/**
 * Writing the paper in Reader, Overleaf a sync beside it, and the code to
 * GitHub: the board's Connections (GitHub and Overleaf, once), the paper card
 * on the overview (Start writing / Continue writing where you left off), the
 * Write tab's start (writing here first), the Write tab opening where it was
 * left, Connect to Overleaf in the editor (no token asked again), and the
 * workspace's Sync to GitHub (a repository made from its menu, then a push).
 *
 * Stands in for Google (sign-in and a Drive in memory), Reader's server (the
 * Overleaf accounts, the compiler: a one-page PDF) and GitHub. Screenshots go
 * to .smoke/.
 *
 *   npm run build && npm start &
 *   node scripts/write-flow-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { makePdf } from './fakeGoogle.mjs';
import { handleGithub } from '../worker/github.js';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const THEME = process.env.SMOKE_THEME || 'dark';

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(label);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

// ---- Google Drive, in memory, with the MoE project's paper in it
const FOLDER = 'application/vnd.google-apps.folder';
const items = new Map([['root', { id: 'root', name: 'My Drive', mimeType: FOLDER, parents: [], trashed: false }]]);
let nextId = 1;
const meta = (item) => ({ id: item.id, name: item.name, mimeType: item.mimeType, size: item.data ? String(item.data.length) : undefined, modifiedTime: item.modifiedTime, webViewLink: `https://drive.google.com/file/d/${item.id}/view` });
const put = (path, text) => {
  let parent = 'root';
  const parts = path.split('/');
  for (const [index, name] of parts.entries()) {
    const last = index === parts.length - 1;
    let found = [...items.values()].find((item) => item.name === name && item.parents[0] === parent && !item.trashed);
    if (!found) {
      found = { id: `${last ? 'f' : 'd'}${nextId++}`, name, mimeType: last ? 'text/plain' : FOLDER, parents: [parent], trashed: false, modifiedTime: new Date(Date.now() - 3 * 3600_000).toISOString() };
      items.set(found.id, found);
    }
    if (last) found.data = Buffer.from(text);
    parent = found.id;
  }
};
const LATEX = 'Papers_collection/Projects/Sparse-gated MoE-p-moe/LaTeX';
put(`${LATEX}/main.tex`, '\\documentclass{article}\n\\usepackage{natbib}\n\\title{Loss-free routing at 8B}\n\\author{Saurav}\n\\begin{document}\n\\maketitle\n\\input{sections/intro}\n\\input{sections/related}\n\\input{sections/method}\n\\bibliographystyle{plainnat}\n\\bibliography{refs}\n\\end{document}\n');
put(`${LATEX}/sections/intro.tex`, '\\section{Introduction}\nSparse mixture-of-experts models route each token to a few experts, so a model can grow without its compute growing with it.\nKeeping the experts evenly loaded is the hard part: an auxiliary loss does it at a price in quality.\n\nWe show that routing can stay balanced at 8B without an auxiliary loss, by a bias used only to choose experts.\n');
put(
  `${LATEX}/sections/related.tex`,
  [
    '\\section{Related work}',
    '\\paragraph{Load balancing.}',
    'Most MoE models keep experts busy with an auxiliary loss on the router~\\cite{fedus2021switch,zoph2022stmoe}.',
    'Its weight trades balance against quality: too small and experts collapse, too large and the LM loss suffers~\\cite{zoph2022stmoe}.',
    'Expert choice routing~\\cite{zhou2022expert} side-steps this by letting experts pick tokens.',
    '',
    '\\paragraph{Routing at scale.}',
    'GShard~\\cite{lepikhin2020gshard} trained a 600B-parameter MoE with top-2 gating.',
    'Switch Transformers~\\cite{fedus2021switch} showed top-1 routing is enough, and cheaper.',
    '',
    '\\paragraph{Bias-based balancing.}',
    'Closest to us, Wang et al. add a per-expert bias used only for selection,',
    'and update it from the load each batch. We scale this to 8B and study',
    'what it does to expert specialisation.',
    '',
  ].join('\n'),
);
put(`${LATEX}/sections/method.tex`, '\\section{Method}\n\\subsection{Loss-free balancing}\nBefore the top-$K$ decision we add a bias $b_i$ to each expert\'s score.\n');
put(`${LATEX}/rebuttal/main.tex`, '\\documentclass{article}\n\\title{Rebuttal}\n\\begin{document}\n\\maketitle\nWe thank the reviewers.\n\\end{document}\n');
put(`${LATEX}/refs.bib`, '@article{fedus2021switch,\n  title = {Switch Transformers},\n  eprint = {2101.03961}\n}\n');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: THEME });
await context.addInitScript(() => {
  window.google = { accounts: { oauth2: { initTokenClient: (config) => ({ requestAccessToken: () => setTimeout(() => config.callback({ access_token: 'test-token', expires_in: 3600, scope: 'openid email profile https://www.googleapis.com/auth/drive.file' }), 10) }), revoke: (_t, done) => done && done() } } };
});
await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|fonts\.|www\.googleapis\.com|accounts\.google\.com|api\.github\.com)/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
await context.route('**/accounts.google.com/gsi/client*', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '// stubbed' }));
await context.route('**/www.googleapis.com/oauth2/v3/userinfo*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: 'Saurav', email: 'reader@example.org' }) }));
await context.route('**/www.googleapis.com/**', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
  if (one) {
    const item = items.get(one[1]);
    if (!item) return json({ error: 'not found' }, 404);
    if (url.searchParams.get('alt') === 'media') return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: item.data ?? Buffer.alloc(0) });
    return json(meta(item));
  }
  if (/^\/upload\/drive\/v3\/files/.test(url.pathname)) return json(meta([...items.values()].find((item) => item.data) ?? items.get('root')));
  if (url.pathname === '/drive/v3/files' && request.method() === 'POST') {
    const body = JSON.parse(request.postData() || '{}');
    const item = { id: `d${nextId++}`, name: body.name, mimeType: body.mimeType ?? FOLDER, parents: body.parents ?? ['root'], trashed: false, modifiedTime: new Date().toISOString() };
    items.set(item.id, item);
    return json(meta(item));
  }
  if (url.pathname === '/drive/v3/files') {
    const q = url.searchParams.get('q') || '';
    const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\'/g, "'");
    const parent = /'((?:[^'\\]|\\.)*)' in parents/.exec(q)?.[1];
    const folderOnly = /mimeType = 'application\/vnd\.google-apps\.folder'/.test(q);
    const files = [...items.values()].filter((item) => item.id !== 'root' && !item.trashed && (!name || item.name === name) && (!parent || item.parents.includes(parent)) && (!folderOnly || item.mimeType === FOLDER));
    return json({ files: files.map(meta) });
  }
  return json({});
});

