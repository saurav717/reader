/**
 * Google Scholar through SerpApi, for a proxy that has a key.
 *
 * SerpApi (serpapi.com) fetches Scholar's pages on its own machines and
 * answers with JSON, so a proxy that goes through it is never the one Scholar
 * shows a captcha to. That makes it the way Scholar works from anywhere that
 * looks like a server — the Cloudflare Worker above all, which Scholar
 * refuses nearly always. It costs money past a free allowance, one search per
 * page asked for, and it needs a key, which is why it is opt-in: set
 * `SERPAPI_KEY` on the proxy (an environment variable for `npm start`, a
 * secret for the Worker) and every Scholar route here goes through it; leave
 * it unset and the proxy asks Scholar directly as before.
 *
 * The key stays on the proxy. It never goes in the page, which anyone can
 * read, and never in an answer.
 *
 * Everything below maps SerpApi's answers onto the same shapes the direct
 * parsers in `server/scholar.js` produce, so nothing downstream knows which
 * was asked. The field names are SerpApi's documented ones; like Scholar's
 * markup they are not a contract, so the mapping returns nothing rather than
 * nonsense when a field is missing, and `scripts/serpapi.test.mjs` pins it to
 * saved answers.
 *
 * Written against web APIs only (fetch, URL, string), so the Worker in
 * `worker/index.js` can import it exactly as `server/api.js` does.
 */
import { parseByline, SCHOLAR_HOST } from './scholar.js';

export const SERPAPI_HOST = 'https://serpapi.com';

// ------------------------------------------------------------- the asks ----

/**
 * The SerpApi request for each of the four pages the proxy asks Scholar for.
 * `kind` is the route's name, `params` what it was given.
 */
export function serpUrl(kind, params, key) {
  const query = new URLSearchParams({ api_key: key, hl: 'en' });
  switch (kind) {
    case 'search':
      query.set('engine', 'google_scholar');
      query.set('q', params.query);
      query.set('num', '10');
      if (params.start) query.set('start', String(params.start));
      break;
    case 'authors':
      query.set('engine', 'google_scholar_profiles');
      query.set('mauthors', params.name);
      break;
    case 'profile':
      query.set('engine', 'google_scholar_author');
      query.set('author_id', params.user);
      query.set('sort', 'pubdate');
      query.set('num', '20');
      if (params.start) query.set('start', String(params.start));
      break;
    case 'versions':
      query.set('engine', 'google_scholar');
      query.set('cluster', params.cluster);
      query.set('num', '20');
      break;
    default:
      throw new Error(`no SerpApi request for ${kind}`);
  }
  return `${SERPAPI_HOST}/search.json?${query}`;
}

/** The same request with the key blanked, for logs and cache keys. */
export const withoutKey = (url) => url.replace(/api_key=[^&]*/, 'api_key=…');

// ---------------------------------------------------------- the mapping ----

const str = (value) => (typeof value === 'string' ? value.trim() : '');
const num = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? '').replace(/[^\d]/g, ''));
  return parsed > 0 ? parsed : undefined;
};
const list = (value) => (Array.isArray(value) ? value : []);
const absolute = (href) => (href && href.startsWith('/') ? `${SCHOLAR_HOST}${href}` : href || undefined);

/**
 * One page of results — a search or a cluster, which SerpApi answers with
 * the same `organic_results` — as `parseResults` would have read it.
 */
export function fromSerpResults(json) {
  return list(json?.organic_results)
    .map((entry) => {
      const info = entry?.publication_info || {};
      const byline = parseByline(str(info.summary));
      const named = list(info.authors)
        .map((author) => str(author?.name))
        .filter(Boolean);
      // The right-hand column: a direct link to a file, where Scholar found one.
      const file = list(entry?.resources).find((resource) => /^https?:/i.test(str(resource?.link)));
      const links = entry?.inline_links || {};
      const versions = links.versions || {};
      return {
        id: str(entry?.result_id) || undefined,
        title: str(entry?.title),
        url: absolute(str(entry?.link)),
        pdfUrl: file ? str(file.link) : undefined,
        pdfKind: file && str(file.file_format) ? str(file.file_format).toUpperCase() : undefined,
        pdfHost: file ? str(file.title) || undefined : undefined,
        // The summary line names every author (up to Scholar's ellipsis); the
        // `authors` array only those with a profile, so it is the fallback.
        authors: byline.authors.length ? byline.authors : named,
        venue: byline.venue,
        year: byline.year,
        snippet: str(entry?.snippet),
        citedBy: num(links.cited_by?.total),
        clusterId: str(versions.cluster_id) || undefined,
        versionCount: num(versions.total),
      };
    })
    .filter((result) => result.title);
}

