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

// ------------------------------------------------------------ the Worker ----

const worker = await import('../worker/browse.js');

describe('the browser from the Worker', () => {
  it('has a browser only with the binding, and says how to add one', () => {
    assert.deepEqual(worker.availability({ BROWSER: {} }), { available: true });
    const without = worker.availability({});
    assert.equal(without.available, false);
    assert.match(without.reason, /wrangler\.toml/);
    assert.equal(worker.idle({}).open, false);
    assert.equal(worker.idle({ BROWSER: {}, SESSIONS: {} }).persistent, true);
    assert.equal(worker.idle({ BROWSER: {} }).persistent, false);
  });

  it('refuses a missing or malformed session before reaching for a browser', async () => {
    for (const session of ['', undefined, 'not a session', 'x'.repeat(200)]) {
      await assert.rejects(worker.frame({ BROWSER: {} }, session), (error) => error.code === 'closed');
    }
    await assert.rejects(worker.open({ BROWSER: {} }, 'http://example.com/'), /https/);
    await assert.rejects(worker.open({}, 'https://example.com/'), /wrangler\.toml/);
  });

  it('makes a Cookie header from the kept cookies that match the URL, and only those', () => {
    const cookies = [
      { name: 'sid', value: '1', domain: '.ieee.org', path: '/', secure: true },
      { name: 'host', value: '2', domain: 'ieeexplore.ieee.org', path: '/' },
      { name: 'other', value: '3', domain: 'www.ieee.org', path: '/' },
      { name: 'deep', value: '4', domain: '.ieee.org', path: '/admin' },
      { name: 'old', value: '5', domain: '.ieee.org', path: '/', expires: 1 },
      { name: 'else', value: '6', domain: '.springer.com', path: '/' },
    ];
    assert.equal(worker.cookieHeaderFor(cookies, 'https://ieeexplore.ieee.org/document/1'), 'sid=1; host=2');
    assert.equal(worker.cookieHeaderFor(cookies, 'https://ieeexplore.ieee.org/admin/x'), 'sid=1; host=2; deep=4');
    assert.equal(worker.cookieHeaderFor(cookies, 'https://link.springer.com/article/1'), 'else=6');
    assert.equal(worker.cookieHeaderFor(cookies, 'https://example.org/'), '');
    assert.equal(worker.cookieHeaderFor(cookies, 'not a url'), '');
  });

  it('keeps and forgets cookies only where there is somewhere to keep them', async () => {
    const store = new Map();
    const env = { SESSIONS: { get: async (k) => store.get(k) ?? null, put: async (k, v) => store.set(k, v), delete: async (k) => store.delete(k) } };
    assert.deepEqual(await worker.storedCookies({}), []);
    assert.deepEqual(await worker.storedCookies(env), []);
    store.set('browser-cookies', JSON.stringify([{ name: 'a', value: '1', domain: '.x.org', path: '/' }, { name: 'gone', value: '2', domain: '.x.org', path: '/', expires: 1 }]));
    assert.deepEqual((await worker.storedCookies(env)).map((c) => c.name), ['a']);
    assert.equal(await worker.forgetCookies(env), true);
    assert.equal(await worker.forgetCookies({}), false);
    assert.deepEqual(await worker.storedCookies(env), []);
  });
});

describe('the Worker entry', () => {
  it('exports the Durable Object that holds a session open, for the runtime to find', async () => {
    const entry = await import('../worker/index.js');
    assert.equal(typeof entry.BrowserSession, 'function');
    assert.equal(typeof entry.default.fetch, 'function');
  });
});

describe('what the Worker says when Cloudflare refuses a browser', () => {
  it('has a message for the person about the free plan, not a status code', async () => {
    const { RATE_LIMITED, rateLimited, rateLimitedMessage } = await import('../worker/browserSession.js');
    assert.match(RATE_LIMITED, /free plan/);
    assert.match(RATE_LIMITED, /try again/);
    assert.equal(rateLimited(new Error('Unable to create new browser: code: 429: message: nope')), true);
    assert.equal(rateLimited(new Error('Unable to create new browser: code: 500: message: boom')), false);
    // Cloudflare's own reason rides on the end, since the minute's allowance
    // and the day's are refused with the same code.
    const worded = rateLimitedMessage(new Error('Unable to create new browser: code: 429: message: Too many browsers this minute.'));
    assert.ok(worded.startsWith(RATE_LIMITED));
    assert.match(worded, /Cloudflare said: Too many browsers this minute\.$/);
    assert.equal(rateLimitedMessage(new Error('429')), RATE_LIMITED);
  });
});

