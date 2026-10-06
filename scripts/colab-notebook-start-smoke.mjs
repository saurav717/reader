/**
 * The notebook before anything is written: the notebook opens blank, asks
 * which model writes it, and writes it with the one picked. A paper is
 * opened without being explained, the tab shows the start — one cell that
 * names no model, the model cards, the button — DeepSeek Flash is picked
 * (the header follows), a DeepSeek key is given, and the notebook is
 * written by a stand-in DeepSeek answering as the API does. Then a page is
 * explained by DeepSeek and the cells added from it are signed by DeepSeek,
 * not Claude. Each state is photographed, dark and light.
 *
 *   npm run build && npm start &
 *   node scripts/colab-notebook-start-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });
const EXPLANATION = await readFile(new URL('./fixtures/explain-attention.md', import.meta.url), 'utf8');

const TITLE = 'Compact Language Models via Pruning and Knowledge Distillation';
const W = 1440;
const H = 900;

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

/** What the stand-in DeepSeek writes when asked for the whole notebook: three steps, text before each. */
const NOTEBOOK_REPLY = `The method as a small implementation, then a pruning step, then the check.

\`\`\`markdown notebook=new
## 1. A tiny model to prune

A two-layer MLP standing in for the LLM: the paper's importance scores are computed on its hidden units.
\`\`\`
\`\`\`python after=end
import torch, torch.nn as nn
torch.manual_seed(0)
device = "cuda" if torch.cuda.is_available() else "cpu"
model = nn.Sequential(nn.Linear(64, 256), nn.GELU(), nn.Linear(256, 64)).to(device)
x = torch.randn(512, 64, device=device)
print("device:", device, "· params:", sum(p.numel() for p in model.parameters()))
\`\`\`
\`\`\`markdown after=end
## 2. Activation-based importance, and the prune

Mean absolute activation per hidden unit over a calibration batch (the paper's width-importance), then the least important half removed.
\`\`\`
\`\`\`python after=end
with torch.no_grad():
    h = model[1](model[0](x))
importance = h.abs().mean(dim=0)
keep = importance.argsort(descending=True)[: h.shape[1] // 2].sort().values
pruned = nn.Sequential(nn.Linear(64, len(keep)), nn.GELU(), nn.Linear(len(keep), 64)).to(device)
pruned[0].weight.data, pruned[0].bias.data = model[0].weight[keep].clone(), model[0].bias[keep].clone()
pruned[2].weight.data = model[2].weight[:, keep].clone(); pruned[2].bias.data = model[2].bias.clone()
print("kept", len(keep), "of", h.shape[1], "hidden units")
\`\`\`
\`\`\`markdown after=end
## 3. Does the pruned model agree with the teacher?

A distillation-style check: the mean squared gap between the two outputs on fresh inputs, before any retraining.
\`\`\`
\`\`\`python after=end
with torch.no_grad():
    y, y_pruned = model(x), pruned(x)
print(f"output MSE after pruning, before retraining: {torch.mean((y - y_pruned) ** 2).item():.4f}")
\`\`\``;

