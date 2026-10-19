// ===========================================================================
//  The Sim pane's reading of a simulation run: the events.jsonl that
//  koios_telemetry.Run writes (src/sim/koios_telemetry.py) parsed into
//  episodes, numbers, videos, world-model dreams and notes, and the same
//  diagnostics its `summary` prints (the rule ids match, and the tests run
//  both on one run).
//
//  Everything is read on the machine, through the runtime's small second
//  kernel (runQuietly), so it works on Colab, whose ports the page can't
//  reach, and nothing has to be synced first: a listing of the runs, then
//  the focused run's file from the byte where the last read stopped, so a
//  long run costs only its new lines. Videos come over in chunks of base64
//  and play from a blob, so the sync's 2 MB text limit never applies.
// ===========================================================================

import { runQuietly } from './colab';
import type { Point, Series } from './telemetry';
import { downsample } from './telemetry';

export interface RunMeta {
  id?: string;
  name?: string;
  sim?: string | null;
  config?: Record<string, unknown>;
  started?: number;
  ended?: number;
  status?: string;
  error?: string;
  host?: { python?: string; platform?: string; machine?: string; gpu?: string | null; colab?: boolean };
}

export interface Episode {
  step: number;
  ret: number;
  length?: number;
  success?: boolean;
}

export interface Media {
  step: number;
  name: string;
  /** From the run's folder: media/rollout-….mp4 */
  path: string;
  type: 'video' | 'gif' | 'image' | 'frames';
  caption?: string;
  bytes?: number;
}

export interface Dream {
  step: number;
  name: string;
  path: string | null;
  type: Media['type'] | null;
  /** The prediction error at each step of the rollout. */
  error: number[];
  /** How many first frames were given rather than predicted. */
  context: number;
}

export interface Note {
  step: number;
  text: string;
  by: string;
  tag?: string;
  t: number;
}

export type RunStatus = 'running' | 'finished' | 'crashed' | 'stopped';

/** A formal evaluation, as `run.evaluation(...)` logs it: the paper's own measure, with the paper's numbers beside ours when given. */
export interface Evaluation {
  step: number;
  name: string;
  metrics: Record<string, number>;
  episodes?: number;
  /** How it was measured, in words: episodes, seeds, deterministic, which checkpoint. */
  protocol?: string;
  /** The paper's numbers for the same metrics. */
  paper?: Record<string, number>;
  /** Where in the paper (a table, a figure). */
  source?: string;
  higherIsBetter?: Record<string, boolean> | boolean;
  t: number;
}

/** Whether more of a metric is better, from what the run said, else from its name. */
export function higherIsBetter(name: string, said: Evaluation['higherIsBetter']): boolean {
  if (typeof said === 'boolean') return said;
  if (said && name in said) return said[name];
  return !/loss|error|distance|cost|regret|time|steps_to|latency|mse|rmse|mae/i.test(name);
}

export interface EvaluationRow {
  metric: string;
  ours: number;
  paper?: number;
  /** Ours against the paper's: the difference, as a share of the paper's, and whether that is the better way. */
  delta?: { abs: number; pct: number | null; better: boolean | null };
}

/** An evaluation as rows for a table: each metric, ours, the paper's, and the gap. */
export function evaluationRows(ev: Pick<Evaluation, 'metrics' | 'paper' | 'higherIsBetter'>): EvaluationRow[] {
  return Object.entries(ev.metrics).map(([metric, ours]) => {
    const paper = ev.paper?.[metric];
    if (paper === undefined || !Number.isFinite(paper) || !Number.isFinite(ours)) return { metric, ours, ...(paper !== undefined ? { paper } : {}) };
    const abs = ours - paper;
    const pct = paper === 0 ? null : (100 * abs) / Math.abs(paper);
    const up = higherIsBetter(metric, ev.higherIsBetter);
    return { metric, ours, paper, delta: { abs, pct, better: abs === 0 ? null : up ? abs > 0 : abs < 0 } };
  });
}

/** The latest evaluation of each name, in the order first seen. */
export function latestEvaluations(list: Evaluation[]): Evaluation[] {
  const byName = new Map<string, Evaluation>();
  for (const ev of list) byName.set(ev.name, ev);
  return [...byName.values()];
}

export interface AxisLabels {
  x?: string;
  y?: string;
}