/** Scholar's profile search, as `parseAuthors` would have read it. */
export function fromSerpAuthors(json) {
  return list(json?.profiles)
    .map((entry) => {
      const userId = str(entry?.author_id) || undefined;
      return {
        userId,
        name: str(entry?.name),
        profileUrl:
          absolute(str(entry?.link)) || (userId ? `${SCHOLAR_HOST}/citations?hl=en&user=${encodeURIComponent(userId)}` : undefined),
        affiliation: str(entry?.affiliations) || undefined,
        verifiedEmail: (str(entry?.email).match(/Verified email at (\S+)/i) || [])[1],
        interests: list(entry?.interests)
          .map((interest) => (typeof interest === 'string' ? interest.trim() : str(interest?.title)))
          .filter(Boolean),
        citedBy: num(entry?.cited_by),
      };
    })
    .filter((author) => author.name);
}

/** A profile's own list of works, as `parseProfileWorks` would have read it. */
export function fromSerpWorks(json) {
  return list(json?.articles)
    .map((entry) => {
      const publication = str(entry?.publication);
      return {
        title: str(entry?.title),
        url: absolute(str(entry?.link)),
        authors: str(entry?.authors)
          .split(/,\s*/)
          .map((name) => name.replace(/…|\.\.\./g, '').trim())
          .filter(Boolean),
        venue: publication.replace(/,?\s*\b(1[89]\d\d|20\d\d)\b\s*$/, '').trim() || undefined,
        year: num(str(entry?.year)) || (publication.match(/\b(1[89]\d\d|20\d\d)\b/) || []).map(Number)[1],
        citedBy: num(entry?.cited_by?.value),
      };
    })
    .filter((work) => work.title);
}

/** The mapping for each kind of ask. */
export const fromSerp = {
  search: fromSerpResults,
  versions: fromSerpResults,
  authors: fromSerpAuthors,
  profile: fromSerpWorks,
};

// ------------------------------------------------------------- refusals ----

/**
 * What SerpApi's answer means when it is not results. Its own convention is
 * an `error` string in the JSON, whatever the status: a bad key, a spent
 * allowance, and — not a failure at all — "Google hasn't returned any
 * results for this query", which is an empty page and is returned as one.
 */
export function serpProblem(json, status) {
  const error = str(json?.error);
  if (/hasn't returned any results|no results/i.test(error)) return null;
  if (status === 401 || /invalid api key|api_key/i.test(error)) {
    return { reason: 'key', message: 'SerpApi did not accept the key in SERPAPI_KEY. Check it on serpapi.com/manage-api-key.' };
  }
  if (status === 429 || /exceed|quota|rate limit|too many/i.test(error)) {
    return {
      reason: 'rate-limited',
      message: `SerpApi is refusing for now: ${error || 'rate-limited'}. That is this account's allowance, not Scholar — wait, or search the other sources meanwhile.`,
    };
  }
  if (error) return { reason: 'serpapi', message: `SerpApi answered with an error: ${error}` };
  if (status >= 400) return { reason: 'serpapi', message: `SerpApi answered ${status}` };
  return null;
}

export class SerpFailed extends Error {
  constructor({ reason, message }) {
    super(message);
    this.reason = reason;
    // Not a Scholar refusal: no captcha to show, nothing a window would fix.
    this.blocked = false;
    this.serpapi = true;
  }
}

// ------------------------------------------------------------- fetching ----

/**
 * A short cache, as for the direct pages: a person typing in the search box
 * should not spend the allowance on the first word twice. Keyed without the
 * key, and holding the mapped answers rather than SerpApi's, which are large.
 */
const CACHE_MS = 5 * 60 * 1000;
const CACHE_MAX = 60;
const cache = new Map();

export function forgetSerp() {
  cache.clear();
}

/** The plain way: one HTTPS request, JSON back. */
export async function plainFetchJson(url, { signal } = {}) {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  let json = {};
  try {
    json = await response.json();
  } catch {
    json = {};
  }
  return { status: response.status, json };
}

/**
 * One ask of SerpApi, mapped. `fetchJson` is how the request is made, so a
 * test can hand in saved answers.
 */
export async function askSerp(kind, params, key, { fetchJson = plainFetchJson, signal } = {}) {
  const url = serpUrl(kind, params, key);
  const cacheKey = withoutKey(url);
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;
  const { status, json } = await fetchJson(url, { signal });
  const problem = serpProblem(json, status);
  if (problem) throw new SerpFailed(problem);
  const results = fromSerp[kind](json);
  cache.set(cacheKey, { results, at: Date.now() });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return results;
}
