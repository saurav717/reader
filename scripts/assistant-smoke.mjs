// The Ask Claude window in a real browser, with Anthropic's API stubbed: it
// opens on ⌘\, asks for a key, reads the screen (the paper, the passage in
// view, the selection), streams an answer, files the chat in History, moves
// with the keyboard and the mouse, and becomes a sheet on a phone.
// Needs a server on BASE (`npm run build && npm start`). Writes screenshots to .smoke/.
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2503.07137v1</id>
    <published>2025-03-10T00:00:00Z</published>
    <title>A Comprehensive Survey of Mixture-of-Experts</title>
    <summary>Mixture of Experts models dynamically select the most relevant sub-models to process input data.</summary>
    <author><name>Siyuan Mu</name></author>
    <author><name>Sen Lin</name></author>
    <link title="pdf" href="http://arxiv.org/pdf/2503.07137v1"/>
    <category term="cs.LG"/>
  </entry>
</feed>`;

const paragraph = (n) =>
  `<div class="ltx_para"><p class="ltx_p">Paragraph ${n}. Mixture of Experts models route each token to a small number of experts, so that the capacity of the network grows without the cost of every forward pass growing with it.</p></div>`;
const ARTICLE = {
  source: 'arxiv',
  base: 'https://arxiv.org/html/2503.07137',
  html: `<html><body><div class="ltx_page_content"><article class="ltx_document">
    <div class="ltx_abstract"><h6 class="ltx_title ltx_title_abstract">Abstract</h6><p class="ltx_p">Artificial intelligence has achieved astonishing successes in many domains.</p></div>
    ${[1, 2, 3, 4, 5, 6].map((s) => `<section class="ltx_section"><h2 class="ltx_title ltx_title_section">${s} Section ${s}</h2>${[1, 2, 3, 4].map((k) => paragraph(`${s}.${k}`)).join('')}</section>`).join('')}
  </article></div></body></html>`,
};

const ANSWER = ['The **gate** picks ', 'a few experts per token.\n\n', '```python\ngate = softmax(W @ x)\n```\n\n', '- sparse\n- cheap'];
const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const STREAM =
  sse('message_start', {
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
  }) +
  sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }) +
  sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'The reader selected the routing sentence.' } }) +
  sse('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } }) +
  sse('content_block_stop', { index: 0 }) +
  sse('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }) +
  ANSWER.map((text) => sse('content_block_delta', { index: 1, delta: { type: 'text_delta', text } })).join('') +
  sse('content_block_stop', { index: 1 }) +
  sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } }) +
  sse('message_stop', {});

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(label);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const viewport = { width: 1440, height: 900 };
const context = await browser.newContext({ viewport });
await context.route('**/api/arxiv/query*', (route) => route.fulfill({ status: 200, contentType: 'application/atom+xml', body: ATOM }));
await context.route('**/api/arxiv/html*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ARTICLE) }));
for (const pattern of ['**/api/arxiv/pdf*', '**/api/pdf*', '**/api/locate*', '**/api.openalex.org/**', '**/api.crossref.org/**', '**/api.semanticscholar.org/**', '**/api.unpaywall.org/**']) {
  await context.route(pattern, (route) => route.fulfill({ status: 404, body: '' }));
}
const requests = [];
await context.route('https://api.anthropic.com/**', (route) => {
  const request = route.request();
  if (request.method() === 'OPTIONS') {
    return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
  }
  requests.push({ headers: request.headers(), body: JSON.parse(request.postData() || '{}') });
  return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: STREAM });
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();

console.log('\n== the window ==');
await page.keyboard.press('Control+Backslash');
const win = page.locator('.assistant-win');
await win.waitFor();
check('⌘\\ opens the window', await win.isVisible());
check('it floats as a column against the right edge', await win.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return getComputedStyle(el).position === 'fixed' && Math.abs(window.innerWidth - r.right - 10) < 2;
}));
check('with no key it asks for one', await page.getByText('Connect your Anthropic account').isVisible());
check('and the compose box waits for it', await page.getByRole('textbox', { name: 'Ask AI' }).isDisabled());
check('the SDK has not been downloaded yet', !(await page.evaluate(() => performance.getEntriesByType('resource').some((e) => /anthropic|sdk/i.test(e.name)))));
await page.screenshot({ path: `${OUT}/assistant-key.png` });
await page.getByLabel('Anthropic API key').fill('sk-ant-test-key');
await page.getByRole('button', { name: 'Save', exact: true }).click();
check('a saved key opens the compose box', await page.getByRole('textbox', { name: 'Ask AI' }).isEnabled());
check('the key is kept in this browser', (await page.evaluate(() => localStorage.getItem('reader.anthropic-key'))) === 'sk-ant-test-key');
await page.keyboard.press('Control+Backslash');
check('⌘\\ closes it again', !(await win.isVisible()));

console.log('\n== reading a paper ==');
if (!(await page.getByLabel('Search papers').isVisible())) await page.getByRole('button', { name: 'Discover papers' }).click();
const chips = page.locator('.discover-panel .chip');
for (let index = 0; index < (await chips.count()); index += 1) {
  const chip = chips.nth(index);
  const wanted = ((await chip.textContent()) || '').trim() === 'arXiv';
  if (wanted !== ((await chip.getAttribute('aria-pressed')) === 'true')) await chip.click();
}
await page.getByLabel('Search papers').fill('mixture of experts survey');
await page.getByLabel('Search papers').press('Enter');
await page.waitForSelector('article.result');
await page.locator('article.result').first().locator('h3').click();
await page.getByRole('button', { name: /^Read$/ }).click();
await page.getByRole('button', { name: 'Read the text instead' }).click({ timeout: 30000 });
await page.waitForSelector('.paper-body .ltx_section', { timeout: 20000 });
await page.evaluate(() => document.querySelector('.reader-scroll').scrollTo(0, 0));

// Select a sentence and send it to Claude from the selection toolbar.
await page.evaluate(() => {
  const p = document.querySelectorAll('.paper-body .ltx_section .ltx_p')[0];
  const node = p.firstChild;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, 'Paragraph 1.1. Mixture of Experts models route each token'.length);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
});
await page.waitForSelector('.selection-toolbar');
await page.locator('.selection-toolbar').getByRole('button', { name: /Ask/ }).click();
await win.waitFor();
check('"Ask" on a selection opens the window with the passage attached', (await page.locator('.chat-quote').textContent()).includes('route each token'));
check('and puts the caret in the box', await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Ask AI'));
await page.keyboard.type('What does the gate do here?');
await page.keyboard.press('Enter');
await page.waitForSelector('.chat-claude pre');
await page.waitForFunction(() => !document.querySelector('.chat-wait'));

const sent = requests[0]?.body;
check('one request went to Anthropic', requests.length === 1);
check('with the browser header the SDK sets', requests[0]?.headers['anthropic-dangerous-direct-browser-access'] === 'true');
check('on the chosen model with adaptive thinking', sent?.model === 'claude-opus-5' && sent?.thinking?.type === 'adaptive' && sent?.stream === true);
const question = sent?.messages?.at(-1)?.content ?? '';
check('the question carries the screen', /<screen>[\s\S]*Title: A Comprehensive Survey of Mixture-of-Experts[\s\S]*<\/screen>/.test(question));
check('including the passage in view', /<passage_in_view>[\s\S]*Paragraph 1\.1/.test(question));
check('and the selection, though focus moved to the chat box', /<selected_text>\nParagraph 1\.1\. Mixture of Experts models route each token\n/.test(question));
check('the attached passage is quoted above the question', /> Paragraph 1\.1[\s\S]*\n\nWhat does the gate do here\?$/.test(question));
check('the paper text sits in the system prompt, cached', sent?.system?.[1]?.cache_control?.type === 'ephemeral' && /<paper_text[\s\S]*Paragraph 6\.4/.test(sent.system[1].text));
check('the answer streams in as Markdown', (await page.locator('.chat-claude strong').first().textContent()) === 'gate' && (await page.locator('.chat-claude li').count()) === 2);
check('code blocks get a Copy button', await page.locator('.chat-claude pre .chat-copy').count() === 1);
check('the reasoning summary is folded away', await page.locator('.chat-thinking summary').isVisible());
check('the quote is used up', (await page.locator('.chat-quote').count()) === 0);
await page.screenshot({ path: `${OUT}/assistant-answer.png` });

console.log('\n== history ==');
const count = await page.locator('.chat-count').textContent();
check('the chat is filed as soon as it is answered', count === '1', count);
await page.getByRole('button', { name: 'New chat' }).click();
check('New chat empties the thread', (await page.locator('.chat-turn').count()) === 0);
await page.getByRole('button', { name: /^History/ }).click();
check('the chat is named after its question', (await page.locator('.chat-hist-title').first().textContent()) === 'What does the gate do here?');
await page.locator('.chat-hist-open').first().click();
check('and reopens with both turns', (await page.locator('.chat-turn').count()) === 2);
await page.getByRole('textbox', { name: 'Ask AI' }).fill('And the load-balancing loss?');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelectorAll('.chat-claude pre').length === 2);
const second = requests[1]?.body?.messages ?? [];
check('a follow-up resends the thread, the screen only on the newest question', second.length === 3 && !second[0].content.includes('<screen>') && second[2].content.includes('<screen>'));

console.log('\n== moving it ==');
const box = () => win.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const start = await box();
await page.mouse.move(start.x + 120, start.y + 17);
await page.mouse.down();
await page.mouse.move(start.x - 280, start.y + 97, { steps: 6 });
await page.mouse.up();
const dragged = await box();
check('the title bar drags it', Math.round(dragged.x) === Math.round(start.x - 400) && Math.round(dragged.y) === Math.round(start.y + 80), JSON.stringify(dragged));
await page.mouse.move(dragged.x + dragged.w - 3, dragged.y + dragged.h - 3);
await page.mouse.down();
await page.mouse.move(dragged.x + dragged.w + 60, dragged.y + dragged.h - 50, { steps: 4 });
await page.mouse.up();
const sized = await box();
check('the corner resizes it', Math.round(sized.w - dragged.w) === 63 && Math.round(sized.x) === Math.round(dragged.x), JSON.stringify(sized));
await page.locator('.chat-body').click({ position: { x: 5, y: 5 } });
await page.keyboard.press('Control+Shift+ArrowLeft');
const snapped = await box();
check('⌘⇧← snaps it to the left half', Math.round(snapped.x) === 70 && Math.round(snapped.h) === 880, JSON.stringify(snapped));
await page.evaluate(() => document.activeElement.blur());
await page.keyboard.press('Control+ArrowRight');
check('⌘→ moves it along', Math.round((await box()).x) === 70 + 44);
await page.reload({ waitUntil: 'networkidle' });
// The Drive screen comes back on a reload; the window waits behind it.
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();
await win.waitFor();
check('it reopens where it was left, after a reload', Math.round((await box()).x) === 70 + 44);
await page.locator('.win-style').click();
check('the frame can be changed', (await win.getAttribute('data-win-style')) === 'clear');
await page.screenshot({ path: `${OUT}/assistant-moved.png` });
await page.getByRole('textbox', { name: 'Ask AI' }).focus();
await page.keyboard.press('Escape');
check('Escape from inside closes it', !(await win.isVisible()));

console.log('\n== on a phone ==');
await page.setViewportSize({ width: 390, height: 844 });
await page.keyboard.press('Control+Backslash');
await win.waitFor();
check('it is a sheet across the bottom', await win.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return el.classList.contains('is-sheet') && Math.round(r.bottom) === 844 - 8 && Math.round(r.width) === 390 - 16;
}));
await page.screenshot({ path: `${OUT}/assistant-phone.png` });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll good.');
