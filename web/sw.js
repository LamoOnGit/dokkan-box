// Service worker : l'app s'ouvre même sans réseau, et les images des cartes restent en cache.
// Fichiers du site : réseau d'abord (pour toujours avoir la dernière version), cache en secours.
// Images des cartes : cache d'abord (elles ne changent pas).
const APP = 'dokkan-app-v1';
const IMG = 'dokkan-img-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.destination === 'image' && url.origin !== location.origin) {
    e.respondWith(caches.open(IMG).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(APP).then((c) => c.put(req, copy)); }
    return res;
  }).catch(async () => (await caches.match(req, { ignoreSearch: true })) || Response.error()));
});
