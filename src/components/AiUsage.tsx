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

type Metric = 'cost' | 'requests' | 'tokens' | 'balance';

const METRICS: { id: Metric; label: string }[] = [
  { id: 'cost', label: 'Cost' },
  { id: 'requests', label: 'Requests' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'balance', label: 'From balance' },
];

const card = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 12,
} as const;

const cardHead = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
  padding: '12px 16px',
  borderBottom: '1px solid var(--border-soft)',
} as const;

const cardTitle = { fontSize: 14, fontWeight: 600, margin: 0 } as const;
const muted = { fontSize: 12.5, color: 'var(--muted)' } as const;

/**
 * Laid out in three parts, top to bottom: each provider at a glance (which
 * also picks the provider the chart shows), who used it, and one chart of the
 * picked provider's days — cost, requests or tokens, switched in its header —
 * for everyone or the one person clicked in the table.
 */
export default function AiUsage({ report }: { report: UsageReport }) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [provider, setProvider] = useState<Provider>('claude');
  const [metric, setMetric] = useState<Metric>('cost');

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

  // "From balance" is DeepSeek's alone, and only with its key set.
  const hasBalance = provider === 'deepseek' && Boolean(account?.configured);
  const metrics = METRICS.filter((entry) => entry.id !== 'balance' || hasBalance);
  const shownMetric: Metric = metrics.some((entry) => entry.id === metric) ? metric : 'cost';

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
    return days.map((day) => sums.get(day) || {});
  }, [days, report.people, picked]);

  const cell = { padding: '0 14px', height: ROW_HEIGHT, textAlign: 'right' as const, whiteSpace: 'nowrap' as const };
  const rule = '1px solid var(--border-soft)';
  const head = { ...cell, fontWeight: 500, fontSize: 12.5, position: 'sticky' as const, top: 0, background: 'var(--panel)', zIndex: 1, borderBottom: rule };
  const providerName = PROVIDERS.find((entry) => entry.id === provider)?.name ?? '';

  return (
    <section style={{ marginTop: 40, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16 }} aria-label="AI credits">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>AI credits</h2>
        <span style={muted}>
          {dollars(aiCost(report.totals))} across Claude and DeepSeek · {report.since} to {report.until}
        </span>
      </div>

      {/* 1 — each provider at a glance; the one pressed is the one charted below. */}
      <div role="group" aria-label="Provider" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: 12 }}>
        {PROVIDERS.map(({ id, name }) => (
          <ProviderSummary
            key={id}
            name={name}
            totals={report.totals}
            provider={id}
            active={provider === id}
            onPick={() => setProvider(id)}
            account={id === 'deepseek' ? account : null}
          />
        ))}
      </div>

      {/* 2 — who used it. */}
      <div style={card}>
        <div style={cardHead}>
          <h3 style={cardTitle}>People</h3>
          <span style={muted}>
            {shown.length === people.length ? `${people.length}` : `${shown.length} of ${people.length}`}
          </span>
          <span style={{ flexGrow: 1 }} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by email…"
            aria-label="Search by email"
            style={{
              width: 260,
              maxWidth: '100%',
              boxSizing: 'border-box',
              padding: '6px 10px',
              fontSize: 13,
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--paper)',
              color: 'var(--ink)',
            }}
          />
        </div>
        <div style={{ maxHeight: ROW_HEIGHT * (ROWS_IN_VIEW + 1) + 1, overflow: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 13.5, width: '100%' }}>
            <thead>
              <tr style={{ color: 'var(--muted)' }}>
                <th style={{ ...head, textAlign: 'left' }}>Who</th>
                {PROVIDERS.map(({ id, name }) => (
                  <th key={id} style={head} title={`${name}: requests · cost`}>
                    {name}
                  </th>
                ))}
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
                      title={active ? 'Chart everyone again' : 'Chart only them'}
                      style={{ cursor: 'pointer', borderBottom: rule, background: active ? 'var(--accent-soft)' : undefined }}
                    >
                      <td style={{ ...cell, textAlign: 'left', fontWeight: active ? 600 : undefined }}>{person.email}</td>
                      {PROVIDERS.map(({ id }) => {
                        const requests = get(person.total, id);
                        return (
                          <td
                            key={id}
                            style={cell}
                            title={`${tokens(get(person.total, `${id}_in`) + get(person.total, `${id}_out`))} tokens`}
                          >
                            {requests ? (
                              <>
                                <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>{requests} req · </span>
                                {dollars(get(person.total, `${id}_cost`))}
                              </>
                            ) : (
                              <span style={{ color: 'var(--muted)' }}>—</span>
                            )}
                          </td>
                        );
                      })}
                      <td style={{ ...cell, fontWeight: 600 }}>{dollars(aiCost(person.total))}</td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={2 + PROVIDERS.length} style={{ ...cell, textAlign: 'left', color: 'var(--muted)' }}>
                    No email matches “{query}”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 3 — one chart: the provider picked above, the measure picked here. */}
      <div style={card}>
        <div style={cardHead}>
          <h3 style={cardTitle}>{providerName} per day</h3>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12.5,
              padding: '2px 10px',
              borderRadius: 999,
              background: picked ? 'var(--accent-soft)' : 'var(--panel)',
              border: '1px solid var(--border)',
            }}
          >
            {picked ?? 'Everyone'}
            {picked ? (
              <button
                type="button"
                onClick={() => setPicked(null)}
                aria-label="Chart everyone"
                style={{ border: 0, background: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 0, fontSize: 14, lineHeight: 1 }}
              >
                ×
              </button>
            ) : null}
          </span>
          <span style={{ flexGrow: 1 }} />
          <div className="segmented" role="group" aria-label="Measure">
            {metrics.map((entry) => (
              <button key={entry.id} type="button" aria-pressed={shownMetric === entry.id} onClick={() => setMetric(entry.id)}>
                {entry.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ padding: '14px 16px 12px' }}>
          <TrendChart provider={provider} metric={shownMetric} days={days} byDay={byDay} account={account} picked={picked} />
        </div>
      </div>
    </section>
  );
}

