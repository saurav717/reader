/**
 * A project's paper in Overleaf, each way Settings offers: the paper card on
 * the overview, Overleaf beside (the cite keys in the workspace), the
 * workspace's Write layout saving to GitHub, and the dock's Draft tab.
 * Seeds a project linked to an Overleaf project and a GitHub repository,
 * stands in for GitHub, and writes screenshots of each to .smoke/.
 *
 *   npm run build && npm start &
 *   node scripts/overleaf-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const day = (ago) => new Date(Date.now() - ago * 24 * 3600 * 1000).toISOString();
const paper = (id, title, authors, extra) => ({ id, source: 'arxiv', title, authors, abstract: 'An abstract.', published: '2022-01-01', categories: [], addedAt: day(5), collectionIds: ['p-moe'], tags: [], progress: 0, ...extra });
const PAPERS = [
  paper('arxiv:2408.15664', 'Auxiliary-Loss-Free Load Balancing Strategy for Mixture-of-Experts', ['Lean Wang', 'Huazuo Gao'], { arxivId: '2408.15664', published: '2024-08-28', progress: 0.3, lastOpenedAt: day(0) }),
  paper('arxiv:2101.03961', 'Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity', ['William Fedus', 'Barret Zoph', 'Noam Shazeer'], { arxivId: '2101.03961', progress: 1, lastOpenedAt: day(3) }),
  paper('arxiv:2202.08906', 'ST-MoE: Designing Stable and Transferable Sparse Expert Models', ['Barret Zoph'], { arxivId: '2202.08906', progress: 0.5, lastOpenedAt: day(1) }),
  paper('arxiv:1701.06538', 'Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer', ['Noam Shazeer'], { arxivId: '1701.06538', published: '2017-01-23', progress: 1, lastOpenedAt: day(9) }),
  paper('arxiv:2202.09368', 'Mixture-of-Experts with Expert Choice Routing', ['Yanqi Zhou'], { arxivId: '2202.09368' }),
];
const LINK = { url: 'https://www.overleaf.com/project/66f1c0a9e2b7d4a1b2c3d4e5', repo: 'me/moe-paper' };

// GitHub, standing in: a repository holding the paper, which takes commits.
const repo = new Map([
  ['main.tex', '\\documentclass{article}\n\\usepackage{natbib}\n\\title{Loss-free routing at 8B}\n\\begin{document}\n\\maketitle\n\\input{sections/intro}\n\\input{sections/related}\n\\input{sections/method}\n\\bibliography{refs}\n\\end{document}\n'],
  ['sections/intro.tex', '\\section{Introduction}\nSparse mixture-of-experts models route each token to a few experts, so a model can grow without its compute growing with it. Keeping the experts evenly loaded is the hard part: an auxiliary loss does it at a price in quality.\n\nWe show that routing can stay balanced at 8B without an auxiliary loss, by a bias used only to choose experts.\n'],
  ['sections/related.tex', '\\section{Related work}\n\\paragraph{Load balancing.}\nMost MoE models keep experts busy with an auxiliary loss on the router~\\cite{fedus2021switch,zoph2022stmoe}.\nIts weight trades balance against quality: too small and experts collapse, too large and the LM loss suffers~\\cite{zoph2022stmoe}.\nExpert choice routing~\\cite{zhou2022expert} side-steps this by letting experts pick tokens.\n\n% TODO(Priya): one line on DeepSeek-V3 here?\n\\paragraph{Routing at scale.}\nGShard~\\cite{lepikhin2020gshard} trained a 600B-parameter MoE with top-2 gating.\n'],
  ['sections/method.tex', '\\section{Method}\n\\subsection{Loss-free balancing}\nBefore the top-$K$ decision we add a bias $b_i$ to each expert\'s score; the gate value is still the original score. After each batch, $b_i$ moves by the load violation error.\n\\subsection{Training at 8B}\nWe train for 40B tokens on 64 experts with top-8 routing.\n'],
  ['refs.bib', '@article{fedus2021switch,\n  title = {Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity},\n  eprint = {2101.03961}\n}\n\n@misc{zoph2022stmoe,\n  title = {ST-MoE: Designing Stable and Transferable Sparse Expert Models},\n  eprint = {2202.08906}\n}\n\n@misc{zhou2022expert,\n  title = {Mixture-of-Experts with Expert Choice Routing},\n  eprint = {2202.09368}\n}\n'],
  ['figures/load.png', 'png'],
]);
let commits = 0;
const sha = (path) => `${Buffer.from(path).toString('hex').slice(0, 20)}${String(Buffer.from(repo.get(path)).length).padStart(6, '0')}${commits}`;
const shaOf = new Map();
const tree = () => [...repo.keys()].map((path) => {
  const s = sha(path);
  shaOf.set(s, path);
  return { path, type: 'blob', sha: s, size: repo.get(path).length };
});
const pendingBlobs = new Map();
let pendingTree = null;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|fonts\.|api\.github\.com)/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
await context.route(/^https:\/\/api\.github\.com\/repos\/me\/moe-paper\//, async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname.replace('/repos/me/moe-paper', '');
  const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  if (path.startsWith('/git/trees/') && request.method() === 'GET') return json({ tree: tree() });
  if (path.startsWith('/git/blobs/') && request.method() === 'GET') return json({ content: Buffer.from(repo.get(shaOf.get(path.split('/').pop())) ?? '').toString('base64'), encoding: 'base64' });
  if (path.startsWith('/git/ref/heads/')) return json({ object: { sha: `c${commits}` } });
  if (path.startsWith('/git/commits/') && request.method() === 'GET') return json({ tree: { sha: `t${commits}` } });
  if (path === '/git/blobs') {
    const body = request.postDataJSON();
    const id = `b${pendingBlobs.size}`;
    pendingBlobs.set(id, Buffer.from(body.content, 'base64').toString('utf8'));
    return json({ sha: id });
  }
  if (path === '/git/trees') {
    pendingTree = request.postDataJSON().tree;
    return json({ sha: `t${commits + 1}` });
  }
  if (path === '/git/commits') return json({ sha: `c${commits + 1}` });
  if (path.startsWith('/git/refs/heads/')) {
    for (const item of pendingTree ?? []) repo.set(item.path, pendingBlobs.get(item.sha));
    commits += 1;
    return json({ object: { sha: `c${commits}` } });
  }
  return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Not Found"}' });
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

async function seed(settings, view, link = LINK) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(
    async ({ papers, settings, view, link }) => {
      localStorage.setItem('reader.welcomed', 'true');
      localStorage.setItem('reader.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('reader.settings') || '{}'), ...settings }));
      localStorage.setItem('reader.view', JSON.stringify(view));
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('reader', 1);
        // First here, before the app: the stores as the app makes them.
        request.onupgradeneeded = () => {
          const made = request.result;
          for (const store of ['papers', 'collections']) if (!made.objectStoreNames.contains(store)) made.createObjectStore(store, { keyPath: 'id' });
          if (!made.objectStoreNames.contains('highlights')) made.createObjectStore('highlights', { keyPath: 'id' }).createIndex('paperId', 'paperId', { unique: false });
          if (!made.objectStoreNames.contains('kv')) made.createObjectStore('kv');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const run = (store, act) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(store, 'readwrite');
          act(tx.objectStore(store));
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      for (const store of ['papers', 'collections', 'kv']) await run(store, (s) => s.clear());
      await run('collections', (s) =>
        s.put({
          id: 'p-moe',
          name: 'Sparse-gated MoE',
          color: '#1f5e52',
          createdAt: new Date().toISOString(),
          project: { question: 'Can routing stay balanced without an aux loss at 8B?', startedAt: new Date().toISOString(), roles: {}, todos: [], ...(link ? { overleaf: link } : {}) },
        }),
      );
      for (const paper of papers) await run('papers', (s) => s.put(paper));
      db.close();
    },
    { papers: PAPERS, settings, view, link },
  );
  const address = view.kind === 'paper' ? `/paper/?id=${encodeURIComponent(view.id)}` : `/project/?id=${view.id}${view.mode === 'workspace' ? '&view=workspace' : ''}`;
  await page.goto(`${BASE}${address}`, { waitUntil: 'networkidle' });
  const skip = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

const settings = { githubToken: 'test-token', overleafView: 'beside' };

console.log('linking a project to Overleaf');
await seed(settings, { kind: 'project', id: 'p-moe' }, null);
await page.getByRole('button', { name: 'Link an Overleaf project' }).click();
await page.getByLabel('Overleaf project').fill('overleaf.com/project/nope');
check('an address that is not a project is refused', await page.locator('.ol-form button[type=submit]').isDisabled());
await page.getByLabel('Overleaf project').fill('https://www.overleaf.com/project/66f1c0a9e2b7d4a1b2c3d4e5');
await page.locator('.ol-more > summary').click();
await page.getByLabel('Repository').fill('https://github.com/me/moe-paper');
await shot('overleaf-link');
await page.locator('.ol-form button[type=submit]').click();
await page.locator('.ol-sec').first().waitFor({ timeout: 10000 }).catch(() => {});
check('once linked, the card reads the draft from the repository', (await page.locator('.ol-sec').count()) >= 3);

console.log('the overview: the paper card');
await seed(settings, { kind: 'project', id: 'p-moe' });
await page.locator('.ol-card').waitFor({ timeout: 15000 }).catch(() => (console.log(errors), shot('overleaf-fail')));
await page.locator('.ol-sec').first().waitFor({ timeout: 10000 }).catch(async () => { await page.locator('.ol-card').scrollIntoViewIfNeeded(); await shot('overleaf-fail'); console.log(await page.locator('.ol-card').innerText()); });
await page.locator('.ol-card').scrollIntoViewIfNeeded();
const sections = await page.locator('.ol-sec-title').allTextContents();
check('the outline comes from the .tex files, in the order main.tex reads', sections.join('|') === 'Introduction|Related work|Method|Loss-free balancing|Training at 8B', sections.join(' | '));
const flags = await page.locator('.ol-card').innerText();
check('it counts what the draft cites', /3 of 5 cited/i.test(flags), flags.match(/\d+ of \d+ cited/i)?.[0]);
check('it names the paper read and not cited', /Read, not cited:[\s\S]*Auxiliary-Loss-Free/.test(flags) && /Outrageously Large/.test(flags));
check('it names the key with no entry', /lepikhin2020gshard/.test(flags));
check('beside: the button opens Overleaf beside', (await page.getByRole('button', { name: /Open Overleaf beside/ }).count()) === 1);
await shot('overleaf-overview');

console.log('beside: the cite keys in the workspace');
await page.evaluate(() => localStorage.setItem('reader.project.layout', 'paper'));
await seed(settings, { kind: 'project', id: 'p-moe', mode: 'workspace' });
await page.locator('.pj-ws-overleaf').waitFor({ timeout: 15000 });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
const popup = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
await page.locator('.pj-ws-overleaf').getByRole('button', { name: /Overleaf/ }).click();
const opened = await popup;
check('Overleaf opens in a window of its own', Boolean(opened), opened?.url());
await opened?.close();
await page.locator('.ol-cite-btns').getByRole('button', { name: /cite/ }).click();
const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
check('\\cite copies the key the draft knows the paper by', clip === '\\cite{wang2024auxiliary}' || clip.startsWith('\\cite{'), clip);
await shot('overleaf-beside');

console.log('write: the Write layout in the workspace');
await page.evaluate(() => localStorage.setItem('reader.project.layout', 'write'));
await seed({ ...settings, overleafView: 'write' }, { kind: 'project', id: 'p-moe', mode: 'workspace' });
await page.locator('.ol-editor textarea').waitFor({ timeout: 15000 });
check('Write is a layout of the workspace', (await page.locator('.pj-ws-bar').getByRole('button', { name: 'Write' }).getAttribute('aria-pressed')) === 'true');
await page.locator('.ol-editor-bar select').selectOption('sections/related.tex');
const area = page.locator('.ol-editor textarea');
await area.click();
await page.keyboard.press('Control+End');
// The editor places the caret after Enter on the next frame, as it does in the Playground.
await page.keyboard.press('Enter');
await page.waitForTimeout(100);
await page.keyboard.type('Closest to us, ');
await page.locator('.ol-cite-bar').getByRole('button', { name: '\\citet' }).click();
await page.waitForTimeout(100);
await page.keyboard.type(' add a per-expert bias used only for selection.');
const typed = await area.inputValue();
check('\\citet goes in at the caret', /Closest to us, \\citet\{wang2024\w+\} add a per-expert bias/.test(typed), typed.split('\n').slice(-1)[0]);
await shot('overleaf-write');
await page.locator('.ol-editor-bar').getByRole('button', { name: 'Save' }).click();
await page.locator('.ol-banner.is-ok').waitFor({ timeout: 10000 });
check('Save is one commit with the section and its new bib entry', commits === 1 && /Closest to us/.test(repo.get('sections/related.tex')) && /@misc\{wang2024\w+,/.test(repo.get('refs.bib')));
await shot('overleaf-write-saved');

console.log('write: a change made in Overleaf is not written over');
await area.click();
await page.keyboard.type(' More.');
repo.set('sections/related.tex', `${repo.get('sections/related.tex')}% edited in Overleaf\n`);
await page.locator('.ol-editor-bar').getByRole('button', { name: 'Save' }).click();
await page.locator('.ol-banner:not(.is-ok)').waitFor({ timeout: 10000 });
check('it says the file moved, and writes nothing', commits === 1 && /changed in the repository/.test(await page.locator('.ol-banner').innerText()));

console.log('dock: the Draft tab beside a paper');
await seed({ ...settings, overleafView: 'dock' }, { kind: 'paper', id: 'arxiv:2202.08906' });
const draftTab = page.locator('.dock-tabs').getByRole('tab', { name: 'Draft' });
await draftTab.waitFor({ timeout: 15000 });
await draftTab.click();
await page.locator('.ol-dock .ol-editor textarea').waitFor({ timeout: 10000 });
check('the dock has the outline and the editor', (await page.locator('.ol-dock-outline span').count()) >= 3);
check('the paper open is the one Cite puts in', /ST-MoE/.test(await page.locator('.ol-dock .ol-cite-paper').innerText()));
await shot('overleaf-dock');

console.log('settings: the four choices');
await page.keyboard.press('Escape');
await page.evaluate(() => window.dispatchEvent(new Event('reader:open-settings')));
const choice = page.getByRole('radiogroup', { name: /Where a project’s paper is written/ });
await choice.waitFor({ timeout: 5000 }).catch(() => {});
if (await choice.isVisible().catch(() => false)) {
  await choice.scrollIntoViewIfNeeded();
  check('four choices, beside the default', (await choice.getByRole('radio').count()) === 4 && /default/.test(await choice.getByRole('radio').first().innerText()));
  await shot('overleaf-settings');
} else check('Settings opens', false);

check('no errors on the page', !errors.length, errors.join(' | '));
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log('\nall good');
