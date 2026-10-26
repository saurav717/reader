// ===========================================================================
//  Studio — a page's process, walked step by step, full screen.
//
//  Most papers worth a Learn track have one process at their heart: a thing
//  that is changed by the same rule over and over — an image denoised a step
//  at a time, a token carried up through the layers, a belief corrected by
//  each new measurement. A Studio scene is that process as data: what is
//  carried (the state), what one step is called, a slot for each step with
//  what the state looks like there, the equation each lesson step pins, and
//  the numbers to read off along the way. The page lays the slots out in 3-D,
//  lifts the state off the first slot, carries it past the others, and sets
//  it down at the last — with the equation above and the readouts beside.
//
//  The block is written by the model with the page, as ```studio … ``` after
//  the figure of the process, or on request. Nothing in it is code and nothing
//  is markup: what each slot shows is a small grid of numbers, a density, or a
//  row of bars, so the scene is themed like a figure and can draw nothing a
//  figure could not. This module is the pure part — the spec, its parsing,
//  the frame at any point of the walk, and where the walk is — and the
//  drawing is src/components/Studio.tsx.
// ===========================================================================

import { parseSpace } from './studioSpace';
import type { StudioSpace } from './studioSpace';

export type ShowKind = 'grid' | 'noise' | 'density' | 'bars' | 'curve' | 'map' | 'points' | 'tokens' | 'graph';
export const SHOW_KINDS: ShowKind[] = ['grid', 'noise', 'density', 'bars', 'curve', 'map', 'points', 'tokens', 'graph'];

/** A point in the unit square: x to the right, y up. */
export type XY = [number, number];

/** A grid of values in 0–1, rows top to bottom. */
export type Grid = number[][];

/**
 * How the state is drawn at each slot. One entry per slot where a kind takes
 * a list; fewer than the slots is fine, the page spreads them and tweens
 * between (so a 1000-step process can be drawn from ten frames).
 */
export type StudioShow =
  // A picture of values: one grid per slot (a heat map, an attention row per head, a feature map).
  | { kind: 'grid'; frames: Grid[] }
  // A picture dissolving into noise or coming out of it: ONE base grid, and how much of it is noise at each slot (0 none, 1 all).
  | { kind: 'noise'; base: Grid; level: number[] }
  // A belief over one number: its mean and spread at each slot, both in 0–1, with an optional mark (a measurement, a target) at each.
  | { kind: 'density'; mean: number[]; spread: number[]; mark?: number[] }
  // A row of quantities at each slot: a loss and its terms, a softmax, the energy by mode.
  | { kind: 'bars'; values: number[][]; labels?: string[] }
  // A point on a landscape: the curve's heights over 0–1 (8 to 32 numbers, 0 low, 1 high) and where the state stands at each slot (x in 0–1). Gradient descent, annealing, a root finder.
  | { kind: 'curve'; values: number[]; at: number[]; labels?: string[] }
  // A point on a 2-D landscape: ONE grid of heights (0 low, 1 high) and where the state is at each slot (x, y in 0–1). The path so far is drawn. An optimiser on a loss surface, an agent on a grid, a trajectory.
  | { kind: 'map'; base: Grid; at: XY[] }
  // A set of points, one set per slot (the same count in each): where each is, and its group (0, 1, 2…) when they have one. k-means, particles, a swarm, embeddings moving.
  | { kind: 'points'; sets: XY[][]; groups?: number[] }
  // A row of tokens per slot, one marked: a sentence growing a token at a time, a string being parsed, a tape being read.
  | { kind: 'tokens'; rows: string[][]; mark?: number[] }
  // A graph: node positions, edges by index, a value per node per slot (0–1, drawn as the node's shade), and the node that is active at each slot. Message passing, PageRank, a shortest path, a spreading process.
  | { kind: 'graph'; nodes: XY[]; edges: [number, number][]; values: number[][]; active?: number[] };

