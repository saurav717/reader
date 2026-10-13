/**
 * The guided tour (components/Tour.tsx): seeds a library, lets the tour start
 * on its own, walks every step — pressing the key each try-it step asks for —
 * and checks it is remembered as seen, comes back from Settings and the
 * palette, and does not start again on a reload. Writes a screenshot of each
 * step to .smoke/ (THEME=dark for the dark theme).
 *
 *   npm run build && npm start &
 *   node scripts/tour-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('./shots/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });
const THEME = process.env.THEME || 'light';
const GLASS = process.env.GLASS === '1';

const TITLE = 'Fourier Neural Operator for Parametric Partial Differential Equations';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

const printer = await browser.newPage();
const para = (n, i) =>
  `<p>In section ${n}, paragraph ${i}: the neural operator is formulated as an iterative architecture in which each update composes a non-local integral operator with a local, nonlinear activation function, so that the same parameters can be evaluated on any discretisation of the domain.</p>`;
const section = (n) =>
  `<section style="break-after: page"><h2>${n} Section ${n}</h2>${[1, 2, 3].map((i) => para(n, i)).join('')}<p style="text-align:center;font-style:italic">(K(φ)v)(x) = F⁻¹(R · (Fv))(x) &nbsp; (${n})</p>${[4, 5, 6, 7].map((i) => para(n, i)).join('')}</section>`;
await printer.setContent(
  `<!doctype html><html><body style="font-family: serif; font-size: 12pt; line-height: 1.45; margin: 0 1in"><h1 style="text-align:center">${TITLE}</h1><p style="text-align:center">Zongyi Li · Nikola Kovachki</p>${[1, 2, 3, 4, 5, 6].map(section).join('')}</body></html>`,
);
const PDF = await printer.pdf({ format: 'Letter', printBackground: true, margin: { top: '0.8in', bottom: '0.8in' } });
await printer.close();

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.route('**/pdf?*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }));
await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|fonts\.)/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
await context.route('**/api.openalex.org/works*', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      results: [
        ['W1', 'Geometry-Informed Neural Operator for Large-Scale 3D PDEs', 'Z Li', 210],
        ['W2', 'Adaptive Fourier Neural Operators: Efficient Token Mixers for Transformers', 'J Guibas', 480],
        ['W3', 'Physics-Informed Neural Operator for Learning Partial Differential Equations', 'Z Li', 900],
      ].map(([id, title, author, cited]) => ({ id: `https://openalex.org/${id}`, display_name: title, publication_date: '2023-01-01', authorships: [{ author: { display_name: author } }], cited_by_count: cited })),
    }),
  }),
);

let page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

