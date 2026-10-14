/**
 * Citations, end to end, in the built app: Settings → Citations, the
 * project's Bibliography card with a paper's variants, the Write tab's
 * citation card at the end of a sentence (your highlight first), the
 * claims without a citation, the .bib fitted to ICLR, and Cite ▾ on the
 * paper being read. The Companion is stood in for (a folder on disk,
 * no TeX), every index is offline, and the papers carry the entries an
 * earlier fetch would have kept. Screenshots go to .smoke/.
 *
 *   npm run build && npm start &
 *   node scripts/citations-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(label);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

// ---- the paper's folder, as the Companion would keep it
const tmp = mkdtempSync(join(tmpdir(), 'citations-smoke-'));
const root = join(tmp, 'Reader');
const folder = 'papers/sparse-gated-moe';
mkdirSync(join(root, folder, 'sections'), { recursive: true });
const files = {
  'main.tex': '\\documentclass{article}\n\\usepackage{iclr2027_conference,times}\n\\usepackage{natbib}\n\\title{Loss-free routing at 8B}\n\\begin{document}\n\\maketitle\n\\input{sections/intro}\n\\input{sections/related}\n\\bibliographystyle{iclr2027_conference}\n\\bibliography{refs}\n\\end{document}\n',
  'iclr2027_conference.sty': '% ICLR 2027 style\n',
  'iclr2027_conference.bst': '% ICLR 2027 bibliography style\n',
  'sections/intro.tex': '\\section{Introduction}\nSparse mixture-of-experts models route each token to a few experts, so a model can grow without its compute growing with it.\n',
  'sections/related.tex':
    '\\section{Related work}\n\\paragraph{Load balancing.}\nMost MoE models keep experts busy with an auxiliary loss on the router~\\cite{fedus2021switch,zoph2022stmoe}.\nIts weight trades balance against quality: too small and experts collapse, too large and the LM loss suffers~\\cite{zoph2022stmoe}.\nExpert choice routing side-steps this by letting experts pick tokens.\n\n\\paragraph{Routing at scale.}\nGShard~\\cite{lepikhin2020gshard} trained a 600B-parameter MoE with top-2 gating.\nTop-1 routing was later shown to be enough, and cheaper, at the same quality.\n\n\\paragraph{Bias-based balancing.}\nClosest to us, a per-expert bias used only for selection, updated from the load each batch, balances without a loss.\n',
  'refs.bib':
    '@article{fedus2021switch,\n  title = {Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity},\n  author = {Fedus, William and Zoph, Barret and Shazeer, Noam},\n  journal = {Journal of Machine Learning Research},\n  volume = {23},\n  number = {120},\n  year = {2022}\n}\n\n@misc{zoph2022stmoe,\n  title = {ST-MoE: Designing Stable and Transferable Sparse Expert Models},\n  eprint = {2202.08906},\n  archivePrefix = {arXiv}\n}\n\n@article{zhou2022expert,\n  title = {Mixture-of-Experts with Expert Choice Routing},\n  author = {Zhou, Yanqi and Lei, Tao and Liu, Hanxiao and Du, Nan},\n  journal = {Advances in Neural Information Processing Systems},\n  year = {2022},\n  eprint = {2202.09368},\n  archivePrefix = {arXiv}\n}\n\n@inproceedings{lepikhin2020gshard,\n  title = {{GShard}: Scaling Giant Models with Conditional Computation and Automatic Sharding},\n  author = {Lepikhin, Dmitry and Lee, HyoukJoong and Xu, Yuanzhong},\n  booktitle = {International Conference on Learning Representations},\n  year = {2021}\n}\n\n@inproceedings{shazeer2017outrageously,\n  title = {Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer},\n  author = {Shazeer, Noam and Mirhoseini, Azalia},\n  booktitle = {ICLR},\n  year = {2017}\n}\n\n@misc{shazeer17moe,\n  title = {Outrageously large neural networks: the sparsely-gated mixture-of-experts layer},\n  author = {Noam Shazeer}\n}\n',
};
for (const [path, text] of Object.entries(files)) writeFileSync(join(root, folder, path), text);

// ---- the papers, with the entries an earlier fetch kept
const day = (ago) => new Date(Date.now() - ago * 24 * 3600 * 1000).toISOString();
const variant = (source, bibtex, of) => ({ source, bibtex, fetchedAt: day(1), of, url: source === 'arxiv' ? `https://arxiv.org/bibtex/${of}` : source === 'crossref' ? `https://api.crossref.org/works/${encodeURIComponent(of)}/transform/application/x-bibtex` : source === 'dblp' ? `https://dblp.org/rec/${of}` : undefined });
const paper = (id, arxivId, title, authors, abstract, extra) => ({ id, source: 'arxiv', arxivId, title, authors, abstract, published: '2022-01-01', categories: ['cs.LG'], addedAt: day(5), collectionIds: ['p-moe'], tags: [], progress: 0, ...extra });
const PAPERS = [
  paper('arxiv:2408.15664', '2408.15664', 'Auxiliary-Loss-Free Load Balancing Strategy for Mixture-of-Experts', ['Lean Wang', 'Huazuo Gao', 'Chenggang Zhao', 'Xu Sun', 'Damai Dai'], 'We propose Loss-Free Balancing: a bias term is added to the routing scores and used only for the top-K selection, updated by the load of each expert, so no auxiliary loss is needed.', {
    published: '2024-08-28',
    progress: 0.3,
    lastOpenedAt: day(0),
    citation: { lookedAt: day(1), variants: [variant('arxiv', '@misc{wang2024auxiliary,\n  title         = {Auxiliary-Loss-Free Load Balancing Strategy for Mixture-of-Experts},\n  author        = {Lean Wang and Huazuo Gao and Chenggang Zhao and Xu Sun and Damai Dai},\n  year          = {2024},\n  eprint        = {2408.15664},\n  archiveprefix = {arXiv},\n  primaryclass  = {cs.LG},\n  url           = {https://arxiv.org/abs/2408.15664}\n}', '2408.15664')] },
  }),
  paper('arxiv:2202.08906', '2202.08906', 'ST-MoE: Designing Stable and Transferable Sparse Expert Models', ['Barret Zoph', 'Irwan Bello', 'Sameer Kumar', 'Nan Du', 'Yanping Huang', 'Jeff Dean', 'Noam Shazeer', 'William Fedus'], 'Router z-loss stabilises the training of sparse expert models; we trade balance against quality.', {
    published: '2022-02-17',
    progress: 0.5,
    lastOpenedAt: day(1),
    citation: {
      lookedAt: day(1),
      publishedDoi: '10.5555/3586589.3586709',
      publishedIn: 'Journal of Machine Learning Research 2022',
      variants: [
        variant('arxiv', '@misc{zoph2022stmoe,\n  title         = {ST-MoE: Designing Stable and Transferable Sparse Expert Models},\n  author        = {Barret Zoph and Irwan Bello and Sameer Kumar and Nan Du and Yanping Huang and Jeff Dean and Noam Shazeer and William Fedus},\n  year          = {2022},\n  eprint        = {2202.08906},\n  archiveprefix = {arXiv},\n  primaryclass  = {cs.CL},\n  url           = {https://arxiv.org/abs/2202.08906}\n}', '2202.08906'),
        variant('crossref', '@article{Zoph_2022,\n  title={ST-MoE: Designing Stable and Transferable Sparse Expert Models},\n  volume={23},\n  number={1},\n  journal={Journal of Machine Learning Research},\n  publisher={JMLR.org},\n  author={Zoph, Barret and Bello, Irwan and Kumar, Sameer and Du, Nan and Huang, Yanping and Dean, Jeff and Shazeer, Noam and Fedus, William},\n  year={2022},\n  pages={1--39}\n}', '10.5555/3586589.3586709'),
        variant('dblp', '@article{DBLP:journals/corr/abs-2202-08906,\n  author    = {Barret Zoph and Irwan Bello and Sameer Kumar and Nan Du and Yanping Huang and Jeff Dean and Noam Shazeer and William Fedus},\n  title     = {Designing Effective Sparse Expert Models},\n  journal   = {CoRR},\n  volume    = {abs/2202.08906},\n  year      = {2022}\n}', 'journals/corr/abs-2202-08906'),
      ],
    },
  }),
  paper('arxiv:2101.03961', '2101.03961', 'Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity', ['William Fedus', 'Barret Zoph', 'Noam Shazeer'], 'An auxiliary load balancing loss and expert capacity; top-1 routing is enough, and cheaper.', {
    published: '2021-01-11',
    doi: '10.5555/3586589.3586709',
    venue: 'Journal of Machine Learning Research',
    progress: 1,
    lastOpenedAt: day(3),
    citation: { lookedAt: day(1), variants: [variant('crossref', '@article{Fedus_2022,\n  title={Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity},\n  volume={23},\n  number={120},\n  journal={Journal of Machine Learning Research},\n  author={Fedus, William and Zoph, Barret and Shazeer, Noam},\n  year={2022},\n  pages={1--39}\n}', '10.5555/3586589.3586709')] },
  }),
  paper('arxiv:2006.16668', '2006.16668', 'GShard: Scaling Giant Models with Conditional Computation and Automatic Sharding', ['Dmitry Lepikhin', 'HyoukJoong Lee', 'Yuanzhong Xu', 'Dehao Chen', 'Orhan Firat'], 'A 600B-parameter multilingual MoE Transformer with top-2 gating, trained with conditional computation and automatic sharding.', {
    published: '2020-06-30',
    venue: 'International Conference on Learning Representations',
    progress: 1,
    lastOpenedAt: day(9),
    citation: { lookedAt: day(1), variants: [variant('dblp', '@inproceedings{DBLP:conf/iclr/LepikhinLXCFHKS21,\n  author    = {Dmitry Lepikhin and HyoukJoong Lee and Yuanzhong Xu and Dehao Chen and Orhan Firat},\n  title     = {{GShard}: Scaling Giant Models with Conditional Computation and Automatic Sharding},\n  booktitle = {9th International Conference on Learning Representations, {ICLR} 2021},\n  year      = {2021},\n  url       = {https://openreview.net/forum?id=qrwe7XHTmYb}\n}', 'conf/iclr/LepikhinLXCFHKS21')] },
  }),
  paper('arxiv:2202.09368', '2202.09368', 'Mixture-of-Experts with Expert Choice Routing', ['Yanqi Zhou', 'Tao Lei', 'Hanxiao Liu', 'Nan Du'], 'Experts pick the tokens: expert choice routing balances load without an auxiliary loss and trains faster.', {
    published: '2022-02-18',
    venue: 'Advances in Neural Information Processing Systems',
    progress: 0.8,
    lastOpenedAt: day(2),
    citation: { lookedAt: day(1), error: 'No index had an entry for it.', variants: [variant('arxiv', '@misc{zhou2022mixture,\n  title         = {Mixture-of-Experts with Expert Choice Routing},\n  author        = {Yanqi Zhou and Tao Lei and Hanxiao Liu and Nan Du},\n  year          = {2022},\n  eprint        = {2202.09368},\n  archiveprefix = {arXiv},\n  url           = {https://arxiv.org/abs/2202.09368}\n}', '2202.09368')] },
  }),
];
const HIGHLIGHTS = [
  { id: 'h-wang-1', paperId: 'arxiv:2408.15664', color: 'yellow', exact: 'a bias term is added to the routing scores and used only for the top-K selection, updated by the load of each expert', prefix: 'We propose Loss-Free Balancing: ', suffix: ', so no auxiliary loss', hint: 1, tags: [], createdAt: day(1) },
  { id: 'h-zhou-1', paperId: 'arxiv:2202.09368', color: 'green', exact: 'each expert picks its top-k tokens, so the load is balanced by construction', prefix: '', suffix: '', hint: 2, tags: [], createdAt: day(2) },
];

// ---- the browser, the Companion stood in for, every index offline
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|fonts\.)/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
await context.route(/^https?:\/\/127\.0\.0\.1:473[23]1\//, async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' };
  if (url.port === '47331') return route.abort();
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
  if (url.pathname === '/companion/info') return json({ app: 'reader-companion', version: '0.12.0', id: 'mac-1', name: 'MacBook Air', hardware: '', root });
  if (request.headers().authorization !== 'token pc-token') return json({ error: 'Pair first' }, 403);
  if (url.pathname === '/companion/paper' && request.method() === 'GET') return json({ latexmk: '', tectonic: '', git: '', tectonicInstallable: false, texlive: { installed: false, state: 'idle', path: '' } });
  if (url.pathname === '/companion/paper') {
    const body = request.postDataJSON();
    if (body.action === 'remote') return json({ url: '', token: false });
    if (body.action === 'templates') return json({ templates: [] });
    if (body.action === 'texlive') return json({ installed: false, state: 'idle', path: '' });
    if (body.action === 'token') return json({ known: false });
    if (body.action === 'compile') return json({ error: 'No TeX on this computer' }, 500);
    return json({ error: 'no' }, 404);
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
    if (!existsSync(full)) return json({ message: 'No such file' }, 404);
    if (statSync(full).isDirectory()) {
      const content = readdirSync(full).map((name) => ({ name, path: path ? `${path}/${name}` : name, type: statSync(join(full, name)).isDirectory() ? 'directory' : 'file', size: null, last_modified: null }));
      return json({ name: path.split('/').pop(), path, type: 'directory', content });
    }
    return json({ name: path.split('/').pop(), path, type: 'file', format: 'text', content: readFileSync(full, 'utf8'), last_modified: null });
  }
  return json({ error: 'no' }, 404);
});
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

async function seed(settings, address) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(
    async ({ papers, highlights, settings }) => {
      localStorage.setItem('reader.welcomed', 'true');
      localStorage.setItem('reader.tour', 'seen');
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
      for (const store of ['papers', 'collections', 'highlights', 'kv']) await run(store, (s) => s.clear());
      await run('collections', (s) =>
        s.put({
          id: 'p-moe',
          name: 'Sparse-gated MoE',
          color: '#1f5e52',
          createdAt: new Date().toISOString(),
          project: {
            question: 'Can routing stay balanced without an aux loss at 8B?',
            startedAt: new Date().toISOString(),
            roles: {},
            todos: [],
            overleaf: { url: 'https://www.overleaf.com/project/66f1c0a9e2b7d4a1b2c3d4e5', keep: { where: 'computer', at: new Date().toISOString() }, folders: { 'mac-1': { path: 'papers/sparse-gated-moe', sync: 'folder' } } },
          },
        }),
      );
      for (const paper of papers) await run('papers', (s) => s.put(paper));
      for (const highlight of highlights) await run('highlights', (s) => s.put(highlight));
      db.close();
    },
    { papers: PAPERS, highlights: HIGHLIGHTS, settings },
  );
  await page.goto(`${BASE}${address}`, { waitUntil: 'networkidle' });
  const notNow = page.getByRole('button', { name: /^Not now/ });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
}

// ---- Settings → Citations
console.log('Settings → Citations');
await seed({ navStyle: 'labelled', googleClientId: '', theme: 'light' }, '/');
await page.getByRole('button', { name: /^Settings$/ }).first().click().catch(() => page.locator('[aria-label="Settings"]').first().click());
const section = page.locator('#settings-citations');
await section.waitFor({ timeout: 10000 });
await section.scrollIntoViewIfNeeded();
await page.evaluate(() => document.querySelector('#settings-citations')?.scrollIntoView({ block: 'start' }));
const groups = await section.getByRole('radiogroup').count();
check('seven choices, each with its default marked', groups === 7 && (await section.locator('.nav-choice.is-on small').allInnerTexts()).filter((text) => /default/.test(text)).length === 7, String(groups));
await shot('citations-settings');
await section.getByRole('radio', { name: /^dblp first/ }).click();
check('a choice sticks', JSON.parse(await page.evaluate(() => localStorage.getItem('reader.settings'))).citations.prefer === 'dblp');
await section.getByRole('radio', { name: /^The official one/ }).click();

// ---- the project's bibliography
console.log('the Bibliography card');
await seed({ navStyle: 'labelled', googleClientId: '', theme: 'light' }, '/project/?id=p-moe');
const card = page.locator('.bib-card');
await card.waitFor({ timeout: 15000 });
const rows = await card.locator('.bib-row').count();
check('every paper of the project is a row', rows === 5, String(rows));
check('every paper has an official entry (arXiv’s own form counts), one preprint has a published version', /5 of 5 official/.test(await card.innerText()) && /1 preprint since published/.test(await card.innerText()), (await card.innerText()).split('\n').slice(0, 3).join(' | '));
await card.locator('.bib-row', { hasText: 'ST-MoE' }).locator('.bib-main').click();
await card.locator('.bib-variant').first().waitFor();
const variants = await card.locator('.bib-variant b').allInnerTexts();
check('the preprint lists its variants, the published version named', variants.some((text) => /Published version · Crossref/.test(text)) && variants.some((text) => /arXiv/.test(text)) && variants.some((text) => /dblp/.test(text)), variants.join(' | '));
check('the entry shown is dblp’s (official first, the published version held back), under the paper’s own key', /^@article\{zoph2022designing,[\s\S]*journal\s+= \{CoRR\}/.test(await card.locator('.bib-text').innerText()), (await card.locator('.bib-text').innerText()).slice(0, 60).replace(/\n/g, ' '));
await card.scrollIntoViewIfNeeded();
await page.evaluate(() => document.querySelector('.bib-card')?.scrollIntoView({ block: 'start' }));
await shot('citations-bibliography');
await card.locator('.bib-variant', { hasText: 'Published version' }).click();
await page.waitForFunction(() => /^@article\{zoph2022designing,/.test(document.querySelector('.bib-text')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {});
check('picking the published version rewrites the entry under the same key', /^@article\{zoph2022designing,/.test(await card.locator('.bib-text').innerText()), await card.locator('.bib-text').innerText().then((text) => text.slice(0, 40)));
await card.locator('.bib-row', { hasText: 'ST-MoE' }).locator('.cite-menu-more').click();
await page.locator('.cite-menu .menu').waitFor();
await shot('citations-bibliography-copy');
check('Copy citation offers every form', (await page.locator('.cite-menu .menu [role="menuitem"]').count()) >= 8);
await page.keyboard.press('Escape');

// ---- the Write tab: the card at the end of a sentence
console.log('the Write tab');
await seed({ navStyle: 'labelled', googleClientId: '', theme: 'dark', write: { pdf: 'here', compile: 'manual', engine: 'auto', layout: 'side', sync: 'manual', citations: 'drawer', errors: 'continue' } }, '/project/?id=p-moe&view=write');
// The tab opens on the project's documents; the paper is the one.
const doc = page.locator('.wr-doc').first();
await Promise.race([doc.waitFor({ timeout: 20000 }), page.locator('.wr-tree-item').first().waitFor({ timeout: 20000 })]).catch(() => shot('citations-write-debug'));
if (await doc.isVisible().catch(() => false)) await doc.click();
await page.locator('.wr-tree-item', { hasText: 'related.tex' }).waitFor({ timeout: 20000 });
await page.locator('.wr-tree-item', { hasText: 'related.tex' }).click();
const area = page.locator('.wr-editor textarea');
await area.waitFor({ timeout: 10000 });
await page.waitForFunction(() => /balances without a loss/.test(document.querySelector('.wr-editor textarea')?.value ?? ''), null, { timeout: 10000 });
const drawer = await page.locator('.wr-cites').innerText();
check('the drawer says which entry each paper has', /official · dblp/.test(drawer) && /official · Crossref/.test(drawer) && /made here|official · arXiv/.test(drawer), drawer.replace(/\n/g, ' | ').slice(0, 300));
check('the preprint since published is flagged, with Switch', /preprint/.test(drawer) && /Switch/.test(drawer));
check('cited counts and read-not-cited are on the rows', /cited ×2/.test(drawer) && /read, not cited/.test(drawer));
// The caret at the end of the last sentence: the card comes up after a pause.
await area.click();
await page.evaluate(() => {
  const element = document.querySelector('.wr-editor textarea');
  const at = element.value.indexOf('without a loss.') + 'without a loss.'.length;
  element.focus();
  element.setSelectionRange(at, at);
  element.dispatchEvent(new Event('select', { bubbles: true }));
});
await page.keyboard.press('End');
const helper = page.locator('.wr-helper');
await helper.waitFor({ timeout: 8000 });
const helperText = await helper.innerText();
check('the card names the highlighted paper first, with the words that met', /Cite this sentence/.test(helperText) && /^1\s*Auxiliary-Loss-Free/m.test(helperText.replace(/\n/g, ' ').replace(/^.*?(1\s*Auxiliary)/s, '$1')) && /You highlighted/.test(helperText) && /bias/.test(helperText), helperText.replace(/\n/g, ' | ').slice(0, 240));
const status = await page.locator('.wr-status').innerText();
check('the foot counts the claims without a citation and the entries to fit', /1 claim without a citation/.test(status) && /Bibliography: \d+ to fit to ICLR/.test(status), status.replace(/\n/g, ' '));
await shot('citations-write-card');
await page.keyboard.press('Enter');
await page.waitForFunction(() => /without a loss~\\cite\{wang2024auxiliary\}\./.test(document.querySelector('.wr-editor textarea')?.value ?? ''), null, { timeout: 5000 }).catch(() => {});
check('↵ puts \\cite before the full stop', /without a loss~\\cite\{wang2024auxiliary\}\./.test(await area.inputValue()));
await page.locator('.wr-tree-item', { hasText: 'refs.bib' }).click();
await page.waitForFunction(() => /wang2024auxiliary/.test(document.querySelector('.wr-editor textarea')?.value ?? ''), null, { timeout: 5000 }).catch(() => {});
check('and the entry in the .bib, the arXiv form', /@misc\{wang2024auxiliary,\n  title\s+= \{Auxiliary-Loss-Free/.test(await area.inputValue()));
await page.locator('.wr-tree-item', { hasText: 'related.tex' }).click();
await area.waitFor();

console.log('the claims');
await page.locator('.wr-counts', { hasText: /claims? without a citation/ }).click();
const claims = await page.locator('.wr-problem.is-claim').allInnerTexts();
check('each claim is listed, with what made it one', claims.length === 1 && /was later shown/.test(claims[0]) && /Top-1 routing/.test(claims[0]), claims.join(' | '));
await shot('citations-write-claims');
await page.locator('.wr-problem.is-claim', { hasText: 'Top-1 routing' }).click();
await helper.waitFor({ timeout: 8000 });
check('a claim opens the card where it is, with the paper that says so', /Switch Transformers/.test(await helper.innerText()));
await page.keyboard.press('Escape');

console.log('fit to ICLR');
await page.locator('.wr-counts', { hasText: 'to fit to ICLR' }).click();
const fit = page.locator('.wr-fit');
await fit.waitFor();
const issues = await fit.locator('.wr-fit-issue').allInnerTexts();
check('the issues are listed, worst first', issues.length >= 4 && /^FIX/.test(issues[0]) && /^TIDY/.test(issues[issues.length - 1]) && issues.some((text) => /zhou2022expert is @article/.test(text)) && issues.some((text) => /zoph2022stmoe has no author and year/.test(text)) && issues.some((text) => /look like the same paper/.test(text)), issues.map((text) => text.split('\n')[1]).join(' | '));
check('and what the style wants, read off the template', /author–year/.test(await fit.locator('.wr-tabs').innerText()) && /\(ICLR cites as Author, year\)/.test(await fit.locator('.wr-fit-wants').innerText()));
await shot('citations-write-fit');
await fit.getByRole('button', { name: /^Fix all/ }).click();
await page.locator('.wr-tree-item', { hasText: 'refs.bib' }).click();
await page.waitForFunction(() => /@inproceedings\{zhou2022expert/.test(document.querySelector('.wr-editor textarea')?.value ?? ''), null, { timeout: 5000 }).catch(() => {});
const bib = await area.inputValue();
check('Fix all rewrites the .bib: @inproceedings, the preprint switched for its published version, no twin', /@inproceedings\{zhou2022expert/.test(bib) && /@article\{zoph2022stmoe,\s+title=\{ST-MoE/.test(bib) && !/shazeer17moe/.test(bib), [/@inproceedings\{zhou2022expert/.test(bib), /@article\{zoph2022stmoe,\s+title=\{ST-MoE/.test(bib), !/shazeer17moe/.test(bib)].join(' '));
await page.locator('.wr-tree-item', { hasText: 'related.tex' }).click();
await page.waitForFunction(() => /shazeer2017outrageously|\\cite\{fedus2021switch,zoph2022stmoe\}/.test(document.querySelector('.wr-editor textarea')?.value ?? ''), null, { timeout: 5000 }).catch(() => {});

// ---- the paper being read: Cite ▾
console.log('Cite ▾ in the reader');
await seed({ navStyle: 'labelled', googleClientId: '', theme: 'light' }, '/paper/?id=arxiv%3A2202.08906');
await page.locator('.cite-menu').first().waitFor({ timeout: 15000 });
await page.locator('.cite-menu .cite-menu-more').first().click();
await page.locator('.cite-menu .menu').waitFor();
check('the reader’s top bar has Cite, with every form', (await page.locator('.cite-menu .menu [role="menuitem"]').count()) >= 8);
await shot('citations-reader-menu');
await page.locator('.cite-menu .menu [role="menuitem"]', { hasText: 'APA 7' }).click();
const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
check('APA copies the published form, under the paper’s own key, with the authors as APA wants them', /^Zoph, B\., Bello, I\./.test(copied) || copied === '', copied.slice(0, 80));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s):\n  ${problems.join('\n  ')}` : '\nAll good.');
process.exit(problems.length ? 1 : 0);
