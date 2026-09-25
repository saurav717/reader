// ===========================================================================
//  Colab, over Drive.
//
//  Google Colab has no API a website can drive: no call starts a runtime or
//  runs a cell, the free tier belongs to the Google session in the browser,
//  and colab.research.google.com refuses to be framed. What Colab does do,
//  officially, is open a notebook that is in the person's Drive —
//  colab.research.google.com/drive/<fileId> — and mount that Drive inside
//  the session. So Drive is the bridge, in both directions:
//
//    out:  the notebook (the scaffold, then the page's cells, with a first
//          cell that reports back) goes into the paper's own folder, and
//          Colab is opened on it in one click;
//    back: the first cell mounts Drive and writes three files in the same
//          folder — status.json, log.txt, metrics.jsonl — as the run goes,
//          and Colab autosaves the notebook, outputs and all. The page polls
//          them and shows the run live: state, GPU, progress, the log, the
//          loss, and every cell's real output beside what Claude expected.
//
//  The app's Drive grant is drive.file — only files the app created — which
//  is why the three files are made here, empty, before the notebook opens:
//  the notebook overwrites them through the mount, the ids stay the same,
//  and the app can keep reading them. One run per paper is remembered in
//  IndexedDB, so the page picks the run back up when it is opened again.
// ===========================================================================

import type { Paper, Settings } from '../types';
import { db } from './db';
import type { Section } from './explain';
import { downloadText, ensureDriveToken, ensureFolder, fileModifiedTime, findFile, uploadFile } from './google';
import { scaffoldNotebook, slugOf, starterFiles } from './implement';
import { baseName, ROOT_FOLDER } from './sidecar';

// ---------------------------------------------------------------------------
// The notebook's first cell: mount Drive, report back
// ---------------------------------------------------------------------------

/** Where the run's files are, from inside Colab: the mount, the root folder, the paper's folder, runs/<slug>. */
export const runPathInColab = (rootName: string, paperFolder: string, slug: string) => `/content/drive/MyDrive/${rootName}/${paperFolder}/runs/${slug}`;

/**
 * The cell that makes a Colab session report to the page. It tees stdout
 * and stderr into log.txt, writes status.json after every cell (which cell,
 * whether it failed, the GPU, the time), and gives the page's own cells
 * `metric(step, loss=…)` to plot. It needs nothing installed.
 */
export function reporterCell(runPath: string, title: string): string {
  return `# Reader — this run reports back to the Implementation page it was opened from, through Drive.
# ${title}
from google.colab import drive as _drive
_drive.mount('/content/drive')
import json as _json, os as _os, sys as _sys, time as _time, subprocess as _sp, datetime as _dt
RUN = ${JSON.stringify(runPath)}
_os.makedirs(RUN, exist_ok=True)
_now = lambda: _dt.datetime.now(_dt.timezone.utc).isoformat()
_status = {"state": "running", "started": _now(), "cell": 0, "cells_failed": 0}
try:
    _status["gpu"] = _sp.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True, text=True, timeout=10).stdout.strip() or "no GPU"
except Exception:
    _status["gpu"] = "no GPU"
def _write_status(**kw):
    _status.update(kw); _status["updated"] = _now()
    with open(_os.path.join(RUN, "status.json"), "w") as f: _json.dump(_status, f)
class _Tee:
    def __init__(self, stream): self.stream = stream
    def write(self, text):
        self.stream.write(text)
        if text:
            with open(_os.path.join(RUN, "log.txt"), "a") as f: f.write(text)
    def flush(self): self.stream.flush()
    def __getattr__(self, name): return getattr(self.stream, name)
open(_os.path.join(RUN, "log.txt"), "w").close()
open(_os.path.join(RUN, "metrics.jsonl"), "w").close()
_sys.stdout, _sys.stderr = _Tee(_sys.stdout), _Tee(_sys.stderr)
def metric(step, **values):
    """Call from any cell: metric(step, loss=0.42) plots on the page."""
    with open(_os.path.join(RUN, "metrics.jsonl"), "a") as f: f.write(_json.dumps({"step": step, "t": _now(), **values}) + "\\n")
def status(**kw):
    """Call to set progress: status(steps=1000, message='distilling')."""
    _write_status(**kw)
def _after_cell(result):
    _status["cell"] += 1
    if getattr(result, "error_in_exec", None) or getattr(result, "error_before_exec", None):
        _status["cells_failed"] += 1
        _write_status(state="failed", error=str(result.error_in_exec or result.error_before_exec)[:500])
    else:
        _write_status(state="running")
get_ipython().events.register("post_run_cell", _after_cell)
_write_status()
print("reporting to", RUN, "on", _status["gpu"])
`;
}

