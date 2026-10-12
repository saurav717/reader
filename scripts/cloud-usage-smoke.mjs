/**
 * The Usage page's Google Cloud tab, with the Worker's /usage routes standing
 * in: the tabs, the billing account and Recharge, each service with Start and
 * Stop, the cost by service and the transactions — and the People tab
 * without the LaTeX compiler in its middle. Writes screenshots to .smoke/.
 *
 *   npm run build && npm start &
 *   node scripts/cloud-usage-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { chromium } from 'playwright';
import { installGoogle, settingsScript } from './fakeGoogle.mjs';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });

const problems = [];
function check(label, condition, detail = '') {
  if (!condition) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const DAY = 86_400_000;
const today = Date.now();
const day = (back) => new Date(today - back * DAY).toISOString().slice(0, 10);
const wave = (back, scale) => Math.round(scale * (1.2 + Math.sin(back / 2.3)) * (back % 7 < 5 ? 1 : 0.4));

const people = ['you@example.org', 'labmate@gmail.com', 'coauthor@uni.edu'].map((email, who) => {
  const daily = Array.from({ length: 30 }, (_, back) => ({ day: day(29 - back), signin: 1, scholar: wave(back + who, 6), pdf: wave(back + who, 3), latex: wave(back + who * 2, 9 - who * 3), latex_s: wave(back + who * 2, 9 - who * 3) * 14 }));
  const total = {};
  for (const row of daily) for (const [key, value] of Object.entries(row)) if (key !== 'day') total[key] = (total[key] || 0) + value;
  return { email, total, today: daily.at(-1), daily, days: 30, last: today - who * 3_600_000 };
});
const totals = {};
for (const person of people) for (const [key, value] of Object.entries(person.total)) totals[key] = (totals[key] || 0) + value;
const REPORT = { days: 30, since: day(29), until: day(0), people, totals, models: {} };

const runDaily = (scale) => Array.from({ length: 30 }, (_, back) => ({ day: day(29 - back), n: wave(back, scale) }));
const services = [
  { kind: 'cloudrun', id: 'projects/reader-509409/locations/us-central1/services/reader-latex', name: 'reader-latex', location: 'us-central1', type: 'Cloud Run service', status: 'running', detail: 'https://reader-latex-fgk7igwsuq-uc.a.run.app', billing: 'scales to zero: billed only while serving requests', billedIdle: false, consoleUrl: 'https://console.cloud.google.com/run', daily: runDaily(40) },
  { kind: 'cloudrun', id: 'projects/reader-509409/locations/us-central1/services/reader-figures', name: 'reader-figures', location: 'us-central1', type: 'Cloud Run service', status: 'stopped', detail: 'closed to the internet (internal ingress)', billing: 'closed: costs nothing while it stays so', billedIdle: false, consoleUrl: 'https://console.cloud.google.com/run', daily: runDaily(6) },
  { kind: 'vm', id: 'projects/reader-509409/zones/us-central1-a/instances/gpu-box', name: 'gpu-box', location: 'us-central1-a', type: 'VM · g2-standard-4', status: 'stopped', detail: 'terminated', consoleUrl: 'https://console.cloud.google.com/compute' },
  { kind: 'vm', id: 'projects/reader-509409/zones/us-central1-a/instances/notebook-cpu', name: 'notebook-cpu', location: 'us-central1-a', type: 'VM · e2-standard-2', status: 'running', detail: `up since ${day(3)}T08:12:44Z`, consoleUrl: 'https://console.cloud.google.com/compute' },
].map((service) => (service.daily ? { ...service, requests: service.daily.reduce((s, p) => s + p.n, 0), instanceSeconds: service.daily.reduce((s, p) => s + p.n, 0) * 13 } : service));

const SKUS = [
  ['Cloud Run', 'CPU Allocation Time (tier 1)', 0.0, 'vCPU-second'],
  ['Cloud Run', 'Memory Allocation Time (tier 1)', 0.0, 'GiB-second'],
  ['Artifact Registry', 'Artifact Registry Storage', 0.0, 'gibibyte month'],
  ['Compute Engine', 'E2 Instance Core running in Americas', 0.0, 'hour'],
  ['Compute Engine', 'Storage PD Capacity', 0.0, 'gibibyte month'],
  ['Cloud Monitoring', 'Monitoring API Requests', 0.0, 'request'],
];
const charges = [];
for (let back = 0; back < 40; back += 1) {
  for (const [index, [service, sku, , unit]] of SKUS.entries()) {
    if ((back + index) % 3 === 2) continue;
    const cost = Math.round((0.05 + ((back * 7 + index * 13) % 23) / 20) * 100) / 100 * (service === 'Compute Engine' ? 2.4 : 0.6);
    const credits = service === 'Cloud Run' ? -cost : 0;
    charges.push({ day: day(back), service, sku, type: 'regular', currency: 'USD', cost: +cost.toFixed(2), credits: +credits.toFixed(2), amount: Math.round(cost * 4000) / 10, unit });
  }
}
charges.push({ day: day(5), service: 'Compute Engine', sku: 'Sales tax', type: 'tax', currency: 'USD', cost: 1.12, credits: 0, amount: null, unit: '' });
const month = day(0).slice(0, 7);
const inMonth = charges.filter((c) => c.day.startsWith(month));
const byService = [...new Set(inMonth.map((c) => c.service))].map((service) => {
  const rows = inMonth.filter((c) => c.service === service);
  const cost = rows.reduce((s, c) => s + c.cost, 0);
  const credits = rows.reduce((s, c) => s + c.credits, 0);
  return { service, cost: +cost.toFixed(2), credits: +credits.toFixed(2), net: +(cost + credits).toFixed(2) };
}).sort((a, b) => b.net - a.net);
const daysNet = [...new Set(charges.map((c) => c.day))].sort().map((d) => ({ day: d, net: +charges.filter((c) => c.day === d).reduce((s, c) => s + c.cost + c.credits, 0).toFixed(2) }));
const cost = inMonth.reduce((s, c) => s + c.cost, 0);
const credits = inMonth.reduce((s, c) => s + c.credits, 0);
let OVERVIEW = {
  configured: true,
  project: 'reader-509409',
  at: today,
  billing: { id: '0123AB-CDEF45-678901', name: 'My Billing Account', open: true, enabled: true, currency: 'USD', overviewUrl: 'https://console.cloud.google.com/billing/0123AB-CDEF45-678901', paymentUrl: 'https://console.cloud.google.com/billing/0123AB-CDEF45-678901/payment', reportsUrl: 'https://console.cloud.google.com/billing/0123AB-CDEF45-678901/reports' },
  services,
  errors: {},
  costs: { month, currency: 'USD', cost: +cost.toFixed(2), credits: +credits.toFixed(2), net: +(cost + credits).toFixed(2), byService, days: daysNet, charges },
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const routes = [];
const actions = [];
routes.push([/^https?:\/\/(?!localhost|127\.0\.0\.1|fonts\.)/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })]);
routes.push(['**/api/usage**', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (request.headers().authorization !== 'Bearer owner-token') return json({ error: 'owner' }, 401);
  if (url.pathname.endsWith('/usage')) return json(REPORT);
  if (url.pathname.endsWith('/usage/latex')) return json({ configured: true, on: 'cloudrun', cpu: 2, memoryGib: 4, free: { vcpuSeconds: 180000, gibSeconds: 360000, requests: 2000000 } });
  if (url.pathname.endsWith('/usage/gcloud')) return json(OVERVIEW);
  if (url.pathname.endsWith('/usage/gcloud/service')) {
    const body = JSON.parse(request.postData() || '{}');
    actions.push(body);
    const status = body.action === 'stop' ? 'stopped' : 'running';
    const detail = (s) => (s.kind === 'vm' ? status === 'running' ? `up since ${new Date().toISOString().slice(0, 19)}Z` : 'terminated' : status === 'running' ? `https://${s.name}-fgk7igwsuq-uc.a.run.app` : 'closed to the internet (internal ingress)');
    OVERVIEW = { ...OVERVIEW, services: OVERVIEW.services.map((s) => (s.id === body.id ? { ...s, status, detail: detail(s), ...(s.kind === 'cloudrun' ? { billing: status === 'running' ? 'scales to zero: billed only while serving requests' : 'closed: costs nothing while it stays so' } : {}) } : s)) };
    return json({ ok: true, status: body.action === 'stop' ? 'stopping' : 'starting' });
  }
  return json({ configured: false });
}]);
for (const [pattern, handler] of routes) await context.route(pattern, handler);

