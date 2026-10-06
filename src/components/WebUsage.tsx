import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import { BarChart, card, cardHead, cardTitle, daysBetween, muted } from './AiUsage';
import type { UsageReport } from './UsageView';

/**
 * The web searches Ask AI's Web button made through the proxy — the part of
 * the Usage page between the services table and the AI credits. Two views
 * of the same thing: what the tally counted, per day and per person
 * (worker/usage.js, the `web` count), and what Tavily itself says the key
 * has spent this billing cycle against the plan's allowance
 * (worker/tavilyUsage.js), which is the number that decides whether the
 * month's free thousand is running out.
 */

/** The owner's Tavily account, as Tavily reports it (worker/tavilyUsage.js). */
export interface TavilyAccount {
  configured: boolean;
  error?: string;
  account?: {
    plan: string;
    planUsage: number;
    planLimit: number | null;
    keyUsage: number;
    keyLimit: number | null;
    searches: number;
    extracts: number;
    at: number;
  } | null;
  days?: { day: string; used: number }[];
}

/** How long an answer is good for before the page asks the Worker again. */
const ACCOUNT_MS = 60_000;

function useTavilyAccount(days: number, refreshedAt: number): TavilyAccount | null {
  const [account, setAccount] = useState<TavilyAccount | null>(null);
  const asked = useRef({ at: 0, days: 0 });
  useEffect(() => {
    if (asked.current.days === days && Date.now() - asked.current.at < ACCOUNT_MS) return;
    asked.current = { at: Date.now(), days };
    let cancelled = false;
    apiFetch(`/usage/tavily?days=${days}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((answer) => !cancelled && answer && setAccount(answer as TavilyAccount))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [days, refreshedAt]);
  return account;
}

const whole = (value: number) => value.toLocaleString('en-US');

const ago = (at: number) => {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
};

export default function WebUsage({ report, days, refreshedAt }: { report: UsageReport; days: number; refreshedAt: number }) {
  const tavily = useTavilyAccount(days, refreshedAt);
  const account = tavily?.configured ? tavily.account : null;

  // The tally's searches, per day over the period, and who made them.
  const span = daysBetween(report.since, report.until);
  const byDay = new Map<string, number>();
  let searched = 0;
  for (const person of report.people) {
    let own = 0;
    for (const row of person.daily || []) {
      const n = Number(row.web) || 0;
      if (!n) continue;
      own += n;
      byDay.set(row.day, (byDay.get(row.day) || 0) + n);
    }
    if (own) searched += 1;
  }
  const total = Number(report.totals.web) || 0;
  const perDay = span.map((day) => byDay.get(day) || 0);

  // The plan's allowance, as a share: the number that says whether the month is running out.
  const limit = account?.planLimit ?? null;
  const share = account && limit ? Math.min(1, account.planUsage / limit) : null;
  const left = account && limit ? Math.max(0, limit - account.planUsage) : null;
  const tone = share === null ? 'var(--viz-1)' : share >= 0.9 ? 'var(--danger)' : share >= 0.7 ? 'var(--viz-2)' : 'var(--viz-1)';

  const stat = (label: string, value: string, note?: string) => (
    <div>
      <div style={{ ...muted, fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{value}</div>
      {note ? <div style={{ ...muted, fontSize: 11.5, marginTop: 2 }}>{note}</div> : null}
    </div>
  );

  return (
    <div style={{ ...card, marginTop: 24 }}>
      <div style={cardHead}>
        <h3 style={cardTitle}>Web searches</h3>
        <span style={{ ...muted, fontSize: 12.5 }}>Ask AI’s Web button, through this proxy</span>
        <span style={{ flexGrow: 1 }} />
        {account ? (
          <span style={{ ...muted, fontSize: 12 }} title="Tavily is asked when this page is, at most every couple of minutes, and once an hour on its own">
            Tavily checked {ago(account.at)}
          </span>
        ) : null}
      </div>
      <div className="ai-usage-split">
        <div className="ai-usage-models" style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '14px 16px' }}>
          {stat('Searches this period', whole(total), searched ? `by ${searched} ${searched === 1 ? 'person' : 'people'}` : 'nobody has searched yet')}
          {account ? (
            <>
              <div>
                <div style={{ ...muted, fontSize: 12 }}>Tavily this cycle{account.plan ? ` · ${account.plan} plan` : ''}</div>
                <div style={{ fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
                  {whole(account.planUsage)}
                  {limit ? <span style={{ ...muted, fontSize: 13, marginLeft: 4 }}>of {whole(limit)} credits</span> : <span style={{ ...muted, fontSize: 13, marginLeft: 4 }}>credits</span>}
                </div>
                {share !== null ? (
                  <div
                    role="meter"
                    aria-label="Tavily credits used this cycle"
                    aria-valuemin={0}
                    aria-valuemax={limit ?? undefined}
                    aria-valuenow={account.planUsage}
                    title={`${Math.round(share * 100)}% of the plan’s credits used this cycle`}
                    style={{ height: 6, marginTop: 8, borderRadius: 3, background: 'var(--border-soft)', overflow: 'hidden' }}
                  >
                    <div style={{ width: `${share * 100}%`, height: '100%', background: tone, borderRadius: 3 }} />
                  </div>
                ) : null}
                {left !== null ? (
                  <div style={{ ...muted, fontSize: 11.5, marginTop: 6, ...(share !== null && share >= 0.9 ? { color: 'var(--danger)' } : {}) }}>
                    {left ? `${whole(left)} left this month` : 'none left this month — searches fail until the cycle turns, or the plan is raised'}
                  </div>
                ) : null}
              </div>
              {account.keyUsage !== account.planUsage ? (
                // More than one key on the account: this one's share, with the rest spent elsewhere.
                stat('This key', whole(account.keyUsage), `${whole(account.searches)} ${account.searches === 1 ? 'search' : 'searches'}${account.extracts ? `, ${whole(account.extracts)} page reads` : ''} by Tavily’s count`)
              ) : (
                <div style={{ ...muted, fontSize: 11.5, marginTop: -8 }}>
                  {whole(account.searches)} {account.searches === 1 ? 'search' : 'searches'}
                  {account.extracts ? `, ${whole(account.extracts)} page reads` : ''} by Tavily’s count
                </div>
              )}
            </>
          ) : null}
          {tavily && !tavily.configured ? (
            <div style={{ ...muted, fontSize: 11.5, lineHeight: 1.5 }}>
              Tavily’s own numbers — the credits left this month — show here with <code>TAVILY_KEY</code> set on the Worker.
            </div>
          ) : null}
          {tavily?.error ? <div style={{ fontSize: 11.5, color: 'var(--danger)', lineHeight: 1.5 }}>Tavily did not answer: {tavily.error}</div> : null}
        </div>
        <div style={{ padding: '14px 16px', minWidth: 0 }}>
          <BarChart
            title={`Searches ${whole(total)}`}
            days={span}
            series={[{ label: 'Searches', color: 'var(--viz-1)', values: perDay }]}
            format={whole}
            axis={whole}
            height={200}
          />
          <p style={{ ...muted, fontSize: 12, margin: '10px 0 0', lineHeight: 1.6 }}>
            Each search the Web button made through this proxy, whoever made it; the services table says who. A page the model
            read is fetched by the proxy itself and costs nothing.
            {account ? ' Tavily’s count can run ahead of this one when a search was asked elsewhere on the same key.' : ''}
          </p>
        </div>
      </div>
    </div>
  );
}
