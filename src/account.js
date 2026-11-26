import { toB64url, fromB64url } from "./crypto.js";
import { VAPID_PUBLIC_KEY, passkeyChallenge, passkeyRegister, passkeySignIn, setReminders } from "./server.js";

// Local times of day, as "HH:MM", in minutes of the UTC day. They shift with daylight saving, so they are sent again on each visit.
export function utcMinutes(times, now = new Date()) {
  const minutes = times.map((time) => {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +time.slice(0, 2), +time.slice(3, 5));
    return at.getUTCHours() * 60 + at.getUTCMinutes();
  });
  return [...new Set(minutes)].sort((a, b) => a - b);
}

export const canRemind = () => Boolean(VAPID_PUBLIC_KEY) && "PushManager" in globalThis && "serviceWorker" in navigator;

const subscription = async () => (await navigator.serviceWorker.ready).pushManager.getSubscription();

// Subscribes this device to pushes at `minutes`.
export async function setDeviceReminders(session, minutes) {
  if (Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") {
    throw Object.assign(new Error("Notifications are blocked"), { code: "errNotify" });
  }
  const registration = await navigator.serviceWorker.ready;
  const current = (await subscription()) ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC_KEY }));
  await setReminders(session, current.endpoint, minutes);
}

export async function stopDeviceReminders(session) {
  const current = await subscription();
  if (!current) return;
  await setReminders(session, current.endpoint, []);
  await current.unsubscribe();
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
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      attestation: "none",
    },
  });
  const body = { credentialId: credential.id, publicKey: toB64url(credential.response.getPublicKey()), clientDataJSON: toB64url(credential.response.clientDataJSON) };
  return passkeyRegister(body, session);
}

export async function usePasskey() {
  const { challenge } = await passkeyChallenge();
  const { id, response } = await navigator.credentials.get({ publicKey: { challenge: fromB64url(challenge), rpId: location.hostname, userVerification: "required" } });
  return passkeySignIn({
    credentialId: id,
    authenticatorData: toB64url(response.authenticatorData),
    clientDataJSON: toB64url(response.clientDataJSON),
    signature: toB64url(response.signature),
  });
}
