export const API = "https://habit-tracker.joacoangelino.workers.dev";
export const GOOGLE_CLIENT_ID = "657713120724-h1fovv0r8vjtf539cjmrvlo28ook5tf7.apps.googleusercontent.com";

export class ServerError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const auth = (session) => (session ? { Authorization: `Bearer ${session}` } : {});

async function fail(res, session) {
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && session) throw new ServerError(401, json.error, "errSignedOut");
  if (res.status >= 500) throw new ServerError(res.status, json.error, "errServer");
  throw new ServerError(res.status, json.error || res.statusText);
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

export async function signIn(credential) {
  return call("/session", { method: "POST", body: { credential } });
}

export const signOut = (session) => call("/session", { method: "DELETE", session });
export const deleteAccount = (session) => call("/account", { method: "DELETE", session });

// Same shape as the GitHub backend; the version number stands in for the file's sha.
const file = async (res) => ({ sha: res.headers.get("X-Version"), bytes: new Uint8Array(await res.arrayBuffer()) });

// Writes may go out without a read first: a conflict carries the newer file as `current`.
export const writesBlind = true;

// `known` is the copy already held; the server sends the data only when it has a newer one.
export async function readFile(cfg, known) {
  const res = await fetch(`${API}/vault${known ? `?have=${known.sha}` : ""}`, { cache: "no-store", headers: auth(cfg.session) });
  if (res.status === 404) return null;
  if (res.status === 204) return known;
  if (!res.ok) await fail(res, cfg.session);
  return file(res);
}

export async function writeFile(cfg, bytes, sha) {
  const res = await fetch(`${API}/vault?version=${Number(sha ?? 0)}`, {
    method: "PUT",
    cache: "no-store",
    headers: { ...auth(cfg.session), "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  if (res.ok) return res.headers.get("X-Version");
  if (res.status !== 409) await fail(res, cfg.session);
  const err = new ServerError(409, "The data changed since it was read");
  err.current = res.headers.get("X-Version") ? await file(res) : null;
  throw err;
}

// Display only: the server checks the token itself.
export function credentialProfile(credential) {
  const bytes = Uint8Array.from(atob(credential.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const payload = JSON.parse(new TextDecoder().decode(bytes));
  return { sub: payload.sub, email: payload.email ?? "" };
}
