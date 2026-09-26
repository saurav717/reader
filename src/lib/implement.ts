// ===========================================================================
//  Implementation — the paper as a project, planned by Claude.
//
//  The second page of Explain. Where the explanation teaches what the paper
//  says, this one plans how to build it: what to reproduce and what to leave
//  out, which datasets to use and where they come from, how to lay the code
//  out, what the starter files say, what the work costs in FLOPs and memory —
//  and, because a budget in FLOPs means nothing until it meets a machine, the
//  hours and dollars for the hardware the reader picks (hardware.ts).
//
//  It is written in the same Markdown as the explanation, with the same four
//  blocks, plus three of its own the page draws:
//
//    ```tree                       the repository's directories and files
//    ```file path="src/train.py"   a starter file, kept whole: together they are the scaffold
//    ```compute                    the work, as JSON: FLOPs a phase, memory, disk
//
//  and ```bash title="…" cells beside the Python ones. The starter files can
//  be downloaded as a zip, written into a Colab notebook that lays them out,
//  or committed to the reader's Git repository and opened in Colab from there.
//  One page per paper, kept in IndexedDB like the explanation; the same key,
//  models and edit operations as explain.ts.
// ===========================================================================

import { explainError, FULL_TEXT_MAX_CHARS, modelSpec, PROVIDERS, sdk, streamModel, tag } from './assistant';
import type { Screen, SDK } from './assistant';
import { db } from './db';
import { applyEdits, notebook, sectionTitles } from './explain';
import type { Explanation, Revision, RevisionScope, Section } from './explain';
import { hardwareText, parseCompute, readHardware, writeHardware } from './hardware';
import type { Compute, Hardware } from './hardware';
import type { RepoFiles } from './github';
import { zip } from './zip';

const MAX_TOKENS = 64000;

