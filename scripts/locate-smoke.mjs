/**
 * "Show me where in this paper the authors talk about oracle selection."
 * Ask Claude answers with a `passages` block; the reader scrolls the paper to
 * the passage and marks it, with a caption saying what it is. Tried in
 * Reflow (scrolled), in the PDF set as a book (the page turned to, the text
 * layer marked), and in the browser's own PDF viewer (the page only).
 *
 * Claude is a stand-in inside the page that streams a fixed answer; the
 * finding is real.
 *
 *   npm run build && npm start &
 *   node scripts/locate-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });

const TITLE = 'Fusion approaches to predict post-stroke aphasia severity from multimodal neuroimaging data';
const QUESTION = 'Show me where in this paper the authors talk about "Oracle Selection"';
const SENTENCE =
  'We refer to choosing the best feature set by its score on the test patients as oracle selection, which gives an upper bound on what any selection rule could achieve.';
const ANSWER = [
  'The authors bring it up in **Section 3.3 (Feature selection)**, where they separate the feature set a fair rule would choose from the one chosen by looking at the test scores — [they call the latter oracle selection](passage:1). It is used only as an upper bound, not as a result.',
  '',
  '```passages',
  JSON.stringify({ quote: 'choosing the best feature set by its score on the test patients as oracle selection, which gives an upper bound', label: 'Where the authors define “oracle selection”', section: '3.3 Feature selection', page: 3, show: true }),
  JSON.stringify({ quote: 'the gap between the nested selection and the oracle is small for Late Fusion', label: 'How close a fair selection gets to the oracle', section: '4. Results', page: 4 }),
  '```',
].join('\n');

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(label);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

function sse(text, size = 120) {
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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

console.log('\n== print the paper ==');
const printer = await browser.newPage();
const filler = (topic) => `<p>${`Post-stroke aphasia varies widely between patients, and ${topic} is one of the questions this study sets out to answer with multimodal imaging. `.repeat(5)}</p>`;
await printer.setContent(
  `<!doctype html><html><body style="font-family: serif; font-size: 11pt; margin: 0.8in">
    <h1 style="text-align:center; font-size: 18pt">${TITLE}</h1>
    <p style="text-align:center">Saurav Chennuri, Sha Lai, Anne Billot, Maria Varkanitsa, Emily J. Braun, Swathi Kiran</p>
    <h3>Abstract</h3>${filler('prognosis')}
    <section style="break-before: page"><h2>1. Introduction</h2>${filler('recovery').repeat(3)}<h2>2. Data</h2>${filler('the imaging').repeat(2)}</section>
    <section style="break-before: page"><h2>3. Methods</h2>${filler('fusion').repeat(2)}
      <h3>3.3 Feature selection</h3>
      <p>Each fusion approach is given the feature sets chosen on the training folds only. ${SENTENCE} We report it for comparison and never use it to pick a model.</p>
      ${filler('selection')}</section>
    <section style="break-before: page"><h2>4. Results</h2>${filler('accuracy')}<p>Across the cross-validation folds, the gap between the nested selection and the oracle is small for Late Fusion, and larger for Early Fusion.</p>${filler('error')}</section>
  </body></html>`,
);
const PDF = await printer.pdf({ format: 'Letter', printBackground: true });
await printer.close();

const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await context.route('**/pdf?*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }));
for (const host of ['api.crossref.org', 'api.semanticscholar.org', 'dblp.org', 'wikidata.org', 'api.openalex.org', 'api.unpaywall.org']) {
  await context.route(`**/${host}/**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[],"data":[],"message":{"items":[]},"result":{"hits":{}}}' }));
}
await context.route('**/scholar/search*', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ results: [{ id: '3001', clusterId: '3001', title: TITLE, url: 'https://example.org/fusion', pdfUrl: 'https://example.org/fusion.pdf', authors: ['S Chennuri', 'S Lai', 'A Billot'], year: 2023, snippet: 'Post-stroke aphasia.' }] }),
  }),
);
await context.route('**/scholar/{authors,person,paper-authors,cluster}*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[]}' }));
await context.addInitScript((events) => {
  const real = window.fetch.bind(window);
  window.__asked = [];
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('https://api.anthropic.com')) return real(input, init);
    window.__asked.push(JSON.parse(init?.body ?? '{}'));
    return new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(e)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  localStorage.setItem('reader.anthropic-key', 'sk-ant-smoke');
}, sse(ANSWER));

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

console.log('\n== open the paper in Reflow ==');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();
const chips = page.locator('.discover-panel .chip');
for (let index = 0; index < (await chips.count()); index += 1) {
  const chip = chips.nth(index);
  const wanted = /Scholar/.test((await chip.textContent()) || '');
  if (wanted !== ((await chip.getAttribute('aria-pressed')) === 'true')) await chip.click();
}
await page.getByLabel('Search papers').fill('fusion aphasia');
await page.getByLabel('Search papers').press('Enter');
await page.waitForSelector('article.result');
await page.locator('article.result h3').first().click();
await page.getByRole('button', { name: /Add to collection/i }).click();
await page.getByRole('button', { name: /^Read$/ }).click();
await page.locator('.segmented button', { hasText: 'Reflow' }).click({ timeout: 20000 });
await page.waitForSelector('.paper-body h2', { timeout: 30000 });
await page.waitForTimeout(600);
const before = await page.locator('.reader-scroll').evaluate((el) => el.scrollTop);

console.log('\n== ask where ==');
await page.keyboard.press('Control+Backslash');
const box = page.getByRole('textbox', { name: 'Ask Claude' });
await box.waitFor();
// The window to the right, clear of the reading column.
await box.fill(QUESTION);
await box.press('Enter');
await page.waitForSelector('.chat-passages', { timeout: 15000 });
await page.waitForSelector('.passage-band', { timeout: 10000 });
await page.waitForTimeout(1200);
const asked = await page.evaluate(() => window.__asked.at(-1));
check('Claude is told how to point at passages', /```passages/.test(asked.system.map((b) => b.text).join('\n')));
check('the answer lists the passages it found', (await page.locator('.chat-passage-row').count()) === 2);
check('the raw block is not in the answer', !(await page.locator('.chat-claude .chat-text').textContent()).includes('"quote"'));
const after = await page.locator('.reader-scroll').evaluate((el) => el.scrollTop);
check('the paper scrolled to it by itself', after > before + 200, `${before} → ${after}`);
const band = await page.locator('.passage-band').first().boundingBox();
const marked = await page.evaluate(({ x, y }) => document.elementsFromPoint(x, y).map((el) => el.textContent ?? '').find((text) => text.includes('oracle selection')), { x: band.x + band.width / 2, y: band.y + band.height / 2 });
check('the mark lies over the passage', Boolean(marked));
check('with the caption Claude gave it', /Where the authors define “oracle selection”/.test(await page.locator('.passage-tag').textContent()));
check('and where it is', /3\.3 Feature selection/.test(await page.locator('.passage-tag').textContent()));
check('the row says it was shown', /Shown in the paper/.test(await page.locator('.chat-passage-row').first().textContent()));
await page.screenshot({ path: `${OUT}/locate-1-reflow.png` });

console.log('\n== it goes by itself, and comes back on a click ==');
await page.waitForSelector('.passage-flash', { state: 'detached', timeout: 15000 });
check('the mark is temporary', (await page.locator('.passage-band').count()) === 0);
await page.locator('.chat-passage').first().click();
await page.waitForSelector('.passage-band', { timeout: 5000 });
check('a link in the answer shows it again', (await page.locator('.passage-band').count()) >= 1);
await page.locator('.passage-tag button').click();
check('the caption’s × clears it', (await page.locator('.passage-band').count()) === 0);
await page.locator('.chat-passage-row').nth(1).click();
await page.waitForSelector('.passage-tag', { timeout: 5000 });
check('the second passage can be shown too', /How close a fair selection gets/.test(await page.locator('.passage-tag').textContent()));
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/locate-2-second.png` });

console.log('\n== the PDF set as a book ==');
await page.locator('.passage-tag button').click().catch(() => undefined);
await page.locator('.segmented button', { hasText: 'PDF' }).evaluate((button) => button.click());
await page.waitForSelector('.pdf-pane iframe', { timeout: 30000 });
await page.getByRole('button', { name: /Read as a book/i }).evaluate((button) => button.click());
await page.waitForSelector('.pdf-book-page[data-text="ready"]', { timeout: 30000 });
await page.locator('.chat-passage-row').first().click();
await page.waitForSelector('.passage-band', { timeout: 10000 });
await page.waitForTimeout(900);
const folio = await page.locator('.book-folio').textContent();
check('the book turned to the page', /Pages? 3/.test(folio), folio);
check('the text layer is marked', (await page.locator('.passage-band').count()) >= 1);
const bookBand = await page.locator('.passage-band').last().boundingBox();
const under = await page.evaluate(({ x, y }) => {
  const layer = document.querySelector('.pdf-book-page[data-page="3"] .pdf-text');
  const spans = [...(layer?.querySelectorAll('span') ?? [])].filter((span) => {
    const r = span.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  });
  return spans.map((span) => span.textContent).join(' ');
}, { x: bookBand.x + 30, y: bookBand.y + bookBand.height / 2 });
check('the mark lies over the quoted words on the page', /feature set|oracle/.test(under), under);
check('the row names the page', /Shown in the paper|page 3/.test(await page.locator('.chat-passage-row').first().textContent()));
await page.screenshot({ path: `${OUT}/locate-3-pdf-book.png` });

console.log('\n== the browser’s own PDF viewer: the page only ==');
// The mark may have faded by itself already.
if (await page.locator('.passage-tag').isVisible()) await page.locator('.passage-tag button').click();
// The top bar's switch can sit under the Claude window; press it directly.
await page.getByRole('button', { name: /Read as one scrolling page/i }).evaluate((button) => button.click());
await page.waitForSelector('.pdf-pane iframe', { timeout: 30000 });
await page.locator('.chat-passage-row').first().click();
await page.waitForSelector('.passage-tag', { timeout: 10000 });
const src = await page.locator('.pdf-pane iframe').getAttribute('src');
check('the viewer is sent to the page', /#page=3$/.test(src || ''), src);
check('the caption says which page', /page 3/.test(await page.locator('.passage-tag').textContent()));
check('the row says only the page could be shown', /Shown: page 3/.test(await page.locator('.chat-passage-row').first().textContent()));
await page.screenshot({ path: `${OUT}/locate-4-pdf-viewer.png` });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nall good');
process.exit(problems.length ? 1 : 0);
