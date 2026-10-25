// ===========================================================================
//  Learn — a topic, taught in pages, from wherever you start to wherever you
//  want to get.
//
//  You name a topic and how far you want to go. The model first writes a MAP:
//  a small graph of concepts, each a page, each saying which pages it assumes
//  you have read, grouped into a few stages from the ground up. Nothing else
//  is written until you open a box on the map; then that one page is written,
//  in the same Markdown Explain uses (explain.ts: figures, scenes, cells,
//  maths), with a few blocks of its own:
//
//    ```formal title="…"                  what the plain prose just said, made exact
//    ```image query="…" must="…" caption="…"   a picture to be found on the web (wikimedia.ts)
//    ```studio title="…"                  the page's process, walked step by step full screen (studio.ts)
//    ```check                             the questions at the end of the page, as JSON
//    ```glossary                          the terms this page taught, one per line
//
//  The pages already read, the glossary so far and what the last check found
//  wanting go into the next page's request, so the pages agree with each
//  other and a page opens with a bridge where the one before it did not stick.
//  A track is kept in this browser (IndexedDB) and, when Drive is connected,
//  as one Markdown file per page under Learn/<topic>/ (learnDrive.ts).
// ===========================================================================

import { explainError, modelSpec, PROVIDERS, sdk, streamModel, tag } from './assistant';
import type { SDK } from './assistant';
import { currentDbName, db } from './db';
import { MOTION_FORMAT } from './motion';
import { STUDIO_FORMAT } from './studio';
import { SPACE_FORMAT } from './studioSpace';
import { applyEdits, parseExplanation, sectionTitles } from './explain';
import type { Section } from './explain';

const MAP_MAX_TOKENS = 6000;
const PAGE_MAX_TOKENS = 32000;

// ---------------------------------------------------------------------------
// What a track is
// ---------------------------------------------------------------------------

export interface LearnPrefs {
  /** Lead each idea with a picture. */
  pictures: boolean;
  /** Plain prose first, the formal account behind a toggle. */
  plainFirst: boolean;
  /** Runnable code cells where they help. */
  code: boolean;
  /** A short check at the end of each page. */
  checks: boolean;
  /** A picture made for the page (generated.ts) when none can be found; a track from before this existed has it on. */
  generate?: boolean;
}

export const DEFAULT_PREFS: LearnPrefs = { pictures: true, plainFirst: true, code: true, checks: true, generate: true };

export interface LearnNode {
  id: string;
  title: string;
  /** The stage it belongs to, one of the track's. */
  stage: string;
  /** The pages it assumes you have read: ids of other nodes. */
  needs: string[];
  /** One line on what the page covers. */
  blurb: string;
  /** A page to write, or a paper to read when you get there (opened in the reader, explained by Explain). */
  kind: 'page' | 'paper';
  paper?: { title: string; arxivId?: string; authors?: string };
}

export type GlossaryEntry = { term: string; meaning: string; nodeId: string };

export type CheckQuestion =
  | { kind: 'pick'; q: string; options: { text: string; svg?: string }[]; answer: number; why: string }
  | { kind: 'order'; q: string; steps: string[]; why: string }
  | { kind: 'fill'; q: string; answer: string; accept: string[]; why: string };

export type CheckAnswer = number | number[] | string | null;

export interface CheckResult {
  at: number;
  /** 0 to 1. */
  score: number;
  /** The explanations of the questions missed: what the next page bridges. */
  missed: string[];
  answers: CheckAnswer[];
}

export interface LearnRevision {
  request: string;
  before: string;
  note: string;
  touched: string[];
  at: number;
}

export interface LearnPage {
  nodeId: string;
  content: string;
  model: string;
  created: number;
  updated: number;
  streaming?: boolean;
  thinking?: string;
  error?: string;
  truncated?: boolean;
  check?: CheckResult;
  revisions?: LearnRevision[];
  pending?: { request: string; reply: string; error?: string; started?: number };
}

export type NodeProgress = 'read' | 'confident';

export interface LearnTrack {
  id: string;
  topic: string;
  from: string;
  to: string;
  prefs: LearnPrefs;
  model: string;
  created: number;
  updated: number;
  /** Last opened, for the list on Home. */
  opened?: number;
  stages: string[];
  nodes: LearnNode[];
  pages: Record<string, LearnPage>;
  progress: Record<string, NodeProgress>;
  glossary: GlossaryEntry[];
  /** The map is being written. */
  mapping?: boolean;
  /** The reply the map was read from, kept so a map can be read again after the parser improves. */
  mapSrc?: string;
  error?: string;
  /** Its folder in Drive, once written or read there. */
  drive?: { folderId: string; link?: string };
}

// ---------------------------------------------------------------------------
// The instructions
// ---------------------------------------------------------------------------

export const MAP_SYSTEM = `You are planning how to teach ONE topic to ONE reader, as a map of short pages they will read one at a time,
from where they start to where they want to get. You are not writing the pages now: only the map.

Reply with ONE JSON object in a \`\`\`json fence and nothing else:
{
  "stages": ["Ground", "The trick", "The model", "Sampling and beyond"],
  "nodes": [
    { "id": "gaussian-noise", "title": "Gaussian noise", "stage": "Ground", "needs": [], "blurb": "What one step of noise does to a picture, and why Gaussians add up.", "kind": "page" },
    { "id": "read-ddpm", "title": "Read DDPM (2020)", "stage": "Sampling and beyond", "needs": ["reverse-process"], "blurb": "The paper itself, now that every piece of it has been met.", "kind": "paper", "paper": { "title": "Denoising Diffusion Probabilistic Models", "arxivId": "2006.11239", "authors": "Ho, Jain, Abbeel" } }
  ]
}

Rules:
- 3 to 5 stages, in order from the ground up. 6 to 14 nodes. Each node is ONE page a reader gets through in ten minutes.
- "needs" lists the ids of the pages a page assumes you have read: at most three, all earlier in the map, never a cycle.
  The first stage's pages need nothing. Every later page needs at least one.
- Start from what the reader already knows (given below) and skip pages they do not need; end where they want to end.
- A "paper" node is a paper to read once the pages before it are read — only a paper you are sure exists, with its arXiv id
  when you are sure of it. At most two, and only where reading the primary source is the natural end of a stage.
- ids are short lowercase slugs, unique. Titles are short (two to five words). Blurbs are one sentence.
- No prose outside the JSON.`;

