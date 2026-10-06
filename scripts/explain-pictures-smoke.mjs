/**
 * Real pictures on the Explain page. A paper with a drawn figure — Figure 1,
 * captioned — is printed to a PDF and opened; Explain is answered by a
 * stand-in for api.anthropic.com that streams scripts/fixtures/explain-pictures.md,
 * whose ```image``` blocks ask for the paper's Figure 1, a picture found by an
 * image search, one from Wikipedia, and a figure the paper does not have. The
 * proxy's image search (/web/images — Google Images through SerpApi on the
 * real proxy), Wikipedia, Commons and the image hosts are stood in for too,
 * answering as they do, so the whole path runs: Figure 1 cut out of the PDF
 * in PDF mode and taken off the page in Reflow mode, the search's first
 * result that will not load passed over for the next, the Wikipedia picture
 * with its credit and licence, the missing one said so, and the close-up.
 *
 *   npm run build && npm start &
 *   node scripts/explain-pictures-smoke.mjs   # SMOKE_BASE=http://localhost:8080
 */
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });
const FIXTURE = await readFile(new URL('./fixtures/explain-pictures.md', import.meta.url), 'utf8');

const TITLE = 'Attention Is All You Need';
const W = 1440;
const H = 900;

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

/** The Messages API's stream, as the SDK expects to read it. */
function sse(text, size = 240) {
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
  body.push(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3000 } }));
  body.push(event('message_stop', { type: 'message_stop' }));
  return body;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

console.log('\n== print a paper with a figure, and draw a picture for the web ==');
const printer = await browser.newPage();
const para =
  'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms. ';
const box = (x, y, w, h, label, fill) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" stroke="#333" stroke-width="1.5"/><text x="${x + w / 2}" y="${y + h / 2 + 5}" font-size="13" text-anchor="middle" font-family="sans-serif">${label}</text>`;
const arrow = (x, y1, y2) => `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="#333" stroke-width="1.5" marker-end="url(#a)"/>`;
const stack = (x, title) =>
  [
    box(x, 250, 160, 34, 'Input Embedding', '#f6d7b0'),
    arrow(x + 80, 250, 222),
    `<rect x="${x - 14}" y="70" width="188" height="150" rx="10" fill="#f2f2f2" stroke="#333" stroke-width="1.5"/>`,
    box(x, 172, 160, 34, 'Multi-Head Attention', '#f7c6a3'),
    arrow(x + 80, 172, 146),
    box(x, 108, 160, 34, 'Feed Forward', '#bfe0f5'),
    arrow(x + 80, 108, 52),
    box(x, 18, 160, 32, title, '#ddeecc'),
  ].join('');
