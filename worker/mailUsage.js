/**
 * The owner's mail account, for the Email tab of the Usage page: how much of
 * the provider's plan the site's invitations have used — today and this month
 * against its daily and monthly sends — whether they were delivered, bounced
 * or blocked, and, where the provider keeps one, who it will no longer send to.
 *
 * Two sources, each with its own error so one refused blanks only its part:
 *
 * - The provider, asked with the same MAIL_API_KEY the mail goes out with
 *   (server/mail.js): Brevo tells its plan's credits, the days' statistics,
 *   recent events, its blocked addresses and its verified senders; SendGrid
 *   its credits and the days' statistics; Postmark the days' sends and
 *   bounces. Resend has no API for any of it.
 * - The site's own log of every send it tried (worker/invites.js, `/mail`):
 *   what it sent, to whom, for what, and the provider's refusal when it
 *   refused — which works with any provider, and is the one place a failed
 *   send shows.
 *
 * The plan's allowances are the free plans' unless MAIL_DAILY_LIMIT or
 * MAIL_MONTHLY_LIMIT says otherwise (wrangler.toml); a paid Brevo plan's
 * credits come from Brevo itself.
 */

import { mailConfigured, mailProvider } from '../server/mail.js';

const DAY_MS = 86_400_000;
/** Days of history the tab shows. */
export const HISTORY_DAYS = 30;

/** The free plans' sends, as each provider publishes them; null where it has no such limit. */
export const FREE_LIMITS = {
  brevo: { daily: 300, monthly: null, plan: 'Free: 300 emails a day' },
  resend: { daily: 100, monthly: 3000, plan: 'Free: 100 emails a day, 3,000 a month' },
  sendgrid: { daily: 100, monthly: null, plan: 'Free trial: 100 emails a day' },
  postmark: { daily: null, monthly: 100, plan: 'Developer: 100 emails a month' },
};

export const PROVIDER_NAMES = { brevo: 'Brevo', resend: 'Resend', sendgrid: 'SendGrid', postmark: 'Postmark' };

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

const positive = (value) => {
  const number = Number(String(value ?? '').trim());
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
};

/** The address in "Reader <you@x.org>". */
export function senderAddress(from) {
  const match = /<([^>]+)>/.exec(String(from || ''));
  return (match ? match[1] : String(from || '')).trim().toLowerCase();
}

/** The allowances: set in wrangler.toml, or the free plan's. */
export function mailLimits(env, provider) {
  const free = FREE_LIMITS[provider] || { daily: null, monthly: null, plan: '' };
  const daily = positive(env.MAIL_DAILY_LIMIT);
  const monthly = positive(env.MAIL_MONTHLY_LIMIT);
  const set = daily !== null || monthly !== null;
  return { daily: set ? daily : free.daily, monthly: set ? monthly : free.monthly, plan: set ? 'as set in MAIL_DAILY_LIMIT / MAIL_MONTHLY_LIMIT' : free.plan, source: set ? 'setting' : 'free plan' };
}

/** One row per day of `days`, each field of `fields` summed from the rows `dayOfRow` places. */
export function byDay(rows, days, dayOfRow, fields) {
  const totals = new Map(days.map((day) => [day, Object.fromEntries(fields.map((field) => [field, 0]))]));
  for (const row of rows || []) {
    const sum = totals.get(dayOfRow(row));
    if (!sum) continue;
    for (const field of fields) {
      const value = Number(row[field]);
      if (Number.isFinite(value)) sum[field] += value;
    }
  }
  return days.map((day) => ({ day, ...totals.get(day) }));
}

export const STAT_FIELDS = ['sent', 'delivered', 'bounced', 'blocked', 'spam', 'opened', 'clicked'];

