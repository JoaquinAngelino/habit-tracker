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

// An in-memory stand-in for the parts of the GitHub REST API the store uses.
// With `lag`, reads keep returning the version a write replaced for that many milliseconds.
function fakeGitHub({ lag = 0 } = {}) {
  const repo = { files: new Map(), old: new Map(), branches: new Set(["main"]), writes: 0 };
  globalThis.fetch = async (url, { method = "GET", body } = {}) => {
    const { pathname, searchParams } = new URL(url);
    const reply = (status, json) => ({ ok: status < 300, status, statusText: "", json: async () => json });
    const file = pathname.match(/^\/repos\/me\/habits\/contents\/(.+)$/);
    if (file && method === "GET") {
      const key = `${searchParams.get("ref")}:${decodeURIComponent(file[1])}`;
      const f = repo.old.has(key) && Date.now() - repo.old.get(key).at < lag ? repo.old.get(key).file : repo.files.get(key);
      return f ? reply(200, { sha: f.sha, content: btoa(f.text) }) : reply(404, { message: "Not Found" });
    }
    if (file && method === "PUT") {
      const b = JSON.parse(body);
      if (!repo.branches.has(b.branch)) return reply(404, { message: "Branch not found" });
      const key = `${b.branch}:${decodeURIComponent(file[1])}`;
      const current = repo.files.get(key);
      if (current?.sha !== b.sha) return reply(409, { message: "sha mismatch" });
      const sha = `sha${++repo.writes}`;
      repo.old.set(key, { file: current ?? null, at: Date.now() });
      repo.files.set(key, { sha, text: atob(b.content) });
      return reply(200, { content: { sha } });
    }
    const branch = pathname.match(/^\/repos\/me\/habits\/branches\/(.+)$/);
    if (branch) return repo.branches.has(branch[1]) ? reply(200, {}) : reply(404, {});
    if (pathname === "/repos/me/habits") return reply(200, { default_branch: "main" });
    if (pathname === "/repos/me/habits/git/ref/heads/main") return reply(200, { object: { sha: "c0" } });
    if (pathname === "/repos/me/habits/git/refs" && method === "POST") {
      repo.branches.add(JSON.parse(body).ref.replace("refs/heads/", ""));
      return reply(201, {});
    }
    return reply(404, { message: `unexpected ${method} ${pathname}` });
  };
  return repo;
}

function device(passphrase = "correct horse battery staple") {
  const statuses = [];
  const store = createStore({
    config: () => ({ mode: "github", target: "github:me/habits@data", ready: true, repo: "me/habits", branch: "data", token: "t", passphrase }),
    onChange: () => {},
    onStatus: (state, err) => statuses.push(err ? `${state}: ${err.code || err.name}` : state),
  });
  return { store, statuses };
}

const habit = { id: "h", name: "Read", type: "check", target: 1, unit: "", start: "2026-11-01", archived: false };

test("two devices sync through the encrypted file and keep each other's edits", async () => {
  const repo = fakeGitHub();
  const a = device();
  const b = device();

  a.store.commit({ t: "habit", habit });
  a.store.commit({ t: "log", date: "2026-11-23", id: "h", v: 1 });
  await a.store.sync();
  assert.equal(a.statuses.at(-1), "synced");
  assert.ok(repo.branches.has("data"));
  const stored = repo.files.get("data:data/habits.enc").text;
  assert.ok(!stored.includes("Read"));

  await b.store.sync();
  assert.deepEqual(b.store.data().habits, [habit]);

  // Both edit before either syncs: the second sync replays its edit on top of the first.
  a.store.commit({ t: "log", date: "2026-11-24", id: "h", v: 1 });
  b.store.commit({ t: "habit", habit: { ...habit, name: "Read fiction" } });
  await a.store.sync();
  await b.store.sync();
  await a.store.sync();
  for (const d of [a, b]) {
    assert.equal(d.store.data().habits[0].name, "Read fiction");
    assert.deepEqual(Object.keys(d.store.data().log), ["2026-11-23", "2026-11-24"]);
    assert.equal(d.store.hasPending(), false);
  }
});

test("a wrong passphrase reports an error and never overwrites the file", async () => {
  const repo = fakeGitHub();
  const a = device();
  a.store.commit({ t: "habit", habit });
  await a.store.sync();
  const before = repo.files.get("data:data/habits.enc");

  const intruder = device("guess");
  intruder.store.commit({ t: "habit", habit: { ...habit, id: "x" } });
  await intruder.store.sync();
  assert.equal(intruder.statuses.at(-1), "error: OperationError");
  assert.equal(repo.files.get("data:data/habits.enc"), before);
});

