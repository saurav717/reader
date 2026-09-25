/**
 * The ways of seeing a paper's notes, and stickies on its PDF. The View menu
 * in the notes pane switches between List, Document (with its / menu), By
 * section (Cornell: cues, notes, summary), and Jots (a line at a time, each
 * keeping its page and section); B opens the Board, the notes full screen,
 * where a card is dragged without the list's order changing, the board is
 * tidied by section, and a double-click writes a new note. On the PDF as a
 * book, M (or 📌 Pin) and a click, or a double-click, pins a sticky to the
 * page — with two pages side by side, and one. Each step is photographed.
 *
 *   npm run build && npm start &
 *   node scripts/notes-views-smoke.mjs        # SMOKE_BASE=http://localhost:8080
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


const shot = (name) => page.screenshot({ path: `${OUT}/views-${name}.png` });
await page.waitForTimeout(600);

// Two highlights, made the way a reader makes them.
async function highlight(text, key) {
  const p = page.locator('.paper-body p').filter({ hasText: text }).first();
  await p.scrollIntoViewIfNeeded();
  const box = await p.boundingBox();
  await page.mouse.move(box.x + 4, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + 40, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector('.selection-toolbar');
  await page.keyboard.press(key);
  await page.waitForTimeout(400);
}
await highlight('An attention function', '1');
await highlight('The dominant sequence transduction', '2');

// Notes of every kind, put straight into the store: writing, a figure and a
// table kept from the paper, a question, a key point, summaries, jots.
const paperId = await page.evaluate(async (title) => {
  const db = await new Promise((resolve) => { const r = indexedDB.open('reader', 1); r.onsuccess = () => resolve(r.result); });
  const papers = await new Promise((resolve) => { const r = db.transaction('papers').objectStore('papers').getAll(); r.onsuccess = () => resolve(r.result); });
  db.close();
  return papers.find((paper) => paper.title === title)?.id;
}, TITLE);
check('the paper is in the library', Boolean(paperId), paperId);
const figurePicture = await page.evaluate(() => {
  const img = document.querySelector('.paper-body figure img, .paper-body img');
  if (!img) return null;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return c.toDataURL('image/png');
});
await page.evaluate(async ({ paperId, figure }) => {
  const at = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
  const text = (id, md, minutes, extra = {}) => ({ id, kind: 'text', md, at: at(minutes), ...extra });
  const clip = (id, label, html, words, section, page, minutes, note) => ({ id, kind: 'clip', label, html, text: words, note, source: { from: 'paper', section, page }, at: at(minutes) });
  const intro = { from: 'paper', section: '1. Introduction' };
  const attention = { from: 'paper', section: '3.2 Attention' };
  const blocks = [
    text('t1', '## My take\nReplaces recurrence with attention everywhere — every token sees every other in **one step**, so training parallelises.\n\n- [x] Why divide by $\\sqrt{d_k}$\n- [ ] Read about RoPE vs sinusoidal', 60),
    text('t2', 'Recurrence is sequential: can\'t parallelise within a sequence, long paths between distant words.', 55, { source: intro }),
    text('t3', 'Why not RNNs?', 54, { tag: 'question', source: intro }),
    clip('c1', 'Passage', '<blockquote><p>An attention function can be described as mapping a query and a set of key-value pairs to an output…</p></blockquote>', 'An attention function can be described as mapping a query and a set of key-value pairs to an output', '3.2 Attention', 2, 50),
    text('t4', 'Q, K, V?', 49, { tag: 'question', source: attention }),
    text('t5', 'Output = weighted sum of values; weights = softmax of query·key similarity.', 48, { source: attention }),
    figure ? clip('c2', 'Figure 1', `<figure><img src="${figure}" alt=""><figcaption>Figure 1: Scaled Dot-Product Attention.</figcaption></figure>`, 'Figure 1: Scaled Dot-Product Attention.', '3.2 Attention', 2, 45, 'The whole idea in one picture: two matmuls around a softmax.') : null,
    text('t6', 'Attention is a soft, differentiable lookup table.', 44, { tag: 'summary', source: attention }),
    clip('c3', 'Table 1', '<table><tr><th>Layer</th><th>Per layer</th><th>Seq.</th><th>Path</th></tr><tr><td>Self-Attention</td><td>O(n²·d)</td><td>O(1)</td><td>O(1)</td></tr><tr><td>Recurrent</td><td>O(n·d²)</td><td>O(n)</td><td>O(n)</td></tr><tr><td>Convolutional</td><td>O(k·n·d²)</td><td>O(1)</td><td>O(logₖ n)</td></tr></table>', '| Layer | Per layer |', '4. Why Self-Attention', 3, 40),
    text('t7', 'Self-attention wins on path length, loses on cost when n ≫ d.', 39, { tag: 'key', source: { from: 'paper', section: '4. Why Self-Attention', page: 3 } }),
  ].filter(Boolean);
  const db = await new Promise((resolve) => { const r = indexedDB.open('reader', 1); r.onsuccess = () => resolve(r.result); });
  await new Promise((resolve) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ blocks, updated: new Date().toISOString() }, `notes:${paperId}`); tx.oncomplete = resolve; });
  db.close();
}, { paperId, figure: figurePicture });
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click({ timeout: 4000 }).catch(() => undefined);
await page.waitForSelector('.paper-body h2', { timeout: 30000 });
if (!(await page.locator('.dock .notes-paper').count())) await page.keyboard.press('h');
await page.waitForSelector('.dock .notes-paper', { timeout: 5000 });
await page.locator('.dock .notes-tabs').getByRole('tab', { name: /^Notes/ }).click();
// The section on the screen: 3.2 Attention.
await page.locator('.paper-body h3, .paper-body h2').filter({ hasText: 'Attention' }).last().evaluate((heading) => heading.scrollIntoView({ block: 'start' }));
await page.waitForTimeout(600);

console.log('\n== the View menu ==');
await page.locator('.dock .notes-view-btn').click();
const items = await page.locator('.dock .notes-view-menu [role=menuitemradio] .notes-view-name').allTextContents();
check('it offers every view', items.join('|') === 'List|Document|By section|Jots|Board ⤢', items.join('|'));
await shot('0-menu');

console.log('\n== Document ==');
await page.locator('.dock .notes-view-menu').getByText('Document', { exact: true }).click();
await page.waitForSelector('.dock .notes-doc');
await page.waitForTimeout(500);
check('writing is drawn: a heading and a checklist, one box ticked', (await page.locator('.dock .doc-shown h5').count()) >= 1 && (await page.locator('.dock .doc-check.is-done').count()) === 1);
check('kept pieces sit in among it', (await page.locator('.dock .doc-clip').count()) >= 2);
await page.locator('.dock .doc-box').nth(1).click();
await page.waitForTimeout(200);
check('ticking a box ticks it in the note', (await page.locator('.dock .doc-check.is-done').count()) === 2);
await shot('1-document');
await page.locator('.dock .doc-more').click();
await page.waitForTimeout(200);
await page.keyboard.type('/');
await page.waitForSelector('.dock .doc-menu');
await page.waitForTimeout(200);
check('/ opens the menu', (await page.locator('.dock .doc-menu button').count()) >= 6);
await shot('2-slash');
await page.keyboard.type('chec');
await page.keyboard.press('Enter');
await page.keyboard.type('Compare with Longformer');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check('a checklist line was started', (await page.locator('.dock .doc-check', { hasText: 'Compare with Longformer' }).count()) === 1, await page.locator('.dock .doc-check').last().textContent());
await page.locator('.dock .doc-more').click();
await page.keyboard.type('/high');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
check('/ Highlight drops one of the highlights in', (await page.locator('.dock .doc-clip', { hasText: 'Highlight' }).count()) === 1);

console.log('\n== By section ==');
await page.locator('.dock .notes-view-btn').click();
await page.locator('.dock .notes-view-menu').getByText('By section', { exact: true }).click();
await page.waitForSelector('.dock .notes-sections');
await page.waitForTimeout(500);
const names = await page.locator('.dock .sec-name > span:first-child').allTextContents();
check('a block to each section, in order', names[0] === '1. Introduction' && names.includes('3.2 Attention') && names[names.length - 1] === 'Whole paper', names.join(' | '));
check('questions are the cues', (await page.locator('.dock .sec', { hasText: '3.2 Attention' }).first().locator('.sec-cues textarea').first().inputValue()) === 'Q, K, V?');
check('the summary under the notes', (await page.locator('.dock .sec', { hasText: '3.2 Attention' }).first().locator('.sec-summary textarea').first().inputValue()).startsWith('Attention is a soft'));
check('the section being read is marked', (await page.locator('.dock .sec.is-here .sec-name').first().textContent())?.includes('Reading now'));
await shot('3-sections');

console.log('\n== Jots ==');
await page.locator('.dock .notes-view-btn').click();
await page.locator('.dock .notes-view-menu').getByText('Jots', { exact: true }).click();
await page.waitForSelector('.dock .jots-compose textarea');
await page.locator('.dock .jots-compose textarea').click();
await page.waitForTimeout(200);
const where = (await page.locator('.dock .jots-toggle').first().textContent()) || '';
check('the jot knows where it is being written', /Attention/.test(where), where);
await page.locator('.dock .jots-toggle', { hasText: 'question' }).click();
await page.locator('.dock .jots-compose textarea').fill('Is multi-head just an ensemble of small attentions?');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
const lastJot = page.locator('.dock .jot').last();
check('Enter keeps it, as a question, with its section', /ensemble/.test((await lastJot.textContent()) || '') && /Attention/.test((await lastJot.locator('.jot-chip').textContent()) || '') && /question/.test((await lastJot.textContent()) || ''));
await page.locator('.dock .jots-compose textarea').fill('O(n/r) path length — a trade: shorter reach for linear cost');
await shot('4-jots');
await page.locator('.dock .jots-compose textarea').fill('');

console.log('\n== the Board ==');
await page.locator('.paper-body').click({ position: { x: 5, y: 5 } });
const count = await page.evaluate((id) => new Promise((resolve) => { const r = indexedDB.open('reader', 1); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get(`notes:${id}`); q.onsuccess = () => resolve(q.result.blocks.map((b) => b.id)); }; }), paperId);
await page.keyboard.press('b');
await page.waitForSelector('.notes-board .board-card:not(.is-unplaced)', { timeout: 5000 });
await page.waitForTimeout(800);
check('B opens every piece as a card', (await page.locator('.notes-board .board-card:not(.is-unplaced)').count()) === count.length, `${await page.locator('.notes-board .board-card').count()} of ${count.length}`);
await page.locator('.notes-board .board-tools').getByRole('button', { name: /Tidy by section/ }).click();
await page.waitForTimeout(600);
check('Tidy puts them in columns under their sections', (await page.locator('.notes-board .board-label').count()) >= 3);
await shot('5-board');
const card = page.locator('.notes-board .board-card', { hasText: 'Figure 1' }).first();
const before = await card.boundingBox();
const head = await card.locator('.board-card-head').boundingBox();
await page.mouse.move(head.x + 60, head.y + 8);
await page.mouse.down();
await page.mouse.move(head.x + 260, head.y + 120, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(500);
const after = await card.boundingBox();
check('a card is moved by its bar', Math.abs(after.x - before.x) > 100, `${Math.round(before.x)} → ${Math.round(after.x)}`);
const order = await page.evaluate((id) => new Promise((resolve) => { const r = indexedDB.open('reader', 1); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get(`notes:${id}`); q.onsuccess = () => resolve(q.result.blocks.map((b) => b.id)); }; }), paperId);
check('the list keeps its own order', order.join() === count.join());
const box = await page.locator('.notes-board .board-wrap').boundingBox();
// A bare spot on the board, clear of every card.
const spot = await page.evaluate(() => {
  const wrap = document.querySelector('.notes-board .board-wrap').getBoundingClientRect();
  for (let y = wrap.bottom - 260; y > wrap.top + 60; y -= 40) {
    for (let x = wrap.right - 420; x > wrap.left + 40; x -= 40) {
      const clear = [[0, 0], [300, 0], [0, 140], [300, 140]].every(([dx, dy]) => document.elementFromPoint(x + dx, y + dy)?.classList.contains('board-wrap'));
      if (clear) return { x, y };
    }
  }
  return { x: wrap.right - 420, y: wrap.bottom - 260 };
});
await page.mouse.dblclick(spot.x, spot.y);
await page.waitForTimeout(300);
await page.keyboard.type('Big picture: attention replaces recurrence AND convolution.');
await page.waitForTimeout(300);
check('a double-click writes a new note there', (await page.locator('.notes-board .board-card', { hasText: 'Big picture' }).count()) === 1 || (await page.locator('.notes-board textarea').evaluateAll((areas) => areas.some((a) => a.value.includes('Big picture')))));
await page.locator('.notes-board .board-card').filter({ hasText: 'Figure 1' }).first().click({ position: { x: 20, y: 40 } });
await shot('6-board-moved');
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check('Esc closes it', (await page.locator('.notes-board').count()) === 0);

console.log('\n== stickies on the PDF ==');
await page.locator('.segmented button', { hasText: 'PDF' }).first().click();
await page.waitForTimeout(800);
if (!(await page.locator('.pdf-book').count())) await page.getByRole('button', { name: /Read as a book/ }).click();
await page.waitForSelector('.pdf-book-page[data-text=ready]', { timeout: 30000 });
await page.waitForTimeout(600);
// The notes out of the way, in their window, for the pages to be seen whole.
if (await page.locator('.notes-win').count()) await page.locator('.notes-win').getByRole('button', { name: /Close the notes/ }).click();
if (await page.locator('.dock .notes-rail').count()) await page.keyboard.press('h');
await page.waitForTimeout(600);
await page.keyboard.press('m');
await page.waitForSelector('.pin-hint');
check('M: pin mode, and says so', (await page.locator('.pin-hint').count()) === 1);
const left = await page.locator('.pdf-book-page').first().boundingBox();
await page.mouse.click(left.x + left.width * 0.1, left.y + left.height * 0.3);
await page.waitForSelector('.pdf-sticky textarea');
await page.keyboard.type('Main claim, in one line: attention is all you need — no recurrence at all.');
await page.keyboard.press('Escape');
const right = await page.locator('.pdf-book-page').nth(1).boundingBox();
await page.mouse.dblclick(right.x + right.width * 0.55, right.y + right.height * 0.62);
await page.waitForTimeout(300);
await page.keyboard.type('The figure to remember: MatMul → scale → softmax → MatMul.');
await page.keyboard.press('Escape');
await page.locator('.pdf-sticky').last().hover();
await page.locator('.pdf-sticky').last().getByRole('button', { name: 'Green' }).click();
await page.mouse.click(right.x + right.width * 0.9, right.y + 30);
await page.mouse.dblclick(right.x + right.width * 0.2, right.y + right.height * 0.2);
await page.waitForTimeout(300);
await page.keyboard.type('Why √d? Softmax saturates for large d_k → vanishing gradients');
await page.locator('.pdf-sticky:focus-within').hover();
await page.locator('.pdf-sticky:focus-within').getByRole('button', { name: 'Blue' }).click();
check('a sticky takes the colour picked', (await page.locator('.pdf-sticky.is-green').count()) === 1 && (await page.locator('.pdf-sticky.is-blue').count()) === 1);
await page.waitForTimeout(400);
check('three stickies, numbered, on their pages', (await page.locator('.pdf-pin').allTextContents()).join() === '1,2,3', (await page.locator('.pdf-pin').allTextContents()).join());
await shot('7-stickies-book');
await page.locator('.book-nav').getByRole('button', { name: '1 page' }).click();
await page.waitForTimeout(1200);
check('one page at a time', (await page.locator('.pdf-book-page').count()) === 1);
check('the page\'s sticky on it', (await page.locator('.pdf-sticky').count()) === 1);
await page.keyboard.press('h');
await page.waitForTimeout(900);
if (await page.locator('.notes-view-btn').count()) {
  await page.locator('.notes-view-btn').first().click();
  await page.locator('.notes-view-menu').getByText('List', { exact: true }).click();
}
await page.waitForTimeout(400);
check('a sticky is a note like any other, in the list', (await page.locator('.note-piece.is-sticky').count()) === 3);
await shot('8-stickies-page');
await page.locator('.book-nav').getByRole('button', { name: '2 pages' }).click();

check('no page errors', !errors.length, errors.join(' | '));
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll good.');
