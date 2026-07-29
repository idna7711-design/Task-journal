/**
 * TaskJournal バックエンド (Google Apps Script)
 *
 * 役割:
 *   doPost … アプリから { tasks, categories } を受け取り
 *            - TaskData.json … 同期用DB（tasks配列）を Drive に保存
 *            - 固定IDのGoogleドキュメント … NotebookLM用のタスク一覧を上書き
 *            - 選択中のGoogleカレンダー … アプリのカレンダー画面へ返す
 *            - TaskJournal専用カレンダー … 明示的に連携したタスクを予定として同期
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
const PROTOCOL_VERSION = 3;
const MAX_BODY_BYTES = 1000000;
const MAX_TASKS = 1000;
const MAX_TOMBSTONES = 5000;
const MAX_CONFLICTS = 2000;
const MAX_CATEGORIES = 100;
const MAX_LOGS_PER_TASK = 200;
const MAX_MUTATIONS = 500;
const MAX_APPLIED_MUTATIONS = 5000;
const NOTEBOOK_REFRESH_HANDLER = 'runPendingNotebookRefresh';
const NOTEBOOK_REFRESH_PENDING_PROPERTY = 'NOTEBOOK_REFRESH_PENDING_AT';
const NOTEBOOK_REFRESH_ATTEMPTS_PROPERTY = 'NOTEBOOK_REFRESH_ATTEMPTS';
const NOTEBOOK_REFRESH_DELAY_MS = 10000;
const NOTEBOOK_REFRESH_MAX_ATTEMPTS = 3;
const CALENDAR_TOKEN_CONTEXT = 'TaskJournal calendar read v1';
const CALENDAR_MAX_RANGE_DAYS = 45;
const CALENDAR_MAX_CALENDARS = 20;
const CALENDAR_MAX_EVENTS = 300;
const CALENDAR_CACHE_SECONDS = 180;
const CALENDAR_CACHE_MAX_BYTES = 90000;
const TASKJOURNAL_CALENDAR_ID_PROPERTY = 'TASKJOURNAL_CALENDAR_ID';
const TASKJOURNAL_CALENDAR_NAME = 'TaskJournal';
const TASKJOURNAL_CALENDAR_RECONCILED_AT_PROPERTY = 'TASKJOURNAL_CALENDAR_RECONCILED_AT';
const TASKJOURNAL_CALENDAR_CACHE_EPOCH_PROPERTY = 'TASKJOURNAL_CALENDAR_CACHE_EPOCH';
const TASKJOURNAL_CALENDAR_RECONCILE_INTERVAL_MS = 60000;
const TASKJOURNAL_CALENDAR_DURATION_MS = 60 * 60 * 1000;
const TASKJOURNAL_CALENDAR_MAX_WRITES = 20;

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

  const requestId = safeRequestId(data.requestId);
  const requestStartedAt = Date.now();
  console.log(JSON.stringify({
    event: 'taskjournal_request_started',
    requestId: requestId,
    action: String(data.action || 'legacy').slice(0, 30),
    attempt: positiveIntegerOrZero(data.attempt)
  }));

  if (data.action === 'calendar-range') {
    if (Number(data.protocolVersion) !== PROTOCOL_VERSION) {
      return jsonOutput({
        protocolVersion: PROTOCOL_VERSION,
        requestId: requestId,
        error: 'Calendar protocol mismatch',
        errorCode: 'CALENDAR_PROTOCOL_MISMATCH'
      });
    }
    if (!isCalendarReadAuthorized(data.calendarToken)) {
      return jsonOutput({
        protocolVersion: PROTOCOL_VERSION,
        requestId: requestId,
        error: 'Unauthorized',
        errorCode: 'CALENDAR_UNAUTHORIZED'
      });
    }
    return handleCalendarRange(data, requestId, requestStartedAt);
  }

  const queryToken = e && e.parameter ? e.parameter.syncToken : '';
  if (!isAuthorized(data.syncToken || queryToken)) {
    return ContentService.createTextOutput('Unauthorized');
  }

  if (data.action === 'capabilities') {
    console.log(JSON.stringify({
      event: 'taskjournal_request_completed',
      requestId: requestId,
      action: 'capabilities',
      elapsedMs: Date.now() - requestStartedAt
    }));
    return jsonOutput({
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId,
      capabilities: {
        mutationSync: true,
        conflictPreservation: true,
        postOnlyToken: true,
        calendarRead: true,
        calendarWrite: true,
        calendarDeleteSync: true,
        calendarWriteTarget: 'dedicated-calendar',
        calendarTokenDerivation: 'hmac-sha256-v1'
      }
    });
  }

  if (data.action === 'sync' && Number(data.protocolVersion) === PROTOCOL_VERSION) {
    return handleMutationSync(data);
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
  let stateSaved = false;
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
    stateSaved = true;
  } catch (err) {
    console.error('TaskJournal sync failed: ' + (err && err.stack ? err.stack : err));
    return ContentService.createTextOutput(
      'Error: ' + (err && err.message ? err.message : 'sync failed')
    );
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }

  // Googleドキュメント全体の更新は重いため、応答後の時間主導トリガーへ分離する。
  // 失敗してもJSON同期は成功済みなので、端末の変更を送信待ちへ戻さない。
  if (stateSaved) scheduleNotebookDocumentRefresh();

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
 * 同期v3: 端末時刻ではなくタスクごとの版番号で変更を直列化する。
 * 送信済みmutationIdは再送されても二重適用せず、分岐は両候補を競合として保持する。
 */
