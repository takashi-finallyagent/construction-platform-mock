# P04 契約前の工事分類と確認事項の保存

設計日・資料確認日: 2026-10-23。対象: 民間の修繕・改修。
設計担当の成果物であり、実装済み・法令適合・着工可能を示す文書ではない。

## 1. 固定した実装境界

初回の開発単位は、工事条件の途中保存、サーバーによる確認課題の導出、保存時の工事情報と現在の差分、分類専用の履歴。以下の型とAPIを実装契約とする。

- 許可証の実証、資格照合、責任者審査、金額による適合・免除認定、添付本体、契約成立、署名、外部連携は含めない。
- 1工事に1つの分類記録。対象は「当社が受ける工事範囲の前提」。下請発注額は条件であり、下請契約そのものではない。
- 工事の住所・相手名・内容・予定日は既存jobsが正本。分類保存時の6項目と版をDBで固定する。
- 分類の版と履歴は独立させる。既存jobs.version、audit_eventsの意味・制約を変更しない。
- 条件が揃っても「入力内容を保存」とだけ表示し、「確認済み」「許可不要」「契約可能」「着工可能」は返さない。
- 設計判断: すべての工事更新で再確認を求める保守的な方式を採用。名称のみの訂正や同内容更新でも版が進めば再確認になる。細かい影響分類は後続。

参照: [製品要件](product-requirements.md)、[基盤詳細設計](product-foundation-design.md)、[構成](product-architecture.md)、[法令レビュー](compliance-review-2026-10-22.md)。

## 2. 型と意味

共有型・空の初期値・カタログは `src/product/classification-model.ts` に置く。export名は `TRADE_CATALOG`（要素はcode/label/kind）、`CATALOG_VERSION`、`RULES_VERSION`、`emptyClassification()` とする。serverからもimportし、React、DOM、fetchに依存させない。JSON Schemaと業務検証、課題導出はserver側を正本とする。

```ts
type Answer<T> =
  | { state: 'unanswered'; value: null; reason: null }
  | { state: 'unknown'; value: null; reason: null }
  | { state: 'known'; value: T; reason: null }
  | { state: 'not_applicable'; value: null; reason: string };
type YesNo = 'yes' | 'no';
type Money = {
  yen: string;
  taxBasis: 'tax_included' | 'tax_excluded' | 'unknown';
};
type WorkItem = {
  id: string; // UUID: 当該分類内で一意。再編集時に保持する。
  description: string;
  tradeCandidates: Answer<TradeCode[]>;
  relationship: Answer<'primary' | 'ancillary' | 'independent'>;
  parentItemId: string | null;
};
type ClassificationData = {
  schemaVersion: 1;
  context: {
    market: Answer<'private' | 'public'>;
    companyRole: Answer<'prime_contractor' | 'subcontractor' | 'owner' | 'other'>;
    workKind: Answer<'repair' | 'renovation' | 'demolition' | 'new_build' | 'other'>;
    targetKind: Answer<'building' | 'structure' | 'other'>;
  };
  workItems: WorkItem[];
  amounts: {
    contract: Answer<Money>;
    suppliedMaterials: Answer<YesNo>;
    suppliedMaterialValue: Answer<Money>;
    suppliedMaterialTransport: Answer<Money>;
    splitContracts: Answer<YesNo>;
    relatedContractValue: Answer<Money>;
    splitReason: Answer<string>;
    subcontracting: Answer<YesNo>;
    subcontractTotal: Answer<Money>;
  };
  permit: {
    declaration: Answer<'held' | 'not_held' | 'renewal_pending'>;
    reportedTrades: Answer<TradeCode[]>;
    note: string;
  };
  conditions: {
    electricalWork: Answer<YesNo>;
    existingStructureWork: Answer<YesNo>;
    demolitionWork: Answer<YesNo>;
    specifiedMaterials: Answer<YesNo>;
    constructionWaste: Answer<YesNo>;
    structuralChange: Answer<YesNo>;
  };
  note: string;
};
type ClassificationPut = {
  version: number; // 未保存は0。保存済みは取得した分類の現在版。
  jobVersion: number; // 入力の前提として画面で取得したjobs.version。
  data: ClassificationData;
};
type JobBasis = {
  version: number;
  name: string;
  siteAddress: string;
  customerName: string;
  workDescription: string;
  plannedStart: string | null;
  plannedEnd: string | null;
};
type ActorSnapshot = { id: string; name: string };
type ClassificationRecord = {
  companyId: string;
  jobId: string;
  version: number; // 保存済みは1以上。
  data: ClassificationData;
  basisJob: JobBasis;
  rulesVersion: string;
  catalogVersion: string;
  createdBy: ActorSnapshot;
  createdAt: string;
  updatedBy: ActorSnapshot;
  updatedAt: string;
};
type Issue = {
  id: string; // code + ':' + path。複数箇所の課題を区別。
  code: string; // 第5節の固定コードのみ。
  path: string; // JSON Pointer。全体課題は空文字。
  kind: 'missing' | 'unknown' | 'review' | 'out_of_scope' | 'stale';
  title: string;
  sourceIds: string[]; // 第7節の出典ID。製品上の課題は空配列可。
};
type JobDifference = {
  field: 'name' | 'siteAddress' | 'customerName' | 'workDescription'
    | 'plannedStart' | 'plannedEnd';
  saved: string | null;
  current: string | null;
};
type ClassificationView = {
  companyId: string;
  jobId: string;
  currentJob: JobBasis;
  record: ClassificationRecord | null;
  currentRulesVersion: string;
  currentCatalogVersion: string;
  staleReasons: ('job_changed' | 'rules_changed' | 'catalog_changed')[];
  jobDifferences: JobDifference[];
  issues: Issue[];
};
type ClassificationAuditEvent = {
  id: string;
  companyId: string;
  jobId: string;
  targetVersion: number;
  requestId: string;
  actorId: string;
  actorName: string;
  action: 'classification.created' | 'classification.updated';
  occurredAt: string;
  beforeData: ClassificationRecord | null;
  afterData: ClassificationRecord;
};
type ClassificationAuditPage = {
  events: ClassificationAuditEvent[];
  nextCursor: string | null;
};
```

