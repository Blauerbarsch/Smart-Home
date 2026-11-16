// Service Worker: App-Hülle offline verfügbar, API immer live.
const CACHE = 'smarthome-v5';
const SHELL = ['/', '/css/app.css', '/css/hud.css', '/js/app.js', '/js/core.js', '/js/tiles.js', '/js/grid.js', '/js/editor.js',
  '/js/settings.js', '/js/map.js', '/js/workshop.js', '/js/hud-bg.js', '/js/notify.js', '/js/kiosk.js',
  '/js/server.js', '/js/floorplan.js', '/js/workshop-extra.js', '/js/workbench-ui.js', '/js/esptools.js',
  '/js/stl.js', '/js/chronik-ui.js', '/js/weather-ui.js', '/icons/icon.svg', '/manifest.webmanifest', '/vendor/mdi/css/materialdesignicons.min.css',
  '/vendor/mdi/fonts/materialdesignicons-webfont.woff2', '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Netzwerk zuerst, damit Updates sofort ankommen; Cache nur als Rückfall.
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('/'))));
});
