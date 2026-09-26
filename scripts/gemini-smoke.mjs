// Ask AI and Explain on Gemini, in a real browser with Google's API stubbed:
// the model picker offers Gemini beside Claude and DeepSeek, a Gemini model
// asks for a Google AI Studio key, the question goes to gemini-3.8-flash with
// the key in a header and the paper in the system instruction, the answer and
// its thought summary stream in under the model's name, the tokens go on the
// owner's tally, and Explain can be written by it.
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

const event = (parts, finishReason, usageMetadata) =>
  `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }], ...(usageMetadata ? { usageMetadata } : {}) })}\r\n\r\n`;
const STREAM =
  event([{ text: 'The reader asks about the gate.', thought: true }]) +
  event([{ text: 'The **gate** sends each token ' }]) +
  event([{ text: 'to a few experts.\n\n- sparse\n- cheap' }], 'STOP', { promptTokenCount: 4000, cachedContentTokenCount: 0, candidatesTokenCount: 20, thoughtsTokenCount: 30 });

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
await context.route('https://generativelanguage.googleapis.com/**', (route) => {
  const request = route.request();
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  requests.push({ url: request.url(), headers: request.headers(), body: JSON.parse(request.postData() || '{}') });
  return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', ...cors }, body: STREAM });
});
let others = 0;
for (const host of ['https://api.anthropic.com/**', 'https://api.deepseek.com/**']) {
  await context.route(host, (route) => {
    others += 1;
    return route.fulfill({ status: 500, body: '' });
  });
}

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();

console.log('\n== picking Gemini ==');
await page.keyboard.press('Control+Backslash');
const win = page.locator('.assistant-win');
await win.waitFor();
const picker = page.getByLabel('Model');
const groups = await picker.locator('optgroup').evaluateAll((els) => els.map((el) => el.label));
check('the picker has a Google group', groups.some((label) => /^Google/.test(label)), groups.join(' | '));
const options = await picker.locator('optgroup[label^="Google"] option').allTextContents();
check('with Google’s three models', options.length === 3 && /Gemini 3\.1 Pro/.test(options[0]) && /3\.8 Flash/.test(options[1]) && /Flash-Lite/.test(options[2]), options.join(' | '));
await picker.selectOption('gemini-3.8-flash');
check('a Gemini model asks for a Google key', await page.getByText('Connect your Google account').isVisible());
await page.screenshot({ path: `${OUT}/gemini-key.png` });
await page.getByLabel('Google API key').fill('AIzaSy-gemini-test');
await page.getByRole('button', { name: 'Save', exact: true }).click();
check('the key is kept under its own name', (await page.evaluate(() => localStorage.getItem('reader.gemini-key'))) === 'AIzaSy-gemini-test');
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
await page.getByRole('textbox', { name: 'Ask AI' }).fill('What does the gate do?');
await page.keyboard.press('Enter');
await page.waitForSelector('.chat-claude li');
await page.waitForFunction(() => !document.querySelector('.chat-claude.is-streaming'));

const sent = requests[0];
check('one request went to Google, none elsewhere', requests.length === 1 && others === 0);
check('to the model’s streaming address', /\/v1beta\/models\/gemini-3\.8-flash:streamGenerateContent\?alt=sse$/.test(sent?.url || ''), sent?.url);
check('with the key in a header, not the address', sent?.headers['x-goog-api-key'] === 'AIzaSy-gemini-test' && !sent.url.includes('AIza'));
check('thinking at medium for a chat, with its summary asked for', sent?.body.generationConfig?.thinkingConfig?.thinkingLevel === 'medium' && sent.body.generationConfig.thinkingConfig.includeThoughts === true);
check('the paper is in the system instruction', /<paper_text[\s\S]*Paragraph 6\.4/.test(sent?.body.systemInstruction?.parts?.[0]?.text || ''));
const last = sent?.body.contents?.at(-1);
check('the question is the last user turn, with the screen', last?.role === 'user' && /<screen>[\s\S]*What does the gate do\?$/.test(last.parts.map((p) => p.text || '').join('')));
check('the answer streams in as Markdown', (await page.locator('.chat-claude strong').first().textContent()) === 'gate' && (await page.locator('.chat-claude li').count()) === 2);
check('under the model’s name', ((await page.locator('.chat-claude .chat-who').textContent()) || '').includes('Gemini 3.8 Flash'));
check('with its thinking folded away', await page.locator('.chat-thinking summary').isVisible());
await page.screenshot({ path: `${OUT}/gemini-answer.png` });
await page.keyboard.press('Control+Backslash');

console.log('\n== Explain ==');
await page.keyboard.press('e');
await page.waitForSelector('.model-pick');
const tiles = await page.locator('.model-pick [role=radio] b').allTextContents();
check('Explain offers the Gemini models', tiles.includes('Gemini 3.1 Pro') && tiles.includes('Gemini 3.5 Flash-Lite'), tiles.join(', '));
await page.locator('.model-pick [role=radio]', { hasText: 'Gemini 3.1 Pro' }).click();
check('with its key, Gemini can start', await page.getByRole('button', { name: 'Explain this paper' }).isVisible());
await page.screenshot({ path: `${OUT}/gemini-explain.png` });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s)` : '\nall good');
process.exit(problems.length ? 1 : 0);
