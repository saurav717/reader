import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TableCell } from '../lib/pdfLayout';
import { addClip } from '../lib/notes';

type Engine = typeof import('../lib/pdfReflow');

/** A figure, table or equation found on a page, in points from the page's top left. */
interface Region {
  kind: 'figure' | 'table' | 'equation';
  label: string;
  caption: string;
  captionHtml: string;
  rows: TableCell[][] | null;
  box: { x0: number; y0: number; x1: number; y1: number };
}

/** Where a page is drawn, in the layer's own pixels. */
interface Frame {
  page: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A little room round what was found, so a figure's edge is not shaved off. */
const PAD = 4;
/** A drag shorter than this is a click. */
const DRAG = 8;
/** The widest a snipped picture is kept at. */
const WIDTH = 1600;

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Props {
  paperId: string;
  doc: PDFDocumentProxy;
  engine: Engine;
  /** The pages on screen. */
  pages: number[];
  /** Pixels a point, as the pages are drawn. */
  scale: number;
  /** What the pages are drawn in. */
  holder: RefObject<HTMLElement>;
  /** Tell the reader what was kept. */
  announce: (label: string) => void;
}

/**
 * Snipping the PDF, set as a book, into your notes. The figures, tables and
 * equations on the pages in view are found — the same reading of the page
 * that reflows it — and outlined: a click keeps one whole, its caption with
 * it, and a table as a table rather than a picture of one. A drag keeps
 * whatever box is dragged, as a picture, with the words inside it.
 */
export default function PdfSnip({ paperId, doc, engine, pages, scale, holder, announce }: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [regions, setRegions] = useState<Record<number, Region[]>>({});
  const [frames, setFrames] = useState<Frame[]>([]);
  const [hot, setHot] = useState<{ page: number; index: number } | null>(null);
  const [drag, setDrag] = useState<{ page: number; x0: number; y0: number; x1: number; y1: number } | null>(null);

  // What is on each page in view, found once a page.
  useEffect(() => {
    let live = true;
    for (const number of pages) {
      if (regions[number]) continue;
      void (async () => {
        try {
          const input = await engine.extractPage(await doc.getPage(number));
          const layout = engine.layoutPages([input]);
          const found: Region[] = [];
          for (const block of layout.blocks) {
            if (block.kind !== 'figure' && block.kind !== 'table' && block.kind !== 'equation') continue;
            const caption = block.kind === 'equation' ? '' : engine.plain(block.caption);
            found.push({
              kind: block.kind,
              label: block.kind === 'equation' ? 'Equation' : block.label,
              caption,
              captionHtml: block.kind === 'equation' ? '' : engine.spansToHtml(block.caption),
              rows: block.kind === 'table' ? block.rows : null,
              box: { x0: block.crop.x0, y0: block.crop.y0, x1: block.crop.x1, y1: block.crop.y1 },
            });
          }
          if (live) setRegions((current) => ({ ...current, [number]: found }));
        } catch {
          if (live) setRegions((current) => ({ ...current, [number]: [] }));
        }
      })();
    }
    return () => {
      live = false;
    };
    // `regions` is read to skip pages already found, not to find them again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, doc, engine]);

  // Where each page is, relative to this layer, as the spread is laid out now.
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const measure = () => {
      const base = layer.getBoundingClientRect();
      setFrames(
        pages.flatMap((page) => {
          const element = holder.current?.querySelector<HTMLElement>(`.pdf-book-page[data-page="${page}"]`);
          if (!element) return [];
          const rect = element.getBoundingClientRect();
          return [{ page, left: rect.left - base.left, top: rect.top - base.top, width: rect.width, height: rect.height }];
        }),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    return () => observer.disconnect();
  }, [pages, scale, holder]);

  const boxOf = (frame: Frame, region: Region) => ({
    left: frame.left + (region.box.x0 - PAD) * scale,
    top: frame.top + (region.box.y0 - PAD) * scale,
    width: (region.box.x1 - region.box.x0 + PAD * 2) * scale,
    height: (region.box.y1 - region.box.y0 + PAD * 2) * scale,
  });
  const at = (event: ReactPointerEvent) => {
    const base = layerRef.current!.getBoundingClientRect();
    return { x: event.clientX - base.left, y: event.clientY - base.top };
  };
  const frameAt = (x: number, y: number) => frames.find((frame) => x >= frame.left && x <= frame.left + frame.width && y >= frame.top && y <= frame.top + frame.height);
  const regionAt = (x: number, y: number) => {
    const frame = frameAt(x, y);
    if (!frame) return null;
    const list = regions[frame.page] ?? [];
    // The smallest one under the pointer: a figure inside a larger box is the one meant.
    let best: { page: number; index: number; area: number } | null = null;
    list.forEach((region, index) => {
      const box = boxOf(frame, region);
      if (x < box.left || x > box.left + box.width || y < box.top || y > box.top + box.height) return;
      const area = box.width * box.height;
      if (!best || area < best.area) best = { page: frame.page, index, area };
    });
    return best as { page: number; index: number } | null;
  };

  /** A box of a page — in pixels from its top left — as a picture, and the words in it. */
  const cut = (page: number, box: { x: number; y: number; width: number; height: number }) => {
    const element = holder.current?.querySelector<HTMLElement>(`.pdf-book-page[data-page="${page}"]`);
    const canvas = element?.querySelector('canvas');
    if (!element || !canvas) return null;
    const ratio = canvas.width / element.clientWidth;
    const sx = Math.max(0, box.x * ratio);
    const sy = Math.max(0, box.y * ratio);
    const sw = Math.min(canvas.width - sx, box.width * ratio);
    const sh = Math.min(canvas.height - sy, box.height * ratio);
    if (sw < 2 || sh < 2) return null;
    const fit = Math.min(1, WIDTH / sw);
    const out = document.createElement('canvas');
    out.width = Math.round(sw * fit);
    out.height = Math.round(sh * fit);
    out.getContext('2d')?.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
    const base = element.getBoundingClientRect();
    const words = Array.from(element.querySelectorAll<HTMLElement>('.pdf-text span'))
      .map((span) => ({ span, rect: span.getBoundingClientRect() }))
      .filter(({ span, rect }) => {
        const cx = rect.left + rect.width / 2 - base.left;
        const cy = rect.top + rect.height / 2 - base.top;
        return span.textContent?.trim() && cx >= box.x && cx <= box.x + box.width && cy >= box.y && cy <= box.y + box.height;
      })
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    let text = '';
    let line = -1;
    for (const { span, rect } of words) {
      if (line >= 0) text += Math.abs(rect.top - line) > rect.height / 2 ? '\n' : ' ';
      text += span.textContent?.trim();
      line = rect.top;
    }
    return { picture: out.toDataURL('image/png'), text: text.trim() };
  };

  const keepRegion = (page: number, region: Region) => {
    const piece = cut(page, {
      x: (region.box.x0 - PAD) * scale,
      y: (region.box.y0 - PAD) * scale,
      width: (region.box.x1 - region.box.x0 + PAD * 2) * scale,
      height: (region.box.y1 - region.box.y0 + PAD * 2) * scale,
    });
    if (!piece) return;
    const caption = region.captionHtml ? `<figcaption>${region.captionHtml}</figcaption>` : '';
    const picture = `<img class="pdf-crop" src="${piece.picture}" alt="${esc(region.label)}">`;
    let html: string;
    let text: string;
    if (region.kind === 'table' && region.rows?.length) {
      const body = region.rows.map((row) => `<tr>${row.map((cell) => `<td${cell.colspan && cell.colspan > 1 ? ` colspan="${cell.colspan}"` : ''}>${engine.spansToHtml(cell.spans)}</td>`).join('')}</tr>`).join('');
      html = `<figure class="pdf-table">${caption}<table>${body}</table></figure>`;
      const rows = region.rows.map((row) => row.map((cell) => engine.plain(cell.spans).replace(/\|/g, '\\|')));
      text = `${region.caption ? `${region.caption}\n\n` : ''}${rows.map((cells, index) => `| ${cells.join(' | ')} |${index === 0 ? `\n|${cells.map(() => ' --- |').join('')}` : ''}`).join('\n')}`;
    } else if (region.kind === 'equation') {
      html = `<div class="pdf-equation">${picture}</div>`;
      text = piece.text || '[Equation]';
    } else {
      html = `<figure class="${region.kind === 'table' ? 'pdf-table' : 'pdf-figure'}">${region.kind === 'table' ? caption + picture : picture + caption}</figure>`;
      text = region.caption ? `[${region.label}: ${region.caption}]` : `[${region.label}]`;
    }
    addClip(paperId, { label: region.label, html, text, source: { from: 'paper', page, quote: (region.caption || piece.text).slice(0, 80) || undefined } });
    announce(region.label);
  };

  const keepBox = (page: number, box: { x: number; y: number; width: number; height: number }) => {
    const piece = cut(page, box);
    if (!piece) return;
    addClip(paperId, {
      label: 'Snip',
      html: `<figure class="pdf-figure"><img class="pdf-crop" src="${piece.picture}" alt="Snipped from page ${page}"></figure>`,
      text: piece.text ? `[Snip, p. ${page}] ${piece.text}` : `[Snip, p. ${page}]`,
      source: { from: 'paper', page, quote: piece.text.slice(0, 80) || undefined },
    });
    announce('Snip');
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const { x, y } = at(event);
    const frame = frameAt(x, y);
    if (!frame) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ page: frame.page, x0: x, y0: y, x1: x, y1: y });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const { x, y } = at(event);
    if (drag) {
      // Kept to the page it started on.
      const frame = frames.find((f) => f.page === drag.page)!;
      setDrag({ ...drag, x1: Math.max(frame.left, Math.min(frame.left + frame.width, x)), y1: Math.max(frame.top, Math.min(frame.top + frame.height, y)) });
      return;
    }
    const found = regionAt(x, y);
    if (found?.page !== hot?.page || found?.index !== hot?.index) setHot(found);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const width = Math.abs(drag.x1 - drag.x0);
    const height = Math.abs(drag.y1 - drag.y0);
    const frame = frames.find((f) => f.page === drag.page);
    setDrag(null);
    if (!frame) return;
    if (width >= DRAG && height >= DRAG) {
      keepBox(drag.page, { x: Math.min(drag.x0, drag.x1) - frame.left, y: Math.min(drag.y0, drag.y1) - frame.top, width, height });
      return;
    }
    const found = regionAt(drag.x0, drag.y0);
    if (found) keepRegion(found.page, regions[found.page][found.index]);
  };

  return (
    <div
      ref={layerRef}
      className="snip-layer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => !drag && setHot(null)}
      aria-label="Snip: drag a box, or click a figure or table that is outlined"
    >
      {frames.flatMap((frame) =>
        (regions[frame.page] ?? []).map((region, index) => {
          const isHot = hot?.page === frame.page && hot.index === index && !drag;
          return (
            <div key={`${frame.page}-${index}`} className={`snip-region${isHot ? ' is-hot' : ''}`} style={boxOf(frame, region)}>
              {isHot ? (
                <span className="snip-region-label">
                  {region.label}
                  {region.kind === 'table' && region.rows?.length ? ` · ${region.rows.length} rows × ${Math.max(...region.rows.map((row) => row.length))}` : ''} · click to add
                </span>
              ) : null}
            </div>
          );
        }),
      )}
      {drag && (Math.abs(drag.x1 - drag.x0) >= DRAG || Math.abs(drag.y1 - drag.y0) >= DRAG) ? (
        <div
          className="snip-drag"
          style={{ left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) }}
        />
      ) : null}
      <div className="snip-hint">✂ Drag a box, or click a figure or table outlined · Esc or S to stop</div>
    </div>
  );
}
