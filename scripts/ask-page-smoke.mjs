/**
 * Ask AI reading the rest of the page: what goes with a question from each
 * page of the app, as it is really sent. Seeds a small library with one paper
 * (Attention Is All You Need, fetched from arXiv), stands in for Anthropic's
 * API with a canned answer, asks a question from Home, the Library, a
 * project's overview and workspace, the Playground, the paper as a PDF and
 * reflowed, with Settings over it, with the Notes panel beside it and with
 * the Explain page open, and checks the <page_on_screen> block of each —
 * what is in it, what is kept out of it, and what the switch under ⚙ does.
 * Writes a screenshot of each state and the block as sent to .smoke/.
 *
 *   npm run build && npm start &
 *   node scripts/ask-page-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 *
 * DOCS_OUT=docs/ask-page writes the figures the documentation uses there too.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
const DOCS = process.env.DOCS_OUT || '';
await mkdir(OUT, { recursive: true });
if (DOCS) await mkdir(DOCS, { recursive: true });

const problems = [];
function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${status}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const day = (ago) => new Date(Date.now() - ago * 864e5).toISOString();
const paper = (id, title, authors, extra) => ({ id, source: 'arxiv', title, authors, abstract: '', published: '', categories: [], addedAt: day(0), collectionIds: ['c-reading'], tags: [], progress: 0, ...extra });
const PAPERS = [
  paper('arxiv:1706.03762', 'Attention Is All You Need', ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'], { arxivId: '1706.03762', published: '2017-06-12', abstract: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder.', progress: 0.2, lastOpenedAt: day(0) }),
  paper('arxiv:2503.07137', 'A comprehensive survey of mixture-of-experts: Algorithms, theory, and applications', ['S Mu', 'S Lin'], { arxivId: '2503.07137', published: '2025-03-10', addedAt: day(4), progress: 0.63, lastOpenedAt: day(2) }),
  paper('arxiv:2005.14165', 'Language Models are Few-Shot Learners', ['Tom B. Brown', 'Benjamin Mann'], { arxivId: '2005.14165', published: '2020-05-28', addedAt: day(9) }),
];

/** What the stand-in says to each question: the window's part is what is tested, not the model's. */
const ANSWERS = {
  'How do I share this project?': 'Press **Share** — it is on the project bar at the top of the page, after **Logbook**. A dialog asks for an email address and a role (editor or viewer), and the project becomes a room on the server that both of you read from. You can stop sharing from the same button later.',
  'What can I do on this page?': 'You are on **Home**, on its **Find papers** view. The big search box looks up arXiv, OpenAlex, Semantic Scholar and Crossref at once; **Save to** picks the collection a result’s **+** adds to. The other views are the tabs beside the greeting: **Continue reading**, **Today**, **Inbox** and **Collections**.',
  'What does this setting do?': 'The **Google OAuth client ID** box on the **Account** tab is what lets *Sign in with Google* work on this site: paste the client ID from the Google Cloud Console, and the Sign in button above it comes alive.',
};
const ANSWER_DEFAULT = 'I can see the page you are on — its headings, buttons and fields — so ask about anything on it, or how to do something from here.';

const sse = (text) =>
  [
    ['message_start', { type: 'message_start', message: { id: 'msg_smoke', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM || undefined });
const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: DOCS ? 2 : 1 });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

