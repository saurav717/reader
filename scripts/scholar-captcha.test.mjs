// Showing a Scholar captcha to a person: what the proxy says about whether it
// can, what it refuses to open a window on, and that a refusal carries the
// page the captcha is on. No browser is launched here — these are the
// decisions around the window, which are what can be wrong quietly.
//
//   node --test scripts/scholar-captcha.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// No profile on this machine, whatever the machine: nothing below may decide
// a captcha was once solved here and reach for a browser.
process.env.READER_SCHOLAR_PROFILE_DIR = join(tmpdir(), `reader-no-scholar-profile-${process.pid}`);
process.env.READER_PROFILE_DIR = join(tmpdir(), `reader-no-profile-${process.pid}`);
delete process.env.SCHOLAR_BROWSER;
const { default: apiRouter, setScholarFetcher } = await import('../server/api.js');
const { browserWanted, captchaStatus } = await import('../server/scholarBrowser.js');
const { forgetScholar } = await import('../server/scholar.js');

const here = dirname(fileURLToPath(import.meta.url));
const CAPTCHA = await readFile(join(here, 'fixtures', 'scholar-captcha.html'), 'utf8');

const server = createServer((req, res) => apiRouter(req, res));
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://localhost:${server.address().port}`;
after(() => server.close());

const SCHOLAR_PAGE = 'https://scholar.google.com/scholar?hl=en&q=attention';
const post = (path, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers });

describe('whether this proxy can show a captcha', () => {
  it('does not use a browser until asked to, or until a captcha has been solved on it', () => {
    assert.equal(browserWanted(), false);
  });

  it('answers with a boolean, no window open, and nothing solved', async () => {
    const answer = await captchaStatus();
    assert.equal(typeof answer.available, 'boolean');
    if (!answer.available) assert.match(answer.reason, /Playwright|Chromium|screen/);
    assert.equal(answer.window, 'closed');
    assert.equal(answer.solved, false);
    assert.equal(answer.browser, false);
  });

  it('says the same over the route the app polls', async () => {
    const response = await fetch(`${base}/scholar/captcha/status`);
    assert.equal(response.status, 200);
    const answer = await response.json();
    assert.equal(typeof answer.available, 'boolean');
    assert.equal(answer.window, 'closed');
  });
});

describe('a refusal, as the app sees it', () => {
  it('carries the page that was refused, which is the page the captcha is on', async () => {
    forgetScholar();
    setScholarFetcher(async () => ({ status: 200, html: CAPTCHA }));
    const response = await fetch(`${base}/scholar/search?q=attention`);
    assert.equal(response.status, 503);
    const answer = await response.json();
    assert.equal(answer.blocked, true);
    assert.equal(answer.reason, 'captcha');
    assert.match(answer.url, /^https:\/\/scholar\.google\.com\/scholar\?/);
    assert.equal(new URL(answer.url).searchParams.get('q'), 'attention');
  });
});

describe('what the window may be opened on', () => {
  it('only a Scholar page: anything else is refused before a browser is looked for', async () => {
    for (const target of ['https://example.com/', 'http://scholar.google.com/scholar?q=x', 'https://scholar.google.com.evil.example/', 'not a url', '']) {
      const response = await post(`/scholar/captcha?url=${encodeURIComponent(target)}`);
      assert.equal(response.status, 400, target);
      assert.match((await response.json()).error, /scholar\.google\.com/);
    }
  });

  it('only from this app: a page on another site cannot open windows on this machine', async () => {
    const response = await post(`/scholar/captcha?url=${encodeURIComponent(SCHOLAR_PAGE)}`, { Origin: 'https://elsewhere.example' });
    assert.equal(response.status, 403);
  });

  it('only by asking, never by following a link', async () => {
    const response = await fetch(`${base}/scholar/captcha?url=${encodeURIComponent(SCHOLAR_PAGE)}`);
    assert.equal(response.status, 405);
  });

  it('closing a window that is not open is nothing to complain about', async () => {
    const response = await post('/scholar/captcha/close');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).window, 'closed');
  });
});
