#!/usr/bin/env node
// TaskJournal 簡易チェック
//   index.html 内のインライン <script> と、単体JSファイルの構文を検証する。
//   使い方: node scripts/check.mjs   （依存パッケージ不要・Node だけで動く）
//   すべて OK なら終了コード 0、問題があれば 1 を返す。
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;

// コード断片を一時ファイルに書き出して `node --check` で構文検証する
function checkSource(label, code, ext) {
    const dir = mkdtempSync(join(tmpdir(), 'tj-check-'));
    const file = join(dir, 'snippet' + ext);
    writeFileSync(file, code);
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    rmSync(dir, { recursive: true, force: true });
    if (r.status === 0) {
        console.log(`OK  ${label}`);
    } else {
        failed++;
        console.error(`NG  ${label}\n${(r.stderr || r.stdout || '').trim()}`);
    }
}

// 1) index.html のインライン <script>（src 付きの外部読み込みは除外）
const html = readFileSync(join(root, 'index.html'), 'utf8');
const noJekyllPath = join(root, '.nojekyll');
if (existsSync(noJekyllPath) && readFileSync(noJekyllPath).length === 0) {
    console.log('OK  GitHub PagesのJekyll処理を無効化');
} else {
    failed++;
    console.error('NG  ルートに空の.nojekyllがありません');
}
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
if (scripts.length === 0) {
    console.error('NG  index.html: インライン <script> が見つかりません');
    failed++;
}
scripts.forEach((m, i) => {
    checkSource(`index.html インライン <script> #${i + 1} (${m[1].length}文字)`, m[1], '.js');
});

// 2) 単体JSファイル（worker は ESM の export を含むため .mjs として検査）
const files = [
    ['sw.js', '.js'],
    ['cloudflare/worker-openai-proxy.js', '.mjs'],
    ['gas/Code.gs', '.js'],
];
for (const [f, ext] of files) {
    checkSource(f, readFileSync(join(root, f), 'utf8'), ext);
}

function checkPowerShell(file) {
    const checker = [
        'param([Parameter(Mandatory=$true)][string]$Path)',
        '$ErrorActionPreference = "Stop"',
        '[void][scriptblock]::Create([IO.File]::ReadAllText($Path))',
    ].join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'tj-check-'));
    const checkerFile = join(dir, 'check.ps1');
    writeFileSync(checkerFile, checker);
    const r = spawnSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', checkerFile,
        join(root, file),
    ], { encoding: 'utf8' });
    rmSync(dir, { recursive: true, force: true });
    if (r.status === 0) {
        console.log(`OK  ${file}`);
    } else {
        failed++;
        console.error(`NG  ${file}\n${(r.stderr || r.stdout || '').trim()}`);
    }
}

// 3) Windows タスクスケジューラ用 PowerShell
checkPowerShell('scripts/notebooklm-refresh.ps1');
checkPowerShell('scripts/register-notebooklm-sync-task.ps1');