// Every question goes to Anthropic's API on this browser's "own" key; the stand-in keeps the request and answers from the table.
const captured = [];
await context.route('https://api.anthropic.com/**', (route) => {
  const body = JSON.parse(route.request().postData() || '{}');
  captured.push(body);
  const last = body.messages?.[body.messages.length - 1];
  const asked = (typeof last?.content === 'string' ? last.content : last?.content?.map((c) => c.text ?? '').join('\n')) ?? '';
  const answer = Object.entries(ANSWERS).find(([question]) => asked.endsWith(question))?.[1] ?? ANSWER_DEFAULT;
  route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(answer) });
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(async ({ papers }) => {
  localStorage.setItem('reader.welcomed', 'true');
  localStorage.setItem('reader.tour.done', 'true');
  localStorage.setItem('reader.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('reader.settings') || '{}'), theme: 'koios' }));
  localStorage.setItem('reader.view', JSON.stringify({ kind: 'home' }));
  // A key that is never sent anywhere real: the route above answers for api.anthropic.com.
  localStorage.setItem('reader.anthropic-key', 'sk-ant-api03-smoke-test-not-a-real-key-000000');
  localStorage.setItem('reader.assistant.v1', JSON.stringify({ model: 'claude-opus-5' }));
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('reader', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const put = (store, value) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  const clear = (store) => new Promise((resolve) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).clear(); tx.oncomplete = resolve; });
  for (const store of ['papers', 'collections', 'highlights']) await clear(store);
  await put('collections', { id: 'c-reading', name: 'Reading list', color: '#2f7d6d', createdAt: new Date().toISOString() });
  await put('collections', { id: 'c-moe', name: 'Mixture of experts', color: '#5b63b7', createdAt: new Date().toISOString(), project: { question: 'Do the experts in a sparse MoE specialise, and can routing be learned without load-balancing losses?', roles: {}, todos: [{ id: 't1', text: 'Reproduce the routing ablation', done: false }] } });
  for (const p of papers) await put('papers', p);
  await put('highlights', { id: 'h1', paperId: 'arxiv:1706.03762', color: 'yellow', exact: 'Scaled Dot-Product Attention', prefix: '', suffix: '', hint: 0, tags: [], note: 'why sqrt(d_k)?', createdAt: new Date().toISOString() });
  db.close();
}, { papers: PAPERS });

const shot = async (name, target) => {
  const path = `${OUT}/${name}.png`;
  await (target ?? page).screenshot({ path });
  return path;
};
async function go(path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  const skip = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
}

/** The block of a <screen> as sent, by tag name. */
const part = (text, name) => new RegExp(`<${name}(?: [^>]*)?>\\n?([^]*?)\\n?</${name}>`).exec(text)?.[1] ?? null;
const sent = {};
/** Ask from the window, wait for the request, keep what went with it. */
async function ask(name, question) {
  const before = captured.length;
  if (!(await page.locator('.assistant-win').isVisible().catch(() => false))) await page.locator('button[aria-label="Ask AI"], button[title^="Ask AI"]').first().click();
  const box = page.locator('.assistant-win textarea');
  await box.fill(question);
  await box.press('Enter');
  for (let i = 0; i < 150 && captured.length === before; i++) await page.waitForTimeout(100);
  await page.waitForTimeout(500);
  const body = captured[captured.length - 1];
  check(`${name}: a question was sent`, captured.length > before);
  if (captured.length === before) return null;
  const last = body.messages[body.messages.length - 1];
  const text = typeof last.content === 'string' ? last.content : last.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const images = typeof last.content === 'string' ? 0 : last.content.filter((c) => c.type === 'image').length;
  const screen = /<screen>\n([^]*?)\n<\/screen>/.exec(text)?.[1] ?? '';
  const result = { question, text, screen, images, where: part(screen, 'where'), page: part(screen, 'page_on_screen'), system: body.system.map((block) => ({ chars: block.text.length, cached: Boolean(block.cache_control) })) };
  sent[name] = result;
  await writeFile(`${OUT}/${name}.txt`, text);
  await shot(name);
  return result;
}

console.log('\n== Home ==');
await go('/');
let r = await ask('home', 'What can I do on this page?');
check('the block is there, with the address and title', r?.page && /address="\/"/.test(r.screen) && /title="/.test(r.screen));
check("Home's views are named as the tabs they are, the open one marked", /\[Find papers[^\]]*\] \(on\) \[Continue reading\]/.test(r?.page ?? ''));
check('the rail says which page is current', /\[Home\] \(current\)/.test(r?.page ?? ''));
check('the search box is read as a field, empty', /\[field “Search for papers”: \(empty\)\]/.test(r?.page ?? ''));
check('the question typed into the window is not read back from it', !(r?.page ?? '').includes('What can I do on this page?'));
check('no paper open: the system prompt is one block', r?.system.length === 1);
if (DOCS) await copyFile(`${OUT}/home.png`, `${DOCS}/fig-home-ask.png`);

