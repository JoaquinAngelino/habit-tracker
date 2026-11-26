// Network first, so a deploy shows on the next load; the cache answers only when offline.
const CACHE = "habit-tracker";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "logo.png",
  "privacy.html",
  "terms.html",
  "src/app.js",
  "src/crypto.js",
  "src/github.js",
  "src/http.js",
  "src/i18n.js",
  "src/idb.js",
  "src/lib.js",
  "src/server.js",
  "src/storage.js",
  "src/store.js",
  "src/ui.js",
  "fonts/barlow-condensed-latin-600-normal.woff2",
  "fonts/barlow-condensed-latin-700-normal.woff2",
  "fonts/barlow-latin-400-normal.woff2",
  "fonts/barlow-latin-500-normal.woff2",
  "fonts/barlow-latin-600-normal.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => (await caches.match(request, { ignoreSearch: true })) ?? (request.mode === "navigate" ? caches.match("./") : Response.error())),
  );
});
