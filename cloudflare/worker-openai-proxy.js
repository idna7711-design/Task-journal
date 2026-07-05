/**
 * Cloudflare Worker - OpenAI互換プロキシ（複数APIキー対応版）
 *
 * 役割:
 *   1. api.edaaiapps.com/v1/* を受ける
 *   2. Authorization: Bearer <キー> を検証（複数キー可）
 *   3. 上流 lmstudio.edaaiapps.com/v1/* へ転送
 *   4. 転送時に Cloudflare Access Service Token を自動付与
 *   5. LM Studio の OpenAI互換レスポンスをそのまま返す
 *
 * CORS対応:
 *   - プリフライト(OPTIONS)に認証不要で応答する
 *   - すべての応答に Access-Control-Allow-Origin を付与する
 *   - 許可Originは ALLOWED_ORIGINS(カンマ区切り) で制御。未設定時は "*"
 *
 * デバッグログ受け口:
 *   POST /v1/debug-log … アプリのエラー時にデバッグログ＋端末情報を受け取り、
 *                        GitHubリポジトリの debug/ にMarkdownでコミットする。
 *                        GitHubトークンはこのWorker(サーバー側)にのみ置くため、
 *                        ブラウザにトークンは一切露出しない。
 *
 * 必要な環境変数(Secret/Text):
 *   GEMMA_API_KEYS           (Secret) … カンマ区切りで複数キー可 例: key1,key2,key3
 *   GEMMA_API_KEY            (Secret) … 旧変数。GEMMA_API_KEYSがなければこちらを使用（後方互換）
 *   CF_ACCESS_CLIENT_ID      (Secret) … Cloudflare Access Service Token ID
 *   CF_ACCESS_CLIENT_SECRET  (Secret) … 同 Secret
 *   UPSTREAM_BASE_URL        (Text)   … 例: https://lmstudio.edaaiapps.com
 *   ALLOWED_ORIGINS          (Text/任意) … 例: https://idna7711-design.github.io
 *                                         複数可(カンマ区切り)。未設定なら全許可(*)。
 *   --- デバッグログ機能を使う場合のみ ---
 *   GITHUB_TOKEN             (Secret) … contents:write 権限の Fine-grained PAT(対象リポジトリ限定推奨)
 *   GITHUB_REPO              (Text)   … 例: idna7711-design/Task-journal
 *   GITHUB_BRANCH            (Text/任意) … 既定 main
 *   DEBUG_LOG_DIR            (Text/任意) … 既定 debug
 */

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    // 1. CORSプリフライト: 認証チェックより前に、認証不要で応答する
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // 2. /v1/ 以外のパスは拒否
    const inUrl = new URL(request.url);
    if (!inUrl.pathname.startsWith('/v1/')) {
      return json({ error: { message: 'Not Found' } }, 404, cors);
    }

    // 3. Bearer認証（複数キー対応 + 旧変数との後方互換）
    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const validKeys = (env.GEMMA_API_KEYS || env.GEMMA_API_KEY || '')
      .split(',').map(k => k.trim()).filter(Boolean);
    if (validKeys.length === 0 || !validKeys.includes(token)) {
      return json({ error: { message: 'Unauthorized', type: 'invalid_api_key' } }, 401, cors);
    }

    // 3.5 デバッグログ受け口（認証済みのみ）。GitHubリポジトリの debug/ にコミットする。
    if (inUrl.pathname === '/v1/debug-log') {
      if (request.method !== 'POST') {
        return json({ error: { message: 'Method Not Allowed' } }, 405, cors);
      }
      return await handleDebugLog(request, env, cors);
    }

    // 4. 上流URLを組み立て (/v1/... のパスとクエリをそのまま引き継ぐ)
    const base = (env.UPSTREAM_BASE_URL || '').replace(/\/+$/, '');
    if (!base) {
      return json({ error: { message: 'UPSTREAM_BASE_URL not configured' } }, 500, cors);
    }
    const upstreamUrl = base + inUrl.pathname + inUrl.search;

    // 5. 上流ヘッダー: Access Service Token を付与、ブラウザ由来の不要ヘッダーは除く
    const headers = new Headers();
    headers.set('Content-Type', request.headers.get('Content-Type') || 'application/json');
    headers.set('CF-Access-Client-Id', env.CF_ACCESS_CLIENT_ID || '');
    headers.set('CF-Access-Client-Secret', env.CF_ACCESS_CLIENT_SECRET || '');

    const init = {
      method: request.method,
      headers,
      body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : request.body,
    };

    // 6. 転送して、本文はそのまま・CORSヘッダーを足して返す
    let upstreamRes;
    try {
      upstreamRes = await fetch(upstreamUrl, init);
    } catch (e) {
      return json({ error: { message: 'Upstream fetch failed: ' + e.message } }, 502, cors);
    }

    const outHeaders = new Headers(upstreamRes.headers);
    for (const [k, v] of Object.entries(cors)) outHeaders.set(k, v);

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: outHeaders,
    });
  },
};