// ---- Reader's server: the Overleaf accounts connected once, and the compiler
let overleafAccounts = [];
await context.route('**/api/latex/**', async (route) => {
  const url = new URL(route.request().url());
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.pathname.endsWith('/latex/overleaf/token')) return json({ accounts: overleafAccounts });
  if (url.pathname.endsWith('/latex/overleaf/sync')) return json({ ok: true, commit: 'a'.repeat(40), committed: false, pushed: true, files: [], deleted: [], account: 'a1', accountLabel: 'saurav@iith.ac.in' });
  if (url.pathname.endsWith('/latex/jobs') && route.request().method() === 'POST') {
    const pdf = makePdf(['Loss-free routing at 8B', 'Saurav', '', '1  Introduction', 'Sparse mixture-of-experts models route each token to a few', 'experts, so a model can grow without its compute growing.', '', '2  Related work', 'Load balancing. Most MoE models keep experts busy with an', 'auxiliary loss on the router [Fedus et al., 2021].']);
    return json({ pdf: pdf.toString('base64'), log: '', exit: 0, seconds: 1.4 });
  }
  return json({});
});

// ---- GitHub: who the token is, its repositories, a repository made, a commit — answered alike to the page (a token
// still in the browser) and to Reader's server (worker/github.js, run here as deployed, its KV in memory)
const github = { repos: [{ full_name: 'saurav/moe-experiments', private: true, default_branch: 'main', permissions: { admin: true, push: true } }], commits: [], tokens: [] };
function fakeGithub(method, path, body, auth) {
  github.tokens.push(auth);
  if (path === '/user') return { status: 200, body: { login: 'saurav', name: 'Saurav' }, headers: { 'github-authentication-token-expiration': '2027-01-31 00:00:00 UTC' } };
  if (path === '/user/repos' && method === 'GET') return { status: 200, body: github.repos };
  if (path === '/user/repos' && method === 'POST') {
    const repo = { full_name: `saurav/${body.name}`, private: true, default_branch: 'main', permissions: { admin: true, push: true } };
    github.repos.unshift(repo);
    return { status: 201, body: repo };
  }
  if (/\/git\/ref\/heads\//.test(path)) return { status: 200, body: { object: { sha: `c${github.commits.length}` } } };
  if (/\/git\/commits\/c\d+$/.test(path)) return { status: 200, body: { tree: { sha: 't0' } } };
  if (path.endsWith('/git/blobs')) return { status: 200, body: { sha: `b${Math.random().toString(16).slice(2, 8)}` } };
  if (path.endsWith('/git/trees')) {
    github.commits.push(body.tree.map((item) => item.path));
    return { status: 200, body: { sha: `t${github.commits.length}` } };
  }
  if (path.endsWith('/git/commits')) return { status: 200, body: { sha: `9f3c2a1${github.commits.length}e8b7d6c5` } };
  if (/\/git\/refs\/heads\//.test(path)) return { status: 200, body: { object: { sha: 'x' } } };
  return { status: 404, body: { message: 'Not Found' } };
}
await context.route('**/api.github.com/**', async (route) => {
  const request = route.request();
  const answer = fakeGithub(request.method(), new URL(request.url()).pathname, request.postDataJSON?.() ?? null, request.headers().authorization);
  return route.fulfill({ status: answer.status, contentType: 'application/json', headers: answer.headers, body: JSON.stringify(answer.body) });
});
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  // GitHub's sign-in: a code (or a refresh token) for a GitHub App's token.
  if (String(url) === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'ghu_smokeapp000000000000000000', expires_in: 28800, refresh_token: 'ghr_smoke', refresh_token_expires_in: 15897600 });
  if (!String(url).startsWith('https://api.github.com/')) return realFetch(url, init);
  const answer = fakeGithub(init.method ?? 'GET', new URL(String(url)).pathname, init.body ? JSON.parse(init.body) : null, init.headers?.Authorization);
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json', ...(answer.headers ?? {}) } });
};
const workerKv = new Map();
const workerEnv = { SESSIONS: { get: async (key) => workerKv.get(key) ?? null, put: async (key, value) => void workerKv.set(key, value), delete: async (key) => void workerKv.delete(key) }, SECRETS_KEY: 'smoke-'.repeat(8) };
const workerTools = { origins: [new URL(BASE).origin], json: (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } }), headers: {}, authorized: async () => ({ email: 'reader@example.org' }) };
await context.route('**/api/github/**', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname.replace(/^\/api/, '');
  const body = request.method() === 'GET' ? undefined : request.postDataBuffer() ?? undefined;
  const answer = await handleGithub(new Request(`https://reader.test${path}${url.search}`, { method: request.method(), body, headers: { 'Content-Type': 'application/json', ...(request.headers().origin ? { Origin: request.headers().origin } : {}) } }), workerEnv, path, workerTools);
  return route.fulfill({ status: answer.status, contentType: answer.headers.get('Content-Type') || 'application/json', body: Buffer.from(await answer.arrayBuffer()) });
});
const TOKEN = 'github_pat_11SMOKE00000000000000_abcdefghijklmnopqrstuvwxyz0123';

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