/** One provider's period in a few numbers — and the button that charts it. */
function ProviderSummary({
  name,
  provider,
  totals,
  active,
  onPick,
  account,
}: {
  name: string;
  provider: Provider;
  totals: object;
  active: boolean;
  onPick: () => void;
  account: DeepSeekAccount | null;
}) {
  const cost = get(totals, `${provider}_cost`);
  const requests = get(totals, provider);
  const used = get(totals, `${provider}_in`) + get(totals, `${provider}_out`);
  const balance = account?.configured ? account.balance : null;
  const stat = (label: string, value: string) => (
    <div>
      <div style={{ ...muted, fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{value}</div>
    </div>
  );
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={active}
      title={`Chart ${name}`}
      style={{
        ...card,
        textAlign: 'left',
        color: 'var(--ink)',
        font: 'inherit',
        cursor: 'pointer',
        padding: '14px 16px',
        borderColor: active ? 'var(--accent)' : 'var(--border)',
        boxShadow: active ? '0 0 0 1px var(--accent)' : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{name}</span>
        <span style={{ flexGrow: 1 }} />
        {active ? <span style={{ ...muted, fontSize: 11.5 }}>charted below</span> : null}
      </div>
      <div style={{ fontSize: 28, fontWeight: 500, margin: '6px 0 10px', fontVariantNumeric: 'tabular-nums' }}>
        {dollars(cost)}
        <span style={{ ...muted, fontSize: 12.5, marginLeft: 6 }}>this period</span>
      </div>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        {stat('Requests', requests.toLocaleString('en-US'))}
        {stat('Tokens', compact(used))}
        {balance ? stat('Balance', dollars(balance.total)) : null}
      </div>
      {provider === 'deepseek' && account && !account.configured ? (
        <div style={{ ...muted, fontSize: 11.5, marginTop: 10 }}>
          Your account’s balance shows here with <code>DEEPSEEK_KEY</code> set on the Worker.
        </div>
      ) : null}
      {provider === 'deepseek' && account?.error ? (
        <div style={{ fontSize: 11.5, marginTop: 10, color: 'var(--danger)' }}>DeepSeek did not answer: {account.error}</div>
      ) : null}
      {balance && !balance.available ? (
        <div style={{ fontSize: 11.5, marginTop: 10, color: 'var(--danger)' }}>DeepSeek says this balance cannot pay for requests.</div>
      ) : null}
    </button>
  );
}

/** The chart for one provider and one measure, with a line under it saying what it counts. */
function TrendChart({
  provider,
  metric,
  days,
  byDay,
  account,
  picked,
}: {
  provider: Provider;
  metric: Metric;
  days: string[];
  byDay: Record<string, number>[];
  account: DeepSeekAccount | null;
  picked: string | null;
}) {
  const series = (key: string) => byDay.map((counts) => num(counts[`${provider}${key}`]));
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const note = { ...muted, fontSize: 12, margin: '10px 0 0', lineHeight: 1.6 } as const;

  if (metric === 'balance') {
    const byDate = new Map((account?.days || []).map((row) => [row.day, row.spent]));
    const spent = days.map((day) => byDate.get(day) || 0);
    return (
      <>
        <BarChart
          title={`Spent from your DeepSeek balance ${dollars(sum(spent))}`}
          days={days}
          series={[{ label: 'Spent', color: 'var(--viz-2)', values: spent }]}
          format={dollars}
          axis={(value) => dollars(value).replace(/\.?0+$/, '')}
          height={240}
        />
        <p style={note}>
          The fall in your account’s balance between checks, hourly and while this page is open.
          {picked ? ` This is the whole account, not only ${picked}.` : ''} A top-up between two checks hides that much spending.
        </p>
      </>
    );
  }
  if (metric === 'tokens') {
    const input = series('_in');
    const output = series('_out');
    return (
      <BarChart
        title={`Tokens ${tokens(sum(input) + sum(output))}`}
        days={days}
        series={[
          { label: 'Input', color: 'var(--viz-1)', values: input },
          { label: 'Output', color: 'var(--viz-2)', values: output },
        ]}
        format={tokens}
        axis={compact}
        height={240}
      />
    );
  }
  if (metric === 'requests') {
    const requests = series('');
    return (
      <BarChart
        title={`Requests ${sum(requests).toLocaleString('en-US')}`}
        days={days}
        series={[{ label: 'Requests', color: 'var(--viz-1)', values: requests }]}
        format={(value) => value.toLocaleString('en-US')}
        axis={compact}
        height={240}
      />
    );
  }
  const cost = series('_cost');
  return (
    <>
      <BarChart
        title={`Cost ${dollars(sum(cost))}`}
        days={days}
        series={[{ label: 'Cost', color: 'var(--viz-1)', values: cost }]}
        format={dollars}
        axis={(value) => dollars(value).replace(/\.?0+$/, '')}
        height={240}
      />
      <p style={note}>Worked out from each answer’s tokens at list price; the provider’s own console is the bill.</p>
    </>
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
