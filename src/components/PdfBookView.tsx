import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { TWO_PAGE_MIN_WIDTH, usePageTurns } from './BookView';
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from './icons';
import { useKept } from './Keep';
import PdfSnip from './PdfSnip';
import { addClip, addText, useNotes } from '../lib/notes';
import PagePins, { stickiesOf } from './PdfPins';

type Engine = typeof import('../lib/pdfReflow');

interface Props {
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
export default function PdfBookView({ paperId, snipping, onSnipping, blob, title, initialProgress, onProgress }: Props) {
  const frameRef = useRef<HTMLDivElement>(null);
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
  const columns = pagesShown === 'one' ? 1 : pagesShown === 'two' ? (frame.width >= 640 ? 2 : 1) : twoFit ? 2 : 1;
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
    if (!pages) return;
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
      setSpread(clamped);
      onProgress(spreads > 1 ? clamped / (spreads - 1) : 0);
    },
    [onProgress, spreads],
  );
  const turns = usePageTurns(go, spreadNow, spreads);

  // Ask Claude showing a passage: turn to the spread that holds its page.
  useEffect(() => {
    const onPage = (event: Event) => {
      const page = (event as CustomEvent<{ page: number }>).detail?.page;
      if (page) go(Math.floor((page - 1) / columns));
    };
    window.addEventListener('reader:pdf-page', onPage);
    return () => window.removeEventListener('reader:pdf-page', onPage);
  }, [go, columns]);

  // Every page drawn at the one scale that fits the spread in the frame.
  const scale = pageSize
    ? Math.max(0.1, Math.min((frame.width - MARGIN * 2) / (pageSize.width * columns), (frame.height - MARGIN * 2) / pageSize.height))
    : 1;
  const shown = Array.from({ length: columns }, (_, index) => spread * columns + index + 1).filter((number) => number <= pages);
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
      if (document.querySelector('.explain:not(.layout-beside), .notes-board, .scrim, .sheet, .palette')) return;
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

  return (
    <div className="book-view pdf-book" aria-label={`${title} (PDF), as a book`}>
      <div
        ref={frameRef}
        className={`pdf-book-spread${columns === 2 ? ' two' : ''}${pinning ? ' is-pinning' : ''}`}
        onWheel={turns.onWheel}
        onTouchStart={turns.onTouchStart}
        onTouchEnd={turns.onTouchEnd}
        onMouseUp={() => !snipping && !pinning && takeSelection()}
        onClick={(event) => {
          if (pinning) pinAt(event.target, event.clientX, event.clientY);
        }}
        onDoubleClick={(event) => {
          if (!snipping && !pinning) pinAt(event.target, event.clientX, event.clientY);
        }}
      >
        {error ? (
          <p className="banner warn" style={{ margin: 16 }}>
            The PDF could not be drawn — {error.replace(/\.$/, '')}.
          </p>
        ) : !opened || !pageSize ? (
          <p className="pdf-book-loading">
            <span className="spinner" /> Opening the PDF…
          </p>
        ) : (
          <div className="pdf-book-pages">
            {shown.map((number, index) => (
              <PdfPage
                key={number}
                doc={opened.doc}
                engine={opened.engine}
                number={number}
                scale={scale}
                side={columns === 2 ? (index === 0 ? 'left' : 'right') : 'single'}
                overlay={(width, height) => pinsOn(number, width, height)}
              />
            ))}
          </div>
        )}
        {pinning ? <div className="pin-hint">📌 Click anywhere on a page to pin a note there · double-click works any time · Esc to stop</div> : null}
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
      <div className="book-nav">
        <span className="book-folio">
          {pages ? `${firstShown === lastShown ? `Page ${firstShown}` : `Pages ${firstShown}–${lastShown}`} of ${pages}` : 'Pages'}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(0, spreads - 1)}
          value={Math.min(spread, spreads - 1)}
          onChange={(event) => go(Number(event.target.value))}
          aria-label="Go to page"
          disabled={spreads <= 1}
        />
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
        <span className="segmented pdf-pages-choice" role="group" aria-label="Pages at a time">
          <button type="button" aria-pressed={columns === 1} onClick={() => choosePages('one')} title="One page at a time">
            1 page
          </button>
          <button type="button" aria-pressed={columns === 2} onClick={() => choosePages('two')} disabled={frame.width < 640} title="Two pages side by side, as a book">
            2 pages
          </button>
        </span>
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
