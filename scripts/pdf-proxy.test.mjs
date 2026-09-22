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

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 0x20), Buffer.from('\n%%EOF')]);

/** Answers the next fetch, whatever URL it is for. */
let upstream = () => new Response('nothing stubbed', { status: 500 });
const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => upstream(String(input instanceof Request ? input.url : input));

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
