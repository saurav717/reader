/**
 * The PDF, read out in full: every glyph and every drawing on every page,
 * handed to `pdfLayout` to be made into a document, and the figures,
 * tables and equations that come back as regions painted from the page
 * itself. This is the half that talks to pdf.js — loaded on demand, since
 * it is a large library that a reader in PDF mode never needs.
 */
// Safari cannot `for await` over a ReadableStream, and pdf.js reads each
// page's text that way — even in the legacy build.
import './streamIterator';
// The legacy build carries its own polyfills — the modern one leans on
// what only the newest browsers have, `Map.prototype.getOrInsertComputed`
// among them, and a reader in last year's browser gets nothing.
import { getDocument, GlobalWorkerOptions, OPS, PDFWorker } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
// The worker script, bundled by Vite into a `.js` file of its own rather
// than copied over as the `.mjs` pdf.js ships: a static host that does not
// know `.mjs` is JavaScript serves it as something else, and a module
// worker made from that never starts.
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&url';
import { layoutPages, renderHtml, type Crop, type GraphicBox, type Layout, type PageInput, type TextRun } from './pdfLayout';

if (typeof window !== 'undefined' && !GlobalWorkerOptions.workerSrc) GlobalWorkerOptions.workerSrc = workerUrl;

/** How long to give the worker script to start before reading on the main thread instead. */
const WORKER_START_MS = 20_000;

let engine: Promise<PDFWorker | null> | null = null;

/**
 * What pdf.js parses with: a web worker running the bundled worker script,
 * or, when the browser will not start one — the script refused, the file
 * not served as JavaScript, workers unavailable — the same code loaded on
 * the main thread, where it is slower and stalls the page while it reads
 * but reads all the same. Decided once, the first time a PDF is opened.
 *
 * pdf.js would fall back on its own, but by importing the worker script
 * over again, which fails for the same reason the worker did; the module
 * imported here is a chunk of the app, loaded the way the rest of it is.
 */
function engineReady(): Promise<PDFWorker | null> {
  engine ??= (async () => {
    if (typeof Worker !== 'undefined') {
      let worker: Worker | null = null;
      try {
        worker = new Worker(workerUrl, { type: 'module' });
        const started = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), WORKER_START_MS);
          // The script says "ready" the moment it has loaded; a script that
          // will not load says so with an error.
          worker!.addEventListener('message', () => (clearTimeout(timer), resolve(true)), { once: true });
          worker!.addEventListener('error', () => (clearTimeout(timer), resolve(false)), { once: true });
        });
        if (started) return PDFWorker.create({ port: worker });
      } catch {
        // No workers here at all.
      }
      worker?.terminate();
    }
    console.warn('pdf.js: the worker script would not start; PDFs are read on the main thread instead.');
    const module = await import('./pdfWorkerMain');
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = module;
    return null;
  })();
  return engine;
}

/** A document opened with whichever engine there is. */
async function openDocument(data: Uint8Array) {
  const worker = await engineReady();
  return getDocument({ data, useSystemFonts: false, ...(worker ? { worker } : {}) });
}

type Matrix = [number, number, number, number, number, number];

/** `m1 × m2`: the transform that applies `m2` first, then `m1`. */
function multiply(m1: ArrayLike<number>, m2: ArrayLike<number>): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

const apply = (m: Matrix, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

/** The four corners of a box under a transform, boxed again. */
function transformed(matrix: Matrix, x0: number, y0: number, x1: number, y1: number): GraphicBox | null {
  const corners = [apply(matrix, x0, y0), apply(matrix, x1, y0), apply(matrix, x0, y1), apply(matrix, x1, y1)];
  const xs = corners.map((point) => point[0]);
  const ys = corners.map((point) => point[1]);
  const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), kind: 'path' as const };
  return Number.isFinite(box.x0) && Number.isFinite(box.y0) && Number.isFinite(box.x1) && Number.isFinite(box.y1) ? box : null;
}

/**
 * Where everything is drawn on a page, in points from the top-left corner.
 * The operator list is replayed with only the transformation stack kept,
 * which is enough to know where each image and path lands.
 */
