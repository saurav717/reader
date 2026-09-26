// Ask AI and Explain on DeepSeek, in a real browser with api.deepseek.com
// stubbed: the model picker offers DeepSeek beside Claude, a DeepSeek model
// asks for a DeepSeek key, the question goes to deepseek-flash with thinking on
// (pictures go as image_url parts — scripts/deepseek.test.mjs), the answer and its reasoning stream in
// under the model's name,
// and Settings and Explain let the model be picked for each.
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

const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const STREAM =
  chunk({ role: 'assistant', content: null, reasoning_content: 'The reader asks about the gate.' }) +
  ': keep-alive\n\n' +
  chunk({ content: 'The **gate** sends each token ' }) +
  chunk({ content: 'to a few experts.\n\n- sparse\n- cheap' }) +
  chunk({ content: '' }, 'stop') +
  'data: [DONE]\n\n';

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(label);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.route('**/api/arxiv/query*', (route) => route.fulfill({ status: 200, contentType: 'application/atom+xml', body: ATOM }));
await context.route('**/api/arxiv/html*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ARTICLE) }));
for (const pattern of ['**/api/arxiv/pdf*', '**/api/pdf*', '**/api/locate*', '**/api.openalex.org/**', '**/api.crossref.org/**', '**/api.semanticscholar.org/**', '**/api.unpaywall.org/**']) {
  await context.route(pattern, (route) => route.fulfill({ status: 404, body: '' }));
}
const requests = [];
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' };
await context.route('https://api.deepseek.com/**', (route) => {
  const request = route.request();
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  requests.push({ headers: request.headers(), body: JSON.parse(request.postData() || '{}') });
  return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', ...cors }, body: STREAM });
});
let anthropicCalls = 0;
await context.route('https://api.anthropic.com/**', (route) => {
  anthropicCalls += 1;
  return route.fulfill({ status: 500, body: '' });
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();

console.log('\n== picking DeepSeek ==');
await page.keyboard.press('Control+Backslash');
const win = page.locator('.assistant-win');
await win.waitFor();
check('the window is called Ask AI', (await win.locator('.win-name').textContent()) === 'Ask AI');
const picker = page.getByLabel('Model');
const groups = await picker.locator('optgroup').evaluateAll((els) => els.map((el) => el.label));
check('the picker groups Claude and DeepSeek models', groups.length === 2 && /Anthropic/.test(groups[0]) && /DeepSeek/.test(groups[1]), groups.join(' | '));
await picker.selectOption('deepseek-flash');
check('a DeepSeek model asks for a DeepSeek key', await page.getByText('Connect your DeepSeek account').isVisible());
await page.screenshot({ path: `${OUT}/deepseek-key.png` });
await page.getByLabel('DeepSeek API key').fill('sk-deepseek-test');
await page.getByRole('button', { name: 'Save', exact: true }).click();
check('the key is kept under its own name', (await page.evaluate(() => localStorage.getItem('reader.deepseek-key'))) === 'sk-deepseek-test');
check('and the Anthropic one is untouched', (await page.evaluate(() => localStorage.getItem('reader.anthropic-key'))) === null);
check('the compose box opens', await page.getByRole('textbox', { name: 'Ask AI' }).isEnabled());
await page.keyboard.press('Control+Backslash');

console.log('\n== asking ==');
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
await page.keyboard.press('Control+Backslash');
await win.waitFor();
check('the screenshot button is on: DeepSeek Flash reads pictures', await page.getByRole('button', { name: 'Attach a screenshot of this tab' }).isEnabled().catch(() => false));
await page.getByRole('textbox', { name: 'Ask AI' }).fill('What does the gate do?');
await page.keyboard.press('Enter');
await page.waitForSelector('.chat-claude li');
await page.waitForFunction(() => !document.querySelector('.chat-claude.is-streaming'));

const sent = requests[0]?.body;
check('one request went to DeepSeek, none to Anthropic', requests.length === 1 && anthropicCalls === 0);
check('with the key as a bearer token', requests[0]?.headers.authorization === 'Bearer sk-deepseek-test');
check('on deepseek-flash, streaming, thinking hard', sent?.model === 'deepseek-flash' && sent?.stream === true && sent?.thinking?.type === 'enabled' && sent?.reasoning_effort === 'high');
check('the system prompt leads, with the paper in it', sent?.messages?.[0]?.role === 'system' && /<paper_text[\s\S]*Paragraph 6\.4/.test(sent.messages[0].content));
const question = sent?.messages?.at(-1)?.content;
check('the question carries the screen', typeof question === 'string' && /<screen>[\s\S]*Mixture-of-Experts/.test(question) && question.endsWith('What does the gate do?'));
check('the answer streams in as Markdown', (await page.locator('.chat-claude strong').first().textContent()) === 'gate' && (await page.locator('.chat-claude li').count()) === 2);
check('under the model’s name', ((await page.locator('.chat-claude .chat-who').textContent()) || '').includes('DeepSeek Flash'));
check('with its reasoning folded away', await page.locator('.chat-thinking summary').isVisible());
await page.screenshot({ path: `${OUT}/deepseek-answer.png` });
await page.locator('.chat-toolbar').getByRole('button', { name: 'Settings' }).click();
check('⚙ lists a key for each provider', (await page.locator('.chat-settings .set-key').count()) === 1 && (await page.locator('.chat-settings .set-key-add').count()) === 1);
await page.screenshot({ path: `${OUT}/deepseek-chat-settings.png` });
await page.keyboard.press('Control+Backslash');

console.log('\n== Explain ==');
await page.keyboard.press('e');
await page.waitForSelector('.model-pick');
const tiles = await page.locator('.model-pick [role=radio] b').allTextContents();
check('Explain offers every model', tiles.includes('DeepSeek Flash') && tiles.includes('Claude Opus 5'), tiles.join(', '));
await page.locator('.model-pick [role=radio]', { hasText: 'Claude Opus 5' }).click();
check('a Claude model with no key asks for an Anthropic key there', await page.getByLabel('Anthropic API key').isVisible());
await page.locator('.model-pick [role=radio]', { hasText: 'no thinking' }).click();
check('with its key, DeepSeek can start', await page.getByRole('button', { name: 'Explain this paper' }).isVisible());
await page.screenshot({ path: `${OUT}/deepseek-explain.png` });
check('the choice is kept apart from the chat’s', await page.evaluate(() => {
  const prefs = JSON.parse(localStorage.getItem('reader.assistant.v1') || '{}');
  return prefs.explainModel === 'deepseek-flash-fast' && prefs.model === 'deepseek-flash';
}));
await page.keyboard.press('Escape');

console.log('\n== Settings ==');
await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
const section = page.locator('section', { hasText: 'AI models' });
await section.scrollIntoViewIfNeeded();
check('Settings has an AI models section with both pickers', (await section.locator('select').count()) === 2);
check('which show the current choices', (await section.locator('select').nth(0).inputValue()) === 'deepseek-flash' && (await section.locator('select').nth(1).inputValue()) === 'deepseek-flash-fast');
await section.screenshot({ path: `${OUT}/deepseek-settings.png` });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s)` : '\nall good');
process.exit(problems.length ? 1 : 0);