/** Anthropic's stream, for the explanation written by Claude. */
function sse(text, size = 600) {
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const body = [];
  body.push(event('message_start', { type: 'message_start', message: { id: 'msg_smoke', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9000, output_tokens: 1 } } }));
  body.push(event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  for (let i = 0; i < text.length; i += size) body.push(event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + size) } }));
  body.push(event('content_block_stop', { type: 'content_block_stop', index: 0 }));
  body.push(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9000 } }));
  body.push(event('message_stop', { type: 'message_stop' }));
  return body;
}
/** DeepSeek's stream: OpenAI's chat-completions chunks, a little thinking first, then the text, then [DONE]. */
function deepseekSse(text, size = 400) {
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'ds-smoke', object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const body = [chunk({ role: 'assistant', reasoning_content: 'The reader wants the whole notebook: the method, a prune, a check. Small enough for a T4.' })];
  for (let i = 0; i < text.length; i += size) body.push(chunk({ content: text.slice(i, i + size) }));
  body.push(chunk({}, 'stop'));
  body.push('data: [DONE]\n\n');
  return body;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

console.log('\n== print a paper ==');
const printer = await browser.newPage();
const para =
  'Large language models targeting different deployment scales and sizes are currently produced by training each variant from scratch; this is extremely compute-intensive. We investigate whether pruning an existing LLM and then re-training it with a fraction of the original training data can be a suitable alternative. ';
const section = (n, name) => `<section style="break-after: page"><h2>${n}. ${name}</h2>${`<p>${para.repeat(3)}</p>`.repeat(5)}</section>`;
await printer.setContent(
  `<!doctype html><html><body style="font-family: serif; font-size: 11pt; margin: 0.8in">
    <h1 style="text-align:center">${TITLE}</h1>
    <p style="text-align:center">Saurav Muralidharan, Sharath Turuvekere Sreenivas, Raviraj Joshi, Marcin Chochowski, Mostofa Patwary, Mohammad Shoeybi, Bryan Catanzaro, Jan Kautz, Pavlo Molchanov</p>
    <h3>Abstract</h3><p>${para.repeat(2)}</p>
    ${section(1, 'Introduction')}${section(2, 'Pruning Methodology')}${section(3, 'Retraining')}${section(4, 'Experiments and Analysis')}
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
      results: [{ id: '3001', clusterId: '3001', title: TITLE, url: 'https://arxiv.org/abs/2407.14679', pdfUrl: 'https://example.org/minitron.pdf', authors: ['S Muralidharan', 'ST Sreenivas', 'R Joshi', 'M Chochowski'], year: 2024, snippet: 'We investigate whether pruning an existing LLM and then re-training it can be a suitable alternative.' }],
    }),
  }),
);
await context.route('**/scholar/{authors,person,paper-authors,cluster}*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[]}' }));
await context.addInitScript(
  ({ explanation, deepseekNotebook, deepseekExplanation }) => {
    const real = window.fetch.bind(window);
    // Every request to a model, kept for the checks: Anthropic's answered with the explanation, DeepSeek's with the notebook or the explanation, by what is asked.
    window.__requests = [];
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const anthropic = url.startsWith('https://api.anthropic.com');
      const deepseek = url.startsWith('https://api.deepseek.com');
      if (!anthropic && !deepseek) return real(input, init);
      const body = typeof init?.body === 'string' ? init.body : '';
      window.__requests.push({ to: anthropic ? 'anthropic' : 'deepseek', body });
      const forNotebook = /writing cells for a Jupyter notebook/.test(body);
      const events = anthropic ? explanation : forNotebook ? deepseekNotebook : deepseekExplanation;
      const stream = new ReadableStream({
        async start(controller) {
          for (const event of events) {
            controller.enqueue(new TextEncoder().encode(event));
            await new Promise((resolve) => setTimeout(resolve, 15));
          }
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_smoke' } });
    };
  },
  { explanation: sse(EXPLANATION), deepseekNotebook: deepseekSse(NOTEBOOK_REPLY), deepseekExplanation: deepseekSse(EXPLANATION, 800) },
);

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
process.on('uncaughtException', async (error) => {
  console.error(error);
  await page.screenshot({ path: `${OUT}/colab-notebook-start-failed.png` }).catch(() => undefined);
  process.exit(2);
});

console.log('\n== open a paper ==');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  // A Claude key only: the DeepSeek key is given on the tab itself.
  localStorage.setItem('reader.anthropic-key', 'sk-ant-smoke');
  localStorage.setItem('reader.explain.layout', 'margin');
  localStorage.setItem('reader.colab.machine', JSON.stringify({ accelerator: 'T4', highMem: false }));
  const saved = JSON.parse(localStorage.getItem('reader.settings') || '{}');
  localStorage.setItem('reader.settings', JSON.stringify({ ...saved, googleClientId: 'smoke-client-id.apps.googleusercontent.com', theme: 'dark', glass: false }));
});
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();
const chips = page.locator('.find-options .chip');
for (let index = 0; index < (await chips.count()); index += 1) {
  const chip = chips.nth(index);
  const wanted = /Scholar/.test((await chip.textContent()) || '');
  if (wanted !== ((await chip.getAttribute('aria-pressed')) === 'true')) await chip.click();
}
await page.getByLabel('Search for papers').fill('compact language models pruning distillation');
await page.getByLabel('Search for papers').press('Enter');
await page.locator('.find-row .find-title').first().waitFor({ timeout: 15000 });
await page.locator('.find-row .find-title').first().click();
await page.locator('.find-detail-actions').waitFor({ timeout: 5000 });
await page.locator('.find-detail-actions').getByRole('button', { name: /Save to/ }).click();
await page.waitForTimeout(400);
await page.locator('.find-detail-actions').getByRole('button', { name: /^(Read|Open)$/ }).click();
await page.locator('.segmented button', { hasText: 'Reflow' }).click({ timeout: 20000 });
await page.waitForSelector('.paper-body h2', { timeout: 30000 });
await page.waitForTimeout(500);

async function withSettings(patch) {
  await page.evaluate((next) => {
    const saved = JSON.parse(localStorage.getItem('reader.settings') || '{}');
    localStorage.setItem('reader.settings', JSON.stringify({ ...saved, ...next }));
  }, patch);
  await page.reload({ waitUntil: 'networkidle' });
  const notNow = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await page.waitForSelector('.explain', { timeout: 15000 });
  await page.waitForTimeout(600);
}

console.log('\n== E, then Colab in the bar, with nothing explained: the notebook asks who writes it ==');
await page.mouse.move(W / 2, H / 2);
await page.keyboard.press('e');
await page.waitForSelector('.explain .explain-empty');
await page.locator('.explain-bar .btn.colab-open').click();
await page.waitForSelector('.nb-start', { timeout: 15000 });
const start = page.locator('.nb-start');
const brand = page.locator('.explain-brand');
check('the one cell is the reader’s, and names no model', (await page.locator('.nb-cell').count()) === 1 && /A notebook of your own in Reader/.test(await page.locator('.nb-cell .nb-markdown').textContent()) && !/Claude/.test(await page.locator('.nb-cell').textContent()));
check('the start asks which model writes the notebook, with every model as a card', /Which model writes this notebook\?/.test(await start.locator('h2').textContent()) && (await start.locator('.model-pick [role="radio"]').count()) === 8);
check('the pages’ model is picked to begin with, and the header names it', (await start.locator('.model-pick [aria-checked="true"] b').textContent()) === 'Claude Opus 5' && /Notebook with Claude Opus 5/.test(await brand.textContent()));
check('with a key, the button writes the notebook with that model', /Write the notebook with Claude Opus 5/.test(await start.locator('.btn.cta').textContent()));
await page.screenshot({ path: `${OUT}/colab-notebook-start-1-dark.png` });

console.log('\n== DeepSeek Flash is picked: the header follows, and the key is asked for here ==');
await start.locator('.model-pick [role="radio"]', { hasText: 'DeepSeek Flash' }).first().click();
await page.waitForTimeout(300);
check('the pick is marked, and the header says Notebook with DeepSeek Flash', (await start.locator('.model-pick [aria-checked="true"] b').textContent()) === 'DeepSeek Flash' && /Notebook with DeepSeek Flash/.test(await brand.textContent()), await brand.textContent());
check('the ask bar’s pill and placeholder follow', /Flash/.test(await page.locator('.nb-ask .model-chip').textContent()) && /Ask DeepSeek Flash/.test(await page.locator('.nb-ask input').getAttribute('placeholder')), await page.locator('.nb-ask input').getAttribute('placeholder'));
check('no DeepSeek key yet: the start asks for one, where the button would be', (await start.locator('.btn.cta', { hasText: 'Write the notebook' }).count()) === 0 && (await start.locator('input[type="password"]').count()) === 1 && /Use this DeepSeek key/.test(await start.locator('button[type="submit"]').textContent()));
await page.screenshot({ path: `${OUT}/colab-notebook-start-2-key-dark.png` });
await start.locator('input[type="password"]').fill('sk-deepseek-smoke');
await start.locator('button[type="submit"]').click();
await page.waitForTimeout(300);
check('with the key, the button is back for DeepSeek', /Write the notebook with DeepSeek Flash/.test(await start.locator('.btn.cta').textContent()));
await page.screenshot({ path: `${OUT}/colab-notebook-start-3-deepseek-dark.png` });

console.log('\n== Write the notebook: DeepSeek writes it ==');
await start.locator('.btn.cta', { hasText: 'Write the notebook with DeepSeek Flash' }).click();
await page.waitForSelector('.nb-ask .ask-status.is-live', { timeout: 10000 });
check('the bar reports on it while it writes, naming the request', /Rewrite the notebook/.test(await page.locator('.nb-ask .ask-status').textContent()));
check('and the start is put away while it does', (await page.locator('.nb-start').count()) === 0);
await page.screenshot({ path: `${OUT}/colab-notebook-start-4-writing-dark.png` });
await page.waitForSelector('.nb-ask .ask-status.is-done', { timeout: 30000 });
await page.waitForTimeout(500);
const requests = await page.evaluate(() => window.__requests);
const nbRequest = requests.find((r) => /writing cells for a Jupyter notebook/.test(r.body));
check('the request went to DeepSeek, as deepseek-flash, with thinking on', nbRequest?.to === 'deepseek' && /"model":"deepseek-flash"/.test(nbRequest.body) && !requests.some((r) => r.to === 'anthropic'), `${requests.length} requests: ${requests.map((r) => r.to).join(', ')}`);
check('it is the whole notebook that was asked for, from the paper', /Write this notebook again from scratch, for this paper/.test(nbRequest?.body ?? ''));
const written = page.locator('.nb-cell');
check('the notebook is DeepSeek’s cells now: three text, three code, every one marked as new', (await written.count()) === 6 && (await page.locator('.nb-cell.is-code').count()) === 3 && (await page.locator('.nb-cell .nb-fresh', { hasText: 'New · from the ask bar' }).count()) === 6, `${await written.count()} cells`);
check('nothing ran', (await page.locator('.nb-cell .cell-output').count()) === 0 && (await page.locator('.colab-chip').textContent()).includes('no runtime'));
check('the start is gone, the header still says DeepSeek, and Run them is offered', (await page.locator('.nb-start').count()) === 0 && /Notebook with DeepSeek Flash/.test(await brand.textContent()) && (await page.locator('.nb-ask .ask-status button', { hasText: 'Run them' }).count()) === 1);
await page.locator('.nb-cells').evaluate((el) => (el.scrollTop = 0));
await page.screenshot({ path: `${OUT}/colab-notebook-start-5-written-dark.png` });

console.log('\n== Undo brings the start back ==');
await page.locator('.nb-ask .ask-status button', { hasText: 'Undo' }).click();
await page.waitForSelector('.nb-start', { timeout: 5000 });
check('the one cell and the start are back, DeepSeek still picked', (await page.locator('.nb-cell').count()) === 1 && (await start.locator('.model-pick [aria-checked="true"] b').textContent()) === 'DeepSeek Flash');

console.log('\n== in light — and a notebook an earlier build kept, saying Claude, is seeded again ==');
// The notebook is written a moment after its last change; give Undo's the moment before the reload.
await page.waitForTimeout(800);
// What an earlier build kept for a paper whose notebook was opened before anything was written: the one header cell, signed Claude whatever was picked.
const planted = await page.evaluate(
  () =>
    new Promise((resolve, reject) => {
      const open = indexedDB.open('reader');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const store = db.transaction('kv', 'readwrite').objectStore('kv');
        const cursor = store.openCursor(IDBKeyRange.bound('notebook:', 'notebook:\uffff'));
        cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
          const at = cursor.result;
          if (!at) return resolve(null);
          const nb = at.value;
          const stale = { ...nb, cells: [{ id: 'old-head', type: 'markdown', source: `# ${nb.title}\n\n*Explained by Claude in Reader. The outputs under each cell were written by Claude, not run — run them to check.*`, outputs: [], count: null }] };
          const put = at.update(stale);
          put.onsuccess = () => resolve(String(at.key));
          put.onerror = () => reject(put.error);
        };
      };
    }),
);
check('the old header is planted in the browser’s store', typeof planted === 'string' && planted.startsWith('notebook:'), String(planted));
await withSettings({ theme: 'light' });
// Explain comes back on the Explanation page; the notebook is a click on Colab in the bar away, as ever.
await page.locator('.explain-bar .btn.colab-open').click();
await page.waitForSelector('.nb-start', { timeout: 15000 });
check('after a reload the pick is kept with the notebook, and the header still names it', (await page.locator('.nb-start .model-pick [aria-checked="true"] b').textContent()) === 'DeepSeek Flash' && /Notebook with DeepSeek Flash/.test(await page.locator('.explain-brand').textContent()));
check('the kept notebook that was only the old build’s header is seeded again: one cell, naming no model', (await page.locator('.nb-cell').count()) === 1 && /A notebook of your own in Reader/.test(await page.locator('.nb-cell .nb-markdown').textContent()) && !/Claude/.test(await page.locator('.nb-cell').textContent()), (await page.locator('.nb-cell .nb-markdown').textContent()).slice(0, 120));
await page.screenshot({ path: `${OUT}/colab-notebook-start-6-light.png` });

