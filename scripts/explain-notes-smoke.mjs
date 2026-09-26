/**
 * Keeping pieces of the Explain page in your notes. The page is written (a
 * stand-in for api.anthropic.com streams scripts/fixtures/explain-attention.md,
 * with the maths fixture's section on the end), and then kept from it: a
 * diagram, a code cell and its output, a table, an equation and a caveat by
 * pointing at them, a passage by selecting it, and a whole section from its
 * heading. They land in the Notes tab as copies — the diagram still a drawing,
 * the code still coloured, the maths still typeset — and survive a reload. A
 * text piece is written among them, one is moved and one deleted, and a
 * piece's label takes you back to it on the page, with Explain open or shut.
 *
 *   npm run build && npm start &
 *   node scripts/explain-notes-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });
const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
// The Attention page — diagrams, code cells, tables, caveats — with the maths
// fixture's section on the end, for an equation to keep.
const maths = (await fixture('explain-maths.md')).split('\n## ').find((part) => part.startsWith('Scaled dot-product attention'));
const FIXTURE = `${await fixture('explain-attention.md')}\n\n## The maths, step by step${maths.slice('Scaled dot-product attention'.length)}`;
const REPLIES = [];

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
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

const errorsBefore = errors.length;
const settle = (ms = 400) => page.waitForTimeout(ms);
const pieces = () => page.locator('.notes-win .note-piece');
const kinds = () => page.locator('.notes-win .note-piece-kind').allTextContents();

console.log('\n== E, and the page is written ==');
await page.mouse.move(W / 2, H / 2);
await page.keyboard.press('e');
await page.waitForSelector('.explain .explain-empty');
await page.getByRole('button', { name: 'Explain this paper' }).click();
await page.waitForSelector('.explain-section h2', { timeout: 20000 });
await page.waitForFunction(() => !document.querySelector('.explain-writing'), null, { timeout: 20000 });
await settle(600);
check('the page has diagrams, cells, a table, an equation and caveats', await page.evaluate(() => ['.explain-figure', '.explain-cell', '.explain-prose table', '.explain-prose .chat-math-block', '.explain-caveat'].every((s) => document.querySelector(s))));

/** Points at a piece of the page and presses the button that comes up on its corner. */
async function keepByPointing(selector, name) {
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded();
  await settle(250);
  const box = await target.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 60));
  await settle(150);
  const button = page.locator('.note-clip-btn');
  const shown = await button.isVisible();
  check(`pointing at ${name} puts “Add to notes” on its corner`, shown);
  if (!shown) return;
  const corner = await button.boundingBox();
  check(`— at its top right`, Math.abs(corner.x + corner.width - (box.x + box.width)) < 16 && corner.y >= box.y - 2 && corner.y < box.y + 40, JSON.stringify({ corner, box }));
  await button.click();
  await settle(200);
  check(`${name}: “added to your notes”`, ((await page.locator('.note-kept').textContent()) || '').includes('added to your notes'));
}

console.log('\n== kept by pointing at them ==');
await keepByPointing('.explain-figure', 'a diagram');
await shot('explain-notes-1-pointing');
await keepByPointing('.explain-cell', 'a code cell');
await keepByPointing('.explain-prose table', 'a table');
await keepByPointing('.explain-prose .chat-math-block', 'an equation');
await keepByPointing('.explain-caveat', 'a caveat');

console.log('\n== a passage, by selecting it ==');
const prose = page.locator('.explain-section[data-title="Multi-head attention"] .explain-prose p').first();
await prose.scrollIntoViewIfNeeded();
await settle(250);
const pbox = await prose.boundingBox();
await page.mouse.move(pbox.x + 3, pbox.y + 5);
await page.mouse.down();
await page.mouse.move(pbox.x + pbox.width * 0.8, pbox.y + pbox.height - 6, { steps: 8 });
await page.mouse.up();
await settle(250);
const addSel = page.locator('.selection-toolbar').getByRole('button', { name: /Add to notes/ });
check('the selection toolbar has “Add to notes”, beside “Ask Claude”', (await addSel.count()) === 1 && (await page.locator('.selection-toolbar').getByRole('button', { name: /Ask AI/ }).count()) === 1);
const selected = await page.evaluate(() => window.getSelection().toString().trim());
await shot('explain-notes-2-selection');
await addSel.click();
await settle(200);
check('the passage is kept', ((await page.locator('.note-kept').textContent()) || '').includes('Passage'));

