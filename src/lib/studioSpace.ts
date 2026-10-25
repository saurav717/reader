// ===========================================================================
//  Studio space — an empty 3-D room the model furnishes to fit the paper.
//
//  The walk (studio.ts, "show") stands the state on a row of slots. A space is
//  the other arrangement: the scene lists THINGS placed in a unit cube — a
//  landscape with a point descending it, a network's layers as blocks with
//  activations flowing, a trajectory through a state space, a picture
//  standing on a panel, an arrow, a label — and any of a thing's properties
//  can be given once (it stays) or once per slot (it moves, grows or changes
//  as the walk goes). This module is the pure part: the things, their
//  parsing, and what each one is at a point of the walk. The drawing is
//  src/components/StudioSpace.tsx.
//
//  Coordinates: x to the right, y up, z toward the viewer, all 0–1. Heights
//  of a surface are 0–1 too, over its footprint.
// ===========================================================================

import { frameAt, walkAt } from './studio';
import type { Frame, Grid, StudioShow } from './studio';

export type V3 = [number, number, number];
export type Tone = 'accent' | 'mark' | 'ink' | 'muted' | 'blue' | 'pink';
export const TONES: Tone[] = ['accent', 'mark', 'ink', 'muted', 'blue', 'pink'];

/** A property given once, or once per slot. */
export type Keyed<T> = T | T[];

export type Thing =
  // A landscape: heights (0 low, 1 high) over its footprint, as a small grid. A loss surface, a potential, terrain.
  | { id: string; kind: 'surface'; heights: Grid; at?: V3; size?: V3; tone?: Tone; label?: string }
  // A ball at a position: the state, a particle, a parameter vector. Keyed `at` moves it; `size` is its radius in 0–1.
  | { id: string; kind: 'point'; at: Keyed<V3>; size?: number; tone?: Tone; label?: Keyed<string> }
  // A line through points. With `follow`, only the part up to the current slot is drawn: the path so far.
  | { id: string; kind: 'path'; points: V3[]; follow?: boolean; tone?: Tone; label?: string }
  // A picture standing in the room: any of the walk's pictures (studio.ts), facing +z unless `face` says otherwise, keyed by the same slots.
  | { id: string; kind: 'panel'; show: StudioShow; at: Keyed<V3>; size?: [number, number]; face?: 'x' | 'y' | 'z'; label?: Keyed<string> }
  // A block: a layer of a network, a bar, a cell. `value` (0–1) scales its height when given, so a block can grow.
  | { id: string; kind: 'box'; at: Keyed<V3>; size?: V3; value?: Keyed<number>; tone?: Tone; label?: Keyed<string> }
  // An arrow from one place to another, either end keyed.
  | { id: string; kind: 'arrow'; from: Keyed<V3>; to: Keyed<V3>; tone?: Tone; label?: Keyed<string> }
  // Words in the room.
  | { id: string; kind: 'text'; text: Keyed<string>; at: Keyed<V3>; size?: number; tone?: Tone }
  // A graph in 3-D: node positions, edges by index, a value per node per slot (its shade), and the active node at each slot.
  | { id: string; kind: 'graph'; nodes: V3[]; edges: [number, number][]; values?: number[][]; active?: number[]; tone?: Tone };

export interface StudioSpace {
  things: Thing[];
  /** What the axes mean, when they mean something: shown at the ends of the floor. */
  axes?: { x?: string; y?: string; z?: string };
  /** Where the camera starts: turn around the room (degrees), tilt up from the floor (degrees), and how close (1 is the whole room). */
  camera?: { yaw?: number; pitch?: number; zoom?: number };
}