export interface SimRun {
  /** The run's folder, from the project's. */
  dir: string;
  meta: RunMeta;
  scalars: Map<string, Point[]>;
  /** What each number's chart measures, from run.axes(): by the number's name, or by its prefix ("loss" for loss/policy). */
  axes: Map<string, AxisLabels>;
  /** The x axis's label for every chart that sets none of its own: run.axes(x=...), else "step". */
  xLabel?: string;
  episodes: Episode[];
  media: Media[];
  dreams: Dream[];
  notes: Note[];
  checkpoints: { step: number; path: string }[];
  evaluations: Evaluation[];
  /** The run's live 3D view (Rerun): a web viewer and a gRPC stream on the machine's ports, and scene.rrd in the run's folder. */
  live3d?: { grpcPort: number; webPort: number; /** Where the run streams scene.rrd as it grows (the port the page's viewer reads from). */ rrdPort?: number; rrd: string; sdk?: string };
  status: RunStatus;
  error?: string;
  firstT?: number;
  lastT?: number;
  step: number;
  sps?: number;
  /** Bytes of events.jsonl read so far. */
  offset: number;
  /** The file was too long to read from its start: only its last part is here. */
  truncated: boolean;
}

export const newRun = (dir: string, meta: RunMeta = {}): SimRun => ({ dir, meta, scalars: new Map(), axes: new Map(), episodes: [], media: [], dreams: [], notes: [], checkpoints: [], evaluations: [], status: (meta.status as RunStatus) ?? 'running', error: meta.error, step: 0, offset: 0, truncated: false });

/** A number as the module writes it: NaN and the infinities come as strings. */
export function valueOf(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (v === 'nan') return NaN;
  if (v === 'inf') return Infinity;
  if (v === '-inf') return -Infinity;
  return null;
}

const MAX_SCALAR_POINTS = 20_000;

