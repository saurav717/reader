// Reading Google Scholar's pages. Scholar publishes no API, so the proxy
// parses the HTML a person's browser would get, and these assertions pin that
// parsing to saved fixtures in scripts/fixtures/ — the one place a change in
// Scholar's markup will show up as a failure rather than as silently empty
// search results.
//
// Also here: that a captcha is recognised as a refusal rather than read as
// "no results", and that the politeness the proxy owes Scholar — one request
// at a time, spaced out, cached — actually happens.
//
//   node --test scripts/scholar.test.mjs

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  authorSearchUrl,
  blockedMessage,
  blockedReason,
  forgetScholar,
  getScholar,
  isScholarUrl,
  parseAuthors,
  parseByline,
  parseProfileWorks,
  parseResults,
  profileUrl,
  searchUrl,
  versionsUrl,
} from '../server/scholar.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFile(path.join(here, 'fixtures', `${name}.html`), 'utf8');

const SEARCH = await fixture('scholar-search');
const AUTHORS = await fixture('scholar-authors');
const CAPTCHA = await fixture('scholar-captcha');
const PROFILE = await fixture('scholar-profile');

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => forgetScholar());

describe('the pages it asks for', () => {
  it('asks for results in English, the way the search box does', () => {
    const url = new URL(searchUrl('attention is all you need'));
    assert.equal(url.hostname, 'scholar.google.com');
    assert.equal(url.pathname, '/scholar');
    assert.equal(url.searchParams.get('q'), 'attention is all you need');
    assert.equal(url.searchParams.get('hl'), 'en');
  });

  it('pages the way Scholar does, in tens', () => {
    assert.equal(new URL(searchUrl('x', { start: 20 })).searchParams.get('start'), '20');
  });

  it('asks for a person by name on the profile search', () => {
    const url = new URL(authorSearchUrl('Saurav Chennuri'));
    assert.equal(url.pathname, '/citations');
    assert.equal(url.searchParams.get('view_op'), 'search_authors');
    assert.equal(url.searchParams.get('mauthors'), 'Saurav Chennuri');
  });

  it('asks a profile for the works it lists', () => {
    const url = new URL(profileUrl('oR9sCGYAAAAJ'));
    assert.equal(url.searchParams.get('user'), 'oR9sCGYAAAAJ');
    assert.equal(url.searchParams.get('view_op'), 'list_works');
  });

  it('asks a cluster for every version of one paper', () => {
    assert.equal(new URL(versionsUrl('1972994675707178528')).searchParams.get('cluster'), '1972994675707178528');
  });

  it('knows which pages are Scholar’s, which is all the captcha window may open', () => {
    assert.equal(isScholarUrl(searchUrl('x')), true);
    assert.equal(isScholarUrl(profileUrl('oR9sCGYAAAAJ')), true);
    // Not a lookalike, not plain http, not Google’s own captcha host either —
    // the window opens Scholar’s page, and Scholar sends it on from there.
    assert.equal(isScholarUrl('https://scholar.google.com.evil.example/scholar'), false);
    assert.equal(isScholarUrl('http://scholar.google.com/scholar?q=x'), false);
    assert.equal(isScholarUrl('https://www.google.com/sorry/index'), false);
    assert.equal(isScholarUrl('not a url'), false);
  });
});

