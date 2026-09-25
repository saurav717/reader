/**
 * The Implementation tab. A paper is opened, E brings up Explain, the tab is
 * switched to Implementation, and "Plan the implementation" is answered by a
 * stand-in for api.anthropic.com that streams
 * scripts/fixtures/implement-minitron.md back — so the whole path runs: the
 * request with the reader's hardware in it, the stream, the tree, the starter
 * files, the compute budget worked out for the machine picked, the picker
 * changing it, the Colab and Local menus, the scaffold written through the
 * proxy into READER_WORKSPACE and a command run there, and a request from the
 * bar. Each state is photographed, in light and dark.
 *
 *   npm run build && READER_WORKSPACE=/tmp/reader-workspace npm start &
 *   node scripts/implement-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });
const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const PLAN = await fixture('implement-minitron.md');
const REPLIES = [await fixture('implement-revise-dataset.md')];

const TITLE = 'Compact Language Models via Pruning and Knowledge Distillation';
const W = 1440;
const H = 900;

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

/** The Messages API's stream, as the SDK expects to read it: one event a string. */
function sse(text, size = 400) {
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
  body.push(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9000 } }));
  body.push(event('message_stop', { type: 'message_stop' }));
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
      results: [
        {
          id: '3001',
          clusterId: '3001',
          title: TITLE,
          url: 'https://arxiv.org/abs/2407.14679',
          pdfUrl: 'https://example.org/minitron.pdf',
          authors: ['S Muralidharan', 'ST Sreenivas', 'R Joshi', 'M Chochowski'],
          year: 2024,
          snippet: 'We investigate whether pruning an existing LLM and then re-training it with a fraction of the original training data can be a suitable alternative.',
        },
      ],
    }),
  }),
);
await context.route('**/scholar/{authors,person,paper-authors,cluster}*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[]}' }));
// GitHub, for the Colab menu's commit: a repository with one branch, answered from memory.
const commits = [];
await context.route('https://api.github.com/**', (route) => {
  const url = route.request().url();
  const method = route.request().method();
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.includes('/git/ref/heads/')) return json({ object: { sha: 'headsha' } });
  if (url.includes('/git/commits/headsha')) return json({ sha: 'headsha', tree: { sha: 'treesha' } });
  if (url.endsWith('/git/blobs') && method === 'POST') return json({ sha: `blob${commits.length}` }, 201);
  if (url.endsWith('/git/trees') && method === 'POST') return json({ sha: 'newtree' }, 201);
  if (url.endsWith('/git/commits') && method === 'POST') {
    commits.push(JSON.parse(route.request().postData()));
    return json({ sha: 'newcommit' }, 201);
  }
  if (url.includes('/git/refs/heads/') && method === 'PATCH') return json({ object: { sha: 'newcommit' } });
  return json({ message: `unexpected ${method} ${url}` }, 500);
});
await context.addInitScript(
  ({ first, replies }) => {
    const real = window.fetch.bind(window);
    window.__asked = [];
    window.__opened = [];
    window.open = (url) => {
      window.__opened.push(String(url));
      return null;
    };
    let next = 0;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.startsWith('https://api.anthropic.com')) return real(input, init);
      const body = JSON.parse(init?.body ?? '{}');
      window.__asked.push(body);
      const events = body.messages.length > 1 ? replies[next++ % replies.length] : first;
      const stream = new ReadableStream({
        async start(controller) {
          for (const event of events) controller.enqueue(new TextEncoder().encode(event));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_smoke' } });
    };
  },
  { first: sse(PLAN), replies: REPLIES.map((reply) => sse(reply, 120)) },
);
const lastAsked = () => page.evaluate(() => window.__asked.at(-1) ?? null);

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

console.log('\n== open a paper ==');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  localStorage.setItem('reader.anthropic-key', 'sk-ant-smoke');
  localStorage.setItem('reader.explain.layout', 'margin');
  localStorage.setItem('reader.explain.page', 'explain');
  localStorage.removeItem('reader.implement.hardware');
});
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Not now — keep everything in this browser/i }).click();
const chips = page.locator('.discover-panel .chip');
for (let index = 0; index < (await chips.count()); index += 1) {
  const chip = chips.nth(index);
  const wanted = /Scholar/.test((await chip.textContent()) || '');
  if (wanted !== ((await chip.getAttribute('aria-pressed')) === 'true')) await chip.click();
}
await page.getByLabel('Search papers').fill('compact language models pruning distillation');
await page.getByLabel('Search papers').press('Enter');
await page.waitForSelector('article.result');
await page.locator('article.result h3').first().click();
await page.getByRole('button', { name: /Add to collection/i }).click();
await page.getByRole('button', { name: /^Read$/ }).click();
await page.locator('.segmented button', { hasText: 'Reflow' }).click({ timeout: 20000 });
await page.waitForSelector('.paper-body h2', { timeout: 30000 });
await page.waitForTimeout(500);

