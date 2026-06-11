# TaskJournal 全体構成

このプロジェクトの「裏側」がどう繋がっているかの地図です。
コードを書く人（人間・AIエージェント）と、運用するオーナーの両方が参照します。

## 構成図

```
[利用者のブラウザ]
  index.html（アプリ本体・GitHub Pages で配信）
  ├── sw.js …… Service Worker（network-first キャッシュ / オフライン対応）
  ├── IndexedDB …… タスク・設定（APIキー含む）・豆知識キャッシュの保存先
  │
  ├──(1) GAS Webhook (POST/GET) ──→ Google Apps Script
  │                                   ├─ Google Drive: TaskData.json（同期DB）
  │                                   └─ Google カレンダー: 期日付きタスクを登録
  │
  ├──(2) https://api.edaaiapps.com/v1/chat/completions
  │        └→ Cloudflare Worker（worker-openai-proxy.js）
  │             └─ Bearer 認証 → CF Access トークン付与
  │                 └→ https://lmstudio.edaaiapps.com（自宅PCの LM Studio / Gemma）
  │
  ├──(3) https://api.edaaiapps.com/v1/debug-log
  │        └→ 同じ Worker → GitHub Contents API
  │             └→ この repo の debug/ にエラーログを自動コミット
  │
  └──(4) https://ja.wikipedia.org/w/api.php
           …… 豆知識のRAG根拠（「M月D日」記事の記念日セクション）。キー不要
```

## 外部サービスと secrets の所在（オーナー管理）

| サービス | 役割 | secrets / 設定の場所 |
| --- | --- | --- |
| **GitHub** | コード置き場・Pages 公開・`debug/` ログ置き場 | Fine-grained PAT（Contents: Read and write・このrepo限定）→ **Cloudflare Worker の `GITHUB_TOKEN`(Secret) に登録**。repo には置かない |
| **Cloudflare Worker** (`api.edaaiapps.com`) | AIプロキシ＋デバッグログ受け口 | 環境変数: `GEMMA_API_KEYS` `CF_ACCESS_CLIENT_ID/SECRET` `UPSTREAM_BASE_URL` `ALLOWED_ORIGINS` `GITHUB_TOKEN` `GITHUB_REPO` `GITHUB_BRANCH` `DEBUG_LOG_DIR`。**コード更新は手動**（`cloudflare/worker-openai-proxy.js` をダッシュボードに貼って Deploy） |
| **Cloudflare Access** | LM Studio への入口を保護 | Service Token（Worker の環境変数に登録済み） |
| **Google (GAS)** | Drive 同期・カレンダー連携 | GAS プロジェクト（`gas/Code.gs` を手動デプロイ）。WebアプリURL はアプリの設定画面に登録 |
| **自宅PC (LM Studio)** | Gemma モデルの実行 | `cloudflare/start-lmstudio-server.bat` で常時稼働（`cloudflare/LM_STUDIO_ALWAYS_ON.md` 参照） |
| **利用者ブラウザ** | アプリ実行 | IndexedDB に GAS URL・AIエンドポイント・APIキーを保存（端末ローカルのみ） |

> **原則**: トークン・APIキーは「Worker の環境変数」か「端末の IndexedDB」のどちらかにしか存在しない。
> リポジトリ・HTML・チャットには書かない。

## 主要なデータの流れ

### タスク同期（GAS）
- push: タスク変更時に `{ tasks, markdown }` を GAS へ POST（`text/plain` で preflight 回避）
- pull: 起動時・同期アイコンで GET → `updatedAt` ベースの LWW でマージ

### 豆知識（Wikipedia RAG）
1. 日本語Wikipedia「M月D日」記事の記念日セクションを MediaWiki API で取得
2. 抜粋を根拠として Gemma に渡し、制定理由中心に要約（JSON）
3. 出典は選ばれた記念日の個別記事URL（無ければ日付ページ）。1日1件キャッシュ＋翌日分の先読みあり

### デバッグログ
- console / 未捕捉エラーをリングバッファ（400件）に常時記録
- エラートースト・豆知識エラー・未捕捉エラー時に `/v1/debug-log` へ自動送信（15秒に1回まで）
- Worker が `debug/<timestamp>.md` としてコミット → 「エラー出たから見て」で AI が読める
- 手動操作: 設定 → デバッグ → コピー / .md ダウンロード / クラウド送信
