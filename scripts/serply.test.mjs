// Google Scholar through Serply: that each Scholar ask is answered from
// Serply's two endpoints — its Scholar results and its Google search for
// Scholar's profile pages — in the same shapes the direct parsers produce;
// that a profile, a person and people are rebuilt from those; that Serply's
// refusals are told apart from a captcha a person here could solve; and that
// a proxy with a key asks Serply, hands the profile pages to SerpApi when it
// has that key too, and never lets either key out.
//
// Serply itself is not asked. scripts/fixtures/serply-scholar.json is a real
// answer of its Scholar endpoint, cut to two results; serply-profiles.json is
// Google's results for Scholar's profile pages, in the shape Serply's search
// endpoint documents (`results[]` of title, link, description).
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
const {
  askSerplyScholar,
  forgetSerply,
  fromSerplyAuthors,
  fromSerplyProfiles,
  fromSerplyResults,
  serplyProblem,
  serplyScholarUrl,
  serplySearchUrl,
  SERPLY_HOST,
} = await import('../server/serply.js');
const { forgetScholar } = await import('../server/scholar.js');
const { forgetSerp } = await import('../server/serpapi.js');
const { forgetResting } = await import('../server/scholarServices.js');

const here = dirname(fileURLToPath(import.meta.url));
const fixture = async (name) => JSON.parse(await readFile(join(here, 'fixtures', `${name}.json`), 'utf8'));
const SCHOLAR = await fixture('serply-scholar');
const PROFILES = await fixture('serply-profiles');
const SERP_SEARCH = await fixture('serpapi-search');
const SERP_AUTHOR = await fixture('serpapi-author');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** Serply, answering from the fixtures: Scholar results, or Google's profile pages. */
const serply = (url) => {
  const path = new URL(url).pathname;
  if (path === '/v1/scholar') return json(SCHOLAR);
  if (path === '/v1/search') return json(PROFILES);
  return json({ detail: 'Not Found' }, 404);
};

/** A fetch that answers as Serply and remembers what it was asked. */
const recording = (answer = serply) => {
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push({ url: String(url), key: init?.headers?.['X-Api-Key'] });
    return answer(String(url));
  };
  return { asked, fetchImpl };
};

beforeEach(() => {
  forgetScholar();
  forgetSerp();
  forgetSerply();
  forgetResting();
});

describe('the asks', () => {
  it('asks the Scholar endpoint for a search, a cluster, or a person’s papers — in English, with no key in the address', () => {
    const search = new URL(serplyScholarUrl({ q: 'attention', start: 10 }));
    assert.equal(search.origin + search.pathname, `${SERPLY_HOST}/v1/scholar`);
    assert.equal(search.searchParams.get('q'), 'attention');
    assert.equal(search.searchParams.get('start'), '10');
    assert.equal(search.searchParams.get('hl'), 'en');
    assert.equal(new URL(serplyScholarUrl({ cluster: '42' })).searchParams.get('cluster'), '42');
    assert.doesNotMatch(serplyScholarUrl({ q: 'x' }), /key/i);
  });

  it('asks Google for Scholar’s profile pages of a name', () => {
    const url = new URL(serplySearchUrl('site:scholar.google.com/citations "Ashish Vaswani"'));
    assert.equal(url.pathname, '/v1/search');
    assert.equal(url.searchParams.get('q'), 'site:scholar.google.com/citations "Ashish Vaswani"');
  });
});

describe('reading Scholar’s results', () => {
  it('reads each result as the direct parser would: file, byline, profiles, citations, cluster', () => {
    const [first, second] = fromSerplyResults(SCHOLAR);
    assert.equal(first.title, 'Attention is all you need');
    assert.equal(first.id, '5Gohgn6QFikJ');
    assert.match(first.pdfUrl, /^https:\/\/proceedings\.neurips\.cc\/.*Paper\.pdf/);
    assert.equal(first.pdfKind, 'PDF');
    assert.equal(first.pdfHost, 'proceedings.neurips.cc');
    assert.deepEqual(first.authors, ['A Vaswani', 'N Shazeer', 'N Parmar']);
    assert.deepEqual(first.authorIds[0], { name: 'A Vaswani', userId: 'oR9sCGYAAAAJ' });
    assert.equal(first.year, 2017);
    assert.equal(first.citedBy, 271700);
    assert.equal(first.clusterId, '2960712678066186980');
    assert.equal(first.versionCount, 26);
    assert.equal(second.title, 'Tensor2tensor for neural machine translation', 'the [HTML] tag is not part of the title');
    assert.equal(second.pdfUrl, undefined);
  });

  it('finds the people of a name in the bylines, once each', () => {
    const people = fromSerplyAuthors(SCHOLAR, 'Ashish Vaswani');
    assert.deepEqual(
      people.map((person) => person.userId),
      ['oR9sCGYAAAAJ'],
    );
    assert.deepEqual(fromSerplyAuthors(SCHOLAR, 'Nobody Here'), []);
  });
});

