// ===========================================================================
//  Reading the paper's figures out of what the reader has: the Reflow
//  column, or — in PDF mode — the PDF itself, reflowed once for the crops
//  of its figures. Kept apart from paperFigures.ts because it needs the DOM
//  and pdf.js; the Explain view sets it as that module's reader.
// ===========================================================================

import { MAX_FIGURES, refFromCaption, figureKey } from './paperFigures';
import type { PaperFigure } from './paperFigures';
import { pdfShown } from './screen';

/** The longest side of a figure as it is kept and sent. */
const FIGURE_PIXELS = 1100;
const CAPTION_MAX = 320;
const FIGURES = 'figure, .ltx_float';

const textOf = (element: Element | null | undefined) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** A picture as base64 JPEG on white, at most FIGURE_PIXELS on its long side. */
function toJpeg(source: CanvasImageSource, width: number, height: number): { data: string; width: number; height: number } | null {
  if (width < 40 || height < 40) return null;
  const scale = Math.min(1, FIGURE_PIXELS / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const data = canvas.toDataURL('image/jpeg', 0.85).split(',')[1] ?? '';
  const out = { data, width: canvas.width, height: canvas.height };
  canvas.width = 0;
  canvas.height = 0;
  return data ? out : null;
}

/**
 * An image's picture: its bytes fetched — a blob: crop, or a file arXiv links,
 * which the paper proxy serves with CORS headers — or, when that fails, the
 * image as the page drew it (which taints nothing when it is our own origin).
 */
async function pictureOf(image: HTMLImageElement): Promise<{ data: string; width: number; height: number } | null> {
  const src = image.currentSrc || image.getAttribute('src') || '';
  if (!src) return null;
  try {
    const response = await fetch(src, { mode: 'cors' });
    if (response.ok) {
      const bitmap = await createImageBitmap(await response.blob());
      try {
        return toJpeg(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close();
      }
    }
  } catch {
    // the page's own copy, below
  }
  try {
    if (image.isConnected && image.complete && image.naturalWidth) return toJpeg(image, image.naturalWidth, image.naturalHeight);
  } catch {
    // a tainted canvas: this one is left out
  }
  return null;
}

/** The figures and tables pictured inside `root`, each once, by the name its caption gives it. */
async function figuresIn(root: ParentNode): Promise<PaperFigure[]> {
  const out: PaperFigure[] = [];
  const seen = new Set<string>();
  for (const element of Array.from(root.querySelectorAll<HTMLElement>(FIGURES))) {
    if (out.length >= MAX_FIGURES) break;
    // A panel inside a figure is part of the figure: the outer one is taken whole.
    if (element.parentElement?.closest(FIGURES)) continue;
    const caption = textOf(element.querySelector(':scope > figcaption, :scope > .ltx_caption') ?? element.querySelector('figcaption, .ltx_caption'));
    const named = refFromCaption(caption);
    if (!named || seen.has(figureKey(named.ref))) continue;
    // The largest picture in it; a table set as text has none, and is left to the text.
    const images = Array.from(element.querySelectorAll<HTMLImageElement>('img'));
    if (!images.length) continue;
    const image = images.length === 1 ? images[0] : images.reduce((a, b) => ((b.naturalWidth || Number(b.getAttribute('width')) || 0) > (a.naturalWidth || Number(a.getAttribute('width')) || 0) ? b : a));
    const picture = await pictureOf(image);
    if (!picture) continue;
    seen.add(figureKey(named.ref));
    out.push({ ...named, caption: caption.length > CAPTION_MAX ? `${caption.slice(0, CAPTION_MAX)}…` : caption, ...picture });
  }
  return out;
}

/** The PDF in PDF mode, reflowed once for the figures in it: the same crops the Reflow column shows. */
async function figuresOfPdf(blob: Blob): Promise<PaperFigure[]> {
  const { reflowPdf } = await import('./pdfReflow');
  const reflowed = await reflowPdf(blob);
  if (!reflowed) return [];
  try {
    const doc = new DOMParser().parseFromString(reflowed.html, 'text/html');
    return await figuresIn(doc.body);
  } finally {
    reflowed.release();
  }
}

/** The paper's figures from what is on screen: the Reflow column, else the PDF being shown. */
export async function figuresOnScreen(): Promise<PaperFigure[]> {
  if (typeof document === 'undefined') return [];
  const body = document.querySelector('.paper-body');
  if (body) {
    const found = await figuresIn(body);
    if (found.length) return found;
  }
  const pdf = pdfShown();
  return pdf ? figuresOfPdf(pdf) : [];
}
