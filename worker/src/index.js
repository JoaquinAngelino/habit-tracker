const DAY = 86_400_000;
const SESSION_TTL = 180 * DAY;
// Sliding expiry: a session is pushed back at most once every 10 days, to keep writes rare.
const SESSION_RENEW_AFTER = 10 * DAY;
const MAX_ENVELOPE = 1_000_000;
const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const CLOCK_SKEW = 60_000;
// An unknown key id refetches Google's keys at most this often, so forged tokens cannot hammer Google.
const CERTS_REFETCH_AFTER = 60_000;
const MAX_SESSIONS_PER_USER = 20;
const MAX_LINK = 300_000;
const MAX_RECOVERY = 4096;
const CHALLENGE_TTL = 5 * 60_000;
// A stolen session must not be able to mint a way in that outlives it.
const FRESH_SIGN_IN = 10 * 60_000;
const MAX_REMINDERS = 48;
const P256 = { name: "ECDSA", namedCurve: "P-256" };
const ES256 = { name: "ECDSA", hash: "SHA-256" };
// The worker posts to addresses clients hand it, so only the browsers' push services are accepted.
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/;
const LINK_TYPES = { feed: "text/calendar; charset=utf-8", share: "application/octet-stream" };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (body, status = 200) => Response.json(body, { status });

const encoder = new TextEncoder();
const b64urlBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sha256(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let certs = { keys: [], until: 0, fetchedAt: 0 };

async function googleKey(kid) {
  const find = () => certs.keys.find((k) => k.kid === kid);
  const now = Date.now();
  if (now < certs.until && (find() || now - certs.fetchedAt < CERTS_REFETCH_AFTER)) return find();
  const res = await fetch(GOOGLE_CERTS);
  if (!res.ok) throw new HttpError(502, "Could not reach Google");
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("Cache-Control") ?? "")?.[1] ?? 3600);
  certs = { keys: (await res.json()).keys ?? [], until: now + maxAge * 1000, fetchedAt: now };
  return find();
}