export const PAGE_SYSTEM = `You are writing ONE page of a course that teaches a topic to one reader, from where they started to where they want to
get. The whole map of the course, which pages they have read, the terms those pages taught, and what the last check
found wanting are given below. Write only the page asked for, so that it reads as the next step and agrees with the
pages before it: the same names for the same things, nothing re-explained that an earlier page taught (name it and move on).

The reader learns visually. Lead every idea with a picture, an analogy or a concrete example before the general statement,
and keep the prose plain — short sentences, one idea each, the intuition before the formalism. The formal account is
welcome, but it goes in a block of its own (below) that the reader opens when ready.

FORMAT — plain Markdown, with these rules the page depends on:
- 3 to 6 sections, each "## <short title>". No "#" headings. "###" is fine inside a section.
  When <bridge> is given, the FIRST section is "## Bridge: <what it mends>": short, drawn, mending exactly what the
  check found wanting before the page proper starts.
- Diagrams: a fenced block \`\`\`figure caption="One-line caption"\` containing ONE self-contained <svg> with a
  viewBox and no width/height, no scripts, no external images, no fonts other than inherited ones.
  Colour it ONLY with these classes (the page themes them for light and dark):
  fill: f-accent, f-soft, f-yellow, f-blue, f-green, f-pink, f-paper; stroke: s-ink, s-muted, s-accent;
  text: t-muted, t-accent, t-on (for text on f-accent; text is ink by default). Lines default to the ink colour. Keep text ≥ 11 units.
  Maths in a figure's text is LaTeX between single dollars too, e.g. <text>$\\hat{z}_{t+1} = f_\\theta(z_t)$</text>.
  Draw the mechanism, not decoration: boxes for the things, arrows for what happens, a label on each. Prefer a sequence
  of small panels (before / during / after) to one busy drawing. One figure per key idea; most sections should have one.
- The formal account: right after the plain paragraphs that carry an idea, a fenced block
  \`\`\`formal title="What this says exactly"\` holding Markdown with the definition, the equation, or the precise statement,
  and a "where …" list naming every symbol. The page folds it away until the reader asks for it, so the plain prose
  above it must stand on its own.
- Maths, inside and outside formal blocks, as LaTeX: inline between single dollars, $\\nabla \\cdot u = 0$; a displayed
  equation on lines of its own between double dollars. Never put maths in \`code\` spans, never as Unicode approximations.
- Pictures from the world: where a real photograph, micrograph, painting, map, screenshot or historical figure would teach
  more than a drawing (what a thing actually looks like; who did it; the apparatus; what a model's output looks like), ask
  for one with
  \`\`\`image query="an image search, 3-8 words" must="what the picture must show, in one clause" caption="One line of what to look at in it"\`
  and inside the block one sentence of Markdown on why it is here. The page searches Wikimedia Commons and the web for it,
  shows you the candidates, and captions the one you pick with its source. Write the query as an image search would want it:
  the name of a thing, a place, an apparatus, a well-known picture ("Hubble ultra deep field", "DDPM CelebA samples",
  "ribosome cryo-EM structure"), not an abstract description. Where the right picture is a figure of a paper you are sure
  of — the samples a model produced, the architecture as the authors drew it, the plot a result rests on — name it too:
  paper="<arXiv id>" figure="Figure 1" on the same fence, and the page pulls that figure from the paper itself. At most two
  pictures per page; none when a drawing does the job.
- Code: \`\`\`python title="What this cell shows"\` — short (≤ 30 lines), self-contained, numpy only (torch when it matters),
  deterministic (seeded), and it must print something that proves the point. Follow each cell with \`\`\`output\` holding
  what it prints. Only where running it teaches something a figure cannot; many pages need none.
- Scenes: this reader learns by watching things happen. Where a figure shows something that happens in stages — a pass
  through a model, a quantity changing with a knob, a procedure with steps, a signal transformed stage by stage — write a
  \`\`\`motion\` block right after it, as described under SCENES below, with one step per paragraph of the section: the
  page plays it as the reader reads, and the figure stays as the still. One such scene per page is right, two at most, on
  the figures that matter most; mark any other figure that could move with animate="yes" in its fence and the reader can
  ask for its scene. A figure of something static — a definition, a table, a comparison at rest — gets neither.
- Drawn lines move: the page traces every figure's strokes as it comes into view, in the order they are written, then
  shows the fills and the text. So write each figure's SVG in the order a hand would draw it — the thing first, then what
  happens to it, then the arrows that join them, labels last — as separate <path>, <line> and <rect> elements rather than
  one path for everything, with arrows as lines with a marker-end. The trace reads as the explanation, for free.
- References: cite claims that rest on a source with [1], [2] … in the prose and end with "## References" listing them,
  one per line as "[n] Authors. Title. Year." Only sources you are sure exist; mark one you are not sure of "(not verified)".
  Never invent a citation. A paper from the map's "paper" nodes, when relevant, is the first thing to cite.
- The check, as the LAST fenced block before the glossary — a \`\`\`check\` block holding ONE JSON object:
  {"questions":[
    {"kind":"pick","q":"Which drawing shows …?","options":[{"text":"…","svg":"<svg viewBox=\\"0 0 200 90\\">…</svg>"},{"text":"…"},{"text":"…"}],"answer":1,"why":"One sentence on what the right answer shows."},
    {"kind":"order","q":"Put the steps of … in order.","steps":["first","second","third","fourth"],"why":"…"},
    {"kind":"fill","q":"The reverse steps are Gaussian because ___.","answer":"the forward steps were tiny","accept":["small steps","tiny steps"],"why":"…"}
  ]}
  Exactly three questions, one of each kind, in that order; "steps" is the CORRECT order (the page shuffles it); a "pick"
  question's options are drawings where the question is about a picture (small SVGs with the same colour classes, JSON-escaped
  on one line) and plain text otherwise. "why" is what the next page bridges when the question is missed, so it names the
  idea, not the answer. No question is a trick; each tests one idea the page taught.
- Last of all, a \`\`\`glossary\` block: the terms this page taught, one per line as "term — meaning in a few words".
  Only terms introduced on THIS page, never ones from the glossary given below.

${MOTION_FORMAT}

For this course the SCENES rule "on request" is relaxed as said above: write the one or two scenes a page needs without
being asked.

${STUDIO_FORMAT}

${SPACE_FORMAT}

A page gets a studio block only when its idea IS a process of that kind; most pages have none. Where it has one, it
is the page's one such block, and the check may ask about what the walk shows.`;

/** The reader's own words about where they start and where they want to get, as the two lines Home asks for. */
export const FROM_HINT = 'e.g. I know basic probability and PyTorch';
export const TO_HINT = 'e.g. can read the DDPM paper';

// ---------------------------------------------------------------------------
// Reading the map
// ---------------------------------------------------------------------------

const slugOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '') || 'page';