/** New lines of events.jsonl, applied to a run in place. Lines that aren't JSON (a write cut short) are skipped. */
export function applyEvents(run: SimRun, text: string): SimRun {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const t = typeof e.t === 'number' ? e.t : undefined;
    if (t !== undefined) {
      run.firstT ??= t;
      run.lastT = t;
    }
    const step = typeof e.step === 'number' ? e.step : run.step;
    run.step = Math.max(run.step, step);
    switch (e.kind) {
      case 'start':
        run.status = 'running';
        run.error = undefined;
        break;
      case 'scalars':
        for (const [name, raw] of Object.entries((e.values as Record<string, unknown>) ?? {})) {
          const y = valueOf(raw);
          if (y === null) continue;
          let points = run.scalars.get(name);
          if (!points) run.scalars.set(name, (points = []));
          points.push({ x: step, y });
          // Long runs: every other point goes when there are too many, the newest always kept.
          if (points.length > MAX_SCALAR_POINTS) run.scalars.set(name, points.filter((_, i) => i % 2 === 0 || i === points!.length - 1));
        }
        break;
      case 'axes': {
        if (typeof e.x === 'string' && e.x.trim()) run.xLabel = e.x.trim();
        for (const [name, raw] of Object.entries((e.axes as Record<string, unknown>) ?? {})) {
          const said = typeof raw === 'string' ? { y: raw } : raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
          const labels: AxisLabels = { ...run.axes.get(name) };
          if (typeof said.y === 'string' && said.y.trim()) labels.y = said.y.trim();
          if (typeof said.x === 'string' && said.x.trim()) labels.x = said.x.trim();
          run.axes.set(name, labels);
        }
        break;
      }
      case 'episode': {
        const ret = valueOf(e.return);
        if (ret !== null) run.episodes.push({ step, ret, length: typeof e.length === 'number' ? e.length : undefined, success: typeof e.success === 'boolean' ? e.success : undefined });
        break;
      }
      case 'media':
        if (typeof e.path === 'string') run.media.push({ step, name: String(e.name ?? 'video'), path: e.path, type: (e.type as Media['type']) ?? 'video', caption: typeof e.caption === 'string' ? e.caption : undefined, bytes: typeof e.bytes === 'number' ? e.bytes : undefined });
        break;
      case 'dream':
        run.dreams.push({ step, name: String(e.name ?? 'dream'), path: typeof e.path === 'string' ? e.path : null, type: (e.type as Media['type']) ?? null, error: Array.isArray(e.error) ? e.error.map((x) => valueOf(x) ?? NaN) : [], context: typeof e.context === 'number' ? e.context : 0 });
        break;
      case 'note':
        run.notes.push({ step, text: String(e.text ?? ''), by: String(e.by ?? 'code'), tag: typeof e.tag === 'string' ? e.tag : undefined, t: t ?? 0 });
        break;
      case 'checkpoint':
        if (typeof e.path === 'string') run.checkpoints.push({ step, path: e.path });
        break;
      case 'evaluation': {
        const metrics: Record<string, number> = {};
        for (const [name, raw] of Object.entries((e.metrics as Record<string, unknown>) ?? {})) {
          const y = valueOf(raw);
          if (y !== null) metrics[name] = y;
        }
        const paper: Record<string, number> = {};
        let source: string | undefined;
        for (const [name, raw] of Object.entries((e.paper as Record<string, unknown>) ?? {})) {
          if (name === 'source') source = typeof raw === 'string' ? raw : undefined;
          else {
            const y = valueOf(raw);
            if (y !== null) paper[name] = y;
          }
        }
        const hib = e.higher_is_better;
        run.evaluations.push({
          step,
          name: String(e.name ?? 'eval'),
          metrics,
          episodes: typeof e.episodes === 'number' ? e.episodes : undefined,
          protocol: typeof e.protocol === 'string' ? e.protocol : undefined,
          paper: Object.keys(paper).length ? paper : undefined,
          source,
          higherIsBetter: typeof hib === 'boolean' ? hib : hib && typeof hib === 'object' ? Object.fromEntries(Object.entries(hib as Record<string, unknown>).map(([k, v]) => [k, Boolean(v)])) : undefined,
          t: t ?? 0,
        });
        break;
      }
      case 'heartbeat':
        if (typeof e.sps === 'number') run.sps = e.sps;
        break;
      case 'live3d':
        if (typeof e.grpc_port === 'number' && typeof e.web_port === 'number') run.live3d = { grpcPort: e.grpc_port, webPort: e.web_port, rrdPort: typeof e.rrd_port === 'number' ? e.rrd_port : undefined, rrd: typeof e.rrd === 'string' ? e.rrd : 'scene.rrd', sdk: typeof e.sdk === 'string' ? e.sdk : undefined };
        break;
      case 'end':
        run.status = (['finished', 'crashed', 'stopped'].includes(String(e.status)) ? e.status : 'finished') as RunStatus;
        run.error = typeof e.error === 'string' ? e.error : undefined;
        break;
    }
  }
  return run;
}

export const parseRun = (dir: string, meta: RunMeta, text: string) => applyEvents(newRun(dir, meta), text);

// --------------------------------------------------------------- series ----

const finite = (xs: number[]) => xs.filter((x) => Number.isFinite(x));
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** The running mean over the last `w` values, as the Python's _rolling. */
export function rolling(xs: number[], w: number): number[] {
  const out: number[] = [];
  let total = 0;
  xs.forEach((x, i) => {
    total += x;
    if (i >= w) total -= xs[i - w];
    out.push(total / Math.min(i + 1, w));
  });
  return out;
}

export const windowOf = (n: number) => Math.max(5, Math.floor(n / 10));

/** The episode returns as a chart's lines: each episode, and their running mean. */
export function returnSeries(run: SimRun): Series[] {
  const eps = run.episodes.filter((e) => Number.isFinite(e.ret));
  if (!eps.length) return [];
  const rolled = rolling(eps.map((e) => e.ret), windowOf(eps.length));
  return [
    { name: 'return', stepped: true, points: downsample(eps.map((e) => ({ x: e.step, y: e.ret }))) },
    { name: `mean of ${windowOf(eps.length)}`, stepped: true, points: downsample(eps.map((e, i) => ({ x: e.step, y: rolled[i] }))) },
  ];
}

/** Success rate over the last episodes, where the task reports success. */
export function successSeries(run: SimRun): Series[] {
  const eps = run.episodes.filter((e) => e.success !== undefined);
  if (eps.length < 2) return [];
  const rolled = rolling(eps.map((e) => (e.success ? 100 : 0)), windowOf(eps.length));
  return [{ name: 'success %', stepped: true, points: downsample(eps.map((e, i) => ({ x: e.step, y: rolled[i] }))) }];
}

