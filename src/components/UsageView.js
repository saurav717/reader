import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { ownerFetch } from '../lib/owner';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hasProxy } from '../lib/api';
import AiUsage, { ROW_HEIGHT, ROWS_IN_VIEW, SearchBox, SortControl, SortHeading, card, cardHead, cardTitle, useSort } from './AiUsage';
import WebUsage from './WebUsage';
import CloudUsage from './CloudUsage';
import { ChartIcon, ChevronDownIcon, ChevronRightIcon, RestoreIcon } from './icons';
import { KEEP_DAYS, addDays, dayOf, daysSpanned, resolvePeriod, sliceReport } from '../lib/usagePeriod';
/** The report for the last `days` days, or null — which is what anyone but the owner gets. */
async function fetchUsage(days, token) {
    if (!hasProxy())
        return null;
    const response = await ownerFetch(`/usage?days=${days}`, token);
    if (!response.ok)
        return null;
    const answer = (await response.json());
    return Array.isArray(answer?.people) ? answer : null;
}
/**
 * Whether whoever is using the reader owns its proxy: the Worker answers
 * `/usage` to READER_TOKEN, or to the Google sign-in of someone named in
 * READER_OWNERS, and to nobody else. Asked again whenever the token (or the
 * pass a sign-in fills in) changes.
 */
