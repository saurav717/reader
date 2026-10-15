/**
 * Meetings and the project logbook, end to end in a browser, with Google,
 * Zoom, Granola and the project's room stood in for: a meeting made on the
 * Calendar with a Zoom call made for it, Granola asked to take notes and a
 * project picked; a meeting that has ended, its Granola notes read back and
 * filed in the shared project's logbook; and the logbook's four tabs —
 * Meetings, Links, Notepad and Whiteboard — with the others in the project
 * writing and drawing in them. Writes screenshots to .smoke/ (SMOKE_OUT).
 *
 *   npm run build && npm start &
 *   node scripts/logbook-smoke.mjs        # SMOKE_BASE=http://localhost:8080
 */
import { chromium } from 'playwright';
import { installGoogle, makePdf, reporter, settingsScript } from './fakeGoogle.mjs';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8080';
const OUT = process.env.SMOKE_OUT || new URL('../.smoke/', import.meta.url).pathname;
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });
const { check, problems } = reporter();

const TZ = 'Asia/Kolkata';
const OFFSET = '+05:30';
const ME = 'reader@example.org';
const ROOM = 'bead'.padEnd(32, '0');
// A pass as the app reads it — the Worker's, here stood in for — so the room's live socket opens.
const PASS = `rp1.${Buffer.from(JSON.stringify({ e: 'reader@example.org', x: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`;
const PROJECT = 'p-moe';
const LAB = 'lab@group.calendar.google.com';

// ---------------------------------------------------------------- fixture ---

const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const today = new Date(`${todayKey}T00:00:00Z`);
const plus = (days) => new Date(today.getTime() + days * 86_400_000);
const key = (date) => date.toISOString().slice(0, 10);
const at = (date, hour, minute = 0) => `${key(date)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${OFFSET}`;
const iso = (date, hour, minute = 0) => new Date(at(date, hour, minute)).toISOString();

const CALENDARS = [
  { id: ME, summary: ME, backgroundColor: '#1f5e52', primary: true, selected: true, accessRole: 'owner' },
  { id: LAB, summary: 'Lab group', backgroundColor: '#7e57c2', selected: true, accessRole: 'writer' },
];
const me = { email: ME, self: true, responseStatus: 'accepted' };
const people = (...names) => names.map((name) => ({ email: `${name.toLowerCase().split(' ')[0]}@example.org`, displayName: name, responseStatus: 'accepted' }));
const team = people('Priya Natarajan', 'Marco Ruiz', 'Lin Zhao');
const zoom = (id) => ({ location: `https://iith.zoom.us/j/${id}`, description: `Join Zoom: https://iith.zoom.us/j/${id}`, extendedProperties: { private: { readerZoom: `https://iith.zoom.us/j/${id}`, readerNotes: 'granola' } } });
let n = 0;
const timed = (calendar, summary, start, end, extra = {}) => ({ calendar, item: { id: `e${++n}`, summary, status: 'confirmed', start: { dateTime: start }, end: { dateTime: end }, htmlLink: `https://calendar.google.com/calendar/event?eid=e${n}`, ...extra } });
const weekly = (date, extra = {}) => ({ calendar: LAB, item: { id: `moe-weekly_${key(date).replace(/-/g, '')}T033000Z`, recurringEventId: 'moe-weekly', summary: 'MoE weekly', status: 'confirmed', start: { dateTime: at(date, 9) }, end: { dateTime: at(date, 10) }, attendees: [me, ...team], organizer: { email: ME, displayName: 'Saurav C' }, htmlLink: 'https://calendar.google.com/calendar/event?eid=w', ...zoom('8123456789'), ...extra } });

