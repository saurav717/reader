/**
 * The Write tab, end to end: setting the paper up from Overleaf's Git, the
 * files, the editor, the PDF compiled as you type, the errors and where they
 * are, the sync to Overleaf (and a coauthor's edit coming back), the citations
 * drawer, and the Write tab's choices in Settings.
 *
 * This computer's Companion is stood in for, but what it does is the real
 * Companion's code (companion/reader_companion/paper.py, run with python3):
 * a real latexmk makes the PDF, and real git syncs with a bare repository
 * standing in for Overleaf's Git. Needs python3, git and latexmk (TeX Live).
 *
 *   npm run build && npm start &
 *   node scripts/write-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
const COMPANION = new URL('../companion/', import.meta.url).pathname;
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

// ---- a computer: the Companion's folder, and Overleaf's Git standing in as a bare repository
const tmp = mkdtempSync(join(tmpdir(), 'write-smoke-'));
const root = join(tmp, 'Reader');
mkdirSync(root);
const env = { ...process.env, GIT_CONFIG_GLOBAL: join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', READER_COMPANION_HOME: join(tmp, 'home'), PYTHONPATH: COMPANION };
writeFileSync(join(tmp, 'gitconfig'), '[user]\n\tname = Priya\n\temail = p@x\n[init]\n\tdefaultBranch = master\n');
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, env, encoding: 'utf8' });
const remote = join(tmp, 'overleaf.git');
sh('git', ['init', '-q', '--bare', remote]);
const coauthor = join(tmp, 'coauthor');
sh('git', ['clone', '-q', remote, coauthor]);
mkdirSync(join(coauthor, 'sections'));
writeFileSync(join(coauthor, 'main.tex'), '\\documentclass{article}\n\\title{Loss-free routing at 8B}\n\\begin{document}\n\\maketitle\n\\input{sections/intro}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n');
writeFileSync(join(coauthor, 'sections', 'intro.tex'), '\\section{Introduction}\nSparse mixture-of-experts models route each token to a few experts~\\cite{fedus2021switch}.\n');
writeFileSync(join(coauthor, 'refs.bib'), '@article{fedus2021switch,\n  title = {Switch Transformers},\n  author = {Fedus, William},\n  year = {2021},\n  journal = {JMLR}\n}\n');
sh('git', ['add', '-A'], coauthor);
sh('git', ['commit', '-q', '-m', 'Start the paper'], coauthor);
sh('git', ['push', '-q', 'origin', 'HEAD'], coauthor);

/** The real Companion's paper.py, given JSON and answering JSON. */
function paper(code, args) {
  const script = `import json, sys\nfrom pathlib import Path\nfrom reader_companion import paper\nargs = json.load(sys.stdin)\nroot = Path(args['root'])\n${code}`;
  return JSON.parse(execFileSync('python3', ['-c', script], { env, input: JSON.stringify({ root, ...args }), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}
const which = (name) => {
  try {
    return execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const found = { latexmk: which('latexmk'), tectonic: '', git: which('git'), pdflatex: which('pdflatex'), bibtex: which('bibtex') };
if (!found.latexmk || !found.git) {
  console.log('needs latexmk and git on this computer');
  process.exit(1);
}

const PROJECT_ID = '66f1c0a9e2b7d4a1b2c3d4e5';
// A second Overleaf project, made blank in Overleaf (its main.tex and all), for a paper from a template.
const blank = join(tmp, 'blank.git');
sh('git', ['init', '-q', '--bare', blank]);
const blankSeed = join(tmp, 'blank-seed');
sh('git', ['clone', '-q', blank, blankSeed]);
writeFileSync(join(blankSeed, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nBlank.\n\\end{document}\n');
sh('git', ['add', '-A'], blankSeed);
sh('git', ['commit', '-q', '-m', 'Blank Project'], blankSeed);
sh('git', ['push', '-q', 'origin', 'HEAD'], blankSeed);
// The conference's kit, as a .zip wrapped in a folder.
const kit = join(tmp, 'neurips_2026.zip');
execFileSync('python3', ['-c', `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],'w')\nz.writestr('NeurIPS_2026/neurips_2026.tex', '\\\\documentclass{article}\\n\\\\usepackage{neurips_2026}\\n\\\\begin{document}\\nTemplate paper.\\n\\\\end{document}\\n')\nz.writestr('NeurIPS_2026/neurips_2026.sty', '\\\\ProvidesPackage{neurips_2026}\\n')\nz.close()`, kit]);
let cloneFrom = remote;
let tokenSaved = false;
const PAPERS = [
  { id: 'arxiv:2408.15664', source: 'arxiv', arxivId: '2408.15664', title: 'Auxiliary-Loss-Free Load Balancing Strategy for Mixture-of-Experts', authors: ['Lean Wang'], abstract: '', published: '2024-08-28', categories: [], addedAt: new Date().toISOString(), collectionIds: ['p-moe'], tags: [], progress: 0.3, lastOpenedAt: new Date().toISOString() },
  { id: 'arxiv:2101.03961', source: 'arxiv', arxivId: '2101.03961', title: 'Switch Transformers', authors: ['William Fedus'], abstract: '', published: '2021-01-11', categories: [], addedAt: new Date().toISOString(), collectionIds: ['p-moe'], tags: [], progress: 1 },
  { id: 'arxiv:2202.09368', source: 'arxiv', arxivId: '2202.09368', title: 'Mixture-of-Experts with Expert Choice Routing', authors: ['Yanqi Zhou'], abstract: '', published: '2022-02-18', categories: [], addedAt: new Date().toISOString(), collectionIds: ['p-moe'], tags: [], progress: 0 },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|fonts\.)/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
let cloned = null;
await context.route(/^https?:\/\/127\.0\.0\.1:473[23]1\//, async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' };
  if (url.port === '47331') return route.abort();
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
  if (url.pathname === '/companion/info') return json({ app: 'reader-companion', version: '0.11.0', id: 'mac-1', name: 'MacBook Air', hardware: '', root });
  if (request.headers().authorization !== 'token pc-token') return json({ error: 'Pair first' }, 403);
  try {
    if (url.pathname === '/companion/paper' && request.method() === 'GET') return json(paper('print(json.dumps(paper.engines(args["found"])))', { found }));
    if (url.pathname === '/companion/paper') {
      const body = request.postDataJSON();
      if (body.action === 'compile') return json(paper('print(json.dumps(paper.compile_paper(root, args["folder"], args.get("main"), args["engine"], args["found"], compiler=args["compiler"], halt=args["halt"])))', { folder: body.folder, engine: body.engine, found, main: body.main ?? null, compiler: body.compiler ?? 'pdflatex', halt: Boolean(body.halt) }));
      if (body.action === 'templates') return json(paper('print(json.dumps({"templates": paper.list_templates(root)}))', {}));
      if (body.action === 'save-template') return json(paper('import base64\nprint(json.dumps(paper.save_template(root, args["name"], base64.b64decode(args["zip"]))))', { name: body.name, zip: body.zip }));
      if (body.action === 'apply-template') return json(paper('print(json.dumps(paper.apply_template(root, args["template"], args["folder"], args["replace"])))', { template: body.template, folder: body.folder, replace: Boolean(body.replace) }));
      if (body.action === 'token') return json({ known: tokenSaved });
      if (body.action === 'clone') {
        // Overleaf's Git is the bare repository here; paper.clone takes Overleaf's or GitHub's address only.
        cloned = body;
        if (body.token) tokenSaved = true;
        sh('git', ['clone', '-q', cloneFrom, join(root, body.folder)]);
        return json({ folder: body.folder });
      }
      if (body.action === 'sync') return json(paper('print(json.dumps(paper.sync(root, args["folder"], "", args["message"])))', { folder: body.folder, message: body.message }));
      if (body.action === 'remote') return json({ url: `https://git.overleaf.com/${PROJECT_ID}`, token: true });
      if (body.action === 'delete-template') return json({ deleted: true });
    }
    if (url.pathname.startsWith('/api/contents')) {
      const path = decodeURIComponent(url.pathname.replace(/^\/api\/contents\/?/, ''));
      const full = join(root, path);
      if (request.method() === 'PUT') {
        const body = request.postDataJSON();
        if (body.type === 'directory') mkdirSync(full, { recursive: true });
        else writeFileSync(full, body.format === 'base64' ? Buffer.from(body.content, 'base64') : body.content);
        return json({ name: path.split('/').pop(), path, type: body.type, last_modified: new Date().toISOString() });
      }
      if (request.method() === 'PATCH') {
        const to = join(root, request.postDataJSON().path);
        mkdirSync(join(to, '..'), { recursive: true });
        renameSync(full, to);
        return json({ path: request.postDataJSON().path });
      }
      if (request.method() === 'DELETE') {
        rmSync(full, { recursive: true, force: true });
        return route.fulfill({ status: 204, headers: cors });
      }
      if (!existsSync(full)) return json({ message: 'No such file' }, 404);
      if (statSync(full).isDirectory()) {
        const content = readdirSync(full).map((name) => ({ name, path: path ? `${path}/${name}` : name, type: statSync(join(full, name)).isDirectory() ? 'directory' : 'file', size: null, last_modified: null }));
        return json({ name: path.split('/').pop(), path, type: 'directory', content });
      }
      return json({ name: path.split('/').pop(), path, type: 'file', format: 'text', content: readFileSync(full, 'utf8'), last_modified: null });
    }
  } catch (error) {
    return json({ error: String(error.stderr || error.message) }, 500);
  }
  return json({ error: 'no' }, 404);
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
// prompt() and confirm() answered in turn: what each next one should say.
const answers = [];
page.on('dialog', (dialog) => {
  const answer = answers.shift();
  if (answer === false) return dialog.dismiss();
  return dialog.type() === 'prompt' ? dialog.accept(answer ?? dialog.defaultValue()) : dialog.accept();
});
const remoteFile = (path, from = remote) => {
  try {
    return sh('git', ['--git-dir', from, 'show', `HEAD:${path}`]);
  } catch {
    return null;
  }
};

async function seed(settings) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(
    async ({ papers, settings, projectId }) => {
      localStorage.setItem('reader.welcomed', 'true');
      localStorage.setItem('reader.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('reader.settings') || '{}'), ...settings }));
      localStorage.setItem('reader.playground.servers', JSON.stringify([{ id: 's-mac', name: 'MacBook Air', url: 'http://127.0.0.1:47321/', token: 'pc-token', where: 'pc', companionId: 'mac-1' }]));
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
      await run('collections', (s) => s.put({ id: 'p-moe', name: 'Sparse-gated MoE', color: '#1f5e52', createdAt: new Date().toISOString(), project: { question: '', startedAt: new Date().toISOString(), roles: {}, todos: [], overleaf: { url: `https://www.overleaf.com/project/${projectId}` } } }));
      for (const paper of papers) await run('papers', (s) => s.put(paper));
      db.close();
    },
    { papers: PAPERS, settings, projectId: PROJECT_ID },
  );
  await page.goto(`${BASE}/project/?id=p-moe&view=write`, { waitUntil: 'networkidle' });
}

console.log('the Write tab: set up from Overleaf’s Git');
await seed({ navStyle: 'labelled' });
check('the project bar has a Write tab, on', (await page.locator('.pj-views').getByRole('button', { name: 'Write' }).getAttribute('aria-pressed')) === 'true');
await page.getByText('Where should the paper’s files be?').waitFor({ timeout: 15000 });
check('Overleaf’s Git is the way picked', (await page.getByRole('radio', { name: /^Overleaf’s Git/ }).getAttribute('aria-checked')) === 'true');
await page.getByLabel('Overleaf Git token').fill('olp_test_token');
await shot('write-setup');
await page.getByRole('button', { name: 'Clone from Overleaf' }).click();
await page.locator('.wr-desk').waitFor({ timeout: 15000 });
check('it clones Overleaf’s Git address, with the token', cloned?.url === `https://git.overleaf.com/${PROJECT_ID}` && cloned?.token === 'olp_test_token' && cloned?.folder === 'papers/sparse-gated-moe', JSON.stringify(cloned));
await page.locator('.wr-tree-item', { hasText: 'intro.tex' }).waitFor({ timeout: 10000 });
const tree = await page.locator('.wr-tree-item').allInnerTexts();
check('the files are listed, main.tex marked', tree.some((t) => /main\.tex/.test(t)) && tree.some((t) => /refs\.bib/.test(t)) && tree.some((t) => /intro\.tex/.test(t)), tree.join(' | '));
await page.locator('.wr-page').first().waitFor({ timeout: 60000 });
check('it compiles at once, with the TeX here, and draws the PDF', (await page.locator('.wr-page').count()) >= 1 && /TeX Live \d{4}/.test(await page.locator('.wr-preview .wr-tabs').innerText()));
await shot('write-desk');

console.log('as you type: saved, compiled, errors where they are');
await page.locator('.wr-tree-item', { hasText: 'intro.tex' }).click();
const area = page.locator('.wr-editor textarea');
await area.click();
await page.keyboard.press('Control+End');
await page.keyboard.press('Enter');
await page.waitForTimeout(80);
await page.keyboard.type('Routing stays balanced \\badmacro without an auxiliary loss.');
await page.locator('.wr-counts.is-bad').waitFor({ timeout: 30000 }).catch(() => {});
check('the file is saved to the folder', /badmacro/.test(readFileSync(join(root, 'papers/sparse-gated-moe/sections/intro.tex'), 'utf8')));
check('it compiles again after the pause, and counts the error', /1 errors/.test(await page.locator('.wr-status').innerText()), await page.locator('.wr-status').innerText());
await page.locator('.wr-counts').click();
const problem = page.locator('.wr-problem.is-error').first();
check('the error says where it is', /sections\/intro\.tex:4/.test(await problem.innerText()), await problem.innerText());
await shot('write-error');
await problem.click();
await page.waitForTimeout(150);
const caretLine = await area.evaluate((el) => el.value.slice(0, el.selectionStart).split('\n').length);
check('clicking it puts the cursor on that line', caretLine === 4, String(caretLine));

console.log('fixed: synced to Overleaf');
const fixed = (await area.inputValue()).replace(' \\badmacro', '');
await area.evaluate((el, value) => {
  el.focus();
  el.select();
  document.execCommand('insertText', false, value);
}, fixed);
await page.waitForFunction(() => /0 errors/.test(document.querySelector('.wr-status')?.textContent ?? ''), null, { timeout: 30000 }).catch(() => {});
check('no errors once fixed', /0 errors/.test(await page.locator('.wr-status').innerText()));
// Until the commit is in "Overleaf": the status already says Synced, from the sync made on opening.
for (let waited = 0; waited < 30000 && !/Routing stays balanced without/.test(remoteFile('sections/intro.tex') ?? ''); waited += 500) await page.waitForTimeout(500);
const log = sh('git', ['--git-dir', remote, 'log', '--format=%s', '-3']);
const pushed = sh('git', ['--git-dir', remote, 'show', 'HEAD:sections/intro.tex']);
check('a few seconds after typing stops, it is in Overleaf’s Git', /Edits from Reader/.test(log) && /Routing stays balanced without an auxiliary loss/.test(pushed), log.split('\n')[0]);
await shot('write-synced');

console.log('a coauthor’s edit in Overleaf comes in');
sh('git', ['pull', '-q'], coauthor);
writeFileSync(join(coauthor, 'sections', 'intro.tex'), readFileSync(join(coauthor, 'sections', 'intro.tex'), 'utf8') + 'Priya wrote this in Overleaf.\n');
sh('git', ['commit', '-qam', 'Priya'], coauthor);
sh('git', ['push', '-q'], coauthor);
await page.locator('.wr-status').getByRole('button', { name: 'Sync' }).click();
await page.waitForFunction(() => /Priya wrote this/.test(document.querySelector('.wr-editor textarea')?.value ?? ''), null, { timeout: 20000 }).catch(() => {});
check('Sync takes it in, and the open file shows it', /Priya wrote this in Overleaf/.test(await area.inputValue()));

console.log('the citations drawer');
await area.click();
await page.keyboard.press('Control+End');
await page.keyboard.type(' Closest to us ');
await page.locator('.wr-cite', { hasText: 'Auxiliary-Loss-Free' }).click();
await page.waitForTimeout(150);
check('a paper from the drawer goes in as \\cite at the cursor', /Closest to us \\cite\{wang2024auxiliary\}/.test(await area.inputValue()));
await page.waitForTimeout(1500);
check('and its BibTeX goes into refs.bib', /@misc\{wang2024auxiliary,/.test(readFileSync(join(root, 'papers/sparse-gated-moe/refs.bib'), 'utf8')));

console.log('compiled as Overleaf does: nothing left in the paper');
const leftovers = readdirSync(join(root, 'papers/sparse-gated-moe')).filter((name) => /\.(aux|log|fls|fdb_latexmk|synctex\.gz|pdf|out|bbl|blg)$/.test(name));
check('the build is kept out of the folder Overleaf gets', !leftovers.length, leftovers.join(', '));
check('and the PDF names the TeX it was made with', /TeX Live \d{4}/.test(await page.locator('.wr-preview .wr-tabs').innerText()), await page.locator('.wr-preview .wr-tabs').innerText());

console.log('files made, added, moved and deleted reach Overleaf');
answers.push('sections/results.tex');
await page.locator('.wr-file-ops').getByRole('button', { name: 'New file' }).click();
await page.locator('.wr-tree-item', { hasText: 'results.tex' }).waitFor({ timeout: 10000 });
await area.click();
// The editor closes the brace and puts the caret inside it on the next frame, as it does in the Playground.
await page.keyboard.type('\\section{');
await page.waitForTimeout(100);
await page.keyboard.type('Results');
answers.push('figures');
await page.locator('.wr-side-head input[type=file]').setInputFiles({ name: 'load.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex') });
await page.locator('.wr-tree-item', { hasText: 'load.png' }).waitFor({ timeout: 10000 });
answers.push('sections/old.tex');
await page.locator('.wr-file-ops').getByRole('button', { name: 'New file' }).click();
await page.locator('.wr-tree-item', { hasText: 'old.tex' }).waitFor({ timeout: 10000 });
answers.push('sections/renamed.tex');
await page.locator('.wr-tree-row', { hasText: 'old.tex' }).hover();
await page.locator('.wr-tree-row', { hasText: 'old.tex' }).getByRole('button', { name: /Rename/ }).click();
await page.locator('.wr-tree-item', { hasText: 'renamed.tex' }).waitFor({ timeout: 10000 });
answers.push(true);
await page.locator('.wr-tree-row', { hasText: 'renamed.tex' }).hover();
await page.locator('.wr-tree-row', { hasText: 'renamed.tex' }).getByRole('button', { name: /Delete/ }).click();
await page.waitForFunction(() => ![...document.querySelectorAll('.wr-tree-item')].some((el) => /renamed\.tex/.test(el.textContent ?? '')), null, { timeout: 10000 }).catch(() => {});
await page.waitForFunction(() => /Synced with Overleaf/.test(document.querySelector('.wr-status')?.textContent ?? '') && !/Syncing/.test(document.querySelector('.wr-status')?.textContent ?? ''), null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(6000);
check('a new file, with what was typed in it, is in Overleaf', /\\section\{Results\}/.test(remoteFile('sections/results.tex') ?? ''), String(remoteFile('sections/results.tex')).slice(0, 40));
check('an uploaded figure is in Overleaf', remoteFile('figures/load.png') !== null);
check('a renamed and then deleted file is not', remoteFile('sections/old.tex') === null && remoteFile('sections/renamed.tex') === null);
await shot('write-files');

console.log('leaving the tab: what was typed goes to Overleaf');
await page.locator('.wr-tree-item', { hasText: 'results.tex' }).click();
await area.click();
await page.keyboard.press('Control+End');
await page.keyboard.type(' Typed just before leaving.');
await page.locator('.pj-views').getByRole('button', { name: 'Overview' }).click();
await page.waitForTimeout(6000);
check('it is saved and synced on the way out', /Typed just before leaving/.test(remoteFile('sections/results.tex') ?? ''));

console.log('it sticks: the folder, the compiler, the main document');
await page.goto(`${BASE}/project/?id=p-moe&view=write`, { waitUntil: 'networkidle' });
await page.locator('.wr-desk').waitFor({ timeout: 15000 });
check('after a reload it opens on the paper, not the set-up', (await page.getByText('Where should the paper’s files be?').count()) === 0);
await page.getByRole('combobox', { name: 'Compiler' }).selectOption('xelatex');
await page.getByRole('combobox', { name: 'Main document' }).selectOption('main.tex');
await page.waitForTimeout(500);
await page.reload({ waitUntil: 'networkidle' });
await page.locator('.wr-desk').waitFor({ timeout: 15000 });
check('the compiler picked stays picked', (await page.getByRole('combobox', { name: 'Compiler' }).inputValue()) === 'xelatex');
check('so does the main document', (await page.getByRole('combobox', { name: 'Main document' }).inputValue()) === 'main.tex');
await page.getByRole('combobox', { name: 'Compiler' }).selectOption('pdflatex');
await page.waitForTimeout(500);

console.log('autocomplete, as in Overleaf');
await page.locator('.wr-tree-item', { hasText: 'results.tex' }).click();
const editorBox = page.locator('.wr-editor textarea');
await editorBox.click();
await page.keyboard.press('Control+End');
await page.keyboard.press('Enter');
await page.waitForTimeout(80);
await page.keyboard.type('\\subsec');
await page.locator('.ce-suggest').waitFor({ timeout: 5000 });
check('a backslash and a few letters bring the commands', /\\subsection\{\}/.test(await page.locator('.ce-suggest button.is-on').innerText()));
await shot('write-autocomplete');
await page.keyboard.press('Enter');
await page.waitForTimeout(120);
await page.keyboard.type('Setup');
check('↵ takes it, the caret in its argument', /\\subsection\{Setup\}/.test(await editorBox.inputValue()));
await page.keyboard.press('End');
await page.keyboard.press('Enter');
await page.waitForTimeout(80);
await page.keyboard.type('\\label{');
await page.waitForTimeout(120);
await page.keyboard.type('sec:setup');
await page.keyboard.press('End');
await page.keyboard.press('Enter');
await page.waitForTimeout(80);
await page.keyboard.type('\\begin{');
await page.waitForTimeout(120);
await page.keyboard.type('enu');
await page.locator('.ce-suggest').waitFor({ timeout: 5000 });
await page.keyboard.press('Enter');
await page.waitForTimeout(150);
await page.keyboard.type('First');
check('an environment comes with its \\end, the caret inside', /\\begin\{enumerate\}\n\s+\\item First\n\\end\{enumerate\}/.test(await editorBox.inputValue()), (await editorBox.inputValue()).slice(-80));
await page.keyboard.type(' as in~\\cite{');
await page.waitForTimeout(120);
await page.keyboard.type('fed');
await page.locator('.ce-suggest').waitFor({ timeout: 5000 });
check('\\cite{ offers the keys, from the .bib and the project', /fedus2021switch/.test(await page.locator('.ce-suggest').innerText()));
await page.keyboard.press('Enter');
await page.waitForTimeout(150);
check('the key goes in', /\\cite\{fedus2021switch\}/.test(await editorBox.inputValue()));
await page.keyboard.press('End');
await page.keyboard.type(' and~\\cite{');
await page.waitForTimeout(120);
await page.keyboard.type('zhou');
await page.locator('.ce-suggest').waitFor({ timeout: 5000 });
check('a project paper not in the .bib is offered too', /zhou2022mixture/.test(await page.locator('.ce-suggest').innerText()));
await page.keyboard.press('Enter');
await page.waitForTimeout(1800);
check('taking it brings its BibTeX entry into the .bib', /@\w+\{zhou2022mixture,/.test(readFileSync(join(root, 'papers/sparse-gated-moe/refs.bib'), 'utf8')));
await page.keyboard.press('End');
await page.keyboard.type(' See~\\ref{');
await page.waitForTimeout(120);
await page.keyboard.type('sec');
await page.locator('.ce-suggest').waitFor({ timeout: 5000 });
check('\\ref{ offers the paper’s labels', /sec:setup/.test(await page.locator('.ce-suggest').innerText()));
await page.keyboard.press('Escape');
await page.waitForTimeout(100);
check('Esc closes the list', (await page.locator('.ce-suggest').count()) === 0);
await page.keyboard.press('End');
await page.keyboard.type(' \\includegraphics{');
await page.waitForTimeout(150);
await page.keyboard.press('Control+Space');
await page.locator('.ce-suggest').waitFor({ timeout: 5000 }).catch(() => {});
check('Ctrl+Space asks: the figures for \\includegraphics', /figures\/load\.png/.test(await page.locator('.ce-suggest').innerText().catch(() => '')));
await page.keyboard.press('Escape');

console.log('a new paper from a conference template');
cloneFrom = blank;
answers.push(true);
await page.locator('.wr-side-foot').getByRole('button', { name: 'Change' }).click();
await page.getByText('Where should the paper’s files be?').waitFor({ timeout: 10000 });
check('the Overleaf token is known: not asked again', (await page.getByText('Your Overleaf account’s Git token is on this computer already').count()) === 1 && (await page.getByLabel('Overleaf Git token').count()) === 0);
await page.getByLabel('The template’s name').fill('NeurIPS 2026');
await page.locator('.wr-templates input[type=file]').setInputFiles(kit);
await page.locator('.wr-template.is-on', { hasText: 'NeurIPS 2026' }).waitFor({ timeout: 10000 });
check('the kit is kept as a template, and picked', (await page.locator('.wr-template', { hasText: 'NeurIPS 2026' }).innerText()).includes('2 files'));
await page.getByLabel('Folder, inside the Companion’s').fill('papers/neurips-paper');
await shot('write-template');
await page.getByRole('button', { name: 'Clone, and fill it from the template' }).click();
await page.locator('.wr-desk').waitFor({ timeout: 20000 });
await page.waitForTimeout(1500);
check('the template is in the Overleaf project at once', /usepackage\{neurips_2026\}/.test(remoteFile('neurips_2026.tex', blank) ?? '') && remoteFile('neurips_2026.sty', blank) !== null && /Start from a template/.test(sh('git', ['--git-dir', blank, 'log', '--format=%s', '-1'])));
check('and its paper is the main document', (await page.getByRole('combobox', { name: 'Main document' }).inputValue()) === 'neurips_2026.tex');
await page.locator('.wr-page').first().waitFor({ timeout: 60000 }).catch(() => {});
check('it compiles', (await page.locator('.wr-page').count()) >= 1);
await shot('write-from-template');

console.log('Settings: the Write tab’s choices');
await page.evaluate(() => window.dispatchEvent(new Event('reader:open-settings')));
const layout = page.getByRole('radiogroup', { name: 'The Write tab: The PDF' });
await layout.waitFor({ timeout: 5000 });
await layout.scrollIntoViewIfNeeded();
check('six choices, each with its default first and on', (await page.locator('.write-choice').count()) === 6 && (await layout.getByRole('radio').first().getAttribute('aria-checked')) === 'true');
check('the Write tab is the default way to write', /A Write tab · default/.test(await page.getByRole('radiogroup', { name: /Where a project’s paper is written/ }).innerText()));
await shot('write-settings');
await layout.getByRole('radio', { name: /A tab of its own/ }).click();
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('PDF in a tab of its own: source or PDF, one at a time', (await page.locator('.wr-panes.is-tabs').count()) === 1 && !(await page.locator('.wr-preview').isVisible()));

check('no errors on the page', !errors.length, errors.join(' | '));
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log('\nall good');
