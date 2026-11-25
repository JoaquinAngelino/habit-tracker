const DAY = 86_400_000;
const SESSION_TTL = 180 * DAY;
// Sliding expiry: a session is pushed back at most once every 10 days, to keep writes rare.
const SESSION_RENEW_AFTER = 10 * DAY;
const MAX_ENVELOPE = 1_000_000;
const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const CLOCK_SKEW = 60_000;

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

let certs = { keys: [], until: 0 };

async function googleKey(kid) {
  const find = () => certs.keys.find((k) => k.kid === kid);
  if (Date.now() < certs.until && find()) return find();
  const res = await fetch(GOOGLE_CERTS);
  if (!res.ok) throw new HttpError(502, "Could not reach Google");
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("Cache-Control") ?? "")?.[1] ?? 3600);
  certs = { keys: (await res.json()).keys ?? [], until: Date.now() + maxAge * 1000 };
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
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = now + SESSION_TTL;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), user.id, expiresAt),
  ]);
  return json({ token, expiresAt });
}

async function authenticate(request, env) {
  const token = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (!token) throw new HttpError(401, "Not signed in");
  const hash = await sha256(token);
  const now = Date.now();
  const session = await env.DB.prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?").bind(hash).first();
  if (!session || session.expires_at <= now) throw new HttpError(401, "Not signed in");
  if (session.expires_at < now + SESSION_TTL - SESSION_RENEW_AFTER) {
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").bind(now + SESSION_TTL, hash).run();
  }
  return { userId: session.user_id, hash };
}

const blob = (bytes, version, status = 200) =>
  new Response(new Uint8Array(bytes), { status, headers: { "Content-Type": "application/octet-stream", "X-Version": String(version) } });

// A client that already has version `have` gets only the version back while it is still current.
async function readVault(url, env, userId) {
  const have = Number(url.searchParams.get("have")) || 0;
  const vault = await env.DB.prepare("SELECT version, CASE WHEN version = ? THEN NULL ELSE envelope END AS envelope FROM vaults WHERE user_id = ?")
    .bind(have, userId)
    .first();
  if (!vault) return json({ error: "No data yet" }, 404);
  if (vault.envelope == null) return new Response(null, { status: 204, headers: { "X-Version": String(vault.version) } });
  return blob(vault.envelope, vault.version);
}

// `version` is the one the client last read (0 for none); a write over a newer version is refused.
async function writeVault(request, url, env, userId) {
  const raw = url.searchParams.get("version") ?? "";
  if (!/^\d+$/.test(raw)) throw new HttpError(400, "Expected a version");
  const version = Number(raw);
  if (Number(request.headers.get("Content-Length")) > MAX_ENVELOPE) throw new HttpError(413, "Data is too large");
  const envelope = await request.arrayBuffer();
  if (!envelope.byteLength) throw new HttpError(400, "Expected the encrypted data");
  if (envelope.byteLength > MAX_ENVELOPE) throw new HttpError(413, "Data is too large");
  const now = Date.now();
  const result = version === 0
    ? await env.DB.prepare("INSERT INTO vaults (user_id, version, envelope, updated_at) VALUES (?, 1, ?, ?) ON CONFLICT (user_id) DO NOTHING")
      .bind(userId, envelope, now)
      .run()
    : await env.DB.prepare("UPDATE vaults SET version = version + 1, envelope = ?, updated_at = ? WHERE user_id = ? AND version = ?")
      .bind(envelope, now, userId, version)
      .run();
  if (result.meta.changes === 1) return new Response(null, { status: 204, headers: { "X-Version": String(version + 1) } });
  // The newer data comes back with the refusal, so the client can merge without another request.
  const current = await env.DB.prepare("SELECT version, envelope FROM vaults WHERE user_id = ?").bind(userId).first();
  return current ? blob(current.envelope, current.version, 409) : json({ error: "The data changed since it was read" }, 409);
}

async function deleteAccount(env, userId) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM vaults WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
  return new Response(null, { status: 204 });
}

async function route(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const key = `${request.method} ${pathname}`;
  if (key === "POST /session") return signIn(request, env);
  if (!["DELETE /session", "GET /vault", "PUT /vault", "DELETE /account"].includes(key)) throw new HttpError(404, "Not found");
  const { userId, hash } = await authenticate(request, env);
  if (key === "DELETE /session") {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
    return new Response(null, { status: 204 });
  }
  if (key === "GET /vault") return readVault(url, env, userId);
  if (key === "PUT /vault") return writeVault(request, url, env, userId);
  return deleteAccount(env, userId);
}

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim());
  if (!origin || !allowed.includes(origin)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
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
};
