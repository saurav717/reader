// Where you stopped reading a paper: enough of the page to show on Home, so
// that a glance there says where you were before the paper is even open.
//
// It is read off the reader's own screen, the way `screen.ts` reads it for
// Ask AI. In PDF mode that is the page most in view, kept as a picture, with
// the band of it that was on screen; in Reflow, the paragraphs on screen and
// a few before them, as text with the highlights marked. It is kept in this
// browser only, for the few papers opened last — it is a view of the page,
// not a record of it, and the reader's own `progress` is still what puts you
// back in the paper.

import type { HighlightColor, ReadingMode } from '../types';

/** A run of a paragraph's text, highlighted or not. */
export interface SpotRun {
  text: string;
  color?: HighlightColor;
}

export interface SpotBlock {
  /** A heading is drawn as one. */
  heading?: boolean;
  runs: SpotRun[];
  /** Above the top of the screen when you left: read already. */
  read?: boolean;
}

export interface Spot {
  paperId: string;
  at: string;
  mode: ReadingMode;
  /** PDF: the page most in view, its number and how many there are. */
  page?: number;
  pages?: number;
  /** PDF: the page, as a JPEG data URL. */
  image?: string;
  /** PDF: the page's width over its height. */
  aspect?: number;
  /** PDF: the part of the page that was on screen, as fractions of its height. */
  top?: number;
  bottom?: number;
  /** Reflow: the paragraphs around where you were. */
  blocks?: SpotBlock[];
  /** The section you were in, when the page says. */
  section?: string;
}

const KEY = 'reader.spots';
/** Home shows the last paper, and the ones in progress beside it. */
const KEEP = 6;
/** Wide enough to read a page's text on Home without being a large picture. */
const IMAGE_WIDTH = 1000;
const BLOCKS_BEFORE = 3;
const BLOCKS_MAX = 14;
const RUN_MAX = 700;

const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, figcaption, blockquote, .ltx_para, .ltx_title';
const HEADINGS = 'h1, h2, h3, h4, h5, h6, .ltx_title';

function readAll(): Record<string, Spot> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, Spot>) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(spots: Record<string, Spot>): void {
  const kept = Object.values(spots)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, KEEP);
  const out = Object.fromEntries(kept.map((spot) => [spot.paperId, spot]));
  try {
    localStorage.setItem(KEY, JSON.stringify(out));
  } catch {
    // Out of room: the pictures are what takes it. Keep the newest one's, and
    // the rest as where they were without it.
    try {
      const lean = Object.fromEntries(kept.map((spot, index) => [spot.paperId, index === 0 ? spot : { ...spot, image: undefined }]));
      localStorage.setItem(KEY, JSON.stringify(lean));
    } catch {
      // Nothing to be done: Home shows the paper without its page.
    }
  }
  window.dispatchEvent(new CustomEvent(SPOT_EVENT));
}

/** Sent when a spot is kept, for a Home that is showing. */
export const SPOT_EVENT = 'reader:spot';

export function spotFor(paperId: string): Spot | null {
  return readAll()[paperId] ?? null;
}

function onScreen(rect: DOMRect, frame: DOMRect): boolean {
  return rect.height > 0 && rect.bottom > frame.top && rect.top < frame.bottom && rect.right > frame.left && rect.left < frame.right;
}

/** The box a PDF page is seen through: the scrolled pages, the spread, or the window. */
function pdfFrame(page: Element): DOMRect {
  const box = (page.closest('.pdf-scroll, .pdf-book-spread') ?? page.closest('.pdf-book'))?.getBoundingClientRect();
  const top = Math.max(box?.top ?? 0, 0);
  const bottom = Math.min(box?.bottom ?? window.innerHeight, window.innerHeight);
  const left = Math.max(box?.left ?? 0, 0);
  const right = Math.min(box?.right ?? window.innerWidth, window.innerWidth);
  return new DOMRect(left, top, right - left, bottom - top);
}