APIで返す日時はUTCのISO 8601。日付は既存jobsと同じYYYY-MM-DD/null。createdBy/updatedByは認証由来の入力者であって、法令上の確認責任者・専門家承認者ではない。UIラベルは「記録者」。将来のreviewedByをこの列で代用しない。

### 未入力・不明・対象外

- unanswered: まだ回答していない。unknown: 回答者が分からないと明示した。どちらも既定のno/0/適合に変換しない。
- known: 内容の申告。yesもnoも資料照合済みという意味を持たない。
- not_applicable: 下記の従属項目だけに許可する。理由1〜300文字を必須にする。一般項目を対象外にして課題を消す仕組みにはしない。
- 全キー必須。途中保存では未入力をunansweredで明示する。空文字、キー欠落、nullだけを回答状態に読み替えない。
- 初期値は各Answerがunanswered、配列空、note空文字、schemaVersion=1。private/repair/no等を勝手に既定選択しない。

### 厳密な検証

1. すべてのオブジェクトでadditionalProperties=false。型変換なし。schemaVersionは1だけ。回答のstate/value/reasonの組合せ、enum、UUIDを検証する。
2. versionは整数0〜2147483646、jobVersionは整数1〜2147483647。数値文字列・小数を拒否。版上限では書込を止め、巻き戻さない。
3. workItemsは0〜12件、descriptionはtrim後1〜300文字、id重複不可。候補業種はknownの場合1〜29件、重複・未知code不可。配列順はUI表示順として保持する。
4. primaryは最大1件。ancillaryのparentItemIdは同じ配列の別項目でrelationshipがknown/primaryまたはknown/independentであること。循環・多段附帯・自己参照を拒否。ancillary以外はparentItemId=null。関係を判断できない場合はunknownで保存できる。附帯の選択は法的な附帯工事認定ではない。
5. yenは正規表現 `^(0|[1-9][0-9]{0,11})$` の円単位整数文字列。マイナス、指数、桁区切り、小数、先頭ゼロ、数値型を拒否。JPY固定。taxBasis=unknownは保存可能で課題を残す。税抜から税込への自動換算は今回しない。
6. suppliedMaterialsがknown/noのときだけsuppliedMaterialValueとsuppliedMaterialTransportにnot_applicableを許可。splitContractsがknown/noのときだけrelatedContractValue/splitReasonに許可。subcontractingがknown/noのときだけsubcontractTotalに許可。それ以外の全Answerでnot_applicableは禁止。
7. 従属項目のunanswered/unknownは親の状態にかかわらず途中保存可。親がknown/noのとき従属項目knownは矛盾として400。親がyesまたは未確定に戻った場合、旧not_applicableを残した保存は400。UIは編集内容を保持し、利用者に従属項目の修正を求める。
8. relatedContractValueは今回のcontractを含まない関連する分割契約額。suppliedMaterialValueは発注者の支給材料価額、運送費は別欄。subcontractTotalは当社が発注する下請契約額の合計で、支給材価額を自動加算しない。これらは申告値であり法定集計額の確定値ではない。
9. splitReasonのknown文字列は1〜500文字、permit.noteは0〜1000文字、全体noteは0〜2000文字。reportedTradesのknown配列は1〜29件で重複不可。許可なし申告にreportedTradesのknownを併存させない。heldでもreportedTradesの未入力/不明は保存可。
10. 文字列はtrimして長さ再検証。日本語は保持する。未知のcodeを「その他」に変換しない。UTF-8本文32KiB上限は既存APIと共通で、超過は413。

## 3. HTTP契約と保存競合

接頭辞は `/api/companies/:companyId/jobs/:jobId`。既存認証preHandlerの内側に追加する。パラメータ、所属確認、Origin、no-store、例外変換は既存APIと同じ。

| 方法・パス | 入出力 | 権限 |
| --- | --- | --- |
| GET `/classification` | 200 ClassificationView。既存工事に未保存ならrecord=nullで正常応答。GETで行を作らない | active owner/manager/viewer |
| PUT `/classification` | 本文ClassificationPut、初回201、更新200。両方ClassificationView | active owner/manager |
| GET `/classification/audit?limit=50&cursor=...` | ClassificationAuditPage。limit既定50、1〜100。cursorは正の分類版、未指定なら最新から | active owner/manager |

別のカタログHTTP APIは初回不要。固定カタログを共有し、応答のcurrentCatalogVersionと対応しないクライアントは書込UIを止め、再読込を求める。