const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');
for (const uniqueId of ['sync-recovery-panel', 'sync-recovery-message', 'sync-recovery-retry-btn']) {
    const count = (indexHtml.match(new RegExp(`id=["']${uniqueId}["']`, 'g')) || []).length;
    if (count === 1) console.log(`OK  同期復旧UIのID: ${uniqueId}`);
    else { failed++; console.error(`NG  同期復旧UIのIDが一意ではありません: ${uniqueId} (${count})`); }
}
for (const requiredSyncSafety of [
    'fetchWithTimeout',
    'new AbortController()',
    'let pullPromise = null',
    'let pushInProgress = false',
    'let syncPromise = null',
    'function enqueueDbWrite(',
    '}, 60000, { requestId, attempt });',
    'クラウドの応答に時間がかかっています。ローカルデータは保持されているため、そのまま操作できます。',
    "action: 'capabilities'",
    "action: 'sync'",
    'dbPersistLocalMutation',
    "key: 'syncOutbox'",
    'serverVersion',
    'mutationId',
    'SYNC_PROTOCOL_MISMATCH',
    'function isRetryableSyncError(',
    'const delays = [2000, 5000, 15000];',
    "state === 'error' ? '未同期'",
    'pendingChanges: syncOutbox.length',
    'const APP_BUILD =',
    'function createRequestId(',
    'function showSyncRetrying(',
    'if (retryDelay !== 0) showSyncRetrying(retryDelay);',
    'function reconcileSyncOutbox(',
    'function buildLegacyTaskMutations(',
    'const SYNC_ACK_MISS_LIMIT = 3;',
    "const SYNC_V3_MIGRATION_META_KEY = 'syncV3MigrationCompleted';",
    'function requestQueuedSync(',
    'SYNC_QUEUED_RERUN_LIMIT',
    'mutationResults',
    'function schedulePendingAckVerification()',
    'window.retryBlockedSyncChanges = async () =>',
]) {
    if (indexHtml.includes(requiredSyncSafety)) {
        console.log(`OK  同期停止対策: ${requiredSyncSafety}`);
    } else {
        failed++;
        console.error(`NG  同期停止対策がありません: ${requiredSyncSafety}`);
    }
}
for (const requiredDiagnosticFeature of [
    'function probeSyncConnection(',
    'function probeAiConnection(',
    'max_tokens: 128',
    "error.code = hasReasoningContent ? 'AI_REASONING_ONLY' : 'AI_EMPTY_CONTENT';",
    'requestId: details.requestId ||',
]) {
    if (indexHtml.includes(requiredDiagnosticFeature)) console.log(`OK  接続診断強化: ${requiredDiagnosticFeature}`);
    else { failed++; console.error(`NG  接続診断強化がありません: ${requiredDiagnosticFeature}`); }
}
const gasCode = readFileSync(join(root, 'gas', 'Code.gs'), 'utf8');
for (const requiredGasDiagnostic of [
    'function safeRequestId(value)',
    "event: 'taskjournal_request_started'",
    'requestId: requestId',
]) {
    if (gasCode.includes(requiredGasDiagnostic)) console.log(`OK  GAS診断ID: ${requiredGasDiagnostic}`);
    else { failed++; console.error(`NG  GAS診断IDがありません: ${requiredGasDiagnostic}`); }
}
for (const lightweightPullSafety of [
    'if (result.changed) {',
    'changed: result.changed',
]) {
    if (gasCode.includes(lightweightPullSafety)) console.log(`OK  変更なし同期を軽量化: ${lightweightPullSafety}`);
    else { failed++; console.error(`NG  変更なし同期の軽量化がありません: ${lightweightPullSafety}`); }
}
for (const requiredLockFix of [
    'function refreshNotebookDocumentSafely()',
    'const documentLock = LockService.getUserLock();',
    'function scheduleNotebookDocumentRefresh()',
    'function runPendingNotebookRefresh()',
    'if (result.changed) scheduleNotebookDocumentRefresh();',
    "console.error('Notebook document refresh failed:",
]) {
    if (gasCode.includes(requiredLockFix)) console.log(`OK  GASロック短縮: ${requiredLockFix}`);
    else { failed++; console.error(`NG  GASロック短縮がありません: ${requiredLockFix}`); }
}
const mutationSyncSource = gasCode.slice(
    gasCode.indexOf('function handleMutationSync'),
    gasCode.indexOf('function safeRequestId')
);
if (!mutationSyncSource.includes('refreshNotebookDocumentSafely();')
    && mutationSyncSource.indexOf('if (lock.hasLock()) lock.releaseLock();') < mutationSyncSource.indexOf('scheduleNotebookDocumentRefresh();')) {
    console.log('OK  Googleドキュメント更新は同期応答処理から分離');
} else {
    failed++;
    console.error('NG  Googleドキュメント更新が同期応答処理内に残っています');
}
if (gasCode.includes('changed: changed') && gasCode.includes('if (result.changed) {')) {
    console.log('OK  再送済みmutationではDriveとGoogleドキュメントを再更新しない');
} else {
    failed++;
    console.error('NG  再送済みmutationの重複更新防止がありません');
}
const workerCode = readFileSync(join(root, 'cloudflare', 'worker-openai-proxy.js'), 'utf8');
for (const requiredDebugDiagnosis of [
    'function classifyGitHubWriteError(status)',
    "'GITHUB_AUTH_FAILED'",
    "'GITHUB_RATE_LIMITED'",
]) {
    if (workerCode.includes(requiredDebugDiagnosis)) console.log(`OK  デバッグ送信診断: ${requiredDebugDiagnosis}`);
    else { failed++; console.error(`NG  デバッグ送信診断がありません: ${requiredDebugDiagnosis}`); }
}
if (indexHtml.includes("console.error('Debug upload failed'") && indexHtml.includes('result.error.code')) {
    console.log('OK  デバッグ送信失敗の安全な詳細を端末へ表示');
} else {
    failed++;
    console.error('NG  デバッグ送信失敗の詳細が端末に残りません');
}
if (indexHtml.includes("postSyncRequest({ action: 'capabilities' }, 60000, { requestId, attempt })")) console.log('OK  同期能力確認は60秒待機');
else { failed++; console.error('NG  同期能力確認の待機時間が不足しています'); }
if (!indexHtml.includes("url.searchParams.set('syncToken'")) console.log('OK  同期キーをURLへ含めない');
else { failed++; console.error('NG  同期キーがURLへ含まれています'); }
if (indexHtml.includes("aiEndpointUrl: ''")) console.log('OK  AI未設定時は自動接続しない');
else { failed++; console.error('NG  AI未設定時にも既定接続先へアクセスします'); }

