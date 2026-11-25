export const API = "https://habit-tracker.joacoangelino.workers.dev";
export const GOOGLE_CLIENT_ID = "657713120724-h1fovv0r8vjtf539cjmrvlo28ook5tf7.apps.googleusercontent.com";

export class ServerError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call(path, { method = "GET", session, body } = {}) {
  const res = await fetch(API + path, {
    method,
    cache: "no-store",
    headers: {
      ...(session && { Authorization: `Bearer ${session}` }),
      ...(body && { "Content-Type": "application/json" }),
    },
    body: body && JSON.stringify(body),
  });
  if (res.status === 404 && method === "GET") return null;
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (res.status === 401 && session) throw new ServerError(401, json.error, "errSignedOut");
  if (res.status >= 500) throw new ServerError(res.status, json.error, "errServer");
  if (!res.ok) throw new ServerError(res.status, json.error || res.statusText);
  return json;
}

export async function signIn(credential) {
  return call("/session", { method: "POST", body: { credential } });
}

export const signOut = (session) => call("/session", { method: "DELETE", session });
export const deleteAccount = (session) => call("/account", { method: "DELETE", session });

// Same shape as the GitHub backend; the version number stands in for the file's sha.
export async function readFile(cfg) {
  const vault = await call("/vault", { session: cfg.session });
  return vault && { sha: String(vault.version), text: vault.envelope };
}

export async function writeFile(cfg, text, sha) {
  const { version } = await call("/vault", { method: "PUT", session: cfg.session, body: { version: Number(sha ?? 0), envelope: text } });
  return String(version);
}

// Display only: the server checks the token itself.
export function credentialProfile(credential) {
  const bytes = Uint8Array.from(atob(credential.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const payload = JSON.parse(new TextDecoder().decode(bytes));
  return { sub: payload.sub, email: payload.email ?? "" };
}