- 未認証401、非所属・停止・工事と会社不一致・存在しない工事404、viewer書込/履歴403、入力不正400、競合409。既存の安全な500/503・413/415を継続。レスポンスのmessageにSQL、入力本文、他社データを含めない。
- PUTのversionは期待する旧版。record=nullの初回だけ0を受理しDB版1にする。以後は一致した旧版から必ず+1。同内容を意図的に再保存しても+1と履歴1件。DB版0の仮レコードは作らない。
- 同一トランザクション/接続で `lock_membership(companyId)` -> `jobs FOR UPDATE` -> `classification FOR UPDATE` の順。jobs.versionとjobVersionを比較し、次に分類の存在・版を照合。いずれか不一致なら409。既存jobs更新とのロック順を揃える。
- 初回も工事行を先にロックするため、分類行が未作成の同時PUTを直列化できる。複合PKを最終防御とする。無条件UPSERTで最後の入力を勝たせない。
- 再送を自動成功扱いする専用冪等キーは設けない。期待版0の再送で二重作成は起きない。commit後の応答消失では再送409になり得る。
- 通信失敗、500/503、409では入力・編集開始時点・送信内容を保持。最新GET後に照合し、利用者が確認するまで最新版で再PUTしない。同じ内容が見えただけで「自分の保存成功」と断定しない。
- GETは所属確認後、jobsからjob_classificationsへのLEFT JOINを単一SELECTで実行する。JOIN条件はcompany_idとjob_idの両方、WHEREも要求会社と工事の両方。単一文のMVCCスナップショットでcurrentJobとrecordを取得する。viewerにUPDATE側のRLS条件を要求しないため、GETではFOR SHARE/FOR UPDATEを使わない。分類未作成でも工事行を返し、record=nullとする。
- 履歴はtargetVersion DESC、cursorより小さい版をlimit+1件取得して継続の有無を判定。nextCursorは返した最後の版文字列、末尾はnull。既存jobs履歴に分類イベントを混在させない。

## 4. 保存と失効

`job_classifications` と `classification_audit_events` を追加する。既存audit_eventsには分類用actionや版を追加しない。

| 表 | 必須項目・不変条件 |
| --- | --- |
| job_classifications | `(company_id,job_id)` PK・jobsへの同じ組の複合FK。version正整数、data JSONB、basis_job_versionとbasis_job_snapshot JSONB、rules_version、catalog_version、created_by/name/at、updated_by/name/at |
| classification_audit_events | UUID id、company_id/job_id、actor_id/name、action、occurred_at、target_version、request_id、before_data、after_data。分類への複合FK、`(company_id,job_id,target_version)` UNIQUE。削除連鎖なし |

DBのBEFOREトリガーは、actor/request context、有効所属owner/manager、構造化dataの制約、初回1/更新+1、親工事の版、識別子と作成情報の不変性を強制する。親工事をロックして現在版を照合し、basis_job_snapshotをDBの実値から構築する。アプリから送られた住所や前提snapshotは採用しない。記録者名・時刻をDBから固定する。

DBのAFTERトリガーだけが実際のOLD/NEWから履歴を生成する。分類と履歴は同一トランザクションでcommitし、履歴挿入失敗では分類も保存しない。初回before_data=null、after_dataは保存後の完全なClassificationRecord。旧版snapshot・当時の表示名を保持する。

RLSは両表に必須。分類SELECTはactiveな当該会社所属、書込はowner/manager。履歴SELECTはowner/managerのみ。実行ロールの履歴INSERT/UPDATE/DELETE/TRUNCATE、分類DELETE、識別子・記録者・時刻・前提snapshotへの直接UPDATEは禁止。data、期待する次version、basis_job_versionの必要列にだけ書込権限を付ける。トリガー生成列は利用者が供給できないようACLとガードを揃える。

SECURITY DEFINERは既存と同じ空search_path・完全修飾・PUBLIC EXECUTE剥奪。新2表・ガード/履歴関数・トリガー・必要ACLを起動検査に追加する。API検証だけでなく、runtime直接SQLの不正data・版・親版・履歴捏造も拒否する。詳細検証をSQLに複製する場合、同じ受入データでAPI/DB両方を試験する。直接SQLによる異なるロック順の競合はDBが中断し得るため、失敗をcommit成功に扱わない。

### 失効は破壊的な書換えにしない

保存時のbasisJob.versionと現在jobs.versionが異なればstaleReasonsへjob_changed。rulesVersion/catalogVersionが現行と異なればそれぞれrules_changed/catalog_changed。保存済みdataや旧履歴は書き換えない。未保存はstaleReasons=[]、jobDifferences=[]。

jobDifferencesは6項目の値を比較し、上記型の順で返す。版だけ違い値が等しければ空配列でもjob_changedを残し、「工事情報の版が更新されています」と表示する。旧前提と現在の工事情報を同時に見せる。

再確認は現在の工事を取得・差分表示した後、利用者が内容を見直してPUTした新しい分類版として記録する。フロントの再取得・自動リトライだけでjobVersionを差し替えない。新しい前提への保存は法令審査完了ではない。

現行ルールIDは `p04-2026-10-23.1`、カタログIDは `construction-trades-2026-10-23.1`。GETのissuesは現行ルールで導出する。古い履歴には当時の条件とルールIDを表示し、現行課題を過去の判定結果のように表示しない。今回、課題の完了状態や証憑を保存するAPIは設けない。

ルール/カタログ版はクライアント入力ではなく保存処理の定数とする。DBガードも現在受理する版を検証または設定し、runtimeが任意のルール版を名乗れないようにする。将来の版更新はマイグレーションとAPIを整合させ、旧履歴を上書きしない。カタログcodeの変更・再利用は禁止し、表示名の変更とは区別する。

