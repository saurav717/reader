import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { FINISHED_AT, statusOf } from '../lib/status';
import { relativeDay } from '../lib/libraryLook';
import { CoverTile, ProgressRing, progressLabel } from './LibraryBits';
import { Continue, clip } from './HomeParts';
import { InboxView, ProjectsView, ResumeStrip, STALLED_DAYS, TodayView, inboxOf } from './HomeViews';
import { FindPapers } from './HomeSearch';
import { CollectionsBoard } from './HomeBoard';
import { HOME_TABS, TAB_ABOUT, TAB_LABEL, openingTab, readHomePrefs, writeHomePrefs } from '../lib/homeViews';
import { CheckIcon, ClockIcon, GridIcon, InboxIcon, OpenBookIcon, SearchIcon, StackIcon } from './icons';
const TAB_ICON = {
    search: _jsx(SearchIcon, { size: 15 }),
    board: _jsx(GridIcon, { size: 15 }),
    continue: _jsx(OpenBookIcon, { size: 15 }),
    today: _jsx(ClockIcon, { size: 15 }),
    projects: _jsx(StackIcon, { size: 15 }),
    inbox: _jsx(InboxIcon, { size: 15 }),
};
const DAY = 24 * 3600 * 1000;
const opened = (paper) => paper.lastOpenedAt ?? '';
const byOpened = (a, b) => opened(b).localeCompare(opened(a));
/** A key pressed while typing is text, not a shortcut. */
function isTyping(target) {
    const element = target;
    return Boolean(element && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)));
}
function greeting(now, name) {
    const hour = now.getHours();
    const part = hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const first = name?.trim().split(/\s+/)[0];
    return first ? `${part}, ${first}` : part;
}
/**
 * Home: where the app opens, and what R on the rail comes back to. The paper
 * you were last reading fills it, shown at the page you left it on, with what
 * else is in progress, your latest highlights and what is next beside it.
 */