const EVENTS = [
  weekly(plus(-14)),
  weekly(plus(-7)),
  weekly(plus(0)),
  weekly(plus(7)),
  timed(LAB, 'Router ablations sync', at(plus(0), 15), at(plus(0), 15, 45), { attendees: [me, ...people('Priya Natarajan')], ...zoom('8555123456') }),
  timed(ME, 'Reading group: Expert Choice routing', at(plus(1), 11), at(plus(1), 12), { attendees: [me, ...team], hangoutLink: 'https://meet.google.com/abc-moe-read', conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-moe-read' }] } }),
  timed(ME, '1:1 with Prof. Rao', at(plus(2), 16), at(plus(2), 16, 30)),
  timed(ME, 'Lunch', at(plus(0), 13), at(plus(0), 14), { location: 'Canteen' }),
  timed(LAB, 'Seminar: Scaling laws', at(plus(3), 15), at(plus(3), 16), { location: 'Auditorium' }),
];
// The ablations sync is this project's on its own; the weekly, as a whole series.
const ablations = EVENTS.find((event) => event.item.summary === 'Router ablations sync').item;
const MEETINGS = { [`${LAB}:moe-weekly`]: { title: 'MoE weekly', taggedAt: '2026-09-01T00:00:00.000Z' }, [`${LAB}:${ablations.id}`]: { title: 'Router ablations sync', taggedAt: '2026-09-01T00:00:00.000Z' } };

// What Granola wrote of this morning's weekly, as its API gives it.
const GRANOLA_TODAY = {
  id: 'not_7Hq2',
  title: 'MoE weekly',
  created_at: iso(plus(0), 10, 2),
  web_url: 'https://notes.granola.ai/d/7Hq2',
  calendar_event: { event_title: 'MoE weekly', scheduled_start_time: iso(plus(0), 9), scheduled_end_time: iso(plus(0), 10), invitees: team.map((person) => ({ email: person.email })) },
  summary_markdown: [
    '### Where we are',
    '- Expert-choice routing beats top-2 on the 1.3B model by **0.04 loss** at equal compute, but collapses after ~40k steps without the z-loss.',
    '- Priya’s [ablation sheet](https://docs.google.com/spreadsheets/d/1abl8/edit) has all twelve runs; the capacity-factor sweep is in tab 2.',
    '- Marco found the load-balancing bug: the auxiliary loss was averaged over the wrong axis (see https://github.com/iith-ml/moe-routing/pull/41).',
    '',
    '### Decisions',
    '- Drop the auxiliary loss entirely for the next round; keep the router z-loss at 1e-3.',
    '- Use the C4 subset from https://huggingface.co/datasets/allenai/c4 for every comparison from now on.',
    '',
    '### Action items',
    '- **Priya**: rerun the 1.3B expert-choice run with z-loss and no aux loss',
    '- **Marco**: merge the load-balancing fix and rerun the top-2 baseline',
    '- **Saurav**: draft §4 (Routing without auxiliary losses) in Overleaf by Friday',
    '- Lin to book 2×8 H100s for next week',
  ].join('\n'),
};

// ---- the room: its members and the logbook it keeps
const place = (more) => ({ active: true, at: Date.now(), ...more });
const MEMBERS = [
  { email: ME, role: 'owner', name: 'Saurav C', color: '#8a3a6e', joinedAt: '2026-09-01T00:00:00.000Z', place: null, lastSeen: null, lastPlace: null },
  { email: 'priya@example.org', role: 'editor', name: 'Priya Natarajan', color: '#b27414', joinedAt: '2026-09-02T00:00:00.000Z', place: place({ tab: 'logbook', path: 'board' }), lastSeen: null, lastPlace: null },
  { email: 'marco@example.org', role: 'editor', name: 'Marco Ruiz', color: '#2d64a0', joinedAt: '2026-09-03T00:00:00.000Z', place: place({ tab: 'logbook', path: 'notepad' }), lastSeen: null, lastPlace: null },
  { email: 'lin@example.org', role: 'viewer', name: 'Lin Zhao', color: '#1f8a70', joinedAt: '2026-09-04T00:00:00.000Z', place: null, lastSeen: Date.now() - 3 * 3600_000, lastPlace: place({ tab: 'read' }) },
];
const SUMMARY = { id: PROJECT, name: 'Sparse-gated MoE', color: '#1f5e52', question: 'Can a router balance experts with no auxiliary loss?', startedAt: '2026-09-01T00:00:00.000Z', papers: [], todos: [] };
const roomState = () => ({ room: ROOM, owner: ME, version: 1, project: SUMMARY, me: ME, role: 'owner', members: MEMBERS, invitations: [], link: { token: 't', on: false, domain: '' } });

// ---- the board: a diagram drawn by hand, in a little stroke font
const GLYPHS = {
  R: [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]], [[2, 3], [4, 6]]],
  O: [[[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]]],
  U: [[[0, 0], [0, 5], [1, 6], [3, 6], [4, 5], [4, 0]]],
  T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
  E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]],
  P: [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]]],
  L: [[[0, 0], [0, 6], [4, 6]]],
  A: [[[0, 6], [2, 0], [4, 6]], [[1, 3.6], [3, 3.6]]],
  D: [[[0, 0], [0, 6], [2.5, 6], [4, 4.5], [4, 1.5], [2.5, 0], [0, 0]]],
  B: [[[0, 3], [0, 0], [3, 0], [3.8, 0.8], [3.8, 2.2], [3, 3], [0, 3], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3]]],
  N: [[[0, 6], [0, 0], [4, 6], [4, 0]]],
  C: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5]]],
  K: [[[0, 0], [0, 6]], [[4, 0], [0, 3.5]], [[1.3, 2.7], [4, 6]]],
  S: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 2], [1, 3], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]],
  G: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 3.5], [2.5, 3.5]]],
  M: [[[0, 6], [0, 0], [2, 3], [4, 0], [4, 6]]],
  I: [[[2, 0], [2, 6]], [[1, 0], [3, 0]], [[1, 6], [3, 6]]],
  X: [[[0, 0], [4, 6]], [[4, 0], [0, 6]]],
  Z: [[[0, 0], [4, 0], [0, 6], [4, 6]]],
  1: [[[1, 1], [2, 0], [2, 6]]],
  2: [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [0, 6], [4, 6]]],
  3: [[[0, 0.5], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [1.5, 3]], [[3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5.5]]],
  4: [[[3, 6], [3, 0], [0, 4], [4, 4]]],
  '-': [[[0.5, 3], [3.5, 3]]],
  '?': [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [2, 3.5], [2, 4.5]], [[2, 5.7], [2, 6]]],
};
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const jitter = (amount) => (rand() - 0.5) * amount;
let sid = 0;
/** A stroke along a polyline, with points every few units, a hand's wobble, and a pen's pressure rising and falling. */
function stroke(points, { color = '#1a1a17', width = 3, tool = 'pen', by = ME, wobble = 1.2 } = {}) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [[x1, y1], [x2, y2]] = [points[i], points[i + 1]];
    const steps = Math.max(2, Math.round(Math.hypot(x2 - x1, y2 - y1) / 6));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const along = (i + t) / (points.length - 1);
      out.push(Math.round((x1 + (x2 - x1) * t + jitter(wobble)) * 10) / 10, Math.round((y1 + (y2 - y1) * t + jitter(wobble)) * 10) / 10, Math.round((0.35 + 0.5 * Math.sin(Math.PI * along) + jitter(0.08)) * 100) / 100);
    }
  }
  const [lx, ly] = points[points.length - 1];
  out.push(lx, ly, 0.3);
  return { id: `s${++sid}`, by, color, width, tool, points: out, at: new Date(Date.now() - (400 - sid) * 1000).toISOString() };
}
function write(text, x, y, size, options) {
  const strokes = [];
  const unit = size / 6;
  let cursor = x;
  for (const char of text) {
    if (char === ' ') {
      cursor += unit * 4;
      continue;
    }
    for (const line of GLYPHS[char] ?? []) strokes.push(stroke(line.map(([gx, gy]) => [cursor + gx * unit + jitter(unit * 0.15), y + gy * unit + jitter(unit * 0.15)]), { ...options, wobble: unit * 0.12 }));
    cursor += unit * 6;
  }
  return strokes;
}
const box = (x, y, w, h, options) => stroke([[x, y], [x + w, y + 2], [x + w - 1, y + h], [x + 1, y + h - 1], [x, y + 3]], options);
const arrow = (x1, y1, x2, y2, options) => {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = 16;
  return [stroke([[x1, y1], [x2, y2]], options), stroke([[x2 - head * Math.cos(angle - 0.45), y2 - head * Math.sin(angle - 0.45)], [x2, y2], [x2 - head * Math.cos(angle + 0.45), y2 - head * Math.sin(angle + 0.45)]], options)];
};
const ellipse = (cx, cy, rx, ry, options) => stroke(Array.from({ length: 34 }, (_, i) => [cx + rx * Math.cos((i / 30) * Math.PI * 2 - 0.4), cy + ry * Math.sin((i / 30) * Math.PI * 2 - 0.4)]), options);