function handleMutationSync(data) {
  const requestId = safeRequestId(data.requestId);
  const requestStartedAt = Date.now();
  let mutations;
  let categoryMutation;
  let resolvedConflictIds;
  try {
    mutations = validateMutations(data.mutations);
    categoryMutation = validateCategoryMutation(data.categoryMutation);
    resolvedConflictIds = validateResolvedConflictIds(data.resolvedConflictIds);
  } catch (err) {
    console.error(JSON.stringify({ event: 'taskjournal_request_failed', requestId: requestId, stage: 'validation', error: err.message }));
    return jsonOutput({ protocolVersion: PROTOCOL_VERSION, requestId: requestId, error: 'Invalid request: ' + err.message });
  }

  const lock = LockService.getScriptLock();
  let result;
  let taskStateChanged = false;
  try {
    lock.waitLock(30000);
    const folder = DriveApp.getFolderById(FOLDER_ID);
    const state = normalizeProtocol3State(readSyncState(folder));
    result = applyMutations(state, mutations, categoryMutation, resolvedConflictIds);
    if (result.changed) {
      result.state.revision = finiteNumberOrZero(state.revision) + 1;
      result.state.updatedAt = Date.now();
      upsertFile(folder, JSON_FILE_NAME, JSON.stringify(result.state));
      taskStateChanged = true;
    }
  } catch (err) {
    console.error(JSON.stringify({
      event: 'taskjournal_request_failed',
      requestId: requestId,
      stage: 'drive',
      elapsedMs: Date.now() - requestStartedAt,
      error: err && err.message ? err.message : 'sync failed'
    }));
    return jsonOutput({ protocolVersion: PROTOCOL_VERSION, requestId: requestId, error: err && err.message ? err.message : 'sync failed' });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }

  // Driveのロック外でGoogle Calendar APIを呼び、他端末のタスク同期を待たせない。
  const calendarSync = synchronizeTaskJournalCalendar(result.state, requestId);
  let responseState = result.state;
  let calendarStateChanged = false;
  if (calendarSync.operationResults.length > 0 || calendarSync.reconciled) {
    const patchLock = LockService.getScriptLock();
    try {
      patchLock.waitLock(30000);
      const folder = DriveApp.getFolderById(FOLDER_ID);
      const latestState = normalizeProtocol3State(readSyncState(folder));
      const patch = applyTaskJournalCalendarResults(latestState, calendarSync);
      calendarStateChanged = patch.changed;
      calendarSync.externalDeleted = patch.externalDeleted;
      if (patch.externalDeleted > 0) bumpTaskJournalCalendarCacheEpoch();
      if (patch.changed) {
        latestState.revision = finiteNumberOrZero(latestState.revision) + 1;
        latestState.updatedAt = Date.now();
        upsertFile(folder, JSON_FILE_NAME, JSON.stringify(latestState));
      }
      responseState = latestState;
    } catch (err) {
      calendarSync.failed += 1;
      calendarSync.errorCode = calendarSync.errorCode || 'CALENDAR_STATE_PATCH_FAILED';
      console.error(JSON.stringify({
        event: 'taskjournal_calendar_state_patch_failed',
        requestId: requestId,
        error: err && err.message ? err.message : 'calendar state patch failed'
      }));
    } finally {
      if (patchLock.hasLock()) patchLock.releaseLock();
    }
  }

  // NotebookLM用ドキュメント更新は応答後に行い、iPhone Safariの待ち時間を短縮する。
  if (taskStateChanged || calendarStateChanged) scheduleNotebookDocumentRefresh();

  console.log(JSON.stringify({
    event: 'taskjournal_request_completed',
    requestId: requestId,
    action: 'sync',
    elapsedMs: Date.now() - requestStartedAt,
    mutationCount: mutations.length,
    changed: taskStateChanged || calendarStateChanged,
    calendarUpserted: calendarSync.upserted,
    calendarDeleted: calendarSync.deleted,
    calendarExternalDeleted: calendarSync.externalDeleted,
    calendarFailed: calendarSync.failed
  }));

  return jsonOutput({
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId,
    revision: responseState.revision,
    tasks: responseState.tasks,
    tombstones: responseState.tombstones,
    conflicts: responseState.conflicts,
    categories: responseState.categories,
    categoriesVersion: responseState.categoriesVersion,
    ackedMutationIds: result.ackedMutationIds,
    mutationResults: result.mutationResults,
    ackedCategoryMutationId: result.ackedCategoryMutationId,
    calendarSync: publicCalendarSyncReport(calendarSync)
  });
}

function safeRequestId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(value) ? value : '';
}

/**
 * NotebookLM用ドキュメントの更新を1本の時間主導トリガーへまとめる。
 * 同期データは先にDriveへ保存済みなので、トリガー作成失敗でも同期結果は失わない。
 */
function scheduleNotebookDocumentRefresh() {
  const properties = PropertiesService.getScriptProperties();
  properties.setProperty(NOTEBOOK_REFRESH_PENDING_PROPERTY, String(Date.now()));
  properties.setProperty(NOTEBOOK_REFRESH_ATTEMPTS_PROPERTY, '0');
  ensureNotebookRefreshTrigger();
}

function ensureNotebookRefreshTrigger() {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
    const exists = ScriptApp.getProjectTriggers().some(function(trigger) {
      return trigger.getHandlerFunction() === NOTEBOOK_REFRESH_HANDLER;
    });
    if (!exists) {
      ScriptApp.newTrigger(NOTEBOOK_REFRESH_HANDLER)
        .timeBased()
        .after(NOTEBOOK_REFRESH_DELAY_MS)
        .create();
    }
  } catch (err) {
    console.error('Notebook refresh trigger could not be scheduled: ' + (err && err.stack ? err.stack : err));
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

/** 時間主導トリガーから呼ばれ、最新JSONを固定Googleドキュメントへ反映する。 */
function runPendingNotebookRefresh() {
  const properties = PropertiesService.getScriptProperties();
  const pendingBefore = properties.getProperty(NOTEBOOK_REFRESH_PENDING_PROPERTY);
  removeNotebookRefreshTriggers();
  if (!pendingBefore) return;

  const refreshed = refreshNotebookDocumentSafely();
  const pendingAfter = properties.getProperty(NOTEBOOK_REFRESH_PENDING_PROPERTY);
  if (refreshed && pendingAfter === pendingBefore) {
    properties.deleteProperty(NOTEBOOK_REFRESH_PENDING_PROPERTY);
    properties.deleteProperty(NOTEBOOK_REFRESH_ATTEMPTS_PROPERTY);
    return;
  }

  if (refreshed) {
    properties.setProperty(NOTEBOOK_REFRESH_ATTEMPTS_PROPERTY, '0');
    ensureNotebookRefreshTrigger();
    return;
  }

  const attempts = positiveIntegerOrZero(properties.getProperty(NOTEBOOK_REFRESH_ATTEMPTS_PROPERTY)) + 1;
  properties.setProperty(NOTEBOOK_REFRESH_ATTEMPTS_PROPERTY, String(attempts));
  if (attempts < NOTEBOOK_REFRESH_MAX_ATTEMPTS) ensureNotebookRefreshTrigger();
}

function removeNotebookRefreshTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === NOTEBOOK_REFRESH_HANDLER) ScriptApp.deleteTrigger(trigger);
  });
}

/**
 * NotebookLM用Googleドキュメントを最新JSONから再生成する。
 * ScriptLockはJSONの読取中だけ保持し、DocumentAppの重い処理とは分離する。
 */
