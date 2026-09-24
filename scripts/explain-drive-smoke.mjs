/**
 * Explain, kept in Drive. One browser has Claude write a paper's explanation
 * and asks for a change; both land in a Markdown file in the paper's folder in
 * Drive. A second browser — its own storage, the same Drive — opens the same
 * paper's explanation and gets it from Drive, without asking Claude at all.
 *
 * Drive here is a small in-memory one, shared by the two browsers: folders
 * with parents, files found by name and parent, created and written over with
 * multipart uploads, read back with alt=media, each with a modifiedTime.
 *
 *   npm run build && npm start &
 *   node scripts/explain-drive-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { connectAndEnter, reporter, settingsScript } from './fakeGoogle.mjs';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });
const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const PAGE = await fixture('explain-attention.md');
const EDIT = await fixture('explain-revise-heads.md');

const TITLE = 'Attention Is All You Need';
const FILE = `${TITLE} — explained by Claude.md`;
const { check, problems } = reporter();

// ------------------------------------------------------------ a fake Drive ---

const drive = { items: new Map(), next: 1, uploads: [], downloads: 0 };
const now = () => new Date(Date.now() + drive.next).toISOString();

function multipart(request) {
  const type = request.headers()['content-type'] || '';
  const boundary = /boundary=(.+)$/.exec(type)?.[1];
  const raw = (request.postDataBuffer() || Buffer.alloc(0)).toString('utf8');
  const parts = boundary ? raw.split(`--${boundary}`).slice(1, -1) : [];
  const body = (part) => part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
  return { metadata: JSON.parse(body(parts[0] || '{}') || '{}'), content: body(parts[1] || '') };
}

async function installDrive(context) {
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await context.addInitScript(() => {
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: (config) => ({
            requestAccessToken: () =>
              setTimeout(() => config.callback({ access_token: 'test-token', expires_in: 3600, scope: 'openid email profile https://www.googleapis.com/auth/drive.file' }), 10),
          }),
          revoke: (_token, done) => done && done(),
        },
      },
    };
  });
  await context.addInitScript((settings) => {
    if (!localStorage.getItem('reader.settings')) localStorage.setItem('reader.settings', JSON.stringify(settings));
  }, settingsScript({ readingMode: 'reflow', autoSync: true, savePdf: false }));
  await context.route('**/accounts.google.com/gsi/client*', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '// stubbed' }));
  await context.route('**/www.googleapis.com/oauth2/v3/userinfo*', (route) => json(route, { name: 'Saurav Chennuri', email: 'reader@example.org' }));
  await context.route('**/www.googleapis.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const upload = /^\/upload\/drive\/v3\/files(?:\/([^/?]+))?$/.exec(url.pathname);
    if (upload) {
      const { metadata, content } = multipart(request);
      const id = upload[1] || `file-${drive.next++}`;
      const existing = drive.items.get(id);
      if (upload[1] && !existing) return json(route, { error: { message: 'File not found' } }, 404);
      const item = { id, name: metadata.name, parent: existing?.parent ?? metadata.parents?.[0], folder: false, content, modifiedTime: now() };
      drive.next++;
      drive.items.set(id, item);
      drive.uploads.push(item.name);
      return json(route, { id, name: item.name, webViewLink: `https://drive.google.com/file/d/${id}/view`, modifiedTime: item.modifiedTime });
    }
    const media = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (media && url.searchParams.get('alt') === 'media') {
      drive.downloads++;
      const item = drive.items.get(media[1]);
      return route.fulfill({ status: item ? 200 : 404, contentType: 'text/markdown', body: item?.content ?? 'missing' });
    }
    if (url.pathname === '/drive/v3/files' && request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}');
      const id = `folder-${drive.next++}`;
      drive.items.set(id, { id, name: body.name, parent: body.parents?.[0] ?? 'root', folder: true });
      return json(route, { id, name: body.name });
    }
    if (url.pathname === '/drive/v3/files') {
      const q = url.searchParams.get('q') || '';
      const name = /name = '((?:\\'|[^'])+)'/.exec(q)?.[1]?.replace(/\\'/g, "'");
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const folder = q.includes("mimeType = 'application/vnd.google-apps.folder'");
      const files = [...drive.items.values()]
        .filter((item) => (!name || item.name === name) && (!parent || item.parent === parent) && (!folder || item.folder))
        .map((item) => ({ id: item.id, name: item.name, webViewLink: `https://drive.google.com/file/d/${item.id}/view`, modifiedTime: item.modifiedTime }));
      return json(route, { files });
    }
    return json(route, {});
  });
}

