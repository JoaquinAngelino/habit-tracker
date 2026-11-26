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

// A stand-in authenticator: a P-256 key that signs what a browser would.
const HOST_HASH = async (origin) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc(new URL(origin).hostname)));

async function newPasskey(id = "credential-0123456789") {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { id, pair, publicKey: b64url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))) };
}

const challenge = async () => (await call("POST", "/passkey/challenge")).body.challenge;
const clientJson = (type, value, origin = ORIGIN) => b64url(JSON.stringify({ type, challenge: value, origin }));

function der(raw) {
  const int = (bytes) => {
    let b = [...bytes];
    while (b.length > 1 && b[0] === 0) b.shift();
    if (b[0] & 0x80) b = [0, ...b];
    return [2, b.length, ...b];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

// Flags 5: a person was present and verified. Passkeys that sync report a use count of 0.
async function assertion(passkey, { origin = ORIGIN, flags = 5, count = 0, value } = {}) {
  const clientDataJSON = clientJson("webauthn.get", value ?? (await challenge()), origin);
  const authenticatorData = new Uint8Array([...(await HOST_HASH(origin)), flags, 0, 0, 0, count]);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", Buffer.from(clientDataJSON, "base64url")));
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, passkey.pair.privateKey, new Uint8Array([...authenticatorData, ...hash])));
  return { credentialId: passkey.id, authenticatorData: b64url(authenticatorData), clientDataJSON, signature: b64url(der(raw)) };
}

const register = async (passkey, token) =>
  call("POST", "/passkey/register", { token, body: { credentialId: passkey.id, publicKey: passkey.publicKey, clientDataJSON: clientJson("webauthn.create", await challenge()) } });

test("a passkey makes an account and signs back in to it", async () => {
  const passkey = await newPasskey();
  const made = await register(passkey);
  assert.equal(made.status, 200);
  await put(made.body.token, 0, "mine");
  const back = await call("POST", "/passkey/session", { body: await assertion(passkey) });
  assert.deepEqual([back.status, back.body.userId], [200, made.body.userId]);
  assert.equal((await get(back.body.token)).data, "mine");
  assert.equal((await register(passkey)).status, 409);
});

test("a passkey added while signed in opens that same account", async () => {
  const token = await signIn();
  await put(token, 0, "google data");
  const elsewhere = await signIn();
  const passkey = await newPasskey();
  const added = await register(passkey, token);
  assert.deepEqual([added.status, added.body.token], [200, undefined]);
  // Adding a way in ends the account's other sessions.
  assert.equal((await get(elsewhere)).status, 401);
  const back = await call("POST", "/passkey/session", { body: await assertion(passkey) });
  // Both ways in name the account the same, so a device does not take it for someone else's.
  const google = await call("POST", "/session", { body: { credential: await idToken() } });
  assert.equal(back.body.userId, google.body.userId);
  assert.equal((await get(back.body.token)).data, "google data");
  assert.equal(env.DB.sql.prepare("SELECT COUNT(*) AS n FROM users").get().n, 1);
  assert.equal((await call("GET", "/passkeys", { token: back.body.token })).body.count, 1);
  env.DB.sql.prepare("UPDATE sessions SET created_at = ?").run(Date.now() - 11 * 60_000);
  assert.equal((await call("DELETE", "/passkeys", { token: back.body.token })).status, 403);
  assert.equal((await call("GET", "/passkeys", { token: back.body.token })).body.count, 1);
  env.DB.sql.prepare("UPDATE sessions SET created_at = ?").run(Date.now());
  assert.equal((await call("DELETE", "/passkeys", { token: back.body.token })).status, 204);
  assert.equal((await call("POST", "/passkey/session", { body: await assertion(passkey) })).status, 401);
});

test("a session that is not fresh cannot add a passkey, and a passkey-only account keeps its passkey", async () => {
  const token = await signIn();
  env.DB.sql.prepare("UPDATE sessions SET created_at = ?").run(Date.now() - 11 * 60_000);
  assert.equal((await register(await newPasskey(), token)).status, 403);
  assert.equal(env.DB.sql.prepare("SELECT COUNT(*) AS n FROM passkeys").get().n, 0);
  const made = await register(await newPasskey("credential-only-000000"));
  assert.equal((await call("DELETE", "/passkeys", { token: made.body.token })).status, 409);
});