function refreshNotebookDocumentSafely() {
  const documentLock = LockService.getUserLock();
  const stateLock = LockService.getScriptLock();
  let latestState;
  try {
    documentLock.waitLock(30000);
    try {
      stateLock.waitLock(10000);
      const folder = DriveApp.getFolderById(FOLDER_ID);
      latestState = readSyncState(folder);
    } finally {
      if (stateLock.hasLock()) stateLock.releaseLock();
    }
    const doc = getNotebookDocument();
    renderNotebookDocument(doc, latestState.tasks, latestState.categories);
    return true;
  } catch (err) {
    console.error('Notebook document refresh failed: ' + (err && err.stack ? err.stack : err));
    return false;
  } finally {
    if (documentLock.hasLock()) documentLock.releaseLock();
  }
}

function normalizeProtocol3State(state) {
  state.protocolVersion = PROTOCOL_VERSION;
  state.tasks = validateTasks(state.tasks || []).map(function(task) {
    task.serverVersion = positiveIntegerOrZero(task.serverVersion) || 1;
    task.lastMutationId = safeIdOrEmpty(task.lastMutationId);
    if (task.calendarLinked && task.dueDate) {
      task.calendarEventId = safeIdOrEmpty(task.calendarEventId) || taskJournalCalendarEventId(task.id);
      task.calendarSyncVersion = Math.min(
        positiveIntegerOrZero(task.calendarSyncVersion),
        task.serverVersion
      );
    } else {
      task.calendarLinked = false;
      task.calendarEventId = '';
      task.calendarSyncVersion = 0;
      task.calendarSyncedAt = 0;
    }
    task.deleted = false;
    return task;
  });
  state.tombstones = validateTombstones(state.tombstones || []).map(function(item) {
    item.serverVersion = positiveIntegerOrZero(item.serverVersion) || 1;
    item.lastMutationId = safeIdOrEmpty(item.lastMutationId);
    return item;
  });
  state.conflicts = validateConflicts(state.conflicts || []);
  state.appliedMutations = validateAppliedMutations(state.appliedMutations);
  state.categoriesVersion = positiveIntegerOrZero(state.categoriesVersion)
    || positiveIntegerOrZero(state.categoriesUpdatedAt);
  state.lastCategoryMutationId = safeIdOrEmpty(state.lastCategoryMutationId);
  return state;
}

function applyMutations(state, mutations, categoryMutation, resolvedConflictIds) {
  const taskById = {};
  const tombstoneById = {};
  const conflictById = {};
  const applied = {};
  const acked = [];
  const mutationResults = [];
  let changed = false;

  state.tasks.forEach(function(task) { taskById[task.id] = task; });
  state.tombstones.forEach(function(item) { tombstoneById[item.id] = item; });
  state.conflicts.forEach(function(item) { conflictById[item.id] = item; });
  state.appliedMutations.forEach(function(item) { applied[item.id] = item; });
  resolvedConflictIds.forEach(function(id) {
    if (conflictById[id] && !conflictById[id].resolvedAt) {
      conflictById[id].resolvedAt = Date.now();
      changed = true;
    }
  });

  mutations.forEach(function(mutation) {
    if (applied[mutation.mutationId]) {
      acked.push(mutation.mutationId);
      mutationResults.push({
        mutationId: mutation.mutationId,
        taskId: mutation.taskId,
        status: 'duplicate'
      });
      return;
    }
    const currentTask = taskById[mutation.taskId];
    const currentTombstone = tombstoneById[mutation.taskId];
    const current = currentTask || currentTombstone || null;
    const currentVersion = current ? positiveIntegerOrZero(current.serverVersion) : 0;
    const currentMutationId = current ? safeIdOrEmpty(current.lastMutationId) : '';
    const resolvingConflict = mutation.resolvesConflictId && conflictById[mutation.resolvesConflictId]
      && !conflictById[mutation.resolvesConflictId].resolvedAt
      && conflictById[mutation.resolvesConflictId].taskId === mutation.taskId;
    const followsCurrent = mutation.baseVersion === currentVersion
      || (!!mutation.parentMutationId && mutation.parentMutationId === currentMutationId)
      || !!resolvingConflict;

    let mutationStatus = 'applied';
    let resultVersion = currentVersion;
    if (followsCurrent) {
      const nextVersion = currentVersion + 1;
      resultVersion = nextVersion;
      if (mutation.operation === 'delete') {
        delete taskById[mutation.taskId];
        tombstoneById[mutation.taskId] = createTaskDeletionTombstone(
          currentTask || mutation.task,
          mutation,
          nextVersion
        );
      } else {
        const next = validateTasks([mutation.task])[0];
        next.id = mutation.taskId;
        next.serverVersion = nextVersion;
        next.lastMutationId = mutation.mutationId;
        next.deleted = false;
        prepareCalendarTaskForMutation(next, currentTask);
        taskById[mutation.taskId] = next;
        delete tombstoneById[mutation.taskId];
      }
      if (resolvingConflict) conflictById[mutation.resolvesConflictId].resolvedAt = Date.now();
    } else {
      mutationStatus = 'conflict';
      const currentVariant = currentTask
        ? currentTask
        : deletionVariant(mutation.taskId, mutation.task && mutation.task.text, currentVersion, currentMutationId);
      const incomingVariant = mutation.operation === 'delete'
        ? deletionVariant(mutation.taskId, mutation.task && mutation.task.text, mutation.baseVersion, mutation.mutationId)
        : mutation.task;
      const conflict = createVersionConflict(currentVariant, incomingVariant);
      conflictById[conflict.id] = conflict;
    }

    applied[mutation.mutationId] = { id: mutation.mutationId, appliedAt: Date.now() };
    acked.push(mutation.mutationId);
    mutationResults.push({
      mutationId: mutation.mutationId,
      taskId: mutation.taskId,
      status: mutationStatus,
      serverVersion: resultVersion
    });
    changed = true;
  });

  let ackedCategoryMutationId = '';
  if (categoryMutation) {
    if (categoryMutation.mutationId === state.lastCategoryMutationId) {
      ackedCategoryMutationId = categoryMutation.mutationId;
    } else if (categoryMutation.baseVersion === positiveIntegerOrZero(state.categoriesVersion)) {
      state.categories = categoryMutation.categories;
      state.categoriesVersion = positiveIntegerOrZero(state.categoriesVersion) + 1;
      state.lastCategoryMutationId = categoryMutation.mutationId;
      ackedCategoryMutationId = categoryMutation.mutationId;
      changed = true;
    }
  }

  state.tasks = Object.keys(taskById).map(function(id) { return taskById[id]; });
  state.tombstones = Object.keys(tombstoneById).map(function(id) { return tombstoneById[id]; });
  state.conflicts = Object.keys(conflictById).map(function(id) { return conflictById[id]; });
  state.appliedMutations = Object.keys(applied).map(function(id) { return applied[id]; })
    .sort(function(a, b) { return a.appliedAt - b.appliedAt; })
    .slice(-MAX_APPLIED_MUTATIONS);
  return {
    state: state,
    ackedMutationIds: acked,
    mutationResults: mutationResults,
    ackedCategoryMutationId: ackedCategoryMutationId,
    changed: changed
  };
}

