/* PAPERX service worker: precache app shell, runtime-cache heavy on-device engines. */
const VERSION = '__VERSION__';
const SHELL = `paperx-shell-${VERSION}`;
const ENGINES = 'paperx-engines-v1';
const PRECACHE = self.__PRECACHE__;
const ENGINE_FILES = [
  './vendor/opencv/opencv.js',
  './vendor/tesseract/worker.min.js',
  './vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js',
  './vendor/tesseract/core/tesseract-core-lstm.wasm.js',
  './vendor/tesseract/lang/tha.traineddata.gz',
  './vendor/tesseract/lang/eng.traineddata.gz',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(Array.isArray(PRECACHE) ? PRECACHE : ['./'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('paperx-shell-') && k !== SHELL).map((k) => caches.delete(k)));
    await self.clients.claim();
    // warm the engine cache in the background so OCR & detection work offline
    const c = await caches.open(ENGINES);
    for (const f of ENGINE_FILES) {
      try { if (!(await c.match(f))) await c.add(f); } catch (err) { /* retry on next activation */ }
    }
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => { const cp = r.clone(); caches.open(SHELL).then((c) => c.put('./', cp)); return r; }).catch(() => caches.match('./', { ignoreSearch: true })));
    return;
  }
  const isEngine = url.pathname.includes('/vendor/');
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) {
      const cp = res.clone();
      caches.open(isEngine ? ENGINES : SHELL).then((c) => c.put(req, cp));
    }
    return res;
  })());
});
