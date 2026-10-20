// Picking a project up from another computer while it runs.
//
// A kernel and what runs in it live on the machine, not in the browser; what
// the browser alone knew was *which* kernel, and what it had asked it to
// run. That is kept here, per Google account, on the proxy (worker/kernels.js):
// a row per kernel scope — a project's, or a pool member's — with the machine
// the project is on, its kernels, and its runs by key, each with the request
// it is and where its output is logged on the machine. A browser that opens
// the project asks for the row (`recall`), joins the same kernel, and follows
// the runs still going: the earlier output read from the log, the rest as the
// kernel sends it (src/lib/colab.ts, `adoptRuns`).
//
// Signed out, or with no proxy, nothing is kept and nothing is asked.

import { api, apiBase, apiHeaders, currentPass } from './api';

export interface RunNote {
  startedAt: number;
  state: 'running' | 'done';
  /** The execute request's msg_id: the kernel's messages for it carry it as their parent, so another browser can follow them. */
  msgId: string;
  kernelId: string;
  where: string;
  /** Where the run's output is logged on the machine, as an absolute path, when it is (a console command's is). */
  log?: string;
  ms?: number;
  outcome?: 'ran' | 'failed' | 'interrupted';
}

export interface ScopeRecord {
  scope: string;
  /** The runtime's endpoint: Colab's for the notebook, or `jupyter:<id>` for a server. */
  endpoint: string;
  /** Kernel ids by scope on that machine — the scope's own, and the machine watch's under '#monitor'. */
  kernels: Record<string, string>;
  runs: Record<string, RunNote>;
  updatedAt: number;
  /** Which browser wrote it, in a few words. */
  by: string;
}

/** How long a row read from the proxy is taken as current before it is asked for again. */
export const RECALL_FRESH_MS = 20_000;
/** How long after a change the row is written: the writes of one burst (a kernel kept, a run started) go as one. */
const WRITE_WAIT_MS = 800;
/** Done runs older than this are let go of the row: nobody comes back for them. */
export const DONE_KEPT_MS = 12 * 3_600_000;
/** The most runs a row carries; the oldest go first. */
export const MAX_RUNS = 30;

const available = () => Boolean(currentPass() && apiBase());

/** This browser, in a few words, for the row's `by`. */
export function browserWords(agent = typeof navigator !== 'undefined' ? navigator.userAgent : '', inApp = typeof window !== 'undefined' && Boolean((window as { readerDesktop?: unknown }).readerDesktop)): string {
  // The Koios app is Chrome inside (Electron), with Electron's word taken out of its user agent: it is named as itself.
  const app = inApp || /Electron\//.test(agent) ? 'the Koios app' : /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'a browser';
  const os = /iPhone|iPad/.test(agent) ? 'iPhone or iPad' : /Mac OS X|Macintosh/.test(agent) ? 'a Mac' : /Windows/.test(agent) ? 'Windows' : /Android/.test(agent) ? 'Android' : /Linux/.test(agent) ? 'Linux' : '';
  return os ? `${app} on ${os}` : app;
}

let rows = new Map<string, ScopeRecord>();
let readAt = 0;
let reading: Promise<void> | null = null;

/** Every row of the account, read when the ones held are older than RECALL_FRESH_MS (or `force`). */
async function readAll(force = false): Promise<void> {
  if (!available()) return;
  if (!force && Date.now() - readAt < RECALL_FRESH_MS) return;
  if (reading) return reading;
  reading = (async () => {
    try {
      const response = await fetch(api('/kernels'), { headers: apiHeaders(), cache: 'no-store' });
      if (!response.ok) return;
      const body = (await response.json()) as { kernels?: ScopeRecord[] };
      const next = new Map<string, ScopeRecord>();
      for (const row of body.kernels ?? []) if (row && typeof row.scope === 'string') next.set(row.scope, row);
      // What this browser changed since, and has not written yet, stays its own.
      for (const [scope, mine] of pending) next.set(scope, mine);
      rows = next;
      readAt = Date.now();
    } catch {
      // Offline, or a proxy without the store: nothing to pick up.
    } finally {
      reading = null;
    }
  })();
  return reading;
}

/** The row for a scope, as the account's other browsers left it; null when there is none, or nothing can be asked. */
export async function recall(scope: string): Promise<ScopeRecord | null> {
  if (!available()) return null;
  await readAll();
  return rows.get(scope) ?? null;
}

/** Every row of the account: which machine each project was on last, and from which browser. */
export async function recallAll(force = false): Promise<ScopeRecord[]> {
  if (!available()) return [];
  await readAll(force);
  return [...rows.values()];
}

/** The row for a scope as this browser holds it now, without asking. */
export const held = (scope: string): ScopeRecord | undefined => rows.get(scope);

const pending = new Map<string, ScopeRecord>();
let writeTimer: number | null = null;

/** Runs cut to the bounds: done ones past DONE_KEPT_MS go, then the oldest past MAX_RUNS. */
export function pruneRuns(runs: Record<string, RunNote>, now = Date.now()): Record<string, RunNote> {
  const kept = Object.entries(runs)
    .filter(([, run]) => run.state === 'running' || now - (run.startedAt + (run.ms ?? 0)) < DONE_KEPT_MS)
    .sort((a, b) => b[1].startedAt - a[1].startedAt)
    .slice(0, MAX_RUNS);
  return Object.fromEntries(kept);
}

function flush() {
  writeTimer = null;
  if (!available()) {
    pending.clear();
    return;
  }
  for (const [scope, record] of pending) {
    pending.delete(scope);
    void fetch(api('/kernels/put'), { method: 'POST', headers: apiHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(record), keepalive: true }).catch(() => undefined);
  }
}

function schedule(scope: string, record: ScopeRecord) {
  rows.set(scope, record);
  pending.set(scope, record);
  if (writeTimer !== null) window.clearTimeout(writeTimer);
  writeTimer = window.setTimeout(flush, WRITE_WAIT_MS);
}

/**
 * A scope's machine and kernels, as this browser has them now: the row made
 * or changed. A new machine (another endpoint) starts the row afresh — the
 * old kernels and runs were that machine's.
 */
export function remember(scope: string, endpoint: string, kernels: Record<string, string>): void {
  if (!available()) return;
  const was = rows.get(scope);
  const same = was?.endpoint === endpoint;
  schedule(scope, { scope, endpoint, kernels: { ...(same ? was.kernels : {}), ...kernels }, runs: same ? was.runs : {}, updatedAt: Date.now(), by: browserWords() });
}

/** A run started, or over, in a scope's kernel: noted in the row, for a browser that joins the kernel later. */
export function noteRun(scope: string, endpoint: string, key: string, note: RunNote): void {
  if (!available()) return;
  const was = rows.get(scope);
  const same = was?.endpoint === endpoint;
  const runs = pruneRuns({ ...(same ? was.runs : {}), [key]: note });
  schedule(scope, { scope, endpoint, kernels: same ? was.kernels : {}, runs, updatedAt: Date.now(), by: browserWords() });
}

/** A scope's row dropped: its kernel was shut down, or its machine stopped. */
export function forget(scope: string): void {
  rows.delete(scope);
  pending.delete(scope);
  if (!available()) return;
  void fetch(api('/kernels/drop'), { method: 'POST', headers: apiHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ scope }), keepalive: true }).catch(() => undefined);
}

/** Whatever waits is written now — on the page going away, so a run started a moment ago is not lost to the other browsers. */
export function flushNow(): void {
  if (writeTimer !== null) window.clearTimeout(writeTimer);
  flush();
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushNow);
