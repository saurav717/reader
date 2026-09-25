/**
 * Keeping pieces of the paper itself in your notes, however it is read. In
 * Reflow: a figure and a table by pointing at them, and a passage by selecting
 * it. The PDF in the browser's viewer offers to open it as a book, since
 * nothing can reach into that viewer; as a book, a passage is kept by
 * selecting it, and ✂ Snip (or S) outlines the figures and tables on the page
 * — a click keeps one whole, a table as a table — or keeps any box dragged.
 * The pictures are held in the notes, and survive a reload; a piece's label
 * shows it in the paper again. Each step is photographed.
 *
 *   npm run build && npm start &
 *   node scripts/paper-notes-smoke.mjs        # SMOKE_BASE=http://localhost:8080
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

/** A trace glides when it passes through places in between, rather than jumping from the one end to the other. */
const glides = (trace, from, to) => trace[0] === from && trace[trace.length - 1] === to && trace.filter((x) => x !== from && x !== to).length >= 3;

console.log('\n== print a paper with a figure and a table ==');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

const printer = await browser.newPage();
const para = 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely. ';
const figure = `
<div style="text-align:center;margin:18px 0">
<svg width="420" height="230" viewBox="0 0 420 230" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif" font-size="12">
  <rect x="20" y="150" width="110" height="40" fill="#fde2c0" stroke="#333"/><text x="75" y="175" text-anchor="middle">Q</text>
  <rect x="155" y="150" width="110" height="40" fill="#fde2c0" stroke="#333"/><text x="210" y="175" text-anchor="middle">K</text>
  <rect x="290" y="150" width="110" height="40" fill="#fde2c0" stroke="#333"/><text x="345" y="175" text-anchor="middle">V</text>
  <rect x="80" y="85" width="200" height="36" fill="#c9ddf2" stroke="#333"/><text x="180" y="108" text-anchor="middle">MatMul, Scale, Softmax</text>
  <rect x="200" y="20" width="200" height="36" fill="#cfe6d8" stroke="#333"/><text x="300" y="43" text-anchor="middle">MatMul</text>
  <line x1="75" y1="150" x2="140" y2="121" stroke="#333"/><line x1="210" y1="150" x2="200" y2="121" stroke="#333"/>
  <line x1="180" y1="85" x2="260" y2="56" stroke="#333"/><line x1="345" y1="150" x2="340" y2="56" stroke="#333"/>
</svg>
<p style="text-align:left">Figure 1: Scaled Dot-Product Attention. The queries and keys are multiplied, scaled by the square root of their dimension and passed through a softmax.</p>
</div>`;
const table = `
<p>Table 1: Maximum path lengths, per-layer complexity and minimum number of sequential operations for different layer types.</p>
<table style="border-collapse:collapse;width:100%;font-size:10pt;margin-bottom:18px">
<tr style="border-top:1.5px solid #000;border-bottom:1px solid #000"><td>Layer Type</td><td>Complexity per Layer</td><td>Sequential Operations</td><td>Maximum Path Length</td></tr>
<tr><td>Self-Attention</td><td>O(n² · d)</td><td>O(1)</td><td>O(1)</td></tr>
<tr><td>Recurrent</td><td>O(n · d²)</td><td>O(n)</td><td>O(n)</td></tr>
<tr><td>Convolutional</td><td>O(k · n · d²)</td><td>O(1)</td><td>O(log_k(n))</td></tr>
<tr style="border-bottom:1.5px solid #000"><td>Self-Attention (restricted)</td><td>O(r · n · d)</td><td>O(1)</td><td>O(n/r)</td></tr>
</table>`;
await printer.setContent(`<!doctype html><html><body style="font-family: serif; font-size: 11pt; margin: 0.8in">
  <h1 style="text-align:center">${TITLE}</h1>
  <p style="text-align:center">Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan N. Gomez, Łukasz Kaiser, Illia Polosukhin</p>
  <h3>Abstract</h3><p>${para.repeat(2)}</p>
  <section style="break-after: page"><h2>1. Introduction</h2><p>${para.repeat(3)}</p><p>${para.repeat(2)}</p></section>
  <section style="break-after: page"><h2>3. Model Architecture</h2><p>${para.repeat(2)}</p><h3>3.2 Attention</h3><p>An attention function can be described as mapping a query and a set of key-value pairs to an output, where the query, keys, values, and output are all vectors. The output is computed as a weighted sum of the values.</p>${figure}<p>${para.repeat(2)}</p></section>
  <section style="break-after: page"><h2>4. Why Self-Attention</h2><p>${para.repeat(1)}</p>${table}<p>${para.repeat(3)}</p></section>
</body></html>`);
const PDF = await printer.pdf({ format: 'Letter', printBackground: true });
await printer.close();

