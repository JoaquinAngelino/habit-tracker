export const ITERATIONS = 600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toB64 = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

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
  // Compressed before encrypting, since ciphertext does not compress. Version 1 files are not compressed.
  const plain = await pipe(encoder.encode(JSON.stringify(value)), new CompressionStream("gzip"));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  const envelope = { v: 2, kdf: "PBKDF2-SHA256", iterations, salt, iv: toB64(iv), data: toB64(new Uint8Array(data)) };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function readEnvelope(text) {
  const envelope = JSON.parse(text);
  if (![1, 2].includes(envelope?.v) || envelope.kdf !== "PBKDF2-SHA256" || !envelope.salt || !envelope.iv || !envelope.data) {
    throw Object.assign(new Error("Unrecognized data file format."), { code: "errFormat" });
  }
  return envelope;
}

export async function unseal(envelope, key) {
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(envelope.iv) }, key, fromB64(envelope.data)));
  return JSON.parse(decoder.decode(envelope.v === 1 ? plain : await pipe(plain, new DecompressionStream("gzip"))));
}