const PRIYA = 'priya@example.org';
const MARCO = 'marco@example.org';
const BOARD = [
  ...write('MOE ROUTING', 70, 60, 34, { width: 3.4 }),
  stroke([[66, 112], [420, 116]], { width: 2.4 }),
  box(80, 400, 190, 110),
  ...write('TOKENS', 104, 438, 26, { width: 2.8 }),
  ...arrow(285, 455, 455, 455),
  box(470, 380, 230, 150),
  ...write('ROUTER', 508, 438, 28, { width: 3 }),
  ...[0, 1, 2, 3].flatMap((i) => [box(940, 180 + i * 175, 170, 110), ...write(`E${i + 1}`, 1000, 215 + i * 175, 30, { width: 3 })]),
  ...arrow(705, 425, 930, 240, { color: '#2d64a0', width: 3 }),
  ...arrow(705, 445, 930, 410, { color: '#2d64a0', width: 3 }),
  ...arrow(705, 470, 930, 585, { color: '#2d64a0', width: 1.6 }),
  ...arrow(705, 490, 930, 760, { color: '#2d64a0', width: 1.6 }),
  stroke([[742, 300], [905, 300]], { tool: 'marker', color: '#b27414', width: 9, wobble: 0.6 }),
  ...write('TOP-2', 760, 282, 22, { color: '#c0392b', width: 2.6 }),
  ellipse(1290, 520, 175, 70, { color: '#c0392b', width: 2.6, by: PRIYA }),
  ...write('LOAD BALANCE?', 1150, 506, 22, { color: '#c0392b', width: 2.4, by: PRIYA }),
  ...arrow(1215, 455, 1120, 360, { color: '#c0392b', width: 2.2, by: PRIYA }),
  ...write('NO AUX LOSS', 1150, 640, 22, { color: '#1f8a70', width: 2.6, by: MARCO }),
  ...write('Z-LOSS 1E-3', 1150, 690, 22, { color: '#1f8a70', width: 2.6, by: MARCO }),
  ...arrow(1165, 740, 1120, 790, { color: '#1f8a70', width: 2, by: MARCO }),
];
/** What Priya is drawing right now: a check by the second expert, half done. */
const PRIYA_INK = stroke([[1125, 400], [1140, 420], [1170, 372]], { color: '#b27414', width: 4, by: PRIYA });

