/**
 * Who uses this Worker's paid accounts, and how much: a tally per person
 * per day, kept by one Durable Object for the whole Worker.
 *
 * Anyone signed in with Google may use Scholar and the browser inside the
 * reader on the owner's accounts (see server/passes.js), so the owner wants
 * to see who does, and how much it costs. What is counted, per email, per
 * day (UTC):
 *
 *   signin   a Google sign-in swapped for a pass
 *   scholar  an ask of Scholar through the paid services
 *   serply   requests Serply was charged for (a credit each)
 *   serpapi  requests SerpApi was charged for (a search each)
 *   browser  the browser inside the reader opened
 *   pdf      a file fetched with a pass — through a kept sign-in, or unlimited
 *
 * The owner, with READER_TOKEN itself, is tallied as "owner". Nobody
 * signed out is tallied: they use nothing that costs. Days older than
 * ninety are dropped. Only the owner can read it back (`GET /usage` on the
 * Worker, READER_TOKEN only — not a pass): `npm run usage` prints it.
 */

export const COUNTS = ['signin', 'scholar', 'serply', 'serpapi', 'browser', 'pdf'];
const KEEP_DAYS = 90;

const dayOf = (at) => new Date(at).toISOString().slice(0, 10);

/** Add `counts` to `email`'s tally for the day of `at`, in `days` — `{ [email]: { signin, … } }`. */
export function addTo(days, email, counts, at) {
  const row = days[email] || (days[email] = Object.fromEntries(COUNTS.map((name) => [name, 0])));
  for (const name of COUNTS) row[name] += Math.max(0, Math.floor(Number(counts?.[name]) || 0));
  row.last = Math.max(row.last || 0, at);
  return days;
}

/**
 * The tallies of the last `days` days, per person: the totals, today's, and
 * when they were last seen — most active first.
 */
export function report(byDay, { days = 30, now = Date.now() } = {}) {
  const since = dayOf(now - (days - 1) * 86_400_000);
  const today = dayOf(now);
  const people = {};
  for (const [day, rows] of Object.entries(byDay)) {
    if (day < since) continue;
    for (const [email, row] of Object.entries(rows)) {
      const person = people[email] || (people[email] = { email, total: {}, today: {}, days: 0, last: 0 });
      person.days += 1;
      person.last = Math.max(person.last, row.last || 0);
      for (const name of COUNTS) {
        person.total[name] = (person.total[name] || 0) + (row[name] || 0);
        if (day === today) person.today[name] = (person.today[name] || 0) + (row[name] || 0);
      }
    }
  }
  const list = Object.values(people).sort((a, b) => b.total.scholar - a.total.scholar || b.last - a.last);
  const totals = Object.fromEntries(COUNTS.map((name) => [name, list.reduce((sum, person) => sum + (person.total[name] || 0), 0)]));
  return { days, since, until: today, people: list, totals };
}

export class Usage {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/record' && request.method === 'POST') {
      const { email, counts, at = Date.now() } = await request.json().catch(() => ({}));
      if (typeof email !== 'string' || !email) return new Response('no email', { status: 400 });
      const key = `day:${dayOf(at)}`;
      const days = (await this.state.storage.get(key)) || {};
      await this.state.storage.put(key, addTo(days, email.toLowerCase(), counts, at));
      await this.prune(at);
      return new Response('ok');
    }
    if (url.pathname === '/report') {
      const days = Math.min(KEEP_DAYS, Math.max(1, Number(url.searchParams.get('days')) || 30));
      const stored = await this.state.storage.list({ prefix: 'day:' });
      const byDay = Object.fromEntries([...stored.entries()].map(([key, value]) => [key.slice(4), value]));
      return Response.json(report(byDay, { days }));
    }
    return new Response('not found', { status: 404 });
  }

  /** Drop the days past keeping, at most once a day. */
  async prune(at) {
    const today = dayOf(at);
    if (this.pruned === today) return;
    this.pruned = today;
    const cutoff = `day:${dayOf(at - KEEP_DAYS * 86_400_000)}`;
    const stored = await this.state.storage.list({ prefix: 'day:', end: cutoff });
    if (stored.size) await this.state.storage.delete([...stored.keys()]);
  }
}
