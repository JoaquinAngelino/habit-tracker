import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { fakeD1 } from "./fake-d1.js";

const CLIENT_ID = "client-123.apps.googleusercontent.com";
const ORIGIN = "https://joaquinangelino.github.io";

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const google = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const stranger = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", google.publicKey)), kid: "k1", alg: "RS256", use: "sig" };

globalThis.fetch = async (url) => {
  assert.equal(url, "https://www.googleapis.com/oauth2/v3/certs");
  return Response.json({ keys: [publicJwk] }, { headers: { "Cache-Control": "public, max-age=3600" } });
};

async function idToken(claims = {}, key = google.privateKey) {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "google-user-1",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

let env;
beforeEach(() => {
  env = { DB: fakeD1(), GOOGLE_CLIENT_ID: CLIENT_ID, ALLOWED_ORIGINS: `${ORIGIN},http://localhost:8765` };
});

async function call(method, path, { token, body, bytes, origin = ORIGIN, headers: extra = {} } = {}) {
  const headers = { Origin: origin, ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (bytes !== undefined) headers["Content-Type"] = "application/octet-stream";
  const payload = body === undefined ? bytes : JSON.stringify(body);
  const res = await worker.fetch(new Request(`https://api.test${path}`, { method, headers, body: payload }), env);
  const version = res.headers.get("X-Version");
  if (res.headers.get("Content-Type") === "application/octet-stream") {
    return { status: res.status, headers: res.headers, version, data: new TextDecoder().decode(await res.arrayBuffer()) };
  }
  const text = await res.text();
  return { status: res.status, headers: res.headers, version, body: text ? JSON.parse(text) : null };
}

const enc = (s) => new TextEncoder().encode(s);
const put = (token, version, data) => call("PUT", "/vault", { token, bytes: enc(data), headers: { "X-Version": String(version) } });
const get = (token, have) => call("GET", "/vault", { token, headers: have ? { "X-Have": have } : {} });

async function signIn(claims) {
  const res = await call("POST", "/session", { body: { credential: await idToken(claims) } });
  assert.equal(res.status, 200);
  return res.body.token;
}

test("a signed-in user saves and reads their encrypted data with version checks", async () => {
  const token = await signIn();
  assert.equal((await call("GET", "/vault", { token })).status, 404);

  const v1 = (await put(token, 0, "one")).version;
  assert.match(v1, /^[0-9a-f]{16}$/);
  const first = await get(token);
  assert.deepEqual([first.version, first.data], [v1, "one"]);
  assert.equal(env.DB.sql.prepare("SELECT typeof(envelope) AS t FROM vaults").get().t, "blob");

  // Another device that read nothing, or an older version, is refused instead of overwriting.
  assert.equal((await put(token, 0, "stale")).status, 409);
  const v2 = (await put(token, v1, "two")).version;
  assert.notEqual(v2, v1);
  assert.equal((await put(token, v1, "stale")).status, 409);
  assert.equal((await get(token)).data, "two");
});

test("signing in twice with the same Google account reaches the same data", async () => {
  const first = await signIn();
  await put(first, 0, "mine");
  const second = await signIn();
  assert.notEqual(first, second);
  assert.equal((await call("GET", "/vault", { token: second })).data, "mine");

  const other = await signIn({ sub: "google-user-2" });
  assert.equal((await call("GET", "/vault", { token: other })).status, 404);
});

test("forged, foreign, expired and malformed sign-ins are rejected", async () => {
  const cases = [
    await idToken({}, stranger.privateKey),
    await idToken({ aud: "someone-else.apps.googleusercontent.com" }),
    await idToken({ iss: "https://evil.example" }),
    await idToken({ exp: Math.floor(Date.now() / 1000) - 3600 }),
    "not.a.token",
    `${(await idToken()).split(".").slice(0, 2).join(".")}.%%%`,
    "",
  ];
  for (const credential of cases) assert.equal((await call("POST", "/session", { body: { credential } })).status, 401);
  assert.equal(env.DB.sql.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);
});

test("requests need a live session", async () => {
  assert.equal((await call("GET", "/vault")).status, 401);
  assert.equal((await call("GET", "/vault", { token: "made-up" })).status, 401);

  const token = await signIn();
  assert.equal((await call("DELETE", "/session", { token })).status, 204);
  assert.equal((await call("GET", "/vault", { token })).status, 401);

  const expired = await signIn();
  env.DB.sql.exec("UPDATE sessions SET expires_at = 0");
  assert.equal((await call("GET", "/vault", { token: expired })).status, 401);
});

test("an active session is extended, at most once every few days", async () => {
  const token = await signIn();
  const expiry = () => env.DB.sql.prepare("SELECT expires_at FROM sessions").get().expires_at;
  const fresh = expiry();
  await call("GET", "/vault", { token });
  assert.equal(expiry(), fresh);

  env.DB.sql.exec(`UPDATE sessions SET expires_at = ${Date.now() + 30 * 86_400_000}`);
  await call("GET", "/vault", { token });
  assert.ok(expiry() >= fresh);
});

test("deleting the account removes the user, sessions and data", async () => {
  const token = await signIn();
  await put(token, 0, "bye");
  assert.equal((await call("DELETE", "/account", { token })).status, 204);
  for (const table of ["users", "sessions", "vaults"]) assert.equal(env.DB.sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  assert.equal((await call("GET", "/vault", { token })).status, 401);
});

test("bad writes are refused", async () => {
  const token = await signIn();
  assert.equal((await put(token, "not a version", "data")).status, 400);
  assert.equal((await call("PUT", "/vault", { token, bytes: enc("data") })).status, 400);
  assert.equal((await put(token, 0, "")).status, 400);
  assert.equal((await put(token, 0, "x".repeat(1_000_001))).status, 413);
  assert.equal((await call("POST", "/vault", { token })).status, 404);
});

test("only the app's own origins get CORS headers", async () => {
  const preflight = await worker.fetch(new Request("https://api.test/vault", { method: "OPTIONS", headers: { Origin: ORIGIN } }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.match(preflight.headers.get("Access-Control-Allow-Headers"), /Authorization/);
  assert.equal(preflight.headers.get("Access-Control-Expose-Headers"), "X-Version");

  const local = await call("GET", "/vault", { origin: "http://localhost:8765" });
  assert.equal(local.headers.get("Access-Control-Allow-Origin"), "http://localhost:8765");
  const other = await call("GET", "/vault", { origin: "https://evil.example" });
  assert.equal(other.headers.get("Access-Control-Allow-Origin"), null);
});

test("sign-in is refused until a Google client ID is configured", async () => {
  env.GOOGLE_CLIENT_ID = "";
  assert.equal((await call("POST", "/session", { body: { credential: await idToken() } })).status, 503);
});

test("a client that already has the current version gets no data back, and a conflict returns the newer data", async () => {
  const token = await signIn();
  const v1 = (await put(token, 0, "one")).version;
  const same = await get(token, v1);
  assert.deepEqual([same.status, same.version, same.body], [204, v1, null]);
  const v2 = (await put(token, v1, "two")).version;
  const newer = await get(token, v1);
  assert.deepEqual([newer.status, newer.version, newer.data], [200, v2, "two"]);

  const conflict = await put(token, v1, "stale");
  assert.deepEqual([conflict.status, conflict.version, conflict.data], [409, v2, "two"]);
  // Clients from before headers sent the version in the query string.
  assert.equal((await call("GET", `/vault?have=${v2}`, { token })).status, 204);
});

test("a recreated vault never matches a version a device still holds", async () => {
  const token = await signIn();
  const old = (await put(token, 0, "before")).version;
  await call("DELETE", "/account", { token });
  const again = await signIn();
  await put(again, 0, "after");
  assert.equal((await get(again, old)).data, "after");
  assert.equal((await put(again, old, "stale")).status, 409);
});

test("a vault stored as text by an older worker is served as its bytes", async () => {
  const token = await signIn();
  await put(token, 0, "x");
  env.DB.sql.exec(`UPDATE vaults SET envelope = '{"v":2}'`);
  assert.equal((await get(token)).data, '{"v":2}');
});

test("each account keeps at most 20 sessions", async () => {
  for (let i = 0; i < 25; i++) await signIn();
  assert.equal(env.DB.sql.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 20);
});

test("unknown key ids refetch Google's keys at most once a minute", async () => {
  let fetches = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => (fetches++, real(url));
  await signIn();
  const before = fetches;
  const header = b64url(JSON.stringify({ alg: "RS256", kid: "unknown", typ: "JWT" }));
  for (let i = 0; i < 5; i++) await call("POST", "/session", { body: { credential: `${header}.e30.x` } });
  assert.ok(fetches - before <= 1);
  globalThis.fetch = real;
});
