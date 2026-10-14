import { ownerFetch } from '../lib/owner';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { card, cardHead, cardTitle, muted } from './AiUsage';

/**
 * The Usage page's Email tab: the mail the site sends — invitations to a
 * project, "Invite someone" — against the provider's plan, today and this
 * month; whether it was delivered, bounced or blocked; every send the site
 * tried, with the provider's refusal; a test mail; and, on Brevo, the
 * addresses it will no longer send to (worker/mailUsage.js).
 */

type Day = { day: string; sent: number; delivered?: number; bounced?: number; blocked?: number; spam?: number; opened?: number; clicked?: number; failed?: number };
type Failed = { error: string };

interface LogEntry {
  id: string;
  at: number;
  kind: 'project' | 'try' | 'test';
  to: string;
  by?: string;
  ok: boolean;
  error?: string;
  project?: string;
}

interface Overview {
  configured: boolean;
  provider: string | null;
  providerName: string | null;
  from: string;
  at: number;
  day: string;
  resetsInMs: number;
  monthResetsInMs: number;
  limits: { daily: number | null; monthly: number | null; plan: string; source: string };
  used: { today: number; month: number; measuredBy: 'provider' | 'site' | null };
  account: ({ name?: string; email?: string; plan?: string; credits: number | null; total?: number | null; detail?: string; endsAt?: string | null } & Partial<Failed>) | Failed | null;
  sender: { email: string; verified: boolean | null; detail?: string; error?: string } | null;
  daily: Day[] | Failed | null;
  events: { at: number | null; to: string; event: string; reason: string; subject: string }[] | Failed | null;
  blocked: { count: number; contacts: { email: string; reason: string; at: number | null }[]; canUnblock?: boolean } | Failed | null;
  log: {
    daily: { day: string; sent: number; failed: number }[];
    today: { sent: number; failed: number };
    month: { sent: number; failed: number };
    byKind: { kind: LogEntry['kind']; sent: number }[];
    recent: LogEntry[];
    lastFailure: LogEntry | null;
  } | null;
}

