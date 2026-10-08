// ===========================================================================
//  The paper's own figures, for the Explain page.
//
//  A drawing Claude makes is a sketch of an idea; the paper's own figure is
//  the thing itself — the architecture as the authors drew it, the plot the
//  result rests on. So when a page is written, the figures and tables of the
//  paper are read out of what the reader already has — the Reflow column
//  (the crops cut from the PDF, or the files arXiv's HTML links), or, in PDF
//  mode, the PDF itself, reflowed once for its figures — and kept, as JPEG,
//  with the paper. The model is given the list (and, when it can see, the
//  pictures themselves), and places one where it helps with
//
//    ```paper-figure ref="Figure 3" caption="What to look at in it"
//    ```
//
//  which the page draws from what was kept, so the page still shows them in
//  PDF mode, after a reload, or with the paper closed.
// ===========================================================================

import { db } from './db';

export interface PaperFigure {
  /** How the paper names it: "Figure 3", "Table 2". */
  ref: string;
  kind: 'figure' | 'table';
  /** Its caption as the paper writes it, held to a few hundred characters. */
  caption: string;
  /** The picture, as base64 JPEG. */
  data: string;
  width: number;
  height: number;
}

/** At most this many figures go with a page: enough for a paper's worth, not a thesis's. */
export const MAX_FIGURES = 16;
const KIND = /^(?:figure|fig\.?|table|tab\.?)$/i;

/**
 * A figure's name, reduced to a key both sides agree on: "Figure 3", "Fig. 3",
 * "figure:3" and "3" are all `figure:3`; "Table 2" and "Tab. 2" are `table:2`.
 */
export function figureKey(ref: string): string {
  const match = /^\s*(figure|fig\.?|table|tab\.?)?\s*[:\s]?\s*(\d+(?:\.\d+)?[a-z]?)\b/i.exec(ref.trim());
  if (!match) return '';
  const kind = match[1] && /^tab/i.test(match[1]) ? 'table' : 'figure';
  return `${kind}:${match[2].toLowerCase()}`;
}

/** The name a caption gives its figure — "Figure 3: The encoder…" is "Figure 3" — or null when it names none. */
export function refFromCaption(caption: string): { ref: string; kind: 'figure' | 'table' } | null {
  const match = /^\s*(figure|fig\.?|table|tab\.?)\s*(\d+(?:\.\d+)?[a-z]?)\b/i.exec(caption.replace(/\s+/g, ' '));
  if (!match || !KIND.test(match[1])) return null;
  const kind = /^tab/i.test(match[1]) ? 'table' : 'figure';
  return { ref: `${kind === 'table' ? 'Table' : 'Figure'} ${match[2]}`, kind };
}

/** The figure a page names, from those kept: exactly, else the whole of which it names a panel ("Figure 3b" → "Figure 3"). */
export function findFigure(figures: readonly PaperFigure[], ref: string): PaperFigure | undefined {
  const key = figureKey(ref);
  if (!key) return undefined;
  const exact = figures.find((figure) => figureKey(figure.ref) === key);
  if (exact) return exact;
  const whole = key.replace(/[a-z]$/, '');
  return figures.find((figure) => figureKey(figure.ref) === whole);
}

/** The list the model is given: one line a figure, its name and its caption. */
export function figureList(figures: readonly PaperFigure[]): string {
  return figures.map((figure) => `- ${figure.ref}: ${figure.caption.replace(/^\s*(figure|fig\.?|table|tab\.?)\s*[\w.]+\s*[:.]?\s*/i, '') || '(no caption)'}`).join('\n');
}

// ---------------------------------------------------------------------------
// Reading them out of the page: figureReader.ts, set by the view
// ---------------------------------------------------------------------------
//
// Reading needs the DOM and, in PDF mode, pdf.js; the view that shows the
// page sets the reader, so this module (and explain.ts, which uses it) stays
// loadable without either.

let readFigures: (() => Promise<PaperFigure[]>) | null = null;

/** Set once by the view: how the paper's figures are read from what is on screen. */
export function setFigureReader(reader: () => Promise<PaperFigure[]>) {
  readFigures = reader;
}

// ---------------------------------------------------------------------------
// Kept per paper, in this browser
// ---------------------------------------------------------------------------

const KEY = (paperId: string) => `explain-figures:${paperId}`;
const cache = new Map<string, PaperFigure[]>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export function subscribePaperFigures(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The figures kept for this paper, once they have been read in. */
export const paperFiguresFor = (paperId: string): PaperFigure[] | undefined => cache.get(paperId);

/** Reads in the figures kept for this paper, if any. */
export async function loadPaperFigures(paperId: string): Promise<PaperFigure[]> {
  const known = cache.get(paperId);
  if (known) return known;
  try {
    const kept = await db.getKv<PaperFigure[]>(KEY(paperId));
    if (kept?.length && !cache.has(paperId)) {
      cache.set(paperId, kept);
      notify();
    }
  } catch {
    // no IndexedDB: read them from the page instead
  }
  return cache.get(paperId) ?? [];
}

/**
 * The figures that go with a page about this paper. Writing it afresh reads
 * them from the screen again (the paper may have come with better ones since);
 * a revision takes the ones the page was written with, so it sees the same
 * figures and its request reads from the same cache. Never throws: a paper
 * whose figures cannot be read is explained without them.
 */
export async function gatherPaperFigures(paperId: string, { fresh = false }: { fresh?: boolean } = {}): Promise<PaperFigure[]> {
  const kept = await loadPaperFigures(paperId);
  if (kept.length && !fresh) return kept;
  let found: PaperFigure[] = [];
  try {
    found = readFigures ? await readFigures() : [];
  } catch {
    found = [];
  }
  if (!found.length) return kept;
  cache.set(paperId, found);
  notify();
  void db.setKv(KEY(paperId), found).catch(() => undefined);
  return found;
}
