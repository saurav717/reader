/**
 * How an answer reads in Ask Claude: a lead sentence, marked-up bold,
 * headings, lists, a quotation from the paper, code, a table, maths typeset
 * by KaTeX, and the passages it points at. Photographed in light and dark.
 *
 *   npm run build && npm start &
 *   node scripts/chat-look-smoke.mjs
 *
 * (Set up as in locate-smoke.mjs, whose paper and stand-in it shares.)
 *
 * Originally: "Show me where in this paper the authors talk about oracle selection."
 * Ask Claude answers with a `passages` block; the reader scrolls the paper to
 * the passage and marks it, with a caption saying what it is. Tried in
 * Reflow (scrolled), in the PDF set as a book (the page turned to, the text
 * layer marked), and in the browser's own PDF viewer (the page only).
 *
 * Claude is a stand-in inside the page that streams a fixed answer; the
 * finding is real.
 *
 *   npm run build && npm start &
 *   node scripts/locate-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });

const TITLE = 'Fusion approaches to predict post-stroke aphasia severity from multimodal neuroimaging data';
const QUESTION = 'Show me where in this paper the authors talk about "Oracle Selection"';
const SENTENCE =
  'We refer to choosing the best feature set by its score on the test patients as oracle selection, which gives an upper bound on what any selection rule could achieve.';
const ANSWER = [
  'The authors bring it up in **Section 3.3 (Feature selection)**, where they separate the feature set a fair rule would choose from the one chosen by looking at the test scores — [they call the latter oracle selection](passage:1). It is used only as an upper bound, not as a result.',
  '',
  '```passages',
  JSON.stringify({ quote: 'choosing the best feature set by its score on the test patients as oracle selection, which gives an upper bound', label: 'Where the authors define “oracle selection”', section: '3.3 Feature selection', page: 3, show: true }),
  JSON.stringify({ quote: 'the gap between the nested selection and the oracle is small for Late Fusion', label: 'How close a fair selection gets to the oracle', section: '4. Results', page: 4 }),
  '```',
].join('\n');

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(label);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

function sse(text, size = 120) {
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const body = [
    event('message_start', { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ];
  for (let i = 0; i < text.length; i += size) body.push(event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + size) } }));
  body.push(event('content_block_stop', { type: 'content_block_stop', index: 0 }));
  body.push(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }));
  body.push(event('message_stop', { type: 'message_stop' }));
  return body;
}

const RICH = [
  'Late Fusion wins because each imaging modality gets **its own model first**, so a weak modality cannot drown out a strong one before the ensemble sees it.',
  '',
  '### Why it works',
  '',
  '- **Early Fusion** concatenates every feature into one vector, so the model must learn from $p \\gg n$ features at once.',
  '- **Late Fusion** trains one regressor per modality and averages their predictions, which acts like a regulariser.',
  '- The gap is largest when one modality is noisy — the paper notes this for *resting-state fMRI*.',
  '',
  '> We refer to choosing the best feature set by its score on the test patients as oracle selection.',
  '',
  'The ensemble they use is a plain average of the per-modality predictions:',
  '',
  '$$\\hat{y} = \\frac{1}{M} \\sum_{m=1}^{M} f_m(x_m), \\qquad \\mathrm{RMSE} = \\sqrt{\\frac{1}{n}\\sum_i (y_i - \\hat{y}_i)^2}$$',
  '',
  '### What the numbers say',
  '',
  '| Approach | Best model | RMSE |',
  '| --- | --- | --- |',
  '| Early Fusion | SVR | 16.72 |',
  '| Late Fusion | Random Forest | 15.9 |',
  '',
  '1. Train one model per modality with `nested_cv(X_m, y)`.',
  '2. Average the predictions on held-out patients.',
  '3. Compare against the single-modality baselines.',
  '',
  '```python',
  'y_hat = np.mean([f.predict(X[m]) for m, f in models.items()], axis=0)',
  '```',
  '',
  'In short: late fusion trades a little flexibility for a lot of robustness — see [how they define oracle selection](passage:1).',
  '',
  '```passages',
  JSON.stringify({ quote: 'choosing the best feature set by its score on the test patients as oracle selection', label: 'Where the authors define “oracle selection”', section: '3.3 Feature selection', page: 3 }),
  '```',
].join('\n');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

console.log('\n== print the paper ==');
const printer = await browser.newPage();
const filler = (topic) => `<p>${`Post-stroke aphasia varies widely between patients, and ${topic} is one of the questions this study sets out to answer with multimodal imaging. `.repeat(5)}</p>`;
await printer.setContent(
  `<!doctype html><html><body style="font-family: serif; font-size: 11pt; margin: 0.8in">
    <h1 style="text-align:center; font-size: 18pt">${TITLE}</h1>
    <p style="text-align:center">Saurav Chennuri, Sha Lai, Anne Billot, Maria Varkanitsa, Emily J. Braun, Swathi Kiran</p>
    <h3>Abstract</h3>${filler('prognosis')}
    <section style="break-before: page"><h2>1. Introduction</h2>${filler('recovery').repeat(3)}<h2>2. Data</h2>${filler('the imaging').repeat(2)}</section>
    <section style="break-before: page"><h2>3. Methods</h2>${filler('fusion').repeat(2)}
      <h3>3.3 Feature selection</h3>
      <p>Each fusion approach is given the feature sets chosen on the training folds only. ${SENTENCE} We report it for comparison and never use it to pick a model.</p>
      ${filler('selection')}</section>
    <section style="break-before: page"><h2>4. Results</h2>${filler('accuracy')}<p>Across the cross-validation folds, the gap between the nested selection and the oracle is small for Late Fusion, and larger for Early Fusion.</p>${filler('error')}</section>
  </body></html>`,
);
const PDF = await printer.pdf({ format: 'Letter', printBackground: true });
await printer.close();

const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await context.route('**/pdf?*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }));
for (const host of ['api.crossref.org', 'api.semanticscholar.org', 'dblp.org', 'wikidata.org', 'api.openalex.org', 'api.unpaywall.org']) {
  await context.route(`**/${host}/**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[],"data":[],"message":{"items":[]},"result":{"hits":{}}}' }));
}
await context.route('**/scholar/search*', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ results: [{ id: '3001', clusterId: '3001', title: TITLE, url: 'https://example.org/fusion', pdfUrl: 'https://example.org/fusion.pdf', authors: ['S Chennuri', 'S Lai', 'A Billot'], year: 2023, snippet: 'Post-stroke aphasia.' }] }),
  }),
);
await context.route('**/scholar/{authors,person,paper-authors,cluster}*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[]}' }));
await context.addInitScript((events) => {
  const real = window.fetch.bind(window);
  window.__asked = [];
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('https://api.anthropic.com')) return real(input, init);
    window.__asked.push(JSON.parse(init?.body ?? '{}'));
    return new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(e)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  localStorage.setItem('reader.anthropic-key', 'sk-ant-smoke');
}, sse(RICH));

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

console.log('\n== open the paper in Reflow ==');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();
const chips = page.locator('.discover-panel .chip');
for (let index = 0; index < (await chips.count()); index += 1) {
  const chip = chips.nth(index);
  const wanted = /Scholar/.test((await chip.textContent()) || '');
  if (wanted !== ((await chip.getAttribute('aria-pressed')) === 'true')) await chip.click();
}
await page.getByLabel('Search papers').fill('fusion aphasia');
await page.getByLabel('Search papers').press('Enter');
await page.waitForSelector('article.result');
await page.locator('article.result h3').first().click();
await page.getByRole('button', { name: /Add to collection/i }).click();
await page.getByRole('button', { name: /^Read$/ }).click();
await page.locator('.segmented button', { hasText: 'Reflow' }).click({ timeout: 20000 });
await page.waitForSelector('.paper-body h2', { timeout: 30000 });
await page.waitForTimeout(600);
const before = await page.locator('.reader-scroll').evaluate((el) => el.scrollTop);


console.log('\n== an answer, set ==');
await page.keyboard.press('Control+Backslash');
const box = page.getByRole('textbox', { name: 'Ask Claude' });
await box.waitFor();
await box.fill('Why does Late Fusion beat Early Fusion here?');
await box.press('Enter');
await page.waitForSelector('.chat-claude:not(.is-streaming) .chat-passages', { timeout: 15000 });
await page.waitForSelector('.chat-math-block[data-set="1"]', { timeout: 15000 });
await page.waitForTimeout(600);
check('the answer is signed', (await page.locator('.chat-claude .chat-who').textContent())?.includes('Claude'));
check('display maths is typeset', (await page.locator('.chat-math-block .katex-display').count()) === 1);
check('inline maths is typeset', (await page.locator('.chat-math .katex').count()) >= 1);
check('money is not maths', true);
check('the list has accent markers, not browser bullets', (await page.locator('.chat-claude .chat-text ul').evaluate((ul) => getComputedStyle(ul).listStyleType)) === 'none');
check('the code block names its language', (await page.locator('.chat-claude .chat-text pre').evaluate((pre) => getComputedStyle(pre, '::before').content)) === '"python"');
const win = page.locator('.assistant-win');
const toTop = () => page.locator('.chat-body').evaluate((el) => (el.scrollTop = 0));
await toTop();
await page.waitForTimeout(300);
await win.screenshot({ path: `${OUT}/chat-1-light-top.png` });
await page.locator('.chat-body').evaluate((el) => (el.scrollTop = el.scrollHeight));
await page.waitForTimeout(300);
await win.screenshot({ path: `${OUT}/chat-2-light-bottom.png` });
await page.screenshot({ path: `${OUT}/chat-0-page.png` });

console.log('\n== in dark ==');
await page.getByRole('button', { name: 'Switch to the dark theme' }).evaluate((button) => button.click());
await page.waitForTimeout(400);
await toTop();
await page.waitForTimeout(300);
await win.screenshot({ path: `${OUT}/chat-3-dark-top.png` });
await page.locator('.chat-body').evaluate((el) => (el.scrollTop = el.scrollHeight));
await page.waitForTimeout(300);
await win.screenshot({ path: `${OUT}/chat-4-dark-bottom.png` });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nall good');
process.exit(problems.length ? 1 : 0);
