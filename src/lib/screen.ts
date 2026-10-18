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

/** The PDF shown in PDF mode, for reading its figures out of it (paperFigures.ts). */
export const pdfShown = (): Blob | null => pdfOnScreen;

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

// ---------------------------------------------------------------------------
// Figures in Reflow mode, and on the Explain page
// ---------------------------------------------------------------------------
//
// Reflow mode has the paper's figures and tables as pictures in the column —
// the crops the reader cut from the PDF, or the files an HTML rendering
// links — and the Explain page keeps its own. The ones on screen go with a
// question the way a PDF page does, each named by its caption, so the model
// sees the figure the reader is looking at rather than a note that figures
// are missing.

/** The longest side of a figure as it is sent. */
const FIGURE_PIXELS = 1200;
const CAPTION_MAX = 240;

/** A figure's caption: the figcaption it sits in, else its alt text. */
function captionOf(image: HTMLImageElement): string {
  const figure = image.closest('figure');
  const caption = figure?.querySelector('figcaption');
  const words = (caption ? text(caption) : image.alt || '').replace(/\s+/g, ' ').trim();
  return words.length > CAPTION_MAX ? `${words.slice(0, CAPTION_MAX)}…` : words;
}

/** The images inside `root` that are on screen inside `frame`, largest first, that have loaded and are big enough to be a figure. */
function imagesInView(root: Element, frame: DOMRect): HTMLImageElement[] {
  const top = Math.max(frame.top, 0);
  const bottom = Math.min(frame.bottom, window.innerHeight);
  return Array.from(root.querySelectorAll<HTMLImageElement>('img'))
    .filter((image) => image.complete && image.naturalWidth >= 40 && image.naturalHeight >= 40)
    .filter((image) => {
      const r = image.getBoundingClientRect();
      return r.height > 0 && r.bottom > top && r.top < bottom;
    });
}

/**
 * A loaded image as base64 JPEG, held to FIGURE_PIXELS on its long side. An
 * image from another origin taints a canvas, so it is fetched instead — the
 * paper proxy answers with CORS headers — and drawn from the bytes.
 */
async function imageJpeg(image: HTMLImageElement): Promise<string> {
  const scale = Math.min(1, FIGURE_PIXELS / Math.max(image.naturalWidth, image.naturalHeight));
  const copy = document.createElement('canvas');
  copy.width = Math.round(image.naturalWidth * scale);
  copy.height = Math.round(image.naturalHeight * scale);
  try {
    return jpeg(image, copy);
  } catch {
    const response = await fetch(image.currentSrc || image.src, { mode: 'cors' });
    if (!response.ok) return '';
    const bitmap = await createImageBitmap(await response.blob());
    try {
      return jpeg(bitmap, copy);
    } finally {
      bitmap.close();
    }
  }
}

/**
 * The figures and tables on screen in Reflow mode, and on the Explain page
 * when it is open, as JPEG pictures with their captions — at most `max`.
 */
