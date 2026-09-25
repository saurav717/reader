// ===========================================================================
//  Notes: what you write about a paper, and what you keep from it — from the
//  paper itself (a passage, a figure, a table, an equation, a box snipped off
//  a PDF page) and from its Explain page (a passage, a whole section, a
//  diagram, a code cell and its output, a table, an equation, a caveat). One
//  list of pieces per paper, in the order you put them, kept in IndexedDB the
//  way the explanation is.
//
//  A kept piece is a copy of it as it was drawn: the maths typeset, the code
//  coloured, a diagram still a drawing, a figure's picture held in the note
//  itself. It is a copy on purpose. The explanation rewrites itself when asked
//  to, and the picture of a reflowed figure lasts only as long as the paper is
//  open; what you kept should not change or vanish under you.
// ===========================================================================

import { useEffect, useSyncExternalStore } from 'react';
import { db } from './db';
import { cleanClip } from './sanitize';

/** Where a kept piece came from, so it can be shown there again. */
export interface NoteSource {
  /** The paper — as reflowed text, its HTML rendering, or its PDF — or its Explain page. */
  from: 'paper' | 'explain';
  /** The section it was in. */
  section?: string;
  /** Words from it to find it by. */
  quote?: string;
  /** The PDF page it is on, where that is known. */
  page?: number;
}

export type NoteBlock =
  | { id: string; kind: 'text'; md: string; at: string }
  | {
      id: string;
      kind: 'clip';
      /** What it is: "Passage", "Diagram", "Code", "Table", "Equation", "Caveat · Superseded", "Section"… */
      label: string;
      /** The piece as it was drawn, cleaned. */
      html: string;
      /** The same as text — Markdown where it has any, TeX for maths — for export and search. */
      text: string;
      /** A line of your own under it. */
      note?: string;
      source: NoteSource;
      at: string;
    };

export type NoteClip = Extract<NoteBlock, { kind: 'clip' }>;

interface Kept {
  blocks: NoteBlock[];
}

const KEY = (paperId: string) => `notes:${paperId}`;
const EMPTY: NoteBlock[] = [];

const cache = new Map<string, NoteBlock[]>();
const loading = new Set<string>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

