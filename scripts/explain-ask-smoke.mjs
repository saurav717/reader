/**
 * Maths on the Explain page, and Ask Claude over it. A paper's explanation is
 * written with LaTeX (scripts/fixtures/explain-maths.md) and must come out
 * typeset by KaTeX. Then the Claude window is opened over it: what Claude is
 * sent must carry the explanation beside the paper, and a passage it points
 * at with "in": "explanation" must be marked on the explanation, not on the
 * paper hidden underneath. A passage selected on the explanation can be sent
 * to Claude from the toolbar that appears under it.
 *
 *   npm run build && npm start &
 *   node scripts/explain-ask-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });
const FIXTURE = await readFile(new URL('./fixtures/explain-maths.md', import.meta.url), 'utf8');
const ANSWER = [
  'The square root keeps the scores in a range where the softmax still has a slope — see [the explanation](passage:1).',
  '',
  '```passages',
  '{"quote": "Dividing by the square root of the key width keeps the scores from growing with the dimension", "label": "Why the scores are scaled", "in": "explanation", "show": true}',
  '```',
].join('\n');

const TITLE = 'Attention Is All You Need';
const W = 1440;
const H = 900;

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

function sse(text, size = 200) {
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
  body.push(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 600 } }));
  body.push(event('message_stop', { type: 'message_stop' }));
  return body;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

const printer = await browser.newPage();
const para =
  'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms. ';
const section = (n, name) => `<section style="break-after: page"><h2>${n}. ${name}</h2>${`<p>${para.repeat(3)}</p>`.repeat(5)}</section>`;
await printer.setContent(
  `<!doctype html><html><body style="font-family: serif; font-size: 11pt; margin: 0.8in">
    <h1 style="text-align:center">${TITLE}</h1>
    <h3>Abstract</h3><p>${para.repeat(2)}</p>
    ${section(1, 'Introduction')}${section(2, 'Background')}${section(3, 'Model Architecture')}
  </body></html>`,
);
const PDF = await printer.pdf({ format: 'Letter', printBackground: true });
await printer.close();

const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await context.route('**/pdf?*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }));
for (const host of ['api.crossref.org', 'api.semanticscholar.org', 'dblp.org', 'wikidata.org', 'api.openalex.org']) {
  await context.route(`**/${host}/**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[],"data":[],"message":{"items":[]},"result":{"hits":{}}}' }));
}
await context.route('**/scholar/search*', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      results: [{ id: '2001', clusterId: '2001', title: TITLE, url: 'https://arxiv.org/abs/1706.03762', pdfUrl: 'https://example.org/attention.pdf', authors: ['A Vaswani', 'N Shazeer'], year: 2017, snippet: 'Attention.' }],
    }),
  }),
);
await context.route('**/scholar/{authors,person,paper-authors,cluster}*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[]}' }));
// api.anthropic.com, stood in for inside the page: Explain gets the page, Ask Claude the answer.
await context.addInitScript(
  ({ page, answer }) => {
    const real = window.fetch.bind(window);
    window.__asked = [];
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.startsWith('https://api.anthropic.com')) return real(input, init);
      const body = JSON.parse(init?.body ?? '{}');
      window.__asked.push(body);
      const system = Array.isArray(body.system) ? body.system.map((b) => b.text).join('\n') : String(body.system ?? '');
      const events = /explanation page of a research-paper reader/.test(system) ? page : answer;
      const stream = new ReadableStream({
        start(controller) {
          for (const event of events) controller.enqueue(new TextEncoder().encode(event));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_smoke' } });
    };
  },
  { page: sse(FIXTURE), answer: sse(ANSWER, 80) },
);

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

console.log('\n== open a paper, and its explanation ==');
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
await page.mouse.move(W / 2, H / 2);
await page.keyboard.press('e');
await page.getByRole('button', { name: 'Explain this paper' }).click();
await page.waitForSelector('.explain-section h2', { timeout: 20000 });
await page.waitForFunction(() => !document.querySelector('.explain-writing'), null, { timeout: 20000 });

console.log('\n== the maths is typeset ==');
check('Claude is asked for LaTeX', /as LaTeX/.test((await page.evaluate(() => window.__asked[0].system.map((b) => b.text).join('\n')))));
await page.waitForSelector('.explain-prose .chat-math-block .katex-display', { timeout: 10000 });
check('the displayed equation is typeset', (await page.locator('.explain-prose .chat-math-block[data-set="1"] .katex-display').count()) === 1);
const inlineSet = await page.locator('.explain-prose .chat-math[data-set="1"] .katex').count();
check('inline maths is typeset', inlineSet >= 4, String(inlineSet));
check('inline maths in a table is typeset', (await page.locator('.explain-prose td .chat-math .katex').count()) === 1);
check('no TeX is left raw', (await page.locator('.explain-prose .chat-math:not([data-set]), .explain-prose .chat-math-block:not([data-set])').count()) === 0);
check('no KaTeX error', (await page.locator('.explain .katex-error').count()) === 0);
await page.locator('#explain-scaled-dot-product-attention').scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/explain-maths.png` });

