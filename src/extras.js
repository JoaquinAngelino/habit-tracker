import { addDays, weekStart, streak, rate, level } from "./lib.js";
import { VAPID_PUBLIC_KEY, passkeyChallenge, passkeyRegister, passkeySignIn, setReminders } from "./server.js";

export const SHARED_WEEKS = 12;

const b64url = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export const randomKey = (bytes = 16) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

// Letters and digits that are hard to mix up when copied by hand.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_LENGTH = 24;

export const cleanCode = (text) => text.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const formatCode = (code) => code.replace(/(.{4})(?=.)/g, "$1-");

export function newRecoveryCode() {
  let code = "";
  while (code.length < CODE_LENGTH) {
    // Bytes past the last full run of the alphabet would favour its first letters.
    for (const b of crypto.getRandomValues(new Uint8Array(CODE_LENGTH))) if (b < 240 && code.length < CODE_LENGTH) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  }
  return code;
}

// What a share link shows: names, streaks, the 30-day rate and recent days. No notes, amounts or tasks.
export function buildShare(data, habits, today, name = "") {
  const first = addDays(weekStart(today), -7 * (SHARED_WEEKS - 1));
  return {
    v: 1,
    name,
    updated: today,
    habits: habits.map((habit) => ({
      name: habit.name,
      avoid: habit.type === "avoid",
      streak: streak(data, habit, today),
      rate: rate(data, habit, today, 30),
      cells: Array.from({ length: SHARED_WEEKS * 7 }, (_, i) => (addDays(first, i) > today ? null : level(data, habit, addDays(first, i), today))),
    })),
  };
}

// Local times of day, as "HH:MM", in minutes of the UTC day. They shift with daylight saving, so they are sent again on each visit.
export function utcMinutes(times, now = new Date()) {
  const minutes = times.map((time) => {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +time.slice(0, 2), +time.slice(3, 5));
    return at.getUTCHours() * 60 + at.getUTCMinutes();
  });
  return [...new Set(minutes)].sort((a, b) => a - b);
}

export const canRemind = () => Boolean(VAPID_PUBLIC_KEY) && "PushManager" in globalThis && "serviceWorker" in navigator;

// Subscribes this device to pushes at `minutes`, or with `on` false takes it off the list.
export async function syncReminders(session, minutes, on) {
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!on) {
    if (!subscription) return;
    await setReminders(session, subscription.endpoint, []);
    await subscription.unsubscribe();
    return;
  }
  if (Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") {
    throw Object.assign(new Error("Notifications are blocked"), { code: "errNotify" });
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC_KEY });
  await setReminders(session, subscription.endpoint, minutes);
}

// The challenge goes to the browser as bytes; it hands them back, encoded as the server sent them, inside clientDataJSON.
export async function createPasskey(session) {
  const { challenge } = await passkeyChallenge();
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: fromB64url(challenge),
      rp: { name: "Habit Tracker", id: location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "Habit Tracker", displayName: "Habit Tracker" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      attestation: "none",
    },
  });
  const body = { credentialId: credential.id, publicKey: b64url(credential.response.getPublicKey()), clientDataJSON: b64url(credential.response.clientDataJSON) };
  return passkeyRegister(body, session);
}

export async function usePasskey() {
  const { challenge } = await passkeyChallenge();
  const { id, response } = await navigator.credentials.get({ publicKey: { challenge: fromB64url(challenge), rpId: location.hostname, userVerification: "preferred" } });
  return passkeySignIn({
    credentialId: id,
    authenticatorData: b64url(response.authenticatorData),
    clientDataJSON: b64url(response.clientDataJSON),
    signature: b64url(response.signature),
  });
}