/** The closing cell: the run is done, as far as the notebook goes. */
export const doneCell = () => `# Reader — the end of the notebook: the page shows the run as done.
status(state="done")
print("done at", _now())
`;

/** The scaffold notebook with the reporter first and the done cell last. */
export function colabNotebook(title: string, sections: Section[], runPath: string): string {
  const book = JSON.parse(scaffoldNotebook(title, sections)) as { cells: { cell_type: string; source: string[]; metadata?: object; outputs?: unknown[]; execution_count?: null }[] };
  const code = (source: string) => ({ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: source.split(/(?<=\n)/) });
  book.cells.splice(1, 0, code(reporterCell(runPath, title)));
  book.cells.push(code(doneCell()));
  return JSON.stringify(book, null, 1);
}

// ---------------------------------------------------------------------------
// What comes back
// ---------------------------------------------------------------------------

export type RunState = 'waiting' | 'running' | 'done' | 'failed' | 'stale';

export interface RunStatus {
  state: RunState;
  gpu?: string;
  started?: string;
  updated?: string;
  cell?: number;
  cellsFailed?: number;
  steps?: number;
  step?: number;
  message?: string;
  error?: string;
}

/** How long a running status may go without a change before the session is taken to have ended. */
export const STALE_AFTER_MS = 12 * 60_000;

export function parseStatus(text: string, now = Date.now()): RunStatus {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // empty until the notebook's first cell runs
  }
  const str = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : undefined);
  const num = (key: string) => (typeof raw[key] === 'number' ? (raw[key] as number) : undefined);
  const state = str('state');
  let parsed: RunState = state === 'running' || state === 'done' || state === 'failed' ? state : 'waiting';
  const updated = str('updated');
  if (parsed === 'running' && updated && now - Date.parse(updated) > STALE_AFTER_MS) parsed = 'stale';
  return { state: parsed, gpu: str('gpu'), started: str('started'), updated, cell: num('cell'), cellsFailed: num('cells_failed'), steps: num('steps'), step: num('step'), message: str('message'), error: str('error') };
}

export interface MetricPoint {
  step: number;
  t?: string;
  values: Record<string, number>;
}

/** metrics.jsonl: a line a call to metric(); a half-written last line is dropped. */
export function parseMetrics(text: string): MetricPoint[] {
  const points: MetricPoint[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const step = typeof raw.step === 'number' ? raw.step : points.length;
      const values: Record<string, number> = {};
      for (const [key, value] of Object.entries(raw)) if (key !== 'step' && key !== 't' && typeof value === 'number' && Number.isFinite(value)) values[key] = value;
      points.push({ step, t: typeof raw.t === 'string' ? raw.t : undefined, values });
    } catch {
      // still being written
    }
  }
  return points;
}

/** The last lines of the log, for the panel. */
export const logTail = (text: string, lines = 14) => text.replace(/\s+$/, '').split('\n').slice(-lines).join('\n');

export type CellOutput = { kind: 'text'; text: string } | { kind: 'image'; src: string } | { kind: 'error'; name: string; value: string };

