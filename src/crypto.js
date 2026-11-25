export const ITERATIONS = 600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toB64 = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const newSalt = () => toB64(crypto.getRandomValues(new Uint8Array(16)));

export async function deriveKey(passphrase, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: fromB64(salt), iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(value, key, salt, iterations = ITERATIONS) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(value)));
  const envelope = { v: 1, kdf: "PBKDF2-SHA256", iterations, salt, iv: toB64(iv), data: toB64(new Uint8Array(data)) };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function readEnvelope(text) {
  const envelope = JSON.parse(text);
  if (envelope?.v !== 1 || envelope.kdf !== "PBKDF2-SHA256" || !envelope.salt || !envelope.iv || !envelope.data) {
    throw Object.assign(new Error("Unrecognized data file format."), { code: "errFormat" });
  }
  return envelope;
}

export async function unseal(envelope, key) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(envelope.iv) }, key, fromB64(envelope.data));
  return JSON.parse(decoder.decode(plain));
}
