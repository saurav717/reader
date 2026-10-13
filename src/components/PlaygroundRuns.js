import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Running playgrounds, around the app. src/lib/playgroundRuns.ts says what
// each playground is doing; this draws it, in the ways the person has chosen
// (Settings → Running playgrounds, settings.runningShows):
//
// - shelf    the Playground home's "Running now" shelf, and a state on each row of its list;
// - dock     a count on the rail's Playground button, a dock in the corner of every page, a toast as a run ends;
// - switcher P opens a switcher — running first, then what needs a look, then the rest;
// - tabs     the playgrounds opened in this tab, as tabs across the top of every page.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadPlaygrounds, usePlaygrounds } from '../lib/playground';
import { ago, clock, closeTab, isLive, phaseLabel, phaseNote, shutDownPlayground, stopPlayground, useRunBoard, useRunEnded, useTabs } from '../lib/playgroundRuns';
import { useStore } from '../lib/store';
import { ColabMark } from './Colab';
import { ChevronDownIcon, CloseIcon } from './icons';
/** Every playground's standing, the live ones first. */
export function useRuns() {
    return useRunBoard(usePlaygrounds());
}
const tone = (run) => run.phase === 'running' || run.phase === 'connecting' ? 'run' : run.phase === 'paused' || run.phase === 'idle' ? 'warm' : run.phase === 'failed' ? 'bad' : run.phase === 'ran' ? 'done' : 'cold';
/** The machine's mark: co for Colab, else a computer's. */
function Where({ run }) {
    return (_jsxs("span", { className: "pr-where", children: [run.where.startsWith('Colab') ? _jsx(ColabMark, {}) : _jsx("span", { className: "pg-mark is-pc", children: "PC" }), _jsx("span", { children: run.where })] }));
}
export function RunPill({ run }) {
    return (_jsxs("span", { className: `pr-pill is-${tone(run)}`, children: [_jsx("i", { "aria-hidden": "true" }), phaseLabel(run)] }));
}
function Progress({ run }) {
    const value = run.progress;
    return (_jsx("span", { className: `pr-bar${value === null || value === undefined ? ' is-unknown' : ''}`, role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": value === null || value === undefined ? undefined : Math.round(value * 100), children: _jsx("i", { style: value === null || value === undefined ? undefined : { width: `${Math.max(2, Math.round(value * 100))}%` } }) }));
}
// ------------------------------------------------------------ shelf ----
/** The Playground home's top shelf: each playground running now, what it is on, its last line, Stop and Open. */
export function RunningShelf({ runs, onOpen }) {
    const live = runs.filter(isLive);
    if (!live.length)
        return null;
    return (_jsxs("section", { className: "pr-shelf", "aria-label": "Running now", children: [_jsxs("div", { className: "pg-section-head", children: [_jsxs("span", { className: "eyebrow pr-live-head", children: [_jsx("i", { className: "pr-dot is-run", "aria-hidden": "true" }), "Running now \u00B7 ", live.length] }), _jsx("span", { className: "pg-aside", children: "it keeps going when you leave this page \u2014 it runs on the machine, not in the page" })] }), _jsx("div", { className: "pr-cards", children: live.map((run) => (_jsxs("article", { className: "pr-card", children: [_jsxs("div", { className: "pr-card-head", children: [_jsx("i", { className: "pr-dot is-run", "aria-hidden": "true" }), _jsx("b", { title: run.title, children: run.title }), _jsx(Where, { run: run })] }), _jsxs("div", { className: "pr-card-now", children: [_jsxs("span", { children: [run.phase === 'paused' ? 'Paused' : run.phase === 'connecting' ? 'Connecting…' : run.label, run.code ? _jsxs("code", { children: [" \u00B7 ", run.code] }) : null] }), _jsx("span", { className: "pr-mono", children: run.startedAt ? clock(Date.now() - run.startedAt) : '' })] }), _jsx(Progress, { run: run }), _jsx("div", { className: "pr-tail", children: run.tail ?? 'no output yet' }), _jsxs("div", { className: "pr-card-foot", children: [_jsx("span", { children: run.queued ? `${run.queued} more ${run.queued === 1 ? 'cell' : 'cells'} queued` : run.also?.length ? `also: ${run.also.join(', ')}` : run.kind === 'project' ? 'Project' : 'Notebook' }), _jsx("span", { className: "spacer" }), _jsx("button", { type: "button", className: "btn sm pr-stop", onClick: () => void stopPlayground(run.id), children: "Stop" }), _jsx("button", { type: "button", className: "btn sm primary", onClick: () => onOpen(run.id), children: "Open" })] })] }, run.id))) })] }));
}
/** A row's state in the home's list: the pill, and what coming back to it will be like. */
export function RunRowState({ run }) {
    return (_jsxs("span", { className: "pr-row-state", children: [_jsx(RunPill, { run: run }), _jsx("small", { children: phaseNote(run) })] }));
}
/** What can be done from a row besides Open: stop a run, or shut down a kernel left idle. */
export function RunRowAction({ run }) {
    if (isLive(run))
        return (_jsx("button", { type: "button", className: "btn sm pr-stop", onClick: () => void stopPlayground(run.id), children: "Stop" }));
    if (run.phase === 'idle')
        return (_jsx("button", { type: "button", className: "btn sm", onClick: () => void shutDownPlayground(run.id), title: run.where.startsWith('Colab') ? 'Stops the Colab runtime: its variables go, and it uses no more units' : 'Shuts the kernel down: its variables go', children: "Shut down" }));
    return null;
}
// -------------------------------------------------------- the rail ----
/** On the rail's Playground button: how many run, and on hover, what each is doing. */
export function RailRunBadge({ onOpen }) {
    const runs = useRuns();
    const live = runs.filter(isLive);
    const idle = runs.filter((run) => run.phase === 'idle');
    if (!live.length && !idle.length)
        return null;
    return (_jsxs(_Fragment, { children: [_jsx("span", { className: `pr-badge${live.length ? '' : ' is-idle'}`, "aria-label": live.length ? `${live.length} running` : 'a kernel is idle', children: live.length || '' }), _jsxs("div", { className: "pr-rail-pop", role: "tooltip", children: [_jsx("b", { children: "Playground" }), [...live, ...idle].map((run) => (_jsxs("button", { type: "button", onClick: () => onOpen(run.id), children: [_jsx("i", { className: `pr-dot is-${tone(run)}`, "aria-hidden": "true" }), _jsx("span", { children: run.title }), _jsx("small", { children: isLive(run) ? run.label ?? phaseLabel(run) : 'idle' })] }, run.id)))] })] }));
}
// ---------------------------------------------------------- the dock ----
const FOLD_KEY = 'reader.playground.dock-folded';
const readFold = () => {
    try {
        return localStorage.getItem(FOLD_KEY) === '1';
    }
    catch {
        return false;
    }
};
/**
 * In the corner of every page but the running playground's own, while
 * something runs: each run, how far it has got, Stop and Open. It folds to a
 * pill, and goes when nothing runs. Toasts stack over it as runs end.
 */
export function RunDock({ current, onOpen }) {
    const runs = useRuns();
    const live = runs.filter((run) => isLive(run) && run.id !== current);
    const [folded, setFolded] = useState(readFold);
    const fold = (next) => {
        setFolded(next);
        try {
            localStorage.setItem(FOLD_KEY, next ? '1' : '0');
        }
        catch {
            // Only a convenience.
        }
    };
    return (_jsxs("div", { className: "pr-corner", children: [_jsx(RunToasts, { current: current, onOpen: onOpen }), live.length ? (folded ? (_jsxs("button", { type: "button", className: "pr-dock-pill", onClick: () => fold(false), "aria-label": `${live.length} running — show them`, children: [_jsx("i", { className: "pr-dot is-run", "aria-hidden": "true" }), "Running \u00B7 ", live.length, live.length === 1 && live[0].progress !== null && live[0].progress !== undefined ? _jsxs("span", { className: "pr-mono", children: [" ", Math.round(live[0].progress * 100), "%"] }) : null] })) : (_jsxs("section", { className: "pr-dock", "aria-label": "Running playgrounds", children: [_jsxs("header", { children: [_jsx("i", { className: "pr-dot is-run", "aria-hidden": "true" }), _jsxs("b", { children: ["Running \u00B7 ", live.length] }), _jsx("span", { className: "spacer" }), _jsx("button", { type: "button", className: "icon-btn sm", "aria-label": "Fold the dock", title: "Fold", onClick: () => fold(true), children: _jsx(ChevronDownIcon, { size: 14 }) })] }), live.map((run) => (_jsxs("div", { className: "pr-job", children: [_jsxs("div", { className: "pr-job-top", children: [_jsx(Where, { run: run }), _jsx("b", { title: run.title, children: run.title }), _jsx("span", { className: "pr-mono", children: run.phase === 'paused' ? 'paused' : run.label })] }), _jsx(Progress, { run: run }), run.also?.length ? _jsxs("div", { className: "pr-job-also", children: ["also ", run.also.join(' · ')] }) : null, _jsxs("div", { className: "pr-job-foot", children: [_jsx("span", { className: "pr-mono", children: run.tail ?? (run.startedAt ? clock(Date.now() - run.startedAt) : '') }), _jsx("button", { type: "button", className: "link pr-stop", onClick: () => void stopPlayground(run.id), children: "Stop" }), _jsx("button", { type: "button", className: "link", onClick: () => onOpen(run.id), children: "Open \u2192" })] })] }, run.id)))] }))) : null] }));
}
/** A toast as each run ends — off its own page — saying how it ended; it goes after a few seconds. */
function RunToasts({ current, onOpen }) {
    const [toasts, setToasts] = useState([]);
    const currentRef = useRef(current);
    currentRef.current = current;
    const add = useCallback((event) => {
        if (event.id === currentRef.current)
            return;
        setToasts((list) => [...list.filter((t) => t.id !== event.id), event].slice(-3));
        window.setTimeout(() => setToasts((list) => list.filter((t) => t !== event)), 9000);
    }, []);
    useRunEnded(add);
    if (!toasts.length)
        return null;
    return (_jsx("div", { className: "pr-toasts", "aria-live": "polite", children: toasts.map((toast) => (_jsxs("div", { className: `pr-toast is-${toast.phase}`, children: [_jsx("span", { className: "pr-toast-mark", "aria-hidden": "true", children: toast.phase === 'ran' ? '✓' : toast.phase === 'failed' ? '!' : '■' }), _jsxs("div", { children: [_jsxs("b", { children: [toast.title, " ", toast.phase === 'ran' ? 'finished' : toast.phase === 'failed' ? 'failed' : 'stopped'] }), _jsx("span", { children: toast.detail }), _jsxs("div", { className: "pr-toast-acts", children: [_jsx("button", { type: "button", className: "btn sm primary", onClick: () => {
                                        setToasts((list) => list.filter((t) => t !== toast));
                                        onOpen(toast.id);
                                    }, children: toast.phase === 'failed' ? 'See the error' : 'See results' }), _jsx("button", { type: "button", className: "btn sm", onClick: () => setToasts((list) => list.filter((t) => t !== toast)), children: "Later" })] })] })] }, `${toast.id}:${toast.at}`))) }));
}
// ------------------------------------------------------ the switcher ----
/** P's switcher: running first, then what needs a look (failed, idle), then the rest; typed letters narrow it. */
export function RunSwitcher({ onOpen, onHome, onClose, onPeek }) {
    useEffect(() => {
        void loadPlaygrounds();
    }, []);
    const runs = useRuns();
    const [query, setQuery] = useState('');
    const [at, setAt] = useState(0);
    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        return runs.filter((run) => !q || run.title.toLowerCase().includes(q) || run.where.toLowerCase().includes(q)).slice(0, 12);
    }, [runs, query]);
    const groups = [
        { title: 'Running', tone: 'run', items: shown.filter(isLive) },
        { title: 'Needs a look', items: shown.filter((run) => run.phase === 'failed' || run.phase === 'idle') },
        { title: 'Pick up where you left off', items: shown.filter((run) => !isLive(run) && run.phase !== 'failed' && run.phase !== 'idle') },
    ].filter((group) => group.items.length);
    const flat = groups.flatMap((group) => group.items);
    const pick = Math.min(at, Math.max(0, flat.length));
    const go = (index) => {
        onClose();
        if (index >= flat.length)
            onHome();
        else
            onOpen(flat[index].id);
    };
    const keys = (event) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setAt((n) => Math.min(flat.length, n + 1));
        }
        else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setAt((n) => Math.max(0, n - 1));
        }
        else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && onPeek && pick < flat.length) {
            event.preventDefault();
            onClose();
            onPeek(flat[pick].id);
        }
        else if (event.key === 'Enter') {
            event.preventDefault();
            go(pick);
        }
        else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
        }
    };
    let index = -1;
    return (_jsxs(_Fragment, { children: [_jsx("div", { className: "scrim pr-scrim", onClick: onClose }), _jsxs("div", { className: "pr-switch", role: "dialog", "aria-label": "Go to a playground", onKeyDown: keys, children: [_jsxs("div", { className: "pr-switch-q", children: [_jsx("input", { autoFocus: true, value: query, onChange: (event) => {
                                    setQuery(event.target.value);
                                    setAt(0);
                                }, placeholder: "Go to a playground\u2026", "aria-label": "Find a playground" }), _jsx("kbd", { children: "esc" })] }), _jsxs("div", { className: "pr-switch-list", role: "listbox", children: [groups.map((group) => (_jsxs("div", { className: "pr-switch-group", children: [_jsx("span", { className: `eyebrow${group.tone ? ' pr-live-head' : ''}`, children: group.title }), group.items.map((run) => {
                                        index += 1;
                                        const mine = index;
                                        return (_jsxs("button", { type: "button", role: "option", "aria-selected": pick === mine, className: `pr-switch-item${pick === mine ? ' is-on' : ''}`, onMouseEnter: () => setAt(mine), onClick: () => go(mine), children: [_jsx("i", { className: `pr-dot is-${tone(run)}`, "aria-hidden": "true" }), _jsxs("span", { className: "pr-switch-main", children: [_jsx("b", { children: run.title }), _jsxs("small", { children: [run.where, isLive(run) ? ` · ${run.label ?? phaseLabel(run)}` : run.at ? ` · ${ago(run.at)}` : ''] })] }), isLive(run) ? _jsx(Progress, { run: run }) : _jsx(RunPill, { run: run })] }, run.id));
                                    })] }, group.title))), _jsx("button", { type: "button", role: "option", "aria-selected": pick === flat.length, className: `pr-switch-item is-home${pick === flat.length ? ' is-on' : ''}`, onMouseEnter: () => setAt(flat.length), onClick: () => go(flat.length), children: _jsxs("span", { className: "pr-switch-main", children: [_jsx("b", { children: "The Playground\u2019s home" }), _jsx("small", { children: "start something new, or see every playground" })] }) })] }), _jsxs("div", { className: "pr-switch-foot", children: [_jsxs("span", { children: [_jsx("kbd", { children: "\u2191" }), " ", _jsx("kbd", { children: "\u2193" }), " move"] }), _jsxs("span", { children: [_jsx("kbd", { children: "\u21B5" }), " open"] }), onPeek ? (_jsxs("span", { children: [_jsx("kbd", { children: "\u2318" }), " ", _jsx("kbd", { children: "\u21B5" }), " beside the paper"] })) : (_jsxs("span", { children: [_jsx("kbd", { children: "P" }), " again from anywhere"] }))] })] })] }));
}
// ---------------------------------------------------------- the tabs ----
/** Across the top of every page: the playgrounds opened in this tab, and any running; each with its state. Closing one stops nothing. */
export function RunTabs({ current, onOpen }) {
    useEffect(() => {
        void loadPlaygrounds();
    }, []);
    const runs = useRuns();
    const tabs = useTabs();
    const shown = runs.filter((run) => tabs.includes(run.id) || isLive(run) || run.id === current).sort((a, b) => tabs.indexOf(a.id) - tabs.indexOf(b.id));
    if (!shown.length)
        return null;
    return (_jsx("nav", { className: "pr-tabs", "aria-label": "Open playgrounds", children: shown.map((run) => (_jsxs("div", { className: `pr-tab${run.id === current ? ' is-on' : ''}`, children: [_jsxs("button", { type: "button", className: "pr-tab-main", onClick: () => onOpen(run.id), title: `${run.title} — ${phaseLabel(run)} · ${run.where}`, "aria-current": run.id === current ? 'page' : undefined, children: [_jsx("i", { className: `pr-dot is-${tone(run)}`, "aria-hidden": "true" }), _jsx("span", { children: run.title }), isLive(run) && run.progress !== null && run.progress !== undefined ? _jsxs("small", { className: "pr-mono", children: [Math.round(run.progress * 100), "%"] }) : null] }), _jsx("button", { type: "button", className: "pr-tab-x", "aria-label": `Close the tab for ${run.title} (it goes on running)`, title: isLive(run) ? 'Close the tab — the run goes on' : 'Close the tab', onClick: () => closeTab(run.id), children: _jsx(CloseIcon, { size: 11 }) })] }, run.id))) }));
}
// ---------------------------------------------------------- choosing ----
export const RUNNING_SHOWS = [
    { id: 'shelf', label: 'A · Running now, on the Playground’s home', note: 'A shelf of what runs at the top of the Playground, and on each playground in its list whether it is idle, finished, failed or stopped.' },
    { id: 'dock', label: 'B · A dock and a count, on every page', note: 'A count on the rail’s Playground button, a dock in the corner while anything runs, and a toast when a run ends.' },
    { id: 'switcher', label: 'C · P opens a switcher', note: 'P from anywhere lists the playgrounds — running first — instead of going to the Playground’s home.' },
    { id: 'tabs', label: 'D · Tabs across the top', note: 'The playgrounds you opened in this tab stay as tabs above every page, with a live dot on each.' },
    { id: 'peek', label: 'E · Beside the paper', note: 'Reading a paper a playground cites, its cells sit at the side of the page, live — run one there, in the playground’s own kernel. ⌘↵ in P’s switcher puts any playground there.' },
];
/** The five ways, each a switch; A and B are what the app starts with. */
export function RunningChooser({ compact = false }) {
    const { settings, updateSettings } = useStore();
    const shows = settings.runningShows;
    const recommended = shows.shelf && shows.dock && !shows.switcher && !shows.tabs && !shows.peek;
    return (_jsxs("div", { className: `pr-choose${compact ? ' is-compact' : ''}`, children: [RUNNING_SHOWS.map((option) => (_jsxs("label", { className: "pr-choose-row", children: [_jsx("input", { type: "checkbox", checked: shows[option.id], onChange: (event) => updateSettings({ runningShows: { ...shows, [option.id]: event.target.checked } }) }), _jsxs("span", { children: [_jsx("strong", { children: option.label }), option.id === 'shelf' || option.id === 'dock' ? _jsx("em", { className: "pr-rec", children: "default" }) : null, _jsx("br", {}), _jsx("small", { children: option.note })] })] }, option.id))), _jsxs("div", { className: "pr-choose-foot", children: [_jsx("button", { type: "button", className: "btn sm", disabled: recommended, onClick: () => updateSettings({ runningShows: { shelf: true, dock: true, switcher: false, tabs: false, peek: false } }), children: "Back to the default (A and B)" }), _jsx("button", { type: "button", className: "btn sm ghost", onClick: () => updateSettings({ runningShows: { shelf: true, dock: true, switcher: true, tabs: true, peek: true } }), children: "All five" })] })] }));
}