const NOTE = (id, days, markdown, extra = {}) => ({ id, meeting: `${LAB}:moe-weekly_${key(plus(days)).replace(/-/g, '')}T033000Z`, title: 'MoE weekly', start: iso(plus(days), 9), end: iso(plus(days), 10), source: 'granola', url: `https://notes.granola.ai/d/${id}`, call: 'https://iith.zoom.us/j/8123456789', attendees: ['Priya Natarajan', 'Marco Ruiz', 'Lin Zhao'], markdown, by: ME, at: iso(plus(days), 10, 5), ...extra });
const LOG = {
  notes: [
    NOTE('granola:not_5Kd1', -7, '### Where we are\n- Top-2 baseline reproduced at 350M; matches the paper within 0.01.\n- Expert-choice run diverges at 12k steps.\n\n### Action items\n- [x] Priya: write the capacity-factor sweep\n- [ ] Marco: find why the aux loss rises with batch size\n- [ ] Book time on the cluster for the 1.3B runs\n\nRecording: https://iith.zoom.us/rec/share/Ab3x9'),
    NOTE('granola:not_2Qm8', -14, '### Kick-off\n- Question: can a router balance experts with no auxiliary loss?\n- Baselines: Switch, top-2 GShard, Expert Choice.\n- Reading list in the [project doc](https://docs.google.com/document/d/1moe/edit).\n\n### Action items\n- Saurav: set up the repo and the Overleaf project'),
  ],
  links: [
    { id: 'l1', url: 'https://www.overleaf.com/project/66f0moe', title: 'Paper draft — Routing without auxiliary losses', note: 'Section 4 is Saurav’s this week.', pinned: true, by: ME, at: iso(plus(-12), 12) },
    { id: 'l2', url: 'https://docs.google.com/spreadsheets/d/1runs/edit', title: 'Run tracker', note: 'Every run, its config and its loss at 10k/40k steps.', pinned: true, by: PRIYA, at: iso(plus(-10), 12) },
    { id: 'l3', url: 'https://github.com/iith-ml/moe-routing', title: 'iith-ml/moe-routing', note: '', pinned: false, by: ME, at: iso(plus(-13), 12) },
    { id: 'l4', url: 'https://wandb.ai/iith-ml/moe-routing/reports/Expert-choice-vs-top-2', title: 'W&B report: expert choice vs top-2', note: 'Updated after every sweep.', pinned: false, by: MARCO, at: iso(plus(-3), 18) },
    { id: 'l5', url: 'https://docs.google.com/presentation/d/1lab/edit', title: 'Lab meeting slides (Oct)', note: '', pinned: false, by: PRIYA, at: iso(plus(-6), 9) },
    { id: 'l6', url: 'https://arxiv.org/abs/2202.09368', title: 'Mixture-of-Experts with Expert Choice Routing', note: 'The baseline we beat at 1.3B.', pinned: false, by: 'lin@example.org', at: iso(plus(-9), 9) },
  ],
  pad: {
    text: [
      '# Sparse-gated MoE — running notes',
      '',
      '## This week',
      '- [x] Reproduce top-2 at 350M',
      '- [ ] 1.3B expert choice **without** aux loss, z-loss 1e-3',
      '- [ ] Fix the aux-loss axis bug (Marco, PR #41)',
      '',
      '## Numbers to beat',
      '| Model | Router | Loss @ 40k |',
      '|---|---|---|',
      '| 1.3B | top-2 + aux | 2.412 |',
      '| 1.3B | expert choice | 2.371 |',
      '',
      '## GPU this week',
      'Priya Mon–Wed, Marco Thu–Fri. Ask in #compute before taking more.',
      '',
      '## Questions for Prof. Rao',
      '1. Is a 0.04 gain at 1.3B enough for the main result, or do we need 6.7B?',
      '2. Should the z-loss be in the method or the appendix?',
    ].join('\n'),
    version: 7,
    by: MARCO,
    at: new Date(Date.now() - 6 * 60_000).toISOString(),
  },
  strokes: BOARD,
};

