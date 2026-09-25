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
// The Explain page counts as the paper here: what is selected on it is what
// the reader is asking about, and it remembers which of the two it came from.
let lastSelection = '';
let lastSelectionIn: 'paper' | 'explanation' = 'paper';
let tracking = false;

const EXPLAIN_DOC = '.explain-doc';

export function trackSelection() {
  if (tracking || typeof document === 'undefined') return;
  tracking = true;
  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection();
    const node = selection?.anchorNode;
    const element = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
    // The PDF book's text layer is selectable too.
    const place = element?.closest(`${BODY}, .pdf-book, ${EXPLAIN_DOC}`);
    if (!place) return;
    lastSelection = selection && !selection.isCollapsed ? selectedText(selection) : '';
    lastSelectionIn = place.matches(EXPLAIN_DOC) ? 'explanation' : 'paper';
  });
}

/**
 * The selection as text. Typeset maths is written back as the TeX it was set
 * from — its rendered glyphs, and the MathML KaTeX keeps beside them, would
 * otherwise come out as a jumble of symbols, each twice.
 */
export function selectedText(selection: Selection): string {
  if (selection.isCollapsed || !selection.rangeCount) return '';
  const range = selection.getRangeAt(0);
  const root = range.commonAncestorContainer;
  const scope = root.nodeType === 1 ? (root as Element) : root.parentElement;
  const inMaths = scope?.closest<HTMLElement>('.chat-math[data-tex], .chat-math-block[data-tex]');
  if (inMaths) return tex(inMaths);
  if (!scope?.querySelector('.chat-math[data-set], .chat-math-block[data-set]')) return selection.toString().trim();
  const copy = document.createElement('div');
  copy.appendChild(range.cloneContents());
  for (const maths of Array.from(copy.querySelectorAll<HTMLElement>('.chat-math[data-tex], .chat-math-block[data-tex]'))) {
    maths.replaceWith(document.createTextNode(tex(maths)));
  }
  // The copy is not laid out, so its text is read without innerText's line breaks; blocks get one each.
  for (const block of Array.from(copy.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, pre, tr, div'))) block.append('\n');
  return (copy.textContent ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const tex = (maths: HTMLElement) => {
  const source = maths.dataset.tex ?? maths.textContent ?? '';
  return maths.classList.contains('chat-math-block') ? `$$${source}$$` : `$${source}$`;
};

export const currentSelection = () => lastSelection;
export const currentSelectionIn = () => lastSelectionIn;

/** Forget the selection — when the paper changes, it is no longer on screen. */
export function clearSelection() {
  lastSelection = '';
  lastSelectionIn = 'paper';
}

/**
 * The Explain page, when it is open: its layout, whether it hides the paper,
 * and the sections on screen as text — each under its title, with maths as TeX.
 */
export function explanationOnScreen(max = 6000): { layout: string; covers: boolean; visible: string } | null {
  const page = document.querySelector<HTMLElement>('.explain');
  const scroller = page?.querySelector<HTMLElement>('.explain-scroll');
  if (!page || !scroller) return null;
  const layout = Array.from(page.classList).find((name) => name.startsWith('layout-'))?.slice('layout-'.length) ?? '';
  const frame = scroller.getBoundingClientRect();
  const out: string[] = [];
  let length = 0;
  for (const section of Array.from(scroller.querySelectorAll<HTMLElement>('.explain-section'))) {
    const blocks: string[] = [];
    for (const el of Array.from(section.querySelectorAll<HTMLElement>('.explain-prose > *, .caveat-head, .caveat-body > *, .explain-figure figcaption, .cell-title'))) {
      const r = el.getBoundingClientRect();
      if (!r.height || r.bottom <= frame.top || r.top >= frame.bottom) continue;
      const text = readable(el);
      if (text) blocks.push(text);
    }
    if (!blocks.length) continue;
    const part = `${section.dataset.title ? `## ${section.dataset.title}\n` : ''}${blocks.join('\n\n')}`;
    out.push(part);
    length += part.length;
    if (length >= max) break;
  }
  return { layout: { margin: 'Margin', notebook: 'Notebook', beside: 'Beside the paper' }[layout] ?? layout, covers: layout !== 'beside', visible: out.join('\n\n') };
}

/** An element's text, with its typeset maths as the TeX it was set from. */
function readable(el: HTMLElement): string {
  if (!el.querySelector('.chat-math[data-tex], .chat-math-block[data-tex]') && !el.matches('.chat-math-block')) return text(el);
  const copy = el.cloneNode(true) as HTMLElement;
  const swap = (maths: HTMLElement) => maths.replaceWith(document.createTextNode(tex(maths)));
  if (copy.matches('.chat-math-block[data-tex]')) return tex(copy);
  copy.querySelectorAll<HTMLElement>('.chat-math[data-tex], .chat-math-block[data-tex]').forEach(swap);
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
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

/** Whether a page is on the screen — scrolled, the pages either side are drawn too, ahead of time. */
function onScreen(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
}

/** The page numbers in view when the PDF is drawn by the reader, as a book or scrolled; empty in the browser's viewer. */
export function pdfPagesInView(): number[] {
  return Array.from(document.querySelectorAll('.pdf-book-page'))
    .filter(onScreen)
    .map((el) => Number(el.getAttribute('aria-label')?.match(/\d+/)?.[0]))
    .filter((n) => n > 0);
}

/**
 * The pages in view as JPEG pictures, base64 without the data: prefix — what
 * Claude needs for figures, tables and equations the text cannot carry. Long
 * sides are held to about 1500 pixels, which is plenty to read a page.
 */
export function pdfPageImages(max = 2): { label: string; data: string }[] {
  const out: { label: string; data: string }[] = [];
  for (const el of Array.from(document.querySelectorAll('.pdf-book-page:not(.drawing)')).filter(onScreen).slice(0, max)) {
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
