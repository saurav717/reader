// The browser inside the reader: what the proxy refuses to open, what it
// says when nothing is open, what input it will pass on, and how the app
// decides where to offer to go and how to read a click on the picture. No
// browser is launched here — these are the decisions around it, which are
// what can be wrong quietly. The proxy's routes are exercised over HTTP the
// way the app calls them.
//
//   node --test scripts/browse.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { cleanup, load } from './bundle.mjs';

// No profile on this machine, whatever the machine: nothing below may decide
// a sign-in was once made here.
process.env.READER_PROFILE_DIR = join(tmpdir(), `reader-no-profile-${process.pid}`);
const { default: apiRouter } = await import('../server/api.js');
const { acceptKey, VIEWPORT } = await import('../server/browse.js');
const { extraBrowserArgs } = await import('../server/access.js');
const { isPrivateHost } = await import('../server/fetchPdf.js');

const server = createServer((req, res) => apiRouter(req, res));
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://localhost:${server.address().port}`;
after(async () => {
  server.close();
  await cleanup();
});

const post = (path, { body, headers = {} } = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });

describe('what the proxy says before anything is open', () => {
  it('answers the status with nothing open and whether it could open something', async () => {
    const response = await fetch(`${base}/browse/status`);
    assert.equal(response.status, 200);
    const answer = await response.json();
    assert.equal(answer.open, false);
    assert.equal(typeof answer.available, 'boolean');
    if (!answer.available) assert.match(answer.reason, /Playwright|Chromium/);
    assert.equal(answer.pdf, null);
  });

  it('answers a frame poll at once when nothing is open, without holding the request', async () => {
    const started = Date.now();
    const response = await fetch(`${base}/browse/frame?after=-1`);
    assert.equal(response.status, 200);
    const answer = await response.json();
    assert.equal(answer.open, false);
    assert.ok(Date.now() - started < 2000, 'the poll returned promptly');
  });

  it('says so in /health', async () => {
    const answer = await (await fetch(`${base}/health`)).json();
    assert.equal(answer.ok, true);
    assert.equal(typeof answer.browse, 'boolean');
  });

  it('has no PDF to hand over', async () => {
    const response = await fetch(`${base}/browse/pdf`);
    assert.equal(response.status, 404);
  });

  it('refuses input and a grab when no page is open', async () => {
    const input = await post('/browse/input', { body: { events: [{ type: 'move', x: 1, y: 1 }] } });
    assert.equal(input.status, 409);
    const grab = await post('/browse/grab');
    assert.equal(grab.status, 409);
  });
});

