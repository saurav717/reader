// The PDF proxy is the one route that fetches a URL chosen by whatever
// OpenAlex or Semantic Scholar returned, so what it refuses matters as much as
// what it serves. Upstream is stubbed: these assertions are about our rules,
// not about any publisher being up.
//
//   node --test scripts/pdf-proxy.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// No signed-in profile on this machine, whatever the machine: a login wall
// below is a login wall, not something to retry through a browser.
process.env.READER_PROFILE_DIR = join(tmpdir(), `reader-no-profile-${process.pid}`);
const { default: apiRouter } = await import('../server/api.js');
const { resetRateLimits, setLookup, setRateLimits } = await import('../server/guard.js');

// No DNS here: every name resolves to a public address, except the one name
// below that stands for a host pointing its name at this machine.
setLookup(async (host) => [{ address: host === 'rebind.example' ? '127.0.0.1' : '203.0.113.10', family: 4 }]);

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 0x20), Buffer.from('\n%%EOF')]);

/** Answers the next fetch, whatever URL it is for. */
let upstream = () => new Response('nothing stubbed', { status: 500 });
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => upstream(String(input instanceof Request ? input.url : input), init);

const server = createServer((req, res) => apiRouter(req, res));
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://localhost:${server.address().port}`;

after(() => {
  globalThis.fetch = realFetch;
  server.close();
});

const get = (target, extra = '') =>
  realFetch(`${base}/pdf?url=${encodeURIComponent(target)}${extra}`);

const pdfResponse = (headers = {}) =>
  new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf', ...headers } });

describe('what the PDF proxy serves', () => {
  it('serves a PDF from a publisher, as a PDF', async () => {
    upstream = () => pdfResponse();
    const response = await get('https://repository.example.org/paper.pdf');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await response.arrayBuffer()).byteLength, PDF.length);
  });

  it('names the file after the paper, inline by default', async () => {
    upstream = () => pdfResponse();
    const response = await get('https://repository.example.org/paper.pdf', '&name=Attention%20is%20all%20you%20need');
    assert.match(response.headers.get('content-disposition'), /^inline; filename="Attention is all you need\.pdf"/);
  });

  it('offers it as a download when asked', async () => {
    upstream = () => pdfResponse();
    const response = await get('https://repository.example.org/paper.pdf', '&download=1&name=Paper');
    assert.match(response.headers.get('content-disposition'), /^attachment; filename="Paper\.pdf"/);
  });

  it('trusts the magic bytes over a wrong content-type', async () => {
    upstream = () => pdfResponse({ 'content-type': 'application/octet-stream' });
    const response = await get('https://repository.example.org/paper');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
  });

  it('follows a redirect to the real file', async () => {
    upstream = (url) =>
      url.includes('/redirect')
        ? new Response(null, { status: 302, headers: { location: 'https://cdn.example.org/paper.pdf' } })
        : pdfResponse();
    const response = await get('https://repository.example.org/redirect');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
  });
});

describe('what the PDF proxy refuses', () => {
  const refusals = [
    ['a URL that is not one', 'not a url', /not a URL/],
    ['plain http', 'http://repository.example.org/paper.pdf', /only https/],
    ['loopback', 'https://127.0.0.1/paper.pdf', /not reachable/],
    ['localhost by name', 'https://localhost/paper.pdf', /not reachable/],
    ['a private network', 'https://10.1.2.3/paper.pdf', /not reachable/],
    ['another private range', 'https://192.168.0.5/paper.pdf', /not reachable/],
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data/', /not reachable/],
    ['an internal name', 'https://build.internal/paper.pdf', /not reachable/],
    ['IPv6 loopback', 'https://[::1]/paper.pdf', /not reachable/],
  ];

  for (const [label, target, expected] of refusals) {
    it(`refuses ${label}`, async () => {
      upstream = () => pdfResponse();
      const response = await get(target);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, expected);
    });
  }

  it('refuses a redirect that bounces onto a private address', async () => {
    upstream = (url) =>
      url.includes('/bounce')
        ? new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } })
        : pdfResponse();
    const response = await get('https://repository.example.org/bounce');
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /not reachable/);
  });

  it('refuses a redirect loop', async () => {
    upstream = () => new Response(null, { status: 302, headers: { location: 'https://repository.example.org/again' } });
    const response = await get('https://repository.example.org/again');
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /redirects too many times/);
  });

  it('refuses a login page dressed up as a PDF, and says whose login it was', async () => {
    upstream = () =>
      new Response('<html><body>Sign in to read this article</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    const response = await get('https://publisher.example.com/article');
    assert.equal(response.status, 415);
    const body = await response.json();
    assert.match(body.error, /web page rather than a PDF/);
    // The app offers a sign-in on this, so the answer has to name the host.
    assert.equal(body.loginWall, true);
    assert.equal(body.host, 'publisher.example.com');
  });

  it('treats a 403 as a login wall too', async () => {
    upstream = () => new Response('forbidden', { status: 403 });
    const response = await get('https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=1');
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.loginWall, true);
    assert.equal(body.host, 'ieeexplore.ieee.org');
  });

  it('refuses a file larger than the cap', async () => {
    upstream = () =>
      new Response(PDF, {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-length': String(1024 ** 4) },
      });
    const response = await get('https://repository.example.org/huge.pdf');
    assert.equal(response.status, 415);
    assert.match((await response.json()).error, /too large/);
  });

  it('passes on the publisher saying no', async () => {
    upstream = () => new Response('gone', { status: 404 });
    const response = await get('https://repository.example.org/missing.pdf');
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /404/);
  });
});