const ago = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString();
const paper = (id, title, authors, extra) => ({ id, source: 'scholar', title, authors, abstract: '', published: '', categories: [], addedAt: ago(240), collectionIds: ['c-reading'], tags: [], progress: 0, ...extra });
const PAPERS = [
  paper('scholar:fno', TITLE, ['Zongyi Li', 'Nikola Kovachki', 'Kamyar Azizzadenesheli'], { venue: 'ICLR', published: '2021-01-01', pdfUrl: 'https://example.org/fno.pdf', abstract: 'We formulate a new neural operator by parameterizing the integral kernel directly in Fourier space.', progress: 0.1, lastOpenedAt: ago(2) }),
  paper('scholar:moe', 'A comprehensive survey of mixture-of-experts: Algorithms, theory, and applications', ['S Mu', 'S Lin'], { published: '2025-01-01', progress: 0.63, lastOpenedAt: ago(50) }),
  paper('scholar:op', 'Neural Operator: Learning Maps Between Function Spaces', ['N Kovachki', 'Z Li'], { published: '2023-01-01', progress: 0.18, lastOpenedAt: ago(96) }),
  paper('scholar:pinn', 'Physics-informed neural networks', ['M Raissi', 'P Perdikaris', 'GE Karniadakis'], { published: '2019-01-01', addedAt: ago(20) }),
  paper('scholar:don', 'DeepONet: Learning nonlinear operators', ['L Lu', 'P Jin'], { published: '2021-01-01', addedAt: ago(70) }),
];

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(
  async ({ papers, theme, glass }) => {
    localStorage.setItem('reader.welcomed', 'true');
    localStorage.setItem('reader.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('reader.settings') || '{}'), theme, userName: 'Saurav', ...(glass ? { glass: true, glassWall: 'spotlight' } : {}) }));
    localStorage.removeItem('reader.tour');
    localStorage.setItem('reader.home', JSON.stringify({ opensOn: 'search', tabs: ['search', 'continue', 'today', 'inbox', 'board'], last: 'search', clearPanels: true, v: 2 }));
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('reader', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const put = (store, value) => new Promise((resolve, reject) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    const clear = (store) => new Promise((resolve) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).clear(); tx.oncomplete = resolve; });
    await clear('papers'); await clear('collections'); await clear('highlights');
    await put('collections', { id: 'c-reading', name: 'Reading list', color: '#2f7d6d', createdAt: new Date().toISOString() });
    for (const p of papers) await put('papers', p);
    const at = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
    await put('highlights', { id: 'h1', paperId: 'scholar:fno', color: 'green', exact: 'the same parameters can be evaluated on any discretisation of the domain', prefix: '', suffix: '', hint: 0, tags: [], createdAt: at(30), note: 'Where does this come from?' });
    await put('highlights', { id: 'h2', paperId: 'scholar:moe', color: 'blue', exact: 'sparse gating selects the top-k experts per token', prefix: '', suffix: '', hint: 0, tags: [], createdAt: at(3000) });
    db.close();
  },
  { papers: PAPERS, theme: THEME, glass: GLASS },
);

// A new visit: the tour should start on its own.
await page.close();
page = await context.newPage();
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto(BASE, { waitUntil: 'networkidle' });
const skip = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
if (await skip.isVisible().catch(() => false)) await skip.click();

const shot = async (name) => { await page.waitForTimeout(450); await page.screenshot({ path: `${OUT}/${THEME}${GLASS ? '-glass' : ''}-${name}.png` }); console.log('  shot', name); };
const stepIs = (id) => page.waitForSelector(`.tour[data-step="${id}"] .tour-card`, { timeout: 15000 });
const next = () => page.locator('.tour-card .btn.primary').click();
const tried = async () => { await page.waitForSelector('.tour-try.is-done', { timeout: 8000 }); };

await stepIs('welcome');
await shot('01-welcome');
await next();
await stepIs('rail'); await shot('02-rail');
await next();
await stepIs('views'); await shot('03-views');
await page.keyboard.press('2'); await tried(); await shot('03b-views-tried');
await stepIs('find'); await shot('04-find');
await next();
await stepIs('palette'); await shot('05-palette');
await page.keyboard.press('Control+k'); await tried(); await shot('05b-palette-open');
await stepIs('reading'); await page.waitForSelector('.reader-head', { timeout: 15000 }); await shot('06-reading');
await next();
await stepIs('highlights'); await shot('07-highlights');
await page.keyboard.press('h'); await tried(); await shot('07b-highlights-open');
await stepIs('ask'); await shot('08-ask');
await page.keyboard.press('Control+\\'); await tried(); await shot('08b-ask-open');
await stepIs('explain'); await shot('09-explain');
await next();
await stepIs('zen'); await shot('10-zen');
await page.keyboard.press('z'); await tried(); await shot('10b-zen-on');
await stepIs('home'); await shot('11-home');
await page.keyboard.press('g'); await tried(); await shot('11b-home-back');
await stepIs('code'); await shot('12-code');
await next();
await stepIs('library'); await shot('13-library');
await next();
await stepIs('settings'); await shot('13b-settings');
await next();
await stepIs('done'); await shot('14-done');
await next();
await page.waitForSelector('.tour', { state: 'detached' });
console.log('tour seen:', await page.evaluate(() => localStorage.getItem('reader.tour')));

// Where it comes back from.
await page.locator('.rail [aria-label="Settings"]').click();
const tourSection = page.getByText('Guided tour');
await tourSection.scrollIntoViewIfNeeded();
await shot('15-settings-replay');
await page.getByRole('button', { name: 'Take the tour' }).click();
await stepIs('welcome');
await page.keyboard.press('Escape');
await page.waitForSelector('.tour', { state: 'detached' });
await page.keyboard.press('Control+k');
await page.waitForSelector('.palette');
await page.keyboard.type('tour');
await shot('16-palette-replay');
await page.keyboard.press('Escape');

// A reload does not start it again.
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);
console.log('tour after reload:', await page.locator('.tour').count());
console.log('errors:', errors);
await browser.close();