function graphicsOf(page: PDFPageProxy, fnArray: number[], argsArray: unknown[], base: Matrix): GraphicBox[] {
  const boxes: GraphicBox[] = [];
  let ctm: Matrix = base;
  const stack: Matrix[] = [];
  const PAINT_OPS = new Set([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  for (let at = 0; at < fnArray.length; at += 1) {
    const fn = fnArray[at];
    const args = argsArray[at] as unknown[] | null;
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? base;
        break;
      case OPS.transform:
        if (args && args.length >= 6) ctm = multiply(ctm, args as ArrayLike<number>);
        break;
      case OPS.paintFormXObjectBegin: {
        stack.push(ctm);
        const matrix = args?.[0] as Matrix | null | undefined;
        if (matrix && matrix.length >= 6) ctm = multiply(ctm, matrix);
        break;
      }
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? base;
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject: {
        const box = transformed(ctm, 0, 0, 1, 1);
        if (box) boxes.push({ ...box, kind: 'image' });
        break;
      }
      case OPS.constructPath: {
        const op = args?.[0] as number | undefined;
        const minMax = args?.[2] as ArrayLike<number> | null | undefined;
        if (op === undefined || !PAINT_OPS.has(op) || !minMax || minMax.length < 4) break;
        const box = transformed(ctm, minMax[0], minMax[1], minMax[2], minMax[3]);
        if (box) boxes.push(box);
        break;
      }
      default:
        break;
    }
  }
  void page;
  return boxes;
}

/** Everything on one page that the layout needs. */
export async function extractPage(page: PDFPageProxy): Promise<PageInput> {
  const viewport = page.getViewport({ scale: 1 });
  const base = viewport.transform as Matrix;
  // The operator list first: it is what loads the fonts, and their names
  // — bold, italic, mathematics — are what the text is read by.
  const operators = await page.getOperatorList();
  const graphics = graphicsOf(page, operators.fnArray, operators.argsArray, base);
  const content = await page.getTextContent();
  const fontNames = new Map<string, string>();
  const runs: TextRun[] = [];
  for (const item of content.items) {
    if (!('str' in item) || !item.str) continue;
    const matrix = multiply(base, item.transform as ArrayLike<number>);
    const [a, b, c, d, e, f] = matrix;
    // Text set sideways — the arXiv stamp down the margin — is not read.
    if (Math.abs(b) > 0.05 * Math.abs(a) || Math.abs(c) > 0.05 * Math.abs(d)) continue;
    if (a <= 0) continue;
    const size = Math.hypot(c, d);
    if (!(size > 0)) continue;
    let font = fontNames.get(item.fontName);
    if (font === undefined) {
      font = '';
      try {
        const loaded = page.commonObjs.has(item.fontName) ? (page.commonObjs.get(item.fontName) as { name?: string } | null) : null;
        font = loaded?.name || content.styles[item.fontName]?.fontFamily || '';
      } catch {
        font = content.styles[item.fontName]?.fontFamily || '';
      }
      fontNames.set(item.fontName, font);
    }
    runs.push({ str: item.str, x: e, y: f, width: item.width * viewport.scale, size, font });
  }
  return { index: page.pageNumber - 1, width: viewport.width, height: viewport.height, runs, graphics };
}

export interface ReflowProgress {
  /** Pages read so far, and how many there are. */
  done: number;
  total: number;
  stage: 'reading' | 'painting';
}

export interface ReflowedPdf {
  html: string;
  pages: number;
  /** Running text found, in characters. Near zero means a scanned PDF. */
  characters: number;
  /** Hands back the images the HTML refers to. */
  release: () => void;
}

const SCALE = 2;
const MAX_CROP_PIXELS = 4000;

/** A region of a page as a PNG, from the page painted at twice its size. */
async function paintCrops(doc: PDFDocumentProxy, crops: Crop[], signal?: AbortSignal, onProgress?: (progress: ReflowProgress) => void): Promise<Map<number, string>> {
  const urls = new Map<number, string>();
  if (typeof document === 'undefined') return urls;
  const byPage = new Map<number, Crop[]>();
  for (const crop of crops) byPage.set(crop.page, [...(byPage.get(crop.page) || []), crop]);
  let done = 0;
  for (const [pageIndex, wanted] of byPage) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const page = await doc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) continue;
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    for (const crop of wanted) {
      const x = Math.floor(crop.x0 * SCALE);
      const y = Math.floor(crop.y0 * SCALE);
      const width = Math.min(MAX_CROP_PIXELS, Math.ceil((crop.x1 - crop.x0) * SCALE));
      const height = Math.min(MAX_CROP_PIXELS, Math.ceil((crop.y1 - crop.y0) * SCALE));
      if (width < 2 || height < 2) continue;
      const piece = document.createElement('canvas');
      piece.width = width;
      piece.height = height;
      const pieceContext = piece.getContext('2d');
      if (!pieceContext) continue;
      pieceContext.fillStyle = '#fff';
      pieceContext.fillRect(0, 0, width, height);
      pieceContext.drawImage(canvas, x, y, width, height, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) => piece.toBlob(resolve, 'image/png'));
      if (blob) urls.set(crop.id, URL.createObjectURL(blob));
      piece.width = 0;
      piece.height = 0;
    }
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
    done += 1;
    onProgress?.({ done, total: byPage.size, stage: 'painting' });
  }
  return urls;
}

