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
const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const FIXTURE = await fixture('explain-attention.md');
const REPLIES = [await fixture('explain-revise-heads.md'), await fixture('explain-revise-question.md')];

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
  ({ first, replies }) => {
    const real = window.fetch.bind(window);
    window.__asked = [];
    window.__hold = null;
    let next = 0;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.startsWith('https://api.anthropic.com')) return real(input, init);
      const body = JSON.parse(init?.body ?? '{}');
      window.__asked.push(body);
      const events = body.messages.length > 1 ? replies[next++ % replies.length] : first;
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
  { first: sse(FIXTURE), replies: REPLIES.map((reply) => sse(reply, 120)) },
);
const lastAsked = () => page.evaluate(() => window.__asked.at(-1) ?? null);
const askedCount = () => page.evaluate(() => window.__asked.length);

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

console.log('\n== in dark glass, before it is written ==');
await withSettings({ theme: 'dark', glass: true });
check('glass frosts what is behind the page', /blur/.test(await page.locator('.explain').evaluate((el) => getComputedStyle(el).backdropFilter)));
check('the ask bar is plainly off until there is a page', (await page.locator('.ask-field.is-off').count()) === 1);
await page.screenshot({ path: `${OUT}/explain-1b-start-glass-dark.png` });
await withSettings({ theme: 'light', glass: true });
await page.screenshot({ path: `${OUT}/explain-1c-start-glass-light.png` });
await withSettings({ theme: 'light', glass: false });

console.log('\n== Claude writes it ==');
await page.getByRole('button', { name: 'Explain this paper' }).click();
await page.waitForSelector('.explain-section h2', { timeout: 20000 });
await page.waitForFunction(() => !document.querySelector('.explain-writing'), null, { timeout: 20000 });
const asked = await lastAsked();
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

console.log('\n== the bar at the top: adjust a section ==');
const bar = page.getByLabel('Ask about the explanation, or ask for a change');
await page.locator('.explain-scroll').evaluate((el) => {
  el.scrollTop = 0;
});
await bar.click();
await page.waitForTimeout(200);
check('an empty bar offers suggestions', (await page.locator('.ask-suggestion').count()) >= 3);
await page.screenshot({ path: `${OUT}/explain-10-bar.png` });
const heads = page.locator('.explain-section[data-title="Multi-head attention"]');
await heads.scrollIntoViewIfNeeded();
await heads.hover();
await heads.getByRole('button', { name: 'Ask or adjust' }).click();
check('Ask or adjust puts the section in the bar', (await page.locator('.ask-chip').first().textContent())?.includes('Multi-head attention'));
await bar.fill('Explain this more simply, with an analogy and a figure');
await page.evaluate(() => {
  let release;
  window.__hold = { at: 24, until: new Promise((resolve) => (release = resolve)) };
  window.__release = release;
});
await bar.press('Enter');
await page.waitForSelector('.explain-section.is-revising', { timeout: 10000 });
await page.waitForTimeout(700);
check('the section rewrites itself in place', (await page.locator('.explain-section.is-revising h2').textContent()) === 'Multi-head attention');
check('the rest of the page stays', (await page.locator('.explain-section').count()) === 8);
const revising = await lastAsked();
check('the request is scoped to the section', /<about_section>\s*Multi-head attention/.test(revising.messages.at(-1).content));
check('the page as written goes along as Claude’s own turn', revising.messages[1]?.role === 'assistant' && revising.messages[1].content.includes('## Since then'));
check('the paper is read from the same cached system prompt', JSON.stringify(revising.system) === JSON.stringify(asked.system));
await page.screenshot({ path: `${OUT}/explain-11-revising.png` });
await page.evaluate(() => window.__release());
await page.waitForSelector('.ask-status.is-done', { timeout: 10000 });
await page.waitForTimeout(400);
check('Claude’s note says what changed', /analogy/.test(await page.locator('.ask-status.is-done').textContent()));
check('the new figure is drawn', (await page.locator('.explain-figure svg').count()) === 4);
check('the section is marked as revised', (await heads.locator('.revised-pill').count()) === 1);
await page.locator('.explain-scroll').evaluate((el) => {
  const target = el.querySelector('.explain-section[data-title="Multi-head attention"]');
  el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/explain-12-revised.png` });

console.log('\n== the bar at the top: a question about a selected passage ==');
const training = page.locator('.explain-section[data-title="Training and results"]');
await training.scrollIntoViewIfNeeded();
const passage = training.locator('.explain-prose p').first();
const box = await passage.boundingBox();
await page.mouse.move(box.x + 2, box.y + 4);
await page.mouse.down();
await page.mouse.move(box.x + box.width - 4, box.y + box.height - 6, { steps: 6 });
await page.mouse.up();
check('a selection becomes what the question is about', (await page.locator('.ask-chip.quote').count()) === 1);
await bar.fill('Why does label smoothing help BLEU if it hurts perplexity?');
await page.screenshot({ path: `${OUT}/explain-13-question.png` });
await bar.press('Enter');
await page
  .waitForFunction(() => document.querySelector('.ask-status.is-done')?.textContent?.includes('label smoothing'), null, { timeout: 10000 })
  .catch(async () => console.log('  the bar says:', await page.locator('.ask-column').textContent()));
const titles = await page.locator('.explain-section h2').allTextContents();
check('the answer is a new section after the one asked about', titles[titles.indexOf('Training and results') + 1] === 'Why label smoothing helps BLEU but hurts perplexity', titles.join(' | '));
check('"Since then" stays last', titles.at(-1) === 'Since then');
await page.locator('.explain-scroll').evaluate((el) => {
  const target = el.querySelector('.explain-section[data-title="Why label smoothing helps BLEU but hurts perplexity"]');
  el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/explain-14-answered.png` });