// ------------------------------------------ the browser kept after a close ----

/**
 * A stand-in for the Durable Object's surroundings and for Cloudflare's
 * browser: enough of a page to be pointed somewhere, drawn and listened
 * to, and a storage that remembers what it is told. No browser is started;
 * asking for one is the failure these tests are about.
 */
function fakeSession() {
  const store = new Map();
  const alarms = [];
  const state = {
    storage: {
      get: async (key) => store.get(key),
      put: async (key, value) => store.set(key, value),
      delete: async (key) => store.delete(key),
      setAlarm: async (at) => alarms.push(at),
      deleteAlarm: async () => alarms.push(null),
    },
  };
  const visited = [];
  const cdp = { sent: [], send: async (method) => cdp.sent.push(method), detach: async () => undefined, on: () => undefined };
  const page = {
    closed: false,
    isClosed: () => page.closed,
    url: () => visited[visited.length - 1] || 'about:blank',
    goto: async (url) => visited.push(url),
    title: async () => '',
    setViewport: async () => undefined,
    screenshot: async () => 'a-jpeg',
    createCDPSession: async () => cdp,
    cookies: async () => [],
    on: () => undefined,
    once: () => undefined,
  };
  const browser = { closed: false, on: () => undefined, pages: async () => [page], close: async () => (browser.closed = true) };
  return { state, store, alarms, visited, cdp, page, browser };
}

describe('the browser kept after the pane closes', () => {
  const call = (object, path, method = 'GET') => object.fetch(new Request(`https://browser-session${path}`, { method })).then((r) => r.json());

  it('is pointed at the next site rather than replaced, and closed only when nobody comes back', async () => {
    const { BrowserSession } = await import('../worker/browserSession.js');
    const fake = fakeSession();
    const object = new BrowserSession(fake.state, { BROWSER: {} });
    let asked = 0;
    object.acquire = async () => {
      asked += 1;
      throw new Error('a new browser was asked for');
    };
    await object.adopt(fake.browser, 'kept-session');
    object.token = 'first';
    await fake.state.storage.put('session', { token: 'first', id: 'kept-session' });

    // The pane closes: the browser stays, blank, out of the old token's reach.
    const closed = await call(object, '/close?session=first', 'POST');
    assert.equal(closed.open, false);
    assert.equal(fake.browser.closed, false);
    assert.equal(fake.visited[fake.visited.length - 1], 'about:blank');
    assert.equal(object.token, null);
    assert.deepEqual(fake.store.get('session'), { token: null, id: 'kept-session' });
    const linger = fake.alarms[fake.alarms.length - 1] - Date.now();
    assert.ok(linger > 30_000 && linger <= 45_000, `kept for ${linger}ms`);
    assert.equal((await call(object, '/frame?session=first&after=-1')).open, false);
    assert.match((await call(object, '/input?session=first', 'POST')).error, /no browser is open/);

    // The pane opens again, somewhere else: the same browser, no new one.
    const opened = await call(object, '/open?url=https%3A%2F%2Fexample.org%2Fpaper', 'POST');
    assert.equal(opened.ok, true);
    assert.equal(opened.open, true);
    assert.ok(opened.session && opened.session !== 'first');
    assert.equal(asked, 0);
    assert.equal(fake.visited[fake.visited.length - 1], 'https://example.org/paper');
    assert.ok(fake.cdp.sent.filter((m) => m === 'Page.startScreencast').length >= 2, 'the screencast starts again');
    assert.equal((await call(object, `/frame?session=${opened.session}&after=-1`)).open, true);

    // Closed and left: the alarm closes the browser for good.
    await call(object, `/close?session=${opened.session}`, 'POST');
    object.lastSeen = Date.now() - 60_000;
    await object.alarm();
    assert.equal(fake.browser.closed, true);
    assert.equal(object.browser, null);
  });

  it('closes a browser whose pane is open only after the longer idle', async () => {
    const { BrowserSession } = await import('../worker/browserSession.js');
    const fake = fakeSession();
    const object = new BrowserSession(fake.state, { BROWSER: {} });
    await object.adopt(fake.browser, 'kept-session');
    object.token = 'open';
    object.lastSeen = Date.now() - 60_000;
    await object.alarm();
    assert.equal(fake.browser.closed, false, 'a minute is not idle for an open pane');
    object.lastSeen = Date.now() - 3 * 60_000;
    await object.alarm();
    assert.equal(fake.browser.closed, true);
  });
});

