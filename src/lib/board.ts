// ===========================================================================
//  The notes board: a paper's notes laid out full screen, each piece a card
//  put anywhere and sized as you like. Where the cards are is the board's
//  own, kept apart from the notes themselves (`board:<paperId>`), so moving
//  a card here never changes the order of the list in the pane, and moving a
//  piece in the list never moves its card.
// ===========================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from './db';
import type { NoteBlock } from './notes';

/** Where a card is on the board, in board units (a unit is a pixel at 100%). */
export interface Place {
  x: number;
  y: number;
  w: number;
  /** Set once the card is sized by hand; until then it is as tall as what is in it. */
  h?: number;
  /** Which is on top: the last one touched. */
  z: number;
}

export interface BoardView {
  /** Where the board's origin is on the screen. */
  x: number;
  y: number;
  zoom: number;
}

/** A heading on the board — a section's name, put there by a tidy. */
export interface BoardLabel {
  id: string;
  text: string;
  x: number;
  y: number;
}

export interface BoardLayout {
  places: Record<string, Place>;
  labels?: BoardLabel[];
  view?: BoardView;
}

export const CARD_W = 300;
export const GAP = 24;
export const EDGE = 40;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;

export const clampZoom = (zoom: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100));

const KEY = (paperId: string) => `board:${paperId}`;

/** The top the next card takes: the highest card's z, and one. */
export const topZ = (places: Record<string, Place>) => Object.values(places).reduce((top, place) => Math.max(top, place.z), 0) + 1;

const bottomOf = (place: Place, height: number) => place.y + (place.h ?? height);

/**
 * Cards without a place put below the others, in the column that is
 * shortest, in the order they are in the list — the way a board fills when a
 * piece is kept while it is shut. `heights` is how tall each card is drawn.
 */
export function placeNew(places: Record<string, Place>, ids: string[], heights: Record<string, number>, columns = 3): Record<string, Place> {
  const next = { ...places };
  const bottoms = Array.from({ length: columns }, (_, column) => {
    const left = EDGE + column * (CARD_W + GAP);
    return Object.entries(next)
      .filter(([, place]) => place.x < left + CARD_W && place.x + place.w > left)
      .reduce((lowest, [id, place]) => Math.max(lowest, bottomOf(place, heights[id] ?? 160) + GAP), EDGE);
  });
  let z = topZ(next);
  for (const id of ids) {
    if (next[id]) continue;
    const column = bottoms.indexOf(Math.min(...bottoms));
    next[id] = { x: EDGE + column * (CARD_W + GAP), y: bottoms[column], w: CARD_W, z: z++ };
    bottoms[column] += (heights[id] ?? 160) + GAP;
  }
  return next;
}

/** The section a piece belongs with: its own, or — for something written — the one kept just before it. */
export function sectionsOf(blocks: NoteBlock[]): string[] {
  let last = 'Your notes';
  return blocks.map((block) => {
    if (block.kind === 'clip') last = block.source.section?.trim() || (block.source.from === 'explain' ? 'From Explain' : 'From the paper');
    else if (block.source?.section?.trim()) return block.source.section.trim();
    return last;
  });
}

/**
 * Every card put back in columns, one to a section, in the list's order —
 * a way back from a board that has got out of hand. Sizes set by hand stay.
 */
export function tidyBySection(blocks: NoteBlock[], heights: Record<string, number>, places: Record<string, Place>): { places: Record<string, Place>; labels: BoardLabel[] } {
  const sections = sectionsOf(blocks);
  const order: string[] = [];
  sections.forEach((section) => {
    if (!order.includes(section)) order.push(section);
  });
  const next: Record<string, Place> = {};
  const labels: BoardLabel[] = [];
  let z = 1;
  let x = EDGE;
  for (const section of order) {
    let y = EDGE + 28;
    let widest = CARD_W;
    labels.push({ id: `l${labels.length}`, text: section, x, y: EDGE });
    blocks.forEach((block, index) => {
      if (sections[index] !== section) return;
      const kept = places[block.id];
      const w = kept?.w ?? CARD_W;
      next[block.id] = { x, y, w, h: kept?.h, z: z++ };
      y += (kept?.h ?? heights[block.id] ?? 160) + GAP;
      widest = Math.max(widest, w);
    });
    x += widest + GAP * 2;
  }
  return { places: next, labels };
}

/** The view that shows every card, with a margin, no closer than 100%. */
export function fitView(places: Record<string, Place>, heights: Record<string, number>, width: number, height: number): BoardView {
  const entries = Object.entries(places);
  if (!entries.length) return { x: 0, y: 0, zoom: 1 };
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
export function zoomAt(view: BoardView, zoom: number, px: number, py: number): BoardView {
  const next = clampZoom(zoom);
  const bx = (px - view.x) / view.zoom;
  const by = (py - view.y) / view.zoom;
  return { x: Math.round(px - bx * next), y: Math.round(py - by * next), zoom: next };
}

// ---------------------------------------------------------------------------
// Kept in IndexedDB, a paper to a board
// ---------------------------------------------------------------------------

/** A paper's board, read once and written a moment after each change. `ready` once it is read. */
export function useBoardLayout(paperId: string) {
  const [layout, setLayout] = useState<BoardLayout>({ places: {} });
  const [ready, setReady] = useState(false);
  const timer = useRef<number>();
  const latest = useRef(layout);

  useEffect(() => {
    let live = true;
    setReady(false);
    db.getKv<BoardLayout>(KEY(paperId))
      .catch(() => undefined)
      .then((kept) => {
        if (!live) return;
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
  useEffect(
    () => () => {
      if (timer.current !== undefined) save();
    },
    [save],
  );

  const update = useCallback(
    (change: (current: BoardLayout) => BoardLayout) => {
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
    },
    [save],
  );

  return { layout, ready, update };
}
