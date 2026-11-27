import { HttpError } from "./http.js";

export const API = "https://habit-tracker.joacoangelino.workers.dev";
// The server's public push key, as `npx web-push generate-vapid-keys` prints it. Reminders stay hidden while it is empty.
export const VAPID_PUBLIC_KEY = "";
export const GOOGLE_CLIENT_ID = "657713120724-h1fovv0r8vjtf539cjmrvlo28ook5tf7.apps.googleusercontent.com";

const auth = (session) => (session ? { Authorization: `Bearer ${session}` } : {});

function code(status, session) {
  if (status === 401 && session) return "errSignedOut";
  if (status === 413) return "errTooLarge";
  if (status >= 500) return "errServer";
  return undefined;
}

async function fail(res, session) {
  const json = await res.json().catch(() => ({}));
  throw new HttpError(res.status, json.error || res.statusText, code(res.status, session));
}

// JSON both ways, unless `bytes` are sent or the response is wanted `raw`.
async function call(path, { method = "GET", session, body, bytes, raw = Boolean(bytes) } = {}) {
  const type = bytes ? "application/octet-stream" : body && "application/json";
  const res = await fetch(API + path, {
    method,
    cache: "no-store",
    headers: { ...auth(session), ...(type && { "Content-Type": type }) },
    body: bytes ?? (body && JSON.stringify(body)),
  });
  if (!res.ok) await fail(res, session);
  if (raw) return res;
  return res.status === 204 ? {} : res.json();
}

export const signIn = (credential) => call("/session", { method: "POST", body: { credential } });
export const signOut = (session) => call("/session", { method: "DELETE", session });
export const deleteAccount = (session) => call("/account", { method: "DELETE", session });
export const passkeyChallenge = () => call("/passkey/challenge", { method: "POST" });
// The server refuses a change to passkeys from a session that is not fresh.
const needsFresh = (err) => {
  if (err.status === 403) err.code = "errFreshSignIn";
  throw err;
};
export const passkeyRegister = (body, session) => call("/passkey/register", { method: "POST", body, session }).catch(needsFresh);
export const passkeyCount = (session) => call("/passkeys", { session });
export const removePasskeys = (session) => call("/passkeys", { method: "DELETE", session }).catch(needsFresh);
export const passkeySignIn = (body) => call("/passkey/session", { method: "POST", body });
export const setReminders = (session, endpoint, minutes) => call("/reminders", { method: "PUT", session, body: { endpoint, minutes } });

const readBytes = async (path, session) => new Uint8Array(await (await call(path, { session, raw: true })).arrayBuffer());

// `kind` is "feed" or "share". Publishing keeps the address; updating one that was taken down fails with 404.
export const publishedLinks = (session) => call("/links", { session });
export const publishLink = async (kind, session, body) => (await call(`/link/${kind}`, { method: "POST", session, bytes: body })).json();
export const updateLink = async (kind, session, body) => (await call(`/link/${kind}`, { method: "PUT", session, bytes: body })).json();
export const removeLink = (kind, session) => call(`/link/${kind}`, { method: "DELETE", session });
export const feedUrl = (token) => `${API}/feed/${token}.ics`;
export const readShare = (token) => readBytes(`/share/${token}`);
export const saveRecovery = async (session, body) => void (await call("/recovery", { method: "PUT", session, bytes: body }));
export const readRecovery = (session) => readBytes("/recovery", session);

const file = async (res) => ({ version: res.headers.get("X-Version"), bytes: new Uint8Array(await res.arrayBuffer()) });

// `held` is the copy already on the device; the server sends the data only when it has a different one.
// Versions travel in headers so the URL, and with it the browser's cached CORS preflight, never changes.
export async function readFile(cfg, held) {
  const res = await fetch(`${API}/vault`, { cache: "no-store", headers: { ...auth(cfg.session), ...(held && { "X-Have": held.version }) } });
  if (res.status === 404) return null;
  if (res.status === 204) return held;
  if (!res.ok) await fail(res, cfg.session);
  return file(res);
}

export async function writeFile(cfg, bytes, version) {
  const res = await fetch(`${API}/vault`, {
    method: "PUT",
    cache: "no-store",
    headers: { ...auth(cfg.session), "Content-Type": "application/octet-stream", "X-Version": version ?? "0" },
    body: bytes,
  });
  if (res.ok) return res.headers.get("X-Version");
  if (res.status !== 409) await fail(res, cfg.session);
  const err = new HttpError(409, "The data changed since it was read");
  err.conflict = true;
  err.current = res.headers.get("X-Version") ? await file(res) : null;
  throw err;
}
