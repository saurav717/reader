// ===========================================================================
//  A notebook of the reader's own, on the Colab runtime.
//
//  Colab's API assigns a runtime and the page already speaks the Jupyter
//  protocol to its kernel (colab.ts), so a notebook needs no page of
//  Colab's: it is cells — code and text — kept here, run in that kernel,
//  with what they printed kept under them. One notebook a paper, in
//  IndexedDB like the explanation and the plan, under the paper's id and
//  stamped with it, so a record is only ever shown for the paper it names;
//  opened blank, with the page's own cells (`seedCells`) added only when
//  the reader asks for them, and the same shape as an .ipynb, so it goes
//  out to Colab's page, GitHub or a file and comes back from one. The model and the store are here; the page is
//  src/components/Notebook.tsx.
// ===========================================================================
import { db } from './db';
import { notebook as pageNotebook } from './explain';
const uuid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10));
export const newCell = (type, source = '') => ({ id: uuid(), type, source, outputs: [], count: null });
const joined = (value) => (Array.isArray(value) ? value.join('') : typeof value === 'string' ? value : '');
/** Outputs as an .ipynb keeps them: streams, data with a MIME type, errors. */
function outputsOut(outputs) {
    return outputs.map((output) => output.type === 'stream'
        ? { output_type: 'stream', name: output.name, text: output.text }
        : output.type === 'text'
            ? { output_type: 'execute_result', data: { 'text/plain': output.text }, metadata: {}, execution_count: null }
            : output.type === 'image'
                ? { output_type: 'display_data', data: { [output.mime]: output.data }, metadata: {} }
                : { output_type: 'error', ename: output.ename, evalue: output.evalue, traceback: output.traceback.split('\n') });
}
/** Outputs as the page shows them, read off an .ipynb: text and pictures, never markup. */
function outputsIn(outputs) {
    const out = [];
    for (const output of outputs ?? []) {
        if (!output || typeof output !== 'object')
            continue;
        if (output.output_type === 'stream')
            out.push({ type: 'stream', name: output.name === 'stderr' ? 'stderr' : 'stdout', text: joined(output.text) });
        else if (output.output_type === 'error')
            out.push({ type: 'error', ename: String(output.ename ?? 'Error'), evalue: String(output.evalue ?? ''), traceback: (output.traceback ?? []).join('\n') });
        else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
            const data = output.data ?? {};
            const image = ['image/png', 'image/jpeg', 'image/gif'].find((mime) => data[mime] !== undefined);
            if (image)
                out.push({ type: 'image', mime: image, data: joined(data[image]).replace(/\s+/g, '') });
            else if (data['text/plain'] !== undefined)
                out.push({ type: 'text', text: joined(data['text/plain']) });
        }
    }
    return out;
}
const lines = (text) => text.split(/(?<=\n)/);
/** The notebook as a Jupyter file, the shape Colab, GitHub and Jupyter read. */
export function toIpynb(nb) {
    const cells = nb.cells.map((cell) => cell.type === 'markdown'
        ? { cell_type: 'markdown', metadata: {}, source: lines(cell.source) }
        : { cell_type: 'code', execution_count: cell.count, metadata: {}, outputs: outputsOut(cell.outputs), source: lines(cell.source) });
    return JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' }, colab: { name: `${nb.title.slice(0, 80)}.ipynb`, provenance: [{ source: 'Reader' }] } },
        cells,
    }, null, 1);
}
/** The cells of a Jupyter file, as the notebook keeps them; null for a file that is not one. */
export function fromIpynb(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (!raw || !Array.isArray(raw.cells))
        return null;
    return raw.cells
        .filter((cell) => cell && typeof cell === 'object' && (cell.cell_type === 'code' || cell.cell_type === 'markdown' || cell.cell_type === 'raw'))
        .map((cell) => ({
        id: uuid(),
        type: cell.cell_type === 'code' ? 'code' : 'markdown',
        source: joined(cell.source).replace(/\n$/, ''),
        outputs: cell.cell_type === 'code' ? outputsIn(cell.outputs) : [],
        count: cell.cell_type === 'code' && typeof cell.execution_count === 'number' ? cell.execution_count : null,
    }));
}
/**
 * The page's own cells as a notebook: the explanation's or the plan's, the
 * way Colab → Download the notebook writes them, with the expected outputs left out — those
 * were written by the model, and the point of the notebook is to run them.
 * Added to the notebook only at the reader's request (Cells ▾, or the start
 * under a blank one) — never because a page was written. `writer` is that
 * model's name, for the header; with no sections there are no cells to
 * seed, and the one cell says whose the notebook is: the reader's, with the
 * model to write it still to be picked.
 */
