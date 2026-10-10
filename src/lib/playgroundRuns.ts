// What the playgrounds are doing, from anywhere in the app: which one is
// running now and how far it has got, which can be picked back up (its
// kernel still holds its variables), and how the last run of each ended.
//
// Each playground has its own kernel session in src/lib/colab.ts — its own
// Python, on its own machine — and the sessions run side by side, outside
// React, so a run goes on when its page is left and while others run. What
// the colab store does not keep is how a run that is over ended once the page
// is reloaded, nor what runs in a playground's terminals or agents. This
// module watches the sessions and those, keeps the last outcome of each
// playground in this browser, and says when a run ends, for a toast.
//
// What the page shows of it — a shelf on the Playground's home, a dock on
// every page, a switcher on P, tabs — is the person's choice: Settings →
// Running playgrounds (settings.runningShows), drawn by
// src/components/PlaygroundRuns.tsx.

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CellRun, ColabState, Output } from './colab';
import { backendLabel, colabNow, keptKernelFor, machineLabel, PAGES, sessionsNow, shutDownScope, stopRunsIn, stripAnsi, subscribeColab } from './colab';
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
  /** The kernel session (colab.ts) it is running or idle in, when it is connected. */
  session?: string;
  /** What else runs for it at the same time: its terminals' commands, its agents. */
  also?: string[];
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
/** The playgrounds whose page is open now (one, or none). */
const mounted = new Set<string>();
/** Playgrounds opened in this tab, for the tabs: newest last. */
let tabs: string[] = readJson(session(), TABS_KEY, []);

/**
 * What else runs for a playground besides its cells: a command in one of its
 * terminals, a coding agent at work. Reported by whatever follows it
 * (src/lib/terminalWatch.ts, the agent panes); shown, stopped and toasted as
 * a cell's run is.
 */
export interface SideJob {
  /** Unique within its playground: "terminal:<name>", "agent:claude". */
  id: string;
  playgroundId: string;
  kind: 'terminal' | 'agent';
  /** What it is doing, in a few words: "terminal · python train.py", "Claude Code · working". */
  label: string;
  busy: boolean;
  /** The last line it printed. */
  tail?: string;
  /** When what it is doing began. */
  since?: number;
  /** Stops what it is doing: Ctrl-C to a terminal, the agent's job ended. */
  stop?: () => void | Promise<void>;
}
const sideJobs = new Map<string, SideJob>();
const jobKey = (playgroundId: string, id: string) => `${playgroundId}|${id}`;

/** The run going on in one session, from its first cell to its last: when it began, the keys it ran, and how many Run all queued. */
interface Batch {
  id: string;
  startedAt: number;
  keys: string[];
  total: number;
}
const batches = new Map<string, Batch>();

let version = 0;
const listeners = new Set<() => void>();
const bump = () => {
  version += 1;
  listeners.forEach((listener) => listener());
};
const ended = new Set<(event: RunEnded) => void>();
const say = (event: RunEnded) => ended.forEach((listener) => listener(event));

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

/** A terminal or an agent says what it is doing; when it was busy and is not any more, that run has ended. */
export function reportJob(job: SideJob) {
  const key = jobKey(job.playgroundId, job.id);
  const before = sideJobs.get(key);
  sideJobs.set(key, job);
  if (before?.busy && !job.busy) {
    const p = playgroundById(job.playgroundId);
    const at = Date.now();
    const detail = `${before.label} ended`;
    outcomes = { ...outcomes, [job.playgroundId]: { phase: 'ran', at, detail, where: p ? whereOf(p) : '' } };
    writeJson(local(), OUTCOMES_KEY, outcomes);
    if (p) say({ id: p.id, title: p.title, phase: 'ran', detail, at });
  }
  bump();
}
export function clearJob(playgroundId: string, id: string) {
  if (sideJobs.delete(jobKey(playgroundId, id))) bump();
}
/** The terminals and agents of a playground busy now. */
export const busyJobs = (playgroundId: string): SideJob[] => [...sideJobs.values()].filter((job) => job.playgroundId === playgroundId && job.busy);

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

