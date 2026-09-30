/**
 * The Colab tab, against stand-ins. Colab's own page cannot be framed, so
 * the tab opens it in the proxy's browser and shows its picture. Here the
 * proxy's browser is played by this script — the reader's /browse calls
 * are answered from a second Playwright page showing a stand-in for
 * Colab's notebook (scripts/fixtures/colab-standin.html), its screenshots
 * sent back as frames and the reader's input applied to it — and the
 * runtime is the same stand-in scripts/colab-run-smoke.mjs uses. So the
 * tab's own code runs for real: the strip, the pane, the frames, the
 * address, the input, the runtime attaching, and the card shown where
 * the proxy has no browser. Each state is photographed, dark and light.
 *
 *   npm run build && npm start &
 *   node scripts/colab-tab-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });
const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const EXPLANATION = await fixture('explain-attention.md');
const STANDIN = await fixture('colab-standin.html');

const TITLE = 'Compact Language Models via Pruning and Knowledge Distillation';
const W = 1440;
const H = 900;
const COLAB_SCOPE = 'https://www.googleapis.com/auth/colaboratory';

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// The stand-ins: a runtime (a Jupyter server), and Colab's page (an HTML file)
// ---------------------------------------------------------------------------

const server = createServer((request, response) => {
  if (request.url.startsWith('/colab')) {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(STANDIN);
    return;
  }
  response.end('runtime');
});
const kernels = new WebSocketServer({ server });
let kernelCount = 0;
const header = (type) => ({ msg_id: `k-${Math.random().toString(36).slice(2)}`, msg_type: type, session: 'kernel', username: 'kernel', version: '5.3', date: new Date().toISOString() });
const send = (socket, type, content, parent, channel = 'iopub') => socket.send(JSON.stringify({ header: header(type), parent_header: { msg_id: parent }, metadata: {}, content, channel, buffers: [] }));
kernels.on('connection', (socket) => {
  socket.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message?.header?.msg_type !== 'execute_request') return;
    const parent = message.header.msg_id;
    const code = String(message.content?.code ?? '');
    send(socket, 'status', { execution_state: 'busy' }, parent);
    const line = code.startsWith('import json, os, shutil, subprocess, time') ? '{"gpu": "Tesla T4, 3, 412, 15360", "cpu": 6, "cpus": 2, "ram": [1900, 13012], "disk": [71, 78]}' : 'ok';
    send(socket, 'stream', { name: 'stdout', text: `${line}\n` }, parent);
    send(socket, 'execute_reply', { status: 'ok', execution_count: 1 }, parent, 'shell');
    send(socket, 'status', { execution_state: 'idle' }, parent);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;
const RUNTIME_URL = `http://127.0.0.1:${PORT}/`;
/** What Colab's addresses stand for here: the front page, the sign-in in front of a notebook, the notebook attached. */
const standInFor = (url) => (/\/tun\/m\//.test(url) || /datalabBackendUrl/.test(url) ? `http://127.0.0.1:${PORT}/colab?signin=1` : /attached=1/.test(url) ? url : `http://127.0.0.1:${PORT}/colab`);
console.log(`stand-in runtime and Colab page at ${RUNTIME_URL}`);

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

function sse(text, size = 600) {
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const body = [];
  body.push(event('message_start', { type: 'message_start', message: { id: 'msg_smoke', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9000, output_tokens: 1 } } }));
  body.push(event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  for (let i = 0; i < text.length; i += size) body.push(event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + size) } }));
  body.push(event('content_block_stop', { type: 'content_block_stop', index: 0 }));
  body.push(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9000 } }));
  body.push(event('message_stop', { type: 'message_stop' }));
  return body;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

console.log('\n== print a paper ==');
const printer = await browser.newPage();
const para =
  'Large language models targeting different deployment scales and sizes are currently produced by training each variant from scratch; this is extremely compute-intensive. We investigate whether pruning an existing LLM and then re-training it with a fraction of the original training data can be a suitable alternative. ';
