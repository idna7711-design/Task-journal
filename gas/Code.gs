/**
 * TaskJournal バックエンド (Google Apps Script)
 *
 * 役割:
 *   doPost … アプリから { tasks, categories } を受け取り
 *            - TaskData.json … 同期用DB（tasks配列）を Drive に保存
 *            - 固定IDのGoogleドキュメント … NotebookLM用のタスク一覧を上書き
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
const JSON_FILE_NAME = 'TaskData.json';
const NOTEBOOK_DOC_ID = '1avg594_Kg4HqXNFZijWatgSn1g1ofTjXa5eeOiHHdSE';

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

  if (!Array.isArray(data.tasks)) {
    return ContentService.createTextOutput('Error: tasks must be an array');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const folder = DriveApp.getFolderById(FOLDER_ID);

    // 1. 複数端末同期用DBを更新
    upsertFile(folder, JSON_FILE_NAME, JSON.stringify(data.tasks));

    // 2. NotebookLMが参照する固定IDのGoogleドキュメントを更新
    const doc = getNotebookDocument();
    renderNotebookDocument(doc, data.tasks, data.categories);
  } finally {
    lock.releaseLock();
  }

  // ※ カレンダー登録はアプリの「カレンダーに追加」ボタン押下時のみ行う。
  //    日時設定のたびに自動登録すると、ボタン押下分と合わせて二重に予定が入るため、
  //    GAS側での自動同期は廃止した。

  return ContentService.createTextOutput('Success');
}

/**
 * 初回セットアップ用。GASエディタから1回実行すると、固定Googleドキュメントへ
 * 現在のTaskData.jsonを反映する。戻り値のURLをNotebookLMへソース登録する。
 */
function setupNotebookDocument() {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const doc = getNotebookDocument();
  const url = doc.getUrl();
  let tasks = [];
  const files = folder.getFilesByName(JSON_FILE_NAME);
  if (files.hasNext()) {
    try {
      const parsed = JSON.parse(files.next().getBlob().getDataAsString());
      if (Array.isArray(parsed)) tasks = parsed;
    } catch (err) {
      // JSONが壊れていても空のドキュメントを作成し、次回同期で回復できるようにする。
    }
  }
  renderNotebookDocument(doc, tasks, []);
  console.log(url);
  return url;
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

/** NotebookLMへ登録済みの固定ドキュメントを取得する。 */
function getNotebookDocument() {
  return DocumentApp.openById(NOTEBOOK_DOC_ID);
}

/** タスク配列をNotebookLM向けの読みやすいGoogleドキュメントへ変換する。 */
function renderNotebookDocument(doc, tasks, categories) {
  const categoryNames = {};
  if (Array.isArray(categories)) {
    categories.forEach(function(category) {
      if (category && category.id) categoryNames[category.id] = category.name || category.id;
    });
  }

  const active = tasks.filter(function(task) { return task && task.status !== 'done'; });
  const done = tasks.filter(function(task) { return task && task.status === 'done'; });
  const body = doc.getBody();
  body.clear();
  body.appendParagraph('TaskJournal').setHeading(DocumentApp.ParagraphHeading.TITLE);
  body.appendParagraph('最終更新: ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'));
  appendTaskSection(body, '進行中・未完了', active, categoryNames);
  appendTaskSection(body, '完了済み', done, categoryNames);
  doc.saveAndClose();
}

function appendTaskSection(body, title, tasks, categoryNames) {
  body.appendParagraph(title).setHeading(DocumentApp.ParagraphHeading.HEADING1);
  if (tasks.length === 0) {
    body.appendParagraph('なし');
    return;
  }

  tasks.forEach(function(task) {
    body.appendParagraph(String(task.text || '（名称なし）'))
      .setHeading(DocumentApp.ParagraphHeading.HEADING2);
    const status = task.status === 'doing' ? '進行中' : (task.status === 'done' ? '完了' : '未着手');
    body.appendListItem('状態: ' + status).setGlyphType(DocumentApp.GlyphType.BULLET);
    if (task.category) {
      body.appendListItem('カテゴリ: ' + (categoryNames[task.category] || task.category))
        .setGlyphType(DocumentApp.GlyphType.BULLET);
    }
    if (task.dueDate) {
      body.appendListItem('予定日時: ' + task.dueDate).setGlyphType(DocumentApp.GlyphType.BULLET);
    }
    if (Array.isArray(task.logs) && task.logs.length > 0) {
      body.appendListItem('ログ').setGlyphType(DocumentApp.GlyphType.BULLET);
      task.logs.forEach(function(log) {
        body.appendListItem(String(log))
          .setGlyphType(DocumentApp.GlyphType.BULLET)
          .setNestingLevel(1);
      });
    }
  });
}