const day = (ago) => new Date(Date.now() - ago * 24 * 3600 * 1000).toISOString();
const paper = (id, title, authors, extra) => ({ id, source: 'arxiv', title, authors, abstract: 'An abstract.', published: '2022-01-01', categories: [], addedAt: day(5), collectionIds: ['p-moe'], tags: [], progress: 0, ...extra });
const PAPERS = [
  paper('arxiv:2408.15664', 'Auxiliary-Loss-Free Load Balancing Strategy for Mixture-of-Experts', ['Lean Wang', 'Huazuo Gao'], { arxivId: '2408.15664', progress: 0.3, lastOpenedAt: day(0) }),
  paper('arxiv:2101.03961', 'Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity', ['William Fedus', 'Barret Zoph', 'Noam Shazeer'], { arxivId: '2101.03961', progress: 1, lastOpenedAt: day(3) }),
  paper('arxiv:2202.08906', 'ST-MoE: Designing Stable and Transferable Sparse Expert Models', ['Barret Zoph'], { arxivId: '2202.08906', progress: 0.5, lastOpenedAt: day(1) }),
];
const CODE_FILES = { 'train.py': 'import torch\n\n# Loss-free balancing: a bias per expert, used only to choose.\n', 'router.py': 'class Router:\n    pass\n', 'README.md': '# MoE experiments\n', 'configs/8b.yaml': 'experts: 64\ntop_k: 8\n' };

