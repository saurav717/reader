import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { OPEN_NOTES, addText, notesMarkdown, removeNote, setNotesView, sourceName, textLabel, updateNote, useNotes } from '../lib/notes';
import { BOARD_COLORS, CARD_W, boardId, clampZoom, curve, edgePoint, fitView, inside, placeNew, snap, tidyBySection, topZ, useBoardLayout, zoomAt } from '../lib/board';
import { cleanClip } from '../lib/sanitize';
import { showSource } from './NotesList';
import MarkdownNote from './MarkdownNote';
import { saveMarkdown } from './NotesIndex';
import { CloseIcon, DownloadIcon, ExplainIcon, FileIcon, NoteIcon, TrashIcon } from './icons';
const MIN_W = 180;
const MIN_H = 80;
const MINI_W = 180;
const MINI_H = 112;
const START = { x: 0, y: 0, zoom: 1 };
const HISTORY = 60;
/** How close, on the screen, a card comes to another's line before it is pulled onto it. */
const SNAP_PX = 7;
const WHERE_KEY = 'reader.board.where';
function whereAtFirst() {
    try {
        return localStorage.getItem(WHERE_KEY) === 'beside' ? 'beside' : 'full';
    }
    catch {
        return 'full';
    }
}
const TOOLS = [
    { id: 'select', key: 'V', icon: '↖', name: 'Select', hint: 'Pick and move cards; drag the board to pan' },
    { id: 'text', key: 'T', icon: 'T', name: 'Text', hint: 'Click the board to write a note there' },
    { id: 'sticky', key: 'S', icon: '▢', name: 'Sticky', hint: 'Click the board to put a coloured sticky there' },
    { id: 'frame', key: 'F', icon: '⬚', name: 'Frame', hint: 'Drag to draw a frame; moving it moves what is in it' },
    { id: 'arrow', key: 'A', icon: '↗', name: 'Arrow', hint: 'Drag from one card to another to connect them' },
];
/** Things on the board that are not the board: a pointer on them does not pan it. */
const NOT_BOARD = '.board-card, .board-label, .board-tools, .board-mini, .board-zoom, .board-frame-head, .board-frame-size, .board-link-hit, .board-link-label';
function Card({ block, place, selected, fresh, linking, onPointerDown, onSize, onConnect, onSelect, onColor, onShowSource, measure, paperId, }) {
    const html = useMemo(() => (block.kind === 'clip' ? cleanClip(block.html) : ''), [block]);
    const sized = place?.h !== undefined;
    // A colour set on the board, or — for a sticky from the PDF — its own.
    const color = place?.color ?? (block.kind === 'text' && block.pin ? (block.color ?? 'yellow') : undefined);
    return (_jsxs("article", { ref: (element) => measure(block.id, element), className: `board-card is-${block.kind}${color ? ` is-sticky is-${color}` : ''}${selected ? ' is-selected' : ''}${sized ? ' is-sized' : ''}${place ? '' : ' is-unplaced'}${linking ? ' is-target' : ''}`, style: place ? { left: place.x, top: place.y, width: place.w, height: place.h, zIndex: place.z } : { width: CARD_W }, onPointerDown: onSelect, "data-id": block.id, children: [_jsxs("header", { className: "board-card-head", onPointerDown: (event) => onPointerDown(event, block), title: "Drag to move it on the board", children: [_jsx("span", { className: "board-grip", "aria-hidden": "true", children: "\u22EE\u22EE" }), _jsx("span", { className: "board-card-kind", children: block.kind === 'text' ? (place?.color && !block.pin && !block.tag ? 'Sticky' : textLabel(block)) : block.label }), _jsx("span", { className: "board-card-colors", "aria-label": "Colour on the board", children: BOARD_COLORS.map((choice) => (_jsx("button", { type: "button", className: `is-${choice}`, "aria-pressed": choice === place?.color, "aria-label": `${choice[0].toUpperCase()}${choice.slice(1)}`, onClick: () => onColor(choice === place?.color ? null : choice) }, choice))) }), _jsx("button", { type: "button", className: "icon-btn sm", onClick: () => removeNote(paperId, block.id), "aria-label": "Delete from your notes", title: "Delete from your notes", children: _jsx(TrashIcon, { size: 13 }) })] }), block.kind === 'text' ? (_jsx(MarkdownNote, { md: block.md, focus: fresh, className: "board-write", onChange: (md) => updateNote(paperId, block.id, { md }) })) : (_jsxs(_Fragment, { children: [_jsx("div", { className: "board-card-body note-clip", dangerouslySetInnerHTML: { __html: html } }), block.note ? _jsx("p", { className: "board-card-note", children: block.note }) : null, _jsx("footer", { className: "board-card-foot", children: _jsxs("button", { type: "button", className: "note-source", onClick: onShowSource, title: block.source.from === 'explain' ? 'Show it in the explanation' : 'Show it in the paper', children: [block.source.from === 'explain' ? _jsx(ExplainIcon, { size: 12 }) : _jsx(FileIcon, { size: 12 }), " ", sourceName(block.source)] }) })] })), _jsx("span", { className: "board-connect", onPointerDown: (event) => onConnect(event, block), title: "Drag to another card to draw an arrow", "aria-hidden": "true" }), _jsx("span", { className: "board-size", onPointerDown: (event) => onSize(event, block), "aria-hidden": "true", title: "Drag to resize" })] }));
}
/**
 * A paper's notes, full screen: each piece a card, moved by its bar,
 * sized by its corner, coloured, and joined to another by an arrow; frames
 * gather cards, and move them together. The board is panned by dragging it
 * (or the wheel) and zoomed with ⌘/Ctrl + the wheel. Double-clicking the
 * board writes a new note there; ⌘Z takes back the last change to the
 * board. Where the cards are is the board's alone: the list in the pane
 * keeps its own order.
 */