// ------------------------------------------------------------------ browser ---

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-IN', timezoneId: TZ, deviceScaleFactor: 2 });
await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|fonts\.)/, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
await installGoogle(context, { pdf: makePdf(['A paper']), settings: settingsScript({ navStyle: 'labelled', granolaKey: 'grn_test_key_123456', zoomRoom: 'https://iith.zoom.us/my/saurav', proxyToken: PASS }) });
await context.addInitScript(() => {
  localStorage.setItem('reader.tour', 'seen');
  window.google.accounts.oauth2.initTokenClient = (config) => ({
    requestAccessToken: () => setTimeout(() => config.callback({ access_token: `token-${config.scope.split(' ').length}`, expires_in: 3600, scope: config.scope }), 10),
  });
});
await context.route('**/www.googleapis.com/oauth2/v3/userinfo*', (route) => route.fulfill({ json: { name: 'Saurav C', email: ME } }));
const calendarWrites = [];
const store = new Map(CALENDARS.map((calendar) => [calendar.id, new Map()]));
for (const { calendar, item } of EVENTS) store.get(calendar).set(item.id, structuredClone(item));
await context.route('**/www.googleapis.com/calendar/v3/**', (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.endsWith('/users/me/calendarList')) return route.fulfill({ json: { items: CALENDARS } });
  const list = url.pathname.match(/\/calendars\/([^/]+)\/events$/);
  if (list && request.method() === 'GET') {
    const min = Date.parse(url.searchParams.get('timeMin'));
    const max = Date.parse(url.searchParams.get('timeMax'));
    const items = [...(store.get(decodeURIComponent(list[1]))?.values() ?? [])].filter((item) => Date.parse(item.start.dateTime) < max && Date.parse(item.end.dateTime) > min);
    return route.fulfill({ json: { items } });
  }
  if (list && request.method() === 'POST') {
    const body = JSON.parse(request.postData() || '{}');
    const item = { id: `made-${calendarWrites.length + 1}`, status: 'confirmed', ...body };
    store.get(decodeURIComponent(list[1])).set(item.id, item);
    calendarWrites.push(body);
    return route.fulfill({ json: item });
  }
  return route.fulfill({ status: 404, json: {} });
});

// ---- the Worker, stood in for: /health says it can make Zoom meetings; Zoom, Granola and the room answer.
const asked = { zoom: [], granola: [], log: [] };
await context.route('**/api/health', async (route) => {
  const real = await route.fetch();
  route.fulfill({ json: { ...(await real.json().catch(() => ({}))), zoom: true, auth: true } });
});
await context.route('**/api/zoom/meetings', (route) => {
  asked.zoom.push(route.request().postDataJSON());
  route.fulfill({ json: { url: 'https://iith.zoom.us/j/8299001122?pwd=Rk9x', id: '8299001122', passcode: '419203' } });
});
await context.route('**/api/granola/**', (route) => {
  const url = new URL(route.request().url());
  asked.granola.push({ path: url.pathname, key: route.request().headers()['x-granola-key'] });
  if (url.pathname.endsWith('/notes')) return route.fulfill({ json: { notes: [{ id: GRANOLA_TODAY.id, title: GRANOLA_TODAY.title, created_at: GRANOLA_TODAY.created_at }], hasMore: false } });
  if (url.pathname.endsWith(`/notes/${GRANOLA_TODAY.id}`)) return route.fulfill({ json: GRANOLA_TODAY });
  return route.fulfill({ status: 404, json: { error: 'no such note' } });
});
await context.route('**/api/rooms/mine', (route) => route.fulfill({ json: { rooms: [] } }));
await context.route('**/api/invites/**', (route) => route.fulfill({ json: { invitations: [] } }));
await context.route(`**/api/rooms/${ROOM}**`, (route) => {
  const url = new URL(route.request().url());
  if (!url.pathname.endsWith('/log')) return route.fulfill({ json: roomState() });
  if (route.request().method() !== 'POST') return route.fulfill({ json: LOG });
  const body = route.request().postDataJSON();
  asked.log.push(body);
  if (body.op === 'note') {
    LOG.notes = [{ ...body.note, by: ME }, ...LOG.notes.filter((note) => note.id !== body.note.id)];
    return route.fulfill({ json: { note: body.note } });
  }
  if (body.op === 'link') {
    LOG.links = [body.link, ...LOG.links.filter((link) => link.id !== body.link.id)];
    return route.fulfill({ json: { link: body.link } });
  }
  if (body.op === 'stroke') {
    LOG.strokes = [...LOG.strokes, ...body.strokes];
    return route.fulfill({ json: { strokes: body.strokes } });
  }
  if (body.op === 'pad') {
    if (body.version !== LOG.pad.version) return route.fulfill({ status: 409, json: { error: 'changed', pad: LOG.pad } });
    LOG.pad = { text: body.text, version: LOG.pad.version + 1, by: ME, at: new Date().toISOString() };
    return route.fulfill({ json: { pad: LOG.pad } });
  }
  return route.fulfill({ json: { ok: true } });
});
let socket = null;
await context.routeWebSocket(`**/api/rooms/${ROOM}/live`, (ws) => {
  socket = ws;
  ws.onMessage(() => undefined);
  ws.send(JSON.stringify({ type: 'here', state: roomState() }));
});
const tell = (message) => socket?.send(JSON.stringify(message));

