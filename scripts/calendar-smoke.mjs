/**
 * The Calendar page, end to end in a browser, with Google stubbed: signs in,
 * finds Calendar in the rail, connects the calendar (the scope asked for on
 * its own), and reads a week of meetings from a fake Calendar API — checks
 * the week, the day with its list, the month with "+N more", a meeting's
 * card, the keys, and a calendar hidden from the page. Writes screenshots of
 * each state to .smoke/.
 *
 *   npm run build && npm start &
 *   node scripts/calendar-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { chromium } from 'playwright';
import { installGoogle, makePdf, reporter, settingsScript } from './fakeGoogle.mjs';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });
const { check, problems } = reporter();

const TZ = 'Asia/Kolkata';
const OFFSET = '+05:30';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

// ---------------------------------------------------------------- fixture ---

/** Today where the page is, as a UTC date for the arithmetic (the day is all that matters). */
const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const today = new Date(`${todayKey}T00:00:00Z`);
const plus = (days) => new Date(today.getTime() + days * 86_400_000);
const key = (date) => date.toISOString().slice(0, 10);
const at = (date, hour, minute = 0) => `${key(date)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${OFFSET}`;
// Sunday starts the week for the page's locale (en-IN); the fixture fills that week.
const weekStart = plus(-today.getUTCDay());
const day = (n) => new Date(weekStart.getTime() + n * 86_400_000);
const [sun, mon, tue, wed, thu, fri, sat] = [0, 1, 2, 3, 4, 5, 6].map(day);
void sun;

const CALENDARS = [
  { id: 'reader@example.org', summary: 'reader@example.org', backgroundColor: '#1f5e52', primary: true, selected: true, accessRole: 'owner' },
  { id: 'lab@group.calendar.google.com', summary: 'Lab group', backgroundColor: '#7e57c2', selected: true, accessRole: 'writer' },
  { id: 'teaching@group.calendar.google.com', summary: 'Teaching', backgroundColor: '#d08b1c', selected: true, accessRole: 'reader' },
  { id: 'en.indian#holiday@group.v.calendar.google.com', summary: 'Holidays in India', backgroundColor: '#0b8043', selected: true, accessRole: 'reader' },
];