/** What the prompt says about a space: when to use one instead of the walk, and how to write it. */
export const SPACE_FORMAT = `A page's idea may not be a thing carried along a row of slots but a SCENE: a point descending a loss surface, activations flowing through
a network's layers, a trajectory through a state space, a geometric construction, particles in a field, a tree being built. Then, in the
same \`\`\`studio\` block, write "space" instead of "show": an empty 3-D room (x right, y up, z toward you, all 0–1) with the THINGS
in it, each with an "id" and a "kind". Any property marked keyed may be given once (it stays) or as a list with one entry per slot
(it changes as the walk goes). For example, gradient descent:
{"state":"the parameters θ","unit":"step","slots":["k=0","k=1","k=2","k=3","k=4","k=5"],
 "space":{"axes":{"x":"θ₁","y":"loss","z":"θ₂"},"camera":{"yaw":35,"pitch":28},
  "things":[{"id":"loss","kind":"surface","heights":[[0.9,0.7,0.6,0.7,0.9],[0.7,0.4,0.3,0.4,0.7],[0.6,0.3,0.1,0.3,0.6],[0.7,0.4,0.3,0.4,0.7],[0.9,0.7,0.6,0.7,0.9]],"label":"L(θ)"},
            {"id":"theta","kind":"point","at":[[0.1,0.85,0.15],[0.25,0.6,0.3],[0.38,0.35,0.42],[0.45,0.2,0.47],[0.49,0.12,0.5],[0.5,0.1,0.5]],"tone":"mark","label":["θ₀","θ₁","θ₂","θ₃","θ₄","θ*"]},
            {"id":"trail","kind":"path","points":[[0.1,0.85,0.15],[0.25,0.6,0.3],[0.38,0.35,0.42],[0.45,0.2,0.47],[0.49,0.12,0.5],[0.5,0.1,0.5]],"follow":true,"tone":"mark"},
            {"id":"grad","kind":"arrow","from":[[0.1,0.85,0.15],[0.25,0.6,0.3],[0.38,0.35,0.42],[0.45,0.2,0.47],[0.49,0.12,0.5],[0.5,0.1,0.5]],"to":[[0.25,0.6,0.3],[0.38,0.35,0.42],[0.45,0.2,0.47],[0.49,0.12,0.5],[0.5,0.1,0.5],[0.5,0.1,0.5]],"label":"−η∇L"}]},
 "steps":[{"title":"Start somewhere","equation":"\\\\theta_0 \\\\sim \\\\text{init}"},{"title":"Step against the gradient","equation":"\\\\theta_{k+1} = \\\\theta_k - \\\\eta\\\\,\\\\nabla L(\\\\theta_k)","at":0.1},{"title":"Settle","equation":"\\\\nabla L(\\\\theta^*) \\\\approx 0","at":0.9}],
 "readouts":[{"label":"L(θ_k)","values":[0.85,0.6,0.35,0.2,0.12,0.1],"decimals":2},{"label":"‖∇L‖","values":[1.4,1.1,0.7,0.4,0.15,0.02],"decimals":2}]}
Kinds: "surface" (heights: a small grid, 0 low 1 high; at, size optional) a landscape; "point" (at keyed; size 0–1; label keyed) the
state or a particle; "path" (points, one per slot with "follow":true draws the path so far) a trajectory; "panel" (show: any of the
walk's pictures above, keyed by the same slots; at keyed; size [w,h]; face x, y or z) a picture standing in the room — a network's
feature map at each layer, the image at each step; "box" (at keyed; size; value keyed 0–1 scales its height) a layer, a bar, a cell;
"arrow" (from, to, both keyed) a gradient, a flow, a force; "text" (text keyed, at keyed) a label; "graph" (nodes, edges, values per
slot, active per slot) a network or a tree. "tone" is accent (default), mark, ink, muted, blue or pink. Three to twelve things;
keep positions inside 0–1; a thing that should move gets a list of as many entries as there are slots. Write "space" when the idea
is a scene, "show" when it is one thing carried along; never both.`;

// ---------------------------------------------------------------------------
// Reading a space
// ---------------------------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const v3 = (v: unknown): V3 | null => (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(isNum) ? ([clamp01(v[0]), clamp01(v[1]), clamp01(v[2])] as V3) : null);
const v3s = (v: unknown): V3[] => (Array.isArray(v) ? v : []).map(v3).filter((p): p is V3 => Boolean(p));
/** A keyed position: one triple, or a list of them. */
const keyedV3 = (v: unknown): Keyed<V3> | null => {
  const one = v3(v);
  if (one) return one;
  const many = v3s(v);
  return many.length ? many : null;
};
const keyedStr = (v: unknown): Keyed<string> | undefined => {
  if (typeof v === 'string') return str(v) || undefined;
  if (Array.isArray(v)) {
    const list = v.map((t) => (isNum(t) ? String(t) : str(t)));
    return list.some(Boolean) ? list : undefined;
  }
  return undefined;
};
const keyedNum = (v: unknown): Keyed<number> | undefined => {
  if (isNum(v)) return clamp01(v);
  if (Array.isArray(v) && v.length && v.every(isNum)) return v.map(clamp01);
  return undefined;
};
const tone = (v: unknown): Tone | undefined => (TONES.includes(v as Tone) ? (v as Tone) : undefined);
const grid = (v: unknown): Grid | null => {
  if (!Array.isArray(v) || !v.length) return null;
  const rows = v.filter((row): row is number[] => Array.isArray(row) && row.length > 0 && row.every(isNum)).map((row) => row.map(clamp01));
  if (!rows.length) return null;
  const width = Math.max(...rows.map((row) => row.length));
  return rows.map((row) => (row.length === width ? row : [...row, ...Array<number>(width - row.length).fill(row[row.length - 1])]));
};

