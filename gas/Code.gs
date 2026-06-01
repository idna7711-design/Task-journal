/**
 * TaskJournal バックエンド (Google Apps Script)
 *
 * 役割:
 *   doPost … アプリから { tasks, markdown } を受け取り
 *            - TaskData.json   … 同期用DB（tasks配列）を Drive に保存
 *            - TaskJournal.md  … NotebookLM用Markdownを Drive に保存
 *            （カレンダー登録はアプリの「カレンダーに追加」ボタンからのみ。GAS自動同期は廃止）
 *   doGet  … TaskData.json の中身（tasks配列）をJSONで返す（他デバイスからのpull用）
 *
 * 修正点（オリジナルからの差分）:
 *   1. folderId はフォルダURLではなく「IDのみ」を指定する
 *      （DriveApp.getFolderById は ID文字列を要求するため）
 *   2. ContentService の戻り値に .setHeaders() は存在しない（TypeErrorで落ちる）ため削除
 *      GASのGETレスポンスには Google が自動で Access-Control-Allow-Origin: * を付与するため、
 *      単純リクエスト（preflightを伴わないGET / text/plainのPOST）であればCORSは通る。
 */

// ▼ Driveフォルダの「ID」だけを指定（URL全体ではない）
//   例: https://drive.google.com/drive/folders/XXXX の XXXX 部分
const FOLDER_ID = '1AxPEwynYHM_vKjsXLKKgpj3pxxMpgZds';
const MD_FILE_NAME = 'TaskJournal.md';
const JSON_FILE_NAME = 'TaskData.json';

function doPost(e) {
  if (!e || !e.postData) {
    return ContentService.createTextOutput('No data');
  }

  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput('Error: invalid JSON');
  }

  const folder = DriveApp.getFolderById(FOLDER_ID);

  // 1. 同期用DB（tasks配列）を保存
  if (data.tasks) {
    upsertFile(folder, JSON_FILE_NAME, JSON.stringify(data.tasks));
  }

  // 2. NotebookLM用Markdownを保存
  if (data.markdown) {
    upsertFile(folder, MD_FILE_NAME, data.markdown);
  }

  // ※ カレンダー登録はアプリの「カレンダーに追加」ボタン押下時のみ行う。
  //    日時設定のたびに自動登録すると、ボタン押下分と合わせて二重に予定が入るため、
  //    GAS側での自動同期は廃止した。

  return ContentService.createTextOutput('Success');
}

function doGet(e) {
  try {
    const folder = DriveApp.getFolderById(FOLDER_ID);
    const files = folder.getFilesByName(JSON_FILE_NAME);
    if (files.hasNext()) {
      const content = files.next().getBlob().getDataAsString();
      return ContentService
        .createTextOutput(content)
        .setMimeType(ContentService.MimeType.JSON);
    }
  } catch (err) {
    // フォールバック（下で空配列を返す）
  }
  return ContentService
    .createTextOutput('[]')
    .setMimeType(ContentService.MimeType.JSON);
}

/** 同名ファイルがあれば内容を更新、無ければ新規作成 */
function upsertFile(folder, name, content) {
  const it = folder.getFilesByName(name);
  if (it.hasNext()) {
    it.next().setContent(content);
  } else {
    folder.createFile(name, content, MimeType.PLAIN_TEXT);
  }
}