/** The app as someone signed in with Google left it: the projects, papers, code; `place` is where they last wrote. */
async function seed({ projects, settings = {}, local = {} }) {
  await page.goto(BASE, { waitUntil: "load" });
  await page.evaluate(
    async ({ projects, papers, settings, local, code, theme }) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem('reader.welcomed', 'true');
      localStorage.setItem('reader.settings', JSON.stringify({ googleClientId: 'test.apps.googleusercontent.com', driveFolderName: 'Papers_collection', proxyBase: '/api', theme, write: { compile: 'save' }, ...settings }));
      for (const [key, value] of Object.entries(local)) localStorage.setItem(key, value);
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('reader', 1);
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
      for (const project of projects) await run('collections', (s) => s.put(project));
      for (const one of papers) await run('papers', (s) => s.put(one));
      await run('kv', (s) => {
        s.put({ id: 'pg-moe', title: 'moe-experiments', kind: 'project', created: Date.now() - 86400000, updated: Date.now() - 3600000, compute: { kind: 'colab', machine: { accelerator: 'NONE' } }, home: { kind: 'browser' }, cites: [], console: [], idleStopMin: 0, start: 'blank', editor: 'reader' }, 'playground:pg-moe');
        s.put(code, 'playground-files:pg-moe');
      });
      db.close();
    },
    { projects, papers: PAPERS, settings, local, code: CODE_FILES, theme: THEME },
  );
}
async function signIn() {
  const button = page.getByRole('button', { name: /Sign in with Google/ }).first();
  if (await button.isVisible().catch(() => false)) {
    await button.click();
    await page.waitForTimeout(600);
  }
  // The sign-in's own Not now — never the paper card's or the editor's, which this test clicks itself.
  const notNow = page.locator('button:not(.ol-suggest *):not(.wr-nudge-actions *):not(.wr-sync-accounts *)').filter({ hasText: /^(Not now — keep everything in this browser|Start reading|Not now)$/ }).first();
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
}
const project = (overleaf, extra = {}) => ({ id: 'p-moe', name: 'Sparse-gated MoE', color: '#1f5e52', createdAt: day(20), project: { question: 'Can routing stay balanced without an aux loss at 8B?', startedAt: day(20), roles: {}, todos: [{ id: 't1', text: 'Replicate Table 2 at 1B', done: false }], playgroundId: 'pg-moe', ...(overleaf ? { overleaf } : {}), ...extra } });
const inDrive = { url: '', drive: { folder: 'Projects/Sparse-gated MoE-p-moe/LaTeX' } };
const onOverleaf = { url: 'https://www.overleaf.com/project/66f1c0a9e2b7d4a1b2c3d4e5', drive: { folder: 'Projects/Sparse-gated MoE-p-moe/LaTeX' }, gitAccount: 'a1' };