// ------------------------------------------- a site that checks for a person ----

const { fetchFileInPage } = await import('../server/browseShared.js');
const { botCheck } = await load('src/lib/browse.ts');

describe('the file, fetched by the page itself', () => {
  const pdf = new TextEncoder().encode('%PDF-1.4 a file');
  const base64 = Buffer.from(pdf).toString('base64');
  /** A page whose fetch() answers by URL: the base64 of a PDF, an HTML page, or a CORS refusal. */
  const pageAnswering = (answers) => ({
    asked: [],
    async evaluate(_fn, { url }) {
      this.asked.push(url);
      const answer = answers[url];
      if (answer === 'throws') throw new Error('Execution context was destroyed');
      return answer === undefined ? null : answer;
    },
  });

  it('returns the bytes of the first URL the page could fetch as a PDF, and skips the rest', async () => {
    const page = pageAnswering({ 'https://a.example/landing': null, 'https://a.example/file.pdf': { base64 } });
    const bytes = await fetchFileInPage(page, ['https://a.example/landing', 'https://a.example/file.pdf', 'https://a.example/other.pdf']);
    assert.deepEqual([...bytes], [...pdf]);
    assert.deepEqual(page.asked, ['https://a.example/landing', 'https://a.example/file.pdf']);
  });

  it('answers null when no URL gave a file, and asks each URL once', async () => {
    const page = pageAnswering({});
    assert.equal(await fetchFileInPage(page, ['https://a.example/x', 'https://a.example/x', 'not a url', 'ftp://a.example/y']), null);
    assert.deepEqual(page.asked, ['https://a.example/x']);
  });

  it('carries on past a page that cannot be asked, and refuses what is not a PDF', async () => {
    const page = pageAnswering({ 'https://a.example/1': 'throws', 'https://a.example/2': { base64: Buffer.from('<html>').toString('base64') } });
    assert.equal(await fetchFileInPage(page, ['https://a.example/1', 'https://a.example/2']), null);
    assert.deepEqual(page.asked, ['https://a.example/1', 'https://a.example/2']);
  });

  it('says when the file is too large rather than fetching it', async () => {
    const page = pageAnswering({ 'https://a.example/big.pdf': { tooLarge: true } });
    await assert.rejects(fetchFileInPage(page, ['https://a.example/big.pdf']), /too large/);
  });
});

describe('what the app says on a site that checks for a person', () => {
  it("names the site and says the box is the person's to tick, on Cloudflare's check", () => {
    const byUrl = botCheck({ url: 'https://www.academia.edu/download/1/10.pdf?__cf_chl_rt_tk=abc', title: '' });
    assert.match(byUrl, /^academia\.edu is checking/);
    assert.match(byUrl, /tick it/);
    assert.match(botCheck({ url: 'https://www.academia.edu/download/1/10.pdf', title: 'Just a moment...' }), /^academia\.edu/);
    assert.match(botCheck({ url: 'https://example.org/', title: 'Attention Required! | Cloudflare' }), /^example\.org/);
    assert.match(botCheck({ url: 'https://example.org/', title: 'Verify you are human' }), /^example\.org/);
  });

  it('says nothing on an ordinary page, or with nothing open', () => {
    assert.equal(botCheck({ url: 'https://ieeexplore.ieee.org/document/1', title: 'A paper | IEEE Xplore' }), null);
    assert.equal(botCheck({ url: 'https://example.org/?token=__cf_chl_rt_tk', title: '' }), null);
    assert.equal(botCheck({ url: '', title: 'Just a moment...' }), null);
    assert.equal(botCheck(null), null);
    assert.equal(botCheck({ url: 'not a url', title: 'Just a moment...' }), null);
  });
});
