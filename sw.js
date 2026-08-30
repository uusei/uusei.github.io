const CACHE = 'cloud-album-shell-v2';
const SHELL = ['./', './index.html', './css/app.css', './js/app.js', './js/r2.js', './js/index-store.js', './icons/icon.svg', './manifest.webmanifest'];

self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method === 'POST' && new URL(request.url).origin === location.origin) {
    event.respondWith((async () => {
      const data = await request.formData();
      const files = data.getAll('images').filter(value => value instanceof File);
      const cache = await caches.open(CACHE);
      await cache.put('./shared-files', new Response(JSON.stringify(await Promise.all(files.map(async file => ({
        name: file.name, type: file.type, data: Array.from(new Uint8Array(await file.arrayBuffer()))
      }))))));
      return Response.redirect('./?share-target=1', 303);
    })());
    return;
  }
  if (request.method !== 'GET' || request.destination === 'image') return;
  event.respondWith(caches.match(request).then(hit => hit || fetch(request).then(response => {
    if (new URL(request.url).origin === location.origin) caches.open(CACHE).then(cache => cache.put(request, response.clone()));
    return response;
  })));
});