export async function figureImages({ paper = true, max = 4 }: { paper?: boolean; max?: number } = {}): Promise<{ label: string; data: string }[]> {
  const out: { label: string; data: string }[] = [];
  const body = document.querySelector(BODY);
  const explain = document.querySelector('.explain-scroll');
  const places: { root: Element | null; frame: Element | null; where: string }[] = [
    { root: paper ? body : null, frame: body?.closest('.reader-scroll, .book-pages') ?? body, where: 'of the paper' },
    { root: explain, frame: explain, where: 'on the Explain page' },
  ];
  for (const place of places) {
    if (!place.root || !place.frame) continue;
    for (const image of imagesInView(place.root, place.frame.getBoundingClientRect())) {
      if (out.length >= max) return out;
      try {
        const data = await imageJpeg(image);
        if (!data) continue;
        const caption = captionOf(image);
        out.push({ label: `A figure ${place.where}, on screen now${caption ? ` — its caption: ${caption}` : ''}:`, data });
      } catch {
        // a picture that cannot be read is left out; the text still goes
      }
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

// ---------------------------------------------------------------------------
// The rest of the page
// ---------------------------------------------------------------------------
//
// Everything above reads the paper and its pages. The rest of the window —
// Home, the Library, a project's overview or workspace, the Playground, the
// Calendar, Settings, Discover, the Notes dock, a dialog — is read here, as a
// person would read it: what is on screen, top to bottom, headings marked,
// buttons and tabs named as the controls they are, a field with what is in
// it. That is what lets the window say "click Workspace at the top" rather
// than guess at a page it cannot see. The chat window itself is left out, and
// so is whatever the callers already send another way (the paper's column,
// the Explain page). Password fields, and anything shaped like a key, never go.

const PAGE_MAX_CHARS = 16_000;
const FIELD_MAX_CHARS = 300;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED', 'svg']);
const CONTROLS = 'button, [role="button"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="switch"], [role="option"], summary';
const KEYISH = /\b(sk-[\w-]{12,}|sk-ant-[\w-]+|AIza[\w-]{20,}|gh[pousr]_\w{20,}|github_pat_\w+|xox[abp]-[\w-]+|ya29\.[\w-]+)\b/g;
const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'TR', 'TABLE', 'UL', 'OL', 'DL', 'DT', 'DD', 'FORM', 'FIELDSET', 'FIGURE', 'FIGCAPTION', 'BLOCKQUOTE', 'PRE', 'DETAILS', 'DIALOG', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BR', 'HR', 'LABEL']);

const squash = (value: string) => value.replace(/\s+/g, ' ').trim();
const unkeyed = (value: string) => value.replace(KEYISH, '[a key, withheld]');

function inView(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
}

function shown(el: Element): boolean {
  if (el.getAttribute('aria-hidden') === 'true' || (el as HTMLElement).hidden) return false;
  const check = (el as HTMLElement).checkVisibility;
  if (typeof check === 'function') return check.call(el, { checkOpacity: true, checkVisibilityCSS: true });
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

/** What a control says it does: its label, else its text, else its tooltip. */
function controlName(el: Element): string {
  const named = el.getAttribute('aria-label') || squash((el as HTMLElement).innerText ?? el.textContent ?? '') || el.getAttribute('title') || '';
  return squash(named).slice(0, 120);
}

function controlState(el: Element): string {
  const states: string[] = [];
  if (el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true') states.push('on');
  if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') states.push('current');
  if (el.getAttribute('aria-expanded') === 'true') states.push('open');
  if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') states.push('disabled');
  return states.length ? ` (${states.join(', ')})` : '';
}

/** The words of a label that wraps its field: what comes before the field, not the hint after it. */
function labelBefore(label: HTMLLabelElement, field: Element): string {
  let text = '';
  for (const node of Array.from(label.childNodes)) {
    if (node === field || (node.nodeType === Node.ELEMENT_NODE && (node as Element).contains(field))) break;
    text += node.textContent ?? '';
  }
  return squash(text) || squash(label.textContent ?? '');
}

/** A field's label: its <label>, its aria-label, its placeholder or its name. */
function fieldLabel(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
  const wrapping = el.closest('label');
  const from = el.getAttribute('aria-label') || (byFor && squash(byFor.textContent ?? '')) || (wrapping && labelBefore(wrapping, el)) || el.getAttribute('placeholder') || el.getAttribute('title') || el.name || '';
  return squash(from).slice(0, 100);
}

function fieldLine(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  const label = fieldLabel(el);
  if (el instanceof HTMLSelectElement) {
    const chosen = el.selectedOptions[0]?.textContent ?? '';
    return `[menu${label ? ` “${label}”` : ''}: ${squash(chosen)}]`;
  }
  const type = (el.getAttribute('type') || (el instanceof HTMLTextAreaElement ? 'textarea' : 'text')).toLowerCase();
  if (type === 'hidden' || type === 'file') return '';
  if (type === 'checkbox' || type === 'radio') return `[${type === 'radio' ? 'choice' : 'tick box'}${label ? ` “${label}”` : ''}: ${(el as HTMLInputElement).checked ? 'on' : 'off'}]`;
  if (type === 'range') return `[slider${label ? ` “${label}”` : ''}: ${el.value}]`;
  if (type === 'button' || type === 'submit' || type === 'reset') return `[${squash(el.value) || label || type}]`;
  // A password, or a field named for a key, is never read out — by its type, its name, or what it is labelled.
  const secret = type === 'password' || /key|token|secret|password|passcode/i.test(`${el.name} ${el.id} ${el.getAttribute('autocomplete') ?? ''} ${label}`);
  const value = secret ? (el.value ? '(filled in, withheld)' : '(empty)') : el.value ? `“${unkeyed(el.value).slice(0, FIELD_MAX_CHARS)}”` : '(empty)';
  return `[field${label ? ` “${label}”` : ''}: ${value}]`;
}

/**
 * The page on screen, as text, in reading order: what the reader can see
 * right now outside the chat window and outside `skip`. Headings start with #,
 * a control is in [brackets] with its state, a field shows what it holds.
 */
export function pageOnScreen(skip: string[] = [], max = PAGE_MAX_CHARS): string {
  if (typeof document === 'undefined') return '';
  const skipping = ['.assistant-win', ...skip].join(', ');
  const lines: string[] = [];
  let line = '';
  let length = 0;
  const flush = () => {
    const text = squash(line);
    line = '';
    if (!text || text === lines[lines.length - 1]) return;
    lines.push(text);
    length += text.length + 1;
  };
  // A control or a field stands apart from the words round it. Text is appended
  // as it is when it runs on from the text before it — "paper" and "s" set as two
  // nodes of one span still read as "papers" — and after a space when it starts a
  // new box, as a flex item or a block does, so two labels side by side keep apart.
  const say = (text: string, own = false) => {
    if (own) flush();
    line += ` ${text} `;
    if (own) flush();
  };
  let lastParent: Element | null = null;
  const inline = (el: Element | null) => Boolean(el) && getComputedStyle(el!).display.startsWith('inline');
  const word = (node: Node) => {
    const parent = node.parentElement;
    const runsOn = parent === lastParent || (inline(parent) && inline(lastParent));
    line += `${runsOn ? '' : ' '}${unkeyed(node.textContent ?? '')}`;
    lastParent = parent;
  };

  const visit = (el: Element) => {
    if (length >= max) return;
    if (SKIP_TAGS.has(el.tagName) || el.matches(skipping) || !shown(el)) return;
    const html = el as HTMLElement;
    // Fields and controls are read whole, as one thing each.
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      if (inView(el.getBoundingClientRect())) say(fieldLine(el));
      return;
    }
    if (el.matches(CONTROLS)) {
      if (inView(el.getBoundingClientRect())) {
        const name = controlName(el);
        if (name) say(`[${name}]${controlState(el)}`);
      }
      return;
    }
    if (el.tagName === 'IMG') {
      const alt = squash(el.getAttribute('alt') ?? '');
      if (alt && inView(el.getBoundingClientRect())) say(`[picture: ${alt.slice(0, 160)}]`);
      return;
    }
    const heading = /^H([1-6])$/.exec(el.tagName) ?? (el.getAttribute('role') === 'heading' ? [, el.getAttribute('aria-level') || '2'] : null);
    if (heading) {
      if (inView(el.getBoundingClientRect())) say(`${'#'.repeat(Number(heading[1]))} ${squash(html.innerText ?? el.textContent ?? '')}`, true);
      return;
    }
    const block = BLOCK_TAGS.has(el.tagName);
    if (block) {
      flush();
      lastParent = null;
    }
    if (el.tagName === 'DIALOG' || el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true') {
      const name = el.getAttribute('aria-label');
      say(`— a window${name ? `: ${squash(name)}` : ''} —`, true);
    }
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? '';
        if (!text.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        if (Array.from(range.getClientRects()).some(inView)) word(node);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        visit(node as Element);
      }
    }
    if (block) flush();
  };

  visit(document.body);
  flush();
  const text = lines.join('\n');
  return text.length > max ? `${text.slice(0, max)}\n[…cut at ${max.toLocaleString('en')} characters]` : text;
}