/** The JSON in a reply: the fenced block, or the first object in it; null when there is none that parses. */
export function jsonIn(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(text);
  const candidates = [fenced?.[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1), text];
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // the next one
    }
  }
  return null;
}

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/**
 * The map as the model wrote it, made safe: ids unique slugs, needs pointing
 * at earlier nodes only (a need that would make a cycle is dropped), stages
 * in the order given with every node in one of them, nodes in stage order.
 */
export function parseMap(text: string): { stages: string[]; nodes: LearnNode[] } | null {
  const raw = jsonIn(text) as { stages?: unknown; nodes?: unknown } | null;
  if (!raw || !Array.isArray(raw.nodes)) return null;
  const stages = (Array.isArray(raw.stages) ? raw.stages.map(str).filter(Boolean) : []).filter((stage, i, all) => all.indexOf(stage) === i);
  const taken = new Set<string>();
  const nodes: LearnNode[] = [];
  for (const item of raw.nodes as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object') continue;
    const title = str(item.title);
    if (!title) continue;
    let id = slugOf(str(item.id) || title);
    for (let n = 2; taken.has(id); n++) id = `${slugOf(str(item.id) || title)}-${n}`;
    taken.add(id);
    const kind: LearnNode['kind'] = str(item.kind) === 'paper' ? 'paper' : 'page';
    const paper = item.paper && typeof item.paper === 'object' ? (item.paper as Record<string, unknown>) : null;
    let stage = str(item.stage);
    if (!stages.includes(stage)) {
      if (stage) stages.push(stage);
      else stage = stages[0] ?? (stages.push('Start'), 'Start');
    }
    nodes.push({
      id,
      title,
      stage,
      needs: Array.isArray(item.needs) ? item.needs.map(str).filter(Boolean) : [],
      blurb: str(item.blurb),
      kind,
      ...(kind === 'paper' && paper ? { paper: { title: str(paper.title) || title, ...(str(paper.arxivId) ? { arxivId: str(paper.arxivId) } : {}), ...(str(paper.authors) ? { authors: str(paper.authors) } : {}) } } : {}),
    });
  }
  if (!nodes.length) return null;
  // Ids the model wrote as titles, or near enough, still point somewhere.
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const byTitle = new Map(nodes.map((node) => [slugOf(node.title), node.id]));
  const order = new Map(nodes.map((node, i) => [node.id, i]));
  for (const node of nodes) {
    node.needs = node.needs
      .map((need) => (byId.has(need) ? need : byTitle.get(slugOf(need)) ?? ''))
      .filter((need, i, all) => need && need !== node.id && all.indexOf(need) === i);
  }
  // In stage order, then as written; a need that points forward is dropped, so the graph is a DAG by construction.
  nodes.sort((a, b) => stages.indexOf(a.stage) - stages.indexOf(b.stage) || order.get(a.id)! - order.get(b.id)!);
  const position = new Map(nodes.map((node, i) => [node.id, i]));
  for (const node of nodes) node.needs = node.needs.filter((need) => position.get(need)! < position.get(node.id)!);
  return { stages: stages.filter((stage) => nodes.some((node) => node.stage === stage)), nodes };
}

// ---------------------------------------------------------------------------
// Where you are on the map
// ---------------------------------------------------------------------------

export type NodeState = 'confident' | 'read' | 'next' | 'ready' | 'locked';

/** Each node's state: read or confident as recorded; else ready when every need is read; the first ready page is next. */
export function nodeStates(track: Pick<LearnTrack, 'nodes' | 'progress'>): Record<string, NodeState> {
  const states: Record<string, NodeState> = {};
  let next = false;
  for (const node of track.nodes) {
    const done = track.progress[node.id];
    if (done) states[node.id] = done;
    else if (node.needs.every((need) => track.progress[need])) {
      states[node.id] = next ? 'ready' : 'next';
      next = true;
    } else states[node.id] = 'locked';
  }
  return states;
}

/** The pages read, and the first one not yet, in the map's order. */
export function nextNode(track: Pick<LearnTrack, 'nodes' | 'progress'>): LearnNode | undefined {
  const states = nodeStates(track);
  return track.nodes.find((node) => states[node.id] === 'next') ?? track.nodes.find((node) => states[node.id] === 'ready');
}

export function countRead(track: Pick<LearnTrack, 'nodes' | 'progress'>): { read: number; confident: number; total: number } {
  let read = 0;
  let confident = 0;
  for (const node of track.nodes) {
    const state = track.progress[node.id];
    if (state) read++;
    if (state === 'confident') confident++;
  }
  return { read, confident, total: track.nodes.length };
}

// ---------------------------------------------------------------------------
// Drawing the map: stages as columns, each node a box, needs as curves
// ---------------------------------------------------------------------------

export interface MapBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MapLayout {
  width: number;
  height: number;
  columns: { stage: string; x: number }[];
  boxes: MapBox[];
  /** From a need to the node that needs it, as an SVG path. */
  edges: { from: string; to: string; d: string }[];
}

export const BOX_W = 150;
export const BOX_H = 40;
const COL_GAP = 70;
const ROW_GAP = 26;
const PAD_X = 24;
const PAD_TOP = 48;
const PAD_BOTTOM = 24;

/**
 * Each stage is a column, its nodes stacked in the order given; the column
 * is centred on the tallest, so a stage with one page sits in the middle.
 */
export function layoutMap(track: Pick<LearnTrack, 'stages' | 'nodes'>): MapLayout {
  const columns = track.stages.map((stage, i) => ({ stage, x: PAD_X + i * (BOX_W + COL_GAP) }));
  const perStage = new Map(track.stages.map((stage) => [stage, track.nodes.filter((node) => node.stage === stage)]));
  const tallest = Math.max(1, ...Array.from(perStage.values()).map((nodes) => nodes.length));
  const inner = tallest * BOX_H + (tallest - 1) * ROW_GAP;
  const boxes: MapBox[] = [];
  for (const column of columns) {
    const nodes = perStage.get(column.stage) ?? [];
    const height = nodes.length * BOX_H + Math.max(0, nodes.length - 1) * ROW_GAP;
    const top = PAD_TOP + (inner - height) / 2;
    nodes.forEach((node, i) => boxes.push({ id: node.id, x: column.x, y: top + i * (BOX_H + ROW_GAP), w: BOX_W, h: BOX_H }));
  }
  const at = new Map(boxes.map((box) => [box.id, box]));
  const edges: MapLayout['edges'] = [];
  for (const node of track.nodes) {
    const to = at.get(node.id);
    if (!to) continue;
    for (const need of node.needs) {
      const from = at.get(need);
      if (!from) continue;
      const x1 = from.x + from.w;
      const y1 = from.y + from.h / 2;
      const x2 = to.x;
      const y2 = to.y + to.h / 2;
      const dx = Math.max(24, (x2 - x1) / 2);
      // Two boxes in one column (a need in the same stage) leave by the right and come back round.
      const d = x2 > x1 ? `M${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}` : `M${x1} ${y1} C ${x1 + 30} ${y1}, ${x1 + 30} ${y2}, ${x2 + to.w} ${y2}`;
      edges.push({ from: need, to: node.id, d });
    }
  }
  return {
    width: columns.length ? columns[columns.length - 1].x + BOX_W + PAD_X : 2 * PAD_X,
    height: PAD_TOP + inner + PAD_BOTTOM,
    columns,
    boxes,
    edges,
  };
}

