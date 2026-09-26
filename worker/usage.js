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
 *   claude, deepseek, gemini         answers from Ask AI and Explain, per provider
 *   claude_in, claude_out, …         the tokens they read and wrote
 *   claude_cost, deepseek_cost, …    what they cost, in millionths of a dollar
 *   models   the same per model: { [model]: { n, in, out, cost } }
 *
 * The AI answers are not the Worker's to make: the app sends them straight to
 * Anthropic or DeepSeek with the visitor's own key, then tells the Worker how
 * many tokens the answer took (`POST /usage/ai`). The cost is worked out here,
 * from PRICES, so that the page and the tally agree on one price list.
 *
 * The owner, with READER_TOKEN itself, is tallied as "owner". Nobody
 * signed out is tallied: they use nothing that costs. Days older than
 * ninety are dropped. Only the owner can read it back (`GET /usage` on the
 * Worker, READER_TOKEN only — not a pass): `npm run usage` prints it.
 */

import { addSnapshot, balanceReport, pruneDays } from './deepseekBalance.js';

export const AI_PROVIDERS = ['claude', 'deepseek', 'gemini'];
export const COUNTS = [
  'signin',
  'scholar',
  'serply',
  'serpapi',
  'browser',
  'pdf',
  ...AI_PROVIDERS.flatMap((provider) => [provider, `${provider}_in`, `${provider}_out`, `${provider}_cost`]),
];

/**
 * US dollars per million tokens: uncached input, output, input read from the
 * cache, and input written to it. Anthropic's list prices; DeepSeek's are
 * its platform's pricing page — change them here when theirs change. A model
 * missing here is priced as its provider's first.
 */
export const PRICES = {
  claude: {
    'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  },
  deepseek: {
    'deepseek-flash': { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0.28 },
  },
  // Google's paid tier, prompts under 200K tokens; thinking is billed as
  // output. Gemini's caching is implicit — nothing to write — and a cached
  // read is a tenth of the input. 3.8 Flash is at its introductory price,
  // which Google says rises to $1.50 / $7.50 on 1 January 2027.
  gemini: {
    'gemini-3.1-pro-preview': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2 },
    'gemini-3.8-flash': { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 },
    'gemini-3.5-flash-lite': { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 },
  },
};

/**
 * The models the tally keeps apart, by the id the app picks them by — a
 * DeepSeek model with thinking off is its own entry, though it is the same
 * model to DeepSeek. Anything else is counted as its provider's "other", so a
 * report can never grow the store with names of its own.
 */
