// ===========================================================================
//  The ask bar of the Colab tab: a request about the notebook, answered by
//  the model the pages are written with, as cells.
//
//  The bar on the Explanation and Implementation pages edits those pages'
//  sections; this one edits the notebook — writes a cell, rewrites one,
//  fixes the one that failed — from the paper, the explanation, the plan
//  and the notebook as it stands, outputs and tracebacks included. The
//  model answers with a line or two and fenced cells that say where they
//  go; the reply is parsed here and applied to the notebook in one move,
//  which one Undo puts back. Every new or rewritten cell is marked as the
//  model's until it is edited or run, and nothing runs on its own.
// ===========================================================================

import type { SDK } from './assistant';
import { explainError, modelSpec, PROVIDERS, sdk, streamModel, tag } from './assistant';
import type { Screen, SystemBlock } from './assistant';
import type { CellRun } from './colab';
import { db } from './db';
import type { CellType, NbCell, NbEdit } from './notebook';
import { applyEdits, newCell, notebookFor, replaceCells, restoreCells, runKey } from './notebook';

const MAX_TOKENS = 16000;
/** How much of the explanation and of the plan go with a request; the paper's own text goes in full, cached. */
const PAGE_MAX_CHARS = 40_000;
const OUTPUT_MAX_CHARS = 2_500;
const REPLIES_KEPT = 8;

export const NOTEBOOK_SYSTEM = `You are writing cells for a Jupyter notebook inside a research-paper reader. The notebook
runs on the reader's own Google Colab runtime — a Python 3 kernel, usually with a GPU — and holds the code the
reader is using to try out ONE paper. The paper's details and text are given below; the reader's explanation of
it, their implementation plan (when they have one), and the notebook as it stands come with each request.

The reader asks for code: a cell that does something specific from the paper, a change to a cell, a rewrite, a
fix for a cell that failed. Answer with the cells, and no more prose than a line or two.

FORMAT — the notebook applies your answer, so keep to it exactly:
- A new cell: a fenced block whose info string says where it goes —
  \`\`\`python after=3          (a code cell after cell 3)
  \`\`\`markdown after=3        (a text cell after cell 3)
  \`\`\`python after=end        (at the end)
  Several new cells go one after another, each with its own fence and its own after=.
  Two cells after the same one keep their order.
- Change a cell: a fenced block naming it — \`\`\`python cell=3 — holding the WHOLE new cell, not a diff.
  A text cell is \`\`\`markdown cell=3. Keep the number of cells you were asked about; change nothing else.
- Cells are numbered as the notebook lists them, from 1. Refer to them by those numbers.
- Outside the fences, at most a sentence or two: what the cells do, or what was wrong. No headings, no lists,
  no other fenced blocks.
- Each code cell should be self-contained or rely only on cells above it, deterministic where it can be
  (seed it), and print or show something that proves what it did. Prefer PyTorch on the GPU when the paper
  calls for it; check torch.cuda.is_available() and fall back to the CPU with a smaller size rather than fail.
- Nothing that mounts Drive, asks for input, or needs credentials. Keep a cell under about 80 lines; split
  longer work across cells. Never delete cells; say so if a cell should go, and the reader will.

If the request is a question rather than a request for code, answer it in the prose and add no cells.`;

/** Rewrite, from the bar's menu: the whole notebook again, by the model picked. */
export const REWRITE_REQUEST = `Write this notebook again from scratch, for this paper: the code a reader runs to try its central idea —
the method as a small, faithful, runnable implementation, then an experiment small enough for this runtime that shows
the paper's claim, with a short text cell before each step saying what it is and why. Keep what the current cells set
out to do where it is sound, and do better where it is not. Every cell of yours is a new cell with after=end, in order,
text cells as markdown and code cells as python; the current cells will all be replaced by yours.`;

// ------------------------------------------------------------ the reply ---

