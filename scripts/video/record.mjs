/**
 * Records the showcase (components/Showcase.tsx) as raw footage for a video:
 * the app driven by its own pointer on the real "Attention Is All You Need",
 * with the model and Colab replayed by the page, the scene cards hidden, and
 * every frame captured through Chrome's screencast at twice the pixels, so
 * the edit can zoom in without going soft. Writes .video/raw/: frames, a
 * timeline of when each scene began, and raw.mp4 at a constant 30 fps.
 *
 *   npm run build && npm start &
 *   node scripts/video/record.mjs          # VIDEO_BASE=http://localhost:8080 THEME=light|dark|koios
 *
 * Fonts: Google Fonts is often out of reach from a recording machine, so the
 * app's three faces are served from .video/fonts when they are there:
 *   npm i --prefix .video/fonts @fontsource/ibm-plex-sans @fontsource/ibm-plex-mono @fontsource-variable/newsreader
 */
import { chromium } from 'playwright';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const BASE = process.env.VIDEO_BASE || 'http://localhost:8080';
const OUT = path.join(ROOT, '.video/raw');
const FONTS = path.join(ROOT, '.video/fonts/node_modules');
const THEME = process.env.THEME || 'light';
const VIEWPORT = { width: 1536, height: 864 }; // 16:9; at scale 2 the frames are 3072×1728
const SCALE = Number(process.env.SCALE || 2);
const FPS = 30;

await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(OUT, 'frames'), { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE });

// ------------------------------------------------------------ the world ---

// The paper itself, from arXiv, kept so a second take needs no network.
const pdfPath = path.join(ROOT, '.video/attention.pdf');
if (!existsSync(pdfPath)) {
  const response = await fetch('https://arxiv.org/pdf/1706.03762');
  if (!response.ok) throw new Error(`arXiv answered ${response.status} for the PDF`);
  await writeFile(pdfPath, Buffer.from(await response.arrayBuffer()));
}
const PDF = await readFile(pdfPath);
const TITLE = 'Attention Is All You Need';

await context.route('**/pdf?*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }));
for (const host of ['api.crossref.org', 'api.semanticscholar.org', 'dblp.org', 'wikidata.org', 'api.openalex.org']) {
  await context.route(`**/${host}/**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[],"data":[],"message":{"items":[]},"result":{"hits":{}}}' }));
}
const HIT = { id: '1706.03762', clusterId: '1706.03762', title: TITLE, url: 'https://arxiv.org/abs/1706.03762', pdfUrl: 'https://arxiv.org/pdf/1706.03762', authors: ['A Vaswani', 'N Shazeer', 'N Parmar', 'J Uszkoreit'], year: 2017, snippet: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.' };
await context.route('**/scholar/search*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [HIT] }) }));
await context.route('**/scholar/{authors,person,paper-authors,cluster}*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[]}' }));
const ATOM = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/1706.03762v7</id><updated>2023-08-02T00:41:18Z</updated><published>2017-06-12T17:57:34Z</published><title>${TITLE}</title><summary>The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.</summary><author><name>Ashish Vaswani</name></author><author><name>Noam Shazeer</name></author><link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/><link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/><category term="cs.CL"/></entry></feed>`;
await context.route('**/api/arxiv/query*', (route) => route.fulfill({ status: 200, contentType: 'application/atom+xml', body: ATOM }));
await context.route('**/api/arxiv/html*', (route) => route.fulfill({ status: 404, body: '' }));

// The app's faces, from the local copies, in place of Google Fonts.
const fontCss = [];
const faces = [
  ['@fontsource/ibm-plex-sans', ['400.css', '500.css', '600.css'], null],
  ['@fontsource/ibm-plex-mono', ['400.css', '500.css'], null],
  ['@fontsource-variable/newsreader', ['opsz.css', 'opsz-italic.css'], ['Newsreader Variable', 'Newsreader']],
];
for (const [pkg, files, rename] of faces) {
  for (const file of files) {
    const at = path.join(FONTS, pkg, file);
    if (!existsSync(at)) continue;
    let css = (await readFile(at, 'utf8')).replace(/url\(\.\/files\/([^)]+)\)/g, `url(https://fonts.gstatic.com/local/${pkg}/files/$1)`);
    if (rename) css = css.replaceAll(`'${rename[0]}'`, `'${rename[1]}'`);
    fontCss.push(css);
  }
}
if (fontCss.length) {
  await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: fontCss.join('\n') }));
  await context.route('https://fonts.gstatic.com/local/**', async (route) => {
    const rest = new URL(route.request().url()).pathname.replace('/local/', '');
    route.fulfill({ status: 200, contentType: 'font/woff2', body: await readFile(path.join(FONTS, rest)) });
  });
} else console.log('  (no local fonts in .video/fonts — the app falls back to system faces)');
// Nothing else leaves the machine.
await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|fonts\.)/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));

