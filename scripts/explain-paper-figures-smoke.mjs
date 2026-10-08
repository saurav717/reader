/**
 * The paper's own figures on the Explain page, and Copy on every snippet. A
 * paper with a figure in it is opened in Reflow; E, and the page is written
 * by a stand-in for api.anthropic.com that records what it was sent. The
 * request must carry the paper's figure as a picture and its name in
 * <paper_figures>; the page must draw it where the reply placed it, open it
 * close up, and every code block on the page — a cell, an output, a plain
 * snippet in the prose — must have a Copy that copies it. Photographed in
 * light and dark.
 *
 *   npm run build && npm start &
 *   node scripts/explain-paper-figures-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });

const TITLE = 'Attention Is All You Need';
const W = 1440;
const H = 900;

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const PAGE = `## At a glance
- Attention alone, no recurrence.
- Trains faster, translates better.

## The architecture
The model is an encoder stack and a decoder stack, both built from attention and feed-forward layers. In Figure 1 of the paper the encoder is on the left and the decoder on the right.

\`\`\`paper-figure ref="Figure 1" caption="The encoder (left) and decoder (right) stacks"
Read it bottom to bottom-up: inputs are embedded, pass **N** identical layers, and the decoder attends to the encoder's output.
\`\`\`

The shapes, as a plain block:

\`\`\`text
x: (batch, seq, d_model) = (32, 128, 512)
\`\`\`

\`\`\`python title="Scaled dot-product attention"
import numpy as np
np.random.seed(0)
q = np.random.randn(4, 8)
print((q @ q.T).shape)
\`\`\`
\`\`\`output
(4, 4)
\`\`\`

## Since then
Still the backbone of most large models.
`;

function sse(text, size = 240) {
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const body = [];
  body.push(event('message_start', { type: 'message_start', message: { id: 'msg_smoke', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9000, output_tokens: 1 } } }));
  body.push(event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  for (let i = 0; i < text.length; i += size) body.push(event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + size) } }));
  body.push(event('content_block_stop', { type: 'content_block_stop', index: 0 }));
  body.push(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6000 } }));
  body.push(event('message_stop', { type: 'message_stop' }));
  return body;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

console.log('\n== print a paper with a figure in it ==');
const printer = await browser.newPage();
const para = 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms. ';
const box = (x, y, label, fill) => `<rect x="${x}" y="${y}" width="150" height="46" rx="6" fill="${fill}" stroke="#222"/><text x="${x + 75}" y="${y + 28}" font-size="14" text-anchor="middle" font-family="sans-serif">${label}</text>`;
const FIGURE = `<svg width="440" height="300" viewBox="0 0 440 300" xmlns="http://www.w3.org/2000/svg">
  ${box(30, 30, 'Feed Forward', '#cde7f0')}${box(30, 110, 'Multi-Head Attn', '#f7dca6')}${box(30, 200, 'Input Embedding', '#f5c4c4')}
  ${box(260, 30, 'Feed Forward', '#cde7f0')}${box(260, 110, 'Masked Attn', '#f7dca6')}${box(260, 200, 'Output Embedding', '#f5c4c4')}
  <path d="M105 200 V156 M105 110 V76 M335 200 V156 M335 110 V76 M180 133 H260" stroke="#222" stroke-width="2" fill="none"/>
</svg>`;
await printer.setContent(
  `<!doctype html><html><body style="font-family: serif; font-size: 11pt; margin: 0.8in">
    <h1 style="text-align:center">${TITLE}</h1>
    <p style="text-align:center">Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit</p>
    <h3>Abstract</h3><p>${para.repeat(2)}</p>
    <h2>1. Introduction</h2>${`<p>${para.repeat(3)}</p>`.repeat(2)}
    <h2>3. Model Architecture</h2><p>${para.repeat(2)}</p>
    <div style="text-align:center; margin: 18px 0">${FIGURE}<p style="font-size: 10pt">Figure 1: The Transformer - model architecture.</p></div>
    <p>${para.repeat(3)}</p>
  </body></html>`,
);
const PDF = await printer.pdf({ format: 'Letter', printBackground: true });
await printer.close();

const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, permissions: ['clipboard-read', 'clipboard-write'] });
await context.route('**/pdf?*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }));
for (const host of ['api.crossref.org', 'api.semanticscholar.org', 'dblp.org', 'wikidata.org', 'api.openalex.org']) {
  await context.route(`**/${host}/**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[],"data":[],"message":{"items":[]},"result":{"hits":{}}}' }));
}
await context.route('**/scholar/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[]}' }));
await context.addInitScript(({ first }) => {
  const real = window.fetch.bind(window);
  window.__asked = [];
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('https://api.anthropic.com')) return real(input, init);
    window.__asked.push(JSON.parse(init?.body ?? '{}'));
    const stream = new ReadableStream({
      start(controller) {
        for (const event of first) controller.enqueue(new TextEncoder().encode(event));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_smoke' } });
  };
}, { first: sse(PAGE) });

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

console.log('\n== open the paper in Reflow ==');
const ago = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString();
const PAPER = { id: 'scholar:attention', source: 'scholar', title: TITLE, authors: ['Ashish Vaswani', 'Noam Shazeer'], abstract: '', published: '2017-06-12', categories: [], addedAt: ago(240), collectionIds: ['c-reading'], tags: [], progress: 0.1, lastOpenedAt: ago(2), pdfUrl: 'https://example.org/attention.pdf' };
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(async ({ paper }) => {
  localStorage.setItem('reader.welcomed', 'true');
  localStorage.setItem('reader.anthropic-key', 'sk-ant-smoke');
  localStorage.setItem('reader.explain.layout', 'margin');
  localStorage.setItem('reader.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('reader.settings') || '{}'), theme: 'light', readingMode: 'reflow' }));
  localStorage.setItem('reader.view', JSON.stringify({ kind: 'paper', id: paper.id }));
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('reader', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const put = (store, value) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  await put('collections', { id: 'c-reading', name: 'Reading list', color: '#2f7d6d', createdAt: new Date().toISOString() });
  await put('papers', paper);
  db.close();
}, { paper: PAPER });
await page.reload({ waitUntil: 'networkidle' });
const skip = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
if (await skip.isVisible().catch(() => false)) await skip.click();
await page.waitForSelector('.paper-body h2', { timeout: 30000 });
await page.waitForTimeout(500);
const reflowFigures = await page.locator('.paper-body figure img').count();
check('the Reflow column has the paper’s figure as a picture', reflowFigures >= 1, `${reflowFigures}`);

console.log('\n== E, and the page is written ==');
await page.mouse.move(W / 2, H / 2);
await page.keyboard.press('e');
await page.waitForSelector('.explain .explain-empty');
await page.getByRole('button', { name: 'Explain this paper' }).click();
await page.waitForSelector('.explain-section h2:text("Since then")', { timeout: 30000 });
await page.waitForTimeout(800);

const asked = await page.evaluate(() => window.__asked[0]);
const system = (asked?.system ?? []).map((block) => block.text).join('\n');
check('the request lists the paper’s figures by name', /<paper_figures>[\s\S]*Figure 1: The Transformer/.test(system));
const first = asked?.messages?.[0]?.content;
const images = Array.isArray(first) ? first.filter((part) => part.type === 'image') : [];
check('the request shows the model the figure itself', images.length === 1 && images[0].source.data.length > 1000, `${images.length} image(s)`);
check('each picture is named before it', Array.isArray(first) && /^Figure 1 of the paper/.test(first[0].text ?? ''));

const placed = page.locator('.explain-figure.is-paper');
check('the page draws the paper’s figure where the reply placed it', (await placed.count()) === 1);
const drawn = await placed.locator('img').evaluate((img) => img.complete && img.naturalWidth > 100).catch(() => false);
check('…as a picture that has loaded', drawn);
check('…named, with what to look at in it', /Figure 1 · from the paper/.test(await placed.locator('figcaption').innerText()) && /bottom-up/.test(await placed.locator('.paper-figure-note').innerText()));
await placed.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}explain-paper-figure.png` });