describe('reading Google’s profile pages', () => {
  const people = fromSerplyProfiles(PROFILES);

  it('keeps Scholar’s profiles only, once each', () => {
    assert.deepEqual(
      people.map((person) => person.userId),
      ['oR9sCGYAAAAJ', 'REALxxxxAAAJ', 'ZZZZZZZZAAAJ'],
    );
  });

  it('stops at the profile page’s own chrome, as Google really ran it together', () => {
    // Serply's answer for `site:scholar.google.com/citations "Ashish Vaswani"`, 2026-09-26.
    const real = people.find((person) => person.userId === 'REALxxxxAAAJ');
    assert.equal(real.name, 'Ashish Vaswani');
    assert.equal(real.affiliation, 'Startup');
    assert.equal(real.verifiedEmail, 'fastmail.com');
    assert.deepEqual(real.interests, ['Deep Learning']);
    assert.equal(real.citedBy, undefined);
  });

  it('reads the full name, the affiliation, the citations and the interests, past Scholar’s direction marks', () => {
    const [ashish] = people;
    assert.equal(ashish.name, 'Ashish Vaswani');
    assert.equal(ashish.affiliation, 'Essential AI');
    assert.equal(ashish.citedBy, 231507);
    assert.deepEqual(ashish.interests, ['Machine Learning', 'Deep Learning']);
    assert.match(ashish.profileUrl, /user=oR9sCGYAAAAJ/);
  });

  it('reads the other way Google shows a profile: the top of the page run together', () => {
    const other = people.find((person) => person.userId === 'ZZZZZZZZAAAJ');
    assert.equal(other.name, 'Ashish Kumar');
    assert.equal(other.affiliation, 'IIT Delhi');
    assert.equal(other.verifiedEmail, 'iitd.ac.in');
    assert.deepEqual(other.interests, ['Robotics']);
  });
});