export const IMPLEMENT_SYSTEM = `You are writing the IMPLEMENTATION page of a research-paper reader: a plan for building what ONE paper
describes, which an engineer or graduate student follows to reproduce it. The full text of the paper and its details
are given below, and the machine the reader has to run it on. Today is ${new Date().toISOString().slice(0, 10)}.

Write as a senior engineer handing a colleague a project: concrete, opinionated, honest about what is feasible on
their hardware. Every design choice gets its reasoning and its alternative. Where the paper leaves a detail out
(a hyper-parameter, a preprocessing step, a seed), say so and pick a sensible default rather than pretending.
Never invent datasets, libraries, model checkpoints or results; name a public one only when you are sure it exists.

FORMAT — plain Markdown with "## " sections in this order (no "#" headings; "###" is fine inside a section):
1. "## At a glance": what will be built, in 3–5 bullets; the smallest faithful reproduction; whether the reader's
   machine is enough for it, and if not, what scaled-down version is.
2. "## What to build, and what to leave out": a table of the paper's components with a column "Build it?"
   (Yes / Simplify / Skip) and why. Then the key design decisions as short sub-headings, each with the
   alternative considered.
3. "## Datasets": a table — dataset, what it is for, size, licence, where to get it — then how to get and
   prepare each one, as \`\`\`bash title="…"\` cells. Say what the paper used and what to use instead
   when that is not public, and how much the substitute changes the result.
4. "## Repository layout": ONE \`\`\`tree block listing every directory and file, one a line, indented with
   box-drawing characters (├── └── │) or two spaces a level, directories ending in "/", and after each entry two
   spaces and "# " with what it holds. Then a paragraph on the split: what each module owns and why.
5. "## Starter files": the files worth writing before anything else, each as
   \`\`\`file path="relative/path.ext"\` with its full content — a config, the model or the core algorithm as
   a skeleton with TODOs where the paper's maths goes, the training entry point, a Makefile or run script, and
   a README with the commands. 4–8 files, each ≤ 80 lines; the same paths as in the tree. Real, runnable code
   over pseudocode; write the paper's central equations out in the code and cite the paper's equation numbers
   in comments.
6. "## The pipeline, step by step": data → model → training → evaluation as a figure, then the order to build
   and test things in, with what to check at each step before moving on.
7. "## Compute budget": ONE \`\`\`compute block of JSON:
   {"params_b": <model size in billions>, "tokens_b": <tokens or samples the main phase runs over, in billions>,
    "phases": [{"name": "…", "flops": <total floating-point operations, a number like 3.0e19>,
                "memory_gb": <accelerator memory the phase needs, total>, "parallel": true, "note": "one line"},
               {"name": "Evaluation", "h100_hours": <hours on one H100, for work that is not FLOP-bound>, "memory_gb": …}],
    "min_vram_gb": <the least accelerator memory any faithful configuration needs>,
    "shrink": "how to get under that: smaller batch, gradient checkpointing, 8-bit optimiser, LoRA, a smaller model…",
    "ram_gb": <system memory needed>, "disk_gb": <datasets and checkpoints>}
   Work the FLOPs out in prose under it (for a transformer: 6 × parameters × tokens for training, 2 × for a
   forward pass, the teacher's forward passes added for distillation) so the reader can check them, and say what
   utilisation you assume. The page turns the block into hours and dollars for the reader's machine, so do NOT put
   hours in the block — put them in the prose only for the paper's own hardware. Then a table of what changes at
   each scale: full paper, a faithful small version, and the smallest thing that still tests the idea.
8. "## Constraints and pitfalls": numerical, memory, licensing, and the mistakes people make reproducing this;
   each with how to notice it and what to do.
9. "## Evaluation": the metrics, the exact numbers from the paper to match (a table), how much variance to
   expect, and a \`\`\`python title="…"\` cell that computes the headline metric.
10. "## Milestones": a checklist of 6–10 steps in order, each with what "done" looks like and roughly how long it
    takes on the reader's hardware.

The blocks the page draws (the same as the explanation page):
- Diagrams: \`\`\`figure caption="…"\` holding ONE <svg> with a viewBox, no width/height, no scripts, no images,
  coloured only with these classes: fill f-accent, f-soft, f-yellow, f-blue, f-green, f-pink, f-paper;
  stroke s-ink, s-muted, s-accent; text t-muted, t-accent, t-on. Keep text ≥ 11 units.
- Code: \`\`\`python title="…"\` for a runnable, seeded cell that prints something, followed by \`\`\`output\`
  with what it prints; \`\`\`bash title="…"\` for shell commands. Plain \`\`\`yaml or \`\`\`json fences inside prose
  are fine for short snippets, but a whole file goes in a file block.
- Caveats: \`\`\`caveat verdict="holds|refined|superseded|disputed|disproved" title="…"\` where a detail of the
  paper's method has since been replaced by something better, and what to use today.
- Maths as LaTeX between $…$ or $$…$$, never in code spans.
- Tables wherever a choice is being made: pipe tables with a header row.`;

// ---------------------------------------------------------------------------
// The reader's hardware: read from the page's picker, sent with every request
// ---------------------------------------------------------------------------

let hardware: Hardware | null = null;
const hardwareListeners = new Set<() => void>();

export function hardwareNow(): Hardware {
  if (!hardware) hardware = readHardware();
  return hardware;
}

export function setHardware(next: Hardware) {
  hardware = next;
  writeHardware(next);
  hardwareListeners.forEach((listener) => listener());
}

export function subscribeHardware(listener: () => void) {
  hardwareListeners.add(listener);
  return () => {
    hardwareListeners.delete(listener);
  };
}

/** The first compute block on the page, read. */
export function computeOf(sections: Section[]): Compute | null {
  for (const section of sections) for (const block of section.blocks) if (block.kind === 'compute' && !block.open) return parseCompute(block.text);
  return null;
}

// ---------------------------------------------------------------------------
// A directory tree, as Claude draws it
// ---------------------------------------------------------------------------

export interface TreeRow {
  depth: number;
  name: string;
  dir: boolean;
  note: string;
}