// Checks a Google ID token (the `credential` from Sign in with Google) and returns the account's stable ID.
async function verifyGoogle(credential, clientId) {
  const invalid = new HttpError(401, "Invalid sign-in");
  const parts = typeof credential === "string" ? credential.split(".") : [];
  if (parts.length !== 3) throw invalid;
  let header;
  let payload;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch {
    throw invalid;
  }
  if (header.alg !== "RS256") throw invalid;
  const jwk = await googleKey(header.kid);
  if (!jwk) throw invalid;
  let valid = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`));
  } catch {
    valid = false;
  }
  if (!valid) throw invalid;
  if (!GOOGLE_ISSUERS.includes(payload.iss) || payload.aud !== clientId || !payload.sub) throw invalid;
  if (!(payload.exp * 1000 + CLOCK_SKEW > Date.now())) throw invalid;
  return String(payload.sub);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
}

async function signIn(request, env) {
  if (!env.GOOGLE_CLIENT_ID) throw new HttpError(503, "Sign-in is not configured");
  const { credential } = await readJson(request);
  const sub = await verifyGoogle(credential, env.GOOGLE_CLIENT_ID);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO users (id, google_sub, created_at) VALUES (?, ?, ?) ON CONFLICT (google_sub) DO NOTHING")
    .bind(crypto.randomUUID(), sub, now)
    .run();
  const user = await env.DB.prepare("SELECT id FROM users WHERE google_sub = ?").bind(sub).first();
  return json(await startSession(env, user.id));
}

async function startSession(env, userId) {
  const now = Date.now();
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = now + SESSION_TTL;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare(
      "DELETE FROM sessions WHERE user_id = ?1 AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id = ?1 ORDER BY expires_at DESC LIMIT ?2)",
    ).bind(userId, MAX_SESSIONS_PER_USER - 1),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").bind(await sha256(token), userId, expiresAt, now),
  ]);
  return { token, expiresAt };
}

const origins = (env) => (env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim());
const invalidPasskey = () => new HttpError(401, "Invalid passkey");

async function passkeyChallenge(env) {
  const challenge = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM challenges WHERE expires_at < ?").bind(now),
    env.DB.prepare("INSERT INTO challenges (value, expires_at) VALUES (?, ?)").bind(challenge, now + CHALLENGE_TTL),
  ]);
  return json({ challenge });
}

// The browser's own record of what it was asked: which ceremony, our challenge, and the page's origin.
// A challenge is spent on its first use.
async function clientData(encoded, type, env) {
  let data;
  try {
    data = b64urlJson(encoded);
  } catch {
    throw invalidPasskey();
  }
  if (data?.type !== type || !origins(env).includes(data.origin)) throw invalidPasskey();
  const spent = await env.DB.prepare("DELETE FROM challenges WHERE value = ? AND expires_at > ?").bind(String(data.challenge), Date.now()).run();
  if (spent.meta.changes !== 1) throw invalidPasskey();
  return data;
}

// No attestation is asked for, so the key is taken as the browser reports it: whoever registers a passkey
// defines the account it opens. Sent with a session that began in the last few minutes, it is added to that
// account instead, and every other session of the account ends.
async function passkeyRegister(request, env) {
  const { credentialId, publicKey, clientDataJSON } = await readJson(request);
  await clientData(clientDataJSON, "webauthn.create", env);
  if (!/^[\w-]{16,1024}$/.test(credentialId ?? "")) throw new HttpError(400, "Expected a credential");
  let key;
  try {
    key = b64urlBytes(publicKey);
    await crypto.subtle.importKey("spki", key, P256, false, ["verify"]);
  } catch {
    throw new HttpError(400, "Expected a P-256 public key");
  }
  if (await env.DB.prepare("SELECT 1 FROM passkeys WHERE credential_id = ?").bind(credentialId).first()) throw new HttpError(409, "That passkey is already registered");
  const now = Date.now();
  const session = request.headers.get("Authorization") ? await authenticate(request, env) : null;
  if (session && !(session.createdAt > now - FRESH_SIGN_IN)) throw new HttpError(403, "Sign in again to add a passkey");
  const userId = session?.userId ?? crypto.randomUUID();
  if (!session) await env.DB.prepare("INSERT INTO users (id, google_sub, created_at) VALUES (?, ?, ?)").bind(userId, `passkey:${credentialId}`, now).run();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO passkeys (credential_id, user_id, public_key, created_at) VALUES (?, ?, ?, ?)").bind(credentialId, userId, key.buffer, now),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(userId, session?.hash ?? ""),
  ]);
  if (session) return json({ userId });
  return json({ ...(await startSession(env, userId)), userId });
}

// WebAuthn signs in DER; Web Crypto checks r and s as two 32-byte numbers.
function rawSignature(der) {
  const out = new Uint8Array(64);
  let at = 2;
  if (der[0] !== 0x30) throw new Error("Not a signature");
  for (const offset of [0, 32]) {
    if (der[at] !== 0x02) throw new Error("Not a signature");
    let number = der.slice(at + 2, at + 2 + der[at + 1]);
    at += 2 + der[at + 1];
    while (number.length > 32 && number[0] === 0) number = number.slice(1);
    if (number.length > 32) throw new Error("Not a signature");
    out.set(number, offset + 32 - number.length);
  }
  return out;
}

async function passkeySignIn(request, env) {
  const { credentialId, authenticatorData, clientDataJSON, signature } = await readJson(request);
  const data = await clientData(clientDataJSON, "webauthn.get", env);
  const passkey = await env.DB.prepare("SELECT user_id, public_key FROM passkeys WHERE credential_id = ?").bind(String(credentialId)).first();
  if (!passkey) throw invalidPasskey();
  let valid = false;
  try {
    const auth = b64urlBytes(authenticatorData);
    const site = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(new URL(data.origin).hostname)));
    // The first 32 bytes name the site the passkey belongs to; bit 0 of the next says a person was present.
    if (auth.length < 37 || !(auth[32] & 1) || !site.every((b, i) => b === auth[i])) throw invalidPasskey();
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", b64urlBytes(clientDataJSON)));
    const signed = new Uint8Array(auth.length + hash.length);
    signed.set(auth);
    signed.set(hash, auth.length);
    const key = await crypto.subtle.importKey("spki", toBytes(passkey.public_key), P256, false, ["verify"]);
    valid = await crypto.subtle.verify(ES256, key, rawSignature(b64urlBytes(signature)), signed);
  } catch {
    valid = false;
  }
  if (!valid) throw invalidPasskey();
  return json({ ...(await startSession(env, passkey.user_id)), userId: passkey.user_id });
}

async function authenticate(request, env) {
  const token = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (!token) throw new HttpError(401, "Not signed in");
  const hash = await sha256(token);
  const now = Date.now();
  const session = await env.DB.prepare("SELECT user_id, expires_at, created_at FROM sessions WHERE token_hash = ?").bind(hash).first();
  if (!session || session.expires_at <= now) throw new HttpError(401, "Not signed in");
  if (session.expires_at < now + SESSION_TTL - SESSION_RENEW_AFTER) {
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").bind(now + SESSION_TTL, hash).run();
  }
  return { userId: session.user_id, hash, createdAt: session.created_at };
}

const newVersion = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");

// D1 returns a BLOB as an array of numbers; a TEXT value can only be an envelope stored as JSON.
const toBytes = (value) => (typeof value === "string" ? encoder.encode(value) : new Uint8Array(value));

const blob = (envelope, version, status = 200) =>
  new Response(toBytes(envelope), { status, headers: { "Content-Type": "application/octet-stream", "X-Version": version } });

// Versions come in headers; the query string is the form clients used before.
const versionFrom = (request, url, header, param) => request.headers.get(header) ?? url.searchParams.get(param) ?? "";

// A client that already has version `have` gets only the version back while it is still current.
async function readVault(request, url, env, userId) {
  const have = versionFrom(request, url, "X-Have", "have");
  const vault = await env.DB.prepare("SELECT version, CASE WHEN version = ? THEN NULL ELSE envelope END AS envelope FROM vaults WHERE user_id = ?")
    .bind(have, userId)
    .first();
  if (!vault) return json({ error: "No data yet" }, 404);
  if (vault.envelope == null) return new Response(null, { status: 204, headers: { "X-Version": vault.version } });
  return blob(vault.envelope, vault.version);
}

// `version` is the one the client last read ("0" for none); a write over any other version is refused.
async function writeVault(request, url, env, userId) {
  const version = versionFrom(request, url, "X-Version", "version");
  if (!/^[\w-]{1,64}$/.test(version)) throw new HttpError(400, "Expected a version");
  if (Number(request.headers.get("Content-Length")) > MAX_ENVELOPE) throw new HttpError(413, "Data is too large");
  const envelope = await request.arrayBuffer();
  if (!envelope.byteLength) throw new HttpError(400, "Expected the encrypted data");
  if (envelope.byteLength > MAX_ENVELOPE) throw new HttpError(413, "Data is too large");
  const now = Date.now();
  const next = newVersion();
  const result = version === "0"
    ? await env.DB.prepare("INSERT INTO vaults (user_id, version, envelope, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id) DO NOTHING")
      .bind(userId, next, envelope, now)
      .run()
    : await env.DB.prepare("UPDATE vaults SET version = ?, envelope = ?, updated_at = ? WHERE user_id = ? AND version = ?")
      .bind(next, envelope, now, userId, version)
      .run();
  if (result.meta.changes === 1) return new Response(null, { status: 204, headers: { "X-Version": next } });
  // The newer data comes back with the refusal, so the client can merge without another request.
  const current = await env.DB.prepare("SELECT version, envelope FROM vaults WHERE user_id = ?").bind(userId).first();
  return current ? blob(current.envelope, current.version, 409) : json({ error: "The data changed since it was read" }, 409);
}

async function passkeyCount(env, userId) {
  return json(await env.DB.prepare("SELECT COUNT(*) AS count FROM passkeys WHERE user_id = ?").bind(userId).first());
}

// An account made with a passkey has no other way in, so its passkeys stay.
async function removePasskeys(env, userId, hash) {
  const user = await env.DB.prepare("SELECT google_sub FROM users WHERE id = ?").bind(userId).first();
  if (user.google_sub.startsWith("passkey:")) throw new HttpError(409, "A passkey is the only way in to this account");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM passkeys WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(userId, hash),
  ]);
  return new Response(null, { status: 204 });
}

async function body(request, max) {
  if (Number(request.headers.get("Content-Length")) > max) throw new HttpError(413, "Data is too large");
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) throw new HttpError(400, "Expected a body");
  if (bytes.byteLength > max) throw new HttpError(413, "Data is too large");
  return bytes;
}

// Publishing again keeps the address, so a calendar or a friend's link keeps working.
async function writeLink(request, env, userId, kind) {
  const bytes = await body(request, MAX_LINK);
  await env.DB.prepare(
    "INSERT INTO links (token, user_id, kind, body, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, kind) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
  ).bind(b64url(crypto.getRandomValues(new Uint8Array(24))), userId, kind, bytes, Date.now()).run();
  return json(await env.DB.prepare("SELECT token FROM links WHERE user_id = ? AND kind = ?").bind(userId, kind).first());
}

async function deleteLink(env, userId, kind) {
  await env.DB.prepare("DELETE FROM links WHERE user_id = ? AND kind = ?").bind(userId, kind).run();
  return new Response(null, { status: 204 });
}

// Open to anyone who has the address.
async function readLink(env, kind, token) {
  const link = await env.DB.prepare("SELECT body FROM links WHERE token = ? AND kind = ?").bind(token, kind).first();
  if (!link) throw new HttpError(404, "Not found");
  return new Response(toBytes(link.body), { headers: { "Content-Type": LINK_TYPES[kind], "Cache-Control": "no-store" } });
}

async function writeRecovery(request, env, userId) {
  const bytes = await body(request, MAX_RECOVERY);
  await env.DB.prepare("INSERT INTO recovery (user_id, body, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at")
    .bind(userId, bytes, Date.now())
    .run();
  return new Response(null, { status: 204 });
}

async function readRecovery(env, userId) {
  const row = await env.DB.prepare("SELECT body FROM recovery WHERE user_id = ?").bind(userId).first();
  if (!row) throw new HttpError(404, "No recovery key yet");
  return new Response(toBytes(row.body), { headers: { "Content-Type": "application/octet-stream" } });
}

function pushEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && PUSH_HOSTS.test(url.hostname)) return url.href;
  } catch {
    /* refused below */
  }
  throw new HttpError(400, "Expected a push subscription");
}

// Replaces the times a device asked for; none removes it.
async function writeReminders(request, env, userId) {
  const { endpoint, minutes } = await readJson(request);
  const url = pushEndpoint(endpoint);
  const list = [...new Set(Array.isArray(minutes) ? minutes : [])];
  if (list.length > MAX_REMINDERS || !list.every((m) => Number.isInteger(m) && m >= 0 && m < 1440)) throw new HttpError(400, "Expected minutes of the day");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reminders WHERE endpoint = ?").bind(url),
    ...list.map((m) => env.DB.prepare("INSERT INTO reminders (endpoint, minute, user_id) VALUES (?, ?, ?)").bind(url, m, userId)),
  ]);
  return new Response(null, { status: 204 });
}

// Signs the worker's identity for a push service, as VAPID asks.
async function vapid(env, endpoint) {
  const point = b64urlBytes(env.VAPID_PUBLIC_KEY);
  const jwk = { kty: "EC", crv: "P-256", d: env.VAPID_PRIVATE_KEY, x: b64url(point.slice(1, 33)), y: b64url(point.slice(33)) };
  const key = await crypto.subtle.importKey("jwk", jwk, P256, false, ["sign"]);
  const part = (value) => b64url(encoder.encode(JSON.stringify(value)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })}`;
  const signature = new Uint8Array(await crypto.subtle.sign(ES256, key, encoder.encode(unsigned)));
  return `vapid t=${unsigned}.${b64url(signature)}, k=${env.VAPID_PUBLIC_KEY}`;
}

