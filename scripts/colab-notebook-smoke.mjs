/**
 * The Colab tab — a notebook of the reader's own on the Colab runtime —
 * against a stand-in runtime: a paper is opened and explained from the
 * fixture, the tab opens the notebook seeded from the explanation's cells,
 * a cell is run in the stand-in kernel (the proxy's Colab routes are
 * answered here, the kernel is a WebSocket server in this script), cells
 * are added, typed into, made text, moved and deleted with the keys the
 * notebook takes, the runtime's disk is listed, the notebook is downloaded
 * as an .ipynb and survives a reload. Each state is photographed, dark and
 * light.
 *
 *   npm run build && npm start &
 *   node scripts/colab-notebook-smoke.mjs        # SMOKE_BASE=http://localhost:8080
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
// The stand-in runtime: a Jupyter kernel over a WebSocket, and a disk
// ---------------------------------------------------------------------------

const runtime = createServer((_request, response) => response.end('runtime'));
const kernels = new WebSocketServer({ server: runtime });
let kernelCount = 0;
let executionCount = 0;
const ran = [];
const probes = [];
/** The keep-alive frames the page sent while nothing else was going, by the time they came. */
const keepalives = [];
const header = (type) => ({ msg_id: `k-${Math.random().toString(36).slice(2)}`, msg_type: type, session: 'kernel', username: 'kernel', version: '5.3', date: new Date().toISOString() });
const send = (socket, type, content, parent, channel = 'iopub') => socket.send(JSON.stringify({ header: header(type), parent_header: { msg_id: parent }, metadata: {}, content, channel, buffers: [] }));

