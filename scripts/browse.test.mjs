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
    assert.deepEqual(worker.availability({ BROWSER: {} }), { available: true, where: 'cloudflare' });
    const without = worker.availability({});
    assert.equal(without.available, false);
    assert.match(without.reason, /wrangler\.toml/);
    assert.match(without.reason, /BROWSERLESS_TOKEN/);
    // A browser elsewhere: Cloudflare's first with both, named as where a check is handed; alone, the only one.
    assert.deepEqual(worker.availability({ BROWSER: {}, BROWSERLESS_TOKEN: 't' }), { available: true, where: 'cloudflare', fallback: 'browserless' });
    assert.deepEqual(worker.availability({ BROWSERLESS_TOKEN: 't' }), { available: true, where: 'browserless' });
    assert.deepEqual(worker.availability({ BROWSERLESS_TOKEN: '  ' }), without);
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

  it('closes the socket to a session whose handshake fails, so the session does not live on held', async () => {
    const { connectSession, PROTOCOL_TIMEOUT_MS } = await import('../worker/browse.js');
    const made = [];
    const create = async (_binding, id) => {
      const transport = { id, closed: false, close: () => (transport.closed = true) };
      made.push(transport);
      return transport;
    };
    const env = { BROWSER: {} };
    // A handshake that fails: the socket is closed and the failure passed on.
    await assert.rejects(
      connectSession(env, 'mute', { create, connect: async () => { throw new Error('Browser.getVersion timed out'); } }),
      /timed out/,
    );
    assert.equal(made[0].closed, true);
    // One that answers: the browser, with the socket left to it — and the protocol timeout set.
    let options;
    const browser = await connectSession(env, 'fine', { create, connect: async (transport, given) => { options = given; return { transport }; } });
    assert.equal(browser.transport, made[1]);
    assert.equal(made[1].closed, false);
    assert.equal(options.sessionId, 'fine');
    assert.equal(options.protocolTimeout, PROTOCOL_TIMEOUT_MS);
    assert.ok(PROTOCOL_TIMEOUT_MS < 60_000, 'well under Puppeteer\'s three minutes');
  });

  it("reads Cloudflare's limits into a shape, whatever it left out", async () => {
    const { shapeLimits } = await import('../worker/browse.js');
    assert.deepEqual(
      shapeLimits({ activeSessions: [{ id: 'a' }, { id: 'b' }], maxConcurrentSessions: 3, allowedBrowserAcquisitions: 0, timeUntilNextAllowedBrowserAcquisition: 21_500 }),
      { alive: 2, max: 3, allowed: 0, nextInMs: 21_500 },
    );
    assert.deepEqual(shapeLimits({}), { alive: null, max: null, allowed: null, nextInMs: 0 });
    assert.deepEqual(shapeLimits({ timeUntilNextAllowedBrowserAcquisition: -5, allowedBrowserAcquisitions: 'x' }), { alive: null, max: null, allowed: null, nextInMs: 0 });
    assert.equal(shapeLimits(null), null);
    assert.equal(shapeLimits('nope'), null);
  });

  it('names the limit met, from what Cloudflare said its limits are', async () => {
    const { rateLimitedMessage, refusal, saidWait, waitFor, whichLimit, RATE_LIMITED, RATE_LIMIT_RETRY_MS } = await import('../worker/browserSession.js');
    const full = { alive: 3, max: 3, allowed: 1, nextInMs: 0 };
    const minute = { alive: 1, max: 3, allowed: 0, nextInMs: 21_500 };
    const unknown = { alive: 1, max: 3, allowed: 0, nextInMs: 0 };
    assert.match(whichLimit(full), /^All 3 of the browsers it allows alive at once are alive/);
    assert.match(whichLimit(minute), /next is allowed in 22 seconds\.$/);
    assert.match(whichLimit(unknown), /did not say when/);
    assert.equal(whichLimit({ alive: 1, max: 3, allowed: 2, nextInMs: 0 }), '');
    assert.equal(whichLimit(null), '');
    assert.equal(saidWait(500), '1 second');
    assert.equal(saidWait(180_000), 'about 3 minutes');
    // The limit met sits between the plan and Cloudflare's own words.
    const worded = rateLimitedMessage(new Error('Unable to create new browser: code: 429: message: Rate limit exceeded'), minute);
    assert.ok(worded.startsWith(RATE_LIMITED));
    assert.match(worded, /used up; the next is allowed in 22 seconds\. Cloudflare said: Rate limit exceeded\.$/);
    // The wait is what Cloudflare named, within reason; a few seconds when it named none.
    assert.equal(waitFor(minute), 21_500);
    assert.equal(waitFor({ ...minute, nextInMs: 100 }), 2_000);
    assert.equal(waitFor({ ...minute, nextInMs: 600_000 }), 60_000);
    assert.equal(waitFor(full), RATE_LIMIT_RETRY_MS);
    assert.equal(waitFor(null), RATE_LIMIT_RETRY_MS);
    // The refusal carries the wait in seconds for the app, a minute when unknown.
    const refused = refusal(new Error('429'), minute);
    assert.equal(refused.code, 'rate-limited');
    assert.equal(refused.retryAfter, 22);
    assert.deepEqual(refused.browsers, minute);
    assert.equal(refusal(null, null).retryAfter, 60);
    assert.equal(refusal(null, null).browsers, null);
    assert.equal(refusal(null, full).retryAfter, 60);
  });
});

// ------------------------------------------------- getting a browser at all ----

/**
 * A stand-in for Cloudflare's browser API: what it lists as alive, what it
 * says its limits are (a script, one answer per ask), and whether it will
 * start a browser. Every ask is written down.
 */
function fakeDriver({ sessions = [], limits = [], launch = 'refuse' } = {}) {
  const asked = { sessions: 0, limits: 0, launch: 0, connect: [] };
  const lists = Array.isArray(sessions[0]) ? sessions : [sessions];
  const browserNamed = (id) => ({ id, sessionId: () => id, on: () => undefined, pages: async () => [], newPage: async () => fakeSession().page, close: async () => undefined });
  return {
    asked,
    sessions: async () => {
      const list = lists[Math.min(asked.sessions, lists.length - 1)] || [];
      asked.sessions += 1;
      return list;
    },
    limits: async () => {
      const answer = limits[Math.min(asked.limits, limits.length - 1)];
      asked.limits += 1;
      if (answer === 'fails') throw new Error('Unable to fetch account limits: code: 500: message: boom');
      return answer;
    },
    connect: async (_env, id) => {
      asked.connect.push(id);
      if (String(id).startsWith('gone')) throw new Error(`Unable to connect to existing session ${id}`);
      return browserNamed(id);
    },
    launch: async () => {
      asked.launch += 1;
      const answer = Array.isArray(launch) ? launch[Math.min(asked.launch - 1, launch.length - 1)] : launch;
      if (answer === 'refuse') throw new Error('Unable to create new browser: code: 429: message: Rate limit exceeded');
      return browserNamed('new');
    },
  };
}