export function lengthSeries(run: SimRun): Series[] {
  const eps = run.episodes.filter((e) => e.length !== undefined);
  if (eps.length < 2) return [];
  const rolled = rolling(eps.map((e) => e.length!), windowOf(eps.length));
  return [{ name: 'length', stepped: true, points: downsample(eps.map((e, i) => ({ x: e.step, y: rolled[i] }))) }];
}

/** A number's axis labels: its own, else its prefix's ("loss" labels loss/policy and loss/value), else the run's x. */
export function axesOf(run: SimRun, name: string): AxisLabels {
  const own = run.axes.get(name);
  const prefix = name.includes('/') ? run.axes.get(name.split('/')[0]) : undefined;
  return { x: own?.x ?? prefix?.x ?? run.xLabel, y: own?.y ?? prefix?.y };
}

/** The numbers logged with nothing saying what their y axis measures. */
export const unlabelled = (run: SimRun): string[] => Array.from(run.scalars.keys()).filter((name) => !axesOf(run, name).y);

/** The run's numbers as charts: those sharing a prefix (loss/policy, loss/value) together, four lines at most a chart, each with its axes' labels. */
export function scalarCharts(run: SimRun, filter = ''): { title: string; series: Series[]; xLabel: string; yLabel?: string }[] {
  const groups = new Map<string, string[]>();
  for (const name of run.scalars.keys()) {
    if (filter && !name.toLowerCase().includes(filter.toLowerCase())) continue;
    const prefix = name.includes('/') ? name.split('/')[0] : name;
    groups.set(prefix, [...(groups.get(prefix) ?? []), name]);
  }
  const out: { title: string; series: Series[]; xLabel: string; yLabel?: string }[] = [];
  for (const [prefix, names] of groups) {
    // A prefix's names share a chart only in fours, and only while their sizes are close: SB3 logs
    // train/value_loss (~1000) and train/learning_rate (0.0003) under one prefix, and on one chart only the big
    // one can be read.
    const parts: string[][] = [];
    for (const name of names) {
      const size = magnitude(run.scalars.get(name)!);
      const last = parts[parts.length - 1];
      if (last && last.length < 4 && last.every((other) => sameScale(size, magnitude(run.scalars.get(other)!)))) last.push(name);
      else parts.push([name]);
    }
    parts.forEach((part, index) => {
      // A chart's labels are its numbers' when they agree, else left to the legend.
      const labels = part.map((name) => axesOf(run, name));
      const same = (key: keyof AxisLabels) => (labels.every((l) => l[key] === labels[0][key]) ? labels[0][key] : undefined);
      out.push({
        xLabel: same('x') ?? 'step',
        yLabel: same('y'),
        title: part.length === 1 ? part[0] : `${prefix}${parts.length > 1 ? ` (${index + 1})` : ''}`,
        series: part.map((name) => ({ name: part.length === 1 ? name : name.slice(prefix.length + 1) || name, stepped: true, points: downsample(run.scalars.get(name)!.filter((p) => Number.isFinite(p.y))) })).filter((s) => s.points.length),
      });
    });
  }
  return out.filter((chart) => chart.series.length);
}

/** How big a series is: the largest |y| it reaches, 0 for one that never leaves zero. */
const magnitude = (points: Point[]) => Math.max(0, ...points.map((p) => Math.abs(p.y)).filter(Number.isFinite));
/** Whether two sizes can share one y axis: both zero, or within a factor of twenty (past that the smaller is a flat line). */
const sameScale = (a: number, b: number) => (a === 0 && b === 0) || (a > 0 && b > 0 && Math.max(a, b) / Math.min(a, b) <= 20);

/** A dream's error over its horizon, and every dream's mean error over training. */
export function dreamSeries(dream: Dream): Series[] {
  return [{ name: 'error', stepped: true, points: dream.error.map((y, i) => ({ x: i + 1, y })).filter((p) => Number.isFinite(p.y)) }];
}

export function dreamTrend(run: SimRun): Series[] {
  const points = run.dreams.map((d) => ({ x: d.step, y: mean(finite(d.error.slice(d.context))) })).filter((p) => Number.isFinite(p.y));
  return points.length >= 2 ? [{ name: 'mean error', stepped: true, points }] : [];
}

// ------------------------------------------------------------ diagnoses ----

