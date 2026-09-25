/**
 * Each paper keeps notes of its own. With two papers' notes already in the
 * library, a third is opened and written in; the notes pane names the paper
 * they belong to, and "All notes" lists every paper's, a card to each, from
 * which another paper opens with its own notes — and nothing of the first's.
 * Back on the first, its note is there as it was left. The library's rows
 * count each paper's notes, and H with no paper open brings up the list.
 * Each step is photographed.
 *
 *   npm run build && npm start &
 *   node scripts/notes-per-paper-smoke.mjs        # SMOKE_BASE=http://localhost:8080
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

// Two papers read before, each with notes of its own, put straight into the library's store.
const picture = await page.evaluate(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 140;
  const g = canvas.getContext('2d');
  g.fillStyle = '#eef3fb';
  g.fillRect(0, 0, 320, 140);
  g.fillStyle = '#4a78c2';
  [60, 110, 80, 130, 95].forEach((h, i) => g.fillRect(30 + i * 56, 130 - h, 36, h));
  return canvas.toDataURL('image/png');
});
await page.evaluate(async ({ picture }) => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('reader', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const put = (store, value, key) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      key === undefined ? tx.objectStore(store).put(value) : tx.objectStore(store).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const paper = (id, title, authors, published, venue) => ({ id, source: 'scholar', title, authors, abstract: '', published, categories: [], venue, addedAt: day(9), collectionIds: [], tags: [], progress: 0.4 });
  await put('papers', paper('bert', 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding', ['Jacob Devlin', 'Ming-Wei Chang', 'Kenton Lee', 'Kristina Toutanova'], '2019', 'NAACL'));
  await put('papers', paper('gpt', 'Language Models are Few-Shot Learners', ['Tom B. Brown', 'Benjamin Mann', 'Nick Ryder'], '2020', 'NeurIPS'));
  await put('papers', paper('resnet', 'Deep Residual Learning for Image Recognition', ['Kaiming He', 'Xiangyu Zhang', 'Shaoqing Ren', 'Jian Sun'], '2016', 'CVPR'));
  const text = (id, md, at) => ({ id, kind: 'text', md, at });
  const clip = (id, label, html, words, section, at, note) => ({ id, kind: 'clip', label, html, text: words, note, source: { from: 'paper', section }, at });
  await put('kv', {
    updated: day(1),
    blocks: [
      text('b1', 'BERT = the Transformer encoder only, trained to fill in masked words from both sides. Fine-tune one extra layer per task.', day(3)),
      clip('b2', 'Passage', '<p>We mask 15% of all WordPiece tokens in each sequence at random, and predict only the masked words rather than reconstructing the entire input.</p>', 'We mask 15% of all WordPiece tokens…', '3.1 Pre-training BERT', day(2), '80/10/10: [MASK] / random / unchanged.'),
      text('b3', 'Next-sentence prediction — later papers (RoBERTa) drop it.', day(1)),
    ],
  }, 'notes:bert');
  await put('kv', {
    updated: day(6),
    blocks: [
      text('r1', 'Learn the residual F(x) = H(x) − x, not H(x). Identity shortcuts cost nothing.', day(7)),
      clip('r2', 'Figure 4', `<figure><img src="${picture}" alt=""><figcaption>Figure 4: Training on ImageNet. Thin curves: training error; bold: validation error.</figcaption></figure>`, 'Figure 4: Training on ImageNet.', '4.1 ImageNet Classification', day(6)),
    ],
  }, 'notes:resnet');
  db.close();
}, { picture });
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click({ timeout: 5000 }).catch(() => undefined);
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

const shot = (name) => page.screenshot({ path: `${OUT}/notes-paper-${name}.png` });
const paperName = () => page.locator('.dock .notes-paper-title').first().textContent();

console.log('\n== a paper opened from Discover leaves Discover where it is ==');
check('Discover, and its results, stay', (await page.locator('.dock .discover-panel article.result').count()) > 0);
await page.keyboard.press('h');
await page.waitForSelector('.dock .notes-paper', { timeout: 5000 });
check('on the Notes tab, ready to write in', (await page.locator('.dock .notes-tabs [role=tab][aria-selected=true]').textContent())?.startsWith('Notes'));

console.log('\n== the notes are the open paper\'s ==');
await page.waitForTimeout(500);
check('the pane names the paper its notes are on', (await paperName()) === TITLE, await paperName());
const switchText = (await page.locator('.dock .notes-paper-switch').textContent()) || '';
check('and offers the other papers\' notes', /All notes · 2 papers/.test(switchText), switchText);
await page.locator('.dock .notes-write-btn').click();
await page.keyboard.type('Attention only: no recurrence, no convolution. Every position sees every other in one step — O(1) path length (Table 1).');
await page.locator('.paper-body').click({ position: { x: 10, y: 10 } });
await page.waitForTimeout(500);
await shot('1-this-paper');

console.log('\n== every paper\'s notes ==');
await page.locator('.dock .notes-paper-switch').click();
await page.waitForSelector('.dock .notes-index-row');
await page.waitForTimeout(300);
const titles = await page.locator('.dock .notes-index-title').allTextContents();
check('three papers, a card to each, the last touched first', titles.length === 3 && titles[0] === TITLE && /BERT/.test(titles[1]) && /Residual/.test(titles[2]), titles.join(' | '));
check('the open paper is marked', (await page.locator('.dock .notes-index-row.is-current .notes-index-title').textContent()) === TITLE);
const bertMeta = (await page.locator('.dock .notes-index-row', { hasText: 'BERT' }).locator('.notes-index-meta').textContent()) || '';
check('a card says what is in them', /3 pieces · 2 written · 1 kept/.test(bertMeta), bertMeta);
const resnetMeta = (await page.locator('.dock .notes-index-row', { hasText: 'Residual' }).locator('.notes-index-meta').textContent()) || '';
check('pictures counted', /1 picture/.test(resnetMeta), resnetMeta);
await shot('2-all-notes');
await page.locator('.dock .notes-index-search input').fill('masked');
await page.waitForTimeout(200);
const found = await page.locator('.dock .notes-index-title').allTextContents();
check('finding in them narrows the list', found.length === 1 && /BERT/.test(found[0]), found.join(' | '));
await page.locator('.dock .notes-index-search input').fill('');

console.log('\n== another paper, its own notes ==');
await page.locator('.dock .notes-index-row', { hasText: 'BERT' }).click();
await page.waitForFunction(() => /BERT/.test(document.querySelector('.dock .notes-paper-title')?.textContent || ''), null, { timeout: 8000 });
await page.waitForTimeout(800);
check('the notes follow the paper opened', /BERT/.test(await paperName()), await paperName());
const bertPieces = await page.locator('.dock .note-piece').allTextContents();
check('its notes, and only its', bertPieces.length === 3 && !bertPieces.some((text) => /O\(1\) path length/.test(text)), `${bertPieces.length} pieces`);
await shot('3-other-paper');

console.log('\n== back to the first ==');
await page.locator('.library-panel .paper-row', { hasText: TITLE }).first().click().catch(async () => {
  await page.locator('.dock .notes-paper-switch').click();
  await page.locator('.dock .notes-index-row', { hasText: TITLE }).click();
});
await page.waitForFunction((title) => document.querySelector('.dock .notes-paper-title')?.textContent === title, TITLE, { timeout: 8000 });
await page.waitForTimeout(500);
const firstPieces = await page.locator('.dock .note-piece').allTextContents();
check('the note written is there as it was left', firstPieces.length === 1 && /O\(1\) path length/.test(firstPieces[0]), `${firstPieces.length} pieces`);

console.log('\n== the notes in a window follow the paper too ==');
await page.locator('.dock').getByRole('button', { name: /Pop the notes out/ }).click();
await page.waitForSelector('.notes-win .notes-paper');
await page.locator('.notes-win .notes-paper-switch').click();
await page.locator('.notes-win .notes-index-row', { hasText: 'Residual' }).click();
await page.waitForFunction(() => /Residual/.test(document.querySelector('.notes-win .notes-paper-title')?.textContent || ''), null, { timeout: 8000 });
await page.waitForTimeout(800);
check('the window shows the paper opened from it', /Residual/.test((await page.locator('.notes-win .notes-paper-title').textContent()) || ''));
check('with its picture', (await page.locator('.notes-win .note-clip img').count()) === 1);
await shot('4-window');
await page.locator('.notes-win').getByRole('button', { name: /back beside the page/ }).click();
await page.waitForTimeout(600);

console.log('\n== the library counts them, and H lists them with no paper open ==');
await page.locator('.library-panel').getByRole('button', { name: /All papers/ }).first().click();
await page.waitForTimeout(800);
const chipsText = await page.locator('.lib-chip.note').allTextContents();
check('each paper with notes has a count on its row', chipsText.length === 3, chipsText.join(' | '));
await page.waitForSelector('.dock .notes-index-row', { timeout: 5000 });
await page.waitForTimeout(600);
check('with no paper open the notes pane lists every paper\'s notes', (await page.locator('.dock .notes-index-row').count()) === 3);
check('and names no paper as open', (await page.locator('.dock .notes-index-row.is-current').count()) === 0);
await page.keyboard.press('h');
await page.waitForTimeout(500);
check('H shuts it', (await page.locator('.dock .notes-index-row').count()) === 0);
await page.keyboard.press('h');
await page.waitForSelector('.dock .notes-index-row', { timeout: 5000 });
await page.waitForTimeout(400);
check('and H brings it back', (await page.locator('.dock .notes-index-row').count()) === 3);
await shot('5-library');

console.log('\n== pointing at a paper lights its notes ==');
const lit = () => page.locator('.dock .notes-index-row.is-lit .notes-index-title').allTextContents();
const dim = () => page.locator('.dock .notes-index-row.is-dim').count();
const pointing = () => page.locator('.dock .notes-index-pointing').textContent();
await page.locator('.lib-row', { hasText: 'BERT' }).hover();
await page.waitForTimeout(400);
check('its card is lit', (await lit()).length === 1 && /BERT/.test((await lit())[0]), (await lit()).join(' | '));
check('the others dimmed', (await dim()) === 2, String(await dim()));
check('and it says whose they are', /Notes on “BERT/.test((await pointing()) || ''), await pointing());
await shot('6-hover');
await page.locator('.lib-row', { hasText: 'Few-Shot' }).hover();
await page.waitForTimeout(400);
check('a paper with no notes dims them all', (await lit()).length === 0 && (await dim()) === 3, String(await dim()));
check('and says so', /No notes on “Language Models are Few-Shot Learners” yet/.test((await pointing()) || ''), await pointing());
await shot('7-hover-none');
await page.locator('.library-panel .paper-row', { hasText: 'Residual' }).hover();
await page.waitForTimeout(400);
check('the library panel\'s rows light them too', /Residual/.test((await lit())[0] || ''), (await lit()).join(' | '));
await page.mouse.move(W / 2, H - 20);
await page.waitForTimeout(400);
check('moving off leaves them all as they were', (await lit()).length === 0 && (await dim()) === 0);

console.log('\n== opening a paper opens its notes ==');
await page.locator('.dock-tabs').getByRole('tab', { name: 'Discover' }).click();
await page.waitForTimeout(300);
await page.locator('.lib-row', { hasText: 'BERT' }).locator('.lib-main').click();
await page.waitForFunction(() => /BERT/.test(document.querySelector('.dock .notes-paper-title')?.textContent || ''), null, { timeout: 8000 }).catch(() => undefined);
await page.waitForTimeout(500);
check('from the library, the paper opens with its notes beside it', /BERT/.test((await page.locator('.dock .notes-paper-title').textContent().catch(() => '')) || ''));
await page.keyboard.press('h');
await page.waitForTimeout(600);
await page.locator('.library-panel .paper-row', { hasText: TITLE }).click();
await page.waitForFunction((title) => document.querySelector('.dock .notes-paper-title')?.textContent === title, TITLE, { timeout: 8000 }).catch(() => undefined);
await page.waitForTimeout(500);
check('even with the notes shut before', (await page.locator('.dock .notes-paper-title').textContent().catch(() => '')) === TITLE);

check('no page errors', !errors.length, errors.join(' | '));
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll good.');
