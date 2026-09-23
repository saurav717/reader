// Reading the reader's own screen, for the Ask Claude window: the passage in
// view, the text last selected in the paper, and the paper's whole text. All
// of it comes from the DOM the reader already rendered — the Reflow column or
// the book — so what Claude reads is what you are looking at, highlights and
// all. In PDF mode the browser's own viewer draws the page and none of this is
// reachable; the window then has the paper's details and abstract to go on.

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
    if (!element?.closest(BODY)) return;
    lastSelection = selection && !selection.isCollapsed ? selection.toString().trim() : '';
  });
}

export const currentSelection = () => lastSelection;

/** Forget the selection — when the paper changes, it is no longer on screen. */
export function clearSelection() {
  lastSelection = '';
}
