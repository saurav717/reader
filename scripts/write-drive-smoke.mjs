/**
 * The Write tab with the paper kept in Google Drive, end to end: nothing on
 * this computer (no Companion at all), the paper brought in from Overleaf by
 * Reader's server, its documents listed, opened, compiled on Cloud Run, edited
 * and saved to Drive, compiled again with only the edit sent, the edit pushed
 * to Overleaf, a coauthor's edit taken in.
 *
 * What stands in: Google (sign-in, and a Drive in memory, folders and all),
 * Overleaf's Git (a bare repository), and the network between them. What is
 * real: the page, the Worker's LaTeX routes (worker/latex.js, its KV in
 * memory), and the compiler (cloudrun/latex/server.py, with real latexmk and
 * git). Needs python3, git and latexmk.
 *
 *   npm run build && npm start &
 *   node scripts/write-drive-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleLatex } from '../worker/latex.js';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const SERVER_DIR = new URL('../cloudrun/latex/', import.meta.url).pathname;
const PROJECT_ID = '66f1c0a9e2b7d4a1b2c3d4e5';
const PORT = 18000 + Math.floor(Math.random() * 1000);

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(label);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

// ---- Overleaf's Git: a bare repository, and a coauthor's clone of it
const tmp = mkdtempSync(join(tmpdir(), 'write-drive-'));
const env = { ...process.env, GIT_CONFIG_GLOBAL: join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
writeFileSync(join(tmp, 'gitconfig'), '[user]\n\tname = Priya\n\temail = p@x\n[init]\n\tdefaultBranch = master\n');
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, env, encoding: 'utf8' });
const remote = join(tmp, 'overleaf.git');
sh('git', ['init', '-q', '--bare', remote]);
const coauthor = join(tmp, 'coauthor');
sh('git', ['clone', '-q', remote, coauthor]);
mkdirSync(join(coauthor, 'sections'));
writeFileSync(join(coauthor, 'main.tex'), '\\documentclass{article}\n\\title{Loss-free routing at 8B}\n\\begin{document}\n\\maketitle\n\\input{sections/intro}\n\\end{document}\n');
writeFileSync(join(coauthor, 'sections', 'intro.tex'), '\\section{Introduction}\nSparse mixture-of-experts models route each token to a few experts.\n');
sh('git', ['add', '-A'], coauthor);
sh('git', ['commit', '-q', '-m', 'Start the paper'], coauthor);
sh('git', ['push', '-q', 'origin', 'HEAD'], coauthor);
const remoteFile = (path) => {
  try {
    return sh('git', ['--git-dir', remote, 'show', `HEAD:${path}`]);
  } catch {
    return null;
  }
};

// ---- the compiler, as on Cloud Run, but Overleaf's address is the bare repository
writeFileSync(
  join(tmp, 'serve.py'),
  `import re, sys\nsys.path.insert(0, ${JSON.stringify(SERVER_DIR)})\nimport server\nserver.GIT_REMOTE = re.compile(r'.*')\nserver.GIT_FILE_PROTOCOL = 'always'\nreal = server.git_sync\ndef sync(job):\n    job['url'] = ${JSON.stringify(remote)}\n    return real(job)\nserver.git_sync = sync\nfrom http.server import ThreadingHTTPServer\nThreadingHTTPServer(('127.0.0.1', ${PORT}), server.Handler).serve_forever()\n`,
);
const compiler = spawn('python3', [join(tmp, 'serve.py')], { env: { ...env, LATEX_TOKEN: 'k' }, stdio: ['ignore', 'ignore', 'inherit'] });
await new Promise((resolve) => setTimeout(resolve, 800));
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => (String(url).startsWith('https://cloudrun.test') ? realFetch(String(url).replace('https://cloudrun.test', `http://127.0.0.1:${PORT}`), init) : realFetch(url, init));

// ---- the Worker's LaTeX routes, as deployed: its KV in memory
const kept = new Map();
const kv = { get: async (key, type) => (kept.has(key) ? (type === 'json' ? JSON.parse(kept.get(key)) : kept.get(key)) : null), put: async (key, value) => void kept.set(key, value), delete: async (key) => void kept.delete(key) };
const workerEnv = { SESSIONS: kv, LATEX_CLOUD_RUN_URL: 'https://cloudrun.test', LATEX_CLOUD_RUN_TOKEN: 'k', LATEX_ALLOW_HTTP: '1' };
const workerJson = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const tools = { json: workerJson, headers: {}, authorized: async () => ({ email: 'reader@example.org' }), personOverLimit: async () => false, tally: () => {} };
const syncs = [];

// ---- Google Drive, in memory: folders, files, trash
const items = new Map([['root', { id: 'root', name: 'My Drive', mimeType: 'application/vnd.google-apps.folder', parents: [], trashed: false }]]);
let nextId = 1;
const FOLDER = 'application/vnd.google-apps.folder';
const meta = (item) => ({ id: item.id, name: item.name, mimeType: item.mimeType, size: item.data ? String(item.data.length) : undefined, modifiedTime: item.modifiedTime, webViewLink: `https://drive.google.com/file/d/${item.id}/view` });
const pathOf = (item) => {
  const parts = [];
  for (let at = item; at && at.id !== 'root'; at = items.get(at.parents[0])) parts.unshift(at.name);
  return parts.join('/');
};
const driveFile = (path) => [...items.values()].find((item) => !item.trashed && item.mimeType !== FOLDER && pathOf(item) === path);
function multipart(request) {
  const boundary = /boundary=([^;]+)/.exec(request.headers()['content-type'] || '')?.[1];
  const body = request.postDataBuffer() ?? Buffer.alloc(0);
  const parts = [];
  if (!boundary) return parts;
  const mark = Buffer.from(`--${boundary}`);
  let at = body.indexOf(mark);
  while (at >= 0) {
    const next = body.indexOf(mark, at + mark.length);
    if (next < 0) break;
    const part = body.subarray(at + mark.length + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    parts.push(part.subarray(split + 4));
    at = next;
  }
  return parts;
}
const unquote = (text) => text.replace(/\\'/g, "'").replace(/\\\\/g, '\\');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  window.google = { accounts: { oauth2: { initTokenClient: (config) => ({ requestAccessToken: () => setTimeout(() => config.callback({ access_token: 'test-token', expires_in: 3600, scope: 'openid email profile https://www.googleapis.com/auth/drive.file' }), 10) }), revoke: (_t, done) => done && done() } } };
});
await context.route('**/accounts.google.com/gsi/client*', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '// stubbed' }));
await context.route('**/www.googleapis.com/oauth2/v3/userinfo*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: 'Saurav', email: 'reader@example.org' }) }));
await context.route('**/www.googleapis.com/**', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const now = new Date(Date.now() + nextId).toISOString();
  const upload = /^\/upload\/drive\/v3\/files\/?([^/?]*)$/.exec(url.pathname);
  if (upload) {
    const [metadataPart, filePart] = multipart(request);
    const metadata = JSON.parse(metadataPart?.toString() || '{}');
    let item = upload[1] ? items.get(upload[1]) : null;
    if (!item) {
      item = { id: `f${nextId++}`, name: metadata.name, mimeType: metadata.mimeType, parents: metadata.parents ?? ['root'], trashed: false };
      items.set(item.id, item);
    }
    Object.assign(item, { name: metadata.name ?? item.name, data: Buffer.from(filePart ?? []), trashed: false, modifiedTime: now });
    return json(meta(item));
  }
  const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
  if (one) {
    const item = items.get(one[1]);
    if (!item) return json({ error: 'not found' }, 404);
    if (url.searchParams.get('alt') === 'media') return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: item.data ?? Buffer.alloc(0) });
    if (request.method() === 'PATCH') {
      const body = request.postData() ? JSON.parse(request.postData()) : {};
      if (body.trashed !== undefined) item.trashed = body.trashed;
      if (body.name) item.name = body.name;
      const add = url.searchParams.get('addParents');
      if (add) item.parents = [add];
      item.modifiedTime = now;
    }
    return json(meta(item));
  }
  if (url.pathname === '/drive/v3/files' && request.method() === 'POST') {
    const body = JSON.parse(request.postData() || '{}');
    const item = { id: `d${nextId++}`, name: body.name, mimeType: body.mimeType ?? FOLDER, parents: body.parents ?? ['root'], trashed: false, modifiedTime: now };
    items.set(item.id, item);
    return json(meta(item));
  }
  if (url.pathname === '/drive/v3/files') {
    const q = url.searchParams.get('q') || '';
    const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1];
    const parent = /'((?:[^'\\]|\\.)*)' in parents/.exec(q)?.[1];
    const folderOnly = /mimeType = 'application\/vnd\.google-apps\.folder'/.test(q);
    const files = [...items.values()].filter((item) => item.id !== 'root' && !item.trashed && (!name || item.name === unquote(name)) && (!parent || item.parents.includes(unquote(parent))) && (!folderOnly || item.mimeType === FOLDER));
    return json({ files: files.map(meta) });
  }
  return json({});
});
await context.route(/^https?:\/\/127\.0\.0\.1:473[23]1\//, (route) => route.abort());
await context.route('**/api/latex/**', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname.replace(/^\/api/, '');
  const body = request.method() === 'GET' || request.method() === 'HEAD' ? undefined : request.postDataBuffer() ?? undefined;
  if (path === '/latex/overleaf/sync') syncs.push(JSON.parse(body.toString()));
  const answer = await handleLatex(new Request(`https://reader.test${path}`, { method: request.method(), body, headers: { 'Content-Type': 'application/json' } }), workerEnv, path, tools);
  return route.fulfill({ status: answer.status, contentType: answer.headers.get('Content-Type') || 'application/json', body: Buffer.from(await answer.arrayBuffer()) });
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

console.log('signed in with Google, no Companion: the paper is offered a home in Drive');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(
  async ({ projectId }) => {
    localStorage.setItem('reader.welcomed', 'true');
    localStorage.setItem('reader.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('reader.settings') || '{}'), googleClientId: 'test.apps.googleusercontent.com', driveFolderName: 'Papers_collection', proxyBase: '/api', navStyle: 'labelled' }));
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
    await new Promise((resolve, reject) => {
      const tx = db.transaction('collections', 'readwrite');
      tx.objectStore('collections').put({ id: 'p-moe', name: 'Sparse-gated MoE', color: '#1f5e52', createdAt: new Date().toISOString(), project: { question: '', startedAt: new Date().toISOString(), roles: {}, todos: [], overleaf: { url: `https://www.overleaf.com/project/${projectId}` } } });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  },
  { projectId: PROJECT_ID },
);
await page.goto(`${BASE}/project/?id=p-moe&view=write`, { waitUntil: 'networkidle' });
const signIn = page.getByRole('button', { name: /Sign in with Google/ }).first();
if (await signIn.isVisible().catch(() => false)) {
  await signIn.click();
  await page.waitForTimeout(500);
  const notNow = page.getByRole('button', { name: /Start reading|Not now/ }).first();
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
}
if (!page.url().includes('view=write')) await page.goto(`${BASE}/project/?id=p-moe&view=write`, { waitUntil: 'networkidle' });
await page.getByText('Keep the paper in Google Drive').waitFor({ timeout: 20000 });
await page.getByLabel('Overleaf Git token for Reader’s server').fill('olp_test_token');
await shot('write-drive-setup');
await page.getByRole('button', { name: 'Bring it into Drive from Overleaf' }).click();

console.log('brought in from Overleaf by Reader’s server, into Drive');
await page.locator('.wr-doc').first().waitFor({ timeout: 30000 });
const folder = 'Papers_collection/Papers/Sparse-gated MoE-p-moe';
check('the paper is in Drive, under Papers_collection/Papers', Boolean(driveFile(`${folder}/main.tex`)) && Boolean(driveFile(`${folder}/sections/intro.tex`)), [...items.values()].filter((item) => item.data).map(pathOf).join(', '));
check('with where it last synced', /"commit":"[0-9a-f]{40}"/.test(driveFile(`${folder}/.reader-sync.json`)?.data?.toString() ?? ''));
check('the token went to the Worker once, and is kept sealed, not in the clear', syncs[0]?.token === 'olp_test_token' && [...kept.values()].some((value) => /"iv"/.test(value)) && ![...kept.values()].some((value) => value.includes('olp_test_token')));
check('its document is listed by its title', /Loss-free routing at 8B/.test(await page.locator('.wr-docs').innerText()));
check('the page says where it is: Drive, in step with Overleaf', /Google Drive › Papers/.test(await page.locator('.wr-home-head').innerText()) && /through Reader’s server/.test(await page.locator('.wr-home-head').innerText()));
await shot('write-drive-home');

console.log('opened: compiled on Cloud Run, nothing here to compile with');
await page.locator('.wr-doc').first().click();
await page.locator('.wr-desk').waitFor({ timeout: 15000 });
check('no "This computer" to compile on', (await page.getByRole('button', { name: 'This computer' }).count()) === 0);
check('Cloud Run is the compiler', (await page.getByRole('button', { name: 'Cloud Run' }).getAttribute('aria-pressed')) === 'true');
await page.locator('.wr-page').first().waitFor({ timeout: 60000 });
check('the PDF comes from Cloud Run', /Compiled on Cloud Run/.test(await page.locator('.wr-ghc').innerText()), await page.locator('.wr-ghc').innerText());
await shot('write-drive-desk');

console.log('an edit: saved to Drive, compiled with only it sent, pushed to Overleaf');
await page.locator('.wr-tree-item', { hasText: 'intro.tex' }).click();
await page.locator('.wr-editor textarea').click();
await page.keyboard.press('Control+End');
await page.keyboard.type(' Typed in the browser, kept in Drive.');
await page.waitForFunction(() => /1 changed file sent/.test(document.querySelector('.wr-ghc')?.textContent ?? ''), null, { timeout: 30000 }).catch(() => {});
check('saved to Drive', /Typed in the browser, kept in Drive/.test(driveFile(`${folder}/sections/intro.tex`)?.data?.toString() ?? ''));
check('compiled again with only the edit sent', /1 changed file sent/.test(await page.locator('.wr-ghc').innerText()), await page.locator('.wr-ghc').innerText());
for (let i = 0; i < 30 && !/Typed in the browser/.test(remoteFile('sections/intro.tex') ?? ''); i += 1) await page.waitForTimeout(500);
check('and pushed to Overleaf by Reader’s server', /Typed in the browser, kept in Drive/.test(remoteFile('sections/intro.tex') ?? ''));
await shot('write-drive-edit');

console.log('a coauthor’s edit in Overleaf comes into Drive');
sh('git', ['pull', '-q'], coauthor);
writeFileSync(join(coauthor, 'main.tex'), '\\documentclass{article}\n\\title{Loss-free routing at 8B, revised}\n\\begin{document}\n\\maketitle\n\\input{sections/intro}\n\\end{document}\n');
sh('git', ['commit', '-q', '-am', 'A coauthor'], coauthor);
sh('git', ['push', '-q'], coauthor);
await page.locator('.wr-status').getByRole('button', { name: /^Sync$/ }).click().catch(async () => page.getByRole('button', { name: /^Sync$/ }).first().click());
for (let i = 0; i < 30 && !/revised/.test(driveFile(`${folder}/main.tex`)?.data?.toString() ?? ''); i += 1) await page.waitForTimeout(500);
check('it is in Drive', /revised/.test(driveFile(`${folder}/main.tex`)?.data?.toString() ?? ''));

check('no errors on the page', !errors.length, errors.join(' | '));
await browser.close();
compiler.kill();
if (problems.length) {
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log('\nall good');
