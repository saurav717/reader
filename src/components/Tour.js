import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { markTourSeen } from '../lib/tour';
import { CloseIcon } from './icons';
const K = ({ children }) => _jsx("kbd", { className: "tour-key", children: children });
const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = mac ? '⌘' : 'Ctrl';
let tabBefore = '';
const activeTab = () => document.querySelector('.home-tab.is-on')?.textContent ?? '';
/** Whether the dock is showing a pane — and not on its way out. */
const dockShows = (name) => document.querySelector('.dock-tabs [role="tab"][aria-selected="true"]')?.textContent?.trim() === name && !document.querySelector('.app.dock-slide-out');
const STEPS = [
    {
        id: 'welcome',
        place: 'any',
        title: 'Welcome to Reader',
        body: (_jsxs(_Fragment, { children: [_jsx("p", { children: "Search the indexes, keep what you collect, read it with highlights, and ask a model about it \u2014 all from one window." }), _jsxs("p", { children: ["This tour takes two minutes and points at the real thing. Where it says ", _jsx("em", { children: "try it" }), ", press the key and watch. ", _jsx(K, { children: "Esc" }), " leaves it at any step, and it is in Settings whenever you want it back."] })] })),
    },
    {
        id: 'rail',
        place: 'home',
        target: '.rail',
        title: 'The rail',
        body: (_jsxs(_Fragment, { children: [_jsxs("p", { children: [_jsx("b", { children: "R" }), " is Home. Under it: the paper you are reading, the ", _jsx("b", { children: "Library" }), " \u2014 your papers and collections \u2014 ", _jsx("b", { children: "Projects" }), ", ", _jsx("b", { children: "Code" }), " for the Playground, and at the foot, ", _jsx("b", { children: "Settings" }), "."] }), _jsx("p", { children: "Rest the pointer on anything for what it does and its key." })] })),
    },
    {
        id: 'views',
        place: 'home',
        target: '.home-tabs',
        title: 'Home’s views',
        body: (_jsx(_Fragment, { children: _jsxs("p", { children: [_jsx("b", { children: "Find papers" }), ", ", _jsx("b", { children: "Continue reading" }), ", ", _jsx("b", { children: "Today" }), ", ", _jsx("b", { children: "Inbox" }), ", ", _jsx("b", { children: "Collections" }), " \u2014 each a way of looking at your library, a number key apart. The ", _jsx("b", { children: "\u22EF" }), " at the end chooses which are shown and which Home opens on."] }) })),
        tryIt: {
            prompt: (_jsxs(_Fragment, { children: ["Press ", _jsx(K, { children: "2" }), " to switch to the next view"] })),
            begin: () => {
                tabBefore = activeTab();
            },
            done: () => activeTab() !== tabBefore,
        },
    },
    {
        id: 'find',
        place: 'home',
        target: '.find-hero',
        title: 'Find papers',
        body: (_jsxs(_Fragment, { children: [_jsxs("p", { children: ["One box over arXiv, OpenAlex, Semantic Scholar, Crossref and Google Scholar \u2014 or paste an arXiv id or a DOI. ", _jsx("b", { children: "Search in" }), " picks the indexes; ", _jsx("b", { children: "Save to" }), " is the collection the ", _jsx("b", { children: "+" }), " on each result adds it to, and a result can be dragged onto a collection instead."] }), _jsxs("p", { children: [_jsx(K, { children: "/" }), " focuses the box from anywhere on Home. Click a result for its abstract and every place it can be read from."] })] })),
    },
    {
        id: 'palette',
        place: 'home',
        target: '.home-search',
        title: 'Jump anywhere',
        body: (_jsx(_Fragment, { children: _jsx("p", { children: "The command palette finds a paper in your library by its title or an author, searches the indexes for one that is not there yet, and runs actions \u2014 making a collection, opening Settings, starting this tour." }) })),
        tryIt: {
            prompt: (_jsxs(_Fragment, { children: ["Press ", _jsxs(K, { children: [MOD, " K"] }), " to open it"] })),
            done: () => Boolean(document.querySelector('.palette')),
            after: (host) => host.closePalette(),
        },
    },
    {
        id: 'reading',
        place: 'paper',
        target: '.reader-head .topbar',
        title: 'Reading a paper',
        body: (_jsxs(_Fragment, { children: [_jsxs("p", { children: [_jsx("b", { children: "Reflow" }), " lays the paper out as text you can select and highlight; ", _jsx("b", { children: "PDF" }), " shows the file as it was typeset, and the book button puts two pages side by side. The download keeps the PDF; a cloud mark says it is already in your Drive."] }), _jsx("p", { children: "Rest the pointer on an author, the venue or a citation and a card says who, where, and what was cited." })] })),
    },
    {
        id: 'highlights',
        place: 'paper',
        target: '[title^="Highlights and notes"], [title^="Notes — "], .dock',
        title: 'Highlights and notes',
        body: (_jsxs(_Fragment, { children: [_jsxs("p", { children: ["Select a passage and pick a colour \u2014 four, each with a meaning you set. Right-click it instead for what a word ", _jsx("b", { children: "means" }), ", where the idea ", _jsx("b", { children: "comes from" }), ", and a ", _jsx("b", { children: "comment" }), " that highlights as you type."] }), _jsx("p", { children: "Everything you mark lands in the pane beside the page, and in your Drive and Git repository." })] })),
        tryIt: {
            prompt: (_jsxs(_Fragment, { children: ["Press ", _jsx(K, { children: "H" }), " to open the highlights beside the page"] })),
            begin: (host) => host.closeNotes(),
            done: () => dockShows('Notes') || Boolean(document.querySelector('.notes-window')),
            doneTarget: '.dock, .notes-window',
        },
    },
    {
        id: 'ask',
        place: 'paper',
        target: '[title^="Ask AI"]',
        title: 'Ask AI',
        body: (_jsx(_Fragment, { children: _jsxs("p", { children: ["A chat window floats over the paper and sees the page you are on. Ask it to explain a passage, or say ", _jsx("i", { children: "\u201Cshow me where\u2026\u201D" }), " and the paper scrolls to it. Claude, DeepSeek or Gemini \u2014 your pick, in Settings."] }) })),
        tryIt: {
            prompt: (_jsxs(_Fragment, { children: ["Press ", _jsxs(K, { children: [MOD, " \\"] }), " \u2014 or ", _jsxs(K, { children: [MOD, " J"] })] })),
            begin: (host) => host.closeAssistant(),
            done: () => Boolean(document.querySelector('.assistant-win')),
            after: (host) => host.closeAssistant(),
            doneTarget: '.assistant-win',
        },
    },
    {
        id: 'explain',
        place: 'paper',
        target: '.explain-toggle',
        title: 'Explain the whole paper',
        body: (_jsxs(_Fragment, { children: [_jsxs("p", { children: [_jsx(K, { children: "E" }), " opens an explanation of the paper, section by section: its figures close up, the maths worked, runnable code, and what has changed since it was published."] }), _jsx("p", { children: "It runs on the model you chose and costs a call, so the tour leaves this key for you." })] })),
    },
    {
        id: 'zen',
        place: 'paper',
        target: '[aria-label^="Zen mode"]',
        title: 'Just the paper',
        body: (_jsx(_Fragment, { children: _jsxs("p", { children: ["Zen puts the rail, the library, the dock and the top bar away; move the pointer to an edge of the screen and that side slides back. ", _jsx(K, { children: "F" }), " takes the paper full screen, and ", _jsx(K, { children: "R" }), " lays every paper in progress out as a desk, each at the line you left it."] }) })),
        tryIt: {
            prompt: (_jsxs(_Fragment, { children: ["Press ", _jsx(K, { children: "Z" }), " for zen mode"] })),
            begin: (host) => host.leaveZen(),
            done: () => Boolean(document.querySelector('.app.is-zen')),
            after: (host) => host.leaveZen(),
            doneTarget: null,
        },
    },
    {
        id: 'home',
        place: 'paper',
        target: '.topbar-home, .brand',
        title: 'Home and back',
        body: (_jsx(_Fragment, { children: _jsxs("p", { children: [_jsx(K, { children: "G" }), " goes between Home and the paper you are reading, both ways. On Home the paper waits in ", _jsx("b", { children: "Back to reading" }), " beside the greeting, and under ", _jsx("b", { children: "R" }), " on the rail."] }) })),
        tryIt: {
            prompt: (_jsxs(_Fragment, { children: ["Press ", _jsx(K, { children: "G" }), " to go Home"] })),
            done: (host) => host.atHome,
            doneTarget: '.home-back',
        },
    },
    {
        id: 'code',
        place: 'home',
        target: '[title^="Playground"]',
        title: 'Code of your own',
        body: (_jsx(_Fragment, { children: _jsxs("p", { children: [_jsx(K, { children: "P" }), " opens the Playground: a notebook or a project, run on your Colab, on this computer, or with the files here and a GPU somewhere else. Explain can hand it a paper\u2019s code to run, and a run goes on when you leave its page."] }) })),
    },
    {
        id: 'library',
        place: 'home',
        target: '.rail [aria-label="Library"], .rail [title^="The Library"]',
        title: 'Your library, yours',
        body: (_jsx(_Fragment, { children: _jsxs("p", { children: ["The Library is every paper you have saved, as ", _jsx("b", { children: "reading now" }), ", ", _jsx("b", { children: "not started" }), " and ", _jsx("b", { children: "finished" }), ", and your collections. Signed in, all of it \u2014 each paper, its highlights, the collections \u2014 lives in your own Google Drive, the same in any browser, and a Git repository can keep the notes and the bibliography beside it."] }) })),
    },
    {
        id: 'settings',
        place: 'home',
        target: '.rail [aria-label="Settings"], .rail [title^="Settings"]',
        title: 'Settings',
        body: (_jsx(_Fragment, { children: _jsx("p", { children: "Your Google account and the Git repository, the model keys for Ask AI and Explain, the paper proxy, the look of the app \u2014 light or dark, glass, how the rail is laid out \u2014 and this tour, to take again." }) })),
    },
    {
        id: 'done',
        place: 'any',
        title: 'That’s the tour',
        body: (_jsx(_Fragment, { children: _jsxs("p", { children: ["Take it again any time: ", _jsx("b", { children: "Settings \u2192 Guided tour" }), ", or ", _jsxs(K, { children: [MOD, " K"] }), " and ", _jsx("i", { children: "Take the tour" }), ". Happy reading."] }) })),
    },
];
/** The steps for this visit: without a paper to open, the reading steps are told, not shown. */
function stepsFor(hasPaper) {
    if (hasPaper)
        return STEPS;
    return STEPS.map((step) => (step.place === 'paper' ? { ...step, place: 'any', target: undefined, tryIt: undefined } : step));
}
/** How far the ring stands off its element, and the card off the ring. */
const PAD = 6;
const GAP = 18;
const EDGE = 12;
const CARD_WIDTH = 360;
function measure(selector) {
    if (!selector)
        return null;
    for (const candidate of Array.from(document.querySelectorAll(selector))) {
        const rect = candidate.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth) {
            return { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 };
        }
    }
    return null;
}
function sameBox(a, b) {
    if (!a || !b)
        return a === b;
    return Math.abs(a.top - b.top) < 0.5 && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}
