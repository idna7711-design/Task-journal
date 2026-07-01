#!/usr/bin/env node
// TaskJournal 簡易チェック
//   index.html 内のインライン <script> と、単体JSファイルの構文を検証する。
//   使い方: node scripts/check.mjs   （依存パッケージ不要・Node だけで動く）
//   すべて OK なら終了コード 0、問題があれば 1 を返す。
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
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
for (const requiredSyncSafety of [
    'fetchWithTimeout',
    'new AbortController()',
    'let pullPromise = null',
    'let pushInProgress = false',
    '}, 60000);',
    'クラウドが20秒以内に応答しませんでした。ローカルデータは保持されています。',
]) {
    if (indexHtml.includes(requiredSyncSafety)) {
        console.log(`OK  同期停止対策: ${requiredSyncSafety}`);
    } else {
        failed++;
        console.error(`NG  同期停止対策がありません: ${requiredSyncSafety}`);
    }
}

for (const requiredFeature of [
    'id="conflict-section"',
    'compareConflictWithAI',
    'resolveConflict',
    'タスクのタイトル',
    '予定日時（任意）',
]) {
    if (indexHtml.includes(requiredFeature)) console.log(`OK  競合・編集機能: ${requiredFeature}`);
    else { failed++; console.error(`NG  競合・編集機能がありません: ${requiredFeature}`); }
}
if (!indexHtml.includes('id="task-datetime"')) console.log('OK  新規追加欄に予定日時なし');
else { failed++; console.error('NG  新規追加欄に予定日時が残っています'); }

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