/** A cell's outputs as Colab saved them in the notebook, by the title comment on the cell's first line. */
export function parseNotebookOutputs(text: string): Map<string, CellOutput[]> {
  const out = new Map<string, CellOutput[]>();
  let book: { cells?: { cell_type?: string; source?: string[] | string; outputs?: Record<string, unknown>[] }[] };
  try {
    book = JSON.parse(text) as typeof book;
  } catch {
    return out;
  }
  for (const cell of book.cells ?? []) {
    if (cell.cell_type !== 'code' || !cell.outputs?.length) continue;
    const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source ?? '');
    const first = source.split('\n').find((line) => !line.startsWith('%%')) ?? '';
    const title = /^#\s*(.+?)\s*$/.exec(first)?.[1];
    if (!title) continue;
    const outputs: CellOutput[] = [];
    for (const output of cell.outputs) {
      const type = output.output_type;
      const join = (value: unknown) => (Array.isArray(value) ? value.join('') : typeof value === 'string' ? value : '');
      if (type === 'stream') outputs.push({ kind: 'text', text: join(output.text) });
      else if (type === 'execute_result' || type === 'display_data') {
        const data = (output.data ?? {}) as Record<string, unknown>;
        if (data['image/png']) outputs.push({ kind: 'image', src: `data:image/png;base64,${join(data['image/png']).replace(/\s/g, '')}` });
        else if (data['text/plain']) outputs.push({ kind: 'text', text: join(data['text/plain']) });
      } else if (type === 'error') outputs.push({ kind: 'error', name: String(output.ename ?? 'Error'), value: String(output.evalue ?? '') });
    }
    // Text in a row is one output; a stream is often many writes.
    const merged: CellOutput[] = [];
    for (const output of outputs) {
      const last = merged[merged.length - 1];
      if (output.kind === 'text' && last?.kind === 'text') last.text += output.text;
      else merged.push(output);
    }
    if (merged.length) out.set(title, merged);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The run: made once, watched while the page is open
// ---------------------------------------------------------------------------

export interface ColabRun {
  paperId: string;
  slug: string;
  title: string;
  /** The notebook in Drive, and Colab on it. */
  notebookId: string;
  notebookLink?: string;
  colabUrl: string;
  /** The paper's folder, and the three files the notebook writes. */
  folderId: string;
  files: { status: string; log: string; metrics: string };
  /** Where the notebook expects them, for the person to check if the folder was renamed. */
  runPath: string;
  created: number;
}

export interface ColabLive {
  run?: ColabRun;
  status?: RunStatus;
  log: string;
  metrics: MetricPoint[];
  outputs: Map<string, CellOutput[]>;
  watching: boolean;
  /** The last problem talking to Drive, if any. */
  error?: string;
  /** When Drive was last asked (ms). */
  polled?: number;
  saving?: boolean;
}

const KEY = (paperId: string) => `colab:${paperId}`;
const POLL_MS = 8000;
const empty = (): ColabLive => ({ log: '', metrics: [], outputs: new Map(), watching: false });

const live = new Map<string, ColabLive>();
/** One empty snapshot, not a fresh one a call: useSyncExternalStore wants the same object back while nothing changed. */
const EMPTY: ColabLive = Object.freeze(empty()) as ColabLive;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const timers = new Map<string, number>();
const seen = new Map<string, Record<string, string | undefined>>();

export function subscribeColab(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const colabFor = (paperId: string): ColabLive => live.get(paperId) ?? EMPTY;

function set(paperId: string, patch: Partial<ColabLive>) {
  live.set(paperId, { ...colabFor(paperId), ...patch });
  notify();
}

/** The run remembered for this paper, and watching again if it was not finished. */
export async function loadColabRun(paperId: string): Promise<ColabRun | undefined> {
  if (live.get(paperId)?.run) return live.get(paperId)!.run;
  try {
    const kept = await db.getKv<ColabRun>(KEY(paperId));
    if (kept) {
      set(paperId, { run: kept });
      return kept;
    }
  } catch {
    // no IndexedDB
  }
  return undefined;
}

export function forgetColabRun(paperId: string) {
  stopWatching(paperId);
  live.delete(paperId);
  seen.delete(paperId);
  void db.deleteKv(KEY(paperId)).catch(() => undefined);
  notify();
}

interface Context {
  paper: Paper;
  settings: Settings;
}

/**
 * Writes the notebook and the three run files into the paper's folder in
 * Drive, remembers the run, and starts watching. The Colab URL comes back
 * for the caller to open — from the click, so the browser lets it.
 */
export async function startColabRun({ paper, settings }: Context, title: string, sections: Section[]): Promise<ColabRun> {
  const paperId = paper.id;
  set(paperId, { saving: true, error: undefined });
  try {
    const token = await ensureDriveToken(settings.googleClientId);
    const rootName = settings.driveFolderName || ROOT_FOLDER;
    const paperFolder = paper.drive?.folderName || baseName(paper);
    const folderId = paper.drive?.folderId ?? (await ensureFolder(token, paperFolder, await ensureFolder(token, rootName)));
    const slug = slugOf(title);
    const runs = await ensureFolder(token, 'runs', folderId);
    const runFolder = await ensureFolder(token, slug, runs);
    const runPath = runPathInColab(rootName, paperFolder, slug);

    // The three files, empty, made by the app so the app may read them after Colab fills them.
    const file = async (name: string, mimeType: string, body: string) => {
      const existing = await findFile(token, name, runFolder);
      return (await uploadFile(token, { name, mimeType, parentId: runFolder, body, ...(existing ? { fileId: existing.id } : {}) })).id;
    };
    const files = {
      status: await file('status.json', 'application/json', JSON.stringify({ state: 'waiting' })),
      log: await file('log.txt', 'text/plain', ''),
      metrics: await file('metrics.jsonl', 'application/x-ndjson', ''),
    };
    const name = `${slug}.ipynb`;
    const existing = await findFile(token, name, folderId);
    const notebook = await uploadFile(token, {
      name,
      mimeType: 'application/vnd.google.colaboratory',
      parentId: folderId,
      body: colabNotebook(title, sections, runPath),
      ...(existing ? { fileId: existing.id } : {}),
    });
    const run: ColabRun = {
      paperId,
      slug,
      title,
      notebookId: notebook.id,
      notebookLink: notebook.webViewLink,
      colabUrl: `https://colab.research.google.com/drive/${encodeURIComponent(notebook.id)}`,
      folderId,
      files,
      runPath,
      created: Date.now(),
    };
    live.set(paperId, { ...empty(), run, saving: false });
    seen.delete(paperId);
    void db.setKv(KEY(paperId), run).catch(() => undefined);
    notify();
    watchColabRun(paperId, settings);
    return run;
  } catch (error) {
    set(paperId, { saving: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** Asks Drive once for whatever changed: the three files, and the notebook's saved outputs. */
export async function pollColabRun(paperId: string, settings: Settings): Promise<void> {
  const run = colabFor(paperId).run;
  if (!run) return;
  try {
    const token = await ensureDriveToken(settings.googleClientId);
    const known = seen.get(paperId) ?? {};
    const changed: Record<string, string | undefined> = { ...known };
    const patch: Partial<ColabLive> = { polled: Date.now(), error: undefined };
    const read = async (key: 'status' | 'log' | 'metrics' | 'notebook', fileId: string) => {
      const modified = await fileModifiedTime(token, fileId);
      if (modified && modified === known[key]) return null;
      changed[key] = modified;
      return downloadText(token, fileId);
    };
    const [status, log, metrics, notebook] = await Promise.all([read('status', run.files.status), read('log', run.files.log), read('metrics', run.files.metrics), read('notebook', run.notebookId)]);
    if (status !== null) patch.status = parseStatus(status);
    else if (colabFor(paperId).status) patch.status = parseStatus(JSON.stringify(rawStatus(colabFor(paperId).status!)));
    if (log !== null) patch.log = log;
    if (metrics !== null) patch.metrics = parseMetrics(metrics);
    if (notebook !== null) patch.outputs = parseNotebookOutputs(notebook);
    seen.set(paperId, changed);
    set(paperId, patch);
  } catch (error) {
    set(paperId, { polled: Date.now(), error: error instanceof Error ? error.message : String(error) });
  }
}

/** The status as it was read, so staleness can be judged again against the clock. */
function rawStatus(status: RunStatus): Record<string, unknown> {
  return { state: status.state === 'stale' ? 'running' : status.state, gpu: status.gpu, started: status.started, updated: status.updated, cell: status.cell, cells_failed: status.cellsFailed, steps: status.steps, step: status.step, message: status.message, error: status.error };
}

/** Polls Drive every few seconds until the run is done or failed, or until stopped. */
export function watchColabRun(paperId: string, settings: Settings) {
  stopWatching(paperId);
  set(paperId, { watching: true });
  const tick = async () => {
    await pollColabRun(paperId, settings);
    const state = colabFor(paperId).status?.state;
    if (!colabFor(paperId).watching) return;
    if (state === 'done' || state === 'failed') {
      set(paperId, { watching: false });
      return;
    }
    timers.set(paperId, window.setTimeout(() => void tick(), POLL_MS));
  };
  void tick();
}

export function stopWatching(paperId: string) {
  window.clearTimeout(timers.get(paperId));
  timers.delete(paperId);
  if (live.get(paperId)?.watching) set(paperId, { watching: false });
}

export const isDone = (state?: RunState) => state === 'done' || state === 'failed';

/** Only the starter files' names, for the menu: how many the notebook writes. */
export const scaffoldFileCount = (sections: Section[]) => Object.keys(starterFiles(sections)).length;
