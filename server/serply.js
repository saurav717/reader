/**
 * Google Scholar through Serply, for a proxy that has a key.
 *
 * Serply (serply.io) has two endpoints Scholar answers, and between them
 * they stand in for every Scholar page the proxy asks for:
 *
 * - Its Scholar endpoint (`GET /v1/scholar`) answers a results page as JSON:
 *   each result's file, byline, authors with a profile (and their ids),
 *   citations, and cluster. A search and a paper's versions are that page.
 * - Its Google endpoint (`GET /v1/search`) finds Scholar's profile pages the
 *   way Google indexes them: the title is the person's full name, and the
 *   line under it their affiliation, "Cited by N", and their interests.
 *
 * What Scholar's own profile pages gave is rebuilt from those:
 *
 * - people: Google's profile pages for the name, then every author with a
 *   profile in the bylines of a search for their papers;
 * - a profile's works: a Scholar search for the person's papers, kept to
 *   those whose byline links this very profile — each with its file and
 *   cluster, which the profile's own list never had — ordered newest or
 *   most cited first;
 * - a person: who they are from Google's profile page, and their most
 *   cited works as above. The h-index and i10-index are printed nowhere
 *   but the profile page itself, which Scholar refuses Serply, so they are
 *   left out rather than guessed.
 * - an entry opened: not answerable — there is no title to search by, only
 *   an id. It is refused as Serply's, and the app then finds the paper by
 *   its title, which is what it does whenever that page is refused.
 *
 * Serply's page fetch (`POST /v1/request`) is not used: tried live, Scholar
 * answers it with its 403 "Sorry…" page, and each try costs a credit.
 *
 * Opt-in, like SerpApi: set `SERPLY_KEY` on the proxy (an environment
 * variable for `npm start`, a secret for the Worker). One credit per
 * request; answers are cached for five minutes. The key stays on the
 * proxy — only in the header of the request to Serply, never in an
 * address, an answer or a cache key.
 *
 * Written against web APIs only (fetch, URL, JSON), so the Worker in
 * `worker/index.js` can import it exactly as `server/api.js` does.
 */
import { parseByline, SCHOLAR_HOST } from './scholar.js';
import { nameCouldBe } from './serpapi.js';

export const SERPLY_HOST = 'https://api.serply.io';

/** Where Serply asks from: an English-speaking region, past Google's consent wall. */
const PROXY_LOCATION = 'US';

/** Every Scholar ask the proxy has; Serply answers each, one way or another. */
export const SERPLY_KINDS = new Set(['search', 'authors', 'versions', 'profile', 'person', 'work']);

/**
 * The asks SerpApi answers better, when there is its key too: it reads the
 * profile page itself — every work, the h-index, the entry opened — where
 * Serply can only rebuild them from searches.
 */
export const SERPAPI_BETTER = new Set(['profile', 'person', 'work']);

// ------------------------------------------------------------- refusals ----

/**
 * What a Serply answer means when it is not an answer. Its errors come as a
 * status and, usually, `{ detail: '...' }`: a 401 for a missing or bad key,
 * a 402 or a message about credits for a spent allowance, a 429 for going
 * too fast, and a 502 when its own fetch from Google failed.
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
    return { reason: 'rate-limited', message: 'Serply is rate-limiting this proxy. Wait a moment, or search the other sources meanwhile.' };
  }
  if (status === 502 || status === 504) {
    return { reason: 'upstream', message: 'Serply could not get an answer from Google this time. Try again in a moment.' };
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

// ------------------------------------------------------------- the asks ----

/** A Scholar results page: a search, a person's papers, or a cluster. */
export function serplyScholarUrl({ q, start, cluster, num = 10 }) {
  const query = new URLSearchParams({ hl: 'en', q: q || '' });
  if (cluster) query.set('cluster', cluster);
  query.set('num', String(num));
  if (start) query.set('start', String(start));
  return `${SERPLY_HOST}/v1/scholar?${query}`;
}

/** A Google search, for Scholar's profile pages as Google has indexed them. */
export function serplySearchUrl(q, num = 10) {
  return `${SERPLY_HOST}/v1/search?${new URLSearchParams({ q, num: String(num) })}`;
}

/** Google's search for the profile pages of a name, or of an id when there is no name. */
export const profilesQuery = (name) => `site:scholar.google.com/citations "${name}"`;

// ---------------------------------------------------------- the mapping ----

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
const profileLink = (userId) => `${SCHOLAR_HOST}/citations?hl=en&user=${encodeURIComponent(userId)}`;
/** Scholar wraps names and counts in direction marks (‪…‬); Google keeps them. */
const unmark = (text) => str(text).replace(/[‎‏‪-‮]/g, '').replace(/\s+/g, ' ').trim();

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
        snippet: str(entry?.snippet) || str(entry?.abstract) || str(entry?.text) || '',
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
 * most often seen first — with the name as the byline has it.
 */
