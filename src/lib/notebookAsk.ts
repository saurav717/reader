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

/** Room for the answer — and, on a model that reasons first, for the reasoning, which comes out of the same budget. */
const MAX_TOKENS = 32000;
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
- The whole notebook again: when the reader asks for the notebook, or all of its code, written again, from
  scratch, or regenerated, put notebook=new on the FIRST fence — \`\`\`python notebook=new — and then every
  fence in your answer is a new cell, in order; the current cells are all replaced by yours. Text cells as
  markdown, code cells as python, a short text cell before each step.

If the request is a question rather than a request for code, answer it in the prose and add no cells.`;

/** Whether a request asks for the whole notebook again — "rewrite all the code", "regenerate the notebook", "start over from scratch" — rather than a cell or two. */
export function wantsWholeNotebook(request: string): boolean {
  const text = request.toLowerCase();
  const again = /\b(re-?writ(?:e|ing)|re-?generat(?:e|ing)|re-?do|re-?creat(?:e|ing)|re-?build|start (?:over|again|afresh)|from scratch|write .{0,30}\bagain)\b/.test(text);
  const whole = /\b(whole|entire|all(?: of)?(?: the| my| this)?|every|full|complete)\b[^.?!]{0,40}\b(notebook|code|cells?)\b|\b(the|this|my) (whole |entire )?notebook\b/.test(text);
  return again && whole;
}

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
  /** The answer is the whole notebook again: every fence a new cell, in order, in place of every current cell. */
  replaceAll?: boolean;
}

