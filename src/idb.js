// A key-value store over IndexedDB. When the browser blocks it, reads find nothing and writes return false;
// a failed read rejects, so a copy that exists but cannot be read is never mistaken for none.
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
  if (!db) return { blocked: true };
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", mode);
    const request = action(tx.objectStore("kv"));
    tx.oncomplete = () => resolve({ result: request.result });
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const usable = async () => Boolean(await open());
export const get = async (key) => (await run("readonly", (s) => s.get(key))).result;
export const set = (key, value) => run("readwrite", (s) => s.put(value, key)).then((r) => !r.blocked).catch(() => false);
export const remove = (key) => run("readwrite", (s) => s.delete(key)).then((r) => !r.blocked).catch(() => false);
