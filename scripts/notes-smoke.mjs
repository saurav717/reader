/**
 * The notes beside the page, and in a window of their own. With the library
 * and the dock shut, H slides the highlights and notes in from the right and
 * the text glides left to make room, and back again; in zen mode the same.
 * Over a PDF the page is not moved: the notes open in a window that floats
 * over it, as Ask Claude does, moved with ⌘ + arrows and snapped with
 * ⌘⇧ + arrows — and with Ask Claude open too, only the window in front
 * moves. The dock's pop-out button lifts the notes into the window, and the
 * window's dock button puts them back. ⌘⇧\ opens and closes them as H
 * does, and while typing too. Each step is photographed.
 *
 *   npm run build && npm start &
 *   node scripts/notes-smoke.mjs        # SMOKE_BASE=http://localhost:8080
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

const shot = (name) => page.screenshot({ path: `${OUT}/notes-${name}.png` });
const column = () => page.evaluate(() => { const r = document.querySelector('.reader-column')?.getBoundingClientRect(); return r ? Math.round(r.left) : null; });

// Two highlights, one with a note, so the notes have something in them.
async function highlight(text, key, note) {
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
  if (note) {
    const area = page.locator('.notes-rail textarea').first();
    await area.fill(note);
    await area.blur();
  }
}
await highlight('An attention function', 'n', 'Attention = weighted sum of values; weights come from query·key similarity. Compare with the √d scaling later.');
await highlight('The dominant sequence transduction', '2');
await page.waitForTimeout(300);

/** Every animation and transition held at `ms`, so the frame mid-slide can be photographed. */
async function holdAt(ms) {
  await page.evaluate((ms) => document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ms; }), ms);
  await page.waitForTimeout(250);
}
const release = () => page.evaluate(() => document.getAnimations().forEach((a) => a.play()));
/** Where the text column is, frame by frame, while the slide plays. */
async function trace(press) {
  await page.evaluate(() => {
    window.__trace = [];
    const t0 = performance.now();
    const step = () => {
      const r = document.querySelector('.reader-column')?.getBoundingClientRect();
      window.__trace.push([Math.round(performance.now() - t0), r ? Math.round(r.left) : null]);
      if (performance.now() - t0 < 520) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  await press();
  await page.waitForTimeout(700);
  return page.evaluate(() => window.__trace.map(([, x]) => x));
}




const rectOf = (sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }, sel);
const mod = 'Control';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const beside = () => page.evaluate(() => document.querySelector('.app').classList.contains('notes-beside'));
const settle = () => page.waitForTimeout(700);

console.log('\n== with nothing either side, the notes slide in and the text makes room ==');
if (await page.locator('.app > .panel').count()) await page.getByRole('button', { name: 'Library', exact: true }).click();
if (await page.locator('.dock').count()) await page.getByRole('button', { name: 'Highlights and notes', exact: true }).click();
await settle();
await page.locator('.paper-body p').filter({ hasText: 'An attention function' }).first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
await page.mouse.move(700, 500);
const alone = await column();
let path = await trace(() => page.keyboard.press('h'));
const room = await column();
check('H opens the dock', (await page.locator('.dock').count()) === 1);
check('the text moves left', room < alone, `${alone} → ${room}`);
check('smoothly, through the places in between', glides(path, alone, room), path.join(' '));
path = await trace(() => page.keyboard.press('h'));
check('H again slides it back, smoothly', glides(path, room, alone), path.join(' '));
check('and the dock is gone', (await page.locator('.dock').count()) === 0);
await shot('1-before');
await page.keyboard.press('h');
await page.waitForTimeout(30);
await holdAt(140);
await shot('2-mid');
await release();
await settle();
await shot('3-after');
await page.keyboard.press('h');
await settle();

console.log('\n== in zen mode, the same ==');
await page.keyboard.press('z');
await settle();
await page.mouse.move(700, 500);
const zenAlone = await column();
await shot('4-zen-before');
path = await trace(() => page.keyboard.press('h'));
const zenRoom = await column();
check('the notes stay out beside the page', await beside());
check('the text glides left to make room', zenRoom < zenAlone && glides(path, zenAlone, zenRoom), path.join(' '));
check('the right edge does not bring a second copy out over it', await page.locator('.zen-edge[data-side="right"]').evaluate((el) => getComputedStyle(el).pointerEvents === 'none'));
path = await trace(() => page.keyboard.press('h'));
check('H puts them away, and the text glides back', glides(path, zenRoom, zenAlone), path.join(' '));
await page.keyboard.press('h');
await page.waitForTimeout(30);
await holdAt(140);
await shot('5-zen-mid');
await release();
await settle();
await page.mouse.move(700, 500);
await shot('6-zen-after');
await page.keyboard.press('h');
await settle();
await page.keyboard.press('z');
await settle();
check('closed in zen, they stay closed out of it', (await page.locator('.dock').count()) === 0);

console.log('\n== over the PDF, the notes float and the page stays ==');
await page.locator('.segmented button', { hasText: 'PDF' }).click();
await page.waitForTimeout(1200);
const bookBtn = page.getByRole('button', { name: 'Read as a book, two pages side by side' });
if (await bookBtn.count()) await bookBtn.click();
await page.waitForSelector('.pdf-book-page', { timeout: 20000 });
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(1500);
await page.keyboard.press('z');
await page.waitForTimeout(1200);
await page.mouse.move(700, 500);
const pages = await rectOf('.pdf-book-pages');
await shot('7-pdf-before');
await page.keyboard.press('h');
await settle();
check('H opens the notes in a window', (await page.locator('.notes-win').count()) === 1);
check('not beside the page', !(await beside()));
check('the PDF does not move', same(pages, await rectOf('.pdf-book-pages')));
await shot('8-pdf-window');
const placed = await rectOf('.notes-win');
await page.keyboard.down(mod);
for (let i = 0; i < 14; i += 1) {
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(35);
}
await page.keyboard.up(mod);
await page.waitForTimeout(300);
const moved = await rectOf('.notes-win');
check('⌘← moves it left, the same size', moved.x < placed.x && moved.w === placed.w && moved.h === placed.h, `${placed.x} → ${moved.x}`);
await shot('9-pdf-window-moved');
await page.keyboard.press(`${mod}+Shift+ArrowRight`);
await page.waitForTimeout(300);
const snapped = await rectOf('.notes-win');
check('⌘⇧→ snaps it to the right half, the full height', snapped.x + snapped.w >= W - 12 && snapped.w > W / 2 - 120 && snapped.h > H - 40, JSON.stringify(snapped));
await page.keyboard.press(`${mod}+Shift+ArrowRight`);
await page.waitForTimeout(300);
check('and again, a third', (await rectOf('.notes-win')).w < snapped.w);
await shot('10-pdf-window-snapped');
await page.reload({ waitUntil: 'networkidle' });
const notNow = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
if (await notNow.isVisible().catch(() => false)) await notNow.click();
// The reload opens the PDF in the browser's own viewer: the notes float over that too.
await page.waitForSelector('.main :is(.pdf-book, .pdf-frame)', { state: 'attached', timeout: 20000 });
await page.waitForTimeout(1500);
await page.mouse.move(700, 500);
await page.keyboard.press('h');
await settle();
check('after a reload, over the PDF, H opens the window again', (await page.locator('.notes-win').count()) === 1);
check('where it was left', (await rectOf('.notes-win'))?.w < snapped.w);

console.log('\n== with Ask Claude open too, only the window in front moves ==');
await page.keyboard.press(`${mod}+Backslash`);
await page.waitForSelector('.assistant-win:not(.notes-win)');
await page.waitForTimeout(400);
const ask = '.assistant-win:not(.notes-win)';
await page.evaluate(() => document.activeElement?.blur());
let askBefore = await rectOf(ask);
let notesBefore = await rectOf('.notes-win');
await page.keyboard.press(`${mod}+Shift+ArrowLeft`);
await page.waitForTimeout(300);
check('Ask Claude, opened last, is in front: it moves', !same(askBefore, await rectOf(ask)));
check('and the notes stay', same(notesBefore, await rectOf('.notes-win')));
const zBefore = Number(await page.locator('.notes-win').evaluate((el) => getComputedStyle(el).zIndex));
await page.locator('.notes-win .win-name').click();
askBefore = await rectOf(ask);
notesBefore = await rectOf('.notes-win');
await page.keyboard.press(`${mod}+ArrowLeft`);
await page.waitForTimeout(300);
check('pressing the notes brings them to the front', Number(await page.locator('.notes-win').evaluate((el) => getComputedStyle(el).zIndex)) > zBefore);
check('and now ⌘← moves the notes', !same(notesBefore, await rectOf('.notes-win')));
check('and not Ask Claude', same(askBefore, await rectOf(ask)));
await shot('11-two-windows');
await page.keyboard.press(`${mod}+Backslash`);
await page.waitForTimeout(300);

console.log('\n== the dock button puts them back beside the page ==');
await page.locator('.notes-win').getByRole('button', { name: 'Put the notes back beside the page' }).click();
await settle();
check('the window closes', (await page.locator('.notes-win').count()) === 0);
check('and the notes are beside the page', await beside());
await page.keyboard.press('h');
await settle();
await page.keyboard.press('z');
await settle();

console.log('\n== popped out from the dock, they stay popped out ==');
await page.locator('.segmented button', { hasText: 'Reflow' }).click();
await page.waitForSelector('.paper-body h2', { timeout: 30000 });
await page.waitForTimeout(500);
await page.keyboard.press('h');
await settle();
check('in Reflow, H opens the dock', (await page.locator('.dock').count()) === 1 && (await page.locator('.notes-win').count()) === 0);
await page.locator('.dock').getByRole('button', { name: 'Pop the notes out into a window' }).click();
await settle();
check('pop out: the window opens and the dock goes', (await page.locator('.notes-win').count()) === 1 && (await page.locator('.dock').count()) === 0);
await page.mouse.move(700, 500);
await shot('12-popped-out');
await page.keyboard.press('h');
await page.waitForTimeout(300);
await page.keyboard.press('h');
await page.waitForTimeout(500);
check('H opens the window next time, in Reflow too', (await page.locator('.notes-win').count()) === 1);
await page.locator('.notes-win').getByRole('button', { name: 'Put the notes back beside the page' }).click();
await settle();
check('docked again, H opens the dock', (await page.locator('.notes-win').count()) === 0 && (await page.locator('.dock').count()) === 1);

console.log('\n== ⌘⇧\\ opens and closes them, typing or not ==');
await page.keyboard.press(`${mod}+Shift+Backslash`);
await settle();
check('⌘⇧\\ closes the notes', (await page.locator('.dock').count()) === 0);
await page.keyboard.press(`${mod}+Backslash`);
await page.waitForSelector('.assistant-win');
await page.waitForTimeout(300);
const typingIn = () => page.evaluate(() => /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '') && Boolean(document.activeElement.closest('.assistant-win')));
await page.locator('.assistant-win input[type="password"]').click();
await page.keyboard.type('sk');
check('with the cursor in a box in Ask Claude…', await typingIn());
await page.keyboard.press(`${mod}+Shift+Backslash`);
await settle();
check('…⌘⇧\\ opens the notes', (await page.locator('.dock').count()) === 1);
check('and leaves Ask Claude open, with the cursor where it was', (await page.locator('.assistant-win').count()) === 1 && (await typingIn()));
await page.keyboard.press(`${mod}+Shift+Backslash`);
await settle();
check('and again closes them', (await page.locator('.dock').count()) === 0);
await page.keyboard.press(`${mod}+Backslash`);

check('no errors on the page', errors.length === 0, errors.join('\n'));
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log('\nall good');