/** The Messages API's stream, one event a string. */
function sse(text, size = 400) {
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const body = [
    event('message_start', { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ];
  for (let i = 0; i < text.length; i += size) body.push(event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + size) } }));
  body.push(event('content_block_stop', { type: 'content_block_stop', index: 0 }));
  body.push(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }));
  body.push(event('message_stop', { type: 'message_stop' }));
  return body;
}

// ------------------------------------------------------------- a browser ---

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

const printer = await browser.newPage();
const para = 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks. We propose the Transformer. ';
await printer.setContent(
  `<!doctype html><html><body style="font-family: serif; margin: 0.8in"><h1>${TITLE}</h1><h3>Abstract</h3><p>${para.repeat(4)}</p>${[1, 2, 3]
    .map((n) => `<section style="break-after: page"><h2>${n}. Section</h2><p>${para.repeat(12)}</p></section>`)
    .join('')}</body></html>`,
);
const PDF = await printer.pdf({ format: 'Letter' });
await printer.close();

/** A browser of its own: fresh storage, the shared Drive, a stand-in for Claude. */
async function openBrowser(label) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await installDrive(context);
  await context.route('**/pdf?*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }));
  for (const host of ['api.crossref.org', 'api.semanticscholar.org', 'dblp.org', 'wikidata.org', 'api.openalex.org', 'api.unpaywall.org']) {
    await context.route(`**/${host}/**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[],"data":[],"message":{"items":[]},"result":{"hits":{}}}' }));
  }
  await context.route('**/scholar/search*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results: [{ id: '2001', clusterId: '2001', title: TITLE, url: 'https://arxiv.org/abs/1706.03762', pdfUrl: 'https://example.org/attention.pdf', authors: ['A Vaswani', 'N Shazeer'], year: 2017, snippet: para }] }),
    }),
  );
  await context.route('**/scholar/{authors,person,paper-authors,cluster}*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"results":[]}' }));
  await context.addInitScript(
    ({ first, edit }) => {
      const real = window.fetch.bind(window);
      window.__asked = [];
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (!url.startsWith('https://api.anthropic.com')) return real(input, init);
        const body = JSON.parse(init?.body ?? '{}');
        window.__asked.push(body);
        const events = body.messages.length > 1 ? edit : first;
        return new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(e)); c.close(); } }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      };
      localStorage.setItem('reader.anthropic-key', 'sk-ant-smoke');
      localStorage.setItem('reader.explain.layout', 'margin');
    },
    { first: sse(PAGE), edit: sse(EDIT) },
  );
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (error) => page.errors.push(`${label}: ${error}`));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await connectAndEnter(page);
  if (!(await page.locator('.dock .discover-panel').isVisible())) await page.getByRole('button', { name: 'Discover papers' }).click();
  const chips = page.locator('.discover-panel .chip');
  for (let index = 0; index < (await chips.count()); index += 1) {
    const chip = chips.nth(index);
    const wanted = /Scholar/.test((await chip.textContent()) || '');
    if (wanted !== ((await chip.getAttribute('aria-pressed')) === 'true')) await chip.click();
  }
  await page.getByLabel('Search papers').fill('attention is all you need');
  await page.getByLabel('Search papers').press('Enter');
  await page.waitForSelector('article.result');
  await page.locator('article.result h3').first().click();
  await page.getByRole('button', { name: /Add to collection/i }).click();
  await page.getByRole('button', { name: /^Read$/ }).click().catch(() => undefined);
  await page.waitForSelector('.paper-body h2, .paper-body p', { timeout: 30000 });
  await page.waitForTimeout(800);
  return page;
}

const driveLine = (page) => page.locator('.drive-line').textContent({ timeout: 15000 }).catch(() => '');

// ------------------------------------------------------------------ run it ---

console.log('\n== the first browser: written once, kept in Drive ==');
const first = await openBrowser('first');
await first.mouse.move(700, 450);
await first.keyboard.press('e');
await first.waitForSelector('.explain-empty', { timeout: 15000 });
check('with Drive connected, the start says where it will be kept', /your Drive/.test(await first.locator('.explain-empty .hint').textContent()));
await first.getByRole('button', { name: 'Explain this paper' }).click();
await first.waitForSelector('.explain-section h2', { timeout: 20000 });
await first.waitForFunction(() => /Saved in your Drive/.test(document.querySelector('.drive-line')?.textContent ?? ''), null, { timeout: 15000 });
const saved = [...drive.items.values()].find((item) => item.name === FILE);
check('the explanation is a Markdown file in Drive', Boolean(saved), [...drive.items.values()].map((i) => i.name).join(' | '));
const folder = saved && drive.items.get(saved.parent);
check('in the paper’s own folder', folder?.name === TITLE && drive.items.get(folder.parent)?.name === 'Papers_collection', folder?.name);
check('it opens with front matter naming the paper and the model', /^---\ngenerator: "reader"\ntitle: "Attention Is All You Need"[\s\S]*model: "claude-opus-5"/.test(saved?.content ?? ''));
check('then the page as Claude wrote it', (saved?.content ?? '').includes('## Since then') && (saved?.content ?? '').includes('```caveat'));
check('the outline links to it', (await first.locator('.drive-line a[href*="drive.google.com"]').count()) === 1, await driveLine(first));
await first.locator('.explain-scroll').evaluate((el) => (el.scrollTop = 0));
await first.screenshot({ path: `${OUT}/explain-drive-1-saved.png` });

console.log('\n== a change is written over the same file ==');
const heads = first.locator('.explain-section[data-title="Multi-head attention"]');
await heads.scrollIntoViewIfNeeded();
await heads.hover();
await heads.getByRole('button', { name: 'Ask or adjust' }).click();
await first.getByLabel('Ask about the explanation, or ask for a change').fill('Explain this more simply, with an analogy');
await first.getByLabel('Ask about the explanation, or ask for a change').press('Enter');
await first.waitForSelector('.ask-status.is-done', { timeout: 15000 });
await first.waitForFunction(() => /Saved in your Drive/.test(document.querySelector('.drive-line')?.textContent ?? ''), null, { timeout: 15000 });
await first.waitForTimeout(300);
const files = [...drive.items.values()].filter((item) => item.name === FILE);
check('still one file', files.length === 1, String(files.length));
check('now holding the change', (files[0]?.content ?? '').includes('group of friends'));
check('and the request that made it', /requests:\n {2}- "Explain this more simply, with an analogy"/.test(files[0]?.content ?? ''));
const firstAsked = await first.evaluate(() => window.__asked.length);

console.log('\n== a second browser: fetched from Drive, not written again ==');
const downloadsBefore = drive.downloads;
const second = await openBrowser('second');
await second.mouse.move(700, 450);
await second.keyboard.press('e');
await second.waitForSelector('.explain-section h2', { timeout: 20000 });
await second.waitForFunction(() => /Fetched from your Drive/.test(document.querySelector('.drive-line')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => undefined);
check('the page comes from Drive', /Fetched from your Drive/.test(await driveLine(second)), await driveLine(second));
check('Claude was not asked', (await second.evaluate(() => window.__asked.length)) === 0);
check('it was downloaded once', drive.downloads - downloadsBefore === 1, String(drive.downloads - downloadsBefore));
check('with the change made in the other browser', (await second.locator('.explain-section[data-title="Multi-head attention"] .explain-prose').first().textContent())?.includes('group of friends'));
check('and the model it was written with', /Written by Opus 5/.test(await second.locator('.outline-meta').textContent()));
await second.locator('.explain-scroll').evaluate((el) => {
  const target = el.querySelector('.explain-section[data-title="Multi-head attention"]');
  el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
});
await second.waitForTimeout(300);
await second.screenshot({ path: `${OUT}/explain-drive-2-fetched.png` });

console.log('\n== opened again: nothing new in Drive, nothing downloaded ==');
await second.keyboard.press('Escape');
await second.waitForTimeout(200);
const downloadsNow = drive.downloads;
await second.mouse.move(700, 450);
await second.keyboard.press('e');
await second.waitForSelector('.explain-section h2');
await second.waitForTimeout(800);
check('an unchanged file is not downloaded again', drive.downloads === downloadsNow, String(drive.downloads - downloadsNow));
check('the first browser asked Claude twice, the second never', firstAsked === 2 && (await second.evaluate(() => window.__asked.length)) === 0, `${firstAsked}`);

const errors = [...first.errors, ...second.errors];
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nall good');
process.exit(problems.length ? 1 : 0);
