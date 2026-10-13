// ===========================================================================
//  The notes board: a paper's notes laid out full screen, each piece a card
//  put anywhere and sized as you like. Where the cards are is the board's
//  own, kept apart from the notes themselves (`board:<paperId>`), so moving
//  a card here never changes the order of the list in the pane, and moving a
//  piece in the list never moves its card.
// ===========================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from './db';
export const BOARD_COLORS = ['yellow', 'green', 'blue', 'pink'];
/**
 * A card being moved to `box`, pulled into line with the others it comes
 * within `reach` of — its left, middle or right on theirs, and its top,
 * middle or bottom — and the lines it was pulled onto, to be drawn.
 */
export function snap(box, others, reach) {
    let best = { dx: Infinity, dy: Infinity };
    let hitX = null;
    let hitY = null;
    const mine = { x: [box.x, box.x + box.w / 2, box.x + box.w], y: [box.y, box.y + box.h / 2, box.y + box.h] };
    for (const other of others) {
        const theirs = { x: [other.x, other.x + other.w / 2, other.x + other.w], y: [other.y, other.y + other.h / 2, other.y + other.h] };
        for (const a of mine.x)
            for (const b of theirs.x)
                if (Math.abs(b - a) <= reach && Math.abs(b - a) < Math.abs(best.dx)) {
                    best = { ...best, dx: b - a };
                    hitX = { at: b, other };
                }
        for (const a of mine.y)
            for (const b of theirs.y)
                if (Math.abs(b - a) <= reach && Math.abs(b - a) < Math.abs(best.dy)) {
                    best = { ...best, dy: b - a };
                    hitY = { at: b, other };
                }
    }
    const x = box.x + (Number.isFinite(best.dx) ? best.dx : 0);
    const y = box.y + (Number.isFinite(best.dy) ? best.dy : 0);
    const guides = [];
    if (hitX)
        guides.push({ axis: 'x', at: hitX.at, from: Math.min(y, hitX.other.y) - 24, to: Math.max(y + box.h, hitX.other.y + hitX.other.h) + 24 });
    if (hitY)
        guides.push({ axis: 'y', at: hitY.at, from: Math.min(x, hitY.other.x) - 24, to: Math.max(x + box.w, hitY.other.x + hitY.other.w) + 24 });
    return { x: Math.round(x), y: Math.round(y), guides };
}
/** A gentle curve from one point to another, leaving and arriving along the way it mostly runs; and its middle. */
export function curve(start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const across = Math.abs(dx) >= Math.abs(dy);
    const c1 = across ? { x: start.x + dx / 2, y: start.y } : { x: start.x, y: start.y + dy / 2 };
    const c2 = across ? { x: start.x + dx / 2, y: end.y } : { x: end.x, y: start.y + dy / 2 };
    return {
        d: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`,
        mid: { x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8, y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8 },
    };
}
export const boardId = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** Where a line from a box's middle towards a point leaves the box. */
export function edgePoint(box, toward) {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const dx = toward.x - cx;
    const dy = toward.y - cy;
    if (!dx && !dy)
        return { x: cx, y: cy };
    const scale = Math.min(dx ? box.w / 2 / Math.abs(dx) : Infinity, dy ? box.h / 2 / Math.abs(dy) : Infinity);
    return { x: cx + dx * scale, y: cy + dy * scale };
}
/** Whether a box's middle lies inside a frame. */
export const inside = (frame, box) => {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    return cx >= frame.x && cx <= frame.x + frame.w && cy >= frame.y && cy <= frame.y + frame.h;
};
export const CARD_W = 300;
export const GAP = 24;
export const EDGE = 40;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;
export const clampZoom = (zoom) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100));
const KEY = (paperId) => `board:${paperId}`;
/** The top the next card takes: the highest card's z, and one. */
export const topZ = (places) => Object.values(places).reduce((top, place) => Math.max(top, place.z), 0) + 1;
const bottomOf = (place, height) => place.y + (place.h ?? height);
/**
 * Cards without a place put below the others, in the column that is
 * shortest, in the order they are in the list — the way a board fills when a
 * piece is kept while it is shut. `heights` is how tall each card is drawn.
 */
export function placeNew(places, ids, heights, columns = 3) {
    const next = { ...places };
    const bottoms = Array.from({ length: columns }, (_, column) => {
        const left = EDGE + column * (CARD_W + GAP);
        return Object.entries(next)
            .filter(([, place]) => place.x < left + CARD_W && place.x + place.w > left)
            .reduce((lowest, [id, place]) => Math.max(lowest, bottomOf(place, heights[id] ?? 160) + GAP), EDGE);
    });
    let z = topZ(next);
    for (const id of ids) {
        if (next[id])
            continue;
        const column = bottoms.indexOf(Math.min(...bottoms));
        next[id] = { x: EDGE + column * (CARD_W + GAP), y: bottoms[column], w: CARD_W, z: z++ };
        bottoms[column] += (heights[id] ?? 160) + GAP;
    }
    return next;
}
/** The section a piece belongs with: its own, or — for something written — the one kept just before it. */
export function sectionsOf(blocks) {
    let last = 'Your notes';
    return blocks.map((block) => {
        if (block.kind === 'clip')
            last = block.source.section?.trim() || (block.source.from === 'explain' ? 'From Explain' : 'From the paper');
        else if (block.source?.section?.trim())
            return block.source.section.trim();
        return last;
    });
}
/**
 * Every card put back in columns, one to a section, in the list's order —
 * a way back from a board that has got out of hand. Sizes set by hand stay.
 */
export function tidyBySection(blocks, heights, places) {
    const sections = sectionsOf(blocks);
    const order = [];
    sections.forEach((section) => {
        if (!order.includes(section))
            order.push(section);
    });
    const next = {};
    const labels = [];
    const frames = [];
    let z = 1;
    let x = EDGE;
    for (const section of order) {
        let y = EDGE + 28;
        let widest = CARD_W;
        const top = y;
        let page;
        blocks.forEach((block, index) => {
            if (sections[index] === section && block.kind === 'clip' && block.source.page)
                page = Math.min(page ?? Infinity, block.source.page);
            if (sections[index] !== section)
                return;
            const kept = places[block.id];
            const w = kept?.w ?? CARD_W;
            next[block.id] = { x, y, w, h: kept?.h, z: z++, color: kept?.color };
            y += (kept?.h ?? heights[block.id] ?? 160) + GAP;
            widest = Math.max(widest, w);
        });
        frames.push({ id: `auto-${frames.length}`, title: section, x: x - 14, y: top - 40, w: widest + 28, h: y - GAP - top + 54, auto: true, page });
        x += widest + GAP * 2;
    }
    return { places: next, labels, frames };
}
/** The view that shows every card, with a margin, no closer than 100%. */
export function fitView(places, heights, width, height) {
    const entries = Object.entries(places);
    if (!entries.length)
        return { x: 0, y: 0, zoom: 1 };
    const left = Math.min(...entries.map(([, place]) => place.x));
    const top = Math.min(...entries.map(([, place]) => place.y));
    const right = Math.max(...entries.map(([, place]) => place.x + place.w));
    const bottom = Math.max(...entries.map(([id, place]) => bottomOf(place, heights[id] ?? 160)));
    const margin = 48;
    const zoom = clampZoom(Math.min(1, (width - margin * 2) / Math.max(1, right - left), (height - margin * 2) / Math.max(1, bottom - top)));
    return {
        x: Math.round((width - (right - left) * zoom) / 2 - left * zoom),
        y: Math.round(Math.max(margin, (height - (bottom - top) * zoom) / 2) - top * zoom),
        zoom,
    };
}
/** A zoom about a point on the screen: that point stays where it is. */
export function zoomAt(view, zoom, px, py) {
    const next = clampZoom(zoom);
    const bx = (px - view.x) / view.zoom;
    const by = (py - view.y) / view.zoom;
    return { x: Math.round(px - bx * next), y: Math.round(py - by * next), zoom: next };
}
// ---------------------------------------------------------------------------
// Kept in IndexedDB, a paper to a board
// ---------------------------------------------------------------------------
/** A paper's board, read once and written a moment after each change. `ready` once it is read. */
export function useBoardLayout(paperId) {
    const [layout, setLayout] = useState({ places: {} });
    const [ready, setReady] = useState(false);
    const timer = useRef();
    const latest = useRef(layout);
    useEffect(() => {
        let live = true;
        setReady(false);
        db.getKv(KEY(paperId))
            .catch(() => undefined)
            .then((kept) => {
            if (!live)
                return;
            const read = kept && typeof kept === 'object' && kept.places ? kept : { places: {} };
            latest.current = read;
            setLayout(read);
            setReady(true);
        });
        return () => {
            live = false;
        };
    }, [paperId]);
    const save = useCallback(() => {
        window.clearTimeout(timer.current);
        void db.setKv(KEY(paperId), latest.current).catch(() => undefined);
    }, [paperId]);
    // Whatever is still waiting to be written is written as the board shuts.
    useEffect(() => () => {
        if (timer.current !== undefined)
            save();
    }, [save]);
    const update = useCallback((change) => {
        setLayout((current) => {
            const next = change(current);
            latest.current = next;
            return next;
        });
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
            timer.current = undefined;
            save();
        }, 400);
    }, [save]);
    return { layout, ready, update };
}
