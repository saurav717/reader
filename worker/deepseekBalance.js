/**
 * The DeepSeek account's own numbers, for the owner's Usage page.
 *
 * DeepSeek's API has no usage or billing endpoint — the charts on
 * platform.deepseek.com are behind its own sign-in — but it does answer
 * `GET /user/balance` to an API key. With the owner's key as a secret
 * (`npx wrangler secret put DEEPSEEK_KEY`), the Worker asks for the balance
 * whenever the Usage page does, and once an hour on its own (the cron in
 * wrangler.toml), and keeps each snapshot in the Usage object. The balance
 * going down between two snapshots is money spent; going up is a top-up (or a
 * grant). A top-up and some spending between the same two snapshots show as
 * their difference — hourly snapshots keep that window small.
 *
 * Only the account the key belongs to: visitors asking on their own keys
 * spend their own balance, which the per-person tally (usage.js) counts.
 * Money is kept in millionths of the currency, as the tally keeps cost.
 */

export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';

const micro = (value) => Math.round((Number(value) || 0) * 1_000_000);

/**
 * The balance, as DeepSeek reports it, in one currency — USD where the
 * account has it, else the first it lists:
 * `{ available, currency, total, granted, toppedUp }`. Throws with DeepSeek's
 * reason when it refuses.
 */
export async function readBalance(key, fetcher = fetch) {
  const response = await fetcher(DEEPSEEK_BALANCE_URL, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message || `DeepSeek answered ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  const info = infos.find((entry) => entry?.currency === 'USD') || infos[0];
  if (!info) throw new Error('DeepSeek listed no balance for this key');
  return {
    available: body.is_available !== false,
    currency: String(info.currency || 'USD'),
    total: micro(info.total_balance),
    granted: micro(info.granted_balance),
    toppedUp: micro(info.topped_up_balance),
  };
}

const dayOf = (at) => new Date(at).toISOString().slice(0, 10);

/**
 * Put one snapshot into `stored` — `{ last, days: { [day]: { spent, added } } }`
 * — and return it: the fall since the last snapshot is spent on the day of
 * this one, a rise is added. A change of currency starts over.
 */
export function addSnapshot(stored, snapshot, at) {
  const next = { last: stored?.last || null, days: { ...(stored?.days || {}) } };
  const last = next.last;
  if (last && last.currency === snapshot.currency && at >= last.at) {
    const change = last.total - snapshot.total;
    if (change) {
      const day = dayOf(at);
      const row = { spent: 0, added: 0, ...(next.days[day] || {}) };
      if (change > 0) row.spent += change;
      else row.added -= change;
      next.days[day] = row;
    }
  }
  next.last = { ...snapshot, at };
  return next;
}

/** The last `days` days of it, oldest first, every day there, for the page. */
export function balanceReport(stored, { days = 30, now = Date.now() } = {}) {
  const out = [];
  for (let index = days - 1; index >= 0; index -= 1) {
    const day = dayOf(now - index * 86_400_000);
    const row = stored?.days?.[day] || {};
    out.push({ day, spent: row.spent || 0, added: row.added || 0 });
  }
  return { balance: stored?.last || null, days: out };
}

/** Drop the days past keeping. */
export function pruneDays(stored, keepDays, now = Date.now()) {
  const cutoff = dayOf(now - keepDays * 86_400_000);
  const days = Object.fromEntries(Object.entries(stored?.days || {}).filter(([day]) => day >= cutoff));
  return { ...stored, days };
}
