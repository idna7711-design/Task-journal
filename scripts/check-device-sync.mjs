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
      baseUpdatedAt: baseUpdatedAt || 0
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

  function mutation(id, taskId, operation, baseVersion, parentMutationId, text) {
    return {
      mutationId: id,
      taskId: taskId,
      operation: operation,
      baseVersion: baseVersion,
      parentMutationId: parentMutationId || '',
      task: task(taskId, 1, text || taskId, 0),
      createdAt: 1
    };
  }
  let v3 = normalizeProtocol3State(createEmptySyncState());
  let v3Result = applyMutations(v3, [mutation('m1', 'v3-task', 'create', 0, '', '初版')], null, []);
  v3 = v3Result.state;
  assert(v3.tasks[0].serverVersion === 1 && v3.tasks[0].text === '初版', 'v3で新規作成できない');

  v3Result = applyMutations(v3, [mutation('m2', 'v3-task', 'update', 1, 'm1', '端末時計が古い後発編集')], null, []);
  v3 = v3Result.state;
  assert(v3.tasks[0].text === '端末時計が古い後発編集', '端末時計に依存して後発編集を失う');
  assert(v3.tasks[0].serverVersion === 2, 'タスク版番号が進まない');

  v3Result = applyMutations(v3, [mutation('m2', 'v3-task', 'update', 1, 'm1', '端末時計が古い後発編集')], null, []);
  assert(v3Result.state.tasks[0].serverVersion === 2, '同じ変更の再送が二重適用される');

  v3Result = applyMutations(v3, [
    mutation('m3', 'v3-task', 'update', 2, 'm2', 'オフライン編集1'),
    mutation('m4', 'v3-task', 'update', 2, 'm3', 'オフライン編集2')
  ], null, []);
  v3 = v3Result.state;
  assert(v3.tasks[0].text === 'オフライン編集2' && v3.tasks[0].serverVersion === 4, '連続オフライン編集を順番に適用できない');

  v3Result = applyMutations(v3, [mutation('other-device', 'v3-task', 'update', 2, 'm2', '別端末の分岐編集')], null, []);
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
})();
`;

try {
    vm.runInNewContext(`${gasSource}\n${scenarios}`, { console }, { timeout: 5000 });
    const clientFunctions = [
        extractFunction(htmlSource, 'uid'),
        extractFunction(htmlSource, 'normalizeTask'),
        extractFunction(htmlSource, 'taskContentSignature'),
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
      if (parsedLog.time !== '16:54' || parsedLog.text !== 'Amazonで見つけた') throw new Error('履歴の時刻と本文を分離できない');
      parsedLog.time = '17:20';
      parsedLog.text = '内容を編集';
      if (serializeTaskLogEntry(parsedLog) !== '[17:20] 内容を編集') throw new Error('編集した履歴を互換形式へ戻せない');
    `;
    vm.runInNewContext(`${clientFunctions}\n${clientScenarios}`, {
        crypto: { randomUUID: () => 'test-id' },
        Date,
        Map,
        Number,
        Array,
        String,
    }, { timeout: 5000 });
    console.log('OK  index.htmlの端末側統合処理');
    console.log('\n端末同期シナリオ: すべてOK');
} catch (error) {
    console.error(`NG  端末同期シナリオ\n${error.stack || error.message || error}`);
    process.exit(1);
}
