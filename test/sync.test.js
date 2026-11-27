import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveKey, seal, unseal, readEnvelope, newSalt, packJson } from "../src/crypto.js";
import { createStore } from "../src/store.js";
import worker from "../worker/src/index.js";
import { fakeD1 } from "../worker/test/fake-d1.js";
import { API } from "../src/server.js";

test("sealed data opens with the same passphrase and fails with another", async () => {
  const salt = newSalt();
  const bytes = await seal({ a: 1 }, await deriveKey("right horse", salt, 100_000), salt, 100_000);
  assert.ok(bytes instanceof Uint8Array);
  const envelope = readEnvelope(bytes);
  assert.deepEqual([envelope.v, envelope.iterations], [3, 100_000]);
  assert.deepEqual(envelope.salt, salt);
  assert.deepEqual(await unseal(envelope, await deriveKey("right horse", salt, 100_000)), { a: 1 });
  await assert.rejects(unseal(envelope, await deriveKey("wrong horse", salt, 100_000)), { name: "OperationError" });
  assert.throws(() => readEnvelope(new Uint8Array([9, 9, 9])), { code: "errFormat" });
});

test("files are compressed raw bytes, and the older JSON text formats still open", async () => {
  const salt = newSalt();
  const key = await deriveKey("right horse", salt, 100_000);
  const value = { log: Object.fromEntries(Array.from({ length: 365 }, (_, i) => [`2026-${i}`, { abcdefgh: 1 }])) };
  const bytes = await seal(value, key, salt, 100_000);
  assert.ok(bytes.length < JSON.stringify(value).length / 7);
  assert.deepEqual(await unseal(readEnvelope(bytes), key), value);

  const b64 = (data) => btoa(String.fromCharCode(...new Uint8Array(data)));
  const legacy = async (v, plain) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
    return new TextEncoder().encode(JSON.stringify({ v, kdf: "PBKDF2-SHA256", iterations: 100_000, salt: b64(salt), iv: b64(iv), data: b64(data) }));
  };
  assert.deepEqual(await unseal(readEnvelope(await legacy(1, new TextEncoder().encode('{"a":1}'))), key), { a: 1 });
  assert.deepEqual(await unseal(readEnvelope(await legacy(2, await packJson({ a: 2 }))), key), { a: 2 });
});

const habit = { id: "h", name: "Read", type: "check", target: 1, unit: "", start: "2026-11-01", archived: false };

// The real worker over an in-memory database, with sessions made directly instead of through Google.
async function fakeServer() {
  const env = { DB: fakeD1(), GOOGLE_CLIENT_ID: "test", ALLOWED_ORIGINS: "" };
  globalThis.fetch = (url, init) => worker.fetch(new Request(url, init), env);
  const sessionFor = async (sub) => {
    const token = `token-${sub}-${Math.random()}`;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    const hash = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
    env.DB.sql.prepare("INSERT OR IGNORE INTO users VALUES (?, ?, 0)").run(`user-${sub}`, sub);
    env.DB.sql.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(hash, `user-${sub}`, Date.now() + 86_400_000);
    return token;
  };
  return { env, sessionFor };
}

function accountDevice(session, { passphrase = "correct horse battery staple", sub = "g1" } = {}) {
  const statuses = [];
  let renders = 0;
  let passes = 0;
  const store = createStore({
    config: () => {
      passes++;
      return { mode: "account", target: `account:${sub}`, ready: true, session, passphrase };
    },
    onChange: () => renders++,
    onStatus: (state, err) => statuses.push(err?.code || (err ? `${state}: ${err.name}` : state)),
  });
  return { store, statuses, renders: () => renders, passes: () => passes };
}

test("two devices sync through the account server and merge each other's edits", async () => {
  const server = await fakeServer();
  assert.ok(API.startsWith("https://"));
  const a = accountDevice(await server.sessionFor("g1"));
  const b = accountDevice(await server.sessionFor("g1"));

  a.store.commit({ t: "habit", habit });
  a.store.commit({ t: "task", task: { id: "t", title: "Buy milk", kind: "buy", due: "", done: "", created: "2026-11-25" } });
  await a.store.sync();
  assert.equal(a.statuses.at(-1), "synced");
  const stored = server.env.DB.sql.prepare("SELECT version, envelope FROM vaults").get();
  assert.match(stored.version, /^[0-9a-f]{16}$/);
  const sealed = new TextDecoder().decode(stored.envelope);
  assert.ok(stored.envelope instanceof Uint8Array && !sealed.includes("Read") && !sealed.includes("milk"));

  await b.store.sync();
  assert.deepEqual(b.store.data().habits, [habit]);

  a.store.commit({ t: "log", date: "2026-11-24", id: "h", v: 1 });
  b.store.commit({ t: "habit", habit: { ...habit, name: "Read fiction" } });
  await a.store.sync();
  await b.store.sync();
  await a.store.sync();
  for (const d of [a, b]) {
    assert.equal(d.store.data().habits[0].name, "Read fiction");
    assert.deepEqual(Object.keys(d.store.data().log), ["2026-11-24"]);
    assert.equal(d.store.hasPending(), false);
  }

  const stranger = accountDevice(await server.sessionFor("g2"), { sub: "g2" });
  await stranger.store.sync();
  assert.deepEqual(stranger.store.data().habits, []);
});

