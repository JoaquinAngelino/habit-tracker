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

// False when the browser refuses the write: storage full or blocked.
export function write(store, key, value) {
  try {
    if (value == null) store?.removeItem(key);
    else store?.setItem(key, value);
    return Boolean(store);
  } catch {
    return false;
  }
}