// ---------------------------------------------------------------------------
// Reading a page: its check and its glossary
// ---------------------------------------------------------------------------

export function parseCheck(src: string): CheckQuestion[] {
  const raw = jsonIn(src) as { questions?: unknown } | unknown[] | null;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { questions?: unknown }).questions) ? (raw as { questions: unknown[] }).questions : [];
  const questions: CheckQuestion[] = [];
  for (const item of list as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object') continue;
    const q = str(item.q ?? item.question);
    const why = str(item.why);
    if (!q) continue;
    const kind = str(item.kind);
    if (kind === 'pick' && Array.isArray(item.options)) {
      const options = (item.options as unknown[])
        .map((option) => (typeof option === 'string' ? { text: option } : option && typeof option === 'object' ? { text: str((option as Record<string, unknown>).text ?? (option as Record<string, unknown>).label), ...(str((option as Record<string, unknown>).svg) ? { svg: str((option as Record<string, unknown>).svg) } : {}) } : null))
        .filter((option): option is { text: string; svg?: string } => Boolean(option && (option.text || option.svg)));
      const answer = Number(item.answer);
      if (options.length >= 2 && Number.isInteger(answer) && answer >= 0 && answer < options.length) questions.push({ kind: 'pick', q, options, answer, why });
    } else if (kind === 'order' && Array.isArray(item.steps)) {
      const steps = (item.steps as unknown[]).map(str).filter(Boolean);
      if (steps.length >= 2) questions.push({ kind: 'order', q, steps, why });
    } else if (kind === 'fill') {
      const answer = str(item.answer);
      if (answer) questions.push({ kind: 'fill', q, answer, accept: Array.isArray(item.accept) ? (item.accept as unknown[]).map(str).filter(Boolean) : [], why });
    }
  }
  return questions;
}

/** The check on a page, once its block has closed. */
export function checkOf(sections: Section[]): CheckQuestion[] {
  for (const section of sections) for (const block of section.blocks) if (block.kind === 'check' && !block.open) return parseCheck(block.src);
  return [];
}

export function parseGlossary(text: string, nodeId: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(?:[-*]\s+)?\**(.+?)\**\s*(?:—|–|:|-)\s+(.+?)\s*$/.exec(line);
    if (match && match[1].trim() && match[2].trim()) entries.push({ term: match[1].trim(), meaning: match[2].trim(), nodeId });
  }
  return entries;
}

export function glossaryOf(sections: Section[], nodeId: string): GlossaryEntry[] {
  for (const section of sections) for (const block of section.blocks) if (block.kind === 'glossary' && !block.open) return parseGlossary(block.text, nodeId);
  return [];
}

/** The page without its check and glossary, for the outline and the notebook: what is read, not what is asked. */
export const pageSections = (sections: Section[]) =>
  sections
    .map((section) => ({ ...section, blocks: section.blocks.filter((block) => block.kind !== 'check' && block.kind !== 'glossary') }))
    .filter((section) => section.title || section.blocks.length);

// ---------------------------------------------------------------------------
// Marking a check
// ---------------------------------------------------------------------------

const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** A shuffle that is the same every time for the same steps, so the page does not reshuffle on each render. */
export function shuffled<T>(items: T[], seed: string): T[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  // Shuffled is the point: an order that came out as it went in is rotated.
  if (out.length > 1 && out.every((item, i) => item === items[i])) out.push(out.shift()!);
  return out;
}

/** How right one answer is, 0 to 1. An order is marked by the steps in their right place, so one swap is not a zero — but only the whole order is full marks. */
export function markAnswer(question: CheckQuestion, answer: CheckAnswer): number {
  if (question.kind === 'pick') return answer === question.answer ? 1 : 0;
  if (question.kind === 'order') {
    if (!Array.isArray(answer) || answer.length !== question.steps.length) return 0;
    const placed = answer.filter((index, i) => index === i).length;
    return placed === answer.length ? 1 : Math.min(0.5, placed / answer.length);
  }
  const given = norm(typeof answer === 'string' ? answer : '');
  if (!given) return 0;
  const wanted = [question.answer, ...question.accept].map(norm).filter(Boolean);
  if (wanted.some((want) => want === given || given.includes(want) || want.includes(given))) return 1;
  // Most of the right words, in any order, is near enough.
  const words = norm(question.answer).split(' ').filter((word) => word.length > 2);
  const hits = words.filter((word) => given.includes(word)).length;
  return words.length && hits / words.length >= 0.6 ? 0.5 : 0;
}

export function markCheck(questions: CheckQuestion[], answers: CheckAnswer[]): Omit<CheckResult, 'at'> {
  const marks = questions.map((question, i) => markAnswer(question, answers[i] ?? null));
  const score = questions.length ? marks.reduce((a, b) => a + b, 0) / questions.length : 1;
  const missed = questions.filter((_, i) => marks[i] < 1).map((question) => question.why || question.q);
  return { score, missed, answers };
}

/** What the page says once the check is marked. */
export function verdictOf(result: Pick<CheckResult, 'score'>): { title: string; confident: boolean } {
  if (result.score >= 0.99) return { title: 'Got it.', confident: true };
  if (result.score >= 0.5) return { title: 'Mostly there.', confident: false };
  return { title: 'Not yet.', confident: false };
}

// ---------------------------------------------------------------------------
// The store: tracks in this browser
// ---------------------------------------------------------------------------

const KEY_PREFIX = 'learn:track:';
const KEY = (id: string) => `${KEY_PREFIX}${id}`;
const cache = new Map<string, LearnTrack>();
const listeners = new Set<() => void>();
let loadedFrom = '';
let loading: Promise<void> | null = null;
let running: { trackId: string; nodeId?: string; stream: { abort(): void } } | null = null;

const notify = () => listeners.forEach((listener) => listener());