export const MODELS = {
  claude: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  deepseek: ['deepseek-flash', 'deepseek-flash-fast'],
  gemini: ['gemini-3.1-pro-preview', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'],
};
export const MODEL_FIELDS = ['n', 'in', 'out', 'cost'];

/** The most one answer is believed to take — a report past this is clipped, not trusted. */
const MAX_TOKENS = 5_000_000;
const tokens = (value) => Math.min(MAX_TOKENS, Math.max(0, Math.floor(Number(value) || 0)));

/**
 * The counts one AI answer adds to the tally: `{ claude: 1, claude_in, claude_out,
 * claude_cost }`, cost in millionths of a dollar. `input` is the input read at
 * full price; `cacheRead` and `cacheWrite` are the rest. Null for a provider
 * this tally does not know.
 */
export function aiCounts({ provider, model, variant, input, output, cacheRead, cacheWrite } = {}) {
  if (!AI_PROVIDERS.includes(provider)) return null;
  const table = PRICES[provider];
  const price = table[model] || Object.values(table)[0];
  const used = { input: tokens(input), output: tokens(output), cacheRead: tokens(cacheRead), cacheWrite: tokens(cacheWrite) };
  // Dollars per million tokens × tokens = millionths of a dollar.
  const cost = used.input * price.input + used.output * price.output + used.cacheRead * price.cacheRead + used.cacheWrite * price.cacheWrite;
  const known = MODELS[provider];
  const key = known.includes(variant) ? variant : known.includes(model) ? model : `${provider}-other`;
  const counts = {
    [provider]: 1,
    [`${provider}_in`]: used.input + used.cacheRead + used.cacheWrite,
    [`${provider}_out`]: used.output,
    [`${provider}_cost`]: Math.round(cost),
  };
  counts.models = { [key]: { n: 1, in: counts[`${provider}_in`], out: used.output, cost: counts[`${provider}_cost`] } };
  return counts;
}

/** Add one set of per-model counts into another, in place: `{ [model]: { n, in, out, cost } }`. */
function addModels(into, from) {
  for (const [key, counts] of Object.entries(from || {})) {
    if (!/^[a-z0-9.-]{1,48}$/.test(key) || !counts || typeof counts !== 'object') continue;
    const row = into[key] || (into[key] = Object.fromEntries(MODEL_FIELDS.map((name) => [name, 0])));
    for (const name of MODEL_FIELDS) row[name] += Math.max(0, Math.floor(Number(counts[name]) || 0));
  }
  return into;
}
const KEEP_DAYS = 90;

const dayOf = (at) => new Date(at).toISOString().slice(0, 10);

/** Add `counts` to `email`'s tally for the day of `at`, in `days` — `{ [email]: { signin, … } }`. */
export function addTo(days, email, counts, at) {
  const row = days[email] || (days[email] = Object.fromEntries(COUNTS.map((name) => [name, 0])));
  for (const name of COUNTS) row[name] += Math.max(0, Math.floor(Number(counts?.[name]) || 0));
  if (counts?.models) row.models = addModels(row.models || {}, counts.models);
  row.last = Math.max(row.last || 0, at);
  return days;
}

/**
 * The tallies of the last `days` days, per person: the totals, today's, and
 * when they were last seen, and each day's own counts, newest first — the
 * most active person first.
 */
export function report(byDay, { days = 30, now = Date.now() } = {}) {
  const since = dayOf(now - (days - 1) * 86_400_000);
  const today = dayOf(now);
  const people = {};
  for (const [day, rows] of Object.entries(byDay)) {
    if (day < since) continue;
    for (const [email, row] of Object.entries(rows)) {
      const person = people[email] || (people[email] = { email, total: {}, today: {}, daily: [], days: 0, last: 0, models: {} });
      person.days += 1;
      person.last = Math.max(person.last, row.last || 0);
      person.daily.push({ day, ...Object.fromEntries(COUNTS.map((name) => [name, row[name] || 0])), models: addModels({}, row.models) });
      addModels(person.models, row.models);
      for (const name of COUNTS) {
        person.total[name] = (person.total[name] || 0) + (row[name] || 0);
        if (day === today) person.today[name] = (person.today[name] || 0) + (row[name] || 0);
      }
    }
  }
  for (const person of Object.values(people)) person.daily.sort((a, b) => (a.day < b.day ? 1 : -1));
  const list = Object.values(people).sort((a, b) => b.total.scholar - a.total.scholar || b.last - a.last);
  const totals = Object.fromEntries(COUNTS.map((name) => [name, list.reduce((sum, person) => sum + (person.total[name] || 0), 0)]));
  const models = list.reduce((sum, person) => addModels(sum, person.models), {});
  return { days, since, until: today, people: list, totals, models };
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
    // The DeepSeek account's balance, a snapshot at a time: deepseekBalance.js.
    if (url.pathname === '/balance/record' && request.method === 'POST') {
      const { snapshot, at = Date.now() } = await request.json().catch(() => ({}));
      if (!snapshot || typeof snapshot.total !== 'number') return new Response('no snapshot', { status: 400 });
      const stored = await this.state.storage.get('balance:deepseek');
      await this.state.storage.put('balance:deepseek', pruneDays(addSnapshot(stored, snapshot, at), KEEP_DAYS, at));
      return new Response('ok');
    }
    if (url.pathname === '/balance/report') {
      const days = Math.min(KEEP_DAYS, Math.max(1, Number(url.searchParams.get('days')) || 30));
      return Response.json(balanceReport(await this.state.storage.get('balance:deepseek'), { days }));
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
