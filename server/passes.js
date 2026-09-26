/**
 * A pass to this proxy for anyone signed in with Google — so nobody has to
 * paste READER_TOKEN into Settings.
 *
 * The proxy's paid and personal routes (Scholar through Serply or SerpApi,
 * the browser inside the reader, kept sign-ins) want to know that a request
 * comes from someone the owner is paying for. The owner's answer is: anyone
 * who signs in with Google. So the app hands this proxy the Google access
 * token of whoever is signed in, once; the proxy asks Google whose it is
 * and that it was issued to this app (`GOOGLE_CLIENT_ID`), and answers with
 * a pass of its own — the person's email and an expiry, signed with
 * READER_TOKEN. The app keeps the pass where a pasted token would go, and
 * sends it the same way. Google's token lasts an hour; the pass lasts
 * thirty days, so a person signs in once a month at most, and not every
 * time Google's token runs out.
 *
 * Changing READER_TOKEN changes the key, and every pass stops working at
 * once. READER_TOKEN itself still works as it always has, for the owner and
 * the scripts.
 *
 * Only the pass travels after the first request; the Google token is sent
 * once, and to this proxy alone. Web APIs only (fetch, crypto.subtle), so
 * the Worker imports it.
 */

export const PASS_DAYS = 30;
const PASS_PREFIX = 'rp1.';
const GOOGLE_TOKENINFO = 'https://oauth2.googleapis.com/tokeninfo';

const encoder = new TextEncoder();

const base64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const fromBase64url = (text) => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};

/** The signing key, from the secret — never the secret itself on the wire. */
function key(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(`reader-pass:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** A pass for `email`, good for thirty days. */
export async function issuePass(email, secret, now = Date.now()) {
  const payload = base64url(encoder.encode(JSON.stringify({ e: email, x: Math.floor(now / 1000) + PASS_DAYS * 86400 })));
  const signature = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(payload));
  return `${PASS_PREFIX}${payload}.${base64url(signature)}`;
}

/**
 * Whose pass this is, or null: signed with this secret, and not expired.
 * The signature is checked by crypto.subtle.verify, which compares in
 * constant time.
 */
export async function readPass(pass, secret, now = Date.now()) {
  if (!secret || typeof pass !== 'string' || !pass.startsWith(PASS_PREFIX)) return null;
  const [payload, signature] = pass.slice(PASS_PREFIX.length).split('.');
  if (!payload || !signature) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await key(secret), fromBase64url(signature), encoder.encode(payload));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
    if (typeof claims.e !== 'string' || typeof claims.x !== 'number' || claims.x * 1000 <= now) return null;
    return { email: claims.e, expires: claims.x * 1000 };
  } catch {
    return null;
  }
}

export const isPass = (value) => typeof value === 'string' && value.startsWith(PASS_PREFIX);

/**
 * Whether an email may have a pass. Anyone may, unless the owner has named
 * who in READER_EMAILS — addresses, or `@domain` for everyone at one —
 * separated by commas or spaces. Checked when a pass is given and again
 * whenever one is used, so taking someone off the list ends their pass.
 */
export function emailAllowed(email, list) {
  const names = String(list || '')
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (!names.length) return true;
  const address = String(email || '').toLowerCase();
  return names.some((name) => (name.startsWith('@') ? address.endsWith(name) : address === name));
}

/**
 * Whose Google access token this is, as Google says: the verified email,
 * provided the token was issued to this app's client ID — a token some
 * other site obtained for the same person is not a sign-in to this one.
 * Null for anything else.
 */
export async function googleEmail(accessToken, clientId, { fetchImpl = (...args) => fetch(...args) } = {}) {
  if (!accessToken || !clientId) return null;
  const response = await fetchImpl(`${GOOGLE_TOKENINFO}?access_token=${encodeURIComponent(accessToken)}`);
  if (!response.ok) return null;
  const info = await response.json().catch(() => ({}));
  const forThisApp = info.aud === clientId || info.azp === clientId;
  const verified = info.email_verified === true || info.email_verified === 'true';
  const live = Number(info.expires_in) > 0;
  return forThisApp && verified && live && typeof info.email === 'string' ? info.email.toLowerCase() : null;
}