const BLANK_LINE = '*A notebook of your own in Reader. Its cells run on your Colab runtime, and what they print is kept under them.*';
export function seedCells(title, sections, writer) {
    if (!sections.length)
        return [newCell('markdown', `# ${title}\n\n${BLANK_LINE}`)];
    return fromIpynb(pageNotebook(title, sections, writer)) ?? [];
}
// ------------------------------------------------------------- the store ---
const KEY = (paperId) => `notebook:${paperId}`;
const cache = new Map();
const listeners = new Set();
const notify = () => listeners.forEach((listener) => listener());
const timers = new Map();
export function subscribeNotebook(listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
export const notebookFor = (paperId) => cache.get(paperId);
/** Written a moment after the last change, so typing does not write a notebook a keystroke. */
function persist(nb) {
    const held = timers.get(nb.paperId);
    if (held !== undefined)
        window.clearTimeout(held);
    timers.set(nb.paperId, window.setTimeout(() => {
        timers.delete(nb.paperId);
        void db.setKv(KEY(nb.paperId), cache.get(nb.paperId)).catch(() => undefined);
    }, 400));
}
/**
 * A notebook an earlier build seeded with nothing but its header, which
 * then always said Claude whatever model was picked: one text cell, no code,
 * nothing of the reader's in it. Seeded again, so the header is right.
 */
export const isStaleSeed = (cells) => cells.length === 1 && cells[0].type === 'markdown' && /^# [^\n]*\n\n\*Explained by Claude in Reader\. The outputs under each cell were written by Claude, not run — run them to check\.\*\s*$/.test(cells[0].source);
/**
 * The record kept under a paper's key, when it is that paper's notebook and
 * whole: null for nothing, for a record with no cells, for a notebook that
 * says it is another paper's — whatever key it was found under, it is not
 * shown for this one — and for the header an earlier build kept alone (see
 * `isStaleSeed`). Each of those is seeded again.
 */
export function takeKept(kept, paperId) {
    if (!kept || typeof kept !== 'object')
        return null;
    const nb = kept;
    if (!Array.isArray(nb.cells) || nb.paperId !== paperId || isStaleSeed(nb.cells))
        return null;
    return nb;
}
/** The paper's notebook from IndexedDB, or a new one from `seed` when there is none yet — or when what is kept is not this paper's, or only an old build's header. */
export async function loadNotebook(paperId, title, seed) {
    const held = cache.get(paperId);
    if (held)
        return held;
    let kept;
    try {
        kept = await db.getKv(KEY(paperId));
    }
    catch {
        // no IndexedDB: kept for the page load only
    }
    const again = cache.get(paperId);
    if (again)
        return again;
    const mine = takeKept(kept, paperId);
    const nb = mine ? { ...mine, title } : { paperId, title, cells: seed(), updated: Date.now() };
    cache.set(paperId, nb);
    notify();
    if (!mine)
        persist(nb);
    return nb;
}
function update(paperId, change) {
    const nb = cache.get(paperId);
    if (!nb)
        return;
    const next = { ...nb, cells: change(nb.cells), updated: Date.now() };
    cache.set(paperId, next);
    notify();
    persist(next);
}
export const setSource = (paperId, id, source) => update(paperId, (cells) => cells.map((cell) => (cell.id === id ? { ...cell, source, fresh: undefined } : cell)));
export const setType = (paperId, id, type) => update(paperId, (cells) => cells.map((cell) => (cell.id === id ? { ...cell, type, outputs: [], count: null, ranAt: undefined, ranSource: undefined } : cell)));
export const setOutputs = (paperId, id, outputs, count, ranAt = Date.now()) => update(paperId, (cells) => cells.map((cell) => (cell.id === id ? { ...cell, outputs, count, ranAt, ranSource: ranAt ? cell.source : undefined, fresh: undefined } : cell)));
export const clearOutputs = (paperId) => update(paperId, (cells) => cells.map((cell) => ({ ...cell, outputs: [], count: null, ranAt: undefined, ranSource: undefined })));
export const removeCell = (paperId, id) => update(paperId, (cells) => (cells.length > 1 ? cells.filter((cell) => cell.id !== id) : cells.map((cell) => (cell.id === id ? { ...cell, source: '', outputs: [], count: null } : cell))));
export const appendCells = (paperId, more) => update(paperId, (cells) => [...cells, ...more]);
/** Whether the notebook is still just the one cell a blank notebook opens with, untouched: then cells added take its place. */
export const isSeedOnly = (cells) => cells.length === 1 && cells[0].type === 'markdown' && new RegExp(`^# [^\\n]*\\n\\n${BLANK_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(cells[0].source);
export const setCells = (paperId, next) => update(paperId, () => next);
/** A new cell before or after `id` (at the end when `id` is null), and its id. */
export function insertCell(paperId, id, where, type = 'code') {
    const cell = newCell(type);
    update(paperId, (cells) => {
        const at = id ? cells.findIndex((c) => c.id === id) : -1;
        if (at < 0)
            return [...cells, cell];
        const index = where === 'above' ? at : at + 1;
        return [...cells.slice(0, index), cell, ...cells.slice(index)];
    });
    return cell.id;
}
export function moveCell(paperId, id, direction) {
    update(paperId, (cells) => {
        const at = cells.findIndex((cell) => cell.id === id);
        const to = at + direction;
        if (at < 0 || to < 0 || to >= cells.length)
            return cells;
        const next = cells.slice();
        [next[at], next[to]] = [next[to], next[at]];
        return next;
    });
}
/**
 * The cells after a reply's edits, and which cells it touched: replacements
 * first, then insertions — each after the cell it names as the notebook was
 * numbered before the reply, so two cells after the same one keep their
 * order, and an unplaced one goes after `scopeIndex` (the cell the request
 * was about) or at the end. A replacement naming no cell is left out.
 */
export function resolveEdits(cells, edits, scopeIndex = null) {
    const touched = [];
    const replaced = cells.map((cell, index) => {
        const edit = edits.find((e) => e.kind === 'replace' && e.cell === index + 1);
        if (!edit)
            return cell;
        touched.push(cell.id);
        return { ...cell, type: edit.type, source: edit.source, outputs: [], count: null, ranAt: undefined, ranSource: undefined, fresh: 'changed' };
    });
    const after = new Map();
    for (const edit of edits) {
        if (edit.kind !== 'insert')
            continue;
        const at = edit.after === 'end' ? cells.length : edit.after === null ? (scopeIndex === null ? cells.length : scopeIndex + 1) : Math.max(0, Math.min(cells.length, edit.after));
        const made = { ...newCell(edit.type, edit.source), fresh: 'new' };
        after.set(at, [...(after.get(at) ?? []), made]);
    }
    const out = [...(after.get(0) ?? [])];
    replaced.forEach((cell, index) => out.push(cell, ...(after.get(index + 1) ?? [])));
    const order = new Set(touched);
    for (const cell of out)
        if (cell.fresh === 'new')
            order.add(cell.id);
    return { cells: out, touched: out.filter((cell) => order.has(cell.id)).map((cell) => cell.id) };
}
/** Applies a reply's edits; what the cells were goes back with Undo. */
export function applyEdits(paperId, edits, scopeIndex = null) {
    const before = cache.get(paperId)?.cells ?? [];
    let touched = [];
    update(paperId, (cells) => {
        const resolved = resolveEdits(cells, edits, scopeIndex);
        touched = resolved.touched;
        return resolved.cells;
    });
    return { before, touched };
}
/** The notebook written again: every cell replaced by `cells`, marked as the model's. */
export function replaceCells(paperId, next) {
    const before = cache.get(paperId)?.cells ?? [];
    const marked = next.map((cell) => ({ ...cell, fresh: 'new' }));
    update(paperId, () => (marked.length ? marked : [newCell('code')]));
    return { before, touched: marked.map((cell) => cell.id) };
}
/** The cells put back as they were: Undo of a reply. */
export const restoreCells = (paperId, cells) => update(paperId, () => cells.map((cell) => ({ ...cell, fresh: undefined })));
/**
 * Whether a cell has run, for the mark in its gutter: running or queued
 * now; ran, failed or stopped the last time; changed since it ran; ran
 * earlier, elsewhere (a count from an .ipynb with no run here); or never.
 * `run` is the Colab store's run for it, if it has one this session.
 */
export function cellStatus(cell, run) {
    if (cell.type !== 'code')
        return null;
    if (run?.state === 'running' || run?.state === 'queued')
        return run.state;
    const changed = cell.ranSource !== undefined && cell.ranSource !== cell.source;
    if (run?.state === 'failed')
        return changed ? 'changed' : 'failed';
    if (run?.state === 'interrupted')
        return changed ? 'changed' : 'stopped';
    if (run?.state === 'ran')
        return changed ? 'changed' : 'ran';
    const ranHere = cell.ranAt !== undefined;
    if (ranHere) {
        if (changed)
            return 'changed';
        return cell.outputs.some((output) => output.type === 'error') ? 'failed' : 'ran';
    }
    if (cell.count !== null || cell.outputs.length)
        return 'earlier';
    return 'never';
}
/** The key a cell's run is kept under in the Colab store: the cell's own, so an edited cell keeps its last run until it runs again. */
export const runKey = (id) => `nb:${id}`;
/** A folder name for the file: from the title, cut at a word. */
export function notebookFileName(title) {
    const base = title
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-|-$/g, '');
    const cut = base.length > 60 ? base.slice(0, 60).replace(/-[^-]*$/, '') : base;
    return `${cut || 'notebook'}.ipynb`;
}