console.log('\n== a page explained by DeepSeek seeds a notebook signed by DeepSeek ==');
await withSettings({ theme: 'dark' });
await page.getByRole('tab', { name: 'Explanation' }).click();
await page.waitForSelector('.explain .explain-empty');
await page.locator('.explain-empty .model-pick [role="radio"]', { hasText: 'DeepSeek Flash' }).first().click();
await page.getByRole('button', { name: 'Explain this paper' }).click();
await page.waitForSelector('.explain-section h2', { timeout: 20000 });
await page.waitForFunction(() => !document.querySelector('.explain-writing'), null, { timeout: 60000 });
check('the explanation was written by DeepSeek', /Explained by DeepSeek Flash/.test(await page.locator('.explain-brand').textContent()));
await page.locator('.explain-bar .btn.colab-open').click();
await page.waitForSelector('.nb-start', { timeout: 15000 });
check('the blank notebook now offers the explanation’s cells too', (await page.locator('.nb-start-other button', { hasText: "add the explanation's cells" }).count()) === 1 && /the paper and your explanation/.test(await page.locator('.nb-start-head p').textContent()));
await page.locator('.nb-start-other button', { hasText: "add the explanation's cells" }).click();
await page.waitForFunction(() => document.querySelectorAll('.nb-cell.is-code').length === 4, null, { timeout: 5000 });
const header = page.locator('.nb-cell.is-markdown').first();
check('the cells seeded from the page are signed by the model that wrote it, not Claude', /Explained by DeepSeek Flash in Reader/.test(await header.textContent()) && !/Claude/.test(await page.locator('.nb-cells').textContent()), (await header.textContent()).slice(0, 160));
check('into a blank notebook they take the place of its one cell, so there is one header, not two', (await page.locator('.nb-cell.is-markdown', { hasText: 'A notebook of your own in Reader' }).count()) === 0 && (await page.locator('.nb-cell').count()) === 17, `${await page.locator('.nb-cell').count()} cells`);
check('and the start is gone, now that there is code', (await page.locator('.nb-start').count()) === 0);
await page.locator('.nb-cells').evaluate((el) => (el.scrollTop = 0));
await page.screenshot({ path: `${OUT}/colab-notebook-start-7-seeded-deepseek-dark.png` });