await installGoogle(context, { settings: settingsScript({ proxyToken: 'owner-token' }), profile: { name: 'You', email: 'you@example.org' } });

const errors = [];
/** A page signed in as the owner, on the Usage page. */
async function openUsage(on) {
  const page = await on.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(BASE, { waitUntil: 'networkidle' });
  // Past the connect screen; a second page, already welcomed, has no Start reading after it.
  await page.getByRole('button', { name: /Connect Google Drive|Sign in with Google/i }).first().click();
  await page.waitForTimeout(600);
  const enter = page.getByRole('button', { name: /Start reading|Not now/i });
  if (await enter.count()) await enter.first().click();
  await page.getByRole('button', { name: 'Usage', exact: true }).first().click();
  return page;
}
const page = await openUsage(context);
await page.getByRole('tab', { name: 'People & services' }).waitFor();
await page.waitForTimeout(600);
check('the page opens on People & services', (await page.getByRole('tab', { name: 'People & services' }).getAttribute('aria-selected')) === 'true');
check('People & services no longer has the LaTeX compiler in its middle', (await page.getByRole('heading', { name: 'LaTeX compiler' }).count()) === 0);
await page.screenshot({ path: `${OUT}/cloud-1-people-tab.png` });

await page.getByRole('tab', { name: 'Google Cloud' }).click();
await page.getByRole('heading', { name: 'Services' }).waitFor();
await page.waitForTimeout(500);
check('the billing account', await page.getByText('My Billing Account').first().isVisible());
const recharge = page.getByRole('link', { name: 'Recharge' });
check('Recharge opens the billing account’s payment page', (await recharge.getAttribute('href'))?.endsWith('/0123AB-CDEF45-678901/payment'));
check('every service listed', (await page.getByRole('button', { name: /^(Start|Stop)$/ }).count()) === 4);
await page.screenshot({ path: `${OUT}/cloud-2-overview.png` });

