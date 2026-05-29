# TaskJournal バックエンド (Google Apps Script)

アプリ（`index.html`）のクラウド同期・NotebookLM用Markdown出力・Googleカレンダー連携を担う GAS です。

## 修正内容（オリジナルからの差分）

| 箇所 | オリジナル | 修正版 |
|---|---|---|
| `folderId` | フォルダURL全体を指定（`https://...folders/XXXX`） | **IDのみ** (`XXXX`) を指定。`DriveApp.getFolderById` はID文字列を要求するため、URLだと例外で全処理が止まる |
| `.setHeaders(headers)` | 全return文で呼び出し | **削除**。`ContentService` の `TextOutput` に `setHeaders` は存在せず `TypeError` で落ちる。`doGet`（pull）が失敗する原因だった |

## CORS について

GAS の `ContentService` ではレスポンスヘッダを自前で設定できません。
ただし Web アプリのGETレスポンスには Google が自動で `Access-Control-Allow-Origin: *` を付けるため、
**preflight を伴わない単純リクエスト**であればブラウザの `fetch` から利用できます。

- **POST**: `Content-Type: text/plain`（または省略）で送ると preflight(OPTIONS) を回避できます。
  本文は JSON 文字列でOK（GAS側は `JSON.parse(e.postData.contents)`）。
- **GET**: 追加ヘッダなしの単純GETなら `fetch(url).then(r => r.json())` で読み取り可能。

## デプロイ手順

1. [script.google.com](https://script.google.com/) で新規プロジェクト作成
2. `Code.gs` の内容を貼り付け（`appsscript.json` はプロジェクト設定で「マニフェストを表示」して反映）
3. `FOLDER_ID` を自分の Drive フォルダIDに設定（URLの `folders/` 以降）
4. **デプロイ → 新しいデプロイ → 種類「ウェブアプリ」**
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員（匿名含む）**
5. 発行された **ウェブアプリ URL**（`.../exec`）をアプリの「同期設定」に登録
6. 初回は Drive / Calendar の権限承認が必要

## アプリ ↔ GAS の契約（インターフェース）

### POST（アプリ → GAS / push）
```json
{
  "tasks": [ /* タスク配列 */ ],
  "markdown": "# NotebookLM用Markdown ..."
}
```
- `tasks`   → `TaskData.json` に保存（同期用DB）
- `markdown`→ `TaskJournal.md` に保存（NotebookLMのソース用）
- `tasks` のうち `dueDate` があり `status !== 'done'` のものをカレンダーに作成/更新

### GET（GAS → アプリ / pull）
- `TaskData.json` の中身（tasks配列のJSON）を返す
- 無ければ `[]`

> 注: 現行の `index.html` は `markdown` を送っていないため `TaskJournal.md` が生成されません。
> これは A案（IndexedDB移行）でクライアント側のMarkdown生成を実装して解消します。
