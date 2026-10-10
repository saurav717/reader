// What the playgrounds are doing, from anywhere in the app: which one is
// running now and how far it has got, which can be picked back up (its
// kernel still holds its variables), and how the last run of each ended.
//
// The kernel and its runs already live outside React, in src/lib/colab.ts, so
// a run goes on when its page is left. What the colab store does not say is
// whose run it is — a notebook cell's key is `nb:<cell>` — nor how a run that
// is over ended once the page is reloaded. This module watches the colab
// store, puts each run with its playground, keeps the last outcome of each
// in this browser, and says when a run ends, for a toast.
//
// What the page shows of it — a shelf on the Playground's home, a dock on
// every page, a switcher on P, tabs — is the person's choice: Settings →
// Running playgrounds (settings.runningShows), drawn by
// src/components/PlaygroundRuns.tsx.

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CellRun, ColabState, Output } from './colab';
import { backendLabel, chooseBackend, colabNow, keptKernelFor, machineLabel, shutDownKernelOn, stopRuns, stopRuntime, stripAnsi, subscribeColab } from './colab';
import { notebookFor, setOutputs, subscribeNotebook } from './notebook';
import type { Playground } from './playground';
import { notebookKey, playgroundById, playgroundsNow, serverById, subscribePlaygrounds } from './playground';

// ---------------------------------------------------------------- types ----

/**
 * Where a playground stands:
 * - running, paused (Run all, held between cells), connecting — it has the kernel now;
 * - idle — it has the kernel, nothing is running, its variables are there;
 * - ran, failed, stopped — how its last run ended, the kernel since gone or another's;
 * - never — nothing has run in it in this browser.
 */
export type RunPhase = 'running' | 'paused' | 'connecting' | 'idle' | 'ran' | 'failed' | 'stopped' | 'never';

export interface PlaygroundRun {
  id: string;
  title: string;
  kind: Playground['kind'];
  phase: RunPhase;
  /** The machine, in a few words: "Colab · T4", "Saurav’s MacBook Air". */
  where: string;
  /** What is running: "cell 9 of 14", "$ python train.py". */
  label?: string;
  /** Its code's first line. */
  code?: string;
  /** The last line it printed. */
  tail?: string;
  /** 0–1 when there is a way to tell (Run all's cells, a percentage or n/m in the last line); null when not. */
  progress?: number | null;
  /** When the run (or Run all) began. */
  startedAt?: number;
  /** When the last run ended. */
  at?: number;
  /** How it ended, in a few words: "3 cells ran", "ZeroDivisionError: division by zero". */
  detail?: string;
  /** Idle, with its kernel still up: how its last run ended. */
  last?: 'ran' | 'failed' | 'stopped';
  /** Run all's cells still to run. */
  queued?: number;
}

/** How a run ended, kept in this browser for each playground. */
interface Outcome {
  phase: 'ran' | 'failed' | 'stopped';
  at: number;
  detail: string;
  where: string;
}

/** What a toast says: a playground's run is over. */
export interface RunEnded {
  id: string;
  title: string;
  phase: Outcome['phase'];
  detail: string;
  at: number;
}

// ---------------------------------------------------- reading a run ----

/** The last line a run printed, as a terminal shows it: a carriage return starts the line again (tqdm's bar). */
export function tailOf(outputs: Output[]): string | undefined {
  for (let i = outputs.length - 1; i >= 0; i -= 1) {
    const output = outputs[i];
    if (output.type === 'error') return `${output.ename}: ${output.evalue}`;
    if (output.type === 'image') continue;
    const lines = stripAnsi(output.text)
      .split('\n')
      .map((line) => line.split('\r').filter((part) => part.trim()).pop() ?? '')
      .filter((line) => line.trim());
    if (lines.length) return lines[lines.length - 1].trim().slice(0, 240);
  }
  return undefined;
}

/** How far a line says it has got: "42%" or "epoch 6/10", "1840/3000"; null when it doesn't say. */
export function progressIn(line: string | undefined): number | null {
  if (!line) return null;
  const percent = /(\d{1,3}(?:\.\d+)?)\s?%/.exec(line);
  if (percent) {
    const value = Number(percent[1]);
    if (value >= 0 && value <= 100) return value / 100;
  }
  const ratio = /\b(\d+)\s?\/\s?(\d+)\b/.exec(line);
  if (ratio) {
    const [done, total] = [Number(ratio[1]), Number(ratio[2])];
    if (total > 1 && done <= total) return done / total;
  }
  return null;
}

