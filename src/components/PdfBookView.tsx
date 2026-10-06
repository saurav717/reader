import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { TWO_PAGE_MIN_WIDTH, usePageTurns } from './BookView';
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from './icons';
import { useKept } from './Keep';
import PdfSnip, { findRegions, type Region } from './PdfSnip';
import { PdfCloseUp, PdfLoupe, PdfMinimap, ZOOM_MAX, clampMagnify, clampZoom, zoomByWheel, type CloseUpItem } from './PdfZoom';
import { addClip, addText, useNotes } from '../lib/notes';
import PagePins, { stickiesOf } from './PdfPins';
import MarkPicker, { highlightIn, markKey, type Mark } from './MarkPicker';
import { NoteIcon } from './icons';
import { useStore } from '../lib/store';
import { buildIndex, offsetOf, rangeFromOffsets, resolveSelector, type Selector } from '../lib/anchor';
import { mergeBoxes, pdfText, placeMarks, readable, selectorIn, type Box, type PageMark, type PdfText } from '../lib/pdfMarks';
import type { Highlight } from '../types';

type Engine = typeof import('../lib/pdfReflow');

interface Props {
  /** Turned as a book, a spread at a time — or one long column of pages, scrolled. */
  flow?: 'book' | 'scroll';
  /** Whose notes a passage or a snip goes into. */
  paperId: string;
  /** Whether ✂ Snip is on, and turning it on or off — the reader's to hold, since its top bar and S turn it on too. */
  snipping: boolean;
  onSnipping: (on: boolean) => void;
  blob: Blob;
  title: string;
  /** The paper's highlights and underlines, made in either mode, drawn on its pages. */
  highlights: Highlight[];
  selectedHighlightId: string | null;
  onSelectHighlight: (id: string | null) => void;
  /** A passage marked here, and whether a note is to be written on it. */
  onMarked: (highlight: Highlight, withNote: boolean) => void;
  /** Where the paper was left, 0–1, to open on the same page. */
  initialProgress: number;
  onProgress: (fraction: number) => void;
}

/** One page at a time, two side by side, or whichever fits the frame. */
type PagesShown = 'auto' | 'one' | 'two';
const PAGES_KEY = 'reader.pdf.pages';
function pagesShownAtFirst(): PagesShown {
  try {
    const kept = localStorage.getItem(PAGES_KEY);
    return kept === 'one' || kept === 'two' ? kept : 'auto';
  } catch {
    return 'auto';
  }
}

/** Space kept round a spread inside the frame, and under it for the pages' shadow. */
const MARGIN = 16;
/** Fill: the pages corner to corner, no margins, the page bar waiting at the bottom edge. */
const FILL_KEY = 'reader.pdf.fill';
function fillAtFirst(): boolean {
  try {
    return localStorage.getItem(FILL_KEY) === 'true';
  } catch {
    return false;
  }
}

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The PDF itself set as a book: its own pages, two side by side — one on a
 * narrow screen — drawn by pdf.js, turned the way the reflowed book is
 * turned. The text of each page is laid over its picture, so it can be
 * selected and copied as in the browser's own viewer.
 */
