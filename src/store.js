import { emptyData, normalize, replay, queue, applyOp, toOps } from "./lib.js";
import { deriveKey, seal, unseal, readEnvelope, newSalt, packJson, unpackJson, ITERATIONS } from "./crypto.js";
import * as idb from "./idb.js";
import * as github from "./github.js";
import * as account from "./server.js";
import { t } from "./i18n.js";

// The synced copy lives compressed in IndexedDB, which has room for years of data; earlier versions kept it here.
const LEGACY_CACHE_KEY = "ht.cache.v1";
const SYNCED_KEY = "synced";
// The short list of unsynced edits stays in localStorage, which saves synchronously on every edit.
const PENDING_KEY = "ht.pending.v1";
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

const emptyCache = () => ({ target: null, base: emptyData(), sha: null, envelope: null, replaced: [], pending: [] });

function legacyCache() {
  try {
    return JSON.parse(read(local, LEGACY_CACHE_KEY)) ?? null;
  } catch {
    return null;
  }
}

function loadPending() {
  try {
    const pending = JSON.parse(read(local, PENDING_KEY));
    if (Array.isArray(pending)) return pending;
  } catch {
    /* fall back to the copy saved with the legacy cache */
  }
  const legacy = legacyCache();
  return Array.isArray(legacy?.pending) ? legacy.pending : [];
}

