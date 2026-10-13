/**
 * The showcase (components/Showcase.tsx): started from the palette's action
 * on a fresh library, with the indexes and the PDF answered here and the
 * model and Colab replayed by the page itself. Watches each scene come up,
 * checks none of them halted, that the paper was saved, explained, planned
 * and run, and that Esc leaves. Writes a screenshot of each scene to .smoke/.
 *
 *   npm run build && npm start &
 *   node scripts/showcase-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });
const THEME = process.env.THEME || 'light';

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const TITLE = 'Attention Is All You Need';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

// A stand-in for the paper: the passages the replayed answer quotes are in it.
const printer = await browser.newPage();
const p = (text) => `<p>${text}</p>`;
await printer.setContent(
  `<!doctype html><html><body style="font-family: serif; font-size: 11pt; line-height: 1.4; margin: 0 1in">
  <h1 style="text-align:center">${TITLE}</h1>
  <p style="text-align:center">Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan N. Gomez, Łukasz Kaiser, Illia Polosukhin</p>
  <h3>Abstract</h3>${p('The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.')}
  <h2>1 Introduction</h2>${p('Recurrent neural networks, long short-term memory and gated recurrent neural networks in particular, have been firmly established as state of the art approaches in sequence modeling and transduction problems such as language modeling and machine translation.').repeat(3)}
  <h2>2 Background</h2>${p('The goal of reducing sequential computation also forms the foundation of the Extended Neural GPU, ByteNet and ConvS2S, all of which use convolutional neural networks as basic building block.').repeat(3)}
  <h2>3 Model Architecture</h2>${p('Most competitive neural sequence transduction models have an encoder-decoder structure. Here, the encoder maps an input sequence of symbol representations to a sequence of continuous representations.').repeat(2)}
  <h3>3.2.1 Scaled Dot-Product Attention</h3>
  ${p('We call our particular attention "Scaled Dot-Product Attention" (Figure 2). The input consists of queries and keys of dimension dk, and values of dimension dv. We compute the dot products of the query with all keys, divide each by the square root of dk, and apply a softmax function to obtain the weights on the values.')}
  ${p('The two most commonly used attention functions are additive attention, and dot-product (multiplicative) attention. While for small values of dk the two mechanisms perform similarly, additive attention outperforms dot product attention without scaling for larger values of dk. We suspect that for large values of dk, the dot products grow large in magnitude, pushing the softmax function into regions where it has extremely small gradients. To counteract this effect, we scale the dot products.')}
  <h3>3.2.2 Multi-Head Attention</h3>
  ${p('Instead of performing a single attention function with dmodel-dimensional keys, values and queries, we found it beneficial to linearly project the queries, keys and values h times with different, learned linear projections to dk, dk and dv dimensions, respectively.')}
  <h2>4 Why Self-Attention</h2>${p('In this section we compare various aspects of self-attention layers to the recurrent and convolutional layers commonly used for mapping one variable-length sequence of symbol representations to another sequence of equal length.').repeat(4)}
  </body></html>`,
);
const PDF = await printer.pdf({ format: 'Letter', printBackground: true });
await printer.close();

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.route('**/pdf?*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }));
for (const host of ['api.crossref.org', 'api.semanticscholar.org', 'dblp.org', 'wikidata.org', 'api.openalex.org']) {
  await context.route(`**/${host}/**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[],"data":[],"message":{"items":[]},"result":{"hits":{}}}' }));
}
const HIT = { id: '1706.03762', clusterId: '1706.03762', title: TITLE, url: 'https://arxiv.org/abs/1706.03762', pdfUrl: 'https://arxiv.org/pdf/1706.03762', authors: ['A Vaswani', 'N Shazeer', 'N Parmar', 'J Uszkoreit'], year: 2017, snippet: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.' };
await context.route('**/scholar/search*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [HIT] }) }));
await context.route('**/scholar/{authors,person,paper-authors,cluster}*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[]}' }));
const ATOM = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/1706.03762v7</id><updated>2023-08-02T00:41:18Z</updated><published>2017-06-12T17:57:34Z</published><title>${TITLE}</title><summary>The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.</summary><author><name>Ashish Vaswani</name></author><author><name>Noam Shazeer</name></author><link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/><link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/><category term="cs.CL"/></entry></feed>`;
await context.route('**/api/arxiv/query*', (route) => route.fulfill({ status: 200, contentType: 'application/atom+xml', body: ATOM }));
await context.route('**/api/arxiv/html*', (route) => route.fulfill({ status: 404, body: '' }));
// Nothing else leaves the machine but the fonts.
await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|fonts\.)/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));

