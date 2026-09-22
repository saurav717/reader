// Google Scholar through SerpApi: that its JSON is read into the same shapes
// the direct parsers produce, that its refusals are told apart from Scholar's,
// and that a proxy with a key asks SerpApi and nothing else — without the key
// ever leaving the proxy. SerpApi itself is not asked: its answers are saved
// in scripts/fixtures/serpapi-*.json, in its documented shape.
//
//   node --test scripts/serpapi.test.mjs

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

const { default: apiRouter } = await import('../server/api.js');
const { askSerp, forgetSerp, fromSerpAuthors, fromSerpResults, fromSerpWorks, serpProblem, serpUrl, withoutKey } =
  await import('../server/serpapi.js');

const here = dirname(fileURLToPath(import.meta.url));
const fixture = async (name) => JSON.parse(await readFile(join(here, 'fixtures', `${name}.json`), 'utf8'));
const SEARCH = await fixture('serpapi-search');
const PROFILES = await fixture('serpapi-profiles');
const AUTHOR = await fixture('serpapi-author');

beforeEach(() => forgetSerp());

describe('the asks it makes', () => {
  it('asks the Scholar engine for a query, in English, ten at a time', () => {
    const url = new URL(serpUrl('search', { query: 'attention is all you need', start: 10 }, 'k'));
    assert.equal(url.hostname, 'serpapi.com');
    assert.equal(url.searchParams.get('engine'), 'google_scholar');
    assert.equal(url.searchParams.get('q'), 'attention is all you need');
    assert.equal(url.searchParams.get('start'), '10');
    assert.equal(url.searchParams.get('hl'), 'en');
    assert.equal(url.searchParams.get('api_key'), 'k');
  });

  it('asks the profiles engine for a person and the author engine for their works', () => {
    assert.equal(new URL(serpUrl('authors', { name: 'Saurav Chennuri' }, 'k')).searchParams.get('engine'), 'google_scholar_profiles');
    assert.equal(new URL(serpUrl('authors', { name: 'Saurav Chennuri' }, 'k')).searchParams.get('mauthors'), 'Saurav Chennuri');
    const works = new URL(serpUrl('profile', { user: 'oR9sCGYAAAAJ', start: 20 }, 'k'));
    assert.equal(works.searchParams.get('engine'), 'google_scholar_author');
    assert.equal(works.searchParams.get('author_id'), 'oR9sCGYAAAAJ');
    assert.equal(works.searchParams.get('sort'), 'pubdate');
    assert.equal(works.searchParams.get('start'), '20');
  });

  it('asks a cluster for every version of one paper', () => {
    assert.equal(new URL(serpUrl('versions', { cluster: '1972994675707178528' }, 'k')).searchParams.get('cluster'), '1972994675707178528');
  });

  it('can say what it asked without saying the key', () => {
    assert.doesNotMatch(withoutKey(serpUrl('search', { query: 'x' }, 'SECRET')), /SECRET/);
  });
});

