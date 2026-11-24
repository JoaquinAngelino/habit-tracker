const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

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
  if (!res.ok) throw new GitHubError(res.status, json.message || res.statusText);
  return json;
}

const contents = ({ repo, path }) => `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;

export async function readFile(cfg) {
  const file = await call(cfg.token, `${contents(cfg)}?ref=${encodeURIComponent(cfg.branch)}`);
  return file && { sha: file.sha, text: atob(file.content.replace(/\s/g, "")) };
}

export async function writeFile(cfg, text, sha) {
  const body = { message: "Update habits", content: btoa(text), branch: cfg.branch, ...(sha && { sha }) };
  return (await call(cfg.token, contents(cfg), { method: "PUT", body })).content.sha;
}

// Habit data lives on its own branch, so saving does not redeploy the site from the default branch.
export async function ensureBranch(cfg) {
  if (await call(cfg.token, `/repos/${cfg.repo}/branches/${encodeURIComponent(cfg.branch)}`)) return;
  const repo = await call(cfg.token, `/repos/${cfg.repo}`);
  if (!repo) throw new GitHubError(404, `Repository ${cfg.repo} not found, or the token cannot see it.`);
  const head = await call(cfg.token, `/repos/${cfg.repo}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
  if (!head) throw new GitHubError(404, `${cfg.repo} has no commits yet.`);
  await call(cfg.token, `/repos/${cfg.repo}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${cfg.branch}`, sha: head.object.sha },
  });
}