console.log('1. the board: Connections, GitHub and Overleaf once for every project');
await seed({ projects: [project(null)], settings: { githubToken: TOKEN } });
await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
await signIn();
await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
await page.locator('.cx-panel').waitFor({ timeout: 15000 }).catch(async (error) => {
  await shot('flow-failed');
  console.log(page.url(), (await page.locator('body').innerText()).slice(0, 800), errors);
  throw error;
});
await page.locator('.cx-chip.is-on').first().waitFor({ timeout: 10000 }).catch(() => {});
check('folded until asked for: both are optional', (await page.locator('.cx-grid').count()) === 0 && /Optional/.test(await page.locator('.cx-head').innerText()));
await shot('flow-0-connections-folded');
await page.locator('.cx-head').click();
check('GitHub is named by its account', /GitHub · saurav/.test(await page.locator('.cx-head').innerText()));
await page.waitForFunction(() => JSON.parse(localStorage.getItem('reader.settings') || '{}').githubToken === 'server', null, { timeout: 10000 }).catch(() => {});
const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
check('a GitHub token in the browser is moved to Reader’s server, and leaves the browser', !stored.includes(TOKEN) && /"githubToken":"server"/.test(stored.replace(/\\/g, '')));
check('the server keeps it sealed: no token, login or email in its KV', ![...workerKv.entries()].some(([key, value]) => `${key}${value}`.includes(TOKEN) || `${key}${value}`.includes('saurav') || `${key}${value}`.includes('reader@example.org')) && workerKv.size === 1);
check('it says what kind of token, and when it expires', /Fine-grained token, expires[\s\S]*Kept encrypted by Reader’s server/.test(await page.locator('.cx-panel').innerText()));
await page.getByLabel('Overleaf Git token').waitFor({ timeout: 5000 }).catch(() => {});
check('Overleaf, not connected yet, is open to connect', (await page.getByLabel('Overleaf Git token').count()) === 1);
await page.getByLabel('Which Overleaf account').fill('saurav@iith.ac.in');
await shot('flow-1-connections');

console.log('2. the overview: no paper yet — Start writing, Overleaf optional');
await seed({ projects: [project(null)] });
await page.goto(`${BASE}/project/?id=p-moe`, { waitUntil: 'networkidle' });
await signIn();
await page.locator('.ol-card').waitFor({ timeout: 15000 });
check('the card starts the paper here', (await page.locator('.ol-card').getByRole('button', { name: 'Start writing' }).count()) === 1);
check('Overleaf is the other way, not the only one', (await page.locator('.ol-card').getByRole('button', { name: /Bring it from Overleaf/ }).count()) === 1);
await page.locator('.ol-card').scrollIntoViewIfNeeded();
await shot('flow-2-overview-new');

console.log('3. Start writing: the Write tab, writing it here picked');
await page.locator('.ol-card').getByRole('button', { name: 'Start writing' }).click();
await page.locator('.wr-ways').waitFor({ timeout: 15000 });
check('writing it here is picked, and first', (await page.locator('.wr-way').first().getAttribute('aria-checked')) === 'true' && /Write it here/.test(await page.locator('.wr-way').first().innerText()));
await shot('flow-3-write-start');

console.log('4. the overview: written before — Continue writing, where it was left');
overleafAccounts = [{ id: 'a1', label: 'saurav@iith.ac.in', addedAt: day(2) }];
const place = JSON.stringify({ dir: '', file: 'sections/related.tex', line: 12, at: Date.now() - 2 * 3600_000 });
const left = { 'reader.write.p-moe.place': place, 'reader.write.p-moe.opened': '', 'reader.write.p-moe.line:|sections/related.tex': '12', 'reader.write.p-moe.file': 'sections/related.tex' };
await seed({ projects: [project(onOverleaf)], local: left });
await page.goto(`${BASE}/project/?id=p-moe`, { waitUntil: 'networkidle' });
await signIn();
await page.locator('.ol-card').waitFor({ timeout: 15000 });
const card = await page.locator('.ol-card').innerText();
check('it says where you left off', /You left off[\s\S]*sections\/related\.tex[\s\S]*line 12/i.test(card), card.replace(/\s+/g, ' ').slice(0, 160));
check('synced with Overleaf, which opens from here', /Synced with Overleaf/.test(card) && (await page.locator('.ol-card').getByRole('button', { name: /Overleaf/ }).count()) >= 1);
await page.locator('.ol-card').scrollIntoViewIfNeeded();
await shot('flow-4-overview-continue');