/** The error a failed run ended on, or how many cells ran. */
function detailOf(runs: CellRun[], phase: Outcome['phase']): string {
  if (phase === 'failed') {
    for (const run of [...runs].reverse()) {
      const error = run.outputs.find((output) => output.type === 'error');
      if (error && error.type === 'error') return `${error.ename}: ${error.evalue}`.slice(0, 200);
    }
    return 'it ended on an error';
  }
  const ran = runs.filter((run) => run.state === 'ran').length;
  if (phase === 'stopped') return ran ? `stopped after ${ran} ${ran === 1 ? 'cell' : 'cells'}` : 'stopped';
  return ran === 1 ? 'it ran' : `${ran} cells ran`;
}

// ------------------------------------------------- whose run it is ----

const owners = new Map<string, string>();

/** The playground a run key belongs to: a console command's says so; a notebook cell's is found in the notebooks. */
export function ownerOf(key: string, list: Pick<Playground, 'id'>[] = playgroundsNow(), cellsOf: (id: string) => { id: string }[] | undefined = (id) => notebookFor(notebookKey(id))?.cells): string | undefined {
  const known = owners.get(key);
  if (known) return known;
  const shell = /^pgsh:([^:]+):/.exec(key);
  if (shell) {
    owners.set(key, shell[1]);
    return shell[1];
  }
  if (!key.startsWith('nb:')) return undefined;
  const cellId = key.slice(3);
  for (const p of list) {
    if (cellsOf(p.id)?.some((cell) => cell.id === cellId)) {
      owners.set(key, p.id);
      return p.id;
    }
  }
  return undefined;
}

/** "cell 9 of 14" or "$ python train.py", and the first line of the code. */
function describeKey(p: Playground, key: string): { label: string; code?: string } {
  if (key.startsWith('pgsh:')) {
    const entry = p.console.find((e) => key.endsWith(`:${e.id}`));
    return { label: entry ? `$ ${entry.command.slice(0, 60)}` : 'a command', code: entry?.command };
  }
  const cells = notebookFor(notebookKey(p.id))?.cells ?? [];
  const code = cells.filter((cell) => cell.type === 'code');
  const index = code.findIndex((cell) => `nb:${cell.id}` === key);
  if (index < 0) return { label: 'a cell' };
  const first = code[index].source.split('\n').find((line) => line.trim() && !line.trim().startsWith('#'));
  return { label: `cell ${index + 1} of ${code.length}`, code: first?.trim().slice(0, 80) };
}

/** The machine a playground runs on, in a few words. */
export function whereOf(p: Playground): string {
  if (p.compute.kind === 'colab') return `Colab · ${machineLabel(p.compute.machine)}`;
  return serverById(p.compute.serverId)?.name ?? p.compute.name ?? 'a computer not connected here';
}

// ------------------------------------------------------ the store ----

const OUTCOMES_KEY = 'reader.playground.outcomes';
const HELD_KEY = 'reader.playground.kernel-holders';
const TABS_KEY = 'reader.playground.tabs';

const readJson = <T>(storage: Storage | undefined, key: string, fallback: T): T => {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (storage: Storage | undefined, key: string, value: unknown) => {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Full or blocked: it is only a convenience.
  }
};
const local = () => (typeof localStorage === 'undefined' ? undefined : localStorage);
const session = () => (typeof sessionStorage === 'undefined' ? undefined : sessionStorage);

let outcomes: Record<string, Outcome> = readJson(local(), OUTCOMES_KEY, {});
/** The playground whose page last took the kernel: its variables are the kernel's while it is connected. */
let holder: string | null = null;
/**
 * On each Jupyter server, the playground that last had this tab's kernel there. The tab keeps that kernel
 * after the page is left (and goes back to it), so its variables are that playground's.
 */
let heldOn: Record<string, string> = readJson(session(), HELD_KEY, {});
/** The playgrounds whose page is open now (one, or none). */
const mounted = new Set<string>();
/** Playgrounds opened in this tab, for the tabs: newest last. */
let tabs: string[] = readJson(session(), TABS_KEY, []);

