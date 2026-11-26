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
  Object.assign(idb.fail, { reads: false, writes: false });
  localStorage.map.clear();
  localStorage.quota.full = false;
});

async function fakeServer() {
  const env = { DB: fakeD1(), GOOGLE_CLIENT_ID: "test", ALLOWED_ORIGINS: "" };
  globalThis.fetch = (url, init) => worker.fetch(new Request(url, init), env);
  const token = "token-g1";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  env.DB.sql.prepare("INSERT INTO users VALUES ('u1', 'g1', 0)").run();
  env.DB.sql.prepare("INSERT INTO sessions VALUES (?, 'u1', ?)").run([...digest].map((b) => b.toString(16).padStart(2, "0")).join(""), Date.now() + 86_400_000);
  return { env, account: () => ({ mode: "account", target: "account:g1", ready: true, session: token, passphrase: "pass words here" }) };
}

test("without sync, edits are folded into a compressed copy in IndexedDB that survives a reload", async () => {
  const store = open();
  await store.ready();
  store.commit({ t: "habit", habit });
  store.commit({ t: "log", date: "2026-11-24", id: "h", v: 1 });
  await store.sync();
  assert.equal(store.hasPending(), false);

  const reloaded = open();
  await reloaded.ready();
  assert.deepEqual(reloaded.data().habits, [habit]);
  assert.deepEqual(reloaded.data().log, { "2026-11-24": { h: 1 } });
  assert.ok(idb.data.get("synced").base instanceof Uint8Array);
  assert.equal(localStorage.getItem("ht.pending.v1"), "[]");
});

test("a copy saved in localStorage by an earlier version moves to IndexedDB", async () => {
  localStorage.setItem("ht.cache.v1", JSON.stringify({ target: null, base: { habits: [habit], log: {}, goals: [], tasks: [] }, pending: [{ t: "log", date: "2026-11-24", id: "h", v: 1 }] }));
  const store = open();
  await store.ready();
  assert.deepEqual(store.data().habits, [habit]);
  assert.deepEqual(store.data().log, { "2026-11-24": { h: 1 } });
  await store.saved();
  assert.equal(localStorage.getItem("ht.cache.v1"), null);
  assert.ok(idb.data.has("synced"));
});

test("data kept on the device merges into an account that already has data", async () => {
  const { account } = await fakeServer();

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
  await store.saved();
  assert.equal(idb.data.has("synced"), false);
  assert.equal(localStorage.getItem("ht.pending.v1"), null);
  const reloaded = open();
  await reloaded.ready();
  assert.deepEqual(reloaded.data().habits, []);
});

test("when IndexedDB refuses a save the copy goes to localStorage, and nothing folded is lost", async () => {
  idb.fail.writes = true;
  const store = open();
  await store.ready();
  store.commit({ t: "habit", habit });
  await store.sync();
  assert.equal(store.hasPending(), false);
  const reloaded = open();
  await reloaded.ready();
  assert.deepEqual(reloaded.data().habits, [habit]);
});

test("when no storage takes the copy, the edits stay in the list", async () => {
  idb.fail.writes = true;
  const store = open();
  await store.ready();
  store.commit({ t: "habit", habit });
  localStorage.quota.full = true;
  await store.sync();
  assert.equal(store.hasPending(), true);
});

test("a copy IndexedDB cannot read is left alone instead of overwritten", async () => {
  const first = open();
  await first.ready();
  first.commit({ t: "habit", habit });
  await first.sync();
  const saved = idb.data.get("synced");

  idb.fail.reads = true;
  const second = open();
  await second.ready();
  second.commit({ t: "habit", habit: other });
  await second.sync();
  assert.equal(idb.data.get("synced"), saved);
});

test("a copy saved before targets were recorded is replaced by the server's, not merged into it", async () => {
  const { env, account } = await fakeServer();
  const elsewhere = open(account);
  elsewhere.commit({ t: "habit", habit: other });
  await elsewhere.sync();
  const version = env.DB.sql.prepare("SELECT version FROM vaults").get().version;
  idb.data.clear();
  localStorage.map.clear();

  // An old device that last synced when the deleted habit `h` still existed.
  localStorage.setItem("ht.cache.v1", JSON.stringify({ sha: version, envelope: null, base: { habits: [habit], log: {}, goals: [], tasks: [] }, pending: [] }));
  const store = open(account);
  await store.sync();
  assert.deepEqual(store.data().habits.map((h) => h.id), ["o"]);
});

test("a tab picks up what another tab saved when it reloads", async () => {
  const a = open();
  const b = open();
  await Promise.all([a.ready(), b.ready()]);
  a.commit({ t: "habit", habit });
  await b.reload();
  b.commit({ t: "habit", habit: other });
  const later = open();
  await later.ready();
  assert.deepEqual(later.data().habits.map((h) => h.id), ["h", "o"]);
});

test("edits an old tab keeps in the pre-IndexedDB copy are picked up", async () => {
  localStorage.setItem("ht.pending.v1", JSON.stringify([{ t: "habit", habit }]));
  localStorage.setItem("ht.cache.v1", JSON.stringify({ target: null, base: { habits: [], log: {}, goals: [], tasks: [] }, pending: [{ t: "habit", habit: other }] }));
  const store = open();
  await store.ready();
  assert.deepEqual(store.data().habits.map((h) => h.id), ["h", "o"]);
});