describe('signing in with an institution', () => {
  it('says whether it can open a window, without opening one', async () => {
    const response = await realFetch(`${base}/access/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.available, 'boolean');
    assert.equal(body.window, 'closed');
    assert.equal(body.everSignedIn, false);
  });

  it('will not open a window for a GET, which any page could trigger', async () => {
    const response = await realFetch(`${base}/access/signin?url=https://ieeexplore.ieee.org/document/1`);
    assert.equal(response.status, 405);
  });

  it('will not open a window for another site', async () => {
    const response = await realFetch(`${base}/access/signin?url=https://ieeexplore.ieee.org/document/1`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /not from this app/);
  });

  it('refuses a sign-in page that is not https, before anything is launched', async () => {
    const response = await realFetch(`${base}/access/signin?url=http://ieeexplore.ieee.org/document/1`, {
      method: 'POST',
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /only https/);
  });

  it('mentions the sign-in on /health, so a proxy check can say so', async () => {
    const body = await (await realFetch(`${base}/health`)).json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.access, 'boolean');
  });
});

describe('a proxy on this machine, called from the site', () => {
  it('answers the site on GitHub Pages with CORS headers', async () => {
    const response = await realFetch(`${base}/health`, { headers: { Origin: 'https://saurav717.github.io' } });
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://saurav717.github.io');
    assert.equal(response.headers.get('vary'), 'Origin');
  });

  it('answers a preflight for the same', async () => {
    const response = await realFetch(`${base}/access/close`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://saurav717.github.io', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(response.status, 204);
    assert.match(response.headers.get('access-control-allow-methods'), /POST/);
  });

  it('gives no CORS headers to anyone else', async () => {
    const response = await realFetch(`${base}/health`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });
});

// ------------------------------------- a site that checks for a person ----

const CHALLENGE = () =>
  new Response('<html><title>Just a moment...</title><body>Performing security verification</body></html>', {
    status: 403,
    headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' },
  });

describe("a site's check for a person, met by the PDF proxy", () => {
  it('is told apart from a login wall by the header Cloudflare puts on it, and named as this proxy\'s own browser\'s to pass', async () => {
    upstream = CHALLENGE;
    const response = await get('https://europepmc.org/article/MED/1?pdf=1');
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.error, /^europepmc\.org checks for a person before it hands out the file/);
    assert.equal(body.botCheck, true);
    assert.equal(body.where, 'proxy');
    // A window on this machine, or the browser in the pane, may still pass it: the sign-in offer stands.
    assert.equal(body.loginWall, true);
    assert.equal(body.host, 'europepmc.org');
  });

  it("is said plainly by the Worker, whose requests never pass it, and not offered as a sign-in", async () => {
    const { default: worker } = await import('../worker/index.js');
    upstream = CHALLENGE;
    const response = await worker.fetch(
      new Request('https://proxy.example/pdf?url=' + encodeURIComponent('https://www.academia.edu/download/1/10.pdf'), {
        headers: { Origin: 'https://saurav717.github.io' },
      }),
      {},
    );
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.error, /^www\.academia\.edu checks for a person before it hands out the file, and Cloudflare refuses the Worker's requests/);
    assert.equal(body.botCheck, true);
    assert.equal(body.where, 'cloudflare');
    assert.equal(body.loginWall, undefined);
    assert.equal(body.host, 'www.academia.edu');
  });

  it('is asked from a browser at Browserless by the Worker that has one, and said to be met there when that browser gives no file either', async () => {
    const { default: worker } = await import('../worker/index.js');
    const asked = [];
    upstream = (url) => {
      asked.push(url);
      // The file: the check. Browserless: no browser this time — which is the answer when the check needs a person too.
      if (url.startsWith('https://production-sfo.browserless.io/')) return new Response('Too many concurrent sessions', { status: 429 });
      return CHALLENGE();
    };
    const noted = [];
    const env = {
      BROWSERLESS_TOKEN: 'secret',
      READER_TOKEN: 'the-token',
      BROWSER_SESSION: { idFromName: (name) => name, get: () => ({ fetch: async (url) => (noted.push(String(url)), new Response('{"ok":true}')) }) },
    };
    // Browserless is metered on the account whose token the Worker holds:
    // without the reader's token it is never asked, and the check is said
    // to be Cloudflare's, refusing the Worker.
    const anonymous = await worker.fetch(
      new Request('https://proxy.example/pdf?url=' + encodeURIComponent('https://www.academia.edu/download/1/10.pdf'), {
        headers: { Origin: 'https://saurav717.github.io' },
      }),
      env,
    );
    assert.equal(anonymous.status, 502);
    assert.equal((await anonymous.json()).where, 'cloudflare');
    assert.equal(asked.filter((url) => url.startsWith('https://production-sfo.browserless.io/')).length, 0);
    const response = await worker.fetch(
      new Request('https://proxy.example/pdf?url=' + encodeURIComponent('https://www.academia.edu/download/1/10.pdf'), {
        headers: { Origin: 'https://saurav717.github.io', Authorization: 'Bearer the-token', 'X-Reader-Client': 'client-aaaaaaaaaaaaaaaa' },
      }),
      env,
    );
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.error, /^www\.academia\.edu checks for a person before it hands out the file, and the browser at Browserless met a box to tick/);
    assert.equal(body.botCheck, true);
    assert.equal(body.where, 'browserless');
    // The pane offer stands, as from the Node proxy: the browser at Browserless may pass it with a person.
    assert.equal(body.loginWall, true);
    assert.equal(body.host, 'www.academia.edu');
    // Browserless was asked, at its stealth Chromium, with the token — and the host noted for the pane.
    const browserless = asked.find((url) => url.startsWith('https://production-sfo.browserless.io/'));
    assert.match(browserless, /^https:\/\/production-sfo\.browserless\.io\/chromium\/stealth\?token=secret&timeout=90000$/);
    assert.deepEqual(noted, ['https://browser-session/note-check?host=www.academia.edu&client=client-aaaaaaaaaaaaaaaa']);
  });
});

// ------------------------------------------- PubMed Central, for programs ----

const { oaFilesIn, pmcFiles, pmcIdIn } = await import('../server/pmc.js');

const OA_XML = `<?xml version="1.0"?><OA><records retmax="1"><record id="PMC8266834" citation="Sensors 2021" license="CC BY">
<link format="tgz" updated="2021-07-10" href="ftp://ftp.ncbi.nlm.nih.gov/pub/pmc/oa_package/ab/cd/PMC8266834.tar.gz" />
<link format="pdf" updated="2021-07-10" href="ftp://ftp.ncbi.nlm.nih.gov/pub/pmc/oa_pdf/ab/cd/sensors-21-04240.PMC8266834.pdf" />
</record></records></OA>`;
const EBI = JSON.stringify({ resultList: { result: [{ id: '34241106', source: 'MED', pmcid: 'PMC8266834', isOpenAccess: 'Y' }] } });

describe('a paper in PubMed Central, fetched the way PubMed Central means programs to', () => {
  it("reads a PMC id, or a PubMed id to look one up, from the sites' URLs and no others", () => {
    assert.deepEqual(pmcIdIn('https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8266834/pdf/'), { pmcid: 'PMC8266834' });
    assert.deepEqual(pmcIdIn('https://pmc.ncbi.nlm.nih.gov/articles/PMC8266834/'), { pmcid: 'PMC8266834' });
    assert.deepEqual(pmcIdIn('https://europepmc.org/articles/PMC8266834?pdf=render'), { pmcid: 'PMC8266834' });
    assert.deepEqual(pmcIdIn('https://europepmc.org/article/PMC/pmc8266834'), { pmcid: 'PMC8266834' });
    assert.deepEqual(pmcIdIn('https://europepmc.org/article/MED/34241106'), { pmid: '34241106' });
    assert.deepEqual(pmcIdIn('https://europepmc.org/abstract/MED/34241106'), { pmid: '34241106' });
    assert.equal(pmcIdIn('https://www.ncbi.nlm.nih.gov/pubmed/34241106'), null);
    assert.equal(pmcIdIn('https://www.mdpi.com/1424-8220/21/12/4240/pdf'), null);
    assert.equal(pmcIdIn('not a url'), null);
  });

  it("takes the PDF the OA Web Service names, on NCBI's FTP host over https, and nothing else", () => {
    assert.deepEqual(oaFilesIn(OA_XML), ['https://ftp.ncbi.nlm.nih.gov/pub/pmc/oa_pdf/ab/cd/sensors-21-04240.PMC8266834.pdf']);
    assert.deepEqual(oaFilesIn('<OA><error code="idIsNotOpenAccess">not open access</error></OA>'), []);
    assert.deepEqual(oaFilesIn('<OA><records><record><link format="pdf" href="ftp://evil.example/x.pdf"/></record></records></OA>'), []);
    assert.deepEqual(oaFilesIn(''), []);
  });

  it('asks Europe PMC for the PMC id of a PubMed id, then NCBI for the file, and gives up quietly when either has nothing', async () => {
    const asked = [];
    const fetchFake = async (url) => {
      asked.push(String(url));
      if (String(url).startsWith('https://www.ebi.ac.uk/europepmc/webservices/rest/search?')) return new Response(EBI, { status: 200 });
      if (String(url).startsWith('https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC8266834')) return new Response(OA_XML, { status: 200 });
      return new Response('no', { status: 404 });
    };
    assert.deepEqual(await pmcFiles('https://europepmc.org/article/MED/34241106', { fetch: fetchFake, userAgent: 'test' }), [
      'https://ftp.ncbi.nlm.nih.gov/pub/pmc/oa_pdf/ab/cd/sensors-21-04240.PMC8266834.pdf',
    ]);
    assert.equal(asked.length, 2);
    assert.match(asked[0], /EXT_ID%3A34241106%20AND%20SRC%3AMED/);
    assert.deepEqual(await pmcFiles('https://www.mdpi.com/1424-8220/21/12/4240', { fetch: fetchFake }), []);
    assert.deepEqual(await pmcFiles('https://europepmc.org/article/MED/999', { fetch: async () => new Response('{}', { status: 200 }) }), []);
    assert.deepEqual(await pmcFiles('https://pmc.ncbi.nlm.nih.gov/articles/PMC1/', { fetch: async () => { throw new Error('offline'); } }), []);
  });

  it("is what the proxy serves when PubMed Central's page would not hand over the file", async () => {
    upstream = (url) => {
      if (url.startsWith('https://www.ebi.ac.uk/')) return new Response(EBI, { status: 200 });
      if (url.startsWith('https://www.ncbi.nlm.nih.gov/pmc/utils/oa/')) return new Response(OA_XML, { status: 200 });
      if (url.startsWith('https://ftp.ncbi.nlm.nih.gov/')) return pdfResponse();
      return CHALLENGE();
    };
    const response = await get('https://europepmc.org/article/MED/34241106');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.equal((await response.arrayBuffer()).byteLength, PDF.length);

    // NCBI's own page saying no, too.
    upstream = (url) => {
      if (url.startsWith('https://www.ncbi.nlm.nih.gov/pmc/utils/oa/')) return new Response(OA_XML, { status: 200 });
      if (url.startsWith('https://ftp.ncbi.nlm.nih.gov/')) return pdfResponse();
      return new Response('forbidden', { status: 403 });
    };
    assert.equal((await get('https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8266834/pdf/')).status, 200);

    // Not in the open-access subset: what the page said, then.
    upstream = (url) => (url.startsWith('https://www.ncbi.nlm.nih.gov/pmc/utils/oa/') ? new Response('<OA><error code="idIsNotOpenAccess"/></OA>') : new Response('forbidden', { status: 403 }));
    const refused = await get('https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1/pdf/');
    assert.equal(refused.status, 502);
    assert.equal((await refused.json()).loginWall, true);
  });

  it('is what the Worker serves too', async () => {
    const { default: worker } = await import('../worker/index.js');
    upstream = (url) => {
      if (url.startsWith('https://www.ebi.ac.uk/')) return new Response(EBI, { status: 200 });
      if (url.startsWith('https://www.ncbi.nlm.nih.gov/pmc/utils/oa/')) return new Response(OA_XML, { status: 200 });
      if (url.startsWith('https://ftp.ncbi.nlm.nih.gov/')) return pdfResponse();
      return CHALLENGE();
    };
    const response = await worker.fetch(
      new Request('https://proxy.example/pdf?url=' + encodeURIComponent('https://europepmc.org/article/MED/34241106'), { headers: { Origin: 'https://saurav717.github.io' } }),
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
  });
});

const { isOpenReviewChallenge, openReviewFiles, openReviewNoteIn } = await import('../server/openreview.js');

describe('a paper on OpenReview, fetched from its API rather than past its check', () => {
  it('reads the note from every URL of OpenReview that names one', () => {
    assert.deepEqual(openReviewNoteIn('https://openreview.net/pdf?id=D2Q6VabcXY'), { id: 'D2Q6VabcXY', name: '' });
    assert.deepEqual(openReviewNoteIn('https://openreview.net/forum?id=D2Q6VabcXY&noteId=zzz'), { id: 'D2Q6VabcXY', name: '' });
    assert.deepEqual(openReviewNoteIn('https://openreview.net/attachment?id=D2Q6VabcXY&name=supplementary_material'), {
      id: 'D2Q6VabcXY',
      name: 'supplementary_material',
    });
    assert.deepEqual(openReviewNoteIn('https://openreview.net/challenge?redirect=%2Fpdf%3Fid%3DD2Q6VabcXY'), { id: 'D2Q6VabcXY', name: '' });
    assert.equal(openReviewNoteIn('https://openreview.net/challenge?redirect=https%3A%2F%2Fevil.example%2Fpdf%3Fid%3DD2Q6VabcXY'), null);
    assert.equal(openReviewNoteIn('https://openreview.net/challenge?redirect=%2F%2Fevil.example%2Fpdf%3Fid%3DD2Q6VabcXY'), null);
    assert.equal(openReviewNoteIn('https://openreview.net/group?id=ICLR.cc/2026/Conference'), null);
    assert.equal(openReviewNoteIn('https://example.org/pdf?id=D2Q6VabcXY'), null);
    assert.equal(openReviewNoteIn('not a url'), null);
  });

  it('asks the current API first, then the old one', () => {
    assert.deepEqual(openReviewFiles('https://openreview.net/challenge?redirect=%2Fpdf%3Fid%3DD2Q6VabcXY'), [
      'https://api2.openreview.net/pdf?id=D2Q6VabcXY',
      'https://api.openreview.net/pdf?id=D2Q6VabcXY',
    ]);
    assert.deepEqual(openReviewFiles('https://www.mdpi.com/1424-8220/21/12/4240/pdf'), []);
  });

  it('knows the check page by where it is', () => {
    assert.equal(isOpenReviewChallenge('https://openreview.net/challenge?redirect=%2Fpdf%3Fid%3DD2Q6VabcXY'), true);
    assert.equal(isOpenReviewChallenge('https://openreview.net/pdf?id=D2Q6VabcXY'), false);
    assert.equal(isOpenReviewChallenge('https://example.org/challenge'), false);
  });

  it('serves the file from the API without asking the site', async () => {
    const asked = [];
    upstream = (url) => {
      asked.push(url);
      if (url.startsWith('https://api2.openreview.net/pdf?id=D2Q6VabcXY')) return pdfResponse();
      return new Response('forbidden', { status: 403 });
    };
    const response = await get('https://openreview.net/pdf?id=D2Q6VabcXY');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.deepEqual(asked, ['https://api2.openreview.net/pdf?id=D2Q6VabcXY']);
  });

  it('falls back to the old API, then to the site and its answer', async () => {
    upstream = (url) => (url.startsWith('https://api.openreview.net/') ? pdfResponse() : new Response('not found', { status: 404 }));
    assert.equal((await get('https://openreview.net/forum?id=D2Q6VabcXY')).status, 200);
    upstream = () => new Response('forbidden', { status: 403 });
    const refused = await get('https://openreview.net/pdf?id=D2Q6VabcXY');
    assert.equal(refused.status, 502);
    assert.equal((await refused.json()).loginWall, true);
  });

  it('is what the Worker serves too', async () => {
    const { default: worker } = await import('../worker/index.js');
    upstream = (url) => (url.startsWith('https://api2.openreview.net/') ? pdfResponse() : new Response('forbidden', { status: 403 }));
    const response = await worker.fetch(
      new Request('https://proxy.example/pdf?url=' + encodeURIComponent('https://openreview.net/pdf?id=D2Q6VabcXY'), { headers: { Origin: 'https://saurav717.github.io' } }),
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
  });
});

describe("OpenReview's API refusing the Worker too", () => {
  const ask = async (env = {}) => {
    const { default: worker } = await import('../worker/index.js');
    return worker.fetch(
      new Request('https://proxy.example/pdf?url=' + encodeURIComponent('https://openreview.net/pdf?id=D2Q6VabcXY'), { headers: { Origin: 'https://saurav717.github.io' } }),
      env,
    );
  };
  const challenge = () =>
    new Response(JSON.stringify({ name: 'ChallengeRequiredError', message: 'Challenge verification required', status: 403 }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });

  it('says what each API answered, and what would get past it, without asking the site', async () => {
    const asked = [];
    upstream = (url) => {
      asked.push(url);
      return challenge();
    };
    const response = await ask();
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.error, /api2\.openreview\.net answered 403 \(ChallengeRequiredError\); api\.openreview\.net answered 403 \(ChallengeRequiredError\)/);
    assert.match(body.error, /OPENREVIEW_USERNAME and OPENREVIEW_PASSWORD/);
    assert.equal(body.botCheck, true);
    assert.equal(body.host, 'openreview.net');
    assert.ok(asked.every((url) => !url.startsWith('https://openreview.net/')));
  });

  it('signs in with the account it is given, and reads the old API when the new one has no such note', async () => {
    const logins = [];
    upstream = (url, init) => {
      if (url.endsWith('/login')) {
        logins.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ token: `t-${new URL(url).hostname}` }), { status: 200 });
      }
      const auth = init?.headers?.Authorization;
      if (!auth) return challenge();
      if (url.startsWith('https://api2.')) return new Response(JSON.stringify({ name: 'NotFoundError' }), { status: 404 });
      return auth === 'Bearer t-api.openreview.net' ? pdfResponse() : new Response('{}', { status: 401 });
    };
    const response = await ask({ OPENREVIEW_USERNAME: 'me@example.org', OPENREVIEW_PASSWORD: 'secret' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.deepEqual(logins.map((login) => login.url), ['https://api2.openreview.net/login', 'https://api.openreview.net/login']);
    assert.deepEqual(logins[0].body, { id: 'me@example.org', password: 'secret' });
  });

  it('signs in again when a kept token has expired', async () => {
    let logins = 0;
    upstream = (url, init) => {
      if (url.endsWith('/login')) {
        logins += 1;
        return new Response(JSON.stringify({ token: `fresh-${logins}` }), { status: 200 });
      }
      return init?.headers?.Authorization === `Bearer fresh-${logins}` && logins > 1
        ? pdfResponse()
        : new Response(JSON.stringify({ name: 'TokenExpiredError' }), { status: 401 });
    };
    const response = await ask({ OPENREVIEW_USERNAME: 'other@example.org', OPENREVIEW_PASSWORD: 'secret' });
    assert.equal(response.status, 200);
    assert.equal(logins, 2);
  });

  it('says so when the account will not sign in', async () => {
    upstream = (url) =>
      url.endsWith('/login')
        ? new Response(JSON.stringify({ name: 'MultiError', message: 'Invalid username or password' }), { status: 400 })
        : challenge();
    const body = await (await ask({ OPENREVIEW_USERNAME: 'wrong@example.org', OPENREVIEW_PASSWORD: 'nope' })).json();
    assert.match(body.error, /api2\.openreview\.net would not sign the account in \(MultiError: Invalid username or password\)/);
    assert.doesNotMatch(body.error, /OPENREVIEW_USERNAME/);
  });

  it('gives up on an API that does not answer, and says so, rather than holding the request until the browser does', async () => {
    const { fetchOpenReview } = await import('../server/openreview.js');
    // An API that never answers, until its deadline aborts the ask.
    const hang = (url, init) =>
      new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal.reason));
      });
    const started = Date.now();
    const { response, said } = await fetchOpenReview('https://openreview.net/pdf?id=D2Q6VabcXY', { fetch: hang, userAgent: 'test', timeoutMs: 50 });
    assert.equal(response, null);
    assert.ok(Date.now() - started < 2000);
    assert.deepEqual(said, ['api2.openreview.net did not answer within 1 s', 'api.openreview.net did not answer within 1 s']);
    const signedIn = await fetchOpenReview('https://openreview.net/pdf?id=D2Q6VabcXY', {
      fetch: hang,
      userAgent: 'test',
      timeoutMs: 1500,
      env: { OPENREVIEW_USERNAME: 'slow@example.org', OPENREVIEW_PASSWORD: 'secret' },
    });
    assert.match(signedIn.said[0], /api2\.openreview\.net would not sign the account in \(did not answer within 2 s\)/);
  });
});

