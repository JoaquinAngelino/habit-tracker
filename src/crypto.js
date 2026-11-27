export const ITERATIONS = 600_000;
// Iteration counts come from the file; outside this range a hostile file could freeze every device.
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 2_000_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Format 3 layout: format byte, iterations (uint32), 16-byte salt, 12-byte IV, then AES-GCM over gzipped JSON.
const FORMAT = 3;
const SALT_AT = 5;
const IV_AT = SALT_AT + 16;
const IV_BYTES = 12;
const HEADER = IV_AT + IV_BYTES;

export const toB64 = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const toB64url = (bytes) => toB64(new Uint8Array(bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64url = (s) => fromB64(s.replace(/-/g, "+").replace(/_/g, "/"));

const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
export const packJson = (value) => pipe(encoder.encode(JSON.stringify(value)), new CompressionStream("gzip"));
export const unpackJson = async (bytes) => JSON.parse(decoder.decode(await pipe(bytes, new DecompressionStream("gzip"))));

export const newSalt = () => crypto.getRandomValues(new Uint8Array(16));

export async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(value, key, salt, iterations) {
  const head = new Uint8Array(IV_AT);
  head[0] = FORMAT;
  new DataView(head.buffer).setUint32(1, iterations);
  head.set(salt, SALT_AT);
  // Compressed before encrypting, since ciphertext does not compress.
  return encrypt(key, await packJson(value), head);
}

const unrecognized = () => Object.assign(new Error("Unrecognized data file format"), { code: "errFormat" });

export function readEnvelope(bytes) {
  const envelope = parseEnvelope(bytes);
  if (!(envelope.iterations >= MIN_ITERATIONS && envelope.iterations <= MAX_ITERATIONS)) throw unrecognized();
  return envelope;
}

function parseEnvelope(bytes) {
  // Formats 1 and 2 were JSON text with base64 fields; a copy saved back then may still hold them.
  if (bytes[0] === 0x7b) {
    let e;
    try {
      e = JSON.parse(decoder.decode(bytes));
    } catch {
      throw unrecognized();
    }
    if (![1, 2].includes(e?.v) || e.kdf !== "PBKDF2-SHA256" || !e.salt || !e.iv || !e.data) throw unrecognized();
    return { v: e.v, iterations: e.iterations, salt: fromB64(e.salt), iv: fromB64(e.iv), data: fromB64(e.data) };
  }
  if (bytes[0] !== FORMAT || bytes.length <= HEADER) throw unrecognized();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { v: FORMAT, iterations: view.getUint32(1), salt: bytes.slice(SALT_AT, IV_AT), iv: bytes.slice(IV_AT, HEADER), data: bytes.slice(HEADER) };
}

export async function unseal(envelope, key) {
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: envelope.iv }, key, envelope.data));
  // Format 1 was not compressed.
  return envelope.v === 1 ? JSON.parse(decoder.decode(plain)) : unpackJson(plain);
}

// The IV, then the AES-GCM ciphertext.
async function encrypt(key, plain, prefix = new Uint8Array()) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const out = new Uint8Array(prefix.length + IV_BYTES + data.length);
  out.set(prefix);
  out.set(iv, prefix.length);
  out.set(data, prefix.length + IV_BYTES);
  return out;
}

const decrypt = async (key, bytes) =>
  decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, IV_BYTES) }, key, bytes.slice(IV_BYTES)));

// A short text sealed under a secret of its own: a 16-byte salt, then as `encrypt` leaves it.
const WRAP_IV_AT = 16;

export async function wrap(text, secret) {
  const salt = newSalt();
  return encrypt(await deriveKey(secret, salt, ITERATIONS), encoder.encode(text), salt);
}

export const unwrap = async (bytes, secret) => decrypt(await deriveKey(secret, bytes.slice(0, WRAP_IV_AT), ITERATIONS), bytes.slice(WRAP_IV_AT));

// A share link's key is random already, so it is used as it is.
export const newKey = () => toB64url(crypto.getRandomValues(new Uint8Array(32)));
const rawKey = (key) => crypto.subtle.importKey("raw", fromB64url(key), "AES-GCM", false, ["encrypt", "decrypt"]);

export const sealWithKey = async (text, key) => encrypt(await rawKey(key), encoder.encode(text));
export const openWithKey = async (bytes, key) => decrypt(await rawKey(key), bytes);

// Letters and digits that are hard to mix up when copied by hand.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_LENGTH = 24;
// Bytes past the last full run of the alphabet would favour its first letters.
const CODE_BYTE_LIMIT = 256 - (256 % CODE_ALPHABET.length);

export const cleanCode = (text) => text.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const formatCode = (code) => code.replace(/(.{4})(?=.)/g, "$1-");

export function newRecoveryCode() {
  let code = "";
  while (code.length < CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(CODE_LENGTH))) {
      if (b < CODE_BYTE_LIMIT && code.length < CODE_LENGTH) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return code;
}
