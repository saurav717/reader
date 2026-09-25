import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject, WheelEvent as ReactWheelEvent } from 'react';

/** A drag shorter than this is a click, and keeps nothing. */
const DRAG = 8;
const PICKED = 'is-snip-picked';

interface Props {
  /** What can be snipped from. */
  root: RefObject<HTMLElement>;
  /** What counts as a piece of it: paragraphs, figures, tables and the like. */
  selector: string;
  /** Keep these, in the order they are on the page. */
  onKeep: (elements: HTMLElement[]) => void;
}

/**
 * Snipping a page of text into your notes by dragging a box over it: every
 * piece the box touches — a paragraph, a list item, a figure, a table, an
 * equation, a code cell — is lit as the box is drawn, and kept, whole and as
 * it is set, when it is let go. It is text still, not a picture of it. The
 * page scrolls under the box with the wheel, so a snip can be made anywhere.
 */
/** What scrolls the page: the nearest ancestor that scrolls, or the page itself. */
function scrollerOf(element: HTMLElement | null): HTMLElement | null {
  let scroller = element;
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /(auto|scroll)/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
  return scroller;
}

export default function BoxSnip({ root, selector, onKeep }: Props) {
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const picked = useRef<HTMLElement[]>([]);
  // The layer lies over the page's own pane only, so the bars around it —
  // and the button that turns snipping off — stay in reach.
  const [area, setArea] = useState({ left: 0, top: 0, width: 0, height: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const pane = scrollerOf(root.current) ?? root.current;
      const rect = pane?.getBoundingClientRect();
      if (!rect) return;
      const left = Math.max(0, rect.left);
      const top = Math.max(0, rect.top);
      setArea({ left, top, width: Math.min(window.innerWidth, rect.right) - left, height: Math.min(window.innerHeight, rect.bottom) - top });
    };
    measure();
    const observer = new ResizeObserver(measure);
    const pane = scrollerOf(root.current) ?? root.current;
    if (pane) observer.observe(pane);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [root]);

  const unmark = () => {
    picked.current.forEach((element) => element.classList.remove(PICKED));
    picked.current = [];
  };
  useEffect(() => unmark, []);

  /** The pieces the box touches: the outermost of each, in page order. */
  const touched = (b: { x0: number; y0: number; x1: number; y1: number }) => {
    const left = Math.min(b.x0, b.x1);
    const right = Math.max(b.x0, b.x1);
    const top = Math.min(b.y0, b.y1);
    const bottom = Math.max(b.y0, b.y1);
    const found: HTMLElement[] = [];
    for (const element of Array.from(root.current?.querySelectorAll<HTMLElement>(selector) ?? [])) {
      if (found.some((outer) => outer.contains(element))) continue;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (rect.right < left || rect.left > right || rect.bottom < top || rect.top > bottom) continue;
      found.push(element);
    }
    return found;
  };

  const within = (x: number, y: number) => {
    const rect = root.current?.getBoundingClientRect();
    return Boolean(rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !within(event.clientX, event.clientY)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setBox({ x0: event.clientX, y0: event.clientY, x1: event.clientX, y1: event.clientY });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!box) return;
    const next = { ...box, x1: event.clientX, y1: event.clientY };
    setBox(next);
    const now = Math.abs(next.x1 - next.x0) >= DRAG || Math.abs(next.y1 - next.y0) >= DRAG ? touched(next) : [];
    unmark();
    now.forEach((element) => element.classList.add(PICKED));
    picked.current = now;
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!box) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const kept = picked.current;
    unmark();
    setBox(null);
    if (kept.length) onKeep(kept);
  };
  // The page under the layer still scrolls.
  const onWheel = (event: ReactWheelEvent) => {
    (scrollerOf(root.current) ?? document.scrollingElement)?.scrollBy({ top: event.deltaY });
  };

  const drawn = box && (Math.abs(box.x1 - box.x0) >= DRAG || Math.abs(box.y1 - box.y0) >= DRAG);
  return (
    <div
      className="box-snip-layer"
      style={area}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      aria-label="Snip: drag a box over anything on the page to add it to your notes"
    >
      {drawn ? (
        <div
          className="snip-drag"
          style={{ left: Math.min(box.x0, box.x1) - area.left, top: Math.min(box.y0, box.y1) - area.top, width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }}
        />
      ) : null}
      <div className="snip-hint">✂ Drag a box over anything to add it to your notes · Esc or S to stop</div>
    </div>
  );
}
