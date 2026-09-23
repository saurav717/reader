// Papers on OpenReview, fetched the way OpenReview means programs to.
//
// openreview.net answers an anonymous fetch of a paper's PDF with a 403 and
// sends the browser to a check of its own — /challenge?redirect=/pdf?id=…,
// "Verifying your browser", with Cloudflare's Turnstile box inside. It is
// not Cloudflare's challenge page, so it carries no `cf-mitigated` header,
// but it is Cloudflare's box, and from the Worker's browser — Cloudflare's
// own, which Cloudflare tells every site is a bot — it never passes: the
// box ticks, says "Verification hiccup, retrying…", and comes back. So an
// OpenReview URL is asked for from OpenReview's API instead (the one its
// own Python client talks to), on api2.openreview.net for the venues of its
// current API and api.openreview.net for the older ones, which serve a
// note's PDF at /pdf?id=… — signed in, where the proxy has an account,
// since the check now stands in front of an anonymous request there too.
//
// Web APIs only: the Worker imports this file too.

const HOSTS = new Set(['openreview.net', 'api.openreview.net', 'api2.openreview.net']);
const ID = /^[A-Za-z0-9_-]{5,40}$/;

/**
 * The note a URL of OpenReview's names — `/pdf?id=`, `/forum?id=`,
 * `/attachment?id=`, or the `/challenge?redirect=` page that stands in
 * front of any of them — as `{ id, name }`, `name` being the attachment's
 * field when it is not the paper itself. Null for any other URL.
 */
export function openReviewNoteIn(target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!HOSTS.has(host)) return null;
  if (/^\/challenge\/?$/i.test(url.pathname)) {
    const redirect = url.searchParams.get('redirect');
    if (!redirect || !redirect.startsWith('/')) return null;
    return openReviewNoteIn(new URL(redirect, 'https://openreview.net/').href);
  }
  const route = url.pathname.replace(/\/+$/, '').toLowerCase();
  if (!['/pdf', '/forum', '/attachment'].includes(route)) return null;
  const id = url.searchParams.get('id') || '';
  if (!ID.test(id)) return null;
  const name = route.endsWith('/attachment') ? url.searchParams.get('name') || '' : '';
  if (name && !/^[A-Za-z0-9_-]{1,40}$/.test(name)) return null;
  return { id, name: name && name !== 'pdf' ? name : '' };
}

/**
 * The URLs on OpenReview's API that serve the file an OpenReview URL
 * names, in the order worth trying — or none, when the URL is not
 * OpenReview's. The current API first, since that is where every venue of
 * the last few years lives; the old one for the venues before it.
 */
export function openReviewFiles(target) {
  const note = openReviewNoteIn(target);
  if (!note) return [];
  const query = note.name
    ? `attachment?id=${encodeURIComponent(note.id)}&name=${encodeURIComponent(note.name)}`
    : `pdf?id=${encodeURIComponent(note.id)}`;
  return [`https://api2.openreview.net/${query}`, `https://api.openreview.net/${query}`];
}

/**
 * Whether a URL is OpenReview's check for a person: the page openreview.net
 * sends a browser to instead of the one it asked for.
 */
export function isOpenReviewChallenge(target) {
  try {
    const url = new URL(target);
    return url.hostname.toLowerCase().replace(/^www\./, '') === 'openreview.net' && /^\/challenge\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

// ------------------------------------------------------- signed in ----
//
// Since September 2026 OpenReview puts its check in front of the API too:
// an anonymous GET of /pdf?id=… on either host answers 403
// ChallengeRequiredError, from a home address as from the Worker. A
// signed-in request does not meet it — the check page itself says "Have an
// OpenReview account? Sign in to skip this check" — and the API signs a
// program in the way its own Python client does: POST /login with the
// account's email and password, and a bearer token back. So with an
// account given to the proxy (OPENREVIEW_USERNAME and OPENREVIEW_PASSWORD,
// secrets on the Worker, the environment for the Node proxy) each API is
// signed in to once, its token kept, and signed in to again when a request
// says the token has expired.

/** The account the proxy signs in to OpenReview with, or null. */
export function openReviewAccount(env) {
  const id = String(env?.OPENREVIEW_USERNAME || '').trim();
  const password = String(env?.OPENREVIEW_PASSWORD || '');
  return id && password ? { id, password } : null;
}

/** Tokens by API host and account, kept for as long as this instance lives. */
const tokens = new Map();

/**
 * How long each ask of the API — a sign-in, or a file, body and all — may
 * take. Without one an API that stops answering held the request open
 * until the browser gave up on it, and Safari says only "Load failed".
 */
export const OPENREVIEW_TIMEOUT_MS = 30_000;

/** A signal that fires after `ms`, where the runtime has one. */
function deadline(ms) {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

/** What a failed ask said, with a deadline run out said as one. */
function failure(error, ms) {
  const name = error?.name || '';
  if (name === 'TimeoutError' || name === 'AbortError') return `did not answer within ${Math.ceil(ms / 1000)} s`;
  return String(error?.message || error);
}

async function signIn(host, account, { fetch, userAgent, timeoutMs }) {
  let response;
  try {
    response = await fetch(`https://${host}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': userAgent },
      body: JSON.stringify({ id: account.id, password: account.password }),
      signal: deadline(timeoutMs),
    });
  } catch (error) {
    throw new Error(`${host} would not sign the account in (${failure(error, timeoutMs)})`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.token !== 'string' || !body.token) {
    const why = [body?.name, body?.message].filter(Boolean).join(': ') || `answered ${response.status}`;
    throw new Error(`${host} would not sign the account in (${why})`);
  }
  return body.token;
}

async function refusal(response) {
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  return typeof body?.name === 'string' ? body.name : '';
}

/**
 * The file an OpenReview URL names, from OpenReview's API: `{ response }`
 * with the API's answer when one handed it over, else `{ response: null,
 * said }` with what each host answered, for the error. Signed in when the
 * proxy has an account (`env`), anonymously otherwise.
 */
export async function fetchOpenReview(target, { env, fetch = globalThis.fetch, userAgent, timeoutMs = OPENREVIEW_TIMEOUT_MS } = {}) {
  const account = openReviewAccount(env);
  const said = [];
  for (const file of openReviewFiles(target)) {
    const host = new URL(file).hostname;
    const key = `${host} ${account?.id || ''}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const headers = { 'User-Agent': userAgent, Accept: 'application/pdf,*/*' };
      if (account) {
        let token = tokens.get(key);
        if (!token) {
          try {
            token = await signIn(host, account, { fetch, userAgent, timeoutMs });
          } catch (error) {
            said.push(String(error?.message || error));
            break;
          }
          tokens.set(key, token);
        }
        headers.Authorization = `Bearer ${token}`;
      }
      let response;
      try {
        // The deadline covers the body too, which the caller reads after.
        response = await fetch(file, { headers, signal: deadline(timeoutMs) });
      } catch (error) {
        said.push(`${host} ${failure(error, timeoutMs)}`);
        break;
      }
      if (response.ok) return { response, said };
      const name = await refusal(response);
      // An expired token is signed in again, once; anything else is the answer.
      if (account && response.status === 401 && attempt === 0) {
        tokens.delete(key);
        continue;
      }
      said.push(`${host} answered ${response.status}${name ? ` (${name})` : ''}`);
      break;
    }
  }
  return { response: null, said };
}

/** Whether what the API said is its check for a person, which an account gets past. */
export function saidChallenge(said) {
  return said.some((line) => /ChallengeRequiredError/.test(line));
}
