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
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

// ---- two papers from before, kept in folders on this computer: one a clone of its Overleaf project with an
// edit not yet synced, one a folder never synced with its (nearly empty) Overleaf project
const CLONE_ID = '77a1c0a9e2b7d4a1b2c3d4e6';
const FOLDER_ID = '88b1c0a9e2b7d4a1b2c3d4e7';
const LOST_ID = '99c1c0a9e2b7d4a1b2c3d4e8';
// A Blank Project made in Overleaf for a paper started in Drive without it.
const FRESH_ID = '55e1c0a9e2b7d4a1b2c3d4e9';
const root = join(tmp, 'Reader');
const bareFor = { [CLONE_ID]: join(tmp, 'clone.git'), [FOLDER_ID]: join(tmp, 'folder.git'), [LOST_ID]: join(tmp, 'lost.git'), [FRESH_ID]: join(tmp, 'fresh.git') };
for (const [id, bare] of Object.entries(bareFor)) {
  sh('git', ['init', '-q', '--bare', bare]);
  const seed = join(tmp, `seed-${id}`);
  sh('git', ['clone', '-q', bare, seed]);
  writeFileSync(join(seed, id === FOLDER_ID ? 'README.md' : 'main.tex'), id !== FOLDER_ID ? '\\documentclass{article}\n\\title{Old clone}\n\\begin{document}\nAs in Overleaf.\n\\end{document}\n' : 'Overleaf’s own readme\n');
  sh('git', ['add', '-A'], seed);
  sh('git', ['commit', '-q', '-m', 'start'], seed);
  sh('git', ['push', '-q', 'origin', 'HEAD'], seed);
}
mkdirSync(join(root, 'papers'), { recursive: true });
sh('git', ['clone', '-q', bareFor[CLONE_ID], join(root, 'papers', 'old-clone')]);
writeFileSync(join(root, 'papers', 'old-clone', 'main.tex'), '\\documentclass{article}\n\\title{Old clone}\n\\begin{document}\nAs in Overleaf. Typed only on this computer.\n\\end{document}\n');
// A project that lost its link to its clone here (as with a project opened elsewhere): papers/lost-link, by its name.
sh('git', ['clone', '-q', bareFor[LOST_ID], join(root, 'papers', 'lost-link')]);
writeFileSync(join(root, 'papers', 'lost-link', 'extra.tex'), 'Lost-link work, only here.\n');
mkdirSync(join(root, 'papers', 'old-folder', 'figures'), { recursive: true });
writeFileSync(join(root, 'papers', 'old-folder', 'main.tex'), '\\documentclass{article}\n\\title{Old folder}\n\\begin{document}\nWritten on this computer, never synced.\n\\end{document}\n');
writeFileSync(join(root, 'papers', 'old-folder', 'figures', 'plot.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
const bareFile = (bare, path) => {
  try {
    return sh('git', ['--git-dir', bare, 'show', `HEAD:${path}`]);
  } catch {
    return null;
  }
};

// ---- the compiler, as on Cloud Run, but Overleaf's address is the bare repository
writeFileSync(
  join(tmp, 'serve.py'),
  `import re, sys, json\nsys.path.insert(0, ${JSON.stringify(SERVER_DIR)})\nimport server\nserver.GIT_REMOTE = re.compile(r'.*')\nserver.GIT_FILE_PROTOCOL = 'always'\nreal = server.git_sync\nbares = ${JSON.stringify(bareFor)}\ndef sync(job):\n    try:\n        access = json.load(open(${JSON.stringify(join(tmp, 'access.json'))}))\n    except Exception:\n        access = {}\n    for key, tokens in access.items():\n        if key in job['url'] and job.get('token') not in tokens:\n            raise server.GitRefused('Overleaf refused the Git token', 401, need_token=True)\n    job['url'] = next((bare for key, bare in bares.items() if key in job['url']), ${JSON.stringify(remote)})\n    return real(job)\nserver.git_sync = sync\nreal_files = server.git_files\ndef files(job):\n    job['url'] = next((bare for key, bare in bares.items() if key in job['url']), ${JSON.stringify(remote)})\n    return real_files(job)\nserver.git_files = files\nreal_check = server.git_check\ndef check(job):\n    job['url'] = next((bare for key, bare in bares.items() if key in job['url']), ${JSON.stringify(remote)})\n    return real_check(job)\nserver.git_check = check\nfrom http.server import ThreadingHTTPServer\nThreadingHTTPServer(('127.0.0.1', ${PORT}), server.Handler).serve_forever()\n`,
);
// Which Overleaf accounts' tokens open which project (by id); a project not named opens with any.
const allow = (access) => writeFileSync(join(tmp, 'access.json'), JSON.stringify(access));
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
// This computer's Companion: none at first; then one with the old papers' folders (its Jupyter contents API and
// its paper calls: what a folder is a clone of, and Git's sync — real git, in those folders).
let companionOn = false;
await context.route(/^https?:\/\/127\.0\.0\.1:473[23]1\//, async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (!companionOn || url.port === '47331') return route.abort();
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' };
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
  if (url.pathname === '/companion/info') return reply({ app: 'reader-companion', version: '0.12.0', id: 'mac-1', name: 'MacBook Air', hardware: '', root });
  if (request.headers().authorization !== 'token pc-token') return reply({ error: 'Pair first' }, 403);
  if (url.pathname === '/companion/paper' && request.method() === 'GET') return reply({ latexmk: false, tectonic: false, git: true });
  if (url.pathname === '/companion/paper' && request.method() === 'POST') {
    const body = request.postDataJSON();
    const folderPath = join(root, body.folder ?? '');
    if (body.action === 'token') return reply({ known: true });
    if (body.action === 'clone') {
      const id = (body.url.match(/[0-9a-f]{24}/) ?? [''])[0];
      sh('git', ['clone', '-q', bareFor[id] ?? body.url, folderPath]);
      return reply({ folder: body.folder });
    }
    if (body.action === 'remote') {
      try {
        // As the real Companion: a clone's origin is its Overleaf Git address.
        const origin = sh('git', ['remote', 'get-url', 'origin'], folderPath).trim();
        const id = Object.keys(bareFor).find((key) => bareFor[key] === origin);
        return reply({ url: id ? `https://git.overleaf.com/${id}` : origin, token: true });
      } catch {
        return reply({ url: '', token: false });
      }
    }
    if (body.action === 'sync') {
      sh('git', ['add', '-A'], folderPath);
      const dirty = sh('git', ['status', '--porcelain'], folderPath).trim();
      if (dirty) sh('git', ['commit', '-q', '-m', body.message || 'Edits from Reader'], folderPath);
      sh('git', ['pull', '-q', '--no-rebase', '--no-edit'], folderPath);
      sh('git', ['push', '-q'], folderPath);
      return reply({ ok: true, committed: Boolean(dirty), pushed: true, conflicts: [], incoming: [], at: Date.now() });
    }
    return reply({ error: 'not here' }, 400);
  }
  if (url.pathname.startsWith('/api/contents')) {
    const path = decodeURIComponent(url.pathname.replace(/^\/api\/contents\/?/, ''));
    const full = join(root, path);
    if (request.method() === 'DELETE') {
      rmSync(full, { recursive: true, force: true });
      return route.fulfill({ status: 204, headers: cors });
    }
    if (!existsSync(full)) return reply({ message: 'No such file' }, 404);
    if (statSync(full).isDirectory()) return reply({ name: path.split('/').pop(), path, type: 'directory', content: readdirSync(full).map((name) => ({ name, path: path ? `${path}/${name}` : name, type: statSync(join(full, name)).isDirectory() ? 'directory' : 'file', size: null, last_modified: null })) });
    const base64 = url.searchParams.get('format') === 'base64';
    return reply({ name: path.split('/').pop(), path, type: 'file', format: base64 ? 'base64' : 'text', content: base64 ? readFileSync(full).toString('base64') : readFileSync(full, 'utf8'), last_modified: null });
  }
  return reply({ error: 'no' }, 404);
});
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
await page.getByText('Bringing the paper into Google Drive').waitFor({ timeout: 20000 });
check('no set-up on this computer is offered', (await page.getByText(/Write it on this computer|Clone from Overleaf/).count()) === 0);
await page.getByLabel('Which Overleaf account').fill('priya@uni.edu');
await page.getByLabel('Overleaf Git token').fill('olp_test_token');
await shot('write-drive-setup');
await page.getByRole('button', { name: 'Connect Overleaf' }).click();

console.log('brought in from Overleaf by Reader’s server, into Drive');
await page.locator('.wr-doc').first().waitFor({ timeout: 30000 }).catch(async (error) => {
  await shot('write-drive-failed');
  console.log((await page.locator('main, .app, body').first().innerText()).slice(0, 1500));
  console.log('drive:', [...items.values()].filter((item) => item.data).map(pathOf).join(', '));
  console.log('bad:', await page.locator('.wr-bad').allInnerTexts());
  console.log('stored:', await page.evaluate(async () => {
    const db = await new Promise((resolve) => { const r = indexedDB.open('reader'); r.onsuccess = () => resolve(r.result); });
    return new Promise((resolve) => { const g = db.transaction('collections').objectStore('collections').getAll(); g.onsuccess = () => resolve(JSON.stringify(g.result.map((c) => [c.id, c.name, c.project?.overleaf]))); });
  }));
  console.log('errors:', errors);
  throw error;
});
const folder = 'Papers_collection/Projects/Sparse-gated MoE-p-moe/LaTeX';
check('the paper is in Drive, in the project’s folder: Projects/<project>/LaTeX', Boolean(driveFile(`${folder}/main.tex`)) && Boolean(driveFile(`${folder}/sections/intro.tex`)), [...items.values()].filter((item) => item.data).map(pathOf).join(', '));
check('with where it last synced', /"commit":"[0-9a-f]{40}"/.test(driveFile(`${folder}/.reader-sync.json`)?.data?.toString() ?? ''));
check('the token went to the Worker once, and is kept sealed, not in the clear', !syncs.some((sync) => sync.token) && [...kept.values()].some((value) => /iv/.test(value)) && ![...kept.values()].some((value) => value.includes('olp_test_token')));
check('its document is listed by its title', /Loss-free routing at 8B/.test(await page.locator('.wr-docs').innerText()));
check('the page says where it is: Drive, in step with Overleaf', /Google Drive › Projects › Sparse-gated MoE-p-moe › LaTeX/.test(await page.locator('.wr-home-head').innerText()) && /in step with Overleaf/.test(await page.locator('.wr-home-head').innerText()));
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

console.log('a new LaTeX project beside it: off Overleaf until it is put there');
await page.getByRole('button', { name: /All LaTeX projects/ }).click();
await page.locator('.wr-home-way', { hasText: 'Blank article' }).click();
await page.locator('.wr-home-name input').fill('Rebuttal');
await page.getByRole('button', { name: 'Make it and open it' }).click();
await page.locator('.wr-desk').waitFor({ timeout: 20000 });
await page.waitForTimeout(1500);
check('it is in a folder of its own, in Drive', /\\title\{Rebuttal\}/.test(driveFile(`${folder}/rebuttal/main.tex`)?.data?.toString() ?? ''));
check('no Overleaf account asked for, nothing synced', (await page.getByText(/No Overleaf account is connected yet/).count()) === 0 && !/Syncing with Overleaf|Synced with/.test(await page.locator('.wr-status').innerText()), await page.locator('.wr-status').innerText());
check('its files are its own: the other project’s aren’t listed', (await page.locator('.wr-tree-item', { hasText: 'intro.tex' }).count()) === 0);
await shot('write-new-project-desk');
await page.getByRole('button', { name: /All LaTeX projects/ }).click();
await page.locator('.wr-doc-card').nth(1).waitFor({ timeout: 20000 });
await page.waitForTimeout(500);
const rebuttalCard = page.locator('.wr-doc-card', { hasText: 'Rebuttal' });
check('its card says it is not on Overleaf, and offers to put it there', /Not on Overleaf/.test(await rebuttalCard.innerText()) && (await rebuttalCard.getByRole('button', { name: 'Put on Overleaf' }).count()) === 1);
check('the other one’s says it is on Overleaf, with Compare', /On Overleaf/.test(await page.locator('.wr-doc-card', { hasText: 'Loss-free' }).innerText()) && (await page.locator('.wr-doc-card', { hasText: 'Loss-free' }).getByRole('button', { name: 'Compare with Overleaf' }).count()) === 1);
await shot('write-latex-projects');
await rebuttalCard.getByRole('button', { name: 'Put on Overleaf' }).click();
await page.getByRole('button', { name: 'Make it on Overleaf' }).waitFor({ timeout: 10000 });
await shot('write-put-on-overleaf');
await rebuttalCard.getByRole('button', { name: 'Put on Overleaf' }).click();

console.log('the top project synced: the new one stays out of its Overleaf project');
await page.locator('.wr-doc-card', { hasText: 'Loss-free' }).locator('.wr-doc').click();
await page.locator('.wr-desk').waitFor({ timeout: 20000 });
await page.locator('.wr-status').getByRole('button', { name: /^Sync$/ }).click();
await page.waitForFunction(() => /Synced with Overleaf/.test(document.querySelector('.wr-status')?.textContent ?? ''), null, { timeout: 30000 }).catch(() => {});
check('synced', /Synced with Overleaf/.test(await page.locator('.wr-status').innerText()), await page.locator('.wr-status').innerText());
check('and the new project isn’t in Overleaf', remoteFile('rebuttal/main.tex') === null);
check('nor are its files listed with the top one’s', (await page.locator('.wr-tree-item', { hasText: /rebuttal/ }).count()) === 0);

console.log('compared with Overleaf, file by file and change by change; then the same in both places');
const siteIntro = '\\section{Introduction}\nSparse mixture-of-experts models route each token to a few experts, chosen by a learned router.\nWe show routing can be loss-free at 8B.\n\\section{Method}\nOur router balances load without an auxiliary loss.\n';
const overleafIntro = '\\section{Introduction}\nSparse mixture-of-experts models send each token to two experts.\nWe show routing can be loss-free at 8B.\n\\section{Method}\nThe router needs no auxiliary loss to balance experts.\n';
const introItem = driveFile(`${folder}/sections/intro.tex`);
introItem.data = Buffer.from(siteIntro);
introItem.modifiedTime = new Date().toISOString();
sh('git', ['pull', '-q'], coauthor);
writeFileSync(join(coauthor, 'sections', 'intro.tex'), overleafIntro);
writeFileSync(join(coauthor, 'sections', 'related.tex'), '\\section{Related work}\nSwitch Transformers route each token to one expert.\n');
writeFileSync(join(coauthor, 'main.tex'), '\\documentclass{article}\n\\title{Loss-free routing at 8B, revised}\n\\begin{document}\n\\maketitle\n\\input{sections/intro}\n\\input{sections/related}\n\\end{document}\n');
sh('git', ['add', '-A'], coauthor);
sh('git', ['commit', '-q', '-m', 'A coauthor, meanwhile'], coauthor);
sh('git', ['push', '-q'], coauthor);
await page.locator('.wr-status').getByRole('button', { name: 'Compare with Overleaf' }).click();
await page.locator('.wc-file').first().waitFor({ timeout: 30000 });
const listed = await page.locator('.wc-files').innerText();
check('the files that differ are listed, by how', /Changed on both[\s\S]*main\.tex[\s\S]*sections\/intro\.tex/i.test(listed) && /Only on Overleaf[\s\S]*sections\/related\.tex/i.test(listed), listed);
check('and the new LaTeX project isn’t part of it', !/rebuttal/.test(listed));
check('Apply waits until every changed file is picked', await page.getByRole('button', { name: 'Apply to both' }).isDisabled());
await page.locator('.wc-file', { hasText: 'sections/intro.tex' }).click();
await page.locator('.wc-hunk-bar').first().waitFor({ timeout: 10000 });
check('its two changes, each to pick', (await page.locator('.wc-hunk-bar').count()) === 2);
await shot('write-compare-code');
await page.locator('.wc-hunk-bar').nth(0).getByRole('button', { name: 'Take Overleaf’s' }).click();
await page.locator('.wc-hunk-bar').nth(1).getByRole('button', { name: 'Keep this site’s' }).click();
await shot('write-compare-picked');
await page.locator('.wc-file', { hasText: 'main.tex' }).first().click();
await page.getByRole('button', { name: 'Use Overleaf’s version' }).click();
check('everything picked: Apply is ready', !(await page.getByRole('button', { name: 'Apply to both' }).isDisabled()));
await page.getByRole('tab', { name: 'PDFs' }).click();
await page.getByRole('button', { name: 'Compile both and compare' }).click();
await page.locator('.wc-pdf-row.has-change').first().waitFor({ timeout: 90000 }).catch(() => {});
check('the two PDFs compiled and compared, the changes boxed', (await page.locator('.wc-hl').count()) > 0, await page.locator('.wc-pdf').innerText());
await shot('write-compare-pdfs');
await page.getByRole('button', { name: 'Apply to both' }).click();
await page.locator('.wc-done').waitFor({ timeout: 30000 });
const settledIntro = '\\section{Introduction}\nSparse mixture-of-experts models send each token to two experts.\nWe show routing can be loss-free at 8B.\n\\section{Method}\nOur router balances load without an auxiliary loss.\n';
check('Drive has the version picked, change by change', driveFile(`${folder}/sections/intro.tex`)?.data?.toString() === settledIntro, driveFile(`${folder}/sections/intro.tex`)?.data?.toString());
check('and so has Overleaf', remoteFile('sections/intro.tex') === settledIntro, remoteFile('sections/intro.tex') ?? '');
check('Overleaf’s main.tex and its new file came into Drive', /sections\/related/.test(driveFile(`${folder}/main.tex`)?.data?.toString() ?? '') && Boolean(driveFile(`${folder}/sections/related.tex`)));
await page.waitForFunction(() => /Nothing differs/.test(document.querySelector('.wc-actions')?.textContent ?? ''), null, { timeout: 30000 }).catch(() => {});
check('compared again: nothing differs', /Nothing differs/.test(await page.locator('.wc-actions').innerText().catch(() => '')));
await shot('write-compare-settled');
await page.getByRole('button', { name: /Back to the LaTeX projects/ }).click();

console.log('papers from before, in folders on this computer: moved into Drive by themselves');
await page.evaluate(
  async ({ cloneId, folderId, lostId }) => {
    localStorage.setItem('reader.playground.servers', JSON.stringify([{ id: 's-mac', name: 'MacBook Air', url: 'http://127.0.0.1:47321/', token: 'pc-token', where: 'pc', companionId: 'mac-1' }]));
    const db = await new Promise((resolve) => {
      const request = indexedDB.open('reader');
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise((resolve) => {
      const tx = db.transaction('collections', 'readwrite');
      const store = tx.objectStore('collections');
      const made = (id, name, overleafId, path, sync) => ({ id, name, color: '#5b4b8a', createdAt: new Date().toISOString(), project: { question: '', startedAt: new Date().toISOString(), roles: {}, todos: [], overleaf: { url: `https://www.overleaf.com/project/${overleafId}`, folders: { 'mac-1': { path, sync } } } } });
      store.put(made('p-clone', 'Old clone', cloneId, 'papers/old-clone', 'git'));
      store.put(made('p-folder', 'Old folder', folderId, 'papers/old-folder', 'folder'));
      const lost = made('p-lost', 'Lost link', lostId, '', 'git');
      delete lost.project.overleaf.folders;
      store.put(lost);
      tx.oncomplete = resolve;
    });
    db.close();
  },
  { cloneId: CLONE_ID, folderId: FOLDER_ID, lostId: LOST_ID },
);
companionOn = true;
await page.goto(`${BASE}/projects/`, { waitUntil: 'networkidle' });
const driveLinks = () =>
  page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const request = indexedDB.open('reader');
      request.onsuccess = () => resolve(request.result);
    });
    return new Promise((resolve) => {
      const got = db.transaction('collections').objectStore('collections').getAll();
      got.onsuccess = () => resolve(Object.fromEntries(got.result.map((item) => [item.id, item.project?.overleaf?.drive?.folder ?? null])));
    });
  });
