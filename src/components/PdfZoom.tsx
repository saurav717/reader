import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Region } from './PdfSnip';


/** A page is never drawn larger than this many pixels off screen, however far it is zoomed. */
const PIXELS = 12e6;

// ---- zoom -------------------------------------------------------------------
// The pages drawn larger than they fit: 1 is the fit, and the most is enough
// to read a footnote across the room.
export const ZOOM_MAX = 5;
export const clampZoom = (zoom: number) => Math.min(ZOOM_MAX, Math.max(1, zoom));
/** A pinch or a ⌘-scroll, as a factor on the zoom. */
export const zoomByWheel = (zoom: number, deltaY: number) => clampZoom(zoom * Math.exp(-deltaY * 0.01));

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Where you are on the page, while it is zoomed: the page small in the
 * corner, the part on screen marked on it. A click or a drag on it goes
 * there.
 */
export function PdfMinimap({ frame, holder, page }: { frame: RefObject<HTMLElement>; holder: RefObject<HTMLElement>; page: number }) {
  const WIDTH = 132;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [aspect, setAspect] = useState(1.3);
  const [window_, setWindow] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  const pageElement = useCallback(() => holder.current?.querySelector<HTMLElement>(`.pdf-book-page[data-page="${page}"]`) ?? null, [holder, page]);

  const draw = useCallback(() => {
    const element = pageElement();
    const source = element?.querySelector('canvas');
    const out = canvasRef.current;
    const view = frame.current;
    if (!element || !source || !source.width || !out || !view) return;
    const rect = element.getBoundingClientRect();
    const seen = view.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = rect.height / rect.width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(WIDTH * dpr);
    const height = Math.round(WIDTH * ratio * dpr);
    if (out.width !== width || out.height !== height) {
      out.width = width;
      out.height = height;
    }
    const context = out.getContext('2d');
    if (!context) return;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, width, height);
    setAspect(ratio);
    const left = clamp01((seen.left - rect.left) / rect.width);
    const top = clamp01((seen.top - rect.top) / rect.height);
    const right = clamp01((seen.right - rect.left) / rect.width);
    const bottom = clamp01((seen.bottom - rect.top) / rect.height);
    setWindow({ left, top, width: right - left, height: bottom - top });
  }, [frame, pageElement]);

  useEffect(() => {
    draw();
    const view = frame.current;
    let raf = 0;
    const soon = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    };
    view?.addEventListener('scroll', soon);
    window.addEventListener('resize', soon);
    // The page is drawn again, sharper, a moment after each zoom: picked up here.
    const timer = window.setInterval(draw, 500);
    return () => {
      cancelAnimationFrame(raf);
      view?.removeEventListener('scroll', soon);
      window.removeEventListener('resize', soon);
      window.clearInterval(timer);
    };
  }, [draw, frame]);

  /** Scroll so that the point of the page under the pointer is in the middle of the screen. */
  const goTo = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = pageElement();
    const view = frame.current;
    if (!element || !view) return;
    const map = event.currentTarget.getBoundingClientRect();
    const fx = clamp01((event.clientX - map.left) / map.width);
    const fy = clamp01((event.clientY - map.top) / map.height);
    const rect = element.getBoundingClientRect();
    const seen = view.getBoundingClientRect();
    view.scrollBy({ left: rect.left + fx * rect.width - (seen.left + seen.width / 2), top: rect.top + fy * rect.height - (seen.top + seen.height / 2) });
  };

  return (
    <div
      className="pdf-minimap"
      style={{ width: WIDTH, height: Math.round(WIDTH * aspect) }}
      title="Where you are on the page — click or drag to go elsewhere"
      aria-label={`Page ${page}, zoomed: where you are`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        goTo(event);
      }}
      onPointerMove={(event) => {
        if (event.buttons & 1) goTo(event);
      }}
    >
      <canvas ref={canvasRef} style={{ width: WIDTH, height: Math.round(WIDTH * aspect) }} />
      <div className="pdf-minimap-shade" />
      {window_ ? (
        <div
          className="pdf-minimap-window"
          style={{ left: `${window_.left * 100}%`, top: `${window_.top * 100}%`, width: `${window_.width * 100}%`, height: `${window_.height * 100}%` }}
        />
      ) : null}
    </div>
  );
}

