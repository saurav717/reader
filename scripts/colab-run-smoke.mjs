/**
 * Colab, from the page, against a stand-in runtime. A paper is opened,
 * explained and planned from the fixtures (a stand-in for api.anthropic.com
 * streams them back), and the page's Colab calls — the ones the proxy would
 * make to Colab's session backend — are answered here, with a runtime whose
 * Jupyter server is a small WebSocket server in this script. So the whole
 * path runs without a Google account: connect, the probe that reads what
 * the machine is, a cell run with its output streamed back, and the
 * Implementation page's "Run it on Colab" panel — the machine cards, the
 * needs against the machine, the steps, and the GPU, CPU and memory drawn
 * as a step runs. Each state is photographed, in dark and light.
 *
 *   npm run build && npm start &
 *   node scripts/colab-run-smoke.mjs        # SMOKE_BASE=http://localhost:8080
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
const PLAN = await fixture('implement-minitron.md');

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
// The stand-in runtime: a Jupyter server as the page speaks to it
// ---------------------------------------------------------------------------

const runtime = createServer((_request, response) => response.end('runtime'));
const kernels = new WebSocketServer({ server: runtime });
let kernelCount = 0;
let executionCount = 0;
/** Whether a cell is running, so the probe's numbers rise while one does. */
let busySince = 0;
const probes = [];
const ran = [];

const header = (type) => ({ msg_id: `k-${Math.random().toString(36).slice(2)}`, msg_type: type, session: 'kernel', username: 'kernel', version: '5.3', date: new Date().toISOString() });
const send = (socket, type, content, parent, channel = 'iopub') => socket.send(JSON.stringify({ header: header(type), parent_header: { msg_id: parent }, metadata: {}, content, channel, buffers: [] }));

/** What the machine says of itself: a T4 idle, then busy while a cell runs, its memory filling. */
function probeLine() {
  const t = busySince ? (Date.now() - busySince) / 1000 : 0;
  const busy = busySince ? Math.min(1, t / 4) : 0;
  const wave = 0.5 + 0.5 * Math.sin(t / 1.7);
  const util = Math.round(busy * (62 + 30 * wave));
  const vram = Math.round(400 + busy * (9800 + 600 * wave));
  const cpu = Math.round(6 + busy * (28 + 20 * (1 - wave)));
  const ram = Math.round(1900 + busy * 3300);
  return JSON.stringify({ gpu: `Tesla T4, ${util}, ${vram}, 15360`, cpu, cpus: 2, ram: [ram, 13012], disk: [71, 78] });
}

/** What a cell prints, as lines with a pause between them, for the code the page sent. */
function answer(code) {
  if (code.startsWith('import json, os, shutil, subprocess, time')) return { lines: [probeLine()], every: 0, probe: true };
  if (code.startsWith('# Lay the repository out here')) {
    const paths = [...code.matchAll(/^ {4}"([^"]+)": "/gm)].map((m) => m[1]);
    return { lines: [...paths.map((p) => `wrote ${p} (${20 + Math.round(Math.random() * 40)} lines)`), `${paths.length} files in /content`], every: 60 };
  }
  if (/^%%bash\nmake distill/.test(code)) {
    const lines = ['python -m minitron.train --config configs/distill.yaml', 'loading teacher models/teacher (1.54B) and student models/pruned_0.8b (0.81B)', 'data/fineweb_edu_1b.bin: 244,140 sequences of 4096'];
    for (let step = 1; step <= 48; step += 1) lines.push(`step ${step * 25}  loss=${(3.1 * Math.exp(-step / 14) + 0.55 + 0.03 * Math.sin(step)).toFixed(3)}  val_loss=${(3.3 * Math.exp(-step / 15) + 0.62).toFixed(3)}  lr=1.0e-04  tok/s=41.2k`);
    lines.push('saved models/distilled_0.8b/step-1200');
    return { lines, every: 430 };
  }
  if (/^%%bash\n/.test(code)) return { lines: [`$ ${code.split('\n')[1]}`, '…done'], every: 200 };
  if (/^import numpy as np/.test(code) && /attention weights/.test(code)) {
    return { lines: ['attention weights (rows sum to 1):', '    the [0.6 0.1 0.2 0.1]', '    cat [0.02 0.89 0.04 0.05]', '    sat [0.15 0.2  0.56 0.1 ]', '   down [0.08 0.3  0.11 0.51]', 'output shape: (4, 8)'], every: 40 };
  }
  if (/teacher, pruned, distilled = 9\.8/.test(code)) return { lines: ['teacher ppl 9.8   pruned 412.0   distilled 12.6', 'log-perplexity gap recovered by distillation: 93%'], every: 40 };
  return { lines: ['ok'], every: 0 };
}