let linked = {};
for (let i = 0; i < 60 && !(linked['p-clone'] && linked['p-folder'] && linked['p-lost']); i += 1) {
  await page.waitForTimeout(500);
  linked = await driveLinks();
}
check('both projects moved into Drive by themselves', linked['p-clone'] === 'Projects/Old clone-p-clone/LaTeX' && linked['p-folder'] === 'Projects/Old folder-p-folder/LaTeX', JSON.stringify(linked));
check('the project that lost its link to its clone here was found by its folder, and moved', linked['p-lost'] === 'Projects/Lost link-p-lost/LaTeX' && /only here/.test(bareFile(bareFor[LOST_ID], 'extra.tex') ?? '') && /only here/.test(driveFile('Papers_collection/Projects/Lost link-p-lost/LaTeX/extra.tex')?.data?.toString() ?? ''), JSON.stringify(linked));
check('nothing was shown or asked', (await page.locator('.move-drive').count()) === 0 && (await page.getByLabel(/Overleaf Git token/).count()) === 0);
check('the clone’s edit made only on this computer reached Overleaf first, by the Companion', /Typed only on this computer/.test(bareFile(bareFor[CLONE_ID], 'main.tex') ?? ''));
check('and is in Drive', /Typed only on this computer/.test(driveFile('Papers_collection/Projects/Old clone-p-clone/LaTeX/main.tex')?.data?.toString() ?? ''));
check('the never-synced folder went into Drive as it was, figures too', /never synced/.test(driveFile('Papers_collection/Projects/Old folder-p-folder/LaTeX/main.tex')?.data?.toString() ?? '') && driveFile('Papers_collection/Projects/Old folder-p-folder/LaTeX/figures/plot.png')?.data?.length === 11);
check('and nothing of them is left on this computer: the folders are gone', !existsSync(join(root, 'papers', 'old-clone')) && !existsSync(join(root, 'papers', 'old-folder')) && !existsSync(join(root, 'papers', 'lost-link')), readdirSync(join(root, 'papers')).join(', '));
await shot('move-drive-silent');