for (const requiredAiRecovery of [
    "const responseText = await response.text();",
    'result = JSON.parse(responseText);',
    'return requestAiChat(context, payload, timeoutMs, 1, diagnosticRequestId);',
    'responseContentType,',
    'responseLength: responseText.length,',
    'AIから一時的に読み取れない応答が返りました。',
]) {
    if (indexHtml.includes(requiredAiRecovery)) console.log(`OK  AI一時応答から復旧: ${requiredAiRecovery}`);
    else { failed++; console.error(`NG  AI一時応答の復旧処理がありません: ${requiredAiRecovery}`); }
}

for (const requiredFeature of [
    'id="conflict-section"',
    'compareConflictWithAI',
    'resolveConflict',
    'タスクのタイトル',
    '予定日時（任意）',
    'id="schedule-created-input"',
    'id="schedule-logs-editor"',
    'parseTaskLogEntry',
    'serializeTaskLogEntry',
    'id="schedule-device-label"',
    'createdDeviceName',
    'id="sync-progress-panel"',
    'setSyncProgress(45,',
]) {
    if (indexHtml.includes(requiredFeature)) console.log(`OK  競合・編集機能: ${requiredFeature}`);
    else { failed++; console.error(`NG  競合・編集機能がありません: ${requiredFeature}`); }
}
if (!indexHtml.includes('id="task-datetime"')) console.log('OK  新規追加欄に予定日時なし');
else { failed++; console.error('NG  新規追加欄に予定日時が残っています'); }

for (const requiredDetailedTaskFeature of [
    'id="detailed-task-btn"',
    "window.openDetailedTaskModal = (presetDateTime = '') =>",
    "let scheduleModalMode = 'edit';",
    "configureScheduleModal('create');",
    "configureScheduleModal('edit');",
    "const isCreate = scheduleModalMode === 'create';",
    'タスクを詳しく追加',
    '追加してカレンダーへ',
]) {
    if (indexHtml.includes(requiredDetailedTaskFeature)) console.log(`OK  詳細タスク追加: ${requiredDetailedTaskFeature}`);
    else { failed++; console.error(`NG  詳細タスク追加が不完全です: ${requiredDetailedTaskFeature}`); }
}
if (!indexHtml.includes('data-lucide="plus-circle"')) console.log('OK  機能しない追加アイコンを削除');
else { failed++; console.error('NG  機能しない追加アイコンが残っています'); }

