/**
 * Cloudflare Worker - OpenAI互換プロキシ (CORS対応版)
 *
 * 役割:
 *   1. api.edaaiapps.com/v1/* を受ける
 *   2. Authorization: Bearer <GEMMA_API_KEY> を検証 (不一致なら 401)
 *   3. 上流 lmstudio.edaaiapps.com/v1/* へ転送
 *   4. 転送時に Cloudflare Access Service Token を自動付与
 *   5. LM Studio の OpenAI互換レスポンスをそのまま返す
 *
 * ★この版での追加点 = ブラウザ(Pages版TaskJournal等)から直接呼べるCORS対応:
 *   - プリフライト(OPTIONS)に認証不要で応答する
 *     ※ブラウザはpreflightにAuthorizationを載せないため、認証より前に処理する
 *   - すべての応答に Access-Control-Allow-Origin を付与する
 *   - 許可Originは ALLOWED_ORIGINS(カンマ区切り) で制御。未設定時は "*"
 *
 * 必要な環境変数(Secret/Text):
 *   GEMMA_API_KEY            (Secret) … Bearer認証の検証用
 *   CF_ACCESS_CLIENT_ID      (Secret) … Cloudflare Access Service Token ID
 *   CF_ACCESS_CLIENT_SECRET  (Secret) … 同 Secret
 *   UPSTREAM_BASE_URL        (Text)   … 例: https://lmstudio.edaaiapps.com
 *   ALLOWED_ORIGINS          (Text/任意) … 例: https://idna7711-design.github.io
 *                                         複数可(カンマ区切り)。未設定なら全許可(*)。
 */

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    // 1. CORSプリフライト: 認証チェックより前に、認証不要で応答する
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // 2. Bearer認証
    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!env.GEMMA_API_KEY || token !== env.GEMMA_API_KEY) {
      return json({ error: { message: 'Unauthorized', type: 'invalid_api_key' } }, 401, cors);
    }

    // 3. 上流URLを組み立て (/v1/... のパスとクエリをそのまま引き継ぐ)
    const inUrl = new URL(request.url);
    const base = (env.UPSTREAM_BASE_URL || '').replace(/\/+$/, '');
    if (!base) {
      return json({ error: { message: 'UPSTREAM_BASE_URL not configured' } }, 500, cors);
    }
    const upstreamUrl = base + inUrl.pathname + inUrl.search;

    // 4. 上流ヘッダー: Access Service Token を付与、ブラウザ由来の不要ヘッダーは除く
    const headers = new Headers();
    headers.set('Content-Type', request.headers.get('Content-Type') || 'application/json');
    headers.set('CF-Access-Client-Id', env.CF_ACCESS_CLIENT_ID || '');
    headers.set('CF-Access-Client-Secret', env.CF_ACCESS_CLIENT_SECRET || '');

    const init = {
      method: request.method,
      headers,
      body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : request.body,
    };

    // 5. 転送して、本文はそのまま・CORSヘッダーを足して返す
    let upstreamRes;
    try {
      upstreamRes = await fetch(upstreamUrl, init);
    } catch (e) {
      return json({ error: { message: 'Upstream fetch failed: ' + e.message } }, 502, cors);
    }

    const outHeaders = new Headers(upstreamRes.headers);
    for (const [k, v] of Object.entries(cors)) outHeaders.set(k, v);
    // 上流が付けてくる可能性のある制限的CORSは上書き済み

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
