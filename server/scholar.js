/**
 * A small API for Google Scholar, because Google publishes none.
 *
 * Scholar is the one index that knows about everything — theses, workshop
 * papers, technical reports, a person's own page — and it lists, for a single
 * paper, every version anyone has put online. None of that is available any
 * other way, so this asks for the same pages a person would open in a browser
 * and reads the answers.
 *
 * Read this before relying on it:
 *
 *   - Scholar has no public API and its terms of service do not permit
 *     automated access. This is here because it was asked for, for one
 *     person's own reading; it is not something to point a crowd at.
 *   - It blocks datacentre IPs hard. From a Cloudflare Worker or a cloud VM,
 *     expect a captcha far more often than a result. From a laptop, or from a
 *     machine on a home connection, it mostly works. `BROWSER` mode below
 *     helps, because a real browser looks like one.
 *   - Being blocked is normal and is not a bug. Every function here reports it
 *     as `blocked` rather than as an empty result, so the app can say what
 *     happened and fall back to the indexes that do have APIs.
 *   - A captcha is Google asking for a person, and a person can be supplied:
 *     `server/scholarBrowser.js` opens the refused page in a real browser
 *     window on the proxy's machine, the captcha is solved there, and Scholar
 *     is asked again through that browser, which now carries the cookie the
 *     solve earned. The refusal carries the page it was refused on for that.
 *   - Scholar's HTML is not a contract. The class names below have been stable
 *     for years, but a redesign would break the parsing rather than corrupt it:
 *     the parsers return nothing rather than nonsense, and
 *     `scripts/scholar.test.mjs` pins them to saved fixtures.
 *
 * Written against web APIs only (fetch, URL, string), so the Worker in
 * `worker/index.js` can import it exactly as `server/api.js` does.
 */

/** What Scholar sees. A real browser's, because a crawler's is refused. */
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const SCHOLAR_HOST = 'https://scholar.google.com';

// --------------------------------------------------------------- the URLs ---

/** Papers matching a query — the page you get from the Scholar search box. */
export function searchUrl(query, { start = 0, sinceYear, patents = false } = {}) {
  const params = new URLSearchParams({ hl: 'en', as_sdt: patents ? '0,5' : '0,5', q: query });
  if (start) params.set('start', String(start));
  if (sinceYear) params.set('as_ylo', String(sinceYear));
  return `${SCHOLAR_HOST}/scholar?${params}`;
}

/** Everything one person has written, by their Scholar profile id. */
export function profileUrl(userId, { start = 0, pageSize = 20 } = {}) {
  const params = new URLSearchParams({
    hl: 'en',
    user: userId,
    cstart: String(start),
    pagesize: String(pageSize),
    view_op: 'list_works',
    sortby: 'pubdate',
  });
  return `${SCHOLAR_HOST}/citations?${params}`;
}

/**
 * One entry on a profile, opened: the page behind a title in the list. It is
 * the only place Scholar shows the file it found for a profile's paper — the
 * "[PDF] from bu.edu" in the corner — and the cluster the paper belongs to,
 * neither of which the list itself carries. `citationId` is Scholar's
 * `citation_for_view`, `<user>:<code>`, which the list gives for each row.
 */
export function workUrl(userId, citationId) {
  const params = new URLSearchParams({ hl: 'en', user: userId, view_op: 'view_citation', citation_for_view: citationId });
  return `${SCHOLAR_HOST}/citations?${params}`;
}

/** People matching a name — Scholar's own profile search. */
export function authorSearchUrl(name) {
  const params = new URLSearchParams({ hl: 'en', view_op: 'search_authors', mauthors: name });
  return `${SCHOLAR_HOST}/citations?${params}`;
}

/** The "All 84 versions" page: every copy of one paper Scholar knows of. */
export function versionsUrl(clusterId, { start = 0 } = {}) {
  const params = new URLSearchParams({ hl: 'en', as_sdt: '0,5', cluster: String(clusterId) });
  if (start) params.set('start', String(start));
  return `${SCHOLAR_HOST}/scholar?${params}`;
}

