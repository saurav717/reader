import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { ownerFetch } from '../lib/owner';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MODELS } from '../lib/assistant';
import { KEEP_DAYS, PERIOD_PRESETS, addDays, dayOf, daysSpanned } from '../lib/usagePeriod';
/** How long a balance is good for before the page asks DeepSeek again. */
const BALANCE_MS = 60_000;
function useDeepSeekAccount(days, refreshedAt) {
    const [account, setAccount] = useState(null);
    const asked = useRef({ at: 0, days: 0 });
    useEffect(() => {
        if (asked.current.days === days && Date.now() - asked.current.at < BALANCE_MS)
            return;
        asked.current = { at: Date.now(), days };
        let cancelled = false;
        ownerFetch(`/usage/deepseek?days=${days}`)
            .then((response) => (response.ok ? response.json() : null))
            .then((answer) => !cancelled && answer && setAccount(answer))
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [days, refreshedAt]);
    return account;
}
/** Which provider each model the tally keeps apart belongs to (worker/usage.js MODELS). */
const MODEL_PROVIDER = {
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
export function modelLabel(id) {
    if (id.endsWith('-other'))
        return 'Other models';
    return MODELS.find((model) => model.id === id)?.label ?? id;
}
const providerOf = (id) => MODEL_PROVIDER[id] ?? (id.startsWith('claude') ? 'claude' : id.startsWith('deepseek') ? 'deepseek' : id.startsWith('gemini') ? 'gemini' : null);
/** Sum per-model counts into `into`. */
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
const PROVIDERS = [
    { id: 'claude', name: 'Claude' },
    { id: 'deepseek', name: 'DeepSeek' },
    { id: 'gemini', name: 'Gemini' },
];
/** Rows the box shows before it scrolls. */
export const ROWS_IN_VIEW = 12;
export const ROW_HEIGHT = 37;
const num = (value) => Number(value) || 0;
const get = (counts, key) => num(counts?.[key]);
/** Millionths of a dollar, as money: to the cent, or finer when there are no cents yet. */
export function dollars(micro) {
    const value = micro / 1_000_000;
    if (!value)
        return '$0.00';
    if (value < 0.01)
        return `$${value.toFixed(4)}`;
    return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
const tokens = (value) => value.toLocaleString('en-US');
const compact = (value) => value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${+(value / 1000).toFixed(1)}K` : String(Math.round(value * 100) / 100);
const aiCost = (counts) => PROVIDERS.reduce((sum, { id }) => sum + get(counts, `${id}_cost`), 0);
/** Every day from `since` to `until`, inclusive, as YYYY-MM-DD (UTC). */
export function daysBetween(since, until) {
    const out = [];
    const end = Date.parse(`${until}T00:00:00Z`);
    for (let at = Date.parse(`${since}T00:00:00Z`); at <= end && out.length < 400; at += 86_400_000) {
        out.push(new Date(at).toISOString().slice(0, 10));
    }
    return out;
}
const shortDay = (day) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
/** What the AI people list can be sorted on. */
const AI_SORTS = [
    { id: 'total', label: 'Total cost', value: (person) => aiCost(person.total) },
    ...PROVIDERS.flatMap(({ id, name }) => [
        { id: `${id}_cost`, label: `${name} cost`, value: (person) => get(person.total, `${id}_cost`) },
        { id, label: `${name} requests`, value: (person) => get(person.total, id) },
        {
            id: `${id}_tokens`,
            label: `${name} tokens`,
            value: (person) => get(person.total, `${id}_in`) + get(person.total, `${id}_out`),
        },
    ]),
    { id: 'last', label: 'Last seen', value: (person) => person.last || 0 },
    { id: 'email', label: 'Email', value: (person) => person.email },
];
const METRICS = [
    { id: 'cost', label: 'Cost' },
    { id: 'requests', label: 'Requests' },
    { id: 'tokens', label: 'Tokens' },
    { id: 'balance', label: 'From balance' },
];
export const card = {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 12,
};
export const cardHead = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
    padding: '12px 16px',
    borderBottom: '1px solid var(--border-soft)',
};
export const cardTitle = { fontSize: 14, fontWeight: 600, margin: 0 };
export const muted = { fontSize: 12.5, color: 'var(--muted)' };
/**
 * Laid out in three parts, top to bottom: each provider at a glance (which
 * also picks the provider the chart shows), who used it, and one chart of the
 * picked provider's days — cost, requests or tokens, switched in its header —
 * for everyone or the one person clicked in the table.
 */
export default function AiUsage({ report, period, range, onPeriod, }) {
    const [query, setQuery] = useState('');
    const [picked, setPicked] = useState(null);
    const [provider, setProvider] = useState('claude');
    const [metric, setMetric] = useState('cost');
    // One model of the charted provider, or all of them.
    const [model, setModel] = useState(null);
    const pickProvider = (id) => {
        setProvider(id);
        setModel(null);
    };
    const sorting = useSort(AI_SORTS, { by: 'total', dir: 'desc' });
    const people = report.people;
    const needle = query.trim().toLowerCase();
    const shown = sorting.sort(needle ? people.filter((person) => person.email.toLowerCase().includes(needle)) : people);
    // Someone picked who has since dropped out of the period shows everyone again.
    useEffect(() => {
        if (picked && !report.people.some((person) => person.email === picked))
            setPicked(null);
    }, [picked, report.people]);
    const days = useMemo(() => daysBetween(report.since, report.until), [report.since, report.until]);
    // DeepSeek's balance is asked for back from today, so far enough to reach
    // the period's first day, even when the period ends before today. Asked
    // again as the report refreshes, at most once a minute.
    const account = useDeepSeekAccount(Math.min(KEEP_DAYS, daysSpanned(report.since, dayOf(Date.now()))), `${report.until}:${report.people.length}:${aiCost(report.totals)}`);
    // "From balance" is DeepSeek's alone, and only with its key set.
    const hasBalance = provider === 'deepseek' && Boolean(account?.configured);
    const metrics = METRICS.filter((entry) => entry.id !== 'balance' || hasBalance);
    const shownMetric = metrics.some((entry) => entry.id === metric) ? metric : 'cost';
    /**
     * Each day's counts, summed over everyone, or the one picked — and, with a
     * model picked, that model's alone, in the provider's own keys, so the
     * chart reads them the same way.
     */
    const byDay = useMemo(() => {
        const sums = new Map(days.map((day) => [day, {}]));
        for (const person of report.people) {
            if (picked && person.email !== picked)
                continue;
            for (const day of person.daily || []) {
                const into = sums.get(day.day);
                if (!into)
                    continue;
                if (model) {
                    const counts = day.models?.[model];
                    if (!counts)
                        continue;
                    into[provider] = (into[provider] || 0) + num(counts.n);
                    into[`${provider}_in`] = (into[`${provider}_in`] || 0) + num(counts.in);
                    into[`${provider}_out`] = (into[`${provider}_out`] || 0) + num(counts.out);
                    into[`${provider}_cost`] = (into[`${provider}_cost`] || 0) + num(counts.cost);
                    continue;
                }
                for (const [key, value] of Object.entries(day))
                    if (key !== 'day' && key !== 'models')
                        into[key] = (into[key] || 0) + num(value);
            }
        }
        return days.map((day) => sums.get(day) || {});
    }, [days, report.people, picked, model, provider]);
    /** The charted provider's models, for everyone or the one picked, most spent first. */
    const models = useMemo(() => {
        const summed = picked
            ? addModels({}, report.people.find((person) => person.email === picked)?.models)
            : report.models ?? report.people.reduce((sum, person) => addModels(sum, person.models), {});
        return Object.entries(summed)
            .filter(([id]) => providerOf(id) === provider)
            .sort(([, a], [, b]) => b.cost - a.cost || b.n - a.n);
    }, [report, picked, provider]);
    const cell = { padding: '0 14px', height: ROW_HEIGHT, textAlign: 'right', whiteSpace: 'nowrap' };
    const rule = '1px solid var(--border-soft)';
    const head = { ...cell, fontWeight: 500, fontSize: 12.5, position: 'sticky', top: 0, background: 'var(--panel)', zIndex: 1, borderBottom: rule };
    const providerName = PROVIDERS.find((entry) => entry.id === provider)?.name ?? '';
    return (_jsxs("section", { style: { marginTop: 40, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16 }, "aria-label": "AI credits", children: [_jsxs("div", { style: { display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }, children: [_jsx("h2", { style: { fontSize: 17, fontWeight: 600, margin: 0 }, children: "AI credits" }), _jsxs("span", { style: muted, children: [dollars(aiCost(report.totals)), " across Claude, DeepSeek and Gemini \u00B7 ", range.since, " to", ' ', range.live ? _jsx("span", { title: `Through ${range.until} (UTC), as of the last refresh`, children: "now" }) : range.until] }), _jsx("span", { style: { flexGrow: 1 } }), _jsx(PeriodPicker, { period: period, range: range, onPeriod: onPeriod })] }), _jsx("div", { role: "group", "aria-label": "Provider", style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: 12 }, children: PROVIDERS.map(({ id, name }) => (_jsx(ProviderSummary, { name: name, totals: report.totals, provider: id, active: provider === id, onPick: () => pickProvider(id), account: id === 'deepseek' ? account : null }, id))) }), _jsxs("div", { style: card, children: [_jsxs("div", { style: cardHead, children: [_jsx("h3", { style: cardTitle, children: "People" }), _jsx("span", { style: muted, children: shown.length === people.length ? `${people.length}` : `${shown.length} of ${people.length}` }), _jsx("span", { style: { flexGrow: 1 } }), _jsx(SortControl, { options: AI_SORTS, by: sorting.by, dir: sorting.dir, onPick: sorting.pick, onDir: sorting.setDir }), _jsx(SearchBox, { value: query, onChange: setQuery })] }), _jsx("div", { style: { maxHeight: ROW_HEIGHT * (ROWS_IN_VIEW + 1) + 1, overflow: 'auto' }, children: _jsxs("table", { style: { borderCollapse: 'collapse', fontSize: 13.5, width: '100%' }, children: [_jsx("thead", { children: _jsxs("tr", { style: { color: 'var(--muted)' }, children: [_jsx(SortHeading, { id: "email", label: "Who", by: sorting.by, dir: sorting.dir, onPick: sorting.pick, style: { ...head, textAlign: 'left' } }), PROVIDERS.map(({ id, name }) => (_jsx(SortHeading, { id: `${id}_cost`, label: name, by: sorting.by, dir: sorting.dir, onPick: sorting.pick, style: head, title: `${name}: requests · cost — sorts by cost` }, id))), _jsx(SortHeading, { id: "total", label: "Total", by: sorting.by, dir: sorting.dir, onPick: sorting.pick, style: head })] }) }), _jsx("tbody", { children: shown.length ? (shown.map((person) => {
                                        const active = picked === person.email;
                                        return (_jsxs("tr", { onClick: () => setPicked(active ? null : person.email), "aria-selected": active, title: active ? 'Chart everyone again' : 'Chart only them', style: { cursor: 'pointer', borderBottom: rule, background: active ? 'var(--accent-soft)' : undefined }, children: [_jsx("td", { style: { ...cell, textAlign: 'left', fontWeight: active ? 600 : undefined }, children: person.email }), PROVIDERS.map(({ id }) => {
                                                    const requests = get(person.total, id);
                                                    return (_jsx("td", { style: cell, title: `${tokens(get(person.total, `${id}_in`) + get(person.total, `${id}_out`))} tokens`, children: requests ? (_jsxs(_Fragment, { children: [_jsxs("span", { style: { color: 'var(--muted)', fontSize: 12.5 }, children: [requests, " req \u00B7 "] }), dollars(get(person.total, `${id}_cost`))] })) : (_jsx("span", { style: { color: 'var(--muted)' }, children: "\u2014" })) }, id));
                                                }), _jsx("td", { style: { ...cell, fontWeight: 600 }, children: dollars(aiCost(person.total)) })] }, person.email));
                                    })) : (_jsx("tr", { children: _jsx("td", { colSpan: 2 + PROVIDERS.length, style: { ...cell, textAlign: 'left', color: 'var(--muted)' }, children: people.length ? `No email matches “${query}”.` : 'Nobody used Ask AI or Explain in this period.' }) })) })] }) })] }), _jsxs("div", { style: card, children: [_jsxs("div", { style: cardHead, children: [_jsxs("h3", { style: cardTitle, children: [providerName, " usage"] }), _jsxs("span", { style: {
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    fontSize: 12.5,
                                    padding: '2px 10px',
                                    borderRadius: 999,
                                    background: picked ? 'var(--accent-soft)' : 'var(--panel)',
                                    border: '1px solid var(--border)',
                                }, children: [picked ?? 'Everyone', picked ? (_jsx("button", { type: "button", onClick: () => setPicked(null), "aria-label": "Chart everyone", style: { border: 0, background: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 0, fontSize: 14, lineHeight: 1 }, children: "\u00D7" })) : null] }), _jsx("span", { style: { flexGrow: 1 } }), _jsx("div", { className: "segmented", role: "group", "aria-label": "Measure", children: metrics.map((entry) => (_jsx("button", { type: "button", "aria-pressed": shownMetric === entry.id, onClick: () => setMetric(entry.id), children: entry.label }, entry.id))) })] }), _jsxs("div", { className: "ai-usage-split", children: [_jsx(ModelList, { models: models, total: get(picked ? report.people.find((person) => person.email === picked)?.total : report.totals, `${provider}_cost`), requests: get(picked ? report.people.find((person) => person.email === picked)?.total : report.totals, provider), picked: model, onPick: setModel }), _jsx("div", { style: { padding: '14px 16px 12px', minWidth: 0 }, children: _jsx(TrendChart, { provider: provider, metric: shownMetric, days: days, byDay: byDay, account: account, picked: picked, model: shownMetric === 'balance' ? null : model }) })] })] })] }));
}
/**
 * The AI credits' own period: a few ready ones, or two days picked — the
 * second of which is "Now" until a day is picked for it. The days are UTC and
 * go back no further than the tally keeps.
 */
function PeriodPicker({ period, range, onPeriod }) {
    const today = dayOf(Date.now());
    const earliest = addDays(today, -(KEEP_DAYS - 1));
    const box = {
        fontSize: 13,
        height: 30,
        boxSizing: 'border-box',
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--paper)',
        color: 'var(--ink)',
        padding: '0 8px',
    };
    // Custom starts from the days shown, so switching to it changes nothing yet.
    const pick = (preset) => onPeriod(preset === 'custom' ? { preset, from: range.since, to: range.live ? null : range.until } : { ...period, preset });
    const now = period.to === null;
    return (_jsxs("span", { role: "group", "aria-label": "AI credits period", style: { display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, children: [_jsx("select", { value: period.preset, onChange: (event) => pick(event.target.value), "aria-label": "Period", style: box, children: PERIOD_PRESETS.map((entry) => (_jsx("option", { value: entry.id, children: entry.label }, entry.id))) }), period.preset === 'custom' ? (_jsxs(_Fragment, { children: [_jsx("input", { type: "date", value: range.since, min: earliest, max: now ? today : period.to ?? today, onChange: (event) => event.target.value && onPeriod({ ...period, from: event.target.value }), "aria-label": "From", style: box }), _jsx("span", { style: muted, children: "to" }), _jsxs("div", { className: "segmented", role: "group", "aria-label": "Up to", children: [_jsx("button", { type: "button", "aria-pressed": now, onClick: () => onPeriod({ ...period, to: null }), title: "Up to now, refreshed as it goes", children: "Now" }), _jsx("button", { type: "button", "aria-pressed": !now, onClick: () => onPeriod({ ...period, to: now ? today : period.to }), title: "Up to a day of your choosing", children: "Date" })] }), !now ? (_jsx("input", { type: "date", value: range.until, min: range.since, max: today, onChange: (event) => event.target.value && onPeriod({ ...period, to: event.target.value }), "aria-label": "To", style: box })) : null] })) : null] }));
}
/**
 * A list's sort: which option, which way, and the rows in that order. Picking
 * a new option starts it the way it reads best — names A to Z, numbers
 * largest first; picking the same one again turns it round. Ties fall back to
 * the email, A to Z, so the order never jumps about between refreshes.
 */
export function useSort(options, initial) {
    const [by, setBy] = useState(initial.by);
    const [dir, setDir] = useState(initial.dir);
    const option = options.find((entry) => entry.id === by) ?? options[0];
    const pick = (id) => {
        if (id === option.id) {
            setDir((current) => (current === 'asc' ? 'desc' : 'asc'));
            return;
        }
        const next = options.find((entry) => entry.id === id) ?? options[0];
        setBy(next.id);
        setDir(next.id === 'email' ? 'asc' : 'desc');
    };
    const sort = (rows) => [...rows].sort((a, b) => {
        const x = option.value(a);
        const y = option.value(b);
        const order = typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y)) : x - y;
        return (dir === 'asc' ? order : -order) || a.email.localeCompare(b.email);
    });
    return { by: option.id, dir, pick, setDir, sort };
}
/** "Sort by" and which way, for a list card's header. */
export function SortControl({ options, by, dir, onPick, onDir, }) {
    const box = {
        fontSize: 13,
        border: '1px solid var(--border)',
        background: 'var(--paper)',
        color: 'var(--ink)',
        height: 30,
        boxSizing: 'border-box',
    };
    return (_jsxs("span", { style: { display: 'inline-flex', alignItems: 'center', gap: 6 }, children: [_jsx("label", { style: { ...muted, whiteSpace: 'nowrap' }, children: "Sort by" }), _jsx("select", { value: by, onChange: (event) => onPick(event.target.value), "aria-label": "Sort by", style: { ...box, borderRadius: 8, padding: '0 8px' }, children: options.map((entry) => (_jsx("option", { value: entry.id, children: entry.label }, entry.id))) }), _jsx("button", { type: "button", onClick: () => onDir(dir === 'asc' ? 'desc' : 'asc'), "aria-label": dir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending', title: dir === 'asc' ? 'Ascending' : 'Descending', style: { ...box, borderRadius: 8, width: 30, cursor: 'pointer', padding: 0, fontSize: 14 }, children: dir === 'asc' ? '↑' : '↓' })] }));
}
/**
 * A column heading that sorts its list: clicking it sorts on it, clicking it
 * again turns the order round, and the one sorted on shows which way.
 */
export function SortHeading({ id, label, by, dir, onPick, style, title, }) {
    const active = by === id;
    return (_jsx("th", { style: style, "aria-sort": active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none', title: title, children: _jsxs("button", { type: "button", onClick: () => onPick(id), style: {
                border: 0,
                background: 'none',
                padding: 0,
                font: 'inherit',
                color: active ? 'var(--ink)' : 'inherit',
                fontWeight: active ? 600 : 'inherit',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
            }, children: [label, _jsx("span", { style: { display: 'inline-block', width: 12, textAlign: 'center', opacity: active ? 1 : 0 }, children: dir === 'asc' ? '↑' : '↓' })] }) }));
}
/** The search box in a list card's header: filters its rows by email, or by what `label` names. */
export function SearchBox({ value, onChange, label = 'Search by email' }) {
    return (_jsx("input", { type: "search", value: value, onChange: (event) => onChange(event.target.value), placeholder: `${label}…`, "aria-label": label, style: {
            width: 260,
            maxWidth: '100%',
            boxSizing: 'border-box',
            padding: '6px 10px',
            fontSize: 13,
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--paper)',
            color: 'var(--ink)',
        } }));
}
/** One provider's period in a few numbers — and the button that charts it. */
function ProviderSummary({ name, provider, totals, active, onPick, account, }) {
    const cost = get(totals, `${provider}_cost`);
    const requests = get(totals, provider);
    const used = get(totals, `${provider}_in`) + get(totals, `${provider}_out`);
    const balance = account?.configured ? account.balance : null;
    const stat = (label, value) => (_jsxs("div", { children: [_jsx("div", { style: { ...muted, fontSize: 12 }, children: label }), _jsx("div", { style: { fontSize: 15, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginTop: 2 }, children: value })] }));
    return (_jsxs("button", { type: "button", onClick: onPick, "aria-pressed": active, title: `Chart ${name}`, style: {
            ...card,
            textAlign: 'left',
            color: 'var(--ink)',
            font: 'inherit',
            cursor: 'pointer',
            padding: '14px 16px',
            borderColor: active ? 'var(--accent)' : 'var(--border)',
            boxShadow: active ? '0 0 0 1px var(--accent)' : 'none',
        }, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'baseline', gap: 8 }, children: [_jsx("span", { style: { fontSize: 14, fontWeight: 600 }, children: name }), _jsx("span", { style: { flexGrow: 1 } }), active ? _jsx("span", { style: { ...muted, fontSize: 11.5 }, children: "charted below" }) : null] }), _jsxs("div", { style: { fontSize: 28, fontWeight: 500, margin: '6px 0 10px', fontVariantNumeric: 'tabular-nums' }, children: [dollars(cost), _jsx("span", { style: { ...muted, fontSize: 12.5, marginLeft: 6 }, children: "this period" })] }), _jsxs("div", { style: { display: 'flex', gap: 24, flexWrap: 'wrap' }, children: [stat('Requests', requests.toLocaleString('en-US')), stat('Tokens', compact(used)), balance ? stat('Balance', dollars(balance.total)) : null] }), provider === 'deepseek' && account && !account.configured ? (_jsxs("div", { style: { ...muted, fontSize: 11.5, marginTop: 10 }, children: ["Your account\u2019s balance shows here with ", _jsx("code", { children: "DEEPSEEK_KEY" }), " set on the Worker."] })) : null, provider === 'deepseek' && account?.error ? (_jsxs("div", { style: { fontSize: 11.5, marginTop: 10, color: 'var(--danger)' }, children: ["DeepSeek did not answer: ", account.error] })) : null, balance && !balance.available ? (_jsx("div", { style: { fontSize: 11.5, marginTop: 10, color: 'var(--danger)' }, children: "DeepSeek says this balance cannot pay for requests." })) : null] }));
}
/**
 * The charted provider's models: each one's share of the spend, its cost,
 * requests and tokens. "All models" first; clicking a model narrows the
 * chart beside it to that model, clicking it again widens it back.
 */
function ModelList({ models, total, requests, picked, onPick, }) {
    const counted = models.reduce((sum, [, counts]) => sum + counts.cost, 0);
    const row = (active) => ({
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
    });
    return (_jsxs("div", { className: "ai-usage-models", role: "group", "aria-label": "Models", children: [_jsx("div", { style: { ...muted, fontSize: 12, padding: '0 12px 6px' }, children: "By model" }), _jsxs("button", { type: "button", "aria-pressed": !picked, onClick: () => onPick(null), style: row(!picked), children: [_jsx("span", { style: { fontWeight: 600, fontSize: 13.5 }, children: "All models" }), _jsx("span", { style: { fontWeight: 600, fontSize: 13.5, fontVariantNumeric: 'tabular-nums' }, children: dollars(total) }), _jsxs("span", { style: { ...muted, fontSize: 12, gridColumn: '1 / -1' }, children: [requests.toLocaleString('en-US'), " requests"] })] }), models.length ? (models.map(([id, counts]) => {
                const active = picked === id;
                const share = counted ? counts.cost / counted : 0;
                return (_jsxs("button", { type: "button", "aria-pressed": active, onClick: () => onPick(active ? null : id), title: active ? 'Chart all models' : `Chart only ${modelLabel(id)}`, style: row(active), children: [_jsx("span", { style: { fontSize: 13.5, fontWeight: active ? 600 : 500 }, children: modelLabel(id) }), _jsxs("span", { style: { fontSize: 13.5, fontVariantNumeric: 'tabular-nums' }, children: [dollars(counts.cost), _jsxs("span", { style: { ...muted, fontSize: 12, marginLeft: 6, display: 'inline-block', minWidth: 34, textAlign: 'right' }, children: [Math.round(share * 100), "%"] })] }), _jsx("span", { style: { gridColumn: '1 / -1', height: 6, borderRadius: 3, background: 'var(--border-soft)', overflow: 'hidden' }, children: _jsx("span", { style: { display: 'block', height: '100%', width: `${share * 100}%`, background: 'var(--viz-1)', borderRadius: 3 } }) }), _jsxs("span", { style: { ...muted, fontSize: 12, gridColumn: '1 / -1', fontVariantNumeric: 'tabular-nums' }, children: [counts.n.toLocaleString('en-US'), " req \u00B7 ", compact(counts.in), " in \u00B7 ", compact(counts.out), " out"] })] }, id));
            })) : (_jsx("p", { style: { ...muted, fontSize: 12, margin: '8px 12px', lineHeight: 1.6 }, children: "No answers split by model yet \u2014 they are counted per model from the Worker redeploy on." }))] }));
}
/** The chart for one provider and one measure, with a line under it saying what it counts. */
function TrendChart({ provider, metric, days, byDay, account, picked, model, }) {
    const of = model ? ` · ${modelLabel(model)}` : '';
    const series = (key) => byDay.map((counts) => num(counts[`${provider}${key}`]));
    const sum = (values) => values.reduce((a, b) => a + b, 0);
    const note = { ...muted, fontSize: 12, margin: '10px 0 0', lineHeight: 1.6 };
    if (metric === 'balance') {
        const byDate = new Map((account?.days || []).map((row) => [row.day, row.spent]));
        const spent = days.map((day) => byDate.get(day) || 0);
        return (_jsxs(_Fragment, { children: [_jsx(BarChart, { title: `Spent from your DeepSeek balance ${dollars(sum(spent))}`, days: days, series: [{ label: 'Spent', color: 'var(--viz-2)', values: spent }], format: dollars, axis: (value) => dollars(value).replace(/\.?0+$/, ''), height: 240 }), _jsxs("p", { style: note, children: ["The fall in your account\u2019s balance between checks, hourly and while this page is open.", picked ? ` This is the whole account, not only ${picked}.` : '', " A top-up between two checks hides that much spending."] })] }));
    }
    if (metric === 'tokens') {
        const input = series('_in');
        const output = series('_out');
        return (_jsx(BarChart, { title: `Tokens${of} ${tokens(sum(input) + sum(output))}`, days: days, series: [
                { label: 'Input', color: 'var(--viz-1)', values: input },
                { label: 'Output', color: 'var(--viz-2)', values: output },
            ], format: tokens, axis: compact, height: 240 }));
    }
    if (metric === 'requests') {
        const requests = series('');
        return (_jsx(BarChart, { title: `Requests${of} ${sum(requests).toLocaleString('en-US')}`, days: days, series: [{ label: 'Requests', color: 'var(--viz-1)', values: requests }], format: (value) => value.toLocaleString('en-US'), axis: compact, height: 240 }));
    }
    const cost = series('_cost');
    return (_jsxs(_Fragment, { children: [_jsx(BarChart, { title: `Cost${of} ${dollars(sum(cost))}`, days: days, series: [{ label: 'Cost', color: 'var(--viz-1)', values: cost }], format: dollars, axis: (value) => dollars(value).replace(/\.?0+$/, ''), height: 240 }), _jsx("p", { style: note, children: "Worked out from each answer\u2019s tokens at list price; the provider\u2019s own console is the bill." })] }));
}
/** A round top for the axis: 1, 2 or 5 times a power of ten, at or above `max`. */
function niceMax(max) {
    if (max <= 0)
        return 1;
    const power = 10 ** Math.floor(Math.log10(max));
    for (const step of [1, 2, 2.5, 5, 10])
        if (step * power >= max)
            return step * power;
    return 10 * power;
}
function useWidth() {
    const ref = useRef(null);
    const [width, setWidth] = useState(600);
    useEffect(() => {
        const element = ref.current;
        if (!element)
            return;
        setWidth(element.clientWidth || 600);
        if (typeof ResizeObserver === 'undefined')
            return;
        const observer = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.round(entry.contentRect.width))));
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    return [ref, width];
}
/**
 * Bars per day, stacked when there is more than one series, on one axis from
 * zero. Hovering a day shows its numbers; a legend names two or more series.
 */
export function BarChart({ title, days, series, format, axis, height, }) {
    const [ref, width] = useWidth();
    const [hover, setHover] = useState(null);
    const totals = days.map((_, index) => series.reduce((sum, s) => sum + (s.values[index] || 0), 0));
    const top = niceMax(Math.max(0, ...totals));
    const left = 48;
    const right = 8;
    const plotTop = 8;
    const plotBottom = height - 22;
    const plotHeight = plotBottom - plotTop;
    const slot = (width - left - right) / Math.max(1, days.length);
    const bar = Math.max(2, Math.min(18, slot * 0.6));
    const y = (value) => plotBottom - (value / top) * plotHeight;
    const ticks = days.length <= 1 ? [0] : [0, Math.round((days.length - 1) / 3), Math.round((2 * (days.length - 1)) / 3), days.length - 1];
    return (_jsxs("div", { ref: ref, style: { position: 'relative' }, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 6 }, children: [_jsx("span", { style: { fontSize: 13.5, fontWeight: 500 }, children: title }), series.length > 1 ? (_jsx("span", { style: { display: 'inline-flex', gap: 12, fontSize: 12, color: 'var(--muted)' }, children: series.map((s) => (_jsxs("span", { style: { display: 'inline-flex', alignItems: 'center', gap: 5 }, children: [_jsx("span", { style: { width: 9, height: 9, borderRadius: 2, background: s.color } }), s.label] }, s.label))) })) : null] }), _jsxs("svg", { width: width, height: height, role: "img", "aria-label": title, style: { display: 'block', overflow: 'visible' }, onMouseLeave: () => setHover(null), children: [[0, top / 2, top].map((value) => (_jsxs("g", { children: [_jsx("line", { x1: left, x2: width - right, y1: y(value), y2: y(value), stroke: "var(--border-soft)", strokeWidth: 1 }), _jsx("text", { x: left - 8, y: y(value), dy: "0.32em", textAnchor: "end", fontSize: 11, fill: "var(--muted)", children: axis(value) })] }, value))), ticks.map((index) => (_jsx("text", { x: left + slot * (index + 0.5), y: height - 4, textAnchor: "middle", fontSize: 11, fill: "var(--muted)", children: shortDay(days[index]) }, index))), days.map((day, index) => {
                        const x = left + slot * (index + 0.5) - bar / 2;
                        let base = 0;
                        const marks = series.map((s, which) => {
                            const value = s.values[index] || 0;
                            if (!value)
                                return null;
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
                            return _jsx("path", { d: d, fill: s.color, opacity: hover === null || hover === index ? 1 : 0.55 }, s.label);
                        });
                        return (_jsxs("g", { children: [marks, _jsx("rect", { x: left + slot * index, y: plotTop, width: slot, height: plotHeight, fill: "transparent", onMouseEnter: () => setHover(index), onFocus: () => setHover(index) })] }, day));
                    })] }), hover !== null ? (_jsxs("div", { role: "tooltip", style: {
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
                }, children: [_jsx("div", { style: { color: 'var(--muted)', marginBottom: 2 }, children: days[hover] }), series.map((s) => (_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 6 }, children: [_jsx("span", { style: { width: 8, height: 8, borderRadius: 2, background: s.color } }), _jsx("span", { style: { flexGrow: 1 }, children: s.label }), _jsx("span", { style: { fontVariantNumeric: 'tabular-nums' }, children: format(s.values[hover] || 0) })] }, s.label)))] })) : null] }));
}
