import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const ORIGIN = "https://app.test";

// The worker run against a cache in memory, with its timers fired at once. `network` answers its requests.
function load(network, cached = {}) {
  const handlers = {};
  const store = new Map(Object.entries(cached));
  const key = (request) => (typeof request === "string" ? request : new URL(request.url).pathname);
  const caches = {
    open: async () => ({ put: async (request, response) => void store.set(key(request), await response.text()) }),
    match: async (request) => (store.has(key(request)) ? new Response(store.get(key(request))) : undefined),
  };
  vm.runInNewContext(source, {
    self: { addEventListener: (type, fn) => (handlers[type] = fn) },
    location: new URL(ORIGIN),
    caches,
    fetch: network,
    setTimeout: (fn) => setImmediate(fn),
    clearTimeout: clearImmediate,
    URL,
    Response,
    Set,
  });
  const get = (path, ids) => {
    let answer;
    handlers.fetch({ request: { url: ORIGIN + path, method: "GET", mode: ids.resultingClientId ? "navigate" : "cors" }, ...ids, respondWith: (p) => (answer = p), waitUntil() {} });
    return answer.then((res) => res.text());
  };
  return { get };
}

const hangs = () => new Promise(() => {});
const later = (text) => () => new Promise((resolve) => setTimeout(() => resolve(new Response(text)), 20));
const within = (promise) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("still waiting")), 500))]);

test("a page whose network stalls opens from the cache, and so do its files", async () => {
  const sw = load(hangs, { "/": "cached page", "/src/app.js": "cached app" });
  assert.equal(await within(sw.get("/", { resultingClientId: "c1", clientId: "" })), "cached page");
  assert.equal(await within(sw.get("/src/app.js", { clientId: "c1" })), "cached app");
});

test("a page that loaded from the network takes its files from the network, however slow", async () => {
  const sw = load(async (request) => (request.mode === "navigate" ? new Response("new page") : later("new app")()), { "/": "old", "/src/app.js": "old app" });
  assert.equal(await sw.get("/", { resultingClientId: "c1", clientId: "" }), "new page");
  assert.equal(await sw.get("/src/app.js", { clientId: "c1" }), "new app");
});

test("a slow network is waited for when nothing is cached", async () => {
  const sw = load(later("first visit"));
  assert.equal(await sw.get("/", { resultingClientId: "c1", clientId: "" }), "first visit");
});

test("every source file is kept for offline use", () => {
  for (const name of readdirSync(new URL("../src/", import.meta.url))) assert.ok(source.includes(`"src/${name}"`), name);
});