/** The run going on now, from its first cell to its last: whose it is, when it began, and the keys it ran. */
interface Batch {
  id: string;
  startedAt: number;
  keys: string[];
  /** Run all's cells, all of them, when it is one. */
  total: number;
}
let batch: Batch | null = null;

let version = 0;
const listeners = new Set<() => void>();
const bump = () => {
  version += 1;
  listeners.forEach((listener) => listener());
};
const ended = new Set<(event: RunEnded) => void>();

export const subscribeRuns = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
/** Called with each run that ends, for a toast. */
export const onRunEnded = (listener: (event: RunEnded) => void) => {
  ended.add(listener);
  return () => {
    ended.delete(listener);
  };
};

/** The playground whose run is going on now, if any. */
export function runningPlayground(state: ColabState = colabNow()): string | undefined {
  if (state.running) return ownerOf(state.running) ?? batch?.id;
  if (state.queue.length) return ownerOf(state.queue[0]) ?? batch?.id;
  return undefined;
}

/** A playground's page took the kernel: it is what the kernel's variables are. */
export function holdKernel(id: string) {
  holder = id;
  const p = playgroundById(id);
  if (p?.compute.kind === 'server' && heldOn[p.compute.serverId] !== id) {
    heldOn = { ...heldOn, [p.compute.serverId]: id };
    writeJson(session(), HELD_KEY, heldOn);
  }
  bump();
}

/** A playground's page is open; called back when it closes. It joins the tabs. */
export function openedPlayground(id: string): () => void {
  mounted.add(id);
  if (!tabs.includes(id)) {
    tabs = [...tabs, id].slice(-8);
    writeJson(session(), TABS_KEY, tabs);
  }
  bump();
  return () => {
    mounted.delete(id);
    bump();
  };
}

export const tabsNow = () => tabs;
export function closeTab(id: string) {
  tabs = tabs.filter((tab) => tab !== id);
  writeJson(session(), TABS_KEY, tabs);
  bump();
}

/** Where a playground stands now. */
export function runOf(p: Playground, state: ColabState = colabNow()): PlaygroundRun {
  const base = { id: p.id, title: p.title, kind: p.kind, where: whereOf(p) };
  const live = state.status === 'idle' || state.status === 'busy' || state.status === 'connecting';
  const mine = runningPlayground(state) === p.id;
  if (mine) {
    const key = state.running ?? state.queue[0];
    const run = state.running ? state.runs[state.running] : undefined;
    const tail = run ? tailOf(run.outputs) : undefined;
    const total = batch?.id === p.id ? batch.total : 0;
    const done = total ? total - state.queue.length - (state.running ? 1 : 0) : 0;
    const { label, code } = describeKey(p, key);
    return {
      ...base,
      where: state.runtime ? backendLabel(state.backend, state.runtime) : base.where,
      phase: state.paused && !state.running ? 'paused' : state.status === 'connecting' ? 'connecting' : 'running',
      label,
      code,
      tail,
      progress: total > 1 ? Math.max(0, done) / total : progressIn(tail),
      startedAt: batch?.id === p.id ? batch.startedAt : run?.startedAt,
      queued: state.queue.length,
    };
  }
  if (holder === p.id && live && !state.running && !state.queue.length) {
    const outcome = outcomes[p.id];
    return { ...base, where: state.runtime ? backendLabel(state.backend, state.runtime) : base.where, phase: state.status === 'connecting' ? 'connecting' : 'idle', at: outcome?.at, detail: outcome?.detail, last: outcome?.phase };
  }
  const outcome = outcomes[p.id];
  // Its page closed, its kernel kept on its server: opening it goes back to the same variables.
  if (p.compute.kind === 'server' && heldOn[p.compute.serverId] === p.id && keptKernelFor(p.compute.serverId) && !(live && state.backend.kind === 'jupyter' && state.backend.server.id === p.compute.serverId && holder !== p.id)) {
    return { ...base, phase: 'idle', at: outcome?.at, detail: outcome?.detail, last: outcome?.phase };
  }
  if (outcome) return { ...base, phase: outcome.phase, at: outcome.at, detail: outcome.detail, where: outcome.where || base.where };
  return { ...base, phase: 'never' };
}

