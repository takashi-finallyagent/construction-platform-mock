# 製品基盤の設計判断

## ADR-001: VPSで運用可能な単一サービス構成

2026-10-22。ConoHa VPSを予定するユーザー判断に基づく。

- 既存React/Viteを継続。製品用入口を `product.html` に分離し、既存IndexedDBを無断で変換・送信しない。
- APIはNode.js 24、Fastify 5。認証はBetter Auth 1.7.12のDBセッション。独自のパスワード暗号・セッション方式を作らない。
- DBはPostgreSQL。会社・所属・工事・監査記録は正規化したテーブルで保持。
- 同一オリジンで画面と `/api` を配信。開発時のみViteからAPIへプロキシ。
- 実行用DBロールとマイグレーション用ロールを分離。実行用はRLSを迂回できず、監査履歴を更新・削除できない。
- リクエストごとに認証済み利用者IDをDBトランザクションのローカル設定へ渡し、会社所属を毎回照合。
- 工事の変更はバージョン条件付き。競合時は409を返し、入力を勝手に破棄しない。
- 作成は利用者・会社・冪等キーで重複を検出し、別の内容でのキー再使用を拒否。
- APIの変更操作には許可したOriginを要求。CookieはHttpOnly、SameSite。公開時はHTTPSとSecure必須。
- ログにCookie、Authorization、パスワード、リクエスト本文を出さない。画面/APIの機微データはno-store。

### トレードオフ

単一VPSは構成と運用を小さくできる一方、ホスト障害が全機能に影響する。
同じVPS内のコピーは災害対策にならない。別保管先へのバックアップと復元訓練が必要。
認証製品を使っても、アカウント発行・回復・多要素認証・監視・更新は別途必要。
DBの権限制御は通常のアプリ利用者からの変更を防ぐが、DB管理者による改ざん耐性・外部証明を保証しない。

## 公開条件

現時点では開発基盤であり、業務運用の公開条件は未達。

- [ ] 必須業務P04〜P08の移行と受入試験
- [ ] 法令・契約書・帳票の専門家レビュー
- [ ] 本人確認、招待、失効、パスワード再設定、MFAと管理者権限の運用
- [ ] 本番VPS上のHTTPS、ファイアウォール、DB非公開、秘密情報の管理
- [ ] 非公開写真保管、ウイルス等の添付検査、容量制限、写真の送信待ち復旧
- [ ] バックアップ・復元、監視、障害対応、依存パッケージの定期更新
- [ ] iPhone/Android実機・複数利用者・負荷・セキュリティ試験
- [ ] 個人情報、保存・削除、利用規約、運用責任者の決定

GitHub Pagesは静的な旧画面の公開先に過ぎず、本製品のAPIやDBの代わりにはならない。
本番用Docker配布・HTTPS設定はVPS・ドメイン決定後に追加する。開発用DB構成を本番へそのまま転用しない。

## 根拠

- [Fastify validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
- [Better Auth Fastify integration](https://better-auth.com/docs/integrations/fastify)
- [Better Auth password authentication](https://better-auth.com/docs/authentication/email-password)
- [node-postgres transactions](https://node-postgres.com/features/transactions)
- [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [ConoHa VPS](https://vps.conoha.jp/)
