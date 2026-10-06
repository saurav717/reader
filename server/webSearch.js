/**
 * The web, for Ask AI: a search, and a page read as text.
 *
 * Ask AI's models answer from the paper on screen. With the window's Web
 * button on, the model may also look things up — what a cited paper found,
 * what has happened since, what a term means — and it does so through two
 * tools the proxy answers, `GET /web/search?q=` and `GET /web/page?url=`,
 * never from the page itself: the search is metered on the proxy owner's
 * account, and a browser cannot fetch an arbitrary site anyway.
 *
 * The search is asked of whichever service the proxy has a key for, in
 * this order: Tavily (TAVILY_KEY — made for exactly this, a thousand
 * searches a month free), then Brave (BRAVE_KEY), then Serply's Google
 * endpoint, then SerpApi's Google engine (SERPLY_KEY and SERPAPI_KEY, the
 * keys Scholar already uses). Each answers the same
 * shape: a few results, each a title, an address and a snippet. Both
 * routes want the proxy's token or a pass, like the rest of what spends.
 *
 * A page is fetched as a plain HTTP client would, its HTML reduced to text
 * — scripts, styles, navigation and the rest dropped — and cut to a size a
 * model reads in one go. Only http and https, and never an address inside
 * the proxy's own network: the model's argument is the model's, not the
 * reader's, and a proxy that fetched what it was told to would be a way
 * into wherever it runs.
 *
 * Written against web APIs only, so the Worker imports it as the Node
 * proxy does.
 */

export const TAVILY_HOST = 'https://api.tavily.com';
export const BRAVE_HOST = 'https://api.search.brave.com';
export const SERPLY_HOST = 'https://api.serply.io';
export const SERPAPI_HOST = 'https://serpapi.com';

/** How many results a search answers with. */
export const RESULTS = 8;
/** The longest query the proxy will send on. */
export const MAX_QUERY = 300;
/** The most of a page the model is handed, in characters. */
export const MAX_PAGE_CHARS = 40_000;
/** The most of a page the proxy will read from the wire before giving up on it. */
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
/** How long one fetch may take. */
const TIMEOUT_MS = 15_000;

export class WebRefused extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const str = (value) => (typeof value === 'string' ? value.trim() : '');
const list = (value) => (Array.isArray(value) ? value : []);

/** Which services the proxy can search with, from the keys it holds; the first is asked. */
export function searchServices(keys = {}) {
  return ['tavily', 'brave', 'serply', 'serpapi'].filter((name) => str(keys[name]));
}

/** Whether the proxy can search the web at all. */
export const webAvailable = (keys) => searchServices(keys).length > 0;

/** The query as it will be sent: one line, trimmed, cut at MAX_QUERY; or a refusal. */
export function checkQuery(value) {
  const query = str(value).replace(/\s+/g, ' ');
  if (!query) throw new WebRefused(400, 'q, the words to search for, is required');
  return query.slice(0, MAX_QUERY);
}

/**
 * The address of a page the proxy may fetch for the model: http or https,
 * a public host by name — not an address, not localhost, not a name that
 * only resolves inside a network.
 */
export function checkPageUrl(value) {
  let url;
  try {
    url = new URL(str(value));
  } catch {
    throw new WebRefused(400, 'url must be a full web address');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WebRefused(400, 'only http and https pages can be read');
  if (url.username || url.password) throw new WebRefused(400, 'an address with a password in it is not read');
  const host = url.hostname.toLowerCase();
  const bare = host.replace(/^\[|\]$/g, '');
  // An address rather than a name: dotted, bracketed IPv6, or a bare number in any base.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(':') || /^(\d+|0x[0-9a-f]+)$/i.test(bare)) {
    throw new WebRefused(400, 'a page is read by its name, not an address');
  }
  if (!host.includes('.') || host === 'localhost' || /\.(localhost|local|internal|lan|home|corp|intranet|arpa)$/.test(host)) {
    throw new WebRefused(400, 'that address is not on the public web');
  }
  url.hash = '';
  return url;
}

// ---------------------------------------------------------------- search ----