console.log('their first syncs from Drive: from the commit they were moved at, or all of it');
// A coauthor edits the clone's Overleaf project meanwhile: its first sync from Drive must merge it, not undo it.
const cloneCoauthor = join(tmp, 'clone-coauthor');
sh('git', ['clone', '-q', bareFor[CLONE_ID], cloneCoauthor]);
writeFileSync(join(cloneCoauthor, 'notes.tex'), 'A coauthor’s notes.\n');
sh('git', ['add', '-A'], cloneCoauthor);
sh('git', ['commit', '-q', '-m', 'notes'], cloneCoauthor);
sh('git', ['push', '-q'], cloneCoauthor);
const syncsBefore = syncs.length;
await page.goto(`${BASE}/project/?id=p-clone&view=write`, { waitUntil: 'networkidle' });
await page.locator('.wr-doc').first().click();
await page.locator('.wr-desk').waitFor({ timeout: 15000 });
for (let i = 0; i < 40 && !driveFile('Papers_collection/Projects/Old clone-p-clone/LaTeX/notes.tex'); i += 1) await page.waitForTimeout(500);
check('the first sync sent the files’ Git ids, to find their commit by', Boolean(syncs.slice(syncsBefore).find((sync) => sync.baseTree && sync.baseTree['main.tex'])));
check('the coauthor’s edit came in', /coauthor’s notes/.test(driveFile('Papers_collection/Projects/Old clone-p-clone/LaTeX/notes.tex')?.data?.toString() ?? ''));
check('and nothing in Overleaf was undone', /Typed only on this computer/.test(bareFile(bareFor[CLONE_ID], 'main.tex') ?? '') && /coauthor’s notes/.test(bareFile(bareFor[CLONE_ID], 'notes.tex') ?? '') && !/<<<<<<</.test(driveFile('Papers_collection/Projects/Old clone-p-clone/LaTeX/main.tex')?.data?.toString() ?? ''));
await page.goto(`${BASE}/project/?id=p-folder&view=write`, { waitUntil: 'networkidle' });
await page.locator('.wr-doc').first().click();
await page.locator('.wr-desk').waitFor({ timeout: 15000 });
for (let i = 0; i < 40 && !/never synced/.test(bareFile(bareFor[FOLDER_ID], 'main.tex') ?? ''); i += 1) await page.waitForTimeout(500);
check('the never-synced folder went to Overleaf at its first sync', /never synced/.test(bareFile(bareFor[FOLDER_ID], 'main.tex') ?? '') && bareFile(bareFor[FOLDER_ID], 'figures/plot.png') !== null);
check('beside what Overleaf had, which came into Drive', /Overleaf’s own readme/.test(driveFile('Papers_collection/Projects/Old folder-p-folder/LaTeX/README.md')?.data?.toString() ?? ''));

