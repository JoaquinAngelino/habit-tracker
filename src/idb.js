// A key-value store over IndexedDB. Every call settles quietly, as if empty, when the browser blocks it.
let opening = null;

function open() {
  opening ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open("habit-tracker", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("kv");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

async function run(mode, action) {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", mode);
    const request = action(tx.objectStore("kv"));
    tx.oncomplete = () => resolve(request.result ?? true);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const usable = async () => Boolean(await open());
export const get = (key) => run("readonly", (s) => s.get(key)).catch(() => undefined);
export const set = (key, value) => run("readwrite", (s) => s.put(value, key)).then(Boolean).catch(() => false);
export const remove = (key) => run("readwrite", (s) => s.delete(key)).catch(() => undefined);
