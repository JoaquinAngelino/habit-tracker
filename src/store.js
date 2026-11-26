import { emptyData, normalize, replay, queue, applyOp, merge, hasData } from "./lib.js";
import { deriveKey, seal, unseal, readEnvelope, newSalt, packJson, unpackJson, toB64, fromB64, ITERATIONS } from "./crypto.js";
import * as idb from "./idb.js";
import { readFile, writeFile } from "./server.js";
import { local, read, write } from "./storage.js";

const COPY_KEY = "synced";
// The device copy before IndexedDB, and still where IndexedDB fails.
const LOCAL_COPY_KEY = "ht.cache.v1";
// Unsynced edits stay in localStorage, which saves synchronously on every edit.
const PENDING_KEY = "ht.pending.v1";
// Touched on every save to IndexedDB, which other tabs cannot observe, so they know to reload.
const CHANGED_KEY = "ht.changed";
// Batch edits: each save is a server request.
const SAVE_DELAY = 30_000;
// Phones hide and show the app often; checking on every return would burn server requests.
const REFRESH_AFTER = 120_000;
// Edits made with sync off, after syncing, wait to be replayed onto that target; past this many they fold into the copy.
const MAX_DETACHED_EDITS = 2_000;
const MIN_PASSPHRASE = 8;
// Copies saved before targets were recorded came from somewhere unknown, so they are never merged into a target.
const UNKNOWN_TARGET = "unknown";

// `target` is where `base`, `version` and `bytes` came from; null means data that never synced.
// `owner` is the account the data belongs to; it survives switching to no sync.
const emptyCopy = () => ({ target: null, owner: null, merging: false, version: null, bytes: null, base: emptyData() });

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function loadPending() {
  const saved = parse(read(local, PENDING_KEY));
  const pending = Array.isArray(saved) ? saved : [];
  // A tab still running a version from before IndexedDB keeps its edits inside the old copy.
  const legacy = parse(read(local, LOCAL_COPY_KEY));
  if (!legacy?.format && Array.isArray(legacy?.pending)) {
    const seen = new Set(pending.map((op) => JSON.stringify(op)));
    pending.push(...legacy.pending.filter((op) => !seen.has(JSON.stringify(op))));
  }
  return pending;
}

function fromSaved(saved, bytes, base) {
  const version = saved.version ?? saved.sha ?? null;
  return {
    target: saved.target ?? (version ? UNKNOWN_TARGET : null),
    owner: saved.owner ?? (saved.target?.startsWith("account:") ? saved.target : null),
    merging: Boolean(saved.merging),
    version,
    bytes,
    base: normalize(base),
  };
}

// Throws when IndexedDB holds a copy it cannot read.
async function loadCopy() {
  const saved = parse(read(local, LOCAL_COPY_KEY));
  // Written only when IndexedDB failed, so it is newer than anything there.
  if (saved?.format === 2) return { ...fromSaved(saved, saved.bytes && fromB64(saved.bytes), saved.base), migrate: true };
  const stored = await idb.get(COPY_KEY);
  if (stored) return fromSaved(stored, stored.bytes ?? stored.envelope ?? null, await unpackJson(stored.base));
  if (saved) return { ...fromSaved(saved, saved.envelope ? new TextEncoder().encode(saved.envelope) : null, saved.base), migrate: true };
  return null;
}

