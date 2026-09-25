import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { TWO_PAGE_MIN_WIDTH, usePageTurns } from './BookView';
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from './icons';
import { useKept } from './Keep';
import PdfSnip from './PdfSnip';
import { addClip, addText, useNotes } from '../lib/notes';
import PagePins, { stickiesOf } from './PdfPins';

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

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The PDF itself set as a book: its own pages, two side by side — one on a
 * narrow screen — drawn by pdf.js, turned the way the reflowed book is
 * turned. The text of each page is laid over its picture, so it can be
 * selected and copied as in the browser's own viewer.
 */
export default function PdfBookView({ flow = 'book', paperId, snipping, onSnipping, blob, title, initialProgress, onProgress }: Props) {
  const scrolling = flow === 'scroll';
  const frameRef = useRef<HTMLDivElement>(null);
  /** In the scrolled column, what the pages are laid in — what snipping measures them against. */
  const columnRef = useRef<HTMLDivElement>(null);
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
  const scale = pageSize
    ? scrolling
      ? Math.max(0.1, Math.min((frame.width - MARGIN * 2 - 14) / pageSize.width, 1000 / pageSize.width))
      : Math.max(0.1, Math.min((frame.width - MARGIN * 2) / (pageSize.width * columns), (frame.height - MARGIN * 2) / pageSize.height))
    : 1;

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
  const [picked, setPicked] = useState<{ text: string; page?: number; top: number; left: number } | null>(null);
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
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    setPicked({ text, page: Number(page.dataset.page) || undefined, top: rect.bottom + 8, left: Math.max(12, Math.min(window.innerWidth - 180, rect.left)) });
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

  const onPages = {
    onMouseUp: () => !snipping && !pinning && takeSelection(),
    onClick: (event: ReactMouseEvent) => {
      if (pinning) pinAt(event.target, event.clientX, event.clientY);
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
      className={`book-view pdf-book${scrolling ? ' is-scrolled' : ''}`}
      aria-label={scrolling ? `${title} (PDF), scrolled` : `${title} (PDF), as a book`}
      data-current-page={firstInView}
    >
      {scrolling ? (
        <div className="pdf-scroll-wrap">
          <div ref={frameRef} className={`pdf-book-spread pdf-scroll${pinning ? ' is-pinning' : ''}`} onScroll={onScrolled} {...onPages}>
            {unopened ?? (
              <div ref={columnRef} className="pdf-scroll-pages">
                {opened && pageSize
                  ? Array.from({ length: pages }, (_, index) => index + 1).map((number) => (
                      <div key={number} className="pdf-scroll-slot" data-slot={number} style={{ width: Math.floor(pageSize.width * scale), minHeight: Math.floor(pageSize.height * scale) }}>
                        {near.has(number) ? (
                          <PdfPage doc={opened.doc} engine={opened.engine} number={number} scale={scale} side="single" overlay={(width, height) => pinsOn(number, width, height)} />
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
          {snipping ? <div className="snip-hint">✂ Drag a box, or click a figure or table outlined · Esc or S to stop</div> : null}
        </div>
      ) : (
        <div
          ref={frameRef}
          className={`pdf-book-spread${columns === 2 ? ' two' : ''}${pinning ? ' is-pinning' : ''}`}
          onWheel={turns.onWheel}
          onTouchStart={turns.onTouchStart}
          onTouchEnd={turns.onTouchEnd}
          {...onPages}
        >
          {unopened ?? (
            <div className="pdf-book-pages">
              {shown.map((number, index) => (
                <PdfPage
                  key={number}
                  doc={opened!.doc}
                  engine={opened!.engine}
                  number={number}
                  scale={scale}
                  side={columns === 2 ? (index === 0 ? 'left' : 'right') : 'single'}
                  overlay={(width, height) => pinsOn(number, width, height)}
                />
              ))}
            </div>
          )}
          {pinHint}
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
      {picked ? (
        <div className="selection-toolbar" style={{ top: picked.top, left: picked.left }} role="toolbar" aria-label="The selection">
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
  overlay,
}: {
  doc: PDFDocumentProxy;
  engine: Engine;
  number: number;
  scale: number;
  side: 'left' | 'right' | 'single';
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
    setDrawn(false);
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
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      const context = canvas.getContext('2d');
      if (!context) return;
      const task = page.render({
        canvas,
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
      if (live) setDrawn(true);
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

  return (
    <div
      className={`pdf-book-page ${side}${drawn ? '' : ' drawing'}`}
      style={size ? { width: size.width, height: size.height } : undefined}
      aria-label={`Page ${number}`}
      data-page={number}
      data-text={textReady ? 'ready' : undefined}
    >
      <canvas ref={canvasRef} style={size ? { width: size.width, height: size.height } : undefined} />
      <div ref={textRef} className="pdf-text" />
      {size && overlay ? overlay(size.width, size.height) : null}
    </div>
  );
}
