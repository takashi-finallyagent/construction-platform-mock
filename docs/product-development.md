# 開発・運用手順

2026-10-26。ローカル開発用。ConoHa VPSへの配備・公開は未実施。

## 構成

Node.js 24.13.1、Fastify 5.12.7、Better Auth 1.7.12、pg 8.23.1、PostgreSQL 17.11で検証。
Viteは脆弱性修正を含む8.3.5に更新。依存関係はpackage-lock.jsonで固定する。
React製品画面は `product.html`、旧端末保存版は `index.html`。コードは同じリポジトリに置く。

## Windowsで製品版を起動する

1. [Node.js 24](https://nodejs.org/en/download) とGitをインストールする。Gitの代わりに、リポジトリの **Code → Download ZIP** からソースを取得して展開してもよい。
2. PowerShellでリポジトリを取得する。ZIPを使った場合は展開したフォルダーを開く。

   ```powershell
   git clone https://github.com/takashi-finallyagent/construction-platform-mock.git
   cd construction-platform-mock
   ```

3. [PostgreSQL公式のWindowsダウンロード案内](https://www.postgresql.org/download/windows/) にあるバイナリZIPから PostgreSQL 17 の Windows x86-64 版を取得する。ZIP内の `pgsql` フォルダーをプロジェクト内の `.runtime` に展開し、`.runtime/pgsql/bin/initdb.exe` があることを確認する。
4. プロジェクトのフォルダーで初期設定を実行する。開発アカウントのメールアドレスとパスワードは、そのPCの `.runtime/local-access.md` に生成される。

   ```powershell
   npm.cmd ci
   npm.cmd run local:setup
   ```

5. PowerShellを2つ開き、それぞれ同じプロジェクトのフォルダーで次のコマンドを1つずつ実行する。

   ```powershell
   npm.cmd run api:dev
   ```

   ```powershell
   npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort
   ```

6. [製品版](http://127.0.0.1:5173/product.html) を開き、手順4で生成した開発アカウントでログインする。試しに工事を1件登録し、「工事を進める」を開く。

この手順で作る台帳と写真の保管先はノートPC内にある。GitHubから取得できるのはコードと設定のひな形で、別のPCで登録した工事や写真を確認するには、認証付きAPIに共通のデータベースと写真の保管先を接続する必要がある。

## 初回セットアップ

`npm ci` で依存を導入する。PostgreSQLの管理接続と実行接続を用意し、`.env.example` の項目を `.env` に設定する。
秘密値は十分な長さのランダム文字列にする。実行ロール `construction_app` はマイグレーションが作成する。
既存ロールがある場合、パスワードは自動変更しない。接続失敗時は管理者が確認する。

```bash
npm run db:migrate
npm run api:dev
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

APIは127.0.0.1:3100、画面は127.0.0.1:5173。Viteの `/api` プロキシで同じオリジンにする。
認証のAPP_ORIGINとブラウザのURLは一致させる。localhostと127.0.0.1は別オリジン。

このWindows開発環境では、EDB公式のPostgreSQLバイナリを `.runtime/pgsql` に展開してある。
`npm run local:setup` は127.0.0.1:55432の専用DBを準備し、既存の開発設定とDBを上書きしない。
開発用の認証情報は `.runtime/local-access.md` に生成される。端末外へ共有せず、本番には使わない。
Dockerの起動エラーを回避するためにローカルバイナリを使用した。Dockerの設定は変更していない。

## アカウント発行

管理用環境で `ACCOUNT_EMAIL`、`ACCOUNT_NAME`、`ACCOUNT_PASSWORD`、`COMPANY_NAME`、`ADMIN_ACTOR`（操作責任者）、`ADMIN_REASON`（理由）を設定し `npm run account:provision`。
新しい会社と初回管理者を作る管理コマンドで、一般利用者に公開しない。秘密をコマンド引数やリポジトリに記入しない。
アカウント作成後に会社作成が失敗した場合、その利用者には所属がなく、業務データにはアクセスできない。
失敗コード `UNASSIGNED_ACCOUNT_REQUIRES_RECOVERY` と対象userIdを確認した場合は、管理者が本人・未所属状態を照合する。
`ACCOUNT_USER_ID`、`COMPANY_NAME`、`ADMIN_ACTOR`、`ADMIN_REASON` を明示し `npm run account:recover` で復旧する。
既に所属があるアカウントの復旧は拒否する。新規発行の再実行では既存アカウントを自動で会社へ割り当てない。
管理コマンドは操作者・理由・対象ID・成否をJSON形式で標準出力または標準エラーへ記録する。
これらをアクセス制限した運用ログへ収集・保管する仕組みは、本番配備前に整備する。パスワードを理由欄に記入しない。
既存会社への招待、再設定、MFA等は公開前に実装・運用確定が必要。

## 検証

```bash
npm run typecheck:server
npm run test:server
npm run test:provision
npm run test:classification
npm run test:classification:flow
npm run test:workflow
npm run test:photo-outbox
npm run test:unit
npm run build
npm run lint
npm audit
```

API試験はローカルPostgreSQL上にランダム名 `construction_test_*`、`classification_test_*` 等の専用DBを作成・削除する。
通常の工事DBにテストデータを書かない。マイグレーション再実行、認証、会社分離、権限、履歴、競合、再送、ロールバックを試験する。
`test:classification` は分類API/DB試験と、003時点の工事・履歴を保持したまま004を適用する `classification_upgrade_*` の移行試験を実行する。
`test:classification:flow` はDB不要の表示分岐・次の入力先の試験。旧値保持と金額だけでは確認課題を除かないことを確認する。
ブラウザ試験と旧版の回帰試験は `tests/` を参照。実機のカメラ・オフライン・本番VPSの負荷試験は代替しない。

製品UIの実API統合試験:

```bash
node tests/product-smoke.mjs --playwright /absolute/path/to/playwright --browser /absolute/path/to/chrome --out test-results/product
node tests/classification-smoke.mjs --playwright /absolute/path/to/playwright --browser /absolute/path/to/chrome --out test-results/classification
node tests/workflow-smoke.mjs --playwright /absolute/path/to/playwright --browser /absolute/path/to/chrome --out test-results/workflow
```

専用のランダム利用者・会社を開発DBへ一時作成し、終了時にそのデータだけを削除する。既存の会社・工事・利用者は変更しない。
ログイン試行は制限を受ける。短時間で再実行して429になった場合、制限を解除せず時間をおいて再実行する。
出力には試験用の画面・履歴が含まれるためGit管理しない。
分類の試験は、初回・更新の競合、保存応答消失時の比較、工事前提の変更、102版の履歴取得、閲覧者、異常応答、段階入力と画面幅を確認する。通常の読取・書込は実API/DBを使い、通信障害・遅延と異常応答を明示的に注入する。

## 契約前の工事分類

設計は [product-classification-design.md](product-classification-design.md)、実行結果は [product-classification-progress.md](product-classification-progress.md) を参照。
004は分類と分類履歴の2表を追加し、既存工事の分類を自動で作成しない。既存の工事履歴と分類履歴は別々の版を持つ。
API更新前にバックアップを取得して `db:migrate` を実行し、その後にAPIを再起動する。旧DBのまま更新後のAPIを起動すると起動検査で拒否される。
分類は工事情報・カタログ・確認基準の版を保存する。工事変更後の再確認は新しい分類版を保存し、過去の回答を上書きしない。
分類の保存は入力の記録であり、許可証や資格の確認、契約締結、双方交付、着工許可を表さない。資料確認と契約交換の手動記録は「工事を進める」で別途保存する。
入力改善は [product-classification-ux-design.md](product-classification-ux-design.md) を参照。保存成功後の移動、直接入力、親回答による子欄の省略は画面側の変更であり、追加のDB移行は不要。

## VPS配備時の必須事項

005の業務記録と非公開ファイルの実装・制限は [product-workflow-progress.md](product-workflow-progress.md) を参照。
API更新前にバックアップを取得し `npm run db:migrate` を実行、その後APIを再起動する。
`FILE_STORAGE_DIR` はWeb公開ディレクトリ外の永続ボリュームへ設定し、API実行者だけに書込みを許可する。
バックアップ・復元はDBとファイルの両方を対象とする。DBだけのdumpでは写真を復元できない。
ファイルの保管先変更時は既存キーを保ったまま本体を移し、DB上のファイル数・サイズ・SHA-256と復元先の本体を照合する。
本番APIにはDB管理用環境変数を渡さず、ファイルディレクトリやdumpをVite/nginxの公開ルートへ置かない。

- HTTPSの同一オリジンで画面と `/api` を公開。API/DBポートはインターネットに開放しない。
- API起動時は `NODE_ENV=production`。APP_ORIGINをHTTPSへ変更。管理DB接続・管理パスワードはAPIプロセスへ渡さない。
- `.env`にNODE_ENVを書かない。フロントのビルドはproduction、マイグレーションは独立した管理コマンドで行う。
- マイグレーションはバックアップ取得後に管理ロールで実行。APIは非所有者・非superuser・非BYPASSRLSの実行ロールを使う。
- DB管理者の操作はアプリの操作履歴だけでは保護できない。管理アクセスの監査と別保管先の設計が必要。
- 現状APIは転送IPを信用しない。リバースプロキシ導入時に信頼範囲を限定し、利用者IP別のログイン制限を再検証する。
- バックアップ保存先、暗号化、保存期間、復元試験、監視、障害対応者を決める。
- ファイル保管・契約・法令確認の製品移行が完了するまで実案件の唯一の業務基盤にしない。

## モデル分担

ユーザー指定に従い、詳細設計・権限境界や例外処理のレビューはGPT-6 astra（ultra）、
確定した設計に沿う画面実装・定型試験はGPT-6.1 sol（high）を使用。
モデルの判断だけで法令適合・本番運用の承認を済ませず、検証結果と未達条件を記録する。
