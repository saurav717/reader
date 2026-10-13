import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { defaultSources, search } from '../lib/sources';
import { authorLine } from '../lib/libraryLook';
import { statusOf } from '../lib/status';
import { ProgressRing, progressLabel } from './LibraryBits';
import { clip } from './HomeParts';
import { PlusIcon } from './icons';
/** A paper dragged from one column to another. */
const CARD_MIME = 'application/x-reader-card';
const SHOWN = 5;
const norm = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/**
 * Collections: each collection a column of its papers, reading ones first,
 * with a box at the foot that finds a paper and puts it straight in. Cards
 * drag from one column to another to move the paper.
 */
export function CollectionsBoard({ onOpenPaper, onFind }) {
    const { papers, collections, createCollection, setPaperCollections } = useStore();
    const [dropOn, setDropOn] = useState(null);
    const [naming, setNaming] = useState(false);
    const [name, setName] = useState('');
    const order = (paper) => (statusOf(paper) === 'reading' ? 0 : statusOf(paper) === 'unread' ? 1 : 2);
    const move = async (paperId, from, to) => {
        const paper = papers.find((item) => item.id === paperId);
        if (!paper || from === to)
            return;
        await setPaperCollections(paperId, [...paper.collectionIds.filter((id) => id !== from), ...(paper.collectionIds.includes(to) ? [] : [to])]);
    };
    return (_jsxs("div", { className: "home-view cb", children: [_jsx("p", { className: "cb-lede", children: "Each collection takes a paper straight in: type in the box at its foot. Drag a card to another column to move it." }), _jsxs("div", { className: "cb-cols", children: [collections.map((collection) => {
                        const inIt = papers
                            .filter((paper) => paper.collectionIds.includes(collection.id))
                            .sort((a, b) => order(a) - order(b) || (b.lastOpenedAt ?? b.addedAt).localeCompare(a.lastOpenedAt ?? a.addedAt));
                        const reading = inIt.filter((paper) => statusOf(paper) === 'reading').length;
                        return (_jsxs("section", { className: `cb-col${dropOn === collection.id ? ' is-drop' : ''}`, "aria-label": collection.name, onDragOver: (event) => {
                                if (!event.dataTransfer.types.includes(CARD_MIME))
                                    return;
                                event.preventDefault();
                                setDropOn(collection.id);
                            }, onDragLeave: (event) => {
                                if (!event.currentTarget.contains(event.relatedTarget))
                                    setDropOn(null);
                            }, onDrop: (event) => {
                                setDropOn(null);
                                const raw = event.dataTransfer.getData(CARD_MIME);
                                if (!raw)
                                    return;
                                event.preventDefault();
                                const { id, from } = JSON.parse(raw);
                                void move(id, from, collection.id);
                            }, children: [_jsxs("header", { className: "cb-col-head", children: [_jsx("span", { className: "home-dot", style: { background: collection.color } }), _jsx("b", { children: collection.name }), _jsxs("span", { className: "cb-count", children: [inIt.length, reading ? ` · ${reading} reading` : ''] })] }), inIt.slice(0, SHOWN).map((paper) => (_jsxs("button", { type: "button", className: "cb-card", draggable: true, onDragStart: (event) => {
                                        event.dataTransfer.setData(CARD_MIME, JSON.stringify({ id: paper.id, from: collection.id }));
                                        event.dataTransfer.effectAllowed = 'move';
                                    }, onClick: () => onOpenPaper(paper.id), children: [_jsx(ProgressRing, { progress: paper.progress, size: 24 }), _jsxs("span", { className: "home-row-text", children: [_jsx("span", { className: "home-row-title", children: paper.title }), _jsxs("span", { className: "home-row-sub", children: [progressLabel(paper.progress), " \u00B7 ", authorLine(paper.authors, 1)] })] })] }, paper.id))), inIt.length > SHOWN ? _jsxs("p", { className: "cb-more", children: ["+ ", inIt.length - SHOWN, " more"] }) : null, !inIt.length ? _jsx("p", { className: "cb-more", children: "Nothing here yet." }) : null, _jsx(AddInto, { collection: collection, onFind: onFind })] }, collection.id));
                    }), _jsx("section", { className: "cb-col cb-new", children: naming ? (_jsx("form", { onSubmit: (event) => {
                                event.preventDefault();
                                if (!name.trim())
                                    return;
                                void createCollection(name.trim()).then(() => {
                                    setName('');
                                    setNaming(false);
                                });
                            }, children: _jsx("input", { autoFocus: true, value: name, onChange: (event) => setName(event.target.value), placeholder: "Name it after a question\u2026", "aria-label": "New collection name", onBlur: () => !name && setNaming(false) }) })) : (_jsxs("button", { type: "button", onClick: () => setNaming(true), children: [_jsx(PlusIcon, { size: 18 }), _jsx("b", { children: "New collection" }), _jsx("span", { children: "Name it after a question, and add to it as you search." })] })) })] })] }));
}
/** The box at a column's foot: type, and the papers found go into this collection. */
function AddInto({ collection, onFind }) {
    const { papers, addPaper } = useStore();
    const [text, setText] = useState('');
    const [found, setFound] = useState(null);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(null);
    const abort = useRef(null);
    // Asked as the typing pauses, from the same sources a search starts with.
    useEffect(() => {
        const query = text.trim();
        abort.current?.abort();
        if (query.length < 3) {
            setFound(null);
            setBusy(false);
            return;
        }
        const controller = new AbortController();
        abort.current = controller;
        const timer = window.setTimeout(() => {
            setBusy(true);
            void search(query, defaultSources(), { limit: 5, signal: controller.signal })
                .then((outcome) => !controller.signal.aborted && setFound(outcome.results.slice(0, 4)))
                .catch(() => !controller.signal.aborted && setFound([]))
                .finally(() => !controller.signal.aborted && setBusy(false));
        }, 450);
        return () => {
            window.clearTimeout(timer);
            controller.abort();
        };
    }, [text]);
    const add = async (ref) => {
        const existing = papers.find((paper) => paper.id === ref.id || norm(paper.title) === norm(ref.title));
        await addPaper(existing ? { ...ref, id: existing.id } : ref, collection.id);
        setText('');
        setFound(null);
        setDone(ref.title);
        window.setTimeout(() => setDone(null), 3000);
    };
    return (_jsxs("div", { className: "cb-add", children: [_jsx("input", { value: text, onChange: (event) => setText(event.target.value), onKeyDown: (event) => {
                    if (event.key === 'Enter' && found?.[0]) {
                        event.preventDefault();
                        void add(found[0]);
                    }
                    if (event.key === 'Escape')
                        setText('');
                }, placeholder: `+ Add a paper to ${clip(collection.name, 24)}`, "aria-label": `Add a paper to ${collection.name}` }), busy ? _jsx("span", { className: "spinner" }) : null, done ? _jsxs("p", { className: "cb-done", children: ["Added ", clip(done, 40)] }) : null, found ? (_jsxs("div", { className: "cb-found", children: [found.map((ref, index) => (_jsxs("button", { type: "button", className: index === 0 ? 'is-first' : undefined, onClick: () => void add(ref), children: [_jsx("b", { children: ref.title }), _jsxs("small", { children: [authorLine(ref.authors, 2), /^\d{4}/.exec(ref.published || '')?.[0] ? ` · ${/^\d{4}/.exec(ref.published)[0]}` : '', index === 0 ? ' · ↵ adds it here' : ''] })] }, `${ref.id}-${index}`))), !found.length ? _jsx("p", { className: "cb-more", children: "Nothing found." }) : null, _jsxs("button", { type: "button", className: "cb-everywhere", onClick: () => onFind(text), children: ["Search everywhere for \u201C", clip(text, 30), "\u201D \u2192"] })] })) : null] }));
}
