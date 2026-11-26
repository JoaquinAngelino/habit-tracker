// The slice of IndexedDB that src/idb.js uses, kept in memory. Requests settle on a later tick, like the real one.
// `fail.reads` and `fail.writes` make transactions of that kind error out.
export function fakeIndexedDB() {
  const data = new Map();
  const fail = { reads: false, writes: false };
  const later = (fn) => setTimeout(fn, 0);
  const db = {
    createObjectStore() {},
    transaction(store, mode) {
      const steps = [];
      const step = (fn) => {
        const request = {};
        steps.push(() => (request.result = fn()));
        return request;
      };
      const tx = {
        objectStore: () => ({
          get: (key) => step(() => structuredClone(data.get(key))),
          put: (value, key) => step(() => (data.set(key, structuredClone(value)), key)),
          delete: (key) => step(() => void data.delete(key)),
        }),
      };
      later(() => {
        if (mode === "readwrite" ? fail.writes : fail.reads) return tx.onerror?.();
        steps.forEach((s) => s());
        tx.oncomplete?.();
      });
      return tx;
    },
  };
  return {
    data,
    fail,
    open() {
      const request = { result: db };
      later(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

// `full` makes every write throw, like a browser over its quota.
export function fakeStorage() {
  const map = new Map();
  const quota = { full: false };
  return {
    map,
    quota,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      if (quota.full) throw new Error("QuotaExceededError");
      map.set(key, String(value));
    },
    removeItem: (key) => map.delete(key),
  };
}