// ---- the loupe --------------------------------------------------------------
/** The glass's width, on screen. */
const LENS = 320;
export const MAGNIFY_MIN = 1.5;
export const MAGNIFY_MAX = 4;
export const clampMagnify = (magnify: number) => Math.min(MAGNIFY_MAX, Math.max(MAGNIFY_MIN, magnify));

/**
 * A reading glass over the pages, following the pointer: the page under
 * it drawn larger, from a sharper drawing of that page made the first time
 * the glass comes over it. The page itself does not move.
 */
export function PdfLoupe({ doc, holder, scale, magnify }: { doc: PDFDocumentProxy; holder: RefObject<HTMLElement>; scale: number; magnify: number }) {
  const [at, setAt] = useState<{ x: number; y: number; page: HTMLElement } | null>(null);
  const lensRef = useRef<HTMLCanvasElement>(null);
  /** The sharper drawings, a page each, for the pages the glass has been over at this scale. */
  const sharp = useRef(new Map<number, HTMLCanvasElement>());
  const making = useRef(new Set<number>());
  const mounted = useRef(true);
  const [, bump] = useState(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    sharp.current.clear();
    making.current.clear();
  }, [scale, doc]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const pages = holder.current?.querySelectorAll<HTMLElement>('.pdf-book-page') ?? [];
      for (const page of Array.from(pages)) {
        const rect = page.getBoundingClientRect();
        if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
          setAt({ x: event.clientX, y: event.clientY, page });
          return;
        }
      }
      setAt(null);
    };
    document.addEventListener('pointermove', onMove);
    return () => document.removeEventListener('pointermove', onMove);
  }, [holder]);

  // The page under the glass, drawn sharper than it is on screen — once.
  const number = at ? Number(at.page.dataset.page) : 0;
  useEffect(() => {
    if (!number || sharp.current.has(number) || making.current.has(number)) return;
    making.current.add(number);
    (async () => {
      const page = await doc.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const factor = Math.min(scale * MAGNIFY_MAX * 0.75, Math.sqrt(PIXELS / (base.width * base.height)));
      const viewport = page.getViewport({ scale: factor });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) return;
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      if (!mounted.current) return;
      sharp.current.set(number, canvas);
      bump((n) => n + 1);
    })()
      .catch((reason) => console.warn(`Could not draw page ${number} for the loupe`, reason))
      .finally(() => making.current.delete(number));
  }, [number, doc, scale]);

  // What the glass shows, drawn as the pointer moves.
  useEffect(() => {
    const lens = lensRef.current;
    if (!lens || !at) return;
    const source = sharp.current.get(number) ?? at.page.querySelector('canvas');
    if (!source?.width) return;
    const rect = at.page.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const side = Math.round(LENS * dpr);
    if (lens.width !== side) {
      lens.width = side;
      lens.height = side;
    }
    const context = lens.getContext('2d');
    if (!context) return;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, side, side);
    context.imageSmoothingQuality = 'high';
    // Source pixels a screen pixel, and the square of them under the glass.
    const k = source.width / rect.width;
    const span = (LENS / magnify) * k;
    const sx = (at.x - rect.left) * k - span / 2;
    const sy = (at.y - rect.top) * k - span / 2;
    // Only what the page has: past its edge the glass shows white.
    const x0 = Math.max(0, sx);
    const y0 = Math.max(0, sy);
    const x1 = Math.min(source.width, sx + span);
    const y1 = Math.min(source.height, sy + span);
    if (x1 <= x0 || y1 <= y0) return;
    const out = side / span;
    context.drawImage(source, x0, y0, x1 - x0, y1 - y0, (x0 - sx) * out, (y0 - sy) * out, (x1 - x0) * out, (y1 - y0) * out);
  });

  if (!at) return null;
  const below = at.y + LENS / 2 + 54 < window.innerHeight;
  return (
    <>
      <div className="pdf-loupe" style={{ left: at.x - LENS / 2, top: at.y - LENS / 2, width: LENS, height: LENS }} aria-hidden="true">
        <canvas ref={lensRef} style={{ width: LENS, height: LENS }} />
      </div>
      <div className="pdf-zoom-chip pdf-loupe-chip" style={{ left: at.x, top: below ? at.y + LENS / 2 + 14 : at.y - LENS / 2 - 14, transform: `translate(-50%, ${below ? 0 : '-100%'})` }}>
        <b>Loupe</b> {magnify.toFixed(1)}× <span className="sep" /> pinch, or <kbd>+</kbd> <kbd>−</kbd>, to change <span className="sep" /> <kbd>L</kbd> puts it away
      </div>
    </>
  );
}