const page = await context.newPage();
await page.clock.setFixedTime(new Date(`${todayKey}T11:20:00${OFFSET}`));
page.on('pageerror', (error) => check('no page error', false, error.message));
page.on('dialog', (dialog) => dialog.accept());
const shot = (name) => page.screenshot({ path: `${OUT}${name}.png` });

console.log('\n== signed in, with a shared project whose weekly meeting is tagged ==');
await page.goto(`${BASE}/`);
await page.getByRole('button', { name: /Connect Google Drive|Sign in with Google/i }).first().click();
await page.waitForTimeout(500);
await page.getByRole('button', { name: /Start reading|Not now/i }).first().click();
await page.waitForTimeout(400);
await page.evaluate(
  async ({ ROOM, ME, PROJECT, MEETINGS }) => {
    const name = (await indexedDB.databases()).map((item) => item.name).find((item) => item.includes('reader@example.org')) ?? 'reader';
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const put = (value) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction('collections', 'readwrite');
        tx.objectStore('collections').put(value);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    await put({ id: PROJECT, name: 'Sparse-gated MoE', color: '#1f5e52', createdAt: '2026-09-01T00:00:00.000Z', project: { question: 'Can a router balance experts with no auxiliary loss?', startedAt: '2026-09-01T00:00:00.000Z', roles: {}, todos: [{ id: 't0', text: 'Reproduce top-2 at 350M', done: true }], meetings: MEETINGS, shared: { room: ROOM, owner: ME, role: 'owner' } } });
    await put({ id: 'pj-fno', name: 'Neural operators', color: '#2d64a0', createdAt: '2026-09-01T00:00:00.000Z', project: { question: '', startedAt: '2026-09-01T00:00:00.000Z', roles: {}, todos: [] } });
    db.close();
  },
  { ROOM, ME, PROJECT, MEETINGS },
);
await page.reload();
await page.waitForTimeout(800);

console.log('\n== the Calendar: Granola’s notes of this morning filed in the project ==');
await page.locator('nav.rail').getByRole('button', { name: 'Calendar' }).first().click();
await page.getByRole('button', { name: 'Connect Google Calendar' }).click();
await page.waitForSelector('.cal-time', { timeout: 8000 });
await page.locator('.cal-news').waitFor({ timeout: 8000 });
check('Granola was asked with the person’s key, the list and then the note', asked.granola.length === 2 && asked.granola.every((item) => item.key === 'grn_test_key_123456'), JSON.stringify(asked.granola));
const filed = asked.log.find((item) => item.op === 'note');
check('this morning’s weekly is filed in the project’s room, with its Granola summary', filed?.note.id === 'granola:not_7Hq2' && filed.note.meeting === `${LAB}:moe-weekly_${key(plus(0)).replace(/-/g, '')}T033000Z` && /Action items/.test(filed.note.markdown), JSON.stringify(filed?.note).slice(0, 200));
check('the page says so', /notes were filed from Granola/.test(await page.locator('.cal-news').innerText()));
await page.locator('.cal-ev.is-block', { hasText: 'MoE weekly' }).first().click();
await page.locator('.cal-card').waitFor();
await page.locator('.cal-card-notes.is-filed').waitFor({ timeout: 5000 });
const card = await page.locator('.cal-card').innerText();
check('its card: Join Zoom, and the notes filed in the project', /Join Zoom/.test(card) && /Notes filed in Sparse-gated MoE from Granola/.test(card) && /Open notes/.test(card), card.replace(/\n/g, ' | '));
await shot('meetings-card-filed');
await page.keyboard.press('Escape');
await page.locator('.cal-ev.is-block', { hasText: 'Router ablations sync' }).click();
await page.locator('.cal-card-notes').waitFor();
check('a meeting still to come says Granola will take its notes, and where they go', /Granola will take notes, filed in Sparse-gated MoE when it ends/.test(await page.locator('.cal-card-notes').innerText()));
await shot('meetings-card-upcoming');
await page.keyboard.press('Escape');