/** Whether a cell is running, so the probe's numbers rise while one does. */
let busySince = 0;
/** Set by the interrupt route; the running cell ends with a KeyboardInterrupt at its next line, as a kernel's would. */
let interruptAsked = false;
function probeLine() {
  const t = busySince ? (Date.now() - busySince) / 1000 : 0;
  const busy = busySince ? Math.min(1, t / 3) : 0;
  const wave = 0.5 + 0.5 * Math.sin(t / 1.3);
  return JSON.stringify({ gpu: `Tesla T4, ${Math.round(busy * (58 + 34 * wave))}, ${Math.round(412 + busy * (9600 + 700 * wave))}, 15360`, cpu: Math.round(6 + busy * (30 + 22 * (1 - wave))), cpus: 2, ram: [Math.round(1900 + busy * 3200), 13012], disk: [71, 78] });
}
/** What a cell prints, for the code the page sent. */
function answer(code) {
  if (code.startsWith('import json, os, shutil, subprocess, time')) return { lines: [probeLine()], probe: true };
  if (/time\.sleep/.test(code)) return { lines: Array.from({ length: 6 }, (_, i) => `step ${i}  loss=${(2.4 * Math.exp(-i / 2) + 0.5).toFixed(3)}`), every: 1300 };
  if (/import numpy as np/.test(code) && /attention weights \(rows sum to 1\)/.test(code)) return { lines: ['attention weights (rows sum to 1):', '    the [0.6 0.1 0.2 0.1]', '    cat [0.02 0.89 0.04 0.05]', '    sat [0.15 0.2  0.56 0.1 ]', '   down [0.08 0.3  0.11 0.51]', 'output shape: (4, 8)'] };
  const printed = [...code.matchAll(/^print\((["'])(.*?)\1\)$/gm)].map((m) => m[2]);
  if (printed.length) return { lines: printed };
  if (/^\s*$/.test(code)) return { lines: [] };
  return { lines: ['ok'] };
}
kernels.on('connection', (socket) => {
  socket.on('message', async (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message?.header?.msg_type === 'kernel_info_request') {
      keepalives.push(Date.now());
      send(socket, 'kernel_info_reply', { status: 'ok', protocol_version: '5.3', implementation: 'stand-in' }, message.header.msg_id, 'shell');
      return;
    }
    if (message?.header?.msg_type !== 'execute_request') return;
    const parent = message.header.msg_id;
    const code = String(message.content?.code ?? '');
    const { lines, probe, every = 30 } = answer(code);
    if (probe) probes.push(Date.now());
    else {
      ran.push(code);
      busySince = Date.now();
    }
    send(socket, 'status', { execution_state: 'busy' }, parent);
    let cut = false;
    if (!probe) interruptAsked = false;
    for (const line of lines) {
      if (!probe && interruptAsked) {
        cut = true;
        break;
      }
      send(socket, 'stream', { name: 'stdout', text: `${line}\n` }, parent);
      await sleep(every);
    }
    if (!probe) {
      executionCount += 1;
      busySince = 0;
      interruptAsked = false;
    }
    if (cut) {
      send(socket, 'error', { ename: 'KeyboardInterrupt', evalue: '', traceback: ['KeyboardInterrupt'] }, parent);
      send(socket, 'execute_reply', { status: 'error', ename: 'KeyboardInterrupt', evalue: '', traceback: ['KeyboardInterrupt'], execution_count: executionCount }, parent, 'shell');
    } else send(socket, 'execute_reply', { status: 'ok', execution_count: probe ? undefined : executionCount }, parent, 'shell');
    send(socket, 'status', { execution_state: 'idle' }, parent);
  });
});
await new Promise((resolve) => runtime.listen(0, '127.0.0.1', resolve));
const RUNTIME_URL = `http://127.0.0.1:${runtime.address().port}/`;
/** The runtime's disk, as the contents API would list it. */
const DISK = {
  '': [
    { name: 'data', path: 'data', type: 'directory', size: null, modified: null },
    { name: 'models', path: 'models', type: 'directory', size: null, modified: null },
    { name: 'minitron', path: 'minitron', type: 'directory', size: null, modified: null },
    { name: 'sample_data', path: 'sample_data', type: 'directory', size: null, modified: null },
    { name: 'Makefile', path: 'Makefile', type: 'file', size: 1180, modified: '2026-09-30T11:02:00Z' },
    { name: 'PLAN.md', path: 'PLAN.md', type: 'file', size: 48211, modified: '2026-09-30T11:02:00Z' },
    { name: 'train.log', path: 'train.log', type: 'file', size: 913402, modified: '2026-09-30T11:40:00Z' },
  ],
  data: [{ name: 'fineweb_edu_1b.bin', path: 'data/fineweb_edu_1b.bin', type: 'file', size: 2_147_483_648, modified: '2026-09-30T11:10:00Z' }],
  models: [{ name: 'teacher', path: 'models/teacher', type: 'directory', size: null, modified: null }, { name: 'pruned_0.8b', path: 'models/pruned_0.8b', type: 'directory', size: null, modified: null }],
};
console.log(`stand-in runtime at ${RUNTIME_URL}`);

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
// The proxy's Colab routes, answered here: one runtime on a T4, and its disk.
const contentsAsked = [];
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
  if (path === '/colab/kernels/interrupt') {
    interruptAsked = true;
    return json({ ok: true });
  }
  if (path === '/colab/kernels/restart') return json({ ok: true });
  if (path === '/colab/contents') {
    const { path: dir } = JSON.parse(route.request().postData() || '{}');
    contentsAsked.push(dir);
    return json({ path: dir, entries: DISK[dir] ?? [] });
  }
  return json({ error: `unexpected ${method} ${path}` }, 500);
});
await context.addInitScript(
  ({ explanation, scope }) => {
    sessionStorage.setItem('reader.google.session', JSON.stringify({ accessToken: 'ya29.smoke', expiresAt: Date.now() + 3_600_000, scopes: ['openid', 'email', scope], user: { email: 'reader@example.org', name: 'Reader' } }));
    const real = window.fetch.bind(window);
    // Every request to the model, kept for the checks; a request from the notebook's bar is answered with what the test set in window.__nbReply.
    window.__requests = [];
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.startsWith('https://api.anthropic.com')) return real(input, init);
      const body = typeof init?.body === 'string' ? init.body : '';
      window.__requests.push(body);
      const sseOf = (text) => {
        const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
        return [
          event('message_start', { type: 'message_start', message: { id: 'msg_cell', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 1 } } }),
          event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
          event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
          event('content_block_stop', { type: 'content_block_stop', index: 0 }),
          event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 90 } }),
          event('message_stop', { type: 'message_stop' }),
        ];
      };
      const cellAsked = body.match(/Rewrite cell (\d+) in place/);
      const forNotebook = /writing cells for a Jupyter notebook/.test(body) && (cellAsked ? sseOf(`Cell ${cellAsked[1]} again.\n\n\`\`\`python cell=${cellAsked[1]}\n# rewritten by the stand-in\nprint("cell ${cellAsked[1]} rewritten")\n\`\`\``) : window.__nbReply);
      const events = forNotebook || explanation;
      const stream = new ReadableStream({
        async start(controller) {
          for (const event of events) controller.enqueue(new TextEncoder().encode(event));
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
  await page.screenshot({ path: `${OUT}/colab-notebook-failed.png` }).catch(() => undefined);
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

console.log('\n== E, then the Colab tab: the notebook, seeded from the explanation ==');
await page.mouse.move(W / 2, H / 2);
await page.keyboard.press('e');
await page.waitForSelector('.explain .explain-empty');
await page.getByRole('button', { name: 'Explain this paper' }).click();
await page.waitForSelector('.explain-section h2', { timeout: 20000 });
await page.waitForFunction(() => !document.querySelector('.explain-writing'), null, { timeout: 30000 });
await page.getByRole('tab', { name: 'Colab' }).click();
await page.waitForSelector('.nb-cell', { timeout: 15000 });
const cells = page.locator('.nb-cell');
const codeCells = page.locator('.nb-cell.is-code');
check('the notebook is seeded from the explanation: its text as text cells, its four cells as code', (await codeCells.count()) === 4 && (await cells.count()) > 8, `${await codeCells.count()} code of ${await cells.count()}`);
check('the text cells are rendered', (await page.locator('.nb-cell.is-markdown .nb-markdown h4').count()) === 1 && (await page.locator('.nb-cell.is-markdown .nb-markdown h5').count()) >= 6, `the page's Markdown sets # as h4 and ## as h5: h4 ${await page.locator('.nb-markdown h4').count()}, h5 ${await page.locator('.nb-markdown h5').count()}`);
check('no cell has run', (await page.locator('.nb-cell .cell-output').count()) === 0);
check('the page’s ask bar and the outline are put away; the notebook has a bar of its own', (await page.locator('.explain-ask:not(.nb-ask)').count()) === 0 && (await page.locator('.explain-outline').count()) === 0 && (await page.locator('.nb-ask input').count()) === 1);
await page.screenshot({ path: `${OUT}/colab-notebook-1-seeded-dark.png` });

console.log('\n== every cell is editable: a seeded code cell, typed into ==');
const seededCode = codeCells.first();
const seededArea = seededCode.locator('.nb-text');
const seededBefore = await seededArea.inputValue();
await seededArea.click();
await page.keyboard.press('Control+End');
await page.keyboard.type('\n# a line of my own');
await page.waitForTimeout(300);
check('typing into a seeded code cell changes it, and the colouring follows', (await seededArea.inputValue()) === `${seededBefore}\n# a line of my own` && /a line of my own/.test(await seededCode.locator('.nb-shadow').textContent()));
await seededArea.press('Control+z').catch(() => undefined);
await seededArea.fill(seededBefore);
await page.waitForTimeout(200);
check('and it can be put back', (await seededArea.inputValue()) === seededBefore);
await page.keyboard.press('Escape');
const textCell = page.locator('.nb-cell.is-markdown').nth(1);
await textCell.hover();
await textCell.locator('.nb-tools button', { hasText: 'Edit' }).click();
await page.waitForTimeout(200);
check('Edit in a text cell’s tools opens its editor, with the caret at the end', (await textCell.locator('.nb-text').count()) === 1 && (await textCell.evaluate((el) => el.contains(document.activeElement))));
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await seededCode.hover();
await seededCode.locator('.nb-tools button', { hasText: 'Edit' }).click();
await page.waitForTimeout(200);
check('and in a code cell’s, it puts the caret in the code', await seededCode.evaluate((el) => el.contains(document.activeElement) && document.activeElement.classList.contains('nb-text')));
await page.keyboard.press('Escape');
await page.locator('.nb-cells').click({ position: { x: 4, y: 4 } });

console.log('\n== a cell runs in the runtime ==');
const first = codeCells.first();
await first.scrollIntoViewIfNeeded();
await first.locator('.nb-run').click();
await page.waitForSelector('.nb-cell.is-ran', { timeout: 30000 });
await page.waitForTimeout(800);
check('the first code cell ran in the stand-in kernel, and printed what it prints', /attention weights \(rows sum to 1\)/.test(await first.locator('.cell-output').textContent()));
check('the gutter counts it', (await first.locator('.nb-count').textContent()) === '[1]');
check('the chip in the bar holds the runtime', /T4 · idle/.test(await page.locator('.colab-chip').textContent()));
check('exactly the cell’s code went to the kernel', ran[0] === (await first.locator('.nb-text').inputValue()));

console.log('\n== the Runtime pane opens with the runtime ==');
await page.waitForSelector('.nb-side .rt-pane', { timeout: 10000 });
const pane = page.locator('.nb-side');
check('the pane opened on its own when the runtime connected, on its Runtime tab', (await pane.locator('[role="tab"][aria-selected="true"]').textContent()) === 'Runtime');
check('the notebook keeps to the left of it', (await first.boundingBox()).x < 120, `x ${(await first.boundingBox()).x}`);
await page.waitForFunction(() => /Tesla T4/.test(document.querySelector('.rt-head')?.textContent ?? ''), null, { timeout: 10000 });
check('it says what the machine is', /Tesla T4/.test(await pane.locator('.rt-head b').textContent()) && /2 CPUs/.test(await pane.locator('.rt-head').textContent()));
const tiles = await pane.locator('.rt-tile').allTextContents();
check('four tiles — GPU, VRAM, CPU, RAM — with numbers, and the disk as a meter', tiles.length === 4 && /GPU\d+%/.test(tiles[0]) && /VRAM[\d.]+of 15 GB/.test(tiles[1]) && /CPU\d+%/.test(tiles[2]) && /RAM[\d.]+of 13 GB/.test(tiles[3]) && /71 GB.*free of 78/.test(await pane.locator('.rt-meter').first().textContent()), tiles.map((m) => m.replace(/\s+/g, ' ')).join(' | '));
check('the session limit counts against the T4’s twelve hours', /left of 12 h/.test(await pane.locator('.rt-limits').textContent()));
check('the pulse is live by default', (await pane.locator('.rt-pulse-pick [aria-checked="true"]').textContent()) === 'Live · 2 s' && /live, every 2 s/.test(await pane.locator('.rt-part-label').first().textContent()));
const samplesAt = () => page.evaluate(() => document.querySelectorAll('.rt-strip').length ? Array.from(document.querySelectorAll('.rt-strip')).map((s) => Array.from(s.querySelectorAll('i')).filter((i) => i.style.background).length) : null);
const readsBefore = probes.length;
await page.waitForTimeout(5200);
check('with nothing running the machine is still read, every two seconds', probes.length - readsBefore >= 2, `${probes.length - readsBefore} reads in 5 s`);
check('the pane opens on Tiles, with the value large and its last minute under it', (await pane.locator('.rt-styles [aria-checked="true"]').textContent()) === 'Tiles' && (await pane.locator('.rt-tile').count()) === 4 && (await pane.locator('.rt-tile .rt-spark path').count()) >= 2);
check('and the heat strips fill as it is read', (await samplesAt())?.some((n) => n >= 1) === true, JSON.stringify(await samplesAt()));
await page.locator('.nb-cells').evaluate((el) => (el.scrollTop = 0));
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/colab-notebook-2-ran-dark.png` });

console.log('\n== the runtime drops the sockets, and the page opens them again ==');
// The kernel's socket and the monitor's, closed from the runtime's side the way an idle tunnel closes one: nothing has ended.
const socketsBefore = kernels.clients.size;
const probesAtDrop = probes.length;
for (const socket of kernels.clients) socket.close(1001, 'idle');
const saidReconnecting = await page.waitForFunction(() => /reconnecting/.test(document.querySelector('.colab-chip')?.textContent ?? ''), null, { timeout: 4000 }).then(() => true).catch(() => false);
check('the chip says reconnecting for the moment it takes', saidReconnecting);
await page.waitForFunction(() => /T4 · idle/.test(document.querySelector('.colab-chip')?.textContent ?? ''), null, { timeout: 15000 });
await page.waitForTimeout(2500);
check('the two sockets — the kernel’s and the monitor’s — are back, to the same kernels, and the runtime is not reported as ended', socketsBefore === 2 && kernels.clients.size === 2 && kernelCount === 2 && !/runtime ended/.test(await page.locator('.colab-chip').textContent()), `${socketsBefore} before, ${kernels.clients.size} after, ${kernelCount} kernels started`);
check('the pane stayed with the runtime, and the reads went on', (await page.locator('.nb-side .rt-pane .rt-head').count()) === 1 && probes.length > probesAtDrop);
check('the cell keeps its run', (await first.locator('.nb-count').textContent()) === '[1]');

console.log('\n== a slow cell, watched on the timeline ==');
await page.locator('.nb-add').click();
await page.waitForTimeout(200);
await page.locator('.nb-cell.is-selected .nb-text').click();
await page.keyboard.type('import time\nfor step in range(6):\n    time.sleep(1)');
await page.keyboard.press('Control+Enter');
await page.waitForSelector('.nb-cell.is-running', { timeout: 10000 });
await page.waitForFunction(() => /running/.test(document.querySelector('.rt-state')?.textContent ?? ''), null, { timeout: 20000 });
await page.waitForTimeout(3500);
const gpuTile = async () => Number((await pane.locator('.rt-tile').first().locator('.rt-tile-n').textContent()).match(/(\d+)/)?.[1]);
check('while it runs the pane says which cell, and the GPU tile rises', /running cell \d+/.test(await pane.locator('.rt-state').textContent()) && (await gpuTile()) > 30, (await pane.locator('.rt-state').textContent()) + ' / ' + (await gpuTile()));
check('and the ruler marks the runs, the live one in orange', (await pane.locator('.rt-ruler-run').count()) >= 2 && (await pane.locator('.rt-ruler-run.is-running').count()) === 1);
check('the strips end with each resource’s peak', /peak \d+%/.test(await pane.locator('.rt-strip-peak').first().textContent()));
await page.locator('.nb-cell.is-running').scrollIntoViewIfNeeded();
await page.screenshot({ path: `${OUT}/colab-notebook-6-runtime-live-dark.png` });
// The other two looks, while it still runs.
await pane.getByRole('radio', { name: 'Meters' }).click();
await page.waitForTimeout(2500);
check('Meters: five bars and the two line charts with the ruler', (await pane.locator('.rt-meter').count()) === 5 && (await pane.locator('.rt-timeline .cell-chart').count()) === 2 && (await pane.locator('.rt-timeline .rt-ruler').count()) === 1);
await page.screenshot({ path: `${OUT}/colab-notebook-7-meters-dark.png` });
await pane.getByRole('radio', { name: 'Rings' }).click();
await page.waitForTimeout(2500);
check('Rings: three dials, memory as a budget, and the cells’ peaks', (await pane.locator('.rt-ring').count()) === 3 && (await pane.locator('.rt-budget').count()) === 2 && (await pane.locator('.rt-peak').count()) >= 1);
await page.screenshot({ path: `${OUT}/colab-notebook-8-rings-dark.png` });
check('the look is remembered', (await page.evaluate(() => localStorage.getItem('reader.colab.pane-style'))) === 'rings');
await pane.getByRole('radio', { name: 'Tiles' }).click();
await page.waitForTimeout(300);
await page.waitForSelector('.nb-cell.is-running', { state: 'detached', timeout: 30000 });
await page.waitForTimeout(600);
check('the loss curve is under the cell, as under a page cell', (await page.locator('.nb-cell.is-ran .cell-chart').count()) >= 1);
await pane.locator('.rt-ruler-run').first().click();
await page.waitForTimeout(600);
check('a segment of the ruler goes to its cell', (await page.locator('.nb-cell.is-selected').count()) === 1 && /attention weights/.test(await page.locator('.nb-cell.is-selected').textContent()));

console.log('\n== Run stays in reach on a long cell ==');
// The first code cell is a long one: scrolled so that its top is well above the fold, its Run button is still on screen, stuck to the top.
const longCell = page.locator('.nb-cell.is-code').first();
await longCell.evaluate((el) => {
  const scroller = el.closest('.nb-cells');
  scroller.scrollTop = el.offsetTop - scroller.offsetTop + 160;
});
await page.waitForTimeout(300);
const runBox = await longCell.locator('.nb-run').boundingBox();
const scrollerBox = await page.locator('.nb-cells').boundingBox();
const cellBox = await longCell.boundingBox();
check('the gutter with Run sticks to the top of the notebook while a long cell scrolls', cellBox.y < scrollerBox.y - 100 && runBox.y >= scrollerBox.y && runBox.y < scrollerBox.y + 40, `cell top ${Math.round(cellBox.y)}, run ${Math.round(runBox.y)}, scroller ${Math.round(scrollerBox.y)}`);
await page.screenshot({ path: `${OUT}/colab-notebook-15-sticky-run-dark.png` });
await page.locator('.nb-cells').evaluate((el) => (el.scrollTop = 0));

console.log('\n== the Metrics tab: what the cells print as they train ==');
await pane.getByRole('tab', { name: 'Metrics' }).click();
await page.waitForSelector('.rt-metrics .cell-chart', { timeout: 10000 });
const metricLabels = await pane.locator('.rt-metric .rt-part-label').allTextContents();
check('the loss the slow cell printed is a chart, a line for that cell, with its last value', metricLabels.length === 1 && /^loss · cell \d+ 0\.\d+/.test(metricLabels[0].replace(/\s+/g, ' ').trim()), metricLabels.join(' | '));
check('the chart is by step, and a button goes to the cell', /step/.test(await pane.locator('.rt-metrics .cell-chart svg .axis').textContent()) && (await pane.locator('.rt-metric-cells-go .rt-peak').count()) === 1);
check('and it says how to reach TensorBoard itself', /%tensorboard/.test(await pane.locator('.rt-metric-note').textContent()) && (await pane.locator('.rt-metric-note a').count()) === 1);
await page.screenshot({ path: `${OUT}/colab-notebook-12-metrics-dark.png` });
await pane.getByRole('tab', { name: 'Runtime' }).click();
await page.waitForTimeout(300);

console.log('\n== typing a cell, and the keys ==');
// The + Code at the foot adds at the end; the toolbar's adds below the cell picked.
await page.locator('.nb-add').click();
await page.waitForTimeout(200);
let picked = page.locator('.nb-cell.is-selected');
check('+ Code adds a code cell at the end and picks it', (await picked.count()) === 1 && (await picked.locator('.nb-text').inputValue()) === '' && (await picked.evaluate((el) => !el.nextElementSibling?.classList?.contains('nb-cell'))));
await picked.locator('.nb-text').click();
await page.keyboard.type('x = 6 * 7\nprint("the answer is 42")');
await page.keyboard.press('Shift+Enter');
await page.waitForFunction(() => document.querySelectorAll('.nb-cell.is-ran').length >= 2, null, { timeout: 30000 });
await page.waitForTimeout(600);
const typed = page.locator('.nb-cell', { hasText: 'the answer is 42' }).first();
check('Shift-Enter runs what was typed, and the output comes back', /the answer is 42/.test(await typed.locator('.cell-output').textContent()) && ran.some((code) => /x = 6 \* 7\nprint\("the answer is 42"\)/.test(code)));
picked = page.locator('.nb-cell.is-selected');
check('and moves on to a fresh cell below, in the editor', (await picked.count()) === 1 && (await picked.locator('.nb-text').inputValue()) === '' && (await picked.evaluate((el) => el.contains(document.activeElement))), `selected ${await picked.count()}, value ${JSON.stringify(await picked.locator('.nb-text').inputValue().catch(() => null))}, focused ${await picked.evaluate((el) => el.contains(document.activeElement)).catch(() => null)}, cells ${await page.locator('.nb-cell').count()}`);
await page.keyboard.type('## A note of my own\n\nThe *weights* row sums to one.');
await picked.locator('.nb-tools button', { hasText: 'Text' }).click();
await page.waitForTimeout(200);
check('the tools make it a text cell, rendered', (await page.locator('.nb-cell.is-markdown .nb-markdown h5', { hasText: 'A note of my own' }).count()) === 1);
const note = page.locator('.nb-cell.is-markdown', { hasText: 'A note of my own' });
await note.click();
await page.keyboard.press('Escape');
await note.click();
await page.keyboard.press('a');
await page.waitForTimeout(200);
check('A adds a cell above the one picked', (await page.locator('.nb-cell').count()) > 0 && (await note.evaluate((el) => el.previousElementSibling?.classList.contains('is-selected'))));
await page.keyboard.press('d');
await page.keyboard.press('d');
await page.waitForTimeout(200);
check('D D deletes it', !(await note.evaluate((el) => el.previousElementSibling?.classList.contains('is-code') && !el.previousElementSibling.textContent.trim())));

console.log('\n== every cell says whether it ran ==');
check('a cell that ran carries a green mark in its gutter, with the time', (await typed.locator('.nb-ran.is-ran').count()) === 1 && /^ran \d/.test(await typed.locator('.nb-ran').getAttribute('title')), await typed.locator('.nb-ran').getAttribute('title'));
check('a cell never run carries an empty one, and a text cell none', (await page.locator('.nb-cell.is-code .nb-ran.is-never').count()) >= 1 && (await page.locator('.nb-cell.is-markdown .nb-ran').count()) === 0);
await typed.hover();
await page.waitForTimeout(200);
check('the tools name it on hover', /^ran \d/.test(await typed.locator('.nb-tools-state').textContent()));
await typed.locator('.nb-text').click();
await page.keyboard.press('Control+End');
await page.keyboard.type('\n# edited since');
await page.waitForTimeout(300);
check('an edit since it ran turns the mark amber: changed since it ran', (await typed.locator('.nb-ran.is-changed').count()) === 1 && (await typed.locator('.nb-tools-state').textContent()) === 'changed since it ran');
await page.keyboard.press('Escape');
await note.scrollIntoViewIfNeeded();
await page.screenshot({ path: `${OUT}/colab-notebook-3-typed-dark.png` });

console.log('\n== the ask bar writes cells ==');
const bar = page.locator('.nb-ask');
const askInput = bar.locator('input');
check('the bar is under the toolbar, and says who writes', /^Ask Claude to write/.test(await askInput.getAttribute('placeholder')), await askInput.getAttribute('placeholder'));
const firstCode = page.locator('.nb-cell.is-code').first();
await firstCode.scrollIntoViewIfNeeded();
await firstCode.locator('.nb-count').click();
await page.waitForTimeout(200);
const chip = await bar.locator('.ask-chip').first().textContent();
const n = Number(chip.match(/cell (\d+)/)?.[1]);
check('picking a cell puts it on the bar as what the request is about', Number.isInteger(n) && n > 1, chip);
await askInput.focus();
await page.waitForTimeout(250);
const suggestions = await bar.locator('.ask-suggestion').allTextContents();
check('and the suggestions are about that cell', suggestions.includes(`Rewrite cell ${n} in PyTorch, on the GPU`) && suggestions.includes(`Fix the error in cell ${n}`), suggestions.join(' | '));
await page.screenshot({ path: `${OUT}/colab-notebook-9-ask-suggestions-dark.png` });
const cellsBeforeAsk = await page.locator('.nb-cell').count();
await page.evaluate(
  (events) => {
    window.__nbReply = events;
  },
  sse(`Cell ${n} again, seeded, and a timing cell after it.\n\n\`\`\`python cell=${n}\nimport numpy as np\nnp.random.seed(0)\nprint("attention weights (rows sum to 1):")\nprint(np.ones((2, 2)) / 2)\n\`\`\`\n\n\`\`\`python after=${n}\nimport time\nt = time.perf_counter()\nprint("forward pass in", round((time.perf_counter() - t) * 1000, 2), "ms")\n\`\`\``),
);
await askInput.fill('Seed it, and add a cell after it that times a forward pass');
await page.keyboard.press('Enter');
await page.waitForSelector('.nb-ask .ask-status.is-done', { timeout: 20000 });
await page.waitForTimeout(400);
const asked = await page.evaluate(() => window.__requests.at(-1));
check('the request carried the notebook, numbered, with what ran, and which cell it is about', /writing cells for a Jupyter notebook/.test(asked) && new RegExp(`### Cell ${n} \\(code, ran\\)`).test(asked) && /attention weights/.test(asked) && new RegExp(`The request is about cell ${n}\\.`).test(asked) && /<explanation>/.test(asked));
check('the note under the bar says what was done, and how many cells', /Cell \d+ again, seeded, and a timing cell after it\. · 2 cells/.test(await bar.locator('.ask-status.is-done .ask-note').textContent()), await bar.locator('.ask-status.is-done .ask-note').textContent());
const rewritten = page.locator('.nb-cell').nth(n - 1);
const added = page.locator('.nb-cell').nth(n);
check('the cell asked about is rewritten in place, and marked', /np\.random\.seed\(0\)/.test(await rewritten.locator('.nb-text').inputValue()) && (await rewritten.locator('.nb-fresh').textContent()) === 'Rewritten at your request');
check('the new cell is right after it, marked as new, and picked', (await page.locator('.nb-cell').count()) === cellsBeforeAsk + 1 && /perf_counter/.test(await added.locator('.nb-text').inputValue()) && (await added.locator('.nb-fresh').textContent()) === 'New · from the ask bar' && (await rewritten.evaluate((el) => el.classList.contains('is-selected'))));
await page.screenshot({ path: `${OUT}/colab-notebook-9-ask-dark.png` });
await bar.getByRole('button', { name: 'Run them' }).click();
await page.waitForFunction((count) => document.querySelectorAll('.nb-cell.is-fresh').length < count, 2, { timeout: 30000 });
await page.waitForSelector('.nb-cell.is-running', { state: 'detached', timeout: 30000 });
await page.waitForTimeout(500);
check('Run them runs the cells it wrote, and a run takes the mark off', (await added.locator('.cell-output').count()) === 1 && (await added.locator('.nb-fresh').count()) === 0 && (await rewritten.locator('.nb-fresh').count()) === 0);
check('Undo is on the bar for the reply', (await bar.getByRole('button', { name: 'Undo' }).count()) === 1);
// The bar can be put away, and comes back from the toolbar; the choice is remembered.
const askToggle = page.locator('.nb-toolbar').getByRole('button', { name: 'Ask', exact: true });
check('the toolbar’s Ask is on while the bar is shown', (await askToggle.getAttribute('aria-pressed')) === 'true');
await bar.getByRole('button', { name: 'Hide the ask bar' }).click();
await page.waitForTimeout(200);
check('the bar hides from its own button, and the toolbar says so', (await page.locator('.nb-ask').count()) === 0 && (await askToggle.getAttribute('aria-pressed')) === 'false' && (await page.evaluate(() => localStorage.getItem('reader.colab.ask-bar'))) === 'hidden');
await page.screenshot({ path: `${OUT}/colab-notebook-11-ask-hidden-dark.png` });
await askToggle.click();
await page.waitForTimeout(200);
check('and comes back from the toolbar, with its status still there', (await page.locator('.nb-ask').count()) === 1 && (await bar.getByRole('button', { name: 'Undo' }).count()) === 1 && (await page.evaluate(() => localStorage.getItem('reader.colab.ask-bar'))) === 'shown');

console.log('\n== the bar, asked for the whole notebook again ==');
await page.locator('.nb-cells').click({ position: { x: 4, y: 4 } });
await page.evaluate(
  (events) => {
    window.__nbReply = events;
  },
  sse('The notebook again, in PyTorch.\n\n```markdown notebook=new\n# Attention in PyTorch\n```\n\n```python\nimport torch\nprint(torch.__version__)\n```\n\n```python\nprint("a small training run")\n```'),
);
const cellsBeforeWhole = await page.locator('.nb-cell').count();
const requestsBeforeWhole = await page.evaluate(() => window.__requests.length);
await askInput.fill('Rewrite the whole notebook from scratch in PyTorch, with a small training run');
await page.keyboard.press('Enter');
await page.waitForSelector('.nb-ask .ask-status.is-done', { timeout: 20000 });
await page.waitForTimeout(400);
const wholeAsk = await page.evaluate((from) => window.__requests[from], requestsBeforeWhole);
check('a request for the whole notebook is sent as the rewrite, with the reader’s words steering it', /Write this notebook again from scratch/.test(wholeAsk) && /The reader asks, in their words: “Rewrite the whole notebook from scratch in PyTorch/.test(wholeAsk));
check('and the answer replaces every cell', (await page.locator('.nb-cell').count()) === 3 && (await page.locator('.nb-cell.is-fresh').count()) === 3 && (await page.locator('.nb-cell', { hasText: 'a small training run' }).count()) === 1, `${await page.locator('.nb-cell').count()} cells`);
await page.screenshot({ path: `${OUT}/colab-notebook-17-whole-from-bar-dark.png` });
await bar.getByRole('button', { name: 'Undo' }).click();
await page.waitForTimeout(300);
check('Undo brings the notebook back', (await page.locator('.nb-cell').count()) === cellsBeforeWhole && (await page.locator('.nb-cell', { hasText: 'the answer is 42' }).count()) === 1);

console.log('\n== Rewrite, on this tab, rewrites the notebook ==');
await page.evaluate(
  (events) => {
    window.__nbReply = events;
  },
  sse('The notebook again: the method, then an experiment.\n\n```markdown after=end\n# Attention, from scratch\n```\n\n```python after=end\nimport numpy as np\nprint("scaled dot-product attention")\n```\n\n```python after=end\nprint("a small experiment")\n```'),
);
const cellsBeforeRewrite = await page.locator('.nb-cell').count();
check('the header names who writes the notebook on this tab', /Notebook with Claude/.test(await page.locator('.explain-brand').textContent()), await page.locator('.explain-brand').textContent());
await page.getByRole('button', { name: /^Rewrite/ }).click();
await page.waitForSelector('.rewrite-menu');
check('the menu says it is the notebook that is rewritten, cell by cell to begin with', /Rewrite the notebook with/.test(await page.locator('.rewrite-menu .rw-head b').textContent()) && (await page.locator('.rw-nb-mode [aria-checked="true"]').textContent()) === 'Cell by cell');
const codeWithSource = await page.locator('.nb-cell.is-code').evaluateAll((els) => els.filter((el) => el.querySelector('.nb-text')?.value.trim()).length);
const requestsBeforeCells = await page.evaluate(() => window.__requests.length);
await page.locator('.rewrite-menu .rw-card:not([disabled])').first().click();
await page.waitForSelector('.nb-ask .ask-status.is-done', { timeout: 60000 });
await page.waitForTimeout(400);
const cellAsks = await page.evaluate((from) => window.__requests.slice(from), requestsBeforeCells);
check('cell by cell: one request a code cell, each naming its cell', cellAsks.length === codeWithSource && cellAsks.every((body) => /Rewrite cell \d+ in place/.test(body)), `${cellAsks.length} requests for ${codeWithSource} code cells`);
check('every code cell is rewritten in its place, marked, and the text cells stay', (await page.locator('.nb-cell').count()) === cellsBeforeRewrite && (await page.locator('.nb-cell.is-code .nb-fresh', { hasText: 'Rewritten at your request' }).count()) === codeWithSource && (await page.locator('.nb-cell.is-code .nb-text').evaluateAll((els) => els.filter((el) => /rewritten by the stand-in/.test(el.value)).length)) === codeWithSource && (await page.locator('.nb-cell.is-markdown', { hasText: 'A note of my own' }).count()) === 1);
check('the note says so', new RegExp(`${codeWithSource} of ${codeWithSource} code cells rewritten with Claude, each in place`).test(await bar.locator('.ask-status.is-done .ask-note').textContent()), await bar.locator('.ask-status.is-done .ask-note').textContent());
await page.screenshot({ path: `${OUT}/colab-notebook-16-rewritten-cells-dark.png` });
await bar.getByRole('button', { name: 'Undo' }).click();
await page.waitForTimeout(300);
check('one Undo puts every cell back', (await page.locator('.nb-cell.is-fresh').count()) === 0 && (await page.locator('.nb-cell', { hasText: 'the answer is 42' }).count()) === 1 && (await page.locator('.nb-cell.is-code .nb-text').evaluateAll((els) => els.filter((el) => /rewritten by the stand-in/.test(el.value)).length)) === 0);
// The other way: the whole notebook from scratch.
await page.getByRole('button', { name: /^Rewrite/ }).click();
await page.waitForSelector('.rewrite-menu');
await page.locator('.rw-nb-mode').getByRole('radio', { name: 'Whole notebook' }).click();
check('the choice is remembered', (await page.evaluate(() => localStorage.getItem('reader.colab.rewrite'))) === 'notebook');
await page.locator('.rewrite-menu .rw-card:not([disabled])').first().click();
await page.waitForSelector('.nb-ask .ask-status.is-live', { timeout: 5000 }).catch(() => undefined);
await page.waitForSelector('.nb-ask .ask-status.is-done', { timeout: 20000 });
await page.waitForTimeout(400);
const rewriteAsk = await page.evaluate(() => window.__requests.at(-1));
check('the model was asked for the notebook again, not the explanation', /Write this notebook again from scratch/.test(rewriteAsk) && /<notebook>/.test(rewriteAsk));
check('every cell is the model’s now, three of them, and the old ones are gone', (await page.locator('.nb-cell').count()) === 3 && (await page.locator('.nb-cell.is-fresh').count()) === 3 && (await page.locator('.nb-cell', { hasText: 'the answer is 42' }).count()) === 0, `${await page.locator('.nb-cell').count()} cells, ${await page.locator('.nb-cell.is-fresh').count()} fresh`);
await page.screenshot({ path: `${OUT}/colab-notebook-10-rewritten-dark.png` });
await bar.getByRole('button', { name: 'Undo' }).click();
await page.waitForTimeout(300);
await page.evaluate(() => localStorage.setItem('reader.colab.rewrite', 'cells'));
check('Undo brings the notebook back as it was', (await page.locator('.nb-cell').count()) === cellsBeforeRewrite && (await page.locator('.nb-cell', { hasText: 'the answer is 42' }).count()) === 1 && (await page.locator('.nb-cell.is-fresh').count()) === 0);

console.log('\n== Ask AI sees the notebook ==');
// The app bar's button is under the Explain page; its shortcut is not.
await page.locator('.nb-cells').click({ position: { x: 4, y: 4 } });
await page.keyboard.press('Control+j');
await page.waitForSelector('.assistant-win textarea', { timeout: 10000 });
await page.locator('.assistant-win textarea').fill(`What does cell ${n} print?`);
await page.keyboard.press('Enter');
await page.waitForFunction((count) => window.__requests.length > count, await page.evaluate(() => window.__requests.length) - 1, { timeout: 15000 });
await page.waitForTimeout(600);
const assistantAsk = await page.evaluate(() => window.__requests.at(-1));
check('the question went with the Colab notebook: its cells numbered, with their outputs, and the runtime', /<colab_notebook>/.test(assistantAsk) && /on their T4 runtime/.test(assistantAsk) && new RegExp(`### Cell ${n} \\(code`).test(assistantAsk) && /the answer is 42/.test(assistantAsk) && /with its Colab notebook open/.test(assistantAsk));
check('and says the tab is on screen and nothing runs', /the tab on screen now/.test(assistantAsk) && /Nothing is running now/.test(assistantAsk));
await page.keyboard.press('Control+j');
await page.waitForSelector('.assistant-win', { state: 'detached', timeout: 5000 }).catch(() => undefined);
await page.waitForTimeout(300);
// From the Explanation tab, with a cell running: the notebook still goes, and names the cell.
const slow = page.locator('.nb-cell.is-code', { hasText: 'time.sleep' }).first();
await slow.locator('.nb-run').click();
await page.waitForSelector('.nb-cell.is-running', { timeout: 15000 });
await page.getByRole('tab', { name: 'Explanation' }).click();
await page.waitForSelector('.explain-scroll', { timeout: 10000 });
await page.keyboard.press('Control+j');
await page.waitForSelector('.assistant-win textarea', { timeout: 10000 });
await page.locator('.assistant-win textarea').fill('Which cell is running now?');
await page.keyboard.press('Enter');
await page.waitForFunction((count) => window.__requests.length > count, await page.evaluate(() => window.__requests.length) - 1, { timeout: 15000 });
await page.waitForTimeout(600);
const fromExplanation = await page.evaluate(() => window.__requests.at(-1));
check('from the Explanation tab the notebook still goes, marked as not the tab on screen, with the running cell named', /<colab_notebook>/.test(fromExplanation) && /not the tab on screen now/.test(fromExplanation) && /Running now: cell \d+\./.test(fromExplanation) && /\(code, running\)/.test(fromExplanation));
await page.keyboard.press('Control+j');
await page.waitForSelector('.assistant-win', { state: 'detached', timeout: 5000 }).catch(() => undefined);
await page.getByRole('tab', { name: 'Colab' }).click();
await page.waitForSelector('.nb-page', { timeout: 10000 });
await page.waitForSelector('.nb-cell.is-running', { state: 'detached', timeout: 30000 });
await page.waitForTimeout(500);

console.log('\n== run, pause and stop, from the pane ==');
await pane.getByRole('tab', { name: 'Runtime' }).click();
const strip = pane.locator('.rt-run');
check('the pane has Run all, and Pause and Stop wait for a run', (await strip.getByRole('button', { name: /Run all/ }).isEnabled()) && (await strip.getByRole('button', { name: /Pause/ }).isDisabled()) && (await strip.getByRole('button', { name: /Stop/ }).isDisabled()));
await page.locator('.nb-cells').click({ position: { x: 4, y: 4 } });
await strip.getByRole('button', { name: /Run all/ }).click();
await strip.getByRole('button', { name: 'Run all', exact: true }).click();
await page.waitForSelector('.nb-cell.is-running:has-text("time.sleep")', { timeout: 30000 });
await page.waitForTimeout(300);
check('Run all queues every code cell and runs them in order', (await page.locator('.nb-cell.is-queued').count()) >= 1 && /running cell \d+ · \d+ queued/.test(await strip.locator('.rt-run-state').textContent()), await strip.locator('.rt-run-state').textContent());
await strip.getByRole('button', { name: /Stop/ }).click();
await page.waitForSelector('.nb-cell.is-running', { state: 'detached', timeout: 15000 });
await page.waitForTimeout(600);
check('Stop interrupts the cell running and drops the rest', (await page.locator('.nb-cell.is-queued').count()) === 0 && (await page.locator('.nb-cell.is-running').count()) === 0 && (await page.locator('.nb-cell.is-failed:has-text("time.sleep")').count()) === 1 && (await strip.getByRole('button', { name: /Run all/ }).count()) === 1);
await strip.getByRole('button', { name: /Run all/ }).click();
await strip.getByRole('button', { name: 'Run all', exact: true }).click();
await page.waitForSelector('.nb-cell.is-running:has-text("time.sleep")', { timeout: 30000 });
await strip.getByRole('button', { name: /Pause/ }).click();
await page.waitForTimeout(200);
check('Pause lets the cell running finish', /pauses after this cell/.test(await strip.locator('.rt-run-state').textContent()) && (await page.locator('.nb-cell.is-running').count()) === 1);
await page.screenshot({ path: `${OUT}/colab-notebook-13-paused-dark.png` });
await page.waitForSelector('.nb-cell.is-running', { state: 'detached', timeout: 30000 });
await page.waitForTimeout(1500);
check('and holds the rest until Resume', (await page.locator('.nb-cell.is-running').count()) === 0 && (await page.locator('.nb-cell.is-queued').count()) >= 1 && /paused/.test(await strip.locator('.rt-run-state').textContent()) && (await strip.getByRole('button', { name: /Resume/ }).count()) === 1);
await strip.getByRole('button', { name: /Resume/ }).click();
await page.waitForFunction(() => document.querySelectorAll('.nb-cell.is-queued').length === 0 && document.querySelectorAll('.nb-cell.is-running').length === 0, null, { timeout: 30000 });
await page.waitForTimeout(400);
check('Resume runs the rest, and the pane is back to Run all', (await strip.getByRole('button', { name: /Run all/ }).count()) === 1 && (await page.locator('.nb-cell.is-code .nb-ran.is-ran').count()) >= 4, `${await page.locator('.nb-cell.is-code .nb-ran.is-ran').count()} ran`);
check('the toolbar’s Run all is the same queue', (await page.locator('.nb-toolbar').getByRole('button', { name: /Run all/ }).count()) === 1);

console.log('\n== the runtime’s disk ==');
await pane.getByRole('tab', { name: 'Files' }).click();
await page.waitForSelector('.nb-files li', { timeout: 10000 });
const listed = await page.locator('.nb-files li').allTextContents();
check('the files pane lists the runtime’s disk, folders first', /data\//.test(listed[0]) && listed.some((l) => /PLAN\.md/.test(l) && /47 KB/.test(l)), listed.join(' | '));
await page.locator('.nb-files li button', { hasText: 'models/' }).click();
await page.waitForFunction(() => /\/content\/models/.test(document.querySelector('.nb-files-path')?.textContent ?? ''), null, { timeout: 5000 });
check('a folder opens', contentsAsked.at(-1) === 'models' && /pruned_0\.8b/.test(await page.locator('.nb-files').textContent()));
await page.locator('.nb-files li button', { hasText: '..' }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/colab-notebook-4-files-dark.png` });
await pane.getByRole('tab', { name: 'Runtime' }).click();
await page.waitForTimeout(300);
check('back on the Runtime tab, the strips are still there', (await pane.locator('.rt-strip').count()) === 4);
await pane.getByRole('radio', { name: 'Every 30 s' }).click();
await page.waitForTimeout(300);
check('the pulse can be slowed, and says so', (await page.evaluate(() => JSON.parse(localStorage.getItem('reader.colab.pulse')))) === 'slow' && !/live, every/.test(await pane.locator('.rt-part-label').first().textContent()));
await pane.getByRole('radio', { name: 'Live · 2 s' }).click();

console.log('\n== out as an .ipynb, and kept across a reload ==');
await page.getByRole('button', { name: /^Notebook ▾$/ }).click();
const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Download as \.ipynb/ }).click()]);
const ipynb = JSON.parse(await readFile(await file.path(), 'utf8'));
check('the download is a Jupyter notebook with the cells, the typed one and its output among them', ipynb.nbformat === 4 && ipynb.cells.some((c) => c.cell_type === 'code' && c.source.join('').includes('the answer is 42') && c.outputs.some((o) => /the answer is 42/.test(o.text))));
check('and the text cell of my own', ipynb.cells.some((c) => c.cell_type === 'markdown' && /A note of my own/.test(c.source.join(''))));
const before = await page.locator('.nb-cell').count();
await withSettings({ theme: 'light' });
await page.waitForSelector('.nb-cell', { timeout: 15000 });
await page.waitForTimeout(500);
check('after a reload the notebook is as it was, outputs and all', (await page.locator('.nb-cell').count()) === before && (await page.locator('.nb-cell', { hasText: 'the answer is 42' }).locator('.cell-output').count()) === 1);
check('and with no runtime the pane is folded', (await page.locator('.nb-side').count()) === 0);
// Connect again from the chip: the pane comes back with the runtime.
await page.locator('.colab-chip').click();
await page.waitForSelector('.colab-connect');
await page.locator('.colab-connect').getByRole('button', { name: /Connect/ }).click();
await page.waitForSelector('.nb-side .rt-pane', { timeout: 30000 });
await page.waitForFunction(() => /Tesla T4/.test(document.querySelector('.rt-head')?.textContent ?? ''), null, { timeout: 10000 });
await page.waitForTimeout(800);
check('the tab is remembered', (await page.evaluate(() => localStorage.getItem('reader.explain.page'))) === 'colab');
await page.locator('.nb-cell', { hasText: 'the answer is 42' }).scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/colab-notebook-5-light.png` });

check('the page kept the sockets alive with a frame every fifteen seconds while nothing ran', keepalives.length >= 1, `${keepalives.length} keep-alive frames`);
console.log('\n== and on the Explanation page, a cell’s header with Run in Colab ==');
await page.getByRole('tab', { name: 'Explanation' }).click();
await page.waitForSelector('.explain-scroll .explain-cell', { timeout: 10000 });
const pageCell = page.locator('.explain-doc .explain-cell').first();
await pageCell.evaluate((el) => {
  const scroller = el.closest('.explain-scroll');
  const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  scroller.scrollTop = top + 160;
});
await page.waitForTimeout(300);
const headBox = await pageCell.locator('header').boundingBox();
const pageScroller = await page.locator('.explain-scroll').boundingBox();
const pageCellBox = await pageCell.boundingBox();
check('the header, with Run in Colab, sticks to the top of the page while a long cell scrolls', pageCellBox.y < pageScroller.y - 100 && headBox.y >= pageScroller.y - 1 && headBox.y < pageScroller.y + 12, `cell top ${Math.round(pageCellBox.y)}, header ${Math.round(headBox.y)}, scroller ${Math.round(pageScroller.y)}`);
await page.screenshot({ path: `${OUT}/colab-notebook-14-sticky-header-light.png` });
await page.getByRole('tab', { name: 'Colab' }).click();
await page.waitForTimeout(300);

check('no page errors', errors.length === 0, errors.join(' | '));
console.log(`\n${problems.length ? `${problems.length} problem(s):\n  ${problems.join('\n  ')}` : 'all good'}\n`);
await browser.close();
kernels.close();
runtime.close();
process.exit(problems.length ? 1 : 0);