// ---- a close-up -------------------------------------------------------------
/** One of the things on the pages in view that can be looked at close up. */
export interface CloseUpItem {
  page: number;
  region: Region;
}

/**
 * A figure, table or equation blown up to fill the screen, drawn afresh from
 * the file at that size, with its caption under it; the rest of the page
 * dimmed behind. Tab, or the arrow keys, go on to the next one on the
 * pages in view; Esc, or a click beside it, puts the whole page back.
 */
export function PdfCloseUp({ doc, items, index, onIndex, onClose }: { doc: PDFDocumentProxy; items: CloseUpItem[]; index: number; onIndex: (index: number) => void; onClose: () => void }) {
  const item = items[index];
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    let live = true;
    let cancel: (() => void) | undefined;
    setDrawn(false);
    if (!item) return;
    const { page: number, region } = item;
    (async () => {
      const page = await doc.getPage(number);
      if (!live) return;
      const PAD = 6;
      const x0 = region.box.x0 - PAD;
      const y0 = region.box.y0 - PAD;
      const width = region.box.x1 - region.box.x0 + PAD * 2;
      const height = region.box.y1 - region.box.y0 + PAD * 2;
      // As large as the screen allows, with room for the caption and the keys under it.
      const roomWidth = window.innerWidth - 112;
      const roomHeight = window.innerHeight - 190;
      const zoom = Math.max(0.5, Math.min(roomWidth / width, roomHeight / height, 8));
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const ratio = Math.min(dpr, Math.sqrt(PIXELS / (width * zoom * height * zoom)));
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = Math.floor(width * zoom * ratio);
      canvas.height = Math.floor(height * zoom * ratio);
      setSize({ width: Math.floor(width * zoom), height: Math.floor(height * zoom) });
      const context = canvas.getContext('2d');
      if (!context) return;
      const viewport = page.getViewport({ scale: zoom });
      const task = page.render({ canvas, canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, -x0 * zoom * ratio, -y0 * zoom * ratio] });
      cancel = () => task.cancel();
      await task.promise;
      if (live) setDrawn(true);
    })().catch((reason) => {
      if (live && !(reason instanceof Error && reason.name === 'RenderingCancelledException')) console.warn('Could not draw the close-up', reason);
    });
    return () => {
      live = false;
      cancel?.();
    };
  }, [item, doc]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const step = (by: number) => {
        event.preventDefault();
        if (items.length) onIndex((index + by + items.length) % items.length);
      };
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Tab') step(event.shiftKey ? -1 : 1);
      else if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === ' ') step(1);
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') step(-1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [items, index, onIndex, onClose]);

  if (!item) return null;
  const { page, region } = item;
  const pages = Array.from(new Set(items.map((other) => other.page)));
  return (
    <div className="pdf-closeup" role="dialog" aria-label={`Close-up of ${region.label}, page ${page}`}>
      <div className="pdf-closeup-back" onClick={onClose} />
      <div className="pdf-closeup-body" style={size ? { width: size.width } : undefined}>
        <div className="pdf-closeup-head">
          <span className="pdf-closeup-title">
            {region.label} · page {page}
          </span>
          {items.length > 1 ? (
            <span className="pdf-closeup-dots" aria-hidden="true">
              {items.map((other, at) => (
                <i key={`${other.page}-${at}`} className={at === index ? 'on' : undefined} onClick={() => onIndex(at)} />
              ))}
            </span>
          ) : null}
        </div>
        <div className={`pdf-closeup-card${drawn ? ' is-drawn' : ''}`}>
          <canvas ref={canvasRef} style={size ? { width: size.width, height: size.height } : undefined} />
          {region.caption ? <p className="pdf-closeup-caption">{region.caption}</p> : null}
        </div>
        <div className="pdf-zoom-chip pdf-closeup-chip">
          <b>Close-up</b> {index + 1} of {items.length} on {pages.length === 1 ? `page ${pages[0]}` : `pages ${pages[0]}–${pages[pages.length - 1]}`} <span className="sep" /> <kbd>⇥</kbd> next <kbd>⇧⇥</kbd> back{' '}
          <span className="sep" /> <kbd>Esc</kbd> whole page
        </div>
      </div>
    </div>
  );
}