export interface StudioStep {
  /** A short imperative: "Pick up the noise", "Carry it one slot". */
  title: string;
  /** The equation this step pins, as LaTeX without dollars. */
  equation?: string;
  /** One or two plain sentences on what to watch. */
  note?: string;
  /** Where in the walk the step begins, 0–1; spread evenly when none is given. */
  at?: number;
}

export interface StudioReadout {
  label: string;
  /** One value per slot; numbers are tweened between slots, strings switch. */
  values: (number | string)[];
  /** How many decimals a number shows. */
  decimals?: number;
}

export interface StudioSpec {
  /** What is carried: "the image x_t", "one token's vector", "the belief about x". */
  state: string;
  /** The room, when the scene is one (studioSpace.ts): things placed in 3-D, keyed by the slots. A scene has a show, a space, or both. */
  space?: StudioSpace;
  /** What one slot is: "step", "layer", "tick". */
  unit: string;
  /** The slots, first to last: a short label each ("t=1000", "layer 3", "t=0"). */
  slots: string[];
  /** The walk: the state standing on each slot. Absent when the scene is a space alone. */
  show?: StudioShow;
  steps: StudioStep[];
  readouts: StudioReadout[];
  /** Things to try, for the inspector. */
  tries: string[];
  /** A question the reader might ask, for the bar. */
  ask?: string;
}

