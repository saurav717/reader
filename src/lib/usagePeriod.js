/**
 * The period the AI credits on the Usage page cover — their own, apart from
 * the page's: the page's period, a few days up to now, this or last month,
 * or two days picked, the second of which may be "now". Days are UTC, as the
 * Worker tallies them (worker/usage.js), and go back no further than the
 * ninety it keeps.
 */
export const PERIOD_PRESETS = [
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
export const dayOf = (at) => new Date(at).toISOString().slice(0, 10);
/** `day` moved by `by` days. */
export const addDays = (day, by) => dayOf(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS);
/** How many days from `since` to `until`, both counted. */
export const daysSpanned = (since, until) => Math.max(0, Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / DAY_MS) + 1);
const isDay = (value) => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)));
/**
 * The days `period` covers, given the page's own `pageDays` and `today`.
 * Kept within the days the tally has, and the right way round.
 */
export function resolvePeriod(period, pageDays, today) {
    const earliest = addDays(today, -(KEEP_DAYS - 1));
    const last = (count) => ({ since: addDays(today, -(count - 1)), until: today, live: true });
    let range;
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
    if (range.until > today)
        range = { ...range, until: today };
    if (range.since < earliest)
        range = { ...range, since: earliest };
    if (range.until < range.since)
        range = { ...range, until: range.since };
    // Any period that runs to today runs up to now: today's counts are as of the last refresh.
    return { ...range, live: range.until === today };
}
const num = (value) => Number(value) || 0;
function addModels(into, from) {
    for (const [id, counts] of Object.entries(from || {})) {
        const row = into[id] || (into[id] = { n: 0, in: 0, out: 0, cost: 0 });
        row.n += num(counts.n);
        row.in += num(counts.in);
        row.out += num(counts.out);
        row.cost += num(counts.cost);
    }
    return into;
}
function addCounts(into, from) {
    for (const [key, value] of Object.entries(from)) {
        if (key === 'day' || key === 'models')
            continue;
        into[key] = (into[key] || 0) + num(value);
    }
    return into;
}
/**
 * The part of `report` from `since` to `until`: each person's days in it,
 * their totals and models summed again from those days, and nobody who used
 * nothing in it. The report asked for must reach back to `since`.
 */
export function sliceReport(report, since, until) {
    const people = [];
    for (const person of report.people) {
        const daily = (person.daily || []).filter((row) => row.day >= since && row.day <= until);
        if (!daily.length)
            continue;
        const total = {};
        const models = {};
        for (const row of daily) {
            addCounts(total, row);
            addModels(models, row.models);
        }
        people.push({ ...person, daily, total, models, days: daily.length });
    }
    const totals = people.reduce((sum, person) => addCounts(sum, person.total), {});
    const models = people.reduce((sum, person) => addModels(sum, person.models), {});
    return { ...report, since, until, people, totals, models };
}