console.log('\n== Export ▾ takes the notebook, the explanation and the scaffold out; Colab in the bar comes back to the page ==');
await page.locator('.nb-toolbar').getByRole('button', { name: /^Export/ }).click();
await page.waitForSelector('.nb-menu');
check('the notebook and the explanation are live, the scaffold off until the plan is written', !(await page.getByRole('menuitem', { name: 'Download as .ipynb' }).isDisabled()) && !(await page.getByRole('menuitem', { name: 'Download the explanation (.zip)' }).isDisabled()) && (await page.getByRole('menuitem', { name: 'Download the scaffold (.zip)' }).isDisabled()));
check('the commits wait for a repository', (await page.getByRole('menuitem', { name: 'Commit the explanation, and open in Colab' }).getAttribute('title')) === 'Settings → Git repository first');
await page.screenshot({ path: `${OUT}/colab-notebook-start-8-export-menu-dark.png` });
const [zipped] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download the explanation (.zip)' }).click()]);
const zipBytes = await readFile(await zipped.path());
check('the explanation downloads as a zip', zipBytes[0] === 0x50 && zipBytes[1] === 0x4b);
check('Colab in the bar is lit while the notebook is on screen, and the bar has two tabs', (await page.locator('.explain-bar .btn.colab-open').getAttribute('aria-pressed')) === 'true' && (await page.locator('.explain-pages [role="tab"]').count()) === 2);
await page.locator('.explain-bar .btn.colab-open').click();
await page.waitForSelector('.explain-scroll', { timeout: 10000 });
check('a second click comes back to the Explanation page, and Colab is unlit', (await page.locator('.explain-pages button[aria-pressed="true"]').textContent()) === 'Explanation' && (await page.locator('.explain-bar .btn.colab-open').getAttribute('aria-pressed')) === 'false' && (await page.locator('.nb-page').count()) === 0);
await page.screenshot({ path: `${OUT}/colab-notebook-start-9-back-to-the-page-dark.png` });

check('no page errors', errors.length === 0, errors.join(' | '));
console.log(`\n${problems.length ? `${problems.length} problem(s):\n  ${problems.join('\n  ')}` : 'all good'}\n`);
await browser.close();
process.exit(problems.length ? 1 : 0);
