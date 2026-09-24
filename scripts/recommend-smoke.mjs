// Papers Claude recommends, in a real browser with Anthropic's API stubbed: the
// answer's `papers` block is drawn as result cards under the prose, and a press
// on one searches for that paper in Discover and opens its result there.
// Needs a server on BASE (`npm run build && npm start`). Writes screenshots to .smoke/.
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1505.00001v1</id>
    <published>1992-01-01T00:00:00Z</published>
    <title>Stacked generalization</title>
    <summary>A scheme for minimizing the generalization error rate of one or more generalizers.</summary>
    <author><name>David H. Wolpert</name></author>
    <link title="pdf" href="http://arxiv.org/pdf/1505.00001v1"/>
  </entry>
</feed>`;

const ANSWER = [
  'Based on the reference list, a short path:\n\n- **Wolpert 1992** — the basis of late fusion.\n',
  '- **Breiman 1996** — stacked regressions.\n\n```papers\n{"title": "Stacked generalization", "authors": "Wolpert", "year": 1992, "why": "The basis of Late Fusion."}\n',
  '{"title": "Stacked regressions", "authors": "Breiman", "year": 1996, "why": "Stacking for regression."}\n```',
];
const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const STREAM =
  sse('message_start', {
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
  }) +
  sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
  ANSWER.map((text) => sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })).join('') +
  sse('content_block_stop', { index: 0 }) +
  sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } }) +
  sse('message_stop', {});

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(label);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const searched = [];
await context.route('**/api/arxiv/query*', (route) => {
  searched.push(route.request().url());
  return route.fulfill({ status: 200, contentType: 'application/atom+xml', body: ATOM });
});
for (const pattern of ['**/api/arxiv/pdf*', '**/api/pdf*', '**/api/locate*', '**/api/scholar*', '**/api.openalex.org/**', '**/api.crossref.org/**', '**/api.semanticscholar.org/**', '**/api.unpaywall.org/**']) {
  await context.route(pattern, (route) => route.fulfill({ status: 404, body: '' }));
}
await context.route('https://api.anthropic.com/**', (route) => {
  if (route.request().method() === 'OPTIONS') {
    return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
  }
  return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: STREAM });
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();
// Discover searches arXiv only, which is the index stubbed here. It stays
// open, under the window's default place against the right edge.
if (!(await page.locator('.discover-panel').count())) await page.getByRole('button', { name: 'Discover papers' }).click();
const chips = page.locator('.discover-panel .chip');
for (let index = 0; index < (await chips.count()); index += 1) {
  const chip = chips.nth(index);
  const wanted = ((await chip.textContent()) || '').trim() === 'arXiv';
  if (wanted !== ((await chip.getAttribute('aria-pressed')) === 'true')) await chip.click();
}

await page.keyboard.press('Control+Backslash');
await page.locator('.assistant-win').waitFor();
const covers = () => page.evaluate(() => document.querySelector('.assistant-win').getBoundingClientRect().right > document.querySelector('.discover-panel').getBoundingClientRect().left);
check('the window starts over Discover', await covers());
await page.getByLabel('Anthropic API key').fill('sk-ant-test-key');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.getByRole('textbox', { name: 'Ask Claude' }).fill('What other papers should I read to understand this one?');
await page.keyboard.press('Enter');
await page.waitForSelector('.chat-paper');
await page.waitForFunction(() => !document.querySelector('.chat-wait'));

const cards = page.locator('.chat-paper');
check('each recommended paper is a card', (await cards.count()) === 2);
check('with its title, authors and year', /Stacked generalization/.test(await cards.nth(0).textContent()) && /Wolpert/.test(await cards.nth(0).textContent()) && /1992/.test(await cards.nth(0).textContent()));
check('the block itself is not shown as code', !(await page.locator('.chat-claude pre').count()) && !/```|"title"/.test(await page.locator('.chat-claude .chat-text').textContent()));
check('the prose stays', /a short path/.test(await page.locator('.chat-claude .chat-text').textContent()));
await page.screenshot({ path: `${OUT}/recommend-cards.png` });

await cards.nth(0).click();
await page.waitForSelector('.discover-panel article.result.is-open', { timeout: 15000 }).catch(async () => { await page.screenshot({ path: `${OUT}/recommend-fail.png` }); });
check('the window steps out of the way of Discover', !(await covers()));
check('a press searches Discover for the title', (await page.getByLabel('Search papers').inputValue()) === 'Stacked generalization');
check('and opens the matching result, with its Read button', /Stacked generalization/.test(await page.locator('.discover-panel article.result.is-open h3').textContent()) && (await page.locator('.discover-panel article.result.is-open').getByRole('button', { name: /^Read$/ }).count()) === 1);
await page.screenshot({ path: `${OUT}/recommend-discover.png` });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(problems.length ? `\n${problems.length} failed` : '\nall passed');
process.exit(problems.length ? 1 : 0);