/**
 * The "space" of a studio block as things the room can hold, or null when it
 * is not one. `readShow` reads a panel's picture the way the walk reads its
 * own, so the two agree on what a picture is.
 */
export function parseSpace(raw: unknown, readShow: (raw: unknown) => StudioShow | null): StudioSpace | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const things: Thing[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(o.things) ? o.things : []) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    let id = str(t.id) || `${str(t.kind) || 'thing'}-${things.length + 1}`;
    for (let n = 2; seen.has(id); n++) id = `${str(t.id) || str(t.kind) || 'thing'}-${n}`;
    const kind = str(t.kind);
    const common = { ...(tone(t.tone) ? { tone: tone(t.tone)! } : {}) };
    let thing: Thing | null = null;
    if (kind === 'surface') {
      const heights = grid(t.heights ?? t.grid);
      if (heights) thing = { id, kind, heights, ...(v3(t.at) ? { at: v3(t.at)! } : {}), ...(v3(t.size) ? { size: v3(t.size)! } : {}), ...common, ...(str(t.label) ? { label: str(t.label) } : {}) };
    } else if (kind === 'point') {
      const at = keyedV3(t.at);
      if (at) thing = { id, kind, at, ...(isNum(t.size) ? { size: clamp01(t.size) } : {}), ...common, ...(keyedStr(t.label) ? { label: keyedStr(t.label)! } : {}) };
    } else if (kind === 'path') {
      const points = v3s(t.points);
      if (points.length >= 2) thing = { id, kind, points, ...(t.follow === true || t.follow === 'true' ? { follow: true } : {}), ...common, ...(str(t.label) ? { label: str(t.label) } : {}) };
    } else if (kind === 'panel') {
      const show = readShow(t.show);
      const at = keyedV3(t.at);
      if (show && at) {
        const size = Array.isArray(t.size) && t.size.length >= 2 && isNum(t.size[0]) && isNum(t.size[1]) ? ([clamp01(t.size[0]), clamp01(t.size[1])] as [number, number]) : undefined;
        const face = t.face === 'x' || t.face === 'y' || t.face === 'z' ? t.face : undefined;
        thing = { id, kind, show, at, ...(size ? { size } : {}), ...(face ? { face } : {}), ...(keyedStr(t.label) ? { label: keyedStr(t.label)! } : {}) };
      }
    } else if (kind === 'box') {
      const at = keyedV3(t.at);
      if (at) thing = { id, kind, at, ...(v3(t.size) ? { size: v3(t.size)! } : {}), ...(keyedNum(t.value) !== undefined ? { value: keyedNum(t.value)! } : {}), ...common, ...(keyedStr(t.label) ? { label: keyedStr(t.label)! } : {}) };
    } else if (kind === 'arrow') {
      const from = keyedV3(t.from);
      const to = keyedV3(t.to);
      if (from && to) thing = { id, kind, from, to, ...common, ...(keyedStr(t.label) ? { label: keyedStr(t.label)! } : {}) };
    } else if (kind === 'text') {
      const text = keyedStr(t.text);
      const at = keyedV3(t.at);
      if (text && at) thing = { id, kind, text, at, ...(isNum(t.size) ? { size: clamp01(t.size) } : {}), ...common };
    } else if (kind === 'graph') {
      const nodes = v3s(t.nodes);
      if (nodes.length >= 2) {
        const edges = (Array.isArray(t.edges) ? t.edges : [])
          .map((e) => (Array.isArray(e) && e.length === 2 && e.every(isNum) ? ([Math.round(e[0]), Math.round(e[1])] as [number, number]) : null))
          .filter((e): e is [number, number] => Boolean(e) && e![0] >= 0 && e![1] >= 0 && e![0] < nodes.length && e![1] < nodes.length && e![0] !== e![1]);
        const values = (Array.isArray(t.values) ? t.values : []).map((row) => (Array.isArray(row) ? row.filter(isNum).map(clamp01) : [])).filter((row) => row.length);
        const active = Array.isArray(t.active) ? t.active.filter(isNum).map(Math.round) : [];
        thing = { id, kind, nodes, edges, ...(values.length ? { values } : {}), ...(active.length ? { active } : {}), ...common };
      }
    }
    if (thing) {
      things.push(thing);
      seen.add(id);
    }
  }
  if (!things.length) return null;
  const space: StudioSpace = { things };
  if (o.axes && typeof o.axes === 'object') {
    const a = o.axes as Record<string, unknown>;
    const axes = { ...(str(a.x) ? { x: str(a.x) } : {}), ...(str(a.y) ? { y: str(a.y) } : {}), ...(str(a.z) ? { z: str(a.z) } : {}) };
    if (Object.keys(axes).length) space.axes = axes;
  }
  if (o.camera && typeof o.camera === 'object') {
    const c = o.camera as Record<string, unknown>;
    const camera = { ...(isNum(c.yaw) ? { yaw: c.yaw } : {}), ...(isNum(c.pitch) ? { pitch: Math.max(5, Math.min(85, c.pitch)) } : {}), ...(isNum(c.zoom) ? { zoom: Math.max(0.3, Math.min(3, c.zoom)) } : {}) };
    if (Object.keys(camera).length) space.camera = camera;
  }
  return space;
}