console.log('5. Continue writing: straight to the file and line');
await page.locator('.ol-card').getByRole('button', { name: /Continue writing/ }).click();
await page.locator('.wr-editor textarea').waitFor({ timeout: 20000 });
await page.waitForTimeout(400);
check('the LaTeX project opens, not the list of them', (await page.locator('.wr-home').count()) === 0);
check('on the file last written', /sections\/related\.tex/.test(await page.locator('.wr-file').innerText()));
const caretLine = await page.locator('.wr-editor textarea').evaluate((area) => area.value.slice(0, area.selectionStart).split('\n').length);
check('at the line it was left at', caretLine === 12, `line ${caretLine}`);
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(1500);
await shot('flow-5-write-resumed');
check('compiled: nothing over the PDF', (await page.locator('.wr-ghc, .wr-ghs').count()) === 0);
await page.getByRole('button', { name: 'Compile details' }).click();
check('ⓘ opens what the compile did', /Compiled on Cloud Run[\s\S]*deleted once compiled/.test(await page.locator('.wr-ghc').innerText()));
await shot('flow-5b-compile-details');
await page.getByRole('button', { name: 'Close the compile details' }).click();
check('× closes it', (await page.locator('.wr-ghc').count()) === 0);

console.log('6. in the editor, not on Overleaf: Connect to Overleaf, the account known');
await seed({ projects: [project(inDrive)], local: left });
await page.goto(`${BASE}/project/?id=p-moe&view=write`, { waitUntil: 'networkidle' });
await signIn();
await page.locator('.wr-editor textarea').waitFor({ timeout: 20000 });
await page.getByRole('button', { name: /Connect to Overleaf/ }).click();
await page.locator('.wr-ol-connect').waitFor({ timeout: 5000 });
await page.waitForTimeout(500);
check('no token asked: the account connected once is used', (await page.getByLabel('Overleaf Git token').count()) === 0 && /saurav@iith\.ac\.in/.test(await page.locator('.wr-ol-connect').innerText()));
await shot('flow-6-connect-overleaf');

console.log('7. the workspace: Sync to GitHub, set up from its menu');
await seed({ projects: [project(inDrive)], settings: { githubToken: TOKEN } });
await page.goto(`${BASE}/project/?id=p-moe&view=workspace`, { waitUntil: 'networkidle' });
await signIn();
await page.locator('.cx-gh-btn').waitFor({ timeout: 15000 });
await page.locator('.cx-gh-btn').click();
await page.locator('.cx-pop select option', { hasText: 'moe-experiments' }).waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
check('with no repository: make one, or pick one of yours', /Make a private repository/i.test(await page.locator('.cx-pop').innerText()) && (await page.locator('.cx-pop select option').count()) >= 2);
await shot('flow-7-github-setup');
await page.locator('.cx-pop').getByRole('button', { name: 'Create' }).click();
await page.locator('.cx-pop').getByRole('button', { name: 'Push to GitHub' }).waitFor({ timeout: 5000 }).catch(async (error) => {
  console.log(await page.locator('.cx-pop').innerText(), errors, github.repos.length);
  throw error;
});
await page.locator('.cx-pop').getByLabel('Commit message').fill('Bias-based balancing: first run at 1B');
await page.locator('.cx-pop').getByRole('button', { name: 'Push to GitHub' }).click();
await page.locator('.cx-pop').getByText(/Last pushed/).waitFor({ timeout: 10000 }).catch(() => {});
check('the code went through Reader’s server, which put the token on it', github.tokens.at(-1) === `Bearer ${TOKEN}`);
check('the code went as one commit', github.commits.length === 1 && github.commits[0].includes('train.py') && github.commits[0].includes('configs/8b.yaml'), JSON.stringify(github.commits));
check('the button names the repository and the push', /sparse-gated-moe-code/.test(await page.locator('.cx-gh-btn').innerText()));
await shot('flow-8-github-pushed');