const FIGURE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300" width="420"><defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#333"/></marker></defs>${stack(40, 'Encoder')}${stack(280, 'Decoder')}<path d="M220 140 C 250 140, 250 190, 280 190" fill="none" stroke="#333" stroke-width="1.5" marker-end="url(#a)"/></svg>`;
const section = (n, name, extra = '') => `<section style="break-after: page"><h2>${n}. ${name}</h2>${`<p>${para.repeat(3)}</p>`.repeat(2)}${extra}${`<p>${para.repeat(3)}</p>`.repeat(2)}</section>`;
await printer.setContent(
  `<!doctype html><html><body style="font-family: serif; font-size: 11pt; margin: 0.8in">
    <h1 style="text-align:center">${TITLE}</h1>
    <p style="text-align:center">Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan N. Gomez, Łukasz Kaiser, Illia Polosukhin</p>
    <h3>Abstract</h3><p>${para.repeat(2)}</p>
    ${section(1, 'Introduction')}
    ${section(3, 'Model Architecture', `<div style="text-align:center; margin: 14pt 0">${FIGURE}<p style="text-align:left; font-size: 10pt">Figure 1: The Transformer - model architecture.</p></div>`)}
    ${section(4, 'Why Self-Attention')}
  </body></html>`,
);
const PDF = await printer.pdf({ format: 'Letter', printBackground: true });
// A picture to stand in for the one on Wikimedia: an attention map over a short sentence.
const PICTURE = Buffer.from(
  (
    await printer.evaluate(() => {
      const words = ['The', 'law', 'will', 'never', 'be', 'perfect', ',', 'but', 'its', 'application', 'should', 'be', 'just'];
      const cell = 34;
      const pad = 96;
      const canvas = document.createElement('canvas');
      canvas.width = pad + words.length * cell + 10;
      canvas.height = pad + words.length * cell + 10;
      const g = canvas.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.font = '13px sans-serif';
      g.fillStyle = '#222';
      words.forEach((word, i) => {
        g.textAlign = 'right';
        g.fillText(word, pad - 8, pad + i * cell + cell / 2 + 4);
        g.save();
        g.translate(pad + i * cell + cell / 2 + 4, pad - 8);
        g.rotate(-Math.PI / 3);
        g.textAlign = 'left';
        g.fillText(word, 0, 0);
        g.restore();
      });
      words.forEach((_, i) =>
        words.forEach((__, j) => {
          const weight = Math.max(i === j + 1 ? 0.95 : 0, j === 2 ? 0.75 : 0, Math.exp(-Math.abs(i - j) * 1.3) * 0.5, 0.04);
          g.fillStyle = `rgba(178, 34, 52, ${weight})`;
          g.fillRect(pad + j * cell + 1, pad + i * cell + 1, cell - 2, cell - 2);
        }),
      );
      return canvas.toDataURL('image/png').split(',')[1];
    })
  ),
  'base64',
);
await printer.close();

const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
await context.route('**/pdf?*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }));
// No arXiv rendering: the figure has to come out of the PDF, or off the page.
await context.route('**/arxiv/html*', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"none"}' }));
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
          id: '2001',
          clusterId: '2001',
          title: TITLE,
          url: 'https://arxiv.org/abs/1706.03762',
          pdfUrl: 'https://example.org/attention.pdf',
          authors: ['A Vaswani', 'N Shazeer', 'N Parmar', 'J Uszkoreit'],
          year: 2017,
          snippet: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
        },
      ],
    }),
  }),
);
await context.route('**/scholar/{authors,person,paper-authors,cluster}*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[]}' }));

// Wikimedia, answering as its APIs do.
const asked = { wikipedia: [], commons: [], upload: 0 };
const FILE = 'Attention-map-example.png';
const THUMB = `https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/${FILE}/1280px-${FILE}`;
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
await context.route('https://en.wikipedia.org/w/api.php?*', (route) => {
  const params = new URL(route.request().url()).searchParams;
  asked.wikipedia.push(Object.fromEntries(params));
  if (params.get('prop') === 'pageimages') return json(route, { query: { pages: { 61603971: { pageid: 61603971, title: 'Attention (machine learning)', pageimage: FILE } } } });
  return json(route, { query: { pages: { '-1': { title: `File:${FILE}`, missing: '' } } } });
});
await context.route('https://commons.wikimedia.org/w/api.php?*', (route) => {
  const params = new URL(route.request().url()).searchParams;
  asked.commons.push(Object.fromEntries(params));
  return json(route, {
    query: {
      pages: {
        118: {
          title: `File:${FILE}`,
          index: 1,
          imageinfo: [
            {
              thumburl: THUMB,
              url: `https://upload.wikimedia.org/wikipedia/commons/1/1a/${FILE}`,
              descriptionurl: `https://commons.wikimedia.org/wiki/File:${FILE}`,
              mime: 'image/png',
              width: 1200,
              height: 1200,
              extmetadata: { Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Example">A. Example</a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' } },
            },
          ],
        },
      },
    },
  });
});
// The proxy, with an image search key: its /health says so, and /web/images answers as Google Images through SerpApi does.
const searched = [];
await context.route('**/health', async (route) => {
  const response = await route.fetch();
  const body = await response.json().catch(() => ({}));
  return route.fulfill({ response, json: { ...body, images: true } });
});
await context.route('**/web/images?*', (route) => {
  searched.push(new URL(route.request().url()).searchParams.get('q'));
  return json(route, {
    query: searched.at(-1),
    via: 'serpapi',
    images: [
      { src: 'https://hotlink-refused.example.org/attention.png', title: 'Refuses to be shown elsewhere', page: 'https://hotlink-refused.example.org/post', source: 'hotlink-refused.example.org', width: 1400 },
      { src: 'https://jalammar.example.io/images/attention-heatmap.png', thumb: 'https://encrypted-tbn0.gstatic.com/images?q=x', title: 'The Illustrated Transformer', page: 'https://jalammar.example.io/illustrated-transformer/', source: 'jalammar.example.io', width: 1100 },
    ],
  });
});
await context.route('https://hotlink-refused.example.org/**', (route) => route.fulfill({ status: 403, body: 'no' }));
await context.route('https://jalammar.example.io/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PICTURE }));
await context.route('https://upload.wikimedia.org/**', (route) => {
  asked.upload += 1;
  return route.fulfill({ status: 200, contentType: 'image/png', body: PICTURE });
});

await context.addInitScript(
  ({ first }) => {
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.startsWith('https://api.anthropic.com')) return real(input, init);
      const stream = new ReadableStream({
        start(controller) {
          for (const event of first) controller.enqueue(new TextEncoder().encode(event));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_smoke' } });
    };
  },
  { first: sse(FIXTURE) },
);

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

console.log('\n== open the paper, as its PDF ==');
// The paper is put straight into the browser's own database, as the close-up smoke does, and the reader opened on it as a PDF.
const PAPER = {
  id: 'scholar:attention',
  source: 'scholar',
  title: TITLE,
  authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit'],
  abstract: '',
  published: '2017-06-12',
  categories: [],
  addedAt: new Date(Date.now() - 240 * 3600 * 1000).toISOString(),
  collectionIds: ['c-reading'],
  tags: [],
  progress: 0.1,
  lastOpenedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
  pdfUrl: 'https://example.org/attention.pdf',
  landingUrl: 'https://arxiv.org/abs/1706.03762',
};
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(async ({ paper }) => {
  localStorage.setItem('reader.welcomed', 'true');
  localStorage.setItem('reader.anthropic-key', 'sk-ant-smoke');
  localStorage.setItem('reader.explain.layout', 'margin');
  localStorage.removeItem('reader.explain.pictures');
  localStorage.setItem('reader.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('reader.settings') || '{}'), theme: 'light', readingMode: 'pdf' }));
  localStorage.setItem('reader.view', JSON.stringify({ kind: 'paper', id: paper.id }));
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
  await put('collections', { id: 'c-reading', name: 'Reading list', color: '#2f7d6d', createdAt: new Date().toISOString() });
  await put('papers', paper);
  db.close();
}, { paper: PAPER });
await page.reload({ waitUntil: 'networkidle' });
const notNow = page.getByRole('button', { name: /Not now — keep everything in this browser/i });
if (await notNow.isVisible().catch(() => false)) await notNow.click();
await page.waitForSelector('.pdf-book-page canvas', { timeout: 30000 });
await page.waitForTimeout(800);
check('the paper is open as its PDF, with nothing of it in the Reflow column', (await page.locator('.paper-body figure').count()) === 0);

console.log('\n== Explain, with pictures ==');
await page.mouse.move(W / 2, H / 2);
await page.keyboard.press('e');
await page.getByRole('button', { name: 'Explain this paper' }).click();
await page.waitForSelector('.explain-section h2', { timeout: 20000 });
await page.waitForFunction(() => !document.querySelector('.explain-writing'), null, { timeout: 20000 });
const loaded = (selector) => page.waitForFunction((s) => Array.from(document.querySelectorAll(s)).some((image) => image.complete && image.naturalWidth > 0), selector, { timeout: 45000 }).then(() => true, () => false);
check('four pictures are on the page', (await page.locator('.explain-picture').count()) === 4);
check('Figure 1 is cut out of the PDF', await loaded('.explain-picture.is-paper .picture-art img'));
check('it says where it is from', /Figure 1 of the paper/.test((await page.locator('.explain-picture.is-paper .picture-credit').first().textContent()) ?? ''));
const searchedPicture = page.locator('#explain-what-attention-looks-at .explain-picture.is-web');
const wikiPicture = page.locator('#explain-where-it-went-next .explain-picture.is-web');
check('the image search is asked with the model’s words', searched[0] === 'transformer self-attention weights heatmap sentence', searched.join(' | '));
check('its picture is found', await loaded('#explain-what-attention-looks-at .explain-picture.is-web .picture-art img'));
check('a result that will not load is passed over for the next', (await searchedPicture.locator('.picture-art img').getAttribute('src')) === 'https://jalammar.example.io/images/attention-heatmap.png');
const found = (await searchedPicture.locator('.picture-credit').textContent()) ?? '';
check('it names the site, and how it was found', /jalammar\.example\.io/.test(found) && /found by Google Images/.test(found), found);
check('linked to the page it is on', (await searchedPicture.locator('.picture-credit a').getAttribute('href')) === 'https://jalammar.example.io/illustrated-transformer/');
check('the Wikipedia picture is found', await loaded('#explain-where-it-went-next .explain-picture.is-web .picture-art img'));
const credit = (await wikiPicture.locator('.picture-credit').textContent()) ?? '';
check('with its source, author and licence', /Wikipedia · Attention \(machine learning\)/.test(credit) && /A\. Example/.test(credit) && /CC BY-SA 4\.0/.test(credit), credit);
check('linked to its page on Commons', (await wikiPicture.locator('.picture-credit a').getAttribute('href')) === `https://commons.wikimedia.org/wiki/File:${FILE}`);
check('the lead image was asked of Wikipedia by its title', asked.wikipedia.some((q) => q.prop === 'pageimages' && q.titles === 'Attention (machine learning)'));
check('a figure the paper does not have says so', /could not be found/.test((await page.locator('.explain-picture .picture-missing').textContent()) ?? ''));
const size = await page.locator('.explain-picture.is-paper .picture-art img').first().evaluate((image) => ({ w: image.naturalWidth, h: image.naturalHeight }));
check('the figure is the drawing, not the page', size.w > 200 && size.h > 100 && size.w / size.h > 1.1, `${size.w}×${size.h}`);
await page.locator('#explain-the-architecture').scrollIntoViewIfNeeded();
await page.evaluate(() => document.querySelector('#explain-the-architecture')?.scrollIntoView({ block: 'start' }));
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/explain-pictures-paper.png` });
await page.evaluate(() => document.querySelector('#explain-what-attention-looks-at')?.scrollIntoView({ block: 'start' }));
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/explain-pictures-web.png` });

console.log('\n== close up ==');
await searchedPicture.locator('.picture-art').click();
await page.waitForSelector('.figure-closeup .closeup-art.picture-art img', { timeout: 5000 });
await page.waitForTimeout(700);
const closeup = await page.locator('.figure-closeup .closeup-art').boundingBox();
check('a picture opens close up, larger than on the page', (closeup?.width ?? 0) > 600, `${Math.round(closeup?.width ?? 0)}px wide`);
await page.screenshot({ path: `${OUT}/explain-pictures-closeup.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(600);

console.log('\n== a second look asks Wikimedia nothing ==');
const before = asked.wikipedia.length + asked.commons.length + searched.length;
await page.reload({ waitUntil: 'networkidle' });
if (await notNow.isVisible().catch(() => false)) await notNow.click();
await page.waitForSelector('.explain-section h2', { timeout: 20000 });
check('the web pictures are back', await loaded('#explain-what-attention-looks-at .explain-picture.is-web .picture-art img'));
check('remembered, not searched for again', asked.wikipedia.length + asked.commons.length + searched.length === before);

console.log('\n== in Reflow, taken off the page ==');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
if (await page.locator('.explain').count()) await page.locator('.explain button[aria-label*="Close"]').first().click().catch(() => undefined);
await page.locator('.segmented button', { hasText: 'Reflow' }).click({ timeout: 20000 });
await page.waitForSelector('.paper-body h2', { timeout: 30000 });
const onPage = await page.locator('.paper-body figure img').count();
check('the reflowed paper has its figure', onPage > 0, `${onPage} on the page`);
await page.mouse.move(W / 2, H / 2);
await page.keyboard.press('e');
await page.waitForSelector('.explain-section h2', { timeout: 20000 });
check('Figure 1 is found again', await loaded('.explain-picture.is-paper .picture-art img'));
const same = await page.evaluate(() => {
  const shown = document.querySelector('.paper-body figure img')?.src;
  return Boolean(shown) && document.querySelector('.explain-picture.is-paper .picture-art img')?.src === shown;
});
check('it is the image the Reflow column shows', same);

console.log('\n== dark ==');
await page.evaluate(() => {
  const saved = JSON.parse(localStorage.getItem('reader.settings') || '{}');
  localStorage.setItem('reader.settings', JSON.stringify({ ...saved, theme: 'dark' }));
});
await page.reload({ waitUntil: 'networkidle' });
if (await notNow.isVisible().catch(() => false)) await notNow.click();
await page.waitForSelector('.explain-section h2', { timeout: 20000 });
await loaded('.explain-picture.is-paper .picture-art img');
await page.evaluate(() => document.querySelector('#explain-the-architecture')?.scrollIntoView({ block: 'start' }));
await page.waitForTimeout(600);
check('a paper figure stays on white in the dark', (await page.locator('.explain-picture.is-paper .picture-art').evaluate((el) => getComputedStyle(el).backgroundColor)) === 'rgb(255, 255, 255)');
await page.screenshot({ path: `${OUT}/explain-pictures-dark.png` });

check('no errors on the page', errors.length === 0, errors.join(' | '));
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll good.');
