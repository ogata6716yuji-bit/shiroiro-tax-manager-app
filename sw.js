// しらべ帳 Service Worker
// キャッシュ更新漏れ対策として network-first 戦略 + バージョン管理を採用
const CACHE_VERSION = 'v3';
const CACHE_NAME = `shirabecho-${CACHE_VERSION}`;
const PRECACHE_URLS = [
  './',
  './index.html',
  './app.js',
  './receipt.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// network-first: 常に最新を取りに行き、失敗時のみキャッシュにフォールバック
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // 外部CDN(html2canvas / jsPDF)はブラウザの通常キャッシュに任せる
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
