// The web for Ask AI, without a network or a key: which service a search
// goes to and how its answer is read, what a page becomes as text, which
// addresses the proxy refuses to fetch, and the Node proxy's two routes.
//
//   node --test scripts/web-search.test.mjs

import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.READER_SCHOLAR_PROFILE_DIR = join(tmpdir(), `reader-no-scholar-profile-${process.pid}`);
process.env.READER_PROFILE_DIR = join(tmpdir(), `reader-no-profile-${process.pid}`);
delete process.env.READER_TOKEN;
delete process.env.BRAVE_KEY;
delete process.env.SERPLY_KEY;
delete process.env.SERPAPI_KEY;

const { default: apiRouter } = await import('../server/api.js');
const web = await import('../server/webSearch.js');

const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });

describe('the query and the address', () => {
  it('trims a query to one line and a length, and refuses an empty one', () => {
    assert.equal(web.checkQuery('  attention \n is all   you need '), 'attention is all you need');
    assert.equal(web.checkQuery('x'.repeat(500)).length, web.MAX_QUERY);
    assert.throws(() => web.checkQuery('   '), /required/);
  });

  it('reads pages by name on the public web only', () => {
    assert.equal(web.checkPageUrl('https://example.com/a?b=1#frag').href, 'https://example.com/a?b=1');
    for (const refused of ['ftp://example.com/x', 'http://127.0.0.1/', 'http://[::1]/', 'http://localhost/', 'http://2130706433/', 'http://0x7f000001/', 'https://box.internal/', 'https://intranet/', 'https://user:pw@example.com/']) {
      assert.throws(() => web.checkPageUrl(refused), web.WebRefused, refused);
    }
    assert.throws(() => web.checkPageUrl('not a url'), /full web address/);
  });
});

describe('a search', () => {
  it('goes to Brave first, then Serply, then SerpApi, by the keys the proxy holds', () => {
    assert.deepEqual(web.searchServices({ brave: 'b', serply: 's', serpapi: 'a' }), ['brave', 'serply', 'serpapi']);
    assert.deepEqual(web.searchServices({ serpapi: 'a' }), ['serpapi']);
    assert.deepEqual(web.searchServices({ brave: ' ' }), []);
    assert.equal(web.webAvailable({}), false);
  });

  it('reads each service’s results as a title, an address and a snippet', () => {
    assert.deepEqual(web.fromBrave({ web: { results: [{ title: 'A', url: 'https://a.example/', description: 'about a', age: 'May 1, 2026' }, { title: '', url: 'https://b.example/' }, { title: 'C', url: 'javascript:alert(1)' }] } }), [
      { title: 'A', url: 'https://a.example/', snippet: 'about a', age: 'May 1, 2026' },
    ]);
    assert.deepEqual(web.fromSerply({ results: [{ title: 'S', link: 'https://s.example/', description: 'd' }] }), [{ title: 'S', url: 'https://s.example/', snippet: 'd' }]);
    assert.deepEqual(web.fromSerpApi({ organic_results: [{ title: 'G', link: 'https://g.example/', snippet: 'sn', date: 'Jun 2, 2026' }] }), [{ title: 'G', url: 'https://g.example/', snippet: 'sn', age: 'Jun 2, 2026' }]);
  });

  it('asks Brave with the key in its header, and says it was Brave', async () => {
    const sent = [];
    const fetchImpl = async (url, init) => {
      sent.push({ url, headers: init.headers });
      return jsonResponse({ web: { results: [{ title: 'A', url: 'https://a.example/', description: 'x' }] } });
    };
    const found = await web.searchWeb(' hello  world ', { brave: 'bk', serply: 'sk' }, { fetchImpl });
    assert.equal(found.via, 'brave');
    assert.equal(found.query, 'hello world');
    assert.equal(found.results.length, 1);
    assert.match(sent[0].url, /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?q=hello\+world/);
    assert.equal(sent[0].headers['X-Subscription-Token'], 'bk');
  });

  it('asks Serply when that is the key, and SerpApi with the key in the address', async () => {
    const sent = [];
    const fetchImpl = async (url, init) => {
      sent.push({ url, headers: init.headers });
      return jsonResponse(url.includes('serply') ? { results: [] } : { organic_results: [] });
    };
    assert.equal((await web.searchWeb('q', { serply: 'sk' }, { fetchImpl })).via, 'serply');
    assert.equal(sent[0].headers['X-Api-Key'], 'sk');
    assert.equal((await web.searchWeb('q', { serpapi: 'ak' }, { fetchImpl })).via, 'serpapi');
    assert.match(sent[1].url, /serpapi\.com\/search\.json\?engine=google&q=q&.*api_key=ak/);
  });

  it('says what is wrong: no key, a refused key, a rate limit', async () => {
    await assert.rejects(web.searchWeb('q', {}), (error) => error instanceof web.WebRefused && error.status === 501);
    const refused = async () => new Response('nope', { status: 403 });
    await assert.rejects(web.searchWeb('q', { brave: 'k' }, { fetchImpl: refused }), (error) => error.status === 502 && /refused/.test(error.message));
    const limited = async () => new Response('slow down', { status: 429 });
    await assert.rejects(web.searchWeb('q', { brave: 'k' }, { fetchImpl: limited }), (error) => error.status === 429);
  });
});

