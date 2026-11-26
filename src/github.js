import { toB64, fromB64 } from "./crypto.js";
import { HttpError } from "./http.js";

const API = "https://api.github.com";
const DATA_PATH = "data/habits.enc";
export const DEFAULT_BRANCH = "data";
// For a few seconds after a save GitHub can still serve the file it replaced, or no file.
export const staleReads = true;

const CODES = { 401: "errToken", 403: "errAccess", 404: "errAccess" };

async function call(token, path, { method = "GET", body } = {}) {
  const res = await fetch(API + path, {
    method,
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body && { "Content-Type": "application/json" }),
    },
    body: body && JSON.stringify(body),
  });
  if (res.status === 404 && method === "GET") return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new HttpError(res.status, json.message || res.statusText, CODES[res.status]);
    err.conflict = res.status === 409 || res.status === 422;
    throw err;
  }
  return json;
}

const contents = (repo) => `/repos/${repo}/contents/${DATA_PATH.split("/").map(encodeURIComponent).join("/")}`;

export async function readFile(cfg) {
  const file = await call(cfg.token, `${contents(cfg.repo)}?ref=${encodeURIComponent(cfg.branch)}`);
  return file && { version: file.sha, bytes: fromB64(file.content.replace(/\s/g, "")) };
}

export async function writeFile(cfg, bytes, version) {
  const body = { message: "Update habits", content: toB64(bytes), branch: cfg.branch, ...(version && { sha: version }) };
  return (await call(cfg.token, contents(cfg.repo), { method: "PUT", body })).content.sha;
}

// Habit data lives on its own branch, so saving does not redeploy the site from the default branch.
export async function ensureBranch(cfg) {
  if (await call(cfg.token, `/repos/${cfg.repo}/branches/${encodeURIComponent(cfg.branch)}`)) return;
  const repo = await call(cfg.token, `/repos/${cfg.repo}`);
  if (!repo) throw new HttpError(404, "", "errRepo");
  const head = await call(cfg.token, `/repos/${cfg.repo}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
  if (!head) throw new HttpError(404, "", "errEmptyRepo");
  await call(cfg.token, `/repos/${cfg.repo}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${cfg.branch}`, sha: head.object.sha },
  });
}