console.log('\n== Ask Claude over the explanation ==');
await page.keyboard.press('Control+Backslash');
const box = page.getByRole('textbox', { name: 'Ask Claude' });
await box.waitFor();
await box.fill('Why divide by the square root?');
await box.press('Enter');
await page.waitForSelector('.chat-passages', { timeout: 15000 });
const asked = await page.evaluate(() => window.__asked.at(-1));
const system = asked.system.map((b) => b.text).join('\n');
check('the paper goes along', /<paper_text/.test(system));
check('and the explanation, after it', /<explanation_text[^>]*>\n## At a glance/.test(system) && system.indexOf('<paper_text') < system.indexOf('<explanation_text'));
const lead = JSON.stringify(asked.messages.at(-1).content);
check('the part of the explanation in view goes along', /explanation_in_view/.test(lead) && /Scaled dot-product attention/.test(lead));
check('the paper under it is not called the passage in view', !/passage_in_view/.test(lead));
await page.waitForSelector('.passage-band', { timeout: 10000 });
await page.waitForTimeout(1200);
check('the list says it is in the explanation', /Found in the explanation/.test(await page.locator('.chat-passages-title').textContent()));
const band = await page.locator('.passage-band').first().boundingBox();
const under = await page.evaluate(({ x, y }) => document.elementsFromPoint(x, y).find((el) => el.closest?.('.explain-doc') && /square root of the key width/.test(el.textContent ?? '')) ? 'explanation' : document.elementsFromPoint(x, y).map((el) => el.className).join(' '), { x: band.x + band.width / 2, y: band.y + band.height / 2 });
check('the mark lies over the words on the explanation', under === 'explanation', under);
const caption = await page.locator('.passage-tag').textContent();
check('the caption says where', /The explanation/.test(caption) && /Scaled dot-product attention/.test(caption), caption);
check('the row says it is on the page', /On the page now/.test(await page.locator('.chat-passage-row').first().textContent()));
await page.screenshot({ path: `${OUT}/explain-ask-marked.png` });
await page.locator('.passage-tag button').click();

console.log('\n== a selection on the explanation, to Ask Claude ==');
const target = page.locator('.explain-prose p', { hasText: 'Each position asks a question' });
await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
await page.waitForTimeout(300);
const rect = await target.boundingBox();
await page.mouse.move(rect.x + 2, rect.y + 6);
await page.mouse.down();
await page.mouse.move(rect.x + 300, rect.y + 8, { steps: 6 });
await page.mouse.up();
await page.waitForSelector('.selection-toolbar', { timeout: 5000 });
await page.locator('.selection-toolbar button', { hasText: 'Ask Claude' }).click();
const quote = await page.locator('.chat-quote-text').textContent();
check('the selection is attached to the next question', /Each position asks/.test(quote), quote);
await box.fill('Say that more simply.');
await box.press('Enter');
await page.waitForFunction(() => window.__asked.length >= 3, null, { timeout: 10000 });
const second = JSON.stringify((await page.evaluate(() => window.__asked.at(-1))).messages.at(-1).content);
check('Claude is told the selection is on the explanation', /selected_text in=\\"the explanation\\"/.test(second), second.slice(0, 300));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nall good');
process.exit(problems.length ? 1 : 0);
