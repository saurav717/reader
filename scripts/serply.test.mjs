// Google Scholar through Serply: that its page fetch is asked for Scholar's
// own pages and nothing else, that what it hands back is read by the same
// parsers as a page fetched directly, that its refusals — and Scholar's
// refusals of it — are told apart from a captcha a person here could solve,
// and that a proxy with a key asks Serply, falls back to SerpApi when it has
// that key too, and never lets either key out. Serply itself is not asked:
// its answers wrap the saved Scholar pages in scripts/fixtures/scholar-*.html
// in the shape its page fetch documents for `response_type: 'full'`.
//
//   node --test scripts/serply.test.mjs

import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.READER_SCHOLAR_PROFILE_DIR = join(tmpdir(), `reader-no-scholar-profile-${process.pid}`);
process.env.READER_PROFILE_DIR = join(tmpdir(), `reader-no-profile-${process.pid}`);
delete process.env.SCHOLAR_BROWSER;
delete process.env.SERPAPI_KEY;
delete process.env.SERPLY_KEY;

const { default: apiRouter } = await import('../server/api.js');
const { askSerply, fromSerplyPage, serplyFetcher, serplyProblem, SERPLY_HOST } = await import('../server/serply.js');
const { forgetScholar, parseAuthors, parseCitationView, parseProfileWorks, parseResults, authorSearchUrl, profileUrl, searchUrl, workUrl } =
  await import('../server/scholar.js');
const { forgetSerp } = await import('../server/serpapi.js');

const here = dirname(fileURLToPath(import.meta.url));
const page = (name) => readFile(join(here, 'fixtures', `${name}.html`), 'utf8');
const SEARCH = await page('scholar-search');
const AUTHORS = await page('scholar-authors');
const PROFILE = await page('scholar-profile');
const WORK = await page('scholar-work');
const CAPTCHA = await page('scholar-captcha');
const SERP_SEARCH = JSON.parse(await readFile(join(here, 'fixtures', 'serpapi-search.json'), 'utf8'));

/** Serply's page fetch, answering with `html` for Scholar's `status`. */
const full = (html, status = 200) => new Response(JSON.stringify({ status, headers: {}, data: html }), { status: 200 });

/** The Scholar page a request to Serply asked for. */
const pageFor = (url) => {
  const target = new URL(url);
  const view = target.searchParams.get('view_op');
  if (view === 'search_authors') return AUTHORS;
  if (view === 'view_citation') return WORK;
  if (target.pathname === '/citations') return PROFILE;
  return SEARCH;
};

beforeEach(() => {
  forgetScholar();
  forgetSerp();
});

describe('asking Serply for a Scholar page', () => {
  it('posts the page to Serply’s fetch, with the key in the header only', async () => {
    const asked = [];
    const fetchImpl = async (url, init) => {
      asked.push({ url, init });
      return full(SEARCH);
    };
    const results = await askSerply(searchUrl('attention is all you need'), parseResults, 'SECRET', { fetchImpl });
    assert.equal(results[0].title, 'Attention is all you need');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].url, `${SERPLY_HOST}/v1/request`);
    assert.equal(asked[0].init.method, 'POST');
    assert.equal(asked[0].init.headers['X-Api-Key'], 'SECRET');
    const body = JSON.parse(asked[0].init.body);
    assert.equal(body.response_type, 'full');
    assert.equal(new URL(body.url).hostname, 'scholar.google.com');
    assert.doesNotMatch(asked[0].init.body, /SECRET/);
  });

  it('fetches Scholar’s pages and nothing else', async () => {
    const fetchPage = serplyFetcher('k', { fetchImpl: async () => full('') });
    await assert.rejects(fetchPage('https://example.com/'), /only a scholar\.google\.com page/);
  });

  it('reads every kind of page the direct way can: people, a profile, one work opened', async () => {
    const fetchImpl = async (_url, init) => full(pageFor(JSON.parse(init.body).url));
    const people = await askSerply(authorSearchUrl('Ashish Vaswani'), parseAuthors, 'k', { fetchImpl });
    assert.equal(people[0].userId, 'oR9sCGYAAAAJ');
    assert.equal(people[0].affiliation, 'Essential AI');
    assert.equal(people[0].verifiedEmail, 'essential.ai');

    const works = await askSerply(profileUrl('oR9sCGYAAAAJ'), parseProfileWorks, 'k', { fetchImpl });
    assert.equal(works[0].title, 'Attention is all you need');
    assert.equal(works[0].citationId, 'oR9sCGYAAAAJ:u5HHmVD_uO8C');

    const [work] = await askSerply(workUrl('abcdefgh', 'abcdefgh:u5HHmVD_uO8C'), parseCitationView, 'k', { fetchImpl });
    assert.equal(work.pdfHost, 'bu.edu');
    assert.equal(work.clusterId, '6188253286931533296');
  });

  it('takes a plain HTML answer as the page itself', () => {
    assert.deepEqual(fromSerplyPage('<html>hi</html>'), { status: 200, html: '<html>hi</html>' });
    assert.deepEqual(fromSerplyPage(JSON.stringify({ status: 429, data: '<html/>' })), { status: 429, html: '<html/>' });
  });

  it('asks once for a page it has already been given', async () => {
    let asked = 0;
    const fetchImpl = async () => {
      asked += 1;
      return full(SEARCH);
    };
    await askSerply(searchUrl('cached once'), parseResults, 'k', { fetchImpl });
    await askSerply(searchUrl('cached once'), parseResults, 'k', { fetchImpl });
    assert.equal(asked, 1);
  });
});

