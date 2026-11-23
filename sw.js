// Minimal service worker for installability. Network-first for the app shell with a cache
// fallback when offline; data/*.json is never cached here so a reload always shows fresh data.
const CACHE = 'hh-shell-v8';
const SHELL = ['./', 'index.html', 'assets/styles.css', 'assets/app.js', 'assets/util.js', 'assets/data.js', 'assets/store.js',
  'assets/charts.js', 'assets/listings.js', 'assets/views.js', 'assets/map.js', 'assets/finance.js', 'assets/github.js', 'assets/bookmarklet.js', 'assets/inflation.js', 'assets/estimate.js', 'assets/icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/data/') || url.pathname.includes('/dev/')) return; // always network
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone())).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || Response.error())),
  );
});