console.log('\n== a new meeting: a Zoom call made for it, Granola, the project ==');
await page.getByRole('button', { name: 'New' }).click();
const editor = page.locator('.cal-editor');
await editor.getByLabel('Title').fill('Paper planning: §4 and the appendix');
await editor.getByRole('radio', { name: 'Zoom' }).click();
check('Zoom starts with the person’s own room', (await editor.getByLabel('Zoom link').inputValue()) === 'https://iith.zoom.us/my/saurav');
await editor.getByRole('button', { name: 'Make one' }).click();
await page.waitForFunction(() => document.querySelector('.cal-editor [aria-label="Zoom link"]')?.value.includes('8299001122'));
check('the Worker was asked for a meeting at the event’s time', asked.zoom.length === 1 && asked.zoom[0].topic === 'Paper planning: §4 and the appendix' && asked.zoom[0].minutes === 60, JSON.stringify(asked.zoom));
await editor.getByLabel(/Take notes with Granola/).check();
await editor.getByLabel('Project').selectOption(PROJECT);
await shot('meetings-editor');
await editor.getByRole('button', { name: 'Save' }).click();
await page.waitForTimeout(600);
const made = calendarWrites.at(-1);
check('Google was sent the Zoom link, in the place and the description, and Granola asked', made?.location === 'https://iith.zoom.us/j/8299001122?pwd=Rk9x' && /^Join Zoom: https:\/\/iith\.zoom\.us\/j\/8299001122/.test(made.description) && made.extendedProperties.private.readerNotes === 'granola', JSON.stringify(made));
const tagged = await page.evaluate(async (PROJECT) => {
  const name = (await indexedDB.databases()).map((item) => item.name).find((item) => item.includes('reader@example.org'));
  const db = await new Promise((resolve) => (indexedDB.open(name, 1).onsuccess = (event) => resolve(event.target.result)));
  const project = await new Promise((resolve) => (db.transaction('collections').objectStore('collections').get(PROJECT).onsuccess = (event) => resolve(event.target.result)));
  return Object.values(project.project.meetings).map((tag) => tag.title);
}, PROJECT);
check('and the new meeting is tagged with the project', tagged.includes('Paper planning: §4 and the appendix'), JSON.stringify(tagged));

console.log('\n== the project’s logbook: Meetings ==');
await page.locator('.cal-ev.is-block', { hasText: 'MoE weekly' }).first().click();
await page.locator('.cal-card').getByRole('button', { name: 'Open notes' }).click();
await page.locator('.lb-note.is-open').waitFor({ timeout: 8000 });
// The library and the dock put away, as someone working in the logbook would: it has the page to itself.
for (const name of ['Library', 'Discover']) {
  const toggle = page.locator('button[aria-pressed="true"]', { hasText: new RegExp(`^\\s*${name}\\s*$`) }).first();
  if (await toggle.count()) await toggle.click();
}
await page.waitForTimeout(300);
check('Open notes goes to the project’s logbook, on Meetings', new URL(page.url()).searchParams.get('view') === 'logbook' && new URL(page.url()).searchParams.get('section') === 'meetings', page.url());
const note = await page.locator('.lb-note.is-open').innerText();
check('today’s notes open first, with their action items and the links that came up', /MoE weekly/.test(note) && /Action items/i.test(note) && /Priya: rerun the 1\.3B/.test(note) && /ablation sheet/.test(note) && /Open in Granola/.test(note), note.replace(/\n/g, ' | ').slice(0, 400));
await page.locator('.lb-side .lb-coming li', { hasText: 'Paper planning' }).waitFor({ timeout: 8000 }).catch(() => undefined);
check('the meetings to come are beside them', /Router ablations sync/.test(await page.locator('.lb-side').innerText()) && /Paper planning/.test(await page.locator('.lb-side').innerText()));
check('the bar has the Logbook, on', (await page.locator('.pj-views button[aria-pressed="true"]', { hasText: 'Logbook' }).count()) === 1);
await shot('logbook-meetings');
await page.locator('.lb-note.is-open .lb-actions li', { hasText: 'Lin to book' }).getByRole('button').click();
await page.waitForTimeout(300);
check('an action item becomes a project to-do with one click', (await page.locator('.lb-note.is-open .lb-actions li', { hasText: 'Lin to book' }).locator('.lb-add.is-done').count()) === 1);