export interface Finding {
  id: 'crashed' | 'stalled' | 'nan' | 'improving' | 'no-learning' | 'collapse' | 'entropy-collapse' | 'loss-explode' | 'dream-drift' | 'dream-stuck' | 'no-episodes' | 'unlabelled';
  level: 'error' | 'warn' | 'info';
  title: string;
  detail: string;
  try: string;
}

const VALUE_LOSS = /(value|critic|vf|q)[ _/-]?loss|loss[ _/-]?(value|critic|vf|q)\b/i;
const g = (n: number) => Number(n.toPrecision(3)).toString();

/** What looks wrong, or right, in a run: the rules of koios_telemetry.diagnose, for the same run the same findings. `now` is the machine's clock. */
export function diagnose(run: SimRun, now: number): Finding[] {
  const out: Finding[] = [];
  const add = (id: Finding['id'], level: Finding['level'], title: string, detail: string, tip: string) => out.push({ id, level, title, detail, try: tip });
  if (run.status === 'crashed') {
    const last = (run.error ?? '').trim().split('\n').pop() || 'no traceback';
    add('crashed', 'error', 'The run crashed', last, 'Read the traceback in the run’s end event or the console; fix, then start again (or resume from the last checkpoint).');
  }
  if (run.status === 'running' && run.lastT && now - run.lastT > 120) {
    add('stalled', 'warn', 'No news from the run', `Nothing written for ${Math.floor(now - run.lastT)} s, not even a heartbeat.`, 'The process may have been killed (out of memory, the runtime stopped). Look at the console; resume from the last checkpoint.');
  }
  for (const [name, points] of run.scalars) {
    const bad = points.find((p) => !Number.isFinite(p.y));
    if (bad) {
      add('nan', 'error', `${name} became ${Number.isNaN(bad.y) ? 'NaN' : 'infinite'}`, `First at step ${bad.x}.`, 'Lower the learning rate, clip gradients, normalise observations and rewards, look for a log of zero or a division by a tiny std.');
      break;
    }
  }
  const returns = run.episodes.map((e) => e.ret).filter(Number.isFinite);
  const n = returns.length;
  if (n >= 30) {
    const q = Math.floor(n / 4);
    const first = mean(returns.slice(0, q));
    const last = mean(returns.slice(-q));
    const spread = std(returns) || 1e-9;
    if (last - first > 0.5 * spread) add('improving', 'info', 'Return is climbing', `Mean return ${g(first)} over the first quarter of episodes, ${g(last)} over the last.`, 'Keep going; compare against the paper’s or the env’s reported score to know how far there is to go.');
    else if (last - first < 0.1 * spread) add('no-learning', 'warn', 'Return isn’t improving', `Mean return ${g(first)} early, ${g(last)} lately, over ${n} episodes.`, 'Check the reward reaches the agent (sign, scale), that actions reach the env, the learning rate (try 3e-4), and that the policy isn’t deterministic from the start.');
  }
  if (n >= 40) {
    const w = windowOf(n);
    const rolled = rolling(returns, w);
    const best = Math.max(...rolled);
    const at = rolled.indexOf(best);
    const end = rolled[rolled.length - 1];
    if (at < rolled.length - w && best - end > 0.5 * (best - rolled[0]) && best - rolled[0] > 0.5 * (std(returns) || 1e-9)) {
      add('collapse', 'warn', 'Performance collapsed after peaking', `The rolling mean return peaked at ${g(best)} and is now ${g(end)}.`, 'Too large policy updates: lower the learning rate, tighten PPO’s clip or add a KL target, keep the best checkpoint.');
    }
  }
  for (const [name, points] of run.scalars) {
    const ys = points.map((p) => p.y).filter(Number.isFinite);
    if (ys.length < 10) continue;
    if (name.toLowerCase().includes('entropy')) {
      const early = mean(ys.slice(0, 3));
      const late = mean(ys.slice(-3));
      if (early > 0 && late < 0.05 * early) add('entropy-collapse', 'warn', `${name} collapsed`, `From ${g(early)} to ${g(late)}: the policy stopped exploring.`, 'Raise the entropy coefficient, lower the learning rate, or check the action distribution’s std isn’t being driven to zero.');
    }
    if (VALUE_LOSS.test(name)) {
      const early = median(ys.slice(0, 5).map(Math.abs));
      const late = mean(ys.slice(-3).map(Math.abs));
      if (early > 0 && late > 100 * early) add('loss-explode', 'warn', `${name} is exploding`, `From about ${g(early)} to ${g(late)}.`, 'Normalise or scale the rewards, clip the value loss, lower the critic’s learning rate, check the bootstrapping at truncation.');
    }
  }
  const dreams = run.dreams.filter((d) => d.error.length);
  if (dreams.length) {
    const latest = dreams[dreams.length - 1];
    const errors = latest.error.slice(latest.context).filter(Number.isFinite);
    if (errors.length >= 6) {
      const third = Math.floor(errors.length / 3);
      const a = mean(errors.slice(0, third));
      const b = mean(errors.slice(-third));
      if (a > 0 && b > 3 * a) add('dream-drift', b > 10 * a ? 'warn' : 'info', 'The world model drifts over the horizon', `Prediction error ${g(a)} in the first third of the rollout, ${g(b)} in the last.`, 'Errors compound when the model feeds on its own predictions: train with multi-step (latent overshooting) losses, imagine shorter horizons, or add stochastic latents.');
    }
  }
  if (dreams.length >= 4) {
    const means = dreams.map((d) => mean(d.error.filter(Number.isFinite)));
    if (mean(means.slice(-2)) >= 0.95 * mean(means.slice(0, 2))) add('dream-stuck', 'warn', 'The world model isn’t getting better', `Mean prediction error ${g(mean(means.slice(0, 2)))} in the first comparisons, ${g(mean(means.slice(-2)))} in the last.`, 'Check the model sees enough varied data (exploration), its capacity, its learning rate, and that the decoder’s loss isn’t dominating the dynamics loss.');
  }
  const bare = unlabelled(run);
  if (bare.length) {
    add('unlabelled', 'warn', `${bare.length === 1 ? 'A chart has' : `${bare.length} charts have`} no axis labels`, `Nothing says what ${bare.slice(0, 4).join(', ')}${bare.length > 4 ? ` and ${bare.length - 4} more` : ''} measure${bare.length === 1 ? 's' : ''}.`, 'Label them in the code: run.axes("name", y="what it measures, with units", x="what the step counts") — or run.axes(x="env steps") once for the whole run.');
  }
  if (!run.episodes.length && !run.dreams.length && run.scalars.size && run.firstT && (run.lastT ?? now) - run.firstT > 300) {
    add('no-episodes', 'info', 'No episodes logged', 'The run logs numbers but no episode has been reported.', 'Wrap the env with run.wrap(env) or call run.episode(return, length) when one ends, so returns can be judged.');
  }
  return out;
}