// ------------------------------------------------------------ the take ---

const timeline = [];
const mark = (name) => {
  timeline.push({ name, t: Date.now() / 1000 });
  console.log(`  ${name}`);
};

await context.addInitScript(() => {
  // Each scene as it comes up, told to the recorder.
  let last = '';
  new MutationObserver(() => {
    const scene = document.querySelector('.showcase')?.getAttribute('data-scene');
    if (scene && scene !== last) {
      last = scene;
      window.__mark?.(`scene:${scene}`);
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-scene'] });
});

const page = await context.newPage();
await page.exposeFunction('__mark', mark);
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate((theme) => {
  localStorage.setItem('reader.welcomed', 'true');
  localStorage.setItem('reader.tour', 'seen');
  const settings = JSON.parse(localStorage.getItem('reader.settings') || '{}');
  if (theme !== 'koios') Object.assign(settings, { theme, themeChosen: true });
  localStorage.setItem('reader.settings', JSON.stringify(settings));
}, THEME);
await page.reload({ waitUntil: 'networkidle' });
const skip = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
if (await skip.isVisible().catch(() => false)) await skip.click();
// The scene cards say what the voice-over will: the video has its own words.
await page.addStyleTag({ content: '.showcase-card { display: none !important; }' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(800);

const frames = [];
const cdp = await context.newCDPSession(page);
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  const file = `f${String(frames.length).padStart(6, '0')}.jpg`;
  frames.push({ file, t: metadata.timestamp });
  await writeFile(path.join(OUT, 'frames', file), Buffer.from(data, 'base64'));
  await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: VIEWPORT.width * SCALE, maxHeight: VIEWPORT.height * SCALE, everyNthFrame: 1 });
mark('start');
// A beat of Home, still, to open on.
await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
await page.waitForTimeout(2500);

mark('palette');
await page.keyboard.press('Control+k');
await page.waitForSelector('.palette');
await page.keyboard.type('show me', { delay: 60 });
await page.locator('.palette-row', { hasText: 'Show me, with a paper' }).click();
await page.waitForSelector('.showcase[data-scene="done"]', { state: 'attached', timeout: 400_000 });
await page.waitForTimeout(1500);
mark('end');
await cdp.send('Page.stopScreencast');
await page.waitForTimeout(300);
await browser.close();

// ------------------------------------------------- frames to footage ---

// The screencast sends a frame when the page changes: each one is held until the next.
const t0 = frames[0].t;
const list = frames.map((frame, i) => `file 'frames/${frame.file}'\nduration ${((frames[i + 1]?.t ?? frame.t + 1 / FPS) - frame.t).toFixed(4)}`);
list.push(`file 'frames/${frames.at(-1).file}'`);
await writeFile(path.join(OUT, 'frames.txt'), list.join('\n'));
await writeFile(path.join(OUT, 'timeline.json'), JSON.stringify(timeline.map(({ name, t }) => ({ name, at: +(t - t0).toFixed(3) })), null, 2));
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'frames.txt', '-vf', `fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', 'raw.mp4'], { cwd: OUT, stdio: 'inherit' });
const span = frames.at(-1).t - t0;
console.log(`\n${frames.length} frames over ${span.toFixed(1)} s (${(frames.length / span).toFixed(1)} a second) → ${path.join(OUT, 'raw.mp4')}`);
if (errors.length) console.log(`page errors:\n  ${errors.join('\n  ')}`);