console.log('\n== Undo ==');
await page.getByRole('button', { name: 'Undo' }).click();
await page.waitForTimeout(300);
check('Undo takes the answer back out', (await page.locator('.explain-section').count()) === 8);
check('and leaves the earlier change', (await heads.locator('.explain-figure').count()) === 1);

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

console.log('\n== background opacity ==');
const background = () => page.locator('.explain').evaluate((el) => getComputedStyle(el).backgroundColor);
check('solid paper by default', !/\/|rgba|color\(/.test(await background()), await background());
await page.getByRole('button', { name: 'Background opacity' }).click();
await page.getByRole('slider', { name: /How opaque/ }).fill('0.4');
await page.waitForTimeout(300);
check('turned down, the page lets the paper through', /0\.4\b|40%/.test(await background()), await background());
check('and frosts it', /blur/.test(await page.locator('.explain').evaluate((el) => getComputedStyle(el).backdropFilter)));
await page.screenshot({ path: `${OUT}/explain-7b-beside-see-through.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('Esc closes the slider, not the explanation', (await page.locator('.opacity-pop').count()) === 0 && (await page.locator('.explain').count()) === 1);
const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('reader.settings') || '{}').explainOpacity);
check('the choice is kept in settings', kept === 0.4, String(kept));
await withSettings({ glass: true });
check('glass takes the chosen opacity too', /0\.4\b/.test(await background()), await background());
await page.screenshot({ path: `${OUT}/explain-7c-beside-see-through-glass.png` });
await page.getByRole('button', { name: 'Background opacity' }).click();
await page.getByRole('button', { name: 'Reset' }).click();
check('Reset goes back to the material', (await page.evaluate(() => JSON.parse(localStorage.getItem('reader.settings') || '{}').explainOpacity)) === null);
await page.keyboard.press('Escape');
await withSettings({ glass: false });

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
await page.reload({ waitUntil: 'networkidle' });
const notNow = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
if (await notNow.isVisible().catch(() => false)) await notNow.click();
await page.waitForSelector('.explain-section h2', { timeout: 20000 });
check('it comes back without asking Claude again', (await askedCount()) === 0);
await page.locator('.explain-scroll').evaluate((el) => {
  const target = el.querySelector('#explain-the-block-residuals-layernorm-and-the-feed-forward-layer');
  el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/explain-8-dark.png` });
await withSettings({ glass: true });
await page.locator('.explain-scroll').evaluate((el) => {
  const target = el.querySelector('#explain-scaled-dot-product-attention');
  el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/explain-8b-dark-glass.png` });

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