describe('reading a page of results', () => {
  const results = parseResults(SEARCH);

  it('finds every result on the page', () => {
    assert.equal(results.length, 3);
  });

  it('reads the title without the [PDF] tag Scholar puts in front of it', () => {
    assert.equal(results[0].title, 'Attention is all you need');
    assert.equal(results[1].title, 'Attention is all you need');
  });

  it('takes the direct file link from the right-hand column', () => {
    assert.equal(
      results[0].pdfUrl,
      'https://proceedings.neurips.cc/paper/2017/file/3f5ee243547dee91fbd053c1c4a845aa-Paper.pdf',
    );
    assert.equal(results[0].pdfKind, 'PDF');
    assert.equal(results[0].pdfHost, 'neurips.cc');
  });

  it('keeps the landing page separately from the file', () => {
    assert.match(results[0].url, /^https:\/\/proceedings\.neurips\.cc\/paper\/2017\/hash\//);
  });

  it('reads the cluster id, which is the handle on "all versions"', () => {
    assert.equal(results[0].clusterId, '1972994675707178528');
    assert.equal(results[0].versionCount, 84);
    assert.equal(results[1].versionCount, 12);
  });

  it('reads the citation count past the thousands separator', () => {
    assert.equal(results[0].citedBy, 145231);
  });

  it('pulls the authors, venue and year out of Scholar’s one metadata line', () => {
    assert.deepEqual(results[0].authors, ['A Vaswani', 'N Shazeer', 'N Parmar', 'J Uszkoreit']);
    assert.match(results[0].venue, /Advances in neural/);
    assert.equal(results[0].year, 2017);
  });

  it('decodes the entities in a snippet and drops the markup', () => {
    assert.match(results[0].snippet, /^The dominant sequence transduction models/);
    assert.equal(/<b>|&hellip;|&amp;/.test(results[0].snippet), false);
  });

  it('copes with a result that has no file and no versions link', () => {
    assert.equal(results[2].pdfUrl, undefined);
    assert.equal(results[2].versionCount, undefined);
    assert.equal(results[2].title, 'Attention is not all you need: pure attention loses rank doubly exponentially');
  });
});

describe('reading a byline', () => {
  it('drops the ellipsis Scholar truncates an author list with', () => {
    const parsed = parseByline('A Vaswani, N Shazeer, N Parmar… - arXiv preprint arXiv …, 2017 - arxiv.org');
    assert.deepEqual(parsed.authors, ['A Vaswani', 'N Shazeer', 'N Parmar']);
    assert.equal(parsed.year, 2017);
    assert.equal(parsed.host, 'arxiv.org');
  });

  it('survives a line with no year and no host', () => {
    const parsed = parseByline('J Doe');
    assert.deepEqual(parsed.authors, ['J Doe']);
    assert.equal(parsed.year, undefined);
  });
});

describe('reading the profile search', () => {
  const authors = parseAuthors(AUTHORS);

  it('finds each person', () => {
    assert.equal(authors.length, 2);
    assert.equal(authors[0].name, 'Ashish Vaswani');
  });

  it('keeps the profile id, which is how their papers are asked for', () => {
    assert.equal(authors[0].userId, 'oR9sCGYAAAAJ');
    assert.match(authors[0].profileUrl, /^https:\/\/scholar\.google\.com\/citations/);
  });

  it('reads the affiliation, the interests and the verified domain', () => {
    assert.equal(authors[0].affiliation, 'Essential AI');
    assert.deepEqual(authors[0].interests, ['Machine Learning', 'Deep Learning']);
    // Which is the one thing that tells two people of the same name apart.
    assert.equal(authors[0].verifiedEmail, 'essential.ai');
    assert.equal(authors[0].citedBy, 231507);
  });
});

describe('reading a profile’s own list of works', () => {
  const works = parseProfileWorks(PROFILE);

  it('finds each entry', () => {
    assert.equal(works.length, 2);
    assert.equal(works[0].title, 'Attention is all you need');
  });

  it('separates the authors from the venue, and reads the year and citations', () => {
    assert.match(works[0].authors[0], /A Vaswani/);
    assert.match(works[0].venue, /Advances in neural information processing systems/);
    assert.equal(works[0].year, 2017);
    assert.equal(works[0].citedBy, 145231);
  });
});

describe('being refused', () => {
  it('knows a captcha page when it sees one', () => {
    assert.equal(blockedReason(CAPTCHA, 200), 'captcha');
  });

  it('never reads a captcha as an empty result set', () => {
    // The dangerous failure: parsing succeeds, finds nothing, and the app
    // reports "no results" for a paper Scholar knows perfectly well.
    assert.equal(parseResults(CAPTCHA).length, 0);
    assert.notEqual(blockedReason(CAPTCHA, 200), null);
  });

  it('tells a rate-limit apart from a captcha, because the advice differs', () => {
    assert.equal(blockedReason('<html><body>scholar.google.com</body></html>', 429), 'rate-limited');
    assert.match(blockedMessage('rate-limited'), /rate-limiting/i);
    assert.match(blockedMessage('captcha'), /captcha/i);
  });

  it('does not blame Scholar for a refusal that never reached it', () => {
    // What a container's egress allowlist answers, and what this repository
    // itself gets: a 403 from something in between. Calling it a captcha sends
    // someone off to solve a puzzle nobody showed them.
    const allowlist = 'Host not in allowlist: scholar.google.com. Add this host to your network egress settings.';
    assert.equal(blockedReason(allowlist, 403), 'unreachable');
    assert.match(blockedMessage('unreachable'), /came from something in between/i);
    // A corporate proxy that demands authentication is the same class of thing.
    assert.equal(blockedReason('Proxy Authentication Required', 407), 'unreachable');
  });

  it('still calls Google\u2019s own 403 a captcha', () => {
    assert.equal(blockedReason('<html><body>scholar.google.com says no</body></html>', 403), 'captcha');
  });

  it('calls Google’s bare 401 a refusal, which a browser gets past, and a proxy’s 401 unreachable', () => {
    const google = '<!DOCTYPE html><html lang=en><title>Error 401 (Unauthorized)!!1</title><a href=//www.google.com/>Google</a>';
    assert.equal(blockedReason(google, 401), 'refused');
    assert.match(blockedMessage('refused'), /real browser/i);
    assert.equal(blockedReason('Unauthorized', 401), 'unreachable');
  });

  it('knows the consent interstitial', () => {
    assert.equal(blockedReason('<html><body>Before you continue to Google</body></html>', 200), 'consent');
  });

  it('says a page of results is not a refusal', () => {
    assert.equal(blockedReason(SEARCH, 200), null);
  });
});

describe('the manners it owes Scholar', () => {
  it('raises a blocked page as an error rather than returning it', async () => {
    await assert.rejects(
      getScholar('https://scholar.google.com/scholar?q=x', {
        fetchPage: async () => ({ status: 200, html: CAPTCHA }),
      }),
      (error) => {
        assert.equal(error.blocked, true);
        assert.equal(error.reason, 'captcha');
        // The page that was refused rides along: it is where the captcha is
        // shown, when the proxy can show it.
        assert.equal(error.url, 'https://scholar.google.com/scholar?q=x');
        return true;
      },
    );
  });

  it('asks once for a page it has already been given', async () => {
    let asked = 0;
    const fetchPage = async () => {
      asked += 1;
      return { status: 200, html: SEARCH };
    };
    const url = 'https://scholar.google.com/scholar?q=cached';
    await getScholar(url, { fetchPage });
    await getScholar(url, { fetchPage });
    assert.equal(asked, 1, 'the second ask came out of the cache');
  });

  it('does not cache a refusal, so a retry is a real one', async () => {
    let asked = 0;
    const url = 'https://scholar.google.com/scholar?q=blocked';
    const fetchPage = async () => {
      asked += 1;
      return { status: 200, html: asked === 1 ? CAPTCHA : SEARCH };
    };
    await assert.rejects(getScholar(url, { fetchPage }));
    const html = await getScholar(url, { fetchPage });
    assert.equal(parseResults(html).length, 3);
    assert.equal(asked, 2);
  });

  it('runs one request at a time, so a burst of typing is still a queue', async () => {
    let inFlight = 0;
    let most = 0;
    const fetchPage = async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { status: 200, html: SEARCH };
    };
    await Promise.all(
      ['a', 'b', 'c'].map((q) => getScholar(`https://scholar.google.com/scholar?q=${q}`, { fetchPage })),
    );
    assert.equal(most, 1, `two requests overlapped (${most})`);
  });

  it('keeps serving the queue after one page fails', async () => {
    const fetchPage = async (url) => ({
      status: 200,
      html: url.endsWith('bad') ? CAPTCHA : SEARCH,
    });
    const bad = getScholar('https://scholar.google.com/scholar?q=bad', { fetchPage }).catch(() => 'failed');
    const good = getScholar('https://scholar.google.com/scholar?q=good', { fetchPage });
    assert.equal(await bad, 'failed');
    assert.equal(parseResults(await good).length, 3);
  });
});
