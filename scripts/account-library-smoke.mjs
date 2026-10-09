/**
 * One library per Google account, kept in that account's Drive. Two accounts
 * with a Drive each, faked in the page and on the network:
 *
 *   - the first to sign in on a browser that has a library from before takes
 *     the papers its Drive proves are its own, gets back the ones only its
 *     Drive's sidecars remember, is offered the rest, and has library.json
 *     written to its Drive;
 *   - signing out leaves nobody's library on screen;
 *   - a second account signing in on the same browser sees none of it, and
 *     is offered none of it;
 *   - the first account on a browser with nothing in it gets its library
 *     back from Drive.
 *
 *   npm run build && npm start &
 *   node scripts/account-library-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(label);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const FOLDER = 'application/vnd.google-apps.folder';
const A = 'first@example.org';
const B = 'second@example.org';

// ------------------------------------------------------------ fake Drives ---

let nextId = 1;
const drives = new Map(); // email -> Map(id -> file)
const driveOf = (email) => {
  if (!drives.has(email)) drives.set(email, new Map());
  return drives.get(email);
};
const put = (email, file) => {
  const id = file.id || `${email.split('@')[0]}-${nextId++}`;
  driveOf(email).set(id, { parents: [], mimeType: 'application/json', ...file, id, modifiedTime: new Date(Date.now() + nextId).toISOString() });
  return id;
};
const libraryIn = (email) => {
  const file = [...driveOf(email).values()].find((item) => item.name === 'library.json');
  return file ? JSON.parse(file.body) : null;
};

function matches(file, q) {
  for (const clause of q.split(' and ')) {
    let m;
    if ((m = clause.match(/^name = '(.*)'$/)) && file.name !== m[1].replace(/\\'/g, "'")) return false;
    if ((m = clause.match(/^mimeType = '(.*)'$/)) && file.mimeType !== m[1]) return false;
    if ((m = clause.match(/^'(.*)' in parents$/))) {
      if (m[1] === 'root' ? file.parents.length : !file.parents.includes(m[1])) return false;
    }
  }
  return true;
}

async function routeGoogle(context) {
  const accountOf = (request) => (request.headers().authorization || '').replace('Bearer token:', '');
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await context.route('**/accounts.google.com/gsi/client*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: '// stubbed' }),
  );
  await context.route('**/www.googleapis.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const email = accountOf(request);
    const drive = driveOf(email);

    if (url.pathname === '/oauth2/v3/userinfo') return json(route, { name: email.split('@')[0], email });

    const upload = url.pathname.match(/^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/);
    if (upload) {
      const body = request.postDataBuffer().toString('utf8');
      const metadata = JSON.parse(body.match(/\{"name".*?\}(?=\r?\n)/s)?.[0] || '{}');
      const content = body.split(/\r?\n\r?\n/).slice(2).join('\n\n').replace(/\r?\n--[^\n]*--\r?\n?$/, '');
      const fileId = upload[1];
      if (fileId && !drive.has(fileId)) return json(route, { error: 'not found' }, 404);
      const id = fileId
        ? put(email, { ...drive.get(fileId), body: content, id: fileId })
        : put(email, { name: metadata.name, mimeType: metadata.mimeType, parents: metadata.parents || [], body: content });
      const file = drive.get(id);
      return json(route, { id, name: file.name, modifiedTime: file.modifiedTime });
    }

    if (url.pathname === '/drive/v3/files' && request.method() === 'POST') {
      const metadata = JSON.parse(request.postData() || '{}');
      const id = put(email, { name: metadata.name, mimeType: metadata.mimeType, parents: metadata.parents || [] });
      return json(route, { id, name: metadata.name });
    }
    if (url.pathname === '/drive/v3/files') {
      const q = url.searchParams.get('q') || '';
      const files = [...drive.values()].filter((file) => matches(file, q.replace(/ and trashed = false/g, '')));
      return json(route, { files: files.map(({ id, name, parents, modifiedTime }) => ({ id, name, parents, modifiedTime })) });
    }
    const one = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (one) {
      const file = drive.get(decodeURIComponent(one[1]));
      if (!file) return json(route, { error: 'not found' }, 404);
      if (url.searchParams.get('alt') === 'media') return route.fulfill({ status: 200, contentType: file.mimeType, body: file.body || '' });
      return json(route, { id: file.id, name: file.name, parents: file.parents, modifiedTime: file.modifiedTime });
    }
    return json(route, {});
  });
}