/** What the prompt says about Studio scenes: the block, its JSON, and when a page gets one. Part of Learn's page instructions. */
export const STUDIO_FORMAT = `STUDIO — a page whose central idea is a PROCESS (one thing changed by the same rule, step after step: an image denoised a step at a
time, a token carried up through the layers, a belief corrected by each measurement, a state advanced by an integrator, a
population after each generation) gets ONE \`\`\`studio title="…"\` block, right after the figure that shows the process, holding ONE
JSON object. The page opens it full screen: the slots stand in a row in 3-D, the state is lifted off the first slot, carried past
each of the others and set down at the last, with the equation of the current step above and the numbers beside. For example:
{"state":"the image x_t","unit":"step",
 "slots":["t=1000","t=800","t=600","t=400","t=200","t=0"],
 "show":{"kind":"noise","base":[[0.9,0.9,0.8,0.9],[0.9,0.7,0.6,0.9],[0.3,0.3,0.3,0.4],[0.2,0.3,0.2,0.2]],"level":[1,0.9,0.7,0.45,0.2,0]},
 "steps":[{"title":"Pick up the noise","equation":"x_T \\\\sim \\\\mathcal{N}(0, I)","note":"No picture in it yet, only the shape."},
          {"title":"Carry it one step","equation":"x_{t-1} = \\\\tfrac{1}{\\\\sqrt{\\\\alpha_t}}\\\\big(x_t - \\\\tfrac{1-\\\\alpha_t}{\\\\sqrt{1-\\\\bar\\\\alpha_t}}\\\\,\\\\epsilon_\\\\theta(x_t,t)\\\\big) + \\\\sigma_t z","note":"One network call, one subtraction, a little fresh noise.","at":0.1},
          {"title":"Set it down as x_0","equation":"x_0 = (x_1 - \\\\sqrt{1-\\\\bar\\\\alpha_1}\\\\,\\\\epsilon_\\\\theta(x_1,1))/\\\\sqrt{\\\\bar\\\\alpha_1}","note":"No noise is added on the last step.","at":0.92}],
 "readouts":[{"label":"t","values":[1000,800,600,400,200,0]},{"label":"ᾱ_t","values":[0.002,0.05,0.26,0.62,0.9,1],"decimals":3}],
 "tries":["Walk two seeds side by side: same slots, different pictures."],
 "ask":"Why does the sky settle before the hills?"}
"state" is what is carried, in a few words; "unit" is what one slot is called; "slots" are 5 to 12 short labels, first to last.
"show" is how the state is drawn, and the kind MUST match what the state is — draw it the way the paper's own figure would:
- a picture of values → {"kind":"grid","frames":[grid,…]}: one small grid of 0–1 values per slot (4×4 to 12×12: a heat map, an
  attention row per head, a feature map, a cellular automaton's cells).
- a picture gaining or losing noise → {"kind":"noise","base":grid,"level":[…]}: ONE grid and how much of it is noise at each slot
  (1 at the start of a diffusion walk, 0 at the end; the reverse for the forward process).
- a point walking on a landscape (gradient descent, annealing, Newton's method, a root finder, a learning rate schedule) →
  {"kind":"curve","values":[…],"at":[…]}: the landscape's heights over 0–1 (8 to 32 numbers, 0 low, 1 high) and where the
  state stands at each slot (x in 0–1). The page draws the curve, the point, and the dots it left behind.
- a point walking on a 2-D landscape (an optimiser on a loss surface, an agent on a grid, a trajectory, a random walk) →
  {"kind":"map","base":grid,"at":[[x,y],…]}: ONE grid of heights and the position at each slot, both in 0–1. The path is drawn.
- many points moving (k-means and its centroids, particles, a swarm, embeddings pulled together, a population) →
  {"kind":"points","sets":[[[x,y],…],…],"groups":[…]}: one set of positions per slot, the same count in each, and each point's
  group number when they have one (drawn in a colour each).
- a sequence being built or read (a sentence growing a token at a time, autoregressive decoding, a parser, a tape, a proof
  step by step) → {"kind":"tokens","rows":[[…],…],"mark":[…]}: the tokens at each slot and which one to mark.
- a graph whose nodes change (message passing, PageRank, a shortest path, belief propagation, a rumour spreading, a GNN) →
  {"kind":"graph","nodes":[[x,y],…],"edges":[[i,j],…],"values":[[…],…],"active":[…]}: node positions in 0–1, edges by index,
  a value per node per slot (0–1, the node's shade) and the active node at each slot.
- a distribution over one number (a Kalman belief, a posterior narrowing, a bandit's estimate) → {"kind":"density","mean":[…],
  "spread":[…],"mark":[…]}: a bell per slot, all in 0–1, with an optional mark (a measurement, a target). A density is for a
  belief or a distribution ONLY — never for a point that moves, a picture, or a loss.
- a few quantities side by side (a loss and its terms, a softmax, energy by mode, a budget) → {"kind":"bars","values":[[…],…],
  "labels":[…]}: a row of numbers per slot.
Fewer frames than slots is fine: the page spreads them. "steps" are 3 to 5 lesson steps in the order of the walk, each with its
equation as LaTeX (no dollars; write a star as ^* or ^{\\star}, never \\*) and "at", where in the walk it begins (0–1). "readouts"
are 2 to 6 numbers to read at each slot, one value per slot. The grids are small and the numbers are plausible, not exact: the scene teaches the shape of the process, not its measurement.`;

// ---------------------------------------------------------------------------
// Reading the block
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter(isNum) : []);
const xys = (v: unknown): XY[] => (Array.isArray(v) ? v : []).map((pt) => (Array.isArray(pt) && pt.length >= 2 && isNum(pt[0]) && isNum(pt[1]) ? ([clamp01(pt[0]), clamp01(pt[1])] as XY) : null)).filter((pt): pt is XY => Boolean(pt));
const grid = (v: unknown): Grid | null => {
  if (!Array.isArray(v) || !v.length) return null;
  const rows = v.filter((row): row is number[] => Array.isArray(row) && row.length > 0 && row.every(isNum)).map((row) => row.map(clamp01));
  if (!rows.length) return null;
  // Ragged rows are padded with the row's last value, so every frame is a rectangle.
  const width = Math.max(...rows.map((row) => row.length));
  return rows.map((row) => (row.length === width ? row : [...row, ...Array<number>(width - row.length).fill(row[row.length - 1])]));
};

