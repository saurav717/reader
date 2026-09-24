// Reading the reader's own screen, for the Ask Claude window: the passage in
// view, the text last selected in the paper, and the paper's whole text. All
// of it comes from the DOM the reader already rendered — the Reflow column or
// the book — so what Claude reads is what you are looking at, highlights and
// all. In PDF mode the page is a picture — pdf.js's canvases, or the
// browser's own viewer — so the text is read from the PDF file itself instead
// (see `showPdf` below), and the pages in view go along as images.

const BODY = '.paper-body';
const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, figcaption, blockquote, pre, dt, dd, caption, .ltx_para, .ltx_title';

const text = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+\n/g, '\n').trim();

/** The paper as the reader rendered it, or '' when nothing is rendered. */
export function paperText(): string {
  const body = document.querySelector(BODY);
  return body ? text(body) : '';
}

/**
 * The paragraphs that are on screen now. "On screen" is judged against the
 * box that scrolls the paper — the Reflow column, or the book's spread — not
 * the window, because the book lays its other pages out beside the spread,
 * outside the window's view but inside the viewport's.
 */
export function visiblePassage(max = 6000): string {
  const body = document.querySelector(BODY);
  if (!body) return '';
  const frame = (body.closest('.reader-scroll, .book-pages') ?? body).getBoundingClientRect();
  const top = Math.max(frame.top, 0);
  const bottom = Math.min(frame.bottom, window.innerHeight);
  const left = Math.max(frame.left, 0);
  const right = Math.min(frame.right, window.innerWidth);

  const out: string[] = [];
  let length = 0;
  let last: Element | null = null;
  for (const el of Array.from(body.querySelectorAll(BLOCKS))) {
    // A list item's paragraph is already in the list item.
    if (last && last.contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (!r.height || r.bottom <= top || r.top >= bottom || r.right <= left || r.left >= right) continue;
    const t = text(el);
    if (!t) continue;
    last = el;
    out.push(t);
    length += t.length;
    if (length >= max) break;
  }
  return out.join('\n\n');
}

// Focusing the chat box moves the document's selection into it, so the
// selection has to be remembered as it is made, not read when the question is
// sent. A selection made in the paper replaces it; clicking in the paper
// without selecting clears it; anything outside the paper leaves it alone.
let lastSelection = '';
let tracking = false;

export function trackSelection() {
  if (tracking || typeof document === 'undefined') return;
  tracking = true;
  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection();
    const node = selection?.anchorNode;
    const element = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
    // The PDF book's text layer is selectable too.
    if (!element?.closest(`${BODY}, .pdf-book`)) return;
    lastSelection = selection && !selection.isCollapsed ? selection.toString().trim() : '';
  });
}

export const currentSelection = () => lastSelection;

/** Forget the selection — when the paper changes, it is no longer on screen. */
export function clearSelection() {
  lastSelection = '';
}

// ---------------------------------------------------------------------------
// PDF mode
// ---------------------------------------------------------------------------
//
// In PDF mode nothing in `.paper-body` is rendered, so the reader registers
// the file it is showing. Its text is pulled out with pdf.js once per file and
// kept, page by page, so a second question costs nothing; the pages in view
// are known when the PDF is set as a book (the browser's own viewer keeps its
// page to itself), and their canvases go along as pictures.

let pdfOnScreen: Blob | null = null;
const pdfPages = new WeakMap<Blob, Promise<string[]>>();

/** The PDF being shown in PDF mode, or null when it is not. */
export function showPdf(blob: Blob | null) {
  pdfOnScreen = blob;
}

async function extractPdfText(blob: Blob): Promise<string[]> {
  const engine = await import('./pdfReflow');
  const { doc, close } = await engine.openPdf(blob);
  try {
    const pages: string[] = [];
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      let line = '';
      const lines: string[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = '';
        }
      }
      if (line) lines.push(line);
      pages.push(lines.join('\n').replace(/[ \t]+/g, ' ').replace(/(\w)-\n(\w)/g, '$1$2').trim());
    }
    return pages;
  } finally {
    close();
  }
}

/** The text of each page of the PDF on screen, or null outside PDF mode. */
export function pdfPageTexts(): Promise<string[]> | null {
  const blob = pdfOnScreen;
  if (!blob) return null;
  let pages = pdfPages.get(blob);
  if (!pages) {
    pages = extractPdfText(blob);
    pdfPages.set(blob, pages);
    // A failure is not cached: the next question tries again.
    pages.catch(() => pdfPages.delete(blob));
  }
  return pages;
}

/** The page numbers in view when the PDF is set as a book; empty in the browser's viewer. */
export function pdfPagesInView(): number[] {
  return Array.from(document.querySelectorAll('.pdf-book-page'), (el) =>
    Number(el.getAttribute('aria-label')?.match(/\d+/)?.[0]),
  ).filter((n) => n > 0);
}

/**
 * The pages in view as JPEG pictures, base64 without the data: prefix — what
 * Claude needs for figures, tables and equations the text cannot carry. Long
 * sides are held to about 1500 pixels, which is plenty to read a page.
 */
export function pdfPageImages(max = 2): { label: string; data: string }[] {
  const out: { label: string; data: string }[] = [];
  for (const el of Array.from(document.querySelectorAll('.pdf-book-page:not(.drawing)')).slice(0, max)) {
    const canvas = el.querySelector('canvas');
    const page = Number(el.getAttribute('aria-label')?.match(/\d+/)?.[0]);
    if (!canvas || !canvas.width || !canvas.height) continue;
    try {
      const scale = Math.min(1, 1500 / Math.max(canvas.width, canvas.height));
      const copy = document.createElement('canvas');
      copy.width = Math.round(canvas.width * scale);
      copy.height = Math.round(canvas.height * scale);
      const data = jpeg(canvas, copy);
      if (data) out.push({ label: `Page ${page} of the PDF, as it is on screen:`, data });
    } catch {
      // a canvas that cannot be read is left out; the text still goes
    }
  }
  return out;
}

/** A picture drawn onto `into` at its size, on white, as base64 JPEG. */
function jpeg(source: CanvasImageSource, into: HTMLCanvasElement): string {
  const context = into.getContext('2d');
  if (!context) return '';
  context.fillStyle = '#fff';
  context.fillRect(0, 0, into.width, into.height);
  context.drawImage(source, 0, 0, into.width, into.height);
  return into.toDataURL('image/jpeg', 0.85).split(',')[1] ?? '';
}

/** Whether this browser can be asked for a screenshot of the tab. */
export const canCapture = () => typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia);

/**
 * A screenshot of this tab, as base64 JPEG — for what no text can carry: the
 * browser's own PDF viewer, a figure, the page exactly as it looks. A page
 * cannot look at the screen by itself; the browser asks, every time, and
 * offers this tab first. Nothing is recorded: one frame is taken and the
 * capture is stopped.
 */
export async function captureTab(): Promise<string> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser' },
    audio: false,
    // Chrome's hints: offer this tab, and do not switch away from it.
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'exclude',
  } as DisplayMediaStreamOptions);
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    // The first frame can be blank while the picker closes.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error('The browser gave back an empty picture.');
    const scale = Math.min(1, 1600 / Math.max(width, height));
    const copy = document.createElement('canvas');
    copy.width = Math.round(width * scale);
    copy.height = Math.round(height * scale);
    const data = jpeg(video, copy);
    video.srcObject = null;
    if (!data) throw new Error('The screenshot could not be drawn.');
    return data;
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}
