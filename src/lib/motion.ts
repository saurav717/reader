// ===========================================================================
//  Motion — a scene: a section's figure with steps, drawn by the page.
//
//  Claude writes the explanation's figures as SVG. A scene is different: it
//  is a small JSON description of nodes (a stack of layers, a distribution, a
//  curve, a slider…), edges between them (a flow of packets, a comparison)
//  and steps (a caption each, with what to highlight, dim, show or change),
//  and the page lays it out, draws it and tweens from step to step. Nothing
//  in it is code and nothing is markup, so it is themed like a figure and
//  cannot draw anything a figure could not.
//
//  The block is written on request — "animate this figure" — right after the
//  figure it animates, and its steps are bound to the section's paragraphs
//  in order: the paragraph being read picks the step. This module is the
//  pure part: the spec, its parsing, the layout and the state at a step. The
//  drawing is src/components/Motion.tsx.
// ===========================================================================

export type Tone = 'accent' | 'blue' | 'yellow' | 'pink' | 'muted';
export type NodeKind = 'box' | 'input' | 'text' | 'stack' | 'dist' | 'curve' | 'grid' | 'slider' | 'timeline';
export const NODE_KINDS: NodeKind[] = ['box', 'input', 'text', 'stack', 'dist', 'curve', 'grid', 'slider', 'timeline'];
export const TONES: Tone[] = ['accent', 'blue', 'yellow', 'pink', 'muted'];

export type Values = number | number[] | number[][];

export interface MotionNode {
  id: string;
  kind: NodeKind;
  label?: string;
  /** The centre, in percent of the scene's width and height. Placed in a row when missing. */
  at?: [number, number];
  /** stack: how many layers. */
  layers?: number;
  /** stack: a network that is not trained here, drawn muted. */
  frozen?: boolean;
  /** dist and curve: the heights, any scale; grid: rows of cells in 0–1; slider: its value. */
  values?: Values;
  /** dist and curve: a name under each value; timeline: unused. */
  labels?: string[];
  min?: number;
  max?: number;
  /** timeline: what happened when. */
  events?: { at: number | string; label: string }[];
  /** Visible from this step on. */
  step?: number;
  tone?: Tone;
}

export interface MotionEdge {
  id?: string;
  from: string;
  to: string;
  /** Packets move along it, up the stacks or back down them. */
  flow?: 'forward' | 'backward';
  /** A comparison: dashed, with its label in a pill. */
  kind?: 'compare' | 'plain';
  label?: string;
  /** Visible from this step on. */
  step?: number;
  tone?: Tone;
}

export interface MotionStep {
  caption: string;
  highlight?: string[];
  dim?: string[];
  /** Ids shown from this step on, besides those with their own `step`. */
  show?: string[];
  /** "id.values", "id.value" or "id.label" (or just "id", meaning its values) set from this step on. */
  set?: Record<string, Values | string>;
  /** The paragraph of the section this step belongs to, counted from 0; in order when missing. */
  paragraph?: number;
}

export interface MotionSpec {
  nodes: MotionNode[];
  edges: MotionEdge[];
  steps: MotionStep[];
}