describe('what the browser may be opened on', () => {
  it('only over POST, and only from this app', async () => {
    const get = await fetch(`${base}/browse/open?url=https%3A%2F%2Fexample.com%2F`);
    assert.equal(get.status, 405);
    const elsewhere = await post('/browse/open?url=https%3A%2F%2Fexample.com%2F', { headers: { origin: 'https://evil.example' } });
    assert.equal(elsewhere.status, 403);
    for (const path of ['/browse/input', '/browse/grab', '/browse/close']) {
      const response = await post(path, { headers: { origin: 'https://evil.example' }, body: {} });
      assert.equal(response.status, 403, path);
    }
  });

  it('never at http, a private address, or this machine — before any browser is looked for', async () => {
    for (const target of [
      'http://example.com/',
      'https://localhost/',
      'https://127.0.0.1/',
      'https://10.0.0.1/',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/',
      'https://proxy.internal/',
      'not a url',
      '',
    ]) {
      const response = await post(`/browse/open?url=${encodeURIComponent(target)}`);
      assert.equal(response.status, 400, target);
      const { error } = await response.json();
      assert.match(error, /https|not reachable|not a URL|no host/, target);
    }
  });

  it('refuses a body that is not JSON, or too many events at once', async () => {
    const bad = await fetch(`${base}/browse/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    assert.equal(bad.status, 400);
    const many = await post('/browse/input', { body: { events: Array.from({ length: 65 }, () => ({ type: 'move', x: 0, y: 0 })) } });
    assert.equal(many.status, 400);
  });
});

describe('the page the person sees', () => {
  it('is a fixed size, so the app can scale the picture and send back page pixels', () => {
    assert.equal(VIEWPORT.width, 1280);
    assert.equal(VIEWPORT.height, 800);
  });

  it('lets through the keys a keyboard has and nothing else', () => {
    for (const key of ['a', 'A', ' ', '@', 'é', 'Enter', 'Backspace', 'Tab', 'ArrowLeft', 'Shift', 'Control', 'Meta', 'F5', 'F12', 'PageDown']) {
      assert.equal(acceptKey(key), true, key);
    }
    for (const key of ['', 'Dead', 'Unidentified', 'Process', 'enter', 'not a key', '<script>', 42, null]) {
      assert.equal(acceptKey(key), false, String(key));
    }
  });

  it('keeps links a page shows out of the proxy’s own network', () => {
    for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.1', '169.254.169.254', '[::1]', 'box.internal', '']) {
      assert.equal(isPrivateHost(host), true, host);
    }
    for (const host of ['ieeexplore.ieee.org', 'link.springer.com', '8.8.8.8', 'scholar.google.com']) {
      assert.equal(isPrivateHost(host), false, host);
    }
  });

  it('takes extra Chromium flags split the way a shell would', () => {
    assert.deepEqual(extraBrowserArgs(''), []);
    assert.deepEqual(extraBrowserArgs('--proxy-server=http://p:3128 --no-sandbox'), ['--proxy-server=http://p:3128', '--no-sandbox']);
    assert.deepEqual(extraBrowserArgs(`--host-resolver-rules="MAP a.example 10.0.0.1" '--x=1 2'`), ['--host-resolver-rules=MAP a.example 10.0.0.1', '--x=1 2']);
  });
});

// ------------------------------------------------------------- the app ----

const { browseSites, keyName, siteFromInput, toPagePoint } = await load('src/lib/browse.ts');

const paper = { id: 'doi:10.1000/x', source: 'openalex', title: 'A paper', authors: [], abstract: '', published: '2021', categories: [] };
const at = (url, extra) => ({ url, host: new URL(url).hostname, label: new URL(url).hostname, kind: 'unknown', isPdf: false, via: 'paper', ...extra });

describe('where the app offers to go', () => {
  it('puts the site that asked for a sign-in first, at its landing page, and Scholar last', () => {
    const sites = browseSites(
      paper,
      [
        at('https://arxiv.org/pdf/2101.00001', { kind: 'preprint', isPdf: true, label: 'arXiv' }),
        at('https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=1', { kind: 'publisher', isPdf: true, label: 'IEEE' }),
        at('https://ieeexplore.ieee.org/document/1', { kind: 'publisher', label: 'IEEE' }),
        at('https://eprints.example.ac.uk/1/paper.pdf', { kind: 'repository', isPdf: true, label: 'eprints.example.ac.uk' }),
      ],
      { host: 'ieeexplore.ieee.org', url: 'https://ieeexplore.ieee.org/document/1' },
    );
    assert.deepEqual(
      sites.map((site) => site.host),
      ['ieeexplore.ieee.org', 'eprints.example.ac.uk', 'arxiv.org', 'scholar.google.com'],
    );
    assert.equal(sites[0].walled, true);
    assert.equal(sites[0].url, 'https://ieeexplore.ieee.org/document/1');
    assert.equal(sites[0].label, 'IEEE');
    assert.match(sites[0].note, /sign in/);
    assert.match(sites.at(-1).url, /^https:\/\/scholar\.google\.com\/scholar\?q=/);
  });

  it('folds www. into the host, and offers a walled host even when no copy names it', () => {
    const sites = browseSites(paper, [at('https://www.example.org/paper.pdf', { isPdf: true })], {
      host: 'www.example.org',
      url: 'https://www.example.org/paper',
    });
    assert.equal(sites.length, 2);
    assert.equal(sites[0].host, 'example.org');
    assert.equal(sites[0].url, 'https://www.example.org/paper');
    const alone = browseSites(paper, [], { host: 'publisher.example', url: 'https://publisher.example/doi/1' });
    assert.deepEqual(
      alone.map((site) => site.host),
      ['publisher.example', 'scholar.google.com'],
    );
  });

  it('always has Scholar, so there is somewhere to go when nothing else is known', () => {
    const sites = browseSites(paper, null, null);
    assert.equal(sites.length, 1);
    assert.equal(sites[0].host, 'scholar.google.com');
  });

  it('makes a typed site into something the proxy will open, and refuses what it will not', () => {
    assert.equal(siteFromInput('library.example.edu'), 'https://library.example.edu/');
    assert.equal(siteFromInput('  https://link.springer.com/article/1 '), 'https://link.springer.com/article/1');
    assert.equal(siteFromInput('http://plain.example/'), null);
    assert.equal(siteFromInput('localhost'), null);
    assert.equal(siteFromInput(''), null);
  });
});

describe('how a click on the picture reaches the page', () => {
  it('scales a point on the picture to the page’s own pixels', () => {
    const box = { left: 100, top: 50, width: 640, height: 400 };
    assert.deepEqual(toPagePoint({ x: 100, y: 50 }, box, VIEWPORT), { x: 0, y: 0 });
    assert.deepEqual(toPagePoint({ x: 420, y: 250 }, box, VIEWPORT), { x: 640, y: 400 });
    assert.deepEqual(toPagePoint({ x: 740, y: 450 }, box, VIEWPORT), { x: 1280, y: 800 });
  });

  it('never sends a point outside the page', () => {
    const box = { left: 0, top: 0, width: 640, height: 400 };
    assert.deepEqual(toPagePoint({ x: -20, y: 900 }, box, VIEWPORT), { x: 0, y: 800 });
    assert.deepEqual(toPagePoint({ x: 10, y: 10 }, { left: 0, top: 0, width: 0, height: 0 }, VIEWPORT), { x: 0, y: 0 });
  });

  it('names keys the way the proxy accepts them, and drops the ones it cannot press', () => {
    assert.equal(keyName('a'), 'a');
    assert.equal(keyName('Enter'), 'Enter');
    assert.equal(keyName('ArrowDown'), 'ArrowDown');
    assert.equal(keyName('Dead'), null);
    assert.equal(keyName('Process'), null);
    assert.equal(keyName(''), null);
  });
});