function pdfSpot(paperId: string): Spot | null {
  const drawn = Array.from(document.querySelectorAll('.pdf-book-page:not(.drawing)'));
  let best: { element: Element; seen: number; rect: DOMRect; frame: DOMRect } | null = null;
  for (const element of drawn) {
    const rect = element.getBoundingClientRect();
    const frame = pdfFrame(element);
    if (!onScreen(rect, frame)) continue;
    const seen = Math.min(rect.bottom, frame.bottom) - Math.max(rect.top, frame.top);
    // The page most on screen; on a tie — a spread — the first of them.
    if (!best || seen > best.seen + 1) best = { element, seen, rect, frame };
  }
  if (!best) return null;
  const canvas = best.element.querySelector('canvas');
  const page = Number(best.element.getAttribute('aria-label')?.match(/\d+/)?.[0]) || undefined;
  // Scrolled, only the pages near the view are drawn: the count is the book's.
  const pages = Number(best.element.closest<HTMLElement>('.pdf-book')?.dataset.pages) || undefined;
  const { rect, frame } = best;
  const top = Math.max(0, Math.min(1, (frame.top - rect.top) / rect.height));
  const bottom = Math.max(top, Math.min(1, (frame.bottom - rect.top) / rect.height));
  let image: string | undefined;
  let aspect: number | undefined;
  if (canvas && canvas.width && canvas.height) {
    try {
      const scale = Math.min(1, IMAGE_WIDTH / canvas.width);
      const copy = document.createElement('canvas');
      copy.width = Math.round(canvas.width * scale);
      copy.height = Math.round(canvas.height * scale);
      const context = copy.getContext('2d');
      if (context) {
        context.fillStyle = '#fff';
        context.fillRect(0, 0, copy.width, copy.height);
        context.drawImage(canvas, 0, 0, copy.width, copy.height);
        image = copy.toDataURL('image/jpeg', 0.72);
        aspect = canvas.width / canvas.height;
      }
    } catch {
      // A canvas that cannot be read leaves the page out, not where you were.
    }
  }
  return { paperId, at: new Date().toISOString(), mode: 'pdf', page, pages, image, aspect, top, bottom };
}

/** A paragraph as runs of text, the highlighted ones marked with their colour. */
function runsOf(element: Element): SpotRun[] {
  const runs: SpotRun[] = [];
  let length = 0;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && length < RUN_MAX; node = walker.nextNode()) {
    let text = (node.textContent ?? '').replace(/\s+/g, ' ');
    if (!text.trim() && !runs.length) continue;
    text = text.slice(0, RUN_MAX - length);
    length += text.length;
    const mark = node.parentElement?.closest('mark.hl');
    const color = mark && element.contains(mark) ? (Array.from(mark.classList).find((name) => /^hl-(yellow|green|blue|pink)$/.test(name))?.slice(3) as HighlightColor | undefined) : undefined;
    const last = runs[runs.length - 1];
    if (last && last.color === color) last.text += text;
    else runs.push(color ? { text, color } : { text });
  }
  if (runs.length) {
    runs[0].text = runs[0].text.trimStart();
    const end = runs[runs.length - 1];
    end.text = length >= RUN_MAX ? `${end.text.trimEnd()}…` : end.text.trimEnd();
  }
  return runs.filter((run) => run.text);
}

function reflowSpot(paperId: string): Spot | null {
  const body = document.querySelector('.paper-body');
  if (!body) return null;
  const box = (body.closest('.reader-scroll, .book-pages') ?? body).getBoundingClientRect();
  const frame = new DOMRect(box.left, Math.max(box.top, 0), box.width, Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0));
  const all: Element[] = [];
  for (const element of Array.from(body.querySelectorAll(BLOCKS))) {
    // A list item's paragraph is already in the list item.
    if (all.length && all[all.length - 1].contains(element)) continue;
    all.push(element);
  }
  // The first paragraph on screen; in a book, the first on the spread.
  const first = all.findIndex((element) => onScreen(element.getBoundingClientRect(), frame));
  if (first < 0) return null;
  const blocks: SpotBlock[] = [];
  let section: string | undefined;
  for (let index = first; index >= 0 && !section; index--) {
    if (all[index].matches(HEADINGS)) section = (all[index].textContent ?? '').replace(/\s+/g, ' ').trim() || undefined;
  }
  for (let index = Math.max(0, first - BLOCKS_BEFORE); index < all.length && blocks.length < BLOCKS_MAX; index++) {
    const element = all[index];
    const rect = element.getBoundingClientRect();
    if (index >= first && rect.top >= frame.bottom) break;
    const runs = runsOf(element);
    if (!runs.length) continue;
    blocks.push({ heading: element.matches(HEADINGS) || undefined, runs, read: index < first || undefined });
  }
  return { paperId, at: new Date().toISOString(), mode: 'reflow', blocks, section };
}

/**
 * Keep where the paper is on screen now. Nothing is kept when the page is not
 * drawn yet — a paper still opening has not been left anywhere.
 */
export function keepSpot(paperId: string, mode: ReadingMode): boolean {
  if (typeof document === 'undefined') return false;
  // Moving from one paper to the next, the screen may already be the next one's.
  const showing = document.querySelector<HTMLElement>('.main[data-paper-id]')?.dataset.paperId;
  if (showing !== paperId) return false;
  const spot = mode === 'pdf' ? pdfSpot(paperId) : reflowSpot(paperId);
  if (!spot) return false;
  const spots = readAll();
  // A PDF page not drawn this time keeps the picture it had, if it is the same page.
  const before = spots[paperId];
  if (spot.mode === 'pdf' && !spot.image && before?.mode === 'pdf' && before.page === spot.page) {
    spot.image = before.image;
    spot.aspect = before.aspect;
  }
  spots[paperId] = spot;
  writeAll(spots);
  return true;
}

/** Keep where a paper is on screen now, whichever way it is being read. */
export function keepSpotNow(paperId: string): void {
  if (!keepSpot(paperId, 'pdf')) keepSpot(paperId, 'reflow');
}