export interface NotebookReply {
  /** The prose outside the fences, for the line under the bar. */
  note: string;
  edits: NbEdit[];
}

const FENCE = /^```[ \t]*([A-Za-z0-9_+-]*)([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm;

const asType = (lang: string): CellType | null => {
  const l = lang.toLowerCase();
  if (l === 'python' || l === 'py' || l === 'python3' || l === '') return 'code';
  if (l === 'markdown' || l === 'md' || l === 'text') return 'markdown';
  return null;
};

const where = (info: string): { cell?: number; after?: number | 'end' } => {
  const cell = /\bcell\s*=\s*"?(\d+)"?/i.exec(info);
  if (cell) return { cell: Number(cell[1]) };
  const after = /\b(?:after|below)\s*=\s*"?(\d+|end)"?/i.exec(info);
  if (after) return { after: after[1].toLowerCase() === 'end' ? 'end' : Number(after[1]) };
  if (/\b(?:at|position)\s*=\s*"?end"?/i.test(info)) return { after: 'end' };
  return {};
};

/**
 * The model's answer as edits: every fenced cell with where it goes, and the
 * prose around them as the note. A fence with no place named is a new cell
 * whose place is decided as it is applied (after the cell the request was
 * about, else at the end). Fences in other languages are left out.
 */
export function parseNotebookReply(text: string): NotebookReply {
  const edits: NbEdit[] = [];
  const prose = text.replace(FENCE, (_match, lang: string, info: string, body: string) => {
    const type = asType(lang);
    if (type === null) return '';
    const source = body.replace(/\n$/, '');
    const at = where(info);
    if (at.cell !== undefined) edits.push({ kind: 'replace', cell: at.cell, type, source });
    else edits.push({ kind: 'insert', after: at.after ?? null, type, source });
    return '';
  });
  const note = prose
    .replace(/^#+\s*/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, 600);
  return { note, edits };
}

// ------------------------------------------------------------ the context --

const clip = (text: string | undefined, max: number) => (!text ? '' : text.length > max ? `${text.slice(0, max)}\n[…cut at ${max.toLocaleString('en')} characters]` : text);

/** What a cell printed, as text: the run in the Colab store while there is one, else what the notebook kept. */
export const outputText = (cell: NbCell, run: CellRun | undefined): string => {
  const outputs = run && run.state !== 'running' && run.state !== 'queued' ? run.outputs : cell.outputs;
  return outputs
    .map((output) => (output.type === 'stream' ? output.text : output.type === 'text' ? output.text : output.type === 'error' ? output.traceback || `${output.ename}: ${output.evalue}` : `[${output.mime} image]`))
    .join('')
    .trim();
};

/** The notebook as the model reads it: every cell numbered, with what it last printed, and how its last run ended. */
export function cellsBlock(cells: NbCell[], runs: Record<string, CellRun> = {}): string {
  return cells
    .map((cell, index) => {
      const run = runs[runKey(cell.id)];
      const state = run ? (run.state === 'ran' ? 'ran' : run.state === 'failed' ? 'FAILED' : run.state) : cell.count !== null ? 'ran earlier' : 'not run';
      const head = `### Cell ${index + 1} (${cell.type === 'code' ? 'code' : 'text'}${cell.type === 'code' ? `, ${state}` : ''})`;
      const body = cell.type === 'code' ? `\`\`\`python\n${cell.source}\n\`\`\`` : cell.source;
      const printed = cell.type === 'code' ? outputText(cell, run) : '';
      return [head, body, printed ? `Output:\n\`\`\`\n${clip(printed, OUTPUT_MAX_CHARS)}\n\`\`\`` : ''].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

