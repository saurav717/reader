/**
 * Working on a project together, in the real page (docs/live-collaboration.md):
 * the people in the project bar, the card on one of them with Jump and
 * Follow, the list of everyone, a toast as someone opens a file, following,
 * and the share dialog. The Worker's room is stood in for here — its state
 * over HTTP and its live socket — with two other people in it.
 *
 *   npm run build && npm start &
 *   node scripts/live-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const ROOM = 'c0ffee'.padEnd(32, '0');
const ME = 'me@example.org';
// A pass as the app reads it: only its claims matter here, the stand-in checks no signature.
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const PASS = `rp1.${b64({ e: ME, x: Math.floor(Date.now() / 1000) + 86400 })}.sig`;

const place = (more) => ({ active: true, at: Date.now(), ...more });
const members = [
  { email: ME, role: 'owner', name: 'Saurav C', color: '#8a3a6e', joinedAt: '2026-10-01T00:00:00.000Z', place: null, lastSeen: null, lastPlace: null },
  { email: 'priya@example.org', role: 'editor', name: 'Priya Natarajan', color: '#b27414', joinedAt: '2026-10-02T00:00:00.000Z', place: place({ tab: 'code', path: 'src/train.py', line: 42, col: 9, offset: 1180 }), lastSeen: null, lastPlace: null },
  { email: 'marco@example.org', role: 'editor', name: 'Marco Ruiz', color: '#2d64a0', joinedAt: '2026-10-03T00:00:00.000Z', place: place({ tab: 'read', paperId: 'arxiv:2101.03961', title: 'Switch Transformers', active: false }), lastSeen: null, lastPlace: null },
  { email: 'lin@example.org', role: 'viewer', name: 'Lin Zhao', color: '#1f8a70', joinedAt: '2026-10-04T00:00:00.000Z', place: null, lastSeen: Date.now() - 26 * 3600_000, lastPlace: place({ tab: 'write', path: 'sections/results.tex', line: 12 }) },
];
const project = { id: 'p-moe', name: 'Sparse-gated MoE', color: '#1f5e52', question: 'Can a router balance experts with no auxiliary loss?', startedAt: '2026-10-01T00:00:00.000Z', papers: [{ id: 'arxiv:2101.03961', title: 'Switch Transformers', role: 'baseline' }], todos: [] };
let state = { room: ROOM, owner: ME, project, me: ME, role: 'owner', members, invitations: [{ email: 'dana@ethz.ch', role: 'viewer', by: ME, at: '2026-10-13T00:00:00.000Z' }], link: { token: 'tok', on: false, domain: '' } };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
page.on('console', (message) => message.type() === 'error' && console.log('  console:', message.text().slice(0, 300)));

// ---- the room, stood in for: its state, and a live socket with the others' moves on it
await page.route(`**/api/rooms/${ROOM}**`, async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith('/invite')) {
    const body = route.request().postDataJSON();
    state = { ...state, invitations: [...state.invitations, { email: body.email, role: body.role, by: ME, at: new Date().toISOString() }] };
  }
  await route.fulfill({ json: state });
});
let socket = null;
await page.routeWebSocket(`**/api/rooms/${ROOM}/live`, (ws) => {
  socket = ws;
  ws.onMessage(() => undefined);
  ws.send(JSON.stringify({ type: 'here', state }));
});
const tell = (message) => socket?.send(JSON.stringify(message));

async function seed() {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(
    async ({ PASS, ROOM, ME }) => {
      localStorage.setItem('reader.welcomed', 'true');
      localStorage.setItem('reader.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('reader.settings') || '{}'), navStyle: 'labelled', googleClientId: '', proxyToken: PASS }));
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
      await run('collections', (s) => s.put({ id: 'p-moe', name: 'Sparse-gated MoE', color: '#1f5e52', createdAt: new Date().toISOString(), project: { question: 'Can a router balance experts with no auxiliary loss?', startedAt: new Date().toISOString(), roles: { 'arxiv:2101.03961': 'baseline' }, todos: [], shared: { room: ROOM, owner: ME, role: 'owner' } } }));
      await run('collections', (s) => s.put({ id: 'p-plain', name: 'Reading list', color: '#b27414', createdAt: new Date().toISOString(), project: { question: '', startedAt: new Date().toISOString(), roles: {}, todos: [] } }));
      await run('papers', (s) => s.put({ id: 'arxiv:2101.03961', source: 'arxiv', title: 'Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity', authors: ['William Fedus', 'Barret Zoph', 'Noam Shazeer'], abstract: 'A simple, scalable Mixture of Experts.', published: '2021-01-11', categories: ['cs.LG'], addedAt: new Date().toISOString(), collectionIds: ['p-moe'], tags: [], progress: 0.3 }));
      db.close();
    },
    { PASS, ROOM, ME },
  );
}
const shot = (name) => page.screenshot({ path: join(OUT, `live-${name}.png`) });

console.log('the project bar: who is here');
await seed();
/** The opening screen (a build with a Google client id): past it, as someone keeping everything in this browser. */
async function pastWelcome() {
  const notNow = page.getByRole('button', { name: /^Not now/ });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
}
await page.goto(`${BASE}/project/?id=p-moe`, { waitUntil: 'networkidle' });
await pastWelcome();
await page.locator('.pj-people-btn').waitFor({ timeout: 15000 });
await page.waitForFunction(() => /\d here/.test(document.querySelector('.pj-people-n')?.textContent || ''), null, { timeout: 15000 });
check('the bar counts the people here now', /3 here/.test(await page.locator('.pj-people-n').innerText()), await page.locator('.pj-people-n').innerText());
check('four avatars, the one gone dimmed', (await page.locator('.pj-avatars .pj-av').count()) === 4 && (await page.locator('.pj-avatars .pj-av.is-gone').count()) === 1);
await shot('1-bar');

console.log('a card on one of them');
const priya = page.locator('.pj-avatars .pj-av[title^="Priya"]');
await priya.hover();
await page.locator('.pj-person').waitFor({ timeout: 5000 });
const card = await page.locator('.pj-person').innerText();
check('the card says where Priya is', /Priya Natarajan/.test(card) && /Code · train\.py · line 42/.test(card) && /Jump there/.test(card) && /Follow Priya/.test(card), card.replace(/\n/g, ' | '));
await shot('2-card');

console.log('everyone, in a list');
await page.mouse.move(10, 10);
await page.locator('.pj-people-btn').click();
await page.locator('.pj-people-list').waitFor({ timeout: 5000 });
const list = await page.locator('.pj-people-list').innerText();
check('here now, then earlier, with where each is', /here now/i.test(list) && /earlier/i.test(list) && /You\n.*Overview/.test(list) && /Lin Zhao/.test(list) && /Read · Switch Transformers/.test(list) && /Appear away/.test(list), list.replace(/\n/g, ' | '));
await shot('3-list');
await page.keyboard.press('Escape');

console.log('someone opens a file: a toast');
tell({ type: 'place', who: 'priya@example.org', place: place({ tab: 'code', path: 'src/router.py', line: 118, col: 1, offset: 4100 }) });
await page.locator('.pj-toast').waitFor({ timeout: 5000 });
check('the toast names the file, with a Jump', /Priya opened router\.py:118/.test(await page.locator('.pj-toast').innerText()) && (await page.locator('.pj-toast').getByRole('button', { name: 'Jump' }).count()) === 1, await page.locator('.pj-toast').innerText());
await shot('4-toast');

console.log('following');
await priya.hover();
await page.locator('.pj-person').getByRole('button', { name: /^Follow/ }).click();
await page.locator('.pj-following').waitFor({ timeout: 5000 });
await page.waitForFunction(() => document.querySelector('.pj-views button[aria-pressed="true"]')?.textContent === 'Code', null, { timeout: 5000 }).catch(() => undefined);
check('following opens the tab Priya is on, with a banner', /Following Priya/.test(await page.locator('.pj-following').innerText()) && (await page.locator('.pj-views').getByRole('button', { name: 'Code' }).getAttribute('aria-pressed')) === 'true');
await shot('5-following');
await page.keyboard.press('Escape');
check('Esc stops', (await page.locator('.pj-following').count()) === 0);

console.log('the share dialog');
await page.getByRole('button', { name: 'Share' }).click();
await page.locator('.pj-share').waitFor({ timeout: 5000 });
const dialog = await page.locator('.pj-share').innerText();
check('members with their roles, an invitation waiting, the link off', /Priya Natarajan/.test(dialog) && /dana@ethz\.ch/.test(dialog) && /Anyone with the link/.test(dialog) && /Owner/.test(dialog), dialog.replace(/\n/g, ' | '));
await page.locator('.pj-share-invite input').fill('new@example.org');
await page.locator('.pj-share-invite').getByRole('button', { name: 'Invite' }).click();
await page.locator('.pj-share-row.is-invited', { hasText: 'new@example.org' }).waitFor({ timeout: 5000 });
check('an invitation is added, with a link to copy', (await page.locator('.pj-share-row.is-invited').count()) === 2);
await shot('6-share');
await page.getByRole('button', { name: 'Done' }).click();

console.log('a project that is not shared');
await page.goto(`${BASE}/project/?id=p-plain`, { waitUntil: 'networkidle' });
await pastWelcome();
await page.getByRole('button', { name: 'Share' }).waitFor({ timeout: 10000 });
check('has the Share button, no people', (await page.locator('.pj-people-btn').count()) === 0);
await page.getByRole('button', { name: 'Share' }).click();
check('and the dialog offers to share it', /Share this project/.test(await page.locator('.pj-share').innerText()));
await shot('7-share-first');

await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nall good');