/** Identity Services in the page; whoever `localStorage['fake.account']` names is who signs in. */
const fakeIdentity = () => {
  window.google = {
    accounts: {
      oauth2: {
        initTokenClient: (config) => ({
          requestAccessToken: () =>
            setTimeout(
              () =>
                config.callback({
                  access_token: `token:${localStorage.getItem('fake.account')}`,
                  expires_in: 3600,
                  scope: 'openid email profile https://www.googleapis.com/auth/drive.file',
                }),
              10,
            ),
        }),
        revoke: (_token, done) => done && done(),
      },
    },
  };
};

// ---------------------------------------------------------- the before ---

const paper = (id, title, extra = {}) => ({
  id,
  source: 'arxiv',
  title,
  authors: ['A. Author'],
  abstract: '',
  published: '2024-01-01',
  categories: [],
  addedAt: new Date().toISOString(),
  collectionIds: ['c-old'],
  tags: [],
  progress: 0,
  ...extra,
});

// A's Drive already holds two paper folders from the old mirror: one for a
// paper this browser has too, one for a paper only Drive remembers.
const root = put(A, { name: 'Papers_collection', mimeType: FOLDER });
const savedFolder = put(A, { name: 'Saved Paper', mimeType: FOLDER, parents: [root] });
const sidecarOnly = put(A, { name: 'Only In Drive', mimeType: FOLDER, parents: [root] });
put(A, {
  name: 'Only In Drive.json',
  parents: [sidecarOnly],
  body: JSON.stringify({
    generator: 'reader',
    paper: { id: 'arxiv:3', title: 'Only In Drive', authors: ['C'], collections: ['Operators'] },
    annotations: [
      {
        id: 'h-drive',
        colour: 'blue',
        created: '2026-01-01T00:00:00.000Z',
        target: { selector: [{ type: 'TextQuoteSelector', exact: 'remembered by Drive', prefix: '', suffix: '' }, { type: 'TextPositionSelector', start: 3 }] },
      },
    ],
  }),
});

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const settings = {
  googleClientId: 'test.apps.googleusercontent.com',
  driveFolderName: 'Papers_collection',
  autoSync: false,
  savePdf: false,
  syncOnOpen: false,
  theme: 'light',
};

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|www\.googleapis\.com|accounts\.google\.com)/, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
  );
  await routeGoogle(context);
  await context.addInitScript(fakeIdentity);
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log('  pageerror', String(error)));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate((stored) => {
    localStorage.setItem('reader.settings', JSON.stringify(stored));
    localStorage.setItem('reader.welcomed', 'true');
    localStorage.setItem('reader.view', JSON.stringify({ kind: 'all' }));
  }, settings);
  return { context, page };
}

async function seedGuest(page) {
  await page.evaluate(async ({ papers }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('reader', 1);
      request.onupgradeneeded = () => {
        const made = request.result;
        made.createObjectStore('papers', { keyPath: 'id' });
        made.createObjectStore('collections', { keyPath: 'id' });
        made.createObjectStore('highlights', { keyPath: 'id' }).createIndex('paperId', 'paperId', { unique: false });
        made.createObjectStore('kv');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['papers', 'collections', 'highlights', 'kv'], 'readwrite');
    for (const item of papers) tx.objectStore('papers').put(item);
    tx.objectStore('collections').put({ id: 'c-old', name: 'Old shelf', color: '#8A4B2A', createdAt: '' });
    tx.objectStore('highlights').put({ id: 'h-saved', paperId: 'arxiv:1', color: 'pink', exact: 'kept here', prefix: '', suffix: '', hint: 0, tags: [], createdAt: '' });
    tx.objectStore('kv').put({ blocks: [{ id: 'n', text: 'my note' }], updated: 'x' }, 'notes:arxiv:1');
    await new Promise((resolve) => (tx.oncomplete = resolve));
    db.close();
  }, {
    papers: [
      paper('arxiv:1', 'Saved Paper', { progress: 0.42, drive: { folderId: savedFolder, folderName: 'Saved Paper' } }),
      paper('arxiv:2', 'Never Saved Anywhere'),
    ],
  });
  await page.reload({ waitUntil: 'networkidle' });
}

async function signInAs(page, email) {
  await page.evaluate((who) => localStorage.setItem('fake.account', who), email);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.locator('.sheet').getByRole('button', { name: /Sign in with Google/ }).click();
  await page.waitForTimeout(2500);
}