// Stop the running VM.
const vmRow = page.locator('tr', { hasText: 'notebook-cpu' });
await vmRow.getByRole('button', { name: 'Stop' }).click();
await page.waitForTimeout(300);
check('Stop asked the Worker to stop that VM', actions.at(-1)?.action === 'stop' && actions.at(-1)?.id.endsWith('/notebook-cpu'));
check('the row says it is stopping', await vmRow.getByText('Stopping').first().isVisible());
await page.screenshot({ path: `${OUT}/cloud-3-stopping.png` });
// Start the stopped Cloud Run service.
const runRow = page.locator('tr', { hasText: 'reader-figures' });
await runRow.getByRole('button', { name: 'Start' }).click();
await page.waitForTimeout(300);
check('Start asked the Worker to start that service', actions.at(-1)?.action === 'start' && actions.at(-1)?.id.endsWith('/reader-figures'));
await page.waitForTimeout(4500);
check('after a look again, the VM is stopped', await vmRow.getByRole('button', { name: 'Start' }).isVisible());

// The whole tab, tall enough for the transactions and the compiler.
await page.setViewportSize({ width: 1440, height: 2700 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/cloud-4-full.png` });
await page.setViewportSize({ width: 1440, height: 900 });
await page.getByRole('heading', { name: 'Transactions' }).scrollIntoViewIfNeeded();
await page.locator('input[type="search"], input[placeholder*="Search" i]').last().fill('Compute');
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/cloud-5-transactions.png` });
check('the transactions filter', (await page.locator('tr', { hasText: 'Cloud Run' }).filter({ hasText: 'CPU Allocation' }).count()) === 0);

// Dark, as the owner may have it, in a page of its own: the tab is remembered.
const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, storageState: await context.storageState() });
for (const [pattern, handler] of routes) await dark.route(pattern, handler);
await installGoogle(dark, { settings: settingsScript({ proxyToken: 'owner-token', theme: 'dark' }), profile: { name: 'You', email: 'you@example.org' } });
const darkPage = await openUsage(dark);
await darkPage.getByRole('heading', { name: 'Services' }).waitFor();
check('the tab is remembered', (await darkPage.getByRole('tab', { name: 'Google Cloud' }).getAttribute('aria-selected')) === 'true');
await darkPage.waitForTimeout(600);
await darkPage.screenshot({ path: `${OUT}/cloud-6-dark.png` });

// Narrow.
await darkPage.setViewportSize({ width: 390, height: 844 });
await darkPage.waitForTimeout(400);
await darkPage.screenshot({ path: `${OUT}/cloud-7-phone.png` });

check('no page errors', !errors.length, errors.join(' | '));
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log('\nall good');
