// Network-first: gdy jest internet – zawsze najnowsza wersja; bez internetu – z pamięci.
const CACHE = 'moja-polka-v3';
const FILES = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/app.js', 'js/reader.js', 'js/importer.js', 'js/db.js', 'js/tts.js',
  'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png',
  'books/tajemniczy-ogrod.epub',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    // no-cache: zawsze pytamy serwer o nowszą wersję (tanie sprawdzenie ETag), więc poprawki widać od razu
    fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