/** The pages of a document, read out one by one. */
export async function extractDocument(doc: PDFDocumentProxy, signal?: AbortSignal, onProgress?: (progress: ReflowProgress) => void): Promise<PageInput[]> {
  const pages: PageInput[] = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const page = await doc.getPage(number);
    pages.push(await extractPage(page));
    onProgress?.({ done: number, total: doc.numPages, stage: 'reading' });
  }
  return pages;
}

/**
 * A PDF as a document to read. Null when the file has no text to speak of
 * — a scan — since a page of nothing is worse than the abstract.
 */
export async function reflowPdf(
  blob: Blob,
  options: { title?: string; signal?: AbortSignal; onProgress?: (progress: ReflowProgress) => void } = {},
): Promise<ReflowedPdf | null> {
  const { signal, onProgress } = options;
  const data = new Uint8Array(await blob.arrayBuffer());
  const task = await openDocument(data);
  const abort = () => void task.destroy();
  signal?.addEventListener('abort', abort, { once: true });
  const doc = await task.promise;
  try {
    const pages = await extractDocument(doc, signal, onProgress);
    const layout: Layout = layoutPages(pages, { title: options.title });
    if (layout.characters < 200) return null;
    const urls = await paintCrops(doc, layout.crops, signal, onProgress);
    const html = renderHtml(layout, (crop) => urls.get(crop.id) ?? null);
    return {
      html,
      pages: doc.numPages,
      characters: layout.characters,
      release: () => {
        for (const url of urls.values()) URL.revokeObjectURL(url);
        urls.clear();
      },
    };
  } finally {
    signal?.removeEventListener('abort', abort);
    void task.destroy();
  }
}

/**
 * How many pages a PDF has and how big the first one is, in points — enough
 * to tell a paper from a poster or a deck of slides (see `pdfShape`). The
 * file is opened, not read: no page's text or drawing is looked at.
 */
export async function measurePdf(blob: Blob): Promise<{ pages: number; width: number; height: number }> {
  const data = new Uint8Array(await blob.arrayBuffer());
  const task = await openDocument(data);
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const { width, height } = page.getViewport({ scale: 1 });
    return { pages: doc.numPages, width, height };
  } finally {
    void task.destroy();
  }
}

/**
 * The PDF opened to be shown page by page, as the book view of PDF mode does.
 * `close` lets go of it — the worker's copy of the file with it.
 */
export async function openPdf(blob: Blob): Promise<{ doc: PDFDocumentProxy; close: () => void }> {
  const data = new Uint8Array(await blob.arrayBuffer());
  const task = await openDocument(data);
  try {
    return { doc: await task.promise, close: () => void task.destroy() };
  } catch (error) {
    void task.destroy();
    throw error;
  }
}

/** The page's text, laid over its picture so that it can be selected and copied. */
export { TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