// ---------------------------------------------------------------------------
// The room at a point of the walk
// ---------------------------------------------------------------------------

/** A thing with every keyed property resolved for one moment of the walk. */
export type Placed =
  | { id: string; kind: 'surface'; heights: Grid; at: V3; size: V3; tone: Tone; label?: string }
  | { id: string; kind: 'point'; at: V3; size: number; tone: Tone; label?: string }
  // The part of the path drawn now: all of it, or up to the current slot (the next point part way).
  | { id: string; kind: 'path'; points: V3[]; tone: Tone; label?: string }
  | { id: string; kind: 'panel'; frame: Frame; at: V3; size: [number, number]; face: 'x' | 'y' | 'z'; label?: string; show: StudioShow }
  | { id: string; kind: 'box'; at: V3; size: V3; value: number; tone: Tone; label?: string }
  | { id: string; kind: 'arrow'; from: V3; to: V3; tone: Tone; label?: string }
  | { id: string; kind: 'text'; text: string; at: V3; size: number; tone: Tone }
  | { id: string; kind: 'graph'; nodes: V3[]; edges: [number, number][]; values: number[]; active?: number; tone: Tone };

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const lerp3 = (a: V3, b: V3, u: number): V3 => [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];

/** Of a per-slot list, the entries before and after a position in slots, and how far between; a short list is spread over the walk. */
function around<T>(list: T[], position: number, slots: number): { a: T; b: T; u: number } {
  const scaled = list.length >= slots || slots < 2 ? position : (position / (slots - 1)) * (list.length - 1);
  const i = Math.max(0, Math.min(list.length - 1, Math.floor(scaled)));
  const j = Math.max(0, Math.min(list.length - 1, i + 1));
  return { a: list[i], b: list[j], u: j === i ? 0 : Math.max(0, Math.min(1, scaled - i)) };
}
const isV3 = (v: Keyed<V3>): v is V3 => v.length === 3 && typeof v[0] === 'number';
const at3 = (v: Keyed<V3>, position: number, slots: number): V3 => {
  if (isV3(v)) return v;
  const { a, b, u } = around(v, position, slots);
  return lerp3(a, b, u);
};
const atStr = (v: Keyed<string> | undefined, position: number, slots: number): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v === 'string') return v;
  const { a, b, u } = around(v, position, slots);
  return (u < 0.5 ? a : b) || undefined;
};
const atNum = (v: Keyed<number> | undefined, position: number, slots: number, fallback: number): number => {
  if (v === undefined) return fallback;
  if (typeof v === 'number') return v;
  const { a, b, u } = around(v, position, slots);
  return lerp(a, b, u);
};