/**
 * Whether this is a page of Scholar's, and only Scholar's. The captcha window
 * opens a URL the app hands back, so the check is what keeps that window from
 * being opened on any other site's page at another site's choosing.
 */
export function isScholarUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'scholar.google.com';
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- being told no --

/**
 * Whether this page is Scholar refusing rather than answering, and which kind
 * of no it is. Told apart because they need different advice: a captcha is
 * this IP being distrusted, a 429 is going too fast, and a consent wall is a
 * region thing that a cookie fixes.
 */
export function blockedReason(html, status) {
  const head = String(html || '').slice(0, 4000);

  // Google's own refusals, which say so in the page.
  if (/gs_captcha_ccl|id="captcha|\/sorry\/index|recaptcha/i.test(head)) return 'captcha';
  if (/unusual traffic from your computer network|automated queries/i.test(head)) return 'captcha';
  if (/consent\.google\.com|Before you continue to Google/i.test(head)) return 'consent';

  // A status alone does not say who sent it. A corporate proxy, a container's
  // egress allowlist or a captive portal all answer 403 for a host they will
  // not reach, and calling that a captcha sends someone off to solve a puzzle
  // that was never shown to them. So a refusal is only Scholar's if the page
  // looks like Google's at all.
  // Naming the host is not being the host: "Host not in allowlist:
  // scholar.google.com" is a plain-text refusal from a proxy. Scholar's own
  // refusals are HTML pages served by Google.
  const isHtml = /^\s*<(?:!doctype|html|head|body)\b/i.test(head);
  const fromGoogle = isHtml && /google/i.test(head);
  if (status === 429) return fromGoogle ? 'rate-limited' : 'unreachable';
  if (status === 403) return fromGoogle ? 'captcha' : 'unreachable';
  // The profile search answers a plain request with a bare 401 and no
  // captcha, and answers a real browser. Refused, then, but not a puzzle.
  if (status === 401) return fromGoogle ? 'refused' : 'unreachable';
  if (status === 407 || status === 502 || status === 504) return 'unreachable';
  return null;
}

/** What to tell the person, in terms of what they can do about it. */
export function blockedMessage(reason) {
  switch (reason) {
    case 'unreachable':
      return (
        'Nothing reached Google Scholar: the refusal came from something in between — a network policy, a proxy ' +
        'allowlist or a firewall — rather than from Scholar itself. Allow scholar.google.com, or leave Scholar off.'
      );
    case 'rate-limited':
      return 'Google Scholar is rate-limiting this proxy. Wait a minute, or search the other sources meanwhile.';
    case 'consent':
      return 'Google Scholar answered with its consent page rather than results, which it does for some regions.';
    case 'refused':
      return (
        'Google Scholar refused this request outright (401) without showing a captcha. It does that to plain requests ' +
        'for its profile pages while answering a real browser, so showing it one is what gets through.'
      );
    case 'captcha':
    default:
      return (
        'Google Scholar served a captcha instead of results. It does that to servers rather than to people — ' +
        'a proxy on a cloud host will see this most of the time. The other sources need no proxy and are not blocked.'
      );
  }
}

export class ScholarBlocked extends Error {
  constructor(reason, url) {
    super(blockedMessage(reason));
    this.reason = reason;
    this.blocked = true;
    /** The page that was refused — where a captcha can be shown and solved. */
    this.url = url;
  }
}

// ------------------------------------------------------------- the parsing ---

const NAMED = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  rsquo: '\u2019',
  lsquo: '\u2018',
  ldquo: '\u201c',
  rdquo: '\u201d',
  middot: '\u00b7',
};

const entity = (value) =>
  String(value || '')
    .replace(/&(\w+);/g, (match, name) => (name in NAMED ? NAMED[name] : match))
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCharCode(parseInt(code, 16)));

