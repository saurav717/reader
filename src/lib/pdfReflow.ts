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
import { getDocument, GlobalWorkerOptions, PDFWorker } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
// The worker script, bundled by Vite into a `.js` file of its own rather
// than copied over as the `.mjs` pdf.js ships: a static host that does not
// know `.mjs` is JavaScript serves it as something else, and a module
// worker made from that never starts.
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&url';
import { layoutPages, renderHtml, type Crop, type Layout, type PageInput, type PaperByline } from './pdfLayout';
import { extractPage } from './pdfExtract';

export { extractPage };

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
  /** The authors named on the first page, where they could be read. */
  authors?: string[];
  /** The byline read whole: marks, notes, institutions. */
  byline?: PaperByline;
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
    const html = renderHtml(layout, (crop) => urls.get(crop.id) ?? null, SCALE);
    return {
      html,
      pages: doc.numPages,
      characters: layout.characters,
      authors: layout.authors,
      byline: layout.byline,
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
// For finding the figures and tables on one page, where the PDF is set as a book.
export { layoutPages, plain, spansToHtml, tableGrid } from './pdfLayout';
