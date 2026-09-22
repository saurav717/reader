// Connect-style handler mounted at /api by both the Vite dev server and the
// production Express server. Everything here exists because the browser cannot
// fetch it directly: arXiv serves no CORS headers, and neither do most of the
// publishers and repositories an open-access PDF link points at.

import { disposition, fetchChecked, readPdf, rejectUrl } from './fetchPdf.js';
import {
  authorSearchUrl,
  getScholar,
  parseAuthors,
  parseProfileWorks,
  parseResults,
  plainFetch,
  profileUrl,
  searchUrl,
  versionsUrl,
} from './scholar.js';
import { scholarFetcher } from './scholarBrowser.js';

const ARXIV_ID = /^(?:[0-9]{4}\.[0-9]{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/[0-9]{7})(?:v[0-9]+)?$/;

const UA = 'reader/0.1 (personal research reading tool)';

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function arxivQuery(url, res) {
  const params = new URLSearchParams();
  for (const key of ['search_query', 'id_list', 'start', 'max_results', 'sortBy', 'sortOrder']) {
    const value = url.searchParams.get(key);
    if (value) params.set(key, value);
  }
  if (!params.has('search_query') && !params.has('id_list')) {
    return send(res, 400, { error: 'search_query or id_list is required' });
  }
  const upstream = await fetch(`https://export.arxiv.org/api/query?${params}`, {
    headers: { 'User-Agent': UA },
  });
  const text = await upstream.text();
  res.writeHead(upstream.ok ? 200 : upstream.status, {
    'Content-Type': 'application/atom+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  });
  res.end(text);
}

// arXiv publishes native HTML for recent submissions; ar5iv has LaTeXML
// conversions of nearly everything older. Try the native one first.
async function arxivHtml(url, res) {
  const id = url.searchParams.get('id') || '';
  if (!ARXIV_ID.test(id)) return send(res, 400, { error: 'bad arXiv id' });
  const bare = id.replace(/v[0-9]+$/, '');
  const candidates = [
    { url: `https://arxiv.org/html/${id}`, source: 'arxiv' },
    { url: `https://ar5iv.labs.arxiv.org/html/${bare}`, source: 'ar5iv' },
  ];
  for (const candidate of candidates) {
    try {
      const upstream = await fetch(candidate.url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (!upstream.ok) continue;
      const html = await upstream.text();
      // ar5iv answers 200 with a stub when it has no conversion for a paper.
      if (html.length < 2000 || /No HTML for/i.test(html)) continue;
      return send(res, 200, { html, source: candidate.source, base: upstream.url }, {
        'Cache-Control': 'public, max-age=3600',
      });
    } catch {
      // try the next candidate
    }
  }
  return send(res, 404, { error: 'no HTML rendering available for this paper' });
}

async function arxivPdf(url, res) {
  const id = url.searchParams.get('id') || '';
  if (!ARXIV_ID.test(id)) return send(res, 400, { error: 'bad arXiv id' });
  const upstream = await fetch(`https://arxiv.org/pdf/${id}`, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
  });
  if (!upstream.ok) return send(res, upstream.status, { error: 'could not fetch PDF' });
  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': buffer.length,
    'Content-Disposition': disposition(url.searchParams),
    'Cache-Control': 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buffer);
}

// Any other open-access PDF: OpenAlex and Semantic Scholar hand out links to
// publishers and repositories that send no CORS headers either, so the browser
// needs this route to read them. See server/fetchPdf.js for what it refuses.
async function pdf(url, res) {
  const target = url.searchParams.get('url') || '';
  const reason = rejectUrl(target);
  if (reason) return send(res, 400, { error: reason });

  let result;
  try {
    result = await fetchChecked(target, { userAgent: UA });
  } catch (error) {
    return send(res, 400, { error: String(error?.message || error) });
  }
  const { response } = result;
  if (!response.ok) {
    return send(res, response.status === 404 ? 404 : 502, {
      error: `the publisher answered ${response.status} for that PDF`,
    });
  }

  let bytes;
  try {
    bytes = await readPdf(response, response.headers.get('content-type'));
  } catch (error) {
    return send(res, 415, { error: String(error?.message || error) });
  }

  const buffer = Buffer.from(bytes);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': buffer.length,
    'Content-Disposition': disposition(url.searchParams),
    'Cache-Control': 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buffer);
}

// ------------------------------------------------------------- Scholar ----
//
// Google publishes no API for Scholar, so these routes fetch the pages a
// person would open and parse them. See server/scholar.js for what that costs
// and how often it is refused; a captcha comes back as 503 with
// `blocked: true`, which is how the app knows to say so and use its other
// sources rather than showing an empty list.

/** Resolved once: a real browser where asked for, plain requests otherwise. */
let fetchPage;
const scholarPage = async (url, options) => {
  if (!fetchPage) fetchPage = await scholarFetcher(plainFetch);
  return fetchPage(url, options);
};

/**
 * Swap in another way of getting a Scholar page. The end-to-end test hands in
 * saved fixtures so that it exercises these routes and the parsing for real
 * without anything leaving the machine; `scripts/scholar-live.mjs` uses it the
 * other way, to force a browser.
 */
export function setScholarFetcher(fetcher) {
  fetchPage = fetcher;
}

async function scholar(url, res, parse) {
  try {
    const html = await getScholar(url, { fetchPage: scholarPage });
    return send(res, 200, { results: parse(html), source: 'scholar' }, { 'Cache-Control': 'private, max-age=300' });
  } catch (error) {
    if (error && error.blocked) {
      return send(res, 503, { error: error.message, blocked: true, reason: error.reason });
    }
    return send(res, 502, { error: String(error?.message || error) });
  }
}

function scholarSearch(url, res) {
  const query = (url.searchParams.get('q') || '').trim();
  if (!query) return send(res, 400, { error: 'q is required' });
  const start = Math.max(0, Math.min(90, Number(url.searchParams.get('start')) || 0));
  return scholar(searchUrl(query, { start }), res, parseResults);
}

function scholarAuthors(url, res) {
  const name = (url.searchParams.get('name') || '').trim();
  if (!name) return send(res, 400, { error: 'name is required' });
  return scholar(authorSearchUrl(name), res, parseAuthors);
}

function scholarProfile(url, res) {
  const user = (url.searchParams.get('user') || '').trim();
  if (!/^[\w-]{6,32}$/.test(user)) return send(res, 400, { error: 'bad Scholar profile id' });
  const start = Math.max(0, Number(url.searchParams.get('start')) || 0);
  return scholar(profileUrl(user, { start }), res, parseProfileWorks);
}

function scholarVersions(url, res) {
  const cluster = (url.searchParams.get('cluster') || '').trim();
  if (!/^\d{1,25}$/.test(cluster)) return send(res, 400, { error: 'bad cluster id' });
  return scholar(versionsUrl(cluster), res, parseResults);
}

// Only the handful of hosts the app actually reads from; an open proxy here
// would let any page on this origin fetch anything as the server.
const ASSET_HOSTS = new Set(['arxiv.org', 'ar5iv.labs.arxiv.org', 'ar5iv.org', 'browse.arxiv.org']);

async function asset(url, res) {
  const target = url.searchParams.get('url') || '';
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return send(res, 400, { error: 'bad url' });
  }
  if (parsed.protocol !== 'https:' || !ASSET_HOSTS.has(parsed.hostname)) {
    return send(res, 403, { error: 'host not allowed' });
  }
  const upstream = await fetch(parsed, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!upstream.ok) return send(res, upstream.status, { error: 'upstream error' });
  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Content-Length': buffer.length,
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(buffer);
}

export default async function apiRouter(req, res, next) {
  const url = new URL(req.url || '/', 'http://localhost');
  try {
    switch (url.pathname) {
      case '/arxiv/query':
        return await arxivQuery(url, res);
      case '/arxiv/html':
        return await arxivHtml(url, res);
      case '/arxiv/pdf':
        return await arxivPdf(url, res);
      case '/pdf':
        return await pdf(url, res);
      case '/scholar/search':
        return await scholarSearch(url, res);
      case '/scholar/authors':
        return await scholarAuthors(url, res);
      case '/scholar/profile':
        return await scholarProfile(url, res);
      case '/scholar/versions':
        return await scholarVersions(url, res);
      case '/asset':
        return await asset(url, res);
      case '/health':
        return send(res, 200, { ok: true });
      default:
        if (next) return next();
        return send(res, 404, { error: 'not found' });
    }
  } catch (error) {
    return send(res, 502, { error: String(error && error.message ? error.message : error) });
  }
}