/** Tavily is asked by POST: the address, and the body beside it. */
export const TAVILY_URL = `${TAVILY_HOST}/search`;
export function tavilyBody(query, count = RESULTS) {
  return { query, max_results: count, search_depth: 'basic', include_answer: false, include_raw_content: false, include_images: false };
}

export function braveUrl(query, count = RESULTS) {
  return `${BRAVE_HOST}/res/v1/web/search?${new URLSearchParams({ q: query, count: String(count), text_decorations: 'false' })}`;
}

export function serplyUrl(query, count = RESULTS) {
  return `${SERPLY_HOST}/v1/search?${new URLSearchParams({ q: query, num: String(count) })}`;
}

export function serpApiUrl(query, key, count = RESULTS) {
  return `${SERPAPI_HOST}/search.json?${new URLSearchParams({ engine: 'google', q: query, num: String(count), hl: 'en', api_key: key })}`;
}

const result = (title, url, snippet, age) => {
  const link = str(url);
  if (!/^https?:\/\//i.test(link) || !str(title)) return null;
  return { title: str(title), url: link, snippet: str(snippet), ...(str(age) ? { age: str(age) } : {}) };
};

/** Tavily's `results[]`: title, url, content (a passage of the page), and when it was published. */
export function fromTavily(json) {
  return list(json?.results)
    .map((entry) => result(entry?.title, entry?.url, entry?.content, entry?.published_date))
    .filter(Boolean);
}

/** Brave's `web.results[]`: title, url, description, and when the page was seen. */
export function fromBrave(json) {
  return list(json?.web?.results)
    .map((entry) => result(entry?.title, entry?.url, entry?.description, entry?.age || entry?.page_age))
    .filter(Boolean);
}

/** Serply's `results[]`: title, link, description. */
export function fromSerply(json) {
  return list(json?.results)
    .map((entry) => result(entry?.title, entry?.link, entry?.description || entry?.snippet))
    .filter(Boolean);
}

/** SerpApi's `organic_results[]`: title, link, snippet, date. */
export function fromSerpApi(json) {
  return list(json?.organic_results)
    .map((entry) => result(entry?.title, entry?.link, entry?.snippet, entry?.date))
    .filter(Boolean);
}

async function readJson(response, service) {
  const text = await response.text();
  if (!response.ok) {
    const status = response.status === 401 || response.status === 403 ? 502 : response.status === 429 ? 429 : 502;
    const why = response.status === 401 || response.status === 403 ? 'refused the proxy’s key' : response.status === 429 ? 'is rate limiting the proxy' : `answered ${response.status}`;
    throw new WebRefused(status, `${service} ${why}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new WebRefused(502, `${service} answered with something that was not JSON`);
  }
}

/** The caller's signal, if any, and a timeout, as one. */
function signalFor(signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), TIMEOUT_MS);
  controller.signal.addEventListener('abort', () => clearTimeout(timer));
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/**
 * The web searched for `query` on the first service the proxy has a key
 * for: its results, and which service answered. The query is checked here,
 * so a route need only hand the parameter on.
 */
export async function searchWeb(query, keys = {}, { fetchImpl = (...args) => fetch(...args), signal } = {}) {
  const q = checkQuery(query);
  const [service] = searchServices(keys);
  if (!service) throw new WebRefused(501, 'this proxy has no web search key: set TAVILY_KEY, BRAVE_KEY, SERPLY_KEY or SERPAPI_KEY');
  const key = str(keys[service]);
  if (service === 'tavily') {
    const response = await fetchImpl(TAVILY_URL, {
      method: 'POST',
      signal: signalFor(signal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(tavilyBody(q)),
    });
    return { query: q, via: 'tavily', results: fromTavily(await readJson(response, 'Tavily')) };
  }
  if (service === 'brave') {
    const response = await fetchImpl(braveUrl(q), { signal: signalFor(signal), headers: { Accept: 'application/json', 'X-Subscription-Token': key } });
    return { query: q, via: 'brave', results: fromBrave(await readJson(response, 'Brave')) };
  }
  if (service === 'serply') {
    const response = await fetchImpl(serplyUrl(q), {
      signal: signalFor(signal),
      // Serply sits behind Cloudflare, which turns away a library's User-Agent.
      headers: { Accept: 'application/json', 'X-Api-Key': key, 'User-Agent': 'reader-proxy/1.0' },
    });
    return { query: q, via: 'serply', results: fromSerply(await readJson(response, 'Serply')) };
  }
  const response = await fetchImpl(serpApiUrl(q, key), { signal: signalFor(signal), headers: { Accept: 'application/json' } });
  const json = await readJson(response, 'SerpApi');
  if (str(json?.error)) throw new WebRefused(502, `SerpApi: ${json.error}`);
  return { query: q, via: 'serpapi', results: fromSerpApi(json) };
}

// ------------------------------------------------------------------ pages ----

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©' };

/** The few entities that matter in prose, decoded; the rest are left as they are. */
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** The page's title, from <title>. */
export function titleOf(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim() : '';
}

/**
 * A page's HTML as the text a person reads: the parts that are not prose —
 * scripts, styles, menus, footers, the head — dropped, the article kept
 * when the page marks one, block elements ending lines, and the whitespace
 * collapsed. Rough, and enough for a model to read a page by.
 */
export function textOfHtml(html) {
  let body = String(html || '');
  // What is marked as the content, when it is; else the body.
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  if (main && main[2].replace(/<[^>]+>/g, '').trim().length > 500) body = main[2];
  else {
    const only = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(body);
    if (only) body = only[1];
  }
  body = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|head|nav|footer|aside|form|button|select)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|main|header|ul|ol|dl|dt|dd|tr|table|thead|tbody|h[1-6]|blockquote|pre|figure|figcaption|details|summary)\b[^>]*>/gi, '\n')
    .replace(/<(li)\b[^>]*>/gi, '\n- ')
    .replace(/<(h[1-6])\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(body)
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A page, read for the model: its title and its text, cut at MAX_PAGE_CHARS
 * and said so. HTML and plain text are read; a PDF or anything else is
 * named for what it is, since the model asked for a page.
 */
export async function readPage(value, { fetchImpl = (...args) => fetch(...args), signal } = {}) {
  const url = checkPageUrl(value);
  let response;
  try {
    response = await fetchImpl(url.href, {
      signal: signalFor(signal),
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Language': 'en',
        'User-Agent': 'Mozilla/5.0 (compatible; reader-proxy/1.0; +https://github.com/saurav717/reader)',
      },
    });
  } catch (error) {
    throw new WebRefused(502, error?.name === 'TimeoutError' ? 'that page took too long to answer' : 'that page could not be reached');
  }
  if (!response.ok) throw new WebRefused(502, `that page answered ${response.status}`);
  const type = (response.headers.get('Content-Type') || '').toLowerCase();
  const kind = type.includes('html') ? 'html' : type.startsWith('text/') ? 'text' : type.includes('pdf') ? 'pdf' : type.includes('json') || type.includes('xml') ? 'text' : 'other';
  if (kind === 'pdf') {
    return { url: response.url || url.href, title: '', text: '', truncated: false, note: 'That address is a PDF file, not a page. If it is a paper, it is better read by its abstract page or searched for.' };
  }
  if (kind === 'other') return { url: response.url || url.href, title: '', text: '', truncated: false, note: `That address is ${type.split(';')[0] || 'not a page'}, which cannot be read as text.` };
  const raw = await readUpTo(response, MAX_PAGE_BYTES);
  const text = kind === 'html' ? textOfHtml(raw) : raw.replace(/\r\n?/g, '\n').trim();
  const truncated = text.length > MAX_PAGE_CHARS;
  return { url: response.url || url.href, title: kind === 'html' ? titleOf(raw) : '', text: truncated ? text.slice(0, MAX_PAGE_CHARS) : text, truncated };
}

/** The body as text, up to `limit` bytes — what is past that is left unread. */
async function readUpTo(response, limit) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let read = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    read += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (read >= limit) {
      reader.cancel().catch(() => undefined);
      break;
    }
  }
  return out + decoder.decode();
}
