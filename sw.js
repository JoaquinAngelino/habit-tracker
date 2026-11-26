// Network first, so a deploy shows on the next load; the cache answers only when offline.
const CACHE = "habit-tracker";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "logo.png",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
  "icons/apple-touch-icon.png",
  "privacy.html",
  "share.html",
  "terms.html",
  "src/app.js",
  "src/crypto.js",
  "src/extras.js",
  "src/github.js",
  "src/http.js",
  "src/i18n.js",
  "src/ics.js",
  "src/idb.js",
  "src/importer.js",
  "src/insights.js",
  "src/lib.js",
  "src/server.js",
  "src/share.js",
  "src/storage.js",
  "src/store.js",
  "src/ui.js",
  "src/viewer.js",
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

// A reminder arrives with no text, so the server never holds any; the wording is the browser's language.
self.addEventListener("push", (event) => {
  const es = (self.navigator.language ?? "").startsWith("es");
  event.waitUntil(
    self.registration.showNotification(es ? "Mis hábitos" : "Habit Tracker", {
      body: es ? "Es hora de tus hábitos." : "Time for your habits.",
      icon: "icons/icon-192.png",
      tag: "habits",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window" }).then((open) => (open[0] ? open[0].focus() : self.clients.openWindow("./"))));
});
