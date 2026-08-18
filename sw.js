/* 御前指挥部 - Service Worker：实现离线可用 */
const CACHE_NAME = 'workbuddy-v33';
const ASSETS = [
  './',
  './index.html',
  './localdb.js',
  './seed_data.json',
  './seed_images.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
  './action_lib/img_manifest.json',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js',
];

// 安装：预缓存核心资源
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// 激活：清理旧缓存
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 请求：缓存优先，失败回退缓存
self.addEventListener('fetch', (e) => {
  const url = e.request.url;
  // 只处理同源 GET 和 CDN 静态资源
  if (e.request.method !== 'GET') return;
  const isAsset = url.startsWith(self.location.origin) ||
    url.includes('cdn.jsdelivr.net') ||
    url.includes('fonts.googleapis.com') ||
    url.includes('fonts.gstatic.com');
  if (!isAsset) return;

  // 导航请求（打开页面）：network-first，保证每次都拿到最新页面
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then((resp) => {
        if (resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return resp;
      }).catch(() =>
        caches.match(e.request).then((c) => c || caches.match('./index.html') || caches.match('./'))
      )
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetchPromise = fetch(e.request).then((resp) => {
        if (resp && (resp.status === 200 || resp.type === 'opaque')) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return resp;
      }).catch(() => cached);
      // 本地文件 stale-while-revalidate：先返回缓存，后台更新
      return cached || fetchPromise;
    })
  );
});