test("passkey sign-in refuses a reused challenge, another site, a missing person, a wrong key and an unknown credential", async () => {
  const passkey = await newPasskey();
  await register(passkey);
  const once = await assertion(passkey);
  assert.equal((await call("POST", "/passkey/session", { body: once })).status, 200);
  assert.equal((await call("POST", "/passkey/session", { body: once })).status, 401);
  assert.equal((await call("POST", "/passkey/session", { body: await assertion(passkey, { origin: "https://evil.example" }) })).status, 401);
  assert.equal((await call("POST", "/passkey/session", { body: await assertion(passkey, { flags: 0 }) })).status, 401);
  assert.equal((await call("POST", "/passkey/session", { body: await assertion(passkey, { flags: 1 }) })).status, 401);
  assert.equal((await call("POST", "/passkey/session", { body: await assertion(passkey, { value: "made-up" }) })).status, 401);
  const other = await newPasskey();
  assert.equal((await call("POST", "/passkey/session", { body: await assertion({ ...passkey, pair: other.pair }) })).status, 401);
  assert.equal((await call("POST", "/passkey/session", { body: await assertion({ ...other, id: "credential-unknown-000" }) })).status, 401);
  env.DB.sql.prepare("UPDATE challenges SET expires_at = 0").run();
  const stale = await challenge();
  env.DB.sql.prepare("UPDATE challenges SET expires_at = 1").run();
  assert.equal((await call("POST", "/passkey/session", { body: await assertion(passkey, { value: stale }) })).status, 401);
});

test("a published link is readable by anyone with its address, keeps the address when republished, and can be taken down", async () => {
  const token = await signIn();
  assert.equal((await call("POST", "/link/feed", { bytes: enc("x") })).status, 401);
  assert.equal((await call("PUT", "/link/feed", { token, bytes: enc("x") })).status, 404);
  const first = await call("POST", "/link/feed", { token, bytes: enc("BEGIN:VCALENDAR") });
  assert.match(first.body.token, /^[\w-]{32}$/);
  const read = await worker.fetch(new Request(`https://api.test/feed/${first.body.token}.ics`), env);
  assert.deepEqual([read.status, read.headers.get("Content-Type"), await read.text()], [200, "text/calendar; charset=utf-8", "BEGIN:VCALENDAR"]);
  assert.equal((await call("PUT", "/link/feed", { token, bytes: enc("again") })).body.token, first.body.token);
  const share = await call("POST", "/link/share", { token, bytes: enc("sealed") });
  assert.notEqual(share.body.token, first.body.token);
  assert.deepEqual((await call("GET", "/links", { token })).body, { feed: first.body.token, share: share.body.token });
  assert.equal((await call("GET", `/share/${share.body.token}`)).data, "sealed");
  assert.equal((await call("GET", `/share/${first.body.token}`)).status, 404);
  assert.equal((await call("PUT", "/link/share", { token, bytes: new Uint8Array(300_001) })).status, 413);
  assert.equal((await call("DELETE", "/link/feed", { token })).status, 204);
  assert.equal((await call("GET", `/feed/${first.body.token}.ics`)).status, 404);
  // Another device bringing its copy up to date does not publish it again.
  assert.equal((await call("PUT", "/link/feed", { token, bytes: enc("stale device") })).status, 404);
  assert.deepEqual((await call("GET", "/links", { token })).body, { share: share.body.token });
});

