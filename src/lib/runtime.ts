// ===========================================================================
//  The Runtime pane's sums: what the samples of the last while look like as
//  a timeline, which cells ran when along it, how much of the session and
//  of the compute units is left, and where the plan's needs sit on the
//  meters. Pure functions over the Colab store's state, for the tests; the
//  pane itself is src/components/RuntimePane.tsx.
// ===========================================================================

import type { Accelerator, CellRun } from './colab';
import { colabMachine } from './colabRun';
import { gpuById } from './hardware';
import type { Compute } from './hardware';
import type { MachineSample, Series } from './telemetry';

export interface Sampled {
  at: number;
  sample: MachineSample;
}

/** The longest one session runs on the machine, in hours: Colab's cap for it. */
export const sessionCapHours = (accelerator: Accelerator | null | undefined): number => gpuById(colabMachine(accelerator).gpu).sessionHours ?? 12;

/** How much of the session is gone and left, against Colab's cap for the machine. */
export function sessionLeft(accelerator: Accelerator | null | undefined, startedAt: number | undefined, now: number): { capHours: number; usedMs: number; leftMs: number; share: number } {
  const capHours = sessionCapHours(accelerator);
  const usedMs = startedAt ? Math.max(0, now - startedAt) : 0;
  const leftMs = Math.max(0, capHours * 3_600_000 - usedMs);
  return { capHours, usedMs, leftMs, share: Math.min(1, usedMs / (capHours * 3_600_000)) };
}

/** Hours left in the compute units at the rate they are going, or null when Colab said nothing, or the machine costs none. */
export function unitsLeft(units: { balance?: number; ratePerHour?: number } | undefined): number | null {
  if (!units || units.balance === undefined || !units.ratePerHour || units.ratePerHour <= 0) return null;
  return units.balance / units.ratePerHour;
}

/** "3 h 12 min", "48 min", "under a minute". */
export function spanText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

/**
 * The timeline: the samples of the last `windowMs`, as series over minutes
 * before now (−10 … 0), one chart for use and one for memory, each with
 * only the lines the samples have. Empty series are left out.
 */
export function timeline(history: Sampled[], now: number, windowMs: number): { use: Series[]; memory: Series[]; from: number } {
  const from = now - windowMs;
  const recent = history.filter((entry) => entry.at >= from);
  const minutes = (at: number) => Math.round(((at - now) / 60_000) * 100) / 100;
  const line = (name: string, pick: (sample: MachineSample) => number | undefined): Series | null => {
    const points = recent.flatMap((entry) => {
      const y = pick(entry.sample);
      return y === undefined ? [] : [{ x: minutes(entry.at), y }];
    });
    return points.length ? { name, stepped: true, points } : null;
  };
  const use = [line('GPU', (s) => s.gpu?.util), line('CPU', (s) => s.cpu)].filter((s): s is Series => Boolean(s));
  const memory = [line('VRAM', (s) => (s.gpu ? s.gpu.memUsedMb / 1024 : undefined)), line('RAM', (s) => (s.ramUsedMb === undefined ? undefined : s.ramUsedMb / 1024))].filter((s): s is Series => Boolean(s));
  return { use, memory, from };
}

export interface RulerSegment {
  key: string;
  /** Minutes before now, negative, clipped to the window. */
  start: number;
  end: number;
  state: CellRun['state'];
  live: boolean;
}

/** Which cells ran when, along the timeline's window: one segment a run, clipped to the window, newest last. */
export function rulerSegments(runs: Record<string, CellRun>, now: number, windowMs: number): RulerSegment[] {
  const from = now - windowMs;
  const minutes = (at: number) => Math.round(((at - now) / 60_000) * 100) / 100;
  return Object.entries(runs)
    .map(([key, run]) => {
      const live = run.state === 'running' || run.state === 'queued';
      const endAt = live ? now : run.startedAt + (run.ms ?? 0);
      return { key, startAt: run.startedAt, endAt, state: run.state, live };
    })
    .filter((run) => run.startAt > 0 && run.endAt >= from)
    .sort((a, b) => a.startAt - b.startAt)
    .map((run) => ({ key: run.key, start: minutes(Math.max(from, run.startAt)), end: minutes(Math.min(now, Math.max(run.endAt, run.startAt + 1_000))), state: run.state, live: run.live }));
}

/** The plan's needs, for the ticks on the meters: the least accelerator memory a faithful configuration needs, and the system memory. */
export function needMarkers(compute: Compute | null | undefined): { vramGb?: number; ramGb?: number } {
  if (!compute) return {};
  const vramGb = compute.minVramGb ?? (Math.max(0, ...compute.phases.map((phase) => phase.memoryGb ?? 0)) || undefined);
  return { vramGb, ramGb: compute.ramGb };
}

/** Whether a meter is near its top: nine tenths and over. */
export const nearFull = (used: number | undefined, total: number | undefined) => used !== undefined && total !== undefined && total > 0 && used / total >= 0.9;