// --------------------------------------------- what a name can hide behind ----

const { isPrivateHost, rejectUrl } = await import('../server/fetchPdf.js');

describe('the private-address rules, on the spellings that used to slip past them', () => {
  const refused = [
    ['IPv4-mapped IPv6 loopback', 'https://[::ffff:127.0.0.1]/'],
    ['IPv4-mapped IPv6 cloud metadata', 'https://[::ffff:169.254.169.254]/'],
    ['IPv4-mapped IPv6 in hex', 'https://[::ffff:7f00:1]/'],
    ['NAT64 to cloud metadata', 'https://[64:ff9b::a9fe:a9fe]/'],
    ['IPv6 site-local', 'https://[fec0::1]/'],
    ['the unspecified IPv6 address', 'https://[::]/'],
    ['localhost with a trailing dot', 'https://localhost./'],
    ['an internal name with a trailing dot', 'https://metadata.google.internal./'],
  ];
  for (const [label, target] of refused) {
    it(`refuses ${label}`, () => {
      assert.match(rejectUrl(target), /not reachable/, target);
    });
  }

  it('still lets the public internet through', () => {
    assert.equal(rejectUrl('https://arxiv.org/'), null);
    assert.equal(rejectUrl('https://[2606:4700::6810:84e5]/'), null);
    assert.equal(isPrivateHost('arxiv.org.'), false);
  });

  it('refuses a public-looking name that resolves to this machine, before anything is fetched', async () => {
    let fetched = 0;
    upstream = () => {
      fetched += 1;
      return pdfResponse();
    };
    const response = await get('https://rebind.example/paper.pdf');
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /not reachable/);
    assert.equal(fetched, 0);
  });

  it('refuses a redirect onto such a name too', async () => {
    upstream = (url) =>
      url.includes('/bounce')
        ? new Response(null, { status: 302, headers: { location: 'https://rebind.example/paper.pdf' } })
        : pdfResponse();
    const response = await get('https://repository.example.org/bounce');
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /not reachable/);
  });

  it('says only that it could not fetch, not what the network said', async () => {
    upstream = () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED 10.0.0.7:443') });
    };
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const response = await get('https://repository.example.org/paper.pdf');
      assert.equal(response.status, 502);
      const { error } = await response.json();
      assert.equal(error, 'could not fetch that');
    } finally {
      console.warn = warn;
    }
  });
});

