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
const SYNC_TOKEN_PROPERTY = 'SYNC_TOKEN';
const SYNC_VERSION = 2;
const MAX_BODY_BYTES = 1000000;
const MAX_TASKS = 1000;
const MAX_TOMBSTONES = 5000;
const MAX_CONFLICTS = 2000;
const MAX_CATEGORIES = 100;
const MAX_LOGS_PER_TASK = 200;

function doPost(e) {
  if (!e || !e.postData) {
    return ContentService.createTextOutput('No data');
  }

  if (Number(e.postData.length || 0) > MAX_BODY_BYTES) {
    return ContentService.createTextOutput('Error: payload too large');
  }

  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput('Error: invalid JSON');
  }

  const queryToken = e && e.parameter ? e.parameter.syncToken : '';
  if (!isAuthorized(data.syncToken || queryToken)) {
    return ContentService.createTextOutput('Unauthorized');
  }

  if (!Array.isArray(data.tasks)) {
    return ContentService.createTextOutput('Error: tasks must be an array');
  }

  let safeTasks;
  let safeTombstones;
  let safeConflicts;
  let safeCategories;
  try {
    safeTasks = validateTasks(data.tasks);
    safeTombstones = validateTombstones(data.tombstones);
    safeConflicts = validateConflicts(data.conflicts);
    safeCategories = validateCategories(data.categories);
  } catch (err) {
    return ContentService.createTextOutput('Error: ' + err.message);
  }

  const usesSyncV2 = Number(data.syncVersion) === SYNC_VERSION;
  const lock = LockService.getScriptLock();
  let mergedState;
  try {
    lock.waitLock(30000);
    const folder = DriveApp.getFolderById(FOLDER_ID);

    // 1. 端末ごとの変更をタスク単位で統合し、削除履歴も保存する。
    const currentState = readSyncState(folder);
    let categoriesUpdatedAt = finiteNumberOrZero(data.categoriesUpdatedAt);
    if (!usesSyncV2 && currentState.categories.length === 0 && safeCategories.length > 0) {
      categoriesUpdatedAt = Date.now();
    }
    mergedState = mergeSyncState(currentState, {
      tasks: safeTasks,
      tombstones: safeTombstones,
      conflicts: safeConflicts,
      categories: safeCategories,
      categoriesUpdatedAt: categoriesUpdatedAt
    });
    mergedState.revision = finiteNumberOrZero(currentState.revision) + 1;
    mergedState.updatedAt = Date.now();
    upsertFile(folder, JSON_FILE_NAME, JSON.stringify(mergedState));

    // 2. NotebookLMが参照する固定IDのGoogleドキュメントを更新
    const doc = getNotebookDocument();
    renderNotebookDocument(doc, mergedState.tasks, mergedState.categories);
  } catch (err) {
    console.error('TaskJournal sync failed: ' + (err && err.stack ? err.stack : err));
    return ContentService.createTextOutput(
      'Error: ' + (err && err.message ? err.message : 'sync failed')
    );
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }

  // ※ カレンダー登録はアプリの「カレンダーに追加」ボタン押下時のみ行う。
  //    日時設定のたびに自動登録すると、ボタン押下分と合わせて二重に予定が入るため、
  //    GAS側での自動同期は廃止した。

  if (usesSyncV2) {
    return ContentService
      .createTextOutput(JSON.stringify(mergedState))
      .setMimeType(ContentService.MimeType.JSON);
  }
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
  const state = readSyncState(folder);
  renderNotebookDocument(doc, state.tasks, state.categories);
  console.log(url);
  return url;
}