/** What the prompt says about scenes: the block, its JSON, and when to mark a figure as worth one. Shared by Explain's instructions and its revision requests. */
export const MOTION_FORMAT = `SCENES — a figure can be animated on request. A \`\`\`motion title="…" figure="<the caption of the figure it animates>\` block holds ONE JSON
object the page draws and plays; it has no SVG and no code. For example:
{"nodes":[{"id":"x","kind":"input","label":"x","at":[50,92]},
          {"id":"teacher","kind":"stack","label":"teacher","layers":6,"at":[28,52],"frozen":true,"tone":"blue"},
          {"id":"student","kind":"stack","label":"student","layers":3,"at":[72,58]},
          {"id":"p","kind":"dist","label":"softmax(z_T / T)","at":[28,12],"values":[0.7,0.2,0.1],"labels":["cat","dog","car"],"tone":"blue"},
          {"id":"q","kind":"dist","label":"softmax(z_S / T)","at":[72,20],"values":[0.4,0.3,0.3],"labels":["cat","dog","car"]}],
 "edges":[{"from":"x","to":"teacher","flow":"forward"},{"from":"x","to":"student","flow":"forward"},
          {"id":"kl","from":"p","to":"q","kind":"compare","label":"T²·KL","step":1},
          {"id":"back","from":"q","to":"student","flow":"backward","step":2}],
 "steps":[{"caption":"The same batch runs through both networks."},
          {"caption":"Only the two softened outputs are compared.","highlight":["p","q"]},
          {"caption":"Gradients reach the student only.","dim":["teacher"],"set":{"q.values":[0.65,0.22,0.13]}}]}
Node kinds: box, input, text, stack (layers), dist (values, labels), curve (values, labels), grid (values as rows of 0–1),
slider (min, max, values as the value, label), timeline (events: [{at, label}]). "at" is the centre in percent of the scene;
"tone" is accent (default), blue, yellow, pink or muted. An edge may have "flow" ("forward" or "backward": packets move along
it), "kind": "compare" (dashed, labelled) and "step" (visible from that step on). Each step is one paragraph of the section, in
order, with a one-sentence caption; "highlight", "dim" and "show" name ids; "set" changes a node's values, value or label from
that step on, and the page tweens it. Four to eight nodes and three to five steps is right; one scene per section at most.`;

/** The scene's drawing space: the same proportions as a figure in the margin. */
export const SCENE_W = 360;
export const SCENE_H = 250;

const asNumber = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const asString = (value: unknown) => (typeof value === 'string' ? value : undefined);
const asIds = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined);
const asValues = (value: unknown): Values | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (!Array.isArray(value)) return undefined;
  if (value.every((v) => typeof v === 'number')) return value as number[];
  if (value.every((v) => Array.isArray(v) && v.every((n: unknown) => typeof n === 'number'))) return value as number[][];
  return undefined;
};

/**
 * The block's JSON as a scene, or null when it is not one yet: half streamed,
 * or not JSON at all. Forgiving about what the model gets wrong most often — a
 * trailing comma, a fence left in, a comment line — and strict about the
 * shape, so the drawing never sees a node it cannot place.
 */
export function parseMotion(text: string): MotionSpec | null {
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
  const object = raw as Record<string, unknown>;
  const nodes: MotionNode[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(object.nodes) ? object.nodes : []) {
    if (!item || typeof item !== 'object') continue;
    const n = item as Record<string, unknown>;
    const id = asString(n.id)?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const kind = NODE_KINDS.includes(n.kind as NodeKind) ? (n.kind as NodeKind) : 'box';
    const at = Array.isArray(n.at) && n.at.length === 2 && n.at.every((v) => typeof v === 'number') ? ([clamp(n.at[0], 0, 100), clamp(n.at[1], 0, 100)] as [number, number]) : undefined;
    const node: MotionNode = { id, kind };
    const label = asString(n.label);
    if (label !== undefined) node.label = label;
    if (at) node.at = at;
    if (kind === 'stack') node.layers = Math.max(1, Math.min(12, Math.round(asNumber(n.layers, 3))));
    if (n.frozen === true) node.frozen = true;
    const values = asValues(n.values ?? n.value);
    if (values !== undefined) node.values = values;
    const labels = asIds(n.labels);
    if (labels) node.labels = labels;
    if (typeof n.min === 'number') node.min = n.min;
    if (typeof n.max === 'number') node.max = n.max;
    if (Array.isArray(n.events)) {
      node.events = n.events
        .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object')
        .map((e) => ({ at: typeof e.at === 'number' || typeof e.at === 'string' ? e.at : '', label: asString(e.label) ?? '' }))
        .filter((e) => e.label);
    }
    if (typeof n.step === 'number') node.step = Math.max(0, Math.round(n.step));
    if (TONES.includes(n.tone as Tone)) node.tone = n.tone as Tone;
    nodes.push(node);
  }
  if (!nodes.length) return null;
  const edges: MotionEdge[] = [];
  for (const item of Array.isArray(object.edges) ? object.edges : []) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const from = asString(e.from), to = asString(e.to);
    if (!from || !to || !seen.has(from) || !seen.has(to) || from === to) continue;
    const edge: MotionEdge = { from, to };
    const id = asString(e.id);
    if (id) edge.id = id;
    if (e.flow === 'forward' || e.flow === 'backward') edge.flow = e.flow;
    if (e.kind === 'compare' || e.kind === 'plain') edge.kind = e.kind;
    const label = asString(e.label);
    if (label) edge.label = label;
    if (typeof e.step === 'number') edge.step = Math.max(0, Math.round(e.step));
    if (TONES.includes(e.tone as Tone)) edge.tone = e.tone as Tone;
    edges.push(edge);
  }
  const steps: MotionStep[] = [];
  for (const item of Array.isArray(object.steps) ? object.steps : []) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const step: MotionStep = { caption: asString(s.caption) ?? '' };
    const highlight = asIds(s.highlight), dim = asIds(s.dim), show = asIds(s.show);
    if (highlight?.length) step.highlight = highlight;
    if (dim?.length) step.dim = dim;
    if (show?.length) step.show = show;
    if (s.set && typeof s.set === 'object') {
      const set: Record<string, Values | string> = {};
      for (const [key, value] of Object.entries(s.set as Record<string, unknown>)) {
        const values = asValues(value);
        if (values !== undefined) set[key] = values;
        else if (typeof value === 'string') set[key] = value;
      }
      if (Object.keys(set).length) step.set = set;
    }
    if (typeof s.paragraph === 'number') step.paragraph = Math.max(0, Math.round(s.paragraph));
    steps.push(step);
  }
  if (!steps.length) steps.push({ caption: '' });
  return { nodes, edges, steps: steps.slice(0, 12) };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Layout: where each node sits, in the scene's own units
