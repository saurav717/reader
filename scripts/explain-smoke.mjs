/**
 * Explain. A paper is opened, E brings up its explanation page, and "Explain
 * this paper" is answered by a stand-in for api.anthropic.com that streams
 * scripts/fixtures/explain-attention.md back as server-sent events — so the
 * whole path runs: the request, the stream, the parsing, the figures, the
 * cells and the caveats, and keeping it in IndexedDB for the next visit. Each
 * layout (Margin, Notebook, Beside the paper) is photographed, in light and
 * dark.
 *
 *   npm run build && npm start &
 *   node scripts/explain-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });
const FIXTURE = await readFile(new URL('./fixtures/explain-attention.md', import.meta.url), 'utf8');

const TITLE = 'Attention Is All You Need';
const W = 1440;
const H = 900;

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

/** The Messages API's stream, as the SDK expects to read it. */
function sse(text) {
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  let body = event('message_start', {
    type: 'message_start',
    message: { id: 'msg_smoke', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9000, output_tokens: 1 } },
  });
  body += event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (let i = 0; i < text.length; i += 240) {
    body += event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 240) } });
  }
  body += event('content_block_stop', { type: 'content_block_stop', index: 0 });
  body += event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6000 } });
  body += event('message_stop', { type: 'message_stop' });
  return body;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

console.log('\n== print a paper ==');
const printer = await browser.newPage();
const para =
  'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms. ';
const section = (n, name) => `<section style="break-after: page"><h2>${n}. ${name}</h2>${`<p>${para.repeat(3)}</p>`.repeat(5)}</section>`;
await printer.setContent(
  `<!doctype html><html><body style="font-family: serif; font-size: 11pt; margin: 0.8in">
    <h1 style="text-align:center">${TITLE}</h1>
    <p style="text-align:center">Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan N. Gomez, Łukasz Kaiser, Illia Polosukhin</p>
    <h3>Abstract</h3><p>${para.repeat(2)}</p>
    ${section(1, 'Introduction')}${section(2, 'Background')}${section(3, 'Model Architecture')}${section(4, 'Why Self-Attention')}
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
      results: [
        {
          id: '2001',
          clusterId: '2001',
          title: TITLE,
          url: 'https://arxiv.org/abs/1706.03762',
          pdfUrl: 'https://example.org/attention.pdf',
          authors: ['A Vaswani', 'N Shazeer', 'N Parmar', 'J Uszkoreit'],
          year: 2017,
          snippet: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
        },
      ],
    }),
  }),
);
await context.route('**/scholar/{authors,person,paper-authors,cluster}*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[]}' }));
let asked = null;
await context.route('https://api.anthropic.com/**', async (route) => {
  asked = JSON.parse(route.request().postData() || '{}');
  await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: sse(FIXTURE) });
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

console.log('\n== open a paper ==');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  localStorage.setItem('reader.anthropic-key', 'sk-ant-smoke');
  localStorage.setItem('reader.explain.layout', 'margin');
});
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();
const chips = page.locator('.discover-panel .chip');
for (let index = 0; index < (await chips.count()); index += 1) {
  const chip = chips.nth(index);
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
await page.waitForTimeout(500);
check('the top bar has an Explain button', (await page.locator('.explain-toggle').count()) === 1);
await page.screenshot({ path: `${OUT}/explain-0-reader.png` });

console.log('\n== E opens the explanation ==');
await page.mouse.move(W / 2, H / 2);
await page.keyboard.press('e');
await page.waitForSelector('.explain .explain-empty');
await page.waitForTimeout(400);
check('before it is written, it offers to write it', await page.getByRole('button', { name: 'Explain this paper' }).isVisible());
await page.screenshot({ path: `${OUT}/explain-1-start.png` });

console.log('\n== Claude writes it ==');
await page.getByRole('button', { name: 'Explain this paper' }).click();
await page.waitForSelector('.explain-section h2', { timeout: 20000 });
await page.waitForFunction(() => !document.querySelector('.explain-writing'), null, { timeout: 20000 });
check('the paper went along with the request', Boolean(asked?.system?.some?.((block) => /paper_text/.test(block.text))));
check('the paper sits behind a cache breakpoint', Boolean(asked?.system?.[1]?.cache_control));
const sections = await page.locator('.explain-section h2').allTextContents();
check('every section is drawn', sections.length === 8, sections.join(' | '));
check('the outline lists them', (await page.locator('.explain-outline li').count()) === 8);
check('the figures are drawn as SVG', (await page.locator('.explain-figure svg').count()) === 3);
check('the code cells are numbered', (await page.locator('.cell-index').allTextContents()).join(',') === 'In [1],In [2],In [3],In [4]');
check('each cell has its expected output', (await page.locator('.cell-output').count()) === 4);
check('Run in Colab waits for the connection', await page.locator('.btn.colab').first().isDisabled());
check('the caveats are flagged', (await page.locator('.explain-caveat').count()) === 6);
check('the outline counts how it has aged', (await page.locator('.aged-row').count()) === 3);
await page.screenshot({ path: `${OUT}/explain-2-margin.png` });

await page.locator('#explain-scaled-dot-product-attention').scrollIntoViewIfNeeded();
await page.locator('.explain-scroll').evaluate((el) => {
  const target = el.querySelector('#explain-scaled-dot-product-attention');
  el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/explain-3-margin-code.png` });

