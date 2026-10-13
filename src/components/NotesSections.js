import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useRef, useEffect } from 'react';
import { addText, removeNote, sourceName, updateNote, useNotes } from '../lib/notes';
import { sectionsOf } from '../lib/board';
import { cleanClip } from '../lib/sanitize';
import { useStore } from '../lib/store';
import { whereNow } from '../lib/where';
import { showSource } from './NotesList';
import { ExplainIcon, FileIcon, PlusIcon, TrashIcon } from './icons';
const WHOLE = 'Whole paper';
/** A textarea as tall as what is in it. */
function Grow({ paperId, block, placeholder, className }) {
    const area = useRef(null);
    useEffect(() => {
        if (!area.current)
            return;
        area.current.style.height = 'auto';
        area.current.style.height = `${area.current.scrollHeight + 2}px`;
    });
    // A piece just made, empty, is written in straight away.
    useEffect(() => {
        if (!block.md && Date.now() - Date.parse(block.at) < 1500)
            area.current?.focus();
    }, [block.md, block.at]);
    return (_jsxs("span", { className: `sec-write-wrap ${className}`, children: [_jsx("textarea", { ref: area, className: "sec-write", value: block.md, placeholder: placeholder, "aria-label": placeholder, onChange: (event) => updateNote(paperId, block.id, { md: event.target.value }) }), _jsx("button", { type: "button", className: "sec-x", onClick: () => removeNote(paperId, block.id), "aria-label": "Delete this", title: "Delete", children: _jsx(TrashIcon, { size: 12 }) })] }));
}
function Clip({ paperId, block }) {
    const html = useMemo(() => cleanClip(block.html), [block]);
    return (_jsxs("div", { className: "sec-clip", children: [_jsx("div", { className: "note-clip", dangerouslySetInnerHTML: { __html: html } }), _jsxs("div", { className: "sec-clip-foot", children: [_jsxs("button", { type: "button", className: "note-source", onClick: () => void showSource(block.source), children: [block.source.from === 'explain' ? _jsx(ExplainIcon, { size: 12 }) : _jsx(FileIcon, { size: 12 }), " ", block.label, " \u00B7 ", sourceName(block.source)] }), _jsx("button", { type: "button", className: "sec-x", onClick: () => removeNote(paperId, block.id), "aria-label": "Delete this", title: "Delete", children: _jsx(TrashIcon, { size: 12 }) })] })] }));
}
/**
 * The notes laid out by the paper's sections, Cornell style: for each, the
 * questions to test yourself with down the left (cues), the notes on the
 * right — what you wrote and what you kept — and a line of summary under
 * them. The section being read is marked. Sections you have highlighted in
 * but not written about wait at the bottom of the list; the whole paper's
 * summary comes last.
 */
export default function NotesSections({ paperId }) {
    const blocks = useNotes(paperId);
    const { highlights } = useStore();
    const here = whereNow().section;
    const groups = useMemo(() => {
        const names = sectionsOf(blocks).map((name) => (name === 'Your notes' ? WHOLE : name));
        const order = [];
        names.forEach((name) => {
            if (name !== WHOLE && !order.includes(name))
                order.push(name);
        });
        for (const highlight of highlights) {
            if (highlight.paperId === paperId && highlight.section && !order.includes(highlight.section))
                order.push(highlight.section);
        }
        if (here && !order.includes(here))
            order.push(here);
        const of = (name) => blocks.filter((_, index) => names[index] === name);
        return { sections: order.map((name) => ({ name, blocks: of(name) })), whole: of(WHOLE) };
    }, [blocks, highlights, paperId, here]);
    const write = (section, tag) => addText(paperId, '', { tag, source: section === WHOLE ? undefined : { from: 'paper', section } });
    const section = (name, list, whole = false) => {
        const cues = list.filter((block) => block.kind === 'text' && block.tag === 'question');
        const summaries = list.filter((block) => block.kind === 'text' && block.tag === 'summary');
        const notes = list.filter((block) => !(block.kind === 'text' && (block.tag === 'question' || block.tag === 'summary')));
        const empty = !list.length;
        return (_jsxs("section", { className: `sec${name === here ? ' is-here' : ''}`, children: [_jsxs("h3", { className: "sec-name", children: [_jsx("span", { children: whole ? 'Whole paper' : name }), name === here ? _jsx("span", { className: "sec-here", children: "Reading now" }) : null] }), empty ? (_jsxs("button", { type: "button", className: "sec-start", onClick: () => write(name, whole ? 'summary' : undefined), children: [_jsx(PlusIcon, { size: 13 }), " ", whole ? 'Overall summary' : 'Write about this section'] })) : (_jsxs("div", { className: "sec-card", children: [!whole ? (_jsxs("div", { className: "sec-cues", children: [_jsx("div", { className: "sec-label", children: "Cues" }), cues.map((cue) => (_jsx(Grow, { paperId: paperId, block: cue, placeholder: "A question\u2026", className: "is-cue" }, cue.id))), _jsx("button", { type: "button", className: "sec-add", onClick: () => write(name, 'question'), children: "+ cue" })] })) : null, _jsxs("div", { className: "sec-notes", children: [notes.map((block) => block.kind === 'clip' ? (_jsx(Clip, { paperId: paperId, block: block }, block.id)) : (_jsx(Grow, { paperId: paperId, block: block, placeholder: "Notes\u2026", className: block.tag === 'key' ? 'is-key' : '' }, block.id))), !whole ? (_jsx("button", { type: "button", className: "sec-add", onClick: () => write(name), children: "+ note" })) : null] }), _jsxs("div", { className: "sec-summary", children: [_jsx("div", { className: "sec-label", children: "Summary" }), summaries.map((summary) => (_jsx(Grow, { paperId: paperId, block: summary, placeholder: "In a line\u2026", className: "is-summary" }, summary.id))), !summaries.length ? (_jsx("button", { type: "button", className: "sec-add", onClick: () => write(name, 'summary'), children: "+ summary" })) : null] })] }))] }, name));
    };
    return (_jsxs("div", { className: "scroll notes-sections", children: [!blocks.length && !groups.sections.length ? (_jsx("p", { className: "notes-empty", children: "Notes by the paper's sections: questions down the left, notes on the right, a summary under each. Start with the section you are reading, or keep something from the paper and its section appears here." })) : null, groups.sections.map((group) => section(group.name, group.blocks)), section(WHOLE, groups.whole, true)] }));
}
