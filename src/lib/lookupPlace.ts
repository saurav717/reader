/**
 * Where the lookup card goes on screen. Kept apart from the component so the
 * rule can be tested without a browser.
 */
import type { Selector } from './anchor';

export interface LookupTarget {
  top: number;
  left: number;
  /** The selection's box on screen, which the card is placed beside and never over. */
  anchor?: { top: number; bottom: number; left: number; right: number };
  /** The text column's edges, so the card can sit in the margin when there is one. */
  column?: { left: number; right: number };
  /** The reading pane's edges: the margins are the room between it and the column. */
  pane?: { left: number; right: number };
  selector: Selector;
  section?: string;
}

const WIDTH = 380;
const MARGIN_MIN = 300;
const GAP = 10;
const EDGE = 12;
const MAX_HEIGHT = 440;

interface Placement {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  /** Which side of the selection the card is on, for the little pointer. */
  side: 'margin' | 'below' | 'above';
}

/**
 * Where the card goes: in the margin beside the line when the window has one
 * wide enough — a note in the margin, the text left entirely clear — and
 * otherwise just below the selected line, or just above it when below is
 * short of room. It never sits over the selected words themselves.
 */
export function placeLookup(
  target: LookupTarget,
  height: number,
  viewport = { width: window.innerWidth, height: window.innerHeight },
): Placement {
  const width = Math.min(WIDTH, viewport.width - EDGE * 2);
  const anchor = target.anchor ?? { top: target.top - 8 - 20, bottom: target.top - 8, left: target.left, right: target.left };
  const clampTop = (top: number, h: number) => Math.max(EDGE, Math.min(viewport.height - EDGE - h, top));
  const fullHeight = Math.min(MAX_HEIGHT, viewport.height - EDGE * 2);
  const h = Math.min(height, fullHeight);
  // The side is chosen for a typical card, not the one on screen this instant,
  // so the card does not jump from below the line to above it as a definition
  // arrives and it grows.
  const typical = Math.min(300, fullHeight);

  const pane = target.pane ?? { left: 0, right: viewport.width };
  const column = target.column;
  if (column) {
    // A margin card may be narrower than the full one, down to MARGIN_MIN.
    const right = pane.right - column.right - GAP * 2 - EDGE;
    const left = column.left - pane.left - GAP * 2 - EDGE;
    const room = Math.max(right, left);
    if (room >= MARGIN_MIN) {
      const onRight = right >= left;
      const marginWidth = Math.min(WIDTH, room);
      return {
        top: clampTop(anchor.top - 14, h),
        left: onRight ? column.right + GAP * 2 : column.left - GAP * 2 - marginWidth,
        width: marginWidth,
        maxHeight: fullHeight,
        side: 'margin',
      };
    }
  }

  // Below or above the line: inside the reading pane where it fits, else the window.
  const [minLeft, maxLeft] =
    pane.right - pane.left >= width + EDGE * 2
      ? [pane.left + EDGE, pane.right - width - EDGE]
      : [EDGE, viewport.width - width - EDGE];
  const left = Math.max(minLeft, Math.min(maxLeft, anchor.left - 24));
  const below = viewport.height - EDGE - (anchor.bottom + GAP);
  const above = anchor.top - GAP - EDGE;
  if (below >= typical || below >= above) {
    return { top: anchor.bottom + GAP, left, width, maxHeight: Math.min(fullHeight, Math.max(160, below)), side: 'below' };
  }
  const maxHeight = Math.min(fullHeight, above);
  return { top: anchor.top - GAP - Math.min(h, maxHeight), left, width, maxHeight, side: 'above' };
}

