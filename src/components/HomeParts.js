import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { authorLine, relativeDay } from '../lib/libraryLook';
import { SPOT_EVENT, spotFor } from '../lib/spot';
import { progressLabel } from './LibraryBits';
// The pieces of Home that more than one of its views shows: the paper to
// carry on with, and the page you left it at.
export const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
/** "2 hours ago", "yesterday", "3 Sep": how long since you were reading it. */
export function sinceLeft(iso, now = new Date()) {
    const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60000);
    if (Number.isNaN(minutes))
        return '';
    if (minutes < 2)
        return 'just now';
    if (minutes < 60)
        return `${minutes} minutes ago`;
    if (minutes < 60 * 12)
        return `${Math.round(minutes / 60)} hour${minutes < 90 ? '' : 's'} ago`;
    return relativeDay(iso, now);
}
/** Where you stopped in a paper, kept up to date as the reader keeps it. */
export function useSpot(paperId) {
    const [spot, setSpot] = useState(() => (paperId ? spotFor(paperId) : null));
    useEffect(() => {
        if (!paperId) {
            setSpot(null);
            return;
        }
        setSpot(spotFor(paperId));
        const onSpot = () => setSpot(spotFor(paperId));
        window.addEventListener(SPOT_EVENT, onSpot);
        return () => window.removeEventListener(SPOT_EVENT, onSpot);
    }, [paperId]);
    return spot;
}
/** Whether there is a page to show: a picture of it, or its paragraphs. */
export const hasPage = (spot) => (spot?.mode === 'pdf' && Boolean(spot.image)) || (spot?.mode === 'reflow' && Boolean(spot.blocks?.length));
/** "page 3 of 6", or the section, or the mode. */
export function whereIn(spot) {
    if (!spot)
        return '';
    if (spot.mode === 'pdf')
        return spot.page ? `page ${spot.page}${spot.pages ? ` of ${spot.pages}` : ''}` : 'PDF';
    return spot.section ?? 'Reflow';
}
/** The paper to carry on with, and the page you left it at. */
export function Continue({ paper, now, onOpen }) {
    const spot = useSpot(paper.id);
    const year = /^\d{4}/.exec(paper.published || '')?.[0];
    const started = paper.progress > 0;
    // Whether there is a page to show, or only the abstract and a word about it.
    const shown = hasPage(spot);
    const where = whereIn(spot);
    return (_jsxs("section", { className: `home-card home-continue${shown ? '' : ' is-bare'}`, children: [_jsxs("div", { className: "home-continue-head", children: [_jsxs("div", { className: "home-continue-text", children: [_jsxs("span", { className: "home-eyebrow accent", children: [started ? 'Continue reading' : 'Start reading', paper.lastOpenedAt ? ` · left ${sinceLeft(paper.lastOpenedAt, now)}` : ''] }), _jsx("h2", { className: "home-continue-title", title: paper.title, children: paper.title }), _jsxs("div", { className: "home-facts", children: [_jsxs("span", { children: [authorLine(paper.authors, 2), paper.venue ? ` · ${paper.venue}` : '', year && !paper.venue?.includes(year) ? ` · ${year}` : ''] }), started ? (_jsxs("span", { className: "home-progress", children: [_jsx("span", { className: "home-bar-track", children: _jsx("span", { style: { width: `${Math.round(Math.min(1, paper.progress) * 100)}%` } }) }), progressLabel(paper.progress)] })) : null] })] }), _jsxs("button", { type: "button", className: "btn primary home-resume", onClick: onOpen, children: [started ? 'Resume here' : 'Open', " ", _jsx("kbd", { children: "\u21B5" })] })] }), _jsxs("div", { className: "home-peek", children: [_jsxs("div", { className: "home-peek-bar", children: [_jsx("span", { className: "home-eyebrow", children: shown ? 'Where you stopped' : paper.abstract ? 'Abstract' : started ? 'Where you are' : 'Not started' }), shown && where ? _jsx("span", { className: "home-peek-where", children: where }) : null, _jsx("span", { style: { flex: 1 } }), shown && spot ? _jsx("span", { className: "home-chip", children: spot.mode === 'pdf' ? 'PDF' : 'Reflow' }) : null] }), _jsx("button", { type: "button", className: "home-peek-page", onClick: onOpen, "aria-label": `Open ${paper.title} where you stopped`, children: shown && spot?.mode === 'pdf' ? (_jsx(PdfPeek, { spot: spot })) : shown && spot ? (_jsx(ReflowPeek, { spot: spot })) : (_jsxs("div", { className: "home-peek-sheet home-peek-abstract", children: [paper.abstract ? _jsx("p", { children: paper.abstract }) : null, _jsx("p", { className: "home-peek-hint", children: started
                                        ? 'Home will show the page you were on from the next time you read this paper.'
                                        : 'Home will show the page you stop on, once you have started it.' })] })) }), _jsx("div", { className: "home-peek-fade", "aria-hidden": "true" })] })] }));
}
/** The PDF page you left, moved so that where you were sits a little below the top. */
export function PdfPeek({ spot }) {
    const top = spot.top ?? 0;
    return (_jsxs("div", { className: "home-peek-pdf", style: { ['--at']: String(top) }, children: [_jsx("img", { src: spot.image, alt: `Page ${spot.page ?? ''} of the paper, as you left it` }), top > 0.02 ? _jsx("span", { className: "home-peek-read", "aria-hidden": "true" }) : null, _jsx("span", { className: "home-stop", "aria-hidden": "true", children: _jsx("span", { children: "You were here" }) })] }));
}
/** The paragraphs you left, the ones scrolled past dimmed, and a line where the screen began. */
export function ReflowPeek({ spot }) {
    const blocks = spot.blocks ?? [];
    const stopAt = blocks.findIndex((block) => !block.read);
    return (_jsx("div", { className: "home-peek-sheet home-peek-reflow", children: blocks.map((block, index) => {
            const body = block.runs.map((run, at) => run.color ? (_jsx("mark", { className: `hl-bg-${run.color}`, children: run.text }, at)) : (_jsx("span", { children: run.text }, at)));
            return (_jsxs("div", { className: block.read ? 'is-read' : undefined, children: [index === stopAt && stopAt > 0 ? (_jsx("span", { className: "home-stop in-flow", "aria-hidden": "true", children: _jsx("span", { children: "You were here" }) })) : null, block.heading ? _jsx("h3", { children: body }) : _jsx("p", { children: body })] }, index));
        }) }));
}