function prepareCalendarTaskForMutation(next, currentTask) {
  if (!next.calendarLinked || !next.dueDate) {
    next.calendarLinked = false;
    next.calendarEventId = '';
    next.calendarSyncVersion = 0;
    next.calendarSyncedAt = 0;
    return next;
  }
  const previousEventId = currentTask && currentTask.calendarLinked
    ? safeIdOrEmpty(currentTask.calendarEventId)
    : '';
  next.calendarEventId = previousEventId || taskJournalCalendarEventId(next.id);
  next.calendarSyncVersion = previousEventId
    ? Math.min(positiveIntegerOrZero(currentTask.calendarSyncVersion), positiveIntegerOrZero(currentTask.serverVersion))
    : 0;
  next.calendarSyncedAt = previousEventId ? finiteNumberOrZero(currentTask.calendarSyncedAt) : 0;
  return next;
}

function createTaskDeletionTombstone(task, mutation, nextVersion) {
  const eventId = task && task.calendarLinked ? safeIdOrEmpty(task.calendarEventId) : '';
  const deleteRequested = !!eventId && !!mutation.deleteGoogleCalendarEvent;
  return {
    id: mutation.taskId,
    deletedAt: Date.now(),
    serverVersion: nextVersion,
    lastMutationId: mutation.mutationId,
    calendarEventId: eventId,
    calendarDeleteRequested: deleteRequested,
    calendarDeletedAt: 0,
    deleteSource: 'taskjournal'
  };
}

function taskJournalCalendarEventId(taskId) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(taskId),
    Utilities.Charset.UTF_8
  );
  const hex = digest.map(function(value) {
    return ((value + 256) % 256).toString(16).padStart(2, '0');
  }).join('');
  return 'tj' + hex.slice(0, 40);
}

function deletionVariant(id, text, serverVersion, lastMutationId) {
  return {
    id: id,
    text: text || 'このタスク',
    dueDate: null,
    category: null,
    status: 'todo',
    pinned: false,
    logs: [],
    createdAt: 0,
    updatedAt: 0,
    baseUpdatedAt: 0,
    serverVersion: positiveIntegerOrZero(serverVersion),
    lastMutationId: safeIdOrEmpty(lastMutationId),
    calendarLinked: false,
    calendarEventId: '',
    calendarSyncVersion: 0,
    calendarSyncedAt: 0,
    deleted: true
  };
}

function createVersionConflict(taskA, taskB) {
  const variants = [normalizeConflictVariant(taskA), normalizeConflictVariant(taskB)];
  const signatures = variants.map(taskContentSignature).sort();
  const taskId = variants[0].id;
  return {
    id: taskId + '-' + simpleHash(signatures.join('|')),
    taskId: taskId,
    detectedAt: Date.now(),
    resolvedAt: 0,
    variants: variants
  };
}

function normalizeConflictVariant(task) {
  const normalized = validateTasks([task])[0];
  normalized.deleted = !!task.deleted;
  return normalized;
}

