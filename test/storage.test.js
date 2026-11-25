import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fakeIndexedDB, fakeStorage } from "./fake-idb.js";
import worker from "../worker/src/index.js";
import { fakeD1 } from "../worker/test/fake-d1.js";

const idb = fakeIndexedDB();
const localStorage = fakeStorage();
globalThis.indexedDB = idb;
globalThis.window = { localStorage, sessionStorage: fakeStorage() };
const { createStore } = await import("../src/store.js");

const habit = { id: "h", name: "Read", type: "check", target: 1, unit: "", start: "2026-11-01", archived: false };
const other = { id: "o", name: "Run", type: "check", target: 1, unit: "", start: "2026-11-01", archived: false };
const none = () => ({ mode: "none" });
const open = (config = none) => createStore({ config, onChange: () => {}, onStatus: () => {} });

beforeEach(() => {
  idb.data.clear();
  localStorage.map.clear();
});

test("without sync, edits are folded into a compressed copy in IndexedDB that survives a reload", async () => {
  const store = open();
  await store.ready;
  store.commit({ t: "habit", habit });
  store.commit({ t: "log", date: "2026-11-24", id: "h", v: 1 });
  await store.sync();
  assert.equal(store.hasPending(), false);

  const reloaded = open();
  await reloaded.ready;
  assert.deepEqual(reloaded.data().habits, [habit]);
  assert.deepEqual(reloaded.data().log, { "2026-11-24": { h: 1 } });
  assert.ok(idb.data.get("synced").base instanceof Uint8Array);
  assert.equal(localStorage.getItem("ht.pending.v1"), "[]");
});

test("a copy saved in localStorage by an earlier version moves to IndexedDB", async () => {
  localStorage.setItem("ht.cache.v1", JSON.stringify({ target: null, base: { habits: [habit], log: {}, goals: [], tasks: [] }, pending: [{ t: "log", date: "2026-11-24", id: "h", v: 1 }] }));
  const store = open();
  await store.ready;
  assert.deepEqual(store.data().habits, [habit]);
  assert.deepEqual(store.data().log, { "2026-11-24": { h: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(localStorage.getItem("ht.cache.v1"), null);
  assert.ok(idb.data.has("synced"));
});

test("data kept on the device merges into an account that already has data", async () => {
  const env = { DB: fakeD1(), GOOGLE_CLIENT_ID: "test", ALLOWED_ORIGINS: "" };
  globalThis.fetch = (url, init) => worker.fetch(new Request(url, init), env);
  const token = "token-g1";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  env.DB.sql.prepare("INSERT INTO users VALUES ('u1', 'g1', 0)").run();
  env.DB.sql.prepare("INSERT INTO sessions VALUES (?, 'u1', ?)").run([...digest].map((b) => b.toString(16).padStart(2, "0")).join(""), Date.now() + 86_400_000);
  const account = () => ({ mode: "account", target: "account:g1", ready: true, session: token, passphrase: "pass words here" });

  const elsewhere = open(account);
  elsewhere.commit({ t: "habit", habit: other });
  await elsewhere.sync();
  idb.data.clear();
  localStorage.map.clear();

  let config = none;
  const store = open(() => config());
  store.commit({ t: "habit", habit });
  await store.sync();
  config = account;
  await store.sync();
  assert.deepEqual(store.data().habits.map((h) => h.id).sort(), ["h", "o"]);
});

test("signing out removes the device copy from IndexedDB and localStorage", async () => {
  const store = open();
  store.commit({ t: "habit", habit });
  await store.sync();
  store.reset();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(idb.data.has("synced"), false);
  assert.equal(localStorage.getItem("ht.pending.v1"), null);
  const reloaded = open();
  await reloaded.ready;
  assert.deepEqual(reloaded.data().habits, []);
});
