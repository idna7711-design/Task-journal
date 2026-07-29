#!/usr/bin/env node
// GAS同期モデルを実行し、複数端末・削除・競合・旧形式移行を検証する。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gasSource = readFileSync(join(root, 'gas', 'Code.gs'), 'utf8');
const htmlSource = readFileSync(join(root, 'index.html'), 'utf8');

function extractFunction(source, name) {
    const start = source.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`関数が見つかりません: ${name}`);
    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    for (let index = bodyStart; index < source.length; index++) {
        if (source[index] === '{') depth++;
        if (source[index] === '}') {
            depth--;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    throw new Error(`関数の終端が見つかりません: ${name}`);
}

const scenarios = String.raw`
(function runSyncScenarios() {
  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }
  function task(id, updatedAt, text, baseUpdatedAt) {
    return {
      id: id,
      text: text || id,
      dueDate: null,
      category: null,
      status: 'todo',
      pinned: false,
      logs: [],
      createdAt: 1,
      updatedAt: updatedAt,
      baseUpdatedAt: baseUpdatedAt || 0,
      calendarLinked: false,
      calendarEventId: '',
      calendarSyncVersion: 0,
      calendarSyncedAt: 0
    };
  }
  function incoming(tasks, tombstones, categories, categoriesUpdatedAt) {
    return {
      tasks: tasks || [],
      tombstones: tombstones || [],
      categories: categories || [],
      categoriesUpdatedAt: categoriesUpdatedAt || 0
    };
  }

  let state = createEmptySyncState();
  state = mergeSyncState(state, incoming([task('a', 10)], [], [], 0));
  state = mergeSyncState(state, incoming([task('b', 20)], [], [], 0));
  assert(state.tasks.length === 2, '別端末の追加タスクが両方残らない');

  state = mergeSyncState(state, incoming([task('a', 10)], [], [], 0));
  assert(state.tasks.some(function(item) { return item.id === 'b'; }), '古い全量送信で別端末タスクが消える');

  state = mergeSyncState(state, incoming([], [{ id: 'a', deletedAt: 30 }], [], 0));
  assert(!state.tasks.some(function(item) { return item.id === 'a'; }), '削除したタスクが残る');
  state = mergeSyncState(state, incoming([task('a', 999, '古い端末から再送')], [], [], 0));
  assert(!state.tasks.some(function(item) { return item.id === 'a'; }), '削除したタスクが再送で復活する');

  state = mergeSyncState(state, incoming([task('b', 40, '新しい編集')], [], [], 0));
  state = mergeSyncState(state, incoming([task('b', 25, '古い編集')], [], [], 0));
  assert(state.tasks.filter(function(item) { return item.id === 'b'; })[0].text === '新しい編集', '古い編集が新しい編集を上書きする');

  let conflictState = createEmptySyncState();
  conflictState = mergeSyncState(conflictState, incoming([task('c', 10, '元の内容')], [], [], 0));
  conflictState = mergeSyncState(conflictState, incoming([task('c', 20, '順次編集', 10)], [], [], 0));
  assert(conflictState.conflicts.length === 0, '順次編集が競合扱いになる');
  conflictState = mergeSyncState(conflictState, incoming([task('c', 30, '別端末の編集', 10)], [], [], 0));
  assert(conflictState.conflicts.length === 1, '分岐した編集を競合として保持できない');
  assert(conflictState.conflicts[0].variants.length === 2, '競合の両候補が残らない');

  const categories = [{ id: 'work', name: '仕事', color: 'blue' }];
  state = mergeSyncState(state, incoming([], [], categories, 50));
  state = mergeSyncState(state, incoming([], [], [], 45));
  assert(state.categories.length === 1 && state.categories[0].id === 'work', '古いジャンル一覧が新しい一覧を上書きする');
  state = mergeSyncState(state, incoming([], [], [], 60));
  state = mergeSyncState(state, incoming([], [], categories, 55));
  assert(state.categories.length === 0, '削除したジャンル一覧が古い端末から復活する');

  const legacy = normalizeStoredState([task('legacy', 5)]);
  assert(legacy.syncVersion === 2 && legacy.tasks.length === 1, '旧タスク配列をv2へ移行できない');

  function mutation(id, taskId, operation, baseVersion, parentMutationId, text, deleteGoogleCalendarEvent) {
    return {
      mutationId: id,
      taskId: taskId,
      operation: operation,
      baseVersion: baseVersion,
      parentMutationId: parentMutationId || '',
      task: task(taskId, 1, text || taskId, 0),
      createdAt: 1,
      deleteGoogleCalendarEvent: !!deleteGoogleCalendarEvent
    };
  }
  let v3 = normalizeProtocol3State(createEmptySyncState());
  let v3Result = applyMutations(v3, [mutation('m1', 'v3-task', 'create', 0, '', '初版')], null, []);
  assert(v3Result.changed === true, '新規mutationは状態変更として扱う');
  v3 = v3Result.state;
  assert(v3.tasks[0].serverVersion === 1 && v3.tasks[0].text === '初版', 'v3で新規作成できない');

  v3Result = applyMutations(v3, [mutation('m2', 'v3-task', 'update', 1, 'm1', '端末時計が古い後発編集')], null, []);
  v3 = v3Result.state;
  assert(v3Result.mutationResults[0].status === 'applied', '正常適用の結果種別が返らない');
  assert(v3.tasks[0].text === '端末時計が古い後発編集', '端末時計に依存して後発編集を失う');
  assert(v3.tasks[0].serverVersion === 2, 'タスク版番号が進まない');

  v3Result = applyMutations(v3, [mutation('m2', 'v3-task', 'update', 1, 'm1', '端末時計が古い後発編集')], null, []);
  assert(v3Result.changed === false, '送信済みmutationの再送は状態を変更しない');
  assert(v3Result.mutationResults[0].status === 'duplicate', '重複受領の結果種別が返らない');
  assert(v3Result.state.tasks[0].serverVersion === 2, '同じ変更の再送が二重適用される');

  v3Result = applyMutations(v3, [
    mutation('m3', 'v3-task', 'update', 2, 'm2', 'オフライン編集1'),
    mutation('m4', 'v3-task', 'update', 2, 'm3', 'オフライン編集2')
  ], null, []);
  v3 = v3Result.state;
  assert(v3.tasks[0].text === 'オフライン編集2' && v3.tasks[0].serverVersion === 4, '連続オフライン編集を順番に適用できない');

  v3Result = applyMutations(v3, [mutation('other-device', 'v3-task', 'update', 2, 'm2', '別端末の分岐編集')], null, []);
  assert(v3Result.mutationResults[0].status === 'conflict', '競合保存の結果種別が返らない');
  assert(v3Result.state.conflicts.some(function(item) { return !item.resolvedAt; }), '分岐編集の両候補を保持できない');

  const deleteMutation = mutation('delete-device', 'v3-task', 'delete', 2, 'm2', '削除前の内容');
  v3Result = applyMutations(v3Result.state, [deleteMutation], null, []);
  const deleteConflict = v3Result.state.conflicts.find(function(item) {
    return item.variants.some(function(variant) { return variant.deleted; });
  });
  assert(deleteConflict && deleteConflict.variants.length === 2, '削除と編集の競合候補を両方保持できない');
  const resolution = mutation('resolve-delete', 'v3-task', 'delete', 0, '', '削除前の内容');
  resolution.resolvesConflictId = deleteConflict.id;
  v3Result = applyMutations(v3Result.state, [resolution], null, []);
  assert(v3Result.state.tombstones.some(function(item) { return item.id === 'v3-task'; }), '競合解決として削除を確定できない');
  assert(v3Result.state.conflicts.find(function(item) { return item.id === deleteConflict.id; }).resolvedAt > 0, '解決済み競合が残る');

  const categoryResult = applyMutations(v3Result.state, [], {
    mutationId: 'category-1', baseVersion: 0, categories: [{ id: 'Work', name: '仕事', color: 'blue' }]
  }, []);
  assert(categoryResult.state.categoriesVersion === 1 && categoryResult.ackedCategoryMutationId === 'category-1', 'ジャンル版番号同期が動かない');

  let calendarState = normalizeProtocol3State(createEmptySyncState());
  const calendarCreate = mutation('calendar-create', 'calendar-task', 'create', 0, '', '予定タイトル');
  calendarCreate.task.dueDate = '2026-07-29T10:00';
  calendarCreate.task.calendarLinked = true;
  let calendarResult = applyMutations(calendarState, [calendarCreate], null, []);
  calendarState = calendarResult.state;
  const linkedTask = calendarState.tasks[0];
  assert(linkedTask.calendarLinked, 'Googleカレンダー連携フラグを保存できない');
  assert(/^tj[0-9a-f]{40}$/.test(linkedTask.calendarEventId), '安全な決定的イベントIDを生成できない');
  assert(linkedTask.calendarSyncVersion === 0, '未送信予定を同期済みとして扱っている');

  const memoDescription = taskCalendarMemoDescription([
    '[2026-07-29 09:00] 📝 予定の説明',
    '[2026-07-29 09:05] ▶ 開始しました',
    '[09:10] 📝 持ち物を確認'
  ]);
  assert(memoDescription.includes('予定の説明') && memoDescription.includes('持ち物を確認'), 'メモを予定説明へ変換できない');
  assert(!memoDescription.includes('開始しました'), '操作履歴が予定説明へ混入する');

  linkedTask.calendarSyncVersion = linkedTask.serverVersion;
  linkedTask.calendarSyncedAt = 100;
  const calendarDelete = mutation(
    'calendar-delete',
    'calendar-task',
    'delete',
    linkedTask.serverVersion,
    linkedTask.lastMutationId,
    linkedTask.text,
    true
  );
  calendarResult = applyMutations(calendarState, [calendarDelete], null, []);
  const calendarTombstone = calendarResult.state.tombstones.find(function(item) {
    return item.id === 'calendar-task';
  });
  assert(calendarTombstone && calendarTombstone.calendarDeleteRequested, 'Google予定の削除希望を墓標へ保持できない');
  assert(calendarTombstone.calendarEventId === linkedTask.calendarEventId, '削除対象のGoogle予定IDを保持できない');

  let externalDeleteState = normalizeProtocol3State(createEmptySyncState());
  externalDeleteState.tasks = [{
    ...task('google-deleted-task', 10, 'Googleから削除'),
    dueDate: '2026-07-29T10:00',
    serverVersion: 2,
    lastMutationId: 'calendar-synced',
    calendarLinked: true,
    calendarEventId: 'tj0123456789abcdef0123456789abcdef01234567',
    calendarSyncVersion: 2,
    calendarSyncedAt: 100
  }];
  const externalPatch = applyTaskJournalCalendarResults(externalDeleteState, {
    operationResults: [],
    reconciled: true,
    activeEventIds: [],
    reconciledTasks: [{
      taskId: 'google-deleted-task',
      eventId: 'tj0123456789abcdef0123456789abcdef01234567',
      taskVersion: 2
    }]
  });
  assert(externalPatch.changed && externalPatch.externalDeleted === 1, 'Google側の予定削除をTaskJournalへ反映できない');
  assert(externalDeleteState.tasks.length === 0, 'Google側で削除されたタスクが残る');
  assert(externalDeleteState.tombstones[0].deleteSource === 'google', 'Google由来の削除履歴を識別できない');

  let concurrentState = normalizeProtocol3State(createEmptySyncState());
  concurrentState.tasks = [{
    ...task('concurrent-task', 20, '一覧取得後の更新'),
    dueDate: '2026-07-29T11:00',
    serverVersion: 3,
    lastMutationId: 'newer-mutation',
    calendarLinked: true,
    calendarEventId: 'tj89abcdef0123456789abcdef0123456789abcdef',
    calendarSyncVersion: 3,
    calendarSyncedAt: 200
  }];
  const staleReconcilePatch = applyTaskJournalCalendarResults(concurrentState, {
    operationResults: [],
    reconciled: true,
    activeEventIds: [],
    reconciledTasks: [{
      taskId: 'concurrent-task',
      eventId: 'tj89abcdef0123456789abcdef0123456789abcdef',
      taskVersion: 2
    }]
  });
  assert(!staleReconcilePatch.changed && concurrentState.tasks.length === 1, '古い一覧取得結果が同時更新後のタスクを削除する');

  console.log('OK  端末A/Bの追加を保持');
  console.log('OK  古い全量送信による消失を防止');
  console.log('OK  削除タスクの復活を防止');
  console.log('OK  同一タスクは新しい編集を採用');
  console.log('OK  順次編集と競合編集を区別');
  console.log('OK  競合の両候補を保持');
  console.log('OK  ジャンル一覧の競合を解決');
  console.log('OK  全削除したジャンルの復活を防止');
  console.log('OK  旧TaskData.jsonを自動移行');
  console.log('OK  v3は端末時計に依存しない');
  console.log('OK  v3変更IDで二重適用を防止');
  console.log('OK  v3は連続オフライン編集を保持');
  console.log('OK  v3は分岐編集を競合保存');
  console.log('OK  v3は削除と編集を競合保存');
  console.log('OK  v3競合解決をサーバーへ確定');
  console.log('OK  v3はジャンルを版番号同期');
  console.log('OK  メモだけをGoogle予定の説明へ送る');
  console.log('OK  TaskJournal削除時のGoogle予定削除を保持');
  console.log('OK  Google予定削除をTaskJournalへ反映');
  console.log('OK  古いGoogle一覧で同時更新タスクを削除しない');
})();
`;

try {
    vm.runInNewContext(`${gasSource}\n${scenarios}`, {
        console,
        Utilities: {
            DigestAlgorithm: { SHA_256: 'SHA_256' },
            Charset: { UTF_8: 'UTF_8' },
            computeDigest: () => Array.from({ length: 32 }, (_, index) => index),
        },
    }, { timeout: 5000 });
    const clientFunctions = [
        extractFunction(htmlSource, 'uid'),
        extractFunction(htmlSource, 'normalizeTask'),
        extractFunction(htmlSource, 'normalizeOutbox'),
        extractFunction(htmlSource, 'taskContentSignature'),
        extractFunction(htmlSource, 'taskSyncSignature'),
        extractFunction(htmlSource, 'buildLegacyTaskMutations'),
        extractFunction(htmlSource, 'mutationGoalSatisfied'),
        extractFunction(htmlSource, 'reconcileSyncOutbox'),
        extractFunction(htmlSource, 'simpleHash'),
        extractFunction(htmlSource, 'createConflict'),
        extractFunction(htmlSource, 'normalizeConflicts'),
        extractFunction(htmlSource, 'normalizeTombstones'),
        extractFunction(htmlSource, 'mergeTaskCollections'),
        extractFunction(htmlSource, 'parseTaskLogEntry'),
        extractFunction(htmlSource, 'serializeTaskLogEntry'),
    ].join('\n');
    const clientScenarios = String.raw`
      const local = [
        { id: 'local', text: '端末A', createdAt: 1, updatedAt: 10 },
        { id: 'deleted', text: '削除対象', createdAt: 1, updatedAt: 10 }
      ];
      const remote = [
        { id: 'remote', text: '端末B', createdAt: 1, updatedAt: 20 },
        { id: 'deleted', text: '古い端末', createdAt: 1, updatedAt: 999 }
      ];
      const result = mergeTaskCollections(local, [], remote, [{ id: 'deleted', deletedAt: 30 }], [], []);
      if (result.tasks.length !== 2) throw new Error('端末側で追加タスクを統合できない');
      if (result.tasks.some(item => item.id === 'deleted')) throw new Error('端末側で削除タスクが復活する');
      if (result.tombstones.length !== 1) throw new Error('端末側で削除履歴を保持できない');
      const sequential = mergeTaskCollections(
        [{ id: 'same', text: '元', createdAt: 1, updatedAt: 10, baseUpdatedAt: 10 }], [],
        [{ id: 'same', text: '編集', createdAt: 1, updatedAt: 20, baseUpdatedAt: 10 }], [], [], []
      );
      if (sequential.conflicts.length !== 0) throw new Error('端末側で順次編集が競合になる');
      const parsedLog = parseTaskLogEntry('[16:54] Amazonで見つけた');
      if (parsedLog.date !== '' || parsedLog.time !== '16:54' || parsedLog.text !== 'Amazonで見つけた' || parsedLog.kind !== 'history') throw new Error('旧履歴の時刻と本文を分離できない');
      parsedLog.time = '17:20';
      parsedLog.text = '内容を編集';
      if (serializeTaskLogEntry(parsedLog) !== '[17:20] 内容を編集') throw new Error('編集した履歴を互換形式へ戻せない');
      const datedLog = parseTaskLogEntry('[2026-07-05 09:30] 日付付きの記録');
      if (datedLog.date !== '2026-07-05' || datedLog.time !== '09:30' || datedLog.text !== '日付付きの記録') throw new Error('履歴の日付・時刻・本文を分離できない');
      datedLog.date = '2026-07-06';
      datedLog.time = '10:45';
      if (serializeTaskLogEntry(datedLog) !== '[2026-07-06 10:45] 日付付きの記録') throw new Error('日付付き履歴を保存できない');
      const memoLog = parseTaskLogEntry('[2026-07-05 11:30] 📝 Google予定の説明');
      if (memoLog.kind !== 'memo' || memoLog.text !== 'Google予定の説明') throw new Error('メモと履歴を区別できない');
      if (serializeTaskLogEntry(memoLog) !== '[2026-07-05 11:30] 📝 Google予定の説明') throw new Error('メモ種別を保ったまま保存できない');

      const canonicalLegacy = new Map([
        ['already-acknowledged', { id: 'already-acknowledged', text: 'クラウド版', createdAt: 1, updatedAt: 2, serverVersion: 1 }],
        ['needs-migration', { id: 'needs-migration', text: '別内容', createdAt: 1, updatedAt: 2, serverVersion: 1 }]
      ]);
      const legacyTasks = [
        { id: 'already-acknowledged', text: '端末版', createdAt: 1, updatedAt: 2, serverVersion: 0 },
        { id: 'needs-migration', text: '端末の未送信内容', createdAt: 1, updatedAt: 2, serverVersion: 0 }
      ];
      const migration = buildLegacyTaskMutations(
        legacyTasks, canonicalLegacy, [], ['already-acknowledged'], false, () => 'legacy-mutation', 50
      );
      if (migration.mutations.length !== 1 || migration.mutations[0].taskId !== 'needs-migration') {
        throw new Error('ACK済み旧タスクを移行処理で再登録している');
      }
      const completedMigration = buildLegacyTaskMutations(
        legacyTasks, canonicalLegacy, [], [], true, () => 'unused', 51
      );
      if (completedMigration.mutations.length !== 0) throw new Error('完了済みの旧移行を再実行している');

      function queued(id, taskId, operation, text, recoveryCount) {
        return normalizeOutbox([{
          mutationId: id,
          taskId,
          operation,
          baseVersion: 0,
          parentMutationId: '',
          task: { id: taskId, text, createdAt: 1, updatedAt: 1 },
          createdAt: 1,
          ackMisses: 0,
          recoveryCount: recoveryCount || 0,
          blocked: false
        }])[0];
      }

      let pending = [queued('ack-me', 'ack-task', 'create', '正常')];
      let recovery = reconcileSyncOutbox(pending, ['ack-me'], ['ack-me'], [], [], () => 'unused', 10);
      if (recovery.outbox.length !== 0 || recovery.ackedCount !== 1) throw new Error('受領済み変更を待ち箱から除去できない');

      pending = [queued('same-mutation', 'same-task', 'create', '反映済み')];
      const sameRemote = [{ id: 'same-task', text: '反映済み', createdAt: 1, updatedAt: 1, serverVersion: 1 }];
      recovery = reconcileSyncOutbox(pending, ['same-mutation'], [], sameRemote, [], () => 'unused', 20);
      recovery = reconcileSyncOutbox(recovery.outbox, ['same-mutation'], [], sameRemote, [], () => 'unused', 21);
      if (recovery.outbox[0].ackMisses !== 2) throw new Error('2回の未受領で早期復旧している');
      recovery = reconcileSyncOutbox(recovery.outbox, ['same-mutation'], [], sameRemote, [], () => 'unused', 22);
      if (recovery.outbox.length !== 0 || recovery.alreadySyncedCount !== 1) throw new Error('反映済みの残留変更を安全に完了扱いできない');

      pending = [queued('old-mutation', 'different-task', 'create', '端末側の内容')];
      const differentRemote = [{ id: 'different-task', text: 'クラウド側の内容', createdAt: 1, updatedAt: 2, serverVersion: 5, lastMutationId: 'remote-5' }];
      recovery = reconcileSyncOutbox(pending, ['old-mutation'], [], differentRemote, [], () => 'recovery-mutation', 30);
      recovery = reconcileSyncOutbox(recovery.outbox, ['old-mutation'], [], differentRemote, [], () => 'recovery-mutation', 31);
      recovery = reconcileSyncOutbox(recovery.outbox, ['old-mutation'], [], differentRemote, [], () => 'recovery-mutation', 32);
      if (recovery.rebuiltCount !== 1 || recovery.outbox[0].mutationId !== 'recovery-mutation') throw new Error('内容が異なる残留変更を復旧mutationへ再構成できない');
      if (recovery.outbox[0].baseVersion !== 6 || recovery.outbox[0].recoveryCount !== 1) throw new Error('復旧mutationがクラウドを強制上書きしない版指定になっていない');
      recovery = reconcileSyncOutbox(recovery.outbox, ['recovery-mutation'], [], differentRemote, [], () => 'unused', 33);
      recovery = reconcileSyncOutbox(recovery.outbox, ['recovery-mutation'], [], differentRemote, [], () => 'unused', 34);
      recovery = reconcileSyncOutbox(recovery.outbox, ['recovery-mutation'], [], differentRemote, [], () => 'unused', 35);
      if (!recovery.outbox[0].blocked || recovery.newlyBlockedCount !== 1) throw new Error('復旧後も未受領の変更を自動停止できない');

      pending = [queued('delete-mutation', 'gone-task', 'delete', '削除対象')];
      pending[0].deleteGoogleCalendarEvent = true;
      const normalizedCalendarDelete = normalizeOutbox(pending)[0];
      if (!normalizedCalendarDelete.deleteGoogleCalendarEvent) throw new Error('Google予定削除フラグを端末待ち箱へ保持できない');
      pending[0].ackMisses = 2;
      recovery = reconcileSyncOutbox(pending, ['delete-mutation'], [], [], [], () => 'unused', 40);
      if (recovery.outbox.length !== 0 || recovery.alreadySyncedCount !== 1) throw new Error('既に削除済みの残留変更を完了扱いできない');
    `;
    vm.runInNewContext(`${clientFunctions}\n${clientScenarios}`, {
        crypto: { randomUUID: () => 'test-id' },
        Date,
        Map,
        Number,
        Array,
        String,
        SYNC_ACK_MISS_LIMIT: 3,
        SYNC_RECOVERY_MAX: 1,
    }, { timeout: 5000 });
    console.log('OK  index.htmlの端末側統合処理');
    console.log('OK  残留同期の自動復旧と停止境界');
    console.log('\n端末同期シナリオ: すべてOK');
} catch (error) {
    console.error(`NG  端末同期シナリオ\n${error.stack || error.message || error}`);
    process.exit(1);
}
