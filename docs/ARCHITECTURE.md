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
- 変更のない取得同期はDriveとGoogleドキュメントを書き換えず、保存処理を待たずに状態だけ返す
- オフライン中の同一端末での連続編集は`parentMutationId`で順番を維持
- 同じ版から別端末で分岐した編集と、削除対編集は両候補を`conflicts`へ保存してアプリに表示
- ジャンル一覧もサーバー版番号で同期し、端末時計に依存しない
- 競合比較AIへ送るのは候補のタイトル・予定日時・状態だけ。AIは提案のみで自動統合・削除しない
- 新アプリはGASの`capabilities`応答でv3対応を確認するまで書き込まない
- 旧アプリ向けv2は移行期間の互換用として残す
- GASは認証成功後に件数・文字長・リクエストサイズを検証

### NotebookLM 自動更新
1. GASがタスク変更のたびに、同じIDのGoogleドキュメント本文を上書き
2. NotebookLMへGoogleドライブから追加したソースは、NotebookLM公式機能で数分ごとに自動更新
3. 反映が遅い場合だけNotebookLM画面の「Googleドライブと同期」を使用

> 2026年7月時点のNotebookLM公式ヘルプでは、Driveソースは数分ごとに自動更新される。
> Windowsの`notebooklm-py`定期タスクは非公式の予備手段であり、実アカウントで自動反映を確認後に無効化・撤去する。

### 豆知識（Wikipedia RAG）
1. 日本語Wikipedia「M月D日」記事の記念日セクションを MediaWiki API で取得
2. 抜粋を根拠として Gemma に渡し、制定理由中心に要約（JSON）
3. 出典は選ばれた記念日の個別記事URL（無ければ日付ページ）。1日1件キャッシュ＋翌日分の先読みあり

### デバッグログ
- console / 未捕捉エラーをリングバッファ（400件）に常時記録
- エラートースト・豆知識エラー・未捕捉エラー時に `/v1/debug-log` へ自動送信（15秒に1回まで）
- Worker が `debug/<timestamp>.md` としてコミット → 「エラー出たから見て」で AI が読める
- 手動操作: 設定 → デバッグ → コピー / .md ダウンロード / クラウド送信
