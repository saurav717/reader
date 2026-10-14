/**
 * The owner's Cloudflare account, for the Cloudflare tab of the Usage page:
 * what this Worker and everything it is built on — Workers, Durable Objects,
 * KV and Browser Rendering — has used today, against what the Workers Free
 * plan allows, and the days before it.
 *
 * Most of it comes from Cloudflare's GraphQL Analytics API, asked with an API
 * token that may read the account's analytics — the secret
 * CLOUDFLARE_API_TOKEN, "Account Analytics: Read" — for the account named in
 * CLOUDFLARE_ACCOUNT_ID (docs/deploy.md, "Cloudflare on the Usage page").
 * Each dataset is asked on its own, so one Cloudflare will not answer comes
 * back as that meter's `error` and the rest are still filled in.
 *
 * The browser's time needs no token: Browser Rendering tells the Worker its
 * own sessions — open now, and closed lately — through the BROWSER binding,
 * and how many may be open at once.
 *
 * The Free plan's allowances are per day, and start again at 00:00 UTC; what
 * is stored (KV, Durable Objects) is a total. A Worker past its daily
 * requests is answered with an error page until midnight UTC; KV and Durable
 * Objects refuse the operation; the browser refuses a new session (429).
 */

import { defaultDriver } from './browse.js';

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const DAY_MS = 86_400_000;
/** Days of history each meter carries, today included. */
export const HISTORY_DAYS = 7;
/** A Durable Object is billed as 128 MB for the time it is active: GB-s per second. */
const DO_GB = 128 / 1024;

/**
 * The Workers Free plan, as Cloudflare publishes it. `period` "day" is an
 * allowance that starts again at 00:00 UTC; "stored" is a total held.
 */
export const FREE_PLAN = {
  'workers.requests': { group: 'Workers', label: 'Requests', unit: 'count', limit: 100_000, period: 'day' },
  'do.requests': { group: 'Durable Objects', label: 'Requests', unit: 'count', limit: 100_000, period: 'day' },
  'do.duration': { group: 'Durable Objects', label: 'Duration', unit: 'gbs', limit: 13_000, period: 'day' },
  'do.rowsRead': { group: 'Durable Objects', label: 'Rows read', unit: 'count', limit: 5_000_000, period: 'day' },
  'do.rowsWritten': { group: 'Durable Objects', label: 'Rows written', unit: 'count', limit: 100_000, period: 'day' },
  'do.storage': { group: 'Durable Objects', label: 'Stored', unit: 'bytes', limit: 5 * 1024 ** 3, period: 'stored' },
  'kv.read': { group: 'KV', label: 'Reads', unit: 'count', limit: 100_000, period: 'day' },
  'kv.write': { group: 'KV', label: 'Writes', unit: 'count', limit: 1_000, period: 'day' },
  'kv.delete': { group: 'KV', label: 'Deletes', unit: 'count', limit: 1_000, period: 'day' },
  'kv.list': { group: 'KV', label: 'Lists', unit: 'count', limit: 1_000, period: 'day' },
  'kv.storage': { group: 'KV', label: 'Stored', unit: 'bytes', limit: 1024 ** 3, period: 'stored' },
  'browser.time': { group: 'Browser Rendering', label: 'Browser time', unit: 'seconds', limit: 600, period: 'day' },
};

const accountOf = (env) => String(env.CLOUDFLARE_ACCOUNT_ID || '').trim();
const tokenOf = (env) => String(env.CLOUDFLARE_API_TOKEN || '').trim();

/** Whether the Worker may read the account's analytics. */
export const cloudflareConfigured = (env) => Boolean(accountOf(env) && tokenOf(env));

export const dayOf = (at) => new Date(at).toISOString().slice(0, 10);

