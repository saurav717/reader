import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo } from 'react';
import { useStore } from '../lib/store';
import { statusOf } from '../lib/status';
import { progressLabel } from './LibraryBits';
import { PdfPeek, ReflowPeek, clip, hasPage, sinceLeft, useSpot, whereIn } from './HomeParts';
import { SearchIcon } from './icons';
const SHOWN = 4;
/**
 * Your desk: R, while reading, lays the papers in progress side by side at
 * the page and the line each was left on. 1–4 goes to one there; R or Esc
 * back to the paper; G to Home.
 */
export default function Desk({ current, onOpen, onClose, onHome, onSearch }) {
    const { papers } = useStore();
    const shown = useMemo(() => {
        const open = papers.find((paper) => paper.id === current);
        const others = papers
            .filter((paper) => paper.id !== current && statusOf(paper) === 'reading')
            .sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''));
        return [...(open ? [open] : []), ...others].slice(0, SHOWN);
    }, [papers, current]);
    useEffect(() => {
        const onKey = (event) => {
            if (event.metaKey || event.ctrlKey || event.altKey)
                return;
            const key = event.key.toLowerCase();
            if (key === 'escape' || key === 'r') {
                event.preventDefault();
                event.stopImmediatePropagation();
                onClose();
            }
            else if (key === 'g') {
                event.preventDefault();
                event.stopImmediatePropagation();
                onHome();
            }
            else if (/^[1-9]$/.test(key) && shown[Number(key) - 1]) {
                event.preventDefault();
                event.stopImmediatePropagation();
                const paper = shown[Number(key) - 1];
                if (paper.id === current)
                    onClose();
                else
                    onOpen(paper.id);
            }
        };
        // Ahead of the reader's own keys, which would take R, G and the digits otherwise.
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [shown, current, onOpen, onClose, onHome]);
    return (_jsx("div", { className: "desk-scrim", onClick: onClose, role: "dialog", "aria-label": "Your desk: the papers you are reading", children: _jsxs("div", { className: "desk", onClick: (event) => event.stopPropagation(), children: [_jsxs("header", { className: "desk-head", children: [_jsxs("div", { children: [_jsx("span", { className: "home-eyebrow accent", children: "Your desk \u00B7 R" }), _jsx("h2", { children: shown.length === 1 ? 'One paper open on it' : `${['', 'One', 'Two', 'Three', 'Four'][shown.length]} papers open on it` })] }), _jsxs("button", { type: "button", className: "home-search desk-find", onClick: onSearch, children: [_jsx(SearchIcon, { size: 16 }), _jsx("span", { children: "Find a paper, or one of these\u2026" }), _jsx("kbd", { children: "\u2318K" })] }), _jsx("button", { type: "button", className: "btn", onClick: onHome, children: "Go to Home" })] }), _jsx("div", { className: "desk-cards", style: { ['--n']: String(Math.max(shown.length, 2)) }, children: shown.map((paper, index) => (_jsx(DeskCard, { paper: paper, index: index, now: paper.id === current, onOpen: () => (paper.id === current ? onClose() : onOpen(paper.id)) }, paper.id))) }), _jsxs("footer", { className: "desk-foot", children: [_jsxs("span", { children: [_jsx("kbd", { children: "1" }), "\u2013", _jsx("kbd", { children: shown.length }), " switch paper, at the line you left"] }), _jsxs("span", { children: [_jsx("kbd", { children: "R" }), " or ", _jsx("kbd", { children: "Esc" }), " back to this paper"] }), _jsxs("span", { children: [_jsx("kbd", { children: "G" }), " go Home"] }), _jsx("span", { className: "desk-foot-note", children: "The papers in progress, the one you opened last first." })] })] }) }));
}
function DeskCard({ paper, index, now, onOpen }) {
    const spot = useSpot(paper.id);
    return (_jsxs("button", { type: "button", className: `desk-card${now ? ' is-now' : ''}`, onClick: onOpen, children: [_jsxs("span", { className: "desk-page", "aria-hidden": "true", children: [hasPage(spot) ? (spot.mode === 'pdf' ? _jsx(PdfPeek, { spot: spot }) : _jsx(ReflowPeek, { spot: spot })) : (_jsx("span", { className: "desk-page-bare", children: paper.abstract ? clip(paper.abstract, 600) : 'Open it and the page you stop on shows here.' })), now ? _jsx("span", { className: "desk-now", children: "Reading now" }) : null] }), _jsxs("span", { className: "desk-info", children: [_jsx("span", { className: "home-row-title", children: paper.title }), _jsxs("span", { className: "home-row-sub", children: [[progressLabel(paper.progress), whereIn(spot), paper.lastOpenedAt && !now ? sinceLeft(paper.lastOpenedAt) : ''].filter(Boolean).join(' · '), _jsx("kbd", { children: index + 1 })] })] })] }));
}