export default function NotesBoard({ paperId, title, onClose }) {
    const blocks = useNotes(paperId);
    const { layout, ready, update } = useBoardLayout(paperId);
    const view = layout.view ?? START;
    const wrap = useRef(null);
    const [size, setSize] = useState({ w: 0, h: 0 });
    const [heights, setHeights] = useState({});
    const [picked, setPicked] = useState(null);
    const selected = picked?.kind === 'card' ? picked.id : null;
    const [fresh, setFresh] = useState(null);
    const [tool, setTool] = useState('select');
    const [drawing, setDrawing] = useState(null);
    const [renaming, setRenaming] = useState(null);
    const [labelling, setLabelling] = useState(null);
    const gesture = useRef(null);
    const layoutRef = useRef(layout);
    layoutRef.current = layout;
    // While a card is moved: where it came from, and the lines it is pulled onto.
    const [ghost, setGhost] = useState(null);
    const [guides, setGuides] = useState([]);
    // Full screen, or beside the paper — the paper to the left, still read and kept from.
    const [where, setWhere] = useState(whereAtFirst);
    const choose = (next) => {
        if (next === 'list') {
            setNotesView('list');
            onClose();
            window.setTimeout(() => window.dispatchEvent(new CustomEvent(OPEN_NOTES)), 0);
            return;
        }
        setWhere(next);
        try {
            localStorage.setItem(WHERE_KEY, next);
        }
        catch {
            /* for this visit only */
        }
    };
    // Beside the paper, the board's keys are the board's only while it is the one being used.
    const section = useRef(null);
    const active = useRef(true);
    useEffect(() => {
        const onDown = (event) => {
            active.current = Boolean(section.current?.contains(event.target));
        };
        document.addEventListener('pointerdown', onDown, true);
        return () => document.removeEventListener('pointerdown', onDown, true);
    }, []);
    // ---- ⌘Z: the board as it was before the last change -------------------------
    const history = useRef([]);
    const remember = useCallback(() => {
        const { view: _view, ...rest } = layoutRef.current;
        history.current = [...history.current.slice(-(HISTORY - 1)), rest];
    }, []);
    const undo = useCallback(() => {
        const last = history.current.pop();
        if (last)
            update((current) => ({ ...last, view: current.view }));
    }, [update]);
    // How big the board is on the screen.
    useLayoutEffect(() => {
        const element = wrap.current;
        if (!element)
            return;
        const measure = () => setSize({ w: element.clientWidth, h: element.clientHeight });
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    // How tall each card is drawn — what a card not yet sized by hand takes up.
    const observer = useRef(null);
    const observed = useRef(new Map());
    if (!observer.current && typeof ResizeObserver !== 'undefined') {
        observer.current = new ResizeObserver((entries) => {
            setHeights((current) => {
                let next = current;
                for (const entry of entries) {
                    const id = entry.target.dataset.id;
                    const height = Math.round(entry.target.offsetHeight);
                    if (id && current[id] !== height)
                        next = { ...next, [id]: height };
                }
                return next;
            });
        });
    }
    useEffect(() => () => observer.current?.disconnect(), []);
    const measure = useCallback((id, element) => {
        const was = observed.current.get(id);
        if (was === element)
            return;
        if (was)
            observer.current?.unobserve(was);
        if (element) {
            observed.current.set(id, element);
            observer.current?.observe(element);
        }
        else
            observed.current.delete(id);
    }, []);
    // A piece with no card on the board yet — kept while it was shut, or its
    // first opening — is put below the others once it has been measured; and
    // the board opened for the first time shows all of it.
    useLayoutEffect(() => {
        if (!ready || !size.w)
            return;
        const missing = blocks.filter((block) => !layout.places[block.id]);
        if (!missing.length) {
            if (!layout.view && blocks.length)
                update((current) => ({ ...current, view: fitView(current.places, heights, size.w, size.h) }));
            return;
        }
        if (missing.some((block) => heights[block.id] === undefined))
            return;
        const columns = Math.max(2, Math.min(5, Math.floor((size.w - 80) / (CARD_W + 24))));
        update((current) => {
            const places = placeNew(current.places, missing.map((block) => block.id), heights, columns);
            return { ...current, places, view: current.view ?? fitView(places, heights, size.w, size.h) };
        });
    }, [ready, blocks, layout.places, layout.view, heights, size.w, size.h, update]);
    const setView = useCallback((next) => update((current) => ({ ...current, view: next })), [update]);
    const toBoard = (clientX, clientY) => {
        const rect = wrap.current?.getBoundingClientRect();
        return { x: (clientX - (rect?.left ?? 0) - view.x) / view.zoom, y: (clientY - (rect?.top ?? 0) - view.y) / view.zoom };
    };
    const boxOf = (id) => {
        const place = layout.places[id];
        return place ? { x: place.x, y: place.y, w: place.w, h: place.h ?? heights[id] ?? 160 } : null;
    };
    // ⌘/Ctrl + the wheel zooms about the pointer — the page itself is not
    // zoomed — and the wheel alone pans, unless a card sized by hand is
    // scrolling what is in it.
    useEffect(() => {
        const element = wrap.current;
        if (!element)
            return;
        const onWheel = (event) => {
            const current = layoutRef.current.view ?? START;
            const rect = element.getBoundingClientRect();
            if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                update((layoutNow) => ({ ...layoutNow, view: zoomAt(current, current.zoom * Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top) }));
                return;
            }
            const within = event.target instanceof Element ? event.target.closest('.board-card.is-sized .board-card-body, .board-card.is-sized .board-write, .board-card.is-sized .note-shown') : null;
            if (within && within.scrollHeight > within.clientHeight)
                return;
            event.preventDefault();
            update((layoutNow) => ({ ...layoutNow, view: { ...current, x: current.x - event.deltaX, y: current.y - event.deltaY } }));
        };
        element.addEventListener('wheel', onWheel, { passive: false });
        return () => element.removeEventListener('wheel', onWheel);
    }, [update]);
    const raise = (id) => update((current) => {
        const place = current.places[id];
        if (!place)
            return current;
        const z = topZ(current.places);
        return place.z === z - 1 ? current : { ...current, places: { ...current.places, [id]: { ...place, z } } };
    });
    /** A new note, written where it is asked for: where the board was clicked, or the middle of the screen. */
    const write = (at, color) => {
        const spot = at ?? toBoard((wrap.current?.getBoundingClientRect().left ?? 0) + size.w / 2 - CARD_W / 2, (wrap.current?.getBoundingClientRect().top ?? 0) + size.h / 2 - 60);
        remember();
        const block = addText(paperId);
        update((current) => ({ ...current, places: { ...current.places, [block.id]: { x: Math.round(spot.x), y: Math.round(spot.y), w: color ? 220 : CARD_W, z: topZ(current.places), color } } }));
        setPicked({ kind: 'card', id: block.id });
        setFresh(block.id);
    };
    const onBoardDown = (event) => {
        if (event.button !== 0 || (event.target instanceof Element && event.target.closest(NOT_BOARD)))
            return;
        setPicked(null);
        setRenaming(null);
        setLabelling(null);
        document.activeElement?.blur?.();
        const at = toBoard(event.clientX, event.clientY);
        if (tool === 'text' || tool === 'sticky') {
            write({ x: at.x - 20, y: at.y - 16 }, tool === 'sticky' ? 'yellow' : undefined);
            setTool('select');
            return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        if (tool === 'frame') {
            gesture.current = { kind: 'draw', x0: at.x, y0: at.y };
            setDrawing({ x0: at.x, y0: at.y, x: at.x, y: at.y });
            return;
        }
        gesture.current = { kind: 'pan', x: event.clientX, y: event.clientY, from: view };
    };
    const startLink = (event, block) => {
        if (event.button !== 0 || !layout.places[block.id])
            return;
        event.preventDefault();
        event.stopPropagation();
        wrap.current?.setPointerCapture(event.pointerId);
        const at = toBoard(event.clientX, event.clientY);
        gesture.current = { kind: 'link', from: block.id };
        setDrawing({ from: block.id, x0: at.x, y0: at.y, x: at.x, y: at.y });
    };
    const onCardDown = (event, block) => {
        if (tool === 'arrow')
            return startLink(event, block);
        const place = layout.places[block.id];
        if (event.button !== 0 || !place || (event.target instanceof Element && event.target.closest('button')))
            return;
        event.preventDefault();
        wrap.current?.setPointerCapture(event.pointerId);
        remember();
        raise(block.id);
        setGhost(place);
        gesture.current = { kind: 'move', id: block.id, x: event.clientX, y: event.clientY, from: place };
    };
    const onSizeDown = (event, block) => {
        const place = layout.places[block.id];
        if (event.button !== 0 || !place)
            return;
        event.preventDefault();
        event.stopPropagation();
        wrap.current?.setPointerCapture(event.pointerId);
        remember();
        raise(block.id);
        gesture.current = { kind: 'size', id: block.id, x: event.clientX, y: event.clientY, from: place, height: place.h ?? heights[block.id] ?? 160 };
    };
    const onLabelDown = (event, id, from) => {
        if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button')))
            return;
        event.preventDefault();
        wrap.current?.setPointerCapture(event.pointerId);
        remember();
        gesture.current = { kind: 'label', id, x: event.clientX, y: event.clientY, from };
    };
    const onFrameDown = (event, frame, resize = false) => {
        if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button, input')))
            return;
        event.preventDefault();
        event.stopPropagation();
        wrap.current?.setPointerCapture(event.pointerId);
        remember();
        setPicked({ kind: 'frame', id: frame.id });
        if (resize) {
            gesture.current = { kind: 'frame-size', id: frame.id, x: event.clientX, y: event.clientY, from: frame };
            return;
        }
        // The cards inside go with it.
        const cards = {};
        for (const block of blocks) {
            const box = boxOf(block.id);
            if (box && inside(frame, box))
                cards[block.id] = layout.places[block.id];
        }
        gesture.current = { kind: 'frame', id: frame.id, x: event.clientX, y: event.clientY, from: frame, cards };
    };
    const onMove = (event) => {
        const now = gesture.current;
        if (!now)
            return;
        if (now.kind === 'link' || now.kind === 'draw') {
            const at = toBoard(event.clientX, event.clientY);
            setDrawing((current) => (current ? { ...current, x: at.x, y: at.y } : current));
            return;
        }
        const dx = event.clientX - now.x;
        const dy = event.clientY - now.y;
        if (now.kind === 'pan') {
            setView({ ...now.from, x: now.from.x + dx, y: now.from.y + dy });
            return;
        }
        const bx = Math.round(dx / view.zoom);
        const by = Math.round(dy / view.zoom);
        if (now.kind === 'label') {
            update((current) => ({ ...current, labels: current.labels?.map((label) => (label.id === now.id ? { ...label, x: now.from.x + bx, y: now.from.y + by } : label)) }));
            return;
        }
        if (now.kind === 'frame' || now.kind === 'frame-size') {
            update((current) => {
                const frames = current.frames?.map((frame) => frame.id !== now.id ? frame : now.kind === 'frame' ? { ...frame, x: now.from.x + bx, y: now.from.y + by } : { ...frame, w: Math.max(120, now.from.w + bx), h: Math.max(80, now.from.h + by) });
                if (now.kind === 'frame-size')
                    return { ...current, frames };
                const places = { ...current.places };
                for (const [id, from] of Object.entries(now.cards))
                    if (places[id])
                        places[id] = { ...places[id], x: from.x + bx, y: from.y + by };
                return { ...current, frames, places };
            });
            return;
        }
        if (now.kind === 'move') {
            // Pulled into line with the cards near it — unless ⌥ is held.
            const height = now.from.h ?? heights[now.id] ?? 160;
            const others = blocks.flatMap((block) => (block.id === now.id ? [] : (boxOf(block.id) ?? [])));
            const box = { x: now.from.x + bx, y: now.from.y + by, w: now.from.w, h: height };
            const snapped = event.altKey ? { x: box.x, y: box.y, guides: [] } : snap(box, others, SNAP_PX / view.zoom);
            setGuides(snapped.guides);
            update((current) => {
                const place = current.places[now.id];
                return place ? { ...current, places: { ...current.places, [now.id]: { ...place, x: snapped.x, y: snapped.y } } } : current;
            });
            return;
        }
        update((current) => {
            const place = current.places[now.id];
            if (!place)
                return current;
            return { ...current, places: { ...current.places, [now.id]: { ...place, w: Math.max(MIN_W, now.from.w + bx), h: Math.max(MIN_H, now.height + by) } } };
        });
    };
    const onUp = (event) => {
        const now = gesture.current;
        gesture.current = null;
        setGhost(null);
        setGuides([]);
        if (now?.kind === 'link') {
            // The card under the pointer, where it was let go.
            const under = document.elementsFromPoint(event.clientX, event.clientY).find((element) => element.closest('.board-card'))?.closest('.board-card');
            const to = under?.dataset.id;
            setDrawing(null);
            if (to && to !== now.from && !layout.links?.some((link) => (link.from === now.from && link.to === to) || (link.from === to && link.to === now.from))) {
                remember();
                const id = boardId('a');
                update((current) => ({ ...current, links: [...(current.links ?? []), { id, from: now.from, to }] }));
                setPicked({ kind: 'link', id });
            }
            setTool('select');
            return;
        }
        if (now?.kind === 'draw' && drawing) {
            setDrawing(null);
            const x = Math.min(drawing.x0, drawing.x);
            const y = Math.min(drawing.y0, drawing.y);
            const w = Math.abs(drawing.x - drawing.x0);
            const h = Math.abs(drawing.y - drawing.y0);
            setTool('select');
            if (w < 40 || h < 40)
                return;
            remember();
            const id = boardId('f');
            update((current) => ({ ...current, frames: [...(current.frames ?? []), { id, title: 'Frame', x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }] }));
            setPicked({ kind: 'frame', id });
            setRenaming(id);
        }
    };
    const tidy = () => {
        remember();
        const { places, frames } = tidyBySection(blocks, heights, layout.places);
        // Frames drawn by hand stay where they are; a tidy's own are drawn again.
        update((current) => ({ ...current, places, labels: [], frames: [...(current.frames ?? []).filter((frame) => !frame.auto), ...frames], view: fitView(places, heights, size.w, size.h) }));
    };
    const fit = () => setView(fitView(layout.places, heights, size.w, size.h));
    const zoomBy = (factor) => setView(zoomAt(view, view.zoom * factor, size.w / 2, size.h / 2));
    const color = (id, next) => {
        remember();
        update((current) => {
            const place = current.places[id];
            if (!place)
                return current;
            const { color: _was, ...rest } = place;
            return { ...current, places: { ...current.places, [id]: next ? { ...rest, color: next } : rest } };
        });
    };
    const dropPicked = () => {
        if (!picked || picked.kind === 'card')
            return;
        remember();
        if (picked.kind === 'link')
            update((current) => ({ ...current, links: current.links?.filter((link) => link.id !== picked.id) }));
        else
            update((current) => ({ ...current, frames: current.frames?.filter((frame) => frame.id !== picked.id) }));
        setPicked(null);
    };
    // Keys: Esc out of what is being written, then out of a tool, then off the
    // board; V T S F A pick a tool; Delete takes an arrow or a frame away; ⌘Z
    // undoes; the arrows nudge the card picked.
    useEffect(() => {
        const onKey = (event) => {
            if (where === 'beside' && !active.current)
                return;
            const typing = event.target instanceof HTMLElement && event.target.closest('textarea, input, [contenteditable="true"]');
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                if (typing)
                    event.target.blur();
                else if (drawing) {
                    gesture.current = null;
                    setDrawing(null);
                }
                else if (tool !== 'select')
                    setTool('select');
                else
                    onClose();
                return;
            }
            if (typing)
                return;
            if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
                event.preventDefault();
                event.stopPropagation();
                undo();
                return;
            }
            if (event.metaKey || event.ctrlKey || event.altKey)
                return;
            if ((event.key === 'Delete' || event.key === 'Backspace') && picked && picked.kind !== 'card') {
                event.preventDefault();
                dropPicked();
                return;
            }
            const chosen = TOOLS.find((item) => item.key.toLowerCase() === event.key.toLowerCase());
            if (chosen) {
                event.preventDefault();
                event.stopPropagation();
                setTool(chosen.id);
                return;
            }
            if (!selected)
                return;
            const step = event.shiftKey ? 40 : 10;
            const by = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
            if (!by)
                return;
            event.preventDefault();
            update((current) => {
                const place = current.places[selected];
                return place ? { ...current, places: { ...current.places, [selected]: { ...place, x: place.x + by[0], y: place.y + by[1] } } } : current;
            });
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    });
    // The whole board in small, and the part of it on the screen.
    const mini = useMemo(() => {
        const rects = blocks.flatMap((block) => {
            const place = layout.places[block.id];
            return place ? [{ id: block.id, x: place.x, y: place.y, w: place.w, h: place.h ?? heights[block.id] ?? 160 }] : [];
        });
        if (!rects.length || !size.w)
            return null;
        const seen = { x: -view.x / view.zoom, y: -view.y / view.zoom, w: size.w / view.zoom, h: size.h / view.zoom };
        const frames = layout.frames ?? [];
        const all = [...rects, ...frames, seen];
        const left = Math.min(...all.map((rect) => rect.x));
        const top = Math.min(...all.map((rect) => rect.y));
        const right = Math.max(...all.map((rect) => rect.x + rect.w));
        const bottom = Math.max(...all.map((rect) => rect.y + rect.h));
        const scale = Math.min((MINI_W - 12) / (right - left), (MINI_H - 12) / (bottom - top));
        const box = (rect) => ({ left: 6 + (rect.x - left) * scale, top: 6 + (rect.y - top) * scale, width: Math.max(2, rect.w * scale), height: Math.max(2, rect.h * scale) });
        return { rects: rects.map((rect) => ({ id: rect.id, style: box(rect) })), frames: frames.map((frame) => ({ id: frame.id, style: box(frame) })), seen: box(seen), left, top, scale };
    }, [blocks, layout.places, layout.frames, heights, view, size]);
    const jump = (event) => {
        if (!mini)
            return;
        const rect = event.currentTarget.getBoundingClientRect();
        const bx = mini.left + (event.clientX - rect.left - 6) / mini.scale;
        const by = mini.top + (event.clientY - rect.top - 6) / mini.scale;
        setView({ ...view, x: Math.round(size.w / 2 - bx * view.zoom), y: Math.round(size.h / 2 - by * view.zoom) });
    };
    // The arrows, from edge to edge of the cards they join.
    const present = new Set(blocks.map((block) => block.id));
    const arrows = (layout.links ?? []).flatMap((link) => {
        if (!present.has(link.from) || !present.has(link.to))
            return [];
        const a = boxOf(link.from);
        const b = boxOf(link.to);
        if (!a || !b)
            return [];
        const start = edgePoint(a, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
        const end = edgePoint(b, { x: a.x + a.w / 2, y: a.y + a.h / 2 });
        const { d, mid } = curve(start, end);
        return [{ link, d, mid }];
    });
    const drawingFrom = drawing?.from ? boxOf(drawing.from) : null;
    const exportMarkdown = () => saveMarkdown(title, `# ${title}\n\n${notesMarkdown(blocks)}`);
    const toolNow = TOOLS.find((item) => item.id === tool);
    return (_jsxs("section", { ref: section, className: `notes-board${where === 'beside' ? ' layout-beside' : ''}`, role: "dialog", "aria-modal": where === 'full', "aria-label": `Notes board: ${title}`, children: [_jsxs("header", { className: "explain-bar board-bar", children: [_jsxs("span", { className: "explain-brand", children: [_jsx(NoteIcon, { size: 15 }), " Notes board"] }), _jsxs("span", { className: "explain-bar-title", title: title, children: [title, " \u00B7 ", blocks.length, " piece", blocks.length === 1 ? '' : 's', layout.links?.length ? ` · ${layout.links.length} arrow${layout.links.length === 1 ? '' : 's'}` : ''] }), _jsxs("span", { className: "segmented board-where", role: "group", "aria-label": "Where the board is", children: [_jsx("button", { type: "button", "aria-pressed": where === 'full', onClick: () => choose('full'), title: "The board full screen", children: "Board" }), _jsx("button", { type: "button", "aria-pressed": where === 'beside', onClick: () => choose('beside'), title: "The board beside the paper, which stays to be read and kept from", children: "Beside the paper" }), _jsx("button", { type: "button", "aria-pressed": false, onClick: () => choose('list'), title: "Back to the notes as a list, in the pane", children: "List" })] }), _jsx("span", { className: "board-sync", title: "Moving a card here never changes the order of the list in the notes pane", children: "\u21C5 List order: separate" }), _jsx("button", { type: "button", className: "btn ghost sm", onClick: undo, title: "Undo the last change to the board (\u2318Z)", children: "\u21B6 Undo" }), _jsxs("button", { type: "button", className: "btn ghost sm", onClick: exportMarkdown, disabled: !blocks.length, children: [_jsx(DownloadIcon, { size: 14 }), " Export"] }), _jsx("button", { type: "button", className: "icon-btn sm", onClick: onClose, "aria-label": "Close the board", title: "Back to the paper (Esc or B)", children: _jsx(CloseIcon, { size: 17 }) })] }), _jsxs("div", { ref: wrap, className: `board-wrap tool-${tool}`, style: { ['--zoom']: String(view.zoom), backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${22 * view.zoom}px ${22 * view.zoom}px` }, onPointerDown: onBoardDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: () => {
                    gesture.current = null;
                    setDrawing(null);
                }, onDoubleClick: (event) => {
                    if (tool !== 'select' || (event.target instanceof Element && event.target.closest(NOT_BOARD)))
                        return;
                    write(toBoard(event.clientX - 20, event.clientY - 16));
                }, children: [_jsxs("div", { className: "board-world", style: { transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }, children: [(layout.frames ?? []).map((frame) => (_jsxs("div", { className: `board-frame${picked?.kind === 'frame' && picked.id === frame.id ? ' is-picked' : ''}`, style: { left: frame.x, top: frame.y, width: frame.w, height: frame.h }, children: [_jsxs("div", { className: "board-frame-head", onPointerDown: (event) => onFrameDown(event, frame), onDoubleClick: () => setRenaming(frame.id), title: "Drag to move the frame and what is in it \u00B7 double-click to rename", children: [renaming === frame.id ? (_jsx("input", { autoFocus: true, defaultValue: frame.title, "aria-label": "Frame name", onFocus: (event) => event.currentTarget.select(), onBlur: (event) => {
                                                    const name = event.currentTarget.value.trim() || 'Frame';
                                                    update((current) => ({ ...current, frames: current.frames?.map((item) => (item.id === frame.id ? { ...item, title: name, auto: false } : item)) }));
                                                    setRenaming(null);
                                                }, onKeyDown: (event) => {
                                                    if (event.key === 'Enter' || event.key === 'Escape') {
                                                        event.preventDefault();
                                                        event.currentTarget.blur();
                                                    }
                                                } })) : (_jsxs("span", { children: [frame.title, frame.page ? _jsxs("small", { children: [" p. ", frame.page] }) : null] })), _jsx("button", { type: "button", onClick: () => { setPicked({ kind: 'frame', id: frame.id }); remember(); update((current) => ({ ...current, frames: current.frames?.filter((item) => item.id !== frame.id) })); }, "aria-label": `Remove the frame ${frame.title}`, title: "Remove the frame (the cards stay)", children: "\u00D7" })] }), _jsx("span", { className: "board-frame-size", onPointerDown: (event) => onFrameDown(event, frame, true), "aria-hidden": "true" })] }, frame.id))), (layout.labels ?? []).map((label) => (_jsxs("div", { className: "board-label", style: { left: label.x, top: label.y }, onPointerDown: (event) => onLabelDown(event, label.id, label), children: [label.text, _jsx("button", { type: "button", onClick: () => update((current) => ({ ...current, labels: current.labels?.filter((item) => item.id !== label.id) })), "aria-label": `Remove the heading ${label.text}`, children: "\u00D7" })] }, label.id))), _jsxs("svg", { className: "board-links", width: "1", height: "1", "aria-hidden": "true", children: [_jsxs("defs", { children: [_jsx("marker", { id: "board-arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "8", markerHeight: "8", orient: "auto-start-reverse", children: _jsx("path", { d: "M0,0 L10,5 L0,10 z", className: "board-arrow-head" }) }), _jsx("marker", { id: "board-arrow-picked", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "8", markerHeight: "8", orient: "auto-start-reverse", children: _jsx("path", { d: "M0,0 L10,5 L0,10 z", className: "board-arrow-head is-picked" }) })] }), arrows.map(({ link, d }) => {
                                        const isPicked = picked?.kind === 'link' && picked.id === link.id;
                                        return (_jsxs("g", { children: [_jsx("path", { className: `board-link${isPicked ? ' is-picked' : ''}`, d: d, markerEnd: `url(#${isPicked ? 'board-arrow-picked' : 'board-arrow'})` }), _jsx("path", { className: "board-link-hit", d: d, onPointerDown: (event) => {
                                                        event.stopPropagation();
                                                        setPicked({ kind: 'link', id: link.id });
                                                    }, onDoubleClick: (event) => {
                                                        event.stopPropagation();
                                                        setLabelling(link.id);
                                                    } })] }, link.id));
                                    }), drawing?.from && drawingFrom ? ((() => {
                                        const start = edgePoint(drawingFrom, { x: drawing.x, y: drawing.y });
                                        return _jsx("line", { className: "board-link is-drawing", x1: start.x, y1: start.y, x2: drawing.x, y2: drawing.y, markerEnd: "url(#board-arrow-picked)" });
                                    })()) : null] }), arrows.map(({ link, mid }) => labelling === link.id ? (_jsx("input", { className: "board-link-label is-editing", style: { left: mid.x, top: mid.y }, autoFocus: true, defaultValue: link.label ?? '', placeholder: "Say how\u2026", "aria-label": "What the arrow says", onBlur: (event) => {
                                    const said = event.currentTarget.value.trim();
                                    remember();
                                    update((current) => ({ ...current, links: current.links?.map((item) => (item.id === link.id ? { ...item, label: said || undefined } : item)) }));
                                    setLabelling(null);
                                }, onKeyDown: (event) => {
                                    if (event.key === 'Enter' || event.key === 'Escape') {
                                        event.preventDefault();
                                        event.currentTarget.blur();
                                    }
                                } }, link.id)) : link.label || (picked?.kind === 'link' && picked.id === link.id) ? (_jsxs("span", { className: `board-link-label${link.label ? '' : ' is-empty'}${picked?.kind === 'link' && picked.id === link.id ? ' is-picked' : ''}`, style: { left: mid.x, top: mid.y }, onPointerDown: (event) => {
                                    event.stopPropagation();
                                    setPicked({ kind: 'link', id: link.id });
                                }, onDoubleClick: () => setLabelling(link.id), children: [link.label || 'Double-click to label', picked?.kind === 'link' && picked.id === link.id ? (_jsx("button", { type: "button", onClick: dropPicked, "aria-label": "Remove the arrow", title: "Remove the arrow (Delete)", children: "\u00D7" })) : null] }, link.id)) : null), ghost ? _jsx("div", { className: "board-ghost", style: { left: ghost.x, top: ghost.y, width: ghost.w, height: ghost.h ?? heights[gesture.current?.kind === 'move' ? gesture.current.id : ''] ?? 160 } }) : null, blocks.map((block) => (_jsx(Card, { block: block, paperId: paperId, place: layout.places[block.id], selected: selected === block.id, fresh: fresh === block.id, linking: Boolean(drawing?.from) && drawing?.from !== block.id, onPointerDown: onCardDown, onSize: onSizeDown, onConnect: startLink, onSelect: () => setPicked({ kind: 'card', id: block.id }), onColor: (next) => color(block.id, next), onShowSource: () => {
                                    if (block.kind !== 'clip')
                                        return;
                                    onClose();
                                    window.setTimeout(() => void showSource(block.source), 60);
                                }, measure: measure }, block.id))), guides.map((guide) => (_jsx("span", { className: `board-guide is-${guide.axis}`, style: guide.axis === 'x' ? { left: guide.at, top: guide.from, height: guide.to - guide.from } : { top: guide.at, left: guide.from, width: guide.to - guide.from } }, `${guide.axis}${guide.at}`))), ghost && gesture.current?.kind === 'move' && layout.places[gesture.current.id] ? (_jsx("div", { className: "board-drag-tip", style: { left: layout.places[gesture.current.id].x, top: layout.places[gesture.current.id].y + (layout.places[gesture.current.id].h ?? heights[gesture.current.id] ?? 160) + 10 }, children: "Moves on the board only \u2014 the list keeps its own order \u00B7 \u2325 to move freely" })) : null, drawing && !drawing.from ? (_jsx("div", { className: "board-frame is-drawing", style: { left: Math.min(drawing.x0, drawing.x), top: Math.min(drawing.y0, drawing.y), width: Math.abs(drawing.x - drawing.x0), height: Math.abs(drawing.y - drawing.y0) } })) : null] }), !blocks.length ? (_jsxs("div", { className: "board-empty", children: [_jsx("p", { children: "Nothing on this paper's board yet." }), _jsx("p", { children: "Double-click anywhere to write, or keep figures, tables and passages from the paper \u2014 they land here too." })] })) : null, tool !== 'select' && toolNow ? _jsxs("div", { className: "board-tool-hint", children: [toolNow.hint, " \u00B7 Esc to stop"] }) : null, _jsxs("div", { className: "board-tools", role: "toolbar", "aria-label": "Board", children: [TOOLS.map((item) => (_jsxs("button", { type: "button", "aria-pressed": tool === item.id, onClick: () => setTool(item.id), title: `${item.hint} (${item.key})`, children: [_jsx("span", { "aria-hidden": "true", children: item.icon }), " ", item.name, " ", _jsx("kbd", { children: item.key })] }, item.id))), _jsx("i", { "aria-hidden": "true" }), _jsx("button", { type: "button", onClick: tidy, disabled: !blocks.length, title: "Put every card back in columns, one frame to a section", children: "\u2630 Tidy by section" }), _jsx("button", { type: "button", onClick: fit, disabled: !blocks.length, title: "Show every card", children: "\u2922 Fit" })] }), _jsxs("div", { className: "board-zoom", children: [_jsx("button", { type: "button", onClick: () => zoomBy(1 / 1.2), "aria-label": "Zoom out", disabled: view.zoom <= clampZoom(0), children: "\u2212" }), _jsxs("button", { type: "button", className: "board-zoom-at", onClick: () => setView(zoomAt(view, 1, size.w / 2, size.h / 2)), title: "Back to 100%", children: [Math.round(view.zoom * 100), "%"] }), _jsx("button", { type: "button", onClick: () => zoomBy(1.2), "aria-label": "Zoom in", disabled: view.zoom >= clampZoom(99), children: "+" })] }), mini ? (_jsxs("div", { className: "board-mini", onPointerDown: jump, title: "The whole board \u2014 click to go there", "aria-hidden": "true", children: [mini.frames.map((frame) => (_jsx("i", { style: frame.style }, frame.id))), mini.rects.map((rect) => (_jsx("b", { style: rect.style, className: rect.id === selected ? 'is-selected' : undefined }, rect.id))), _jsx("span", { className: "board-mini-seen", style: mini.seen })] })) : null] })] }));
}
