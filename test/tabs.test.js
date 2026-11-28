import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fakeIndexedDB, fakeStorage } from "./fake-idb.js";

const idb = fakeIndexedDB();
const localStorage = fakeStorage();
const listeners = [];
globalThis.indexedDB = idb;
globalThis.window = { localStorage, sessionStorage: fakeStorage() };
globalThis.document = { visibilityState: "visible" };
globalThis.addEventListener = (type, fn) => type === "storage" && listeners.push(fn);
const { createStore } = await import("../src/store.js");

const task = (id) => ({ t: "task", task: { id, title: id, done: "" } });
const ids = (store) => store.data().tasks.map((x) => x.id).sort();

beforeEach(() => {
  idb.data.clear();
  localStorage.map.clear();
  listeners.length = 0;
});

async function openTab(config = () => ({ mode: "none" })) {
  const statuses = [];
  const store = createStore({ config, onChange: () => {}, onStatus: (state) => statuses.push(state) });
  const hear = listeners.at(-1);
  await store.ready();
  return { store, statuses, hear };
}

// What the browser does to a tab in the background when another one saves.
function whileHidden(tab, key = "ht.pending.v1") {
  document.visibilityState = "hidden";
  tab.hear({ key });
  document.visibilityState = "visible";
}

test("a tab that was in the background keeps the edits another tab made when it makes its own", async () => {
  const a = await openTab();
  const b = await openTab();
  b.store.commit(task("b"));
  whileHidden(a);
  a.store.commit(task("a"));
  const fresh = await openTab();
  assert.deepEqual(ids(fresh.store), ["a", "b"]);
  await Promise.all([a.store.sync(), b.store.sync()]);
});

test("a tab that was in the background shows what another tab saved once it is back", async () => {
  const a = await openTab();
  await a.store.sync();
  const b = await openTab();
  b.store.commit(task("b"));
  await b.store.sync();
  whileHidden(a, "ht.changed");
  await a.store.refresh(0);
  assert.deepEqual(ids(a.store), ["b"]);
});

test("a sync that another tab's save interrupts runs again instead of staying unfinished", async () => {
  let saveElsewhere = null;
  const a = await openTab(() => {
    saveElsewhere?.();
    return { mode: "account", target: "account:g1", ready: true, session: "s", passphrase: "pass words here" };
  });
  let version = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method !== "PUT") return new Response("{}", { status: 404 });
    saveElsewhere?.();
    saveElsewhere = null;
    return new Response(null, { status: 204, headers: { "X-Version": String(++version) } });
  };
  a.store.commit(task("a"));
  let passes = 0;
  saveElsewhere = () => {
    if (++passes < 2) return;
    saveElsewhere = null;
    document.visibilityState = "hidden";
    a.hear({ key: "ht.changed" });
  };
  await a.store.sync();
  document.visibilityState = "visible";
  assert.notEqual(a.statuses.at(-1), "syncing");
  assert.equal(a.store.hasPending(), false);
});

test("a sync in a visible tab that another tab's save interrupts runs again too", async () => {
  const a = await openTab(() => ({ mode: "account", target: "account:g1", ready: true, session: "s", passphrase: "pass words here" }));
  let version = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method !== "PUT") return new Response("{}", { status: 404 });
    if (!version) a.hear({ key: "ht.changed" });
    return new Response(null, { status: 204, headers: { "X-Version": String(++version) } });
  };
  a.store.commit(task("a"));
  await a.store.sync();
  assert.equal(a.statuses.at(-1), "synced");
});

test("signing out in a tab that was in the background does not bring its data back", async () => {
  const a = await openTab();
  a.store.commit(task("a"));
  await a.store.sync();
  whileHidden(a, "ht.changed");
  a.store.reset();
  await a.store.sync();
  assert.deepEqual(ids(a.store), []);
});
