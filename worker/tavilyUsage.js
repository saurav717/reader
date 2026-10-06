/**
 * The Tavily account's own numbers, for the owner's Usage page.
 *
 * Tavily is what the Web button in Ask AI searches with (server/webSearch.js),
 * on the owner's key. Its API answers `GET /usage` to that key with what the
 * key has spent this billing cycle and what the plan allows — a thousand
 * credits a month on the free plan — and, with pay as you go turned on at
 * Tavily, the credits bought past them this cycle (`paygo_usage`, against
 * the cap `paygo_limit`; both null while pay as you go is off), so the page
 * can show how much of the month is left and what the overflow has cost,
 * beside the searches the tally counted. The Worker asks
 * whenever the Usage page does, no more than once every couple of minutes
 * (the endpoint allows ten asks in ten minutes), and once an hour on its own
 * (the cron in wrangler.toml), and keeps each snapshot in the Usage object:
 * the rise in the key's usage between two snapshots is the credits spent
 * that day, and the rise in the pay-as-you-go count the paid ones among
 * them. A fall is the cycle starting over, and what the key shows then
 * is what it has spent since.
 *
 * Only the account the key belongs to: what the proxy searched on it, for
 * everyone; the per-person tally (usage.js) says who. Credits are kept as
 * Tavily counts them, whole numbers.
 */

export const TAVILY_USAGE_URL = 'https://api.tavily.com/usage';

/** How fresh a snapshot has to be for the page to be shown it rather than Tavily asked again. */
export const FRESH_MS = 2 * 60_000;

const count = (value) => (value === null || value === undefined ? null : Math.max(0, Math.round(Number(value) || 0)));

/**
 * The key's usage and the plan's, as Tavily reports them:
 * `{ plan, planUsage, planLimit, keyUsage, keyLimit, searches, extracts,
 * paygoUsage, paygoLimit }` — a limit null where Tavily sets none, and the
 * pay-as-you-go pair null while pay as you go is off on the account. Throws
 * with Tavily's reason when it refuses.
 */
export async function readTavilyUsage(key, fetcher = fetch) {
  const response = await fetcher(TAVILY_USAGE_URL, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.detail?.error || body?.detail || body?.error || `Tavily answered ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const account = body?.account || {};
  const apiKey = body?.key || {};
  if (apiKey.usage === undefined && account.plan_usage === undefined) throw new Error('Tavily answered without any usage');
  return {
    plan: String(account.current_plan || ''),
    planUsage: count(account.plan_usage) ?? 0,
    planLimit: count(account.plan_limit),
    keyUsage: count(apiKey.usage) ?? 0,
    keyLimit: count(apiKey.limit),
    searches: count(apiKey.search_usage) ?? 0,
    extracts: count(apiKey.extract_usage) ?? 0,
    paygoUsage: count(account.paygo_usage),
    paygoLimit: count(account.paygo_limit),
  };
}

const dayOf = (at) => new Date(at).toISOString().slice(0, 10);

/** The rise from one count to the next; a fall is the cycle starting over, and the count then is the rise. Nothing when either is unknown. */
const rise = (from, to) => (to === null || to === undefined ? 0 : from === null || from === undefined || to >= from ? Math.max(0, to - (from ?? 0)) : to);

/**
 * Put one snapshot into `stored` — `{ last, days: { [day]: { used, paid } } }`
 * — and return it: the rise in the key's usage since the last snapshot is
 * credits used on the day of this one, and the rise in the account's
 * pay-as-you-go count the paid ones among them. A fall is a new billing
 * cycle, and the count then is what has been used since the cycle began.
 */
export function addTavilySnapshot(stored, snapshot, at) {
  const next = { last: stored?.last || null, days: { ...(stored?.days || {}) } };
  const last = next.last;
  if (last && at >= last.at) {
    const used = rise(last.keyUsage, snapshot.keyUsage);
    const paid = rise(last.paygoUsage, snapshot.paygoUsage);
    if (used || paid) {
      const day = dayOf(at);
      next.days[day] = { used: (next.days[day]?.used || 0) + used, paid: (next.days[day]?.paid || 0) + paid };
    }
  }
  next.last = { ...snapshot, at };
  return next;
}

/** The last `days` days of it, oldest first, every day there, for the page. */
export function tavilyReport(stored, { days = 30, now = Date.now() } = {}) {
  const out = [];
  for (let index = days - 1; index >= 0; index -= 1) {
    const day = dayOf(now - index * 86_400_000);
    out.push({ day, used: stored?.days?.[day]?.used || 0, paid: stored?.days?.[day]?.paid || 0 });
  }
  return { account: stored?.last || null, days: out };
}