const readShow = (raw: unknown, slots: number): StudioShow | null => {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const kind = SHOW_KINDS.includes(s.kind as ShowKind) ? (s.kind as ShowKind) : null;
  if (kind === 'grid') {
    const frames = (Array.isArray(s.frames) ? s.frames : []).map(grid).filter((g): g is Grid => Boolean(g));
    return frames.length ? { kind, frames } : null;
  }
  if (kind === 'noise') {
    const base = grid(s.base);
    const level = nums(s.level).map(clamp01);
    if (!base) return null;
    return { kind, base, level: level.length ? level : Array.from({ length: slots }, (_, i) => (slots > 1 ? 1 - i / (slots - 1) : 0)) };
  }
  if (kind === 'density') {
    const mean = nums(s.mean).map(clamp01);
    const spread = nums(s.spread).map((v) => clamp(v, 0.01, 1));
    if (!mean.length) return null;
    const mark = nums(s.mark).map(clamp01);
    return { kind, mean, spread: spread.length ? spread : mean.map(() => 0.2), ...(mark.length ? { mark } : {}) };
  }
  if (kind === 'bars') {
    const values = (Array.isArray(s.values) ? s.values : []).map(nums).filter((row) => row.length);
    if (!values.length) return null;
    const labels = Array.isArray(s.labels) ? s.labels.map(str).filter(Boolean) : [];
    return { kind, values, ...(labels.length ? { labels } : {}) };
  }
  if (kind === 'curve') {
    const values = nums(s.values).map(clamp01);
    const at = nums(s.at).map(clamp01);
    if (values.length < 2 || !at.length) return null;
    const labels = Array.isArray(s.labels) ? s.labels.map(str).filter(Boolean) : [];
    return { kind, values, at, ...(labels.length ? { labels } : {}) };
  }
  if (kind === 'map') {
    const base = grid(s.base);
    const at = xys(s.at);
    if (!base || !at.length) return null;
    return { kind, base, at };
  }
  if (kind === 'points') {
    const sets = (Array.isArray(s.sets) ? s.sets : []).map(xys).filter((set) => set.length);
    if (!sets.length) return null;
    const groups = nums(s.groups).map((g) => Math.max(0, Math.round(g)));
    return { kind, sets, ...(groups.length ? { groups } : {}) };
  }
  if (kind === 'tokens') {
    const rows = (Array.isArray(s.rows) ? s.rows : []).map((row) => (Array.isArray(row) ? row.map((t) => (isNum(t) ? String(t) : str(t))).filter(Boolean) : [])).filter((row) => row.length);
    if (!rows.length) return null;
    const mark = nums(s.mark).map((m) => Math.max(-1, Math.round(m)));
    return { kind, rows, ...(mark.length ? { mark } : {}) };
  }
  if (kind === 'graph') {
    const nodes = xys(s.nodes);
    if (nodes.length < 2) return null;
    const edges = (Array.isArray(s.edges) ? s.edges : [])
      .map((e) => (Array.isArray(e) && e.length === 2 && e.every(isNum) ? ([Math.round(e[0]), Math.round(e[1])] as [number, number]) : null))
      .filter((e): e is [number, number] => Boolean(e) && e![0] >= 0 && e![1] >= 0 && e![0] < nodes.length && e![1] < nodes.length && e![0] !== e![1]);
    const values = (Array.isArray(s.values) ? s.values : []).map((row) => nums(row).map(clamp01)).filter((row) => row.length);
    const active = nums(s.active).map((a) => Math.round(a));
    return { kind, nodes, edges, values: values.length ? values : [nodes.map(() => 0.5)], ...(active.length ? { active } : {}) };
  }
  return null;
};

/**
 * The block's JSON as a scene, or null when it is not one yet: half streamed,
 * or not a scene at all. Forgiving about a trailing comma, a fence left in
 * and a comment line, as motion.ts is; strict about the shape.
 */