console.log('\n== E, then the Implementation tab ==');
await page.mouse.move(W / 2, H / 2);
await page.keyboard.press('e');
await page.waitForSelector('.explain .explain-empty');
check('the bar has the two pages', (await page.locator('.explain-pages button').allTextContents()).join('|') === 'Explanation|Implementation');
await page.getByRole('tab', { name: 'Implementation' }).click();
await page.waitForSelector('.impl-empty');
await page.waitForTimeout(400);
check('before it is planned, it offers to plan it', await page.getByRole('button', { name: 'Plan the implementation' }).isVisible());
check('the picker is on the empty state', (await page.locator('.impl-empty .hardware-panel').count()) === 1);
check('the tab is remembered', (await page.evaluate(() => localStorage.getItem('reader.explain.page'))) === 'implement');
await page.screenshot({ path: `${OUT}/implement-1-start.png` });

console.log('\n== the machine, from the proxy ==');
await page.waitForSelector('.hw-detect', { timeout: 10000 }).catch(() => null);
const detect = page.locator('.hw-detect');
check('the proxy says what this machine is', (await detect.count()) === 1, 'is READER_WORKSPACE set on the server?');
if (await detect.count()) {
  await detect.getByRole('button', { name: 'Use this machine' }).click();
  await page.waitForTimeout(200);
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('reader.implement.hardware') || '{}'));
  check('the machine goes into the picker', kept.hoursPerDay === 24 && kept.ramGb > 0, JSON.stringify(kept));
}
// Back to a Colab T4, the default and the case the fixture is written for.
await page.locator('.impl-empty select[aria-label="Accelerator"]').selectOption('colab-t4');
await page.locator('.impl-empty select[aria-label="System memory"]').selectOption('16');
await page.locator('.impl-empty select[aria-label="Free disk"]').selectOption('100');

console.log('\n== Claude plans it ==');
await page.getByRole('button', { name: 'Plan the implementation' }).click();
await page.waitForSelector('.explain-section h2', { timeout: 20000 });
await page.waitForFunction(() => !document.querySelector('.explain-writing'), null, { timeout: 30000 });
const asked = await lastAsked();
check('the paper went along, behind a cache breakpoint', Boolean(asked?.system?.[1]?.cache_control) && /paper_text/.test(asked.system[1].text));
check('the reader’s hardware went along, after it', /readers_hardware/.test(asked?.system?.[2]?.text ?? '') && /T4/.test(asked.system[2].text));
check('the instructions are the plan’s', /IMPLEMENTATION page/.test(asked?.system?.[0]?.text ?? ''));
const titles = await page.locator('.explain-section h2').allTextContents();
check('the ten sections are drawn', titles.length === 10 && titles[0] === 'At a glance' && titles.at(-1) === 'Milestones', titles.join(' | '));
check('the tree is drawn as rows', (await page.locator('.impl-tree li.is-dir').count()) >= 5 && (await page.locator('.impl-tree li.is-file').count()) >= 10);
check('the starter files are cards', (await page.locator('.impl-file').count()) === 6);
check('the shell cells have a prompt', (await page.locator('.explain-cell.is-shell').count()) === 2);
check('the budget is worked out', (await page.locator('.impl-budget .budget-table tbody tr').count()) === 4);
check('the outline says what the machine is', /T4/.test(await page.locator('.outline-hardware').textContent()));
const wall = () => page.locator('.impl-budget .budget-stat').first().locator('b').textContent();
const onT4 = await wall();
check('on a T4 it is days', /day|week/.test(onT4), onT4);
check('and it does not fit without tricks', (await page.locator('.impl-budget .budget-summary .fit-chip').textContent()) === 'Needs offloading');
await page.screenshot({ path: `${OUT}/implement-2-margin.png` });

const scrollTo = async (selector, offset = 12) => {
  await page.locator('.explain-scroll').evaluate(
    (el, { selector, offset }) => {
      const target = el.querySelector(selector);
      if (target) el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - offset;
    },
    { selector, offset },
  );
  await page.waitForTimeout(300);
};
await scrollTo('#explain-datasets');
await page.screenshot({ path: `${OUT}/implement-3-datasets.png` });
await scrollTo('#explain-repository-layout');
await page.screenshot({ path: `${OUT}/implement-4-tree.png` });
await scrollTo('#explain-starter-files');
await page.screenshot({ path: `${OUT}/implement-5-files.png` });
await scrollTo('#explain-compute-budget');
await page.screenshot({ path: `${OUT}/implement-6-budget-t4.png` });

