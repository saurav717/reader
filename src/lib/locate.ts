/**
 * Finding a passage Claude quoted, in the page on screen.
 *
 * Claude copies the paper's words from the text the app extracted, but the
 * page it has to be found in differs in everything but the words: pdf.js
 * splits a line into spans with no space between them, a line break can
 * hyphenate a word, ligatures stand for two letters, quotes and dashes come
 * curly or straight. So both sides are compared as letters and digits only,
 * lower-cased, and every kept character remembers where it was in the page.
 *
 * A quote that is not there whole — Claude tidied a word, or it runs across
 * a figure — is found by its longest run of words that is.
 */
import { buildIndex, rangeFromOffsets } from './anchor';

const LIGATURES: Record<string, string> = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };
const KEEP = /[\p{L}\p{N}]/u;

/** Letters and digits only, lower-cased, with where each came from. */
export function squash(text: string): { text: string; at: number[] } {
  let out = '';
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const expanded = LIGATURES[char] ?? char;
    for (const piece of expanded.normalize('NFKD')) {
      if (!KEEP.test(piece)) continue;
      out += piece.toLowerCase();
      at.push(i);
    }
  }
  return { text: out, at };
}

const words = (quote: string) => quote.split(/\s+/).map((word) => squash(word).text).filter(Boolean);

/**
 * Where the quote is in `haystack` (already squashed): the whole of it, or else
 * its longest run of at least four words. `[start, end)` in squashed offsets,
 * with how many of the quote's words it covers.
 */
export function findSquashed(haystack: string, quote: string): { start: number; end: number; words: number; of: number } | null {
  const parts = words(quote).slice(0, 50);
  if (!parts.length) return null;
  const whole = parts.join('');
  const direct = haystack.indexOf(whole);
  if (direct >= 0) return { start: direct, end: direct + whole.length, words: parts.length, of: parts.length };
  const least = Math.min(4, parts.length);
  for (let size = parts.length - 1; size >= least; size--) {
    for (let from = 0; from + size <= parts.length; from++) {
      const run = parts.slice(from, from + size).join('');
      // A short run of short words is found everywhere; it has to say something.
      if (run.length < 16) continue;
      const at = haystack.indexOf(run);
      if (at >= 0) return { start: at, end: at + run.length, words: size, of: parts.length };
    }
  }
  return null;
}

/** The quote as a Range in `root`'s text, or null when it is not there. */
export function findPassage(root: HTMLElement, quote: string): Range | null {
  const index = buildIndex(root);
  const flat = squash(index.text);
  const hit = findSquashed(flat.text, quote);
  if (!hit) return null;
  return rangeFromOffsets(index, flat.at[hit.start], flat.at[hit.end - 1] + 1);
}

/** Which page (1-based) of a PDF's page texts holds the quote, preferring the page Claude named. */
export function pageOf(pages: string[], quote: string, hint?: number): number | null {
  let best: { page: number; words: number } | null = null;
  const order = hint && hint <= pages.length ? [hint - 1, ...pages.keys()] : [...pages.keys()];
  for (const index of order) {
    const hit = findSquashed(squash(pages[index]).text, quote);
    if (!hit) continue;
    if (hit.words === hit.of) return index + 1;
    if (!best || hit.words > best.words) best = { page: index + 1, words: hit.words };
  }
  return best?.page ?? null;
}

// ---------------------------------------------------------------------------
// Asking the reader to show one
// ---------------------------------------------------------------------------

export interface LocateRequest {
  quote: string;
  label: string;
  section?: string;
  page?: number;
  /** Its number in the answer's list. */
  n?: number;
  /** Where the words are: the paper (the default), or its Explain page. */
  source?: 'paper' | 'explanation';
}

/** Sent by the reader when a passage is marked (its quote) and when the mark goes (null). */
export const FLASH_EVENT = 'reader:passage-flash';

export interface LocateResult {
  found: boolean;
  /** The page it is on, in PDF mode. */
  page?: number;
  /** Shown by page only — the browser's own PDF viewer cannot be drawn on. */
  pageOnly?: boolean;
  /** Why it was not shown. */
  reason?: string;
}

export const LOCATE_EVENT = 'reader:locate';

/**
 * The Explain page, while it is open: it is asked first, and answers with
 * where it marked the passage, or null to leave the passage to the paper.
 */
type ExplainLocator = (request: LocateRequest) => Promise<LocateResult | null>;
let explainLocator: ExplainLocator | null = null;

/** Set by the Explain page while it is open; returns the function that takes it away again. */
export function setExplainLocator(locate: ExplainLocator): () => void {
  explainLocator = locate;
  return () => {
    if (explainLocator === locate) explainLocator = null;
  };
}

/** Asks the open paper — or its Explain page, when that is open — to scroll to the passage and mark it. Answers once it has, or could not. */
export async function showPassage(request: LocateRequest): Promise<LocateResult> {
  if (explainLocator) {
    const shown = await explainLocator(request);
    if (shown) return shown;
  }
  return new Promise((resolve) => {
    const event = new CustomEvent(LOCATE_EVENT, { detail: { ...request, reply: resolve }, cancelable: true });
    // Nobody took it: no paper is open.
    if (window.dispatchEvent(event)) resolve({ found: false, reason: 'Open the paper to see it.' });
  });
}