/** Tags out, entities decoded, whitespace collapsed. */
export function text(html) {
  return entity(String(html || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The contents of every element carrying this class, tags and all. Elements
 * rather than element: Scholar reuses `gs_fl` for both the file link and the
 * footer, so the caller has to be able to say which one it meant.
 */
function blocks(html, className) {
  const out = [];
  const open = new RegExp(`<([a-z][\\w-]*)[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`, 'gi');
  let match;
  while ((match = open.exec(html))) {
    const tag = match[1];
    const from = match.index + match[0].length;
    // Walk to the matching close tag, counting nested tags of the same name.
    const scan = new RegExp(`<${tag}\\b|</${tag}\\s*>`, 'gi');
    scan.lastIndex = from;
    let depth = 1;
    let found;
    let to = html.length;
    while ((found = scan.exec(html))) {
      depth += found[0][1] === '/' ? -1 : 1;
      if (depth === 0) {
        to = found.index;
        break;
      }
    }
    out.push(html.slice(from, to));
  }
  return out;
}

/** The contents of the first element with this class. */
const block = (html, className) => blocks(html, className)[0] || '';

/** The contents of the element with this id, walked to its close tag the same way. */
function idBlock(html, id) {
  const open = new RegExp(`<([a-z][\\w-]*)[^>]*\\bid="${id}"[^>]*>`, 'i');
  const match = open.exec(html);
  if (!match) return '';
  const tag = match[1];
  const from = match.index + match[0].length;
  const scan = new RegExp(`<${tag}\\b|</${tag}\\s*>`, 'gi');
  scan.lastIndex = from;
  let depth = 1;
  let found;
  while ((found = scan.exec(html))) {
    depth += found[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(from, found.index);
  }
  return html.slice(from);
}

/** Every `<a href>` in a fragment, as { href, text }. */
function links(html) {
  const out = [];
  const pattern = /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html))) out.push({ href: entity(match[1]), text: text(match[2]) });
  return out;
}

const absolute = (href) => (href && href.startsWith('/') ? `${SCHOLAR_HOST}${href}` : href);

/**
 * Splits a result list into one fragment per result. Scholar wraps each in
 * `<div class="gs_r gs_or gs_scl" data-cid="…">`; the cid is the id of that
 * *record*, and `data-cluster-id`/the versions link carries the id of the
 * group of copies.
 */
function resultBlocks(html) {
  const out = [];
  const pattern = /<div class="gs_r gs_or gs_scl"[^>]*>/gi;
  let match;
  const starts = [];
  while ((match = pattern.exec(html))) starts.push({ index: match.index, tag: match[0] });
  starts.forEach((start, position) => {
    const end = position + 1 < starts.length ? starts[position + 1].index : html.length;
    out.push({ tag: start.tag, html: html.slice(start.index, end) });
  });
  return out;
}

const attribute = (tag, name) => {
  const match = new RegExp(`${name}="([^"]*)"`, 'i').exec(tag);
  return match ? entity(match[1]) : undefined;
};

/**
 * `A Vaswani, N Shazeer… - Advances in neural information …, 2017 - nips.cc`
 * — Scholar's one line of metadata, which is all it gives. The year is the
 * last four-digit number before the final dash, and the host after it.
 */
export function parseByline(line) {
  const parts = String(line || '').split(' - ');
  const authors = text(parts[0] || '')
    .split(/,\s*/)
    .map((name) => name.replace(/…|\.\.\./g, '').trim())
    .filter(Boolean);
  const middle = parts.length > 2 ? parts.slice(1, -1).join(' - ') : parts.length === 2 ? parts[1] : '';
  const year = (middle.match(/\b(1[89]\d\d|20\d\d)\b/) || [])[1];
  const venue = middle
    .replace(/,?\s*\b(1[89]\d\d|20\d\d)\b\s*$/, '')
    .replace(/…/g, '')
    .trim();
  const host = parts.length > 1 ? text(parts[parts.length - 1]) : '';
  return { authors, venue: venue || undefined, year: year ? Number(year) : undefined, host: host || undefined };
}

/**
 * One page of Scholar results. The same shape whether it came from a search,
 * a cluster ("all versions") or a citing-papers page — they are one template.
 */
export function parseResults(html) {
  return resultBlocks(html).map(({ tag, html: entry }) => {
    const titleBlock = block(entry, 'gs_rt');
    const titleLink = links(titleBlock)[0];
    const byline = text(block(entry, 'gs_a'));
    const parsed = parseByline(byline);

    // The right-hand column: a direct link to a file, where Scholar found one.
    const file = links(block(entry, 'gs_or_ggsm'))[0];
    const fileTag = (block(entry, 'gs_ctg2').match(/\[(\w+)\]/) || [])[1];

    // `gs_fl` is on the footer *and* on the wrapper around the file link, and
    // the wrapper comes first in the markup. The footer is the one holding the
    // links this reads, so pick by content rather than by position.
    const footer = links(
      blocks(entry, 'gs_flb')[0] ||
        blocks(entry, 'gs_fl').find((candidate) => /cluster=|Cited by/i.test(candidate)) ||
        '',
    );
    const versions = footer.find((link) => /\bversions?\b/i.test(link.text) && /cluster=/.test(link.href));
    const citedBy = footer.find((link) => /^cited by/i.test(link.text));
    const cluster =
      (versions && (versions.href.match(/cluster=(\d+)/) || [])[1]) ||
      attribute(tag, 'data-cid') ||
      undefined;

    return {
      /** Scholar's own id for this record. */
      id: attribute(tag, 'data-cid'),
      // Scholar puts the type tag in front of the title twice — once for wide
      // screens and once for narrow ones — so this strips as many as it finds.
      title: text(titleBlock).replace(/^(?:\[(?:PDF|HTML|BOOK|CITATION|B|C)\]\s*)+/i, ''),
      /** Where the title points: usually the publisher's landing page. */
      url: titleLink ? absolute(titleLink.href) : undefined,
      /** The file Scholar itself found, which is the one worth trying first. */
      pdfUrl: file && /^https?:/i.test(file.href) ? file.href : undefined,
      /** `PDF`, `HTML`, `BOOK` — what that file is. */
      pdfKind: fileTag ? fileTag.toUpperCase() : undefined,
      /** The host it sits on, as Scholar labels it: `mit.edu`, `arxiv.org`. */
      pdfHost: file ? file.text.replace(/^\[\w+\]\s*/, '').trim() || undefined : undefined,
      authors: parsed.authors,
      venue: parsed.venue,
      year: parsed.year,
      snippet: text(block(entry, 'gs_rs')),
      citedBy: citedBy ? Number((citedBy.text.match(/(\d[\d,]*)/) || [])[1]?.replace(/,/g, '')) || undefined : undefined,
      /** The group of copies this record belongs to — "all N versions". */
      clusterId: cluster,
      versionCount: versions ? Number((versions.text.match(/(\d+)/) || [])[1]) || undefined : undefined,
    };
  }).filter((result) => result.title);
}

/** Scholar's profile search: the people, not their papers. */
export function parseAuthors(html) {
  const out = [];
  const pattern = /<div class="gsc_1usr[^"]*"[^>]*>/gi;
  const starts = [];
  let match;
  while ((match = pattern.exec(html))) starts.push(match.index);
  starts.forEach((start, position) => {
    const entry = html.slice(start, position + 1 < starts.length ? starts[position + 1] : html.length);
    const nameLink = links(block(entry, 'gs_ai_name'))[0];
    if (!nameLink) return;
    const userId = (nameLink.href.match(/[?&]user=([^&"]+)/) || [])[1];
    out.push({
      userId,
      name: nameLink.text,
      profileUrl: absolute(nameLink.href),
      affiliation: text(block(entry, 'gs_ai_aff')) || undefined,
      verifiedEmail: (text(block(entry, 'gs_ai_eml')).match(/Verified email at (\S+)/i) || [])[1],
      interests: links(block(entry, 'gs_ai_int')).map((link) => link.text).filter(Boolean),
      citedBy: Number((text(block(entry, 'gs_ai_cby')).match(/(\d[\d,]*)/) || [])[1]?.replace(/,/g, '')) || undefined,
    });
  });
  return out;
}

/** A profile's own list of works, which is richer than searching their name. */
export function parseProfileWorks(html) {
  const out = [];
  const pattern = /<tr class="gsc_a_tr">/gi;
  const starts = [];
  let match;
  while ((match = pattern.exec(html))) starts.push(match.index);
  starts.forEach((start, position) => {
    const entry = html.slice(start, position + 1 < starts.length ? starts[position + 1] : html.length);
    const titleLink = links(block(entry, 'gsc_a_t'))[0];
    if (!titleLink) return;
    const grey = entry.match(/<div class="gs_gray">([\s\S]*?)<\/div>[\s\S]*?<div class="gs_gray">([\s\S]*?)<\/div>/i);
    out.push({
      title: titleLink.text,
      /** Opens the entry on the person's profile; no direct file here. */
      url: absolute(titleLink.href),
      /**
       * Scholar's handle on that entry, which is how its own page — and the
       * file link and cluster on it — is asked for. See `parseCitationView`.
       */
      citationId: (titleLink.href.match(/[?&]citation_for_view=([^&"]+)/) || [])[1],
      authors: text(grey?.[1] || '').split(/,\s*/).filter(Boolean),
      venue: text(grey?.[2] || '').replace(/,?\s*\b(1[89]\d\d|20\d\d)\b\s*$/, '') || undefined,
      year: Number(text(block(entry, 'gsc_a_y')).match(/(1[89]\d\d|20\d\d)/)?.[1]) || undefined,
      citedBy: Number(text(block(entry, 'gsc_a_c')).replace(/[^\d]/g, '')) || undefined,
    });
  });
  return out;
}

/**
 * One entry of a profile, opened: the "View article" page. Scholar lays it out
 * as a title, a "[PDF] from bu.edu" link beside it where it found a file, and
 * a table of field/value rows — authors, publication date, the venue under
 * whichever name fits (journal, conference, book, source), a description,
 * total citations — ending in "Scholar articles", the search record(s) the
 * entry stands for, whose "All N versions" link names the cluster.
 *
 * The ids are `gsc_oci_*` on the page opened in its own tab and `gsc_vcd_*`
 * in the overlay on the profile itself; the same page under two prefixes, so
 * both are read. The answer is a list of at most one, in the shape of a search
 * result, so it folds in with the rest of the Scholar answers.
 */
export function parseCitationView(html) {
  const source = String(html || '');
  const prefix = /gsc_oci_title/.test(source) ? 'gsc_oci' : /gsc_vcd_title/.test(source) ? 'gsc_vcd' : null;
  if (!prefix) return [];

  // The title and, next to it, the file Scholar found.
  const titleBlock = idBlock(source, `${prefix}_title`);
  const titleLink = links(titleBlock)[0];
  const title = titleLink ? titleLink.text : text(titleBlock);
  if (!title) return [];
  // The id is on the wrapper and the class on the link inside it; either will do.
  const file = links(idBlock(source, `${prefix}_title_ggi`) || block(source, `${prefix}_title_ggi`))[0];
  const fileTag = file ? (file.text.match(/^\[(\w+)\]/) || [])[1] : undefined;

  // The table: one row per field, labelled in words.
  const fields = new Map();
  for (const row of blocks(source, 'gs_scl')) {
    const name = text(block(row, `${prefix}_field`)).toLowerCase();
    const value = block(row, `${prefix}_value`);
    if (name && value) fields.set(name, value);
  }
  const field = (name) => fields.get(name) || '';
  const authors = text(field('authors') || field('inventors'))
    .split(/,\s*/)
    .map((name) => name.trim())
    .filter(Boolean);
  const venue =
    ['journal', 'conference', 'book', 'source', 'publisher', 'institution']
      .map((name) => text(field(name)))
      .find(Boolean) || undefined;
  // `2023/10/2`, `2023/10`, or `2023`: as much of the date as Scholar has.
  const date = (text(field('publication date')).match(/\b(1[89]\d\d|20\d\d)(?:\/(\d{1,2}))?(?:\/(\d{1,2}))?/) || []);
  const year = date[1] ? Number(date[1]) : undefined;
  const published = date[1]
    ? [date[1], date[2] ? date[2].padStart(2, '0') : '01', date[3] ? date[3].padStart(2, '0') : '01'].join('-')
    : undefined;
  // The description is shown twice — a short cut and the full text — and the
  // full one carries the `descr` id; the short one is just the fallback.
  const description = text(idBlock(field('description'), `${prefix}_descr`) || field('description'));
  const citedBy = Number((text(field('total citations')).match(/cited by\s+(\d[\d,]*)/i) || [])[1]?.replace(/,/g, '')) || undefined;

  // The search record(s) this entry is, and the cluster they belong to.
  const articles = links(field('scholar articles'));
  const versions = articles.find((link) => /\bversions?\b/i.test(link.text) && /cluster=/.test(link.href));
  const clusterId =
    (versions && (versions.href.match(/cluster=(\d+)/) || [])[1]) ||
    (articles.map((link) => (link.href.match(/cluster=(\d+)/) || [])[1]).find(Boolean)) ||
    undefined;

  return [
    {
      title,
      /** Where the title points: the publisher's page, usually. */
      url: titleLink && /^https?:/i.test(titleLink.href) ? titleLink.href : undefined,
      /** The file Scholar found — the "[PDF] from bu.edu" in the corner. */
      pdfUrl: file && /^https?:/i.test(file.href) ? file.href : undefined,
      pdfKind: fileTag ? fileTag.toUpperCase() : undefined,
      pdfHost: file ? file.text.replace(/^\[\w+\]\s*(?:from\s+)?/i, '').trim() || undefined : undefined,
      authors,
      venue,
      year,
      published,
      snippet: description,
      citedBy,
      clusterId,
      versionCount: versions ? Number((versions.text.match(/(\d+)/) || [])[1]) || undefined : undefined,
    },
  ];
}

// ------------------------------------------------------------- the fetching --

/**
 * Scholar's tolerance is per IP and it is not generous. One request at a time,
 * a gap between them, and a short cache over the lot: a person typing in the
 * search box would otherwise spend the whole budget on the first word.
 */
const MIN_GAP_MS = 1500;
const CACHE_MS = 5 * 60 * 1000;
const CACHE_MAX = 60;

const cache = new Map();
let chain = Promise.resolve();
let lastAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cached(url) {
  const hit = cache.get(url);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_MS) {
    cache.delete(url);
    return undefined;
  }
  return hit.html;
}

function remember(url, html) {
  cache.set(url, { html, at: Date.now() });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/** For the tests, and for a proxy that wants a clean slate. */
export function forgetScholar() {
  cache.clear();
  lastAt = 0;
}

/**
 * One Scholar page. Queued behind any other, spaced out, cached, and with a
 * refusal turned into a `ScholarBlocked` rather than a page of captcha HTML
 * that the parsers would read as "no results".
 *
 * `fetchPage` is how the request is actually made, so the Node server can hand
 * in a real browser (see `server/scholarBrowser.js`) while the Worker uses
 * plain fetch.
 */
export async function getScholar(url, { fetchPage = plainFetch, signal } = {}) {
  const hit = cached(url);
  if (hit) return hit;

  const run = chain.then(async () => {
    const again = cached(url);
    if (again) return again;
    const wait = MIN_GAP_MS - (Date.now() - lastAt);
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    const { status, html } = await fetchPage(url, { signal });
    const reason = blockedReason(html, status);
    if (reason) throw new ScholarBlocked(reason, url);
    if (status >= 400) throw new Error(`Google Scholar answered ${status}`);
    remember(url, html);
    return html;
  });
  // A failure must not break the queue for everyone behind it.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** The plain way: one HTTPS request, with a browser's headers. */
export async function plainFetch(url, { signal } = {}) {
  const response = await fetch(url, {
    signal,
    redirect: 'follow',
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      // Scholar in English, and past the consent interstitial some regions get.
      Cookie: 'GSP=LM=1:S=scholar; CONSENT=YES+',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Upgrade-Insecure-Requests': '1',
    },
  });
  return { status: response.status, html: await response.text() };
}