function jsonOutput(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 旧セットアップとの互換用。新規セットアップではauthorizeCalendarIntegrationを使う。
 */
function authorizeCalendarRead() {
  const calendars = CalendarApp.getAllCalendars();
  console.log(JSON.stringify({
    event: 'taskjournal_calendar_authorized',
    calendarCount: calendars.length
  }));
  return calendars.length;
}

/**
 * GASエディタから初回に1度実行する。
 * 選択中カレンダーの読み取りと、TaskJournal専用カレンダーへの書き込みを承認する。
 */
function authorizeCalendarIntegration() {
  const calendars = CalendarApp.getAllCalendars();
  const calendarId = getTaskJournalCalendarId(true);
  const createdCalendar = Calendar.Calendars.get(calendarId);
  Calendar.Events.list(calendarId, { maxResults: 1, showDeleted: false });
  console.log(JSON.stringify({
    event: 'taskjournal_calendar_integration_authorized',
    readableCalendarCount: calendars.length,
    dedicatedCalendarIdSet: !!calendarId
  }));
  return String(createdCalendar.summary || TASKJOURNAL_CALENDAR_NAME);
}

function isCalendarReadAuthorized(candidate) {
  const expectedSyncToken = PropertiesService.getScriptProperties().getProperty(SYNC_TOKEN_PROPERTY);
  if (!expectedSyncToken || typeof candidate !== 'string' || !/^[A-Za-z0-9_-]{40,100}$/.test(candidate)) {
    return false;
  }
  const signature = Utilities.computeHmacSha256Signature(
    CALENDAR_TOKEN_CONTEXT,
    expectedSyncToken,
    Utilities.Charset.UTF_8
  );
  const expected = Utilities.base64EncodeWebSafe(signature).replace(/=+$/g, '');
  return constantTimeStringEquals(candidate, expected);
}

function constantTimeStringEquals(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  let difference = a.length ^ b.length;
  const maxLength = Math.max(a.length, b.length);
  for (let index = 0; index < maxLength; index++) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function handleCalendarRange(data, requestId, requestStartedAt) {
  let range;
  try {
    range = validateCalendarRange(data.start, data.end);
  } catch (err) {
    return jsonOutput({
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId,
      error: err && err.message ? err.message : 'Invalid calendar range',
      errorCode: 'CALENDAR_INVALID_RANGE'
    });
  }

  const cacheEpoch = PropertiesService.getScriptProperties()
    .getProperty(TASKJOURNAL_CALENDAR_CACHE_EPOCH_PROPERTY) || '0';
  const cacheKey = 'calendar-v1-' + cacheEpoch + '-' + range.start.getTime() + '-' + range.end.getTime();
  const cache = CacheService.getScriptCache();
  const cachedText = cache.get(cacheKey);
  if (cachedText) {
    try {
      const cached = JSON.parse(cachedText);
      cached.protocolVersion = PROTOCOL_VERSION;
      cached.requestId = requestId;
      cached.cached = true;
      console.log(JSON.stringify({
        event: 'taskjournal_calendar_completed',
        requestId: requestId,
        elapsedMs: Date.now() - requestStartedAt,
        eventCount: Array.isArray(cached.events) ? cached.events.length : 0,
        cached: true
      }));
      return jsonOutput(cached);
    } catch (err) {
      cache.remove(cacheKey);
    }
  }

  let calendars;
  try {
    calendars = CalendarApp.getAllCalendars()
      .filter(function(calendar) { return calendar.isSelected(); })
      .slice(0, CALENDAR_MAX_CALENDARS);
    if (calendars.length === 0) calendars = [CalendarApp.getDefaultCalendar()];
  } catch (err) {
    console.error('Calendar list read failed');
    return jsonOutput({
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId,
      error: 'Google Calendar permission or connection failed',
      errorCode: 'CALENDAR_READ_FAILED'
    });
  }

  const events = [];
  let successfulCalendars = 0;
  let failedCalendars = 0;
  calendars.some(function(calendar, calendarIndex) {
    if (events.length >= CALENDAR_MAX_EVENTS) return true;
    try {
      const timeZone = calendar.getTimeZone() || Session.getScriptTimeZone();
      const calendarName = String(calendar.getName() || 'Googleカレンダー').slice(0, 100);
      const calendarColor = safeCalendarHexColor(calendar.getColor());
      const remaining = CALENDAR_MAX_EVENTS - events.length;
      const calendarEvents = calendar.getEvents(range.start, range.end, { max: remaining });
      calendarEvents.slice(0, remaining).forEach(function(event) {
        const allDay = event.isAllDayEvent();
        const startTime = event.getStartTime();
        const endTime = event.getEndTime();
        const scriptTimeZone = Session.getScriptTimeZone();
        const start = allDay
          ? Utilities.formatDate(event.getAllDayStartDate(), scriptTimeZone, 'yyyy-MM-dd')
          : startTime.toISOString();
        const end = allDay
          ? Utilities.formatDate(event.getAllDayEndDate(), scriptTimeZone, 'yyyy-MM-dd')
          : endTime.toISOString();
        const dayPath = allDay
          ? start.replace(/-/g, '/')
          : Utilities.formatDate(startTime, timeZone, 'yyyy/M/d');
        events.push({
          key: simpleHash(calendar.getId() + '|' + event.getId() + '|' + start),
          title: String(event.getTitle() || '（無題の予定）').slice(0, 300),
          start: start,
          end: end,
          allDay: allDay,
          calendarName: calendarName,
          color: calendarColor,
          openUrl: 'https://calendar.google.com/calendar/u/0/r/day/' + dayPath
        });
      });
      successfulCalendars += 1;
    } catch (err) {
      failedCalendars += 1;
      console.error(JSON.stringify({
        event: 'taskjournal_calendar_partial_failure',
        requestId: requestId,
        calendarIndex: calendarIndex
      }));
    }
    return events.length >= CALENDAR_MAX_EVENTS;
  });

  if (successfulCalendars === 0 && failedCalendars > 0) {
    return jsonOutput({
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId,
      error: 'Google Calendar read failed',
      errorCode: 'CALENDAR_READ_FAILED'
    });
  }

  events.sort(function(left, right) {
    return String(left.start).localeCompare(String(right.start))
      || String(left.title).localeCompare(String(right.title));
  });
  const response = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId,
    events: events,
    calendarCount: successfulCalendars,
    partial: failedCalendars > 0,
    truncated: events.length >= CALENDAR_MAX_EVENTS,
    cached: false
  };
  const cacheValue = JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    events: events,
    calendarCount: successfulCalendars,
    partial: failedCalendars > 0,
    truncated: events.length >= CALENDAR_MAX_EVENTS
  });
  if (Utilities.newBlob(cacheValue).getBytes().length <= CALENDAR_CACHE_MAX_BYTES) {
    try {
      cache.put(cacheKey, cacheValue, CALENDAR_CACHE_SECONDS);
    } catch (err) {
      console.warn('Calendar cache write skipped');
    }
  }
  console.log(JSON.stringify({
    event: 'taskjournal_calendar_completed',
    requestId: requestId,
    elapsedMs: Date.now() - requestStartedAt,
    eventCount: events.length,
    calendarCount: successfulCalendars,
    failedCalendars: failedCalendars,
    cached: false
  }));
  return jsonOutput(response);
}

function validateCalendarRange(startValue, endValue) {
  if (typeof startValue !== 'string' || typeof endValue !== 'string'
      || startValue.length > 40 || endValue.length > 40) {
    throw new Error('Invalid calendar range');
  }
  const start = new Date(startValue);
  const end = new Date(endValue);
  const rangeMs = end.getTime() - start.getTime();
  if (isNaN(start.getTime()) || isNaN(end.getTime())
      || rangeMs <= 0 || rangeMs > CALENDAR_MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
    throw new Error('Invalid calendar range');
  }
  return { start: start, end: end };
}

function safeCalendarHexColor(value) {
  const color = String(value || '');
  return /^#[0-9a-f]{6}$/i.test(color) ? color : '#4285f4';
}

function getTaskJournalCalendarId(createIfMissing) {
  const properties = PropertiesService.getScriptProperties();
  const existingId = String(properties.getProperty(TASKJOURNAL_CALENDAR_ID_PROPERTY) || '');
  if (existingId) {
    try {
      Calendar.Calendars.get(existingId);
      return existingId;
    } catch (err) {
      if (isCalendarApiMissing(err)) {
        const missing = new Error('TaskJournal calendar is missing');
        missing.code = 'CALENDAR_CONTAINER_MISSING';
        throw missing;
      }
      throw err;
    }
  }
  if (!createIfMissing) return '';
  const creationLock = LockService.getScriptLock();
  try {
    creationLock.waitLock(30000);
    const createdByOtherRequest = String(
      properties.getProperty(TASKJOURNAL_CALENDAR_ID_PROPERTY) || ''
    );
    if (createdByOtherRequest) {
      Calendar.Calendars.get(createdByOtherRequest);
      return createdByOtherRequest;
    }
    const created = Calendar.Calendars.insert({
      summary: TASKJOURNAL_CALENDAR_NAME,
      description: 'TaskJournalから連携した予定専用',
      timeZone: Session.getScriptTimeZone()
    });
    if (!created || !created.id) throw new Error('TaskJournal calendar could not be created');
    properties.setProperty(TASKJOURNAL_CALENDAR_ID_PROPERTY, String(created.id));
    return String(created.id);
  } finally {
    if (creationLock.hasLock()) creationLock.releaseLock();
  }
}

