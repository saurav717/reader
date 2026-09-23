// ===========================================================================
//  Floating window.
//  The Ask Claude window sits *over* the reader instead of taking room from
//  it: moved by its title bar, resized from any edge or corner, and tinted
//  rather than painted, so the paper underneath stays readable while you read
//  the answer on top of it. Nothing behind it is blocked or dimmed, and it
//  keeps its place across reloads.
//
//  This module is the geometry only — pure functions over rectangles in
//  viewport pixels, since the window is `position: fixed`. The component owns
//  the element, the pointer events and the persistence.
// ===========================================================================

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Side = 'left' | 'right' | 'up' | 'down';

/** Smallest usable window. Below this the compose box and the thread collide. */
export const MIN = { w: 300, h: 240 };

/**
 * Margin kept between the window and the edges of the page. The window is
 * contained by the page: a corner dragged past the edge would take its resize
 * grip with it and never give it back.
 */
export const PAD = 10;

/** The rail on the left stays uncovered, so the button that closes the window is always reachable. */
export const LEFT_GUTTER = 60;

/** Below this the app stacks its panels, and the window becomes a sheet. */
export const STACK_WIDTH = 900;

/**
 * The fractions a snap cycles through when the same arrow is pressed again.
 * Half first because half is what you almost always want; a third when the
 * answer is short and the paper matters more; two thirds when it is long.
 */
export const SNAP_STEPS = [
  { f: 1 / 2, label: 'half' },
  { f: 1 / 3, label: 'third' },
  { f: 2 / 3, label: 'two thirds' },
];

/** How far one ⌘ + arrow moves the window from a standing start, and how a held key speeds up. */
export const NUDGE = 44;
export const NUDGE_MAX = 200;
export const NUDGE_GROWTH = 1.22;
export const RUN_GAP = 260;

/** The frames the window can wear, and the tint each is drawn for. The stylesheet owns the look. */
export const STYLES = [
  { id: 'frosted', label: 'Frosted', tint: 0.72 },
  { id: 'clear', label: 'Clear', tint: 0.46 },
  { id: 'terminal', label: 'Terminal', tint: 0.86 },
  { id: 'aurora', label: 'Aurora', tint: 0.62 },
] as const;
export type WindowStyle = (typeof STYLES)[number]['id'];
export const styleAt = (id: string | undefined) => STYLES.find((s) => s.id === id) ?? STYLES[0];

export const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

export interface Viewport {
  width: number;
  height: number;
}

/** The box a window has to stay inside. */
export function bounds(view: Viewport): Rect {
  const x = LEFT_GUTTER + PAD;
  return {
    x,
    y: PAD,
    w: Math.max(MIN.w, view.width - x - PAD),
    h: Math.max(MIN.h, view.height - 2 * PAD),
  };
}

/**
 * Where a window goes when it has never been placed: a tall column against
 * the right edge. Not the full height, deliberately — a window that exactly
 * fills its bounds has nowhere to be dragged, and the gap is the invitation.
 */
export function defaultRect(view: Viewport): Rect {
  const b = bounds(view);
  const w = clamp(Math.round(view.width * 0.3), MIN.w, 460);
  const h = Math.max(MIN.h, Math.round(b.h * 0.88));
  return { x: b.x + b.w - w, y: b.y, w, h };
}

/** Keep a rectangle usable: big enough to work in, and wholly on the page. */
export function fit(r: Rect, view: Viewport): Rect {
  const b = bounds(view);
  const w = clamp(r.w, MIN.w, b.w);
  const h = clamp(r.h, MIN.h, b.h);
  return {
    w,
    h,
    x: clamp(r.x, b.x, b.x + b.w - w),
    y: clamp(r.y, b.y, b.y + b.h - h),
  };
}

/**
 * A drag from a grip. `dir` is its compass direction. Each edge is clamped
 * against the page here rather than left to `fit`: clamping the size
 * afterwards would slide the *opposite* edge, and the edge you are not
 * dragging is the one that has to stay where it is.
 */
export function resize(start: Rect, dir: string, dx: number, dy: number, view: Viewport): Rect {
  const b = bounds(view);
  const r = { ...start };
  if (dir.includes('e')) r.w = clamp(start.w + dx, MIN.w, b.x + b.w - start.x);
  if (dir.includes('s')) r.h = clamp(start.h + dy, MIN.h, b.y + b.h - start.y);
  if (dir.includes('w')) {
    r.w = clamp(start.w - dx, MIN.w, start.x + start.w - b.x);
    r.x = start.x + start.w - r.w;
  }
  if (dir.includes('n')) {
    r.h = clamp(start.h - dy, MIN.h, start.y + start.h - b.y);
    r.y = start.y + start.h - r.h;
  }
  return fit(r, view);
}

/**
 * Double-clicking the bar sends the window back to the column it starts in —
 * and a second double-click, from there, fills the workspace instead.
 */
export function zoom(rect: Rect, view: Viewport): Rect {
  const home = defaultRect(view);
  const atHome = Math.abs(rect.x - home.x) < 6 && Math.abs(rect.w - home.w) < 6 && Math.abs(rect.y - home.y) < 6;
  return fit(atHome ? bounds(view) : home, view);
}

/**
 * Throw the window at one edge. `step` is the index into SNAP_STEPS; the
 * caller cycles it when the same side is pressed again. Each snap fills the
 * other axis: half the width means the full height.
 */
export function snap(side: Side, step: number, view: Viewport): Rect {
  const b = bounds(view);
  const { f } = SNAP_STEPS[step % SNAP_STEPS.length];
  if (side === 'left' || side === 'right') {
    const w = clamp(Math.round(b.w * f), MIN.w, b.w);
    return fit({ w, h: b.h, y: b.y, x: side === 'left' ? b.x : b.x + b.w - w }, view);
  }
  const h = clamp(Math.round(b.h * f), MIN.h, b.h);
  return fit({ w: b.w, h, x: b.x, y: side === 'up' ? b.y : b.y + b.h - h }, view);
}

/** Move the window one step that way. Its size never changes: this is moving, not tiling. */
export function nudge(rect: Rect, side: Side, by: number, view: Viewport): Rect {
  const [dx, dy] = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[side];
  return fit({ ...rect, x: rect.x + dx * by, y: rect.y + dy * by }, view);
}

/**
 * The next stride of a held arrow: a tap is a small precise move, a held key
 * accelerates until it crosses the page in about a second.
 */
export function stride(previous: number | null): number {
  return previous === null ? NUDGE : Math.min(previous * NUDGE_GROWTH, NUDGE_MAX);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const WINDOW_STORE = 'reader.assistant.window';

export interface WindowPrefs {
  rect: Rect | null;
  tint: number;
  style: WindowStyle;
}

export function loadWindow(): WindowPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(WINDOW_STORE) || '{}') as Partial<WindowPrefs>;
    const rect = saved.rect && [saved.rect.x, saved.rect.y, saved.rect.w, saved.rect.h].every(Number.isFinite) ? saved.rect : null;
    const style = styleAt(saved.style).id;
    const tint = typeof saved.tint === 'number' ? clamp(saved.tint, 0.25, 1) : styleAt(style).tint;
    return { rect, tint, style };
  } catch {
    return { rect: null, tint: STYLES[0].tint, style: STYLES[0].id };
  }
}

export function saveWindow(prefs: WindowPrefs) {
  try {
    localStorage.setItem(WINDOW_STORE, JSON.stringify(prefs));
  } catch {
    // private mode: the window forgets where it was on reload
  }
}