console.log('\n== the machine changes, the budget follows ==');
await page.locator('.impl-budget').getByRole('button', { name: 'Change machine' }).click();
await page.locator('.impl-budget select[aria-label="Accelerator"]').selectOption('h100');
await page.locator('.impl-budget select[aria-label="How many cards"]').selectOption('2');
await page.waitForTimeout(200);
const onH100 = await wall();
check('on two H100s it is hours', /\bh$/.test(onH100), onH100);
check('and it fits', (await page.locator('.impl-budget .budget-summary .fit-chip').textContent()) === 'Fits');
check('with a cost', /\$/.test(await page.locator('.impl-budget .budget-stat').nth(1).locator('b').textContent()));
check('the outline follows', /H100/.test(await page.locator('.outline-hardware').textContent()));
await page.screenshot({ path: `${OUT}/implement-7-budget-h100.png` });
await page.locator('.impl-budget').getByRole('button', { name: 'Done' }).click();

console.log('\n== Colab ==');
await page.evaluate(() => {
  const saved = JSON.parse(localStorage.getItem('reader.settings') || '{}');
  localStorage.setItem('reader.settings', JSON.stringify({ ...saved, githubRepo: 'saurav717/papers', githubBranch: 'main', githubToken: 'ghp_smoke' }));
});
await page.reload({ waitUntil: 'networkidle' });
{
  const notNow = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
}
await page.waitForSelector('.explain-section h2', { timeout: 20000 });
check('the plan comes back without asking Claude again', (await page.evaluate(() => window.__asked.length)) === 0);
check('and on the Implementation tab', (await page.locator('.explain-pages button[aria-pressed="true"]').textContent()) === 'Implementation');
await scrollTo('#explain-starter-files', 40);
await page.getByRole('button', { name: 'Colab', exact: true }).click();
await page.waitForTimeout(200);
check('the menu offers the commit, the notebook and the zip', (await page.locator('.colab-menu .colab-action').count()) === 3);
await page.screenshot({ path: `${OUT}/implement-8-colab-menu.png` });
await page.getByRole('menuitem', { name: /Commit to GitHub and open in Colab/ }).click();
await page.waitForSelector('.colab-status.is-ok', { timeout: 10000 });
check('one commit carries the scaffold', commits.length === 1 && /Implementation scaffold/.test(commits[0].message), JSON.stringify(commits.map((c) => c.message)));
const opened = await page.evaluate(() => window.__opened);
check('and Colab opens on the notebook in the repository', /^https:\/\/colab\.research\.google\.com\/github\/saurav717\/papers\/blob\/main\/implementations\/.+\.ipynb$/.test(opened[0] ?? ''), opened[0]);
await page.screenshot({ path: `${OUT}/implement-9-colab-committed.png` });
const [notebook] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Download the notebook/ }).click()]);
const ipynb = JSON.parse(await readFile(await notebook.path(), 'utf8'));
check('the notebook writes the files first', ipynb.cells.filter((c) => c.cell_type === 'code' && c.source[0].startsWith('%%writefile')).length === 6);
const [zipped] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Download the scaffold/ }).click()]);
const zipBytes = await readFile(await zipped.path());
check('the zip is a zip', zipBytes[0] === 0x50 && zipBytes[1] === 0x4b);
await page.keyboard.press('Escape');

console.log('\n== Local: the scaffold on this machine, and a command run there ==');
await page.getByRole('button', { name: 'Local' }).click();
await page.waitForSelector('.local-menu');
await page.waitForFunction(() => !/Asking the proxy/.test(document.querySelector('.local-menu')?.textContent ?? ''), null, { timeout: 10000 });
const localText = await page.locator('.local-menu').textContent();
check('the menu says what the machine is', /GB RAM/.test(localText), localText.slice(0, 120));
await page.screenshot({ path: `${OUT}/implement-10-local-menu.png` });
const writeButton = page.getByRole('menuitem', { name: /Write the scaffold here/ });
if (await writeButton.count()) {
  await writeButton.click();
  await page.waitForSelector('.local-menu .colab-status.is-ok', { timeout: 10000 });
  check('the files are written', /8 written/.test(await page.locator('.local-menu .colab-status.is-ok').textContent()));
  check('the menu offers the commands to run', (await page.locator('.local-command').count()) >= 3);
  await page.screenshot({ path: `${OUT}/implement-11-local-written.png` });
  await page.getByRole('menuitem', { name: /Open the console/ }).click();
  await page.waitForSelector('.run-console');
  const command = page.getByLabel('Command to run');
  await command.fill('find . -type f | sort && echo && head -n 12 Makefile');
  await command.press('Enter');
  await page.waitForFunction(() => /\[reader\] exit 0/.test(document.querySelector('.console-out')?.textContent ?? ''), null, { timeout: 15000 });
  const out = await page.locator('.console-out').textContent();
  check('the command runs in the project, and its output streams back', /\.\/minitron\/distill\.py/.test(out) && /PLAN\.md/.test(out) && /make all/.test(out), out.slice(0, 200));
  await scrollTo('#explain-datasets', 40);
  await page.waitForTimeout(200);
  check('a shell cell can be run locally', (await page.locator('.explain-cell.is-shell .local-run').count()) === 2);
  await page.screenshot({ path: `${OUT}/implement-12-console.png` });
  await page.locator('.run-console').getByRole('button', { name: 'Close the console' }).click();
} else {
  check('the scaffold can be written', false, 'no Write button — READER_WORKSPACE is not set on the server');
}