export default function PdfBookView({
  flow = 'book',
  paperId,
  snipping,
  onSnipping,
  blob,
  title,
  highlights,
  selectedHighlightId,
  onSelectHighlight,
  onMarked,
  initialProgress,
  onProgress,
}: Props) {
  const scrolling = flow === 'scroll';
  const frameRef = useRef<HTMLDivElement>(null);
  /** In the scrolled column, what the pages are laid in — what snipping measures them against. */
  const columnRef = useRef<HTMLDivElement>(null);
  /** As a book, what the spread's pages are laid in. */
  const bookPagesRef = useRef<HTMLDivElement>(null);
  const [opened, setOpened] = useState<{ doc: PDFDocumentProxy; engine: Engine } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  /** The first page's size in points, which every spread is fitted by. */
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [spread, setSpread] = useState(0);
  const spreadNow = useRef(0);
  spreadNow.current = spread;

  useEffect(() => {
    let live = true;
    let close: (() => void) | undefined;
    setOpened(null);
    setError(null);
    (async () => {
      const engine = await import('../lib/pdfReflow');
      const { doc, close: done } = await engine.openPdf(blob);
      close = done;
      if (!live) return done();
      const first = await doc.getPage(1);
      const { width, height } = first.getViewport({ scale: 1 });
      if (!live) return;
      setPageSize({ width, height });
      setOpened({ doc, engine });
    })().catch((reason) => live && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      live = false;
      close?.();
    };
  }, [blob]);

  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const measure = () => setFrame({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The whole PDF's text, page by page as the text layers hold it, which every
  // highlight is looked for in — read once, a page at a time, after opening.
  const [text, setText] = useState<PdfText | null>(null);
  useEffect(() => {
    setText(null);
    if (!opened) return;
    let live = true;
    (async () => {
      const texts: string[] = [];
      for (let number = 1; number <= opened.doc.numPages && live; number++) {
        const page = await opened.doc.getPage(number);
        const content = await page.getTextContent();
        texts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(''));
      }
      if (live) setText(pdfText(texts));
    })().catch((reason) => console.warn('Could not read the PDF’s text for its highlights', reason));
    return () => {
      live = false;
    };
  }, [opened]);
  const marks = useMemo(() => (text ? placeMarks(text, highlights) : new Map<number, PageMark[]>()), [text, highlights]);
  const marksOn = (number: number) => ({
    marks: marks.get(number),
    pageText: text?.pages[number - 1],
    selectedId: selectedHighlightId,
  });

  const pages = opened?.doc.numPages ?? 0;
  // Two pages side by side where they fit — or one, or two, as picked.
  const [pagesShown, setPagesShown] = useState<PagesShown>(pagesShownAtFirst);
  const twoFit = frame.width >= TWO_PAGE_MIN_WIDTH && frame.width >= frame.height;
  const columns = scrolling ? 1 : pagesShown === 'one' ? 1 : pagesShown === 'two' ? (frame.width >= 640 ? 2 : 1) : twoFit ? 2 : 1;
  const choosePages = (next: PagesShown) => {
    setPagesShown(next);
    try {
      localStorage.setItem(PAGES_KEY, next);
    } catch {
      /* kept for this visit only */
    }
  };
  const spreads = Math.max(1, Math.ceil(pages / columns));

  // Open where the paper was left, once the pages are counted; keep the same page when the spread changes width.
  const restored = useRef<unknown>(null);
  const columnsWere = useRef(columns);
  useEffect(() => {
    if (!pages || scrolling) return;
    if (restored.current !== opened) {
      restored.current = opened;
      setSpread(Math.round(Math.min(1, Math.max(0, initialProgress)) * (spreads - 1)));
    } else if (columnsWere.current !== columns) {
      setSpread((current) => Math.min(spreads - 1, Math.floor((current * columnsWere.current) / columns)));
    }
    columnsWere.current = columns;
  }, [opened, pages, columns, spreads, initialProgress]);

  const go = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(spreads - 1, next));
      // Scrolled, a page at a time is a page down the column.
      if (scrolling) {
        columnRef.current?.querySelector<HTMLElement>(`[data-slot="${clamped + 1}"]`)?.scrollIntoView({ block: 'start' });
        return;
      }
      setSpread(clamped);
      onProgress(spreads > 1 ? clamped / (spreads - 1) : 0);
    },
    [onProgress, spreads, scrolling],
  );
  const turns = usePageTurns(go, spreadNow, spreads);

  // Ask Claude showing a passage: turn to the spread that holds its page.
  useEffect(() => {
    const onPage = (event: Event) => {
      const page = (event as CustomEvent<{ page: number }>).detail?.page;
      if (!page) return;
      if (scrolling) columnRef.current?.querySelector<HTMLElement>(`[data-slot="${page}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      else go(Math.floor((page - 1) / columns));
    };
    window.addEventListener('reader:pdf-page', onPage);
    return () => window.removeEventListener('reader:pdf-page', onPage);
  }, [go, columns, scrolling]);

  // Every page drawn at the one scale that fits the spread in the frame.
  // Scrolled, a page is as wide as the column allows, up to a comfortable size.
  // Filled, there is no margin, no comfortable width, and no page bar in the
  // way: the pages have the whole frame, corner to corner.
  const [fill, setFill] = useState(fillAtFirst);
  const chooseFill = (next: boolean) => {
    setFill(next);
    try {
      localStorage.setItem(FILL_KEY, String(next));
    } catch {
      /* kept for this visit only */
    }
  };
  // The page bar, put away while filled, comes back with the pointer at the bottom edge, and stays while it is over it.
  const [barOut, setBarOut] = useState(false);
  useEffect(() => {
    if (!fill) return;
    const onMove = (event: PointerEvent) => {
      const fromBottom = window.innerHeight - event.clientY;
      setBarOut((current) => (current ? fromBottom < 76 : fromBottom < 20));
    };
    document.addEventListener('pointermove', onMove);
    return () => {
      document.removeEventListener('pointermove', onMove);
      setBarOut(false);
    };
  }, [fill]);
  const margin = fill ? 0 : MARGIN;
  const fit = pageSize
    ? scrolling
      ? Math.max(0.1, Math.min((frame.width - margin * 2 - 14) / pageSize.width, (fill ? Infinity : 1000) / pageSize.width))
      : Math.max(0.1, Math.min((frame.width - margin * 2) / (pageSize.width * columns), (frame.height - margin * 2) / pageSize.height))
    : 1;

  // ---- zoom -----------------------------------------------------------------
  // Pinched, ⌘-scrolled, or + and −: the pages drawn larger than they fit,
  // sharp at that size, and the frame scrolled over them, with the point
  // under the pointer kept where it is. 0 fits them again.
  const [zoom, setZoom] = useState(1);
  const zoomNow = useRef(1);
  zoomNow.current = zoom;
  useEffect(() => setZoom(1), [blob]);
  const scale = fit * zoom;
  const zoomed = zoom > 1;
  /** Across a zoom, the page under the pointer, the point of it there — in its pixels at zoom 1 — and where on screen. */
  const anchor = useRef<{ slot: number; u: number; v: number; x: number; y: number } | null>(null);
  const slotsOf = () => Array.from((scrolling ? columnRef : bookPagesRef).current?.querySelectorAll<HTMLElement>('[data-slot]') ?? []);
  const zoomTo = useCallback(
    (next: number, x?: number, y?: number) => {
      const element = frameRef.current;
      const clamped = clampZoom(next);
      if (!element || clamped === zoomNow.current) return;
      const seen = element.getBoundingClientRect();
      const px = x ?? seen.left + seen.width / 2;
      const py = y ?? seen.top + seen.height / 2;
      const slots = slotsOf();
      const slot =
        slots.find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom;
        }) ?? slots[0];
      if (slot) {
        const rect = slot.getBoundingClientRect();
        anchor.current = { slot: Number(slot.dataset.slot), u: (px - rect.left) / zoomNow.current, v: (py - rect.top) / zoomNow.current, x: px, y: py };
      }
      setZoom(clamped);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scrolling],
  );
  useLayoutEffect(() => {
    const kept = anchor.current;
    anchor.current = null;
    const element = frameRef.current;
    if (!kept || !element) return;
    const slot = slotsOf().find((candidate) => Number(candidate.dataset.slot) === kept.slot);
    if (!slot) return;
    const rect = slot.getBoundingClientRect();
    element.scrollLeft += rect.left + kept.u * zoom - kept.x;
    element.scrollTop += rect.top + kept.v * zoom - kept.y;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);
  // The loupe: a glass over the page, following the pointer (L).
  const [loupe, setLoupe] = useState(false);
  const loupeNow = useRef(false);
  loupeNow.current = loupe;
  const [magnify, setMagnify] = useState(2.2);
  useEffect(() => setLoupe(false), [blob]);
  // A pinch, or ⌘ with the wheel, zooms — the glass when it is out, else the
  // pages, round the pointer. Pinches come thick and fast: one zoom a frame.
  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    let factor = 1;
    let at = { x: 0, y: 0 };
    let raf = 0;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      factor *= Math.exp(-event.deltaY * 0.01);
      at = { x: event.clientX, y: event.clientY };
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const by = factor;
        factor = 1;
        if (loupeNow.current) setMagnify((current) => clampMagnify(current * by));
        else zoomTo(zoomByWheel(zoomNow.current, 0) * by, at.x, at.y);
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      element.removeEventListener('wheel', onWheel);
    };
  }, [zoomTo]);

  // ---- the scrolled column ----------------------------------------------------
  // Every page has its place from the start, at its size; a page is drawn
  // once it comes near the screen, so a long paper does not draw it all at once.
  const [near, setNear] = useState<Set<number>>(() => new Set());
  const [inView, setInView] = useState<number[]>([]);
  useEffect(() => {
    if (!scrolling || !pages || !frameRef.current || !columnRef.current) return;
    const slots = Array.from(columnRef.current.querySelectorAll<HTMLElement>('[data-slot]'));
    const nearing = new IntersectionObserver(
      (entries) =>
        setNear((current) => {
          const next = new Set(current);
          for (const entry of entries) if (entry.isIntersecting) next.add(Number((entry.target as HTMLElement).dataset.slot));
          return next.size === current.size ? current : next;
        }),
      { root: frameRef.current, rootMargin: '1200px 0px' },
    );
    const seen = new Map<number, boolean>();
    const showing = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) seen.set(Number((entry.target as HTMLElement).dataset.slot), entry.isIntersecting);
        setInView(
          Array.from(seen)
            .filter(([, on]) => on)
            .map(([page]) => page)
            .sort((a, b) => a - b),
        );
      },
      { root: frameRef.current },
    );
    slots.forEach((slot) => {
      nearing.observe(slot);
      showing.observe(slot);
    });
    return () => {
      nearing.disconnect();
      showing.disconnect();
    };
  }, [scrolling, pages, scale]);
  // Opened where it was left; how far down it is, kept as it is scrolled.
  const scrolledTo = useRef<unknown>(null);
  useEffect(() => {
    const element = frameRef.current;
    if (!scrolling || !pages || !element || scrolledTo.current === opened) return;
    scrolledTo.current = opened;
    requestAnimationFrame(() => {
      element.scrollTop = Math.min(1, Math.max(0, initialProgress)) * (element.scrollHeight - element.clientHeight);
    });
  }, [scrolling, pages, opened, initialProgress]);
  const progressFrame = useRef(0);
  const onScrolled = () => {
    const element = frameRef.current;
    if (!scrolling || !element) return;
    cancelAnimationFrame(progressFrame.current);
    progressFrame.current = requestAnimationFrame(() => {
      const room = element.scrollHeight - element.clientHeight;
      onProgress(room > 0 ? element.scrollTop / room : 0);
    });
  };
  const toPage = (page: number) => columnRef.current?.querySelector<HTMLElement>(`[data-slot="${page}"]`)?.scrollIntoView({ block: 'start' });

  const shown = scrolling
    ? inView.length
      ? inView
      : [1].filter(() => pages > 0)
    : Array.from({ length: columns }, (_, index) => spread * columns + index + 1).filter((number) => number <= pages);
  const firstShown = shown[0] ?? 1;

  // ---- into your notes ------------------------------------------------------
  // Snip mode (✂ here or in the top bar, or S) outlines the figures, tables
  // and equations on the pages in view: click one to keep it, or drag a box.
  // Text selected on a page has "Add to notes" under it.
  const { announce, toast } = useKept();
  const [picked, setPicked] = useState<{ text: string; page?: number; top: number; left: number; selector: Selector } | null>(null);
  useEffect(() => {
    if (!picked) return;
    const drop = () => {
      if (window.getSelection()?.isCollapsed) setPicked(null);
    };
    document.addEventListener('selectionchange', drop);
    return () => document.removeEventListener('selectionchange', drop);
  }, [picked]);
  useEffect(() => setPicked(null), [spread, snipping]);
  const takeSelection = () => {
    const selection = window.getSelection();
    const text = selection?.toString().replace(/\s+/g, ' ').trim() ?? '';
    const node = selection?.anchorNode;
    const element = node instanceof Element ? node : node?.parentElement;
    const page = element?.closest<HTMLElement>('.pdf-book-page');
    if (!selection?.rangeCount || text.length < 3 || !page || !frameRef.current?.contains(page)) {
      setPicked(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    setPicked({
      text,
      page: Number(page.dataset.page) || undefined,
      top: rect.bottom + 8,
      left: Math.max(12, Math.min(window.innerWidth - 420, rect.left)),
      selector: selectorOf(range, selection.toString()),
    });
  };
  /** Where a selection on the pages is in the whole PDF's text, as the selector a highlight keeps. */
  const selectorOf = (range: Range, shown: string): Selector => {
    const at = (node: Node, offset: number) => {
      const element = node instanceof Element ? node : node.parentElement;
      const page = element?.closest<HTMLElement>('.pdf-book-page');
      const layer = page?.querySelector<HTMLElement>('.pdf-text');
      const number = Number(page?.dataset.page);
      if (!text || !layer || !number) return null;
      const index = buildIndex(layer);
      // A page whose text layer is not the text read out of the file cannot be placed in it.
      if (index.text !== text.pages[number - 1]) return null;
      const local = offsetOf(index, node, offset);
      return local === null ? null : text.starts[number - 1] + local;
    };
    const start = at(range.startContainer, range.startOffset);
    const end = at(range.endContainer, range.endOffset);
    if (text && start !== null && end !== null && end > start) return selectorIn(text, start, end, shown);
    // Placed by its words alone, the way a quote from elsewhere is.
    return { exact: readable(shown), prefix: '', suffix: '', hint: 0 };
  };
  const { addHighlight } = useStore();
  const markSelection = useCallback(
    async (mark: Mark, withNote: boolean) => {
      if (!picked?.selector.exact) return;
      const created = await addHighlight({
        paperId,
        color: mark.color,
        style: mark.style,
        ...picked.selector,
        tags: [],
        note: withNote ? '' : undefined,
      });
      window.getSelection()?.removeAllRanges();
      setPicked(null);
      onMarked(created, withNote);
    },
    [addHighlight, onMarked, paperId, picked],
  );
  // With text selected, 1–4 highlight it in a colour, U underlines it, N highlights it with a note.
  useEffect(() => {
    if (!picked) return;
    const onKey = (event: KeyboardEvent) => {
      if (markKey(event, (mark, withNote) => void markSelection(mark, withNote))) event.preventDefault();
      else if (event.key === 'Escape') setPicked(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picked, markSelection]);
  /** A click on a marked passage brings its card up among the highlights. */
  const pickMark = (clientX: number, clientY: number) => {
    if (window.getSelection()?.isCollapsed === false) return false;
    const hit = Array.from(frameRef.current?.querySelectorAll<HTMLElement>('.pdf-mark') ?? []).find((mark) => {
      const box = mark.getBoundingClientRect();
      return clientX >= box.left && clientX <= box.right && clientY >= box.top - 2 && clientY <= box.bottom + 2;
    });
    if (!hit?.dataset.highlightId) return false;
    onSelectHighlight(hit.dataset.highlightId);
    return true;
  };
  const keepSelection = () => {
    if (!picked) return;
    addClip(paperId, { label: 'Passage', html: `<p>${esc(picked.text)}</p>`, text: picked.text, source: { from: 'paper', page: picked.page, quote: picked.text.slice(0, 160) } });
    window.getSelection()?.removeAllRanges();
    setPicked(null);
    announce('Passage');
  };
  const lastShown = shown[shown.length - 1] ?? firstShown;

  // ---- stickies ---------------------------------------------------------------
  // A note pinned to a place on a page: double-click anywhere on a page, or
  // 📌 Pin (or M) and click. Each is one of the paper's notes, a numbered
  // marker where it was put with its card beside it; the marker is dragged
  // to move it, and clicked to fold the card away.
  const blocks = useNotes(paperId);
  const stickies = stickiesOf(blocks);
  const [pinning, setPinning] = useState(false);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const [cardsHidden, setCardsHidden] = useState(false);
  const [freshPin, setFreshPin] = useState<string | null>(null);
  useEffect(() => {
    if (snipping) setPinning(false);
  }, [snipping]);
  const pinAt = (target: EventTarget, clientX: number, clientY: number) => {
    const page = target instanceof Element ? target.closest<HTMLElement>('.pdf-book-page') : null;
    if (!page || (target instanceof Element && target.closest('.pdf-pins button, .pdf-sticky'))) return false;
    const rect = page.getBoundingClientRect();
    const number = Number(page.dataset.page) || 1;
    window.getSelection()?.removeAllRanges();
    setPicked(null);
    const sticky = addText(paperId, '', {
      pin: { page: number, x: Math.min(0.98, Math.max(0.02, (clientX - rect.left) / rect.width)), y: Math.min(0.98, Math.max(0.02, (clientY - rect.top) / rect.height)) },
      source: { from: 'paper', page: number },
    });
    setFreshPin(sticky.id);
    setCardsHidden(false);
    setPinning(false);
    return true;
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (document.querySelector('.explain:not(.layout-beside), .notes-board:not(.layout-beside), .scrim, .sheet, .palette')) return;
      if (event.key.toLowerCase() === 'm') {
        event.preventDefault();
        onSnipping(false);
        setPinning((current) => !current);
      } else if (event.key === 'Escape' && pinning) {
        setPinning(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinning, onSnipping]);
  const pinsOn = (number: number, width: number, height: number) => (
    <PagePins
      paperId={paperId}
      page={number}
      stickies={stickies}
      width={width}
      height={height}
      folded={cardsHidden ? new Set(stickies.map(({ sticky }) => sticky.id)) : folded}
      fresh={freshPin}
      onToggle={(id) => {
        if (cardsHidden) {
          setCardsHidden(false);
          setFolded(new Set(stickies.map(({ sticky }) => sticky.id).filter((other) => other !== id)));
          return;
        }
        setFolded((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }}
    />
  );

  // ---- a close-up -----------------------------------------------------------
  // C, or ⌥-click on one: a figure, table or equation on the pages in view,
  // blown up to fill the screen; Tab goes on to the next.
  const regionsFound = useRef(new Map<number, Region[]>());
  const [closeUp, setCloseUp] = useState<{ items: CloseUpItem[]; index: number } | null>(null);
  const [zoomHint, setZoomHint] = useState<string | null>(null);
  useEffect(() => {
    regionsFound.current.clear();
    setCloseUp(null);
  }, [opened]);
  useEffect(() => {
    if (!zoomHint) return;
    const timer = window.setTimeout(() => setZoomHint(null), 2600);
    return () => window.clearTimeout(timer);
  }, [zoomHint]);
  const shownKey = shown.join(' ');
  const openCloseUp = useCallback(
    async (want?: { page: number; x: number; y: number }) => {
      if (!opened) return;
      const items: CloseUpItem[] = [];
      for (const number of shownKey.split(' ').map(Number)) {
        let found = regionsFound.current.get(number);
        if (!found) {
          try {
            found = await findRegions(opened.engine, opened.doc, number);
          } catch {
            found = [];
          }
          regionsFound.current.set(number, found);
        }
        for (const region of found) items.push({ page: number, region });
      }
      let index = 0;
      if (want) {
        // The smallest one under the pointer: a figure inside a larger box is the one meant.
        let area = Infinity;
        index = -1;
        items.forEach((item, at) => {
          if (item.page !== want.page) return;
          const { x0, y0, x1, y1 } = item.region.box;
          const inside = want.x >= (x0 - 4) * scale && want.x <= (x1 + 4) * scale && want.y >= (y0 - 4) * scale && want.y <= (y1 + 4) * scale;
          const size = (x1 - x0) * (y1 - y0);
          if (inside && size < area) {
            area = size;
            index = at;
          }
        });
        if (index < 0) return;
      } else if (!items.length) {
        setZoomHint('Nothing to look at close up here — no figure, table or equation was found on the page');
        return;
      }
      setLoupe(false);
      setCloseUp({ items, index });
    },
    [opened, shownKey, scale],
  );
  // + and − zoom (the glass, when it is out), 0 fits the page, L is the loupe, C a close-up.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (document.querySelector('.explain:not(.layout-beside), .notes-board:not(.layout-beside), .scrim, .sheet, .palette, .desk-scrim, .pdf-closeup')) return;
      const key = event.key;
      if (key === '+' || key === '=') {
        event.preventDefault();
        if (loupe) setMagnify((current) => clampMagnify(current + 0.5));
        else zoomTo(zoomNow.current * 1.25);
      } else if (key === '-' || key === '_') {
        event.preventDefault();
        if (loupe) setMagnify((current) => clampMagnify(current - 0.5));
        else zoomTo(zoomNow.current / 1.25);
      } else if (key === '0') {
        event.preventDefault();
        zoomTo(1);
      } else if (key.toLowerCase() === 'l') {
        event.preventDefault();
        setLoupe(!loupe);
      } else if (key.toLowerCase() === 'c') {
        event.preventDefault();
        void openCloseUp();
      } else if (key === 'Escape' && loupe) {
        setLoupe(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loupe, zoomTo, openCloseUp]);
  const zoomHintShown = zoomHint ? <div className="pin-hint">{zoomHint}</div> : null;

  const onPages = {
    onMouseUp: () => !snipping && !pinning && takeSelection(),
    onClick: (event: ReactMouseEvent) => {
      if (event.altKey) {
        const page = event.target instanceof Element ? event.target.closest<HTMLElement>('.pdf-book-page') : null;
        if (!page) return;
        const rect = page.getBoundingClientRect();
        void openCloseUp({ page: Number(page.dataset.page) || 1, x: event.clientX - rect.left, y: event.clientY - rect.top });
        return;
      }
      if (pinning) pinAt(event.target, event.clientX, event.clientY);
      else if (!snipping) pickMark(event.clientX, event.clientY);
    },
    onDoubleClick: (event: ReactMouseEvent) => {
      if (!snipping && !pinning) pinAt(event.target, event.clientX, event.clientY);
    },
  };
  const unopened = error ? (
    <p className="banner warn" style={{ margin: 16 }}>
      The PDF could not be drawn — {error.replace(/\.$/, '')}.
    </p>
  ) : !opened || !pageSize ? (
    <p className="pdf-book-loading">
      <span className="spinner" /> Opening the PDF…
    </p>
  ) : null;
  const pinHint = pinning ? <div className="pin-hint">📌 Click anywhere on a page to pin a note there · double-click works any time · Esc to stop</div> : null;
  const firstInView = shown[0] ?? 1;
  if (scrolling) spreadNow.current = firstInView - 1;

  return (
    <div
      className={`book-view pdf-book${scrolling ? ' is-scrolled' : ''}${fill ? ' is-fill' : ''}${fill && barOut ? ' bar-out' : ''}`}
      aria-label={scrolling ? `${title} (PDF), scrolled` : `${title} (PDF), as a book`}
      data-current-page={firstInView}
      data-pages={pages || undefined}
    >
      {scrolling ? (
        <div className="pdf-scroll-wrap">
          <div ref={frameRef} className={`pdf-book-spread pdf-scroll${pinning ? ' is-pinning' : ''}${zoomed ? ' is-zoomed' : ''}`} onScroll={onScrolled} {...onPages}>
            {unopened ?? (
              <div ref={columnRef} className="pdf-scroll-pages">
                {opened && pageSize
                  ? Array.from({ length: pages }, (_, index) => index + 1).map((number) => (
                      <div key={number} className="pdf-scroll-slot" data-slot={number} style={{ width: Math.floor(pageSize.width * scale), minHeight: Math.floor(pageSize.height * scale) }}>
                        {near.has(number) ? (
                          <PdfPage doc={opened.doc} engine={opened.engine} number={number} scale={scale} side="single" {...marksOn(number)} overlay={(width, height) => pinsOn(number, width, height)} />
                        ) : null}
                      </div>
                    ))
                  : null}
                {snipping && opened && pageSize ? (
                  <PdfSnip paperId={paperId} doc={opened.doc} engine={opened.engine} pages={shown} scale={scale} holder={columnRef} announce={announce} />
                ) : null}
              </div>
            )}
          </div>
          {pinHint}
          {zoomHintShown}
          {snipping ? <div className="snip-hint">✂ Drag a box, or click a figure or table outlined · Esc or S to stop</div> : null}
        </div>
      ) : (
        <div
          ref={frameRef}
          className={`pdf-book-spread${columns === 2 ? ' two' : ''}${pinning ? ' is-pinning' : ''}${zoomed ? ' is-zoomed' : ''}`}
          onWheel={zoomed || loupe ? undefined : turns.onWheel}
          onTouchStart={turns.onTouchStart}
          onTouchEnd={turns.onTouchEnd}
          {...onPages}
        >
          {unopened ?? (
            <div ref={bookPagesRef} className="pdf-book-pages">
              {shown.map((number, index) => (
                <div key={number} className="pdf-book-slot" data-slot={number} style={{ width: Math.floor(pageSize!.width * scale), height: Math.floor(pageSize!.height * scale) }}>
                  <PdfPage
                    doc={opened!.doc}
                    engine={opened!.engine}
                    number={number}
                    scale={scale}
                    side={columns === 2 ? (index === 0 ? 'left' : 'right') : 'single'}
                    {...marksOn(number)}
                    overlay={(width, height) => pinsOn(number, width, height)}
                  />
                </div>
              ))}
            </div>
          )}
          {pinHint}
          {zoomHintShown}
          {snipping && opened && pageSize ? (
            <PdfSnip paperId={paperId} doc={opened.doc} engine={opened.engine} pages={shown} scale={scale} holder={frameRef} announce={announce} />
          ) : null}
          <button type="button" className="book-turn prev" onClick={() => go(spread - 1)} disabled={spread <= 0} aria-label="Previous page">
            <ChevronLeftIcon size={22} />
          </button>
          <button type="button" className="book-turn next" onClick={() => go(spread + 1)} disabled={spread >= spreads - 1} aria-label="Next page">
            <ChevronRightIcon size={22} />
          </button>
        </div>
      )}
      <div className="book-nav">
        <span className="book-folio">
          {pages ? `${firstShown === lastShown ? `Page ${firstShown}` : `Pages ${firstShown}–${lastShown}`} of ${pages}` : 'Pages'}
        </span>
        {scrolling ? (
          <input type="range" min={1} max={Math.max(1, pages)} value={firstInView} onChange={(event) => toPage(Number(event.target.value))} aria-label="Go to page" disabled={pages <= 1} />
        ) : (
          <input
            type="range"
            min={0}
            max={Math.max(0, spreads - 1)}
            value={Math.min(spread, spreads - 1)}
            onChange={(event) => go(Number(event.target.value))}
            aria-label="Go to page"
            disabled={spreads <= 1}
          />
        )}
        <button
          type="button"
          className="btn sm ghost snip-btn"
          aria-pressed={snipping}
          onClick={() => onSnipping(!snipping)}
          title="Snip figures, tables and equations into your notes — or drag any box (S)"
        >
          ✂ Snip
        </button>
        <button
          type="button"
          className="btn sm ghost pin-btn"
          aria-pressed={pinning}
          onClick={() => {
            onSnipping(false);
            setPinning(!pinning);
          }}
          title="Pin a sticky note to a place on the page — or double-click the page (M)"
        >
          📌 Pin
        </button>
        <button type="button" className="btn sm ghost loupe-btn" aria-pressed={loupe} onClick={() => setLoupe(!loupe)} title="A reading glass that follows the pointer over the page (L)">
          🔍 Loupe
        </button>
        <button type="button" className="btn sm ghost closeup-btn" onClick={() => void openCloseUp()} title="A figure, table or equation blown up to fill the screen — or ⌥-click one (C)">
          Close-up
        </button>
        <button
          type="button"
          className="btn sm ghost fill-btn"
          aria-pressed={fill}
          onClick={() => chooseFill(!fill)}
          title={fill ? 'Give the pages their margins back' : 'Fill the screen with the pages, corner to corner — this bar comes back with the pointer at the bottom edge'}
        >
          ⤢ Fill
        </button>
        <span className="pdf-zoom-ctl" role="group" aria-label="Zoom">
          <button type="button" className="btn sm ghost" onClick={() => zoomTo(zoomNow.current / 1.25)} disabled={zoom <= 1} aria-label="Zoom out" title="Zoom out (−)">
            −
          </button>
          <button type="button" className="btn sm ghost pdf-zoom-pct" onClick={() => zoomTo(1)} title="Pinch, or ⌘ with the wheel, zooms round the pointer; 0 fits the page again">
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" className="btn sm ghost" onClick={() => zoomTo(zoomNow.current * 1.25)} disabled={zoom >= ZOOM_MAX} aria-label="Zoom in" title="Zoom in (+)">
            +
          </button>
        </span>
        {stickies.length ? (
          <button type="button" className="btn sm ghost" aria-pressed={!cardsHidden} onClick={() => setCardsHidden(!cardsHidden)} title={cardsHidden ? 'Show the stickies' : 'Fold the stickies down to their numbers'}>
            {cardsHidden ? `Show ${stickies.length} stickies` : 'Fold stickies'}
          </button>
        ) : null}
        {scrolling ? null : (
        <span className="segmented pdf-pages-choice" role="group" aria-label="Pages at a time">
          <button type="button" aria-pressed={columns === 1} onClick={() => choosePages('one')} title="One page at a time">
            1 page
          </button>
          <button type="button" aria-pressed={columns === 2} onClick={() => choosePages('two')} disabled={frame.width < 640} title="Two pages side by side, as a book">
            2 pages
          </button>
        </span>
        )}
      </div>
      {zoomed && opened ? <PdfMinimap frame={frameRef} holder={frameRef} page={firstShown} /> : null}
      {loupe && opened ? <PdfLoupe doc={opened.doc} holder={frameRef} scale={scale} magnify={magnify} /> : null}
      {closeUp && opened ? (
        <PdfCloseUp doc={opened.doc} items={closeUp.items} index={closeUp.index} onIndex={(index) => setCloseUp({ items: closeUp.items, index })} onClose={() => setCloseUp(null)} />
      ) : null}
      {picked ? (
        <div className="selection-toolbar" style={{ top: picked.top, left: picked.left }} role="toolbar" aria-label="The selection">
          <MarkPicker onPick={(mark) => void markSelection(mark, false)} />
          <span className="divider" />
          <button type="button" className="wide" onMouseDown={(event) => event.preventDefault()} onClick={() => void markSelection(highlightIn('yellow'), true)} title="Highlight and write a note — N">
            <NoteIcon size={15} /> Note
          </button>
          <button type="button" className="wide" onMouseDown={(event) => event.preventDefault()} onClick={keepSelection} title="Keep this passage in your notes">
            <PlusIcon size={15} /> Add to notes
          </button>
        </div>
      ) : null}
      {toast}
    </div>
  );
}

/**
 * One page: its picture on a canvas, sharp at the screen's pixel density,
 * and its text over it in pdf.js's text layer. Drawn again at a new scale,
 * with whatever was being drawn before given up.
 */
function PdfPage({
  doc,
  engine,
  number,
  scale,
  side,
  marks,
  pageText,
  selectedId,
  overlay,
}: {
  doc: PDFDocumentProxy;
  engine: Engine;
  number: number;
  scale: number;
  side: 'left' | 'right' | 'single';
  /** The highlights on this page, in offsets into its text as read out of the file. */
  marks?: PageMark[];
  pageText?: string;
  selectedId: string | null;
  /** What is laid over the page once its size is known: its stickies. */
  overlay?: (width: number, height: number) => ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [textReady, setTextReady] = useState(false);

  useEffect(() => {
    let live = true;
    let cancel: (() => void) | undefined;
    // Drawn again at a new size — zoomed — the picture there stays, stretched, until the new one is ready.
    if (!canvasRef.current?.width) setDrawn(false);
    setTextReady(false);
    (async () => {
      const page = await doc.getPage(number);
      if (!live) return;
      const viewport = page.getViewport({ scale });
      setSize({ width: viewport.width, height: viewport.height });
      const canvas = canvasRef.current;
      const text = textRef.current;
      if (!canvas || !text) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 3);
      const fresh = canvas.width ? document.createElement('canvas') : canvas;
      fresh.width = Math.floor(viewport.width * ratio);
      fresh.height = Math.floor(viewport.height * ratio);
      const context = fresh.getContext('2d');
      if (!context) return;
      const task = page.render({
        canvas: fresh,
        canvasContext: context,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      text.replaceChildren();
      text.style.setProperty('--scale-factor', String(scale));
      const layer = new engine.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
      cancel = () => {
        task.cancel();
        layer.cancel();
      };
      await task.promise;
      if (!live) return;
      if (fresh !== canvas) {
        canvas.width = fresh.width;
        canvas.height = fresh.height;
        canvas.getContext('2d')?.drawImage(fresh, 0, 0);
      }
      setDrawn(true);
      await layer.render();
      if (live) setTextReady(true);
    })().catch((reason) => {
      // A drawing given up for a newer one is not a failure.
      if (live && !(reason instanceof Error && reason.name === 'RenderingCancelledException')) console.warn(`Could not draw page ${number}`, reason);
    });
    return () => {
      live = false;
      cancel?.();
    };
  }, [doc, engine, number, scale]);

  // The marks, measured off the words in the text layer once it is laid out:
  // a box a line, in the page's own pixels.
  const pageRef = useRef<HTMLDivElement>(null);
  const [boxes, setBoxes] = useState<{ highlight: Highlight; boxes: Box[] }[]>([]);
  useLayoutEffect(() => {
    const page = pageRef.current;
    const layer = textRef.current;
    if (!textReady || !page || !layer || !marks?.length) {
      setBoxes([]);
      return;
    }
    const index = buildIndex(layer);
    // The text layer not what was read out of the file — it should be — each
    // mark is looked for again in the page's own text.
    const placed =
      pageText === undefined || index.text === pageText
        ? marks
        : marks.flatMap((mark) => {
            const at = resolveSelector(index, mark.highlight);
            return at ? [{ ...mark, ...at }] : [];
          });
    const frame = page.getBoundingClientRect();
    // The page may be drawn scaled — mid-turn — and the boxes go in its own units.
    const ratio = page.offsetWidth ? frame.width / page.offsetWidth : 1;
    setBoxes(
      placed.map((mark) => {
        const found: Box[] = [];
        // Word by word, text node by text node: a range over whole spans
        // would give each span's box as well as its text's.
        for (const entry of index.nodes) {
          if (entry.end <= mark.start || entry.start >= mark.end) continue;
          const range = rangeFromOffsets(index, Math.max(mark.start, entry.start), Math.min(mark.end, entry.end));
          if (!range) continue;
          for (const rect of Array.from(range.getClientRects())) {
            found.push({ left: (rect.left - frame.left) / ratio, top: (rect.top - frame.top) / ratio, width: rect.width / ratio, height: rect.height / ratio });
          }
        }
        return { highlight: mark.highlight, boxes: mergeBoxes(found) };
      }),
    );
  }, [textReady, marks, pageText, size]);

  return (
    <div
      ref={pageRef}
      className={`pdf-book-page ${side}${drawn ? '' : ' drawing'}`}
      style={size ? { width: size.width, height: size.height } : undefined}
      aria-label={`Page ${number}`}
      data-page={number}
      data-text={textReady ? 'ready' : undefined}
    >
      <canvas ref={canvasRef} style={size ? { width: size.width, height: size.height } : undefined} />
      {boxes.length ? (
        <div className="pdf-marks" aria-hidden="true">
          {boxes.flatMap(({ highlight, boxes: lines }) =>
            lines.map((box, line) => (
              <div
                key={`${highlight.id}-${line}`}
                className={`pdf-mark hl-${highlight.color}${highlight.style === 'underline' ? ' hl-underline' : ''}${highlight.id === selectedId ? ' is-selected' : ''}`}
                data-highlight-id={highlight.id}
                title={highlight.note || undefined}
                style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
              />
            )),
          )}
        </div>
      ) : null}
      <div ref={textRef} className="pdf-text" />
      {size && overlay ? overlay(size.width, size.height) : null}
    </div>
  );
}
