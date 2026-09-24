import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { TWO_PAGE_MIN_WIDTH, usePageTurns } from './BookView';
import { ChevronLeftIcon, ChevronRightIcon } from './icons';

type Engine = typeof import('../lib/pdfReflow');

interface Props {
  blob: Blob;
  title: string;
  /** Where the paper was left, 0–1, to open on the same page. */
  initialProgress: number;
  onProgress: (fraction: number) => void;
}

/** Space kept round a spread inside the frame, and under it for the pages' shadow. */
const MARGIN = 16;

/**
 * The PDF itself set as a book: its own pages, two side by side — one on a
 * narrow screen — drawn by pdf.js, turned the way the reflowed book is
 * turned. The text of each page is laid over its picture, so it can be
 * selected and copied as in the browser's own viewer.
 */
export default function PdfBookView({ blob, title, initialProgress, onProgress }: Props) {
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
  const columns = frame.width >= TWO_PAGE_MIN_WIDTH && frame.width >= frame.height ? 2 : 1;
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

  // Every page drawn at the one scale that fits the spread in the frame.
  const scale = pageSize
    ? Math.max(0.1, Math.min((frame.width - MARGIN * 2) / (pageSize.width * columns), (frame.height - MARGIN * 2) / pageSize.height))
    : 1;
  const shown = Array.from({ length: columns }, (_, index) => spread * columns + index + 1).filter((number) => number <= pages);
  const firstShown = shown[0] ?? 1;
  const lastShown = shown[shown.length - 1] ?? firstShown;

  return (
    <div className="book-view pdf-book" aria-label={`${title} (PDF), as a book`}>
      <div
        ref={frameRef}
        className={`pdf-book-spread${columns === 2 ? ' two' : ''}`}
        onWheel={turns.onWheel}
        onTouchStart={turns.onTouchStart}
        onTouchEnd={turns.onTouchEnd}
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
              />
            ))}
          </div>
        )}
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
      </div>
    </div>
  );
}

/**
 * One page: its picture on a canvas, sharp at the screen's pixel density,
 * and its text over it in pdf.js's text layer. Drawn again at a new scale,
 * with whatever was being drawn before given up.
 */
function PdfPage({ doc, engine, number, scale, side }: { doc: PDFDocumentProxy; engine: Engine; number: number; scale: number; side: 'left' | 'right' | 'single' }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    let live = true;
    let cancel: (() => void) | undefined;
    setDrawn(false);
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
    >
      <canvas ref={canvasRef} style={size ? { width: size.width, height: size.height } : undefined} />
      <div ref={textRef} className="pdf-text" />
    </div>
  );
}