async function call(fetcher, url, init, who) {
  let response;
  try {
    response = await fetcher(url, init);
  } catch (error) {
    throw new Error(`${who} could not be reached: ${error?.message || error}`);
  }
  if (response.status === 204) return {};
  const said = await response.text().catch(() => '');
  let body = {};
  try {
    body = said ? JSON.parse(said) : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    const reason = body?.message || body?.Message || body?.errors?.[0]?.message || said.slice(0, 200);
    throw new Error(`${who} answered ${response.status}${reason ? `: ${reason}` : ''}`);
  }
  return body;
}

// --------------------------------------------------------------------- Brevo

const BREVO = 'https://api.brevo.com/v3';

function brevo(env, fetcher) {
  const headers = { 'api-key': String(env.MAIL_API_KEY).trim(), Accept: 'application/json' };
  return (path, init = {}) => call(fetcher, `${BREVO}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } }, 'Brevo');
}

/** Brevo's account: its plan, and the credits it has left to send with. */
export function brevoAccount(body) {
  const plans = Array.isArray(body?.plan) ? body.plan : [];
  const sending = plans.find((plan) => plan?.creditsType === 'sendLimit') || plans[0] || null;
  return {
    name: String(body?.companyName || [body?.firstName, body?.lastName].filter(Boolean).join(' ') || body?.email || ''),
    email: String(body?.email || ''),
    plan: sending ? String(sending.type || '') : '',
    credits: sending && Number.isFinite(Number(sending.credits)) ? Number(sending.credits) : null,
    creditsType: sending ? String(sending.creditsType || '') : '',
    endsAt: sending?.endDate ? String(sending.endDate) : null,
  };
}

async function readBrevo(env, fetcher, days, now) {
  const ask = brevo(env, fetcher);
  const from = senderAddress(env.MAIL_FROM);
  const [account, reports, events, blocked, senders] = await Promise.all([
    settle(() => ask('/account')),
    settle(() => ask(`/smtp/statistics/reports?startDate=${days[0]}&endDate=${days[days.length - 1]}`)),
    settle(() => ask('/smtp/statistics/events?limit=50&days=30&sort=desc')),
    settle(() => ask('/smtp/blockedContacts?limit=50&sort=desc')),
    settle(() => ask('/senders')),
  ]);
  const plan = account.value ? brevoAccount(account.value) : null;
  return {
    account: plan ? { ...plan, detail: plan.creditsType === 'sendLimit' ? 'credits left on the plan' : '' } : { error: account.error },
    daily: reports.value
      ? byDay(
          (reports.value.reports || []).map((row) => ({
            date: row.date,
            sent: row.requests,
            delivered: row.delivered,
            bounced: Number(row.hardBounces || 0) + Number(row.softBounces || 0),
            blocked: Number(row.blocked || 0) + Number(row.invalid || 0),
            spam: row.spamReports,
            opened: row.uniqueOpens ?? row.opens,
            clicked: row.uniqueClicks ?? row.clicks,
          })),
          days,
          (row) => String(row.date || '').slice(0, 10),
          STAT_FIELDS,
        )
      : { error: reports.error },
    events: events.value
      ? (events.value.events || []).map((event) => ({ at: Date.parse(event.date) || null, to: String(event.email || ''), event: String(event.event || ''), reason: String(event.reason || ''), subject: String(event.subject || '') }))
      : { error: events.error },
    blocked: blocked.value
      ? {
          count: Number(blocked.value.count ?? (blocked.value.contacts || []).length),
          contacts: (blocked.value.contacts || []).map((contact) => ({ email: String(contact.email || ''), reason: String(contact.reason?.message || contact.reason?.code || ''), at: Date.parse(contact.blockedAt) || null })),
          canUnblock: true,
        }
      : { error: blocked.error },
    sender: senders.value
      ? (() => {
          const found = (senders.value.senders || []).find((sender) => String(sender.email || '').toLowerCase() === from);
          return { email: from, verified: found ? Boolean(found.active) : false, detail: found ? (found.active ? 'a verified sender on Brevo' : 'on Brevo, but not yet verified') : 'not among Brevo’s senders: mail from it is refused' };
        })()
      : { email: from, verified: null, error: senders.error },
  };
}

// ------------------------------------------------------------------ SendGrid

async function readSendgrid(env, fetcher, days) {
  const headers = { Authorization: `Bearer ${String(env.MAIL_API_KEY).trim()}`, Accept: 'application/json' };
  const ask = (path) => call(fetcher, `https://api.sendgrid.com/v3${path}`, { headers }, 'SendGrid');
  const [credits, stats] = await Promise.all([
    settle(() => ask('/user/credits')),
    settle(() => ask(`/stats?start_date=${days[0]}&end_date=${days[days.length - 1]}&aggregated_by=day`)),
  ]);
  return {
    account: credits.value
      ? { plan: String(credits.value.reset_frequency || ''), credits: Number.isFinite(Number(credits.value.remain)) ? Number(credits.value.remain) : null, total: Number(credits.value.total) || null, detail: credits.value.next_reset ? `credits left · reset ${credits.value.next_reset}` : 'credits left' }
      : { error: credits.error },
    daily: stats.value
      ? byDay(
          (Array.isArray(stats.value) ? stats.value : []).map((row) => {
            const metrics = row.stats?.[0]?.metrics || {};
            return { date: row.date, sent: metrics.requests, delivered: metrics.delivered, bounced: metrics.bounces, blocked: Number(metrics.blocks || 0) + Number(metrics.invalid_emails || 0), spam: metrics.spam_reports, opened: metrics.unique_opens, clicked: metrics.unique_clicks };
          }),
          days,
          (row) => String(row.date || '').slice(0, 10),
          STAT_FIELDS,
        )
      : { error: stats.error },
    events: null,
    blocked: null,
    sender: { email: senderAddress(env.MAIL_FROM), verified: null },
  };
}

// ------------------------------------------------------------------ Postmark

async function readPostmark(env, fetcher, days) {
  const headers = { 'X-Postmark-Server-Token': String(env.MAIL_API_KEY).trim(), Accept: 'application/json' };
  const range = `fromdate=${days[0]}&todate=${days[days.length - 1]}`;
  const ask = (path) => call(fetcher, `https://api.postmarkapp.com${path}`, { headers }, 'Postmark');
  const [sends, bounces] = await Promise.all([settle(() => ask(`/stats/outbound/sends?${range}`)), settle(() => ask(`/stats/outbound/bounces?${range}`))]);
  if (sends.error) return { account: null, daily: { error: sends.error }, events: null, blocked: null, sender: { email: senderAddress(env.MAIL_FROM), verified: null } };
  const bounced = new Map((bounces.value?.Days || []).map((row) => [String(row.Date).slice(0, 10), Object.entries(row).reduce((sum, [key, value]) => (key === 'Date' ? sum : sum + (Number(value) || 0)), 0)]));
  return {
    account: null,
    daily: byDay((sends.value.Days || []).map((row) => ({ date: String(row.Date).slice(0, 10), sent: row.Sent, bounced: bounced.get(String(row.Date).slice(0, 10)) || 0 })), days, (row) => row.date, STAT_FIELDS),
    events: null,
    blocked: null,
    sender: { email: senderAddress(env.MAIL_FROM), verified: null },
  };
}

const READERS = { brevo: readBrevo, sendgrid: readSendgrid, postmark: readPostmark };

/** An address taken off Brevo's blocked list, so the site's mail reaches it again. */
export async function unblockAddress(env, address, fetcher = fetch) {
  if (!mailConfigured(env)) throw new Error('mail is not set up here');
  if (mailProvider(env) !== 'brevo') throw new Error('only Brevo keeps a list the site can take an address off');
  const to = String(address || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('an email address');
  await brevo(env, fetcher)(`/smtp/blockedContacts/${encodeURIComponent(to)}`, { method: 'DELETE' });
  return { ok: true, email: to };
}

// -------------------------------------------------------------- the site's log

/**
 * The site's own log, summed: sends tried each day and how many the provider
 * refused, today's and this month's, and the latest. Pure.
 */
export function mailLog(entries, now = Date.now(), days = lastDays(now)) {
  const list = [...(entries || [])].filter((entry) => Number.isFinite(entry?.at)).sort((a, b) => b.at - a.at);
  const daily = byDay(
    list.map((entry) => ({ at: entry.at, sent: entry.ok ? 1 : 0, failed: entry.ok ? 0 : 1 })),
    days,
    (row) => dayOf(row.at),
    ['sent', 'failed'],
  );
  const today = dayOf(now);
  const month = today.slice(0, 7);
  const count = (pick) => list.filter(pick).length;
  return {
    daily,
    today: { sent: count((entry) => entry.ok && dayOf(entry.at) === today), failed: count((entry) => !entry.ok && dayOf(entry.at) === today) },
    month: { sent: count((entry) => entry.ok && dayOf(entry.at).startsWith(month)), failed: count((entry) => !entry.ok && dayOf(entry.at).startsWith(month)) },
    byKind: ['project', 'try', 'test'].map((kind) => ({ kind, sent: count((entry) => entry.ok && entry.kind === kind && dayOf(entry.at).startsWith(month)) })),
    recent: list.slice(0, 50),
    lastFailure: list.find((entry) => !entry.ok) || null,
  };
}

// ------------------------------------------------------------------- overview

/** Everything the Email tab shows. `log` is the site's own entries (worker/invites.js), or null where none is kept. */
export async function mailOverview(env, { fetcher = fetch, now = Date.now(), log = null } = {}) {
  const configured = mailConfigured(env);
  const provider = mailProvider(env);
  const days = lastDays(now);
  const today = days[days.length - 1];
  const read = configured ? READERS[provider] : null;
  const fromProvider = read ? await settle(() => read(env, fetcher, days, now)) : null;
  const providerPart = fromProvider?.value ?? (fromProvider ? { account: { error: fromProvider.error }, daily: { error: fromProvider.error }, events: null, blocked: null, sender: null } : null);
  const ours = log ? mailLog(log, now, days) : null;
  const providerDaily = Array.isArray(providerPart?.daily) ? providerPart.daily : null;
  const monthOf = (rows, pick) => rows.filter((row) => row.day.startsWith(today.slice(0, 7))).reduce((sum, row) => sum + pick(row), 0);
  // The provider's counts cover everything sent on the account; the site's log, what this site sent. The larger is nearer the limit.
  const usedToday = Math.max(providerDaily ? providerDaily.at(-1).sent : 0, ours ? ours.today.sent : 0);
  const usedMonth = Math.max(providerDaily ? monthOf(providerDaily, (row) => row.sent) : 0, ours ? ours.month.sent : 0);
  const monthStart = Date.parse(`${today.slice(0, 7)}-01T00:00:00Z`);
  const nextMonth = new Date(monthStart);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  return {
    configured,
    provider,
    providerName: PROVIDER_NAMES[provider] || null,
    from: String(env.MAIL_FROM || '').trim(),
    at: now,
    day: today,
    resetsInMs: Date.parse(`${today}T00:00:00Z`) + DAY_MS - now,
    monthResetsInMs: nextMonth.getTime() - now,
    limits: mailLimits(env, provider),
    used: { today: usedToday, month: usedMonth, measuredBy: providerDaily ? 'provider' : ours ? 'site' : null },
    account: providerPart?.account ?? null,
    sender: providerPart?.sender ?? (configured ? { email: senderAddress(env.MAIL_FROM), verified: null } : null),
    daily: providerPart?.daily ?? null,
    events: providerPart?.events ?? null,
    blocked: providerPart?.blocked ?? null,
    log: ours,
  };
}