function synchronizeTaskJournalCalendar(state, requestId) {
  const report = {
    upserted: 0,
    deleted: 0,
    externalDeleted: 0,
    failed: 0,
    pending: 0,
    reconciled: false,
    activeEventIds: [],
    reconciledTasks: [],
    operationResults: [],
    errorCode: ''
  };
  const upserts = (state.tasks || []).filter(function(task) {
    return task.calendarLinked
      && task.calendarEventId
      && task.dueDate
      && positiveIntegerOrZero(task.calendarSyncVersion) < positiveIntegerOrZero(task.serverVersion);
  }).map(function(task) {
    return { action: 'upsert', task: task };
  });
  const deletions = (state.tombstones || []).filter(function(tombstone) {
    return tombstone.calendarDeleteRequested
      && tombstone.calendarEventId
      && !finiteNumberOrZero(tombstone.calendarDeletedAt);
  }).map(function(tombstone) {
    return { action: 'delete', tombstone: tombstone };
  });
  const allOperations = deletions.concat(upserts);
  report.pending = allOperations.length;

  if (allOperations.length > 0) {
    let calendarId;
    try {
      calendarId = getTaskJournalCalendarId(upserts.length > 0);
      if (!calendarId) throw new Error('TaskJournal calendar is not configured');
    } catch (err) {
      report.failed = Math.min(allOperations.length, TASKJOURNAL_CALENDAR_MAX_WRITES);
      report.errorCode = safeCalendarErrorCode(err);
      console.error(JSON.stringify({
        event: 'taskjournal_calendar_write_failed',
        requestId: requestId,
        stage: 'calendar',
        errorCode: report.errorCode,
        operationCount: allOperations.length
      }));
      return report;
    }

    allOperations.slice(0, TASKJOURNAL_CALENDAR_MAX_WRITES).forEach(function(operation) {
      try {
        if (operation.action === 'delete') {
          deleteTaskJournalCalendarEvent(calendarId, operation.tombstone.calendarEventId);
          report.deleted += 1;
          report.operationResults.push({
            action: 'delete',
            status: 'success',
            taskId: operation.tombstone.id,
            eventId: operation.tombstone.calendarEventId
          });
        } else {
          const result = upsertTaskJournalCalendarEvent(calendarId, operation.task);
          if (result.status === 'external-deleted') {
            report.operationResults.push({
              action: 'upsert',
              status: 'external-deleted',
              taskId: operation.task.id,
              eventId: operation.task.calendarEventId,
              taskVersion: positiveIntegerOrZero(operation.task.serverVersion)
            });
          } else {
            report.upserted += 1;
            report.operationResults.push({
              action: 'upsert',
              status: 'success',
              taskId: operation.task.id,
              eventId: operation.task.calendarEventId,
              taskVersion: positiveIntegerOrZero(operation.task.serverVersion)
            });
          }
        }
      } catch (err) {
        report.failed += 1;
        report.errorCode = report.errorCode || safeCalendarErrorCode(err);
        report.operationResults.push({
          action: operation.action,
          status: 'failed',
          taskId: operation.action === 'delete' ? operation.tombstone.id : operation.task.id,
          eventId: operation.action === 'delete'
            ? operation.tombstone.calendarEventId
            : operation.task.calendarEventId
        });
        console.error(JSON.stringify({
          event: 'taskjournal_calendar_write_failed',
          requestId: requestId,
          stage: operation.action,
          errorCode: safeCalendarErrorCode(err)
        }));
      }
    });
    const externallyDeleted = report.operationResults.filter(function(item) {
      return item.status === 'external-deleted';
    }).length;
    report.pending = Math.max(0, allOperations.length - report.upserted - report.deleted - externallyDeleted);
    if (report.upserted > 0 || report.deleted > 0) bumpTaskJournalCalendarCacheEpoch();
    return report;
  }

  const linkedTasks = (state.tasks || []).filter(function(task) {
    return task.calendarLinked
      && task.calendarEventId
      && positiveIntegerOrZero(task.calendarSyncVersion) > 0
      && positiveIntegerOrZero(task.calendarSyncVersion) >= positiveIntegerOrZero(task.serverVersion);
  });
  if (linkedTasks.length === 0 || !taskJournalCalendarReconcileIsDue()) return report;

  try {
    const calendarId = getTaskJournalCalendarId(false);
    if (!calendarId) return report;
    report.activeEventIds = listActiveTaskJournalCalendarEventIds(calendarId);
    report.reconciledTasks = linkedTasks.map(function(task) {
      return {
        taskId: task.id,
        eventId: task.calendarEventId,
        taskVersion: positiveIntegerOrZero(task.serverVersion)
      };
    });
    report.reconciled = true;
    PropertiesService.getScriptProperties().setProperty(
      TASKJOURNAL_CALENDAR_RECONCILED_AT_PROPERTY,
      String(Date.now())
    );
  } catch (err) {
    report.failed = 1;
    report.errorCode = safeCalendarErrorCode(err);
    console.error(JSON.stringify({
      event: 'taskjournal_calendar_reconcile_failed',
      requestId: requestId,
      errorCode: report.errorCode
    }));
  }
  return report;
}

function upsertTaskJournalCalendarEvent(calendarId, task) {
  const start = new Date(task.dueDate);
  if (isNaN(start.getTime())) throw new Error('Task calendar date is invalid');
  const end = new Date(start.getTime() + TASKJOURNAL_CALENDAR_DURATION_MS);
  const resource = {
    summary: String(task.text || '（無題のタスク）').slice(0, 500),
    description: taskCalendarMemoDescription(task.logs),
    start: {
      dateTime: start.toISOString(),
      timeZone: Session.getScriptTimeZone()
    },
    end: {
      dateTime: end.toISOString(),
      timeZone: Session.getScriptTimeZone()
    },
    extendedProperties: {
      private: {
        taskJournal: '1'
      }
    }
  };
  const eventId = safeIdOrEmpty(task.calendarEventId);
  if (!eventId) throw new Error('Task calendar event ID is missing');

  if (positiveIntegerOrZero(task.calendarSyncVersion) > 0) {
    let existing;
    try {
      existing = Calendar.Events.get(calendarId, eventId);
    } catch (err) {
      if (isCalendarApiMissing(err)) return { status: 'external-deleted' };
      throw err;
    }
    if (!existing || existing.status === 'cancelled') return { status: 'external-deleted' };
    Calendar.Events.patch(resource, calendarId, eventId);
    return { status: 'success' };
  }

  try {
    Calendar.Events.insert(Object.assign({ id: eventId }, resource), calendarId);
  } catch (err) {
    if (!isCalendarApiConflict(err)) throw err;
    const existing = Calendar.Events.get(calendarId, eventId);
    if (!existing || existing.status === 'cancelled') return { status: 'external-deleted' };
    Calendar.Events.patch(resource, calendarId, eventId);
  }
  return { status: 'success' };
}