describe('the asks that are rebuilt', () => {
  it('people: Google’s profiles of the name first, with who they are, then anyone else in the bylines', async () => {
    const { asked, fetchImpl } = recording();
    const people = await askSerplyScholar('authors', { name: 'Ashish Vaswani' }, 'k', { fetchImpl });
    assert.deepEqual(
      people.map((person) => person.userId),
      ['oR9sCGYAAAAJ', 'REALxxxxAAAJ'],
      'both people of the name, each once — not also their byline self, and not the other Ashish',
    );
    assert.equal(people[0].name, 'Ashish Vaswani');
    assert.equal(people[0].affiliation, 'Essential AI');
    assert.deepEqual(asked.map((ask) => new URL(ask.url).pathname).sort(), ['/v1/scholar', '/v1/search']);
  });

  it('a profile’s works: their papers only, newest first or most cited, with the file and the cluster', async () => {
    const { asked, fetchImpl } = recording();
    const newest = await askSerplyScholar('profile', { user: 'oR9sCGYAAAAJ', start: 0, sort: 'pubdate', name: 'Ashish Vaswani' }, 'k', { fetchImpl });
    assert.deepEqual(
      newest.map((work) => work.title),
      ['Tensor2tensor for neural machine translation', 'Attention is all you need'],
    );
    assert.equal(newest[1].clusterId, '2960712678066186980');
    assert.equal(newest[1].pdfHost, 'proceedings.neurips.cc');
    assert.equal(new URL(asked[0].url).searchParams.get('q'), 'author:"Ashish Vaswani"');
    assert.equal(asked.length, 1, 'a short results page is the end: nothing after it is asked for');

    const cited = await askSerplyScholar('profile', { user: 'oR9sCGYAAAAJ', start: 0, sort: 'citations', name: 'Ashish Vaswani' }, 'k', { fetchImpl });
    assert.equal(cited[0].title, 'Attention is all you need');

    const theirs = await askSerplyScholar('profile', { user: 'wsGvgA8AAAAJ', start: 0, name: 'Noam Shazeer' }, 'k', { fetchImpl });
    assert.deepEqual(
      theirs.map((work) => work.title),
      ['Attention is all you need'],
      'only the papers whose byline links that profile',
    );
  });

  it('a profile’s later pages ask Scholar’s later results, none twice', async () => {
    const full = { articles: Array.from({ length: 20 }, () => SCHOLAR.articles[0]) };
    const { asked, fetchImpl } = recording((url) => json(new URL(url).pathname === '/v1/scholar' ? full : PROFILES));
    await askSerplyScholar('profile', { user: 'oR9sCGYAAAAJ', start: 0, name: 'A' }, 'k', { fetchImpl });
    await askSerplyScholar('profile', { user: 'oR9sCGYAAAAJ', start: 20, name: 'A' }, 'k', { fetchImpl });
    assert.deepEqual(
      asked.map((ask) => new URL(ask.url).searchParams.get('start')),
      [null, '20', '40', '60'],
    );
  });

  it('a profile asked for by id alone finds whose it is first', async () => {
    const { asked, fetchImpl } = recording();
    const works = await askSerplyScholar('profile', { user: 'oR9sCGYAAAAJ', start: 0 }, 'k', { fetchImpl });
    assert.equal(works.length, 2);
    assert.equal(new URL(asked[0].url).pathname, '/v1/search');
    assert.match(new URL(asked[0].url).searchParams.get('q'), /"oR9sCGYAAAAJ"/);
    assert.equal(new URL(asked[1].url).searchParams.get('q'), 'author:"Ashish Vaswani"');
  });

  it('a person: who they are, and their most cited works — with no h-index rather than a guessed one', async () => {
    const { fetchImpl } = recording();
    const [person] = await askSerplyScholar('person', { user: 'oR9sCGYAAAAJ', name: 'A Vaswani' }, 'k', { fetchImpl });
    assert.equal(person.name, 'Ashish Vaswani');
    assert.equal(person.affiliation, 'Essential AI');
    assert.equal(person.citedBy, 231507);
    assert.equal(person.hIndex, undefined);
    assert.equal(person.works[0].title, 'Attention is all you need');
  });

  it('versions: the cluster asked with the paper’s title beside it, the one way Serply opens one', async () => {
    const { asked, fetchImpl } = recording();
    const versions = await askSerplyScholar('versions', { cluster: '2960712678066186980', title: 'Attention is all you need' }, 'k', { fetchImpl });
    assert.equal(versions.length, 2);
    const url = new URL(asked[0].url);
    assert.equal(url.searchParams.get('q'), 'Attention is all you need');
    assert.equal(url.searchParams.get('cluster'), '2960712678066186980');
  });

  it('versions without a title are refused as Serply’s, with no credit spent', async () => {
    const { asked, fetchImpl } = recording();
    await assert.rejects(
      askSerplyScholar('versions', { cluster: '2960712678066186980' }, 'k', { fetchImpl }),
      (error) => error.serply === true && error.reason === 'unsupported',
    );
    assert.equal(asked.length, 0);
  });

  it('an entry opened is refused as Serply’s, so the app looks the paper up by its title', async () => {
    const { asked, fetchImpl } = recording();
    await assert.rejects(
      askSerplyScholar('work', { user: 'oR9sCGYAAAAJ', citation: 'oR9sCGYAAAAJ:u5HHmVD_uO8C' }, 'k', { fetchImpl }),
      (error) => error.serply === true && error.blocked === false && error.reason === 'unsupported',
    );
    assert.equal(asked.length, 0, 'no credit spent on it');
  });
});