console.log('\n== a request from the bar ==');
const bar = page.getByLabel('Ask about the explanation, or ask for a change');
await page.locator('.explain-scroll').evaluate((el) => (el.scrollTop = 0));
await bar.click();
await page.waitForTimeout(200);
check('the suggestions are the plan’s', /smallest version|Lightning|JAX/.test((await page.locator('.ask-suggestion').allTextContents()).join(' ')));
const datasets = page.locator('.explain-section[data-title="Datasets"]');
await datasets.scrollIntoViewIfNeeded();
await datasets.hover();
await datasets.getByRole('button', { name: 'Ask or adjust' }).click();
await bar.fill('Swap the dataset for one I can download in an hour');
await bar.press('Enter');
await page.waitForSelector('.ask-status.is-done', { timeout: 15000 });
const revising = await lastAsked();
check('the page and the machine go back with the request', revising.messages[1]?.role === 'assistant' && /readers_hardware_now/.test(revising.messages.at(-1).content));
check('the instructions are the plan’s, unchanged', JSON.stringify(revising.system.slice(0, 2)) === JSON.stringify(asked.system.slice(0, 2)));
check('Claude’s note says what changed', /stream/.test(await page.locator('.ask-status.is-done').textContent()));
check('the section is marked as revised', (await datasets.locator('.revised-pill').count()) === 1);
check('and the rest stays', (await page.locator('.explain-section').count()) === 10);
await scrollTo('.explain-section[data-title="Datasets"]');
await page.screenshot({ path: `${OUT}/implement-13-revised.png` });

console.log('\n== the other tab is its own page ==');
await page.getByRole('tab', { name: 'Explanation' }).click();
await page.waitForSelector('.explain-empty', { timeout: 10000 });
check('the explanation has not been written, and is offered', await page.getByRole('button', { name: 'Explain this paper' }).isVisible());
await page.getByRole('tab', { name: 'Implementation' }).click();
await page.waitForSelector('.impl-tree');
check('the plan is still there', (await page.locator('.explain-section').count()) === 10);

console.log('\n== notebook layout, dark ==');
await page.getByRole('button', { name: 'Notebook', exact: true }).click();
await page.evaluate(() => {
  const saved = JSON.parse(localStorage.getItem('reader.settings') || '{}');
  localStorage.setItem('reader.settings', JSON.stringify({ ...saved, theme: 'dark' }));
});
await page.reload({ waitUntil: 'networkidle' });
{
  const notNow = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
}
await page.waitForSelector('.impl-budget', { timeout: 20000 });
await scrollTo('#explain-compute-budget');
await page.screenshot({ path: `${OUT}/implement-14-dark-budget.png` });
await scrollTo('#explain-repository-layout');
await page.screenshot({ path: `${OUT}/implement-15-dark-tree.png` });

console.log('\n== on a phone ==');
await page.setViewportSize({ width: 390, height: 844 });
await scrollTo('#explain-compute-budget');
const overflow = await page.locator('.explain-scroll').evaluate((el) => el.scrollWidth - el.clientWidth);
// What is too wide, when something is: the widest elements, so the failure names them.
const wide = overflow > 1 ? await page.locator('.explain-scroll').evaluate((el) => {
  const limit = el.clientWidth;
  return Array.from(el.querySelectorAll('*'))
    .map((node) => ({ w: Math.round(node.getBoundingClientRect().right), tag: `${node.tagName.toLowerCase()}.${String(node.className).split(' ').slice(0, 2).join('.')}` }))
    .filter((item) => item.w > limit + 1)
    .slice(0, 8)
    .map((item) => `${item.tag}@${item.w}`)
    .join(', ');
}) : '';
check('nothing scrolls sideways', overflow <= 1, `${overflow}px ${wide}`);
await page.screenshot({ path: `${OUT}/implement-16-phone.png` });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nall good');
process.exit(problems.length ? 1 : 0);