const section = (n, name) => `<section style="break-after: page"><h2>${n}. ${name}</h2>${`<p>${para.repeat(3)}</p>`.repeat(5)}</section>`;
await printer.setContent(
  `<!doctype html><html><body style="font-family: serif; font-size: 11pt; margin: 0.8in">
    <h1 style="text-align:center">${TITLE}</h1>
    <p style="text-align:center">Saurav Muralidharan, Sharath Turuvekere Sreenivas, Raviraj Joshi, Marcin Chochowski, Mostofa Patwary, Mohammad Shoeybi, Bryan Catanzaro, Jan Kautz, Pavlo Molchanov</p>
    <h3>Abstract</h3><p>${para.repeat(2)}</p>
    ${section(1, 'Introduction')}${section(2, 'Pruning Methodology')}${section(3, 'Retraining')}${section(4, 'Experiments and Analysis')}
  </body></html>`,
);
const PDF = await printer.pdf({ format: 'Letter', printBackground: true });
await printer.close();

// The proxy's browser, played here: a page of Colab's size, driven by the reader's input, photographed for its frames.
const driven = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let browsing = { open: false, url: '', seq: 0, loading: false };
let browserAvailable = true;
const frameOf = async () => (await driven.screenshot({ type: 'jpeg', quality: 70 })).toString('base64');
/** Where the driven page is, as Colab's addresses: the sign-in is Google's, the rest Colab's. */
const reportedUrl = () => {
  const at = driven.url();
  if (/signin=1/.test(at)) return 'https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fcolab.research.google.com%2F&service=colab';
  if (/attached=1/.test(at)) return 'https://colab.research.google.com/notebooks/standin?attached=1';
  return 'https://colab.research.google.com/';
};
const browseStatus = async (withFrame) => ({
  available: browserAvailable,
  where: 'proxy',
  open: browsing.open,
  url: browsing.open ? reportedUrl() : undefined,
  title: browsing.open ? await driven.title() : undefined,
  seq: browsing.seq,
  width: 1280,
  height: 800,
  loading: browsing.loading,
  frame: withFrame && browsing.open ? await frameOf() : undefined,
  persistent: true,
  pdf: null,
  ...(browserAvailable ? {} : { reason: 'Playwright is installed on the proxy but its Chromium is not. Run `npx playwright install chromium` there, or set READER_BROWSER_CHANNEL=chrome to use the Chrome you already have.' }),
});
const inputs = [];
async function applyInput(events) {
  for (const event of events) {
    inputs.push(event.type);
    if (event.type === 'move') await driven.mouse.move(event.x, event.y);
    else if (event.type === 'down') await driven.mouse.down({ button: event.button || 'left', clickCount: event.clickCount || 1 });
    else if (event.type === 'up') await driven.mouse.up({ button: event.button || 'left', clickCount: event.clickCount || 1 });
    else if (event.type === 'wheel') await driven.mouse.wheel(event.dx, event.dy);
    else if (event.type === 'keydown') await driven.keyboard.down(event.key);
    else if (event.type === 'keyup') await driven.keyboard.up(event.key);
    else if (event.type === 'insert') await driven.keyboard.insertText(event.text);
    else if (event.type === 'navigate') await driven.goto(standInFor(event.url)).catch(() => undefined);
    else if (event.type === 'reload') await driven.reload().catch(() => undefined);
  }
  await driven.waitForLoadState('domcontentloaded').catch(() => undefined);
  browsing.seq += 1;
}