console.log('\n== a whole section, from its heading ==');
const head = page.locator('.explain-section[data-title="Where is each word? Positional encoding"] .explain-section-head');
await head.scrollIntoViewIfNeeded();
await head.hover();
await head.getByRole('button', { name: 'Add to notes' }).click();
await settle(200);
check('the section is kept', ((await page.locator('.note-kept').textContent()) || '').includes('Section'));

console.log('\n== ✂ Snip: a box over the page ==');
const snip = page.locator('.explain-bar .snip-toggle');
check('the bar has ✂ Snip', (await snip.count()) === 1);
await snip.click();
await page.waitForSelector('.box-snip-layer', { timeout: 3000 });
const snipped = page.locator('.explain-section[data-title="Training and results"] .explain-prose').first();
await snipped.evaluate((el) => el.scrollIntoView({ block: 'center' }));
await settle(300);
const sb = await snipped.boundingBox();
await page.mouse.move(sb.x + 10, sb.y + 8);
await page.mouse.down();
await page.mouse.move(sb.x + sb.width * 0.6, sb.y + Math.min(sb.height - 8, 90), { steps: 8 });
check('what the box touches is lit', (await page.locator('.is-snip-picked').count()) >= 1);
await page.mouse.up();
await settle(300);
check('letting go keeps it', ((await page.locator('.note-kept').textContent()) || '').includes('Snip'));
await page.keyboard.press('Escape');
await settle(200);
check('Esc puts the snip tool away, and leaves Explain open', (await page.locator('.box-snip-layer').count()) === 0 && (await page.locator('.explain').count()) === 1);

console.log('\n== they are in the notes, as they were drawn ==');
await page.locator('.note-kept').getByRole('button', { name: 'Open notes' }).click();
await page.waitForSelector('.notes-win', { timeout: 5000 });
await settle(500);
check('“Open notes” opens them over Explain, in their window', (await page.locator('.notes-win').count()) === 1);
check('on the Notes tab', (await page.locator('.notes-win [role="tab"][aria-selected="true"]').textContent())?.startsWith('Notes'));
const labels = await kinds();
check('eight pieces, in the order they were kept', labels.length === 8 && labels[7] === 'Snip' && /^Diagram/.test(labels[0]) && /^(Code|Output)/.test(labels[1]) && labels[2] === 'Table' && labels[3] === 'Equation' && /^Caveat/.test(labels[4]) && labels[5] === 'Passage' && labels[6] === 'Section', labels.join(' | '));
check('the diagram is still a drawing', (await page.locator('.notes-win .note-piece').nth(0).locator('.note-clip svg').count()) === 1);
check('the code is still coloured', (await page.locator('.notes-win .note-piece').nth(1).locator('.note-clip .tok-k, .note-clip .tok-f').count()) > 0);
check('the table is still a table', (await page.locator('.notes-win .note-piece').nth(2).locator('.note-clip table tr').count()) >= 2);
check('the equation is still typeset', (await page.locator('.notes-win .note-piece').nth(3).locator('.note-clip .katex').count()) >= 1);
check('the passage is the words selected', ((await page.locator('.notes-win .note-piece').nth(5).locator('.note-clip').textContent()) || '').replace(/\s+/g, ' ').includes(selected.replace(/\s+/g, ' ').slice(0, 40)));
check('the page’s own buttons are left behind', (await page.locator('.notes-win .note-clip button').count()) === 0);
check('each says where it came from', ((await page.locator('.notes-win .note-piece').nth(5).locator('.note-source').textContent()) || '').includes('Multi-head attention'));
await shot('explain-notes-3-in-the-notes');

