import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  SNAP_STEPS,
  RUN_GAP,
  STACK_WIDTH,
  defaultRect,
  dropWindow,
  fit,
  isFrontWindow,
  loadWindow,
  nudge,
  raiseWindow,
  resize,
  saveWindow,
  snap,
  stride,
  watchWindows,
  windowOrder,
  zoom,
} from '../lib/floatWindow';
import type { Rect, Side, Viewport, WindowPrefs } from '../lib/floatWindow';

// ===========================================================================
//  A window over the reader: moved by its bar, resized from any edge or
//  corner, zoomed by a double-click on the bar, moved with ⌘ + arrows and
//  thrown at an edge with ⌘⇧ + arrows, and kept where it was left across
//  reloads. Ask Claude is one; the notes, popped out, are another. The
//  geometry is `lib/floatWindow.ts`; this is the element's side of it.
// ===========================================================================

const DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const ARROWS: Record<string, Side> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
const EDGE_NAME: Record<Side, string> = { left: 'left', right: 'right', up: 'top', down: 'bottom' };

/** The windows' layer: above the reader and its panes, below the sheets. */
const Z_BASE = 45;

export const viewport = (): Viewport => ({ width: window.innerWidth, height: window.innerHeight });
export const stacked = () => window.innerWidth <= STACK_WIDTH;

export const isEditable = (el: Element | null) =>
  !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable);

interface Options {
  /** Which window this is, for knowing which one is in front. */
  id: string;
  /** Where its place is kept in `localStorage`. */
  store: string;
  /** What it is called when its moves are read out: "Claude window". */
  name: string;
  /** Where it goes the first time, before it has been placed. */
  start?: (view: Viewport) => Rect;
  /** Something to read out to a screen reader. */
  say: (text: string) => void;
}

