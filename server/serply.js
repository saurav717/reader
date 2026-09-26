/**
 * Google Scholar through Serply, for a proxy that has a key.
 *
 * Two of Serply's endpoints are used, because each gets through where the
 * other does not:
 *
 * - Its Scholar endpoint (`GET /v1/scholar`) answers JSON for a search
 *   results page, and Scholar answers it: a search, a search for a person's
 *   papers (which is how people are found — every byline names the authors
 *   with a profile, and their ids), and a paper's versions. Those three go
 *   there, mapped onto the shapes the direct parsers produce.
 * - Its page fetch (`POST /v1/request`) fetches any page on Serply's
 *   machines. Scholar mostly answers those with its 403 "Sorry…" page, so it
 *   is only the last resort for the pages the Scholar endpoint cannot give —
 *   a profile, a person, an entry opened — when there is no SerpApi key to
 *   ask instead.
 *
 * Opt-in, like SerpApi: set `SERPLY_KEY` on the proxy (an environment
 * variable for `npm start`, a secret for the Worker). With a SerpApi key as
 * well, SerpApi takes the profile pages and whatever Serply refuses. One
 * credit per request; answers are cached for five minutes.
 *
 * The key stays on the proxy. It goes only in the header of the request to
 * Serply — never in the page, never in an answer, never in a cache key.
 *
 * Written against web APIs only (fetch, URL, JSON), so the Worker in
 * `worker/index.js` can import it exactly as `server/api.js` does.
 */
import { getScholar, isScholarUrl, parseByline, SCHOLAR_HOST } from './scholar.js';
import { nameCouldBe } from './serpapi.js';

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

// ------------------------------------------------ the Scholar endpoint ----

/** The asks Serply's Scholar endpoint can answer: results pages, all of them. */
export const SERPLY_KINDS = new Set(['search', 'authors', 'versions']);

/** The request for each, with the key left for the header. */
export function serplyScholarUrl(kind, params) {
  const query = new URLSearchParams({ hl: 'en' });
  switch (kind) {
    case 'search':
      query.set('q', params.query);
      query.set('num', '10');
      if (params.start) query.set('start', String(params.start));
      break;
    case 'authors':
      // A search for the person's papers: each byline names the authors who
      // have a profile, with their ids — what the profile search gave.
      query.set('q', `author:"${params.name}"`);
      query.set('num', '20');
      break;
    case 'versions':
      // Scholar's own parameter, passed through as the endpoint passes the rest.
      query.set('q', '');
      query.set('cluster', params.cluster);
      query.set('num', '20');
      break;
    default:
      throw new Error(`no Serply Scholar request for ${kind}`);
  }
  return `${SERPLY_HOST}/v1/scholar?${query}`;
}

const str = (value) => (typeof value === 'string' ? value.trim() : '');
const list = (value) => (Array.isArray(value) ? value : []);
const count = (value) => {
  const parsed = Number(String(value ?? '').replace(/[^\d]/g, ''));
  return parsed > 0 ? parsed : undefined;
};
const absolute = (href) => (href && href.startsWith('/') ? `${SCHOLAR_HOST}${href}` : href || undefined);
const userOf = (link) => (str(link).match(/[?&]user=([\w-]+)/) || [])[1];
const clusterOf = (link) => (str(link).match(/[?&]cluster=(\d+)/) || [])[1];
const hostOf = (link) => {
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
};

/**
 * One page of Serply's Scholar results, as `parseResults` would have read
 * the page: `articles[]`, each with `doc` (the file beside it), `author`
 * (the byline, and the authors with a profile), and `extras` (cited by, and
 * the versions with the cluster in their link).
 */
export function fromSerplyResults(json) {
  return list(json?.articles)
    .map((entry) => {
      const byline = parseByline(str(entry?.author?.names) || str(entry?.description));
      const profiled = list(entry?.author?.authors);
      const file = /^https?:/i.test(str(entry?.doc?.link)) ? str(entry.doc.link) : '';
      const versions = entry?.extras?.versions || {};
      return {
        id: str(entry?.id) || undefined,
        title: str(entry?.title).replace(/^\[(?:PDF|HTML|BOOK|B|CITATION|C)\]\s*/i, ''),
        url: absolute(str(entry?.link)),
        pdfUrl: file || undefined,
        pdfKind: file ? str(entry?.doc?.type).toUpperCase() || undefined : undefined,
        pdfHost: file ? hostOf(file) : undefined,
        authors: byline.authors.length ? byline.authors : profiled.map((author) => str(author?.name)).filter(Boolean),
        authorIds: profiled
          .map((author) => ({ name: str(author?.name), userId: userOf(author?.link) }))
          .filter((author) => author.name && author.userId),
        venue: byline.venue,
        year: byline.year,
        snippet: str(entry?.snippet) || str(entry?.abstract) || '',
        citedBy: count(entry?.extras?.citations?.count),
        clusterId: clusterOf(versions.link),
        versionCount: count(versions.count),
      };
    })
    .filter((result) => result.title);
}

/**
 * The people a search for a name's papers turns up: every author in a
 * byline with a profile whose name could be the one asked for, once each,
 * most often seen first. No affiliation or email — those are on the
 * profile, which this endpoint does not give.
 */
export function fromSerplyAuthors(json, name) {
  const seen = new Map();
  for (const entry of list(json?.articles)) {
    for (const author of list(entry?.author?.authors)) {
      const userId = userOf(author?.link);
      if (!userId || !nameCouldBe(author?.name, name)) continue;
      const found = seen.get(userId);
      if (found) found.worksSeen += 1;
      else {
        seen.set(userId, {
          userId,
          name: str(author?.name),
          profileUrl: `${SCHOLAR_HOST}/citations?hl=en&user=${encodeURIComponent(userId)}`,
          affiliation: undefined,
          verifiedEmail: undefined,
          interests: [],
          citedBy: undefined,
          worksSeen: 1,
        });
      }
    }
  }
  return Array.from(seen.values())
    .sort((a, b) => b.worksSeen - a.worksSeen)
    .map(({ worksSeen, ...person }) => person);
}

const CACHE_MS = 5 * 60 * 1000;
const CACHE_MAX = 60;
const cache = new Map();

export function forgetSerply() {
  cache.clear();
}

/**
 * One ask of Serply's Scholar endpoint, mapped. `fetchImpl` is how the
 * request is made, so a test can hand in saved answers. A 502 is tried once
 * more, as for the page fetch.
 */
export async function askSerplyScholar(kind, params, key, { fetchImpl = (...args) => fetch(...args), signal } = {}) {
  const url = serplyScholarUrl(kind, params);
  const hit = cache.get(url);
  let json = hit && Date.now() - hit.at < CACHE_MS ? hit.json : undefined;
  if (!json) {
    let problem;
    for (let attempt = 0; attempt < 2 && !json; attempt += 1) {
      const response = await fetchImpl(url, {
        signal,
        headers: {
          'X-Api-Key': key,
          Accept: 'application/json',
          'User-Agent': 'reader-proxy/1.0',
          'X-Proxy-Location': PROXY_LOCATION,
        },
      });
      const text = await response.text();
      problem = serplyProblem(response.status, text);
      if (!problem) {
        try {
          json = JSON.parse(text);
        } catch {
          problem = { reason: 'serply', message: 'Serply answered with something that was not JSON' };
          break;
        }
      } else if (problem.reason !== 'upstream') break;
    }
    if (!json) throw new SerplyFailed(problem);
    cache.set(url, { json, at: Date.now() });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return kind === 'authors' ? fromSerplyAuthors(json, params.name) : fromSerplyResults(json);
}