const liveStatus = (s: ColabState) => s.status === 'idle' || s.status === 'busy';
const kernelRunning = (s: ColabState) => Boolean(s.running || s.queue.length);

/** Where a playground stands now: its sessions (a kernel on each machine it has run on in this tab), its terminals and agents, its last outcome. */
export function runOf(p: Playground, all: ColabState[] = sessionsNow()): PlaygroundRun {
  const base = { id: p.id, title: p.title, kind: p.kind, where: whereOf(p) };
  const mine = all.filter((s) => s.scope === p.id);
  const jobs = busyJobs(p.id);
  const live = mine.find(kernelRunning) ?? mine.find((s) => s.status === 'connecting');
  if (live) {
    const key = live.running ?? live.queue[0];
    const run = live.running ? live.runs[live.running] : undefined;
    const tail = run ? tailOf(run.outputs) : undefined;
    const batch = batches.get(live.id);
    const total = batch?.total ?? 0;
    const done = total ? total - live.queue.length - (live.running ? 1 : 0) : 0;
    const { label, code } = key ? describeKey(p, key) : { label: 'connecting', code: undefined };
    return {
      ...base,
      where: live.runtime ? backendLabel(live.backend, live.runtime) : base.where,
      phase: live.paused && !live.running ? 'paused' : live.status === 'connecting' && !live.running ? 'connecting' : 'running',
      label,
      code,
      tail,
      progress: total > 1 ? Math.max(0, done) / total : progressIn(tail),
      startedAt: batch?.startedAt ?? run?.startedAt,
      queued: live.queue.length,
      session: live.id,
      also: jobs.map((job) => job.label),
    };
  }
  if (jobs.length) {
    const job = jobs[0];
    return { ...base, phase: 'running', label: job.label, tail: job.tail, progress: progressIn(job.tail), startedAt: job.since, also: jobs.slice(1).map((other) => other.label) };
  }
  const outcome = outcomes[p.id];
  const held = mine.find((s) => liveStatus(s) && s.kernel);
  if (held) return { ...base, where: held.runtime ? backendLabel(held.backend, held.runtime) : base.where, phase: 'idle', at: outcome?.at, detail: outcome?.detail, last: outcome?.phase, session: held.id };
  // Its page closed and its kernel let go, but kept on its server: opening it goes back to the same variables.
  if (p.compute.kind === 'server' && keptKernelFor(p.compute.serverId, p.id)) return { ...base, phase: 'idle', at: outcome?.at, detail: outcome?.detail, last: outcome?.phase };
  if (outcome) return { ...base, phase: outcome.phase, at: outcome.at, detail: outcome.detail, where: outcome.where || base.where };
  return { ...base, phase: 'never' };
}

/** Every playground's standing, the ones that need a look first: running, then idle with a kernel, then the rest, newest first. */
export function boardOf(list: Playground[], all: ColabState[] = sessionsNow()): PlaygroundRun[] {
  const rank: Record<RunPhase, number> = { running: 0, connecting: 0, paused: 1, idle: 2, failed: 3, ran: 4, stopped: 4, never: 5 };
  return list
    .map((p) => ({ run: runOf(p, all), updated: p.updated }))
    .sort((a, b) => rank[a.run.phase] - rank[b.run.phase] || Math.max(b.run.at ?? 0, b.updated) - Math.max(a.run.at ?? 0, a.updated))
    .map(({ run }) => run);
}

export const isLive = (run: Pick<PlaygroundRun, 'phase'>) => run.phase === 'running' || run.phase === 'paused' || run.phase === 'connecting';

// ------------------------------------------------- watching colab ----

