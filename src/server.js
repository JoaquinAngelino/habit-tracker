import { HttpError } from "./http.js";

export const API = "https://habit-tracker.joacoangelino.workers.dev";
// The server's public push key, as `npx web-push generate-vapid-keys` prints it. Reminders stay hidden while it is empty.
export const VAPID_PUBLIC_KEY = "";
export const GOOGLE_CLIENT_ID = "657713120724-h1fovv0r8vjtf539cjmrvlo28ook5tf7.apps.googleusercontent.com";

const auth = (session) => (session ? { Authorization: `Bearer ${session}` } : {});

function code(status, session) {
  if (status === 401 && session) return "errSignedOut";
  if (status === 403) return "errFreshSignIn";
  if (status === 413) return "errTooLarge";
  if (status >= 500) return "errServer";
  return undefined;
}

async function fail(res, session) {
  const json = await res.json().catch(() => ({}));
  throw new HttpError(res.status, json.error || res.statusText, code(res.status, session));
}

async function call(path, { method = "GET", session, body } = {}) {
  const res = await fetch(API + path, {
    method,
    cache: "no-store",
    headers: { ...auth(session), ...(body && { "Content-Type": "application/json" }) },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) await fail(res, session);
  return res.status === 204 ? {} : res.json();
}

export const signIn = (credential) => call("/session", { method: "POST", body: { credential } });
export const signOut = (session) => call("/session", { method: "DELETE", session });
export const deleteAccount = (session) => call("/account", { method: "DELETE", session });
export const passkeyChallenge = () => call("/passkey/challenge", { method: "POST" });
export const passkeyRegister = (body, session) => call("/passkey/register", { method: "POST", body, session });
export const passkeyCount = (session) => call("/passkeys", { session });
export const removePasskeys = (session) => call("/passkeys", { method: "DELETE", session });
export const passkeySignIn = (body) => call("/passkey/session", { method: "POST", body });
export const setReminders = (session, endpoint, minutes) => call("/reminders", { method: "PUT", session, body: { endpoint, minutes } });

async function bytes(path, { method = "GET", session, body } = {}) {
  const res = await fetch(API + path, { method, cache: "no-store", headers: { ...auth(session), ...(body && { "Content-Type": "application/octet-stream" }) }, body });
  if (!res.ok) await fail(res, session);
  return res;
}

// `kind` is "feed" or "share". Publishing again keeps the address.
export const publishLink = async (kind, session, body) => (await bytes(`/link/${kind}`, { method: "PUT", session, body })).json();
export const removeLink = (kind, session) => call(`/link/${kind}`, { method: "DELETE", session });
export const feedUrl = (token) => `${API}/feed/${token}.ics`;
export const readShare = async (token) => new Uint8Array(await (await bytes(`/share/${token}`)).arrayBuffer());
export const saveRecovery = (session, body) => bytes("/recovery", { method: "PUT", session, body });
export const readRecovery = async (session) => new Uint8Array(await (await bytes("/recovery", { session })).arrayBuffer());

const file = async (res) => ({ version: res.headers.get("X-Version"), bytes: new Uint8Array(await res.arrayBuffer()) });

// Writes may go out without a read first: a conflict carries the newer file as `current`.
export const writesBlind = true;

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