// The local copy is the last synced file plus the edits not yet pushed. Every sync replays those edits on
// top of the newest file, so changes made on another device are kept.
export function createStore({ config, onChange, onStatus }) {
  let cache = { ...emptyCopy(), pending: loadPending() };
  let view = replay(cache.base, cache.pending);
  let generation = 0;
  const touched = new Map();
  let useIdb = false;
  let saving = Promise.resolve(true);
  let cachedKey = null;
  let keyId = "";
  let timer = 0;
  let running = null;
  let resyncQueued = false;
  let state = "off";
  let resets = 0;
  let checkedAt = 0;
  let stale = false;

  let edits = 0;

  function setView(next) {
    view = next;
    generation++;
    edits++;
    touched.clear();
  }

  const savePending = () => write(local, PENDING_KEY, JSON.stringify(cache.pending));

  // Saves run one at a time, in order. Resolves true once the copy is stored where a reload finds it.
  function saveCopy(copy = cache) {
    const { pending, ...fields } = copy;
    saving = saving
      .then(async () => {
        if (useIdb && (await idb.set(COPY_KEY, { ...fields, base: await packJson(fields.base) }))) {
          write(local, LOCAL_COPY_KEY, null);
          write(local, CHANGED_KEY, String(Math.random()));
          return true;
        }
        useIdb = false;
        // With no storage at all nothing survives a reload, so there is nothing to keep in step.
        if (!local) return true;
        return write(local, LOCAL_COPY_KEY, JSON.stringify({ ...fields, bytes: fields.bytes && toB64(fields.bytes), format: 2 }));
      })
      .catch(() => false);
    return saving;
  }

  async function load(rereadPending) {
    useIdb = await idb.usable();
    let copy = null;
    try {
      copy = await loadCopy();
    } catch {
      // Never overwrite a copy that could not be read; this visit saves to localStorage instead.
      useIdb = false;
    }
    const { migrate, ...fields } = copy ?? {};
    cache = { ...emptyCopy(), ...fields, pending: rereadPending ? loadPending() : cache.pending };
    setView(replay(cache.base, cache.pending));
    stale = false;
    if (migrate && (await saveCopy())) savePending();
  }

  let loading = load(false);

  // Another tab saved: this one reloads before it shows or saves anything stale.
  async function reload() {
    resets++;
    loading = load(true);
    await loading;
    onChange();
  }
  globalThis.addEventListener?.("storage", (e) => {
    if (![PENDING_KEY, CHANGED_KEY, LOCAL_COPY_KEY, null].includes(e.key)) return;
    stale = true;
    if (globalThis.document?.visibilityState === "visible") reload();
  });

  async function keyFor(cfg, salt, iterations) {
    const id = `${cfg.passphrase}\n${salt}\n${iterations}`;
    if (keyId !== id) {
      cachedKey = await deriveKey(cfg.passphrase, salt, iterations);
      keyId = id;
    }
    return cachedKey;
  }

  function report(next, err) {
    state = next;
    onStatus(next, err);
  }

  function synced() {
    checkedAt = Date.now();
    report(cache.pending.length ? "local" : "synced");
  }

  // Resolves once the local edits made so far have been pushed, or the attempt failed.
  function sync() {
    clearTimeout(timer);
    if (running) {
      resyncQueued = true;
      return running;
    }
    running = (async () => {
      await loading;
      do {
        resyncQueued = false;
        await syncPass();
      } while (resyncQueued);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  // With nowhere to sync, edits fold into the device copy so their list stays short.
  async function idle(cfg) {
    const start = resets;
    const detach = cache.target === null || (cfg.mode === "none" && cache.pending.length > MAX_DETACHED_EDITS);
    if (detach && cache.pending.length && !stale) {
      const folded = new Set(cache.pending);
      const copy = { ...cache, target: null, version: null, bytes: null, merging: false, base: replay(cache.base, cache.pending) };
      if ((await saveCopy(copy)) && start === resets) {
        cache = { ...copy, pending: cache.pending.filter((op) => !folded.has(op)) };
        savePending();
      }
    }
    report(cfg.mode === "none" || cache.pending.length || hasData(cache.base) ? "local" : "off");
  }

  function switchTarget(cfg) {
    // Another person's account must never receive this device's data.
    if (cfg.mode === "account" && cache.owner && cache.owner !== cfg.target) {
      cache = { ...emptyCopy(), pending: [] };
      savePending();
      setView(replay(cache.base, []));
      onChange();
    }
    // Data that never synced is merged into the new target; a copy of another target is not, since that
    // target still holds it, and merging it would bring back whatever was deleted there since.
    Object.assign(cache, {
      target: cfg.target,
      owner: cfg.mode === "account" ? cfg.target : cache.owner,
      merging: cache.target === null && hasData(cache.base),
      version: null,
      bytes: null,
    });
    saveCopy();
  }

  async function syncPass() {
    const cfg = config();
    if (cfg.mode !== "account" || !cfg.ready) return idle(cfg);
    const start = resets;
    report("syncing");
    if (cache.target !== cfg.target) switchTarget(cfg);
    try {
      const held = cache.bytes ? { version: cache.version, bytes: cache.bytes } : null;
      // Edits on top of a copy already held go straight to the write; a conflict hands back the newer data.
      let remote = held && cache.pending.length ? held : await readFile(cfg, held);
      if (held && remote === held && !cache.pending.length && !cache.merging) return synced();
      for (let attempt = 0; ; attempt++) {
        if (start !== resets) return;
        const envelope = remote && readEnvelope(remote.bytes);
        const salt = envelope?.salt ?? newSalt();
        const iterations = envelope?.iterations ?? ITERATIONS;
        const key = await keyFor(cfg, salt, iterations);
        const remoteData = envelope && normalize(await unseal(envelope, key));
        const base = !remoteData ? cache.base : cache.merging ? merge(remoteData, cache.base) : remoteData;
        const sent = cache.pending;
        const next = replay(base, sent);
        let version = remote?.version ?? null;
        let bytes = remote?.bytes ?? null;
        if (sent.length || (cache.merging && remoteData) || (!remote && hasData(next))) {
          // The first save fixes the passphrase for good, so a weak one is refused before it happens.
          if (!remote && cfg.passphrase.length < MIN_PASSPHRASE) throw Object.assign(new Error("Passphrase too short"), { code: "errWeakPassphrase" });
          bytes = await seal(next, key, salt, iterations);
          if (start !== resets) return;
          try {
            version = await writeFile(cfg, bytes, version);
          } catch (err) {
            if (!err.conflict || attempt >= 4) throw err;
            // The refusal carries the newer file.
            remote = err.current;
            continue;
          }
        }
        // Results are dropped after a sign-out, or when another tab saved meanwhile; the server has them.
        if (start !== resets || stale) return;
        const pushed = new Set(sent);
        const unsent = () => cache.pending.filter((op) => !pushed.has(op));
        Object.assign(cache, { base: next, version, bytes, merging: false });
        setView(replay(next, unsent()));
        // Pushed edits leave the list only once the copy holding them is saved.
        if ((await saveCopy()) && start === resets) {
          cache.pending = unsent();
          savePending();
        }
        onChange();
        return synced();
      }
    } catch (err) {
      if (start === resets) report("error", err);
    }
  }

  function touch(op) {
    // Breaks and imports can change any habit's stats.
    if (op.t === "break" || op.t === "delBreak" || op.t === "import") generation++;
    const id = op.t === "log" || op.t === "skip" || op.t === "delHabit" ? op.id : op.habit?.id;
    if (id) touched.set(id, (touched.get(id) ?? 0) + 1);
  }

  return {
    data: () => view,
    // Changes whenever the data may have.
    version: () => edits,
    // Changes whenever anything that habit's stats read may have changed.
    revision: (habitId) => `${generation}:${touched.get(habitId) ?? 0}`,
    // `quiet` skips the re-render, for fields still being typed in.
    commit(op, { quiet = false } = {}) {
      cache.pending = queue(cache.pending, op);
      view = applyOp(view, op);
      edits++;
      touch(op);
      // An edit list too big for the browser to keep would be lost on the next reload.
      if (!savePending() && local) onStatus("error", { code: "errStorage" });
      if (!quiet) onChange();
      if (state !== "error" && state !== "syncing") report("local");
      clearTimeout(timer);
      timer = setTimeout(sync, SAVE_DELAY);
    },
    sync,
    refresh(now = Date.now()) {
      return cache.pending.length || now - checkedAt >= REFRESH_AFTER ? sync() : Promise.resolve();
    },
    ready: () => loading,
    reload,
    // Resolves once every queued save has finished.
    saved: () => saving,
    hasPending: () => cache.pending.length > 0,
    // Drops everything this device holds; a sync still in flight is discarded when it returns.
    reset() {
      clearTimeout(timer);
      resets++;
      cache = { ...emptyCopy(), pending: [] };
      setView(replay(cache.base, []));
      cachedKey = null;
      keyId = "";
      write(local, PENDING_KEY, null);
      saving = saving
        .then(async () => {
          await idb.remove(COPY_KEY);
          write(local, LOCAL_COPY_KEY, null);
          write(local, CHANGED_KEY, String(Math.random()));
          return true;
        })
        .catch(() => false);
      onChange();
      return saving;
    },
  };
}
