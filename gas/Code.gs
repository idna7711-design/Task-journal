/**
 * TaskJournal バックエンド (Google Apps Script)
 *
 * 役割:
 *   doPost … アプリから { tasks, markdown } を受け取り
 *            - TaskData.json   … 同期用DB（tasks配列）を Drive に保存
 *            - TaskJournal.md  … NotebookLM用Markdownを Drive に保存
 *            - Googleカレンダー … dueDate付き・未完了タスクを作成/更新
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

  // 3. Googleカレンダー自動同期
  if (data.tasks && data.tasks.length > 0) {
    try {
      const calendar = CalendarApp.getDefaultCalendar();
      data.tasks.forEach(task => {
        if (task.status === 'done' || !task.dueDate) return;

        const startTime = new Date(task.dueDate);
        const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);
        const title = '[Task] ' + task.text;
        let desc = 'TaskJournalからの自動同期\n(ID:' + task.id + ')\n\n';
        if (task.logs && task.logs.length > 0) desc += task.logs.join('\n');

        // task.id を説明文に含めているので、それで既存予定を検索して重複を防ぐ
        const events = calendar.getEvents(
          new Date(startTime.getTime() - 30 * 24 * 60 * 60 * 1000),
          new Date(endTime.getTime() + 30 * 24 * 60 * 60 * 1000),
          { search: task.id }
        );
        if (events.length > 0) {
          const ev = events[0];
          ev.setTitle(title);
          ev.setTime(startTime, endTime);
          ev.setDescription(desc);
        } else {
          calendar.createEvent(title, startTime, endTime, { description: desc });
        }
      });
    } catch (err) {
      // カレンダー権限未許可などは握りつぶす（保存処理は成功させる）
    }
  }

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