function deleteTaskJournalCalendarEvent(calendarId, eventId) {
  try {
    Calendar.Events.remove(calendarId, safeIdOrEmpty(eventId));
  } catch (err) {
    if (!isCalendarApiMissing(err)) throw err;
  }
}

function taskCalendarMemoDescription(logs) {
  if (!Array.isArray(logs)) return '';
  return logs.map(function(log) {
    const value = String(log || '');
    const match = value.match(/^(\[(?:\d{4}-\d{2}-\d{2}\s+)?\d{1,2}:\d{2}\]\s*)?📝\s*([\s\S]*)$/);
    if (!match || !String(match[2] || '').trim()) return '';
    return String(match[1] || '') + String(match[2] || '').trim();
  }).filter(Boolean).join('\n\n').slice(0, 8000);
}

function listActiveTaskJournalCalendarEventIds(calendarId) {
  const ids = [];
  let pageToken = '';
  let pageCount = 0;
  do {
    const options = {
      maxResults: 2500,
      showDeleted: false
    };
    if (pageToken) options.pageToken = pageToken;
    const response = Calendar.Events.list(calendarId, options);
    (response.items || []).forEach(function(event) {
      if (event && event.id && event.status !== 'cancelled') ids.push(String(event.id));
    });
    pageToken = String(response.nextPageToken || '');
    pageCount += 1;
    if (pageCount > 10) throw new Error('TaskJournal calendar pagination exceeded');
  } while (pageToken);
  return ids;
}

function taskJournalCalendarReconcileIsDue() {
  const last = finiteNumberOrZero(
    PropertiesService.getScriptProperties().getProperty(TASKJOURNAL_CALENDAR_RECONCILED_AT_PROPERTY)
  );
  return Date.now() - last >= TASKJOURNAL_CALENDAR_RECONCILE_INTERVAL_MS;
}

function applyTaskJournalCalendarResults(state, report) {
  const taskById = {};
  const tombstoneById = {};
  let changed = false;
  let externalDeleted = 0;
  state.tasks.forEach(function(task) { taskById[task.id] = task; });
  state.tombstones.forEach(function(tombstone) { tombstoneById[tombstone.id] = tombstone; });

  function deleteTaskFromGoogle(task) {
    if (!task || !taskById[task.id]) return;
    delete taskById[task.id];
    tombstoneById[task.id] = {
      id: task.id,
      deletedAt: Date.now(),
      serverVersion: positiveIntegerOrZero(task.serverVersion) + 1,
      lastMutationId: 'calendar-' + simpleHash(task.calendarEventId + '|' + Date.now()),
      calendarEventId: task.calendarEventId,
      calendarDeleteRequested: false,
      calendarDeletedAt: Date.now(),
      deleteSource: 'google'
    };
    changed = true;
    externalDeleted += 1;
  }

  report.operationResults.forEach(function(result) {
    if (result.status === 'failed') return;
    if (result.action === 'delete') {
      const tombstone = tombstoneById[result.taskId];
      if (tombstone && tombstone.calendarEventId === result.eventId && !tombstone.calendarDeletedAt) {
        tombstone.calendarDeletedAt = Date.now();
        changed = true;
      }
      return;
    }
    const task = taskById[result.taskId];
    if (!task || task.calendarEventId !== result.eventId) return;
    if (result.status === 'external-deleted') {
      if (positiveIntegerOrZero(task.serverVersion) !== positiveIntegerOrZero(result.taskVersion)) return;
      deleteTaskFromGoogle(task);
      return;
    }
    const syncedVersion = positiveIntegerOrZero(result.taskVersion);
    if (syncedVersion > positiveIntegerOrZero(task.calendarSyncVersion)) {
      task.calendarSyncVersion = Math.min(syncedVersion, positiveIntegerOrZero(task.serverVersion));
      task.calendarSyncedAt = Date.now();
      changed = true;
    }
  });

  if (report.reconciled) {
    const active = {};
    report.activeEventIds.forEach(function(eventId) { active[eventId] = true; });
    (report.reconciledTasks || []).forEach(function(snapshot) {
      const task = taskById[snapshot.taskId];
      if (!task
          || task.calendarEventId !== snapshot.eventId
          || positiveIntegerOrZero(task.serverVersion) !== positiveIntegerOrZero(snapshot.taskVersion)) {
        return;
      }
      const calendarIsCurrent = task.calendarLinked
        && task.calendarEventId
        && positiveIntegerOrZero(task.calendarSyncVersion) > 0
        && positiveIntegerOrZero(task.calendarSyncVersion) >= positiveIntegerOrZero(task.serverVersion);
      if (calendarIsCurrent && !active[task.calendarEventId]) deleteTaskFromGoogle(task);
    });
  }

  state.tasks = Object.keys(taskById).map(function(id) { return taskById[id]; });
  state.tombstones = Object.keys(tombstoneById).map(function(id) { return tombstoneById[id]; });
  return { changed: changed, externalDeleted: externalDeleted };
}

function bumpTaskJournalCalendarCacheEpoch() {
  const properties = PropertiesService.getScriptProperties();
  const current = positiveIntegerOrZero(properties.getProperty(TASKJOURNAL_CALENDAR_CACHE_EPOCH_PROPERTY));
  properties.setProperty(TASKJOURNAL_CALENDAR_CACHE_EPOCH_PROPERTY, String(current + 1));
}

function publicCalendarSyncReport(report) {
  return {
    upserted: positiveIntegerOrZero(report.upserted),
    deleted: positiveIntegerOrZero(report.deleted),
    externalDeleted: positiveIntegerOrZero(report.externalDeleted),
    failed: positiveIntegerOrZero(report.failed),
    pending: positiveIntegerOrZero(report.pending),
    reconciled: !!report.reconciled,
    errorCode: optionalString(report.errorCode, 80, 'calendar error code') || ''
  };
}

function safeCalendarErrorCode(err) {
  if (err && err.code && /^[A-Z0-9_]{1,80}$/.test(String(err.code))) return String(err.code);
  if (isCalendarApiMissing(err)) return 'CALENDAR_EVENT_NOT_FOUND';
  if (isCalendarApiConflict(err)) return 'CALENDAR_EVENT_CONFLICT';
  return 'CALENDAR_API_FAILED';
}

function isCalendarApiMissing(err) {
  const message = String(err && err.message ? err.message : err || '').toLowerCase();
  return /\b404\b|\b410\b|not found|gone/.test(message);
}

