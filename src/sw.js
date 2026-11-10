// Network first for the page, the last good copy when offline, so the
// installed app still opens on a train. Everything else (version.json, icons)
// goes straight to the network.
var CACHE = 'page-v1';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).then(function (res) {
    // An expired Access session answers with an opaque redirect to the login
    // page. It is passed through so the browser signs in, and never cached.
    if (res.ok && res.type === 'basic') {
      var copy = res.clone();
      event.waitUntil(caches.open(CACHE).then(function (c) { return c.put('./', copy); }));
    }
    return res;
  }).catch(function () {
    return caches.match('./').then(function (r) { return r || Response.error(); });
  }));
});