function doGet(e) {
  if (!isAuthorized(e && e.parameter ? e.parameter.syncToken : '')) {
    return ContentService
      .createTextOutput('{"error":"Unauthorized"}')
      .setMimeType(ContentService.MimeType.JSON);
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const folder = DriveApp.getFolderById(FOLDER_ID);
    const state = readSyncState(folder);
    const usesSyncV2 = Number(e && e.parameter ? e.parameter.syncVersion : 0) === SYNC_VERSION;
    return ContentService
      .createTextOutput(JSON.stringify(usesSyncV2 ? state : state.tasks))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    // フォールバック（下で空配列を返す）
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
  return ContentService
    .createTextOutput('[]')
    .setMimeType(ContentService.MimeType.JSON);
}

function createEmptySyncState() {
  return {
    syncVersion: SYNC_VERSION,
    revision: 0,
    updatedAt: 0,
    tasks: [],
    tombstones: [],
    conflicts: [],
    categories: [],
    categoriesUpdatedAt: 0
  };
}

/** 旧形式（タスク配列）もv2へ読み替え、既存データを失わない。 */
function readSyncState(folder) {
  const files = folder.getFilesByName(JSON_FILE_NAME);
  if (!files.hasNext()) return createEmptySyncState();
  try {
    const parsed = JSON.parse(files.next().getBlob().getDataAsString());
    return normalizeStoredState(parsed);
  } catch (err) {
    throw new Error('TaskData.json is invalid');
  }
}

function normalizeStoredState(parsed) {
  const state = createEmptySyncState();
  if (Array.isArray(parsed)) {
    state.tasks = validateTasks(parsed);
    return state;
  }
  if (!parsed || typeof parsed !== 'object') return state;
  state.revision = finiteNumberOrZero(parsed.revision);
  state.updatedAt = finiteNumberOrZero(parsed.updatedAt);
  state.tasks = validateTasks(Array.isArray(parsed.tasks) ? parsed.tasks : []);
  state.tombstones = validateTombstones(parsed.tombstones);
  state.conflicts = validateConflicts(parsed.conflicts);
  state.categories = validateCategories(parsed.categories);
  state.categoriesUpdatedAt = finiteNumberOrZero(parsed.categoriesUpdatedAt);
  return mergeSyncState(createEmptySyncState(), state);
}

/** 削除を優先し、通常の更新はupdatedAtが新しい方を採用する。 */
function mergeSyncState(current, incoming) {
  const taskById = {};
  const tombstoneById = {};
  const conflictById = {};

  function applyTask(task) {
    if (!task || !task.id || tombstoneById[task.id]) return;
    const existing = taskById[task.id];
    const incomingTime = finiteNumberOrZero(task.updatedAt || task.createdAt);
    const existingTime = existing
      ? finiteNumberOrZero(existing.updatedAt || existing.createdAt)
      : -1;
    if (existing && taskContentSignature(existing) !== taskContentSignature(task)) {
      const incomingIsSequential = finiteNumberOrZero(task.baseUpdatedAt) === existingTime;
      if (!incomingIsSequential) {
        const conflict = createConflict(existing, task);
        if (!conflictById[conflict.id]) conflictById[conflict.id] = conflict;
      }
    }
    if (!existing || incomingTime > existingTime) taskById[task.id] = task;
  }

  function applyTombstone(tombstone) {
    if (!tombstone || !tombstone.id) return;
    const existing = tombstoneById[tombstone.id];
    if (!existing || tombstone.deletedAt > existing.deletedAt) {
      tombstoneById[tombstone.id] = tombstone;
    }
    delete taskById[tombstone.id];
  }

  (current.tasks || []).forEach(applyTask);
  (current.tombstones || []).forEach(applyTombstone);
  (current.conflicts || []).forEach(applyConflict);
  (incoming.tasks || []).forEach(applyTask);
  (incoming.tombstones || []).forEach(applyTombstone);
  (incoming.conflicts || []).forEach(applyConflict);

  function applyConflict(conflict) {
    if (!conflict || !conflict.id) return;
    const existing = conflictById[conflict.id];
    if (!existing || finiteNumberOrZero(conflict.resolvedAt) > finiteNumberOrZero(existing.resolvedAt)) {
      conflictById[conflict.id] = conflict;
    }
  }

  Object.keys(taskById).forEach(function(id) {
    const task = taskById[id];
    task.baseUpdatedAt = finiteNumberOrZero(task.updatedAt || task.createdAt);
  });

  const currentCategoriesUpdatedAt = finiteNumberOrZero(current.categoriesUpdatedAt);
  const incomingCategoriesUpdatedAt = finiteNumberOrZero(incoming.categoriesUpdatedAt);
  const useIncomingCategories = incomingCategoriesUpdatedAt > currentCategoriesUpdatedAt
    || (currentCategoriesUpdatedAt === 0
      && (current.categories || []).length === 0
      && (incoming.categories || []).length > 0);

  return {
    syncVersion: SYNC_VERSION,
    revision: finiteNumberOrZero(current.revision),
    updatedAt: finiteNumberOrZero(current.updatedAt),
    tasks: Object.keys(taskById).map(function(id) { return taskById[id]; }),
    tombstones: Object.keys(tombstoneById).map(function(id) { return tombstoneById[id]; }),
    conflicts: Object.keys(conflictById).map(function(id) { return conflictById[id]; }),
    categories: useIncomingCategories ? (incoming.categories || []) : (current.categories || []),
    categoriesUpdatedAt: useIncomingCategories
      ? incomingCategoriesUpdatedAt
      : currentCategoriesUpdatedAt
  };
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

function isAuthorized(candidate) {
  const expected = PropertiesService.getScriptProperties().getProperty(SYNC_TOKEN_PROPERTY);
  return !!expected && typeof candidate === 'string' && candidate === expected;
}

function validateTasks(tasks) {
  if (tasks.length > MAX_TASKS) throw new Error('too many tasks');
  return tasks.map(function(task) {
    if (!task || typeof task !== 'object') throw new Error('invalid task');
    const logs = Array.isArray(task.logs) ? task.logs : [];
    if (logs.length > MAX_LOGS_PER_TASK) throw new Error('too many task logs');
    return {
      id: boundedString(task.id, 100, 'task id'),
      text: boundedString(task.text, 500, 'task text'),
      dueDate: optionalString(task.dueDate, 40, 'due date'),
      category: optionalString(task.category, 100, 'category'),
      status: ['todo', 'doing', 'done'].indexOf(task.status) >= 0 ? task.status : 'todo',
      pinned: !!task.pinned,
      logs: logs.map(function(log) { return boundedString(log, 1000, 'task log'); }),
      createdAt: finiteNumberOrZero(task.createdAt),
      updatedAt: finiteNumberOrZero(task.updatedAt) || finiteNumberOrZero(task.createdAt),
      baseUpdatedAt: finiteNumberOrZero(task.baseUpdatedAt)
    };
  });
}

function validateTombstones(tombstones) {
  if (tombstones == null) return [];
  if (!Array.isArray(tombstones) || tombstones.length > MAX_TOMBSTONES) {
    throw new Error('invalid tombstones');
  }
  return tombstones.map(function(tombstone) {
    if (!tombstone || typeof tombstone !== 'object') throw new Error('invalid tombstone');
    const deletedAt = finiteNumberOrZero(tombstone.deletedAt);
    if (!deletedAt) throw new Error('invalid deletion time');
    return {
      id: boundedString(tombstone.id, 100, 'tombstone id'),
      deletedAt: deletedAt
    };
  });
}

function validateConflicts(conflicts) {
  if (conflicts == null) return [];
  if (!Array.isArray(conflicts) || conflicts.length > MAX_CONFLICTS) throw new Error('invalid conflicts');
  return conflicts.map(function(conflict) {
    if (!conflict || typeof conflict !== 'object' || !Array.isArray(conflict.variants) || conflict.variants.length !== 2) {
      throw new Error('invalid conflict');
    }
    if (!/^[A-Za-z0-9._-]{1,180}$/.test(String(conflict.id))) throw new Error('invalid conflict id');
    const variants = validateTasks(conflict.variants);
    return {
      id: boundedString(conflict.id, 180, 'conflict id'),
      taskId: boundedString(conflict.taskId, 100, 'conflict task id'),
      detectedAt: finiteNumberOrZero(conflict.detectedAt),
      resolvedAt: finiteNumberOrZero(conflict.resolvedAt),
      variants: variants
    };
  });
}

function taskContentSignature(task) {
  return JSON.stringify([
    task.text || '', task.dueDate || null, task.category || null,
    task.status || 'todo', !!task.pinned, Array.isArray(task.logs) ? task.logs : []
  ]);
}

function simpleHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function createConflict(taskA, taskB) {
  const variants = validateTasks([taskA, taskB]);
  const signatures = [taskContentSignature(variants[0]), taskContentSignature(variants[1])].sort();
  return {
    id: variants[0].id + '-' + simpleHash(signatures.join('|')),
    taskId: variants[0].id,
    detectedAt: Date.now(),
    resolvedAt: 0,
    variants: variants
  };
}

function validateCategories(categories) {
  if (categories == null) return [];
  if (!Array.isArray(categories) || categories.length > MAX_CATEGORIES) {
    throw new Error('invalid categories');
  }
  return categories.map(function(category) {
    if (!category || typeof category !== 'object') throw new Error('invalid category');
    return {
      id: boundedString(category.id, 100, 'category id'),
      name: boundedString(category.name, 100, 'category name'),
      color: optionalString(category.color, 30, 'category color')
    };
  });
}

function boundedString(value, maxLength, label) {
  if (typeof value !== 'string' || !value || value.length > maxLength) {
    throw new Error('invalid ' + label);
  }
  return value;
}

function optionalString(value, maxLength, label) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new Error('invalid ' + label);
  }
  return value;
}

function finiteNumberOrZero(value) {
  return typeof value === 'number' && isFinite(value) && value >= 0 ? value : 0;
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
  // Body.clear()は文書セクションの最終要素まで削除しようとして失敗する場合がある。
  // 空要素を一時的に残し、その後ろにタイトル段落を追加してから空要素を削除する。
  // 削除時点ではタイトル段落が末尾にあるため、最終要素の削除にはならない。
  body.setText('');
  body.appendParagraph('TaskJournal').setHeading(DocumentApp.ParagraphHeading.TITLE);
  body.removeChild(body.getChild(0));
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
