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

## アプリ ↔ GAS の契約（同期方式v3）

### POST `action: capabilities`（書き込み前確認）
旧GASへ誤って書き込まないため、新アプリは最初にv3対応を確認します。

### POST `action: sync`（双方向同期）
```json
{
  "protocolVersion": 3,
  "action": "sync",
  "syncToken": "Script Propertiesと同じランダムキー",
  "mutations": [ /* mutationId・taskId・baseVersion・操作・タスク */ ],
  "categoryMutation": null,
  "resolvedConflictIds": []
}
```
- `serverVersion`と`baseVersion`で分岐を判定し、端末時計は勝敗に使わない
- `mutationId`で同じ変更の再送を二重適用しない
- 削除と別端末編集が重なった場合も両候補を保持
- 成功確認済みの変更だけ端末の送信待ち箱から削除
- 統合後の`tasks`と`categories`を固定IDのGoogleドキュメントへ反映（NotebookLM用）
- JSON同期のロックとGoogleドキュメント更新のロックを分離し、複数端末の同時同期を妨げない
- 同期キーはPOST本文だけに入れ、URL・履歴へ残さない
- GETと同期方式v2は旧アプリの移行期間だけ維持

## 複数端末同期の競合ルール

- 同じサーバー版から分岐した編集は、端末時刻にかかわらず両方を競合欄へ残す
- 削除と編集の競合も自動削除せず、人が選ぶまで両方を保持する
- 端末ごとに別のタスクを追加した場合は、両方を保持する
- アプリがオンラインへ戻った時と再表示された時にも、30秒以上空いていれば自動取得する

`Code.gs`を変更した場合は、GASのウェブアプリを新しいバージョンとして再デプロイしてください。

## NotebookLM自動再同期

NotebookLM公式ヘルプでは、Googleドライブから追加したソースは数分ごとに自動更新されます。
Windowsの`notebooklm-py`タスクは予備手段です。固定Googleドキュメントの更新が実アカウントへ自動反映されることを確認後、無効化・撤去してください。
