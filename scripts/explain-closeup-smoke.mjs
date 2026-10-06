/**
 * A figure, close up. A paper is opened, E brings up its explanation (the
 * fixture, streamed by a stand-in for api.anthropic.com), and a click on a
 * figure Claude drew lifts it off the page to the middle of the window, as
 * large as the window allows, with its caption under it and the page dimmed
 * behind: Tab goes on to the next figure, Esc puts it back, Add to notes
 * keeps it. The same for a scene, on the step it is on, once the bar has
 * written one. Each state is photographed, in light and dark, in every
 * layout, and on a phone.
 *
 *   npm run build && npm start &
 *   node scripts/explain-closeup-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });
const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const FIXTURE = await fixture('explain-attention.md');
const REPLIES = [await fixture('explain-revise-scene.md')];
const PLAN = await fixture('implement-minitron.md');

const TITLE = 'Attention Is All You Need';
const W = 1440;
const H = 900;

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

/** The Messages API's stream, as the SDK expects to read it: one event a string. */
function sse(text, size = 240) {
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const body = [];
  body.push(event('message_start', {
    type: 'message_start',
    message: { id: 'msg_smoke', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9000, output_tokens: 1 } },
  }));
  body.push(event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  for (let i = 0; i < text.length; i += size) {
    body.push(event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + size) } }));
  }
  body.push(event('content_block_stop', { type: 'content_block_stop', index: 0 }));
  body.push(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6000 } }));
  body.push(event('message_stop', { type: 'message_stop' }));
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
// A stand-in for api.anthropic.com inside the page, so a reply can be held
// halfway (window.__hold) and photographed mid-stream. The first page comes
// from the fixture; each request from the bar gets the next of REPLIES.
await context.addInitScript(
  ({ first, replies, plan }) => {
    const real = window.fetch.bind(window);
    window.__asked = [];
    window.__hold = null;
    let next = 0;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.startsWith('https://api.anthropic.com')) return real(input, init);
      const body = JSON.parse(init?.body ?? '{}');
      window.__asked.push(body);
      const events = body.messages.length > 1 ? replies[next++ % replies.length] : /IMPLEMENTATION page/.test(body.system?.[0]?.text ?? '') ? plan : first;
      const hold = window.__hold;
      const stream = new ReadableStream({
        async start(controller) {
          for (let i = 0; i < events.length; i++) {
            if (hold && i === hold.at) await hold.until;
            controller.enqueue(new TextEncoder().encode(events[i]));
          }
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_smoke' } });
    };
  },
  { first: sse(FIXTURE), replies: REPLIES.map((reply) => sse(reply, 120)), plan: sse(PLAN) },
);
const lastAsked = () => page.evaluate(() => window.__asked.at(-1) ?? null);
const askedCount = () => page.evaluate(() => window.__asked.length);

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

console.log('\n== open a paper ==');
// The paper is put straight into the browser's own database, as the zoom smoke does, and the reader opened on it, in Reflow.
const ago = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString();
const PAPER = {
  id: 'scholar:attention',
  source: 'scholar',
  title: TITLE,
  authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit'],
  abstract: '',
  published: '2017-06-12',
  categories: [],
  addedAt: ago(240),
  collectionIds: ['c-reading'],
  tags: [],
  progress: 0.1,
  lastOpenedAt: ago(2),
  pdfUrl: 'https://example.org/attention.pdf',
};
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
  const put = (store, value) =>
    new Promise((resolve, reject) => {
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
check('the top bar has an Explain button', (await page.locator('.explain-toggle').count()) === 1);

/** Settings as the app keeps them, then a reload, past the Drive question, back to the paper. */
async function withSettings(patch) {
  await page.evaluate((next) => {
    const saved = JSON.parse(localStorage.getItem('reader.settings') || '{}');
    localStorage.setItem('reader.settings', JSON.stringify({ ...saved, ...next }));
  }, patch);
  await page.reload({ waitUntil: 'networkidle' });
  const notNow = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await page.waitForSelector('.explain', { timeout: 15000 });
  await page.waitForSelector('.paper-body h2', { state: 'attached', timeout: 30000 });
  await page.waitForTimeout(600);
}

console.log('\n== E, and Claude writes the page ==');
await page.mouse.move(W / 2, H / 2);
await page.keyboard.press('e');
await page.waitForSelector('.explain .explain-empty');
await page.getByRole('button', { name: 'Explain this paper' }).click();
await page.waitForSelector('.explain-section h2', { timeout: 20000 });
await page.waitForFunction(() => !document.querySelector('.explain-writing'), null, { timeout: 20000 });
check('the figures are drawn as SVG', (await page.locator('.explain-figure svg').count()) === 3);
check('each drawing says it opens close up', (await page.locator('.explain-figure .figure-art[role="button"]').count()) === 3);

const scroller = page.locator('.explain-scroll');
const scrollTo = async (selector, pad = 12) => {
  await scroller.evaluate(
    (el, [sel, pad]) => {
      const target = el.querySelector(sel);
      el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - pad;
    },
    [selector, pad],
  );
  await page.waitForTimeout(300);
};
const figureIn = (title) => page.locator(`.explain-section[data-title="${title}"] .explain-figure .figure-art`).first();
const closeup = page.locator('.figure-closeup');
const cardBox = () => page.locator('.figure-closeup-card').boundingBox();

console.log('\n== pointing at a figure ==');
await scrollTo('#explain-scaled-dot-product-attention', 40);
const pipeline = figureIn('Scaled dot-product attention');
await pipeline.hover();
await page.waitForTimeout(250);
check('the pointer is a magnifier over it', (await pipeline.evaluate((el) => getComputedStyle(el).cursor)) === 'zoom-in');
check('and a mark comes up on its corner', (await pipeline.evaluate((el) => getComputedStyle(el, '::after').opacity)) > 0.5);
await page.screenshot({ path: `${OUT}/closeup-1-hover.png` });

console.log('\n== click: the figure, close up ==');
const onPage = await pipeline.boundingBox();
await pipeline.click();
await closeup.waitFor({ timeout: 5000 });
await page.waitForTimeout(500);
check('a close-up opens over the page', await closeup.isVisible());
const grown = await cardBox();
check('the drawing is much larger than on the page', grown.width > onPage.width * 1.8, `${Math.round(onPage.width)} → ${Math.round(grown.width)}px`);
check('and in the middle of the window', Math.abs(grown.x + grown.width / 2 - W / 2) < 4 && grown.y > 40 && grown.y + grown.height < H - 40, `x ${Math.round(grown.x)}, w ${Math.round(grown.width)}`);
check('it says which figure it is, and whose section', /Figure 2 of 3 · Scaled dot-product attention/.test(await page.locator('.figure-closeup-title').textContent()));
check('its caption is under it', /match queries against keys/.test(await page.locator('.figure-closeup-caption').textContent()));
check('the keys are said in a chip', /⇥.*next.*Esc/.test(await page.locator('.figure-closeup-chip').textContent()));
check('the page behind is dimmed', /0\.6/.test(await page.locator('.figure-closeup-back').evaluate((el) => getComputedStyle(el).backgroundColor)));
check('the page is still there behind it', (await page.locator('.explain-section').count()) === 8);
await page.screenshot({ path: `${OUT}/closeup-2-open.png` });

console.log('\n== Tab: the next figure; Esc: back to the page ==');
await page.keyboard.press('Tab');
await page.waitForTimeout(400);
check('Tab goes on to the next figure', /Figure 3 of 3/.test(await page.locator('.figure-closeup-title').textContent()));
check('and the dots say so', (await page.locator('.figure-closeup-dots i.on').count()) === 1 && (await page.locator('.figure-closeup-dots i').nth(2).getAttribute('class')) === 'on');
await page.screenshot({ path: `${OUT}/closeup-3-next.png` });
await page.keyboard.press('Shift+Tab');
await page.waitForTimeout(300);
check('Shift-Tab goes back', /Figure 2 of 3/.test(await page.locator('.figure-closeup-title').textContent()));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check('Esc puts the figure back', (await closeup.count()) === 0);
check('and leaves the page open', (await page.locator('.explain').count()) === 1);
check('the focus is back on the drawing', await pipeline.evaluate((el) => document.activeElement === el));

console.log('\n== Enter on a focused figure; a click beside the close-up ==');
await page.keyboard.press('Enter');
await closeup.waitFor({ timeout: 5000 });
check('Enter opens it from the keyboard', await closeup.isVisible());
await page.mouse.click(30, H / 2);
await page.waitForTimeout(400);
check('a click beside it puts it back', (await closeup.count()) === 0);

console.log('\n== Add to notes, from the close-up ==');
await pipeline.click();
await closeup.waitFor({ timeout: 5000 });
await page.locator('.figure-closeup').getByRole('button', { name: 'Add to notes' }).click();
await page.waitForTimeout(500);
check('the figure is kept, and the close-up goes', (await closeup.count()) === 0 && (await page.locator('.note-kept').count()) === 1);

console.log('\n== in the dark ==');
await withSettings({ theme: 'dark', glass: false });
await scrollTo('#explain-scaled-dot-product-attention', 40);
await figureIn('Scaled dot-product attention').click();
await closeup.waitFor({ timeout: 5000 });
await page.waitForTimeout(500);
check('the close-up follows the theme', (await page.locator('.figure-closeup-card').evaluate((el) => getComputedStyle(el).backgroundColor)) !== 'rgb(255, 253, 247)');
await page.screenshot({ path: `${OUT}/closeup-4-dark.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await withSettings({ theme: 'light', glass: false });

console.log('\n== a scene, close up on its step ==');
const bar = page.getByLabel('Ask about the explanation, or ask for a change');
await scrollTo('#explain-scaled-dot-product-attention', 40);
const attention = page.locator('.explain-section[data-title="Scaled dot-product attention"]');
await attention.hover();
await attention.getByRole('button', { name: 'Ask or adjust' }).click();
await bar.fill('Animate the pipeline figure');
await bar.press('Enter');
await page.waitForSelector('.explain-motion .motion-art svg', { timeout: 15000 });
await page.waitForSelector('.ask-status.is-done', { timeout: 15000 });
await page.waitForTimeout(600);
const scene = page.locator('.explain-motion .motion-art').first();
await scene.locator('..').locator('.motion-steps .dots button').nth(2).click();
await page.waitForTimeout(600);
await scrollTo('#explain-scaled-dot-product-attention', 40);
await scene.click();
await closeup.waitFor({ timeout: 5000 });
await page.waitForTimeout(500);
check('a scene opens close up too', /Scene \d of 4/.test(await page.locator('.figure-closeup-title').textContent()));
check('on the step it was on', /3 of 4/.test(await page.locator('.figure-closeup-caption').textContent()));
check('drawn in its own colours', (await page.locator('.figure-closeup .closeup-art.is-scene svg .m-soft').count()) > 0);
await page.screenshot({ path: `${OUT}/closeup-5-scene.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

console.log('\n== the other layouts ==');
await page.getByRole('button', { name: 'Notebook', exact: true }).click();
await scrollTo('#explain-scaled-dot-product-attention', 40);
await figureIn('Scaled dot-product attention').click();
await closeup.waitFor({ timeout: 5000 });
await page.waitForTimeout(500);
check('a figure in the notebook layout opens close up', await closeup.isVisible());
await page.screenshot({ path: `${OUT}/closeup-6-notebook.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Beside the paper' }).click();
await page.waitForTimeout(500);
await scrollTo('#explain-scaled-dot-product-attention', 40);
await figureIn('Scaled dot-product attention').click();
await closeup.waitFor({ timeout: 5000 });
await page.waitForTimeout(500);
const beside = await cardBox();
check('beside the paper, the close-up still takes the whole window', Math.abs(beside.x + beside.width / 2 - W / 2) < 4 && beside.width > 700, `x ${Math.round(beside.x)}, w ${Math.round(beside.width)}`);
await page.screenshot({ path: `${OUT}/closeup-7-beside.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Margin', exact: true }).click();

console.log('\n== on a phone ==');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);
await scrollTo('#explain-scaled-dot-product-attention', 40);
await figureIn('Scaled dot-product attention').click();
await closeup.waitFor({ timeout: 5000 });
await page.waitForTimeout(500);
const phone = await cardBox();
check('on a phone the close-up fits the width', phone.width >= 390 - 40 && phone.width <= 390, `${Math.round(phone.width)}px`);
await page.screenshot({ path: `${OUT}/closeup-8-phone.png` });
await page.keyboard.press('Escape');
await page.setViewportSize({ width: W, height: H });

console.log('\n== the Implementation page: its pipeline figure, close up ==');
await page.getByRole('tab', { name: 'Implementation' }).click();
await page.waitForSelector('.impl-empty');
await page.locator('.impl-empty select[aria-label="Accelerator"]').selectOption('colab-t4');
await page.getByRole('button', { name: 'Plan the implementation' }).click();
await page.waitForSelector('.explain-section h2', { timeout: 20000 });
await page.waitForFunction(() => !document.querySelector('.explain-writing'), null, { timeout: 30000 });
await page.waitForTimeout(400);
const planFigure = page.locator('.explain-figure .figure-art').first();
await planFigure.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await planFigure.click();
await closeup.waitFor({ timeout: 5000 });
await page.waitForTimeout(500);
check('a figure on the Implementation page opens close up', /Figure 1 of 1/.test(await page.locator('.figure-closeup-title').textContent()));
await page.screenshot({ path: `${OUT}/closeup-9-implementation.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll good.');
