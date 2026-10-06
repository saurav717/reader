import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import { MODELS } from '../lib/assistant';
import type { ByModel, UsageReport } from './UsageView';
import { KEEP_DAYS, PERIOD_PRESETS, addDays, dayOf, daysSpanned } from '../lib/usagePeriod';
import type { AiPeriod, PeriodPreset, Range } from '../lib/usagePeriod';

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

type Provider = 'claude' | 'deepseek' | 'gemini';
type Person = UsageReport['people'][number];

/** Which provider each model the tally keeps apart belongs to (worker/usage.js MODELS). */
const MODEL_PROVIDER: Record<string, Provider> = {
  'claude-opus-5': 'claude',
  'claude-sonnet-5': 'claude',
  'claude-haiku-4-5': 'claude',
  'claude-other': 'claude',
  'deepseek-flash': 'deepseek',
  'deepseek-flash-fast': 'deepseek',
  'deepseek-other': 'deepseek',
  'gemini-3.1-pro-preview': 'gemini',
  'gemini-3.8-flash': 'gemini',
  'gemini-3.5-flash-lite': 'gemini',
  'gemini-other': 'gemini',
};

/** A model's name as the model picker shows it. */
export function modelLabel(id: string): string {
  if (id.endsWith('-other')) return 'Other models';
  return MODELS.find((model) => model.id === id)?.label ?? id;
}

const providerOf = (id: string): Provider | null =>
  MODEL_PROVIDER[id] ?? (id.startsWith('claude') ? 'claude' : id.startsWith('deepseek') ? 'deepseek' : id.startsWith('gemini') ? 'gemini' : null);

/** Sum per-model counts into `into`. */
function addModels(into: ByModel, from: ByModel | undefined): ByModel {
  for (const [id, counts] of Object.entries(from || {})) {
    const row = into[id] || (into[id] = { n: 0, in: 0, out: 0, cost: 0 });
    row.n += num(counts.n);
    row.in += num(counts.in);
    row.out += num(counts.out);
    row.cost += num(counts.cost);
  }
  return into;
}

const PROVIDERS: { id: Provider; name: string }[] = [
  { id: 'claude', name: 'Claude' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'gemini', name: 'Gemini' },
];