export function parseStudio(text: string): StudioSpec | null {
  const body = text
    .replace(/^\s*```[^\n]*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1')
    .trim();
  if (!body.startsWith('{')) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const slots = (Array.isArray(o.slots) ? o.slots : []).map((v) => (isNum(v) ? String(v) : str(v))).filter(Boolean);
  if (slots.length < 2) return null;
  const show = readShow(o.show, slots.length);
  const space = parseSpace(o.space, (raw) => readShow(raw, slots.length));
  if (!show && !space) return null;
  const steps: StudioStep[] = (Array.isArray(o.steps) ? o.steps : [])
    .map((item): StudioStep | null => {
      if (!item || typeof item !== 'object') return null;
      const s = item as Record<string, unknown>;
      const title = str(s.title);
      if (!title) return null;
      const step: StudioStep = { title };
      // A `\*` is what the model writes for a star it meant to keep: LaTeX has no such command.
      if (str(s.equation)) step.equation = str(s.equation).replace(/\\\*/g, '*');
      if (str(s.note)) step.note = str(s.note);
      if (isNum(s.at)) step.at = clamp01(s.at);
      return step;
    })
    .filter((s): s is StudioStep => Boolean(s));
  if (!steps.length) steps.push({ title: `Walk ${str(o.state) || 'the state'} from ${slots[0]} to ${slots[slots.length - 1]}` });
  // Steps keep the order they were written in: an "at" that would run backwards is taken as unset.
  let last = -1;
  for (const step of steps) {
    if (step.at !== undefined && step.at <= last) delete step.at;
    if (step.at !== undefined) last = step.at;
  }
  const readouts: StudioReadout[] = (Array.isArray(o.readouts) ? o.readouts : [])
    .map((item): StudioReadout | null => {
      if (!item || typeof item !== 'object') return null;
      const r = item as Record<string, unknown>;
      const label = str(r.label);
      const values = (Array.isArray(r.values) ? r.values : []).filter((v): v is number | string => isNum(v) || typeof v === 'string');
      if (!label || !values.length) return null;
      const readout: StudioReadout = { label, values };
      if (isNum(r.decimals)) readout.decimals = clamp(Math.round(r.decimals), 0, 6);
      return readout;
    })
    .filter((r): r is StudioReadout => Boolean(r))
    .slice(0, 8);
  const tries = (Array.isArray(o.tries) ? o.tries : Array.isArray(o.try) ? o.try : []).map(str).filter(Boolean).slice(0, 4);
  return {
    state: str(o.state) || 'the state',
    unit: str(o.unit) || 'step',
    slots,
    ...(show ? { show } : {}),
    ...(space ? { space } : {}),
    steps: steps.slice(0, 8),
    readouts,
    tries,
    ...(str(o.ask) ? { ask: str(o.ask) } : {}),
  };
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/** How much of the walk the lift at either end takes. */
export const LIFT_SPAN = 0.06;

export interface Walk {
  /** Where the carried state is, in slots: 0 at the first slot, slots − 1 at the last. */
  position: number;
  /** The slot the state is at or has just left. */
  slot: number;
  /** The slot it is going to, the same as `slot` at the end. */
  next: number;
  /** How far from `slot` to `next`, 0–1. */
  between: number;
  phase: 'pickup' | 'carry' | 'setdown';
  /** How high the state is held, 0 on its stand, 1 fully lifted. */
  lift: number;
}

/** Where the walk is at a fraction `p` of it: which slot, how far to the next, and whether the state is being lifted, carried or set down. */
export function walkAt(p: number, slots: number): Walk {
  const u = clamp01(Number.isFinite(p) ? p : 0);
  const n = Math.max(1, slots);
  const position = u * (n - 1);
  const slot = Math.min(n - 1, Math.floor(position));
  const next = Math.min(n - 1, slot + 1);
  const between = next === slot ? 0 : position - slot;
  const phase: Walk['phase'] = u < LIFT_SPAN ? 'pickup' : u > 1 - LIFT_SPAN ? 'setdown' : 'carry';
  const lift = u < LIFT_SPAN ? u / LIFT_SPAN : u > 1 - LIFT_SPAN ? (1 - u) / LIFT_SPAN : 1;
  return { position, slot, next, between, phase, lift: clamp01(lift) };
}

/** The index of the lesson step the walk is on at `p`: the last whose start is at or before it. */
export function stepAt(spec: Pick<StudioSpec, 'steps'>, p: number): number {
  const starts = stepStarts(spec);
  let index = 0;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= clamp01(p)) index = i;
  return index;
}

/** Where each lesson step begins, 0–1: as written, with the unset ones spread evenly between their neighbours. */
export function stepStarts(spec: Pick<StudioSpec, 'steps'>): number[] {
  const n = spec.steps.length;
  const starts = spec.steps.map((step) => step.at);
  if (n) starts[0] = 0;
  for (let i = 0; i < n; i++) {
    if (starts[i] !== undefined) continue;
    let j = i;
    while (j < n && starts[j] === undefined) j++;
    const from = starts[i - 1] ?? 0;
    const to = j < n ? starts[j]! : 1;
    for (let k = i; k < j; k++) starts[k] = from + ((to - from) * (k - i + 1)) / (j - i + 1);
  }
  return starts.map((s) => s ?? 0);
}

// ---------------------------------------------------------------------------
// The frames
// ---------------------------------------------------------------------------

/** What the state looks like at one moment, ready to draw. */
export type Frame =
  | { kind: 'grid'; grid: Grid }
  | { kind: 'density'; mean: number; spread: number; mark?: number }
  | { kind: 'bars'; values: number[]; labels?: string[] }
  // The point on the curve now, and where it has been at the slots so far.
  | { kind: 'curve'; values: number[]; at: number; trail: number[]; labels?: string[] }
  | { kind: 'map'; grid: Grid; at: XY; trail: XY[] }
  | { kind: 'points'; points: XY[]; groups?: number[] }
  | { kind: 'tokens'; tokens: string[]; mark?: number }
  | { kind: 'graph'; nodes: XY[]; edges: [number, number][]; values: number[]; active?: number };

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

/** The entry of a per-slot list at a slot, when the list is shorter than the slots: spread over them. */
const spreadIndex = (length: number, slot: number, slots: number) => (length >= slots || slots < 2 ? Math.min(length - 1, slot) : Math.min(length - 1, Math.round((slot / (slots - 1)) * (length - 1))));

/** Of a per-slot list, the value just before and just after a position in slots, and how far between them. */
function around<T>(list: T[], position: number, slots: number): { a: T; b: T; u: number } {
  if (list.length >= slots) {
    const i = clamp(Math.floor(position), 0, list.length - 1);
    const j = clamp(i + 1, 0, list.length - 1);
    return { a: list[i], b: list[j], u: j === i ? 0 : clamp01(position - i) };
  }
  // Fewer entries than slots: the list is spread over the whole walk.
  const scaled = slots < 2 ? 0 : (position / (slots - 1)) * (list.length - 1);
  const i = clamp(Math.floor(scaled), 0, list.length - 1);
  const j = clamp(i + 1, 0, list.length - 1);
  return { a: list[i], b: list[j], u: j === i ? 0 : clamp01(scaled - i) };
}

const mixGrid = (a: Grid, b: Grid, u: number): Grid => {
  if (u <= 0 || a === b) return a;
  if (u >= 1) return b;
  const rows = Math.max(a.length, b.length);
  const cols = Math.max(a[0]?.length ?? 0, b[0]?.length ?? 0);
  const at = (g: Grid, r: number, c: number) => g[Math.min(r, g.length - 1)]?.[Math.min(c, (g[0]?.length ?? 1) - 1)] ?? 0;
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => lerp(at(a, r, c), at(b, r, c), u)));
};

/** A fixed, cheap pseudo-random in 0–1 for a cell and a seed: the same noise every time the frame is drawn. */
export function hash01(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** A grid with a share of its values replaced by noise: the signal scaled by √(1−level), the noise by √level, as a diffusion step mixes them. */
export function noised(base: Grid, level: number, seed = 1): Grid {
  const l = clamp01(level);
  if (l <= 0) return base;
  const keep = Math.sqrt(1 - l);
  const add = Math.sqrt(l);
  // Both parts are centred on mid-grey, so a fully noised frame is grey static and not a white-out.
  return base.map((row, y) => row.map((v, x) => clamp01(0.5 + keep * (v - 0.5) + add * (hash01(x, y, seed) - 0.5) * 1.4)));
}

/** The frame at a fraction `p` of the walk: the slot's picture, tweened toward the next. */
export function frameAt(spec: { show: StudioShow; slots: string[] }, p: number, seed = 1): Frame {
  const { position } = walkAt(p, spec.slots.length);
  const show = spec.show;
  const n = spec.slots.length;
  if (show.kind === 'grid') {
    const { a, b, u } = around(show.frames, position, n);
    return { kind: 'grid', grid: mixGrid(a, b, u) };
  }
  if (show.kind === 'noise') {
    const { a, b, u } = around(show.level, position, n);
    return { kind: 'grid', grid: noised(show.base, lerp(a, b, u), seed) };
  }
  if (show.kind === 'density') {
    const mean = around(show.mean, position, n);
    const spread = around(show.spread, position, n);
    const frame: Frame = { kind: 'density', mean: lerp(mean.a, mean.b, mean.u), spread: lerp(spread.a, spread.b, spread.u) };
    if (show.mark?.length) {
      const mark = around(show.mark, position, n);
      frame.mark = lerp(mark.a, mark.b, mark.u);
    }
    return frame;
  }
  if (show.kind === 'bars') {
    const { a, b, u } = around(show.values, position, n);
    const width = Math.max(a.length, b.length);
    return { kind: 'bars', values: Array.from({ length: width }, (_, i) => lerp(a[i] ?? 0, b[i] ?? 0, u)), ...(show.labels ? { labels: show.labels } : {}) };
  }
  // Where the state has stood at each slot passed so far: the dots left behind on the landscape.
  const passed = Math.floor(position + 1e-9);
  if (show.kind === 'curve') {
    const { a, b, u } = around(show.at, position, n);
    const trail = Array.from({ length: Math.min(passed + 1, n) }, (_, i) => around(show.at, i, n).a);
    return { kind: 'curve', values: show.values, at: lerp(a, b, u), trail, ...(show.labels ? { labels: show.labels } : {}) };
  }
  if (show.kind === 'map') {
    const { a, b, u } = around(show.at, position, n);
    const trail = Array.from({ length: Math.min(passed + 1, n) }, (_, i) => around(show.at, i, n).a);
    return { kind: 'map', grid: show.base, at: [lerp(a[0], b[0], u), lerp(a[1], b[1], u)], trail };
  }
  if (show.kind === 'points') {
    const { a, b, u } = around(show.sets, position, n);
    const count = Math.max(a.length, b.length);
    const points: XY[] = Array.from({ length: count }, (_, i) => {
      const from = a[i] ?? b[i];
      const to = b[i] ?? a[i];
      return [lerp(from[0], to[0], u), lerp(from[1], to[1], u)];
    });
    return { kind: 'points', points, ...(show.groups ? { groups: show.groups } : {}) };
  }
  if (show.kind === 'tokens') {
    // Tokens do not tween: the row switches at the midpoint, and the mark with it.
    const { a, b, u } = around(show.rows, position, n);
    const tokens = u < 0.5 ? a : b;
    const frame: Frame = { kind: 'tokens', tokens };
    if (show.mark?.length) {
      const mark = around(show.mark, position, n);
      const m = u < 0.5 ? mark.a : mark.b;
      if (m >= 0 && m < tokens.length) frame.mark = m;
    }
    return frame;
  }
  const { a, b, u } = around(show.values, position, n);
  const values = show.nodes.map((_, i) => lerp(a[i] ?? 0.5, b[i] ?? a[i] ?? 0.5, u));
  const frame: Frame = { kind: 'graph', nodes: show.nodes, edges: show.edges, values };
  if (show.active?.length) {
    const active = around(show.active, position, n);
    const node = u < 0.5 ? active.a : active.b;
    if (node >= 0 && node < show.nodes.length) frame.active = node;
  }
  return frame;
}

/** The frame exactly at a slot: what stands on its stand. */
export const frameAtSlot = (spec: { show: StudioShow; slots: string[] }, slot: number, seed = 1) => frameAt(spec, spec.slots.length < 2 ? 0 : clamp(slot, 0, spec.slots.length - 1) / (spec.slots.length - 1), seed);

/** The readouts at a fraction `p` of the walk, as text: numbers tweened between slots, strings taken from the nearer slot. */
export function readoutsAt(spec: Pick<StudioSpec, 'readouts' | 'slots'>, p: number): { label: string; value: string }[] {
  const { position } = walkAt(p, spec.slots.length);
  const n = spec.slots.length;
  return spec.readouts.map((readout) => {
    const { a, b, u } = around(readout.values, position, n);
    if (isNum(a) && isNum(b)) {
      const v = lerp(a, b, u);
      const decimals = readout.decimals ?? (Number.isInteger(a) && Number.isInteger(b) ? 0 : Math.max(2, Math.min(4, -Math.floor(Math.log10(Math.max(1e-9, Math.abs(v || 1)))) + 2)));
      return { label: readout.label, value: v.toFixed(decimals) };
    }
    return { label: readout.label, value: String(u < 0.5 ? a : b) };
  });
}

/** The density of a bell at `x` with the frame's mean and spread, scaled to 1 at the mean. */
export const bell = (frame: Extract<Frame, { kind: 'density' }>, x: number) => Math.exp(-((x - frame.mean) ** 2) / (2 * frame.spread * frame.spread));

/** The share of the slots this scene draws at a slot: what a short per-slot list contributes there (for the strip's labels). */
export const slotFrameIndex = (spec: { show: StudioShow; slots: string[] }, slot: number) => {
  const show = spec.show;
  const length =
    show.kind === 'grid' ? show.frames.length : show.kind === 'noise' ? show.level.length : show.kind === 'density' ? show.mean.length : show.kind === 'curve' || show.kind === 'map' ? show.at.length : show.kind === 'points' ? show.sets.length : show.kind === 'tokens' ? show.rows.length : show.values.length;
  return spreadIndex(length, slot, spec.slots.length);
};

// ---------------------------------------------------------------------------
// Asking for one, and saying what one is
// ---------------------------------------------------------------------------

/** The request that asks the model to add a Studio scene to a page: for the bar, and the page's button. */
export function studioRequest(title?: string): string {
  return `Add a studio block for this page${title ? ` (“${title}”)` : ''}: the process the page teaches, as the STUDIO format describes — its state, one slot per step, how the state looks at each, the equation each lesson step pins, and the numbers to read along the way. Put it right after the figure that shows the process.`;
}

/** A Studio scene as a line of text, for the notebook and for what the bar is told the page holds. */
export function studioText(title: string, spec: StudioSpec | null): string {
  if (!spec) return `[Studio scene${title ? `: ${title}` : ''}]`;
  const where = spec.space && !spec.show ? `in a 3-D space with ${spec.space.things.length} things` : `one ${spec.unit} at a time from ${spec.slots[0]} to ${spec.slots[spec.slots.length - 1]}`;
  return `[Studio scene${title ? `: ${title}` : ''} — ${spec.state}, ${where}: ${spec.steps.map((s) => s.title).join(' → ')}]`;
}
