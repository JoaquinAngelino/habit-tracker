import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveKey, seal, unseal, readEnvelope, newSalt } from "../src/crypto.js";
import { createStore } from "../src/store.js";

test("sealed data opens with the same passphrase and fails with another", async () => {
  const salt = newSalt();
  const text = await seal({ a: 1 }, await deriveKey("right horse", salt, 1000), salt, 1000);
  const envelope = readEnvelope(text);
  assert.ok(!text.includes('"a"'));
  assert.deepEqual(await unseal(envelope, await deriveKey("right horse", salt, 1000)), { a: 1 });
  await assert.rejects(unseal(envelope, await deriveKey("wrong horse", salt, 1000)), { name: "OperationError" });
});

// An in-memory stand-in for the parts of the GitHub REST API the store uses.
function fakeGitHub() {
  const repo = { files: new Map(), branches: new Set(["main"]), writes: 0 };
  globalThis.fetch = async (url, { method = "GET", body } = {}) => {
    const { pathname, searchParams } = new URL(url);
    const reply = (status, json) => ({ ok: status < 300, status, statusText: "", json: async () => json });
    const file = pathname.match(/^\/repos\/me\/habits\/contents\/(.+)$/);
    if (file && method === "GET") {
      const key = `${searchParams.get("ref")}:${decodeURIComponent(file[1])}`;
      const f = repo.files.get(key);
      return f ? reply(200, { sha: f.sha, content: btoa(f.text) }) : reply(404, { message: "Not Found" });
    }
    if (file && method === "PUT") {
      const b = JSON.parse(body);
      if (!repo.branches.has(b.branch)) return reply(404, { message: "Branch not found" });
      const key = `${b.branch}:${decodeURIComponent(file[1])}`;
      const current = repo.files.get(key);
      if (current?.sha !== b.sha) return reply(409, { message: "sha mismatch" });
      const sha = `sha${++repo.writes}`;
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
    config: () => ({ repo: "me/habits", branch: "data", path: "data/habits.enc", token: "t", passphrase }),
    onChange: () => {},
    onStatus: (state, message) => statuses.push(message ? `${state}: ${message}` : state),
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
  assert.match(intruder.statuses.at(-1), /^error: Wrong passphrase/);
  assert.equal(repo.files.get("data:data/habits.enc"), before);
});