console.log('kept on this computer instead, as chosen: a clone of Overleaf here, left where it is');
page.on('dialog', (dialog) => void dialog.accept());
await page.goto(`${BASE}/project/?id=p-clone&view=write`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Keep on this computer instead' }).click();
await page.getByText('Where on this computer?').waitFor({ timeout: 20000 });
await shot('write-local-setup');
await page.getByRole('button', { name: 'Clone from Overleaf' }).click();
await page.locator('.wr-doc').first().waitFor({ timeout: 20000 });
check('cloned into a folder on this computer', existsSync(join(root, 'papers', 'old-clone', 'notes.tex')));
check('the page says it is on this computer', /~\/Reader\/papers\/old-clone/.test(await page.locator('.wr-home-head').innerText()) && (await page.getByRole('button', { name: 'Keep in Google Drive instead' }).count()) === 1);
await shot('write-local-home');
await page.goto(`${BASE}/projects/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);
check('and not moved back into Drive by itself', existsSync(join(root, 'papers', 'old-clone', 'notes.tex')));

console.log('back to Google Drive: the clone’s edits to Overleaf, the folder removed');
writeFileSync(join(root, 'papers', 'old-clone', 'notes.tex'), 'A coauthor’s notes, and mine from this computer.\n');
await page.goto(`${BASE}/project/?id=p-clone&view=write`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Keep in Google Drive instead' }).click();
await page.getByText(/Google Drive › Projects › Old clone-p-clone › LaTeX/).waitFor({ timeout: 20000 });
check('the edit made on this computer went to Overleaf', /mine from this computer/.test(bareFile(bareFor[CLONE_ID], 'notes.tex') ?? ''));
check('the folder is gone from this computer', !existsSync(join(root, 'papers', 'old-clone')));
for (let i = 0; i < 40 && !/mine from this computer/.test(driveFile('Papers_collection/Projects/Old clone-p-clone/LaTeX/notes.tex')?.data?.toString() ?? ''); i += 1) await page.waitForTimeout(500);
check('and it came into Drive with the next sync', /mine from this computer/.test(driveFile('Papers_collection/Projects/Old clone-p-clone/LaTeX/notes.tex')?.data?.toString() ?? ''));

const addProject = (id, name) =>
  page.evaluate(
    async ({ id, name }) => {
      const db = await new Promise((resolve) => {
        const request = indexedDB.open('reader');
        request.onsuccess = () => resolve(request.result);
      });
      await new Promise((resolve) => {
        const tx = db.transaction('collections', 'readwrite');
        tx.objectStore('collections').put({ id, name, color: '#8a5b2e', createdAt: new Date().toISOString(), project: { question: '', startedAt: new Date().toISOString(), roles: {}, todos: [] } });
        tx.oncomplete = resolve;
      });
      db.close();
    },
    { id, name },
  );

console.log('a new project, started from the Overleaf account: connected first, then a project picked');
kept.clear(); // the account not connected yet
companionOn = false;
await addProject('p-start', 'Routing study');
await page.goto(`${BASE}/project/?id=p-start&view=write`, { waitUntil: 'networkidle' });
await page.getByText('Start this project’s paper').waitFor({ timeout: 20000 });
check('two ways to start: from Overleaf, or without it', (await page.getByRole('radio', { name: /From your Overleaf account/ }).count()) === 1 && (await page.getByRole('radio', { name: /Start without Overleaf/ }).count()) === 1);
await shot('write-start');

console.log('the guide, on the site: opened from the choices it explains');
await page.getByRole('button', { name: /Which should I pick\?/ }).click();
await page.getByRole('dialog', { name: 'Writing your paper' }).waitFor({ timeout: 10000 });
await page.waitForTimeout(300);
check('it opens at the part about the choice', (await page.locator('.wg-nav button.is-on').innerText()).includes('Starting a paper'));
await shot('guide-begin');
for (const [part, name] of [['Quick start', 'guide-start'], ['Where your paper is kept', 'guide-where'], ['Overleaf accounts', 'guide-accounts'], ['In the editor', 'guide-editor'], ['Your Write tab settings', 'guide-settings']]) {
  await page.locator('.wg-nav').getByRole('button', { name: new RegExp(part) }).click();
  await page.waitForTimeout(700);
  await shot(name);
}
check('its parts are reached from the contents', (await page.locator('.wg-nav button.is-on').innerText()).includes('Your Write tab settings'));
await page.keyboard.press('Escape');
check('Escape closes it', (await page.getByRole('dialog', { name: 'Writing your paper' }).count()) === 0);
await page.setViewportSize({ width: 390, height: 844 });
await page.getByRole('button', { name: /Which should I pick\?/ }).click();
await page.getByRole('dialog', { name: 'Writing your paper' }).waitFor({ timeout: 10000 });
await page.waitForTimeout(300);
await shot('guide-phone');
check('on a phone, nothing is wider than the screen', await page.evaluate(() => { const sheet = document.querySelector('.wg-sheet'); return Boolean(sheet) && sheet.scrollWidth <= sheet.clientWidth + 1; }));
await page.keyboard.press('Escape');
await page.setViewportSize({ width: 1440, height: 900 });
await page.getByRole('radio', { name: /From your Overleaf account/ }).click();
await page.getByLabel('Which Overleaf account').fill('priya@uni.edu');
await page.getByLabel('Overleaf Git token').fill('olp_test_token');
await shot('write-start-connect');
await page.getByRole('button', { name: 'Connect Overleaf' }).click();
await page.locator('.wr-ol-item').first().waitFor({ timeout: 15000 });
const offered = await page.locator('.wr-ol-item').allInnerTexts();
check('connected: kept sealed by the Worker', [...kept.values()].some((value) => /iv/.test(value)) && ![...kept.values()].some((value) => value.includes('olp_test_token')));
check('the Overleaf projects Reader knows are offered, by name', offered.some((text) => /Sparse-gated MoE/.test(text)) && offered.some((text) => /Old clone/.test(text)), offered.join(' | '));
await shot('write-start-pick');
await page.locator('.wr-ol-item', { hasText: 'Sparse-gated MoE' }).click();
await page.locator('.wr-doc').first().waitFor({ timeout: 30000 });
check('the picked project came into Drive, in this project’s folder', /revised/.test(driveFile('Papers_collection/Projects/Routing study-p-start/LaTeX/main.tex')?.data?.toString() ?? ''));
check('and is in step with Overleaf', /in step with Overleaf/.test(await page.locator('.wr-home-head').innerText()));
await shot('write-start-picked');

console.log('a new project without Overleaf: a blank paper in Drive, put on Overleaf later');
await addProject('p-blank', 'Workshop note');
await page.goto(`${BASE}/project/?id=p-blank&view=write`, { waitUntil: 'networkidle' });
await page.getByRole('radio', { name: /Start without Overleaf/ }).click({ timeout: 20000 });
await page.getByRole('button', { name: 'Start the paper' }).click();
await page.locator('.wr-home-way').first().waitFor({ timeout: 20000 });
check('its folder is made in Drive, and it is not on Overleaf', /Google Drive › Projects › Workshop note-p-blank › LaTeX/.test(await page.locator('.wr-home-head').innerText()) && /not on Overleaf/.test(await page.locator('.wr-home-head').innerText()));
await shot('write-start-blank-home');
await page.locator('.wr-home-way', { hasText: 'Blank article' }).click();
await page.locator('.wr-home-name input').fill('Workshop note');
await page.getByRole('button', { name: 'Make it and open it' }).click();
await page.locator('.wr-desk').waitFor({ timeout: 20000 });
await page.waitForFunction(() => /Compiled on Cloud Run/.test(document.querySelector('.wr-ghc')?.textContent ?? ''), null, { timeout: 60000 }).catch(() => {});
check('its first document is in Drive', /\\title\{Workshop note\}/.test(driveFile('Papers_collection/Projects/Workshop note-p-blank/LaTeX/main.tex')?.data?.toString() ?? ''));
// (This machine's TeX for the stand-in compiler is a small one: Cloud Run's has all of TeX Live.)
check('and compiled on Cloud Run', /Compiled on Cloud Run/.test(await page.locator('.wr-ghc').innerText()));
check('which says it is in Drive, not on Overleaf', /Saved in Google Drive · not on Overleaf/.test(await page.locator('.wr-status').innerText()));
await shot('write-start-blank-desk');
await page.getByRole('button', { name: /All LaTeX projects/ }).click();
await page.getByRole('button', { name: 'Put it on Overleaf' }).click();
await page.getByLabel('The Overleaf project’s address').fill(`https://www.overleaf.com/project/${FRESH_ID}`);
await shot('write-start-put');
// The Blank Project was made in the lab's Overleaf account: Priya's token can't open it.
allow({ [FRESH_ID]: ['olp_lab'] });
await page.getByRole('button', { name: 'Put the paper in this project' }).click();
await page.getByText(/can’t open this project/).waitFor({ timeout: 30000 });
check('no connected account opens it: said so, and another account is asked for', (await page.getByText('Connect another Overleaf account').count()) === 1 && (await page.locator('.ol-account').count()) === 1);
await page.getByLabel('Which Overleaf account').fill('lab@uni.edu');
await page.getByLabel('Overleaf Git token').fill('olp_lab');
await shot('write-start-other-account');
await page.getByRole('button', { name: 'Connect Overleaf' }).click();
await page.getByText(/in step with Overleaf through lab@uni\.edu/).waitFor({ timeout: 30000 });
check('with the lab account connected, the paper went into its Overleaf project', /\\title\{Workshop note\}/.test(bareFile(bareFor[FRESH_ID], 'main.tex') ?? ''));
check('and the project remembers it syncs through the lab account', /through lab@uni\.edu/.test(await page.locator('.wr-home-head').innerText()));
await shot('write-start-put-done');

console.log('a project shared with both accounts: synced through the one chosen; when it loses access, through the other');
allow({ [FRESH_ID]: ['olp_lab', 'olp_test_token'] });
await page.locator('.wr-doc').first().click();
await page.locator('.wr-desk').waitFor({ timeout: 20000 });
await page.getByRole('button', { name: 'Overleaf account' }).click();
await page.locator('.ol-account.is-current', { hasText: 'lab@uni.edu' }).waitFor({ timeout: 10000 });
await page.locator('.ol-account', { hasText: 'priya@uni.edu' }).getByRole('button', { name: 'Sync with this one' }).click();
// (A sync may still be under way from opening the paper: Sync again until one goes through the chosen account.)
for (let i = 0; i < 4 && !(await page.locator('.ol-account.is-current', { hasText: 'priya@uni.edu' }).count()); i += 1) {
  await page.locator('.wr-status').getByRole('button', { name: /^Sync$/ }).click();
  await page.locator('.ol-account.is-current', { hasText: 'priya@uni.edu' }).waitFor({ timeout: 6000 }).catch(() => {});
}
check('synced through the account chosen', (await page.locator('.ol-account.is-current').innerText()).includes('priya@uni.edu'));
await shot('write-shared-accounts');
allow({ [FRESH_ID]: ['olp_lab'] });
await page.locator('.wr-status').getByRole('button', { name: /^Sync$/ }).click();
await page.getByText(/can’t open this Overleaf project any more/).waitFor({ timeout: 20000 });
check('unshared from it: synced through the other account, and said so', (await page.locator('.ol-account.is-current').innerText()).includes('lab@uni.edu'));
await shot('write-shared-fell-back');

console.log('the accounts, once for every project: in Settings, and on the project’s overview');
await page.goto(`${BASE}/project/?id=p-blank`, { waitUntil: 'networkidle' });
await page.locator('.ol-through').waitFor({ timeout: 15000 }).catch(() => {});
check('the overview says which account it syncs through', /lab@uni\.edu/.test(await page.locator('.ol-through').innerText().catch(() => '')));
await shot('overview-synced-through');
await page.locator('.ol-through').getByRole('button', { name: 'Overleaf accounts' }).click();
await page.locator('#settings-overleaf-accounts').waitFor({ timeout: 10000 });
await page.waitForTimeout(600);
check('Settings lists both accounts, with their projects', (await page.locator('.ol-account').count()) === 2 && /Workshop note/.test(await page.locator('.ol-account', { hasText: 'lab@uni.edu' }).innerText()));
await shot('settings-overleaf-accounts');

check('no errors on the page', !errors.length, errors.join(' | '));
await browser.close();
compiler.kill();
if (problems.length) {
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log('\nall good');