/** The system prompt, the same for every request on a paper, so the paper's text is read from the cache. */
function systemFor(screen: Screen): SystemBlock[] {
  const paper = screen.paper;
  const details = paper
    ? [`Title: ${paper.title}`, paper.authors.length ? `Authors: ${paper.authors.join(', ')}` : '', paper.published ? `Published: ${paper.published}` : '', paper.arxivId ? `arXiv: ${paper.arxivId}` : ''].filter(Boolean).join('\n')
    : '';
  const text = screen.fullText?.trim() ?? '';
  return [
    { type: 'text', text: NOTEBOOK_SYSTEM },
    { type: 'text', text: [tag('paper', details), tag('abstract', paper?.abstract), tag('paper_text', text.slice(0, 200_000))].filter(Boolean).join('\n\n') || 'No paper is open.', cache_control: { type: 'ephemeral' } },
  ];
}

export interface AskScope {
  /** The cell the request is about, numbered from 1. */
  cell?: number;
  /** A passage — an output, a traceback, a bit of code — the request is about. */
  quote?: string;
}

export function requestText(request: string, scope: AskScope, cells: NbCell[], runs: Record<string, CellRun>, pages: { explanation?: string; plan?: string }): string {
  const about = scope.cell ? `The request is about cell ${scope.cell}. A new cell with no place named goes right after it; a change is to it.` : 'A new cell with no place named goes at the end.';
  return [
    tag('explanation', clip(pages.explanation, PAGE_MAX_CHARS)),
    tag('implementation_plan', clip(pages.plan, PAGE_MAX_CHARS)),
    tag('notebook', cells.length ? cellsBlock(cells, runs) : 'The notebook is empty.'),
    tag('about', scope.quote ? clip(scope.quote, 4000) : ''),
    `${about}\n\nRequest: ${request.trim()}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ------------------------------------------------------------- the store ---

export interface NbPending {
  request: string;
  reply: string;
  thinking?: string;
  started: number;
  error?: string;
}

export interface NbReplyRecord {
  request: string;
  note: string;
  /** The cells as they were, for Undo. */
  before: NbCell[];
  /** The ids of the cells written or changed, in notebook order. */
  touched: string[];
  at: number;
}

export interface NbAsk {
  pending?: NbPending;
  /** The last reply applied, until it is undone or the next one lands. */
  last?: NbReplyRecord;
  /** Every request answered on this notebook, for the suggestions. */
  requests: string[];
  /** The model the last reply was asked of, and the next is unless another is picked. */
  model?: string;
}

const KEY = (paperId: string) => `notebook-ask:${paperId}`;
const state = new Map<string, NbAsk>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
let running: { paperId: string; abort: () => void } | null = null;

export function subscribeNotebookAsk(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const EMPTY: NbAsk = { requests: [] };
export const notebookAskFor = (paperId: string): NbAsk => state.get(paperId) ?? EMPTY;
export const isAskingNotebook = (paperId: string) => running?.paperId === paperId;

const update = (paperId: string, patch: Partial<NbAsk>) => {
  const next = { ...notebookAskFor(paperId), ...patch };
  state.set(paperId, next);
  notify();
  return next;
};

/** The last reply and the requests, kept in the browser with the notebook, so Undo survives a reload. */
function persist(paperId: string) {
  const { pending: _pending, ...kept } = notebookAskFor(paperId);
  void db.setKv(KEY(paperId), kept).catch(() => undefined);
}

export async function loadNotebookAsk(paperId: string) {
  if (state.has(paperId)) return;
  try {
    const kept = await db.getKv<NbAsk>(KEY(paperId));
    if (kept && !state.has(paperId)) update(paperId, { ...kept, pending: undefined, requests: kept.requests ?? [] });
  } catch {
    // no IndexedDB
  }
}

/**
 * One request on the notebook: streamed from the model, parsed, applied. The
 * reply is shown as it streams only as the note under the bar; the cells
 * change when the whole answer is in, so nothing half-written is ever a cell.
 */
export async function askNotebook(params: { paperId: string; screen: Screen; model: string; request: string; scope?: AskScope; runs?: Record<string, CellRun>; pages?: { explanation?: string; plan?: string }; mode?: 'ask' | 'rewrite' }): Promise<void> {
  const { paperId, screen, model, scope = {}, runs = {}, pages = {}, mode = 'ask' } = params;
  const request = params.request.trim();
  const nb = notebookFor(paperId);
  if (!request || !nb || running) return;
  const pending: NbPending = { request, reply: '', started: Date.now() };
  update(paperId, { pending: { ...pending }, model });
  let SDK: SDK | null = null;
  try {
    if (modelSpec(model).provider === 'anthropic') SDK = await sdk();
    const stream = await streamModel({
      model,
      maxTokens: MAX_TOKENS,
      system: systemFor(screen),
      messages: [{ role: 'user', content: mode === 'rewrite' ? requestText(REWRITE_REQUEST, {}, nb.cells, runs, pages) : requestText(request, scope, nb.cells, runs, pages) }],
      effort: 'medium',
    });
    running = { paperId, abort: () => stream.abort() };
    let frame = 0;
    const paint = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update(paperId, { pending: { ...pending } });
      });
    };
    stream.on('thinking', (delta: string) => {
      pending.thinking = `${pending.thinking ?? ''}${delta}`;
      paint();
    });
    stream.on('text', (delta: string) => {
      pending.reply += delta;
      pending.thinking = undefined;
      paint();
    });
    const final = await stream.finalMessage();
    if (frame) cancelAnimationFrame(frame);
    if (final.stop_reason === 'refusal') throw new Error(`${PROVIDERS[modelSpec(model).provider].name} declined that request.`);
    const parsed = parseNotebookReply(pending.reply);
    const scopeIndex = scope.cell ? scope.cell - 1 : null;
    const applied =
      mode === 'rewrite'
        ? parsed.edits.length
          ? replaceCells(paperId, parsed.edits.map((edit) => newCell(edit.type, edit.source)))
          : null
        : parsed.edits.length
          ? applyEdits(paperId, parsed.edits, scopeIndex)
          : null;
    const note = parsed.note || (applied ? `${applied.touched.length} ${applied.touched.length === 1 ? 'cell' : 'cells'} written` : '');
    if (!applied && !note) throw new Error(`${PROVIDERS[modelSpec(model).provider].name} sent nothing the notebook could take.`);
    const now = notebookAskFor(paperId);
    update(paperId, {
      pending: undefined,
      last: applied ? { request, note: final.stop_reason === 'max_tokens' ? `${note} (the answer was cut short)` : note, before: applied.before, touched: applied.touched, at: Date.now() } : { request, note, before: nb.cells, touched: [], at: Date.now() },
      requests: [...now.requests, request].slice(-REPLIES_KEPT),
    });
    persist(paperId);
  } catch (error) {
    const message = explainError(error, SDK);
    update(paperId, { pending: message === 'Stopped.' ? undefined : { ...pending, error: message } });
  } finally {
    running = null;
  }
}

/** The whole notebook written again by `model` — Rewrite, from the bar's menu, on the Colab tab. */
export const rewriteNotebook = (params: { paperId: string; screen: Screen; model: string; runs?: Record<string, CellRun>; pages?: { explanation?: string; plan?: string } }) =>
  askNotebook({ ...params, request: 'Rewrite the notebook', mode: 'rewrite' });

export function stopNotebookAsk() {
  running?.abort();
}

/** Puts the cells back as they were before the last reply. */
export function undoNotebookReply(paperId: string) {
  const last = notebookAskFor(paperId).last;
  if (!last || running) return;
  restoreCells(paperId, last.before);
  update(paperId, { last: undefined });
  persist(paperId);
}

export function dismissNotebookAsk(paperId: string) {
  update(paperId, { pending: undefined });
}

/** Forgets the last reply's Undo, once the notebook has moved on. */
export function settleNotebookAsk(paperId: string) {
  if (!notebookAskFor(paperId).last) return;
  update(paperId, { last: undefined });
  persist(paperId);
}
