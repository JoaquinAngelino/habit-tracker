import { emptyData, normalize, replay, queue } from "./lib.js";
import { deriveKey, seal, unseal, readEnvelope, newSalt, ITERATIONS } from "./crypto.js";
import { readFile, writeFile, ensureBranch } from "./github.js";
import { t } from "./i18n.js";

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
      envelope: saved.envelope ?? null,
      replaced: Array.isArray(saved.replaced) ? saved.replaced : [],
      pending: Array.isArray(saved.pending) ? saved.pending : [],
    };
  } catch {
    return { base: emptyData(), sha: null, envelope: null, replaced: [], pending: [] };
  }
}

function describe(err, repo) {
  if (err?.name === "OperationError") return t("errPassphrase");
  if (err?.code) return t(err.code, { repo });
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
        let remote = await readFile(cfg);
        // For a few seconds after a save GitHub can still serve the version it replaced, or no file.
        if (cache.envelope && (!remote || cache.replaced.includes(remote.sha))) remote = { sha: cache.sha, text: cache.envelope };
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
        if (sent.length || (!remote && next.habits.length)) {
          if (!remote) await ensureBranch(cfg);
          text = await seal(next, key, salt, iterations);
          try {
            const written = await writeFile(cfg, text, sha);
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
        onStatus("synced");
        break;
      }
    } catch (err) {
      onStatus("error", describe(err, cfg.repo));
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