export function fromSerplyAuthors(json, name) {
  const seen = new Map();
  for (const entry of list(json?.articles)) {
    for (const author of list(entry?.author?.authors)) {
      const userId = userOf(author?.link);
      if (!userId || !nameCouldBe(author?.name, name)) continue;
      const found = seen.get(userId);
      if (found) found.seen += 1;
      else seen.set(userId, { userId, name: str(author?.name), seen: 1 });
    }
  }
  return Array.from(seen.values())
    .sort((a, b) => b.seen - a.seen)
    .map(({ userId, name: byline }) => ({
      userId,
      name: byline,
      profileUrl: profileLink(userId),
      affiliation: undefined,
      verifiedEmail: undefined,
      interests: [],
      citedBy: undefined,
    }));
}

/**
 * Scholar's profile pages among Google's results, read for what Google
 * shows of them: the title is `Ashish Vaswani - Google Scholar`, and the
 * line under it `Essential AI - Cited by 231,507 - Machine Learning - Deep
 * Learning` — or, as Google sometimes has it, the top of the page run
 * together: `Ashish Vaswani. Essential AI. Verified email at essential.ai`.
 * What is not there is left undefined.
 */
export function fromSerplyProfiles(json) {
  const seen = new Set();
  const people = [];
  for (const entry of list(json?.results)) {
    const link = str(entry?.link);
    const userId = userOf(link);
    if (!userId || !/scholar\.google\.[a-z.]+\/citations/i.test(link) || seen.has(userId)) continue;
    const name = unmark(entry?.title)
      .replace(/\s*[-–|]\s*(?:‪)?Google Scholar.*$/i, '')
      .replace(/\s*\.\.\.$|…$/, '')
      .trim();
    if (!name || /google scholar/i.test(name)) continue;
    seen.add(userId);
    const text = unmark(entry?.description);
    const email = (text.match(/Verified email at ([\w.-]+\.[a-z]{2,})/i) || [])[1];
    const citedBy = count((text.match(/Cited by ([\d,.]+)/i) || [])[1]);
    // What is left, once the name, the counts and the email are out of it:
    // the affiliation first, then the interests.
    const pieces = text
      .split(/\s+[-–·]\s+|\.\s+/)
      .map((piece) => piece.replace(/\.$/, '').trim())
      .filter(
        (piece) =>
          piece &&
          piece.toLowerCase() !== name.toLowerCase() &&
          !/^Cited by\b|^Verified email\b|^Articles\b|^Homepage$|^No verified email$|^Google Scholar$/i.test(piece),
      );
    const [affiliation, ...interests] = pieces;
    people.push({
      userId,
      name,
      profileUrl: profileLink(userId),
      affiliation: affiliation && affiliation.length <= 160 ? affiliation : undefined,
      verifiedEmail: email,
      interests: interests.filter((interest) => interest.length <= 60).slice(0, 8),
      citedBy,
    });
  }
  return people;
}

/** A person's works as a profile's list gives them, from the results that link their profile. */
export function worksOf(results, userId) {
  return results
    .filter((result) => result.authorIds.some((author) => author.userId === userId))
    .map(({ authorIds, id, ...work }) => work);
}

const byNewest = (a, b) => (b.year || 0) - (a.year || 0) || (b.citedBy || 0) - (a.citedBy || 0);
const byCited = (a, b) => (b.citedBy || 0) - (a.citedBy || 0) || (b.year || 0) - (a.year || 0);

// ------------------------------------------------------------- fetching ----

const CACHE_MS = 5 * 60 * 1000;
const CACHE_MAX = 80;
const cache = new Map();

export function forgetSerply() {
  cache.clear();
}

/**
 * One request of Serply, JSON back, cached by its address — which never
 * holds the key. A 502 is tried once more, as Serply's own advice has it.
 */
async function getJson(url, key, { fetchImpl, signal }) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.json;
  let problem;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchImpl(url, {
      signal,
      headers: {
        'X-Api-Key': key,
        Accept: 'application/json',
        // Serply sits behind Cloudflare, which turns away a library's User-Agent.
        'User-Agent': 'reader-proxy/1.0',
        'X-Proxy-Location': PROXY_LOCATION,
      },
    });
    const text = await response.text();
    problem = serplyProblem(response.status, text);
    if (!problem) {
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new SerplyFailed({ reason: 'serply', message: 'Serply answered with something that was not JSON' });
      }
      cache.set(url, { json, at: Date.now() });
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return json;
    }
    if (problem.reason !== 'upstream') break;
  }
  throw new SerplyFailed(problem);
}