test("an expired session reports signed out and keeps the edits for later", async () => {
  const server = await fakeServer();
  const a = accountDevice(await server.sessionFor("g1"));
  server.env.DB.sql.exec("DELETE FROM sessions");
  a.store.commit({ t: "habit", habit });
  await a.store.sync();
  assert.equal(a.statuses.at(-1), "errSignedOut");
  assert.equal(a.store.hasPending(), true);
});

// Holds the first request whose method matches until `release` is called.
function gate(method) {
  const real = globalThis.fetch;
  let release;
  const released = new Promise((resolve) => (release = resolve));
  let reached;
  const arrived = new Promise((resolve) => (reached = resolve));
  let used = false;
  globalThis.fetch = async (url, init = {}) => {
    if (!used && (init.method ?? "GET") === method) {
      used = true;
      reached();
      await released;
    }
    return real(url, init);
  };
  return { arrived, release, restore: () => (globalThis.fetch = real) };
}

test("signing out empties the device, and a sync already under way cannot bring the data back", async () => {
  const server = await fakeServer();
  const a = accountDevice(await server.sessionFor("g1"));
  a.store.commit({ t: "habit", habit });
  const held = gate("PUT");
  const inFlight = a.store.sync();
  await held.arrived;
  a.store.reset();
  held.release();
  await inFlight;
  held.restore();
  assert.deepEqual(a.store.data().habits, []);
  assert.equal(a.store.hasPending(), false);
});

test("an edit made while a save is on its way is pushed by the same sync call", async () => {
  const server = await fakeServer();
  const a = accountDevice(await server.sessionFor("g1"));
  a.store.commit({ t: "habit", habit });
  const held = gate("PUT");
  const first = a.store.sync();
  await held.arrived;
  a.store.commit({ t: "log", date: "2026-11-24", id: "h", v: 1 });
  const second = a.store.sync();
  held.release();
  await second;
  await first;
  held.restore();
  assert.equal(a.store.hasPending(), false);
  const b = accountDevice(await server.sessionFor("g1"));
  await b.store.sync();
  assert.deepEqual(Object.keys(b.store.data().log), ["2026-11-24"]);
});

test("turning sync off and back on does not bring back what another device deleted", async () => {
  const server = await fakeServer();
  const account = { mode: "account", target: "account:g1", ready: true, session: await server.sessionFor("g1"), passphrase: "pass words here" };
  let cfg = account;
  const a = createStore({ config: () => cfg, onChange: () => {}, onStatus: () => {} });
  a.commit({ t: "habit", habit });
  a.commit({ t: "log", date: "2026-11-23", id: "h", v: 1 });
  await a.sync();

  const b = accountDevice(await server.sessionFor("g1"), { passphrase: "pass words here" });
  await b.store.sync();
  b.store.commit({ t: "delHabit", id: "h" });
  await b.store.sync();

  cfg = { mode: "none" };
  await a.sync();
  cfg = account;
  await a.sync();
  assert.deepEqual(a.data().habits, []);
  assert.deepEqual(a.data().log, {});
});

test("data that came from one account never reaches another, even after a stop at no sync", async () => {
  const server = await fakeServer();
  const g1 = { mode: "account", target: "account:g1", ready: true, session: await server.sessionFor("g1"), passphrase: "pass words here" };
  const g2 = { mode: "account", target: "account:g2", ready: true, session: await server.sessionFor("g2"), passphrase: "pass words here" };
  let cfg = g1;
  const store = createStore({ config: () => cfg, onChange: () => {}, onStatus: () => {} });
  store.commit({ t: "habit", habit });
  await store.sync();
  cfg = { mode: "none" };
  await store.sync();
  cfg = g2;
  await store.sync();
  assert.deepEqual(store.data().habits, []);
  assert.equal(server.env.DB.sql.prepare("SELECT COUNT(*) AS n FROM vaults").get().n, 1);
});

test("a wrong passphrase reports an error and never overwrites the data", async () => {
  const server = await fakeServer();
  const a = accountDevice(await server.sessionFor("g1"));
  a.store.commit({ t: "habit", habit });
  await a.store.sync();
  const before = server.env.DB.sql.prepare("SELECT version FROM vaults").get().version;

  const intruder = accountDevice(await server.sessionFor("g1"), { passphrase: "a wrong guess" });
  intruder.store.commit({ t: "habit", habit: { ...habit, id: "x" } });
  await intruder.store.sync();
  assert.equal(intruder.statuses.at(-1), "error: OperationError");
  assert.equal(server.env.DB.sql.prepare("SELECT version FROM vaults").get().version, before);
});