/** A run's status as shown: a run that says it is running but has written nothing for two minutes is stalled. */
export function shownStatus(status: string | undefined, lastWrite: number | undefined, now: number): RunStatus | 'stalled' {
  if ((status ?? 'running') === 'running' && lastWrite && now - lastWrite > 120) return 'stalled';
  return (['running', 'finished', 'crashed', 'stopped'].includes(status ?? '') ? status : 'running') as RunStatus;
}

// ---------------------------------------------------------- the machine ----

/** How much of a run's file one read brings: the rest comes on the next. */
export const READ_CAP = 1_500_000;

export interface RunListing {
  dir: string;
  meta: RunMeta;
  size: number;
  /** When events.jsonl was last written, machine seconds. */
  mtime: number;
}

export interface SimRead {
  /** The machine's clock, seconds: the runs' times are on it. */
  now: number;
  runs: RunListing[];
  /** The focused run's new text, from `from`, ending on a whole line. */
  focus?: { dir: string; from: number; to: number; text: string; size: number; truncated: boolean };
}

const py = (value: unknown) => JSON.stringify(JSON.stringify(value));

export const READ_CODE = (folder: string, focus: { dir: string; offset: number } | null) => String.raw`
import os, json, glob, time
root = os.path.abspath(${JSON.stringify(folder)})
focus = json.loads(${py(focus)})
CAP = ${READ_CAP}
out = {'now': time.time(), 'runs': []}
found = []
# Walked with the folders that can't hold a run pruned, and no deeper than six levels, so a project with a
# node_modules or a data/ folder of a million files costs nothing more than one without.
PRUNE = {'.git', '.reader', 'node_modules', 'wandb', 'data', 'datasets', '__pycache__', '.venv', 'venv', 'site-packages', '.ipynb_checkpoints'}
for here, dirs, files in os.walk(root):
    dirs[:] = [d for d in dirs if d not in PRUNE and not d.startswith('.')]
    if here[len(root):].count(os.sep) >= 6:
        dirs[:] = []
    if 'events.jsonl' in files:
        path = os.path.join(here, 'events.jsonl')
        try:
            found.append((os.path.getmtime(path), os.path.relpath(here, root), path))
        except OSError:
            pass
found.sort(reverse=True)
for mtime, rel, path in found[:40]:
    meta = {}
    try:
        with open(os.path.join(os.path.dirname(path), 'run.json')) as f:
            meta = json.load(f)
        meta.pop('argv', None)
    except Exception:
        pass
    out['runs'].append({'dir': rel, 'meta': meta, 'size': os.path.getsize(path), 'mtime': mtime})
    if focus and focus['dir'] == rel:
        size = os.path.getsize(path)
        start = focus['offset'] if focus['offset'] <= size else 0
        truncated = False
        if start == 0 and size > 4 * CAP:
            start, truncated = size - 4 * CAP, True
        with open(path, 'rb') as f:
            f.seek(start)
            chunk = f.read(CAP)
        if truncated:
            skip = chunk.find(b'\n') + 1
            chunk, start = chunk[skip:], start + skip
        cut = chunk.rfind(b'\n') + 1
        out['focus'] = {'dir': rel, 'from': start, 'to': start + cut, 'text': chunk[:cut].decode('utf-8', 'replace'), 'size': size, 'truncated': truncated}
print(json.dumps(out))
`;