// A push with no body: the app words the notification itself, so the server never holds its text.
async function remind(env, now) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return 0;
  const at = new Date(now);
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  const { results } = await env.DB.prepare("SELECT DISTINCT endpoint FROM reminders WHERE minute = ?").bind(minute).all();
  await Promise.all(results.map(async ({ endpoint }) => {
    try {
      const res = await fetch(endpoint, { method: "POST", headers: { Authorization: await vapid(env, endpoint), TTL: "3600" } });
      // The browser dropped the subscription.
      if (res.status === 404 || res.status === 410) await env.DB.prepare("DELETE FROM reminders WHERE endpoint = ?").bind(endpoint).run();
    } catch (err) {
      console.error(err);
    }
  }));
  return results.length;
}

async function deleteAccount(env, userId) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM vaults WHERE user_id = ?").bind(userId),
    ...["passkeys", "links", "recovery", "reminders"].map((table) => env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId)),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
  return new Response(null, { status: 204 });
}

const ROUTES = {
  "DELETE /session": async (request, url, env, { hash }) => {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
    return new Response(null, { status: 204 });
  },
  "GET /vault": (request, url, env, { userId }) => readVault(request, url, env, userId),
  "PUT /vault": (request, url, env, { userId }) => writeVault(request, url, env, userId),
  "DELETE /account": (request, url, env, { userId }) => deleteAccount(env, userId),
  "PUT /link/feed": (request, url, env, { userId }) => writeLink(request, env, userId, "feed"),
  "PUT /link/share": (request, url, env, { userId }) => writeLink(request, env, userId, "share"),
  "DELETE /link/feed": (request, url, env, { userId }) => deleteLink(env, userId, "feed"),
  "DELETE /link/share": (request, url, env, { userId }) => deleteLink(env, userId, "share"),
  "GET /passkeys": (request, url, env, { userId }) => passkeyCount(env, userId),
  "DELETE /passkeys": (request, url, env, { userId, hash }) => removePasskeys(env, userId, hash),
  "PUT /recovery": (request, url, env, { userId }) => writeRecovery(request, env, userId),
  "GET /recovery": (request, url, env, { userId }) => readRecovery(env, userId),
  "PUT /reminders": (request, url, env, { userId }) => writeReminders(request, env, userId),
};

const OPEN_ROUTES = {
  "POST /session": signIn,
  "POST /passkey/challenge": (request, env) => passkeyChallenge(env),
  "POST /passkey/register": passkeyRegister,
  "POST /passkey/session": passkeySignIn,
};

async function route(request, env) {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;
  if (OPEN_ROUTES[key]) return OPEN_ROUTES[key](request, env);
  const link = request.method === "GET" && /^\/(feed|share)\/([\w-]{16,64})(\.ics)?$/.exec(url.pathname);
  if (link) return readLink(env, link[1], link[2]);
  const handler = ROUTES[key];
  if (!handler) throw new HttpError(404, "Not found");
  return handler(request, url, env, await authenticate(request, env));
}

function corsHeaders(origin, env) {
  if (!origin || !origins(env).includes(origin)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Have, X-Version",
    "Access-Control-Expose-Headers": "X-Version",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request.headers.get("Origin"), env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    let response;
    try {
      response = await route(request, env);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      response = err instanceof HttpError ? json({ error: err.message }, err.status) : json({ error: "Server error" }, 500);
    }
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  },
  // Runs every minute.
  scheduled(event, env, ctx) {
    ctx.waitUntil(remind(env, event.scheduledTime));
  },
};