/**
 * Who a profile id belongs to, from Google's profile pages: for the name
 * when it is known, and for the id itself when it is not. Undefined when
 * Google shows neither.
 */
async function profileOf(userId, name, key, options) {
  const queries = name ? [profilesQuery(name), `"${userId}" site:scholar.google.com`] : [`"${userId}" site:scholar.google.com`];
  for (const query of queries) {
    const found = fromSerplyProfiles(await getJson(serplySearchUrl(query), key, options)).find((person) => person.userId === userId);
    if (found) return found;
  }
  return undefined;
}

/**
 * How many of Scholar's result pages stand for one page of a profile. A
 * search for a name's papers finds other people of the name too, and their
 * papers are dropped, so one results page seldom leaves the twenty a
 * profile's page has — and the app takes a short page for the last.
 */
const PAGES_PER_PROFILE_PAGE = 2;

/**
 * A person's works, from a Scholar search for their papers: page `start /
 * 20` of the profile is results pages 2p and 2p+1, each of twenty, kept to
 * the papers whose byline links this very profile. No results page is in
 * two profile pages, so none is lost or shown twice; a short one is the
 * end, and nothing after it is asked for.
 */
async function worksFor(userId, name, { start = 0, sort = 'pubdate', pages = PAGES_PER_PROFILE_PAGE }, key, options) {
  const page = Math.floor(start / 20);
  const works = [];
  for (let i = 0; i < pages; i += 1) {
    const offset = (page * pages + i) * 20;
    const results = fromSerplyResults(await getJson(serplyScholarUrl({ q: `author:"${name}"`, start: offset, num: 20 }), key, options));
    works.push(...worksOf(results, userId));
    if (results.length < 20) break;
  }
  return works.sort(sort === 'citations' ? byCited : byNewest);
}

/**
 * One ask of Serply, mapped onto the shapes the direct parsers produce, so
 * nothing downstream knows which answered. `params` are the route's, with
 * the person's `name` where the app knows it — a profile and a person are
 * asked for by id, and a name saves finding out whose it is. `fetchImpl` is
 * how requests are made, so a test can hand in saved answers.
 */
export async function askSerplyScholar(kind, params, key, { fetchImpl = (...args) => fetch(...args), signal } = {}) {
  const options = { fetchImpl, signal };
  switch (kind) {
    case 'search':
      return fromSerplyResults(await getJson(serplyScholarUrl({ q: params.query, start: params.start }), key, options));

    case 'versions':
      return fromSerplyResults(await getJson(serplyScholarUrl({ cluster: params.cluster, num: 20 }), key, options));

    case 'authors': {
      // Google's profile pages for the name: full names, and who they are.
      // Then the bylines of their papers, for anyone Google did not show.
      const [profiles, papers] = await Promise.all([
        getJson(serplySearchUrl(profilesQuery(params.name)), key, options).then(
          (json) => fromSerplyProfiles(json).filter((person) => nameCouldBe(person.name, params.name)),
          () => [],
        ),
        getJson(serplyScholarUrl({ q: `author:"${params.name}"`, num: 20 }), key, options).then((json) => fromSerplyAuthors(json, params.name)),
      ]);
      const known = new Set(profiles.map((person) => person.userId));
      return [...profiles, ...papers.filter((person) => !known.has(person.userId))];
    }

    case 'profile': {
      const name = params.name || (await profileOf(params.user, undefined, key, options))?.name;
      if (!name) throw notFound(params.user);
      return worksFor(params.user, name, params, key, options);
    }

    case 'person': {
      const profile = await profileOf(params.user, params.name, key, options);
      const name = profile?.name || params.name;
      if (!name) throw notFound(params.user);
      // A hover card's handful of most cited works: one results page is plenty.
      const works = await worksFor(params.user, name, { sort: 'citations', pages: 1 }, key, options);
      return [
        {
          ...(profile || { userId: params.user, name, profileUrl: profileLink(params.user), interests: [] }),
          homepage: undefined,
          citedBySince: undefined,
          // Printed on the profile page alone, which Scholar does not give Serply.
          hIndex: undefined,
          i10Index: undefined,
          works,
        },
      ];
    }

    case 'work':
      // An id and no title: nothing to search by. The app finds the paper by
      // its title instead, as it does whenever this page is refused.
      throw new SerplyFailed({
        reason: 'unsupported',
        message: 'Serply cannot open one entry of a profile by its id; the paper is looked up by its title instead.',
      });

    default:
      throw new Error(`no Serply request for ${kind}`);
  }
}

const notFound = (userId) =>
  new SerplyFailed({ reason: 'not-found', message: `Google shows no Scholar profile with the id ${userId}, so its works could not be searched for.` });