/** Every thing in the room at a fraction `p` of the walk. */
export function thingsAt(space: StudioSpace, slots: string[], p: number, seed = 1): Placed[] {
  const n = slots.length;
  const { position } = walkAt(p, n);
  return space.things.map((thing): Placed => {
    switch (thing.kind) {
      case 'surface':
        return { id: thing.id, kind: 'surface', heights: thing.heights, at: thing.at ?? [0, 0, 0], size: thing.size ?? [1, 1, 1], tone: thing.tone ?? 'accent', ...(thing.label ? { label: thing.label } : {}) };
      case 'point': {
        const label = atStr(thing.label, position, n);
        return { id: thing.id, kind: 'point', at: at3(thing.at, position, n), size: thing.size ?? 0.03, tone: thing.tone ?? 'accent', ...(label ? { label } : {}) };
      }
      case 'path': {
        let points = thing.points;
        if (thing.follow) {
          // Up to the current slot, then part of the way to the next: the path grows as the walk goes.
          const { a, b, u } = around(thing.points, position, n);
          const scaled = thing.points.length >= n || n < 2 ? position : (position / (n - 1)) * (thing.points.length - 1);
          const whole = Math.max(0, Math.min(thing.points.length - 1, Math.floor(scaled)));
          points = [...thing.points.slice(0, whole + 1), ...(u > 0 ? [lerp3(a, b, u)] : [])];
        }
        return { id: thing.id, kind: 'path', points, tone: thing.tone ?? 'accent', ...(thing.label ? { label: thing.label } : {}) };
      }
      case 'panel': {
        const label = atStr(thing.label, position, n);
        return { id: thing.id, kind: 'panel', frame: frameAt({ show: thing.show, slots }, p, seed), at: at3(thing.at, position, n), size: thing.size ?? [0.3, 0.3], face: thing.face ?? 'z', show: thing.show, ...(label ? { label } : {}) };
      }
      case 'box': {
        const label = atStr(thing.label, position, n);
        return { id: thing.id, kind: 'box', at: at3(thing.at, position, n), size: thing.size ?? [0.1, 0.1, 0.1], value: atNum(thing.value, position, n, 1), tone: thing.tone ?? 'accent', ...(label ? { label } : {}) };
      }
      case 'arrow': {
        const label = atStr(thing.label, position, n);
        return { id: thing.id, kind: 'arrow', from: at3(thing.from, position, n), to: at3(thing.to, position, n), tone: thing.tone ?? 'accent', ...(label ? { label } : {}) };
      }
      case 'text':
        return { id: thing.id, kind: 'text', text: atStr(thing.text, position, n) ?? '', at: at3(thing.at, position, n), size: thing.size ?? 0.05, tone: thing.tone ?? 'ink' };
      case 'graph': {
        const rows = thing.values?.length ? thing.values : [thing.nodes.map(() => 0.5)];
        const { a, b, u } = around(rows, position, n);
        const values = thing.nodes.map((_, i) => lerp(a[i] ?? 0.5, b[i] ?? a[i] ?? 0.5, u));
        const placed: Placed = { id: thing.id, kind: 'graph', nodes: thing.nodes, edges: thing.edges, values, tone: thing.tone ?? 'accent' };
        if (thing.active?.length) {
          const act = around(thing.active, position, n);
          const node = u < 0.5 ? act.a : act.b;
          if (node >= 0 && node < thing.nodes.length) placed.active = node;
        }
        return placed;
      }
    }
  });
}

/** The things that move during the walk: what the camera might follow, and what the card can say the space does. */
export const movingThings = (space: StudioSpace) =>
  space.things.filter((thing) => ('at' in thing && !isV3(thing.at as Keyed<V3>)) || (thing.kind === 'path' && thing.follow) || (thing.kind === 'arrow' && (!isV3(thing.from) || !isV3(thing.to))) || (thing.kind === 'graph' && (thing.values?.length ?? 0) > 1) || (thing.kind === 'box' && Array.isArray(thing.value)));

/** A space as a line of text, for the card and the notebook. */
export const spaceText = (space: StudioSpace) => {
  const counts = new Map<string, number>();
  for (const thing of space.things) counts.set(thing.kind, (counts.get(thing.kind) ?? 0) + 1);
  return Array.from(counts, ([kind, count]) => `${count} ${kind}${count > 1 ? (kind === 'box' ? 'es' : 's') : ''}`).join(', ');
};