describe('asking Serply', () => {
  it('sends the key in the header only, and asks once for what it has been given', async () => {
    const { asked, fetchImpl } = recording();
    await askSerplyScholar('search', { query: 'once' }, 'SECRET', { fetchImpl });
    const results = await askSerplyScholar('search', { query: 'once' }, 'SECRET', { fetchImpl });
    assert.equal(results[0].title, 'Attention is all you need');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].key, 'SECRET');
    assert.doesNotMatch(asked[0].url, /SECRET/);
  });

  it('tries a failed answer of Serply’s once more before saying so', async () => {
    let tries = 0;
    const fetchImpl = async () => (++tries === 1 ? new Response('', { status: 502 }) : json(SCHOLAR));
    const results = await askSerplyScholar('search', { query: 'retried' }, 'k', { fetchImpl });
    assert.equal(tries, 2);
    assert.equal(results.length, 2);
  });

  it('knows a bad key, a spent allowance, going too fast, and its own fetch failing', () => {
    assert.equal(serplyProblem(401, '{"detail":"Invalid API key"}').reason, 'key');
    assert.equal(serplyProblem(402, '{"detail":"Out of credits"}').reason, 'rate-limited');
    assert.match(serplyProblem(402, '{"detail":"Out of credits"}').message, /allowance/);
    assert.equal(serplyProblem(429, '').reason, 'rate-limited');
    assert.equal(serplyProblem(502, '').reason, 'upstream');
    assert.equal(serplyProblem(200, '{}'), null);
  });

  it('raises a refusal as Serply’s, not as a captcha', async () => {
    await assert.rejects(
      askSerplyScholar('search', { query: 'x' }, 'k', { fetchImpl: async () => json({ detail: 'Invalid API key' }, 401) }),
      (error) => error.serply === true && error.blocked === false && error.reason === 'key',
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
    delete process.env.SCHOLAR_FIRST;
    globalThis.fetch = realFetch;
    server.close();
  };
  /** The proxy's own fetch, answered as `answer` does for anything but the proxy. */
  const intercept = (answer) => {
    globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(base)) return realFetch(input, init);
      return answer(url, init);
    };
  };

  it('answers every Scholar route from Serply, never Scholar, and never lets the key out', async () => {
    await listen();
    process.env.SERPLY_KEY = 'SERPLY-SECRET';
    const asked = [];
    intercept((url, init) => {
      asked.push({ url, key: init?.headers?.['X-Api-Key'] });
      return serply(url);
    });
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

      const search = await (await realFetch(`${base}/scholar/search?q=attention`)).json();
      assert.equal(search.results[0].clusterId, '2960712678066186980');
      const versions = await (await realFetch(`${base}/scholar/versions?cluster=2960712678066186980&title=Attention%20is%20all%20you%20need`)).json();
      assert.equal(versions.via, 'serply');
      assert.equal(versions.results[0].title, 'Attention is all you need');

      const works = await (await realFetch(`${base}/scholar/profile?user=oR9sCGYAAAAJ&name=Ashish%20Vaswani`)).json();
      assert.equal(works.via, 'serply');
      assert.equal(works.results.length, 2);

      const person = await (await realFetch(`${base}/scholar/person?user=oR9sCGYAAAAJ&name=Ashish%20Vaswani`)).json();
      assert.equal(person.results[0].name, 'Ashish Vaswani');
      assert.equal(person.results[0].works[0].title, 'Attention is all you need');

      const opened = await realFetch(`${base}/scholar/work?user=oR9sCGYAAAAJ&citation=oR9sCGYAAAAJ:u5HHmVD_uO8C`);
      assert.equal(opened.status, 503);
      assert.equal((await opened.json()).serply, true);

      assert.ok(asked.length > 0);
      assert.ok(asked.every((ask) => ask.url.startsWith(`${SERPLY_HOST}/v1/`)), asked.map((ask) => ask.url).join('\n'));
      assert.ok(asked.every((ask) => ask.key === 'SERPLY-SECRET'));
      assert.ok(asked.every((ask) => !ask.url.includes('SERPLY-SECRET')));
    } finally {
      stop();
    }
  });

  it('says its refusal is Serply’s, so the app does not offer a captcha window for it', async () => {
    await listen();
    process.env.SERPLY_KEY = 'SERPLY-SECRET';
    intercept(() => json({ detail: 'Invalid API key' }, 401));
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

  describe('with a SerpApi key too', () => {
    /** Both services, each answering or refusing as the test says. */
    const both = ({ serplyRefuses = false, serpapiRefuses = false } = {}) => {
      const hosts = [];
      const state = { serplyRefuses, serpapiRefuses };
      intercept((url) => {
        hosts.push(new URL(url).hostname);
        if (url.startsWith(SERPLY_HOST)) return state.serplyRefuses ? json({ detail: 'Out of credits' }, 402) : serply(url);
        if (state.serpapiRefuses) return json({ error: 'Your account has run out of searches.' }, 429);
        const engine = new URL(url).searchParams.get('engine');
        return json(engine === 'google_scholar_author' ? SERP_AUTHOR : SERP_SEARCH);
      });
      return { hosts, state };
    };
    // start() sets up SCHOLAR_FIRST=serply, as the tests after the first one
    // want; the first is the default arrangement, SerpApi first.
    const start = async (first = 'serply') => {
      await listen();
      process.env.SERPLY_KEY = 'SERPLY-SECRET';
      process.env.SERPAPI_KEY = 'SERPAPI-SECRET';
      process.env.SCHOLAR_FIRST = first;
    };

    it('by default asks SerpApi first for everything, and Serply when SerpApi refuses', async () => {
      await start('');
      const { hosts, state } = both();
      try {
        assert.equal((await (await realFetch(`${base}/health`)).json()).scholar, 'serpapi+serply');
        const search = await (await realFetch(`${base}/scholar/search?q=serpapi-first`)).json();
        assert.equal(search.via, 'serpapi');
        const works = await (await realFetch(`${base}/scholar/profile?user=oR9sCGYAAAAJ`)).json();
        assert.equal(works.via, 'serpapi');
        assert.deepEqual(hosts, ['serpapi.com', 'serpapi.com']);

        hosts.length = 0;
        state.serpapiRefuses = true;
        const fallback = await (await realFetch(`${base}/scholar/search?q=serpapi-out`)).json();
        assert.equal(fallback.via, 'serply');
        assert.deepEqual(hosts, ['serpapi.com', 'api.serply.io']);
      } finally {
        stop();
      }
    });

    it('asks Serply first for a search, and SerpApi first for a profile, which it reads exactly', async () => {
      await start();
      const { hosts } = both();
      try {
        assert.equal((await (await realFetch(`${base}/health`)).json()).scholar, 'serply+serpapi');
        const search = await (await realFetch(`${base}/scholar/search?q=serply`)).json();
        assert.equal(search.via, 'serply');
        const works = await (await realFetch(`${base}/scholar/profile?user=oR9sCGYAAAAJ`)).json();
        assert.equal(works.via, 'serpapi');
        assert.deepEqual(hosts, ['api.serply.io', 'serpapi.com']);
      } finally {
        stop();
      }
    });

    it('asks SerpApi when Serply refuses', async () => {
      await start();
      const { hosts } = both({ serplyRefuses: true });
      try {
        const payload = await (await realFetch(`${base}/scholar/search?q=fallback`)).json();
        assert.equal(payload.via, 'serpapi');
        assert.equal(payload.results[0].title, 'Attention is all you need');
        assert.deepEqual(hosts, ['api.serply.io', 'serpapi.com']);
      } finally {
        stop();
      }
    });

    it('asks Serply when SerpApi is out of searches — and then stops asking SerpApi first', async () => {
      await start();
      const { hosts } = both({ serpapiRefuses: true });
      try {
        const first = await (await realFetch(`${base}/scholar/profile?user=oR9sCGYAAAAJ&name=Ashish%20Vaswani`)).json();
        assert.equal(first.via, 'serply');
        assert.equal(first.results.length, 2);
        assert.deepEqual(hosts, ['serpapi.com', 'api.serply.io']);

        hosts.length = 0;
        const person = await (await realFetch(`${base}/scholar/person?user=oR9sCGYAAAAJ&name=Ashish%20Vaswani`)).json();
        assert.equal(person.via, 'serply');
        assert.ok(!hosts.includes('serpapi.com'), 'a service out of searches is rested, not asked first again');
      } finally {
        stop();
      }
    });

    it('still asks a rested service when the other refuses too, and says what the last one said', async () => {
      await start();
      const { hosts, state } = both({ serpapiRefuses: true });
      try {
        await realFetch(`${base}/scholar/profile?user=oR9sCGYAAAAJ&name=A`);
        state.serplyRefuses = true;
        hosts.length = 0;
        const response = await realFetch(`${base}/scholar/search?q=nobody`);
        assert.equal(response.status, 503);
        const payload = await response.json();
        assert.equal(payload.serpapi, true);
        assert.equal(payload.reason, 'rate-limited');
        assert.deepEqual(hosts, ['api.serply.io', 'serpapi.com']);
      } finally {
        stop();
      }
    });

    it('opens a profile entry through SerpApi, and says Serply’s refusal when SerpApi is out, so the app finds it by title', async () => {
      await start();
      both({ serpapiRefuses: true });
      try {
        const response = await realFetch(`${base}/scholar/work?user=oR9sCGYAAAAJ&citation=oR9sCGYAAAAJ:u5HHmVD_uO8C`);
        assert.equal(response.status, 503);
        const payload = await response.json();
        assert.equal(payload.serply, true);
        assert.equal(payload.reason, 'unsupported');
      } finally {
        stop();
      }
    });
  });

  after(() => {
    globalThis.fetch = realFetch;
  });
});