describe('how the Worker gets a browser', () => {
  const objectWith = async (driver) => {
    const { BrowserSession } = await import('../worker/browserSession.js');
    const fake = fakeSession();
    const object = new BrowserSession(fake.state, { BROWSER: {} });
    object.driver = driver;
    object.slept = [];
    // Sleeping is instant here, and the clock moves by what was slept.
    let clock = Date.now();
    object.now = () => clock;
    object.sleep = async (ms) => {
      object.slept.push(ms);
      clock += ms;
    };
    return { object, fake };
  };

  it('takes over a session nothing is connected to before asking for a new one', async () => {
    const driver = fakeDriver({ sessions: [{ sessionId: 'held', connectionId: 'c1' }, { sessionId: 'free' }] });
    const { object } = await objectWith(driver);
    const got = await object.acquire();
    assert.equal(got.id, 'free');
    assert.deepEqual(driver.asked.connect, ['free']);
    assert.equal(driver.asked.launch, 0);
    assert.equal(driver.asked.limits, 0, 'nothing to ask when there is one to take');
  });

  it('tries the session it had before it was evicted first, and the free ones when that is gone', async () => {
    const driver = fakeDriver({ sessions: [{ sessionId: 'free' }] });
    const { object, fake } = await objectWith(driver);
    await fake.state.storage.put('session', { token: null, id: 'gone-mine' });
    const got = await object.acquire();
    assert.equal(got.id, 'free');
    assert.deepEqual(driver.asked.connect, ['gone-mine', 'free']);
    assert.equal(driver.asked.launch, 0);
  });

  it('asks Cloudflare what it will allow, and starts a browser when it will', async () => {
    const driver = fakeDriver({ limits: [{ activeSessions: [], maxConcurrentSessions: 3, allowedBrowserAcquisitions: 3, timeUntilNextAllowedBrowserAcquisition: 0 }], launch: 'ok' });
    const { object } = await objectWith(driver);
    const got = await object.acquire();
    assert.equal(got.id, 'new');
    assert.equal(driver.asked.limits, 1);
    assert.equal(driver.asked.launch, 1);
    assert.deepEqual(object.slept, []);
    assert.deepEqual(object.limits, { alive: 0, max: 3, allowed: 3, nextInMs: 0 });
  });

  it("waits exactly as long as Cloudflare says, once, rather than asking for a browser meanwhile", async () => {
    const spent = { activeSessions: [{ id: 'a' }], maxConcurrentSessions: 3, allowedBrowserAcquisitions: 0, timeUntilNextAllowedBrowserAcquisition: 21_500 };
    const back = { ...spent, allowedBrowserAcquisitions: 1, timeUntilNextAllowedBrowserAcquisition: 0 };
    const driver = fakeDriver({ limits: [spent, back], launch: 'ok' });
    const { object } = await objectWith(driver);
    const got = await object.acquire();
    assert.equal(got.id, 'new');
    assert.deepEqual(object.slept, [21_500]);
    assert.equal(driver.asked.launch, 1, 'asked only once Cloudflare said it would answer');
    assert.equal(driver.asked.sessions, 2, 'looked for a freed session again after the wait');
  });

  it('looks again every few seconds when every browser is alive and held, and takes one that comes free', async () => {
    const full = { activeSessions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], maxConcurrentSessions: 3, allowedBrowserAcquisitions: 2, timeUntilNextAllowedBrowserAcquisition: 0 };
    const driver = fakeDriver({
      sessions: [[{ sessionId: 'a', connectionId: '1' }, { sessionId: 'b', connectionId: '2' }, { sessionId: 'c', connectionId: '3' }], [{ sessionId: 'a', connectionId: '1' }, { sessionId: 'b' }]],
      limits: [full],
      launch: 'refuse',
    });
    const { object } = await objectWith(driver);
    const got = await object.acquire();
    assert.equal(got.id, 'b');
    assert.equal(driver.asked.launch, 0, 'a start cannot succeed with every browser alive, so none was asked for');
    assert.deepEqual(object.slept, [12_000]);
  });

  it('gives up at once, saying how long, when the wait Cloudflare names is longer than it will hold the request', async () => {
    const spent = { activeSessions: [{ id: 'a' }], maxConcurrentSessions: 3, allowedBrowserAcquisitions: 0, timeUntilNextAllowedBrowserAcquisition: 55_000 };
    const driver = fakeDriver({ limits: [spent] });
    const { object } = await objectWith(driver);
    await assert.rejects(object.acquire(), (error) => {
      assert.equal(error.code, 'rate-limited');
      assert.equal(error.retryAfter, 55);
      assert.match(error.message, /next is allowed in 55 seconds/);
      assert.deepEqual(error.browsers, { alive: 1, max: 3, allowed: 0, nextInMs: 55_000 });
      return true;
    });
    assert.equal(driver.asked.launch, 0);
    assert.deepEqual(object.slept, []);
  });

  it('gives up after most of a minute of looking when Cloudflare names no time', async () => {
    const full = { activeSessions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], maxConcurrentSessions: 3, allowedBrowserAcquisitions: 3, timeUntilNextAllowedBrowserAcquisition: 0 };
    const driver = fakeDriver({ limits: [full], launch: 'refuse' });
    const { object } = await objectWith(driver);
    await assert.rejects(object.acquire(), (error) => {
      assert.equal(error.code, 'rate-limited');
      assert.equal(error.retryAfter, 60);
      assert.match(error.message, /All 3 of the browsers it allows alive at once are alive/);
      assert.doesNotMatch(error.message, /Cloudflare said/, 'nothing was asked for, so Cloudflare said nothing');
      return true;
    });
    assert.deepEqual(object.slept, [12_000, 12_000, 12_000, 12_000]);
    assert.equal(driver.asked.launch, 0);
    assert.equal(driver.asked.sessions, 5, 'looked for a freed session on every pass');
  });

  it('asks for a browser when Cloudflare says one may be started, and waits out its refusal when it refuses anyway', async () => {
    const room = { activeSessions: [{ id: 'a' }], maxConcurrentSessions: 3, allowedBrowserAcquisitions: 1, timeUntilNextAllowedBrowserAcquisition: 0 };
    const driver = fakeDriver({ limits: [room], launch: ['refuse', 'ok'] });
    const { object } = await objectWith(driver);
    const got = await object.acquire();
    assert.equal(got.id, 'new');
    assert.equal(driver.asked.launch, 2);
    assert.deepEqual(object.slept, [12_000]);
  });

  it('carries on the old way when Cloudflare will not say what its limits are', async () => {
    const driver = fakeDriver({ limits: ['fails'], launch: ['refuse', 'ok'] });
    const { object } = await objectWith(driver);
    const got = await object.acquire();
    assert.equal(got.id, 'new');
    assert.equal(object.limits, null);
    assert.deepEqual(object.slept, [12_000]);
  });

  it('hands out the refusal as a 429 with the wait on it, for the app to count down', async () => {
    const spent = { activeSessions: [{ id: 'a' }], maxConcurrentSessions: 3, allowedBrowserAcquisitions: 0, timeUntilNextAllowedBrowserAcquisition: 55_000 };
    const { object } = await objectWith(fakeDriver({ limits: [spent] }));
    const response = await object.fetch(new Request('https://browser-session/open?url=https%3A%2F%2Fexample.org%2F', { method: 'POST' }));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('Retry-After'), '55');
    const body = await response.json();
    assert.equal(body.retryAfter, 55);
    assert.equal(body.browsers.alive, 1);
    assert.match(body.error, /^Cloudflare would not start another browser just now/);
    // And the status says what Cloudflare last said, for anyone looking.
    const status = await (await object.fetch(new Request('https://browser-session/status'))).json();
    assert.deepEqual(status.browsers, { alive: 1, max: 3, allowed: 0, nextInMs: 55_000 });
  });

  it('gives up on a session that never answers, leaves it alone after, and takes the next', async () => {
    const driver = fakeDriver({ sessions: [{ sessionId: 'mute' }, { sessionId: 'free' }] });
    driver.connect = async (_env, id) => {
      driver.asked.connect.push(id);
      if (id === 'mute') return new Promise(() => undefined); // never answers
      return { id, sessionId: () => id, on: () => undefined, pages: async () => [], close: async () => undefined };
    };
    const { object } = await objectWith(driver);
    object.deadlines.connect = 30;
    const got = await object.acquire();
    assert.equal(got.id, 'free');
    assert.deepEqual(driver.asked.connect, ['mute', 'free']);
    assert.ok(object.avoid.get('mute') > Date.now(), 'the mute session is avoided');
    // Asked again, the mute session is not even tried.
    driver.asked.connect.length = 0;
    await object.acquire();
    assert.deepEqual(driver.asked.connect, ['free']);
  });

  it('answers the open with what took too long rather than hanging, lets the browser go, and says so in the status', async () => {
    const { BrowserSession } = await import('../worker/browserSession.js');
    const fake = fakeSession();
    const object = new BrowserSession(fake.state, { BROWSER: {} });
    object.deadlines = { ...object.deadlines, adopt: 30, close: 30, ask: 30 };
    object.driver = fakeDriver({ limits: [{ activeSessions: [], maxConcurrentSessions: 3, allowedBrowserAcquisitions: 3, timeUntilNextAllowedBrowserAcquisition: 0 }] });
    let letGo = false;
    const stuck = {
      sessionId: () => 'stuck',
      on: () => undefined,
      pages: () => new Promise(() => undefined), // never answers
      close: async () => (letGo = true),
    };
    object.acquire = async () => ({ browser: stuck, id: 'stuck' });
    const started = Date.now();
    const response = await object.fetch(new Request('https://browser-session/open?url=https%3A%2F%2Fexample.org%2F', { method: 'POST' }));
    assert.equal(response.status, 504);
    const body = await response.json();
    assert.match(body.error, /taking the browser took longer than 0 seconds/);
    assert.ok(Date.now() - started < 5_000, 'answered promptly');
    assert.equal(letGo, true, 'the browser that would not answer was closed');
    assert.equal(object.browser, null);
    assert.equal(object.opening, null);
    assert.ok(object.avoid.get('stuck') > Date.now(), 'and is avoided');
    const status = await (await object.fetch(new Request('https://browser-session/status'))).json();
    assert.equal(status.open, false);
    assert.equal(status.held, false);
    assert.equal(status.opening, null);
    assert.deepEqual(status.avoiding, ['stuck']);
    assert.match(status.lastError.message, /took longer/);
    assert.equal(status.lastError.code, 'timeout');
    assert.equal(status.lastError.url, 'https://example.org/');
    assert.deepEqual(status.browsers, { alive: 0, max: 3, allowed: 3, nextInMs: 0 });
  });

  it('answers the open when the whole of it runs out, and the abandoned open stops at its next step', async () => {
    const { BrowserSession } = await import('../worker/browserSession.js');
    const fake = fakeSession();
    const object = new BrowserSession(fake.state, { BROWSER: {} });
    object.deadlines = { ...object.deadlines, open: 40, close: 30 };
    let release;
    const late = fakeSession();
    let closedLate = false;
    late.browser.close = async () => (closedLate = true);
    object.acquire = () => new Promise((resolve) => (release = () => resolve({ browser: late.browser, id: 'late' })));
    const response = await object.fetch(new Request('https://browser-session/open?url=https%3A%2F%2Fexample.org%2F', { method: 'POST' }));
    assert.equal(response.status, 504);
    assert.match((await response.json()).error, /opening the browser took longer than 0 seconds/);
    // The browser that arrives after the open was given up on is let go, not held.
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(closedLate, true);
    assert.equal(object.browser, null);
  });

  it('reports what it holds and how long an open has been in flight', async () => {
    const { BrowserSession } = await import('../worker/browserSession.js');
    const fake = fakeSession();
    const object = new BrowserSession(fake.state, { BROWSER: {} });
    object.driver = fakeDriver({ limits: ['fails'] });
    await object.adopt(fake.browser, 'kept-session');
    object.token = 'open';
    const status = await (await object.fetch(new Request('https://browser-session/status'))).json();
    assert.equal(status.open, true);
    assert.equal(status.held, true);
    assert.equal(status.page, true);
    assert.equal(status.id, 'kept-session');
    assert.equal(status.opening, null);
    assert.equal(status.frame, undefined);
    assert.equal(status.browsers, null);
    assert.equal(status.lastError, null);
  });

  it("says it is most likely the day's time, after one more look, when Cloudflare refuses a start its limits allow", async () => {
    const { contradicted } = await import('../worker/browserSession.js');
    assert.equal(contradicted({ alive: 0, max: 4, allowed: 1, nextInMs: 0 }), true);
    assert.equal(contradicted({ alive: 4, max: 4, allowed: 1, nextInMs: 0 }), false);
    assert.equal(contradicted({ alive: 0, max: 4, allowed: 0, nextInMs: 30_000 }), false);
    assert.equal(contradicted(null), false);
    const room = { activeSessions: [], maxConcurrentSessions: 4, allowedBrowserAcquisitions: 1, timeUntilNextAllowedBrowserAcquisition: 0 };
    const driver = fakeDriver({ limits: [room], launch: 'refuse' });
    const { object } = await objectWith(driver);
    const response = await object.fetch(new Request('https://browser-session/open?url=https%3A%2F%2Fexample.org%2F', { method: 'POST' }));
    assert.equal(response.status, 429);
    const body = await response.json();
    assert.equal(body.retryAfter, null, 'no countdown: no wait cures it');
    assert.equal(body.daily, true);
    assert.match(body.error, /^Cloudflare says a browser may start, yet refuses to start one/);
    assert.match(body.error, /Cloudflare said: Rate limit exceeded\.$/);
    assert.equal(driver.asked.launch, 2, 'one more look, then said');
    assert.deepEqual(object.slept, [12_000]);
  });

  it("says at once, with no countdown, when Cloudflare's refusal is the day's browser time", async () => {
    const room = { activeSessions: [], maxConcurrentSessions: 4, allowedBrowserAcquisitions: 1, timeUntilNextAllowedBrowserAcquisition: 0 };
    const driver = fakeDriver({ limits: [room] });
    driver.launch = async () => {
      driver.asked.launch += 1;
      throw new Error('Unable to create new browser: code: 429: message: Browser time limit exceeded for today');
    };
    const { object } = await objectWith(driver);
    const response = await object.fetch(new Request('https://browser-session/open?url=https%3A%2F%2Fexample.org%2F', { method: 'POST' }));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('Retry-After'), null);
    const body = await response.json();
    assert.equal(body.daily, true);
    assert.equal(body.retryAfter, null);
    assert.match(body.error, /^Cloudflare's free plan gives this Worker some minutes of browser time a day, and today's are spent/);
    assert.match(body.error, /Cloudflare said: Browser time limit exceeded for today\.$/);
    assert.equal(driver.asked.launch, 1, 'asked once, and not again');
    assert.deepEqual(object.slept, []);
  });

  it('writes down what happened where a later instance can read it, since eviction empties memory', async () => {
    const { BrowserSession } = await import('../worker/browserSession.js');
    const room = { activeSessions: [], maxConcurrentSessions: 4, allowedBrowserAcquisitions: 1, timeUntilNextAllowedBrowserAcquisition: 0 };
    const driver = fakeDriver({ limits: [room], launch: 'refuse' });
    const { object, fake } = await objectWith(driver);
    const first = await object.fetch(new Request('https://browser-session/open?url=https%3A%2F%2Fexample.org%2F', { method: 'POST' }));
    assert.equal(first.status, 429);
    // A fresh instance on the same storage, as after an eviction.
    const later = new BrowserSession(fake.state, { BROWSER: {} });
    later.driver = fakeDriver({ limits: ['fails'] });
    const status = await (await later.fetch(new Request('https://browser-session/status'))).json();
    assert.equal(status.seq, 0, 'a fresh instance');
    assert.match(status.lastError.message, /^Cloudflare says a browser may start, yet refuses to start one/);
    assert.equal(status.lastError.code, 'rate-limited');
    assert.equal(status.lastError.url, 'https://example.org/');
    assert.ok(status.log.length >= 2);
    assert.match(status.log[0].what, /^Cloudflare refused a browser: Unable to create new browser: code: 429: message: Rate limit exceeded/);
    assert.match(status.log[status.log.length - 1].what, /^open failed \(rate-limited\)/);
    assert.deepEqual(status.browsers, { alive: 0, max: 4, allowed: 1, nextInMs: 0 }, "what Cloudflare last said, when it won't say now");
  });

  it('opens a new page in the browser it holds when the page went, rather than asking for another browser', async () => {
    const { BrowserSession } = await import('../worker/browserSession.js');
    const fake = fakeSession();
    const object = new BrowserSession(fake.state, { BROWSER: {} });
    object.acquire = async () => {
      throw new Error('a new browser was asked for');
    };
    const replacement = fakeSession().page;
    fake.browser.newPage = async () => replacement;
    await object.adopt(fake.browser, 'kept-session');
    fake.page.closed = true;
    const opened = await object.open('https://example.org/paper');
    assert.equal(opened.open, true);
    assert.equal(object.page, replacement);
    assert.equal(object.browser, fake.browser);
    assert.equal(fake.browser.closed, false);
  });

  it('lets go of a browser that will not give a page, so it does not sit holding one of the few allowed', async () => {
    const { BrowserSession } = await import('../worker/browserSession.js');
    const fake = fakeSession();
    const object = new BrowserSession(fake.state, { BROWSER: {} });
    const fresh = fakeSession();
    object.acquire = async () => ({ browser: fresh.browser, id: 'fresh' });
    fake.browser.newPage = async () => {
      throw new Error('Target closed');
    };
    await object.adopt(fake.browser, 'kept-session');
    fake.page.closed = true;
    const opened = await object.open('https://example.org/paper');
    assert.equal(opened.open, true);
    assert.equal(fake.browser.closed, true, 'the useless browser was closed, not left held');
    assert.equal(object.browser, fresh.browser);
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
  it("names the site and says the box is the person's to tick, on Cloudflare's check from the proxy's own browser", () => {
    const byUrl = botCheck({ url: 'https://www.academia.edu/download/1/10.pdf?__cf_chl_rt_tk=abc', title: '', where: 'proxy' });
    assert.match(byUrl, /^academia\.edu is checking/);
    assert.match(byUrl, /tick it/);
    assert.match(botCheck({ url: 'https://www.academia.edu/download/1/10.pdf', title: 'Just a moment...', where: 'proxy' }), /^academia\.edu/);
    assert.match(botCheck({ url: 'https://example.org/', title: 'Attention Required! | Cloudflare', where: 'proxy' }), /^example\.org/);
    assert.match(botCheck({ url: 'https://example.org/', title: 'Verify you are human', where: 'proxy' }), /^example\.org/);
    // A proxy that says nothing about whose browser it is, and hands out no session id, is the Node proxy.
    assert.match(botCheck({ url: 'https://example.org/', title: 'Just a moment...' }), /tick it/);
  });

  it("says Cloudflare's check will not pass from Cloudflare's own browser, before the box is ever ticked", () => {
    const fromWorker = botCheck({ url: 'https://www.academia.edu/download/1/10.pdf', title: 'Just a moment...', where: 'cloudflare' });
    assert.match(fromWorker, /^academia\.edu is checking/);
    assert.match(fromWorker, /not expected to pass from here/);
    assert.match(fromWorker, /rendering browsers are bots/);
    assert.match(fromWorker, /tab of your own/);
    assert.match(fromWorker, /Settings → Paper proxy/);
    assert.doesNotMatch(fromWorker, /tick it;/);
    // A Worker deployed before it said whose browser it is still hands out a session id, which only it does.
    assert.match(botCheck({ url: 'https://example.org/', title: 'Just a moment...', session: 'abc' }), /not expected to pass/);
    // With a browser at Browserless to hand the session to, the check is a moment's wait, not a dead end.
    const handing = botCheck({ url: 'https://www.academia.edu/download/1/10.pdf', title: 'Just a moment...', where: 'cloudflare', fallback: 'browserless' });
    assert.match(handing, /^academia\.edu is checking/);
    assert.match(handing, /handed to a browser at Browserless/);
    assert.match(handing, /yours to tick/);
    assert.doesNotMatch(handing, /not expected to pass/);
    // Browserless gave no browser: said, in its words, with the way out.
    const refused = botCheck({ url: 'https://www.academia.edu/download/1/10.pdf', title: 'Just a moment...', where: 'cloudflare', fallback: 'browserless', fallbackError: 'Browserless would not open a browser: code: 403: message: Bad token.' });
    assert.match(refused, /Browserless gave none — Browserless would not open a browser: code: 403: message: Bad token — so it stays here/);
    assert.match(refused, /tab of your own/);
    assert.doesNotMatch(refused, /A moment/);
    // Handed over, the browser is Browserless's, and the box is the person's to tick as from the Node proxy.
    const there = botCheck({ url: 'https://www.academia.edu/download/1/10.pdf', title: '', where: 'browserless', check: { host: 'academia.edu', times: 1, answered: 0 } });
    assert.match(there, /^academia\.edu is checking/);
    assert.match(there, /tick it;/);
    assert.doesNotMatch(there, /rendering browsers are bots/);
    // The proxy's word that the page is the check beats a title that says nothing.
    const byHeader = botCheck({ url: 'https://www.academia.edu/download/1/10.pdf', title: '', where: 'cloudflare', check: { host: 'academia.edu', times: 1, answered: 0 } });
    assert.match(byHeader, /not expected to pass/);
    // A check the proxy saw on another host is not this page's.
    assert.equal(botCheck({ url: 'https://example.org/', title: '', where: 'cloudflare', check: { host: 'academia.edu', times: 1, answered: 0 } }), null);
  });

  it('says the check came back after it was answered, and what to do instead', () => {
    const came = { host: 'academia.edu', times: 3, answered: 1 };
    const fromWorker = botCheck({ url: 'https://www.academia.edu/download/1/10.pdf', title: '', where: 'cloudflare', check: came });
    assert.match(fromWorker, /^academia\.edu's check has come back after you answered it/);
    assert.match(fromWorker, /however many times the box is ticked/);
    assert.match(fromWorker, /tab of your own/);
    const fromProxy = botCheck({ url: 'https://www.academia.edu/download/1/10.pdf', title: '', where: 'proxy', check: came });
    assert.match(fromProxy, /^academia\.edu's check has come back after you answered it/);
    assert.match(fromProxy, /refusing this browser/);
    assert.match(fromProxy, /tab of your own/);
    assert.doesNotMatch(fromProxy, /Paper proxy/, 'the proxy is already their own');
    // Come back on its own — the check's first pass running its scripts — is still the check, to tick.
    const ran = botCheck({ url: 'https://www.academia.edu/download/1/10.pdf', title: '', where: 'proxy', check: { host: 'academia.edu', times: 2, answered: 0 } });
    assert.match(ran, /tick it/);
  });

  it('says nothing on an ordinary page, or with nothing open', () => {
    assert.equal(botCheck({ url: 'https://ieeexplore.ieee.org/document/1', title: 'A paper | IEEE Xplore' }), null);
    assert.equal(botCheck({ url: 'https://example.org/?token=__cf_chl_rt_tk', title: '' }), null);
    assert.equal(botCheck({ url: '', title: 'Just a moment...' }), null);
    assert.equal(botCheck(null), null);
    assert.equal(botCheck({ url: 'not a url', title: 'Just a moment...' }), null);
    // The check over: the proxy reports none, and the page is the site's.
    assert.equal(botCheck({ url: 'https://www.academia.edu/download/1/10.pdf', title: '', where: 'cloudflare', check: null }), null);
  });
});

// ------------------------------------ the check, noticed from the response ----

const { challengedHost, checkAfter, isMainDocument } = await import('../server/browseShared.js');

describe('how the proxy notices a site\'s check for a person', () => {
  const main = { name: 'main' };
  const page = { mainFrame: () => main };
  const response = ({ url = 'https://www.academia.edu/download/1/10.pdf', headers = {}, type = 'document', frame = main } = {}) => ({
    url: () => url,
    headers: () => headers,
    request: () => ({ resourceType: () => type }),
    frame: () => frame,
  });

  it("knows Cloudflare's challenge page by the header Cloudflare puts on it, whatever the page says", () => {
    assert.equal(challengedHost(response({ headers: { 'cf-mitigated': 'challenge' } })), 'academia.edu');
    assert.equal(challengedHost(response({ headers: { 'cf-mitigated': 'Challenge ' } })), 'academia.edu');
    assert.equal(challengedHost(response({ headers: { 'cf-mitigated': 'block' } })), null);
    assert.equal(challengedHost(response({ headers: {} })), null);
    assert.equal(challengedHost(response({ url: 'not a url', headers: { 'cf-mitigated': 'challenge' } })), null);
    assert.equal(challengedHost({ headers: () => { throw new Error('gone'); }, url: () => '' }), null);
  });

  it('looks only at the page itself, never at its frames and fetches', () => {
    assert.equal(isMainDocument(response(), page), true);
    assert.equal(isMainDocument(response({ type: 'xhr' }), page), false);
    assert.equal(isMainDocument(response({ frame: { name: 'the widget' } }), page), false, "the check's own widget is a frame from Cloudflare's domain");
    assert.equal(isMainDocument(response({ frame: null }), page), true, "a response with no frame to name is the page's");
    assert.equal(isMainDocument({ request: () => { throw new Error('gone'); } }, page), false);
  });

  it('counts the check coming, and how many of those came after the person answered it', () => {
    const first = checkAfter(null, 'academia.edu', false);
    assert.deepEqual(first, { host: 'academia.edu', times: 1, answered: 0 });
    // The check's scripts ran and it came back on its own: still the check, not yet refused.
    const ran = checkAfter(first, 'academia.edu', false);
    assert.deepEqual(ran, { host: 'academia.edu', times: 2, answered: 0 });
    // The box ticked, and the check back: that is the site refusing the browser.
    const refused = checkAfter(ran, 'academia.edu', true);
    assert.deepEqual(refused, { host: 'academia.edu', times: 3, answered: 1 });
    // Another host's check starts over, ticked or not.
    assert.deepEqual(checkAfter(refused, 'example.org', true), { host: 'example.org', times: 1, answered: 0 });
    assert.equal(checkAfter(refused, null, true), null);
  });

  it('is reported by the Worker\'s session from the page it holds, and cleared when the site itself comes', async () => {
    const { BrowserSession } = await import('../worker/browserSession.js');
    const fake = fakeSession();
    const handlers = {};
    fake.page.on = (event, handler) => {
      (handlers[event] ||= []).push(handler);
    };
    const arrives = (response) => handlers.response.forEach((handler) => handler(response));
    fake.page.mainFrame = () => main;
    const object = new BrowserSession(fake.state, { BROWSER: {} });
    await object.adopt(fake.browser, 'a-session');
    object.token = 'tok';
    const call = (path, method = 'GET', body) =>
      object.fetch(new Request(`https://browser-session${path}`, { method, body: body ? JSON.stringify(body) : undefined })).then((r) => r.json());

    assert.equal((await object.status(-1)).check, null);
    const challenge = response({ headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } });
    arrives(challenge);
    assert.deepEqual((await object.status(-1)).check, { host: 'academia.edu', times: 1, answered: 0 });
    // The widget's own frame, and the page's fetches, say nothing.
    arrives(response({ headers: { 'cf-mitigated': 'challenge' }, frame: { name: 'widget' } }));
    arrives(response({ headers: { 'cf-mitigated': 'challenge' }, type: 'xhr' }));
    assert.deepEqual((await object.status(-1)).check, { host: 'academia.edu', times: 1, answered: 0 });
    // The person ticks the box; the check comes back.
    fake.page.mouse = { move: async () => undefined, down: async () => undefined, up: async () => undefined };
    assert.equal((await call('/input?session=tok', 'POST', [{ type: 'move', x: 1, y: 1 }, { type: 'down', x: 1, y: 1 }, { type: 'up', x: 1, y: 1 }])).ok, true);
    arrives(challenge);
    assert.deepEqual((await object.status(-1)).check, { host: 'academia.edu', times: 2, answered: 1 });
    // The site itself comes: the check is over.
    arrives(response({ headers: { 'content-type': 'text/html' } }));
    assert.equal((await object.status(-1)).check, null);
    // Opening somewhere else starts clean.
    fake.page.goto = async () => undefined;
    fake.page.url = () => 'https://example.org/';
    arrives(challenge);
    await object.open('https://example.org/');
    assert.equal((await object.status(-1)).check, null);
  });
});

// ------------------------------------------ a browser elsewhere: Browserless ----

const elsewhere = await import('../worker/browserless.js');

describe('the address the Worker connects to Browserless at', () => {
  it('is the stealth Chromium, with the token, the session length, and the proxy when one is asked for', () => {
    const address = elsewhere.endpoint({ token: 'secret' });
    assert.equal(address, 'wss://production-sfo.browserless.io/chromium/stealth?token=secret&timeout=120000');
    const home = elsewhere.endpoint({ token: 'secret', url: 'wss://production-lon.browserless.io/', proxy: 'residential', country: 'GB', timeoutMs: 90_000 });
    assert.equal(home, 'wss://production-lon.browserless.io/chromium/stealth?token=secret&timeout=90000&proxy=residential&proxyCountry=gb');
    // A country without a proxy is nothing to route through.
    assert.equal(elsewhere.endpoint({ token: 'secret', country: 'us' }).includes('proxyCountry'), false);
    assert.throws(() => elsewhere.endpoint({ token: 'secret', url: 'https://example.org/path' }), /wss:\/\//);
  });

  it('comes from the Worker settings, and is written down without the token', () => {
    const env = { BROWSERLESS_TOKEN: ' secret ', BROWSERLESS_PROXY: 'residential' };
    const address = elsewhere.endpointFor(env);
    assert.match(address, /token=secret&/);
    assert.equal(elsewhere.redacted(address).includes('secret'), false);
    assert.match(elsewhere.redacted(address), /token=…&timeout=/);
    assert.equal(elsewhere.configured(env), true);
    assert.equal(elsewhere.configured({ BROWSERLESS_TOKEN: '' }), false);
    assert.equal(elsewhere.configured({}), false);
    assert.equal(elsewhere.isBrowserless('browserless:abc'), true);
    assert.equal(elsewhere.isBrowserless('abc'), false);
    // The session length: the free plan's two minutes, unless a var raises it.
    assert.equal(elsewhere.sessionMsOf({}), 120_000);
    assert.equal(elsewhere.sessionMsOf({ BROWSERLESS_SESSION_MS: '600000' }), 600_000);
    assert.equal(elsewhere.sessionMsOf({ BROWSERLESS_SESSION_MS: 'ten minutes' }), 120_000);
    assert.match(elsewhere.endpointFor({ BROWSERLESS_TOKEN: 't', BROWSERLESS_SESSION_MS: '300000' }), /timeout=300000/);
  });

  it("reads the plan's cap on session time out of a refusal, and asks again at it", async () => {
    const said =
      "Browserless would not open a browser: code: 400: message: The 'timeout' value must be a whole number of milliseconds between 1 and 120,000 (your plan's maximum session time, 2 minutes). Received \"600000\". Use a smaller timeout, or upgrade your plan for a longer one.";
    assert.equal(elsewhere.sessionCapIn(said), 120_000);
    assert.equal(elsewhere.sessionCapIn('Browserless would not open a browser: code: 403: message: Bad token'), null);
    assert.equal(elsewhere.sessionCapIn(''), null);
    const opened = [];
    const socket = { accept: () => undefined, addEventListener: () => undefined, close: () => undefined };
    const browser = await elsewhere.launch(
      { BROWSERLESS_TOKEN: 't', BROWSERLESS_SESSION_MS: '600000' },
      {
        open: async (address) => {
          opened.push(address);
          if (opened.length === 1) throw new Error(said);
          return socket;
        },
        connect: async (_transport, options) => ({ sessionId: () => options.sessionId }),
      },
    );
    assert.match(browser.sessionId(), /^browserless:/);
    assert.equal(opened.length, 2);
    assert.match(opened[0], /timeout=600000/);
    assert.match(opened[1], /timeout=120000/);
    // A refusal about anything else is not asked again.
    await assert.rejects(
      elsewhere.launch(
        { BROWSERLESS_TOKEN: 't' },
        {
          open: async () => {
            throw new Error('Browserless would not open a browser: code: 403: message: Bad token');
          },
        },
      ),
      /Bad token/,
    );
  });

  it('opens the socket the way a Worker does, and words a refusal from what came back instead', async () => {
    const calls = [];
    const socket = { accepted: false, accept: () => (socket.accepted = true), addEventListener: () => undefined };
    const opened = await elsewhere.openSocket('wss://production-sfo.browserless.io/chromium/stealth?token=t', async (url, init) => {
      calls.push({ url, init });
      return { webSocket: socket, status: 101 };
    });
    assert.equal(opened, socket);
    assert.equal(socket.accepted, true);
    assert.equal(calls[0].url, 'https://production-sfo.browserless.io/chromium/stealth?token=t');
    assert.equal(calls[0].init.headers.Upgrade, 'websocket');
    await assert.rejects(
      elsewhere.openSocket('wss://production-sfo.browserless.io/?token=t', async () => new Response('Bad or missing token', { status: 403 })),
      /Browserless would not open a browser: code: 403: message: Bad or missing token/,
    );
  });

  it('drives what it connects to like any browser, under a session id of its own, and lets go when the handshake fails', async () => {
    const env = { BROWSERLESS_TOKEN: 't' };
    const socket = { closed: false, accept: () => undefined, addEventListener: () => undefined, close: () => (socket.closed = true) };
    let seen;
    const browser = await elsewhere.launch(env, {
      open: async () => socket,
      connect: async (transport, options) => {
        seen = { transport, options };
        return { sessionId: () => options.sessionId };
      },
    });
    assert.match(browser.sessionId(), /^browserless:[0-9a-f-]{36}$/);
    assert.equal(seen.options.sessionId, browser.sessionId());
    assert.equal(seen.options.protocolTimeout, 30_000);
    assert.equal(seen.transport.ws, socket);
    await assert.rejects(
      elsewhere.launch(env, {
        open: async () => socket,
        connect: async () => {
          throw new Error('no answer');
        },
      }),
      /no answer/,
    );
    assert.equal(socket.closed, true, 'the socket is closed rather than left holding a browser');
    await assert.rejects(elsewhere.launch({}, { open: async () => socket }), /BROWSERLESS_TOKEN/);
  });
});

describe('a file behind a check, fetched from a Browserless page', () => {
  const main = { name: 'main' };
  const arrival = (url, headers) => ({ url: () => url, headers: () => headers, request: () => ({ resourceType: () => 'document' }), frame: () => main });
  const PDF = '%PDF-1.4 a paper';
  const makeBrowser = ({ arrivals = [], file = true } = {}) => {
    const handlers = {};
    const visited = [];
    const page = {
      mainFrame: () => main,
      url: () => visited[visited.length - 1] || 'about:blank',
      setViewport: async () => undefined,
      on: (event, handler) => (handlers[event] ||= []).push(handler),
      goto: async (url) => {
        visited.push(url);
        // The page's own responses, in order, as the navigation brings them.
        for (const [at, headers] of arrivals) handlers.response.forEach((handler) => handler(arrival(at, headers)));
      },
      // The page's own fetch of the file, with its cookies (`fetchFileInPage`).
      evaluate: async () => (file ? { base64: btoa(PDF) } : null),
    };
    const browser = { closed: false, pages: async () => [page], newPage: async () => page, close: async () => (browser.closed = true) };
    return { browser, page, visited, handlers };
  };

  it('does nothing without a token, and never for a URL the proxy refuses', async () => {
    let launched = 0;
    const launch = async () => {
      launched += 1;
      throw new Error('should not be asked');
    };
    assert.equal(await elsewhere.fetchFile({}, 'https://www.academia.edu/download/1/10.pdf', { launch }), null);
    assert.equal(await elsewhere.fetchFile({ BROWSERLESS_TOKEN: 't' }, 'http://www.academia.edu/download/1/10.pdf', { launch }), null);
    assert.equal(await elsewhere.fetchFile({ BROWSERLESS_TOKEN: 't' }, 'https://10.0.0.1/x.pdf', { launch }), null);
    assert.equal(launched, 0);
  });

  it('hands back the file when the check passes on its own, with the cookies kept, and closes the browser', async () => {
    const url = 'https://www.academia.edu/download/1/10.pdf';
    const fake = makeBrowser({ arrivals: [[url, { 'cf-mitigated': 'challenge' }], [url, { 'content-type': 'application/pdf' }]] });
    let launchedWith;
    const kept = [];
    const got = await elsewhere.fetchFile({ BROWSERLESS_TOKEN: 't' }, url, {
      launch: async (_env, options) => {
        launchedWith = options;
        return fake.browser;
      },
      restoreCookies: async () => kept.push('restored'),
      saveCookies: async () => kept.push('saved'),
    });
    assert.equal(new TextDecoder().decode(got.bytes), PDF);
    assert.deepEqual(fake.visited, [url]);
    assert.deepEqual(kept, ['restored', 'saved']);
    assert.equal(launchedWith.timeoutMs, 90_000, 'a session long enough for the check, not for a person');
    assert.equal(fake.browser.closed, true);
  });

  it('says the check needs a person when it is still there after the wait, and closes the browser', async () => {
    const url = 'https://www.academia.edu/download/1/10.pdf';
    const fake = makeBrowser({ arrivals: [[url, { 'cf-mitigated': 'challenge' }], [url, { 'cf-mitigated': 'challenge' }]] });
    const started = Date.now();
    const got = await elsewhere.fetchFile({ BROWSERLESS_TOKEN: 't' }, url, { launch: async () => fake.browser, waitMs: 30 });
    assert.deepEqual(got, { check: { host: 'academia.edu', times: 2, answered: 0 } });
    assert.ok(Date.now() - started < 2000);
    assert.equal(fake.browser.closed, true);
  });

  it('gives nothing when the page is not a file, or Browserless gives no browser', async () => {
    const url = 'https://www.academia.edu/download/1/10.pdf';
    const fake = makeBrowser({ arrivals: [[url, { 'content-type': 'text/html' }]], file: false });
    assert.equal(await elsewhere.fetchFile({ BROWSERLESS_TOKEN: 't' }, url, { launch: async () => fake.browser }), null);
    assert.equal(fake.browser.closed, true);
    assert.equal(
      await elsewhere.fetchFile({ BROWSERLESS_TOKEN: 't' }, url, {
        launch: async () => {
          throw new Error('code: 429: too many browsers');
        },
      }),
      null,
    );
  });
});

const { BrowserSession, challengedAfter, isRemembered, hostOf } = await import('../worker/browserSession.js');

describe('the session handed to a browser at Browserless', () => {
  const main = { name: 'main' };
  const arrival = (url, headers) => ({ url: () => url, headers: () => headers, request: () => ({ resourceType: () => 'document' }), frame: () => main });
  const CHECK = 'https://www.academia.edu/download/1/10.pdf';

  /** A page that records what happens to it, and lets a response be delivered to it. */
  const fakePage = () => {
    const handlers = {};
    const visited = [];
    const page = {
      closed: false,
      isClosed: () => page.closed,
      mainFrame: () => main,
      url: () => visited[visited.length - 1] || 'about:blank',
      goto: async (url) => visited.push(url),
      title: async () => '',
      setViewport: async () => undefined,
      screenshot: async () => 'a-jpeg',
      createCDPSession: async () => ({ send: async () => undefined, detach: async () => undefined, on: () => undefined }),
      cookies: async () => [],
      on: (event, handler) => (handlers[event] ||= []).push(handler),
      once: () => undefined,
      visited,
      arrives: (response) => (handlers.response || []).forEach((handler) => handler(response)),
    };
    return page;
  };
  const fakeBrowser = (id, page) => ({ id, closed: false, sessionId: () => id, on: () => undefined, pages: async () => [page], newPage: async () => page, close: async () => (page.browser.closed = true) });

  /** An object holding Cloudflare's browser, with a driver that can start one at Browserless. */
  const held = async (env = { BROWSER: {}, BROWSERLESS_TOKEN: 't' }, { launch = 'ok' } = {}) => {
    const fake = fakeSession();
    const object = new BrowserSession(fake.state, env);
    const first = fakePage();
    const cloudflares = fakeBrowser('cf-session', first);
    first.browser = cloudflares;
    const launches = [];
    const second = fakePage();
    const browserlesss = fakeBrowser('browserless:new', second);
    second.browser = browserlesss;
    object.driver = {
      launch: async (_env, options) => {
        launches.push(options);
        if (launch === 'refuse') throw new Error('Browserless would not open a browser: code: 429: message: Too many concurrent sessions');
        return browserlesss;
      },
      connect: async () => {
        throw new Error('nothing to connect to');
      },
      sessions: async () => [],
      limits: async () => null,
    };
    await object.adopt(cloudflares, 'cf-session');
    object.token = 'tok';
    await fake.state.storage.put('session', { token: 'tok', id: 'cf-session' });
    return { object, fake, first, second, cloudflares, browserlesss, launches };
  };

  it('remembers a host for a week, and forgets the stale ones', () => {
    const now = 1_000_000;
    const hosts = challengedAfter({ 'old.example': now - 1, 'kept.example': now + 5 }, 'academia.edu', now);
    assert.deepEqual(hosts, { 'kept.example': now + 5, 'academia.edu': now + 7 * 24 * 60 * 60_000 });
    assert.equal(isRemembered(hosts, 'academia.edu', now), true);
    assert.equal(isRemembered(hosts, 'academia.edu', now + 8 * 24 * 60 * 60_000), false);
    assert.equal(isRemembered(hosts, 'nobody.example', now), false);
    assert.equal(isRemembered(null, 'academia.edu', now), false);
    assert.deepEqual(challengedAfter('not an object', 'a.example', now), { 'a.example': now + 7 * 24 * 60 * 60_000 });
    assert.equal(hostOf('https://www.academia.edu/download/1'), 'academia.edu');
    assert.equal(hostOf('not a url'), '');
  });

  it("is handed over when Cloudflare's check comes to Cloudflare's browser: the same page opens there, the token holds, Cloudflare's browser is closed", async () => {
    const { object, first, second, cloudflares, launches, fake } = await held();
    assert.equal((await object.status(-1)).where, 'cloudflare');
    assert.equal((await object.status(-1)).fallback, 'browserless');
    first.arrives(arrival(CHECK, { 'cf-mitigated': 'challenge' }));
    assert.ok(object.moving, 'the hand-over began');
    // The check is still reported meanwhile, for the line under the page.
    assert.deepEqual((await object.status(-1)).check, { host: 'academia.edu', times: 1, answered: 0 });
    await object.moving;
    assert.deepEqual(launches, [{ at: 'browserless' }]);
    const status = await object.status(-1);
    assert.equal(status.open, true);
    assert.equal(status.session, 'tok');
    assert.equal(status.where, 'browserless');
    assert.equal(status.check, null);
    assert.equal(status.url, CHECK);
    assert.deepEqual(second.visited, [CHECK]);
    assert.equal(object.browser.id, 'browserless:new');
    assert.equal(cloudflares.closed, true);
    assert.equal(object.id, 'browserless:new');
    assert.deepEqual(await fake.state.storage.get('session'), { token: 'tok', id: 'browserless:new' });
    assert.equal(isRemembered(await fake.state.storage.get('challenged'), 'academia.edu'), true);
    assert.match(object.log.map((entry) => entry.what).join('\n'), /handing the session to a browser at Browserless[\s\S]*handed over to Browserless/);
    // The check's page coming again, from Cloudflare's browser still finishing, starts no second hand-over.
    first.arrives(arrival(CHECK, { 'cf-mitigated': 'challenge' }));
    assert.equal(object.moving, null);
    assert.deepEqual(launches.length, 1);
    // From the browser at Browserless the check is the person's to tick, and counted as before.
    second.arrives(arrival(CHECK, { 'cf-mitigated': 'challenge' }));
    assert.deepEqual((await object.status(-1)).check, { host: 'academia.edu', times: 1, answered: 0 });
    assert.equal(object.moving, null);
  });

  it("stays on Cloudflare's browser, and says why in the status, when Browserless gives none", async () => {
    const { object, first, cloudflares, launches } = await held(undefined, { launch: 'refuse' });
    first.arrives(arrival(CHECK, { 'cf-mitigated': 'challenge' }));
    await object.moving;
    assert.equal(launches.length, 1);
    const status = await object.status(-1);
    assert.equal(status.where, 'cloudflare');
    assert.equal(status.open, true);
    assert.deepEqual(status.check, { host: 'academia.edu', times: 1, answered: 0 });
    assert.equal(cloudflares.closed, false);
    assert.match(object.lastError.message, /Too many concurrent sessions/);
    // The line under the page can say so: the refusal rides the status, in Browserless's words.
    assert.match(status.fallbackError, /^Browserless would not open a browser: code: 429: message: Too many concurrent sessions$/);
    // Opening somewhere else starts clean.
    await object.open('https://example.org/');
    assert.equal((await object.status(-1)).fallbackError, undefined);
  });

  it('is not handed over without a token, nor from a browser that is already Browserless\'s', async () => {
    const { object, first, launches } = await held({ BROWSER: {} });
    first.arrives(arrival(CHECK, { 'cf-mitigated': 'challenge' }));
    assert.equal(object.moving, null);
    assert.equal(launches.length, 0);
    assert.equal((await object.status(-1)).fallback, undefined);
  });

  it('opens a remembered host at Browserless straight away, letting go of Cloudflare\'s browser, and the next site at Cloudflare\'s again', async () => {
    const { object, fake, cloudflares, launches, second } = await held();
    await fake.state.storage.put('challenged', challengedAfter({}, 'academia.edu', Date.now()));
    await object.open('https://www.academia.edu/download/2/20.pdf');
    assert.deepEqual(launches, [{ at: 'browserless' }]);
    assert.equal(cloudflares.closed, true);
    assert.equal((await object.status(-1)).where, 'browserless');
    assert.deepEqual(second.visited, ['https://www.academia.edu/download/2/20.pdf']);
    // Another site is Cloudflare's browser's again: the one at Browserless is let go, and Cloudflare asked.
    let askedCloudflare = 0;
    object.driver.launch = async (_env, options) => {
      launches.push(options);
      askedCloudflare += 1;
      const page = fakePage();
      const browser = fakeBrowser('cf-again', page);
      page.browser = browser;
      return browser;
    };
    object.driver.limits = async () => ({ activeSessions: [], maxConcurrentSessions: 3, allowedBrowserAcquisitions: 3, timeUntilNextAllowedBrowserAcquisition: 0 });
    await object.open('https://example.org/');
    assert.equal(second.browser.closed, true, "Browserless's browser is closed, not kept");
    assert.equal(askedCloudflare, 1);
    assert.equal(launches.length, 2);
    assert.equal(launches[1]?.at, undefined, "Cloudflare's, asked for as before");
    assert.equal((await object.status(-1)).where, 'cloudflare');
  });

  it("uses Browserless for everything when there is no browser of Cloudflare's", async () => {
    const { object, launches } = await held({ BROWSERLESS_TOKEN: 't' });
    await object.forget();
    await object.open('https://example.org/');
    assert.deepEqual(launches, [{ at: 'browserless' }]);
    const status = await object.status(-1);
    assert.equal(status.where, 'browserless');
    assert.equal(status.fallback, undefined);
    assert.equal(status.open, true);
  });

  it('closes a browser at Browserless when the pane closes, rather than keeping it, and never reconnects to one', async () => {
    const { object, fake, second, first } = await held();
    first.arrives(arrival(CHECK, { 'cf-mitigated': 'challenge' }));
    await object.moving;
    const answer = await (await object.fetch(new Request('https://browser-session/close?session=tok', { method: 'POST' }))).json();
    assert.equal(answer.open, false);
    assert.equal(second.browser.closed, true);
    assert.equal(object.browser, null);
    assert.equal(await fake.state.storage.get('session'), undefined);
    // An object evicted with a Browserless session in storage does not try to take it back.
    await fake.state.storage.put('session', { token: 'again', id: 'browserless:gone' });
    object.token = null;
    const frame = await (await object.fetch(new Request('https://browser-session/frame?session=again&after=-1'))).json();
    assert.equal(frame.open, false);
  });

  it("remembers a host `/pdf` met the check at, so the pane opens there at Browserless", async () => {
    const { object, fake, launches } = await held();
    const noted = await (await object.fetch(new Request('https://browser-session/note-check?host=www.europepmc.org', { method: 'POST' }))).json();
    assert.equal(noted.ok, true);
    assert.equal(isRemembered(await fake.state.storage.get('challenged'), 'europepmc.org'), true);
    await object.open('https://europepmc.org/article/MED/1?pdf=1');
    assert.deepEqual(launches, [{ at: 'browserless' }]);
  });
});

describe('input across a hand-over, and a session Browserless ended', () => {
  const { apply } = worker;

  it('lets a release whose press went to the page before pass, rather than failing the batch', async () => {
    const page = {
      mouse: {
        move: async () => undefined,
        down: async () => {
          throw new Error("'left' is already pressed.");
        },
        up: async () => {
          throw new Error("'left' is not pressed.");
        },
      },
    };
    await apply(page, { type: 'down', x: 1, y: 1 });
    await apply(page, { type: 'up', x: 1, y: 1 });
  });

  it('applies a batch to the page it was meant for, and stops when that page is swapped mid-batch', async () => {
    const fake = fakeSession();
    const object = new BrowserSession(fake.state, { BROWSER: {} });
    await object.adopt(fake.browser, 'a-session');
    object.token = 'tok';
    const first = fake.page;
    const seen = [];
    const second = { ...first, isClosed: () => false, mouse: { move: async () => seen.push('second'), down: async () => seen.push('second'), up: async () => seen.push('second') } };
    first.mouse = {
      move: async () => seen.push('first'),
      down: async () => {
        seen.push('first');
        // The hand-over lands between the press and the release.
        object.page = second;
      },
      up: async () => seen.push('first'),
    };
    const answer = await object
      .fetch(new Request('https://browser-session/input?session=tok', { method: 'POST', body: JSON.stringify([{ type: 'move', x: 1, y: 1 }, { type: 'down', x: 1, y: 1 }, { type: 'up', x: 1, y: 1 }]) }))
      .then((r) => r.json());
    assert.equal(answer.ok, true);
    assert.deepEqual(seen, ['first', 'first', 'first'], 'the release is not sent to the page that came, whose mouse never saw the press');
  });

  it("says why, on the closed status, when the browser at Browserless went while the pane was open", async () => {
    const { ENDED_AT_BROWSERLESS } = await import('../worker/browserSession.js');
    const fake = fakeSession();
    const object = new BrowserSession(fake.state, { BROWSER: {}, BROWSERLESS_TOKEN: 't' });
    let onDisconnected;
    fake.browser.on = (event, handler) => {
      if (event === 'disconnected') onDisconnected = handler;
    };
    await object.adopt(fake.browser, 'browserless:x');
    object.token = 'tok';
    assert.equal((await object.status(-1)).where, 'browserless');
    onDisconnected();
    const closed = await (await object.fetch(new Request('https://browser-session/frame?session=tok&after=-1'))).json();
    assert.equal(closed.open, false);
    assert.equal(closed.ended, ENDED_AT_BROWSERLESS);
    assert.match(closed.ended, /two minutes/);
    // Cloudflare's browser going says nothing of the kind; and the next open starts clean.
    const again = fakeSession();
    const object2 = new BrowserSession(again.state, { BROWSER: {}, BROWSERLESS_TOKEN: 't' });
    let gone;
    again.browser.on = (event, handler) => {
      if (event === 'disconnected') gone = handler;
    };
    await object2.adopt(again.browser, 'cf-session');
    object2.token = 'tok';
    gone();
    assert.equal((await object2.status(-1)).ended, undefined);
  });
});