console.log('\n== close up ==');
await placed.locator('.figure-art').click();
await page.waitForSelector('.figure-closeup .closeup-art img', { timeout: 5000 }).catch(() => undefined);
check('a click opens it close up', (await page.locator('.figure-closeup .closeup-art img').count()) === 1);
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}explain-paper-figure-closeup.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

console.log('\n== Copy on every snippet ==');
const prose = page.locator('.explain-prose .prose-code');
check('a plain code block in the prose has a Copy button', (await prose.locator('button[data-copy-code]').count()) === 1);
await prose.scrollIntoViewIfNeeded();
await prose.hover();
await prose.locator('button[data-copy-code]').click();
await page.waitForTimeout(200);
check('…which copies the block', (await page.evaluate(() => navigator.clipboard.readText())).includes('(batch, seq, d_model)'));
check('…and says so', await prose.locator('button.is-done').count() === 1);
check('…without its label in the page’s text', !(await page.locator('.explain-prose').first().evaluate((el) => el.closest('.explain-section')?.textContent ?? '')).includes('Copy'));
await page.screenshot({ path: `${OUT}explain-prose-copy.png` });
const cell = page.locator('.explain-cell').first();
await cell.getByRole('button', { name: 'Copy', exact: true }).click();
await page.waitForTimeout(200);
check('a cell copies its code', (await page.evaluate(() => navigator.clipboard.readText())).includes('np.random.seed(0)'));
await cell.getByRole('button', { name: /Copy output/ }).click();
await page.waitForTimeout(200);
check('its expected output has a Copy of its own', (await page.evaluate(() => navigator.clipboard.readText())).trim() === '(4, 4)');

console.log('\n== kept, and in the dark ==');
await page.evaluate(() => {
  const saved = JSON.parse(localStorage.getItem('reader.settings') || '{}');
  localStorage.setItem('reader.settings', JSON.stringify({ ...saved, theme: 'dark' }));
});
await page.reload({ waitUntil: 'networkidle' });
if (await skip.isVisible().catch(() => false)) await skip.click();
await page.waitForSelector('.explain-figure.is-paper img', { timeout: 15000 }).catch(() => undefined);
check('the figure is drawn again after a reload, from what was kept', (await page.locator('.explain-figure.is-paper img').count()) === 1);
await page.locator('.explain-figure.is-paper').scrollIntoViewIfNeeded().catch(() => undefined);
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}explain-paper-figure-dark.png` });

check('no errors on the page', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s)` : '\nall good');
process.exit(problems.length ? 1 : 0);