describe('reading a page of results', () => {
  const results = fromSerpResults(SEARCH);

  it('finds every result, in the shape the direct parser gives', () => {
    assert.equal(results.length, 3);
    assert.equal(results[0].id, '1DZmFRMh2t0J');
    assert.equal(results[0].title, 'Attention is all you need');
  });

  it('takes the direct file link and where it sits', () => {
    assert.equal(results[0].pdfUrl, 'https://proceedings.neurips.cc/paper/2017/file/3f5ee243547dee91fbd053c1c4a845aa-Paper.pdf');
    assert.equal(results[0].pdfKind, 'PDF');
    assert.equal(results[0].pdfHost, 'neurips.cc');
    assert.match(results[0].url, /^https:\/\/proceedings\.neurips\.cc\/paper\/2017\/hash\//);
  });

  it('reads the cluster id and the counts', () => {
    assert.equal(results[0].clusterId, '1972994675707178528');
    assert.equal(results[0].versionCount, 84);
    assert.equal(results[0].citedBy, 145231);
  });

  it('prefers the summary line for authors, which names more of them than the profile list', () => {
    assert.deepEqual(results[0].authors, ['A Vaswani', 'N Shazeer', 'N Parmar', 'J Uszkoreit']);
    assert.match(results[0].venue, /Advances in neural/);
    assert.equal(results[0].year, 2017);
  });

  it('copes with a result that has no file and no versions', () => {
    assert.equal(results[2].pdfUrl, undefined);
    assert.equal(results[2].versionCount, undefined);
    assert.equal(results[2].citedBy, 300);
  });

  it('returns nothing rather than nonsense for an answer with no results in it', () => {
    assert.deepEqual(fromSerpResults({}), []);
    assert.deepEqual(fromSerpResults({ organic_results: [{ snippet: 'no title' }] }), []);
  });
});

describe('reading the profile search', () => {
  const authors = fromSerpAuthors(PROFILES);

  it('finds each person, with the id their papers are asked for by', () => {
    assert.equal(authors.length, 2);
    assert.equal(authors[0].name, 'Ashish Vaswani');
    assert.equal(authors[0].userId, 'oR9sCGYAAAAJ');
    assert.match(authors[0].profileUrl, /^https:\/\/scholar\.google\.com\/citations/);
  });

  it('reads the affiliation, the interests and the verified domain', () => {
    assert.equal(authors[0].affiliation, 'Essential AI');
    assert.deepEqual(authors[0].interests, ['Machine Learning', 'Deep Learning']);
    assert.equal(authors[0].verifiedEmail, 'essential.ai');
    assert.equal(authors[0].citedBy, 231507);
  });

  it('makes a relative profile link absolute', () => {
    assert.equal(authors[1].profileUrl, 'https://scholar.google.com/citations?hl=en&user=AAAAAAAAAAAJ');
  });
});

describe('reading a profile’s own list of works', () => {
  const works = fromSerpWorks(AUTHOR);

  it('finds each entry with its authors, venue, year and citations', () => {
    assert.equal(works.length, 2);
    assert.equal(works[0].title, 'Attention is all you need');
    assert.equal(works[0].authors[0], 'A Vaswani');
    assert.equal(works[0].venue, 'Advances in neural information processing systems 30');
    assert.equal(works[0].year, 2017);
    assert.equal(works[0].citedBy, 145231);
  });

  it('drops the ellipsis Scholar truncates an author list with', () => {
    assert.deepEqual(works[1].authors, ['A Vaswani', 'S Bengio', 'E Brevdo', 'F Chollet', 'AN Gomez']);
  });
});

describe('being refused by SerpApi, which is not being refused by Scholar', () => {
  it('knows a bad key', () => {
    assert.equal(serpProblem({ error: 'Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key' }, 401).reason, 'key');
  });

  it('knows a spent allowance, and says whose it is', () => {
    const problem = serpProblem({ error: 'You are exceeding your monthly searches limit.' }, 429);
    assert.equal(problem.reason, 'rate-limited');
    assert.match(problem.message, /allowance/);
  });

  it('treats "no results" as an empty page, not a failure', () => {
    assert.equal(serpProblem({ error: "Google hasn't returned any results for this query." }, 200), null);
    assert.equal(serpProblem(SEARCH, 200), null);
  });

  it('raises a refusal as an error that is not a captcha', async () => {
    await assert.rejects(
      askSerp('search', { query: 'x' }, 'k', { fetchJson: async () => ({ status: 401, json: { error: 'Invalid API key' } }) }),
      (error) => {
        assert.equal(error.serpapi, true);
        assert.equal(error.blocked, false);
        return true;
      },
    );
  });

  it('asks once for a page it has already been given', async () => {
    let asked = 0;
    const fetchJson = async () => {
      asked += 1;
      return { status: 200, json: SEARCH };
    };
    await askSerp('search', { query: 'cached' }, 'k', { fetchJson });
    await askSerp('search', { query: 'cached' }, 'k', { fetchJson });
    assert.equal(asked, 1);
  });
});

describe('a proxy with a key', () => {
  const server = createServer((req, res) => apiRouter(req, res));
  const asked = [];
  const realFetch = globalThis.fetch;

  it('asks SerpApi, and never Scholar, and never lets the key out', async () => {
    await new Promise((resolve) => server.listen(0, resolve));
    const base = `http://localhost:${server.address().port}`;
    process.env.SERPAPI_KEY = 'SECRET-KEY';
    globalThis.fetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(base)) return realFetch(input);
      asked.push(url);
      const engine = new URL(url).searchParams.get('engine');
      const json = engine === 'google_scholar_profiles' ? PROFILES : engine === 'google_scholar_author' ? AUTHOR : SEARCH;
      return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const health = await (await realFetch(`${base}/health`)).json();
      assert.equal(health.scholar, 'serpapi');

      const response = await realFetch(`${base}/scholar/authors?name=Ashish%20Vaswani`);
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.doesNotMatch(text, /SECRET-KEY/);
      const payload = JSON.parse(text);
      assert.equal(payload.via, 'serpapi');
      assert.equal(payload.results[0].userId, 'oR9sCGYAAAAJ');

      const works = await (await realFetch(`${base}/scholar/profile?user=oR9sCGYAAAAJ`)).json();
      assert.equal(works.results[0].title, 'Attention is all you need');

      assert.ok(asked.length >= 2);
      assert.ok(asked.every((url) => url.startsWith('https://serpapi.com/')), asked.join('\n'));
      assert.ok(asked.every((url) => url.includes('api_key=SECRET-KEY')));
    } finally {
      delete process.env.SERPAPI_KEY;
      globalThis.fetch = realFetch;
      server.close();
    }
  });

  it('says its refusal is SerpApi’s, so the app does not offer a captcha window for it', async () => {
    await new Promise((resolve) => server.listen(0, resolve));
    const base = `http://localhost:${server.address().port}`;
    process.env.SERPAPI_KEY = 'SECRET-KEY';
    globalThis.fetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(base)) return realFetch(input);
      return new Response(JSON.stringify({ error: 'You are exceeding your monthly searches limit.' }), { status: 429 });
    };
    try {
      const response = await realFetch(`${base}/scholar/search?q=anything`);
      assert.equal(response.status, 503);
      const payload = await response.json();
      assert.equal(payload.serpapi, true);
      assert.notEqual(payload.blocked, true);
      assert.equal(payload.url, undefined);
    } finally {
      delete process.env.SERPAPI_KEY;
      globalThis.fetch = realFetch;
      server.close();
    }
  });

  after(() => {
    globalThis.fetch = realFetch;
  });
});
