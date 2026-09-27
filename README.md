# 建設業向け受発注・現場管理システム Phase 1 UIモック

## 目的

ChatGPTチャット「建設業向け設計案」の仕様に沿って、バックエンドなしで操作導線と画面構成を確認するためのUIモックです。

## 技術構成

- React 19
- TypeScript 6
- Vite 8
- Tailwind CSS 4
- React Router 8
- lucide-react

## 起動

```bash
npm install
npm run dev
```

## 検証

```bash
npm run build
```

## 実装済み範囲

- Hash RouterによるSPAルーティング
- ログイン風デモ画面
- ロール切替
- ダッシュボード
- 現場一覧
- 現場詳細タブ
- 受発注一覧
- 人工・応援取引の注意表示
- 標準ルート外登録時の確認モーダル
- 見積作成モック
- 契約一覧と変更履歴
- 資材発注
- 人員管理
- 現場配置
- 日報入力
- 請求一覧
- 書類管理
- 建設業許可・決算変更届のサンプル画面
- 監査ログ表示
- GitHub Pages用Actionsワークフロー

## Phase 1で実装しないもの

- 実ログイン認証
- データベース
- サーバーAPI
- PDF生成
- ファイルアップロード
- 電子署名
- 建設業法の自動判定
- 決算変更届の帳票生成

## GitHub Pages

`.github/workflows/deploy.yml` を追加済みです。

GitHub側で以下を設定してください。

1. Repository Settings
2. Pages
3. Build and deployment
4. Source: GitHub Actions

リポジトリのサブパス配信でパス調整が必要な場合は、ビルド時に `VITE_BASE_PATH` を指定します。

```bash
VITE_BASE_PATH=/repository-name/ npm run build
```
