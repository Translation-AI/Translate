/**
 * Service Worker: 静的資産のオフラインキャッシュ。
 *
 * Transformers.js のモデルファイルは HF CDN 側で別途キャッシュされる
 * （ここでは触らない＝SW のストレージ枠を圧迫しない）。
 */
const CACHE = 'translate-static-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './main.js',
  './glossary.json',
  './cache/indexedDb.js',
  './engines/chromeTranslator.js',
  './engines/transformersJs.js',
  './engines/serverApi.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
        .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // HF CDN や API 呼び出しはネットワーク優先（SW がキャッシュ汚染しない）
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      // ランタイムで取得した同一オリジン資産もキャッシュに追加
      if (res.ok && e.request.method === 'GET') {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => hit))
  );
});