/** The runs under a project's folder on the machine, and the focused one's new lines since `offset`. */
export async function readSimRuns(folder: string, focus: { dir: string; offset: number } | null, scope?: string): Promise<SimRead> {
  const answer = await runQuietly(READ_CODE(folder, focus), scope);
  if (!answer) throw new Error('The machine isn’t connected.');
  if (!answer.ok) throw new Error(answer.text.trim().split('\n').pop() || 'The runs couldn’t be read.');
  return JSON.parse(answer.text.trim().split('\n').pop() || '{"now":0,"runs":[]}') as SimRead;
}

/** Media bigger than this are not fetched: the pane says where the file is instead. */
export const MEDIA_LIMIT = 64 * 1024 * 1024;
const CHUNK = 2 * 1024 * 1024;

export const MEDIA_CODE = (folder: string, runDir: string, path: string, offset: number) => String.raw`
import os, json, base64
root = os.path.realpath(os.path.abspath(${JSON.stringify(folder)}))
p = os.path.realpath(os.path.join(root, ${JSON.stringify(runDir)}, ${JSON.stringify(path)}))
if not p.startswith(root + os.sep):
    raise SystemExit('outside the project')
size = os.path.getsize(p)
with open(p, 'rb') as f:
    f.seek(${offset})
    data = f.read(${CHUNK})
print(json.dumps({'size': size, 'data': base64.b64encode(data).decode()}))
`;

export const mimeOf = (path: string) => (/\.mp4$/i.test(path) ? 'video/mp4' : /\.webm$/i.test(path) ? 'video/webm' : /\.gif$/i.test(path) ? 'image/gif' : /\.png$/i.test(path) ? 'image/png' : /\.jpe?g$/i.test(path) ? 'image/jpeg' : 'application/octet-stream');

/** A run's video or image, fetched from the machine a chunk at a time, as a blob the page can play. */
export async function readMedia(folder: string, runDir: string, path: string, scope?: string, onProgress?: (done: number, size: number) => void, maxBytes = MEDIA_LIMIT): Promise<Blob> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let size = Infinity;
  while (offset < size) {
    const answer = await runQuietly(MEDIA_CODE(folder, runDir, path, offset), scope);
    if (!answer) throw new Error('The machine isn’t connected.');
    if (!answer.ok) throw new Error(answer.text.trim().split('\n').pop() || 'The file couldn’t be read.');
    const got = JSON.parse(answer.text.trim().split('\n').pop() || '{}') as { size: number; data: string };
    size = got.size;
    if (size > maxBytes) throw new Error(`${Math.round(size / 1048576)} MB is more than the ${Math.round(maxBytes / 1048576)} MB fetched; it is at ${runDir}/${path} on the machine.`);
    const bytes = Uint8Array.from(atob(got.data), (c) => c.charCodeAt(0));
    if (!bytes.length) break;
    parts.push(bytes);
    offset += bytes.length;
    onProgress?.(offset, size);
  }
  return new Blob(parts as BlobPart[], { type: mimeOf(path) });
}

