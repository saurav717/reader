/**
 * The Colab route of the Implementation tab, over Drive. With Drive connected,
 * "Save to Drive and open in Colab" writes the notebook and three run files
 * into the paper's folder and opens Colab on the notebook; then a stand-in
 * for the Colab session writes into those files the way the notebook's first
 * cell does — status.json, log.txt, metrics.jsonl, and the notebook with its
 * outputs saved — and the page shows the run as it goes: the GPU, the cells,
 * the loss, the log, and each cell's real output beside the one Claude
 * expected. Photographed at each state.
 *
 *   npm run build && npm start &
 *   node scripts/implement-colab-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { connectAndEnter, reporter, settingsScript } from './fakeGoogle.mjs';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });
const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const PLAN = await fixture('implement-minitron.md');
const TITLE = 'Compact Language Models via Pruning and Knowledge Distillation';
const W = 1440;
const H = 900;
const { check, problems } = reporter();

// ------------------------------------------------------------ a fake Drive ---
// Folders with parents, files found by name and parent, multipart uploads that
// create or overwrite, alt=media reads, and ?fields=modifiedTime — which is
// what the page polls, so a file the "Colab session" writes must bump it.

const drive = { items: new Map(), next: 1 };
const stamp = () => new Date(Date.now() + drive.next++).toISOString();
const byName = (name) => [...drive.items.values()].find((item) => item.name === name);
/** What the notebook's first cell does through the mount: write the file in place. */
function colabWrites(name, content, { append = false } = {}) {
  const item = byName(name);
  if (!item) throw new Error(`no ${name} in Drive`);
  item.content = append ? item.content + content : content;
  item.modifiedTime = stamp();
}

function multipart(request) {
  const type = request.headers()['content-type'] || '';
  const boundary = /boundary=(.+)$/.exec(type)?.[1];
  const raw = (request.postDataBuffer() || Buffer.alloc(0)).toString('utf8');
  const parts = boundary ? raw.split(`--${boundary}`).slice(1, -1) : [];
  const body = (part) => part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
  return { metadata: JSON.parse(body(parts[0] || '{}') || '{}'), content: body(parts[1] || '') };
}

async function installDrive(context) {
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await context.addInitScript(() => {
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: (config) => ({
            requestAccessToken: () => setTimeout(() => config.callback({ access_token: 'test-token', expires_in: 3600, scope: 'openid email profile https://www.googleapis.com/auth/drive.file' }), 10),
          }),
          revoke: (_token, done) => done && done(),
        },
      },
    };
  });
  await context.addInitScript((settings) => {
    if (!localStorage.getItem('reader.settings')) localStorage.setItem('reader.settings', JSON.stringify(settings));
  }, settingsScript({ readingMode: 'reflow', autoSync: true, savePdf: false }));
  await context.route('**/accounts.google.com/gsi/client*', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '// stubbed' }));
  await context.route('**/www.googleapis.com/oauth2/v3/userinfo*', (route) => json(route, { name: 'Saurav Chennuri', email: 'reader@example.org' }));
  await context.route('**/www.googleapis.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const upload = /^\/upload\/drive\/v3\/files(?:\/([^/?]+))?$/.exec(url.pathname);
    if (upload) {
      const { metadata, content } = multipart(request);
      const id = upload[1] || `file-${drive.next++}`;
      const existing = drive.items.get(id);
      if (upload[1] && !existing) return json(route, { error: { message: 'File not found' } }, 404);
      const item = { id, name: metadata.name ?? existing?.name, parent: existing?.parent ?? metadata.parents?.[0], folder: false, content, modifiedTime: stamp() };
      drive.items.set(id, item);
      return json(route, { id, name: item.name, webViewLink: `https://drive.google.com/file/d/${id}/view`, modifiedTime: item.modifiedTime });
    }
    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const item = drive.items.get(one[1]);
      if (!item) return json(route, { error: { message: 'File not found' } }, 404);
      if (url.searchParams.get('alt') === 'media') return route.fulfill({ status: 200, contentType: 'text/plain', body: item.content ?? '' });
      return json(route, { id: item.id, modifiedTime: item.modifiedTime });
    }
    if (url.pathname === '/drive/v3/files' && request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}');
      const id = `folder-${drive.next++}`;
      drive.items.set(id, { id, name: body.name, parent: body.parents?.[0] ?? 'root', folder: true, modifiedTime: stamp() });
      return json(route, { id, name: body.name });
    }
    if (url.pathname === '/drive/v3/files') {
      const q = url.searchParams.get('q') || '';
      const name = /name = '((?:\\'|[^'])+)'/.exec(q)?.[1]?.replace(/\\'/g, "'");
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const folder = q.includes("mimeType = 'application/vnd.google-apps.folder'");
      const files = [...drive.items.values()]
        .filter((item) => (!name || item.name === name) && (!parent || item.parent === parent) && (!folder || item.folder))
        .map((item) => ({ id: item.id, name: item.name, webViewLink: `https://drive.google.com/file/d/${item.id}/view`, modifiedTime: item.modifiedTime }));
      return json(route, { files });
    }
    return json(route, {});
  });
}