function isCalendarApiConflict(err) {
  const message = String(err && err.message ? err.message : err || '').toLowerCase();
  return /\b409\b|already exists|duplicate/.test(message);
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
    protocolVersion: PROTOCOL_VERSION,
    revision: 0,
    updatedAt: 0,
    tasks: [],
    tombstones: [],
    conflicts: [],
    categories: [],
    categoriesUpdatedAt: 0,
    categoriesVersion: 0,
    lastCategoryMutationId: '',
    appliedMutations: []
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
  state.categoriesVersion = positiveIntegerOrZero(parsed.categoriesVersion);
  state.lastCategoryMutationId = safeIdOrEmpty(parsed.lastCategoryMutationId);
  state.appliedMutations = validateAppliedMutations(parsed.appliedMutations);
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
      : currentCategoriesUpdatedAt,
    categoriesVersion: positiveIntegerOrZero(incoming.categoriesVersion || current.categoriesVersion),
    lastCategoryMutationId: safeIdOrEmpty(incoming.lastCategoryMutationId || current.lastCategoryMutationId),
    appliedMutations: validateAppliedMutations(incoming.appliedMutations || current.appliedMutations)
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
      id: requireSafeId(task.id, 'task id'),
      text: boundedString(task.text, 500, 'task text'),
      dueDate: optionalString(task.dueDate, 40, 'due date'),
      category: optionalString(task.category, 100, 'category'),
      status: ['todo', 'doing', 'done'].indexOf(task.status) >= 0 ? task.status : 'todo',
      pinned: !!task.pinned,
      logs: logs.map(function(log) { return boundedString(log, 1000, 'task log'); }),
      createdAt: finiteNumberOrZero(task.createdAt),
      createdDeviceId: safeIdOrEmpty(task.createdDeviceId),
      createdDeviceName: optionalString(task.createdDeviceName, 80, 'created device name'),
      updatedAt: finiteNumberOrZero(task.updatedAt) || finiteNumberOrZero(task.createdAt),
      baseUpdatedAt: finiteNumberOrZero(task.baseUpdatedAt),
      serverVersion: positiveIntegerOrZero(task.serverVersion),
      lastMutationId: safeIdOrEmpty(task.lastMutationId),
      calendarLinked: !!task.calendarLinked,
      calendarEventId: safeIdOrEmpty(task.calendarEventId),
      calendarSyncVersion: positiveIntegerOrZero(task.calendarSyncVersion),
      calendarSyncedAt: finiteNumberOrZero(task.calendarSyncedAt),
      deleted: !!task.deleted
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
      id: requireSafeId(tombstone.id, 'tombstone id'),
      deletedAt: deletedAt,
      serverVersion: positiveIntegerOrZero(tombstone.serverVersion),
      lastMutationId: safeIdOrEmpty(tombstone.lastMutationId),
      calendarEventId: safeIdOrEmpty(tombstone.calendarEventId),
      calendarDeleteRequested: !!tombstone.calendarDeleteRequested,
      calendarDeletedAt: finiteNumberOrZero(tombstone.calendarDeletedAt),
      deleteSource: ['taskjournal', 'google'].indexOf(tombstone.deleteSource) >= 0
        ? tombstone.deleteSource
        : ''
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
      taskId: requireSafeId(conflict.taskId, 'conflict task id'),
      detectedAt: finiteNumberOrZero(conflict.detectedAt),
      resolvedAt: finiteNumberOrZero(conflict.resolvedAt),
      variants: variants
    };
  });
}

function taskContentSignature(task) {
  return JSON.stringify([
    task.text || '', task.dueDate || null, task.category || null,
    task.status || 'todo', !!task.pinned, Array.isArray(task.logs) ? task.logs : [],
    !!task.calendarLinked, !!task.deleted
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
      id: requireSafeId(category.id, 'category id'),
      name: boundedString(category.name, 100, 'category name'),
      color: optionalString(category.color, 30, 'category color')
    };
  });
}

function validateMutations(mutations) {
  if (mutations == null) return [];
  if (!Array.isArray(mutations) || mutations.length > MAX_MUTATIONS) throw new Error('invalid mutations');
  return mutations.map(function(mutation) {
    if (!mutation || typeof mutation !== 'object') throw new Error('invalid mutation');
    const mutationId = requireSafeId(mutation.mutationId, 'mutation id');
    const taskId = requireSafeId(mutation.taskId, 'mutation task id');
    if (['create', 'update', 'delete'].indexOf(mutation.operation) < 0) throw new Error('invalid mutation operation');
    const task = validateTasks([mutation.task])[0];
    if (task.id !== taskId) throw new Error('mutation task mismatch');
    return {
      mutationId: mutationId,
      taskId: taskId,
      operation: mutation.operation,
      baseVersion: positiveIntegerOrZero(mutation.baseVersion),
      parentMutationId: safeIdOrEmpty(mutation.parentMutationId),
      resolvesConflictId: mutation.resolvesConflictId ? requireSafeId(mutation.resolvesConflictId, 'resolved conflict id', 180) : '',
      task: task,
      createdAt: finiteNumberOrZero(mutation.createdAt),
      deleteGoogleCalendarEvent: !!mutation.deleteGoogleCalendarEvent
    };
  });
}

function validateCategoryMutation(mutation) {
  if (mutation == null) return null;
  if (!mutation || typeof mutation !== 'object') throw new Error('invalid category mutation');
  return {
    mutationId: requireSafeId(mutation.mutationId, 'category mutation id'),
    baseVersion: positiveIntegerOrZero(mutation.baseVersion),
    categories: validateCategories(mutation.categories)
  };
}

function validateResolvedConflictIds(ids) {
  if (ids == null) return [];
  if (!Array.isArray(ids) || ids.length > MAX_CONFLICTS) throw new Error('invalid resolved conflicts');
  return ids.map(function(id) { return requireSafeId(id, 'resolved conflict id', 180); });
}

function validateAppliedMutations(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(-MAX_APPLIED_MUTATIONS).map(function(item) {
    if (!item || typeof item !== 'object') throw new Error('invalid applied mutation');
    return { id: requireSafeId(item.id, 'applied mutation id'), appliedAt: finiteNumberOrZero(item.appliedAt) };
  });
}

function requireSafeId(value, label, maxLength) {
  const text = String(value || '');
  const max = maxLength || 100;
  if (text.length > max || !/^[A-Za-z0-9._-]+$/.test(text)) throw new Error('invalid ' + label);
  return text;
}

function safeIdOrEmpty(value) {
  if (value == null || value === '') return '';
  return requireSafeId(value, 'id');
}

function positiveIntegerOrZero(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
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