const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
await context.route('**/pdf?*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }));
for (const host of ['api.crossref.org', 'api.semanticscholar.org', 'dblp.org', 'wikidata.org', 'api.openalex.org']) {
  await context.route(`**/${host}/**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[],"data":[],"message":{"items":[]},"result":{"hits":{}}}' }));
}
await context.route('**/scholar/search*', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      results: [{ id: '3001', clusterId: '3001', title: TITLE, url: 'https://arxiv.org/abs/2407.14679', pdfUrl: 'https://example.org/minitron.pdf', authors: ['S Muralidharan', 'ST Sreenivas', 'R Joshi', 'M Chochowski'], year: 2024, snippet: 'We investigate whether pruning an existing LLM and then re-training it can be a suitable alternative.' }],
    }),
  }),
);
await context.route('**/scholar/{authors,person,paper-authors,cluster}*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[]}' }));
// The proxy's Colab routes, answered here: one runtime on a T4.
await context.route('**/api/colab/**', (route) => {
  const url = new URL(route.request().url());
  const path = url.pathname.replace(/^.*\/api\/colab/, '/colab');
  const method = route.request().method();
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (!route.request().headers()['x-google-token']) return json({ error: 'no token' }, 401);
  if (path === '/colab/runtimes' && method === 'POST') return json({ runtime: { endpoint: 'm-s-1a2b3c4d5e6f', accelerator: 'T4', highMem: false, proxy: { url: RUNTIME_URL, token: 'proxy-token', expiresAt: Date.now() + 3_600_000 } } });
  if (path === '/colab/runtimes/stop') return json({ ok: true });
  if (path === '/colab/units') return json({ balance: 0 });
  if (path === '/colab/kernels/list') return json({ kernels: Array.from({ length: kernelCount }, (_, i) => ({ id: `kernel-${i + 1}` })) });
  if (path === '/colab/kernels' && method === 'POST') {
    kernelCount += 1;
    return json({ kernel: { id: `kernel-${kernelCount}` } });
  }
  if (path === '/colab/kernels/interrupt' || path === '/colab/kernels/restart') return json({ ok: true });
  return json({ error: `unexpected ${method} ${path}` }, 500);
});
// The proxy's browser routes, answered from the driven page.
const opened = [];
await context.route('**/api/browse/**', async (route) => {
  const url = new URL(route.request().url());
  const path = url.pathname.replace(/^.*\/api\/browse/, '/browse');
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (path === '/browse/status') return json(await browseStatus(false));
  if (path === '/browse/open') {
    const target = url.searchParams.get('url') || '';
    opened.push(target);
    browsing = { open: true, url: target, seq: browsing.seq + 1, loading: true };
    await driven.goto(standInFor(target)).catch(() => undefined);
    browsing.loading = false;
    browsing.seq += 1;
    return json(await browseStatus(true));
  }
  if (path === '/browse/frame') {
    const after = Number(url.searchParams.get('after') || -1);
    // Held until something is newer, up to a few seconds — as the proxy holds it — then a fresh picture either way.
    for (let waited = 0; waited < 2500 && browsing.seq <= after; waited += 100) await sleep(100);
    browsing.seq += 1;
    return json(await browseStatus(true));
  }
  if (path === '/browse/input') {
    const { events } = JSON.parse(route.request().postData() || '{"events":[]}');
    await applyInput(events);
    return json({ ok: true });
  }
  if (path === '/browse/close') {
    browsing = { ...browsing, open: false };
    return json({ ok: true });
  }
  if (path === '/browse/stream') return route.fulfill({ status: 404, body: 'no stream' });
  return json({ error: `unexpected ${path}` }, 500);
});

await context.addInitScript(
  ({ explanation, scope }) => {
    sessionStorage.setItem('reader.google.session', JSON.stringify({ accessToken: 'ya29.smoke', expiresAt: Date.now() + 3_600_000, scopes: ['openid', 'email', scope], user: { email: 'reader@example.org', name: 'Reader' } }));
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.startsWith('https://api.anthropic.com')) return real(input, init);
      const stream = new ReadableStream({
        async start(controller) {
          for (const event of explanation) controller.enqueue(new TextEncoder().encode(event));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_smoke' } });
    };
  },
  { explanation: sse(EXPLANATION), scope: COLAB_SCOPE },
);

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
process.on('uncaughtException', async (error) => {
  console.error(error);
  await page.screenshot({ path: `${OUT}/colab-tab-failed.png` }).catch(() => undefined);
  process.exit(2);
});

console.log('\n== open a paper ==');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  localStorage.setItem('reader.anthropic-key', 'sk-ant-smoke');
  localStorage.setItem('reader.explain.layout', 'margin');
  localStorage.setItem('reader.explain.page', 'explain');
  localStorage.setItem('reader.colab.machine', JSON.stringify({ accelerator: 'T4', highMem: false }));
  const saved = JSON.parse(localStorage.getItem('reader.settings') || '{}');
  localStorage.setItem('reader.settings', JSON.stringify({ ...saved, googleClientId: 'smoke-client-id.apps.googleusercontent.com', theme: 'dark', glass: false }));
});
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();
const chips = page.locator('.find-options .chip');
for (let index = 0; index < (await chips.count()); index += 1) {
  const chip = chips.nth(index);
  const wanted = /Scholar/.test((await chip.textContent()) || '');
  if (wanted !== ((await chip.getAttribute('aria-pressed')) === 'true')) await chip.click();
}
await page.getByLabel('Search for papers').fill('compact language models pruning distillation');
await page.getByLabel('Search for papers').press('Enter');
await page.locator('.find-row .find-title').first().waitFor({ timeout: 15000 });
await page.locator('.find-row .find-title').first().click();
await page.locator('.find-detail-actions').waitFor({ timeout: 5000 });
await page.locator('.find-detail-actions').getByRole('button', { name: /Save to/ }).click();
await page.waitForTimeout(400);
await page.locator('.find-detail-actions').getByRole('button', { name: /^(Read|Open)$/ }).click();
await page.locator('.segmented button', { hasText: 'Reflow' }).click({ timeout: 20000 });
await page.waitForSelector('.paper-body h2', { timeout: 30000 });
await page.waitForTimeout(500);

async function withSettings(patch) {
  await page.evaluate((next) => {
    const saved = JSON.parse(localStorage.getItem('reader.settings') || '{}');
    localStorage.setItem('reader.settings', JSON.stringify({ ...saved, ...next }));
  }, patch);
  await page.reload({ waitUntil: 'networkidle' });
  const notNow = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await page.waitForSelector('.explain', { timeout: 15000 });
  await page.waitForTimeout(600);
}

console.log('\n== E, then the Colab tab with no runtime ==');
await page.mouse.move(W / 2, H / 2);
await page.keyboard.press('e');
await page.waitForSelector('.explain .explain-empty');
await page.getByRole('button', { name: 'Explain this paper' }).click();
await page.waitForSelector('.explain-section h2', { timeout: 20000 });
await page.waitForFunction(() => !document.querySelector('.explain-writing'), null, { timeout: 30000 });
check('the bar has three pages', (await page.locator('.explain-pages button').allTextContents()).join('|') === 'Explanation|Implementation|Colab');
await page.getByRole('tab', { name: 'Colab' }).click();
await page.waitForSelector('.colab-page', { timeout: 10000 });
await page.waitForSelector('.colab-page .mini-browser-screen img', { timeout: 20000 });
await page.waitForTimeout(800);
check('the tab is remembered', (await page.evaluate(() => localStorage.getItem('reader.explain.page'))) === 'colab');
check('with no runtime it opens Colab’s front page in the proxy’s browser', opened[0] === 'https://colab.research.google.com/', opened[0]);
check('and says so', /No runtime yet/.test(await page.locator('.colab-page-head').textContent()));
check('the ask bar and the outline are put away', (await page.locator('.explain-ask').count()) === 0 && (await page.locator('.explain-outline').count()) === 0);
check('the address shows where the browser is', /colab\.research\.google\.com/.test(await page.locator('.browser-pane-url').textContent()));
await page.screenshot({ path: `${OUT}/colab-tab-1-front-dark.png` });

console.log('\n== a runtime starts; the tab attaches to it ==');
await page.locator('.colab-chip').click();
await page.waitForSelector('.colab-connect');
await page.locator('.colab-connect').getByRole('button', { name: /Connect and run|Connect/ }).click();
await page.waitForFunction(() => /T4 · idle/.test(document.querySelector('.colab-chip')?.textContent ?? ''), null, { timeout: 30000 });
await page.waitForFunction(() => /on your T4 runtime/.test(document.querySelector('.colab-page-head')?.textContent ?? ''), null, { timeout: 15000 });
await page.waitForSelector('.colab-page .mini-browser-screen img', { timeout: 20000 });
await page.waitForTimeout(1200);
check('the browser is sent to Colab’s notebook attached to the runtime', /colab\.research\.google\.com\/notebooks\/empty\.ipynb\?dbu=.*m-s-1a2b3c4d5e6f/.test(opened.at(-1) ?? ''), opened.at(-1));
check('the strip names the runtime', /T4 · m-s-1a2b3c4d5e6f/.test(await page.locator('.colab-page-runtime').textContent()));
check('Google’s sign-in is recognised, and the foot says what to do', /Google is asking you to sign in/.test(await page.locator('.colab-page-foot').textContent()));
await page.screenshot({ path: `${OUT}/colab-tab-2-signin-dark.png` });

console.log('\n== signing in inside the pane, then running a cell there ==');
const screen = page.locator('.colab-page .mini-browser-screen img');
const box = await screen.boundingBox();
// The stand-in sign-in's Next button, at the page's own coordinates (1280 × 800 → the picture's box).
const at = (x, y) => ({ x: box.x + (x / 1280) * box.width, y: box.y + (y / 800) * box.height });
const next = await driven.locator('.next').boundingBox();
await page.mouse.click(at(next.x + next.width / 2, next.y + next.height / 2).x, at(next.x + next.width / 2, next.y + next.height / 2).y);
await driven.waitForURL(/attached=1/, { timeout: 10000 });
await page.waitForFunction(() => /notebooks\/standin\?attached=1/.test(document.querySelector('.browser-pane-url')?.textContent ?? ''), null, { timeout: 15000 });
await page.waitForTimeout(1200);
check('a click in the pane lands on the page in the proxy’s browser', inputs.includes('down') && inputs.includes('up') && /attached=1/.test(driven.url()));
check('and the foot goes back to the general note once Google is done asking', !/Google is asking/.test(await page.locator('.colab-page-foot').textContent()));
const run = await driven.locator('#run1').boundingBox();
await page.mouse.click(at(run.x + run.width / 2, run.y + run.height / 2).x, at(run.x + run.width / 2, run.y + run.height / 2).y);
await driven.waitForFunction(() => /Tesla T4/.test(document.getElementById('out1')?.textContent ?? ''), null, { timeout: 5000 });
// The frame that shows the output is a poll away; a few seconds is enough for two.
await page.waitForTimeout(4000);
check('the cell ran in Colab’s page, and its output came back as a picture', /Tesla T4/.test(await driven.locator('#out1').textContent()));
await page.screenshot({ path: `${OUT}/colab-tab-3-notebook-dark.png` });
// Keys go too: the stand-in runs the cell on Shift-Enter.
await driven.evaluate(() => (document.getElementById('out1').textContent = ''));
await page.locator('.colab-page .mini-browser').focus();
await page.keyboard.press('Shift+Enter');
await driven.waitForFunction(() => /Tesla T4/.test(document.getElementById('out1')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => undefined);
check('keys pressed on the pane reach the page', inputs.includes('keydown') && /Tesla T4/.test(await driven.locator('#out1').textContent()));

console.log('\n== back to the explanation: the browser on the proxy is closed ==');
const before = browsing.open;
await page.getByRole('tab', { name: 'Explanation' }).click();
await page.waitForSelector('.explain-section h2', { timeout: 10000 });
await page.waitForTimeout(500);
check('leaving the tab closes the page on the proxy', before && !browsing.open);
check('the runtime stays', /T4 · idle/.test(await page.locator('.colab-chip').textContent()));

console.log('\n== in light, and where the proxy has no browser ==');
await withSettings({ theme: 'light' });
await page.getByRole('tab', { name: 'Colab' }).click();
await page.waitForSelector('.colab-page .mini-browser-screen img', { timeout: 20000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: `${OUT}/colab-tab-4-notebook-light.png` });
browserAvailable = false;
await page.getByRole('tab', { name: 'Explanation' }).click();
await page.waitForTimeout(300);
await page.getByRole('tab', { name: 'Colab' }).click();
await page.waitForSelector('.colab-page-card', { timeout: 10000 });
check('without a browser on the proxy, the tab says what it would show and what to set up', /needs the proxy's browser/.test(await page.locator('.colab-page-card h2').textContent()) && /npx playwright install chromium/.test(await page.locator('.colab-page-card').textContent()));
// After the reload the runtime is remembered but not reconnected, so the link is to Colab itself until it is.
check('and links Colab out', /open (this runtime in )?Colab/.test(await page.locator('.colab-page-card a').last().textContent()));
await page.screenshot({ path: `${OUT}/colab-tab-5-no-browser-light.png` });

check('no page errors', errors.length === 0, errors.join(' | '));
console.log(`\ninput sent: ${Array.from(new Set(inputs)).join(', ')}`);
console.log(`\n${problems.length ? `${problems.length} problem(s):\n  ${problems.join('\n  ')}` : 'all good'}\n`);
await browser.close();
kernels.close();
server.close();
process.exit(problems.length ? 1 : 0);
