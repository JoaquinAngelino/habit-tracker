// Network first, so a deploy shows on the next load; the cache answers when offline or when a page is slow to arrive.
const CACHE = "habit-tracker";
const SLOW_AFTER = 3000;
// Pages opened from the cache take their files from it too, so versions never mix.
const fromCache = new Set();
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
  "src/account.js",
  "src/app.js",
  "src/card.js",
  "src/crypto.js",
  "src/http.js",
  "src/i18n.js",
  "src/ics.js",
  "src/idb.js",
  "src/importer.js",
  "src/insights.js",
  "src/lib.js",
  "src/metrics.js",
  "src/server.js",
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

const cachedFor = (request) => caches.match(request, { ignoreSearch: true });

async function fromNetwork(request) {
  const response = await fetch(request);
  if (response.ok) {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy));
  }
  return response;
}

const offline = async (request) => (await cachedFor(request)) ?? (request.mode === "navigate" ? caches.match("./") : Response.error());

async function openPage(request, id) {
  const network = fromNetwork(request);
  // Once the cache has answered, a late failure has nobody left to tell.
  network.catch(() => {});
  let timer;
  const slow = new Promise((resolve) => (timer = setTimeout(resolve, SLOW_AFTER)));
  try {
    const first = await Promise.race([network, slow]);
    if (first) return first;
    const cached = await cachedFor(request);
    if (!cached) return await network;
    fromCache.add(id);
    return cached;
  } catch {
    fromCache.add(id);
    return offline(request);
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener("fetch", (event) => {
  const { request, clientId, resultingClientId } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== location.origin) return;
  if (request.mode === "navigate") return event.respondWith(openPage(request, resultingClientId));
  event.respondWith(
    (async () => (fromCache.has(clientId) && (await cachedFor(request))) || fromNetwork(request).catch(() => offline(request)))(),
  );
});

// A reminder arrives with no text, so the server never holds any. The app leaves the wording where this can read it.
async function remind() {
  const saved = await (await caches.open("habit-tracker-settings")).match("notification");
  const { title, body } = (await saved?.json().catch(() => null)) ?? { title: "Habit Tracker", body: "Time for your habits." };
  return self.registration.showNotification(title, {
    body,
    icon: "icons/icon-192.png",
    tag: "habits",
  });
}

self.addEventListener("push", (event) => event.waitUntil(remind()));

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window" }).then((open) => (open[0] ? open[0].focus() : self.clients.openWindow("./"))));
});
