import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from './icons';

/**
 * Narrower than this — or taller than it is wide, a tablet held upright — a
 * spread of two pages leaves each too thin to read, so it is one page at a time.
 */
const TWO_PAGE_MIN_WIDTH = 820;
/** How far a finger has to travel sideways before it turns the page. */
const SWIPE_PX = 48;
/** How much wheel it takes to turn a page, and how long to ignore the rest of the same flick. */
const WHEEL_PX = 60;
const WHEEL_REST_MS = 450;

interface Props {
  children: ReactNode;
  /** Changes whenever the text inside changes, so the pages are counted again. */
  contentKey: unknown;
  /** Where the paper was left, 0–1, to open on the same page. */
  initialProgress: number;
  onProgress: (fraction: number) => void;
  style?: React.CSSProperties;
}

/**
 * The paper set as a book: a spread of two pages side by side — one on a
 * narrow screen — turned with the arrows, the keys, a swipe or the wheel.
 * The text is laid out in CSS columns the height of the page, and turning
 * the page is moving along them by a spread's width. It is the same DOM as
 * the scrolling view, so highlighting and looking things up work unchanged.
 */
export default function BookView({ children, contentKey, initialProgress, onProgress, style }: Props) {
  const spreadRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(2);
  const [spread, setSpread] = useState(0);
  const [spreads, setSpreads] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  /** The paper opens where it was left once per document, not on every re-measure. */
  const restored = useRef<unknown>(undefined);
  const spreadNow = useRef(0);
  spreadNow.current = spread;

  const stride = useCallback(() => {
    const pages = pagesRef.current;
    if (!pages) return 1;
    const gap = parseFloat(getComputedStyle(pages).columnGap) || 0;
    return pages.clientWidth + gap;
  }, []);

  const measure = useCallback(() => {
    const pages = pagesRef.current;
    const frame = spreadRef.current;
    if (!pages || !frame) return;
    const nextColumns = frame.clientWidth >= TWO_PAGE_MIN_WIDTH && frame.clientWidth >= frame.clientHeight ? 2 : 1;
    if (nextColumns !== columns) {
      setColumns(nextColumns);
      return; // measured again once the columns are set
    }
    pages.style.setProperty('--page-height', `${pages.clientHeight}px`);
    const gap = parseFloat(getComputedStyle(pages).columnGap) || 0;
    const columnWidth = (pages.clientWidth - gap * (nextColumns - 1)) / nextColumns;
    const total = Math.max(1, Math.round((pages.scrollWidth + gap) / (columnWidth + gap)));
    const count = Math.max(1, Math.ceil(total / nextColumns));
    setPageCount(total);
    setSpreads(count);

    let target = Math.min(spreadNow.current, count - 1);
    if (restored.current !== contentKey && pages.textContent?.trim()) {
      restored.current = contentKey;
      target = Math.round(Math.min(1, Math.max(0, initialProgress)) * (count - 1));
    }
    setSpread(target);
    pages.scrollLeft = target * (pages.clientWidth + gap);
  }, [columns, contentKey, initialProgress]);

  useLayoutEffect(() => {
    measure();
  }, [measure, contentKey, children]);

  // A different window size or a new font size is a different set of pages.
  useEffect(() => {
    const frame = spreadRef.current;
    const pages = pagesRef.current;
    if (!frame || !pages) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(frame);
    // Images arrive after the text, and push everything after them along.
    const onLoad = () => measure();
    pages.addEventListener('load', onLoad, true);
    return () => {
      observer.disconnect();
      pages.removeEventListener('load', onLoad, true);
    };
  }, [measure]);

  // Pictures off to the side are never "near the viewport" in a paged
  // layout, so lazy loading would leave them unloaded and the page count wrong.
  useEffect(() => {
    pagesRef.current?.querySelectorAll('img[loading="lazy"]').forEach((image) => image.setAttribute('loading', 'eager'));
  }, [contentKey, children]);

  const go = useCallback(
    (next: number) => {
      const pages = pagesRef.current;
      if (!pages) return;
      const clamped = Math.max(0, Math.min(spreads - 1, next));
      setSpread(clamped);
      pages.scrollLeft = clamped * stride();
      onProgress(spreads > 1 ? clamped / (spreads - 1) : 0);
    },
    [onProgress, spreads, stride],
  );

  // Arrow keys, Page Up/Down and the space bar turn the page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)) return;
      let delta = 0;
      if (event.key === 'ArrowRight' || event.key === 'PageDown' || (event.key === ' ' && !event.shiftKey)) delta = 1;
      else if (event.key === 'ArrowLeft' || event.key === 'PageUp' || (event.key === ' ' && event.shiftKey)) delta = -1;
      else if (event.key === 'Home') return event.preventDefault(), go(0);
      else if (event.key === 'End') return event.preventDefault(), go(spreads - 1);
      if (!delta) return;
      event.preventDefault();
      go(spreadNow.current + delta);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, spreads]);

  // Selecting text by dragging can nudge the columns along; put the page back.
  const settle = useRef<number | undefined>(undefined);
  const onScroll = () => {
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      const pages = pagesRef.current;
      if (!pages) return;
      const at = Math.round(pages.scrollLeft / stride());
      if (Math.abs(pages.scrollLeft - at * stride()) > 1) go(at);
    }, 200);
  };
  useEffect(() => () => window.clearTimeout(settle.current), []);

  const wheel = useRef({ total: 0, restUntil: 0 });
  const onWheel = (event: React.WheelEvent) => {
    const now = Date.now();
    const state = wheel.current;
    if (now < state.restUntil) return;
    state.total += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (Math.abs(state.total) < WHEEL_PX) return;
    go(spreadNow.current + Math.sign(state.total));
    state.total = 0;
    state.restUntil = now + WHEEL_REST_MS;
  };

  const touch = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (event: React.TouchEvent) => {
    const point = event.touches[0];
    touch.current = event.touches.length === 1 && point ? { x: point.clientX, y: point.clientY } : null;
  };
  const onTouchEnd = (event: React.TouchEvent) => {
    const start = touch.current;
    touch.current = null;
    const point = event.changedTouches[0];
    if (!start || !point) return;
    // A drag that selected text is a selection, not a page turn.
    if (window.getSelection()?.isCollapsed === false) return;
    const dx = point.clientX - start.x;
    const dy = point.clientY - start.y;
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    go(spreadNow.current + (dx < 0 ? 1 : -1));
  };

  const first = spread * columns + 1;
  const last = Math.min(pageCount, first + columns - 1);

  return (
    <div className="book-view">
      <div
        ref={spreadRef}
        className={`book-spread${columns === 2 ? ' two' : ''}`}
        onWheel={onWheel}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div
          ref={pagesRef}
          className="book-pages"
          style={{ ...style, columnCount: columns }}
          onScroll={onScroll}
        >
          {children}
        </div>
        <button
          type="button"
          className="book-turn prev"
          onClick={() => go(spread - 1)}
          disabled={spread <= 0}
          aria-label="Previous page"
        >
          <ChevronLeftIcon size={22} />
        </button>
        <button
          type="button"
          className="book-turn next"
          onClick={() => go(spread + 1)}
          disabled={spread >= spreads - 1}
          aria-label="Next page"
        >
          <ChevronRightIcon size={22} />
        </button>
      </div>
      <div className="book-nav">
        <span className="book-folio">{first === last ? `Page ${first}` : `Pages ${first}–${last}`} of {pageCount}</span>
        <input
          type="range"
          min={0}
          max={Math.max(0, spreads - 1)}
          value={spread}
          onChange={(event) => go(Number(event.target.value))}
          aria-label="Go to page"
          disabled={spreads <= 1}
        />
      </div>
    </div>
  );
}
