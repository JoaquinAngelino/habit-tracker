import { emptyData, normalize, replay, queue } from "./lib.js";
import { deriveKey, seal, unseal, readEnvelope, newSalt, ITERATIONS } from "./crypto.js";
import * as github from "./github.js";
import * as account from "./server.js";
import { t } from "./i18n.js";

const CACHE_KEY = "ht.cache.v1";
// Every save is a commit, so edits are batched; leaving the app saves sooner.
const SAVE_DELAY = 30_000;
const BACKENDS = { github, account };

function getStorage(kind) {
  try {
    return window[kind];
  } catch {
    return null;
  }
}

export const local = getStorage("localStorage");
export const session = getStorage("sessionStorage");

export function read(store, key) {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function write(store, key, value) {
  try {
    if (value == null) store?.removeItem(key);
    else store?.setItem(key, value);
  } catch {
    /* storage full or blocked: the app still works for this visit */
  }
}

function loadCache() {
  try {
    const saved = JSON.parse(read(local, CACHE_KEY) ?? "{}") ?? {};
    return {
      target: saved.target ?? null,
      base: normalize(saved.base),
      sha: saved.sha ?? null,
      envelope: saved.envelope ?? null,
      replaced: Array.isArray(saved.replaced) ? saved.replaced : [],
      pending: Array.isArray(saved.pending) ? saved.pending : [],
    };
  } catch {
    return { target: null, base: emptyData(), sha: null, envelope: null, replaced: [], pending: [] };
  }
}

function describe(err, repo) {
  if (err?.name === "OperationError") return t("errPassphrase");
  if (err?.code) return t(err.code, { repo, message: err.message });
  if (err?.status === 401) return t("errToken");
  if (err?.status === 403 || err?.status === 404) return t("errAccess", { message: err.message });
  if (err instanceof TypeError) return t("errNetwork");
  return err?.message || String(err);
}

// The local copy is the last synced file plus the edits not yet pushed. Every sync re-reads the
// file and replays those edits on top, so changes made on another device are kept.
export function createStore({ config, onChange, onStatus }) {
  const cache = loadCache();
  let view = replay(cache.base, cache.pending);
  let key = null;
  let keyId = "";
  let timer = 0;
  let running = false;
  let again = false;
  let state = "off";

  const persist = () => write(local, CACHE_KEY, JSON.stringify(cache));

  async function keyFor(cfg, salt, iterations) {
    const id = `${cfg.passphrase}\n${salt}\n${iterations}`;
    if (keyId !== id) {
      key = await deriveKey(cfg.passphrase, salt, iterations);
      keyId = id;
    }
    return key;
  }

  function report(next, message, code) {
    state = next;
    onStatus(next, message, code);
  }

  async function sync() {
    clearTimeout(timer);
    const cfg = config();
    const backend = BACKENDS[cfg.mode];
    if (!backend || !cfg.ready) return report(cache.pending.length ? "local" : "off");
    if (running) {
      again = true;
      return;
    }
    running = true;
    report("syncing");
    // A different repository or account: keep the local data, forget what was read from the old one.
    if (cache.target !== cfg.target) Object.assign(cache, { target: cfg.target, sha: null, envelope: null, replaced: [] });
    try {
      for (let attempt = 0; ; attempt++) {
        let remote = await backend.readFile(cfg);
        // For a few seconds after a save GitHub can still serve the version it replaced, or no file.
        const stale = cfg.mode === "github" && cache.envelope && (!remote || cache.replaced.includes(remote.sha));
        if (stale) remote = { sha: cache.sha, text: cache.envelope };
        const envelope = remote && readEnvelope(remote.text);
        const salt = envelope?.salt ?? newSalt();
        const iterations = envelope?.iterations ?? ITERATIONS;
        const key = await keyFor(cfg, salt, iterations);
        const base = envelope ? normalize(await unseal(envelope, key)) : cache.base;
        const sent = cache.pending;
        const next = replay(base, sent);
        const replaced = [...cache.replaced];
        let sha = remote?.sha ?? null;
        let text = remote?.text ?? null;
        if (sent.length || (!remote && (next.habits.length || next.tasks.length))) {
          if (!remote) await backend.ensureBranch?.(cfg);
          text = await seal(next, key, salt, iterations);
          try {
            const written = await backend.writeFile(cfg, text, sha);
            if (sha) replaced.push(sha);
            sha = written;
          } catch (err) {
            if ((err.status === 409 || err.status === 422) && attempt < 4) {
              await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
              continue;
            }
            throw err;
          }
        }
        if (cache.sha && sha !== cache.sha && !replaced.includes(cache.sha)) replaced.push(cache.sha);
        Object.assign(cache, {
          base: next,
          sha,
          envelope: text,
          replaced: replaced.slice(-20),
          pending: cache.pending.filter((op) => !sent.includes(op)),
        });
        view = replay(cache.base, cache.pending);
        persist();
        onChange();
        report(cache.pending.length ? "local" : "synced");
        break;
      }
    } catch (err) {
      report("error", describe(err, cfg.repo), err?.code);
    } finally {
      running = false;
      if (again) {
        again = false;
        sync();
      }
    }
  }

  return {
    data: () => view,
    // `quiet` skips the re-render, for fields still being typed in.
    commit(op, { quiet = false } = {}) {
      cache.pending = queue(cache.pending, op);
      view = replay(cache.base, cache.pending);
      persist();
      if (!quiet) onChange();
      if (state !== "error" && state !== "syncing") report("local");
      clearTimeout(timer);
      timer = setTimeout(sync, SAVE_DELAY);
    },
    sync,
    hasPending: () => cache.pending.length > 0,
  };
}
