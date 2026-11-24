import { emptyData, normalize, replay, queue } from "./lib.js";
import { deriveKey, seal, unseal, readEnvelope, newSalt } from "./crypto.js";
import { readFile, writeFile, ensureBranch } from "./github.js";

const CACHE_KEY = "ht.cache.v1";

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
      base: normalize(saved.base),
      sha: saved.sha ?? null,
      salt: saved.salt ?? null,
      pending: Array.isArray(saved.pending) ? saved.pending : [],
    };
  } catch {
    return { base: emptyData(), sha: null, salt: null, pending: [] };
  }
}

function describe(err) {
  if (err?.name === "OperationError") return "Wrong passphrase: the data file could not be decrypted.";
  if (err?.status === 401) return "GitHub rejected the token.";
  if (err?.status === 403 || err?.status === 404) return `${err.message} Check the repository name and that the token has Contents read and write.`;
  if (err instanceof TypeError) return "GitHub could not be reached.";
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

  const persist = () => write(local, CACHE_KEY, JSON.stringify(cache));

  async function keyFor(cfg, salt, iterations) {
    const id = `${cfg.passphrase}\n${salt}\n${iterations}`;
    if (keyId !== id) {
      key = await deriveKey(cfg.passphrase, salt, iterations);
      keyId = id;
    }
    return key;
  }

  async function sync() {
    clearTimeout(timer);
    const cfg = config();
    if (!cfg.repo || !cfg.token || !cfg.passphrase) return onStatus(cache.pending.length ? "local" : "off");
    if (running) {
      again = true;
      return;
    }
    running = true;
    onStatus("syncing");
    try {
      for (let attempt = 0; ; attempt++) {
        const remote = await readFile(cfg);
        let base = cache.base;
        let salt = cache.salt ?? newSalt();
        let iterations;
        if (remote) {
          const envelope = readEnvelope(remote.text);
          ({ salt, iterations } = envelope);
          base = normalize(await unseal(envelope, await keyFor(cfg, salt, iterations)));
        }
        const sent = cache.pending;
        const next = replay(base, sent);
        let sha = remote?.sha ?? null;
        if (sent.length || (!remote && next.habits.length)) {
          if (!remote) await ensureBranch(cfg);
          try {
            sha = await writeFile(cfg, await seal(next, await keyFor(cfg, salt, iterations), salt, iterations), sha);
          } catch (err) {
            if ((err.status === 409 || err.status === 422) && attempt < 3) continue;
            throw err;
          }
        }
        Object.assign(cache, { base: next, sha, salt, pending: cache.pending.filter((op) => !sent.includes(op)) });
        view = replay(cache.base, cache.pending);
        persist();
        onChange();
        onStatus("synced");
        break;
      }
    } catch (err) {
      onStatus("error", describe(err));
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
      clearTimeout(timer);
      timer = setTimeout(sync, 2000);
    },
    sync,
    hasPending: () => cache.pending.length > 0,
  };
}
