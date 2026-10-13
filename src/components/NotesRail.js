import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { NOTE_ADDED, OPEN_BOARD, notesMarkdown, setNotesView, useAllNotes, useNotes, useNotesView } from '../lib/notes';
import NotesDocument from './NotesDocument';
import NotesSections from './NotesSections';
import NotesJots from './NotesJots';
import NotesList from './NotesList';
import NotesIndex, { saveMarkdown } from './NotesIndex';
import { HIGHLIGHT_COLORS } from '../types';
import { CloseIcon, FileIcon, PopOutIcon, TrashIcon } from './icons';
const openBoard = () => window.dispatchEvent(new CustomEvent(OPEN_BOARD));
const VIEWS = [
    { id: 'list', name: 'List', hint: 'Each piece a card, in the order you put them' },
    { id: 'document', name: 'Document', hint: 'One page of writing — / drops in highlights and figures' },
    { id: 'sections', name: 'By section', hint: "Cornell style: cues, notes and a summary for each of the paper's sections" },
    { id: 'jots', name: 'Jots', hint: 'Quick capture: a line at a time, each keeping its page' },
    { id: 'board', name: 'Board ⤢', hint: 'Full screen: move and size every piece anywhere (B)' },
];
/** Which way the notes are shown — the same in the dock and the window. */
function ViewMenu() {
    const view = useNotesView();
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => {
        if (!open)
            return;
        const away = (event) => {
            if (!ref.current?.contains(event.target))
                setOpen(false);
        };
        const esc = (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                setOpen(false);
            }
        };
        document.addEventListener('pointerdown', away, true);
        window.addEventListener('keydown', esc, true);
        return () => {
            document.removeEventListener('pointerdown', away, true);
            window.removeEventListener('keydown', esc, true);
        };
    }, [open]);
    const name = VIEWS.find((item) => item.id === view)?.name ?? 'List';
    return (_jsxs("div", { className: "notes-view", ref: ref, children: [_jsxs("button", { type: "button", className: "notes-view-btn", "aria-haspopup": "menu", "aria-expanded": open, onClick: () => setOpen(!open), title: "How the notes are shown", children: ["View: ", _jsx("b", { children: name }), " \u25BE"] }), open ? (_jsx("div", { className: "notes-view-menu", role: "menu", children: VIEWS.map((item) => (_jsxs("button", { type: "button", role: "menuitemradio", "aria-checked": item.id === view, onClick: () => {
                        setOpen(false);
                        if (item.id === 'board')
                            openBoard();
                        else
                            setNotesView(item.id);
                    }, children: [_jsx("span", { className: "notes-view-name", children: item.name }), _jsx("span", { className: "notes-view-hint", children: item.hint })] }, item.id))) })) : null] }));
}
function toMarkdown(title, highlights, notes) {
    const lines = [`# ${title}`, ''];
    if (notes.length)
        lines.push('## Notes', '', notesMarkdown(notes), highlights.length ? '## Highlights' : '', '');
    let section = '';
    for (const highlight of highlights) {
        if (highlight.section && highlight.section !== section) {
            section = highlight.section;
            lines.push(`## ${section}`, '');
        }
        lines.push(`> ${highlight.exact}`, '');
        if (highlight.note)
            lines.push(highlight.note, '');
        if (highlight.tags.length)
            lines.push(highlight.tags.join(' '), '');
    }
    return lines.join('\n');
}
export default function NotesRail({ paperId, selectedId, orphanIds, onSelect, onClose, onPopOut, inWindow = false, onOpenPaper }) {
    const { papers, highlights, updateHighlight, deleteHighlight } = useStore();
    const paper = papers.find((item) => item.id === paperId);
    // Every paper's notes, a card to each, in place of this one's: with no paper
    // open there is nothing else to show.
    const [everyPaper, setEveryPaper] = useState(false);
    const showingAll = everyPaper || !paper;
    const others = useAllNotes().filter((summary) => summary.paperId !== paperId && papers.some((item) => item.id === summary.paperId)).length;
    const [filter, setFilter] = useState('all');
    const [notesOnly, setNotesOnly] = useState(false);
    const notes = useNotes(paperId);
    const view = useNotesView();
    // Which list is showing: your notes, or the highlights. Until one is picked,
    // the notes — unless there are only highlights so far.
    const [picked, setTab] = useState(null);
    const highlighted = highlights.some((highlight) => highlight.paperId === paperId);
    const tab = picked ?? (notes.length || !highlighted ? 'notes' : 'highlights');
    // A highlight picked — or a note begun on one — is shown among the highlights;
    // something kept from Explain, among the notes.
    useEffect(() => {
        if (selectedId)
            setTab('highlights');
    }, [selectedId]);
    useEffect(() => {
        const onAdded = (event) => {
            if (event.detail.paperId === paperId)
                setTab('notes');
        };
        window.addEventListener(NOTE_ADDED, onAdded);
        return () => window.removeEventListener(NOTE_ADDED, onAdded);
    }, [paperId]);
    const mine = useMemo(() => {
        let list = highlights.filter((highlight) => highlight.paperId === paperId);
        if (filter !== 'all')
            list = list.filter((highlight) => highlight.color === filter);
        if (notesOnly)
            list = list.filter((highlight) => typeof highlight.note === 'string' && highlight.note.length > 0);
        return list.slice().sort((a, b) => a.hint - b.hint);
    }, [highlights, paperId, filter, notesOnly]);
    const total = highlights.filter((highlight) => highlight.paperId === paperId).length;
    const grouped = useMemo(() => {
        const groups = [];
        for (const highlight of mine) {
            const section = highlight.section || 'Elsewhere in the paper';
            const last = groups[groups.length - 1];
            if (last && last.section === section)
                last.items.push(highlight);
            else
                groups.push({ section, items: [highlight] });
        }
        return groups;
    }, [mine]);
    const exportMarkdown = () => {
        if (paper)
            saveMarkdown(paper.title, toMarkdown(paper.title, mine, notes));
    };
    // Whose notes these are, and the way to every other paper's.
    const whose = (_jsxs("div", { className: `notes-paper${inWindow ? ' in-window' : ''}`, children: [showingAll ? (_jsxs("span", { className: "notes-paper-name", children: [_jsx("span", { className: "notes-paper-eyebrow", children: "Every paper" }), _jsx("span", { className: "notes-paper-title", children: "Your notes, a paper to each" })] })) : (_jsxs("span", { className: "notes-paper-name", title: paper?.title, children: [_jsx("span", { className: "notes-paper-eyebrow", children: "Notes on this paper" }), _jsx("span", { className: "notes-paper-title", children: paper?.title })] })), paper ? (_jsx("button", { type: "button", className: "btn ghost sm notes-paper-switch", "aria-pressed": everyPaper, onClick: () => setEveryPaper(!everyPaper), title: everyPaper ? 'Back to the notes on the paper open now' : "See every paper's notes, and switch to another", children: everyPaper ? '← This paper' : `All notes${others ? ` · ${others + (notes.length ? 1 : 0)} papers` : ''}` })) : null] }));
    return (_jsxs("aside", { className: "panel notes-rail", "aria-label": "Highlights and notes", children: [inWindow ? null : (_jsxs("div", { className: "panel-head", children: [_jsx("h2", { children: "Notes" }), paper ? (_jsx("button", { type: "button", className: "icon-btn sm board-open", onClick: openBoard, "aria-label": "Open the notes full screen, on a board", title: "Full screen \u2014 a board to arrange them on (B)", children: "\u2922" })) : null, onPopOut ? (_jsx("button", { type: "button", className: "icon-btn sm", onClick: onPopOut, "aria-label": "Pop the notes out into a window", title: "Pop out \u2014 a window you can move anywhere (\u2318 + arrows)", children: _jsx(PopOutIcon, { size: 16 }) })) : null, paper ? (_jsx("button", { type: "button", className: "icon-btn sm", onClick: exportMarkdown, "aria-label": "Export notes and highlights as Markdown", children: _jsx(FileIcon, { size: 16 }) })) : null, _jsx("button", { type: "button", className: "icon-btn sm", onClick: onClose, "aria-label": "Close the highlights panel", children: _jsx(CloseIcon, { size: 17 }) })] })), whose, showingAll ? (_jsx(NotesIndex, { current: paper?.id, onOpenPaper: (id) => (id === paperId ? setEveryPaper(false) : onOpenPaper?.(id)) })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "notes-tabs", role: "tablist", "aria-label": "Notes or highlights", children: [_jsxs("button", { type: "button", role: "tab", "aria-selected": tab === 'notes', onClick: () => setTab('notes'), children: ["Notes", notes.length ? _jsx("span", { className: "notes-tab-count", children: notes.length }) : null] }), _jsxs("button", { type: "button", role: "tab", "aria-selected": tab === 'highlights', onClick: () => setTab('highlights'), children: ["Highlights", total ? _jsx("span", { className: "notes-tab-count", children: total }) : null] }), _jsx("span", { style: { flex: 1 } }), tab === 'notes' ? _jsx(ViewMenu, {}) : null, inWindow ? (_jsx("button", { type: "button", className: "icon-btn sm board-open", onClick: openBoard, "aria-label": "Open the notes full screen, on a board", title: "Full screen \u2014 a board to arrange them on (B)", children: "\u2922" })) : null, inWindow ? (_jsx("button", { type: "button", className: "icon-btn sm", onClick: exportMarkdown, "aria-label": "Export notes and highlights as Markdown", title: "Export as Markdown", children: _jsx(FileIcon, { size: 16 }) })) : null] }), tab === 'notes' ? (view === 'document' ? (_jsx(NotesDocument, { paperId: paperId })) : view === 'sections' ? (_jsx(NotesSections, { paperId: paperId })) : view === 'jots' ? (_jsx(NotesJots, { paperId: paperId })) : (_jsx(NotesList, { paperId: paperId }))) : (_jsxs(_Fragment, { children: [_jsxs("div", { style: { padding: inWindow ? '0 12px 10px' : '0 16px 12px', display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }, children: [_jsxs("button", { type: "button", className: "chip", "aria-pressed": filter === 'all', onClick: () => setFilter('all'), children: ["All ", total] }), HIGHLIGHT_COLORS.map((colour) => (_jsx("button", { type: "button", className: "chip", "aria-pressed": filter === colour.id, title: colour.label, "aria-label": colour.label, onClick: () => setFilter(filter === colour.id ? 'all' : colour.id), style: { padding: 5, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center' }, children: _jsx("span", { className: "dot", style: { background: colour.swatch, width: 12, height: 12 } }) }, colour.id))), _jsx("button", { type: "button", className: "chip", "aria-pressed": notesOnly, onClick: () => setNotesOnly(!notesOnly), children: "With notes" })] }), orphanIds.length ? (_jsxs("p", { className: "banner warn", style: { margin: '0 16px 12px' }, children: [orphanIds.length, " highlight", orphanIds.length === 1 ? '' : 's', " could not be found in this version of the text. The note is kept; the quote no longer matches."] })) : null, _jsxs("div", { className: "scroll", style: { padding: '0 12px 20px', display: 'flex', flexDirection: 'column', gap: 8 }, children: [!mine.length ? (_jsxs("p", { style: { padding: '8px 4px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }, children: ["Select text in the paper to highlight it. Keys ", _jsx("span", { className: "mono", children: "1" }), "\u2013", _jsx("span", { className: "mono", children: "4" }), " pick a colour, ", _jsx("span", { className: "mono", children: "N" }), " adds a note."] })) : null, grouped.map((group) => (_jsxs("div", { children: [_jsx("div", { className: "eyebrow", style: { padding: '6px 4px 8px' }, children: group.section }), _jsx("div", { style: { display: 'flex', flexDirection: 'column', gap: 8 }, children: group.items.map((highlight) => {
                                                    const colour = HIGHLIGHT_COLORS.find((item) => item.id === highlight.color);
                                                    const orphaned = orphanIds.includes(highlight.id);
                                                    const isSelected = selectedId === highlight.id;
                                                    return (_jsxs("article", { className: "note-card", style: isSelected ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 1px var(--accent)' } : undefined, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 }, children: [_jsx("span", { className: "dot", style: highlight.style === 'underline'
                                                                            ? { background: 'none', borderRadius: 0, height: 0, borderBottom: '3px solid var(--ink)' }
                                                                            : { background: colour?.swatch } }), _jsxs("span", { style: { fontSize: 10.5, color: 'var(--muted)' }, children: [new Date(highlight.createdAt).toLocaleDateString(), highlight.style === 'underline' ? ' · underlined' : '', orphaned ? ' · not found in text' : ''] }), _jsx("span", { style: { flexGrow: 1 } }), _jsx("button", { type: "button", className: "icon-btn sm", style: { width: 24, height: 24, fontFamily: 'var(--serif)', fontSize: 13, textDecoration: 'underline', textUnderlineOffset: 3 }, "aria-pressed": highlight.style === 'underline', "aria-label": highlight.style === 'underline' ? 'Highlight this instead of underlining it' : 'Underline this instead of highlighting it', title: highlight.style === 'underline' ? 'Highlight instead' : 'Underline instead', onClick: () => void updateHighlight(highlight.id, { style: highlight.style === 'underline' ? 'highlight' : 'underline' }), children: "U" }), _jsx("button", { type: "button", className: "icon-btn sm", style: { width: 24, height: 24 }, "aria-label": "Delete this highlight", onClick: () => {
                                                                            void deleteHighlight(highlight.id);
                                                                            if (isSelected)
                                                                                onSelect(null);
                                                                        }, children: _jsx(TrashIcon, { size: 14 }) })] }), _jsx("button", { type: "button", onClick: () => onSelect(isSelected ? null : highlight.id), style: { all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }, children: _jsx("p", { className: "quote", children: highlight.exact }) }), typeof highlight.note === 'string' || isSelected ? (_jsxs("div", { style: { marginTop: 9 }, children: [_jsx("label", { className: "vh", htmlFor: `note-${highlight.id}`, children: "Note on this highlight" }), _jsx("textarea", { id: `note-${highlight.id}`, value: highlight.note ?? '', placeholder: "Write a note\u2026", onChange: (event) => void updateHighlight(highlight.id, { note: event.target.value }) })] })) : null, _jsxs("div", { style: { display: 'flex', gap: 5, marginTop: 9, flexWrap: 'wrap' }, children: [highlight.tags.map((tag) => (_jsx("span", { className: "tag", children: tag }, tag))), _jsx("button", { type: "button", className: "btn ghost sm", onClick: () => {
                                                                            const tag = window.prompt('Tag (without the #)');
                                                                            if (!tag)
                                                                                return;
                                                                            const clean = `#${tag.replace(/^#/, '').trim()}`;
                                                                            if (!highlight.tags.includes(clean)) {
                                                                                void updateHighlight(highlight.id, { tags: [...highlight.tags, clean] });
                                                                            }
                                                                        }, children: "+ tag" })] })] }, highlight.id));
                                                }) })] }, group.section)))] })] }))] }))] }));
}
