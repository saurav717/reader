/**
 * The period the AI credits on the Usage page cover — their own, apart from
 * the page's: the page's period, a few days up to now, this or last month,
 * or two days picked, the second of which may be "now". Days are UTC, as the
 * Worker tallies them (worker/usage.js), and go back no further than the
 * ninety it keeps.
 */

export type PeriodPreset = 'page' | '1' | '7' | '30' | '90' | 'month' | 'last-month' | 'custom';

/** A picked period. `from` and `to` are read only for 'custom'; `to` null means up to now. */
export interface AiPeriod {
  preset: PeriodPreset;
  from: string;
  to: string | null;
}

export const PERIOD_PRESETS: { id: PeriodPreset; label: string }[] = [
  { id: 'page', label: 'Same as page' },
  { id: '1', label: 'Today' },
  { id: '7', label: 'Last 7 days' },
  { id: '30', label: 'Last 30 days' },
  { id: '90', label: 'Last 90 days' },
  { id: 'month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: 'custom', label: 'Custom…' },
];

/** How far back the tally goes. */
export const KEEP_DAYS = 90;

const DAY_MS = 86_400_000;

/** The day of `at`, YYYY-MM-DD, in UTC. */
export const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

/** `day` moved by `by` days. */
export const addDays = (day: string, by: number) => dayOf(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS);

/** How many days from `since` to `until`, both counted. */
export const daysSpanned = (since: string, until: string) =>
  Math.max(0, Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / DAY_MS) + 1);

const isDay = (value: string | null | undefined): value is string => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)));

/** The days a period covers: `since` to `until`, inclusive; `live` when it runs up to now (to today). */
export interface Range {
  since: string;
  until: string;
  live: boolean;
}

/**
 * The days `period` covers, given the page's own `pageDays` and `today`.
 * Kept within the days the tally has, and the right way round.
 */
export function resolvePeriod(period: AiPeriod, pageDays: number, today: string): Range {
  const earliest = addDays(today, -(KEEP_DAYS - 1));
  const last = (count: number) => ({ since: addDays(today, -(count - 1)), until: today, live: true });
  let range: Range;
  switch (period.preset) {
    case 'page':
      range = last(pageDays);
      break;
    case '1':
    case '7':
    case '30':
    case '90':
      range = last(Number(period.preset));
      break;
    case 'month':
      range = { since: `${today.slice(0, 7)}-01`, until: today, live: true };
      break;
    case 'last-month': {
      const end = addDays(`${today.slice(0, 7)}-01`, -1);
      range = { since: `${end.slice(0, 7)}-01`, until: end, live: false };
      break;
    }
    default: {
      const from = isDay(period.from) ? period.from : addDays(today, -29);
      const to = period.to === null || !isDay(period.to) ? today : period.to;
      range = from <= to ? { since: from, until: to, live: false } : { since: to, until: from, live: false };
    }
  }
  if (range.until > today) range = { ...range, until: today };
  if (range.since < earliest) range = { ...range, since: earliest };
  if (range.until < range.since) range = { ...range, until: range.since };
  // Any period that runs to today runs up to now: today's counts are as of the last refresh.
  return { ...range, live: range.until === today };
}

/** One model's counts: answers, tokens in and out, cost in millionths of a dollar. */
interface ModelCounts {
  n: number;
  in: number;
  out: number;
  cost: number;
}
type ByModel = Record<string, ModelCounts>;

interface DayRow {
  day: string;
  models?: ByModel;
}

interface PersonLike {
  total: object;
  daily?: DayRow[];
  days: number;
  models?: ByModel;
}

interface ReportLike {
  since: string;
  until: string;
  people: PersonLike[];
  totals: object;
  models?: ByModel;
}

const num = (value: unknown) => Number(value) || 0;

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

function addCounts(into: Record<string, number>, from: object) {
  for (const [key, value] of Object.entries(from)) {
    if (key === 'day' || key === 'models') continue;
    into[key] = (into[key] || 0) + num(value);
  }
  return into;
}

/**
 * The part of `report` from `since` to `until`: each person's days in it,
 * their totals and models summed again from those days, and nobody who used
 * nothing in it. The report asked for must reach back to `since`.
 */
export function sliceReport<R extends ReportLike>(report: R, since: string, until: string): R {
  const people: R['people'] = [];
  for (const person of report.people) {
    const daily = (person.daily || []).filter((row) => row.day >= since && row.day <= until);
    if (!daily.length) continue;
    const total: Record<string, number> = {};
    const models: ByModel = {};
    for (const row of daily) {
      addCounts(total, row);
      addModels(models, row.models);
    }
    people.push({ ...person, daily, total, models, days: daily.length });
  }
  const totals = people.reduce<Record<string, number>>((sum, person) => addCounts(sum, person.total), {});
  const models = people.reduce<ByModel>((sum, person) => addModels(sum, person.models), {});
  return { ...report, since, until, people, totals, models };
}