// ---------------------------------------------------------------------------

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A node's size, by kind and by how much it holds. */
export function sizeOf(node: MotionNode): { w: number; h: number } {
  switch (node.kind) {
    case 'input':
      return { w: 22, h: 22 };
    case 'text':
      return { w: Math.min(SCENE_W, 14 + 6.2 * (node.label?.length ?? 4)), h: 16 };
    case 'stack':
      return { w: 72, h: (node.layers ?? 3) * 12 + ((node.layers ?? 3) - 1) * 4 };
    case 'dist': {
      const n = Math.max(1, Array.isArray(node.values) ? node.values.length : 3);
      return { w: Math.min(160, 20 * n + 12), h: 56 };
    }
    case 'curve':
      return { w: 124, h: 72 };
    case 'grid': {
      const rows = Array.isArray(node.values) ? node.values.length : 4;
      const cols = Array.isArray(node.values) && Array.isArray(node.values[0]) ? Math.max(...(node.values as number[][]).map((r) => r.length), 1) : rows;
      const cell = Math.min(16, 110 / Math.max(rows, cols, 1));
      return { w: cols * cell, h: rows * cell };
    }
    case 'slider':
      return { w: 120, h: 26 };
    case 'timeline':
      return { w: 300, h: 56 };
    default:
      return { w: Math.max(56, Math.min(170, 18 + 6.4 * (node.label?.length ?? 6))), h: 26 };
  }
}

/** Every node's box. Nodes without a place of their own are spread along the middle, in order. */
export function layoutMotion(spec: MotionSpec): Map<string, Box> {
  const boxes = new Map<string, Box>();
  const loose = spec.nodes.filter((node) => !node.at);
  loose.forEach((node, index) => {
    node.at = [((index + 0.5) / loose.length) * 100, 50];
  });
  for (const node of spec.nodes) {
    const { w, h } = sizeOf(node);
    const [px, py] = node.at ?? [50, 50];
    const x = clamp((px / 100) * SCENE_W - w / 2, 4, SCENE_W - w - 4);
    const y = clamp((py / 100) * SCENE_H - h / 2, 14, SCENE_H - h - 14);
    boxes.set(node.id, { x, y, w, h });
  }
  return boxes;
}

/** Where a line from one box to another leaves and arrives: the nearest sides, so edges do not cross their own nodes. */
export function anchors(a: Box, b: Box): { x1: number; y1: number; x2: number; y2: number } {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = bc.x - ac.x, dy = bc.y - ac.y;
  if (Math.abs(dx) * a.h > Math.abs(dy) * a.w) {
    // Side to side.
    const sign = dx > 0 ? 1 : -1;
    return { x1: ac.x + (sign * a.w) / 2, y1: ac.y, x2: bc.x - (sign * b.w) / 2, y2: bc.y };
  }
  const sign = dy > 0 ? 1 : -1;
  return { x1: ac.x, y1: ac.y + (sign * a.h) / 2, x2: bc.x, y2: bc.y - (sign * b.h) / 2 };
}