/**
 * The guided tour: a ring round one part of the app at a time, the rest of
 * the screen shaded, and a card beside it saying what that part does. Some
 * steps ask for a key; the tour watches for what it opens, says so, and
 * moves on. Esc, or Skip, leaves it; Settings and the palette bring it back.
 */
export default function Tour({ host, onClose }) {
    const steps = stepsFor(host.hasPaper);
    const [index, setIndex] = useState(0);
    const [done, setDone] = useState(false);
    /** The step whose `begin` has run: what a step watches for is not looked at before its own has. */
    const [beganAt, setBeganAt] = useState(-1);
    const began = beganAt === index;
    const [box, setBox] = useState(null);
    const [cardHeight, setCardHeight] = useState(0);
    const card = useRef(null);
    const hostRef = useRef(host);
    hostRef.current = host;
    const step = steps[Math.min(index, steps.length - 1)];
    const last = index === steps.length - 1;
    // Entering a step: go where it is, and remember what it watches for.
    useEffect(() => {
        const current = hostRef.current;
        if (step.place === 'home' && !current.atHome)
            current.goHome();
        if (step.place === 'paper' && current.hasPaper && !current.reading)
            current.openPaper();
        // A step that opens something waits for the page it is on before it puts
        // that thing away: the paper's panels come back with the paper.
        const begin = () => {
            step.tryIt?.begin?.(hostRef.current);
            setBeganAt(index);
        };
        setDone(false);
        const timer = window.setTimeout(begin, step.place === 'paper' && !current.reading ? 400 : 0);
        return () => window.clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [index]);
    // Where the ring goes, followed as the page moves under it; and whether a
    // try-it step has been tried.
    useEffect(() => {
        const target = done && step.tryIt && step.tryIt.doneTarget !== undefined ? step.tryIt.doneTarget ?? undefined : step.target;
        const tick = () => {
            setBox((current) => {
                const next = measure(target);
                return sameBox(current, next) ? current : next;
            });
            if (began && step.tryIt && !done && step.tryIt.done(hostRef.current))
                setDone(true);
        };
        tick();
        const timer = window.setInterval(tick, 120);
        window.addEventListener('resize', tick);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener('resize', tick);
        };
    }, [step, done, began]);
    useLayoutEffect(() => {
        const element = card.current;
        if (!element)
            return;
        const watch = () => setCardHeight(element.offsetHeight);
        watch();
        const observer = new ResizeObserver(watch);
        observer.observe(element);
        return () => observer.disconnect();
    }, [step]);
    const leave = useCallback((finished) => {
        step.tryIt?.after?.(hostRef.current);
        markTourSeen();
        onClose();
        if (finished && !hostRef.current.atHome)
            hostRef.current.goHome();
    }, [step, onClose]);
    const next = useCallback(() => {
        step.tryIt?.after?.(hostRef.current);
        if (last)
            leave(true);
        else
            setIndex((current) => current + 1);
    }, [step, last, leave]);
    const back = useCallback(() => {
        step.tryIt?.after?.(hostRef.current);
        setIndex((current) => Math.max(0, current - 1));
    }, [step]);
    // A tried step moves on by itself, once its result has been seen.
    useEffect(() => {
        if (!done)
            return;
        const timer = window.setTimeout(next, 1400);
        return () => window.clearTimeout(timer);
    }, [done, next]);
    useEffect(() => {
        const onKey = (event) => {
            const target = event.target;
            // Enter on one of the card's buttons is that button's, not Home's.
            if (event.key === 'Enter' && target?.closest?.('.tour-card')) {
                event.stopPropagation();
                return;
            }
            // Something the step opened — the palette, a sheet — takes Esc first.
            if (document.querySelector('.palette, .sheet'))
                return;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                leave(false);
            }
            else if (event.key === 'ArrowRight') {
                event.preventDefault();
                next();
            }
            else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                back();
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [leave, next, back]);
    // The card: beside the ring where there is room — right, left, below, above — else in the middle.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(CARD_WIDTH, vw - EDGE * 2);
    const height = cardHeight || 240;
    const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
    let where;
    if (!box) {
        where = { top: (vh - height) / 2, left: (vw - width) / 2, side: 'middle' };
    }
    else if (box.left + box.width + GAP + width <= vw - EDGE) {
        where = { top: clamp(box.top + box.height / 2 - height / 2, EDGE, vh - height - EDGE), left: box.left + box.width + GAP, side: 'right' };
    }
    else if (box.left - GAP - width >= EDGE) {
        where = { top: clamp(box.top + box.height / 2 - height / 2, EDGE, vh - height - EDGE), left: box.left - GAP - width, side: 'left' };
    }
    else if (box.top + box.height + GAP + height <= vh - EDGE) {
        where = { top: box.top + box.height + GAP, left: clamp(box.left + box.width / 2 - width / 2, EDGE, vw - width - EDGE), side: 'below' };
    }
    else if (box.top - GAP - height >= EDGE) {
        where = { top: box.top - GAP - height, left: clamp(box.left + box.width / 2 - width / 2, EDGE, vw - width - EDGE), side: 'above' };
    }
    else {
        where = { top: (vh - height) / 2, left: (vw - width) / 2, side: 'middle' };
    }
    const tried = step.tryIt;
    const number = index + 1;
    return (_jsxs("div", { className: `tour${box ? ' has-ring' : ''}`, "data-step": step.id, children: [box ? (_jsxs(_Fragment, { children: [_jsx("div", { className: "tour-shade", style: { top: 0, left: 0, right: 0, height: Math.max(0, box.top) } }), _jsx("div", { className: "tour-shade", style: { top: box.top + box.height, left: 0, right: 0, bottom: 0 } }), _jsx("div", { className: "tour-shade", style: { top: box.top, left: 0, width: Math.max(0, box.left), height: box.height } }), _jsx("div", { className: "tour-shade", style: { top: box.top, left: box.left + box.width, right: 0, height: box.height } }), _jsx("div", { className: "tour-ring", style: { top: box.top, left: box.left, width: box.width, height: box.height } })] })) : (_jsx("div", { className: "tour-shade", style: { top: 0, left: 0, right: 0, bottom: 0 } })), _jsxs("div", { ref: card, className: `tour-card side-${where.side}${done ? ' is-done' : ''}`, style: { top: where.top, left: where.left, width }, role: "dialog", "aria-label": `Tour, step ${number} of ${steps.length}: ${step.title}`, children: [_jsx("div", { className: "tour-progress", "aria-hidden": "true", children: _jsx("span", { style: { width: `${(number / steps.length) * 100}%` } }) }), _jsxs("div", { className: "tour-head", children: [_jsxs("span", { className: "tour-count", children: [number, " / ", steps.length] }), _jsx("button", { type: "button", className: "icon-btn sm tour-close", onClick: () => leave(false), "aria-label": "Leave the tour", title: "Leave the tour (Esc)", children: _jsx(CloseIcon, { size: 15 }) })] }), _jsx("h3", { children: step.title }), _jsx("div", { className: "tour-body", children: step.body }), tried ? (_jsx("div", { className: `tour-try${done ? ' is-done' : ''}`, "aria-live": "polite", children: done ? (_jsxs(_Fragment, { children: [_jsx("span", { className: "tour-try-mark", children: "\u2713" }), " There it is \u2014 moving on"] })) : (_jsxs(_Fragment, { children: [_jsx("span", { className: "tour-try-tag", children: "Try it" }), " ", tried.prompt] })) })) : step.place === 'any' && !host.hasPaper && index > 0 && !last ? (_jsx("p", { className: "tour-note", children: "You will be able to try this once a paper is in your library." })) : null, _jsxs("div", { className: "tour-actions", children: [index === 0 ? (_jsx("button", { type: "button", className: "btn ghost sm", onClick: () => leave(false), children: "Not now" })) : (_jsx("button", { type: "button", className: "btn ghost sm", onClick: () => leave(false), children: "Skip tour" })), _jsx("span", { className: "tour-gap" }), index > 0 ? (_jsx("button", { type: "button", className: "btn sm", onClick: back, children: "Back" })) : null, _jsxs("button", { type: "button", className: "btn primary sm", onClick: next, autoFocus: true, children: [index === 0 ? 'Start the tour' : last ? 'Start reading' : tried && !done ? 'Skip this one' : 'Next', index > 0 && !last ? _jsx("kbd", { children: "\u2192" }) : null] })] })] })] }));
}
