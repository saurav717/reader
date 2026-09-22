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
const {
  askSerp,
  forgetSerp,
  fromSerpAuthorProfile,
  fromSerpAuthorsInResults,
  fromSerpCitation,
  fromSerpResults,
  fromSerpWorks,
  nameCouldBe,
  serpProblem,
  serpUrl,
  withoutKey,
} = await import('../server/serpapi.js');

const here = dirname(fileURLToPath(import.meta.url));
const fixture = async (name) => JSON.parse(await readFile(join(here, 'fixtures', `${name}.json`), 'utf8'));
const SEARCH = await fixture('serpapi-search');
const AUTHOR = await fixture('serpapi-author');
const CITATION = await fixture('serpapi-citation');

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

  it('asks for a person as a search for their papers, since SerpApi has no profile search any more', () => {
    const url = new URL(serpUrl('authors', { name: 'Saurav Chennuri' }, 'k'));
    assert.equal(url.searchParams.get('engine'), 'google_scholar');
    assert.equal(url.searchParams.get('q'), 'author:"Saurav Chennuri"');
  });

  it('asks the author engine for a profile’s works', () => {
    const works = new URL(serpUrl('profile', { user: 'oR9sCGYAAAAJ', start: 20 }, 'k'));
    assert.equal(works.searchParams.get('engine'), 'google_scholar_author');
    assert.equal(works.searchParams.get('author_id'), 'oR9sCGYAAAAJ');
    assert.equal(works.searchParams.get('sort'), 'pubdate');
    assert.equal(works.searchParams.get('start'), '20');
  });

  it('asks the author engine for one entry of a profile, opened', () => {
    const url = new URL(serpUrl('work', { user: 'oR9sCGYAAAAJ', citation: 'oR9sCGYAAAAJ:u5HHmVD_uO8C' }, 'k'));
    assert.equal(url.searchParams.get('engine'), 'google_scholar_author');
    assert.equal(url.searchParams.get('view_op'), 'view_citation');
    assert.equal(url.searchParams.get('citation_id'), 'oR9sCGYAAAAJ:u5HHmVD_uO8C');
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

describe('finding people in the bylines', () => {
  it('knows which byline names could be the person asked for', () => {
    assert.equal(nameCouldBe('S Chennuri', 'Saurav Chennuri'), true);
    assert.equal(nameCouldBe('SVP Chennuri', 'Saurav Chennuri'), true);
    assert.equal(nameCouldBe('Saurav Chennuri', 'saurav chennuri'), true);
    assert.equal(nameCouldBe('R Chennuri', 'Saurav Chennuri'), false);
    assert.equal(nameCouldBe('S Chennai', 'Saurav Chennuri'), false);
    // A surname alone means anyone with it.
    assert.equal(nameCouldBe('S Chennuri', 'Chennuri'), true);
  });

  it('collects each author with a profile once, from the bylines of a search', () => {
    const people = fromSerpAuthorsInResults(SEARCH, 'Ashish Vaswani');
    assert.equal(people.length, 1);
    assert.equal(people[0].userId, 'oR9sCGYAAAAJ');
    assert.equal(people[0].name, 'A Vaswani');
    assert.match(people[0].profileUrl, /^https:\/\/scholar\.google\.com\/citations/);
    // N Shazeer has a profile too, but is not who was asked for.
    assert.equal(fromSerpAuthorsInResults(SEARCH, 'Noam Shazeer')[0].userId, 'wsGvgA8AAAAJ');
    assert.deepEqual(fromSerpAuthorsInResults(SEARCH, 'Nobody Here'), []);
  });

  it('reads the person at the top of their profile: full name, affiliation, verified domain, citations', () => {
    const person = fromSerpAuthorProfile(AUTHOR, 'oR9sCGYAAAAJ');
    assert.equal(person.name, 'Ashish Vaswani');
    assert.equal(person.affiliation, 'Essential AI');
    assert.equal(person.verifiedEmail, 'essential.ai');
    assert.deepEqual(person.interests, ['Machine Learning', 'Deep Learning']);
    assert.equal(person.citedBy, 231507);
    assert.equal(fromSerpAuthorProfile({}, 'x'), null);
  });

  it('fills the people in from their profiles, and does without when a profile fails', async () => {
    const asked = [];
    const fetchJson = async (url) => {
      const engine = new URL(url).searchParams.get('engine');
      asked.push(engine);
      return { status: 200, json: engine === 'google_scholar_author' ? AUTHOR : SEARCH };
    };
    const people = await askSerp('authors', { name: 'Ashish Vaswani' }, 'k', { fetchJson });
    assert.equal(people[0].name, 'Ashish Vaswani');
    assert.equal(people[0].affiliation, 'Essential AI');
    assert.equal(people[0].worksSeen, undefined);
    assert.deepEqual(asked, ['google_scholar', 'google_scholar_author']);

    forgetSerp();
    const failing = async (url) =>
      new URL(url).searchParams.get('engine') === 'google_scholar_author'
        ? { status: 200, json: { error: 'The Google Scholar Author API is discontinued.' } }
        : { status: 200, json: SEARCH };
    const bare = await askSerp('authors', { name: 'Ashish Vaswani' }, 'k', { fetchJson: failing });
    assert.equal(bare[0].userId, 'oR9sCGYAAAAJ');
    assert.equal(bare[0].name, 'A Vaswani');
    assert.equal(bare[0].affiliation, undefined);
  });

  it('opens a person from the cache their profile was read into', async () => {
    let profileAsks = 0;
    const fetchJson = async (url) => {
      const engine = new URL(url).searchParams.get('engine');
      if (engine === 'google_scholar_author') profileAsks += 1;
      return { status: 200, json: engine === 'google_scholar_author' ? AUTHOR : SEARCH };
    };
    await askSerp('authors', { name: 'Ashish Vaswani' }, 'k', { fetchJson });
    const works = await askSerp('profile', { user: 'oR9sCGYAAAAJ', start: 0 }, 'k', { fetchJson });
    assert.equal(works[0].title, 'Attention is all you need');
    assert.equal(profileAsks, 1, 'the profile was asked for once, for the person and their works');
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

  it('keeps each entry’s handle, so its own page can be asked for', () => {
    assert.equal(works[0].citationId, 'oR9sCGYAAAAJ:u5HHmVD_uO8C');
  });
});

describe('reading one entry of a profile, opened', () => {
  const [work] = fromSerpCitation(CITATION);

  it('finds the file beside the title, and where it sits', () => {
    assert.equal(fromSerpCitation(CITATION).length, 1);
    assert.equal(work.pdfUrl, 'https://www.bu.edu/example/papers/Chennuri_Fusion_ICCVW_2023.pdf');
    assert.equal(work.pdfKind, 'PDF');
    assert.equal(work.pdfHost, 'bu.edu');
    assert.match(work.url, /^https:\/\/openaccess\.thecvf\.com\//);
  });

  it('reads the table, in the shape the direct parser gives', () => {
    assert.equal(work.title, 'Fusion approaches to predict post-stroke aphasia severity from multimodal neuroimaging data');
    assert.equal(work.authors.length, 10);
    assert.equal(work.published, '2023-10-02');
    assert.equal(work.year, 2023);
    assert.match(work.venue, /ICCVW/);
    assert.match(work.snippet, /feature selection/);
    assert.equal(work.citedBy, 9);
  });

  it('names the cluster from the "all versions" link', () => {
    assert.equal(work.clusterId, '6188253286931533296');
    assert.equal(work.versionCount, 5);
  });

  it('finds the file link inside the citation too, where SerpApi has also put it', () => {
    const nested = { citation: { ...CITATION.citation, resources: CITATION.resources } };
    assert.equal(fromSerpCitation(nested)[0].pdfUrl, work.pdfUrl);
  });

  it('returns nothing rather than nonsense for an answer with no citation in it', () => {
    assert.deepEqual(fromSerpCitation({ search_metadata: { status: 'Success' } }), []);
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

  it('knows a page SerpApi has stopped offering', () => {
    assert.equal(serpProblem({ error: 'The Google Scholar Profiles API is discontinued.' }, 200).reason, 'discontinued');
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
      const params = new URL(url).searchParams;
      const json =
        params.get('view_op') === 'view_citation' ? CITATION : params.get('engine') === 'google_scholar_author' ? AUTHOR : SEARCH;
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
      assert.equal(payload.results[0].affiliation, 'Essential AI');

      const works = await (await realFetch(`${base}/scholar/profile?user=oR9sCGYAAAAJ`)).json();
      assert.equal(works.results[0].title, 'Attention is all you need');

      // One of those works, opened: the file beside its title comes back too.
      const opened = await (
        await realFetch(`${base}/scholar/work?user=oR9sCGYAAAAJ&citation=${encodeURIComponent(works.results[0].citationId)}`)
      ).json();
      assert.equal(opened.via, 'serpapi');
      assert.equal(opened.results[0].pdfHost, 'bu.edu');
      assert.equal(opened.results[0].clusterId, '6188253286931533296');

      assert.ok(asked.length >= 3);
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
