import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { TAG_NAMES, addText, removeNote, useNotes, withoutLabel } from '../lib/notes';
import { whereNow } from '../lib/where';
import { relativeDay } from '../lib/libraryLook';
import { showSource } from './NotesList';
import { TrashIcon } from './icons';
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayOf = (iso) => {
    const day = relativeDay(iso);
    return day ? day[0].toUpperCase() + day.slice(1) : '';
};
/** Where a jot was written, in a chip: "p. 3 · 4 Why self-attention". */
const whereName = (where) => [where.page ? `p. ${where.page}` : '', where.section ?? ''].filter(Boolean).join(' · ');
function Jot({ paperId, block }) {
    const text = block.kind === 'text' ? block.md : block.note || withoutLabel(block.label, block.text);
    const source = block.source;
    return (_jsxs("article", { className: `jot${block.kind === 'text' && block.tag ? ` is-${block.tag}` : ''}${block.kind === 'clip' ? ' is-kept' : ''}`, children: [_jsxs("p", { className: "jot-text", children: [block.kind === 'text' && block.tag === 'question' ? _jsx("b", { children: "? " }) : null, block.kind === 'text' && block.tag === 'key' ? _jsx("b", { children: "\u2605 " }) : null, block.kind === 'clip' ? _jsxs("b", { className: "jot-label", children: [block.label, " \u00B7 "] }) : null, text.trim()] }), _jsxs("div", { className: "jot-meta", children: [source && (source.page || source.section || source.from === 'explain') ? (_jsxs("button", { type: "button", className: "jot-chip", onClick: () => void showSource(source), title: "Go back to where it was written", children: [source.from === 'explain' ? 'Explain · ' : '', whereName({ page: source.page, section: source.section }) || 'Explain'] })) : null, _jsx("span", { children: time(block.at) }), block.kind === 'text' && block.tag ? _jsxs("span", { children: ["\u00B7 ", TAG_NAMES[block.tag].toLowerCase()] }) : null, block.kind === 'text' && block.pin ? _jsx("span", { children: "\u00B7 sticky" }) : null, block.kind === 'clip' ? _jsx("span", { children: "\u00B7 kept" }) : null, _jsx("button", { type: "button", className: "jot-x", onClick: () => removeNote(paperId, block.id), "aria-label": "Delete this jot", title: "Delete", children: _jsx(TrashIcon, { size: 12 }) })] })] }));
}
/**
 * Quick capture: a line at a time, each remembering the page and section it
 * was written at, in the order they were written — a running log of the
 * reading. Enter keeps a jot; ? and ★ mark it as a question or a key point.
 */
export default function NotesJots({ paperId }) {
    const blocks = useNotes(paperId);
    const [draft, setDraft] = useState('');
    const [tag, setTag] = useState(null);
    const [where, setWhere] = useState(() => whereNow());
    const [placed, setPlaced] = useState(true);
    const list = useRef(null);
    const area = useRef(null);
    // Writing begun and left empty elsewhere is not a jot.
    const ordered = blocks.filter((block) => block.kind !== 'text' || block.md.trim()).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    useEffect(() => {
        list.current?.scrollTo({ top: list.current.scrollHeight });
    }, [blocks.length]);
    const save = () => {
        const md = draft.trim();
        if (!md)
            return;
        const here = placed ? whereNow() : {};
        addText(paperId, md, { tag: tag ?? undefined, source: here.page || here.section ? { from: 'paper', page: here.page, section: here.section } : undefined });
        setDraft('');
        setTag(null);
        setWhere(whereNow());
        area.current?.focus();
    };
    let lastDay = '';
    return (_jsxs("div", { className: "notes-jots", children: [_jsxs("div", { ref: list, className: "scroll jots-list", children: [!ordered.length ? _jsx("p", { className: "notes-empty", children: "Jot a line as you read \u2014 it keeps the page and section you were on. Enter to keep it." }) : null, ordered.map((block) => {
                        const day = dayOf(block.at);
                        const head = day !== lastDay ? _jsx("div", { className: "jots-day", children: day }) : null;
                        lastDay = day;
                        return (_jsxs("div", { children: [head, _jsx(Jot, { paperId: paperId, block: block })] }, block.id));
                    })] }), _jsxs("div", { className: "jots-compose", children: [_jsx("textarea", { ref: area, value: draft, placeholder: "Jot a line\u2026", "aria-label": "Jot a line", onFocus: () => setWhere(whereNow()), onChange: (event) => setDraft(event.target.value), onKeyDown: (event) => {
                            if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault();
                                save();
                            }
                            if (event.key === 'Escape') {
                                event.stopPropagation();
                                event.currentTarget.blur();
                            }
                        } }), _jsxs("div", { className: "jots-bar", children: [whereName(where) ? (_jsxs("button", { type: "button", className: "jots-toggle", "aria-pressed": placed, onClick: () => setPlaced(!placed), title: placed ? 'Keep where you are with it — click to leave it off' : 'Leave where you are off it', children: ["\uD83D\uDCCD ", whereName(where)] })) : null, _jsx("button", { type: "button", className: "jots-toggle", "aria-pressed": tag === 'question', onClick: () => setTag(tag === 'question' ? null : 'question'), children: "? question" }), _jsx("button", { type: "button", className: "jots-toggle", "aria-pressed": tag === 'key', onClick: () => setTag(tag === 'key' ? null : 'key'), children: "\u2605 key" }), _jsx("span", { className: "jots-hint", children: "\u23CE to save" }), _jsx("button", { type: "button", className: "btn sm", onClick: save, disabled: !draft.trim(), children: "Save" })] })] })] }));
}