function corsHeaders(origin, env) {
  const allow = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  let allowOrigin = '*';
  if (allow.length > 0) {
    allowOrigin = allow.includes(origin) ? origin : allow[0];
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// ===== デバッグログ → GitHub コミット =====
async function handleDebugLog(request, env, cors) {
  const ghToken = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || 'main';
  const dir = (env.DEBUG_LOG_DIR || 'debug').replace(/^\/+|\/+$/g, '');
  if (!ghToken || !repo) {
    return json({ error: { message: 'GITHUB_TOKEN / GITHUB_REPO not configured' } }, 500, cors);
  }

  let payload;
  try { payload = await request.json(); } catch { payload = { reason: 'invalid-json' }; }

  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const rnd = Math.random().toString(36).slice(2, 8);
  const path = `${dir}/${stamp}-${rnd}.md`;

  const md = buildDebugMarkdown(payload, now);
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

  let ghRes, ghJson;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    ghRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${ghToken}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'task-journal-debug-logger',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `debug: ${(payload && payload.reason) || 'error'} @ ${stamp}`,
        content: b64utf8(md),
        branch,
      }),
      signal: controller.signal,
    });
    ghJson = await ghRes.json().catch(() => ({}));
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return json({ error: { message: debugUploadErrorMessage('GITHUB_TIMEOUT'), code: 'GITHUB_TIMEOUT' } }, 504, cors);
    }
    return json({ error: { message: 'GitHubへの接続に失敗しました', code: 'GITHUB_FETCH_FAILED' } }, 502, cors);
  } finally {
    clearTimeout(timeoutId);
  }
  if (!ghRes.ok) {
    const code = classifyGitHubWriteError(ghRes.status);
    return json({
      error: {
        message: debugUploadErrorMessage(code),
        code,
        status: ghRes.status,
      },
    }, 502, cors);
  }
  return json({ ok: true, path, html_url: ghJson && ghJson.content && ghJson.content.html_url }, 200, cors);
}

function classifyGitHubWriteError(status) {
  if (status === 401 || status === 403) return 'GITHUB_AUTH_FAILED';
  if (status === 409) return 'GITHUB_CONFLICT';
  if (status === 422) return 'GITHUB_REQUEST_REJECTED';
  if (status === 429) return 'GITHUB_RATE_LIMITED';
  return 'GITHUB_WRITE_FAILED';
}

function debugUploadErrorMessage(code) {
  const messages = {
    GITHUB_AUTH_FAILED: 'GitHubトークンの期限または書き込み権限を確認してください',
    GITHUB_CONFLICT: 'GitHub側で一時的な競合が発生しました',
    GITHUB_REQUEST_REJECTED: 'GitHubがログファイルの作成要求を拒否しました',
    GITHUB_RATE_LIMITED: 'GitHubの利用上限に達しました。時間を置いて再試行してください',
    GITHUB_TIMEOUT: 'GitHubへの接続が15秒以内に完了しませんでした',
    GITHUB_WRITE_FAILED: 'GitHubへのログ保存に失敗しました',
  };
  return messages[code] || messages.GITHUB_WRITE_FAILED;
}

function buildDebugMarkdown(p, now) {
  p = p || {};
  const env = p.env || {};
  const logs = Array.isArray(p.logs) ? p.logs : [];
  const lines = [];
  lines.push('# Task-journal Debug Report');
  lines.push('');
  lines.push(`- **時刻**: ${now.toISOString()}`);
  lines.push(`- **理由**: ${p.reason || '(unspecified)'}`);
  if (p.message) lines.push(`- **メッセージ**: ${String(p.message).slice(0, 500)}`);
  lines.push('');
  lines.push('## 端末・実行環境');
  lines.push('```json');
  lines.push(JSON.stringify(env, null, 2));
  lines.push('```');
  lines.push('');
  lines.push(`## ログ (${logs.length}件 / 古い→新しい)`);
  lines.push('```');
  logs.forEach(e => {
    lines.push(`[${(e && e.t) || ''}] ${((e && e.level) || 'log').toUpperCase()} ${(e && e.msg) || ''}`);
  });
  lines.push('```');
  return lines.join('\n');
}

// UTF-8文字列をbase64へ（大きめでもスタックを溢れさせないようチャンク処理）
function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