/** Every playground's standing, the ones that need a look first: running, then idle with a kernel, then the rest, newest first. */
export function boardOf(list: Playground[], state: ColabState = colabNow()): PlaygroundRun[] {
  const rank: Record<RunPhase, number> = { running: 0, connecting: 0, paused: 1, idle: 2, failed: 3, ran: 4, stopped: 4, never: 5 };
  return list
    .map((p) => ({ run: runOf(p, state), updated: p.updated }))
    .sort((a, b) => rank[a.run.phase] - rank[b.run.phase] || Math.max(b.run.at ?? 0, b.updated) - Math.max(a.run.at ?? 0, a.updated))
    .map(({ run }) => run);
}

export const isLive = (run: Pick<PlaygroundRun, 'phase'>) => run.phase === 'running' || run.phase === 'paused' || run.phase === 'connecting';

// ------------------------------------------------- watching colab ----

/** Ends the batch: its outcome kept, a toast said, its notebook's outputs saved. */
function finish(state: ColabState) {
  const done = batch;
  batch = null;
  if (!done) return;
  const p = playgroundById(done.id);
  const runs = done.keys.map((key) => state.runs[key]).filter((run): run is CellRun => Boolean(run));
  // A run left 'running' had its kernel closed under it (another machine, the runtime stopped).
  // Stop interrupts the cell, and Python answers with a KeyboardInterrupt: that is a stop, not a failure.
  const interrupted = (run: CellRun) => run.outputs.some((output) => output.type === 'error' && output.ename === 'KeyboardInterrupt');
  const failed = runs.some((run) => run.state === 'failed' && !interrupted(run));
  const stopped = runs.some((run) => run.state === 'interrupted' || run.state === 'running' || run.stale || interrupted(run));
  const phase: Outcome['phase'] = failed ? 'failed' : stopped ? 'stopped' : 'ran';
  const detail = detailOf(runs, phase);
  const at = Date.now();
  outcomes = { ...outcomes, [done.id]: { phase, at, detail, where: runs[runs.length - 1]?.where ?? '' } };
  writeJson(local(), OUTCOMES_KEY, outcomes);
  if (p) ended.forEach((listener) => listener({ id: p.id, title: p.title, phase, detail, at }));
  // With no playground's page open to hold it, the jupyter kernel's socket is let go now that nothing runs: the
  // paper pages' cells run in Colab again, as the workspace leaves it on closing. The kernel stays on its server.
  if (!mounted.size && state.backend.kind === 'jupyter' && !state.running && !state.queue.length) chooseBackend({ kind: 'colab' });
}

/** A cell that ended with its page closed: its outputs go into the notebook, as the page would have put them. */
function keepOutputs(key: string, run: CellRun) {
  if (!key.startsWith('nb:') || run.state === 'running' || run.state === 'queued') return;
  const owner = ownerOf(key);
  if (!owner || mounted.has(owner)) return;
  const nbKey = notebookKey(owner);
  const cell = notebookFor(nbKey)?.cells.find((c) => c.id === key.slice(3));
  if (cell && cell.outputs !== run.outputs) setOutputs(nbKey, cell.id, run.outputs, run.executionCount ?? cell.count, run.startedAt);
}

let previous: ColabState | null = null;
function onColab() {
  const state = colabNow();
  const before = previous;
  previous = state;
  const begin = (owner: string) => {
    if (batch && batch.id !== owner) finish(state);
    if (!batch) batch = { id: owner, startedAt: Date.now(), keys: [], total: 0 };
    return batch;
  };
  // Run all marks every cell queued at once, before the first runs: that is how many there are.
  if (state.queue.length > (before?.queue.length ?? 0)) {
    const owner = ownerOf(state.queue[0]);
    if (owner) {
      const now = begin(owner);
      now.total = now.keys.length + state.queue.length;
    }
  }
  if (state.running && before?.running !== state.running) {
    const owner = ownerOf(state.running);
    const now = owner ? begin(owner) : batch;
    if (now && !now.keys.includes(state.running)) now.keys.push(state.running);
  }
  if (before && before.runs !== state.runs) {
    for (const [key, run] of Object.entries(state.runs)) if (before.runs[key] !== run) keepOutputs(key, run);
  }
  if (batch && !state.running && !state.queue.length && !state.paused) finish(state);
  bump();
}