export function useFloatingWindow({ id, store, name, start = defaultRect, say }: Options) {
  const [win, setWin] = useState(() => loadWindow(store));
  const [rect, setRect] = useState<Rect>(() => fit(win.rect ?? start(viewport()), viewport()));
  const [isStacked, setStacked] = useState(stacked);
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const drag = useRef<{ id: number; dir: string | null; x0: number; y0: number; start: Rect } | null>(null);
  const snapped = useRef<{ side: Side; step: number } | null>(null);
  const run = useRef<{ side: Side; step: number; at: number; stuck: boolean } | null>(null);
  const runSave = useRef(0);
  const sayNow = useRef(say);
  sayNow.current = say;

  const persist = useCallback(
    (next: Rect, patch: Partial<WindowPrefs> = {}) => {
      setWin((current) => {
        const merged = { ...current, ...patch, rect: next };
        saveWindow(merged, store);
        return merged;
      });
    },
    [store],
  );

  /** Put the window somewhere, and keep it there. */
  const place = useCallback(
    (next: Rect) => {
      snapped.current = null;
      run.current = null;
      setRect(next);
      rectRef.current = next;
      persist(next);
    },
    [persist],
  );

  // Open, it is in front; the one pressed or typed in last stays in front.
  useEffect(() => {
    raiseWindow(id);
    return () => dropWindow(id);
  }, [id]);
  const order = useSyncExternalStore(watchWindows, windowOrder);
  const raise = useCallback(() => raiseWindow(id), [id]);

  // A window that survives a reload has to survive a resized browser too.
  useEffect(() => {
    const onResize = () => {
      setStacked(stacked());
      setRect((current) => fit(current, viewport()));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const begin = (event: ReactPointerEvent<HTMLElement>, dir: string | null) => {
    if (event.button !== 0 || stacked()) return;
    if (!dir && (event.target as HTMLElement).closest('button, a, input, select, textarea, label')) return;
    drag.current = { id: event.pointerId, dir, x0: event.clientX, y0: event.clientY, start: { ...rectRef.current } };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.body.classList.add('win-moving');
    event.preventDefault();
  };
  const step = (event: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.id) return;
    // Moved by hand: the next arrow press starts its cycle over.
    snapped.current = null;
    run.current = null;
    const dx = event.clientX - d.x0;
    const dy = event.clientY - d.y0;
    setRect(d.dir ? resize(d.start, d.dir, dx, dy, viewport()) : fit({ ...d.start, x: d.start.x + dx, y: d.start.y + dy }, viewport()));
  };
  const end = (event: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.id) return;
    event.currentTarget.releasePointerCapture?.(d.id);
    drag.current = null;
    document.body.classList.remove('win-moving');
    persist(rectRef.current);
  };

  // ---- the keyboard ---------------------------------------------------------
  // ⌘ + an arrow *moves* the window in front, faster the longer the key is
  // held; ⌘⇧ + an arrow throws it at that edge and cycles half / a third /
  // two thirds. Plain ⌘ + arrow is left alone in a text field, where it moves
  // the caret.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const side = ARROWS[event.key];
      if (!mod || !side || event.altKey || stacked() || !isFrontWindow(id)) return;
      if (event.shiftKey) {
        event.preventDefault();
        const i = snapped.current?.side === side ? snapped.current.step + 1 : 0;
        snapped.current = { side, step: i % SNAP_STEPS.length };
        run.current = null;
        const next = snap(side, i, viewport());
        setRect(next);
        persist(next);
        sayNow.current(`${name}: ${EDGE_NAME[side]} ${SNAP_STEPS[i % SNAP_STEPS.length].label}`);
        return;
      }
      if (isEditable(document.activeElement)) return;
      event.preventDefault();
      snapped.current = null;
      const now = performance.now();
      const going = !!run.current && run.current.side === side && now - run.current.at < RUN_GAP;
      const by = stride(going ? run.current!.step : null);
      const before = rectRef.current;
      const moved = nudge(before, side, by, viewport());
      const stuck = moved.x === before.x && moved.y === before.y;
      setRect(moved);
      rectRef.current = moved;
      if (!going) persist(moved);
      clearTimeout(runSave.current);
      runSave.current = window.setTimeout(() => persist(rectRef.current), RUN_GAP);
      // A held arrow repeats thirty times a second: speak once when the run
      // starts, and once more the first time it runs out of room.
      if (stuck && !(going && run.current?.stuck)) sayNow.current(`${name}: at the ${EDGE_NAME[side]}`);
      else if (!going && !stuck) sayNow.current(`${name} moving ${side}`);
      run.current = { side, step: by, at: now, stuck };
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id, name, persist]);

  const floating = !isStacked;
  return {
    win,
    rect,
    rectRef,
    floating,
    persist,
    place,
    /** Pressed or typed in, the window comes to the front. */
    frame: {
      onPointerDownCapture: raise,
      onFocusCapture: raise,
    },
    /** Where it is and what it is layered at, for the element's style. */
    position: floating
      ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: Z_BASE + Math.max(0, order.indexOf(id)), ['--win-tint' as string]: String(win.tint) }
      : { zIndex: Z_BASE + Math.max(0, order.indexOf(id)) },
    /** The bar it is moved by; a double-click sends it home, or fills the page from there. */
    bar: {
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => begin(event, null),
      onPointerMove: step,
      onPointerUp: end,
      onPointerCancel: end,
      onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => {
        if (!floating || (event.target as HTMLElement).closest('button, input, label')) return;
        place(zoom(rectRef.current, viewport()));
      },
      title: floating ? 'Drag to move · double-click to zoom · ⌘ + arrows to move · ⌘⇧ + arrows to snap' : undefined,
    },
    /** The edges and corners it is resized by. */
    grips: floating
      ? DIRS.map((dir) => ({
          key: dir as string,
          className: `win-grip win-grip-${dir}`,
          onPointerDown: (event: ReactPointerEvent<HTMLElement>) => begin(event, dir),
          onPointerMove: step,
          onPointerUp: end,
          onPointerCancel: end,
        }))
      : [],
  };
}