const KIND: Record<LogEntry['kind'], string> = { project: 'Project invitation', try: 'Invite someone', test: 'Test' };
const failedOf = (value: unknown): string | null => (value && typeof value === 'object' && 'error' in value && (value as Failed).error ? (value as Failed).error : null);
const count = (value: number) => Math.round(value).toLocaleString('en-US');
const toneOf = (share: number) => (share >= 0.9 ? 'var(--danger)' : share >= 0.7 ? 'var(--viz-2)' : 'var(--viz-1)');
const percent = (share: number) => (share > 0 && share < 0.001 ? '<0.1%' : `${Math.round(share * 1000) / 10}%`);
const when = (at: number | null) => (at ? new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

function until(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes >= 48 * 60) return `${Math.round(minutes / 1440)} days`;
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

/** The overview, asked again when the page refreshes; null until the first answer. */
function useOverview(refreshedAt: number) {
  const [overview, setOverview] = useState<Overview | null | undefined>(undefined);
  const load = useCallback(async () => {
    try {
      const response = await ownerFetch('/usage/mail');
      const answer = response.ok ? ((await response.json()) as Overview) : null;
      setOverview((before) => answer ?? before ?? null);
    } catch {
      setOverview((before) => before ?? null);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [refreshedAt, load]);
  return { overview, reload: load };
}

async function post(path: string, body: object) {
  const response = await ownerFetch(path, undefined, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!response.ok || answer.error) throw new Error(answer.error || `the proxy answered ${response.status}`);
  return answer;
}

export default function MailUsage({ refreshedAt }: { refreshedAt: number }) {
  const { overview, reload } = useOverview(refreshedAt);
  if (overview === undefined) return <p style={{ fontSize: 13, color: 'var(--muted)' }}>Asking the mail provider…</p>;
  if (overview === null)
    return <p className="banner error">The proxy did not answer for mail. Try Refresh, or check the Worker is deployed with worker/mailUsage.js.</p>;

  const { limits, used } = overview;
  const name = overview.providerName || 'the provider';
  const dayShare = limits.daily ? Math.min(1, used.today / limits.daily) : null;
  const monthShare = limits.monthly ? Math.min(1, used.month / limits.monthly) : null;
  const account = overview.account && !failedOf(overview.account) ? (overview.account as Exclude<Overview['account'], Failed | null>) : null;
  const daily = Array.isArray(overview.daily) ? overview.daily : null;
  const log = overview.log;
  const tile = (label: string, value: ReactNode, note?: ReactNode) => (
    <div style={{ ...card, padding: '14px 16px', flex: '1 1 200px', minWidth: 0 }}>
      <div style={{ ...muted, fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
      {note ? <div style={{ ...muted, fontSize: 11.5, marginTop: 4 }}>{note}</div> : null}
    </div>
  );

  // The days' sends: the provider's where it tells them, else the site's own log — with what the provider refused, from the log.
  const failedByDay = new Map((log?.daily ?? []).map((row) => [row.day, row.failed]));
  const days: Day[] = (daily ?? log?.daily ?? []).map((row) => ({ ...row, failed: failedByDay.get(row.day) ?? 0 }));
  const totals = (daily ?? []).reduce(
    (sum, row) => ({ sent: sum.sent + row.sent, delivered: sum.delivered + (row.delivered ?? 0), bounced: sum.bounced + (row.bounced ?? 0), blocked: sum.blocked + (row.blocked ?? 0), spam: sum.spam + (row.spam ?? 0), opened: sum.opened + (row.opened ?? 0), clicked: sum.clicked + (row.clicked ?? 0) }),
    { sent: 0, delivered: 0, bounced: 0, blocked: 0, spam: 0, opened: 0, clicked: 0 },
  );

  return (
    <>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {tile(
          'Sent today',
          <>
            {count(used.today)}
            {limits.daily ? <span style={{ ...muted, fontSize: 14, marginLeft: 6 }}>of {count(limits.daily)}</span> : null}
          </>,
          dayShare !== null ? (
            <span style={{ color: toneOf(dayShare) }}>
              {percent(dayShare)} of the day’s sends · resets in {until(overview.resetsInMs)}
            </span>
          ) : (
            'no daily limit on this plan'
          ),
        )}
        {tile(
          'Sent this month',
          <>
            {count(used.month)}
            {limits.monthly ? <span style={{ ...muted, fontSize: 14, marginLeft: 6 }}>of {count(limits.monthly)}</span> : null}
          </>,
          monthShare !== null ? <span style={{ color: toneOf(monthShare) }}>{percent(monthShare)} of the month’s sends · resets in {until(overview.monthResetsInMs)}</span> : 'no monthly limit on this plan',
        )}
        {tile(
          'Credits left',
          account?.credits !== null && account?.credits !== undefined ? count(account.credits) : '—',
          account ? [account.plan ? `${name} plan: ${account.plan}` : '', account.detail].filter(Boolean).join(' · ') : failedOf(overview.account) ?? `${name} does not report credits`,
        )}
        {tile(
          'Refused today',
          log ? <span style={{ color: log.today.failed ? 'var(--danger)' : undefined }}>{count(log.today.failed)}</span> : '—',
          log?.lastFailure ? `last: ${when(log.lastFailure.at)} — ${log.lastFailure.error || 'refused'}` : log ? 'no send has been refused' : 'the site keeps no log here (INVITES)',
        )}
      </div>

      {!overview.configured ? (
        <div style={{ ...card, padding: '16px 18px', fontSize: 13.5, lineHeight: 1.6, marginTop: 16 }}>
          <h3 style={{ ...cardTitle, marginBottom: 6 }}>Mail is not set up</h3>
          <p style={{ margin: 0, color: 'var(--muted)' }}>
            The site sends no mail until it has a provider’s key as the secret <code>MAIL_API_KEY</code> and a verified sender in <code>MAIL_FROM</code> — the
            steps are in docs/deploy.md, “Optional: mail”. Invitations still work meanwhile: the share dialog says to send the link by hand.
          </p>
        </div>
      ) : (
        <AccountCard overview={overview} onSent={reload} />
      )}

      {limits.daily || limits.monthly ? (
        <div style={{ ...card, marginTop: 16 }}>
          <div style={cardHead}>
            <h3 style={cardTitle}>Plan</h3>
            <span style={muted}>
              {limits.plan}
              {used.measuredBy === 'provider' ? ` · counted by ${name}, for the whole account` : used.measuredBy === 'site' ? ' · counted from the site’s own log' : ''}
            </span>
          </div>
          {limits.daily ? <Meter label="Today" used={used.today} limit={limits.daily} note={`resets at 00:00 UTC, in ${until(overview.resetsInMs)}`} first /> : null}
          {limits.monthly ? <Meter label="This month" used={used.month} limit={limits.monthly} note={`resets on the 1st, in ${until(overview.monthResetsInMs)}`} first={!limits.daily} /> : null}
        </div>
      ) : null}

      <div style={{ ...card, marginTop: 16 }}>
        <div style={cardHead}>
          <h3 style={cardTitle}>The last {days.length || 30} days</h3>
          <span style={muted}>{daily ? `as ${name} counts them` : failedOf(overview.daily) ? `${name}: ${failedOf(overview.daily)} — from the site’s log instead` : 'from the site’s own log'}</span>
        </div>
        {days.length ? <Days days={days} limit={limits.daily} /> : <p style={{ ...muted, padding: '12px 16px', margin: 0 }}>Nothing sent yet.</p>}
        {daily ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, padding: '4px 16px 14px', fontSize: 13 }}>
            {(
              [
                ['Sent', totals.sent, null],
                ['Delivered', totals.delivered, totals.sent],
                ['Bounced', totals.bounced, totals.sent],
                ['Blocked', totals.blocked, totals.sent],
                ['Marked spam', totals.spam, totals.sent],
                ['Opened', totals.opened, totals.delivered],
                ['Clicked', totals.clicked, totals.delivered],
              ] as const
            ).map(([label, value, of]) => (
              <div key={label}>
                <div style={{ ...muted, fontSize: 12 }}>{label}</div>
                <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: (label === 'Bounced' || label === 'Blocked' || label === 'Marked spam') && value ? 'var(--danger)' : undefined }}>
                  {count(value)}
                  {of ? <span style={{ ...muted, fontWeight: 400, marginLeft: 6 }}>{percent(value / of)}</span> : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <SiteLog log={log} />
      <ProviderEvents events={overview.events} name={name} />
      <Blocked blocked={overview.blocked} name={name} onChanged={reload} />

      <p style={{ ...muted, fontSize: 11.5, marginTop: 16, lineHeight: 1.5 }}>
        The provider’s counts cover everything sent with the account, a few minutes behind; the site’s log, each send this Worker tried. The tiles use whichever
        is higher. Past the plan’s sends, the provider refuses the mail and the invitation stands without it: the share dialog says to send the link by hand.
        {limits.source === 'free plan' ? ' The limits are the free plan’s; set MAIL_DAILY_LIMIT or MAIL_MONTHLY_LIMIT in wrangler.toml for a paid one.' : ''}
      </p>
    </>
  );
}

function AccountCard({ overview, onSent }: { overview: Overview; onSent: () => void }) {
  const [to, setTo] = useState('');
  const [state, setState] = useState<{ busy?: boolean; ok?: string; error?: string }>({});
  const sender = overview.sender;
  const account = overview.account && !failedOf(overview.account) ? (overview.account as Exclude<Overview['account'], Failed | null>) : null;
  const send = async () => {
    setState({ busy: true });
    try {
      const answer = (await post('/usage/mail/test', to.trim() ? { email: to.trim() } : {})) as { to?: string };
      setState({ ok: `Sent to ${answer.to}. Check that inbox, and its spam folder.` });
      onSent();
    } catch (error) {
      setState({ error: (error as Error).message });
      onSent();
    }
  };
  const row = (label: string, value: ReactNode) => (
    <div style={{ display: 'flex', gap: 12, padding: '6px 0', fontSize: 13 }}>
      <span style={{ ...muted, width: 110, flex: 'none' }}>{label}</span>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  );
  return (
    <div style={{ ...card, marginTop: 16 }}>
      <div style={cardHead}>
        <h3 style={cardTitle}>{overview.providerName ?? 'Mail'}</h3>
        <span style={muted}>the account the site’s invitations go out through</span>
      </div>
      <div style={{ padding: '8px 16px 14px' }}>
        {account?.email || account?.name ? row('Account', [account.name, account.email && account.email !== account.name ? account.email : ''].filter(Boolean).join(' · ')) : null}
        {row('Sender', overview.from || '—')}
        {sender
          ? row(
              'Verified',
              sender.error ? (
                <span style={muted}>{sender.error}</span>
              ) : sender.verified === null ? (
                <span style={muted}>{overview.providerName ?? 'The provider'} does not say here</span>
              ) : (
                <span style={{ color: sender.verified ? 'var(--viz-1)' : 'var(--danger)' }}>
                  {sender.verified ? 'Yes' : 'No'}
                  {sender.detail ? <span style={{ ...muted, marginLeft: 6 }}>— {sender.detail}</span> : null}
                </span>
              ),
            )
          : null}
        {failedOf(overview.account) ? row('Account', <span style={{ color: 'var(--danger)' }}>{failedOf(overview.account)}</span>) : null}
        {account?.endsAt ? row('Plan ends', account.endsAt) : null}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
          <input
            className="invites-find"
            style={{ marginLeft: 0, width: 260, maxWidth: '100%' }}
            placeholder="Your own address, unless you name one"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            aria-label="Send a test to"
          />
          <button type="button" className="btn sm" onClick={() => void send()} disabled={state.busy}>
            {state.busy ? 'Sending…' : 'Send a test mail'}
          </button>
          <span style={{ ...muted, fontSize: 12 }}>uses one of the plan’s sends</span>
        </div>
        {state.ok ? <p style={{ fontSize: 12.5, color: 'var(--viz-1)', margin: '8px 0 0' }}>{state.ok}</p> : null}
        {state.error ? <p style={{ fontSize: 12.5, color: 'var(--danger)', margin: '8px 0 0' }}>{state.error}</p> : null}
      </div>
    </div>
  );
}

function Meter({ label, used, limit, note, first }: { label: string; used: number; limit: number; note: string; first?: boolean }) {
  const share = Math.min(1, used / limit);
  const tone = toneOf(share);
  return (
    <div style={{ padding: '12px 16px', borderTop: first ? undefined : '1px solid var(--border-soft)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 500, fontSize: 13.5 }}>{label}</span>
        <span style={{ flexGrow: 1 }} />
        <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>
          {count(used)}
          <span style={{ ...muted, marginLeft: 4 }}>of {count(limit)}</span>
          <span style={{ marginLeft: 8, color: tone, fontWeight: 500 }}>{percent(share)}</span>
        </span>
      </div>
      <div role="meter" aria-label={`Emails sent ${label.toLowerCase()} against the plan`} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} style={{ height: 6, marginTop: 8, borderRadius: 3, background: 'var(--border-soft)', overflow: 'hidden' }}>
        <div style={{ width: `${share * 100}%`, minWidth: share ? 2 : 0, height: '100%', background: tone, borderRadius: 3 }} />
      </div>
      <div style={{ ...muted, fontSize: 11.5, marginTop: 5 }}>
        {count(Math.max(0, limit - used))} left · {note}
      </div>
    </div>
  );
}

/** The days as bars of what was sent, scaled to the busiest, each colored by its share of the daily limit; refused sends on top in red. */
function Days({ days, limit }: { days: Day[]; limit: number | null }) {
  const height = 64;
  const top = Math.max(1, ...days.map((row) => row.sent + (row.failed ?? 0)));
  return (
    <div style={{ padding: '12px 16px 8px' }}>
      <svg viewBox={`0 0 ${days.length * 10} ${height}`} preserveAspectRatio="none" width="100%" height={height} role="img" aria-label={`Emails sent each day, last ${days.length} days`} style={{ display: 'block' }}>
        <line x1={0} x2={days.length * 10} y1={height - 0.5} y2={height - 0.5} stroke="var(--border-soft)" vectorEffect="non-scaling-stroke" />
        {days.map((row, index) => {
          const tall = row.sent > 0 ? Math.max(1.5, (row.sent / top) * (height - 2)) : 0;
          const bad = row.failed ? Math.max(1.5, (row.failed / top) * (height - 2)) : 0;
          const fill = limit ? toneOf(Math.min(1, row.sent / limit)) : 'var(--viz-1)';
          return (
            <g key={row.day}>
              <title>
                {row.day}: {count(row.sent)} sent{limit ? ` (${percent(Math.min(1, row.sent / limit))} of the day’s)` : ''}
                {row.failed ? `, ${count(row.failed)} refused` : ''}
              </title>
              <rect x={index * 10 + 2} y={height - tall} width={6} height={tall} fill={fill} />
              {bad ? <rect x={index * 10 + 2} y={height - tall - bad} width={6} height={bad} fill="var(--danger)" /> : null}
            </g>
          );
        })}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', ...muted, fontSize: 11, marginTop: 4 }}>
        <span>{days[0]?.day}</span>
        <span>today</span>
      </div>
    </div>
  );
}

function SiteLog({ log }: { log: Overview['log'] }) {
  if (!log) return null;
  return (
    <div style={{ ...card, marginTop: 16 }}>
      <div style={cardHead}>
        <h3 style={cardTitle}>Sent by the site</h3>
        <span style={muted}>
          this month: {log.byKind.map((item) => `${count(item.sent)} ${KIND[item.kind].toLowerCase()}`).join(' · ')}
          {log.month.failed ? ` · ${count(log.month.failed)} refused` : ''}
        </span>
      </div>
      {!log.recent.length ? (
        <p style={{ ...muted, padding: '12px 16px', margin: 0 }}>No mail sent yet. Each invitation by email shows here, and whether the provider took it.</p>
      ) : (
        <div style={{ overflowX: 'auto', maxHeight: 360 }}>
          <table className="invites-table">
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>To</th>
                <th>From</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {log.recent.map((entry) => (
                <tr key={entry.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{when(entry.at)}</td>
                  <td>
                    {KIND[entry.kind]}
                    {entry.project ? <span style={muted}> · {entry.project}</span> : null}
                  </td>
                  <td>{entry.to}</td>
                  <td style={muted}>{entry.by || '—'}</td>
                  <td style={{ color: entry.ok ? undefined : 'var(--danger)' }}>{entry.ok ? 'Sent' : entry.error || 'Refused'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const BAD_EVENTS = new Set(['hardBounces', 'softBounces', 'bounces', 'blocked', 'invalid', 'spam', 'error', 'deferred', 'unsubscribed']);

function ProviderEvents({ events, name }: { events: Overview['events']; name: string }) {
  if (!events) return null;
  const error = failedOf(events);
  const list = Array.isArray(events) ? events : [];
  return (
    <div style={{ ...card, marginTop: 16 }}>
      <div style={cardHead}>
        <h3 style={cardTitle}>What happened to them</h3>
        <span style={muted}>{name}’s latest events: delivered, opened, bounced, blocked</span>
      </div>
      {error ? (
        <p style={{ padding: '12px 16px', margin: 0, fontSize: 12.5, color: 'var(--danger)' }}>{error}</p>
      ) : !list.length ? (
        <p style={{ ...muted, padding: '12px 16px', margin: 0 }}>No events in the last 30 days.</p>
      ) : (
        <div style={{ overflowX: 'auto', maxHeight: 320 }}>
          <table className="invites-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>To</th>
                <th>Subject / reason</th>
              </tr>
            </thead>
            <tbody>
              {list.map((event, index) => (
                <tr key={`${event.at}-${event.to}-${event.event}-${index}`}>
                  <td style={{ whiteSpace: 'nowrap' }}>{when(event.at)}</td>
                  <td style={{ color: BAD_EVENTS.has(event.event) ? 'var(--danger)' : undefined }}>{event.event}</td>
                  <td>{event.to}</td>
                  <td style={muted}>{event.reason || event.subject}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Blocked({ blocked, name, onChanged }: { blocked: Overview['blocked']; name: string; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!blocked) return null;
  const failed = failedOf(blocked);
  const list = !failed && 'contacts' in blocked ? blocked : null;
  const unblock = async (address: string) => {
    setBusy(address);
    setError(null);
    try {
      await post('/usage/mail/unblock', { email: address });
      onChanged();
    } catch (problem) {
      setError(`${address}: ${(problem as Error).message}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div style={{ ...card, marginTop: 16 }}>
      <div style={cardHead}>
        <h3 style={cardTitle}>Blocked addresses{list ? ` · ${count(list.count)}` : ''}</h3>
        <span style={muted}>{name} sends nothing more to these — after a hard bounce, a spam report or an unsubscribe</span>
      </div>
      {failed ? (
        <p style={{ padding: '12px 16px', margin: 0, fontSize: 12.5, color: 'var(--danger)' }}>{failed}</p>
      ) : !list?.contacts.length ? (
        <p style={{ ...muted, padding: '12px 16px', margin: 0 }}>None: every address can be mailed.</p>
      ) : (
        <>
          {error ? <p style={{ padding: '8px 16px 0', margin: 0, fontSize: 12.5, color: 'var(--danger)' }}>{error}</p> : null}
          <table className="invites-table">
            <thead>
              <tr>
                <th>Address</th>
                <th>Why</th>
                <th>Since</th>
                {list.canUnblock ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {list.contacts.map((contact) => (
                <tr key={contact.email}>
                  <td>{contact.email}</td>
                  <td style={muted}>{contact.reason || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{when(contact.at)}</td>
                  {list.canUnblock ? (
                    <td className="n">
                      <button type="button" className="btn sm" disabled={busy === contact.email} onClick={() => void unblock(contact.email)} title="Let the site's mail reach this address again">
                        {busy === contact.email ? 'Unblocking…' : 'Unblock'}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