export default function Home({ returnTo, returnFromThisVisit, onOpenPaper, onOpenHighlight, onSearch, onDiscover, onShowNotes }) {
    const { papers, highlights, user } = useStore();
    const now = new Date();
    const [prefs, setPrefs] = useState(readHomePrefs);
    const [tab, setTab] = useState(() => openingTab(prefs));
    const [menuOpen, setMenuOpen] = useState(false);
    /** A question handed to Find papers from elsewhere on Home: a column's “search everywhere”. */
    const [findAsk, setFindAsk] = useState(null);
    const changePrefs = (next) => {
        setPrefs(next);
        writeHomePrefs(next);
    };
    const show = (next) => {
        setTab(next);
        changePrefs({ ...prefs, last: next });
    };
    const tabs = HOME_TABS.filter((item) => prefs.tabs.includes(item));
    // The paper to carry on with: the last one opened that isn't finished; failing
    // that, the last one opened; failing that, the newest one not started.
    const hero = useMemo(() => {
        const openedOnes = papers.filter((paper) => paper.lastOpenedAt).sort(byOpened);
        return (openedOnes.find((paper) => paper.progress < FINISHED_AT) ??
            openedOnes[0] ??
            papers.filter((paper) => statusOf(paper) === 'unread').sort((a, b) => b.addedAt.localeCompare(a.addedAt))[0] ??
            null);
    }, [papers]);
    const inProgress = useMemo(() => papers.filter((paper) => statusOf(paper) === 'reading' && paper.id !== hero?.id).sort(byOpened).slice(0, 4), [papers, hero]);
    const upNext = useMemo(() => papers
        .filter((paper) => statusOf(paper) === 'unread' && paper.id !== hero?.id)
        .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
        .slice(0, 3), [papers, hero]);
    const recent = useMemo(() => {
        const known = new Set(papers.map((paper) => paper.id));
        return highlights
            .filter((highlight) => !highlight.orphaned && known.has(highlight.paperId))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 3);
    }, [highlights, papers]);
    // 1–4 switch between the views shown as tabs.
    const showRef = useRef(show);
    showRef.current = show;
    useEffect(() => {
        const onKey = (event) => {
            if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target) || !/^[1-9]$/.test(event.key))
                return;
            if (document.querySelector('.scrim, .sheet, .palette'))
                return;
            const next = tabs[Number(event.key) - 1];
            if (!next)
                return;
            event.preventDefault();
            showRef.current(next);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [tabs]);
    const fresh = useMemo(() => inboxOf(papers).fresh.length, [papers]);
    // Enter carries on reading, as the button says.
    useEffect(() => {
        if (!hero)
            return;
        const onKey = (event) => {
            if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || isTyping(event.target))
                return;
            if (document.querySelector('.scrim, .sheet, .palette'))
                return;
            // A focused button or link on Home answers Enter itself; R, just
            // clicked to come here, is not asked again.
            if (event.target?.closest?.('.home :is(button, a)'))
                return;
            event.preventDefault();
            onOpenPaper(hero.id);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [hero, onOpenPaper]);
    const titleOf = (id) => papers.find((paper) => paper.id === id)?.title ?? '';
    return (_jsx("div", { className: "main home", children: _jsxs("div", { className: "home-scroll", children: [_jsxs("header", { className: "home-bar", children: [_jsxs("div", { className: "home-hello", children: [_jsx("span", { className: "home-eyebrow", children: now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) }), _jsx("h1", { children: greeting(now, user?.name) })] }), returnTo && tab !== 'continue' ? (_jsxs("button", { type: "button", className: "home-back", onClick: () => onOpenPaper(returnTo.id), title: `${returnTo.title} — G goes between Home and this paper`, children: [_jsx(OpenBookIcon, { size: 17 }), _jsxs("span", { className: "home-back-text", children: [_jsx("small", { children: returnFromThisVisit ? 'Back to reading' : 'Continue reading' }), _jsx("b", { children: clip(returnTo.title, 44) })] }), _jsx("kbd", { children: "G" })] })) : null, _jsxs("nav", { className: "home-tabs", "aria-label": "Home view", children: [tabs.map((item, index) => (_jsxs("button", { type: "button", className: `home-tab${tab === item ? ' is-on' : ''}`, "aria-pressed": tab === item, title: `${TAB_ABOUT[item]} (${index + 1})`, onClick: () => show(item), children: [TAB_ICON[item], TAB_LABEL[item], prefs.opensOn === item ? _jsx("em", { children: "default" }) : null, item === 'inbox' && fresh ? _jsx("b", { "aria-label": `${fresh} new`, children: fresh }) : null] }, item))), _jsxs("span", { className: "home-tabs-more", children: [_jsx("button", { type: "button", className: `home-tab${menuOpen ? ' is-on' : ''}`, "aria-expanded": menuOpen, "aria-label": "Choose Home's views", title: "Choose Home's views", onClick: () => setMenuOpen(!menuOpen), children: "\u22EF" }), menuOpen ? _jsx(ViewMenu, { prefs: prefs, onChange: changePrefs, onClose: () => setMenuOpen(false) }) : null] })] }), _jsxs("button", { type: "button", className: "home-search", onClick: onSearch, children: [_jsx(SearchIcon, { size: 16 }), _jsx("span", { children: "Search your library, or find a paper\u2026" }), _jsx("kbd", { children: "\u2318K" })] })] }), tab === 'search' ? (_jsx(FindPapers, { hero: hero, ask: findAsk?.query, focusBox: !returnFromThisVisit, saveTo: prefs.saveTo, onSaveTo: (id) => changePrefs({ ...prefs, saveTo: id }), onOpenPaper: onOpenPaper, onDiscover: (query) => window.dispatchEvent(new CustomEvent('reader:discover', { detail: { query } })) }, findAsk?.at ?? 'find')) : tab === 'board' ? (_jsx(CollectionsBoard, { onOpenPaper: onOpenPaper, onFind: (query) => {
                        setFindAsk({ query, at: Date.now() });
                        show('search');
                    } })) : tab === 'today' ? (_jsx(TodayView, { hero: hero, onOpenPaper: onOpenPaper, onShowNotes: onShowNotes })) : tab === 'projects' ? (_jsx(ProjectsView, { hero: hero, onOpenPaper: onOpenPaper })) : tab === 'inbox' ? (_jsx(InboxView, { onOpenPaper: onOpenPaper })) : !hero ? (_jsxs("div", { className: "home-empty", children: [_jsx("h2", { children: "Your library is empty" }), _jsx("p", { children: "Find a paper to read \u2014 search by title, author or topic, or paste an arXiv id or DOI. Home will pick up where you leave off." }), _jsxs("button", { type: "button", className: "btn primary", onClick: onDiscover, children: [_jsx(SearchIcon, { size: 15 }), " Find papers"] })] })) : (_jsxs("div", { className: "home-grid", children: [_jsx(Continue, { paper: hero, now: now, onOpen: () => onOpenPaper(hero.id) }), _jsxs("aside", { className: "home-side", children: [inProgress.length ? (_jsxs("section", { className: "home-card", children: [_jsx("h2", { className: "home-eyebrow", children: "Also in progress" }), inProgress.map((paper) => {
                                            const idle = paper.lastOpenedAt ? Math.floor((now.getTime() - new Date(paper.lastOpenedAt).getTime()) / DAY) : 0;
                                            return (_jsxs("button", { type: "button", className: "home-row", onClick: () => onOpenPaper(paper.id), children: [_jsx(ProgressRing, { progress: paper.progress, size: 28 }), _jsxs("span", { className: "home-row-text", children: [_jsx("span", { className: "home-row-title", children: paper.title }), _jsxs("span", { className: "home-row-sub", children: [progressLabel(paper.progress), paper.lastOpenedAt ? ' · ' : '', idle >= STALLED_DAYS ? _jsxs("span", { className: "home-stalled", children: ["not opened for ", idle, " days"] }) : paper.lastOpenedAt ? relativeDay(paper.lastOpenedAt, now) : ''] })] })] }, paper.id));
                                        })] })) : null, recent.length ? (_jsxs("section", { className: "home-card", children: [_jsx("h2", { className: "home-eyebrow", children: "Recent highlights" }), recent.map((highlight) => (_jsxs("button", { type: "button", className: "home-hl", onClick: () => onOpenHighlight(highlight.paperId, highlight.id), children: [_jsx("span", { className: `home-hl-quote hl-bg-${highlight.color}`, children: clip(highlight.exact, 150) }), _jsxs("span", { className: "home-row-sub", children: [_jsx("span", { className: `home-dot dot-${highlight.color}` }), " ", clip(titleOf(highlight.paperId), 60), highlight.note ? ' · with a note' : ''] })] }, highlight.id)))] })) : null, upNext.length ? (_jsxs("section", { className: "home-card", children: [_jsx("h2", { className: "home-eyebrow", children: "Up next" }), upNext.map((paper) => (_jsxs("button", { type: "button", className: "home-row", onClick: () => onOpenPaper(paper.id), children: [_jsx(CoverTile, { paper: paper, size: "mini" }), _jsxs("span", { className: "home-row-text", children: [_jsx("span", { className: "home-row-title", children: paper.title }), _jsxs("span", { className: "home-row-sub", children: ["added ", relativeDay(paper.addedAt, now)] })] })] }, paper.id)))] })) : null] })] })), tab !== 'continue' && tab !== 'search' && hero && statusOf(hero) === 'reading' ? _jsx(ResumeStrip, { paper: hero, onOpen: () => onOpenPaper(hero.id) }) : null] }) }));
}
/** Which view Home opens on, and which are tabs. */
function ViewMenu({ prefs, onChange, onClose }) {
    const box = useRef(null);
    useEffect(() => {
        const onDown = (event) => {
            if (box.current && !box.current.parentElement?.contains(event.target))
                onClose();
        };
        const onKey = (event) => {
            if (event.key === 'Escape')
                onClose();
        };
        window.addEventListener('pointerdown', onDown);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('pointerdown', onDown);
            window.removeEventListener('keydown', onKey);
        };
    }, [onClose]);
    const opensOn = (value) => {
        // A view Home opens on is one of its tabs.
        const tabs = value === 'last' || prefs.tabs.includes(value) ? prefs.tabs : HOME_TABS.filter((item) => item === value || prefs.tabs.includes(item));
        onChange({ ...prefs, opensOn: value, tabs });
    };
    // The view Home opens on stays a tab; any other can be put away.
    const fixed = (item) => item === prefs.opensOn || (prefs.opensOn === 'last' && prefs.tabs.length === 1 && prefs.tabs[0] === item);
    const toggle = (item) => {
        if (fixed(item))
            return;
        const tabs = prefs.tabs.includes(item) ? prefs.tabs.filter((other) => other !== item) : HOME_TABS.filter((other) => other === item || prefs.tabs.includes(other));
        onChange({ ...prefs, tabs });
    };
    return (_jsxs("div", { ref: box, className: "home-menu", role: "dialog", "aria-label": "Home's views", children: [_jsx("p", { className: "home-eyebrow", children: "Home opens on" }), [...HOME_TABS, 'last'].map((item) => (_jsxs("label", { className: `home-menu-opt${prefs.opensOn === item ? ' is-on' : ''}`, children: [_jsx("input", { type: "radio", name: "home-opens-on", checked: prefs.opensOn === item, onChange: () => opensOn(item) }), _jsxs("span", { children: [_jsx("b", { children: item === 'last' ? 'Whichever I used last' : TAB_LABEL[item] }), item === 'last' ? null : _jsx("small", { children: TAB_ABOUT[item] })] })] }, item))), _jsx("p", { className: "home-eyebrow home-menu-split", children: "Show as tabs" }), _jsx("div", { className: "home-menu-tabs", children: HOME_TABS.map((item) => (_jsxs("label", { className: fixed(item) ? 'is-fixed' : undefined, title: fixed(item) ? 'Home opens on it, so it stays' : undefined, children: [_jsx("input", { type: "checkbox", checked: prefs.tabs.includes(item), disabled: fixed(item), onChange: () => toggle(item) }), prefs.tabs.includes(item) ? _jsx(CheckIcon, { size: 11, strokeWidth: 3, className: "home-menu-tick" }) : null, TAB_LABEL[item]] }, item))) }), _jsxs("label", { className: "home-menu-check", children: [_jsx("input", { type: "checkbox", checked: prefs.clearPanels, onChange: () => onChange({ ...prefs, clearPanels: !prefs.clearPanels }) }), _jsxs("span", { children: [_jsx("b", { children: "Put the side panels away on Home" }), _jsx("small", { children: "The library and the dock close while you are on Home, and come back as they were when you open a paper." })] })] }), _jsxs("p", { className: "home-menu-foot", children: [_jsx("kbd", { children: "1" }), "\u2013", _jsx("kbd", { children: Math.min(9, prefs.tabs.length) }), " switch views \u00B7 ", _jsx("kbd", { children: "/" }), " search \u00B7 ", _jsx("kbd", { children: "R" }), " in a paper opens your desk"] })] }));
}