await page.locator('.explain-scroll').evaluate((el) => {
  const target = el.querySelector('#explain-where-is-each-word-positional-encoding');
  el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/explain-4-margin-caveat.png` });

await page.locator('.explain-scroll').evaluate((el) => {
  el.scrollTop = el.scrollHeight;
});
await page.waitForTimeout(300);
check('the outline follows the reading', (await page.locator('.explain-outline li.active').textContent())?.includes('Since then'));
await page.screenshot({ path: `${OUT}/explain-5-since-then.png` });

console.log('\n== notebook ==');
await page.getByRole('button', { name: 'Notebook', exact: true }).click();
await page.locator('.explain-scroll').evaluate((el) => {
  const target = el.querySelector('#explain-scaled-dot-product-attention');
  el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/explain-6-notebook.png` });

console.log('\n== beside the paper ==');
await page.getByRole('button', { name: 'Beside the paper' }).click();
await page.locator('.explain-scroll').evaluate((el) => {
  el.scrollTop = 0;
});
await page.waitForTimeout(500);
const left = await page.locator('.explain').evaluate((el) => el.getBoundingClientRect().left);
check('the paper stays readable on the left', left > W * 0.35, `${left}px`);
await page.screenshot({ path: `${OUT}/explain-7-beside.png` });

console.log('\n== the notebook downloads ==');
await page.getByRole('button', { name: 'Margin' }).click();
const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Notebook ↓/ }).click()]);
const ipynb = JSON.parse(await readFile(await download.path(), 'utf8'));
check('it is a notebook with the four cells', ipynb.nbformat === 4 && ipynb.cells.filter((c) => c.cell_type === 'code').length === 4);

console.log('\n== dark, and kept for the next visit ==');
await page.evaluate(() => {
  const saved = JSON.parse(localStorage.getItem('reader.settings') || '{}');
  localStorage.setItem('reader.settings', JSON.stringify({ ...saved, theme: 'dark' }));
});
asked = null;
await page.reload({ waitUntil: 'networkidle' });
const notNow = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
if (await notNow.isVisible().catch(() => false)) await notNow.click();
await page.waitForSelector('.explain-section h2', { timeout: 20000 });
check('it comes back without asking Claude again', asked === null);
await page.locator('.explain-scroll').evaluate((el) => {
  const target = el.querySelector('#explain-the-block-residuals-layernorm-and-the-feed-forward-layer');
  el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/explain-8-dark.png` });

console.log('\n== on a phone ==');
await page.setViewportSize({ width: 390, height: 844 });
await page.locator('.explain-scroll').evaluate((el) => {
  const target = el.querySelector('#explain-scaled-dot-product-attention');
  el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
});
await page.waitForTimeout(300);
const overflow = await page.locator('.explain-scroll').evaluate((el) => el.scrollWidth - el.clientWidth);
check('nothing scrolls sideways', overflow <= 1, `${overflow}px`);
await page.screenshot({ path: `${OUT}/explain-9-phone.png` });

console.log('\n== Esc goes back to the paper ==');
await page.setViewportSize({ width: W, height: H });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('the explanation closes', (await page.locator('.explain').count()) === 0);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nall good');
process.exit(problems.length ? 1 : 0);