async function signOut(page) {
  await page.getByRole('button', { name: /^Sign out$/ }).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
}

const titles = (page) =>
  page.evaluate(() => {
    const text = document.body.innerText;
    return ['Saved Paper', 'Never Saved Anywhere', 'Only In Drive'].filter((title) => text.includes(title));
  });

const closeSettings = (page) => page.getByRole('button', { name: 'Close settings' }).click();

// ---------------------------------------------------------- the browser ---

console.log('A signs in on a browser with a library from before');
const first = await newPage();
await seedGuest(first.page);
await signInAs(first.page, A);
const settingsText = await first.page.locator('.sheet').innerText();
check('one sign-in connects Drive too', settingsText.includes('Library saved in your Drive'), settingsText.match(/Library[^\n]*/)?.[0]);
check('the paper that was never in any Drive is offered, not taken', /still has 1 paper/.test(settingsText));
await first.page.screenshot({ path: `${OUT}account-a-settings.png` });
await closeSettings(first.page);
await first.page.waitForTimeout(400);
let shown = await titles(first.page);
check('A has its own paper back, and the one only its Drive remembered', shown.includes('Saved Paper') && shown.includes('Only In Drive') && !shown.includes('Never Saved Anywhere'), shown.join(', '));
let written = libraryIn(A);
check('library.json is in A’s Drive', Boolean(written), written ? `${written.papers.length} papers` : 'none');
check('the paper kept its reading progress', written?.papers.find((item) => item.id === 'arxiv:1')?.progress === 0.42);
check('highlights from both places are in it', ['h-saved', 'h-drive'].every((id) => written?.highlights.some((item) => item.id === id)));
check('the notes went with the paper', await first.page.evaluate(async () => {
  const db = await new Promise((resolve) => {
    const request = indexedDB.open('reader:first@example.org', 1);
    request.onsuccess = () => resolve(request.result);
  });
  const value = await new Promise((resolve) => {
    const request = db.transaction('kv').objectStore('kv').get('notes:arxiv:1');
    request.onsuccess = () => resolve(request.result);
  });
  db.close();
  return Boolean(value);
}));

await first.page.getByRole('button', { name: 'Settings' }).first().click();
await first.page.getByRole('button', { name: 'Add to my library' }).click();
await first.page.waitForTimeout(2500);
written = libraryIn(A);
check('adopting the leftover writes it to A’s Drive', written?.papers.some((item) => item.id === 'arxiv:2'));

console.log('A signs out');
await signOut(first.page);
shown = await titles(first.page);
check('nothing of A’s is on screen once signed out', shown.length === 0, shown.join(', '));

console.log('B signs in on the same browser');
await signInAs(first.page, B);
const bSettings = await first.page.locator('.sheet').innerText();
check('B is offered none of A’s papers', !/still has \d+ paper/.test(bSettings));
await closeSettings(first.page);
await first.page.waitForTimeout(400);
shown = await titles(first.page);
check('B sees none of A’s library', shown.length === 0, shown.join(', ') || 'empty');
await first.page.screenshot({ path: `${OUT}account-b-library.png` });
const bLibrary = libraryIn(B);
check('B’s Drive has a library of its own, with nothing of A’s in it', bLibrary && bLibrary.papers.length === 0);
check('nothing of A’s was written to B’s Drive', ![...driveOf(B).values()].some((file) => /Saved Paper|Only In Drive/.test(file.name)));
await first.context.close();

console.log('A signs in on a browser with nothing in it');
const second = await newPage();
await signInAs(second.page, A);
await closeSettings(second.page);
await second.page.waitForTimeout(400);
const restored = await second.page.evaluate(async () => {
  const db = await new Promise((resolve) => {
    const request = indexedDB.open('reader:first@example.org', 1);
    request.onsuccess = () => resolve(request.result);
  });
  const papers = await new Promise((resolve) => {
    const request = db.transaction('papers').objectStore('papers').getAll();
    request.onsuccess = () => resolve(request.result);
  });
  db.close();
  return papers.map((item) => item.title).sort();
});
check('the whole library comes back from A’s Drive', restored.length === 3, restored.join(', '));
const home = await second.page.locator('body').innerText();
check('with its collections', home.includes('Old shelf') && home.includes('Operators'));
await second.page.screenshot({ path: `${OUT}account-a-new-browser.png` });
await second.context.close();

await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} failed`);
  process.exit(1);
}
console.log('\nall passed');
