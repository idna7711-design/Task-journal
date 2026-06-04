/**
 * TaskJournal Service Worker
 *
 * 方式: network-first（ネットワーク優先）
 *   - オンライン時は常にネットワークから最新を取得 → 通常リロードで最新版が反映される
 *     （スーパーリロード不要）
 *   - 取得に成功したらキャッシュへ保存し、オフライン時はキャッシュから配信する
 *   - ナビゲーション(HTML)はオフライン時に index.html へフォールバック
 *
 * 注意: タスクや設定(APIキー等)は IndexedDB に保存されており、このキャッシュとは無関係。
 *       キャッシュを消してもユーザーデータは消えない。
 */
const CACHE = 'taskjournal-cache-v1';
const CORE_ASSETS = ['./', './index.html'];

self.addEventListener('install', (event) => {
    // 新しい SW を即時有効化（更新がすぐ効くように）
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE).then((c) => c.addAll(CORE_ASSETS)).catch(() => {})
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    event.respondWith(
        fetch(req)
            .then((res) => {
                // 取得できたものはキャッシュに保存（オフライン用。CDN等の opaque も含む）
                const copy = res.clone();
                caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
                return res;
            })
            .catch(() =>
                caches.match(req).then((cached) => {
                    if (cached) return cached;
                    // ナビゲーションはオフライン時に index.html へフォールバック
                    if (req.mode === 'navigate') return caches.match('./index.html');
                    return Response.error();
                })
            )
    );
});