export function useIsOwner(token, signedInAs) {
    const [owner, setOwner] = useState(false);
    useEffect(() => {
        // A pass or token to show, or a Google sign-in: the owner is known by either.
        if (!token.trim() && !signedInAs) {
            setOwner(false);
            return;
        }
        let cancelled = false;
        let timer = 0;
        const ask = (triesLeft) => fetchUsage(1, token)
            .then((report) => !cancelled && setOwner(Boolean(report)))
            .catch(() => {
            // Not an answer (offline, the Worker waking): ask again in a while rather than hide Usage for good.
            if (cancelled)
                return;
            setOwner(false);
            if (triesLeft > 0)
                timer = window.setTimeout(() => void ask(triesLeft - 1), 5000);
        });
        void ask(3);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [token, signedInAs]);
    return owner;
}
const ago = (at) => {
    if (!at)
        return '—';
    const minutes = Math.round((Date.now() - at) / 60000);
    if (minutes < 60)
        return `${Math.max(1, minutes)} min ago`;
    if (minutes < 48 * 60)
        return `${Math.round(minutes / 60)} h ago`;
    return `${Math.round(minutes / 1440)} days ago`;
};
const COUNTED = [
    ['signin', 'Sign-ins'],
    ['scholar', 'Scholar'],
    ['serply', 'Serply credits'],
    ['serpapi', 'SerpApi searches'],
    ['browser', 'Browser'],
    ['pdf', 'PDFs'],
    ['web', 'Web searches'],
];
/** What the services list can be sorted on: every column. */
const SERVICE_SORTS = [
    ...COUNTED.map(([key, title]) => ({ id: key, label: title, value: (person) => person.total[key] || 0 })),
    { id: 'last', label: 'Last seen', value: (person) => person.last || 0 },
    { id: 'days', label: 'Days active', value: (person) => person.days || 0 },
    { id: 'email', label: 'Email', value: (person) => person.email },
];
/**
 * Who has used the proxy's paid accounts, and how much: everyone who has
 * signed in, their totals for the period, when they were last seen, and —
 * opened — each day on its own. A page of its own in the main area; the
 * owner's alone, since the rail shows its button only to them.
 */
/** How often the page asks again while it is open and in view. */
export const REFRESH_MS = 30_000;
const TAB_KEY = 'reader.usageTab';
function rememberedTab() {
    try {
        return window.localStorage.getItem(TAB_KEY) === 'cloud' ? 'cloud' : 'people';
    }
    catch {
        return 'people';
    }
}
export default function UsageView() {
    const [tab, setTab] = useState(rememberedTab);
    const pickTab = (next) => {
        setTab(next);
        try {
            window.localStorage.setItem(TAB_KEY, next);
        }
        catch {
            // Not kept: the page opens on People next time.
        }
    };
    const [days, setDays] = useState(30);
    // The AI credits' own period; the page's until another is picked there.
    const [aiPeriod, setAiPeriod] = useState({ preset: 'page', from: '', to: null });
    const today = dayOf(Date.now());
    const aiRange = resolvePeriod(aiPeriod, days, today);
    // One ask covers both: back far enough for the page's period and the AI credits'.
    const asked = Math.min(KEEP_DAYS, Math.max(days, daysSpanned(aiRange.since, today)));
    const [full, setReport] = useState(undefined);
    const report = useMemo(() => (full ? sliceReport(full, addDays(full.until, -(days - 1)), full.until) : full), [full, days]);
    const aiReport = useMemo(() => (full ? sliceReport(full, aiRange.since, aiRange.until) : full), [full, aiRange.since, aiRange.until]);
    const [open, setOpen] = useState(null);
    const [query, setQuery] = useState('');
    // Most Scholar asks first, as the Worker orders it, until another order is picked.
    const sorting = useSort(SERVICE_SORTS, { by: 'scholar', dir: 'desc' });
    const [updatedAt, setUpdatedAt] = useState(0);
    const [refreshing, setRefreshing] = useState(false);
    // The period of the answer being waited for, so an answer for a period
    // since changed is dropped rather than shown under the new one.
    const asking = useRef(asked);
    /**
     * Ask the proxy again. A refresh keeps the table on screen while it waits;
     * only the first ask starts from "Asking…" — a new period is cut from the
     * last answer until the next one is in. A refresh that fails keeps the
     * last numbers rather than blanking them.
     */
    const load = useCallback(async (period, fresh) => {
        asking.current = period;
        if (fresh)
            setReport(undefined);
        setRefreshing(true);
        try {
            const answer = await fetchUsage(period);
            if (asking.current !== period)
                return;
            if (answer || fresh)
                setReport(answer);
            if (answer)
                setUpdatedAt(Date.now());
        }
        catch {
            if (asking.current === period && fresh)
                setReport(null);
        }
        finally {
            if (asking.current === period)
                setRefreshing(false);
        }
    }, []);
    const first = useRef(true);
    useEffect(() => {
        void load(asked, first.current);
        first.current = false;
    }, [asked, load]);
    // Every thirty seconds while the page is open and the tab is in view — a
    // hidden tab asks nothing — and at once on coming back to it, if the
    // numbers are older than that. Each ask is one request to the Worker and
    // one read of the tally; nothing paid.
    const lastAsked = useRef(0);
    lastAsked.current = updatedAt;
    useEffect(() => {
        const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
        const timer = setInterval(() => {
            if (visible())
                void load(asked, false);
        }, REFRESH_MS);
        const onVisibility = () => {
            if (visible() && Date.now() - lastAsked.current >= REFRESH_MS)
                void load(asked, false);
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [asked, load]);
    const cell = { padding: '0 12px', height: ROW_HEIGHT, textAlign: 'right', whiteSpace: 'nowrap' };
    const rule = '1px solid var(--border-soft)';
    // The header stays in view as the box scrolls, and the totals row at its foot.
    const head = { ...cell, fontWeight: 500, fontSize: 12.5, position: 'sticky', top: 0, background: 'var(--panel)', zIndex: 1, borderBottom: rule };
    const foot = { ...cell, position: 'sticky', bottom: 0, background: 'var(--panel)', borderTop: rule };
    const needle = query.trim().toLowerCase();
    const shown = report ? sorting.sort(needle ? report.people.filter((person) => person.email.toLowerCase().includes(needle)) : report.people) : [];
    return (_jsxs("div", { className: "main library-main", "aria-label": "Usage", children: [_jsxs("div", { className: "collection-head", children: [_jsxs("div", { className: "collection-titlebar", children: [_jsx("span", { className: "junk-mark", children: _jsx(ChartIcon, { size: 18 }) }), _jsx("h1", { className: "collection-title", children: "Usage" }), _jsx("div", { className: "segmented", role: "tablist", "aria-label": "Usage", style: { marginLeft: 8 }, children: [
                                    ['people', 'People & services'],
                                    ['cloud', 'Google Cloud'],
                                ].map(([id, label]) => (_jsx("button", { type: "button", role: "tab", "aria-selected": tab === id, onClick: () => pickTab(id), children: label }, id))) }), _jsx("span", { style: { flexGrow: 1 } }), updatedAt ? (_jsxs("span", { style: { fontSize: 12, color: 'var(--muted)' }, title: "Refreshes every 30 seconds while this page is open and in view", children: ["Updated ", new Date(updatedAt).toLocaleTimeString()] })) : null, _jsxs("button", { type: "button", className: "btn sm", onClick: () => void load(asked, false), disabled: refreshing, "aria-label": "Refresh", title: "Refresh now", style: { display: 'inline-flex', alignItems: 'center', gap: 6 }, children: [_jsx(RestoreIcon, { size: 14 }), refreshing ? 'Refreshing…' : 'Refresh'] }), _jsxs("select", { className: "chat-model", value: days, onChange: (event) => setDays(Number(event.target.value)), "aria-label": "Period", children: [_jsx("option", { value: 1, children: "Today" }), _jsx("option", { value: 7, children: "7 days" }), _jsx("option", { value: 30, children: "30 days" }), _jsx("option", { value: 90, children: "90 days" })] })] }), _jsxs("p", { className: "collection-sub", children: [report ? (_jsxs("span", { children: [report.people.length, " ", report.people.length === 1 ? 'person' : 'people', " \u00B7 ", report.since, " to ", report.until, " (UTC)"] })) : null, _jsx("span", { children: tab === 'cloud'
                                    ? 'your Google Cloud project: services, billing and transactions — only you see this'
                                    : 'what everyone signed in used on your accounts — only you see this' })] })] }), _jsx("div", { className: "scroll", style: { padding: '18px 32px 32px' }, children: tab === 'cloud' ? (_jsx(CloudUsage, { report: report, refreshedAt: updatedAt })) : report === undefined ? (_jsx("p", { style: { fontSize: 13, color: 'var(--muted)' }, children: "Asking the proxy\u2026" })) : report === null ? (_jsx("p", { className: "banner error", children: "The proxy did not answer with the tally. Sign in again, or check that your email is in READER_OWNERS." })) : (_jsxs(_Fragment, { children: [!report.people.length ? (_jsx("p", { style: { fontSize: 14 }, children: "Nobody has used the paid features in this period." })) : (_jsxs(_Fragment, { children: [_jsxs("div", { style: card, children: [_jsxs("div", { style: cardHead, children: [_jsx("h3", { style: cardTitle, children: "Services" }), _jsx("span", { style: { fontSize: 12.5, color: 'var(--muted)' }, children: shown.length === report.people.length ? report.people.length : `${shown.length} of ${report.people.length}` }), _jsx("span", { style: { flexGrow: 1 } }), _jsx(SortControl, { options: SERVICE_SORTS, by: sorting.by, dir: sorting.dir, onPick: sorting.pick, onDir: sorting.setDir }), _jsx(SearchBox, { value: query, onChange: setQuery })] }), _jsx("div", { style: { maxHeight: ROW_HEIGHT * (ROWS_IN_VIEW + 2) + 2, overflow: 'auto' }, children: _jsxs("table", { style: { borderCollapse: 'collapse', fontSize: 13.5, width: '100%' }, children: [_jsx("thead", { children: _jsxs("tr", { style: { color: 'var(--muted)' }, children: [_jsx(SortHeading, { id: "email", label: "Who", by: sorting.by, dir: sorting.dir, onPick: sorting.pick, style: { ...head, textAlign: 'left' } }), _jsx(SortHeading, { id: "last", label: "Last seen", by: sorting.by, dir: sorting.dir, onPick: sorting.pick, style: head }), _jsx(SortHeading, { id: "days", label: "Days", by: sorting.by, dir: sorting.dir, onPick: sorting.pick, style: head }), COUNTED.map(([key, title]) => (_jsx(SortHeading, { id: key, label: title, by: sorting.by, dir: sorting.dir, onPick: sorting.pick, style: head }, key)))] }) }), _jsxs("tbody", { children: [!shown.length ? (_jsx("tr", { children: _jsxs("td", { colSpan: 3 + COUNTED.length, style: { ...cell, textAlign: 'left', color: 'var(--muted)' }, children: ["No email matches \u201C", query, "\u201D."] }) })) : null, shown.map((person) => {
                                                                const expanded = open === person.email;
                                                                return (_jsxs(Fragment, { children: [_jsxs("tr", { onClick: () => setOpen(expanded ? null : person.email), style: { cursor: 'pointer', borderBottom: expanded ? undefined : rule }, "aria-expanded": expanded, title: expanded ? 'Hide their days' : 'Show each day', children: [_jsx("td", { style: { ...cell, textAlign: 'left' }, children: _jsxs("span", { style: { display: 'inline-flex', alignItems: 'center', gap: 6 }, children: [expanded ? _jsx(ChevronDownIcon, { size: 14 }) : _jsx(ChevronRightIcon, { size: 14 }), person.email] }) }), _jsx("td", { style: cell, children: ago(person.last) }), _jsx("td", { style: cell, children: person.days }), COUNTED.map(([key]) => (_jsx("td", { style: cell, children: person.total[key] || 0 }, key)))] }), expanded
                                                                            ? (person.daily || []).map((day, index, all) => (_jsxs("tr", { style: { color: 'var(--muted)', fontSize: 12.5, borderBottom: index === all.length - 1 ? rule : undefined }, children: [_jsx("td", { style: { ...cell, textAlign: 'left', paddingLeft: 32 }, children: day.day }), _jsx("td", { style: cell }), _jsx("td", { style: cell }), COUNTED.map(([key]) => (_jsx("td", { style: cell, children: day[key] || 0 }, key)))] }, day.day)))
                                                                            : null] }, person.email));
                                                            }), _jsxs("tr", { style: { fontWeight: 600 }, children: [_jsx("td", { style: { ...foot, textAlign: 'left' }, children: needle ? `All ${report.people.length} people` : 'All' }), _jsx("td", { style: foot }), _jsx("td", { style: foot }), COUNTED.map(([key]) => (_jsx("td", { style: foot, children: report.totals[key] || 0 }, key)))] })] })] }) })] }), _jsx("p", { style: { fontSize: 12, color: 'var(--muted)', marginTop: 14, lineHeight: 1.6 }, children: "Click a person for each day. Serply credits and SerpApi searches are what each service charged; answers from the proxy\u2019s five-minute cache cost nothing. Counted by your Worker, kept ninety days; this page asks again every thirty seconds while it is open." })] })), _jsx(WebUsage, { report: report, days: days, refreshedAt: updatedAt }), aiReport ? _jsx(AiUsage, { report: aiReport, period: aiPeriod, range: aiRange, onPeriod: setAiPeriod }) : null] })) })] }));
}