// ---------------------------------------------------- who may ask for what ----

import { request as httpRequest } from 'node:http';

/** A request with whatever headers we like — fetch() will not let a Host header be set. */
const raw = (path, { method = 'GET', headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });

describe('a request with no Origin header', () => {
  // A private address the browser refuses before it looks for Chromium:
  // the answer tells whether the request got as far as the route.
  const open = '/browse/open?url=' + encodeURIComponent('https://127.0.0.1/');

  it('is taken for this machine when it came in over loopback', async () => {
    const response = await raw(open, { method: 'POST', headers: { Host: 'localhost:8080' } });
    assert.equal(response.status, 400);
    assert.match(JSON.parse(response.body).error, /not reachable/);
    for (const host of ['127.0.0.1', '[::1]:8080']) {
      assert.equal((await raw(open, { method: 'POST', headers: { Host: host } })).status, 400, host);
    }
  });

  it('is refused when the Host header says it came from anywhere else', async () => {
    const response = await raw(open, { method: 'POST', headers: { Host: 'proxy.example.org' } });
    assert.equal(response.status, 403);
    assert.match(JSON.parse(response.body).error, /not from this app/);
  });

  it('is never let in by an Origin that merely matches the Host', async () => {
    const response = await raw(open, { method: 'POST', headers: { Host: 'proxy.example.org', Origin: 'http://proxy.example.org' } });
    assert.equal(response.status, 403);
  });
});