console.log('\n== written among them, moved, deleted ==');
await page.locator('.notes-win').getByRole('button', { name: 'Write' }).click();
await settle(300);
await page.keyboard.type('Multi-head = several questions at once; each head has its own small Q, K, V.');
check('Write adds a text piece and puts the cursor in it', (await kinds()).at(-1) === 'Text');
const text = page.locator('.notes-win .note-piece.is-text');
await text.hover();
await text.getByRole('button', { name: 'Move up' }).click();
await settle(200);
check('↑ moves it up one', (await kinds()).at(-2) === 'Text');
const eq = page.locator('.notes-win .note-piece').filter({ has: page.locator('.note-piece-kind', { hasText: /^Equation$/ }) });
await eq.hover();
await eq.getByRole('button', { name: 'Delete' }).click();
await settle(200);
check('the bin deletes a piece', !(await kinds()).includes('Equation') && (await kinds()).length === 8);
const diagram = page.locator('.notes-win .note-piece').first();
await diagram.getByRole('button', { name: '+ note' }).click();
await page.keyboard.type('The figure to remember.');
await page.locator('.notes-win .win-name').click();
await settle(200);

console.log('\n== kept, after a reload ==');
await page.reload({ waitUntil: 'networkidle' });
const notNow = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
if (await notNow.isVisible().catch(() => false)) await notNow.click();
await page.waitForSelector('.explain-section', { timeout: 20000 });
await page.mouse.move(W / 2, H / 2);
await page.keyboard.press('h');
await page.waitForSelector('.notes-win .note-piece', { timeout: 5000 });
await settle(300);
const after = await kinds();
check('the notes are all there', after.length === 8 && after.at(-2) === 'Text', after.join(' | '));
// Written notes are drawn as Markdown until clicked: the words, either way.
const written = await page.locator('.notes-win .note-piece.is-text :is(textarea, .note-shown)').first().evaluate((element) => (element instanceof HTMLTextAreaElement ? element.value : element.textContent || '').trim());
check('the text written is kept', written.startsWith('Multi-head = several'), written);
check('and the line under the diagram', (await page.locator('.notes-win .note-piece').first().locator('textarea').inputValue()) === 'The figure to remember.');

console.log('\n== back to where a piece came from ==');
const passage = page.locator('.notes-win .note-piece').filter({ has: page.locator('.note-piece-kind', { hasText: /^Passage$/ }) });
await page.locator('.explain-scroll').evaluate((el) => { el.scrollTop = 0; });
await passage.locator('.note-source').click();
await page.waitForSelector('.passage-flash', { timeout: 5000 }).catch(() => undefined);
check('its label marks the passage on the Explain page', (await page.locator('.passage-flash').count()) === 1);
await settle(600);
await shot('explain-notes-4-back-to-it');
await page.locator('.explain').getByRole('button', { name: /Close the explanation/ }).click();
await settle(400);
check('with Explain shut…', (await page.locator('.explain').count()) === 0);
const sectionPiece = page.locator('.notes-win .note-piece').filter({ has: page.locator('.note-piece-kind', { hasText: /^Section$/ }) });
await sectionPiece.locator('.note-source').click();
await page.waitForSelector('.explain .explain-section', { timeout: 8000 }).catch(() => undefined);
await settle(900);
check('…the label opens it again', (await page.locator('.explain').count()) === 1);
const top = await page.locator('.explain-section[data-title="Where is each word? Positional encoding"]').evaluate((el) => {
  const scroller = el.closest('.explain-scroll');
  return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
});
check('and brings the section into view', top > -40 && top < 300, `${Math.round(top)}px from the top`);

check('no page errors', errors.length === errorsBefore, errors.slice(errorsBefore).join('\n'));
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log('\nall good');