for (const requiredUxFeature of [
    'rel="manifest" href="manifest.webmanifest"',
    'id="confirm-modal"',
    'function showConfirm(',
    'function showUndoToast(',
    'id="task-search"',
    'id="app-view-switch"',
    'data-app-view="tasks"',
    'id="task-filter-panel"',
    'function getTaskAttention(',
    'function activeTaskDisplayRank(',
    'class="task-actions-menu"',
    'sync-status-label',
    'taskjournal:theme',
    'window.lucide = window.lucide || { createIcons() {} };',
    'id="sync-connection-test-btn"',
    'id="ai-connection-test-btn"',
    'function safeConnectionError(',
]) {
    if (indexHtml.includes(requiredUxFeature)) console.log(`OK  GUI/UX刷新: ${requiredUxFeature}`);
    else { failed++; console.error(`NG  GUI/UX機能がありません: ${requiredUxFeature}`); }
}
if (!indexHtml.includes('id="focus-card"') && !indexHtml.includes('function renderFocusCard(')) {
    console.log('OK  独立したフォーカスカードを撤去');
} else {
    failed++;
    console.error('NG  独立したフォーカスカードが残っています');
}
for (const requiredCompletedBoxFeature of [
    'aria-label="完了したタスクの格納ボックス"',
    'aria-describedby="completed-toggle-description"',
    'data-lucide="archive"',
    'let completedCollapsed = true;',
    'if (storedCompletedState !== null)',
    "description.textContent = completedCollapsed ? 'タップして表示' : 'タップして閉じる';",
    'ccEl.textContent = `${doneTasks.length}件`;',
]) {
    if (indexHtml.includes(requiredCompletedBoxFeature)) console.log(`OK  完了タスク格納ボックス: ${requiredCompletedBoxFeature}`);
    else { failed++; console.error(`NG  完了タスク格納ボックスが不完全です: ${requiredCompletedBoxFeature}`); }
}
for (const requiredDeletedBoxFeature of [
    'id="task-storage-boxes" class="storage-box-grid"',
    'aria-label="削除したタスクの格納ボックス"',
    'aria-describedby="deleted-toggle-description"',
    "const DELETED_TASK_ARCHIVE_KEY = 'deletedTaskArchive';",
    'const DELETED_TASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;',
    'function normalizeDeletedTaskArchive(',
    '.sort((a, b) => b.deletedAt - a.deletedAt)',
    '.slice(0, DELETED_TASK_ARCHIVE_LIMIT);',
    'removeDeletedArchiveId: deletedArchiveId',
    'window.restoreDeletedTask = async (archiveId) =>',
    'window.permanentlyDeleteArchivedTask = async (archiveId) =>',
    "const title = escapeHtml(task.text || '無題のタスク');",
    "description.textContent = deletedCollapsed ? 'この端末・30日保存' : 'タップして閉じる';",
    'dcEl.textContent = `${deletedTaskArchive.length}件`;',
]) {
    if (indexHtml.includes(requiredDeletedBoxFeature)) console.log(`OK  削除タスク格納ボックス: ${requiredDeletedBoxFeature}`);
    else { failed++; console.error(`NG  削除タスク格納ボックスが不完全です: ${requiredDeletedBoxFeature}`); }
}
for (const requiredExclusiveStorageBoxFeature of [
    'function persistTaskStorageBoxStates()',
    'if (!completedCollapsed && !deletedCollapsed)',
    'if (willOpen) deletedCollapsed = true;',
    'if (willOpen) completedCollapsed = true;',
    'persistTaskStorageBoxStates();',
    'applyCompletedSectionState();',
    'applyDeletedSectionState();',
]) {
    if (indexHtml.includes(requiredExclusiveStorageBoxFeature)) console.log(`OK  格納ボックス排他開閉: ${requiredExclusiveStorageBoxFeature}`);
    else { failed++; console.error(`NG  格納ボックス排他開閉が不完全です: ${requiredExclusiveStorageBoxFeature}`); }
}
const serviceWorkerCode = readFileSync(join(root, 'sw.js'), 'utf8');
if (indexHtml.includes("const SW_CACHE_NAME = 'taskjournal-cache-v13';")
    && serviceWorkerCode.includes("const CACHE = 'taskjournal-cache-v13';")) {
    console.log('OK  Service Workerキャッシュ名が一致');
} else {
    failed++;
    console.error('NG  Service Workerキャッシュ名が一致していません');
}
const gasManifest = JSON.parse(readFileSync(join(root, 'gas', 'appsscript.json'), 'utf8'));
for (const requiredCalendarFeature of [
    'id="calendar-view"',
    'data-calendar-mode="day"',
    'data-calendar-mode="week"',
    'data-calendar-mode="month"',
    "action: 'calendar-range'",
    'window.openDetailedTaskForDate = (dateKey) =>',
    'この日に追加',
    "const CALENDAR_TOKEN_CONTEXT = 'TaskJournal calendar read v1';",
    'async function deriveCalendarReadToken(',
    'const CALENDAR_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;',
    '重複候補',
]) {
    if (indexHtml.includes(requiredCalendarFeature)) console.log(`OK  カレンダー表示: ${requiredCalendarFeature}`);
    else { failed++; console.error(`NG  カレンダー表示が不完全です: ${requiredCalendarFeature}`); }
}
if (indexHtml.includes('.calendar-month-preview-title { display: block; }')
    && !indexHtml.includes('.calendar-month-preview-title { display: none; }')) {
    console.log('OK  iPhone月表示でタスク名を表示');
} else {
    failed++;
    console.error('NG  iPhone月表示でタスク名が表示されません');
}
for (const requiredCalendarBackendFeature of [
    "data.action === 'calendar-range'",
    'function authorizeCalendarRead()',
    'function isCalendarReadAuthorized(',
    'function handleCalendarRange(',
    'const CALENDAR_MAX_RANGE_DAYS = 45;',
    'const CALENDAR_MAX_EVENTS = 300;',
    "calendarTokenDerivation: 'hmac-sha256-v1'",
]) {
    if (gasCode.includes(requiredCalendarBackendFeature)) console.log(`OK  カレンダーGAS: ${requiredCalendarBackendFeature}`);
    else { failed++; console.error(`NG  カレンダーGASが不完全です: ${requiredCalendarBackendFeature}`); }
}
if (Array.isArray(gasManifest.oauthScopes)
    && gasManifest.oauthScopes.includes('https://www.googleapis.com/auth/calendar.readonly')) {
    console.log('OK  Googleカレンダー権限は読み取り専用');
} else {
    failed++;
    console.error('NG  Googleカレンダーの読み取り専用権限がありません');
}
const executableGas = gasCode.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
if (!/\b(?:CalendarApp|calendar|event)\.(?:create|set|delete)[A-Z]\w*\s*\(/.test(executableGas)) {
    console.log('OK  GASはGoogleカレンダーを書き換えない');
} else {
    failed++;
    console.error('NG  GASにGoogleカレンダーの書き換え処理があります');
}
if (!indexHtml.includes('id="trivia-bar"') && !indexHtml.includes('id="trivia-modal"')) console.log('OK  豆知識UIを撤去');
else { failed++; console.error('NG  豆知識UIが残っています'); }
if (indexHtml.includes('src="icons/icon-192.png"')) console.log('OK  ヘッダーに選定アイコンを表示');
else { failed++; console.error('NG  ヘッダーに選定アイコンがありません'); }
const executableHtml = indexHtml.replace(/<!--([\s\S]*?)-->/g, '').split('\n')
    .filter(line => !/^\s*(?:\/\/|\*)/.test(line)).join('\n');
if (!/\b(?:window\.)?confirm\s*\(/.test(executableHtml) && !/\b(?:window\.)?alert\s*\(/.test(executableHtml)) {
    console.log('OK  ブラウザ標準のconfirm/alertを使用しない');
} else {
    failed++;
    console.error('NG  ブラウザ標準のconfirm/alertが残っています');
}

for (const pwaFile of ['manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png']) {
    try {
        readFileSync(join(root, pwaFile));
        console.log(`OK  PWAファイル: ${pwaFile}`);
    } catch {
        failed++;
        console.error(`NG  PWAファイルがありません: ${pwaFile}`);
    }
}
for (const [iconFile, expectedSize] of [['icons/icon-192.png', 192], ['icons/icon-512.png', 512], ['icons/apple-touch-icon.png', 180]]) {
    const png = readFileSync(join(root, iconFile));
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (width === expectedSize && height === expectedSize) console.log(`OK  アイコン寸法: ${iconFile} (${width}x${height})`);
    else { failed++; console.error(`NG  アイコン寸法が不正です: ${iconFile} (${width}x${height})`); }
}

const syncCheck = spawnSync(process.execPath, [join(root, 'scripts', 'check-device-sync.mjs')], {
    encoding: 'utf8',
});
if (syncCheck.status === 0) {
    console.log(syncCheck.stdout.trim());
} else {
    failed++;
    console.error((syncCheck.stderr || syncCheck.stdout || 'NG  端末同期シナリオ').trim());
}

console.log(failed ? `\n${failed} 件の問題があります` : '\nすべてOK');
process.exit(failed ? 1 : 0);