/** The last `count` days, oldest first, ending today (UTC). */
export function lastDays(now, count = HISTORY_DAYS) {
  const today = Date.parse(`${dayOf(now)}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => dayOf(today - (count - 1 - index) * DAY_MS));
}

const settle = async (work) => {
  try {
    return { value: await work() };
  } catch (error) {
    return { error: String(error?.message || error) };
  }
};

/** One dataset of the account, asked on its own; its rows, or throws with Cloudflare's reason. */
async function ask(env, fetcher, dataset, fields, since, until, extra = '') {
  const query = `query ($account: string!, $since: Date!, $until: Date!) {
  viewer { accounts(filter: { accountTag: $account }) {
    rows: ${dataset}(limit: 10000, filter: { date_geq: $since, date_leq: $until${extra} }) { ${fields} }
  } }
}`;
  const response = await fetcher(GRAPHQL_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenOf(env)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { account: accountOf(env), since, until } }),
  });
  const answer = await response.json().catch(() => ({}));
  if (answer?.errors?.length) throw new Error(answer.errors[0]?.message || 'Cloudflare refused the query');
  if (!response.ok) throw new Error(`${response.status} from Cloudflare`);
  const account = answer?.data?.viewer?.accounts?.[0];
  if (!account) throw new Error('the token cannot read this account (CLOUDFLARE_ACCOUNT_ID)');
  return account.rows || [];
}

/**
 * A dataset over the days shown, or, when Cloudflare will not go back that far
 * on this plan, over today alone.
 */
async function askDays(env, fetcher, dataset, fields, days, extra) {
  try {
    return await ask(env, fetcher, dataset, fields, days[0], days[days.length - 1], extra);
  } catch (error) {
    if (days.length === 1) throw error;
    const today = days[days.length - 1];
    return ask(env, fetcher, dataset, fields, today, today, extra).catch(() => {
      throw error;
    });
  }
}

/** Rows summed by day, by what `pick` reads from each: `[{ day, n }]` over `days`. */
export function byDay(rows, days, pick) {
  const totals = new Map(days.map((day) => [day, 0]));
  for (const row of rows) {
    const day = row?.dimensions?.date;
    if (!totals.has(day)) continue;
    const value = Number(pick(row));
    if (Number.isFinite(value)) totals.set(day, totals.get(day) + value);
  }
  return days.map((day) => ({ day, n: totals.get(day) }));
}

/** A meter: today's use (or what is held, for storage) against the plan's allowance. */
function meter(id, daily, extra = {}) {
  const plan = FREE_PLAN[id];
  const held = plan.period === 'stored' ? [...daily].reverse().find((point) => point.n > 0)?.n ?? 0 : daily[daily.length - 1]?.n ?? 0;
  return { id, ...plan, used: held, daily, ...extra };
}

const failed = (id, error) => ({ id, ...FREE_PLAN[id], used: null, daily: [], error });

// ------------------------------------------------------------------ datasets

async function readWorkers(env, fetcher, days) {
  const rows = await askDays(env, fetcher, 'workersInvocationsAdaptive', 'sum { requests errors } dimensions { date }', days);
  const errors = byDay(rows, days, (row) => row.sum?.errors).at(-1)?.n ?? 0;
  return [meter('workers.requests', byDay(rows, days, (row) => row.sum?.requests), { detail: errors ? `${errors.toLocaleString('en-US')} errors today` : '' })];
}

async function readDoRequests(env, fetcher, days) {
  const rows = await askDays(env, fetcher, 'durableObjectsInvocationsAdaptiveGroups', 'sum { requests } dimensions { date }', days);
  return [meter('do.requests', byDay(rows, days, (row) => row.sum?.requests))];
}

async function readDoPeriodic(env, fetcher, days) {
  const rows = await askDays(env, fetcher, 'durableObjectsPeriodicGroups', 'sum { activeTime rowsRead rowsWritten } dimensions { date }', days);
  return [
    // activeTime is in microseconds.
    meter('do.duration', byDay(rows, days, (row) => (Number(row.sum?.activeTime) / 1e6) * DO_GB)),
    meter('do.rowsRead', byDay(rows, days, (row) => row.sum?.rowsRead)),
    meter('do.rowsWritten', byDay(rows, days, (row) => row.sum?.rowsWritten)),
  ];
}

async function readDoStorage(env, fetcher, days) {
  const rows = await askDays(env, fetcher, 'durableObjectsStorageGroups', 'max { storedBytes } dimensions { date }', days);
  return [meter('do.storage', byDay(rows, days, (row) => row.max?.storedBytes))];
}

async function readKvOperations(env, fetcher, days) {
  const rows = await askDays(env, fetcher, 'kvOperationsAdaptiveGroups', 'sum { requests } dimensions { date actionType }', days);
  return ['read', 'write', 'delete', 'list'].map((action) =>
    meter(`kv.${action}`, byDay(rows.filter((row) => row.dimensions?.actionType === action), days, (row) => row.sum?.requests)),
  );
}

async function readKvStorage(env, fetcher, days) {
  // One row per namespace per day: the namespaces' largest of each day, summed.
  const rows = await askDays(env, fetcher, 'kvStorageAdaptiveGroups', 'max { byteCount } dimensions { date namespaceId }', days);
  return [meter('kv.storage', byDay(rows, days, (row) => row.max?.byteCount))];
}

const DATASETS = [
  [readWorkers, ['workers.requests']],
  [readDoRequests, ['do.requests']],
  [readDoPeriodic, ['do.duration', 'do.rowsRead', 'do.rowsWritten']],
  [readDoStorage, ['do.storage']],
  [readKvOperations, ['kv.read', 'kv.write', 'kv.delete', 'kv.list']],
  [readKvStorage, ['kv.storage']],
];

// ------------------------------------------------------------------- browser

/**
 * Seconds of browser time per day over `days`, from the sessions Browser
 * Rendering reports: each closed one from its start to its end, each open
 * one until `now`, split across midnight UTC where it spans it. Pure.
 */
export function browserSeconds(closed, open, days, now) {
  const totals = new Map(days.map((day) => [day, 0]));
  const spans = [
    ...(closed || []).map((session) => [Number(session.startTime), Number(session.endTime)]),
    ...(open || []).map((session) => [Number(session.startTime), now]),
  ];
  for (const [start, end] of spans) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    for (const day of days) {
      const from = Date.parse(`${day}T00:00:00Z`);
      const overlap = Math.min(end, from + DAY_MS) - Math.max(start, from);
      if (overlap > 0) totals.set(day, totals.get(day) + overlap / 1000);
    }
  }
  return days.map((day) => ({ day, n: Math.round(totals.get(day)) }));
}

/** The browser's time today and its sessions open now, from the BROWSER binding. */
export async function readBrowser(env, days, now, driver = defaultDriver) {
  if (!env?.BROWSER) return { meters: [failed('browser.time', 'no BROWSER binding on this Worker')], browser: null };
  const [closed, open, limits] = await Promise.all([
    settle(() => driver.history(env)),
    settle(() => driver.sessions(env)),
    settle(() => driver.limits(env)),
  ]);
  const raw = limits.value;
  const browser = raw
    ? {
        open: Array.isArray(raw.activeSessions) ? raw.activeSessions.length : (open.value || []).length,
        max: Number.isFinite(Number(raw.maxConcurrentSessions)) ? Number(raw.maxConcurrentSessions) : null,
        allowed: Number.isFinite(Number(raw.allowedBrowserAcquisitions)) ? Number(raw.allowedBrowserAcquisitions) : null,
        nextInMs: Math.max(0, Math.round(Number(raw.timeUntilNextAllowedBrowserAcquisition) || 0)),
      }
    : null;
  if (closed.error && open.error) return { meters: [failed('browser.time', closed.error)], browser };
  const daily = browserSeconds(closed.value, open.value, days, now);
  return { meters: [meter('browser.time', daily, { detail: 'from the sessions Cloudflare remembers' })], browser };
}

// ------------------------------------------------------------------ overview

/** Everything the Cloudflare tab shows, each dataset with its own error. */
export async function cloudflareOverview(env, fetcher = fetch, now = Date.now(), driver = defaultDriver) {
  const days = lastDays(now);
  const configured = cloudflareConfigured(env);
  const [datasets, browser] = await Promise.all([
    configured ? Promise.all(DATASETS.map(async ([read, ids]) => {
      const answer = await settle(() => read(env, fetcher, days));
      return answer.value ?? ids.map((id) => failed(id, answer.error));
    })) : [],
    readBrowser(env, days, now, driver),
  ]);
  const midnight = Date.parse(`${days[days.length - 1]}T00:00:00Z`) + DAY_MS;
  return {
    configured,
    plan: 'free',
    at: now,
    day: days[days.length - 1],
    resetsInMs: midnight - now,
    meters: [...datasets.flat(), ...browser.meters],
    browser: browser.browser,
  };
}