// Every note a scene shows — a halt, a problem — kept as it appears, for the report.
await context.addInitScript(() => {
  window.__notes = [];
  new MutationObserver(() => {
    for (const el of document.querySelectorAll('.showcase-note')) {
      const text = el.textContent || '';
      if (!window.__notes.includes(text)) window.__notes.push(text);
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate((theme) => {
  localStorage.setItem('reader.welcomed', 'true');
  localStorage.setItem('reader.tour', 'seen');
  localStorage.setItem('reader.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('reader.settings') || '{}'), theme }));
}, THEME);
await page.reload({ waitUntil: 'networkidle' });
const skip = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
if (await skip.isVisible().catch(() => false)) await skip.click();

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${THEME}-showcase-${name}.png` });
  console.log('  shot', name);
};
const sceneIs = async (id, timeout = 60_000) => {
  const seen = await page.waitForSelector(`.showcase[data-scene="${id}"] .showcase-card`, { timeout }).then(() => true).catch(() => false);
  check(`scene ${id} came up`, seen, seen ? '' : `notes so far: ${(await page.evaluate(() => window.__notes)).join(' | ')}`);
};

console.log('\n== start the showcase from the palette ==');
await page.keyboard.press('Control+k');
await page.waitForSelector('.palette');
await page.keyboard.type('show me');
await page.locator('.palette-row', { hasText: 'Show me, with a paper' }).click();
await sceneIs('find', 10_000);
console.log('\n== watch it ==');
await page.waitForFunction(() => document.querySelector('.find-box input')?.value?.length > 10, null, { timeout: 15_000 });
await shot('1-typing');
await sceneIs('open');
await shot('2-found');
await sceneIs('modes');
await shot('3-opened');
await page.waitForFunction(() => document.querySelector('.reader-head .segmented [aria-pressed="true"]')?.textContent === 'Reflow', null, { timeout: 20_000 }).catch(() => undefined);
await shot('3b-reflow');
await sceneIs('ask');
await page.waitForSelector('.assistant-win .chat-passage-row', { timeout: 40_000 }).catch(() => undefined);
await page.waitForTimeout(2600);
await shot('4-ask');
await sceneIs('explain');
await page.waitForFunction(() => document.querySelectorAll('.explain-section').length >= 4, null, { timeout: 50_000 }).catch(() => undefined);
await page.waitForTimeout(1200);
await shot('5-explained');
await sceneIs('implement');
await page.waitForFunction(() => /Repository layout|What to build/.test(document.querySelector('.explain')?.textContent ?? ''), null, { timeout: 50_000 }).catch(() => undefined);
await page.waitForTimeout(1200);
await shot('6-planned');
await sceneIs('colab');
await page.waitForSelector('.nb-cell .cell-output', { timeout: 60_000 }).catch(() => undefined);
await page.waitForTimeout(5000);
await shot('7-colab');
const outputs = await page.locator('.nb-cell .cell-output').count();
const metrics = await page.locator('.rt-meter-fill').count();
await sceneIs('toggle');
await page.waitForTimeout(2200);
await shot('8-toggle');
await sceneIs('done', 30_000);
await shot('9-done');

const notes = await page.evaluate(() => window.__notes);
check('no scene halted', notes.length === 0, notes.join(' | '));
check('the paper is in the library', (await page.evaluate(() => document.body.textContent)).includes(TITLE));
check('the notebook ran its cells on the stand-in runtime', outputs >= 3, `${outputs} outputs`);
check('the machine’s load was read while they ran', metrics >= 1, `${metrics} meters`);
await page.keyboard.press('Escape');
await page.waitForSelector('.showcase', { state: 'detached' });
check('Esc leaves', (await page.locator('.showcase').count()) === 0);
await page.waitForTimeout(1500);
check('the stand-in runtime is let go with the showcase', !/T4 · GPU/.test(await page.textContent('body')));
check('the replay is taken out when the showcase ends', await page.evaluate(() => window.fetch.toString().includes('[native code]')));
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nall good');