/** The Messages API's stream, one event a string. */
function sse(text, size = 400) {
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const body = [
    event('message_start', { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ];
  for (let i = 0; i < text.length; i += size) body.push(event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + size) } }));
  body.push(event('content_block_stop', { type: 'content_block_stop', index: 0 }));
  body.push(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }));
  body.push(event('message_stop', { type: 'message_stop' }));
  return body;
}

// ------------------------------------------------------------- a browser ---

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const printer = await browser.newPage();
const para = 'We investigate whether pruning an existing LLM and then re-training it with a fraction of the original training data can be a suitable alternative to training each variant from scratch. ';
await printer.setContent(
  `<!doctype html><html><body style="font-family: serif; margin: 0.8in"><h1>${TITLE}</h1><h3>Abstract</h3><p>${para.repeat(4)}</p>${[1, 2, 3]
    .map((n) => `<section style="break-after: page"><h2>${n}. Section</h2><p>${para.repeat(12)}</p></section>`)
    .join('')}</body></html>`,
);
const PDF = await printer.pdf({ format: 'Letter' });
await printer.close();

const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
await installDrive(context);
await context.route('**/pdf?*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }));
for (const host of ['api.crossref.org', 'api.semanticscholar.org', 'dblp.org', 'wikidata.org', 'api.openalex.org', 'api.unpaywall.org']) {
  await context.route(`**/${host}/**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[],"data":[],"message":{"items":[]},"result":{"hits":{}}}' }));
}
await context.route('**/scholar/search*', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ results: [{ id: '3001', clusterId: '3001', title: TITLE, url: 'https://arxiv.org/abs/2407.14679', pdfUrl: 'https://example.org/minitron.pdf', authors: ['S Muralidharan', 'ST Sreenivas'], year: 2024, snippet: para }] }),
  }),
);
await context.route('**/scholar/{authors,person,paper-authors,cluster}*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[]}' }));
await context.addInitScript(
  ({ first }) => {
    const real = window.fetch.bind(window);
    window.__asked = [];
    window.__opened = [];
    // The window the click opens, and where it is sent once Drive has the notebook.
    window.open = () => {
      const fake = { closed: false, close() { this.closed = true; }, _href: '', get location() { return { set href(value) { window.__opened.push(value); } }; } };
      Object.defineProperty(fake, 'location', { set(value) { window.__opened.push(String(value)); }, get() { return { set href(value) { window.__opened.push(value); } }; } });
      return fake;
    };
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.startsWith('https://api.anthropic.com')) return real(input, init);
      window.__asked.push(JSON.parse(init?.body ?? '{}'));
      return new Response(new ReadableStream({ start(c) { for (const e of first) c.enqueue(new TextEncoder().encode(e)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    localStorage.setItem('reader.anthropic-key', 'sk-ant-smoke');
    localStorage.setItem('reader.explain.layout', 'margin');
    localStorage.setItem('reader.explain.page', 'implement');
    localStorage.setItem('reader.implement.hardware', JSON.stringify({ gpu: 'colab-t4', count: 1, ramGb: 16, diskGb: 100, mfu: 0.35, hoursPerDay: 8 }));
  },
  { first: sse(PLAN) },
);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

console.log('\n== open a paper, with Drive connected ==');
await page.goto(BASE, { waitUntil: 'networkidle' });
await connectAndEnter(page);
if (!(await page.locator('.dock .discover-panel').isVisible())) await page.getByRole('button', { name: 'Discover papers' }).click();
const chips = page.locator('.discover-panel .chip');
for (let index = 0; index < (await chips.count()); index += 1) {
  const chip = chips.nth(index);
  const wanted = /Scholar/.test((await chip.textContent()) || '');
  if (wanted !== ((await chip.getAttribute('aria-pressed')) === 'true')) await chip.click();
}
await page.getByLabel('Search papers').fill('compact language models pruning');
await page.getByLabel('Search papers').press('Enter');
await page.waitForSelector('article.result');
await page.locator('article.result h3').first().click();
await page.getByRole('button', { name: /Add to collection/i }).click();
await page.getByRole('button', { name: /^Read$/ }).click().catch(() => undefined);
await page.waitForSelector('.paper-body h2, .paper-body p', { timeout: 30000 });
await page.waitForTimeout(800);

console.log('\n== the plan ==');
await page.mouse.move(700, 450);
await page.keyboard.press('e');
await page.waitForSelector('.explain', { timeout: 15000 }).catch(async () => {
  await page.screenshot({ path: `${OUT}/implement-colab-debug.png` });
  console.log('  no Explain:', errors.join(' | ') || (await page.locator('body').textContent())?.slice(0, 300));
});
if (!(await page.locator('.impl-empty').count())) await page.getByRole('tab', { name: 'Implementation' }).click().catch(() => undefined);
await page.waitForSelector('.impl-empty', { timeout: 15000 });
await page.getByRole('button', { name: 'Plan the implementation' }).click();
await page.waitForSelector('.explain-section h2', { timeout: 20000 });
await page.waitForFunction(() => !document.querySelector('.explain-writing'), null, { timeout: 30000 });
check('the plan is on the page', (await page.locator('.explain-section').count()) === 10);

console.log('\n== Save to Drive and open in Colab ==');
await page.getByRole('button', { name: 'Colab', exact: true }).click();
await page.waitForSelector('.colab-menu');
check('with Drive connected, the first action is Drive', /Save to Drive and open in Colab/.test(await page.locator('.colab-menu .colab-action').first().textContent()));
await page.screenshot({ path: `${OUT}/implement-colab-1-menu.png` });
await page.getByRole('menuitem', { name: /Save to Drive and open in Colab/ }).click();
await page.waitForSelector('.colab-panel', { timeout: 15000 });
await page.waitForTimeout(500);
const notebook = byName('compact-language-models-via-pruning-and-knowledge.ipynb');
check('the notebook is in the paper’s folder in Drive', Boolean(notebook) && drive.items.get(notebook.parent)?.name === TITLE, [...drive.items.values()].map((i) => i.name).join(' | '));
const runFolder = byName('compact-language-models-via-pruning-and-knowledge');
check('the three run files are made by the app, empty, under runs/', ['status.json', 'log.txt', 'metrics.jsonl'].every((name) => byName(name)?.parent === runFolder?.id) && drive.items.get(runFolder?.parent)?.name === 'runs');
check('status.json says waiting', /waiting/.test(byName('status.json')?.content ?? ''));
const opened = await page.evaluate(() => window.__opened);
check('Colab is opened on the notebook in Drive', opened[0] === `https://colab.research.google.com/drive/${notebook?.id}`, opened.join(' | '));
const book = JSON.parse(notebook?.content ?? '{}');
check('the notebook reports back from its second cell', /drive\.mount/.test(book.cells?.[1]?.source?.join('') ?? '') && /runs\/compact-language-models-via-pruning-and-knowledge/.test(book.cells?.[1]?.source?.join('') ?? ''));
check('the panel waits for Run all', /Waiting for Run all/.test(await page.locator('.colab-panel .run-chip').textContent()));
await page.screenshot({ path: `${OUT}/implement-colab-2-waiting.png` });

console.log('\n== the session runs: status, log and metrics come back through Drive ==');
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
colabWrites('status.json', JSON.stringify({ state: 'running', gpu: 'Tesla T4, 15360 MiB', started: at(9), updated: at(0), cell: 9, cells_failed: 0, steps: 800, step: 340, message: 'Distilling: 1B tokens, micro-batch 2 × 128 accumulation' }));
colabWrites('log.txt', ['reporting to /content/drive/MyDrive/Papers_collection/…/runs/compact-language-models-via-pruning-and-knowledge on Tesla T4, 15360 MiB', 'teacher: 1.54B parameters, 28 layers, hidden 1536, 12 heads (2 KV), intermediate 8960', 'data/calib.bin: 1,024 sequences × 4096 tokens', 'importance: neuron (28 × 8960), head (28 × 12), emb (1536) — 41 s', 'pruned to 0.81B parameters: hidden 1024, 8 heads, intermediate 5632', 'step 100/800  kl 2.8412  lr 1.00e-04  3,910 tok/s', 'step 200/800  kl 1.9377  lr 9.62e-05  3,894 tok/s', 'step 300/800  kl 1.4120  lr 8.54e-05  3,902 tok/s', 'checkpoint: models/distilled_0.8b/step-300'].join('\n') + '\n');
const steps = Array.from({ length: 35 }, (_, i) => i * 10);
colabWrites('metrics.jsonl', steps.map((step) => JSON.stringify({ step, t: at(9 - step / 40), loss: Number((0.9 + 3.4 * Math.exp(-step / 110) + 0.08 * Math.sin(step / 7)).toFixed(4)), lr: 1e-4 })).join('\n') + '\n');
await page.waitForFunction(() => /Running/.test(document.querySelector('.colab-panel .run-chip')?.textContent ?? ''), null, { timeout: 20000 });
await page.waitForTimeout(400);
const panel = await page.locator('.colab-panel').textContent();
check('the panel shows the GPU Colab gave', /Tesla T4/.test(panel), panel.slice(0, 120));
check('and how far it is', /340 \/ 800 steps/.test(panel));
check('the loss is drawn', (await page.locator('.metric-chart path.series').count()) === 1 && /loss/.test(await page.locator('.metric-chart figcaption').textContent()));
check('the log’s tail is there', /checkpoint: models\/distilled_0\.8b\/step-300/.test(panel));
await page.locator('.metric-chart svg').scrollIntoViewIfNeeded();
await page.waitForTimeout(150);
const chart = await page.locator('.metric-chart svg').boundingBox();
await page.mouse.move(chart.x + chart.width * 0.5, chart.y + chart.height * 0.4);
await page.waitForTimeout(150);
check('the pointer reads a value off the line', /at step \d+/.test(await page.locator('.metric-chart figcaption').textContent()));
await page.screenshot({ path: `${OUT}/implement-colab-3-running.png` });

console.log('\n== done: the notebook’s outputs beside the cells ==');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAADNMzENAAAAaklEQVR4nO3TsQ2AMBAEwTMioQdaoP8G6IEG4AoyA+ZGmQVbulJXt+tzzUzSt7bnvbv7BEqQFglTIiVGz5VJpMSISYkRkxIjJiVGTEqMmJQYMSkxYlJixKTEiEmJEZMSIyYlRkxK7B9c8uLABkE3g6MAAAAASUVORK5CYII=';
const saved = JSON.parse(notebook.content);
for (const cell of saved.cells) {
  const source = cell.source.join('');
  if (cell.cell_type !== 'code') continue;
  if (source.startsWith('%%bash\n# Get the teacher')) cell.outputs = [{ output_type: 'stream', name: 'stdout', text: ['teacher: 1.54B parameters, 28 layers, hidden 1536, 12 heads (2 KV), intermediate 8960\n', 'data/fineweb_edu_1b.bin: 244,140 sequences × 4096 tokens (1.00B tokens, 4.0 GB)\n', 'data/calib.bin: 1,024 sequences × 4096 tokens\n'] }];
  if (source.startsWith('# The headline')) cell.outputs = [{ output_type: 'stream', name: 'stdout', text: ['teacher ppl 9.8   pruned 412.0   distilled 13.1\n', 'log-perplexity gap recovered by distillation: 92%\n'] }, { output_type: 'display_data', data: { 'image/png': PNG, 'text/plain': ['<Figure size 640x200>'] } }];
  if (source.startsWith('%%bash\n# The five benchmarks')) cell.outputs = [{ output_type: 'error', ename: 'CalledProcessError', evalue: "Command 'lm_eval …' returned non-zero exit status 1.", traceback: [] }];
}
colabWrites('compact-language-models-via-pruning-and-knowledge.ipynb', JSON.stringify(saved));
colabWrites('log.txt', 'step 800/800  kl 0.9121  lr 1.00e-05  3,899 tok/s\ncheckpoint: models/distilled_0.8b/step-800\ndone at 2026-09-25T13:02:11+00:00\n', { append: true });
colabWrites('metrics.jsonl', steps.slice(35).concat([400, 500, 600, 700, 800]).map((step) => JSON.stringify({ step, loss: Number((0.9 + 3.4 * Math.exp(-step / 110)).toFixed(4)) })).join('\n') + '\n', { append: true });
colabWrites('status.json', JSON.stringify({ state: 'done', gpu: 'Tesla T4, 15360 MiB', started: at(21), updated: at(0), cell: 14, cells_failed: 1, steps: 800, step: 800 }));
await page.waitForFunction(() => /Done/.test(document.querySelector('.colab-panel .run-chip')?.textContent ?? ''), null, { timeout: 20000 });
await page.waitForTimeout(400);
check('the panel says done, and stops watching', /Done/.test(await page.locator('.colab-panel .run-chip').textContent()) && (await page.locator('.colab-panel .btn', { hasText: 'Watch again' }).count()) === 0);
check('three cells reported their output', /3 cells reported/.test(await page.locator('.colab-panel').textContent()));
const fromColab = page.locator('.cell-output.is-colab');
check('the outputs are beside the cells', (await fromColab.count()) === 3);
check('what Claude expected stays under them, quieter', (await page.locator('.cell-output.is-expected').count()) === 2);
check('an image output is an image', (await page.locator('.cell-output.is-colab img.cell-image').count()) === 1);
check('a failed cell shows its error', /CalledProcessError/.test(await page.locator('.cell-output.is-colab .cell-error').textContent()));
await page.locator('.explain-scroll').evaluate((el) => {
  const target = el.querySelector('#explain-evaluation');
  el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/implement-colab-4-done-outputs.png` });
await page.locator('.explain-scroll').evaluate((el) => {
  const target = el.querySelector('#explain-datasets');
  el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/implement-colab-5-done-datasets.png` });

console.log('\n== opened again: the run is remembered ==');
await page.evaluate(() => {
  const saved = JSON.parse(localStorage.getItem('reader.settings') || '{}');
  localStorage.setItem('reader.settings', JSON.stringify({ ...saved, theme: 'dark' }));
});
await page.reload({ waitUntil: 'networkidle' });
{
  const notNow = page.getByRole('button', { name: /Start reading|Not now/i });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
}
await page.waitForSelector('.colab-panel', { timeout: 20000 });
await page.waitForFunction(() => /Done/.test(document.querySelector('.colab-panel .run-chip')?.textContent ?? ''), null, { timeout: 20000 });
await page.waitForTimeout(400);
check('the run comes back with the page', (await page.locator('.cell-output.is-colab').count()) === 3);
check('Claude was asked once', (await page.evaluate(() => window.__asked.length)) === 0);
await page.locator('.explain-scroll').evaluate((el) => {
  const target = el.querySelector('#explain-evaluation');
  el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/implement-colab-6-dark.png` });
await page.locator('.colab-panel').getByRole('button', { name: 'Forget this run' }).click();
await page.waitForTimeout(200);
check('Forget takes the panel and the outputs away, and leaves Drive alone', (await page.locator('.colab-panel').count()) === 0 && (await page.locator('.cell-output.is-colab').count()) === 0 && Boolean(byName('status.json')));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nall good');
process.exit(problems.length ? 1 : 0);
