/**
 * Google Scholar through Serply, for a proxy that has a key.
 *
 * Serply (serply.io) has a Scholar search endpoint, but only that: no
 * profiles, no entry of a profile opened, no cluster. What it also has is a
 * page fetch — `POST /v1/request` with a URL — which fetches any page on its
 * own machines and hands back the HTML. Scholar's pages asked for that way
 * are the same pages the proxy would have asked for directly, so they are
 * read by the same parsers in `server/scholar.js`, and every Scholar route
 * works through it: a search, the profile search, a profile's works, a
 * person, one of their works opened, and a paper's versions. The profile
 * search in particular is one SerpApi no longer offers, so a person is found
 * here in one request, with their affiliation and verified email, rather
 * than in the four SerpApi takes.
 *
 * Opt-in, like SerpApi: set `SERPLY_KEY` on the proxy (an environment
 * variable for `npm start`, a secret for the Worker). With both keys set,
 * Serply is asked first and SerpApi is what a Serply refusal falls back to.
 * One credit per page actually fetched; the five-minute cache in
 * `getScholar` applies, so a page already fetched costs nothing more.
 *
 * The key stays on the proxy. It goes only in the header of the request to
 * Serply — never in the page, never in an answer, never in a cache key.
 *
 * Scholar may still refuse whichever of Serply's machines asked. That is
 * told apart from a direct refusal: there is no captcha a person here could
 * solve for Serply's machine, so it is reported as Serply's, not as a
 * captcha to open in a window.
 *
 * Written against web APIs only (fetch, URL, JSON), so the Worker in
 * `worker/index.js` can import it exactly as `server/api.js` does.
 */
import { getScholar, isScholarUrl } from './scholar.js';

export const SERPLY_HOST = 'https://api.serply.io';

/** Where the page is fetched from: an English-speaking region, past Google's consent wall. */
const PROXY_LOCATION = 'US';

// ------------------------------------------------------------- refusals ----

/**
 * What a Serply answer means when it is not a page. Its errors come as a
 * status and, usually, `{ detail: '...' }`: a 401 for a missing or bad key,
 * a 402 or a message about credits for a spent allowance, a 429 for going
 * too fast, and a 502 when its own fetch of the page failed.
 */
export function serplyProblem(status, body) {
  if (status >= 200 && status < 300) return null;
  let detail = '';
  try {
    const json = typeof body === 'string' ? JSON.parse(body) : body;
    detail = String(json?.detail || json?.error || json?.message || '').trim();
  } catch {
    detail = '';
  }
  if (status === 401 || status === 403) {
    return { reason: 'key', message: 'Serply did not accept the key in SERPLY_KEY. Check it on app.serply.io.' };
  }
  if (status === 402 || /credit|quota|exceed/i.test(detail)) {
    return {
      reason: 'rate-limited',
      message: `Serply is refusing for now: ${detail || 'no credits left'}. That is this account's allowance, not Scholar — wait, or search the other sources meanwhile.`,
    };
  }
  if (status === 429) {
    return {
      reason: 'rate-limited',
      message: 'Serply is rate-limiting this proxy. Wait a moment, or search the other sources meanwhile.',
    };
  }
  if (status === 502 || status === 504) {
    return { reason: 'upstream', message: 'Serply could not fetch the Scholar page this time. Try again in a moment.' };
  }
  return { reason: 'serply', message: `Serply answered ${status}${detail ? `: ${detail}` : ''}` };
}

export class SerplyFailed extends Error {
  constructor({ reason, message }) {
    super(message);
    this.reason = reason;
    // Not a refusal a captcha window here would fix.
    this.blocked = false;
    this.serply = true;
  }
}

// ------------------------------------------------------------- fetching ----

/**
 * What Serply's page fetch hands back, as `{ status, html }` for
 * `getScholar`. Asked for `response_type: 'full'`, it answers a JSON object
 * with the page in `data` and Scholar's own status beside it, which is what
 * lets a refusal of Scholar's be told from one of Serply's. Anything else —
 * the plain HTML it gives by default — is taken as the page itself.
 */
export function fromSerplyPage(text) {
  try {
    const json = JSON.parse(text);
    if (json && typeof json.data === 'string') {
      const status = Number(json.status ?? json.status_code);
      return { status: Number.isInteger(status) && status > 0 ? status : 200, html: json.data };
    }
  } catch {
    // Not JSON: the page, as it came.
  }
  return { status: 200, html: String(text || '') };
}

/**
 * A `fetchPage` for `getScholar` that goes through Serply. Only Scholar's
 * own pages: this is not a way for anything else to spend the key. A 502 —
 * Serply's fetch of the page failing — is tried once more before it is
 * reported, as Serply's own advice has it.
 */
export function serplyFetcher(key, { fetchImpl = (...args) => fetch(...args) } = {}) {
  return async (url, { signal } = {}) => {
    if (!isScholarUrl(url)) throw new Error('only a scholar.google.com page is fetched through Serply');
    let problem;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetchImpl(`${SERPLY_HOST}/v1/request`, {
        method: 'POST',
        signal,
        headers: {
          'X-Api-Key': key,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/html;q=0.9',
          // Serply sits behind Cloudflare, which turns away requests with no
          // or a library's User-Agent.
          'User-Agent': 'reader-proxy/1.0',
          'X-Proxy-Location': PROXY_LOCATION,
        },
        body: JSON.stringify({ url, response_type: 'full' }),
      });
      const text = await response.text();
      problem = serplyProblem(response.status, text);
      if (!problem) return fromSerplyPage(text);
      if (problem.reason !== 'upstream') break;
    }
    throw new SerplyFailed(problem);
  };
}

/**
 * One Scholar page through Serply, parsed. `parse` is the route's own
 * parser from `server/scholar.js`. Scholar refusing Serply's machine comes
 * back as a `SerplyFailed`, not a `ScholarBlocked`: the captcha window a
 * direct refusal offers would be solved on this machine, not on Serply's.
 */
export async function askSerply(url, parse, key, { fetchImpl, signal } = {}) {
  try {
    return parse(await getScholar(url, { fetchPage: serplyFetcher(key, fetchImpl ? { fetchImpl } : {}), signal }));
  } catch (error) {
    if (error && error.blocked) {
      throw new SerplyFailed({
        reason: 'scholar-refused',
        message:
          error.reason === 'captcha'
            ? 'Google Scholar served Serply a captcha instead of the page. Try again shortly — Serply asks from another machine each time.'
            : `Google Scholar refused the page Serply asked for (${error.reason}). Try again shortly.`,
      });
    }
    throw error;
  }
}