test("a passphrase let through by a sync with nothing new is not taken as opening the data", async () => {
  const server = await fakeServer();
  const session = await server.sessionFor("g1");
  let passphrase = "correct horse battery staple";
  const statuses = [];
  const store = createStore({ config: () => ({ mode: "account", target: "account:g1", ready: true, session, passphrase }), onChange: () => {}, onStatus: (state) => statuses.push(state) });
  store.commit({ t: "habit", habit });
  await store.sync();
  assert.equal(await store.opens(), true);
  passphrase = "a wrong guess";
  await store.sync();
  assert.deepEqual([statuses.at(-1), await store.opens()], ["synced", false]);
});

test("a save refused because the data changed is retried on top of the newer data", async () => {
  const server = await fakeServer();
  const a = accountDevice(await server.sessionFor("g1"));
  const b = accountDevice(await server.sessionFor("g1"));
  a.store.commit({ t: "habit", habit });
  await a.store.sync();
  await b.store.sync();

  // B saves between A's last read and A's write.
  b.store.commit({ t: "log", date: "2026-11-23", id: "h", v: 1 });
  await b.store.sync();
  const real = globalThis.fetch;
  const puts = [];
  globalThis.fetch = async (url, init = {}) => {
    const res = await real(url, init);
    if (init.method === "PUT") puts.push(res.status);
    return res;
  };
  a.store.commit({ t: "log", date: "2026-11-24", id: "h", v: 1 });
  await a.store.sync();
  globalThis.fetch = real;
  assert.deepEqual(puts, [409, 204]);
  assert.equal(a.statuses.at(-1), "synced");
  assert.deepEqual(Object.keys(a.store.data().log).sort(), ["2026-11-23", "2026-11-24"]);
  await b.store.sync();
  assert.deepEqual(Object.keys(b.store.data().log).sort(), ["2026-11-23", "2026-11-24"]);
});

test("edits save on their own 30 seconds after the last one", async (t) => {
  const server = await fakeServer();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const a = accountDevice(await server.sessionFor("g1"));
  a.store.commit({ t: "habit", habit });
  t.mock.timers.tick(29_000);
  assert.equal(a.passes(), 0);
  t.mock.timers.tick(1_000);
  await a.store.sync();
  assert.equal(a.store.hasPending(), false);
  assert.equal(server.env.DB.sql.prepare("SELECT COUNT(*) AS n FROM vaults").get().n, 1);
});

test("another Google account signing in on the same device starts empty instead of receiving the data", async () => {
  const server = await fakeServer();
  let cfg = { mode: "account", target: "account:g1", ready: true, session: await server.sessionFor("g1"), passphrase: "pass words here" };
  const store = createStore({ config: () => cfg, onChange: () => {}, onStatus: () => {} });
  store.commit({ t: "habit", habit });
  await store.sync();

  // The first session expired, so its edit could not be pushed before someone else signed in.
  store.commit({ t: "habit", habit: { ...habit, name: "Private" } });
  cfg = { ...cfg, target: "account:g2", session: await server.sessionFor("g2") };
  await store.sync();
  assert.deepEqual(store.data().habits, []);
  assert.equal(store.hasPending(), false);
  assert.equal(server.env.DB.sql.prepare("SELECT COUNT(*) AS n FROM vaults").get().n, 1);
});

test("saving edits takes one request, and checking for news downloads nothing when there is none", async () => {
  const server = await fakeServer();
  const a = accountDevice(await server.sessionFor("g1"));
  const b = accountDevice(await server.sessionFor("g1"));
  a.store.commit({ t: "habit", habit });
  await a.store.sync();
  await b.store.sync();

  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const res = await real(url, init);
    seen.push(`${init.method ?? "GET"} ${res.status} ${res.headers.get("Content-Type") === "application/octet-stream" ? "data" : "-"}`);
    return res;
  };

  a.store.commit({ t: "log", date: "2026-11-24", id: "h", v: 1 });
  await a.store.sync();
  assert.deepEqual(seen.splice(0), ["PUT 204 -"]);
  const rendersBefore = a.renders();
  await a.store.sync();
  assert.deepEqual(seen.splice(0), ["GET 204 -"]);
  assert.equal(a.renders(), rendersBefore);

  // B's copy is behind: its write is refused with A's data, merged, and written again.
  b.store.commit({ t: "log", date: "2026-11-25", id: "h", v: 1 });
  await b.store.sync();
  assert.deepEqual(seen.splice(0), ["PUT 409 data", "PUT 204 -"]);
  assert.deepEqual(Object.keys(b.store.data().log), ["2026-11-24", "2026-11-25"]);
  globalThis.fetch = real;
});

test("coming back to the app checks the server only when the last check is a few minutes old or edits wait", async () => {
  const server = await fakeServer();
  const a = accountDevice(await server.sessionFor("g1"));
  await a.store.sync();
  const real = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (url, init) => (requests++, real(url, init));

  await a.store.refresh();
  assert.equal(requests, 0);
  await a.store.refresh(Date.now() + 121_000);
  assert.equal(requests, 1);
  a.store.commit({ t: "habit", habit });
  await a.store.refresh();
  assert.ok(requests > 1);
  assert.equal(a.store.hasPending(), false);
  globalThis.fetch = real;
});