describe('a proxy with a token', () => {
  const open = '/browse/open?url=' + encodeURIComponent('https://127.0.0.1/');
  const withToken = async (fn) => {
    process.env.READER_TOKEN = 'abc';
    try {
      return await fn();
    } finally {
      delete process.env.READER_TOKEN;
    }
  };

  it('says so in /health, so the app can ask for it', async () => {
    assert.equal((await (await realFetch(`${base}/health`)).json()).auth, false);
    await withToken(async () => {
      assert.equal((await (await realFetch(`${base}/health`)).json()).auth, true);
    });
  });

  it('wants it for the browser, and takes it as a bearer', async () =>
    withToken(async () => {
      const without = await realFetch(`${base}${open}`, { method: 'POST' });
      assert.equal(without.status, 401);
      assert.match((await without.json()).error, /needs its token/);
      const wrong = await realFetch(`${base}${open}`, { method: 'POST', headers: { Authorization: 'Bearer abd' } });
      assert.equal(wrong.status, 401);
      const longer = await realFetch(`${base}${open}`, { method: 'POST', headers: { Authorization: 'Bearer abcd' } });
      assert.equal(longer.status, 401);
      const right = await realFetch(`${base}${open}`, { method: 'POST', headers: { Authorization: 'Bearer abc' } });
      assert.equal(right.status, 400);
      assert.match((await right.json()).error, /not reachable/);
    }));

  it('wants it for the frames, the input and the sign-in, but not for the two status routes', async () =>
    withToken(async () => {
      for (const path of ['/browse/frame?after=-1', '/browse/pdf', '/access/signin', '/access/forget', '/scholar/captcha/status']) {
        assert.equal((await realFetch(`${base}${path}`)).status, 401, path);
      }
      for (const path of ['/browse/status', '/access/status']) {
        assert.equal((await realFetch(`${base}${path}`)).status, 200, path);
      }
    }));

  it('lets a request with the token in and no Origin pass as this app', async () =>
    withToken(async () => {
      const response = await raw(open, { method: 'POST', headers: { Host: 'proxy.example.org', Authorization: 'Bearer abc' } });
      assert.equal(response.status, 400);
    }));

  it('keeps the plain PDF fetch, arXiv and /health open', async () =>
    withToken(async () => {
      upstream = () => pdfResponse();
      assert.equal((await get('https://repository.example.org/paper.pdf')).status, 200);
      assert.equal((await realFetch(`${base}/health`)).status, 200);
    }));

  it('allows the token and the client id through CORS', async () => {
    const response = await realFetch(`${base}/browse/open`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://saurav717.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' },
    });
    assert.equal(response.status, 204);
    assert.match(response.headers.get('access-control-allow-headers'), /Authorization/);
    assert.match(response.headers.get('access-control-allow-headers'), /X-Reader-Client/);
  });
});