/** A fenced block: three or more backticks or tildes, closed by the same; the language, the rest of the info string, the body. */
const FENCE = /^(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+-]*)([^\n]*)\n([\s\S]*?)^\1[ \t]*$/gm;
/** An opening fence with no close: the answer was cut before the cell was whole. */
const OPEN_FENCE = /^(`{3,}|~{3,})[ \t]*[A-Za-z0-9_+-]*[^\n]*\n(?![\s\S]*?^\1[ \t]*$)/m;

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
  let replaceAll = false;
  const prose = text.replace(FENCE, (_match, _fence: string, lang: string, info: string, body: string) => {
    const type = asType(lang);
    if (type === null) return '';
    if (/\b(?:notebook|replace)\s*=\s*"?(?:new|all)"?/i.test(info)) replaceAll = true;
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
  return replaceAll ? { note, edits, replaceAll } : { note, edits };
}

/** Why an answer gave the notebook nothing, in words the reader can act on. */
export function nothingTaken(writer: string, reply: string, thinking: string | undefined, stop: string | null): string {
  const cut = stop === 'max_tokens';
  if (!reply.trim()) {
    if (cut || thinking) return `${writer} ran out of room before it wrote a cell${thinking ? ' — its reasoning used up the answer' : ''}. Ask for less at once: one cell, or Rewrite cell by cell.`;
    return `${writer} sent an empty answer. Try again, or ask for one cell at a time.`;
  }
  if (cut || OPEN_FENCE.test(reply)) return `${writer}'s answer was cut off before the cell was complete, so nothing was changed. Ask for less at once: one cell, or Rewrite cell by cell.`;
  return `${writer} answered without a cell the notebook could take. It said: “${reply.trim().slice(0, 160)}${reply.trim().length > 160 ? '…' : ''}”`;
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
  /** Cell by cell: how far along, and which cell is being written now. */
  progress?: { done: number; total: number; label: string };
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
  const { paperId, screen, model, scope = {}, runs = {}, pages = {} } = params;
  const request = params.request.trim();
  const nb = notebookFor(paperId);
  if (!request || !nb || running) return;
  // A request for the whole notebook again is the rewrite, with the reader's words steering it; the reply then replaces every cell.
  const mode: 'ask' | 'rewrite' = params.mode === 'rewrite' || wantsWholeNotebook(request) ? 'rewrite' : 'ask';
  const rewriteAsk = `${REWRITE_REQUEST}${params.mode === 'rewrite' ? '' : `\n\nThe reader asks, in their words: “${request}”. Follow that — it decides what the notebook is for, the framework, the scale, the data.`}`;
  const pending: NbPending = { request, reply: '', started: Date.now() };
  update(paperId, { pending: { ...pending }, model });
  let SDK: SDK | null = null;
  try {
    if (modelSpec(model).provider === 'anthropic') SDK = await sdk();
    const stream = await streamModel({
      model,
      maxTokens: MAX_TOKENS,
      system: systemFor(screen),
      messages: [{ role: 'user', content: mode === 'rewrite' ? requestText(rewriteAsk, {}, nb.cells, runs, pages) : requestText(request, scope, nb.cells, runs, pages) }],
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
      mode === 'rewrite' || parsed.replaceAll
        ? parsed.edits.length
          ? replaceCells(paperId, parsed.edits.map((edit) => newCell(edit.type, edit.source)))
          : null
        : parsed.edits.length
          ? applyEdits(paperId, parsed.edits, scopeIndex)
          : null;
    const note = parsed.note || (applied ? `${applied.touched.length} ${applied.touched.length === 1 ? 'cell' : 'cells'} written` : '');
    // A rewrite that changed nothing is a failure whatever it said; an ask may be answered in prose alone.
    if (!applied && (!note || mode === 'rewrite')) throw new Error(nothingTaken(PROVIDERS[modelSpec(model).provider].name, pending.reply, pending.thinking, final.stop_reason));
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

/** Rewrite, cell by cell: what each code cell is asked for, in turn. */
export const cellRewriteRequest = (n: number) =>
  `Rewrite cell ${n} in place: the same purpose and the same place in the notebook, written again by you — correct, clear, idiomatic,
faithful to the paper, self-contained or relying only on the cells above it, and printing something comparable to what it prints now.
Answer with ONE fenced block, \`\`\`python cell=${n}, holding the whole new cell, and at most one sentence outside it. Change no other cell.`;

/**
 * Every code cell written again by `model`, one at a time, each in place —
 * Rewrite's other choice on the Colab tab. The notebook keeps its shape;
 * each cell lands as its answer comes, marked as rewritten; Stop keeps the
 * cells done so far; one Undo puts every cell back.
 */
export async function rewriteCells(params: { paperId: string; screen: Screen; model: string; runs?: Record<string, CellRun>; pages?: { explanation?: string; plan?: string } }): Promise<void> {
  const { paperId, screen, model, runs = {}, pages = {} } = params;
  const nb = notebookFor(paperId);
  if (!nb || running) return;
  const targets = nb.cells.filter((cell) => cell.type === 'code' && cell.source.trim());
  if (!targets.length) return;
  const writer = PROVIDERS[modelSpec(model).provider].name;
  const request = `Rewrite every code cell, one by one, with ${writer}`;
  const before = nb.cells;
  const touched: string[] = [];
  const pending: NbPending = { request, reply: '', started: Date.now(), progress: { done: 0, total: targets.length, label: 'cell 1' } };
  update(paperId, { pending: { ...pending }, model });
  let SDK: SDK | null = null;
  const settle = (note: string) => {
    const now = notebookAskFor(paperId);
    update(paperId, { pending: undefined, last: { request, note, before, touched: [...touched], at: Date.now() }, requests: [...now.requests, request].slice(-REPLIES_KEPT) });
    persist(paperId);
  };
  try {
    if (modelSpec(model).provider === 'anthropic') SDK = await sdk();
    for (const target of targets) {
      const current = notebookFor(paperId);
      const at = current ? current.cells.findIndex((cell) => cell.id === target.id) : -1;
      if (!current || at < 0) continue;
      const n = at + 1;
      pending.progress = { done: touched.length, total: targets.length, label: `cell ${n}` };
      pending.reply = '';
      pending.thinking = undefined;
      update(paperId, { pending: { ...pending } });
      const stream = await streamModel({
        model,
        maxTokens: MAX_TOKENS,
        system: systemFor(screen),
        messages: [{ role: 'user', content: requestText(cellRewriteRequest(n), { cell: n }, current.cells, runs, pages) }],
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
      if (final.stop_reason === 'refusal') throw new Error(`${writer} declined to rewrite cell ${n}.`);
      const parsed = parseNotebookReply(pending.reply);
      // The cell asked for, first; else the one replacement it sent; else its one new cell, taken as the rewrite.
      const edit = parsed.edits.find((e) => e.kind === 'replace' && e.cell === n) ?? parsed.edits.find((e) => e.kind === 'replace') ?? (parsed.edits.length === 1 ? parsed.edits[0] : undefined);
      if (!edit || !edit.source.trim()) {
        // The first cell it cannot write says why and stops the round; the cells done so far stay.
        if (!touched.length) throw new Error(nothingTaken(writer, pending.reply, pending.thinking, final.stop_reason));
        continue;
      }
      applyEdits(paperId, [{ kind: 'replace', cell: n, type: 'code', source: edit.source }], at);
      touched.push(target.id);
    }
    settle(`${touched.length} of ${targets.length} code ${targets.length === 1 ? 'cell' : 'cells'} rewritten with ${writer}, each in place`);
  } catch (error) {
    const message = explainError(error, SDK);
    if (message === 'Stopped.') settle(touched.length ? `Stopped after ${touched.length} of ${targets.length} code cells; those are rewritten, the rest as they were` : 'Stopped before any cell was rewritten');
    else update(paperId, { pending: { ...pending, error: touched.length ? `${message} ${touched.length} of ${targets.length} cells were rewritten before that.` : message } });
  } finally {
    running = null;
  }
}

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
