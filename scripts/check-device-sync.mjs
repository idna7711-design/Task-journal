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
  function task(id, updatedAt, text) {
    return {
      id: id,
      text: text || id,
      dueDate: null,
      category: null,
      status: 'todo',
      pinned: false,
      logs: [],
      createdAt: 1,
      updatedAt: updatedAt
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

  const categories = [{ id: 'work', name: '仕事', color: 'blue' }];
  state = mergeSyncState(state, incoming([], [], categories, 50));
  state = mergeSyncState(state, incoming([], [], [], 45));
  assert(state.categories.length === 1 && state.categories[0].id === 'work', '古いジャンル一覧が新しい一覧を上書きする');
  state = mergeSyncState(state, incoming([], [], [], 60));
  state = mergeSyncState(state, incoming([], [], categories, 55));
  assert(state.categories.length === 0, '削除したジャンル一覧が古い端末から復活する');

  const legacy = normalizeStoredState([task('legacy', 5)]);
  assert(legacy.syncVersion === 2 && legacy.tasks.length === 1, '旧タスク配列をv2へ移行できない');

  console.log('OK  端末A/Bの追加を保持');
  console.log('OK  古い全量送信による消失を防止');
  console.log('OK  削除タスクの復活を防止');
  console.log('OK  同一タスクは新しい編集を採用');
  console.log('OK  ジャンル一覧の競合を解決');
  console.log('OK  全削除したジャンルの復活を防止');
  console.log('OK  旧TaskData.jsonを自動移行');
})();
`;

try {
    vm.runInNewContext(`${gasSource}\n${scenarios}`, { console }, { timeout: 5000 });
    const clientFunctions = [
        extractFunction(htmlSource, 'uid'),
        extractFunction(htmlSource, 'normalizeTask'),
        extractFunction(htmlSource, 'normalizeTombstones'),
        extractFunction(htmlSource, 'mergeTaskCollections'),
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
      const result = mergeTaskCollections(local, [], remote, [{ id: 'deleted', deletedAt: 30 }]);
      if (result.tasks.length !== 2) throw new Error('端末側で追加タスクを統合できない');
      if (result.tasks.some(item => item.id === 'deleted')) throw new Error('端末側で削除タスクが復活する');
      if (result.tombstones.length !== 1) throw new Error('端末側で削除履歴を保持できない');
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