// ---------------------------------------------------------------------------
// State: what a step shows, and the values at it
// ---------------------------------------------------------------------------

export interface SceneState {
  /** Each node's values after every `set` up to this step. */
  values: Map<string, Values | undefined>;
  labels: Map<string, string | undefined>;
  highlight: Set<string>;
  dim: Set<string>;
  /** Node and edge ids (and `from→to` for edges without one) on screen at this step. */
  visible: Set<string>;
}

export const edgeId = (edge: MotionEdge) => edge.id ?? `${edge.from}→${edge.to}`;

export function stateAt(spec: MotionSpec, step: number): SceneState {
  const at = clamp(Math.round(step), 0, spec.steps.length - 1);
  const values = new Map<string, Values | undefined>();
  const labels = new Map<string, string | undefined>();
  for (const node of spec.nodes) {
    values.set(node.id, node.values);
    labels.set(node.id, node.label);
  }
  const shown = new Set<string>();
  for (let i = 0; i <= at; i++) {
    const s = spec.steps[i];
    for (const id of s.show ?? []) shown.add(id);
    for (const [key, value] of Object.entries(s.set ?? {})) {
      const dot = key.lastIndexOf('.');
      const id = dot > 0 ? key.slice(0, dot) : key;
      const field = dot > 0 ? key.slice(dot + 1) : 'values';
      if (!values.has(id)) continue;
      if (field === 'label') {
        if (typeof value === 'string') labels.set(id, value);
      } else if (typeof value !== 'string') values.set(id, value);
    }
  }
  const visible = new Set<string>();
  for (const node of spec.nodes) if ((node.step ?? 0) <= at || shown.has(node.id)) visible.add(node.id);
  for (const edge of spec.edges) {
    const id = edgeId(edge);
    if (((edge.step ?? 0) <= at || shown.has(id)) && visible.has(edge.from) && visible.has(edge.to)) visible.add(id);
  }
  const current = spec.steps[at];
  return { values, labels, highlight: new Set(current.highlight ?? []), dim: new Set(current.dim ?? []), visible };
}

/** Between two values of the same shape; the second when the shapes differ. */
export function mix(a: Values | undefined, b: Values | undefined, u: number): Values | undefined {
  if (a === undefined || b === undefined) return u < 1 ? a ?? b : b;
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * u;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    if (a.every((v) => typeof v === 'number') && b.every((v) => typeof v === 'number')) return (a as number[]).map((v, i) => v + ((b as number[])[i] - v) * u);
    if (a.every((v) => Array.isArray(v)) && b.every((v) => Array.isArray(v))) {
      return (a as number[][]).map((row, i) => {
        const other = (b as number[][])[i];
        return row.length === other.length ? row.map((v, j) => v + (other[j] - v) * u) : other;
      });
    }
  }
  return b;
}

/**
 * The step for the paragraph being read: the step that names it, else in
 * order, spread over the section so the last paragraph reaches the last step.
 */
export function stepForParagraph(spec: MotionSpec, paragraph: number, paragraphs: number): number {
  const n = spec.steps.length;
  if (n <= 1) return 0;
  if (spec.steps.some((s) => s.paragraph !== undefined)) {
    let step = 0;
    spec.steps.forEach((s, i) => {
      if ((s.paragraph ?? i) <= paragraph) step = i;
    });
    return step;
  }
  if (paragraphs <= 0) return 0;
  if (paragraph >= paragraphs - 1) return n - 1;
  return clamp(Math.floor((paragraph * n) / paragraphs), 0, n - 1);
}

/** The scene as words, for the notebook, the notes and a search. */
export function motionText(title: string, spec: MotionSpec | null): string {
  const steps = spec?.steps.map((s, i) => `${i + 1}. ${s.caption}`).filter((s) => s.length > 3) ?? [];
  return `[Scene${title ? `: ${title}` : ''}]${steps.length ? `\n${steps.join('\n')}` : ''}`;
}