console.log('\n== The Library ==');
await go('/library');
r = await ask('library', 'Which of these should I read first?');
check('the list, its filters and the three papers are in it', /\[All papers 3\]/.test(r?.page ?? '') && (r?.page ?? '').includes('Language Models are Few-Shot Learners'));
check('words split across spans read as one word', /3 papers/.test(r?.page ?? '') && !/paper s\b/.test(r?.page ?? ''));
check('the list of titles still goes on its own switch too', Boolean(part(r?.screen ?? '', 'list_on_screen')));
check('the Discover panel beside it is read', /## Discover/.test(r?.page ?? ''));

console.log('\n== A project ==');
await go('/project/c-moe');
r = await ask('project', 'How do I share this project?');
check("the project's bar, with Share, is there", /\[Share\]/.test(r?.page ?? '') && /\[Overview\] \(on\)/.test(r?.page ?? ''));
check("the project's question and its to-do are read", (r?.page ?? '').includes('Do the experts in a sparse MoE specialise') && /\[tick box “Reproduce the routing ablation”: off\]/.test(r?.page ?? ''));
check('the where line names the project', /research project “Mixture of experts”/.test(r?.where ?? ''));
if (DOCS) await copyFile(`${OUT}/project.png`, `${DOCS}/fig-project-ask.png`);

await go('/project/c-moe?view=workspace');
r = await ask('workspace', 'What is this page for?');
check('the workspace: its layout switch, with the one on marked', /\[Full code\] \(on\) \[Side by side\] \[Paper\]/.test(r?.page ?? ''));
check('text in sibling boxes keeps apart', /Projects Beside the page/.test(r?.page ?? '') && /Colab needs a Google client ID/.test(r?.page ?? ''));

console.log('\n== The Playground ==');
await go('/playground');
r = await ask('playground', 'How do I run a notebook on my own computer?');
check('the six ways to start are read as the buttons they are', /\[\[ \] Blank notebook/.test(r?.page ?? '') && /From a repository/.test(r?.page ?? ''));

console.log('\n== The paper, as a PDF ==');
await go('/paper/arxiv:1706.03762');
await page.waitForSelector('.pdf-book-page canvas', { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(2500);
r = await ask('paper-pdf', 'What is on my screen right now?');
check('the PDF is open, set as a book', (await page.locator('.pdf-book').count()) === 1);
check('the paper goes in its own blocks: details, abstract, the pages in view as text', Boolean(part(r?.screen ?? '', 'paper')) && Boolean(part(r?.screen ?? '', 'passage_in_view')));
check('the pages in view go as pictures', (r?.images ?? 0) >= 1, `${r?.images} images`);
check('the paper text is the cached system block', r?.system.length === 2 && r.system[1].cached && r.system[1].chars > 20000, JSON.stringify(r?.system));
check("the page block has the paper's top bar, PDF marked on", /\[Reflow\] \[PDF\] \(on\)/.test(r?.page ?? ''));
check("the page block does not repeat the PDF's pages", !/\[Page \d+\]/.test(r?.page ?? '') && !(r?.page ?? '').includes('dominant sequence transduction'));
if (DOCS) await copyFile(`${OUT}/paper-pdf.png`, `${DOCS}/fig-paper-ask.png`);

console.log('\n== Settings over the paper ==');
await page.getByRole('button', { name: 'Sign in and settings' }).click();
await page.waitForTimeout(600);
r = await ask('settings', 'What does this setting do?');
check('Settings is announced as a window, with its tabs and the open one', /— a window: Settings —/.test(r?.page ?? '') && /\[Account\] \(current\)/.test(r?.page ?? ''));
check("the client ID field is read, with its placeholder as its name", /\[field “[^”]*apps\.googleusercontent\.com”: \(empty\)\]/.test(r?.page ?? '') || /client ID/i.test(r?.page ?? ''));
await page.getByRole('tab', { name: 'Proxy & access' }).click();
await page.waitForTimeout(500);
r = await ask('settings-proxy', 'Is my proxy set up?');
const proxyFields = (r?.page ?? '').match(/\[field[^\]]*\]/g) ?? [];
check('the proxy tab is on screen, with its fields', /Proxy & access\] \(current\)/.test(r?.page ?? '') && proxyFields.length > 0, `${proxyFields.length} fields`);
check('a field named for a token or pass never shows its value', !proxyFields.some((field) => /token|pass|key/i.test(field) && /: “/.test(field)), proxyFields.join(' '));
check("a wrapping label's hint is not taken as the field's name", proxyFields.some((field) => /\[field “Proxy token”/.test(field)), proxyFields.join(' '));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

console.log('\n== The paper, reflowed ==');
await page.getByRole('button', { name: 'Reflow', exact: true }).click();
await page.waitForSelector('.paper-body p', { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1500);
r = await ask('paper-reflow', 'Explain the passage I am looking at.');
check('the paper is reflowed', (await page.locator('.paper-body').count()) === 1);
check('the passage in view comes from the column, as text', /attention/i.test(part(r?.screen ?? '', 'passage_in_view') ?? ''));
check("the page block has the bar, Reflow marked on, and not the paper's column", /\[Reflow\] \(on\)/.test(r?.page ?? '') && !(r?.page ?? '').includes('dominant sequence transduction'));

console.log('\n== The Notes panel beside it ==');
await page.locator('button[title*="Highlights and notes"], button[aria-label="Notes"]').first().click();
await page.waitForTimeout(700);
r = await ask('notes', 'What have I highlighted?');
check('the Notes panel is read, with the highlight and its controls', /## Notes/.test(r?.page ?? '') && (r?.page ?? '').includes('[Scaled Dot-Product Attention]'));
check('the highlights block is there too, with the note', /why sqrt\(d_k\)\?/.test(part(r?.screen ?? '', 'highlights') ?? ''));

console.log('\n== The Explain page, before anything is written ==');
await page.getByRole('button', { name: 'Explain', exact: true }).first().click();
await page.waitForTimeout(1500);
r = await ask('explain-start', 'What will this page do?');
check('the where line says the Explain page is open and empty', /Explain page open — nothing written/.test(r?.where ?? ''));
check('its start page is read, with the button that writes it', /\[Explain this paper\]/.test(r?.page ?? ''));
check('no explanation block, since there is none', !part(r?.screen ?? '', 'explain_page'));

console.log('\n== The switch under ⚙ ==');
const gear = page.locator('.assistant-win button[aria-label="Settings"]');
await gear.click();
await page.waitForTimeout(500);
const rows = await page.locator('.assistant-win .set-switch b').allTextContents();
check('nine parts, the page last', rows.length === 9 && rows[8] === 'The rest of the page', rows.join(' | '));
check('the drawer counts them', /9 of 9 on/.test(await page.locator('.assistant-win .chat-settings').innerText()));
await page.locator('.assistant-win .chat-settings').evaluate((el) => el.querySelector('.set-switches')?.scrollIntoView({ block: 'center' }));
await page.waitForTimeout(300);
await shot('gear', page.locator('.assistant-win'));
if (DOCS) await copyFile(`${OUT}/gear.png`, `${DOCS}/fig-gear.png`);
await page.locator('.assistant-win .set-switch', { hasText: 'The rest of the page' }).click();
await page.waitForTimeout(200);
await gear.click();
r = await ask('page-off', 'What will this page do?');
check('off: the block is not assembled at all', r && !r.page && !/page_on_screen/.test(r.text));
await gear.click();
await page.locator('.assistant-win .set-switch', { hasText: 'The rest of the page' }).click();
await gear.click();
r = await ask('page-on', 'And now?');
check('on again: it is back', Boolean(r?.page));

console.log('\n== Cost ==');
await go('/library');
const timing = await page.evaluate(async () => {
  const { pageOnScreen } = await import('/src/lib/screen.ts').catch(() => ({}));
  if (!pageOnScreen) return null;
  const t = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    pageOnScreen();
    t.push(Math.round(performance.now() - start));
  }
  return t;
});
if (timing) check('reading the page takes a few milliseconds', Math.max(...timing) < 50, `${timing.join(', ')} ms`);
else console.log('  (built site: the module is not importable by path; timing skipped)');

const sizes = Object.fromEntries(Object.entries(sent).map(([name, r]) => [name, { page: r.page?.length ?? 0, screen: r.screen.length, system: r.system.map((b) => b.chars), images: r.images }]));
await writeFile(`${OUT}/sizes.json`, JSON.stringify(sizes, null, 1));
console.log('\nsizes (chars):', Object.entries(sizes).map(([k, v]) => `${k} page ${v.page} / screen ${v.screen} / system ${v.system.join('+')}`).join('\n  '));

await browser.close();
if (errors.length) console.log('\npage errors:', errors.slice(0, 5));
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nall good');
