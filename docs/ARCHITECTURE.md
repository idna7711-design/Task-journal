# TaskJournal 全体構成

このプロジェクトの「裏側」がどう繋がっているかの地図です。
コードを書く人（人間・AIエージェント）と、運用するオーナーの両方が参照します。

## 構成図

```
[利用者のブラウザ]
  index.html（アプリ本体・GitHub Pages で配信）
  ├── sw.js …… Service Worker（network-first キャッシュ / オフライン対応）
  ├── IndexedDB …… タスク・設定（APIキー含む）の保存先
  │
  ├──(1) GAS Webhook (POST) ──→ Google Apps Script
  │                                   ├─ Google Drive: TaskData.json（同期DB）
  │                                   ├─ Google Docs: 固定IDのTaskJournal（NotebookLM用）
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
```

## 外部サービスと secrets の所在（オーナー管理）

| サービス | 役割 | secrets / 設定の場所 |
| --- | --- | --- |
| **GitHub** | コード置き場・Pages 公開・`debug/` ログ置き場 | Fine-grained PAT（Contents: Read and write・このrepo限定）→ **Cloudflare Worker の `GITHUB_TOKEN`(Secret) に登録**。repo には置かない |
| **Cloudflare Worker** (`api.edaaiapps.com`) | AIプロキシ＋デバッグログ受け口 | 環境変数: `GEMMA_API_KEYS` `CF_ACCESS_CLIENT_ID/SECRET` `UPSTREAM_BASE_URL` `ALLOWED_ORIGINS` `GITHUB_TOKEN` `GITHUB_REPO` `GITHUB_BRANCH` `DEBUG_LOG_DIR`。**コード更新は手動**（`cloudflare/worker-openai-proxy.js` をダッシュボードに貼って Deploy） |
| **Cloudflare Access** | LM Studio への入口を保護 | Service Token（Worker の環境変数に登録済み） |
| **Google (GAS)** | Drive 同期・カレンダー連携 | GAS プロジェクトのScript Propertiesに`SYNC_TOKEN`を登録。WebアプリURLと同期キーは各端末のIndexedDBに保存 |
| **自宅PC (LM Studio)** | Gemma モデルの実行 | `cloudflare/start-lmstudio-server.bat` で常時稼働（`cloudflare/LM_STUDIO_ALWAYS_ON.md` 参照） |
| **利用者ブラウザ** | アプリ実行 | IndexedDB に GAS URL・AIエンドポイント・APIキーを保存（端末ローカルのみ） |

> **原則**: トークン・APIキーは「Worker / GAS の秘密設定」か「端末の IndexedDB」のどちらかにしか存在しない。
> リポジトリ・HTML・チャットには書かない。

## 主要なデータの流れ

### タスク同期（GAS・同期方式v3）
- pullとpushは同期キーをURLへ出さない`text/plain`のPOSTへ統一
- タスク変更と送信待ち箱をIndexedDBの同一トランザクションで保存し、通信失敗でも変更を失わない
- 新規タスクは追加日時と、粗い端末名＋ランダムな短い識別子を保持する。詳細なUser-Agentは同期データへ保存しない
- 同期中は、準備・確認・送受信・端末反映という完了済み処理段階を割合と処理名で表示する
- 各変更は`mutationId`を持ち、再送されてもGASで二重適用しない
- 各タスクの`serverVersion`と変更元の`baseVersion`で分岐を判定し、端末時計は同期の勝敗に使わない
- GASは`LockService`内で変更を直列化し、成功した変更IDだけを端末へ返す
- GASのScriptLockはJSONの読取・統合・保存だけに限定し、NotebookLM用Googleドキュメント更新は時間主導トリガーへ分離して別ロックで直列化する
- 端末への同期応答はDrive保存後に返し、重いGoogleドキュメント再生成を待たせない（通常は約1分以内に反映開始）
- Googleドキュメント更新に失敗しても、保存済みタスク同期は取り消さず、次回変更時に最新JSONから再生成する
- 変更のない取得同期はDriveとGoogleドキュメントを書き換えず、保存処理を待たずに状態だけ返す
- オフライン中の同一端末での連続編集は`parentMutationId`で順番を維持
- 同じ版から別端末で分岐した編集と、削除対編集は両候補を`conflicts`へ保存してアプリに表示
- ジャンル一覧もサーバー版番号で同期し、端末時計に依存しない
- 競合比較AIへ送るのは候補のタイトル・予定日時・状態だけ。AIは提案のみで自動統合・削除しない
- 新アプリはGASの`capabilities`応答でv3対応を確認するまで書き込まない
- 旧アプリ向けv2は移行期間の互換用として残す
- GASは認証成功後に件数・文字長・リクエストサイズを検証
- 通信・タイムアウト・HTTP 408/429/5xxだけを2秒、5秒、15秒の最大3回で再試行する。認証・形式不一致は再試行しない
- 再試行後も送れない変更はIndexedDBの送信待ち箱へ残し、オンライン復帰・画面復帰・手動同期で再開する
- 失敗時は100%と表示せず、「未同期」、未送信件数、次の再試行予定を表示する
- 1回の同期にランダムな`requestId`を付け、ブラウザの安全な診断ログとGAS実行ログを突合できるようにする
- 診断ログには処理段階、試行回数、経過時間、HTTP状態、リダイレクト先ホスト、未送信件数、アプリ版を記録する。同期キーとタスク本文は記録しない

### GAS同期のWorker中継（保留中の第二段階）

SafariからGASへの直接通信で`Load failed`が安全実装後も続く場合だけ、既存Cloudflare Workerに同期専用経路を追加する。
現時点ではタスク本文と同期キーが通る場所を増やさないため、実装・有効化しない。

切替時の必須条件:

- 同期専用SecretをAI用キーと分離する
- GAS URLをWorker環境変数へ固定し、任意URLへの中継を禁止する
- 許可外OriginはCORSヘッダーだけでなくHTTP 403で拒否する
- POST限定、本文1MB以下、上流タイムアウト、回数制限を設ける
- タスク本文、同期キー、Authorization、URLクエリをログへ残さない
- 旧GAS直接接続へ戻せる復旧手順を維持する

### NotebookLM 自動更新
1. GASがタスク変更のたびに、同じIDのGoogleドキュメント本文を上書き
2. NotebookLMへGoogleドライブから追加したソースは、NotebookLM公式機能で数分ごとに自動更新
3. 反映が遅い場合だけNotebookLM画面の「Googleドライブと同期」を使用

> 2026年7月時点のNotebookLM公式ヘルプでは、Driveソースは数分ごとに自動更新される。
> Windowsの`notebooklm-py`定期タスクは非公式の予備手段であり、実アカウントで自動反映を確認後に無効化・撤去する。

### デバッグログ
- console / 未捕捉エラーをリングバッファ（400件）に常時記録
- エラートースト・接続テスト失敗・未捕捉エラー時に `/v1/debug-log` へ自動送信（15秒に1回まで）
- Worker が `debug/<timestamp>.md` としてコミット → 「エラー出たから見て」で AI が読める
- GitHub書き込み失敗時は、秘密情報を含まない分類コードを端末へ返す
- 手動操作: 設定 → デバッグ → コピー / .md ダウンロード / クラウド送信
- 接続テストは同期APIの到達・同期キー・同期方式と、AIのWorker到達・上流到達・回答生成を分けて表示する
- AI接続テストは最大128トークンで確認し、空本文などの一時失敗時だけ1回再試行する
- AIログには回答本文を残さず、`finish_reason`、推論本文の有無と長さ、応答形式と長さだけを記録する
