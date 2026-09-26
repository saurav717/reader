import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import type { UsageReport } from './UsageView';

/** The owner's DeepSeek account, as DeepSeek reports it (worker/deepseekBalance.js). */
export interface DeepSeekAccount {
  configured: boolean;
  error?: string;
  balance?: { available: boolean; currency: string; total: number; granted: number; toppedUp: number; at: number } | null;
  days?: { day: string; spent: number; added: number }[];
}

/** How long a balance is good for before the page asks DeepSeek again. */
const BALANCE_MS = 60_000;

function useDeepSeekAccount(days: number, refreshedAt: string): DeepSeekAccount | null {
  const [account, setAccount] = useState<DeepSeekAccount | null>(null);
  const asked = useRef({ at: 0, days: 0 });
  useEffect(() => {
    if (asked.current.days === days && Date.now() - asked.current.at < BALANCE_MS) return;
    asked.current = { at: Date.now(), days };
    let cancelled = false;
    apiFetch(`/usage/deepseek?days=${days}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((answer) => !cancelled && answer && setAccount(answer as DeepSeekAccount))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [days, refreshedAt]);
  return account;
}

/**
 * What Ask AI and Explain cost on Claude and DeepSeek, per person — the part
 * of the Usage page under the Serply and SerpApi table. The answers go from
 * each visitor's browser to Anthropic or DeepSeek on their own key; the app
 * reports the tokens each one took to the Worker (src/lib/aiUsage.ts), and
 * the Worker prices them (worker/usage.js). A box of everyone, searchable by
 * email, and under it each provider's days, for everyone or the one picked.
 */

type Provider = 'claude' | 'deepseek';
type Person = UsageReport['people'][number];
type Day = NonNullable<Person['daily']>[number];

const PROVIDERS: { id: Provider; name: string }[] = [
  { id: 'claude', name: 'Claude' },
  { id: 'deepseek', name: 'DeepSeek' },
];

/** Rows the box shows before it scrolls. */
const ROWS_IN_VIEW = 12;
const ROW_HEIGHT = 37;

const num = (value: unknown) => Number(value) || 0;
const get = (counts: object | undefined, key: string) => num((counts as Record<string, unknown> | undefined)?.[key]);

/** Millionths of a dollar, as money: to the cent, or finer when there are no cents yet. */
export function dollars(micro: number): string {
  const value = micro / 1_000_000;
  if (!value) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const tokens = (value: number) => value.toLocaleString('en-US');
const compact = (value: number) =>
  value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${+(value / 1000).toFixed(1)}K` : String(Math.round(value * 100) / 100);

const aiCost = (counts: object | undefined) => PROVIDERS.reduce((sum, { id }) => sum + get(counts, `${id}_cost`), 0);

/** Every day from `since` to `until`, inclusive, as YYYY-MM-DD (UTC). */
function daysBetween(since: string, until: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${until}T00:00:00Z`);
  for (let at = Date.parse(`${since}T00:00:00Z`); at <= end && out.length < 400; at += 86_400_000) {
    out.push(new Date(at).toISOString().slice(0, 10));
  }
  return out;
}

const shortDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

export default function AiUsage({ report }: { report: UsageReport }) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);

  const people = useMemo(
    () => [...report.people].sort((a, b) => aiCost(b.total) - aiCost(a.total) || a.email.localeCompare(b.email)),
    [report.people],
  );
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? people.filter((person) => person.email.toLowerCase().includes(needle)) : people;
  }, [people, query]);

  // Someone picked who has since dropped out of the period shows everyone again.
  useEffect(() => {
    if (picked && !report.people.some((person) => person.email === picked)) setPicked(null);
  }, [picked, report.people]);

  const days = useMemo(() => daysBetween(report.since, report.until), [report.since, report.until]);
  // Asked again as the report refreshes, at most once a minute.
  const account = useDeepSeekAccount(days.length, `${report.until}:${report.people.length}:${aiCost(report.totals)}`);
  /** Each day's counts, summed over everyone, or the one picked. */
  const byDay = useMemo(() => {
    const sums = new Map<string, Record<string, number>>(days.map((day) => [day, {}]));
    for (const person of report.people) {
      if (picked && person.email !== picked) continue;
      for (const day of person.daily || []) {
        const into = sums.get(day.day);
        if (!into) continue;
        for (const [key, value] of Object.entries(day as Day)) if (key !== 'day') into[key] = (into[key] || 0) + num(value);
      }
    }
    return days.map((day) => ({ day, counts: sums.get(day) || {} }));
  }, [days, report.people, picked]);

  const cell = { padding: '0 12px', height: ROW_HEIGHT, textAlign: 'right' as const, whiteSpace: 'nowrap' as const };
  const rule = '1px solid var(--border-soft)';
  const head = { ...cell, fontWeight: 500, position: 'sticky' as const, top: 0, background: 'var(--surface)', zIndex: 1, borderBottom: rule };

  return (
    <section style={{ marginTop: 36 }} aria-label="AI credits">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>AI credits — Claude and DeepSeek</h2>
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          {dollars(aiCost(report.totals))} in all · {report.since} to {report.until}
        </span>
      </div>

      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by email…"
        aria-label="Search by email"
        style={{
          width: '100%',
          maxWidth: 420,
          boxSizing: 'border-box',
          padding: '8px 12px',
          fontSize: 13.5,
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--surface)',
          color: 'var(--ink)',
          marginBottom: 10,
        }}
      />

      <div
        style={{
          maxHeight: ROW_HEIGHT * (ROWS_IN_VIEW + 1) + 2,
          overflowY: 'auto',
          border: '1px solid var(--border)',
          borderRadius: 10,
          background: 'var(--surface)',
        }}
      >
        <table style={{ borderCollapse: 'collapse', fontSize: 13.5, width: '100%' }}>
          <thead>
            <tr style={{ color: 'var(--muted)' }}>
              <th style={{ ...head, textAlign: 'left' }}>Who</th>
              {PROVIDERS.map(({ id, name }) => [
                <th key={`${id}-n`} style={head}>
                  {name} answers
                </th>,
                <th key={`${id}-t`} style={head}>
                  {name} tokens
                </th>,
                <th key={`${id}-c`} style={head}>
                  {name} cost
                </th>,
              ])}
              <th style={head}>Total</th>
            </tr>
          </thead>
          <tbody>
            {shown.length ? (
              shown.map((person) => {
                const active = picked === person.email;
                return (
                  <tr
                    key={person.email}
                    onClick={() => setPicked(active ? null : person.email)}
                    aria-selected={active}
                    title={active ? 'Show everyone in the charts' : 'Show only them in the charts'}
                    style={{ cursor: 'pointer', borderBottom: rule, background: active ? 'var(--accent-soft)' : undefined }}
                  >
                    <td style={{ ...cell, textAlign: 'left', fontWeight: active ? 600 : undefined }}>{person.email}</td>
                    {PROVIDERS.map(({ id }) => [
                      <td key={`${id}-n`} style={cell}>
                        {get(person.total, id)}
                      </td>,
                      <td key={`${id}-t`} style={cell}>
                        {tokens(get(person.total, `${id}_in`) + get(person.total, `${id}_out`))}
                      </td>,
                      <td key={`${id}-c`} style={cell}>
                        {dollars(get(person.total, `${id}_cost`))}
                      </td>,
                    ])}
                    <td style={{ ...cell, fontWeight: 600 }}>{dollars(aiCost(person.total))}</td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={2 + PROVIDERS.length * 3} style={{ ...cell, textAlign: 'left', color: 'var(--muted)' }}>
                  No email matches “{query}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '8px 0 0', lineHeight: 1.6 }}>
        {shown.length} of {people.length} shown. Click someone to see only their days below. Costs are worked out from each
        answer’s tokens at list price — Anthropic’s and DeepSeek’s own consoles are the bill.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '26px 0 4px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>Charts for</span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13,
            padding: '4px 10px',
            borderRadius: 999,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
          }}
        >
          {picked ?? 'everyone'}
          {picked ? (
            <button
              type="button"
              onClick={() => setPicked(null)}
              aria-label="Show everyone"
              style={{ border: 0, background: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 0, fontSize: 14, lineHeight: 1 }}
            >
              ×
            </button>
          ) : null}
        </span>
      </div>

      {PROVIDERS.map(({ id, name }) => (
        <ProviderCharts key={id} provider={id} name={name} byDay={byDay} account={id === 'deepseek' ? account : null} />
      ))}
    </section>
  );
}

const card = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: '14px 18px 12px',
} as const;

function ProviderCharts({
  provider,
  name,
  byDay,
  account,
}: {
  provider: Provider;
  name: string;
  byDay: { day: string; counts: Record<string, number> }[];
  account: DeepSeekAccount | null;
}) {
  const series = (key: string) => byDay.map(({ counts }) => num(counts[`${provider}${key}`]));
  const cost = series('_cost');
  const answers = series('');
  const input = series('_in');
  const output = series('_out');
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const days = byDay.map(({ day }) => day);

  return (
    <div style={{ marginTop: 22 }}>
      <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 10px' }}>{name}</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 12 }}>
        <Tile title="Cost" value={dollars(sum(cost))} unit="USD" />
        <Tile title="API requests" value={sum(answers).toLocaleString('en-US')} />
        <Tile title="Tokens" value={tokens(sum(input) + sum(output))} />
      </div>
      {account ? <AccountPanel account={account} days={days} /> : null}
      <div style={{ ...card, marginBottom: 12 }}>
        <BarChart
          title={`Cost (USD) ${dollars(sum(cost))}`}
          days={days}
          series={[{ label: 'Cost', color: 'var(--viz-1)', values: cost }]}
          format={dollars}
          axis={(value) => dollars(value).replace(/\.?0+$/, '')}
          height={200}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        <div style={card}>
          <BarChart
            title={`API requests ${sum(answers).toLocaleString('en-US')}`}
            days={days}
            series={[{ label: 'Requests', color: 'var(--viz-1)', values: answers }]}
            format={(value) => value.toLocaleString('en-US')}
            axis={compact}
            height={160}
          />
        </div>
        <div style={card}>
          <BarChart
            title={`Tokens ${tokens(sum(input) + sum(output))}`}
            days={days}
            series={[
              { label: 'Input', color: 'var(--viz-1)', values: input },
              { label: 'Output', color: 'var(--viz-2)', values: output },
            ]}
            format={tokens}
            axis={compact}
            height={160}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The account as DeepSeek itself reports it: the balance now, and what it
 * fell by each day. Only for the owner's key — everyone on a key of their own
 * is in the tally above, not here.
 */
function AccountPanel({ account, days }: { account: DeepSeekAccount; days: string[] }) {
  const note = { fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6, margin: '0 0 12px' } as const;
  if (!account.configured) {
    return (
      <p style={note}>
        To see your DeepSeek account’s own balance and spend here, give the Worker your key:{' '}
        <code>npx wrangler secret put DEEPSEEK_KEY</code>, then redeploy it.
      </p>
    );
  }
  const balance = account.balance;
  const byDay = new Map((account.days || []).map((row) => [row.day, row]));
  const spent = days.map((day) => byDay.get(day)?.spent || 0);
  const total = spent.reduce((a, b) => a + b, 0);
  const currency = balance?.currency || 'USD';
  const money = (value: number) => (currency === 'USD' ? dollars(value) : `${(value / 1_000_000).toFixed(2)} ${currency}`);
  return (
    <div style={{ ...card, marginBottom: 12, background: 'var(--panel)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>Your DeepSeek account</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          from DeepSeek’s own balance{balance ? ` · checked ${new Date(balance.at).toLocaleTimeString()}` : ''}
        </span>
      </div>
      {account.error ? (
        <p className="banner error" style={{ margin: '0 0 10px' }}>
          DeepSeek did not answer: {account.error}
        </p>
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 12 }}>
        <Tile title="Balance" value={balance ? money(balance.total) : '—'} unit={balance && currency === 'USD' ? 'USD' : undefined} />
        <Tile title="Topped up" value={balance ? money(balance.toppedUp) : '—'} />
        <Tile title="Granted" value={balance ? money(balance.granted) : '—'} />
        <Tile title="Spent in this period" value={money(total)} />
      </div>
      {balance && !balance.available ? (
        <p className="banner error" style={{ margin: '0 0 10px' }}>
          DeepSeek says this balance cannot pay for requests — top it up.
        </p>
      ) : null}
      <div style={{ ...card }}>
        <BarChart
          title={`Spent per day, from the balance ${money(total)}`}
          days={days}
          series={[{ label: 'Spent', color: 'var(--viz-2)', values: spent }]}
          format={money}
          axis={(value) => money(value).replace(/\.?0+(?= |$)/, '')}
          height={160}
        />
      </div>
      <p style={{ ...note, margin: '8px 0 0' }}>
        The fall in the balance between checks — every hour, and whenever this page is open. It starts from the first check after
        DEEPSEEK_KEY was set; a top-up between two checks hides that much spending.
      </p>
    </div>
  );
}

function Tile({ title, value, unit }: { title: string; value: string; unit?: string }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{title}</div>
      <div style={{ fontSize: 26, fontWeight: 500, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
        {value}
        {unit ? <span style={{ fontSize: 13, color: 'var(--muted)', marginLeft: 6 }}>{unit}</span> : null}
      </div>
    </div>
  );
}

/** A round top for the axis: 1, 2 or 5 times a power of ten, at or above `max`. */
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= max) return step * power;
  return 10 * power;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth || 600);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.round(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

interface Series {
  label: string;
  color: string;
  values: number[];
}

/**
 * Bars per day, stacked when there is more than one series, on one axis from
 * zero. Hovering a day shows its numbers; a legend names two or more series.
 */
function BarChart({
  title,
  days,
  series,
  format,
  axis,
  height,
}: {
  title: string;
  days: string[];
  series: Series[];
  format: (value: number) => string;
  axis: (value: number) => string;
  height: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const totals = days.map((_, index) => series.reduce((sum, s) => sum + (s.values[index] || 0), 0));
  const top = niceMax(Math.max(0, ...totals));
  const left = 48;
  const right = 8;
  const plotTop = 8;
  const plotBottom = height - 22;
  const plotHeight = plotBottom - plotTop;
  const slot = (width - left - right) / Math.max(1, days.length);
  const bar = Math.max(2, Math.min(18, slot * 0.6));
  const y = (value: number) => plotBottom - (value / top) * plotHeight;
  const ticks = days.length <= 1 ? [0] : [0, Math.round((days.length - 1) / 3), Math.round((2 * (days.length - 1)) / 3), days.length - 1];

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontSize: 13.5, fontWeight: 500 }}>{title}</span>
        {series.length > 1 ? (
          <span style={{ display: 'inline-flex', gap: 12, fontSize: 12, color: 'var(--muted)' }}>
            {series.map((s) => (
              <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color }} />
                {s.label}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      <svg width={width} height={height} role="img" aria-label={title} style={{ display: 'block', overflow: 'visible' }} onMouseLeave={() => setHover(null)}>
        {[0, top / 2, top].map((value) => (
          <g key={value}>
            <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="var(--border-soft)" strokeWidth={1} />
            <text x={left - 8} y={y(value)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)">
              {axis(value)}
            </text>
          </g>
        ))}
        {ticks.map((index) => (
          <text key={index} x={left + slot * (index + 0.5)} y={height - 4} textAnchor="middle" fontSize={11} fill="var(--muted)">
            {shortDay(days[index])}
          </text>
        ))}
        {days.map((day, index) => {
          const x = left + slot * (index + 0.5) - bar / 2;
          let base = 0;
          const marks = series.map((s, which) => {
            const value = s.values[index] || 0;
            if (!value) return null;
            const from = y(base);
            base += value;
            const to = y(base);
            const topmost = series.slice(which + 1).every((next) => !(next.values[index] || 0));
            // A 2px gap between stacked parts; the top part gets the rounded end.
            const gap = which > 0 ? 2 : 0;
            const h = Math.max(1, from - to - gap);
            const r = topmost ? Math.min(4, bar / 2, h) : 0;
            const yTop = from - gap - h;
            const d = `M${x},${from - gap} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + bar - r} Q${x + bar},${yTop} ${x + bar},${yTop + r} V${from - gap} Z`;
            return <path key={s.label} d={d} fill={s.color} opacity={hover === null || hover === index ? 1 : 0.55} />;
          });
          return (
            <g key={day}>
              {marks}
              <rect
                x={left + slot * index}
                y={plotTop}
                width={slot}
                height={plotHeight}
                fill="transparent"
                onMouseEnter={() => setHover(index)}
                onFocus={() => setHover(index)}
              />
            </g>
          );
        })}
      </svg>
      {hover !== null ? (
        <div
          role="tooltip"
          style={{
            position: 'absolute',
            top: 24,
            left: Math.min(Math.max(0, left + slot * (hover + 0.5) - 70), Math.max(0, width - 150)),
            minWidth: 140,
            padding: '6px 10px',
            fontSize: 12,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: 'var(--shadow-md)',
            pointerEvents: 'none',
            zIndex: 2,
          }}
        >
          <div style={{ color: 'var(--muted)', marginBottom: 2 }}>{days[hover]}</div>
          {series.map((s) => (
            <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />
              <span style={{ flexGrow: 1 }}>{s.label}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{format(s.values[hover] || 0)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