describe('what the public status routes say', () => {
  it('never where the profiles are on disk', async () => {
    const access = await (await realFetch(`${base}/access/status`)).json();
    assert.equal(access.profile, undefined);
    assert.equal(access.profileExists, false);
    const captcha = await (await realFetch(`${base}/scholar/captcha/status`)).json();
    assert.equal(captcha.profile, undefined);
    assert.equal(captcha.profileExists, false);
  });
});

describe('asking too often', () => {
  it('is held off with a 429 and told when to come back, unless the token says who it is', async () => {
    setRateLimits({ pdf: 2 });
    resetRateLimits();
    upstream = () => pdfResponse();
    try {
      assert.equal((await get('https://repository.example.org/1.pdf')).status, 200);
      assert.equal((await get('https://repository.example.org/2.pdf')).status, 200);
      const held = await get('https://repository.example.org/3.pdf');
      assert.equal(held.status, 429);
      assert.match(held.headers.get('retry-after'), /^\d+$/);
      assert.match((await held.json()).error, /too many/);
      process.env.READER_TOKEN = 'abc';
      const asked = await realFetch(`${base}/pdf?url=${encodeURIComponent('https://repository.example.org/4.pdf')}`, {
        headers: { Authorization: 'Bearer abc' },
      });
      assert.equal(asked.status, 200);
    } finally {
      delete process.env.READER_TOKEN;
      setRateLimits();
      resetRateLimits();
    }
  });
});