describe('a page as text', () => {
  const PAGE = `<!doctype html><html><head><title>Attention &amp; Transformers</title><style>p{}</style><script>track()</script></head>
<body><nav><a href="/">Home</a> <a href="/x">More</a></nav>
<h1>Attention</h1><p>It&rsquo;s a mechanism &mdash; see &#167; 3.</p>
<ul><li>one</li><li>two</li></ul>
<footer>&copy; nobody</footer><script>more()</script></body></html>`;

  it('keeps the prose and drops the chrome', () => {
    const text = web.textOfHtml(PAGE);
    assert.match(text, /^Attention\nIt’s a mechanism — see § 3\.\n\n- one\n- two$/);
    assert.equal(web.titleOf(PAGE), 'Attention & Transformers');
  });

  it('prefers the article when the page marks one', () => {
    const filler = 'word '.repeat(200);
    const html = `<body><div>sidebar junk</div><article><p>${filler}</p></article><div>more junk</div></body>`;
    assert.equal(web.textOfHtml(html), filler.trim());
  });

  it('is fetched by the proxy, cut at a size, and a PDF is named for what it is', async () => {
    const long = `<html><head><title>Long</title></head><body><p>${'a'.repeat(web.MAX_PAGE_CHARS + 100)}</p></body></html>`;
    const fetchImpl = async (url) => {
      if (url.includes('pdf')) return new Response('%PDF-', { headers: { 'Content-Type': 'application/pdf' } });
      return new Response(long, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    };
    const page = await web.readPage('https://example.com/long', { fetchImpl });
    assert.equal(page.title, 'Long');
    assert.equal(page.text.length, web.MAX_PAGE_CHARS);
    assert.equal(page.truncated, true);
    const pdf = await web.readPage('https://example.com/paper.pdf', { fetchImpl });
    assert.equal(pdf.text, '');
    assert.match(pdf.note, /PDF/);
  });
});

describe('the Node proxy’s /web routes', () => {
  const server = createServer((req, res) => apiRouter(req, res));
  const realFetch = globalThis.fetch;
  const sent = [];
  let base;
  const ready = new Promise((resolve) => server.listen(0, resolve)).then(() => {
    base = `http://localhost:${server.address().port}`;
    globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(base)) return realFetch(input, init);
      sent.push({ url, key: init?.headers?.['X-Subscription-Token'] });
      if (url.includes('brave')) return jsonResponse({ web: { results: [{ title: 'A', url: 'https://a.example/', description: 'x' }] } });
      return new Response('<html><head><title>P</title></head><body><p>Hello page</p></body></html>', { headers: { 'Content-Type': 'text/html' } });
    };
  });
  const get = async (path) => {
    await ready;
    const response = await realFetch(`${base}${path}`);
    return { status: response.status, body: await response.json() };
  };
  afterEach(() => {
    delete process.env.BRAVE_KEY;
    sent.length = 0;
  });
  after(() => {
    globalThis.fetch = realFetch;
    server.close();
  });

  it('says on /health whether it can search, and 501 until a key is set', async () => {
    assert.equal((await get('/health')).body.web, false);
    const { status, body } = await get('/web/search?q=hello');
    assert.equal(status, 501);
    assert.equal(body.setup, true);
    process.env.BRAVE_KEY = 'bk';
    assert.equal((await get('/health')).body.web, true);
  });

  it('searches on the proxy’s key, and refuses an empty query', async () => {
    process.env.BRAVE_KEY = 'bk';
    const { status, body } = await get('/web/search?q=hello');
    assert.equal(status, 200);
    assert.equal(body.via, 'brave');
    assert.equal(body.results[0].url, 'https://a.example/');
    assert.equal(sent[0].key, 'bk');
    assert.equal((await get('/web/search')).status, 400);
  });

  it('reads a page as text, and not an address inside the network', async () => {
    const { status, body } = await get(`/web/page?url=${encodeURIComponent('https://example.com/p')}`);
    assert.equal(status, 200);
    assert.equal(body.title, 'P');
    assert.equal(body.text, 'Hello page');
    assert.equal((await get(`/web/page?url=${encodeURIComponent('http://127.0.0.1:8080/admin')}`)).status, 400);
    assert.equal(sent.length, 1, 'the refused address was never fetched');
  });
});
