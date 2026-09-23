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
      // SerpApi has discontinued its profiles engine. A search for papers by
      // the name names, in each byline, the authors who have a profile — and
      // their ids — which is what the profile search gave.
      query.set('engine', 'google_scholar');
      query.set('q', `author:"${params.name}"`);
      query.set('num', '20');
      break;
    case 'profile':
      query.set('engine', 'google_scholar_author');
      query.set('author_id', params.user);
      // Newest first unless asked for the most cited, which is the engine's
      // own order and takes no parameter.
      if (params.sort !== 'citations') query.set('sort', 'pubdate');
      query.set('num', '20');
      if (params.start) query.set('start', String(params.start));
      break;
    case 'versions':
      query.set('engine', 'google_scholar');
      query.set('cluster', params.cluster);
      query.set('num', '20');
      break;
    case 'work':
      // One entry of a profile, opened: the author engine's citation view,
      // which carries the file Scholar found for it and the cluster.
      query.set('engine', 'google_scholar_author');
      query.set('view_op', 'view_citation');
      query.set('citation_id', params.citation);
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

const profileLink = (userId) => `${SCHOLAR_HOST}/citations?hl=en&user=${encodeURIComponent(userId)}`;

/** `Saurav Chennuri`, `S Chennuri`, `Chennuri, S.` → `s chennuri`-ish tokens. */
const nameTokens = (name) =>
  str(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/**
 * Whether a byline's name could be the person searched for. Bylines carry
 * initials — `S Chennuri`, `SVP Chennuri` — so the surname has to match and
 * the initials have to begin with the first name's. A surname alone matches
 * anyone with it, which is what a search by surname means.
 */
export function nameCouldBe(byline, wanted) {
  const have = nameTokens(byline);
  const want = nameTokens(wanted);
  if (!have.length || !want.length) return false;
  if (have.join(' ') === want.join(' ')) return true;
  if (have[have.length - 1] !== want[want.length - 1]) return false;
  if (want.length === 1) return true;
  return have[0][0] === want[0][0];
}

/**
 * The people a search for a name turns up: every author in a byline with a
 * profile whose name could be the one asked for, once each, most often
 * seen first. As much as the profile search gave, less the affiliation and
 * the verified email — those come from the profile itself, below.
 */
export function fromSerpAuthorsInResults(json, name) {
  const seen = new Map();
  for (const entry of list(json?.organic_results)) {
    for (const author of list(entry?.publication_info?.authors)) {
      const userId = str(author?.author_id);
      if (!userId || !nameCouldBe(author?.name, name)) continue;
      const found = seen.get(userId);
      if (found) found.worksSeen += 1;
      else {
        seen.set(userId, {
          userId,
          name: str(author?.name),
          profileUrl: absolute(str(author?.link)) || profileLink(userId),
          affiliation: undefined,
          verifiedEmail: undefined,
          interests: [],
          citedBy: undefined,
          worksSeen: 1,
        });
      }
    }
  }
  return Array.from(seen.values()).sort((a, b) => b.worksSeen - a.worksSeen);
}

/** The person a profile page is about — the top of the author engine's answer. */
export function fromSerpAuthorProfile(json, userId) {
  const author = json?.author || {};
  const name = str(author.name);
  if (!name) return null;
  const table = list(json?.cited_by?.table);
  const citations = table.find((row) => row?.citations)?.citations;
  return {
    userId,
    name,
    profileUrl: profileLink(userId),
    affiliation: str(author.affiliations) || undefined,
    verifiedEmail: (str(author.email).match(/Verified email at (\S+)/i) || [])[1],
    interests: list(author.interests)
      .map((interest) => (typeof interest === 'string' ? interest.trim() : str(interest?.title)))
      .filter(Boolean),
    citedBy: num(citations?.all),
  };
}

/** A profile's own list of works, as `parseProfileWorks` would have read it. */
export function fromSerpWorks(json) {
  return list(json?.articles)
    .map((entry) => {
      const publication = str(entry?.publication);
      return {
        title: str(entry?.title),
        url: absolute(str(entry?.link)),
        citationId: str(entry?.citation_id) || (str(entry?.link).match(/[?&]citation_for_view=([^&]+)/) || [])[1],
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

/**
 * One entry of a profile, opened, as `parseCitationView` would have read it:
 * the `citation` object is the table on the page, `resources` the file link
 * beside the title, and `scholar_articles` the search records it stands for,
 * with the cluster in their "all versions" link.
 */
export function fromSerpCitation(json) {
  const citation = json?.citation;
  const title = str(citation?.title);
  if (!title) return [];
  // Beside the answer or inside it: SerpApi has put the file link in both places.
  const resource = [...list(json?.resources), ...list(citation?.resources)].find((entry) => absolute(str(entry?.link)));
  const articles = list(citation?.scholar_articles);
  const versions = articles.map((entry) => str(entry?.all_versions?.link)).find((link) => /cluster=(\d+)/.test(link));
  const clusterId =
    (versions && (versions.match(/cluster=(\d+)/) || [])[1]) ||
    articles.map((entry) => (str(entry?.link).match(/cluster=(\d+)/) || [])[1]).find(Boolean) ||
    undefined;
  const date = (str(citation?.publication_date).match(/\b(1[89]\d\d|20\d\d)(?:\/(\d{1,2}))?(?:\/(\d{1,2}))?/) || []);
  return [
    {
      title,
      url: absolute(str(citation?.link)),
      pdfUrl: resource ? absolute(str(resource.link)) : undefined,
      pdfKind: resource ? str(resource.file_format).toUpperCase() || undefined : undefined,
      pdfHost: resource ? str(resource.title) || undefined : undefined,
      authors: str(citation?.authors)
        .split(/,\s*/)
        .map((name) => name.trim())
        .filter(Boolean),
      venue:
        ['journal', 'conference', 'book', 'source', 'publisher', 'institution'].map((name) => str(citation?.[name])).find(Boolean) ||
        undefined,
      year: date[1] ? Number(date[1]) : undefined,
      published: date[1]
        ? [date[1], date[2] ? date[2].padStart(2, '0') : '01', date[3] ? date[3].padStart(2, '0') : '01'].join('-')
        : undefined,
      snippet: str(citation?.description),
      citedBy: num(citation?.total_citations?.cited_by?.value) || num(citation?.total_citations?.cited_by?.total) || undefined,
      clusterId,
      versionCount: articles.map((entry) => num(entry?.all_versions?.total)).find(Boolean),
    },
  ];
}

/** The mapping for each kind of ask that is one request. */
export const fromSerp = {
  search: fromSerpResults,
  versions: fromSerpResults,
  profile: fromSerpWorks,
  work: fromSerpCitation,
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
  if (/discontinued|deprecated|no longer/i.test(error)) {
    return { reason: 'discontinued', message: `SerpApi no longer offers this Scholar page: ${error}` };
  }
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
 * key. It holds SerpApi's answers as given, so that the profile fetched to
 * fill in a person in the list is the same one their works are read from
 * when they are opened — one search, not two.
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

/** One request of SerpApi, answered from the cache where it can be. */
async function getJson(kind, params, key, { fetchJson, signal }) {
  const url = serpUrl(kind, params, key);
  const cacheKey = withoutKey(url);
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.json;
  const { status, json } = await fetchJson(url, { signal });
  const problem = serpProblem(json, status);
  if (problem) throw new SerpFailed(problem);
  cache.set(cacheKey, { json, at: Date.now() });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return json;
}

/** How many of the people found are looked up for their affiliation and email. */
const FILL_IN_PEOPLE = 3;

/**
 * One ask of SerpApi, mapped. `fetchJson` is how the request is made, so a
 * test can hand in saved answers.
 *
 * People are the one ask that is more than one request: the search that
 * finds them, then their profiles — the first few — for the affiliation
 * and the verified email, which are what tell two people of a name apart.
 * That is up to four searches of the allowance; the profiles are cached,
 * so opening one of those people afterwards costs nothing more.
 */
export async function askSerp(kind, params, key, { fetchJson = plainFetchJson, signal } = {}) {
  if (kind !== 'authors') return fromSerp[kind](await getJson(kind, params, key, { fetchJson, signal }));

  const people = fromSerpAuthorsInResults(await getJson('authors', params, key, { fetchJson, signal }), params.name);
  await Promise.all(
    people.slice(0, FILL_IN_PEOPLE).map(async (person) => {
      try {
        const profile = fromSerpAuthorProfile(
          await getJson('profile', { user: person.userId, start: 0 }, key, { fetchJson, signal }),
          person.userId,
        );
        if (profile) Object.assign(person, profile);
      } catch {
        // Their profile is a nicety; the person is still found without it.
      }
    }),
  );
  return people.map(({ worksSeen, ...person }) => person);
}