// ----------------------------------------------------------------- live ----

/** The live view's newest frame: what the run said with it, and the JPEG when it is one the page has not had. */
export interface LiveFrame {
  /** The machine's clock now, and when the frame was written. */
  now: number;
  t?: number;
  step?: number;
  frame?: number;
  episode?: number;
  info?: Record<string, unknown>;
  /** Why the run could not render a frame for it. */
  error?: string;
  /** The JPEG, base64; left out when the frame is the one the page already has. */
  jpeg?: string;
}

/**
 * Asks the run for its live view and reads its newest frame: live.want touched (the run streams while it is fresh,
 * koios_telemetry.LIVE_FOR_S), then live.json, and live.jpg only when its frame is newer than `seen`.
 */
export const LIVE_CODE = (folder: string, runDir: string, seen: number) => String.raw`
import os, json, base64, time
root = os.path.realpath(os.path.abspath(${JSON.stringify(folder)}))
d = os.path.realpath(os.path.join(root, ${JSON.stringify(runDir)}))
if not d.startswith(root + os.sep):
    raise SystemExit('outside the project')
with open(os.path.join(d, 'live.want'), 'w') as f:
    f.write(str(time.time()))
out = {'now': time.time()}
try:
    with open(os.path.join(d, 'live.json')) as f:
        out.update(json.load(f))
except Exception:
    pass
if out.get('frame', 0) > ${seen}:
    try:
        with open(os.path.join(d, 'live.jpg'), 'rb') as f:
            out['jpeg'] = base64.b64encode(f.read()).decode()
    except Exception:
        pass
print(json.dumps(out))
`;

export async function readLive(folder: string, runDir: string, seen: number, scope?: string): Promise<LiveFrame> {
  const answer = await runQuietly(LIVE_CODE(folder, runDir, seen), scope);
  if (!answer) throw new Error('The machine isn’t connected.');
  if (!answer.ok) throw new Error(answer.text.trim().split('\n').pop() || 'The live view couldn’t be read.');
  return JSON.parse(answer.text.trim().split('\n').pop() || '{"now":0}') as LiveFrame;
}

// --------------------------------------------------------------- doctor ----

export interface Doctor {
  python: string;
  platform: string;
  colab: boolean;
  cpus: number | null;
  gpus: { name: string; memMb: number; driver: string }[];
  rtx: boolean;
  display: boolean;
  egl: boolean;
  osmesa: boolean;
  vulkan: boolean;
  java: boolean;
  ffmpeg: boolean;
  torch: boolean;
  jax: boolean;
  env: Record<string, string | null>;
  installed: Record<string, boolean>;
  render: { ok: boolean; text: string } | null;
  /** A small layer's time on one CPU thread and on torch's default pool, ms, and the faster. */
  torch_threads?: { ms: Record<string, number>; best: number };
}

/** Runs the telemetry module's doctor on the machine, from a copy written to a temporary file (the project may not have one). */
export const DOCTOR_CODE = (module: string) => String.raw`
import os, sys, json, tempfile, subprocess
d = tempfile.mkdtemp(prefix='koios-doctor-')
p = os.path.join(d, 'koios_telemetry.py')
with open(p, 'w') as f:
    f.write(json.loads(${py(module)}))
r = subprocess.run([sys.executable, p, 'doctor', '--json'], capture_output=True, text=True, timeout=180, cwd=d)
print((r.stdout or '').strip().splitlines()[-1] if r.returncode == 0 and r.stdout.strip() else json.dumps({'error': (r.stderr or r.stdout)[-800:]}))
`;

export async function runDoctor(module: string, scope?: string): Promise<Doctor> {
  const answer = await runQuietly(DOCTOR_CODE(module), scope);
  if (!answer) throw new Error('The machine isn’t connected.');
  if (!answer.ok) throw new Error(answer.text.trim().split('\n').pop() || 'The doctor couldn’t run.');
  const got = JSON.parse(answer.text.trim().split('\n').pop() || '{}') as Doctor & { error?: string };
  if (got.error) throw new Error(got.error);
  return got;
}