/** On Colab: a runtime left idle longer than its playground asks is stopped, its page open or not. */
function idleCheck() {
  const state = colabNow();
  if (state.status !== 'idle' || state.backend.kind !== 'colab' || !holder || mounted.has(holder)) return;
  const p = playgroundById(holder);
  if (!p || p.compute.kind !== 'colab' || !p.idleStopMin) return;
  const outcome = outcomes[holder];
  const since = Math.max(outcome?.at ?? 0, state.startedAt ?? 0);
  if (since && Date.now() - since > p.idleStopMin * 60_000) void stopRuntime();
}

let watching = 0;
let stopWatch: (() => void) | null = null;
/** Starts watching (once, however many call it); the function given back stops it when the last caller is done. */
export function watchPlaygroundRuns(): () => void {
  watching += 1;
  if (watching === 1) {
    previous = colabNow();
    const offColab = subscribeColab(onColab);
    const offPlaygrounds = subscribePlaygrounds(bump);
    const offNotebook = subscribeNotebook(bump);
    const timer = setInterval(idleCheck, 30_000);
    stopWatch = () => {
      offColab();
      offPlaygrounds();
      offNotebook();
      clearInterval(timer);
    };
  }
  return () => {
    watching -= 1;
    if (watching === 0) {
      stopWatch?.();
      stopWatch = null;
    }
  };
}

// ------------------------------------------------------- actions ----

/** Stops a playground's run: Run all's queue dropped, the cell running interrupted. */
export async function stopPlayground(id: string): Promise<void> {
  if (runningPlayground() === id) await stopRuns();
}

/** Shuts down the kernel a playground holds: its variables go; on Colab, the runtime stops and costs nothing more. */
export async function shutDownPlayground(id: string): Promise<void> {
  if (runningPlayground() === id) return;
  const p = playgroundById(id);
  const server = p?.compute.kind === 'server' ? serverById(p.compute.serverId) : undefined;
  if (server) await shutDownKernelOn(server);
  else if (holder === id) await stopRuntime();
  bump();
}

// --------------------------------------------------------- hooks ----

const versionNow = () => version;

/** Every playground's standing, kept current; re-read each second while something runs, for the clocks. */
export function useRunBoard(list: Playground[]): PlaygroundRun[] {
  useSyncExternalStore(subscribeRuns, versionNow);
  const state = useSyncExternalStore(subscribeColab, colabNow);
  const board = boardOf(list, state);
  const busy = board.some(isLive);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  return board;
}

export const useTabs = () => {
  useSyncExternalStore(subscribeRuns, versionNow);
  return tabs;
};

/** Each run that ends, as it ends. */
export function useRunEnded(listener: (event: RunEnded) => void) {
  useEffect(() => onRunEnded(listener), [listener]);
}

// ------------------------------------------------------ wording ----

/** "38 min", "1 h 4 min", "12 s". */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function ago(at: number, now = Date.now()): string {
  const s = Math.round((now - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86_400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/** The phase in a few words, for its pill. */
export function phaseLabel(run: PlaygroundRun): string {
  switch (run.phase) {
    case 'running':
      return 'Running';
    case 'connecting':
      return 'Connecting';
    case 'paused':
      return 'Paused';
    case 'idle':
      return 'Idle · variables kept';
    case 'ran':
      return 'Finished';
    case 'failed':
      return 'Failed';
    case 'stopped':
      return 'Stopped';
    default:
      return 'Not run yet';
  }
}

/** What coming back to it will be like, under the pill. */
export function phaseNote(run: PlaygroundRun): string {
  switch (run.phase) {
    case 'running':
    case 'connecting':
      return [run.label, run.startedAt ? clock(Date.now() - run.startedAt) : ''].filter(Boolean).join(' · ');
    case 'paused':
      return `Run all paused · ${run.queued ?? 0} ${run.queued === 1 ? 'cell' : 'cells'} waiting`;
    case 'idle': {
      const last = run.last === 'failed' ? `failed — ${run.detail}` : run.detail;
      const up = run.where.startsWith('Colab') ? 'the runtime is still up, and uses units until it stops' : 'its variables are still in the kernel';
      return last ? `${last} · ${up}` : up;
    }
    case 'ran':
      return `${run.detail ?? 'it ran'} · outputs kept`;
    case 'failed':
      return run.detail ?? 'it ended on an error';
    case 'stopped':
      return `${run.detail ?? 'stopped'} · the code is kept; run it again to carry on`;
    default:
      return 'nothing has run here in this browser';
  }
}