/** Ends a session's batch: its outcome kept, a toast said. */
function finish(s: ColabState, done: Batch) {
  batches.delete(s.id);
  const p = playgroundById(done.id);
  const list = done.keys.map((key) => s.runs[key]).filter((run): run is CellRun => Boolean(run));
  // Stop interrupts the cell, and Python answers with a KeyboardInterrupt: that is a stop, not a failure.
  const interrupted = (run: CellRun) => run.outputs.some((output) => output.type === 'error' && output.ename === 'KeyboardInterrupt');
  const failed = list.some((run) => run.state === 'failed' && !interrupted(run));
  // A run left 'running' had its kernel closed under it.
  const stopped = list.some((run) => run.state === 'interrupted' || run.state === 'running' || run.stale || interrupted(run));
  const phase: Outcome['phase'] = failed ? 'failed' : stopped ? 'stopped' : 'ran';
  const detail = detailOf(list, phase);
  const at = Date.now();
  outcomes = { ...outcomes, [done.id]: { phase, at, detail, where: list[list.length - 1]?.where ?? '' } };
  writeJson(local(), OUTCOMES_KEY, outcomes);
  if (p) say({ id: p.id, title: p.title, phase, detail, at });
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

const previous = new Map<string, ColabState>();
let previousRuns: ColabState['runs'] = {};
function onColab() {
  const all = sessionsNow();
  for (const state of all) {
    if (state.scope === PAGES) continue;
    const before = previous.get(state.id);
    previous.set(state.id, state);
    let batch = batches.get(state.id);
    const begin = () => (batch ??= (batches.set(state.id, { id: state.scope, startedAt: Date.now(), keys: [], total: 0 }), batches.get(state.id)!));
    // Run all marks every cell queued at once, before the first runs: that is how many there are.
    if (state.queue.length > (before?.queue.length ?? 0)) {
      const now = begin();
      now.total = now.keys.length + state.queue.length;
    }
    if (state.running && before?.running !== state.running) {
      const now = begin();
      if (!now.keys.includes(state.running)) now.keys.push(state.running);
    }
    if (batch && !state.running && !state.queue.length && !state.paused) finish(state, batch);
  }
  const runs = all[0]?.runs ?? {};
  if (runs !== previousRuns) {
    for (const [key, run] of Object.entries(runs)) if (previousRuns[key] !== run) keepOutputs(key, run);
    previousRuns = runs;
  }
  bump();
}

/** On Colab: a playground's kernel left idle longer than it asks is shut down — the runtime stopped when it is the last — its page open or not. */
function idleCheck() {
  for (const state of sessionsNow()) {
    if (state.scope === PAGES || state.status !== 'idle' || state.backend.kind !== 'colab' || mounted.has(state.scope)) continue;
    const p = playgroundById(state.scope);
    if (!p || p.compute.kind !== 'colab' || !p.idleStopMin) continue;
    const since = Math.max(outcomes[p.id]?.at ?? 0, state.startedAt ?? 0);
    if (since && Date.now() - since > p.idleStopMin * 60_000) void shutDownScope(p.id);
  }
}

let watching = 0;
let stopWatch: (() => void) | null = null;
/** Starts watching (once, however many call it); the function given back stops it when the last caller is done. */
export function watchPlaygroundRuns(): () => void {
  watching += 1;
  if (watching === 1) {
    for (const state of sessionsNow()) previous.set(state.id, state);
    previousRuns = colabNow().runs;
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

/** Stops what a playground is running: its kernels' runs (Run all's queue dropped, the cell interrupted), its terminals' commands, its agents' jobs. */
export async function stopPlayground(id: string): Promise<void> {
  const work: Promise<unknown>[] = [];
  for (const state of sessionsNow()) if (state.scope === id && kernelRunning(state)) work.push(stopRunsIn(state.id));
  for (const job of busyJobs(id)) if (job.stop) work.push(Promise.resolve(job.stop()));
  await Promise.all(work);
}

/** Shuts down the kernel a playground holds, connected or kept: its variables go; on Colab the runtime stops when it is the last. */
export async function shutDownPlayground(id: string): Promise<void> {
  const p = playgroundById(id);
  if (!p) return;
  await shutDownScope(id, p.compute.kind === 'server' ? serverById(p.compute.serverId) : undefined);
  bump();
}

// --------------------------------------------------------- hooks ----

const versionNow = () => version;

/** Every playground's standing, kept current; re-read each second while something runs, for the clocks. */
export function useRunBoard(list: Playground[]): PlaygroundRun[] {
  useSyncExternalStore(subscribeRuns, versionNow);
  const all = useSyncExternalStore(subscribeColab, sessionsNow);
  const board = boardOf(list, all);
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