/** Reads a tree drawn with box characters or plain indentation, a row a line. */
export function parseTree(text: string): TreeRow[] {
  const found: { width: number; boxed: boolean; name: string; note: string }[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    // Everything before the name is the drawing: box characters, spaces, pipes.
    const match = /^([\s│|├└─┌┐┘┬┴┼\\-]*?)([^\s│|├└─#][^#]*?)(?:\s{2,}#\s*(.*)|\s+#\s*(.*))?\s*$/.exec(raw.replace(/\t/g, '    '));
    if (!match) continue;
    const prefix = match[1];
    // A branch ("├── ", "└── ") is one level, four columns wide, like the "│   " above it.
    const width = prefix.replace(/[├└]──\s?/g, '    ').length;
    found.push({ width, boxed: /[│├└]/.test(prefix), name: match[2].trim(), note: (match[3] ?? match[4] ?? '').trim() });
  }
  if (!found.length) return [];
  // A level is four columns when the tree is drawn with box characters, else the smallest indent it uses.
  const indents = found.map((row) => row.width).filter(Boolean);
  const unit = found.some((row) => row.boxed) ? 4 : indents.length ? Math.min(...indents) : 1;
  const least = Math.min(...found.map((row) => row.width));
  return found.map((row) => ({ depth: Math.round((row.width - least) / unit), name: row.name, dir: row.name.endsWith('/'), note: row.note }));
}

// ---------------------------------------------------------------------------
// The scaffold: the starter files, as a zip, a notebook, or a commit
// ---------------------------------------------------------------------------

/** A folder name from the title: lower case, dashes, cut at a word to about sixty characters. */
export function slugOf(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '');
  const cut = base.length > 60 ? base.slice(0, 60).replace(/-[^-]*$/, '') : base;
  return cut || 'paper';
}

/** Every starter file on the page, by path. */
export function starterFiles(sections: Section[]): RepoFiles {
  const files: RepoFiles = {};
  for (const section of sections)
    for (const block of section.blocks) if (block.kind === 'file' && !block.open) files[block.path.replace(/^\.?\//, '')] = block.code.replace(/\s+$/, '') + '\n';
  return files;
}

/** The page itself as Markdown, so the plan travels with the code. */
export function planMarkdown(title: string, content: string): string {
  return `# ${title} — implementation plan\n\n*Planned by Claude in Reader. The starter files beside this are the ones it wrote; the compute budget was worked out for the hardware picked when it was written.*\n\n${content.trim()}\n`;
}

/** A notebook that lays the repository out (a cell a file), then runs the page's cells. */
export function scaffoldNotebook(title: string, sections: Section[]): string {
  const book = JSON.parse(notebook(title, sections)) as { cells: { cell_type: string; source: string[] }[] };
  const paths = Object.keys(starterFiles(sections));
  const dirs = Array.from(new Set(paths.map((path) => path.split('/').slice(0, -1).join('/')).filter(Boolean)));
  if (dirs.length) {
    book.cells.splice(1, 0, {
      cell_type: 'code',
      source: `# The directories the starter files below are written into\nimport os\nfor d in ${JSON.stringify(dirs)}:\n    os.makedirs(d, exist_ok=True)\nprint("ready:", ", ".join(${JSON.stringify(dirs)}))\n`.split(/(?<=\n)/),
      ...{ execution_count: null, metadata: {}, outputs: [] },
    } as never);
  }
  book.cells[0].source = `# ${title} — implementation\n\n*Planned by Claude in Reader. Run the cells in order: the first ones write the starter files into this session's disk, the rest are the page's own cells. Outputs shown under a cell were written by Claude, not run.*\n`.split(/(?<=\n)/);
  return JSON.stringify(book, null, 1);
}

/** The files a commit or a zip holds: the starter files, the plan, and the notebook, under one folder. */
export function scaffold(title: string, content: string, sections: Section[]): { folder: string; files: RepoFiles } {
  const folder = `implementations/${slugOf(title)}`;
  const files: RepoFiles = {};
  for (const [path, text] of Object.entries(starterFiles(sections))) files[`${folder}/${path}`] = text;
  files[`${folder}/PLAN.md`] = planMarkdown(title, content);
  files[`${folder}/${slugOf(title)}.ipynb`] = scaffoldNotebook(title, sections);
  return { folder, files };
}

export function scaffoldZip(title: string, content: string, sections: Section[]): Uint8Array {
  const { files } = scaffold(title, content, sections);
  return zip(Object.entries(files).map(([path, text]) => ({ path: path.replace(/^implementations\//, ''), content: text })));
}

/** Colab opens a notebook straight from GitHub, if it can read the repository. */
export const colabUrl = (owner: string, repo: string, branch: string, path: string) =>
  `https://colab.research.google.com/github/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${encodeURIComponent(branch)}/${path.split('/').map(encodeURIComponent).join('/')}`;

// ---------------------------------------------------------------------------
// The store: one plan per paper, streamed once and kept
// ---------------------------------------------------------------------------

const REVISIONS_KEPT = 12;
const KEY = (paperId: string) => `implement:${paperId}`;
const cache = new Map<string, Explanation>();
const listeners = new Set<() => void>();
let running: { paperId: string; stream: { abort(): void } } | null = null;

const notify = () => listeners.forEach((listener) => listener());

export function subscribeImplement(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const implementationFor = (paperId: string) => cache.get(paperId);

function persist(entry: Explanation) {
  const { pending: _pending, streaming: _streaming, thinking: _thinking, ...kept } = entry;
  void db.setKv(KEY(entry.paperId), { ...kept, updated: Date.now() }).catch(() => undefined);
}

export async function loadImplementation(paperId: string): Promise<Explanation | undefined> {
  if (!cache.has(paperId)) {
    try {
      const kept = await db.getKv<Explanation>(KEY(paperId));
      if (kept && !cache.has(paperId)) {
        cache.set(paperId, { ...kept, streaming: false, thinking: undefined, pending: undefined });
        notify();
      }
    } catch {
      // no IndexedDB: written again
    }
  }
  return cache.get(paperId);
}

/** For a demo or a test: put a plan in place without asking anyone. */
export function putImplementation(plan: Explanation) {
  cache.set(plan.paperId, plan);
  notify();
  persist(plan);
}

export function stopImplementing() {
  running?.stream.abort();
}

export const isImplementing = (paperId: string) => running?.paperId === paperId;

/** The system prompt: the instructions, then the paper behind a cache breakpoint, then the reader's machine. */
function systemFor(screen: Screen) {
  const paper = screen.paper!;
  const text = screen.fullText?.trim() ?? '';
  const details = [
    `Title: ${paper.title}`,
    paper.authors.length ? `Authors: ${paper.authors.join(', ')}` : '',
    paper.published ? `Published: ${paper.published}` : '',
    paper.venue ? `Venue: ${paper.venue}` : '',
    paper.arxivId ? `arXiv: ${paper.arxivId}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return [
    { type: 'text' as const, text: IMPLEMENT_SYSTEM },
    {
      type: 'text' as const,
      text: [tag('paper', details), tag('abstract', paper.abstract), tag('paper_text', text.slice(0, FULL_TEXT_MAX_CHARS))].filter(Boolean).join('\n\n'),
      cache_control: { type: 'ephemeral' as const },
    },
    // The machine comes after the breakpoint: changing it must not throw the paper out of the cache.
    { type: 'text' as const, text: tag('readers_hardware', hardwareText(hardwareNow())) },
  ];
}

const firstAsk = (screen: Screen) =>
  screen.fullText?.trim()
    ? 'Write the implementation page for this paper, for my hardware.'
    : 'Only the details and abstract of this paper could be read, not its full text. Write the implementation page from them and what you reliably know of the paper, for my hardware, and say at the top that the full text was not available.';

function setThinking(paperId: string, thinking: string | undefined) {
  const entry = cache.get(paperId);
  if (!entry || entry.thinking === thinking) return;
  cache.set(paperId, { ...entry, thinking });
  notify();
}

async function streamOnce(
  paperId: string,
  model: string,
  params: { system: ReturnType<typeof systemFor>; messages: { role: 'user' | 'assistant'; content: string }[] },
  onText: (text: string) => void,
): Promise<{ stop: string | null }> {
  const stream = await streamModel({ model, maxTokens: MAX_TOKENS, ...params, effort: 'medium' });
  running = { paperId, stream };
  let text = '';
  let thinking = '';
  let frame = 0;
  const paint = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      onText(text);
      setThinking(paperId, thinking || undefined);
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
    setThinking(paperId, undefined);
  }
}

export async function generateImplementation(screen: Screen, model: string) {
  const paper = screen.paper;
  if (!paper || running) return;
  const previous = cache.get(paper.id);
  const entry: Explanation = { paperId: paper.id, content: '', model, created: Date.now(), streaming: true };
  cache.set(paper.id, entry);
  notify();

  let SDK: SDK | null = null;
  try {
    if (modelSpec(model).provider === 'anthropic') SDK = await sdk();
    const { stop } = await streamOnce(paper.id, model, { system: systemFor(screen), messages: [{ role: 'user', content: firstAsk(screen) }] }, (text) => {
      entry.content = text;
      cache.set(paper.id, { ...entry });
      notify();
    });
    if (stop === 'max_tokens') entry.truncated = true;
    if (stop === 'refusal') entry.error = `${PROVIDERS[modelSpec(model).provider].name} declined to write this one.`;
  } catch (error) {
    entry.error = explainError(error, SDK);
  } finally {
    running = null;
    entry.streaming = false;
    if (previous?.content && entry.content) {
      entry.revisions = [
        ...(previous.revisions ?? []),
        { request: 'Rewrite the whole page', before: previous.content, note: 'Written again from scratch.', touched: [], at: Date.now() },
      ].slice(-REVISIONS_KEPT);
    }
    cache.set(paper.id, { ...entry });
    notify();
    if (entry.content && !entry.error) persist(entry);
  }
}

function revisionRequest(content: string, request: string, scope: RevisionScope): string {
  return [
    'The reader has a request about the implementation page you wrote above.',
    tag('request', request),
    tag('about_section', scope.section),
    tag('selected_passage', scope.quote),
    tag('readers_hardware_now', hardwareText(hardwareNow())),
    `Change the page to satisfy it. If it is a question, answer it inside the page: expand the section it belongs to, or add a
new section right after that one. If it asks to adjust the plan (a different dataset, PyTorch Lightning instead of a loop,
a smaller model, their hardware changed…), rewrite only the sections that must change — the compute block and the starter
files included, when they are affected — and keep every other section exactly as it is. Follow the same format rules.

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
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function reviseImplementation(screen: Screen, request: string, scope: RevisionScope = {}) {
  const paper = screen.paper;
  const current = paper && cache.get(paper.id);
  if (!paper || !current?.content || running || current.streaming || !request.trim()) return;
  const before = current.content;
  const pending = { request: request.trim(), scope, reply: '' };
  const update = (patch: Partial<Explanation>) => {
    const next = { ...cache.get(paper.id)!, ...patch };
    cache.set(paper.id, next);
    notify();
    return next;
  };
  update({ pending: { ...pending }, error: undefined });

  let SDK: SDK | null = null;
  try {
    if (modelSpec(current.model).provider === 'anthropic') SDK = await sdk();
    const { stop } = await streamOnce(
      paper.id,
      current.model,
      {
        system: systemFor(screen),
        messages: [
          { role: 'user', content: firstAsk(screen) },
          { role: 'assistant', content: before },
          { role: 'user', content: revisionRequest(before, pending.request, scope) },
        ],
      },
      (reply) => {
        pending.reply = reply;
        update({ pending: { ...pending } });
      },
    );
    if (stop === 'refusal') throw new Error(`${PROVIDERS[modelSpec(current.model).provider].name} declined that request.`);
    const applied = applyEdits(before, pending.reply, scope.section);
    if (!applied.touched.length && applied.content === before) throw new Error(applied.note || `${PROVIDERS[modelSpec(current.model).provider].name} left the page as it was.`);
    const revision: Revision = { request: pending.request, before, note: applied.note, touched: applied.touched, at: Date.now() };
    const next = update({
      content: applied.content,
      pending: undefined,
      truncated: stop === 'max_tokens' ? true : undefined,
      revisions: [...(current.revisions ?? []), revision].slice(-REVISIONS_KEPT),
      requests: [...(current.requests ?? []), revision.request],
    });
    persist(next);
  } catch (error) {
    const message = explainError(error, SDK);
    update({ pending: message === 'Stopped.' ? undefined : { ...pending, error: message } });
  } finally {
    running = null;
  }
}

export function undoImplementRevision(paperId: string) {
  const entry = cache.get(paperId);
  const last = entry?.revisions?.[entry.revisions.length - 1];
  if (!entry || !last || running) return;
  const next = {
    ...entry,
    content: last.before,
    revisions: entry.revisions!.slice(0, -1),
    requests: entry.requests?.at(-1) === last.request ? entry.requests.slice(0, -1) : entry.requests,
    pending: undefined,
    error: undefined,
    truncated: undefined,
  };
  cache.set(paperId, next);
  notify();
  persist(next);
}

export function dismissImplementPending(paperId: string) {
  const entry = cache.get(paperId);
  if (!entry?.pending || running) return;
  cache.set(paperId, { ...entry, pending: undefined });
  notify();
}