test("the recovery blob is kept per account and goes with it", async () => {
  const token = await signIn();
  assert.equal((await call("GET", "/recovery", { token })).status, 404);
  assert.equal((await call("PUT", "/recovery", { token, bytes: enc("wrapped") })).status, 204);
  assert.equal((await call("PUT", "/recovery", { token, bytes: enc("wrapped again") })).status, 204);
  assert.equal((await call("GET", "/recovery", { token })).data, "wrapped again");
  assert.equal((await call("GET", "/recovery", { token: await signIn({ sub: "someone-else" }) })).status, 404);
  await call("POST", "/link/feed", { token, bytes: enc("x") });
  await register(await newPasskey(), token);
  await call("PUT", "/reminders", { token, body: { endpoint: "https://fcm.googleapis.com/fcm/send/a", minutes: [1] } });
  assert.equal((await call("DELETE", "/account", { token })).status, 204);
  for (const table of ["recovery", "links", "passkeys", "reminders"]) {
    assert.equal(env.DB.sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
});

test("reminders push, with no body, to the devices due that minute and forget the ones that are gone", async () => {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
  env.VAPID_PUBLIC_KEY = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  env.VAPID_PRIVATE_KEY = jwk.d;
  env.VAPID_SUBJECT = "https://example.test/";
  const token = await signIn();
  const phone = "https://fcm.googleapis.com/fcm/send/phone";
  const gone = "https://updates.push.services.mozilla.com/wpush/v2/gone";
  assert.equal((await call("PUT", "/reminders", { token, body: { endpoint: "https://evil.example/x", minutes: [1] } })).status, 400);
  assert.equal((await call("PUT", "/reminders", { token, body: { endpoint: phone, minutes: [1440] } })).status, 400);
  assert.equal((await call("PUT", "/reminders", { token, body: { endpoint: phone, minutes: [450, 450, 1200] } })).status, 204);
  assert.equal((await call("PUT", "/reminders", { token, body: { endpoint: gone, minutes: [450] } })).status, 204);

  const sent = [];
  const googleFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url, init });
    return new Response(null, { status: url === gone ? 410 : 201 });
  };
  const waits = [];
  const tick = async (iso) => {
    worker.scheduled({ scheduledTime: Date.parse(iso) }, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  try {
    await tick("2026-11-24T07:31:00Z");
    assert.equal(sent.length, 0);
    await tick("2026-11-24T07:30:20Z");
  } finally {
    globalThis.fetch = googleFetch;
  }
  assert.deepEqual(sent.map((x) => x.url).sort(), [phone, gone].sort());
  const { init } = sent.find((x) => x.url === phone);
  assert.deepEqual([init.method, init.body, init.headers.TTL], ["POST", undefined, "3600"]);
  const [, jwt, k] = /^vapid t=([\w.-]+), k=([\w-]+)$/.exec(init.headers.Authorization);
  const [head, claims, signature] = jwt.split(".");
  assert.equal(k, env.VAPID_PUBLIC_KEY);
  assert.equal(JSON.parse(Buffer.from(claims, "base64url")).aud, "https://fcm.googleapis.com");
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, keys.publicKey, Buffer.from(signature, "base64url"), enc(`${head}.${claims}`)), true);
  assert.deepEqual(env.DB.sql.prepare("SELECT endpoint, minute FROM reminders ORDER BY minute").all().map((r) => [r.endpoint, r.minute]), [[phone, 450], [phone, 1200]]);
  assert.equal((await call("PUT", "/reminders", { token, body: { endpoint: phone, minutes: [] } })).status, 204);
  assert.equal(env.DB.sql.prepare("SELECT COUNT(*) AS n FROM reminders").get().n, 0);
});

test("an account can have reminders on a handful of devices, and a service is signed for once per run", async () => {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  env.VAPID_PUBLIC_KEY = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  env.VAPID_PRIVATE_KEY = (await crypto.subtle.exportKey("jwk", keys.privateKey)).d;
  const token = await signIn();
  const device = (n) => `https://fcm.googleapis.com/fcm/send/${n}`;
  for (let n = 0; n < 5; n++) assert.equal((await call("PUT", "/reminders", { token, body: { endpoint: device(n), minutes: [60] } })).status, 204);
  assert.equal((await call("PUT", "/reminders", { token, body: { endpoint: device(5), minutes: [60] } })).status, 400);
  assert.equal((await call("PUT", "/reminders", { token, body: { endpoint: device(0), minutes: [61] } })).status, 204);

  const headers = [];
  const googleFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    headers.push(init.headers.Authorization);
    return new Response(null, { status: 201 });
  };
  const waits = [];
  try {
    worker.scheduled({ scheduledTime: Date.parse("2026-11-24T01:00:00Z") }, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  } finally {
    globalThis.fetch = googleFetch;
  }
  assert.equal(headers.length, 4);
  assert.equal(new Set(headers).size, 1);
});

test("the open passkey routes are limited per address", async () => {
  const from = (ip) => ({ headers: { "CF-Connecting-IP": ip } });
  for (let n = 0; n < 30; n++) assert.equal((await call("POST", "/passkey/challenge", from("1.1.1.1"))).status, 200);
  assert.equal((await call("POST", "/passkey/challenge", from("1.1.1.1"))).status, 429);
  assert.equal((await call("POST", "/passkey/challenge", from("2.2.2.2"))).status, 200);
  for (let n = 0; n < 5; n++) await call("POST", "/passkey/register", { ...from("3.3.3.3"), body: {} });
  assert.equal((await call("POST", "/passkey/register", { ...from("3.3.3.3"), body: {} })).status, 429);
});

test("a passkey whose use count does not move forward is refused", async () => {
  const passkey = await newPasskey();
  await register(passkey);
  assert.equal((await call("POST", "/passkey/session", { body: await assertion(passkey, { count: 7 }) })).status, 200);
  assert.equal((await call("POST", "/passkey/session", { body: await assertion(passkey, { count: 7 }) })).status, 401);
  assert.equal((await call("POST", "/passkey/session", { body: await assertion(passkey, { count: 0 }) })).status, 401);
  assert.equal((await call("POST", "/passkey/session", { body: await assertion(passkey, { count: 8 }) })).status, 200);
});