/** Rows the box shows before it scrolls. */
export const ROWS_IN_VIEW = 12;
export const ROW_HEIGHT = 37;

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
export function daysBetween(since: string, until: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${until}T00:00:00Z`);
  for (let at = Date.parse(`${since}T00:00:00Z`); at <= end && out.length < 400; at += 86_400_000) {
    out.push(new Date(at).toISOString().slice(0, 10));
  }
  return out;
}

const shortDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

type Metric = 'cost' | 'requests' | 'tokens' | 'balance';

/** What the AI people list can be sorted on. */
const AI_SORTS: SortOption<Person>[] = [
  { id: 'total', label: 'Total cost', value: (person) => aiCost(person.total) },
  ...PROVIDERS.flatMap(({ id, name }) => [
    { id: `${id}_cost`, label: `${name} cost`, value: (person: Person) => get(person.total, `${id}_cost`) },
    { id, label: `${name} requests`, value: (person: Person) => get(person.total, id) },
    {
      id: `${id}_tokens`,
      label: `${name} tokens`,
      value: (person: Person) => get(person.total, `${id}_in`) + get(person.total, `${id}_out`),
    },
  ]),
  { id: 'last', label: 'Last seen', value: (person) => person.last || 0 },
  { id: 'email', label: 'Email', value: (person) => person.email },
];

const METRICS: { id: Metric; label: string }[] = [
  { id: 'cost', label: 'Cost' },
  { id: 'requests', label: 'Requests' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'balance', label: 'From balance' },
];

export const card = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 12,
} as const;

export const cardHead = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
  padding: '12px 16px',
  borderBottom: '1px solid var(--border-soft)',
} as const;

export const cardTitle = { fontSize: 14, fontWeight: 600, margin: 0 } as const;
export const muted = { fontSize: 12.5, color: 'var(--muted)' } as const;

/**
 * Laid out in three parts, top to bottom: each provider at a glance (which
 * also picks the provider the chart shows), who used it, and one chart of the
 * picked provider's days — cost, requests or tokens, switched in its header —
 * for everyone or the one person clicked in the table.
 */
export default function AiUsage({
  report,
  period,
  range,
  onPeriod,
}: {
  report: UsageReport;
  period: AiPeriod;
  range: Range;
  onPeriod: (period: AiPeriod) => void;
}) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [provider, setProvider] = useState<Provider>('claude');
  const [metric, setMetric] = useState<Metric>('cost');
  // One model of the charted provider, or all of them.
  const [model, setModel] = useState<string | null>(null);
  const pickProvider = (id: Provider) => {
    setProvider(id);
    setModel(null);
  };

  const sorting = useSort(AI_SORTS, { by: 'total', dir: 'desc' });
  const people = report.people;
  const needle = query.trim().toLowerCase();
  const shown = sorting.sort(needle ? people.filter((person) => person.email.toLowerCase().includes(needle)) : people);

  // Someone picked who has since dropped out of the period shows everyone again.
  useEffect(() => {
    if (picked && !report.people.some((person) => person.email === picked)) setPicked(null);
  }, [picked, report.people]);

  const days = useMemo(() => daysBetween(report.since, report.until), [report.since, report.until]);
  // DeepSeek's balance is asked for back from today, so far enough to reach
  // the period's first day, even when the period ends before today. Asked
  // again as the report refreshes, at most once a minute.
  const account = useDeepSeekAccount(
    Math.min(KEEP_DAYS, daysSpanned(report.since, dayOf(Date.now()))),
    `${report.until}:${report.people.length}:${aiCost(report.totals)}`,
  );

  // "From balance" is DeepSeek's alone, and only with its key set.
  const hasBalance = provider === 'deepseek' && Boolean(account?.configured);
  const metrics = METRICS.filter((entry) => entry.id !== 'balance' || hasBalance);
  const shownMetric: Metric = metrics.some((entry) => entry.id === metric) ? metric : 'cost';

  /**
   * Each day's counts, summed over everyone, or the one picked — and, with a
   * model picked, that model's alone, in the provider's own keys, so the
   * chart reads them the same way.
   */
  const byDay = useMemo(() => {
    const sums = new Map<string, Record<string, number>>(days.map((day) => [day, {}]));
    for (const person of report.people) {
      if (picked && person.email !== picked) continue;
      for (const day of person.daily || []) {
        const into = sums.get(day.day);
        if (!into) continue;
        if (model) {
          const counts = day.models?.[model];
          if (!counts) continue;
          into[provider] = (into[provider] || 0) + num(counts.n);
          into[`${provider}_in`] = (into[`${provider}_in`] || 0) + num(counts.in);
          into[`${provider}_out`] = (into[`${provider}_out`] || 0) + num(counts.out);
          into[`${provider}_cost`] = (into[`${provider}_cost`] || 0) + num(counts.cost);
          continue;
        }
        for (const [key, value] of Object.entries(day)) if (key !== 'day' && key !== 'models') into[key] = (into[key] || 0) + num(value);
      }
    }
    return days.map((day) => sums.get(day) || {});
  }, [days, report.people, picked, model, provider]);

  /** The charted provider's models, for everyone or the one picked, most spent first. */
  const models = useMemo(() => {
    const summed: ByModel = picked
      ? addModels({}, report.people.find((person) => person.email === picked)?.models)
      : report.models ?? report.people.reduce<ByModel>((sum, person) => addModels(sum, person.models), {});
    return Object.entries(summed)
      .filter(([id]) => providerOf(id) === provider)
      .sort(([, a], [, b]) => b.cost - a.cost || b.n - a.n);
  }, [report, picked, provider]);

  const cell = { padding: '0 14px', height: ROW_HEIGHT, textAlign: 'right' as const, whiteSpace: 'nowrap' as const };
  const rule = '1px solid var(--border-soft)';
  const head = { ...cell, fontWeight: 500, fontSize: 12.5, position: 'sticky' as const, top: 0, background: 'var(--panel)', zIndex: 1, borderBottom: rule };
  const providerName = PROVIDERS.find((entry) => entry.id === provider)?.name ?? '';

  return (
    <section style={{ marginTop: 40, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16 }} aria-label="AI credits">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>AI credits</h2>
        <span style={muted}>
          {dollars(aiCost(report.totals))} across Claude, DeepSeek and Gemini · {range.since} to{' '}
          {range.live ? <span title={`Through ${range.until} (UTC), as of the last refresh`}>now</span> : range.until}
        </span>
        <span style={{ flexGrow: 1 }} />
        <PeriodPicker period={period} range={range} onPeriod={onPeriod} />
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
            onPick={() => pickProvider(id)}
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
          <SortControl options={AI_SORTS} by={sorting.by} dir={sorting.dir} onPick={sorting.pick} onDir={sorting.setDir} />
          <SearchBox value={query} onChange={setQuery} />
        </div>
        <div style={{ maxHeight: ROW_HEIGHT * (ROWS_IN_VIEW + 1) + 1, overflow: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 13.5, width: '100%' }}>
            <thead>
              <tr style={{ color: 'var(--muted)' }}>
                <SortHeading id="email" label="Who" by={sorting.by} dir={sorting.dir} onPick={sorting.pick} style={{ ...head, textAlign: 'left' }} />
                {PROVIDERS.map(({ id, name }) => (
                  <SortHeading
                    key={id}
                    id={`${id}_cost`}
                    label={name}
                    by={sorting.by}
                    dir={sorting.dir}
                    onPick={sorting.pick}
                    style={head}
                    title={`${name}: requests · cost — sorts by cost`}
                  />
                ))}
                <SortHeading id="total" label="Total" by={sorting.by} dir={sorting.dir} onPick={sorting.pick} style={head} />
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
                    {people.length ? `No email matches “${query}”.` : 'Nobody used Ask AI or Explain in this period.'}
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
          <h3 style={cardTitle}>{providerName} usage</h3>
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
        <div className="ai-usage-split">
          <ModelList
            models={models}
            total={get(picked ? report.people.find((person) => person.email === picked)?.total : report.totals, `${provider}_cost`)}
            requests={get(picked ? report.people.find((person) => person.email === picked)?.total : report.totals, provider)}
            picked={model}
            onPick={setModel}
          />
          <div style={{ padding: '14px 16px 12px', minWidth: 0 }}>
            <TrendChart
              provider={provider}
              metric={shownMetric}
              days={days}
              byDay={byDay}
              account={account}
              picked={picked}
              model={shownMetric === 'balance' ? null : model}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The AI credits' own period: a few ready ones, or two days picked — the
 * second of which is "Now" until a day is picked for it. The days are UTC and
 * go back no further than the tally keeps.
 */
function PeriodPicker({ period, range, onPeriod }: { period: AiPeriod; range: Range; onPeriod: (period: AiPeriod) => void }) {
  const today = dayOf(Date.now());
  const earliest = addDays(today, -(KEEP_DAYS - 1));
  const box = {
    fontSize: 13,
    height: 30,
    boxSizing: 'border-box' as const,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--paper)',
    color: 'var(--ink)',
    padding: '0 8px',
  };
  // Custom starts from the days shown, so switching to it changes nothing yet.
  const pick = (preset: PeriodPreset) =>
    onPeriod(preset === 'custom' ? { preset, from: range.since, to: range.live ? null : range.until } : { ...period, preset });
  const now = period.to === null;
  return (
    <span role="group" aria-label="AI credits period" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <select value={period.preset} onChange={(event) => pick(event.target.value as PeriodPreset)} aria-label="Period" style={box}>
        {PERIOD_PRESETS.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
          </option>
        ))}
      </select>
      {period.preset === 'custom' ? (
        <>
          <input
            type="date"
            value={range.since}
            min={earliest}
            max={now ? today : period.to ?? today}
            onChange={(event) => event.target.value && onPeriod({ ...period, from: event.target.value })}
            aria-label="From"
            style={box}
          />
          <span style={muted}>to</span>
          <div className="segmented" role="group" aria-label="Up to">
            <button type="button" aria-pressed={now} onClick={() => onPeriod({ ...period, to: null })} title="Up to now, refreshed as it goes">
              Now
            </button>
            <button
              type="button"
              aria-pressed={!now}
              onClick={() => onPeriod({ ...period, to: now ? today : period.to })}
              title="Up to a day of your choosing"
            >
              Date
            </button>
          </div>
          {!now ? (
            <input
              type="date"
              value={range.until}
              min={range.since}
              max={today}
              onChange={(event) => event.target.value && onPeriod({ ...period, to: event.target.value })}
              aria-label="To"
              style={box}
            />
          ) : null}
        </>
      ) : null}
    </span>
  );
}

export type SortDir = 'asc' | 'desc';

/** One way a list can be sorted: what it is called and the value each row is sorted on. */
export interface SortOption<T> {
  id: string;
  label: string;
  value: (row: T) => number | string;
}

/**
 * A list's sort: which option, which way, and the rows in that order. Picking
 * a new option starts it the way it reads best — names A to Z, numbers
 * largest first; picking the same one again turns it round. Ties fall back to
 * the email, A to Z, so the order never jumps about between refreshes.
 */
export function useSort<T extends { email: string }>(options: SortOption<T>[], initial: { by: string; dir: SortDir }) {
  const [by, setBy] = useState(initial.by);
  const [dir, setDir] = useState<SortDir>(initial.dir);
  const option = options.find((entry) => entry.id === by) ?? options[0];
  const pick = (id: string) => {
    if (id === option.id) {
      setDir((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    const next = options.find((entry) => entry.id === id) ?? options[0];
    setBy(next.id);
    setDir(next.id === 'email' ? 'asc' : 'desc');
  };
  const sort = (rows: T[]) =>
    [...rows].sort((a, b) => {
      const x = option.value(a);
      const y = option.value(b);
      const order = typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y)) : x - y;
      return (dir === 'asc' ? order : -order) || a.email.localeCompare(b.email);
    });
  return { by: option.id, dir, pick, setDir, sort };
}

/** "Sort by" and which way, for a list card's header. */
export function SortControl<T>({
  options,
  by,
  dir,
  onPick,
  onDir,
}: {
  options: SortOption<T>[];
  by: string;
  dir: SortDir;
  onPick: (id: string) => void;
  onDir: (dir: SortDir) => void;
}) {
  const box = {
    fontSize: 13,
    border: '1px solid var(--border)',
    background: 'var(--paper)',
    color: 'var(--ink)',
    height: 30,
    boxSizing: 'border-box' as const,
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <label style={{ ...muted, whiteSpace: 'nowrap' }}>
        Sort by
      </label>
      <select
        value={by}
        onChange={(event) => onPick(event.target.value)}
        aria-label="Sort by"
        style={{ ...box, borderRadius: 8, padding: '0 8px' }}
      >
        {options.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onDir(dir === 'asc' ? 'desc' : 'asc')}
        aria-label={dir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
        title={dir === 'asc' ? 'Ascending' : 'Descending'}
        style={{ ...box, borderRadius: 8, width: 30, cursor: 'pointer', padding: 0, fontSize: 14 }}
      >
        {dir === 'asc' ? '↑' : '↓'}
      </button>
    </span>
  );
}

/**
 * A column heading that sorts its list: clicking it sorts on it, clicking it
 * again turns the order round, and the one sorted on shows which way.
 */
export function SortHeading({
  id,
  label,
  by,
  dir,
  onPick,
  style,
  title,
}: {
  id: string;
  label: string;
  by: string;
  dir: SortDir;
  onPick: (id: string) => void;
  style: React.CSSProperties;
  title?: string;
}) {
  const active = by === id;
  return (
    <th style={style} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'} title={title}>
      <button
        type="button"
        onClick={() => onPick(id)}
        style={{
          border: 0,
          background: 'none',
          padding: 0,
          font: 'inherit',
          color: active ? 'var(--ink)' : 'inherit',
          fontWeight: active ? 600 : 'inherit',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
        <span style={{ display: 'inline-block', width: 12, textAlign: 'center', opacity: active ? 1 : 0 }}>{dir === 'asc' ? '↑' : '↓'}</span>
      </button>
    </th>
  );
}

/** The search box in a list card's header: filters its rows by email. */
export function SearchBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <input
      type="search"
      value={value}
      onChange={(event) => onChange(event.target.value)}
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

/**
 * The charted provider's models: each one's share of the spend, its cost,
 * requests and tokens. "All models" first; clicking a model narrows the
 * chart beside it to that model, clicking it again widens it back.
 */
function ModelList({
  models,
  total,
  requests,
  picked,
  onPick,
}: {
  models: [string, { n: number; in: number; out: number; cost: number }][];
  total: number;
  requests: number;
  picked: string | null;
  onPick: (id: string | null) => void;
}) {
  const counted = models.reduce((sum, [, counts]) => sum + counts.cost, 0);
  const row = (active: boolean) =>
    ({
      display: 'grid',
      gridTemplateColumns: '1fr auto',
      gap: '4px 12px',
      width: '100%',
      textAlign: 'left',
      font: 'inherit',
      color: 'var(--ink)',
      padding: '10px 12px',
      border: 0,
      borderRadius: 8,
      background: active ? 'var(--accent-soft)' : 'transparent',
      cursor: 'pointer',
    }) as const;
  return (
    <div className="ai-usage-models" role="group" aria-label="Models">
      <div style={{ ...muted, fontSize: 12, padding: '0 12px 6px' }}>By model</div>
      <button type="button" aria-pressed={!picked} onClick={() => onPick(null)} style={row(!picked)}>
        <span style={{ fontWeight: 600, fontSize: 13.5 }}>All models</span>
        <span style={{ fontWeight: 600, fontSize: 13.5, fontVariantNumeric: 'tabular-nums' }}>{dollars(total)}</span>
        <span style={{ ...muted, fontSize: 12, gridColumn: '1 / -1' }}>{requests.toLocaleString('en-US')} requests</span>
      </button>
      {models.length ? (
        models.map(([id, counts]) => {
          const active = picked === id;
          const share = counted ? counts.cost / counted : 0;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              onClick={() => onPick(active ? null : id)}
              title={active ? 'Chart all models' : `Chart only ${modelLabel(id)}`}
              style={row(active)}
            >
              <span style={{ fontSize: 13.5, fontWeight: active ? 600 : 500 }}>{modelLabel(id)}</span>
              <span style={{ fontSize: 13.5, fontVariantNumeric: 'tabular-nums' }}>
                {dollars(counts.cost)}
                <span style={{ ...muted, fontSize: 12, marginLeft: 6, display: 'inline-block', minWidth: 34, textAlign: 'right' }}>
                  {Math.round(share * 100)}%
                </span>
              </span>
              <span style={{ gridColumn: '1 / -1', height: 6, borderRadius: 3, background: 'var(--border-soft)', overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: `${share * 100}%`, background: 'var(--viz-1)', borderRadius: 3 }} />
              </span>
              <span style={{ ...muted, fontSize: 12, gridColumn: '1 / -1', fontVariantNumeric: 'tabular-nums' }}>
                {counts.n.toLocaleString('en-US')} req · {compact(counts.in)} in · {compact(counts.out)} out
              </span>
            </button>
          );
        })
      ) : (
        <p style={{ ...muted, fontSize: 12, margin: '8px 12px', lineHeight: 1.6 }}>
          No answers split by model yet — they are counted per model from the Worker redeploy on.
        </p>
      )}
    </div>
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
  model,
}: {
  provider: Provider;
  metric: Metric;
  days: string[];
  byDay: Record<string, number>[];
  account: DeepSeekAccount | null;
  picked: string | null;
  model: string | null;
}) {
  const of = model ? ` · ${modelLabel(model)}` : '';
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
        title={`Tokens${of} ${tokens(sum(input) + sum(output))}`}
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
        title={`Requests${of} ${sum(requests).toLocaleString('en-US')}`}
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
        title={`Cost${of} ${dollars(sum(cost))}`}
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
export function BarChart({
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
