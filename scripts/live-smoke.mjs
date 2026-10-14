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

// The site can send mail, as far as the page asks (/health is read once per address): invitations are emailed.
await page.route('**/api/health', async (route) => {
  const real = await route.fetch();
  route.fulfill({ json: { ...(await real.json().catch(() => ({}))), mail: true } });
});
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
      localStorage.setItem('reader.tour', 'seen');
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

console.log('the welcome page, opened from an invite link');
await page.route('**/api/invites/link/abcdefghjk**', (route) => route.fulfill({ json: { byName: 'Priya Natarajan', note: 'Have a look before Thursday?', expired: false, expiresAt: Date.now() + 86400000 } }));
await page.goto(`${BASE}/?invite=abcdefghjk`, { waitUntil: 'networkidle' });
await page.locator('.welcome-greeting').waitFor({ timeout: 10000 });
check('it greets by the inviter’s name, with the note', /Priya Natarajan invited you to Reader/.test(await page.locator('.welcome-greeting').innerText()) && /Have a look before Thursday\?/.test(await page.locator('.welcome-greeting').innerText()), await page.locator('.welcome-greeting').innerText());
await shot('9-welcome-invited');

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

console.log('an invitation opened by the wrong account');
await page.goto(`${BASE}/project/?id=p-moe&room=${ROOM}&as=saurav.varaprasad%40gmail.com`, { waitUntil: 'networkidle' });
await pastWelcome();
await page.locator('.pj-notice').waitFor({ timeout: 10000 });
const notice = await page.locator('.pj-notice').innerText();
check('the owner opening an invitee’s link is told whom it was for', /invitation for saurav\.varaprasad@gmail\.com, not for me@example\.org/.test(notice) && /opened your own copy of the project, as its owner/.test(notice), notice);
await shot('15-wrong-account');
await page.locator('.pj-notice').getByRole('button', { name: 'Got it' }).click();

console.log('the collaborators, on the overview and on the board');
await page.locator('.pj-views').getByRole('button', { name: 'Overview' }).click();
await page.locator('.pj-collab .pj-collab-list li').first().waitFor({ timeout: 10000 });
const collab = await page.locator('.pj-collab').innerText();
check('the overview lists everyone with their role and where they are', /collaborators · 4/i.test(collab) && /Priya Natarajan/.test(collab) && /can edit · here · Code · train\.py · line 42/.test(collab) && /Lin Zhao/.test(collab) && /last here/.test(collab) && /\(you\)\s*\n?\s*owner · here · Overview/.test(collab), collab.replace(/\n/g, ' | ').slice(0, 300));
await shot('13-overview-collaborators');
await page.locator('.pj-which-btn').click();
await page.getByRole('menuitem', { name: 'All projects' }).click();
await page.locator('.pj-card .pj-collab-stack').waitFor({ timeout: 10000 });
check('the board card stacks them, with how many are here now', /4 people · \d here now/.test(await page.locator('.pj-card .pj-collab-count').first().innerText()), await page.locator('.pj-card .pj-collab-count').first().innerText());
await shot('14-board-collaborators');
await page.locator('.pj-card').first().getByRole('button', { name: 'Overview' }).click();
await page.locator('.pj-people-btn').waitFor({ timeout: 10000 });

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

console.log('invite someone to try Reader');
await page.route('**/api/invite', (route) => route.fulfill({ json: { ok: true, to: route.request().postDataJSON().email } }));
await page.getByRole('button', { name: 'Just want to show someone Reader?' }).click();
await page.locator('.invite-someone').waitFor({ timeout: 5000 });
await page.locator('.invite-way', { hasText: 'An email from the site' }).click();
check('the dialog takes an address and a note', (await page.locator('.invite-someone input').count()) === 1 && (await page.locator('.invite-someone textarea').count()) === 1);
await page.locator('.invite-someone input').fill('colleague@uni.edu, other@uni.edu');
await page.locator('.invite-someone textarea').fill('Have a look before Thursday?');
check('the button counts the addresses', /Send 2 invitations/.test(await page.locator('.invite-someone .btn.primary').innerText()));
await shot('8-invite-someone');
await page.locator('.invite-someone .btn.primary').click();
await page.locator('.invite-someone-sent li').nth(1).waitFor({ timeout: 5000 });
const sentRows = await page.locator('.invite-someone-sent li').allInnerTexts();
check('each address is reported sent', sentRows.length === 2 && sentRows.every((row) => /sent/.test(row)), sentRows.join(' | '));
await page.getByRole('button', { name: 'Done' }).click();

console.log('a link to share, with a QR code');
await page.route('**/api/invites/link', (route) => route.fulfill({ json: { token: 'abcdefghjk', url: `${BASE}/?invite=abcdefghjk`, expiresAt: Date.now() + 30 * 86400000 } }));
await page.getByRole('button', { name: 'Share' }).click();
await page.getByRole('button', { name: 'Just want to show someone Reader?' }).click();
await page.locator('.invite-someone').waitFor({ timeout: 5000 });
await page.locator('.invite-someone textarea').fill('Have a look before Thursday?');
await page.getByRole('button', { name: 'Make the link' }).click();
await page.locator('.invite-someone .qr svg').waitFor({ timeout: 5000 });
check('the link is shown, with a QR code of it', /invite=abcdefghjk/.test(await page.locator('.invite-link-row code').innerText()) && (await page.locator('.invite-someone .qr svg rect').count()) > 100);
await shot('10-invite-link');
await page.locator('.invite-way', { hasText: 'From my own mail app' }).click();
await page.locator('.invite-someone input').fill('colleague@uni.edu');
const mailto = await page.locator('.invite-someone a.btn.primary').getAttribute('href');
check('the mail-app way is a mailto with the message filled in', typeof mailto === 'string' && mailto.startsWith('mailto:colleague%40uni.edu') && /Try%20it/.test(mailto), String(mailto).slice(0, 80));
await page.getByRole('button', { name: 'Done' }).click();