export function subscribeLearn(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let snapshot: LearnTrack[] = [];
let snapshotAt = -1;
let version = 0;
/** Every track, newest opened first. The same array until something changes, as useSyncExternalStore wants. */
export function tracks(): LearnTrack[] {
  if (snapshotAt !== version) {
    snapshot = Array.from(cache.values()).sort((a, b) => (b.opened ?? b.updated) - (a.opened ?? a.updated));
    snapshotAt = version;
  }
  return snapshot;
}

export const trackFor = (id: string) => cache.get(id);

/** `persist`: nowhere (a stream's frame), here and in Drive, or here only (what came from Drive). */
function put(track: LearnTrack, persist: boolean | 'local' = true) {
  cache.set(track.id, track);
  version++;
  notify();
  if (persist) {
    const { mapping: _m, ...kept } = track;
    const pages: Record<string, LearnPage> = {};
    for (const [id, page] of Object.entries(kept.pages)) {
      const { streaming: _s, thinking: _t, pending: _p, ...page_ } = page;
      pages[id] = page_;
    }
    void db.setKv(KEY(track.id), { ...kept, pages }).catch(() => undefined);
    if (persist !== 'local') driveSave(track);
  }
}

/** The tracks kept in this browser's database, read once per database (it changes at sign-in). */
export function loadTracks(): Promise<void> {
  const from = currentDbName();
  if (loadedFrom === from) return loading ?? Promise.resolve();
  loadedFrom = from;
  loading = (async () => {
    try {
      const kept = await db.kvWithPrefix<LearnTrack>(KEY_PREFIX);
      if (currentDbName() !== from) return;
      for (const [, track] of kept) {
        const now = cache.get(track.id);
        if (!now || (track.updated ?? 0) > (now.updated ?? 0)) cache.set(track.id, { ...track, mapping: false, pages: Object.fromEntries(Object.entries(track.pages ?? {}).map(([id, page]) => [id, { ...page, streaming: false }])) });
      }
      version++;
      notify();
    } catch {
      // no IndexedDB: tracks live for this tab
    } finally {
      loading = null;
    }
    await syncFromDrive();
  })();
  return loading;
}

let synced: LearnDriveAdapter | null = null;
let syncing: Promise<void> | null = null;
/**
 * The tracks in Drive, read once per connection and merged: a track newer
 * there than here is taken (a page written in another browser), one newer
 * here goes up. Nothing is asked twice of the same connection.
 */
export function syncFromDrive(): Promise<void> {
  const adapter = drive;
  if (!adapter || synced === adapter) return syncing ?? Promise.resolve();
  synced = adapter;
  syncing = (async () => {
    try {
      const found = await adapter.load();
      for (const remote of found) {
        const now = cache.get(remote.id);
        const busy = running?.trackId === remote.id || now?.mapping;
        if (!now) put(remote, 'local');
        else if (!busy && (remote.updated ?? 0) > (now.updated ?? 0)) put({ ...remote, opened: Math.max(remote.opened ?? 0, now.opened ?? 0) || undefined }, 'local');
        else if (!busy && (now.updated ?? 0) > (remote.updated ?? 0)) put({ ...now, drive: now.drive ?? remote.drive });
        else if (!now.drive) put({ ...now, drive: remote.drive }, 'local');
        driveStates.set(remote.id, { state: 'saved', link: remote.drive?.link });
      }
      // Tracks made before Drive was connected go up now.
      for (const track of cache.values()) if (!track.drive && track.nodes.length && !track.mapping) driveSave(track);
      notify();
    } catch (error) {
      for (const track of cache.values()) driveStates.set(track.id, { state: 'error', message: error instanceof Error ? error.message : String(error) });
      synced = null;
      notify();
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** For a demo or a test: a track in place without asking anyone. */
export function putTrack(track: LearnTrack) {
  put(track);
}

export function deleteTrack(id: string) {
  if (running?.trackId === id) running.stream.abort();
  const track = cache.get(id);
  if (track && drive) void drive.remove(track).catch(() => undefined);
  window.clearTimeout(driveTimers.get(id));
  driveStates.delete(id);
  cache.delete(id);
  version++;
  notify();
  void db.deleteKv(KEY(id)).catch(() => undefined);
}

export function touchTrack(id: string) {
  const track = cache.get(id);
  if (track) put({ ...track, opened: Date.now() }, true);
}

export function stopLearning() {
  running?.stream.abort();
}

export const isWorking = (trackId: string, nodeId?: string) => running?.trackId === trackId && (nodeId === undefined || running.nodeId === nodeId);

// ---------------------------------------------------------------------------
// Drive: one file per page, under Learn/<topic>/ (learnDrive.ts)
// ---------------------------------------------------------------------------

export interface LearnDriveAdapter {
  /** Every track kept in Drive. */
  load(): Promise<LearnTrack[]>;
  /** The track written: track.json, and each page whose content changed since `written` (updated by node) last saw it. */
  save(track: LearnTrack, written: Record<string, number>): Promise<{ folderId: string; link?: string }>;
  /** Its folder put in Drive's trash. */
  remove(track: LearnTrack): Promise<void>;
}

let drive: LearnDriveAdapter | null = null;
const driveTimers = new Map<string, number>();
/** Which page content each track has had written to Drive, by node: updated stamps. */
const driveWritten = new Map<string, Record<string, number>>();
export type LearnDriveState = { state: 'saving' } | { state: 'saved'; link?: string } | { state: 'error'; message: string };
const driveStates = new Map<string, LearnDriveState>();
export const driveStateOf = (trackId: string) => driveStates.get(trackId);

/** Set by the app when Drive is connected, and cleared when it is not; a new connection is read once. */
export function setLearnDrive(adapter: LearnDriveAdapter | null) {
  drive = adapter;
  if (!adapter) {
    synced = null;
    driveStates.clear();
    notify();
  }
}

function driveSave(track: LearnTrack) {
  if (!drive || track.mapping || !track.nodes.length) return;
  window.clearTimeout(driveTimers.get(track.id));
  driveStates.set(track.id, { state: 'saving' });
  driveTimers.set(
    track.id,
    window.setTimeout(() => {
      driveTimers.delete(track.id);
      const adapter = drive;
      const now = cache.get(track.id);
      if (!adapter || !now) return;
      const written = driveWritten.get(track.id) ?? {};
      driveWritten.set(track.id, written);
      adapter
        .save(now, written)
        .then((mark) => {
          driveStates.set(track.id, { state: 'saved', link: mark.link });
          const latest = cache.get(track.id);
          if (latest && latest.drive?.folderId !== mark.folderId) put({ ...latest, drive: mark }, 'local');
        })
        .catch((error: unknown) => driveStates.set(track.id, { state: 'error', message: error instanceof Error ? error.message : String(error) }))
        .finally(notify);
    }, 1500),
  );
}

// ---------------------------------------------------------------------------
// Asking the model
// ---------------------------------------------------------------------------

type Params = { system: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[]; messages: { role: 'user' | 'assistant'; content: string }[] };

/** One streamed request, `onText` a frame at a time with everything so far; thinking shown meanwhile. */
async function streamOnce(trackId: string, nodeId: string | undefined, model: string, maxTokens: number, params: Params, onText: (text: string, thinking?: string) => void): Promise<{ stop: string | null }> {
  const stream = await streamModel({ model, maxTokens, ...params, effort: 'medium' });
  running = { trackId, nodeId, stream };
  let text = '';
  let thinking = '';
  let frame = 0;
  const paint = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      onText(text, thinking || undefined);
    });
  };
  stream.on('thinking', (delta: string) => {
    thinking += delta;
    paint();
  });
  stream.on('text', (delta: string) => {
    text += delta;
    thinking = '';
    paint();
  });
  try {
    const final = await stream.finalMessage();
    return { stop: final.stop_reason };
  } finally {
    if (frame) cancelAnimationFrame(frame);
    onText(text);
  }
}

const mapRequest = (track: LearnTrack) =>
  [tag('topic', track.topic), tag('reader_starts_from', track.from || 'a beginner'), tag('reader_wants_to_reach', track.to || 'a working understanding'), 'Write the map.'].filter(Boolean).join('\n\n');

/** Starts a track: the map is asked for now, and the first page when a box is opened. */
export async function startTrack(input: { topic: string; from: string; to: string; prefs: LearnPrefs; model: string }): Promise<string> {
  const track: LearnTrack = {
    id: newId(),
    topic: input.topic.trim(),
    from: input.from.trim(),
    to: input.to.trim(),
    prefs: input.prefs,
    model: input.model,
    created: Date.now(),
    updated: Date.now(),
    opened: Date.now(),
    stages: [],
    nodes: [],
    pages: {},
    progress: {},
    glossary: [],
    mapping: true,
  };
  put(track, false);
  await writeMap(track.id);
  return track.id;
}

/** Writes (or rewrites) the map. A remap keeps the pages and progress of nodes whose ids survive. */
export async function writeMap(trackId: string) {
  const track = cache.get(trackId);
  if (!track || running) return;
  put({ ...track, mapping: true, error: undefined }, false);
  let SDK: SDK | null = null;
  let reply = '';
  try {
    if (modelSpec(track.model).provider === 'anthropic') SDK = await sdk();
    const { stop } = await streamOnce(trackId, undefined, track.model, MAP_MAX_TOKENS, { system: [{ type: 'text', text: MAP_SYSTEM }], messages: [{ role: 'user', content: mapRequest(track) }] }, (text) => {
      reply = text;
    });
    if (stop === 'refusal') throw new Error(`${PROVIDERS[modelSpec(track.model).provider].name} declined to map this one.`);
    const map = parseMap(reply);
    if (!map) throw new Error('The map could not be read from the reply. Try again, or another model.');
    const now = cache.get(trackId) ?? track;
    put({ ...now, ...map, mapSrc: reply, mapping: false, updated: Date.now() });
  } catch (error) {
    const now = cache.get(trackId) ?? track;
    put({ ...now, mapping: false, error: explainError(error, SDK) });
  } finally {
    running = null;
  }
}

/** The map, as the page request describes it: every node, with what it needs and whether it is read. */
function mapText(track: LearnTrack): string {
  return track.nodes
    .map((node) => `- ${node.id}: ${node.title} [${node.stage}]${node.needs.length ? ` needs ${node.needs.join(', ')}` : ''}${track.progress[node.id] ? ' (read)' : ''}${node.kind === 'paper' ? ' (a paper to read)' : ''} — ${node.blurb}`)
    .join('\n');
}

/** What the model is told about this reader and this track, the same for every page, so it caches. */
function systemFor(track: LearnTrack) {
  const prefs = [
    track.prefs.pictures ? 'lead with pictures' : '',
    track.prefs.plainFirst ? 'plain first, the formal account in formal blocks' : 'the formal account inline, with the intuition beside it',
    track.prefs.code ? 'code cells where they teach' : 'no code cells',
    track.prefs.checks ? 'a check at the end' : 'no check block',
    track.prefs.generate !== false ? 'an illustration can be generated when no real picture is found, so an image block may ask for a scene no photograph exists of' : 'no generated pictures: ask only for pictures that exist',
  ]
    .filter(Boolean)
    .join('; ');
  return [
    { type: 'text' as const, text: PAGE_SYSTEM },
    {
      type: 'text' as const,
      text: [tag('topic', track.topic), tag('reader_starts_from', track.from || 'a beginner'), tag('reader_wants_to_reach', track.to || 'a working understanding'), tag('preferences', prefs), tag('map', mapText(track))].filter(Boolean).join('\n\n'),
      cache_control: { type: 'ephemeral' as const },
    },
  ];
}

/** The pages read so far, the terms they taught, and what the last check missed — then the ask. */
export function pageRequest(track: LearnTrack, nodeId: string): string {
  const node = track.nodes.find((n) => n.id === nodeId)!;
  const read = track.nodes.filter((n) => track.progress[n.id] && n.id !== nodeId).map((n) => `- ${n.title}: ${n.blurb}`);
  const glossary = track.glossary.map((entry) => `- ${entry.term} — ${entry.meaning}`);
  // The check on the page this one follows: the latest read page it needs, else the latest read page.
  const before = [...node.needs].reverse().map((need) => track.pages[need]).find((page) => page?.check) ?? Object.values(track.pages).filter((page) => page.check && track.progress[page.nodeId]).sort((a, b) => (b.check!.at ?? 0) - (a.check!.at ?? 0))[0];
  const missed = before?.check?.missed ?? [];
  return [
    read.length ? tag('pages_read', read.join('\n')) : '',
    glossary.length ? tag('glossary_so_far', glossary.join('\n')) : '',
    missed.length ? tag('bridge', `On the page “${track.nodes.find((n) => n.id === before!.nodeId)?.title ?? 'before'}” the reader's check found these wanting:\n${missed.map((m) => `- ${m}`).join('\n')}`) : '',
    `Write the page “${node.title}” (${node.id}): ${node.blurb}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Writes one page. A page written before is written again, over the same place. */
export async function writePage(trackId: string, nodeId: string) {
  const track = cache.get(trackId);
  const node = track?.nodes.find((n) => n.id === nodeId);
  if (!track || !node || running || node.kind === 'paper') return;
  const previous = track.pages[nodeId];
  const page: LearnPage = { nodeId, content: '', model: track.model, created: Date.now(), updated: Date.now(), streaming: true, revisions: previous?.revisions };
  const update = (patch: Partial<LearnPage>, persist = false) => {
    const now = cache.get(trackId);
    if (!now) return;
    Object.assign(page, patch);
    put({ ...now, pages: { ...now.pages, [nodeId]: { ...page } } }, persist);
  };
  update({});
  let SDK: SDK | null = null;
  try {
    if (modelSpec(track.model).provider === 'anthropic') SDK = await sdk();
    const { stop } = await streamOnce(trackId, nodeId, track.model, PAGE_MAX_TOKENS, { system: systemFor(track), messages: [{ role: 'user', content: pageRequest(track, nodeId) }] }, (text, thinking) => update({ content: text, thinking }));
    if (stop === 'max_tokens') page.truncated = true;
    if (stop === 'refusal') page.error = `${PROVIDERS[modelSpec(track.model).provider].name} declined to write this one.`;
  } catch (error) {
    page.error = explainError(error, SDK);
  } finally {
    running = null;
    const now = cache.get(trackId);
    if (now) {
      const finished: LearnPage = { ...page, streaming: false, thinking: undefined, updated: Date.now() };
      const taught = finished.content && !finished.error ? glossaryOf(parseExplanation(finished.content), nodeId) : [];
      put({
        ...now,
        pages: { ...now.pages, [nodeId]: finished },
        glossary: taught.length ? [...now.glossary.filter((entry) => entry.nodeId !== nodeId), ...taught] : now.glossary,
        updated: Date.now(),
      });
    }
  }
}

function revisionRequest(content: string, request: string): string {
  return [
    'The reader has a request about the page you wrote above.',
    tag('request', request),
    `Change the page to satisfy it. If it is a question, answer it inside the page: expand the section it belongs to, or add a
section right after it. If it asks to adjust the content (simpler, a picture, another example, deeper, less maths…), rewrite
only the sections that must change and keep every other section exactly as it is, the check and glossary included unless the
request is about them. If the request is to animate a figure, add ONE motion block right after it (keep the figure).

Reply ONLY with edit operations, each marker on a line of its own:
<<<replace: Exact title of an existing section>>>
## Title (the same one, or a better one)
the whole new content of that section
<<<insert after: Exact title of an existing section>>>
## A new section's title
its content
<<<delete: Exact title of an existing section>>>
and last of all:
<<<note>>>
One short sentence to the reader on what you changed.`,
    tag('existing_sections', sectionTitles(content).map((title) => `- ${title}`).join('\n')),
  ].join('\n\n');
}

/** Answers a request from the bar by editing the page's sections. */
export async function revisePage(trackId: string, nodeId: string, request: string, model?: string) {
  const track = cache.get(trackId);
  const current = track?.pages[nodeId];
  if (!track || !current?.content || running || current.streaming || !request.trim()) return;
  const answerer = model || current.model || track.model;
  const before = current.content;
  const pending = { request: request.trim(), reply: '', started: Date.now() };
  const update = (patch: Partial<LearnPage>, persist = false) => {
    const now = cache.get(trackId);
    if (!now) return;
    put({ ...now, pages: { ...now.pages, [nodeId]: { ...now.pages[nodeId], ...patch } } }, persist);
  };
  update({ pending: { ...pending }, error: undefined });
  let SDK: SDK | null = null;
  try {
    if (modelSpec(answerer).provider === 'anthropic') SDK = await sdk();
    const { stop } = await streamOnce(
      trackId,
      nodeId,
      answerer,
      PAGE_MAX_TOKENS,
      { system: systemFor(track), messages: [{ role: 'user', content: pageRequest(track, nodeId) }, { role: 'assistant', content: before }, { role: 'user', content: revisionRequest(before, pending.request) }] },
      (reply) => {
        pending.reply = reply;
        update({ pending: { ...pending } });
      },
    );
    if (stop === 'refusal') throw new Error(`${PROVIDERS[modelSpec(answerer).provider].name} declined that request.`);
    const applied = applyEdits(before, pending.reply);
    if (!applied.touched.length && applied.content === before) throw new Error(applied.note || `${PROVIDERS[modelSpec(answerer).provider].name} left the page as it was.`);
    const revision: LearnRevision = { request: pending.request, before, note: applied.note, touched: applied.touched, at: Date.now() };
    const taught = glossaryOf(parseExplanation(applied.content), nodeId);
    const now = cache.get(trackId)!;
    put({
      ...now,
      pages: { ...now.pages, [nodeId]: { ...now.pages[nodeId], content: applied.content, pending: undefined, updated: Date.now(), revisions: [...(current.revisions ?? []), revision].slice(-12) } },
      glossary: taught.length ? [...now.glossary.filter((entry) => entry.nodeId !== nodeId), ...taught] : now.glossary,
      updated: Date.now(),
    });
  } catch (error) {
    const message = explainError(error, SDK);
    update({ pending: message === 'Stopped.' ? undefined : { ...pending, error: message } });
  } finally {
    running = null;
  }
}

export function undoPageRevision(trackId: string, nodeId: string) {
  const track = cache.get(trackId);
  const page = track?.pages[nodeId];
  const last = page?.revisions?.[page.revisions.length - 1];
  if (!track || !page || !last || running) return;
  put({ ...track, pages: { ...track.pages, [nodeId]: { ...page, content: last.before, revisions: page.revisions!.slice(0, -1), pending: undefined, error: undefined, truncated: undefined, updated: Date.now() } }, updated: Date.now() });
}

export function dismissPagePending(trackId: string, nodeId: string) {
  const track = cache.get(trackId);
  const page = track?.pages[nodeId];
  if (!track || !page?.pending || running) return;
  put({ ...track, pages: { ...track.pages, [nodeId]: { ...page, pending: undefined } } }, false);
}

/** The live content of a page: with a request's reply so far applied, while one is being answered. */
export function shownContent(page: LearnPage | undefined): string {
  if (!page) return '';
  const pending = page.pending;
  if (pending && !pending.error) return applyEdits(page.content, pending.reply).content;
  return page.content;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/** Opening a page reads it; a page is never un-read. */
export function markRead(trackId: string, nodeId: string) {
  const track = cache.get(trackId);
  if (!track || track.progress[nodeId]) return;
  put({ ...track, progress: { ...track.progress, [nodeId]: 'read' }, updated: Date.now() });
}

export function markConfident(trackId: string, nodeId: string, confident = true) {
  const track = cache.get(trackId);
  if (!track) return;
  put({ ...track, progress: { ...track.progress, [nodeId]: confident ? 'confident' : 'read' }, updated: Date.now() });
}

/** The check marked and kept: a full score makes the page confident; anything less leaves it read. */
export function recordCheck(trackId: string, nodeId: string, questions: CheckQuestion[], answers: CheckAnswer[]): CheckResult {
  const result: CheckResult = { ...markCheck(questions, answers), at: Date.now() };
  const track = cache.get(trackId);
  if (track) {
    const page = track.pages[nodeId];
    put({
      ...track,
      pages: page ? { ...track.pages, [nodeId]: { ...page, check: result } } : track.pages,
      progress: { ...track.progress, [nodeId]: verdictOf(result).confident ? 'confident' : 'read' },
      updated: Date.now(),
    });
  }
  return result;
}

/** Puts a page back to unchecked, for another go. */
export function clearCheck(trackId: string, nodeId: string) {
  const track = cache.get(trackId);
  const page = track?.pages[nodeId];
  if (!track || !page?.check) return;
  const { check: _c, ...rest } = page;
  put({ ...track, pages: { ...track.pages, [nodeId]: rest } });
}

/** The node after this one in the map's order that is a page (a paper is opened, not written). */
export function nodeAfter(track: Pick<LearnTrack, 'nodes'>, nodeId: string): LearnNode | undefined {
  const at = track.nodes.findIndex((node) => node.id === nodeId);
  return at >= 0 ? track.nodes[at + 1] : undefined;
}

export function nodeBefore(track: Pick<LearnTrack, 'nodes'>, nodeId: string): LearnNode | undefined {
  const at = track.nodes.findIndex((node) => node.id === nodeId);
  return at > 0 ? track.nodes[at - 1] : undefined;
}

// ---------------------------------------------------------------------------
// Searching what has been learned: topics, pages, terms, and the pages' text
// ---------------------------------------------------------------------------

export interface SearchHit {
  kind: 'topic' | 'page' | 'term' | 'text';
  /** The page it points at, when it does. */
  nodeId?: string;
  label: string;
  /** A few words around the match. */
  snippet?: string;
}

export interface TrackMatch {
  track: LearnTrack;
  hits: SearchHit[];
}

const plain = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`$\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** A few words either side of the first place `needle` occurs in `text`, or '' when it does not. */
export function snippetOf(text: string, needle: string, span = 70): string {
  const haystack = plain(text);
  const at = haystack.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return '';
  const start = Math.max(0, at - span);
  const end = Math.min(haystack.length, at + needle.length + span);
  return `${start ? '…' : ''}${haystack.slice(start, end).trim()}${end < haystack.length ? '…' : ''}`;
}

/**
 * The tracks that match a query, best first: by topic, by a page's title,
 * by a term taught, and by the text of a page. Every word of the query must
 * be found somewhere in the track; a hit says where.
 */
export function searchTracks(all: readonly LearnTrack[], query: string): TrackMatch[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const has = (text: string | undefined) => Boolean(text) && words.every((word) => text!.toLowerCase().includes(word));
  const hasAny = (text: string | undefined) => Boolean(text) && words.some((word) => text!.toLowerCase().includes(word));
  const first = (text: string) => words.find((word) => text.toLowerCase().includes(word)) ?? words[0];
  const matches: TrackMatch[] = [];
  for (const track of all) {
    const hits: SearchHit[] = [];
    const about = `${track.topic} ${track.from} ${track.to}`;
    if (hasAny(about)) hits.push({ kind: 'topic', label: track.topic, snippet: [track.from, track.to].filter(Boolean).join(' → ') });
    for (const node of track.nodes) if (hasAny(`${node.title} ${node.blurb}`)) hits.push({ kind: 'page', nodeId: node.id, label: node.title, snippet: node.blurb });
    for (const entry of track.glossary) if (hasAny(`${entry.term} ${entry.meaning}`)) hits.push({ kind: 'term', nodeId: entry.nodeId, label: entry.term, snippet: entry.meaning });
    for (const page of Object.values(track.pages)) {
      if (!page.content || hits.some((hit) => hit.kind === 'page' && hit.nodeId === page.nodeId)) continue;
      if (hasAny(page.content)) {
        const node = track.nodes.find((n) => n.id === page.nodeId);
        hits.push({ kind: 'text', nodeId: page.nodeId, label: node?.title ?? page.nodeId, snippet: snippetOf(page.content, first(page.content)) });
      }
    }
    // Every word somewhere in the track, else it is not a match at all.
    const everything = `${about} ${track.nodes.map((n) => `${n.title} ${n.blurb}`).join(' ')} ${track.glossary.map((e) => `${e.term} ${e.meaning}`).join(' ')} ${Object.values(track.pages).map((p) => p.content).join(' ')}`;
    if (hits.length && has(everything)) matches.push({ track, hits: hits.slice(0, 8) });
  }
  const weight = (match: TrackMatch) => (match.hits.some((h) => h.kind === 'topic') ? 100 : 0) + match.hits.length;
  return matches.sort((a, b) => weight(b) - weight(a) || (b.track.opened ?? b.track.updated) - (a.track.opened ?? a.track.updated));
}

/** Where a track stands, for a list: not started, in progress, stalled (not opened for a while), or finished. */
export function trackStatus(track: LearnTrack, now = Date.now()): 'new' | 'reading' | 'stalled' | 'finished' {
  const counts = countRead(track);
  if (!counts.total || !counts.read) return 'new';
  if (counts.read >= counts.total) return 'finished';
  return now - (track.opened ?? track.updated) > 7 * 24 * 3600 * 1000 ? 'stalled' : 'reading';
}

// ---------------------------------------------------------------------------
// Opening Learn from elsewhere: "Teach me this" on a selection, a track's page
// ---------------------------------------------------------------------------

/** Home's Learn tab, with a topic to start from. */
export const OPEN_LEARN = 'reader:open-learn';
/** A page of a track, over everything. */
export const OPEN_LEARN_PAGE = 'reader:open-learn-page';

export function askToLearn(topic: string, context?: string) {
  window.dispatchEvent(new CustomEvent(OPEN_LEARN, { detail: { topic, context } }));
}

export function openLearnPage(trackId: string, nodeId: string) {
  window.dispatchEvent(new CustomEvent(OPEN_LEARN_PAGE, { detail: { trackId, nodeId } }));
}

/** A page as a Markdown file, for Drive and for export: front matter, then the page as written. */
export function pageFile(track: LearnTrack, page: LearnPage): string {
  const node = track.nodes.find((n) => n.id === page.nodeId);
  const line = (key: string, value: unknown) => `${key}: ${JSON.stringify(value)}`;
  return [
    '---',
    line('generator', 'reader'),
    line('topic', track.topic),
    line('page', node?.title ?? page.nodeId),
    line('model', page.model),
    line('written', new Date(page.created).toISOString()),
    line('updated', new Date(page.updated).toISOString()),
    ...(page.check ? [line('check', Math.round(page.check.score * 100) / 100)] : []),
    '---',
    '',
    page.content.trim(),
    '',
  ].join('\n');
}
