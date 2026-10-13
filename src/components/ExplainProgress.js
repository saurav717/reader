import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { MODELS, modelSpec, PROVIDERS } from '../lib/assistant';
import { explanationsAtWork, subscribeExplain } from '../lib/explain';
import { implementationsAtWork, subscribeImplement } from '../lib/implement';
import { useStore } from '../lib/store';
import { lastThought, openExplainOn } from './Explain';
import { ExplainIcon, PlanIcon } from './icons';
/** The explanation is "At a glance", four to eight sections and "Since then"; the plan is ten, in order. */
const EXPECTED = { explain: 8, implement: 10 };
/**
 * How far along a page is, 0–1, or null when there is no telling (a request
 * from the bar edits whichever sections it needs). A first page is measured by
 * its sections: they are asked for in a known number, so the heading being
 * written says roughly where it is.
 */
export function progressOf(page, entry) {
    if (!entry.streaming)
        return null;
    const heads = (entry.content.match(/^## /gm) ?? []).length;
    if (!heads)
        return entry.content ? 0.05 : 0.02;
    if (page === 'explain' && /^## Since then/im.test(entry.content))
        return 0.93;
    return Math.min(0.95, Math.max(0.05, (heads - 0.5) / EXPECTED[page]));
}
const clock = (ms) => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
/** Every page being written or revised, less the one whose Explain is open; re-rendered each second while there are any. */
function useJobs(showing) {
    const [, setTick] = useState(0);
    const jobs = [
        ...explanationsAtWork().map((entry) => ({ page: 'explain', entry })),
        ...implementationsAtWork().map((entry) => ({ page: 'implement', entry })),
    ].filter((job) => job.entry.paperId !== showing);
    const working = jobs.length > 0;
    useEffect(() => {
        const bump = () => setTick((n) => n + 1);
        const offExplain = subscribeExplain(bump);
        const offImplement = subscribeImplement(bump);
        return () => {
            offExplain();
            offImplement();
        };
    }, []);
    // The clock ticks only while something is being written.
    useEffect(() => {
        if (!working)
            return;
        const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
        return () => window.clearInterval(timer);
    }, [working]);
    return jobs;
}
/** What a job says about itself: the paper, how far, how long, what it is on. */
function describeJob({ page, entry }, titleOf) {
    const progress = progressOf(page, entry);
    const writer = PROVIDERS[modelSpec(entry.model).provider].name;
    const heads = entry.content.match(/^## +(.+)$/gm) ?? [];
    const now = heads.length ? heads[heads.length - 1].replace(/^## +/, '') : '';
    const thought = lastThought(entry.thinking);
    return {
        label: page === 'implement' ? 'Implementation' : 'Explanation',
        title: titleOf(entry.paperId) ?? 'A paper',
        model: MODELS.find((m) => m.id === entry.model)?.label ?? writer,
        percent: progress === null ? null : Math.round(progress * 100),
        elapsed: clock(Date.now() - (entry.pending?.started ?? entry.created)),
        doing: entry.pending
            ? `Revising — ${entry.pending.request}`
            : thought
                ? `Thinking — ${thought}`
                : entry.content
                    ? `Writing — ${now || 'the opening'}`
                    : 'Reading the paper',
    };
}
/** A ring round the page's icon: filled as far as it has got, or turning when there is no telling. */
function Ring({ page, percent, size = 36 }) {
    const R = 15;
    const C = 2 * Math.PI * R;
    return (_jsxs("span", { className: `ep-ring${percent === null ? ' is-open' : ''}`, style: { width: size, height: size }, "aria-hidden": "true", children: [_jsxs("svg", { viewBox: "0 0 36 36", width: size, height: size, children: [_jsx("circle", { className: "ep-track", cx: "18", cy: "18", r: R }), _jsx("circle", { className: "ep-fill", cx: "18", cy: "18", r: R, strokeDasharray: C, strokeDashoffset: percent === null ? C * 0.72 : C * (1 - percent / 100) })] }), _jsx("span", { className: "ep-icon", children: page === 'implement' ? _jsx(PlanIcon, { size: size > 30 ? 13 : 12 }) : _jsx(ExplainIcon, { size: size > 30 ? 13 : 12 }) })] }));
}
function Bar({ percent }) {
    return (_jsx("span", { className: `ep-bar${percent === null ? ' is-open' : ''}`, "aria-hidden": "true", children: _jsx("i", { style: percent === null ? undefined : { width: `${percent}%` } }) }));
}
/** The whole story of one job: the card in the rail's popover. */
function Card({ job, titleOf }) {
    const d = describeJob(job, titleOf);
    return (_jsxs(_Fragment, { children: [_jsxs("span", { className: "ep-top", children: [_jsx("b", { children: d.label }), _jsxs("span", { className: "ep-meta", children: [d.percent === null ? '' : `${d.percent}% · `, _jsx("span", { className: "ep-clock", children: d.elapsed })] })] }), _jsx("span", { className: "ep-paper", children: d.title }), _jsx("span", { className: "ep-doing", children: d.doing }), _jsx(Bar, { percent: d.percent }), _jsxs("span", { className: "ep-foot", children: [d.model, " \u00B7 ", _jsx("u", { children: "Open" })] })] }));
}
/**
 * In the left rail, under Ask AI, while Explain is closed and a page is still
 * being written or revised: a ring for each, filled as far as it has got, with
 * the percentage under it. Pointing at it shows the paper, a clock and what it
 * is on; clicking opens it. It takes no room from what is being read.
 */
export function RailProgress({ showing, onOpen }) {
    const { papers } = useStore();
    const jobs = useJobs(showing);
    if (!jobs.length)
        return null;
    const titleOf = (id) => papers.find((p) => p.id === id)?.title;
    const open = (job) => {
        openExplainOn(job.entry.paperId, job.page);
        onOpen(job.entry.paperId);
    };
    return (_jsx("div", { className: "rail-progress", "aria-live": "polite", children: jobs.map((job) => {
            const d = describeJob(job, titleOf);
            return (_jsxs("div", { className: "rail-progress-item", children: [_jsxs("button", { type: "button", className: "rail-progress-btn", onClick: () => open(job), "aria-label": `${d.label} of “${d.title}”: ${d.percent === null ? 'revising' : `${d.percent}%`}, ${d.elapsed} — open it`, children: [_jsx(Ring, { page: job.page, percent: d.percent, size: 34 }), _jsx("span", { className: "rail-progress-pct", children: d.percent === null ? d.elapsed : `${d.percent}%` })] }), _jsx("div", { className: "rail-progress-pop", role: "tooltip", children: _jsx(Card, { job: job, titleOf: titleOf }) })] }, `${job.page}:${job.entry.paperId}`));
        }) }));
}