async function loadSynced() {
  try {
    const saved = await idb.get(SYNCED_KEY);
    if (saved) return { target: saved.target, sha: saved.sha, envelope: saved.envelope, replaced: saved.replaced, base: normalize(await unpackJson(saved.base)) };
  } catch {
    /* an unreadable copy: the next sync fetches it again */
  }
  const legacy = legacyCache();
  if (!legacy) return null;
  return {
    target: legacy.target ?? null,
    sha: legacy.sha ?? null,
    envelope: legacy.envelope ? new TextEncoder().encode(legacy.envelope) : null,
    replaced: Array.isArray(legacy.replaced) ? legacy.replaced : [],
    base: normalize(legacy.base),
    legacy: true,
  };
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
  const cache = { ...emptyCache(), pending: loadPending() };
  let view = replay(cache.base, cache.pending);
  let saving = Promise.resolve();
  let persistent = false;
  let key = null;
  let keyId = "";
  let timer = 0;
  let running = null;
  let again = false;
  let state = "off";
  let epoch = 0;

  // Saves run in order. The synced copy goes first: if the page dies between the two writes, edits are replayed again, never lost.
  const queueSave = (step) => (saving = saving.then(step).catch(() => false));
  const savePending = () => queueSave(() => write(local, PENDING_KEY, JSON.stringify(cache.pending)));
  function persist() {
    const { pending, ...synced } = cache;
    return queueSave(async () => {
      const saved = await idb.set(SYNCED_KEY, { ...synced, base: await packJson(synced.base) });
      write(local, PENDING_KEY, JSON.stringify(pending));
      return saved;
    });
  }

  const ready = (async () => {
    persistent = await idb.usable();
    const saved = await loadSynced();
    if (!saved) return;
    const { legacy, ...synced } = saved;
    Object.assign(cache, synced);
    view = replay(cache.base, cache.pending);
    if (legacy && (await persist())) write(local, LEGACY_CACHE_KEY, null);
  })();

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

  // Resolves once the local edits made so far have been pushed, or the attempt failed.
  function sync() {
    clearTimeout(timer);
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      await ready;
      do {
        again = false;
        await once();
      } while (again);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  async function once() {
    const cfg = config();
    const backend = BACKENDS[cfg.mode];
    if (!backend || !cfg.ready) {
      // With nowhere to sync, edits are folded into the device copy so their list stays short.
      // A detached copy is merged as edits into whatever it syncs with next.
      if (persistent && (cfg.mode === "none" || cache.target === null) && (cache.pending.length || cache.target)) {
        Object.assign(cache, emptyCache(), { base: replay(cache.base, cache.pending) });
        await persist();
      }
      return report(cfg.mode === "none" || cache.pending.length ? "local" : "off");
    }
    const start = epoch;
    report("syncing");
    if (cache.target !== cfg.target) {
      // Another person's account must never receive this device's data; a repository or a first account may.
      const otherAccount = cache.target?.startsWith("account:") && cfg.target.startsWith("account:");
      const pending = otherAccount ? [] : [...toOps(cache.base), ...cache.pending];
      Object.assign(cache, emptyCache(), { target: cfg.target, pending });
      view = replay(cache.base, cache.pending);
      persist();
      if (otherAccount) onChange();
    }
    try {
      const known = cache.envelope ? { sha: cache.sha, bytes: cache.envelope } : null;
      // Edits on top of a copy already held go straight to the write; a conflict hands back the newer data.
      let remote = backend.writesBlind && known && cache.pending.length ? known : await backend.readFile(cfg, known);
      for (let attempt = 0; ; attempt++) {
        // For a few seconds after a save GitHub can still serve the version it replaced, or no file.
        if (cfg.mode === "github" && known && (!remote || cache.replaced.includes(remote.sha))) remote = known;
        const envelope = remote && readEnvelope(remote.bytes);
        const salt = envelope?.salt ?? newSalt();
        const iterations = envelope?.iterations ?? ITERATIONS;
        const key = await keyFor(cfg, salt, iterations);
        const base = envelope ? normalize(await unseal(envelope, key)) : cache.base;
        const sent = cache.pending;
        const next = replay(base, sent);
        const replaced = [...cache.replaced];
        let sha = remote?.sha ?? null;
        let bytes = remote?.bytes ?? null;
        if (sent.length || (!remote && (next.habits.length || next.tasks.length))) {
          if (!remote) await backend.ensureBranch?.(cfg);
          bytes = await seal(next, key, salt, iterations);
          try {
            const written = await backend.writeFile(cfg, bytes, sha);
            if (sha) replaced.push(sha);
            sha = written;
          } catch (err) {
            if (!(err.status === 409 || err.status === 422) || attempt >= 4) throw err;
            if ("current" in err) remote = err.current;
            else {
              await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
              remote = await backend.readFile(cfg, known);
            }
            continue;
          }
        }
        if (start !== epoch) return;
        if (cache.sha && sha !== cache.sha && !replaced.includes(cache.sha)) replaced.push(cache.sha);
        Object.assign(cache, {
          base: next,
          sha,
          envelope: bytes,
          replaced: replaced.slice(-20),
          pending: cache.pending.filter((op) => !sent.includes(op)),
        });
        view = replay(cache.base, cache.pending);
        await persist();
        onChange();
        report(cache.pending.length ? "local" : "synced");
        break;
      }
    } catch (err) {
      if (start === epoch) report("error", describe(err, cfg.repo), err?.code);
    }
  }

  return {
    data: () => view,
    // `quiet` skips the re-render, for fields still being typed in.
    commit(op, { quiet = false } = {}) {
      cache.pending = queue(cache.pending, op);
      // Replaying every edit on a copy of the whole history grows slow with the years; an edit only overwrites.
      view = applyOp(view, op);
      savePending();
      if (!quiet) onChange();
      if (state !== "error" && state !== "syncing") report("local");
      clearTimeout(timer);
      timer = setTimeout(sync, SAVE_DELAY);
    },
    sync,
    // Resolves once the device copy has loaded; render after it.
    ready,
    hasPending: () => cache.pending.length > 0,
    // Drops everything this device holds; a sync still in flight is discarded when it returns.
    reset() {
      clearTimeout(timer);
      epoch++;
      Object.assign(cache, emptyCache());
      view = replay(cache.base, cache.pending);
      key = null;
      keyId = "";
      queueSave(async () => {
        await idb.remove(SYNCED_KEY);
        write(local, LEGACY_CACHE_KEY, null);
        write(local, PENDING_KEY, null);
      });
      onChange();
    },
  };
}
