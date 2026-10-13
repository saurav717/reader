import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { allNotesMarkdown, notesFor, useAllNotes, useHoveredPaper } from '../lib/notes';
import { coverFor, relativeDay } from '../lib/libraryLook';
import { DownloadIcon, SearchIcon } from './icons';
/** A file of Markdown handed to the browser to save. */
export function saveMarkdown(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${name.slice(0, 60).replace(/[^\w\s-]/g, '').trim() || 'notes'}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
}
/**
 * Every paper you have notes on, a card to each: how much is in them, when
 * they were last touched, and their first words. Each paper's notes are its
 * own; picking one opens the paper, and its notes come with it.
 */
export default function NotesIndex({ current, onOpenPaper }) {
    const { papers } = useStore();
    const all = useAllNotes();
    const [query, setQuery] = useState('');
    // The paper the pointer is on in the library: its card lit, every other dimmed —
    // all of them, when it has no notes.
    const hovered = useHoveredPaper();
    const pointedAt = hovered ? papers.find((paper) => paper.id === hovered) : undefined;
    const cards = useRef(new Map());
    // Notes on a paper no longer in the library — in Junk, say — wait there for it.
    const rows = useMemo(() => {
        const words = query.trim().toLowerCase();
        return all
            .map((summary) => ({ summary, paper: papers.find((paper) => paper.id === summary.paperId) }))
            .filter((row) => Boolean(row.paper))
            .filter(({ summary, paper }) => !words || `${paper.title} ${paper.authors.join(' ')} ${summary.preview}`.toLowerCase().includes(words));
    }, [all, papers, query]);
    const lit = pointedAt && rows.some(({ paper }) => paper.id === pointedAt.id) ? pointedAt.id : null;
    useEffect(() => {
        if (lit)
            cards.current.get(lit)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, [lit]);
    const pointedHasNotes = pointedAt && all.some((summary) => summary.paperId === pointedAt.id);
    const exportAll = () => saveMarkdown('Notes', allNotesMarkdown(rows.map(({ paper }) => ({ title: paper.title, blocks: notesFor(paper.id) }))));
    return (_jsxs("div", { className: "scroll notes-index", children: [_jsxs("div", { className: "notes-index-bar", children: [_jsxs("label", { className: "notes-index-search", children: [_jsx(SearchIcon, { size: 14 }), _jsx("input", { type: "search", value: query, placeholder: "Find in your notes", "aria-label": "Find a paper's notes", onChange: (event) => setQuery(event.target.value) })] }), _jsx("button", { type: "button", className: "icon-btn sm", onClick: exportAll, disabled: !rows.length, "aria-label": "Export every paper's notes as Markdown", title: "Export all as Markdown", children: _jsx(DownloadIcon, { size: 15 }) })] }), _jsx("p", { className: `notes-index-pointing${pointedAt ? ' is-on' : ''}${pointedAt && !lit ? ' is-none' : ''}`, "aria-live": "polite", children: !pointedAt
                    ? 'Point at a paper in the library to find its notes.'
                    : lit
                        ? `Notes on “${pointedAt.title}”`
                        : pointedHasNotes
                            ? `“${pointedAt.title}” has notes, but not in this search.`
                            : `No notes on “${pointedAt.title}” yet.` }), !all.length ? (_jsxs("p", { className: "notes-empty", children: ["No notes yet. Each paper keeps its own: open one, press ", _jsx("b", { children: "H" }), ", and write or keep things from it. They will be listed here, a paper to a card."] })) : !rows.length ? (_jsxs("p", { className: "notes-empty", children: ["No paper's notes match \u201C", query, "\u201D."] })) : null, rows.map(({ summary, paper }) => (_jsxs("button", { type: "button", ref: (element) => {
                    if (element)
                        cards.current.set(paper.id, element);
                    else
                        cards.current.delete(paper.id);
                }, className: `notes-index-row${paper.id === current ? ' is-current' : ''}${pointedAt ? (paper.id === lit ? ' is-lit' : ' is-dim') : ''}`, onClick: () => onOpenPaper?.(paper.id), style: { ['--h']: String(coverFor(paper).hue) }, "aria-current": paper.id === current ? 'true' : undefined, title: paper.id === current ? 'The paper open now' : `Open “${paper.title}” with its notes`, children: [_jsx("span", { className: "notes-index-spine", "aria-hidden": "true" }), _jsxs("span", { className: "notes-index-text", children: [_jsx("span", { className: "notes-index-title", children: paper.title }), _jsxs("span", { className: "notes-index-meta", children: [summary.count, " piece", summary.count === 1 ? '' : 's', summary.written ? ` · ${summary.written} written` : '', summary.kept ? ` · ${summary.kept} kept` : '', summary.pictures ? ` · ${summary.pictures} picture${summary.pictures === 1 ? '' : 's'}` : '', summary.updated ? ` · ${relativeDay(summary.updated)}` : ''] }), summary.preview ? _jsx("span", { className: "notes-index-preview", children: summary.preview }) : null] }), paper.id === current ? _jsx("span", { className: "notes-index-here", children: "Open" }) : null] }, paper.id)))] }));
}