export function subscribeNotes(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function load(paperId: string) {
  if (cache.has(paperId) || loading.has(paperId)) return;
  loading.add(paperId);
  try {
    const kept = await db.getKv<Kept>(KEY(paperId));
    // Something added while this was being read is kept, after what was read.
    const added = cache.get(paperId) ?? [];
    cache.set(paperId, [...(kept?.blocks ?? []), ...added.filter((block) => !kept?.blocks.some((old) => old.id === block.id))]);
  } catch {
    if (!cache.has(paperId)) cache.set(paperId, []);
  } finally {
    loading.delete(paperId);
    changed();
  }
}

function put(paperId: string, blocks: NoteBlock[]) {
  cache.set(paperId, blocks);
  changed();
  void db.setKv(KEY(paperId), { blocks } satisfies Kept).catch(() => undefined);
}

/** A paper's notes, read from IndexedDB the first time they are asked for. */
export function useNotes(paperId: string): NoteBlock[] {
  useEffect(() => {
    if (paperId) void load(paperId);
  }, [paperId]);
  return useSyncExternalStore(subscribeNotes, () => (paperId ? cache.get(paperId) ?? EMPTY : EMPTY));
}

export const notesFor = (paperId: string) => cache.get(paperId) ?? EMPTY;

const newId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Asks for the notes to be opened, the way H opens them. */
export const OPEN_NOTES = 'reader:open-notes';
/** Asks for the Explain page to be opened, and for a place on it to be shown (a `NoteSource`). */
export const OPEN_EXPLAIN = 'reader:open-explain';
/** Asks for the Explain page to be closed, to show the paper under it. */
export const CLOSE_EXPLAIN = 'reader:close-explain';
export const SHOW_IN_EXPLAIN = 'reader:explain-show';

/** Sent when something is added, so the notes can show it: `{ paperId, id }`. */
export const NOTE_ADDED = 'reader:note-added';

function add(paperId: string, block: NoteBlock) {
  put(paperId, [...notesFor(paperId), block]);
  void load(paperId);
  window.dispatchEvent(new CustomEvent(NOTE_ADDED, { detail: { paperId, id: block.id } }));
  return block;
}

export function addText(paperId: string, md = ''): NoteBlock {
  return add(paperId, { id: newId(), kind: 'text', md, at: new Date().toISOString() });
}

export function addClip(paperId: string, clip: Omit<NoteClip, 'id' | 'kind' | 'at'>): NoteBlock {
  return add(paperId, { ...clip, id: newId(), kind: 'clip', at: new Date().toISOString() });
}

export function updateNote(paperId: string, id: string, patch: { md?: string; note?: string }) {
  put(
    paperId,
    notesFor(paperId).map((block) => (block.id !== id ? block : block.kind === 'text' ? { ...block, md: patch.md ?? block.md } : { ...block, note: patch.note ?? block.note })),
  );
}

export function removeNote(paperId: string, id: string) {
  put(
    paperId,
    notesFor(paperId).filter((block) => block.id !== id),
  );
}

/** One place up (-1) or down (+1) the list. */
export function moveNote(paperId: string, id: string, by: -1 | 1) {
  const blocks = [...notesFor(paperId)];
  const from = blocks.findIndex((block) => block.id === id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= blocks.length) return;
  [blocks[from], blocks[to]] = [blocks[to], blocks[from]];
  put(paperId, blocks);
}

// ---------------------------------------------------------------------------
// Taking a copy of what is on the page
// ---------------------------------------------------------------------------

/** What is taken out of a copy: the page's own controls, and what only means anything live. */
const CONTROLS = 'button, .caret, .revised-pill, .note-clip-btn, input, select, textarea';

/** The widest a kept picture is held at; a figure is rarely read wider than this. */
const PICTURE_WIDTH = 1600;

/**
 * A picture as a data URL, drawn from where it is now — the object URL of a
 * reflowed figure, which goes when the paper is closed, or a copy the proxy
 * served. Null when it cannot be read back, as a picture from another origin
 * sent without CORS cannot.
 */
export function pictureOf(src: string): Promise<string | null> {
  if (src.startsWith('data:')) return Promise.resolve(src);
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      try {
        const scale = Math.min(1, PICTURE_WIDTH / (image.naturalWidth || 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

/**
 * A copy of part of the page, safe to keep and draw again: its controls and
 * ids taken out, its pictures held in it rather than pointed at, and cleaned
 * again — a little more strictly than the page was, since a copy is kept for
 * good and drawn without the page around it: nothing that fetches, frames or
 * restyles. A diagram's SVG and KaTeX's maths come through as they are.
 */
export async function copyOf(source: Node | DocumentFragment): Promise<string> {
  const holder = document.createElement('div');
  holder.appendChild(source instanceof DocumentFragment ? source : source.cloneNode(true));
  for (const image of Array.from(holder.querySelectorAll('img'))) {
    image.removeAttribute('srcset');
    image.removeAttribute('loading');
    const kept = await pictureOf(image.currentSrc || image.src);
    // A picture that cannot be held is pointed at, and shows while its address does.
    if (kept) image.src = kept;
  }
  holder.querySelectorAll(CONTROLS).forEach((element) => element.remove());
  holder.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
  // Nothing in a copy may pass for a place on the page it came from.
  holder.querySelectorAll('[data-section], [data-title]').forEach((element) => {
    element.removeAttribute('data-section');
    element.removeAttribute('data-title');
  });
  return cleanClip(holder.innerHTML);
}

// ---------------------------------------------------------------------------
// As Markdown, for the export
// ---------------------------------------------------------------------------

/**
 * Code in a fence that the code cannot close: a run of backticks one longer
 * than the longest run inside it, and never fewer than three.
 */
function fenced(text: string): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

export function notesMarkdown(blocks: NoteBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'text') {
      if (block.md.trim()) lines.push(block.md.trim(), '');
      continue;
    }
    const where = ` — ${sourceName(block.source)}`;
    // The label is one line of bold; a newline in it would end the bold
    // early and start something else on the next line.
    lines.push(`**${block.label.replace(/\s*[\r\n]+\s*/g, ' ').trim()}**${where}`, '');
    const code = /^(Code|Output)/.test(block.label);
    lines.push(code ? fenced(block.text.trim()) : block.text.trim().replace(/^/gm, '> '), '');
    if (block.note?.trim()) lines.push(block.note.trim(), '');
  }
  return lines.join('\n');
}

/** Where a piece came from, in words: "Explain · Multi-head attention", "Paper · p. 3 · 4 Why self-attention". */
export function sourceName(source: NoteSource): string {
  return [source.from === 'explain' ? 'Explain' : 'Paper', source.page ? `p. ${source.page}` : '', source.section ?? ''].filter(Boolean).join(' · ');
}