console.log('9. two LaTeX projects, each its own Overleaf project: the card and Sync with Overleaf go by the one written in');
const twoProjects = { ...onOverleaf, latex: { rebuttal: { url: '' } } };
const inRebuttal = { 'reader.write.p-moe.place': JSON.stringify({ dir: 'rebuttal', file: 'rebuttal/main.tex', line: 5, at: Date.now() - 600_000 }), 'reader.write.p-moe.opened': 'rebuttal' };
await seed({ projects: [project(twoProjects)], local: inRebuttal });
await page.goto(`${BASE}/project/?id=p-moe`, { waitUntil: 'networkidle' });
await signIn();
await page.locator('.ol-card').waitFor({ timeout: 15000 });
const two = await page.locator('.ol-card').innerText();
check('the card speaks for the LaTeX project written in: rebuttal, not on Overleaf', /rebuttal · Not on Overleaf/i.test(two), two.replace(/\s+/g, ' ').slice(0, 120));
check('and lists each LaTeX project’s own Overleaf project', (await page.locator('.ol-latex li').count()) === 2 && /top of the folder[\s\S]*Overleaf …[\s\S]*rebuttal\/[\s\S]*not on Overleaf/i.test(await page.locator('.ol-latex').innerText()));
await page.locator('.ol-card').scrollIntoViewIfNeeded();
await shot('flow-9-overview-two-latex');
await page.locator('.ol-card').getByRole('button', { name: /Sync with Overleaf/ }).click();
await page.locator('.wr-ol-connect').waitFor({ timeout: 20000 });
check('Sync with Overleaf opens that LaTeX project, linking it alone', /Linking rebuttal\//.test(await page.locator('.wr-ol-connect').innerText()) && /We thank the reviewers/.test(await page.locator('.wr-editor textarea').inputValue()));
await shot('flow-10-connect-one-latex');

console.log('10. with accounts: the card suggests Overleaf, nothing more to enter');
await seed({ projects: [project(inDrive)], local: left });
await page.goto(`${BASE}/project/?id=p-moe`, { waitUntil: 'networkidle' });
await signIn();
await page.locator('.ol-suggest').waitFor({ timeout: 15000 }).catch(async (error) => { await shot('flow-failed'); console.log(await page.locator('.ol-card').innerText().catch(() => 'no card'), errors); console.log(await page.evaluate(() => JSON.stringify(Object.keys(localStorage).filter((k) => k.includes('notNow') || k.includes('place'))))); throw error; });
check('a suggestion, naming the account it will use', /as saurav@iith\.ac\.in[\s\S]*nothing more to enter/.test(await page.locator('.ol-suggest').innerText()));
await page.locator('.ol-suggest').getByRole('button', { name: 'Not now' }).click();
check('Not now puts it away, the button stays', (await page.locator('.ol-suggest').count()) === 0 && (await page.locator('.ol-card').getByRole('button', { name: /Sync with Overleaf/ }).count()) === 1);

console.log('11. no Overleaf account anywhere: asked for only when connecting, in two steps');
overleafAccounts = [];
await seed({ projects: [project(inDrive)], local: left });
await page.goto(`${BASE}/project/?id=p-moe`, { waitUntil: 'networkidle' });
await signIn();
await page.locator('.ol-suggest').waitFor({ timeout: 15000 }).catch(async (error) => { await shot('flow-failed'); console.log(await page.locator('.ol-card').innerText().catch(() => 'no card'), errors); throw error; });
check('the card offers Overleaf, asking nothing', /Optionally connect your Overleaf account/.test(await page.locator('.ol-suggest').innerText()) && (await page.getByLabel('Overleaf Git token').count()) === 0);
await page.locator('.ol-card').scrollIntoViewIfNeeded();
await shot('flow-11-overview-suggest');
await page.locator('.ol-suggest').getByRole('button', { name: /Connect Overleaf/ }).click();
await page.locator('.wr-ol-connect .wr-steps').waitFor({ timeout: 20000 });
await page.locator('.wr-ol-connect').getByLabel('Overleaf Git token').waitFor({ timeout: 10000 }).catch(() => {});
check('step 1 the account, step 2 the Overleaf project after it', (await page.locator('.wr-ol-connect').getByLabel('Overleaf Git token').count()) === 1 && /Next, once the account is connected/.test(await page.locator('.wr-step.is-later').innerText()));
await shot('flow-12-connect-two-steps');

console.log('12. linked to Overleaf, no account: a nudge in the editor, the form only when asked');
await seed({ projects: [project(onOverleaf)], local: left });
await page.goto(`${BASE}/project/?id=p-moe&view=write`, { waitUntil: 'networkidle' });
await signIn();
await page.locator('.wr-nudge-actions').waitFor({ timeout: 20000 });
check('a line and two buttons, no form', (await page.getByLabel('Overleaf Git token').count()) === 0 && /isn’t syncing/.test(await page.locator('.wr-sync-banner').last().innerText()));
await shot('flow-13-editor-nudge');
await page.locator('.wr-nudge-actions').getByRole('button', { name: 'Not now' }).click();
await seed({ projects: [project(onOverleaf)], local: { ...left, 'reader.write.p-moe.notNow:desk': '1' } });
await page.goto(`${BASE}/project/?id=p-moe&view=write`, { waitUntil: 'networkidle' });
await signIn();
await page.locator('.wr-editor textarea').waitFor({ timeout: 20000 });
await page.waitForTimeout(1500);
check('Not now is remembered: no nudge the next time', (await page.locator('.wr-nudge-actions').count()) === 0);

console.log('13. GitHub: the App or Sign in with GitHub, explained, the App recommended; signed in through the App');
Object.assign(workerEnv, { GITHUB_APP_CLIENT_ID: 'Iv1.smoke', GITHUB_APP_CLIENT_SECRET: 'app-secret', GITHUB_APP_SLUG: 'reader-papers', GITHUB_OAUTH_CLIENT_ID: 'Ov23.smoke', GITHUB_OAUTH_CLIENT_SECRET: 'oauth-secret' });
workerKv.clear();
// GitHub's sign-in page, standing in: it sends the person straight back to Reader's server with a code.
await context.route(/^https:\/\/github\.com\/login\/oauth\/authorize/, (route) => {
  const asked = new URL(route.request().url());
  // As a page that moves on (a redirect answered here isn't routed again): the callback, as GitHub would send it.
  const back = `${BASE}/api/github/callback?code=smoke&state=${asked.searchParams.get('state')}`;
  return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><script>location.replace(${JSON.stringify(back)})</script>` });
});
await seed({ projects: [project(inDrive)] });
await page.goto(`${BASE}/projects`, { waitUntil: 'networkidle' });
await signIn();
await page.goto(`${BASE}/projects`, { waitUntil: 'networkidle' });
await page.locator('.cx-head').click();
await page.locator('.cx-way').first().waitFor({ timeout: 10000 });
const ways = await page.locator('.cx-way').allInnerTexts();
check('both sign-ins offered, the GitHub App first and recommended', ways.length === 2 && /GitHub App[\s\S]*recommended/i.test(ways[0]) && /Sign in with GitHub[\s\S]*quickest/i.test(ways[1]), ways.join(' | ').replace(/\s+/g, ' '));
await page.locator('.cx-which > summary').click();
check('what each does, and the recommendation, explained', /Only the repositories you tick/.test(await page.locator('.cx-which').innerText()) && /Recommended: the GitHub App/.test(await page.locator('.cx-which').innerText()));
await page.locator('.cx-which').scrollIntoViewIfNeeded();
await shot('flow-14-github-choose');
const popupOpened = context.waitForEvent('page', { timeout: 10000 });
await page.locator('.cx-way.is-recommended').click();
const popup = await popupOpened;
popup.on('console', (message) => console.log('   popup:', message.text()));
await popup.waitForEvent('close', { timeout: 15000 }).catch(async () => console.log('   popup still open at', popup.url(), (await popup.locator('body').innerText().catch(() => '')).slice(0, 300)));
await page.locator('.cx-via').waitFor({ timeout: 15000 }).catch(async () => console.log('   panel:', (await page.locator('.cx-panel').innerText()).replace(/\s+/g, ' ').slice(0, 400)));
check('signed in through the App: the window closed itself, Reader says so', /GitHub App/.test(await page.locator('.cx-via').innerText().catch(() => '')) && popup.isClosed());
check('its token, refresh token and login kept sealed', workerKv.size === 1 && ![...workerKv.values()].some((value) => /ghu_|ghr_|saurav/.test(value)));
check('choosing its repositories is a click away', (await page.getByRole('link', { name: /Choose repositories/ }).getAttribute('href')) === 'https://github.com/apps/reader-papers/installations/new');
await page.locator('.cx-panel').scrollIntoViewIfNeeded();
await shot('flow-15-github-app-connected');

check('no errors on the page', !errors.length, errors.join(' | '));
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log('\nall good');
