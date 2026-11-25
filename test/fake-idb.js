// The slice of IndexedDB that src/idb.js uses, kept in memory. Requests settle on a later tick, like the real one.
export function fakeIndexedDB() {
  const data = new Map();
  const later = (fn) => setTimeout(fn, 0);
  const db = {
    createObjectStore() {},
    transaction() {
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
        steps.forEach((s) => s());
        tx.oncomplete?.();
      });
      return tx;
    },
  };
  return {
    data,
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

export function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}