kernels.on('connection', (socket) => {
  socket.on('message', async (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message?.header?.msg_type !== 'execute_request') return;
    const parent = message.header.msg_id;
    const code = String(message.content?.code ?? '');
    const { lines, every, probe } = answer(code);
    if (probe) probes.push(code);
    else {
      ran.push(code);
      busySince = Date.now();
    }
    send(socket, 'status', { execution_state: 'busy' }, parent);
    for (const line of lines) {
      if (socket.readyState !== socket.OPEN) return;
      send(socket, 'stream', { name: 'stdout', text: `${line}\n` }, parent);
      if (every) await sleep(every);
    }
    if (!probe) {
      busySince = 0;
      executionCount += 1;
    }
    send(socket, 'execute_reply', { status: 'ok', execution_count: probe ? undefined : executionCount }, parent, 'shell');
    send(socket, 'status', { execution_state: 'idle' }, parent);
  });
});
await new Promise((resolve) => runtime.listen(0, '127.0.0.1', resolve));
const RUNTIME_URL = `http://127.0.0.1:${runtime.address().port}/`;
console.log(`stand-in runtime at ${RUNTIME_URL}`);

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

/** The Messages API's stream, as the SDK expects to read it: one event a string. */
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

// The proxy's Colab routes, answered here: one runtime on a T4, whose Jupyter server is the stand-in above.
const colabCalls = [];
await context.route('**/api/colab/**', (route) => {
  const url = new URL(route.request().url());
  const path = url.pathname.replace(/^.*\/api\/colab/, '/colab');
  const method = route.request().method();
  colabCalls.push(`${method} ${path}`);
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (!route.request().headers()['x-google-token']) return json({ error: 'no token' }, 401);
  if (path === '/colab/runtimes' && method === 'POST') return json({ runtime: { endpoint: 'm-s-smoke', accelerator: 'T4', highMem: false, proxy: { url: RUNTIME_URL, token: 'proxy-token', expiresAt: Date.now() + 3_600_000 } } });
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

await context.addInitScript(
  ({ explanation, plan, scope }) => {
    // A Google session that already holds Colab access, so the first Run need not open Google's window.
    sessionStorage.setItem('reader.google.session', JSON.stringify({ accessToken: 'ya29.smoke', expiresAt: Date.now() + 3_600_000, scopes: ['openid', 'email', scope], user: { email: 'reader@example.org', name: 'Reader' } }));
    const real = window.fetch.bind(window);
    window.__asked = [];
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.startsWith('https://api.anthropic.com')) return real(input, init);
      const body = JSON.parse(init?.body ?? '{}');
      window.__asked.push(body);
      const events = body.system?.some((block) => /IMPLEMENTATION page/.test(block.text)) ? plan : explanation;
      const stream = new ReadableStream({
        async start(controller) {
          for (const event of events) controller.enqueue(new TextEncoder().encode(event));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_smoke' } });
    };
  },
  { explanation: sse(EXPLANATION), plan: sse(PLAN), scope: COLAB_SCOPE },
);

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
process.on('uncaughtException', async (error) => {
  console.error(error);
  await page.screenshot({ path: `${OUT}/colab-run-failed.png` }).catch(() => undefined);
  process.exit(2);
});

console.log('\n== open a paper ==');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  localStorage.setItem('reader.anthropic-key', 'sk-ant-smoke');
  localStorage.setItem('reader.explain.layout', 'margin');
  localStorage.removeItem('reader.implement.hardware');
  localStorage.removeItem('reader.implement.colab-panel');
  localStorage.setItem('reader.colab.machine', JSON.stringify({ accelerator: 'T4', highMem: false }));
  const saved = JSON.parse(localStorage.getItem('reader.settings') || '{}');
  localStorage.setItem('reader.settings', JSON.stringify({ ...saved, googleClientId: 'smoke-client-id.apps.googleusercontent.com', theme: 'dark', glass: false }));
});
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();
// Home's search box, over Google Scholar only (the stand-in answers it), then Save, then Read.
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

/** Settings as the app keeps them, then a reload, back to the page. */
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

const scrollTo = async (selector, offset = 12) => {
  await page.locator('.explain-scroll').evaluate(
    (el, { selector, offset }) => {
      const target = el.querySelector(selector);
      if (target) el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - offset;
    },
    { selector, offset },
  );
  await page.waitForTimeout(300);
};

/** The pointer onto a cell's header, as a reader's would be before Run or Copy. */
async function hoverHeader(cell) {
  const box = await cell.locator('header').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(300);
}

/** A picture of one element with some air around it. */
async function shot(selector, path, air = 28) {
  const box = await page.locator(selector).first().boundingBox();
  await page.screenshot({ path, clip: { x: Math.max(0, box.x - air), y: Math.max(0, box.y - air), width: Math.min(W - Math.max(0, box.x - air), box.width + air * 2), height: Math.min(H - Math.max(0, box.y - air), box.height + air * 2) } });
}

// ---------------------------------------------------------------------------
// 1. The cell's header: Add to notes beside Copy and Run in Colab, not over them
// ---------------------------------------------------------------------------

console.log('\n== E: the explanation, and a cell run in Colab ==');
await page.mouse.move(W / 2, H / 2);
await page.keyboard.press('e');
await page.waitForSelector('.explain .explain-empty');
await page.getByRole('button', { name: 'Explain this paper' }).click();
await page.waitForSelector('.explain-section h2', { timeout: 20000 });
await page.waitForFunction(() => !document.querySelector('.explain-writing'), null, { timeout: 30000 });
const cell = page.locator('.explain-doc .explain-cell').first();
await scrollTo('.explain-cell', 120);
check('the cell’s header has Add to notes in it, beside Copy', (await cell.locator('header .keep-btn').count()) === 1 && (await cell.locator('header .btn', { hasText: 'Copy' }).count()) === 1);
check('Run in Colab is live before any connection, since a client ID and the proxy are there', !(await cell.locator('header .btn.colab').isDisabled()));
await hoverHeader(cell);
check('no corner button is dropped on the cell', (await page.locator('.note-clip-btn').count()) === 0);
const buttons = await cell.locator('header button').evaluateAll((els) => els.map((el) => ({ text: el.textContent.trim(), ...el.getBoundingClientRect().toJSON() })));
const overlaps = buttons.some((a, i) => buttons.some((b, j) => i < j && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height));
check('none of the header’s buttons overlap', !overlaps, JSON.stringify(buttons.map((b) => [b.text, Math.round(b.x), Math.round(b.width)])));
await shot('.explain-doc .explain-cell', `${OUT}/colab-run-1-cell-header-dark.png`);

await cell.locator('header .btn.colab').click();
await page.waitForSelector('.explain-cell.is-ran', { timeout: 30000 });
await page.waitForTimeout(600);
check('the cell ran in the stand-in runtime and matches what Claude expected', /Matches what Claude expected/.test(await cell.textContent()));
check('the chip in the bar says the runtime is a T4', /T4/.test(await page.locator('.colab-chip').textContent()));
check('the machine was probed as the runtime connected', probes.length >= 1);
await hoverHeader(cell);
await shot('.explain-doc .explain-cell', `${OUT}/colab-run-2-cell-ran-dark.png`);
await cell.locator('header .keep-btn').click();
await page.waitForSelector('.note-kept', { timeout: 5000 });
check('the header’s button keeps the cell in the notes', /Code.*added to your notes/.test(await page.locator('.note-kept').textContent()));
await page.waitForSelector('.note-kept', { state: 'detached', timeout: 10000 });

await page.locator('.colab-chip').click();
await page.waitForSelector('.colab-runtime');
check('the runtime menu says what the machine is', /Tesla T4/.test(await page.locator('.colab-specs').textContent()) && /13 GB RAM|12\.7 GB RAM/.test(await page.locator('.colab-specs').textContent()), await page.locator('.colab-specs').textContent());
check('the watch is offered for every runtime, with the probe a click away', (await page.locator('.colab-switch').count()) === 1);
await page.locator('.colab-switch .link').click();
await page.waitForSelector('.colab-probe');
await page.screenshot({ path: `${OUT}/colab-run-3-runtime-menu-dark.png` });
await page.keyboard.press('Escape');

// ---------------------------------------------------------------------------
// 2. The Implementation page: Run it on Colab
// ---------------------------------------------------------------------------

console.log('\n== the Implementation tab, planned ==');
await page.getByRole('tab', { name: 'Implementation' }).click();
await page.waitForSelector('.impl-empty');
await page.locator('.impl-empty select[aria-label="Accelerator"]').selectOption('colab-t4');
await page.getByRole('button', { name: 'Plan the implementation' }).click();
await page.waitForSelector('.explain-section h2', { timeout: 20000 });
await page.waitForFunction(() => !document.querySelector('.explain-writing'), null, { timeout: 30000 });
await page.waitForSelector('.impl-colab', { timeout: 10000 });
const panel = page.locator('.impl-colab');
check('the panel sits under the compute budget, open', (await panel.count()) === 1 && (await panel.getAttribute('class')).includes('is-open'));
check('it offers Colab’s four machines with the budget on each', (await panel.locator('.colab-machine').count()) === 4);
check('the smallest that fits is marked', (await panel.locator('.colab-machine.is-best b').textContent()) === 'A100 · 40 GB');
check('the runtime’s machine is the one shown, since one is connected', (await panel.locator('.colab-machine.is-on b').textContent()) === 'T4 · 16 GB');
check('the needs are set against the machine as measured', /measured/.test(await panel.locator('.colab-part-label').nth(1).textContent()) && (await panel.locator('.need-measured').count()) === 3);
const stepTitles = await panel.locator('.colab-step .step-body > b').allTextContents();
check('the steps are the connection, the scaffold, the shell cells, the Makefile’s targets and the Python cell', stepTitles.length === 11 && /Connected to your T4/.test(stepTitles[0]) && stepTitles[1] === 'Lay the repository out' && stepTitles.at(-1).startsWith('The headline'), stepTitles.join(' | '));
check('the outline links to it', (await page.locator('.outline-hardware .hw-change', { hasText: 'Run it on Colab' }).count()) === 1);
await scrollTo('#run-on-colab', 16);
await page.screenshot({ path: `${OUT}/colab-run-4-panel-dark.png` });

console.log('\n== the steps run, and the machine is watched ==');
await panel.locator('.colab-step', { hasText: 'Lay the repository out' }).getByRole('button', { name: /Run/ }).click();
await page.waitForSelector('.colab-step.is-scaffold.is-ran', { timeout: 30000 });
check('the scaffold cell wrote the six files in the runtime', /6 files in \/content/.test(await panel.locator('.colab-step.is-scaffold').textContent()));
check('what the kernel took is the cell as shown', ran.some((code) => code.startsWith('# Lay the repository out here') && /"minitron\/distill\.py": "/.test(code)));
const distill = panel.locator('.colab-step', { hasText: 'make distill' });
await distill.locator('.step-note .link').click();
await distill.getByRole('button', { name: /Run/ }).click();
await page.waitForSelector('.colab-step.is-running', { timeout: 10000 });
await page.waitForFunction(() => document.querySelectorAll('.colab-live .cell-chart').length >= 2, null, { timeout: 30000 });
await page.waitForTimeout(6000);
check('the tiles show the GPU, VRAM, CPU, RAM and disk as it runs', /GPU\s*\d+%/.test(await panel.locator('.live-tiles').textContent()) && /CPU\s*\d+%/.test(await panel.locator('.live-tiles').textContent()), (await panel.locator('.live-tiles').textContent()).replace(/\s+/g, ' '));
check('the chip in the bar carries the GPU and the CPU', /GPU \d+% · CPU \d+%/.test(await page.locator('.colab-chip').textContent()), await page.locator('.colab-chip').textContent());
check('the use and the memory are drawn, live', (await panel.locator('.colab-live .cell-chart').count()) === 2 && /Now · GPU \d+% · CPU \d+%/.test(await panel.locator('.colab-live .chart-title').first().textContent()));
check('the loss curve is read off the log under the step', (await distill.locator('.cell-chart').count()) >= 1);
await scrollTo('.colab-steps', 60);
await page.screenshot({ path: `${OUT}/colab-run-5-running-dark.png` });
await scrollTo('.colab-live', 80);
await page.screenshot({ path: `${OUT}/colab-run-6-live-dark.png` });
await page.waitForSelector('.colab-step.is-make.is-ran', { timeout: 60000 });
await page.waitForTimeout(500);
check('the step ends with its peak use kept', /Peak · GPU \d+% · CPU \d+%/.test(await panel.locator('.colab-live .chart-title').first().textContent()));
check('the cell ran as bash', ran.some((code) => code === '%%bash\nmake distill\n'));
await scrollTo('.colab-live', 80);
await page.screenshot({ path: `${OUT}/colab-run-7-ran-dark.png` });

console.log('\n== in light ==');
await withSettings({ theme: 'light' });
await page.waitForSelector('.impl-colab', { timeout: 15000 });
await scrollTo('#run-on-colab', 16);
check('after a reload the runtime is remembered, and the panel offers to connect again or is connected', (await page.locator('.impl-colab .colab-step.is-connect').count()) === 1);
await page.screenshot({ path: `${OUT}/colab-run-8-panel-light.png` });
const lightDistill = page.locator('.impl-colab .colab-step', { hasText: 'make distill' });
await lightDistill.getByRole('button', { name: /Run/ }).click();
await page.waitForFunction(() => document.querySelectorAll('.colab-live .cell-chart').length >= 2, null, { timeout: 40000 });
await page.waitForTimeout(6000);
await scrollTo('.colab-live', 80);
await page.screenshot({ path: `${OUT}/colab-run-9-live-light.png` });
await page.getByRole('tab', { name: 'Explanation' }).click();
await page.waitForSelector('.explain-cell', { timeout: 15000 });
await scrollTo('.explain-cell', 120);
await page.waitForTimeout(800);
await scrollTo('.explain-cell', 120);
await hoverHeader(page.locator('.explain-doc .explain-cell').first());
await shot('.explain-doc .explain-cell', `${OUT}/colab-run-10-cell-header-light.png`);

check('no page errors', errors.length === 0, errors.join(' | '));
console.log(`\ncolab calls: ${colabCalls.join(', ')}`);
console.log(`\n${problems.length ? `${problems.length} problem(s):\n  ${problems.join('\n  ')}` : 'all good'}\n`);
await browser.close();
kernels.close();
runtime.close();
process.exit(problems.length ? 1 : 0);
