import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { ownerFetch } from '../lib/owner';
import { useEffect, useRef, useState } from 'react';
import { BarChart, card, cardHead, cardTitle, daysBetween, muted } from './AiUsage';
const MONTH_MS = 60_000;
function useLatexMonth(refreshedAt) {
    const [month, setMonth] = useState(null);
    const asked = useRef(0);
    useEffect(() => {
        if (Date.now() - asked.current < MONTH_MS)
            return;
        asked.current = Date.now();
        // Not dropped on a re-render: the guard above would not ask again for a minute.
        ownerFetch('/usage/latex')
            .then((response) => (response.ok ? response.json() : null))
            .then((answer) => answer && setMonth(answer))
            .catch(() => undefined);
    }, [refreshedAt]);
    return month;
}
const whole = (value) => value.toLocaleString('en-US');
const duration = (seconds) => (seconds >= 60 ? `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s` : `${Math.round(seconds)} s`);
export default function LatexUsage({ report, refreshedAt }) {
    const month = useLatexMonth(refreshedAt);
    const people = report.people
        .map((person) => ({ email: person.email, compiles: Number(person.total.latex) || 0, seconds: Number(person.total.latex_s) || 0, last: person.last }))
        .filter((person) => person.compiles > 0)
        .sort((a, b) => b.seconds - a.seconds);
    if (month && !month.configured && !people.length)
        return null;
    if (month?.on === 'cloudrun')
        return _jsx(CloudRunUsage, { month: month, report: report, people: people });
    const minutes = month?.minutes ?? 0;
    const limit = month?.limit ?? null;
    const share = limit ? Math.min(1, minutes / limit) : null;
    const tone = share === null ? 'var(--viz-1)' : share >= 0.9 ? 'var(--danger)' : share >= 0.7 ? 'var(--viz-2)' : 'var(--viz-1)';
    const span = month?.month ? daysBetween(`${month.month}-01`, new Date().toISOString().slice(0, 10)) : [];
    const byDay = new Map((month?.days || []).map((row) => [row.day, row]));
    const stat = (label, value, note) => (_jsxs("div", { children: [_jsx("div", { style: { ...muted, fontSize: 12 }, children: label }), _jsx("div", { style: { fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginTop: 2 }, children: value }), note ? _jsx("div", { style: { ...muted, fontSize: 11.5, marginTop: 2 }, children: note }) : null] }));
    const cell = { padding: '6px 12px', textAlign: 'right', whiteSpace: 'nowrap' };
    return (_jsxs("div", { style: { ...card, marginTop: 24 }, children: [_jsxs("div", { style: cardHead, children: [_jsx("h3", { style: cardTitle, children: "LaTeX compiler" }), _jsxs("span", { style: { ...muted, fontSize: 12.5 }, children: ["GitHub Actions", month?.repo ? ` in ${month.repo}` : '', ", for everyone signed in"] }), _jsx("span", { style: { flexGrow: 1 } }), month?.repo ? (_jsx("a", { href: `https://github.com/${month.repo}/actions/workflows/latex-compile.yml`, target: "_blank", rel: "noreferrer noopener", style: { ...muted, fontSize: 12 }, children: "The runs on GitHub" })) : null] }), month && !month.configured ? (_jsx("p", { style: { ...muted, padding: '12px 16px', margin: 0 }, children: "Not set up on the Worker yet (LATEX_GITHUB_TOKEN, LATEX_RUNNER_TOKEN \u2014 docs/deploy.md). These are the compiles it counted before." })) : null, month?.error ? _jsxs("p", { className: "banner error", style: { margin: '12px 16px' }, children: ["GitHub didn\u2019t answer: ", month.error] }) : null, _jsxs("div", { className: "ai-usage-split", children: [_jsx("div", { className: "ai-usage-models", style: { display: 'flex', flexDirection: 'column', gap: 16, padding: '14px 16px' }, children: month?.configured && !month.error ? (_jsxs(_Fragment, { children: [_jsxs("div", { children: [_jsxs("div", { style: { ...muted, fontSize: 12 }, children: ["Runner minutes this month", month.month ? ` · ${month.month}` : ''] }), _jsxs("div", { style: { fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginTop: 2 }, children: [whole(minutes), _jsx("span", { style: { ...muted, fontSize: 13, marginLeft: 4 }, children: limit ? `of ${whole(limit)} minutes` : 'minutes · unlimited' })] }), share !== null ? (_jsx("div", { role: "meter", "aria-label": "GitHub Actions minutes used this month", "aria-valuemin": 0, "aria-valuemax": limit ?? undefined, "aria-valuenow": minutes, title: `${Math.round(share * 100)}% of the month’s free minutes`, style: { height: 6, marginTop: 8, borderRadius: 3, background: 'var(--border-soft)', overflow: 'hidden' }, children: _jsx("div", { style: { width: `${share * 100}%`, height: '100%', background: tone, borderRadius: 3 } }) })) : null, _jsx("div", { style: { ...muted, fontSize: 11.5, marginTop: 6, ...(share !== null && share >= 0.9 ? { color: 'var(--danger)' } : {}) }, children: limit
                                                ? `${whole(Math.max(0, limit - minutes))} left this month — the repository is private, and GitHub’s Free plan gives ${whole(limit)} minutes a month across your private repositories`
                                                : 'The repository is public: GitHub doesn’t meter its Actions minutes. Each run’s minutes are rounded up, as GitHub counts a job.' })] }), stat('Compiles this month', whole(month.runs ?? 0), `${whole(month.done ?? 0)} done · ${whole(month.failed ?? 0)} failed or cancelled`), stat('Running now', `${whole((month.running ?? 0) + (month.queued ?? 0))}`, `${whole(month.running ?? 0)} compiling, ${whole(month.queued ?? 0)} waiting · GitHub runs ${month.concurrent ?? 20} at once`), stat('A compile takes', month.average ? duration(month.average) : '—', month.longest ? `the longest ${duration(month.longest)}` : undefined)] })) : !month ? (_jsx("p", { style: { ...muted, margin: 0 }, children: "Asking GitHub\u2026" })) : null }), _jsxs("div", { style: { flex: 1, minWidth: 0, padding: '14px 16px' }, children: [span.length ? (_jsx(BarChart, { title: `Minutes this month ${whole(minutes)}`, days: span, series: [{ label: 'Minutes', color: 'var(--viz-1)', values: span.map((day) => byDay.get(day)?.minutes || 0) }], format: whole, axis: whole, height: 150 })) : null, _jsxs("table", { style: { borderCollapse: 'collapse', fontSize: 13, width: '100%', marginTop: span.length ? 14 : 0 }, children: [_jsx("thead", { children: _jsxs("tr", { style: { color: 'var(--muted)' }, children: [_jsxs("th", { style: { ...cell, textAlign: 'left', fontWeight: 500 }, children: ["Who compiled (", report.since, " to ", report.until, ")"] }), _jsx("th", { style: { ...cell, fontWeight: 500 }, children: "Compiles" }), _jsx("th", { style: { ...cell, fontWeight: 500 }, children: "Runner time" })] }) }), _jsxs("tbody", { children: [people.map((person) => (_jsxs("tr", { style: { borderTop: '1px solid var(--border-soft)' }, children: [_jsx("td", { style: { ...cell, textAlign: 'left' }, children: person.email }), _jsx("td", { style: cell, children: whole(person.compiles) }), _jsx("td", { style: cell, children: duration(person.seconds) })] }, person.email))), !people.length ? (_jsx("tr", { children: _jsx("td", { colSpan: 3, style: { ...cell, textAlign: 'left', color: 'var(--muted)' }, children: "Nobody has compiled in this period." }) })) : null] })] })] })] })] }));
}
/** On Cloud Run: the compiles the Worker counted, and their seconds as Cloud Run bills them against its free tier. */
function CloudRunUsage({ month, report, people }) {
    const cpu = month.cpu ?? 2;
    const memory = month.memoryGib ?? 4;
    const free = month.free ?? { vcpuSeconds: 180_000, gibSeconds: 360_000, requests: 2_000_000 };
    const thisMonth = new Date().toISOString().slice(0, 7);
    const byDay = new Map();
    for (const person of report.people) {
        for (const row of person.daily ?? []) {
            if (!row.latex)
                continue;
            const day = byDay.get(row.day) ?? { compiles: 0, seconds: 0 };
            day.compiles += Number(row.latex) || 0;
            day.seconds += Number(row.latex_s) || 0;
            byDay.set(row.day, day);
        }
    }
    let seconds = 0;
    let compiles = 0;
    for (const [day, row] of byDay)
        if (day.startsWith(thisMonth))
            (seconds += row.seconds, compiles += row.compiles);
    const vcpu = seconds * cpu;
    const gib = seconds * memory;
    const share = Math.min(1, Math.max(vcpu / free.vcpuSeconds, gib / free.gibSeconds));
    const tone = share >= 0.9 ? 'var(--danger)' : share >= 0.7 ? 'var(--viz-2)' : 'var(--viz-1)';
    const span = daysBetween(report.since, report.until);
    const total = people.reduce((sum, person) => sum + person.compiles, 0);
    const totalSeconds = people.reduce((sum, person) => sum + person.seconds, 0);
    const cell = { padding: '6px 12px', textAlign: 'right', whiteSpace: 'nowrap' };
    const stat = (label, value, note) => (_jsxs("div", { children: [_jsx("div", { style: { ...muted, fontSize: 12 }, children: label }), _jsx("div", { style: { fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginTop: 2 }, children: value }), note ? _jsx("div", { style: { ...muted, fontSize: 11.5, marginTop: 2 }, children: note }) : null] }));
    return (_jsxs("div", { style: { ...card, marginTop: 24 }, children: [_jsxs("div", { style: cardHead, children: [_jsx("h3", { style: cardTitle, children: "LaTeX compiler" }), _jsxs("span", { style: { ...muted, fontSize: 12.5 }, children: ["Google Cloud Run, ", cpu, " vCPU and ", memory, " GiB, for everyone signed in"] })] }), _jsxs("div", { className: "ai-usage-split", children: [_jsxs("div", { className: "ai-usage-models", style: { display: 'flex', flexDirection: 'column', gap: 16, padding: '14px 16px' }, children: [_jsxs("div", { children: [_jsxs("div", { style: { ...muted, fontSize: 12 }, children: ["Free tier used this month \u00B7 ", report.since > `${thisMonth}-01` ? `since ${report.since}, the period shown` : thisMonth] }), _jsxs("div", { style: { fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums', marginTop: 2 }, children: [Math.round(share * 1000) / 10, "%", _jsxs("span", { style: { ...muted, fontSize: 13, marginLeft: 4 }, children: [whole(Math.round(vcpu)), " of ", whole(free.vcpuSeconds), " vCPU-s \u00B7 ", whole(Math.round(gib)), " of ", whole(free.gibSeconds), " GiB-s"] })] }), _jsx("div", { role: "meter", "aria-label": "Cloud Run free tier used this month", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(share * 100), style: { height: 6, marginTop: 8, borderRadius: 3, background: 'var(--border-soft)', overflow: 'hidden' }, children: _jsx("div", { style: { width: `${share * 100}%`, height: '100%', background: tone, borderRadius: 3 } }) }), _jsx("div", { style: { ...muted, fontSize: 11.5, marginTop: 6, ...(share >= 0.9 ? { color: 'var(--danger)' } : {}) }, children: "From the compiles the Worker timed; Cloud Run also bills each instance\u2019s start, so its own count runs a little higher. Past the free tier it is billed to the project." })] }), stat('Compiles this month', whole(compiles), `${duration(seconds)} compiling`), stat('A compile takes', total ? duration(totalSeconds / total) : '—', 'from the files sent to the PDF back, including any cold start')] }), _jsxs("div", { style: { flex: 1, minWidth: 0, padding: '14px 16px' }, children: [span.length ? (_jsx(BarChart, { title: `Compiles ${whole(total)}`, days: span, series: [{ label: 'Compiles', color: 'var(--viz-1)', values: span.map((day) => byDay.get(day)?.compiles || 0) }], format: whole, axis: whole, height: 150 })) : null, _jsxs("table", { style: { borderCollapse: 'collapse', fontSize: 13, width: '100%', marginTop: span.length ? 14 : 0 }, children: [_jsx("thead", { children: _jsxs("tr", { style: { color: 'var(--muted)' }, children: [_jsxs("th", { style: { ...cell, textAlign: 'left', fontWeight: 500 }, children: ["Who compiled (", report.since, " to ", report.until, ")"] }), _jsx("th", { style: { ...cell, fontWeight: 500 }, children: "Compiles" }), _jsx("th", { style: { ...cell, fontWeight: 500 }, children: "Compiler time" })] }) }), _jsxs("tbody", { children: [people.map((person) => (_jsxs("tr", { style: { borderTop: '1px solid var(--border-soft)' }, children: [_jsx("td", { style: { ...cell, textAlign: 'left' }, children: person.email }), _jsx("td", { style: cell, children: whole(person.compiles) }), _jsx("td", { style: cell, children: duration(person.seconds) })] }, person.email))), !people.length ? (_jsx("tr", { children: _jsx("td", { colSpan: 3, style: { ...cell, textAlign: 'left', color: 'var(--muted)' }, children: "Nobody has compiled in this period." }) })) : null] })] })] })] })] }));
}
