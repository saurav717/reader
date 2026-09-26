/**
 * Who has used the Worker's paid accounts, and how much — the tally the
 * Worker keeps per person per day (worker/usage.js), printed as a table.
 *
 *   READER_TOKEN=… npm run usage                 # the last 30 days
 *   READER_TOKEN=… npm run usage -- --days 7
 *   READER_TOKEN=… npm run usage -- --json       # the report as it came
 *
 * The Worker is READER_PROXY when set, else the reader's own. Only
 * READER_TOKEN itself reads the tally; a pass from a Google sign-in does not.
 */
const PROXY = (process.env.READER_PROXY || 'https://reader-arxiv-proxy.es16btech11007.workers.dev').replace(/\/$/, '');
const TOKEN = (process.env.READER_TOKEN || '').trim();
const args = process.argv.slice(2);
const days = Number(args[args.indexOf('--days') + 1]) || 30;

if (!TOKEN) {
  console.error('Set READER_TOKEN to the Worker’s token:  READER_TOKEN=… npm run usage');
  process.exit(2);
}

const response = await fetch(`${PROXY}/usage?days=${days}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(`${PROXY}/usage answered ${response.status}: ${body.error || 'no reason given'}`);
  process.exit(1);
}
if (args.includes('--json')) {
  console.log(JSON.stringify(body, null, 2));
  process.exit(0);
}

const when = (at) => {
  if (!at) return '—';
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
};
const columns = [
  ['Who', (p) => p.email],
  ['Last seen', (p) => when(p.last)],
  ['Days', (p) => p.days],
  ['Sign-ins', (p) => p.total.signin || 0],
  ['Scholar', (p) => p.total.scholar || 0],
  ['Serply credits', (p) => p.total.serply || 0],
  ['SerpApi searches', (p) => p.total.serpapi || 0],
  ['Browser', (p) => p.total.browser || 0],
  ['PDFs', (p) => p.total.pdf || 0],
  ['Scholar today', (p) => p.today.scholar || 0],
];
const rows = body.people.map((person) => columns.map(([, cell]) => String(cell(person))));
const totals = ['All', '', '', ...['signin', 'scholar', 'serply', 'serpapi', 'browser', 'pdf'].map((name) => String(body.totals[name] || 0)), ''];
const widths = columns.map(([title], i) => Math.max(title.length, ...rows.map((row) => row[i].length), totals[i].length));
const line = (cells) => cells.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ');

console.log(`Usage of ${PROXY}, ${body.since} to ${body.until} (UTC)\n`);
if (!rows.length) {
  console.log('Nobody has used the paid features in that time.');
  process.exit(0);
}
console.log(line(columns.map(([title]) => title)));
console.log(widths.map((width) => '─'.repeat(width)).join('  '));
for (const row of rows) console.log(line(row));
console.log(widths.map((width) => '─'.repeat(width)).join('  '));
console.log(line(totals));
console.log('\n"owner" is READER_TOKEN itself. Serply credits and SerpApi searches are the requests each was charged for; answers from the cache cost nothing.');