設計根拠は採用中のPostgreSQL 17の[行ロック](https://www.postgresql.org/docs/17/explicit-locking.html)と[Read Committedの可視性](https://www.postgresql.org/docs/17/transaction-iso.html)。単一SELECTによる読取と、親工事をロックする書込を使い分ける。DB管理者の直接改変に対する第三者証明は保証しない。

## 5. 確認課題の導出

導出は現在の保存済みdata（未保存はemptyClassification()）とcurrentJob、staleReasonsだけを入力とする純粋関数。入力途中の未保存内容で、保存済みの確認課題を黙って差し替えない。法的適合・免除・許可確認の完了を返すコードは定義しない。

`isNo(a)` は `a.state === 'known' && a.value === 'no'`、`isYes(a)` は同様のyes判定。unknown/unansweredをBooleanのfalseとして扱わない。`hasTrade(code)` は全workItemsのknownなtradeCandidates内の存在。閾値計算・税額計算・業種の自動確定は行わない。

### 入力を求める対象

contextの4項目、各workItemのtradeCandidates/relationship、contract、suppliedMaterials/splitContracts/subcontracting、permit.declaration、conditionsの6項目は常に対象。
従属する金額/理由は、親のYesNoがknown/noの場合のみ入力要求を抑制する。permit.reportedTradesもdeclarationがknown/not_heldの場合だけ入力要求を抑制する。noteは任意。workItems=[]は専用のSCOPE_REQUIREDを出す。

入力要求対象のAnswerがunansweredならFIELD_UNANSWERED/missing、unknownならFIELD_UNKNOWN/unknown。既知のMoney.taxBasisがunknownなら、その回答の `/value/taxBasis` にFIELD_UNKNOWNを出す。not_applicableが正しい従属項目にある場合は入力要求を出さないが、適法・免除の肯定表示もしない。

### 固定コードと発生条件

表の順を基本表示順とする。staleを最優先、次にout_of_scope、入力要求、reviewの順。同順位は表の行順、同じコードの複数項目は入力項目順。id=`code + ':' + path`で重複排除する。sourceIdsは第7節のIDを使用する。

| code | 条件 / kind | path / title / sourceIds |
| --- | --- | --- |
| JOB_CHANGED | job_changed / stale | 空文字 / 工事情報が変わっています / [] |
| RULES_CHANGED | rules_changed / stale | 空文字 / 確認基準が更新されています / [] |
| CATALOG_CHANGED | catalog_changed / stale | 空文字 / 工事分類が更新されています / [] |
| OUT_OF_SCOPE | market=known/public、companyRole=known/ownerまたはother、workKind=known/demolition・new_build・other、targetKind=known/otherの各項目 / out_of_scope | 該当Answerのpath / 初期対象外の条件です。個別確認が必要です / [] |
| FIELD_UNANSWERED | 上記入力要求対象の未入力 / missing | 該当path / `{項目名}を入力してください` / [] |
| FIELD_UNKNOWN | 同対象でunknown、または税区分unknown / unknown | 該当path / `{項目名}が不明です` / [] |
| SCOPE_REQUIRED | workItemsが空 / missing | /workItems / 今回請け負う作業を入力してください / [L01] |
| TRADE_REVIEW | 各workItemに常時 / review | /workItems/{index} / 工事範囲と業種候補を確認 / [L01,L02] |
| GENERAL_TRADE_REVIEW | 各workItemにcivil_generalまたはbuilding_generalの候補あり / review | /workItems/{index}/tradeCandidates / 一式工事に該当する根拠を確認 / [L01,L02] |
| ANCILLARY_REVIEW | 各workItemのrelationshipがknown/ancillary / review | /workItems/{index}/relationship / 主たる工事との関係と附帯工事の根拠を確認 / [L01] |
| PERMIT_REVIEW | 常時 / review | /permit / 工事業種に対応する許可と有効性を確認 / [L01,L03] |
| AMOUNT_BASIS_REVIEW | 常時 / review | /amounts / 請負額・税・支給材・分割契約の集計範囲を確認 / [L01,L03] |
| TAX_BASIS_REVIEW | 各knownのMoneyでtaxBasisがtax_excluded / review | 該当Money回答のpath / 税込金額と税の取扱いを確認 / [L03] |
| SUPPLIED_MATERIAL_REVIEW | suppliedMaterialsがisNoでない / review | /amounts/suppliedMaterials / 支給材料の有無・価額・運送費を確認 / [L01] |
| SPLIT_CONTRACT_REVIEW | splitContractsがisNoでない / review | /amounts/splitContracts / 関連する分割契約と分割理由を確認 / [L01] |
| SUBCONTRACT_REVIEW | subcontractingがisNoでない / review | /amounts/subcontracting / 下請契約の範囲と一般・特定の許可条件を確認 / [L01,L03] |
| ELECTRICAL_REVIEW | electricalWorkがisNoでない、またはhasTrade(electrical) / review | /conditions/electricalWork / 電気工事の範囲・事業の登録届出・作業者資格を確認 / [L06] |
| ASBESTOS_REVIEW | existingStructureWorkまたはdemolitionWorkがisNoでない、またはworkKindがknown/repair・renovation・demolition / review | /conditions/existingStructureWork / 石綿の事前調査・調査者資格・報告等を確認 / [L07] |
| RECYCLING_REVIEW | specifiedMaterialsまたはdemolitionWorkがisNoでない、またはworkKindがknown/demolition / review | /conditions/specifiedMaterials / 特定建設資材・工事規模・契約記載・届出を確認 / [L08] |
| WASTE_REVIEW | constructionWasteがisNoでない、またはdemolitionWorkがisYes / review | /conditions/constructionWaste / 廃材の処理方法と委託先・記録を確認 / [L08] |
| BUILDING_REVIEW | structuralChangeがisNoでない、hasTrade(building_general)、またはworkKindがknown/new_build / review | /conditions/structuralChange / 修繕範囲と建築確認等の要否を確認 / [L09] |
| REGIONAL_REVIEW | 常時 / review | 空文字 / 現場所在地に応じた手続・施工条件を確認 / [] |
| EVIDENCE_REVIEW | 常時 / review | 空文字 / 根拠資料と確認責任者の記録が必要です / [] |

FIELD系の項目名は固定ラベル表を使い、入力されたnoteをHTMLやtitleへ埋め込まない。pathはdataを起点とするJSON Pointer。空文字の全体課題は、currentJobや保存状態に関するものも含む。例: `/amounts/contract/value/taxBasis`。indexを含む課題IDは現時点の表示用であり、将来の証憑・審査の永続参照IDに転用しない。

確認課題は義務の適用を確定する一覧ではない。ELECTRICAL_REVIEW等の文言を「届出義務あり」「資格あり」のような判定に変更しない。条件の否定申告で個別の注意項目が表示されなくなってもPERMIT_REVIEW/AMOUNT_BASIS_REVIEW/REGIONAL_REVIEW/EVIDENCE_REVIEWは残る。

今回の条件モデルでは、建物の築年・対象部分・床面積・用途・資材の実証、許可の種類/番号/有効期限、従事者資格、条例の特定までは収集していない。このため小額・税区分既知・候補1業種・許可ありを組み合わせても自動判定はできない。後続の証憑審査工程で追加する情報であり、未実装欄をnoteだけで確認済みにすることも禁止する。

## 6. 29業種カタログ

TradeCodeは下記表のcodeリテラルのunion。codeは本製品の識別子であり、公的連携用番号ではない。kindはカタログの属性で、WorkItem.relationshipとは別。

| code | 工事種類 | kind |
| --- | --- | --- |
| civil_general | 土木一式工事 | general |
| building_general | 建築一式工事 | general |
| carpentry | 大工工事 | specialty |
| plastering | 左官工事 | specialty |
| scaffolding_earthwork_concrete | とび・土工・コンクリート工事 | specialty |
| stone | 石工事 | specialty |
| roofing | 屋根工事 | specialty |
| electrical | 電気工事 | specialty |
| plumbing | 管工事 | specialty |
| tile_brick_block | タイル・れんが・ブロック工事 | specialty |
| steel_structure | 鋼構造物工事 | specialty |
| reinforcing_steel | 鉄筋工事 | specialty |
| paving | 舗装工事 | specialty |
| dredging | しゅんせつ工事 | specialty |
| sheet_metal | 板金工事 | specialty |
| glass | ガラス工事 | specialty |
| painting | 塗装工事 | specialty |
| waterproofing | 防水工事 | specialty |
| interior_finishing | 内装仕上工事 | specialty |
| machinery_installation | 機械器具設置工事 | specialty |
| thermal_insulation | 熱絶縁工事 | specialty |
| telecommunications | 電気通信工事 | specialty |
| landscaping | 造園工事 | specialty |
| well_drilling | さく井工事 | specialty |
| fittings | 建具工事 | specialty |
| water_facilities | 水道施設工事 | specialty |
| fire_protection | 消防施設工事 | specialty |
| sanitation_facilities | 清掃施設工事 | specialty |
| demolition | 解体工事 | specialty |

一式工事は2種類、専門工事は27種類。見積に「一式」と書いてあること、複数専門工事があること、元請であることだけでは一式工事に確定しない。一式許可と個別専門工事の許可を同一視しない。候補複数やunknownを許容し、法律上の業種認定は確認課題として残す。

表のlabelは工事種類であり「建設業の許可業種名」として表示しない。たとえばbuilding_generalの工事種類は建築一式工事、許可業種名は建築工事業。P05以後の許可証照合では別属性を追加する。法令表記の「ブロツク」と画面表記の「ブロック」の違いでcodeを分けない。

## 7. 公式資料と施行時点

以下は2026-10-23に取得できた一次資料。資料更新日・制度施行日・今回のルールIDを別にする。古い施行日指定のe-Gov本文を現行法として引用しない。

| ID | 公式資料・確認できた時点 | 設計に反映する事実 / 今回確定しない事項 |
| --- | --- | --- |
| L01 | 国交省[許可事務ガイドライン](https://www.mlit.go.jp/totikensangyo/const/content/001860019.pdf)。公式[索引](https://www.mlit.go.jp/totikensangyo/const/sosei_const_tk1_000002.html)が2025-02-01適用版として掲載 | 工事内容の重複や一式の解釈を踏まえる。軽微判定には分割契約、支給材の市場価格・運送費の扱いがある。直接元請の特定許可用下請額では元請支給材料等を含めない。分割の正当な理由、附帯該当性、集計は自動確定しない |
| L02 | 国交省[業種区分一覧](https://www.mlit.go.jp/common/001209751.pdf)、表の改正表示2017-11-10。2026-10-23時点でも公式索引から参照。中国地方整備局[2025年3月手引き](https://www.cgr.mlit.go.jp/kensei/tetsuduki/keishin/pdf/tebiki2503.pdf)も参照 | 29種類を識別する。業種コード・一式/専門と、作業の主従関係を分離する。過去日付の表を「2026年改正表」と呼ばない |
| L03 | 国交省[許可とは](https://www.mlit.go.jp/totikensangyo/const/1_6_bt_000080.html)、[FAQ 2026-03-09時点](https://www.mlit.go.jp/totikensangyo/const/content/001985869.pdf) | 軽微工事は建築一式以外500万円未満、建築一式1500万円未満または一定の木造住宅150平方メートル未満等。税込と工事全体の扱いを確認する。直接元請の特定許可に関する下請合計5000万円/建築工事業8000万円は2025-02-01から。これらは別の基準であり、今回数値比較を適合判定にしない |
| L04 | 国交省[法令遵守ガイドライン](https://www.mlit.go.jp/totikensangyo/const/1_6_bt_000188.html): 元下第12版、発受第8版、2026-01改訂・2026-02-02訂正。[元下本文](https://www.mlit.go.jp/totikensangyo/const/content/001979927.pdf)。[改正完全施行の告知](https://www.mlit.go.jp/report/press/content/001968879.pdf)は2025-12-12施行を明記 | 見積・契約・追加変更等はP05へ引継ぐ。2026-01は文書改訂月で全条項の施行日ではない。29業種ごとに別の法定契約様式があると扱わない |
| L05 | 国交省[標準約款](https://www.mlit.go.jp/totikensangyo/const/1_6_bt_000092.html): 2025-12-02改正、2025-12-12施行、2026-02-25正誤。[電子契約ガイドライン](https://www.mlit.go.jp/totikensangyo/const/content/001912595.pdf): 2025-09 | 公共・民間・下請の契約関係と電子的方法の要件を区別。P04保存は交付・承諾ではない。標準約款ページの本文にある年号の誤記を施行日の根拠に使わず、明記された施行日と通知を参照する |
| L06 | 経産省関東東北監督部[電気工事業の手続](https://www.safety-kanto.meti.go.jp/electric/kojigyo/index.html): 検索本文で最終更新2026-03-18を確認。経産省[電気工事士](https://www.meti.go.jp/information/license/c_text24.html): 同2026-04-24。[近畿支部Q&A](https://www.safety-kinki.meti.go.jp/electric/denkikouzi/kouzigyou/kouzigyou_a01.html)の公式検索本文も照合 | 建設業許可と電気工事業の登録/通知/届出、作業者資格は別。直接openは403のため全文取得未完了。個々の適用除外・設備区分・資格の十分性は不明。各更新日を法施行日とは扱わず、確認課題の追加に限定 |
| L07 | 厚労省[小規模工事の手続](https://www.ishiwata.mhlw.go.jp/procedures/)、[2026-09-30の発表](https://www.mhlw.go.jp/stf/newpage_76403.html)、[事業主向け情報](https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/koyou_roudou/roudoukijun/sekimen/other/index_00003.html) | 石綿の事前調査と一定規模の結果報告を分離。建築物等の調査者資格は2023-10-01以降着工、工作物の対象資格制度は2026-01-01以降着工を確認。改修100万円、建築物解体80平方メートル等の報告基準未満でも事前調査を不要扱いしない。工作物の種類・必要資格や調査対象外の例外は個別確認 |
| L08 | 環境省[建設リサイクル法概要](https://www.env.go.jp/recycle/build/gaiyo.html)、国交省[施行告知](https://www.mlit.go.jp/kisha/kisha02/01/010528_3_.html)、[質疑応答集（案）](https://www.mlit.go.jp/sogoseisaku/region/recycle/d11pdf/recyclehou/qanda/qanda2023.pdf)、中部地方整備局[契約書様式](https://www.cbr.mlit.go.jp/contract/keiyakusyo/index.htm) | 分別解体等の義務付けは2002-05-30施行。特定建設資材と規模の条件を確認する。国の規模は解体80平方メートル、新増築500平方メートル、修繕等1億円、その他工作物500万円。対象契約には分別方法、解体費、再資源化施設・所在地、再資源化費等を確認する。リサイクル対象外でも廃棄物処理の義務が消えるわけではない。自治体・工事ごとの適用と内訳は未確定 |
| L09 | 国交省[建築確認対象見直し](https://www.mlit.go.jp/jutakukentiku/build/content/001902550.pdf)、[2026-09-08の説明会告知](https://www.mlit.go.jp/report/press/house05_hh_001148.html) | 2025-04-01施行の見直しにより、2階建て木造住宅などの大規模な修繕・模様替も確認手続の対象になり得る。「修繕だから確認不要」と扱わない。用途・規模・主要構造部の範囲を収集しない今回のモデルでは要否を確定できない |

L08の廃棄物処理に関する補足資料（統合時確認）: 環境省の[排出事業者責任](https://www.env.go.jp/recycle/waste/haisyutsu.html)は、処理委託後も責任が残ることと書面の委託契約を説明している。`WASTE_REVIEW`は建設リサイクル法の規模判定だけを根拠に消さず、この資料も参照する。建設工事における元請責任と例外は[2011年更新の公式Q&A](https://www.env.go.jp/recycle/waste_law/kaisei2010/qa.html)を補助資料とし、2026年の新規改正資料とは扱わない。

e-Govの[建設業法の現行URL](https://laws.e-gov.go.jp/law/324AC0000000100)は今回本文が取得できず、全文・全改正の照合完了とはしない。上記公式資料で確認した事実と、取得できなかった全文・所在地ごとの規定を区別する。将来の契約日・着工日や過去案件の施行時点別判定は未実装。資料確認日の前後を問わず本P04から適法性を保証しない。

REGIONAL_REVIEW/EVIDENCE_REVIEWは確認漏れを防ぐ製品設計上の課題であり、それ自体が特定条項に基づく一律の提出義務ではない。法令網羅性を示す件数・達成率・合格バッジを付けない。

## 8. 段階入力と受入ケース

メインメニューは追加せず、工事詳細の「契約前の確認」タブまたは基本情報からの次作業導線で入る。分類履歴はこの画面の折りたたみ領域に置く。既存の工事基本情報履歴との見出しを区別する。

| 段階 | 質問と操作 |
| --- | --- |
| 1. 工事条件 | 民間/公共、依頼者との関係、修繕/改修等、対象。未入力と分からないを区別する |
| 2. 施工範囲 | 作業の説明。業種候補は検索付き選択で必要時に開く。作業を追加して主な工事/付随する工事/別に扱う工事/分からないを選べる |
| 3. 金額と許可 | 金額・税込/税抜/不明、支給材・分割・下請の有無に応じた従属入力。許可は「資料と照合していない申告」として扱う |
| 4. 関連条件 | 電気、既存物、解体部分、特定建設資材、廃材、構造に関わる変更。yes/noと分からないを区別し、未選択をnoにしない |
| 保存後 | 最も先に必要な課題を1つ表示し、残りは件数付きで展開。保存した条件・記録者・日時、現在の前提との違い、履歴を参照できる |

どの段階でも途中保存可。前後への移動は入力を保持する。29項目をメインメニューや常時表示カードに並べない。候補の補助検索があっても推測候補を自動保存しない。法的な言葉を選べない利用者はunknownで止められる。not_applicableの理由は、従属項目を明示的に対象外として保存する場合だけ入力させる。

保存前/保存中/保存済み/保存結果不明/再確認が必要を区別する。承認や完了の緑色バッジを付けない。viewerは保存済み条件と現在の確認課題を参照できるが編集・履歴を表示しない。会社切替・ログアウト・別工事移動時の古い応答は破棄し、未送信データを別会社に引き継がない。ブラウザ永続ストレージへ業務入力を保存しない。

### 受入ケース

以下は実装者・親担当が実行して結果を記録するケースであり、本書作成時点の合格宣言ではない。

| ID | 条件・操作 | 必須結果 |
| --- | --- | --- |
| C01 | 既存工事で分類未保存のGETを繰り返す | 200 record=null、分類・履歴とも行数不変。空の初期条件から課題を導出 |
| C02 | 初回version0/current jobVersionで一部unknownのPUT | 201/版1、値と不明状態保持、記録者はセッション本人、履歴1件 |
| C03 | 版1で更新・同内容を再保存 | 各200、版2/3、各履歴1件、before/afterと前提の完全snapshot。jobs.version/既存jobs履歴は分類保存で変わらない |
| C04 | 未認証、他社ID、他社工事ID、停止所属、viewer | 401/404/403が権限表と一致。他社存在を漏らさない。viewer GETは未保存/保存済みの両方200で履歴不可 |
| C05 | 2セッションが同時に初回PUT、または同じ期待版で更新 | 成功1件、409が1件。重複行・重複版・紛失更新なし |
| C06 | 工事変更と分類保存を同時実行 | 工事が先なら旧jobVersionの保存409。分類が先なら保存成功後のGETでjob_changed。旧前提に新しい工事内容を偽装して記録しない |
| C07 | 工事の6項目を各変更、同内容jobs更新も実行 | 旧分類は残る。変更値は差分表示、同内容でも版違いのstaleを表示。自動rebaseしない |
| C08 | 差分確認後に現在jobVersionと現在分類版で再保存 | 新分類版・新前提・履歴を作りjob_changed解消。ただし資料審査の課題は消えない |
| C09 | 保存commit直後に通信を遮断して再送 | 409になっても未保存と断定しない。入力と送信内容を保持、GET照合、勝手な再送なし |
| C10 | 履歴トリガーを失敗させる、DB接続/commit結果を失わせる | 原子的rollbackまたは結果不明。保存済みと誤表示しない。再取得可能、履歴だけ/分類だけのcommitなし |
| C11 | runtime直接SQLで他社、viewer、actor未設定、版飛越、旧jobs版、偽snapshot・時刻を書込 | RLS/ACL/DBガードで拒否。正規の直接更新はDB履歴が必ず付く |
| C12 | runtimeによる履歴捏造/更新/削除/TRUNCATE、RLS/トリガー無効化、特権付与 | 拒否。新表/保護機構不備でAPI起動を拒否。履歴失敗時は保存失敗 |
| C13 | 数値文字列版、未知キー・状態・trade、重複ID/業種、回答value/reason不整合、過大本文 | 400または413、データ・履歴不変。型を勝手に変換しない |
| C14 | 金額0、最大12桁、負数、小数、指数、カンマ、taxBasis=unknown/税抜 | 正しい文字列だけ保存。不明は課題、税抜は確認課題。0を未入力に変えない。金額基準の前後で適合/免除を返さない |
| C15 | 親noと従属known、親yesと従属not_applicable、理由空、親変更 | 矛盾400。親no+従属unknown/unansweredは保存できる。許される対象外理由を保持し、他項目への対象外逃げを拒否 |
| C16 | 附帯の親なし/自己参照/循環、多段附帯、複数primary、候補に一式と専門が混在 | 無効な参照は400。複数候補自体は保存可、一式/業種/附帯の確認課題を残す |
| C17 | 修繕99万円、石綿に関する条件不明、電気候補かつelectricalWork=no、許可あり申告 | ASBESTOS_REVIEWを金額で消さない。ELECTRICAL_REVIEWとPERMIT_REVIEWが残る。矛盾する申告を適合に変えない |
| C18 | public/new_build/ownerなど対象外、unknownなど対象不明 | 保存可。対象外と不明を別kindで表示し、業務運用への適合判定を出さない |
| C19 | ルール/カタログ版をテスト用に更新 | GETでstale、過去snapshot不変。未対応カタログのUIは再読込を求める。保存のルール版をブラウザから上書きできない |
| C20 | 102版以上の履歴を50件ずつ取得、途中で新規版追加 | 50/50/残件、重複・欠落なし、末尾null。失敗時に既表示分を保持して再取得。既存jobs履歴と版衝突しない |
| C21 | 記録者の表示名変更、所属停止 | 過去名とactorIdを保持。停止後の新規操作拒否。先行ロック中の保存と停止commitの順序を検証 |
| C22 | 分類GET中に工事・分類を変更 | 単一SELECTでcurrentJobとrecordの組合せが一貫する。正常に古い前提の分類が返る場合はstaleを計算する |
| C23 | 会社切替/工事移動中の遅い応答、保存失敗、ログイン切れ | 古い応答が別会社・工事画面を上書きしない。入力の無断破棄/自動再送なし。期限切れは既存の認証導線へ戻る |
| C24 | スマホ360/390px、デスクトップ、キーボード、縮小動作設定 | 横はみ出し・重なりなし。段階間の入力保持、フォーカス・エラー通知、viewer導線、縮小動作設定を確認 |
| C25 | 旧001〜003適用DBからの移行、旧試作と製品基盤の回帰 | 既存工事・監査履歴・IndexedDB・添付を変更しない。新2表・権限・起動検査が有効。バックアップ/移行と既存試験の結果は親担当が記録 |

設計時のトレードオフ: JSONBで条件の全体版を保持するため、個別フィールドの独立同時編集はできず競合時の比較が必要。対価として複数テーブルの部分保存を避け、前提と回答を一体で履歴化できる。会社を跨ぐ分析・契約項目への正規化・部分編集は実需要が確定した時点で再設計する。

## 9. P05への接続

分類記録は契約ではない。P05では1工事に複数契約・相手・元下関係を持たせ、契約ごとに参照した分類版と工事版を固定する。変更契約は元契約と変更範囲・金額・工期・効力発生日を持つ別版とし、P04の訂正保存で締結済み契約を書き換えない。

将来必要な送達、双方交付、電子的方法への事前承諾、本人性、承諾権限、契約内容の固定、証拠保管、追加変更の着手前確認はP05の仕様。今回の記録者・保存ボタン・履歴を署名、相手方承諾、変更合意に転用しない。

| P05へ渡すもの | 次工程で新たに設計するもの |
| --- | --- |
| companyId/jobId、分類版、前提jobs版、全条件snapshot、ルール版・出典ID | 当事者の法人/個人識別、当社の受注・発注の契約関係、代理/承諾権限、外部相手のアクセス範囲 |
| workItemsの安定ID・説明・候補業種・主従関係 | 専門家が確定した適用範囲、工事業種・許可との証拠照合、契約対象の各作業と除外事項 |
| 金額の申告値・税区分・分割/支給/下請条件 | 見積内訳、適切な見積期間・工期、支給貸与条件、価格変動・変更・支払等の契約事項 |
| 旧前提との差分と分類履歴 | 当初契約/変更契約の不変版、差額/工期影響/効力日、旧契約との対応。分類編集とは別の承認・送達・受領イベント |
| 未確認課題と申告した入力者 | 証憑原本・hash・版・保管、確認者の権限と審査結果、送達先/内容/時刻/受領・承諾の真正性 |

P05移行時は最新分類を無条件参照せず、契約に用いた版を固定する。古い分類が後にstaleになっても締結済み契約の成立状態を自動取消ししない。影響を確認する課題と変更契約の判断を発生させる。現在の1工事1分類は初期入力を簡単にする設計であり、複数の元下取引を1つのcompanyRoleや金額で恒久的に代用しない。

## 10. 完了範囲と残課題

astra担当の今回の設計範囲は、P04初回保存の型/API/状態、会社分離・DB履歴・競合、条件変更時の扱い、段階入力、公式資料の確認範囲、受入ケース、P05への引継ぎまで。本書の作成でこの設計工程を完了とする。実装、DB移行、受入実行、統合結果は親担当とsol実装担当が扱う。

残る判断は、許可証・資格等の証拠照合方式、確認責任者と承認権限、所在地別規定、施行時点別判定、P05の相手方本人性・送達/承諾・契約約款と証拠保管。いずれもP04保存の実装を止める未確定APIではなく、適法性や契約成立の判定を追加する前に解決すべき次工程の要件である。

### 設計文書の検証記録

2026-10-23にNode.jsとリポジトリ導入済みTypeScriptで、本書から型・カタログ・課題コード・出典・受入IDを読み取り検証した。ファイル出力を伴わない検証で、型診断0件、29業種codeの一意性（一式2/専門27）、23課題codeの一意性、出典9件への参照、C01〜C25の連番、GET単一JOIN仕様を確認した。未記入の仮節はない。

この担当では実装コード・DB・画面を変更しておらず、上記C01〜C25の実API/DB/ブラウザ受入試験、DB移行・再起動は実行していない。実装合格の証拠は親担当の統合検証結果で記録する。本担当の変更ファイルは `docs/product-classification-design.md` のみ。