describe('being refused', () => {
  it('knows a bad key, a spent allowance, going too fast, and its own fetch failing', () => {
    assert.equal(serplyProblem(401, '{"detail":"Invalid API key"}').reason, 'key');
    assert.equal(serplyProblem(402, '{"detail":"Out of credits"}').reason, 'rate-limited');
    assert.match(serplyProblem(402, '{"detail":"Out of credits"}').message, /allowance/);
    assert.equal(serplyProblem(429, '').reason, 'rate-limited');
    assert.equal(serplyProblem(502, '').reason, 'upstream');
    assert.equal(serplyProblem(200, '{}'), null);
  });

  it('tries a failed fetch of Serply’s once more before saying so', async () => {
    let asked = 0;
    const fetchImpl = async () => {
      asked += 1;
      return asked === 1 ? new Response('', { status: 502 }) : full(SEARCH);
    };
    const results = await askSerply(searchUrl('retried'), parseResults, 'k', { fetchImpl });
    assert.equal(asked, 2);
    assert.equal(results[0].title, 'Attention is all you need');
  });

  it('says a captcha shown to Serply is Serply’s, not one to open in a window here', async () => {
    await assert.rejects(
      askSerply(searchUrl('refused'), parseResults, 'k', { fetchImpl: async () => full(CAPTCHA, 200) }),
      (error) => {
        assert.equal(error.serply, true);
        assert.equal(error.blocked, false);
        assert.equal(error.reason, 'scholar-refused');
        return true;
      },
    );
  });
});

describe('a proxy with a Serply key', () => {
  const server = createServer((req, res) => apiRouter(req, res));
  const realFetch = globalThis.fetch;
  let base;

  const listen = async () => {
    await new Promise((resolve) => server.listen(0, resolve));
    base = `http://localhost:${server.address().port}`;
  };
  const stop = () => {
    delete process.env.SERPLY_KEY;
    delete process.env.SERPAPI_KEY;
    globalThis.fetch = realFetch;
    server.close();
  };

  it('asks Serply for every Scholar route, never Scholar, and never lets the key out', async () => {
    await listen();
    process.env.SERPLY_KEY = 'SERPLY-SECRET';
    const asked = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(base)) return realFetch(input, init);
      asked.push({ url, key: init?.headers?.['X-Api-Key'] });
      return full(pageFor(JSON.parse(init.body).url));
    };
    try {
      const health = await (await realFetch(`${base}/health`)).json();
      assert.equal(health.scholar, 'serply');

      const response = await realFetch(`${base}/scholar/authors?name=Ashish%20Vaswani`);
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.doesNotMatch(text, /SERPLY-SECRET/);
      const people = JSON.parse(text);
      assert.equal(people.via, 'serply');
      assert.equal(people.results[0].affiliation, 'Essential AI');

      const works = await (await realFetch(`${base}/scholar/profile?user=oR9sCGYAAAAJ`)).json();
      assert.equal(works.results[0].title, 'Attention is all you need');

      const opened = await (
        await realFetch(`${base}/scholar/work?user=oR9sCGYAAAAJ&citation=${encodeURIComponent(works.results[0].citationId)}`)
      ).json();
      assert.equal(opened.via, 'serply');
      assert.equal(opened.results[0].pdfHost, 'bu.edu');

      const search = await (await realFetch(`${base}/scholar/search?q=attention`)).json();
      assert.equal(search.results[0].title, 'Attention is all you need');

      assert.equal(asked.length, 4, 'one credit per page: people, works, a work, a search');
      assert.ok(asked.every((ask) => ask.url === `${SERPLY_HOST}/v1/request`));
      assert.ok(asked.every((ask) => ask.key === 'SERPLY-SECRET'));
    } finally {
      stop();
    }
  });

  it('says its refusal is Serply’s, so the app does not offer a captcha window for it', async () => {
    await listen();
    process.env.SERPLY_KEY = 'SERPLY-SECRET';
    globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(base)) return realFetch(input, init);
      return new Response('{"detail":"Invalid API key"}', { status: 401 });
    };
    try {
      const response = await realFetch(`${base}/scholar/search?q=anything`);
      assert.equal(response.status, 503);
      const payload = await response.json();
      assert.equal(payload.serply, true);
      assert.equal(payload.reason, 'key');
      assert.notEqual(payload.blocked, true);
      assert.equal(payload.url, undefined);
    } finally {
      stop();
    }
  });

  it('falls back to SerpApi when it has that key too and Serply refuses', async () => {
    await listen();
    process.env.SERPLY_KEY = 'SERPLY-SECRET';
    process.env.SERPAPI_KEY = 'SERPAPI-SECRET';
    const hosts = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(base)) return realFetch(input, init);
      hosts.push(new URL(url).hostname);
      if (url.startsWith(SERPLY_HOST)) return full(CAPTCHA);
      return new Response(JSON.stringify(SERP_SEARCH), { status: 200 });
    };
    try {
      const payload = await (await realFetch(`${base}/scholar/search?q=fallback`)).json();
      assert.equal(payload.via, 'serpapi');
      assert.equal(payload.results[0].title, 'Attention is all you need');
      assert.deepEqual(hosts, ['api.serply.io', 'serpapi.com']);
    } finally {
      stop();
    }
  });

  after(() => {
    globalThis.fetch = realFetch;
  });
});
