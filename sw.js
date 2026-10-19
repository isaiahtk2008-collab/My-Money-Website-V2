const CACHE_NAME = 'mm-v1';
const CHART_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || /(^|\.)script\.google(usercontent)?\.com$/.test(url.hostname)) return;
  const put = (res) => { if (res && res.ok) { const c = res.clone(); caches.open(CACHE_NAME).then(ch => ch.put(req, c)); } return res; };
  if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
    e.respondWith(caches.match(req).then(hit => { const net = fetch(req).then(put).catch(() => hit); return hit || net; }));
  } else if (req.url === CHART_CDN) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(put)));
  } else if (url.origin === location.origin) {
    // network-first so app updates are never stuck behind the cache
    e.respondWith(fetch(req).then(put).catch(() => caches.match(req)));
  }
});