console.log('\n== Links ==');
await page.locator('.lb-tab', { hasText: 'Links' }).click();
await page.locator('.lb-grid').waitFor();
const suggestions = await page.locator('.lb-suggest').innerText();
check('the links that came up in meetings are offered, the call and the kept ones not', /ablation sheet/.test(suggestions) && /c4/i.test(suggestions) && !/zoom\.us\/j/.test(suggestions) && !/Run tracker/.test(suggestions), suggestions.replace(/\n/g, ' | ').slice(0, 300));
check('pinned links first', (await page.locator('.lb-link').nth(0).getAttribute('class')).includes('is-pinned') && (await page.locator('.lb-link').nth(1).getAttribute('class')).includes('is-pinned') && !(await page.locator('.lb-link').nth(2).getAttribute('class')).includes('is-pinned'));
await shot('logbook-links');
await page.locator('.lb-suggest-card', { hasText: 'ablation sheet' }).getByRole('button', { name: 'Keep' }).click();
await page.waitForTimeout(300);
check('Keep files it for everyone', asked.log.some((item) => item.op === 'link' && item.link.url.includes('1abl8')) && (await page.locator('.lb-link', { hasText: 'ablation sheet' }).count()) === 1);

console.log('\n== Notepad ==');
await page.locator('.lb-tab', { hasText: 'Notepad' }).click();
await page.locator('.lb-pad-text').waitFor();
check('the notepad as the room keeps it, written and read side by side', /running notes/.test(await page.locator('.lb-pad-text').inputValue()) && (await page.locator('.lb-pad-preview table').count()) === 1);
// Marco writes at the same time as this page does: both changes kept.
await page.locator('.lb-pad-text').click();
await page.keyboard.press('Control+End');
await page.keyboard.type('\n3. Do we cite the z-loss paper or re-derive it?');
LOG.pad = { text: LOG.pad.text.replace('## GPU this week\nPriya Mon–Wed', '## GPU this week\nLin has booked 2×8 H100s for next week.\nPriya Mon–Wed'), version: LOG.pad.version + 1, by: MARCO, at: new Date().toISOString() };
await page.waitForTimeout(2500);
console.log('  pad writes:', JSON.stringify(asked.log.filter((item) => item.op === 'pad').map((item) => [item.version, item.text.slice(-60)])));
const merged = await page.locator('.lb-pad-text').inputValue();
check('a change made on an older notepad is merged, not lost', /re-derive it\?/.test(merged) && /booked 2×8 H100s/.test(merged) && /re-derive it\?/.test(LOG.pad.text) && /booked 2×8/.test(LOG.pad.text), merged.slice(-200));
await shot('logbook-notepad');

console.log('\n== Whiteboard ==');
await page.locator('.lb-tab', { hasText: 'Whiteboard' }).click();
await page.locator('.lb-canvas').waitFor();
tell({ type: 'ink', who: PRIYA, stroke: PRIYA_INK });
await page.waitForTimeout(300);
check('Priya, on the board, is drawing', /Priya is drawing/.test(await page.locator('.lb-drawing').innerText()));
// A stroke of this page's own: an underline under the title, with the mouse.
const canvas = await page.locator('.lb-canvas').boundingBox();
const scale = canvas.width / 1600;
await page.mouse.move(canvas.x + 470 * scale, canvas.y + 118 * scale);
await page.mouse.down();
for (let i = 1; i <= 20; i++) await page.mouse.move(canvas.x + (470 + i * 14) * scale, canvas.y + (118 + Math.sin(i / 3) * 3) * scale);
await page.mouse.up();
await page.waitForTimeout(300);
const drawn = asked.log.find((item) => item.op === 'stroke');
check('a stroke drawn is sent to the room, thinned', drawn && drawn.strokes.length === 1 && drawn.strokes[0].points.length >= 9 && drawn.strokes[0].points.length % 3 === 0, JSON.stringify(drawn?.strokes[0].points.length));
await shot('logbook-board');
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
await page.waitForTimeout(300);
await page.locator('.lb-tab', { hasText: 'Notepad' }).click();
await page.locator('.lb-tab', { hasText: 'Whiteboard' }).click();
await page.waitForTimeout(400);
await shot('logbook-board-dark');

console.log('\n== on a phone ==');
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}/project/?id=${PROJECT}&view=logbook&section=meetings`);
await page.locator('.lb-note').first().waitFor({ timeout: 8000 });
await page.waitForTimeout(500);
// The logbook itself, that is: nothing in it wider than the screen (the app's library panel is its own affair).
const wide = await page.evaluate(() => [...document.querySelectorAll('.lb *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && !el.closest('.lb-tabs')).slice(0, 6).map((el) => `${el.tagName}.${String(el.className).slice(0, 40)} ${Math.round(el.getBoundingClientRect().right)}`));
check('nothing in the logbook runs off a phone’s screen', wide.length === 0, wide.join(' | '));
await shot('logbook-phone');

await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('\nall good');
