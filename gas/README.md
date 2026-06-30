# TaskJournal バックエンド (Google Apps Script)

アプリ（`index.html`）のクラウド同期・NotebookLM用Googleドキュメント更新・Googleカレンダー連携を担う GAS です。

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
4. プロジェクトの設定 → スクリプト プロパティへ`SYNC_TOKEN`を追加
5. **デプロイ → 新しいデプロイ → 種類「ウェブアプリ」**
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員（匿名含む）**
6. 発行されたウェブアプリURLと`SYNC_TOKEN`をアプリの同期設定へ登録
7. 初回は Drive / Calendar の権限承認が必要
8. `NOTEBOOK_DOC_ID`に、NotebookLM用の固定GoogleドキュメントIDを設定する
9. GASエディタで関数`setupNotebookDocument`を選び、1回だけ「実行」する
10. 実行ログに表示された固定GoogleドキュメントをNotebookLMのソースとして追加する

## アプリ ↔ GAS の契約（インターフェース）

### POST（アプリ → GAS / push）
```json
{
  "syncVersion": 2,
  "syncToken": "Script Propertiesと同じランダムキー",
  "tasks": [ /* タスク配列 */ ],
  "tombstones": [ /* 削除したタスクのID・削除時刻 */ ],
  "categories": [ /* ジャンルID・名前・色 */ ],
  "categoriesUpdatedAt": 0
}
```
- `TaskData.json`の既存状態とタスクID単位で統合して保存
- 通常編集は`updatedAt`が新しい方、削除は`tombstones`を優先
- 別端末で追加されたタスクは、受信配列に含まれなくても保持
- 統合後の`tasks`と`categories`を固定IDのGoogleドキュメントへ反映（NotebookLM用）
- `syncVersion: 2`の場合は統合後の状態をJSONで返す

### GET（GAS → アプリ / pull）
- クエリ`syncToken`が必要
- `syncVersion=2`ではタスク・削除履歴・ジャンルを含む状態を返す
- パラメータがない旧アプリには従来どおりタスク配列だけを返す
- 旧形式の`TaskData.json`（タスク配列）は読み取り時に自動でv2として扱う

## 複数端末同期の競合ルール

- 削除したタスクIDは削除履歴に残り、古い端末から再送されても復活しない
- 同じタスクを複数端末で編集した場合は、`updatedAt`が新しい内容を採用する
- 端末ごとに別のタスクを追加した場合は、両方を保持する
- アプリがオンラインへ戻った時と再表示された時にも、30秒以上空いていれば自動取得する

`Code.gs`を変更した場合は、GASのウェブアプリを新しいバージョンとして再デプロイしてください。

## NotebookLM自動再同期

Googleドキュメントの更新だけではNotebookLMへ自動反映されません。
Windowsタスクスケジューラから`scripts/notebooklm-refresh.ps1`を2分ごとに実行し、NotebookLM側の鮮度確認後に必要な場合だけ再同期します。

NotebookLM個人版には公式の再同期APIがないため、非公式の`notebooklm-py`を使用します。