const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
await context.route('**/pdf?*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }));
for (const host of ['api.crossref.org', 'api.semanticscholar.org', 'dblp.org', 'wikidata.org', 'api.openalex.org']) {
  await context.route(`**/${host}/**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[],"data":[],"message":{"items":[]},"result":{"hits":{}}}' }));
}
await context.route('**/scholar/search*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [{ id: '2001', clusterId: '2001', title: TITLE, url: 'https://arxiv.org/abs/1706.03762', pdfUrl: 'https://example.org/attention.pdf', authors: ['A Vaswani', 'N Shazeer', 'N Parmar', 'J Uszkoreit'], year: 2017, snippet: 'The dominant sequence transduction models.' }] }) }));
await context.route('**/scholar/{authors,person,paper-authors,cluster}*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[]}' }));


const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();
const chips = page.locator('.discover-panel .chip');
for (let i = 0; i < (await chips.count()); i += 1) {
  const chip = chips.nth(i);
  const wanted = /Scholar/.test((await chip.textContent()) || '');
  if (wanted !== ((await chip.getAttribute('aria-pressed')) === 'true')) await chip.click();
}
await page.getByLabel('Search papers').fill('attention is all you need');
await page.getByLabel('Search papers').press('Enter');
await page.waitForSelector('article.result');
await page.locator('article.result h3').first().click();
await page.getByRole('button', { name: /Add to collection/i }).click();
await page.getByRole('button', { name: /^Read$/ }).click();
await page.locator('.segmented button', { hasText: 'Reflow' }).click({ timeout: 20000 });
await page.waitForSelector('.paper-body h2', { timeout: 30000 });
await page.waitForTimeout(800);

const shot = (name) => page.screenshot({ path: `${OUT}/paper-notes-${name}.png` });
const settle = (ms = 400) => page.waitForTimeout(ms);
const kept = async () => ((await page.locator('.note-kept').textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const notesOf = () => page.evaluate(async () => {
  const req = indexedDB.open('reader');
  const db = await new Promise((resolve) => { req.onsuccess = () => resolve(req.result); });
  const all = await new Promise((resolve) => { const r = db.transaction('kv').objectStore('kv').getAll(); r.onsuccess = () => resolve(r.result); });
  const keys = await new Promise((resolve) => { const r = db.transaction('kv').objectStore('kv').getAllKeys(); r.onsuccess = () => resolve(r.result); });
  const at = keys.findIndex((key) => String(key).startsWith('notes:'));
  return at < 0 ? [] : all[at].blocks;
});

// The library and the dock shut, so the page is all there is.
if (await page.locator('.app > .panel').count()) await page.getByRole('button', { name: 'Library', exact: true }).click();
// The Discover button shuts the dock when Discover is showing, and brings Discover up when the notes are.
for (let tries = 0; tries < 3 && (await page.locator('.dock').count()); tries += 1) {
  await page.getByRole('button', { name: 'Discover papers' }).click();
  await settle(500);
}
await settle(300);
check('the page has nothing either side of it', (await page.locator('.dock, .app > .panel').count()) === 0);

async function keepByPointing(selector, name, expect) {
  const target = page.locator(selector).first();
  await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await settle(300);
  const box = await target.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(40, box.height / 2));
  await settle(200);
  const shown = await page.locator('.note-clip-btn').isVisible();
  check(`pointing at ${name} puts “Add to notes” on its corner`, shown);
  if (!shown) return;
  await page.locator('.note-clip-btn').click();
  await page.waitForSelector('.note-kept', { timeout: 5000 }).catch(() => undefined);
  check(`${name} is kept, as “${expect}”`, (await kept()).startsWith(expect), await kept());
}

console.log('\n== Reflow: a figure, a table, a passage ==');
await keepByPointing('.paper-body figure.pdf-figure', 'the figure', 'Figure 1');
await shot('1-reflow-figure');
await keepByPointing('.paper-body figure.pdf-table', 'the table', 'Table 1');
const passageP = page.locator('.paper-body p').filter({ hasText: 'An attention function' }).first();
await passageP.evaluate((el) => el.scrollIntoView({ block: 'center' }));
await settle(300);
const pbox = await passageP.boundingBox();
await page.mouse.move(pbox.x + 3, pbox.y + 6);
await page.mouse.down();
await page.mouse.move(pbox.x + pbox.width * 0.7, pbox.y + pbox.height - 6, { steps: 8 });
await page.mouse.up();
await settle(300);
const reflowAdd = page.locator('.selection-toolbar').getByRole('button', { name: /Add to notes/ });
check('the selection toolbar has “Add to notes”', (await reflowAdd.count()) === 1);
await shot('2-reflow-selection');
await reflowAdd.click();
await settle(300);
check('the passage is kept', (await kept()).startsWith('Passage'));
let blocks = await notesOf();
check('three pieces, from the paper', blocks.length === 3 && blocks.every((b) => b.source.from === 'paper'), blocks.map((b) => b.label).join(' | '));
check('the figure’s picture is held in the note, not pointed at', /<img[^>]+src="data:image\/png/.test(blocks[0].html));
check('the table is a table', /<table/.test(blocks[1].html) && blocks[1].text.includes('| Self-Attention'), blocks[1].text.slice(0, 120));
check('each knows its section', blocks[0].source.section?.includes('Attention') && blocks[2].source.section?.includes('Attention'), `${blocks[0].source.section} / ${blocks[2].source.section}`);

console.log('\n== the PDF, in the browser’s viewer ==');
await page.locator('.segmented button', { hasText: 'PDF' }).click();
await page.waitForSelector('.pdf-frame', { timeout: 20000 });
await settle(600);
const asBook = page.getByRole('button', { name: 'Open it as a book' });
check('it says the viewer cannot be reached into, and offers the book', (await asBook.count()) === 1);
await asBook.click();
await page.waitForSelector('.pdf-book-page[data-text="ready"]', { timeout: 20000 });
await settle(800);

console.log('\n== the PDF as a book: a passage ==');
const span = page.locator('.pdf-book-page[data-page="2"] .pdf-text span', { hasText: 'An attention function' }).first();
const sbox = await span.boundingBox();
await page.mouse.move(sbox.x + 2, sbox.y + sbox.height / 2);
await page.mouse.down();
await page.mouse.move(sbox.x + sbox.width - 2, sbox.y + sbox.height / 2, { steps: 6 });
await page.mouse.up();
await settle(300);
const bookAdd = page.locator('.selection-toolbar').getByRole('button', { name: /Add to notes/ });
check('text selected on a page has “Add to notes”', (await bookAdd.count()) === 1);
await bookAdd.click();
await settle(300);
blocks = await notesOf();
check('the passage is kept, with its page', blocks.at(-1)?.label === 'Passage' && blocks.at(-1)?.source.page === 2, JSON.stringify(blocks.at(-1)?.source));

console.log('\n== ✂ Snip: a table, whole ==');
await page.keyboard.press('ArrowRight');
await settle(1200);
await page.keyboard.press('s');
await page.waitForSelector('.snip-layer', { timeout: 3000 });
await page.waitForSelector('.snip-region', { timeout: 10000 }).catch(() => undefined);
await settle(400);
check('S turns snipping on, and the figures and tables found are outlined', (await page.locator('.snip-region').count()) >= 1, `${await page.locator('.snip-region').count()} outlined`);
const regions = await page.locator('.snip-region').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
// The table is the widest box on page 3.
const biggest = regions.sort((a, b) => b.w * b.h - a.w * a.h)[0];
await page.mouse.move(biggest.x + biggest.w / 2, biggest.y + biggest.h / 2);
await settle(200);
const label = (await page.locator('.snip-region.is-hot .snip-region-label').textContent().catch(() => '')) || '';
check('pointing at it lights it and names it', /Table 1/.test(label), label);
await shot('3-snip-table');
await page.mouse.click(biggest.x + biggest.w / 2, biggest.y + biggest.h / 2);
await settle(400);
check('a click keeps it', (await kept()).startsWith('Table 1'), await kept());
blocks = await notesOf();
const snippedTable = blocks.at(-1);
check('as a table — rows and columns, not a picture', /<table/.test(snippedTable.html) && !/<img/.test(snippedTable.html) && (snippedTable.html.match(/<tr/g) || []).length >= 4, `${(snippedTable.html.match(/<tr/g) || []).length} rows`);
check('with its page', snippedTable.source.page === 3);

console.log('\n== ✂ Snip: any box ==');
const pageBox = await page.locator('.pdf-book-page[data-page="3"]').boundingBox();
await page.mouse.move(pageBox.x + pageBox.width * 0.1, pageBox.y + pageBox.height * 0.4);
await page.mouse.down();
await page.mouse.move(pageBox.x + pageBox.width * 0.9, pageBox.y + pageBox.height * 0.52, { steps: 10 });
await shot('4-snip-drag');
await page.mouse.up();
await settle(400);
check('a dragged box is kept', (await kept()).startsWith('Snip'), await kept());
blocks = await notesOf();
check('as a picture, with the words inside it', /<img[^>]+src="data:image\/png/.test(blocks.at(-1).html) && blocks.at(-1).text.length > 20, blocks.at(-1).text.slice(0, 80));
await page.keyboard.press('Escape');
await settle(200);
check('Esc puts the snip tool away', (await page.locator('.snip-layer').count()) === 0);

console.log('\n== in the notes ==');
await page.keyboard.press('h');
await page.waitForSelector('.notes-win .note-piece', { timeout: 5000 });
await settle(400);
const labels = await page.locator('.notes-win .note-piece-kind').allTextContents();
check('six pieces, as kept', labels.join(' | ') === 'Figure 1 | Table 1 | Passage | Passage | Table 1 | Snip', labels.join(' | '));
check('the figure shows its picture', await page.locator('.notes-win .note-piece').first().locator('.note-clip img').evaluate((img) => img.complete && img.naturalWidth > 50));
check('the snipped table shows as a table', (await page.locator('.notes-win .note-piece').nth(4).locator('.note-clip table tr').count()) >= 4);
check('labelled with the page', ((await page.locator('.notes-win .note-piece').nth(4).locator('.note-source').textContent()) || '').includes('p. 3'));
await shot('5-in-the-notes');

console.log('\n== back to where one came from ==');
await page.locator('.notes-win .note-piece').first().locator('.note-source').click();
await page.waitForSelector('.passage-flash', { timeout: 6000 }).catch(() => undefined);
check('the figure’s label finds it in the PDF, and turns to its page', (await page.locator('.passage-flash').count()) === 1 && (await page.locator('.pdf-book-page[data-page="2"]').count()) === 1);
await settle(500);
await shot('6-back-to-it');

console.log('\n== after a reload ==');
await page.reload({ waitUntil: 'networkidle' });
const notNow = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
if (await notNow.isVisible().catch(() => false)) await notNow.click();
await page.waitForSelector('.main :is(.pdf-book, .pdf-frame, .paper-body)', { state: 'attached', timeout: 20000 });
await settle(800);
await page.mouse.move(W / 2, H / 2);
await page.keyboard.press('h');
await page.waitForSelector('.note-piece', { timeout: 5000 });
await settle(400);
check('the pieces are all there', (await page.locator('.note-piece').count()) === 6);
check('and the figure’s picture still shows, though the paper was closed', await page.locator('.note-piece').first().locator('.note-clip img').evaluate((img) => img.complete && img.naturalWidth > 50));

check('no errors on the page', errors.length === 0, errors.join('\n'));
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log('\nall good');
