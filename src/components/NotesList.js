import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from 'react';
import { CLOSE_EXPLAIN, NOTE_ADDED, OPEN_EXPLAIN, SHOW_IN_EXPLAIN, addText, moveNote, removeNote, sourceName, textLabel, updateNote, useNotes } from '../lib/notes';
import { showPassage } from '../lib/locate';
import { cleanClip } from '../lib/sanitize';
import MarkdownNote from './MarkdownNote';
import { ExplainIcon, FileIcon, PlusIcon, TrashIcon } from './icons';
/** Waits, a frame at a time, until something is — or is no longer — on the page. */
function when(selector, there, within = 4000) {
    const until = performance.now() + within;
    return new Promise((resolve) => {
        const look = () => {
            if (Boolean(document.querySelector(selector)) === there)
                resolve(true);
            else if (performance.now() > until)
                resolve(false);
            else
                requestAnimationFrame(look);
        };
        look();
    });
}
/**
 * Back to where a piece was kept from. From Explain: Explain opened if it is
 * shut, then the passage marked, or its section scrolled to. From the paper:
 * Explain closed if it covers the paper, then the passage marked — or, for a
 * snip with no words to find it by, its page of the PDF turned to.
 */
export async function showSource(source) {
    if (source.from === 'explain') {
        if (!document.querySelector('.explain')) {
            window.dispatchEvent(new CustomEvent(OPEN_EXPLAIN));
            if (!(await when('.explain .explain-section', true)))
                return;
        }
        window.dispatchEvent(new CustomEvent(SHOW_IN_EXPLAIN, { detail: source }));
        return;
    }
    if (document.querySelector('.explain:not(.layout-beside)')) {
        window.dispatchEvent(new CustomEvent(CLOSE_EXPLAIN));
        await when('.explain', false);
    }
    // Something written with no words of the paper to find it by is shown at its section's heading.
    const quote = source.quote ?? (source.page ? undefined : source.section);
    if (quote) {
        const shown = await showPassage({ quote, page: source.page, section: source.section, label: 'From your notes' });
        if (shown.found || !source.page)
            return;
    }
    if (source.page)
        window.dispatchEvent(new CustomEvent('reader:pdf-page', { detail: { page: source.page } }));
}
/** A textarea as tall as what is in it. */
function grow(element) {
    if (!element)
        return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight + 2}px`;
}
function Piece({ paperId, block, first, last, fresh }) {
    const cardRef = useRef(null);
    const [noting, setNoting] = useState(false);
    const html = useMemo(() => (block.kind === 'clip' ? cleanClip(block.html) : ''), [block]);
    useEffect(() => {
        if (!fresh)
            return;
        cardRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, [fresh, block.kind]);
    const tools = (_jsxs("span", { className: "note-piece-tools", children: [_jsx("button", { type: "button", className: "icon-btn sm", disabled: first, onClick: () => moveNote(paperId, block.id, -1), "aria-label": "Move up", title: "Move up", children: "\u2191" }), _jsx("button", { type: "button", className: "icon-btn sm", disabled: last, onClick: () => moveNote(paperId, block.id, 1), "aria-label": "Move down", title: "Move down", children: "\u2193" }), _jsx("button", { type: "button", className: "icon-btn sm", onClick: () => removeNote(paperId, block.id), "aria-label": "Delete", title: "Delete", children: _jsx(TrashIcon, { size: 14 }) })] }));
    if (block.kind === 'text') {
        return (_jsxs("article", { ref: cardRef, className: `note-piece is-text${fresh ? ' is-fresh' : ''}${block.pin ? ` is-sticky is-${block.color ?? 'yellow'}` : ''}${block.tag ? ` is-${block.tag}` : ''}`, children: [_jsxs("header", { className: "note-piece-head", children: [_jsx("span", { className: "note-piece-kind", children: textLabel(block) }), tools] }), _jsx(MarkdownNote, { md: block.md, focus: fresh, onChange: (md) => updateNote(paperId, block.id, { md }) }), block.source ? (_jsx("footer", { className: "note-piece-foot", children: _jsxs("button", { type: "button", className: "note-source", onClick: () => block.source && void showSource(block.source), title: block.pin ? 'Show it on its page' : 'Show where it was written', children: [_jsx(FileIcon, { size: 12 }), " ", sourceName(block.source)] }) })) : null] }));
    }
    return (_jsxs("article", { ref: cardRef, className: `note-piece is-clip${fresh ? ' is-fresh' : ''}`, children: [_jsxs("header", { className: "note-piece-head", children: [_jsx("span", { className: "note-piece-kind", children: block.label }), tools] }), _jsx("div", { className: "note-clip", dangerouslySetInnerHTML: { __html: html } }), _jsxs("footer", { className: "note-piece-foot", children: [_jsxs("button", { type: "button", className: "note-source", onClick: () => void showSource(block.source), title: block.source.from === 'explain' ? 'Show it in the explanation' : 'Show it in the paper', children: [block.source.from === 'explain' ? _jsx(ExplainIcon, { size: 12 }) : _jsx(FileIcon, { size: 12 }), " ", sourceName(block.source)] }), !block.note && !noting ? (_jsx("button", { type: "button", className: "btn ghost sm", onClick: () => setNoting(true), children: "+ note" })) : null] }), block.note || noting ? (_jsx("textarea", { ref: (element) => grow(element), className: "note-write is-under", value: block.note ?? '', placeholder: "A line of your own about it\u2026", "aria-label": "Your note on this", autoFocus: noting && !block.note, onChange: (event) => {
                    updateNote(paperId, block.id, { note: event.target.value });
                    grow(event.target);
                }, onBlur: () => setNoting(false) })) : null] }));
}
/**
 * Your notes on a paper: what you write, and what you keep from its Explain
 * page, in the order you put them.
 */
export default function NotesList({ paperId }) {
    const blocks = useNotes(paperId);
    const [fresh, setFresh] = useState(null);
    // What was just added is scrolled to, and a new text piece is written in straight away.
    useEffect(() => {
        const onAdded = (event) => {
            const detail = event.detail;
            if (detail.paperId !== paperId)
                return;
            setFresh(detail.id);
            window.setTimeout(() => setFresh((current) => (current === detail.id ? null : current)), 1600);
        };
        window.addEventListener(NOTE_ADDED, onAdded);
        return () => window.removeEventListener(NOTE_ADDED, onAdded);
    }, [paperId]);
    return (_jsxs("div", { className: "scroll notes-list", children: [!blocks.length ? (_jsxs("p", { className: "notes-empty", children: ["These notes are this paper's own; every other paper keeps its own. Write here, or keep things from the paper and its Explain page: select any text and choose ", _jsx("b", { children: "Add to notes" }), ", or point at a figure, table, equation, diagram or code cell. Over the PDF, ", _jsx("b", { children: "\u2702 Snip" }), " (or S) keeps any figure or table, or a box you drag."] })) : null, blocks.map((block, index) => (_jsx(Piece, { paperId: paperId, block: block, first: index === 0, last: index === blocks.length - 1, fresh: fresh === block.id }, block.id))), _jsxs("button", { type: "button", className: "btn ghost sm notes-write-btn", onClick: () => addText(paperId), children: [_jsx(PlusIcon, { size: 14 }), " Write"] })] }));
}
