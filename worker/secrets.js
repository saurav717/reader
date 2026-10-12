// People's secrets kept by this Worker — an Overleaf account's Git token and
// email, a GitHub token and its login — sealed so that what is in KV is of
// no use to anyone who reads it, and of none to anyone else's account.
//
//   - One secret of its own, SECRETS_KEY, sealing nothing but these: not a
//     secret that also opens anything else (the compiler's bearer token), so
//     neither gives the other away, and either can be rotated on its own.
//
//         openssl rand -base64 32 | npx wrangler secret put SECRETS_KEY
//
//   - A key for each person and each kind of secret, derived from it (HKDF,
//     the person and the purpose as its info), and the same two bound into
//     every seal as AES-GCM's additional data: a sealed value copied into
//     another person's record, or used as another kind, does not open.
//   - KV keys name no one: a person's record is filed under a keyed hash of
//     their email (HMAC-SHA-256 with a key derived from SECRETS_KEY), not the
//     email itself.
//   - Without SECRETS_KEY nothing new is kept: the routes say what is missing
//     rather than fall back to a weaker key.
//
// Overleaf tokens kept before this (sealed with a key derived from
// LATEX_CLOUD_RUN_TOKEN, filed under the plain email) still open, and are
// sealed again the new way, and moved, the first time they are read.

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/** Whether this Worker can keep secrets: SECRETS_KEY set, and long enough to be a key. */
export function secretsReady(env) {
  return String(env.SECRETS_KEY || '').trim().length >= 32;
}

export const SECRETS_MISSING = 'Reader’s server can’t keep tokens yet: it needs its SECRETS_KEY secret (openssl rand -base64 32 | npx wrangler secret put SECRETS_KEY).';

async function master(env) {
  return crypto.subtle.importKey('raw', enc.encode(String(env.SECRETS_KEY || '').trim()), 'HKDF', false, ['deriveKey', 'deriveBits']);
}

/** The key one person's secrets of one kind are sealed with. */
async function sealKey(env, owner, purpose) {
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('reader-secrets-v2'), info: enc.encode(`${purpose}\n${owner}`) },
    await master(env),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** A value sealed for `owner`, as `purpose`: `{"v":2,"iv":…,"data":…}`. */
export async function sealSecret(env, owner, purpose, value) {
  if (!secretsReady(env)) throw new Error(SECRETS_MISSING);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`${purpose}\n${owner}`) }, await sealKey(env, owner, purpose), enc.encode(String(value))));
  return JSON.stringify({ v: 2, iv: b64(iv), data: b64(data) });
}

/** The value back — null when it isn't one sealed for this owner and purpose, or the key changed. */
export async function openSecret(env, owner, purpose, sealed) {
  if (!sealed || !secretsReady(env)) return null;
  try {
    const { v, iv, data } = JSON.parse(sealed);
    if (v !== 2) return null;
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(`${purpose}\n${owner}`) }, await sealKey(env, owner, purpose), unb64(data)));
  } catch {
    return null;
  }
}

/** Whether a stored value is sealed the current way. */
export const sealedNow = (sealed) => {
  try {
    return JSON.parse(sealed)?.v === 2;
  } catch {
    return false;
  }
};

/** Where a person's record of `kind` is kept in KV: by a keyed hash of their email, never the email. */
export async function secretsKey(env, kind, owner) {
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('reader-secrets-v2'), info: enc.encode('kv-names') }, await master(env), 256);
  const mac = await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', mac, enc.encode(String(owner).toLowerCase())));
  return `${kind}:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** How long a secret not used is kept: then it is forgotten, as a token nobody uses should be. */
export const UNUSED_DAYS = 180;
const DAY_MS = 24 * 3600_000;

/** Whether a record last used (or added) at `at` has gone unused too long. */
export const unusedTooLong = (at, now = Date.now()) => Boolean(at) && now - Date.parse(at) > UNUSED_DAYS * DAY_MS;

/** Whether a "last used" is worth writing again: at most once a day, so a sync doesn't write KV each time. */
export const staleUse = (at, now = Date.now()) => !at || now - Date.parse(at) > DAY_MS;
