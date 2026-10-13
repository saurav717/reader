import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { createContext, useContext, useEffect, useState } from 'react';
import { OPEN_NOTES } from '../lib/notes';
import { NoteIcon } from './icons';
/**
 * How a piece of the page is kept, for the pieces that carry their own
 * button: a code cell, a starter file, the budget — anything whose header
 * already holds buttons, where a button dropped on the corner would land on
 * top of Copy or Run in Colab. The page provides it; `KeepButton` calls it.
 */
export const KeepContext = createContext(null);
/** "Add to notes", in a header, for the piece of the page (`selector`) the button sits in. */
export function KeepButton({ selector, what }) {
    const keep = useContext(KeepContext);
    if (!keep)
        return null;
    return (_jsxs("button", { type: "button", className: "btn sm ghost keep-btn", onClick: (event) => {
            const element = event.currentTarget.closest(selector);
            if (element)
                keep(element);
        }, title: `Keep this ${what} in your notes`, children: [_jsx(NoteIcon, { size: 13 }), " ", _jsx("span", { children: "Add to notes" })] }));
}
// ===========================================================================
//  Keeping a piece of a page in your notes: the "Add to notes" button that
//  comes up on the corner of whatever keepable thing the pointer is over,
//  and the line that says it was kept. The Explain page, the reflowed paper
//  and the PDF set as a book all use them, each with what it counts as
//  keepable and how it copies it.
// ===========================================================================
/**
 * The corner button. `selector` says what can be kept whole under `root`;
 * the page's scrolling, anywhere, puts the button away, since it no longer
 * sits on what it would keep. `own` names the pieces that carry the button
 * in their own header (a `KeepButton`): the corner button stays away from
 * those, so it never covers what the header already holds.
 */
export function useKeeper({ root, selector, onKeep, off = false, own }) {
    const [at, setAt] = useState(null);
    useEffect(() => {
        if (!at)
            return;
        const away = () => setAt(null);
        document.addEventListener('scroll', away, { capture: true, passive: true });
        return () => document.removeEventListener('scroll', away, { capture: true });
    }, [at]);
    useEffect(() => {
        if (off)
            setAt(null);
    }, [off]);
    const onMouseOver = (event) => {
        if (off)
            return;
        const found = event.target instanceof Element ? event.target.closest(selector) : null;
        if (!found || !root.current?.contains(found))
            return;
        // Something keepable inside something keepable — an equation in a caveat — is kept with what holds it.
        let element = found;
        for (let outer = element.parentElement?.closest(selector); outer && root.current.contains(outer); outer = outer.parentElement?.closest(selector))
            element = outer;
        if (own && element.matches(own)) {
            if (at)
                setAt(null);
            return;
        }
        if (at?.element === element)
            return;
        const rect = element.getBoundingClientRect();
        setAt({ element, top: Math.max(rect.top + 6, 56), right: window.innerWidth - rect.right + 6 });
    };
    const onMouseLeave = (event) => {
        if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest('.note-clip-btn')))
            setAt(null);
    };
    const button = at && at.element.isConnected ? (_jsxs("button", { type: "button", className: "note-clip-btn", style: { top: at.top, right: at.right }, onClick: () => {
            onKeep(at.element);
            setAt(null);
        }, onMouseLeave: (event) => {
            if (!(event.relatedTarget instanceof Node && at.element.contains(event.relatedTarget)))
                setAt(null);
        }, title: "Keep this in your notes", children: [_jsx(NoteIcon, { size: 14 }), " Add to notes"] })) : null;
    return { onMouseOver, onMouseLeave, button };
}
/** The line at the bottom that says what was kept, with a way to the notes. */
export function useKept() {
    const [kept, setKept] = useState(null);
    useEffect(() => {
        if (!kept)
            return;
        const timer = window.setTimeout(() => setKept(null), 3200);
        return () => window.clearTimeout(timer);
    }, [kept]);
    const toast = kept ? (_jsxs("div", { className: "note-kept", role: "status", children: [_jsxs("span", { children: [_jsx("b", { children: kept.label }), " added to your notes"] }), _jsx("button", { type: "button", onClick: () => window.dispatchEvent(new CustomEvent(OPEN_NOTES)), children: "Open notes" })] }, kept.at)) : null;
    return { announce: (label) => setKept({ label, at: Date.now() }), toast };
}
/** A table as Markdown, a row a line. */
export function tableText(table) {
    const rows = Array.from(table.querySelectorAll('tr'), (row) => Array.from(row.children, (cell) => (cell.textContent ?? '').trim().replace(/\s+/g, ' ').replace(/\|/g, '\\|')));
    return rows.map((cells, index) => `| ${cells.join(' | ')} |${index === 0 ? `\n|${cells.map(() => ' --- |').join('')}` : ''}`).join('\n');
}