test("edits survive GitHub serving the previous version right after a save", async () => {
  const repo = fakeGitHub({ lag: 5000 });
  const a = device();
  a.store.commit({ t: "habit", habit });
  await a.store.sync();
  for (const date of ["2026-11-22", "2026-11-23", "2026-11-24"]) {
    a.store.commit({ t: "log", date, id: "h", v: 1 });
    await a.store.sync();
    assert.ok(a.store.data().log[date], `${date} kept after its own save`);
  }
  assert.deepEqual(Object.keys(a.store.data().log), ["2026-11-22", "2026-11-23", "2026-11-24"]);
  assert.equal(a.statuses.at(-1), "synced");

  repo.old.clear();
  const b = device();
  await b.store.sync();
  assert.deepEqual(Object.keys(b.store.data().log), ["2026-11-22", "2026-11-23", "2026-11-24"]);
});

// The real worker over an in-memory database, with sessions made directly instead of through Google.
async function fakeServer() {
  const env = { DB: fakeD1(), GOOGLE_CLIENT_ID: "test", ALLOWED_ORIGINS: "" };
  globalThis.fetch = (url, init) => worker.fetch(new Request(url, init), env);
  const sessionFor = async (sub) => {
    const token = `token-${sub}-${Math.random()}`;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    const hash = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
    env.DB.sql.prepare("INSERT OR IGNORE INTO users VALUES (?, ?, 0)").run(`user-${sub}`, sub);
    env.DB.sql.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(hash, `user-${sub}`, Date.now() + 86_400_000);
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

test("switching from GitHub to a new account uploads what the device already has", async () => {
  fakeGitHub();
  let cfg = { mode: "github", target: "github:me/habits@data", ready: true, repo: "me/habits", branch: "data", token: "t", passphrase: "pass words here" };
  const store = createStore({ config: () => cfg, onChange: () => {}, onStatus: () => {} });
  store.commit({ t: "habit", habit });
  await store.sync();
  assert.equal(store.hasPending(), false);

  const server = await fakeServer();
  cfg = { mode: "account", target: "account:g1", ready: true, session: await server.sessionFor("g1"), passphrase: "pass words here" };
  await store.sync();
  assert.ok(server.env.DB.sql.prepare("SELECT version FROM vaults").get());
  const other = accountDevice(await server.sessionFor("g1"), { passphrase: "pass words here" });
  await other.store.sync();
  assert.deepEqual(other.store.data().habits, [habit]);
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

test("data that came from one account never reaches another, even after a stop at no sync or a repository", async () => {
  const server = await fakeServer();
  const repo = { mode: "github", target: "github:me/habits@data", ready: true, repo: "me/habits", branch: "data", token: "t", passphrase: "pass words here" };
  const g1 = { mode: "account", target: "account:g1", ready: true, session: await server.sessionFor("g1"), passphrase: "pass words here" };
  const g2 = { mode: "account", target: "account:g2", ready: true, session: await server.sessionFor("g2"), passphrase: "pass words here" };
  for (const detour of [{ mode: "none" }, repo]) {
    server.env.DB.sql.exec("DELETE FROM vaults");
    let cfg = g1;
    const store = createStore({ config: () => cfg, onChange: () => {}, onStatus: () => {} });
    store.commit({ t: "habit", habit });
    await store.sync();
    cfg = detour;
    if (detour === repo) {
      const toServer = globalThis.fetch;
      fakeGitHub();
      await store.sync();
      globalThis.fetch = toServer;
    } else await store.sync();
    cfg = g2;
    await store.sync();
    assert.deepEqual(store.data().habits, [], detour.mode);
    assert.equal(server.env.DB.sql.prepare("SELECT COUNT(*) AS n FROM vaults").get().n, 1, detour.mode);
  }
});

test("a GitHub save refused because the file changed is retried on top of the new file", async () => {
  const repo = fakeGitHub();
  const a = device();
  const b = device();
  a.store.commit({ t: "habit", habit });
  await a.store.sync();
  await b.store.sync();

  // B saves between A's read and A's write.
  const real = globalThis.fetch;
  let raced = false;
  globalThis.fetch = async (url, init = {}) => {
    if (!raced && init.method === "PUT") {
      raced = true;
      b.store.commit({ t: "log", date: "2026-11-23", id: "h", v: 1 });
      await b.store.sync();
    }
    return real(url, init);
  };
  a.store.commit({ t: "log", date: "2026-11-24", id: "h", v: 1 });
  await a.store.sync();
  globalThis.fetch = real;
  assert.equal(a.statuses.at(-1), "synced");
  assert.deepEqual(Object.keys(a.store.data().log).sort(), ["2026-11-23", "2026-11-24"]);
  assert.equal(repo.writes, 3);
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