console.log('the projects waiting for you, on Home');
await page.route('**/api/invites/inbox', (route) => route.fulfill({ json: { invitations: [{ id: 'e1', room: ROOM, project: 'Sparse-gated MoE', role: 'editor', by: 'priya@example.org', byName: 'Priya Natarajan', at: Date.now() - 86400000 }] } }));
await page.route(`**/api/rooms/${ROOM}/join`, (route) => route.fulfill({ json: { ...state, me: ME, role: 'editor' } }));
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await pastWelcome();
// The bare address goes on to the page this tab left; Home is the rail's.
const homeItem = page.getByRole('button', { name: /^Home/ }).first();
if (await homeItem.isVisible().catch(() => false)) await homeItem.click();
await page.locator('.home-invite').waitFor({ timeout: 10000 });
check('the card names who invited you, to what, and your role', /Priya Natarajan invited you to/.test(await page.locator('.home-invite').innerText()) && /edit the project/.test(await page.locator('.home-invite').innerText()));
await shot('11-home-invited');
await page.locator('.home-invite').getByRole('button', { name: 'Join the project' }).click();
await page.locator('.pj-people-btn').waitFor({ timeout: 10000 });
check('Join opens the project, with the people in its bar', (await page.locator('.pj-which-btn').innerText()).includes('Sparse-gated MoE'));

console.log('the owner’s Invitations tab');
await page.route('**/api/usage/invites', (route) => route.fulfill({ json: { at: Date.now(), totals: { sent: 9, converted: 5 }, people: [
  { email: ME, name: 'Saurav C', sent: { project: 3, mail: 2, link: 2 }, converted: { project: 2, mail: 1, link: 1 }, last: Date.now() - 3600000, people: [
    { email: 'priya@example.org', name: 'Priya Natarajan', how: 'project', project: 'Sparse-gated MoE', at: Date.now() - 86400000 },
    { email: 'marco@example.org', name: 'Marco Ruiz', how: 'project', project: 'Sparse-gated MoE', at: Date.now() - 2 * 86400000 },
    { email: 'dana@ethz.ch', name: 'Dana K', how: 'mail', at: Date.now() - 3 * 86400000 },
    { email: 'lin@example.org', name: 'Lin Zhao', how: 'link', note: 'Have a look before Thursday?', at: Date.now() - 5 * 86400000 } ] },
  { email: 'priya@example.org', name: 'Priya Natarajan', sent: { project: 1, mail: 0, link: 1 }, converted: { project: 1, mail: 0, link: 0 }, last: Date.now() - 7 * 86400000, people: [ { email: 'kai@example.org', name: '', how: 'project', project: 'Thesis ch. 3', at: Date.now() - 8 * 86400000 } ] } ] } }));
// The owner is whoever /usage answers: a token that is not a pass, and the usage route stood in for.
await page.route(/\/api\/usage\?days=/, (route) => route.fulfill({ json: { since: '2026-10-01', until: '2026-10-15', people: [], totals: {} } }));
await page.evaluate(
  ({ ME }) => {
    localStorage.setItem('reader.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('reader.settings') || '{}'), proxyToken: 'owner-token' }));
    // A Google sign-in with Drive, as this tab keeps one: the page then counts itself signed in, and asks /usage.
    sessionStorage.setItem('reader.google.session', JSON.stringify({ accessToken: 'ya29.test', expiresAt: Date.now() + 3600_000, scopes: ['https://www.googleapis.com/auth/drive.file', 'openid', 'email', 'profile'], user: { name: 'Saurav C', email: ME } }));
  },
  { ME },
);
await page.goto(`${BASE}/usage`, { waitUntil: 'networkidle' });
await pastWelcome();
await page.waitForTimeout(1500);
const usageTab = page.getByRole('tab', { name: 'Invitations' });
if (await usageTab.isVisible().catch(() => false)) {
  await usageTab.click();
  await page.locator('.invites-table').waitFor({ timeout: 10000 });
  await page.locator('.invites-row').first().click();
  await page.locator('.invites-detail').waitFor({ timeout: 5000 });
  check('the tab tallies each person, and opens who took their invitations', (await page.locator('.invites-row').count()) === 2 && (await page.locator('.invites-detail li').count()) === 4);
  await shot('12-usage-invitations');
} else {
  console.log('  (the Usage page is not shown here: not the owner)');
}

console.log('a project that is not shared');
await page.goto(`${BASE}/project/?id=p-plain`, { waitUntil: 'networkidle' });
await pastWelcome();
await page.getByRole('button', { name: 'Share', exact: true }).waitFor({ timeout: 10000 });
check('has the Share button, no people', (await page.locator('.pj-people-btn').count()) === 0);
check('and the overview says it is just you', /Just you/.test(await page.locator('.pj-collab').innerText()));
await page.getByRole('button', { name: 'Share', exact: true }).click();
check('and the dialog offers to share it', /Share this project/.test(await page.locator('.pj-share').innerText()));
await shot('7-share-first');

await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nall good');