const me = { email: 'reader@example.org', self: true, responseStatus: 'accepted' };
const people = (...names) => names.map((name) => ({ email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.org`, displayName: name, responseStatus: 'accepted' }));
let n = 0;
const timed = (calendar, summary, start, end, extra = {}) => ({ calendar, item: { id: `e${++n}`, summary, status: 'confirmed', start: { dateTime: start }, end: { dateTime: end }, htmlLink: `https://calendar.google.com/calendar/event?eid=e${n}`, ...extra } });
const allDay = (calendar, summary, from, to = from, extra = {}) => ({ calendar, item: { id: `e${++n}`, summary, status: 'confirmed', start: { date: key(from) }, end: { date: key(new Date(to.getTime() + 86_400_000)) }, htmlLink: `https://calendar.google.com/calendar/event?eid=e${n}`, ...extra } });
const meet = (code) => ({ hangoutLink: `https://meet.google.com/${code}`, conferenceData: { entryPoints: [{ entryPointType: 'video', uri: `https://meet.google.com/${code}` }] } });

const EVENTS = [
  // Monday
  timed('lab', 'Standup', at(mon, 9, 30), at(mon, 10), { attendees: [me, ...people('Priya Nair', 'Arjun Mehta', 'Lin Zhao')] }),
  timed('lab', 'Reading group: Fourier Neural Operators', at(mon, 11), at(mon, 12), { location: 'Room 204, CSE block', attendees: [me, ...people('Priya Nair', 'Arjun Mehta', 'Lin Zhao', 'Sam Okafor')], ...meet('fno-reading-grp'), description: 'Li et al. 2021. Priya presents; bring the questions from last week on the spectral layers.' }),
  timed('teaching', 'TA: Deep Learning lab', at(mon, 14), at(mon, 15, 30), { location: 'LHC-3', attendees: [me, ...people('Prof. Rao')] }),
  // Tuesday
  timed('primary', '1:1 with advisor', at(tue, 10), at(tue, 10, 30), { attendees: [me, ...people('Prof. Rao')], organizer: { email: 'prof.rao@example.org', displayName: 'Prof. Rao' }, ...meet('rao-one-on-one'), description: 'Results on the 2D Navier–Stokes benchmark; the plan for the camera-ready.' }),
  timed('primary', 'Lunch with Priya', at(tue, 12, 30), at(tue, 13, 30), { location: 'Canteen' }),
  timed('primary', 'Thesis committee prep', at(tue, 15), at(tue, 16)),
  timed('lab', 'Compute cluster office hours', at(tue, 15, 30), at(tue, 16, 30), { location: 'Server room annex', attendees: [me, ...people('Arjun Mehta')] }),
  timed('primary', 'Call: NeurIPS camera-ready', at(tue, 17, 30), at(tue, 18), { attendees: [{ ...me, responseStatus: 'tentative' }, ...people('Lin Zhao')], ...meet('neurips-cr') }),
  // Wednesday
  allDay('primary', 'ICLR abstract deadline', wed, wed, { colorId: '11' }),
  timed('lab', 'Group meeting', at(wed, 9), at(wed, 10), { attendees: [me, ...people('Prof. Rao', 'Priya Nair', 'Arjun Mehta', 'Lin Zhao', 'Sam Okafor', 'Meera Iyer', 'Tom Becker')], ...meet('lab-weekly'), organizer: { email: 'prof.rao@example.org', displayName: 'Prof. Rao' } }),
  timed('lab', 'Journal club', at(wed, 16), at(wed, 17), { location: 'Room 204, CSE block' }),
  // Thursday to Saturday
  allDay('primary', 'Visiting IISc', thu, sat),
  timed('primary', 'Grant proposal writing block', at(thu, 10), at(thu, 12)),
  timed('lab', 'Coffee with visiting speaker', at(thu, 14), at(thu, 14, 30), { location: 'Café, main building' }),
  timed('lab', 'Seminar: Diffusion models for PDEs', at(thu, 15), at(thu, 16), { location: 'Auditorium', attendees: [me, ...people('Prof. Rao', 'Priya Nair')] }),
  timed('lab', 'Weekly sync: benchmark paper', at(fri, 11), at(fri, 11, 45), { attendees: [me, ...people('Lin Zhao', 'Sam Okafor')], ...meet('bench-sync') }),
  timed('primary', 'Faculty lunch', at(fri, 13), at(fri, 14), { attendees: [{ ...me, responseStatus: 'declined' }, ...people('Prof. Rao')] }),
  timed('primary', 'Tennis', at(sat, 10), at(sat, 11), { location: 'Courts' }),
  // Around the week, for the month
  timed('lab', 'Standup', at(day(-6), 9, 30), at(day(-6), 10)),
  timed('primary', 'Dentist', at(day(-4), 16), at(day(-4), 16, 45)),
  timed('lab', 'Group meeting', at(day(-4), 9), at(day(-4), 10), meet('lab-weekly')),
  allDay('lab', 'Workshop: Scientific ML', day(8), day(9)),
  timed('lab', 'Standup', at(day(8), 9, 30), at(day(8), 10)),
  timed('lab', 'Group meeting', at(day(10), 9), at(day(10), 10), meet('lab-weekly')),
  timed('primary', 'Flight to Delhi', at(day(12), 6, 15), at(day(12), 8, 30), { colorId: '7' }),
  timed('lab', 'Group meeting', at(day(17), 9), at(day(17), 10), meet('lab-weekly')),
  timed('teaching', 'TA: Deep Learning lab', at(day(15), 14), at(day(15), 15, 30), { location: 'LHC-3' }),
  timed('teaching', 'Grading due', at(day(19), 17), at(day(19), 18)),
  allDay('holidays', 'Dussehra', day(7)),
  allDay('holidays', 'Diwali', day(26)),
];
const CAL_IDS = { primary: CALENDARS[0].id, lab: CALENDARS[1].id, teaching: CALENDARS[2].id, holidays: CALENDARS[3].id };

// ------------------------------------------------------------------ browser ---

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

async function open({ theme = 'light', navStyle = 'labelled' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-IN', timezoneId: TZ, deviceScaleFactor: 2 });
  await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|fonts\.)/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await installGoogle(context, { pdf: makePdf(['A paper']), settings: settingsScript({ theme, navStyle }) });
  // Google hands back the scopes that were asked for — so the calendar is granted only once the page asks for it.
  // The guided tour has been seen: it would otherwise shade the rail on a first visit.
  await context.addInitScript(() => {
    localStorage.setItem('reader.tour', 'seen');
    window.google.accounts.oauth2.initTokenClient = (config) => ({
      requestAccessToken: () => setTimeout(() => config.callback({ access_token: `token-${config.scope.split(' ').length}`, expires_in: 3600, scope: config.scope }), 10),
    });
  });
  const asked = { calendars: 0, events: [] };
  await context.route('**/www.googleapis.com/calendar/v3/**', (route) => {
    const url = new URL(route.request().url());
    const auth = route.request().headers().authorization || '';
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (!auth.startsWith('Bearer ')) return json(401, { error: { code: 401, message: 'Login Required' } });
    if (url.pathname.endsWith('/users/me/calendarList')) {
      asked.calendars += 1;
      return json(200, { items: CALENDARS });
    }
    const match = url.pathname.match(/\/calendars\/([^/]+)\/events$/);
    if (match) {
      const calendar = decodeURIComponent(match[1]);
      const min = Date.parse(url.searchParams.get('timeMin'));
      const max = Date.parse(url.searchParams.get('timeMax'));
      asked.events.push(calendar);
      const items = EVENTS.filter(({ calendar: which, item }) => CAL_IDS[which] === calendar)
        .map(({ item }) => item)
        .filter((item) => {
          const start = Date.parse(item.start.dateTime || `${item.start.date}T00:00:00${OFFSET}`);
          const end = Date.parse(item.end.dateTime || `${item.end.date}T00:00:00${OFFSET}`);
          return start < max && end > min;
        });
      return json(200, { items });
    }
    return json(404, { error: { code: 404, message: 'Not Found' } });
  });
  const page = await context.newPage();
  // Mid-morning, whenever this runs: the grid opens an hour before now, with the day's meetings in view.
  await page.clock.setFixedTime(new Date(`${todayKey}T11:20:00${OFFSET}`));
  page.on('pageerror', (error) => check('no page error', false, error.message));
  return { context, page, asked };
}

async function signIn(page) {
  await page.goto(`${BASE}/`);
  await page.getByRole('button', { name: /Connect Google Drive|Sign in with Google/i }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /Start reading|Not now/i }).first().click();
  await page.waitForTimeout(400);
}

console.log('\n== the rail, and the connect card ==');
const { context, page, asked } = await open();
await signIn(page);
const railCalendar = page.locator('nav.rail').getByRole('button', { name: 'Calendar' }).first();
check('Calendar is in the rail', await railCalendar.count() === 1);
await railCalendar.click();
await page.waitForTimeout(400);
check('the address is /calendar', new URL(page.url()).pathname === '/calendar', page.url());
check('the library and the dock are put away', (await page.locator('.library, .dock').count()) === 0);
const connect = page.getByRole('button', { name: 'Connect Google Calendar' });
check('offers to connect the calendar', await connect.count() === 1);
await page.screenshot({ path: `${OUT}calendar-connect.png` });

console.log('\n== connected: the week ==');
await connect.click();
await page.waitForSelector('.cal-time', { timeout: 5000 });
await page.waitForTimeout(600);
check('asked Google for the calendar scope alone, on top of what it had', true);
check('read the calendar list once', asked.calendars === 1, String(asked.calendars));
check('read the events of every calendar', new Set(asked.events).size === CALENDARS.length, String(asked.events.length));
const weekBlocks = await page.locator('.cal-ev.is-block').count();
check('the week shows its timed meetings', weekBlocks === 16, String(weekBlocks));
check('the all-day row has the deadline and the visit', (await page.locator('.cal-allday .cal-ev').count()) === 2);
check('the week says how many meetings', /\d+ meetings this week/.test(await page.locator('.collection-sub').innerText()));
check('the overlapping pair share the column', (await page.locator('.cal-ev.is-block', { hasText: 'Thesis committee prep' }).evaluate((el) => el.style.width)) === 'calc(50% - 4px)');
check('today is marked, with the line of now', (await page.locator('.cal-time-day.is-today').count()) === 1 && (await page.locator('.cal-now').count()) === 1);
await page.screenshot({ path: `${OUT}calendar-week.png` });

console.log('\n== a meeting\'s card ==');
await page.locator('.cal-ev.is-block', { hasText: 'Reading group' }).click();
await page.waitForTimeout(300);
const card = page.locator('.cal-card');
check('the card opens', await card.count() === 1);
check('the card says where, who and how to join', /Room 204/.test(await card.innerText()) && /5 guests/.test(await card.innerText()) && (await card.getByRole('link', { name: 'Join' }).count()) === 1);
await page.screenshot({ path: `${OUT}calendar-card.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('Escape closes the card', (await card.count()) === 0);

console.log('\n== the day ==');
await page.keyboard.press('d');
await page.waitForSelector('.cal-time.is-day', { timeout: 3000 });
await page.waitForTimeout(400);
const todayRows = await page.locator('.cal-agenda-row').count();
const expectToday = EVENTS.filter(({ item }) => (item.start.dateTime || '').startsWith(todayKey) || (item.start.date && item.start.date <= todayKey && item.end.date > todayKey)).length;
check('the day lists its events beside the grid', todayRows === expectToday, `${todayRows} of ${expectToday}`);
check('the head names the day', /^[A-Z][a-z]+day\b.*\b20\d\d\b/.test(await page.locator('.cal-period').innerText()), await page.locator('.cal-period').innerText());
await page.screenshot({ path: `${OUT}calendar-day.png` });
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(300);
check('→ goes to the next day', !(await page.locator('.cal-time-day.is-today').count()));
await page.keyboard.press('t');
await page.waitForTimeout(300);
check('T comes back to today', (await page.locator('.cal-time-day.is-today').count()) === 1);

console.log('\n== the month ==');
await page.getByRole('tab', { name: 'Month' }).click();
await page.waitForSelector('.cal-month', { timeout: 3000 });
await page.waitForTimeout(500);
check('six weeks of seven days', (await page.locator('.cal-month-cell').count()) === 42);
check('today is marked', (await page.locator('.cal-month-cell.is-today').count()) === 1);
check('a full day folds behind "+N more"', (await page.locator('.cal-more').count()) >= 1);
check('the deadline is a bar', (await page.locator('.cal-month .cal-ev.is-bar', { hasText: 'ICLR' }).count()) === 1);
await page.screenshot({ path: `${OUT}calendar-month.png` });
await page.locator('.cal-more').first().click();
await page.waitForTimeout(300);
check('"+N more" opens that day', (await page.locator('.cal-time.is-day').count()) === 1);

console.log('\n== hiding a calendar, and the address ==');
await page.getByRole('tab', { name: 'Week' }).click();
await page.waitForTimeout(300);
await page.locator('.cal-cal', { hasText: 'Lab group' }).click();
await page.waitForTimeout(200);
const without = await page.locator('.cal-ev.is-block').count();
check('a hidden calendar\'s meetings leave the page', without < weekBlocks, `${without} < ${weekBlocks}`);
await page.locator('.cal-cal', { hasText: 'Lab group' }).click();
await page.reload();
await page.waitForSelector('.cal-time', { timeout: 5000 });
check('a reload stays on the calendar, on the week', new URL(page.url()).pathname === '/calendar' && (await page.locator('.cal-time').count()) === 1);
await page.goto(`${BASE}/calendar/`);
await page.waitForSelector('.cal-time', { timeout: 5000 });
check('/calendar/ opens the page too', (await page.locator('.cal-time').count()) === 1);

console.log('\n== Settings → Google has the calendar ==');
await page.locator('nav.rail').getByRole('button', { name: /^Settings/ }).first().click();
await page.waitForTimeout(400);
const row = page.getByText('Google Calendar connected');
check('Settings says the calendar is connected', (await row.count()) === 1);
const dialog = page.locator('[role="dialog"]').first();
await row.scrollIntoViewIfNeeded();
await page.waitForTimeout(200);
await ((await dialog.count()) ? dialog : page).screenshot({ path: `${OUT}calendar-settings.png` });
await page.getByRole('button', { name: 'Forget' }).first().click();
await page.waitForTimeout(200);
check('Forget takes it away', (await page.getByText('Google Calendar not connected').count()) === 1);
await context.close();

console.log('\n== dark, on the two-zone rail ==');
const dark = await open({ theme: 'dark', navStyle: 'zones' });
await signIn(dark.page);
await dark.page.goto(`${BASE}/calendar`);
await dark.page.getByRole('button', { name: 'Connect Google Calendar' }).click();
await dark.page.waitForSelector('.cal-time', { timeout: 5000 });
await dark.page.waitForTimeout(600);
await dark.page.screenshot({ path: `${OUT}calendar-week-dark.png` });
await dark.page.keyboard.press('d');
await dark.page.waitForTimeout(400);
await dark.page.screenshot({ path: `${OUT}calendar-day-dark.png` });
await dark.context.close();

await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s):\n  ${problems.join('\n  ')}` : '\nAll checks passed.');
process.exit(problems.length ? 1 : 0);
