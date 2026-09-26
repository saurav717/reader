// ===========================================================================
//  Explain — the whole paper, taught by Claude.
//
//  One long answer per paper: what it claims, how it works, why that works
//  better than what came before, drawn as figures and written as code you can
//  run, and — because a paper does not update itself — what has happened to
//  its claims since. It is written in plain Markdown with four kinds of fenced
//  block the view draws specially:
//
//    ```figure caption="…"      an inline SVG diagram
//    ```python title="…"        a runnable cell (Colab is wired up later)
//    ```output                  what the cell above prints, as Claude expects it
//    ```caveat verdict="…" title="…"   a claim that has aged: holds, refined,
//                                      superseded, disputed or disproved
//
//  Everything else is ordinary Markdown, and `## ` headings are the sections
//  the outline lists. The same key and SDK as Ask Claude (assistant.ts); the
//  finished text is kept per paper in IndexedDB, so it is paid for once.
// ===========================================================================

import { explainError, FULL_TEXT_MAX_CHARS, modelSpec, PROVIDERS, sdk, streamModel, tag } from './assistant';
import type { Screen, SDK } from './assistant';
import { db } from './db';

/**
 * The explanation is long by design; this caps a runaway, it does not budget one.
 * Thinking comes out of the same allowance, so it has room for both.
 */
const MAX_TOKENS = 64000;

export const EXPLAIN_SYSTEM = `You are writing the explanation page of a research-paper reader: a long-form,
teach-it-properly walkthrough of ONE paper, which the reader studies instead of (or beside) the paper itself.
The full text of the paper and its details are given below.

Write for a capable reader who is new to this paper — a graduate student or engineer. Your job:
1. Explain what problem the paper solves and why it mattered at the time.
2. Explain HOW the method works, step by step, with the intuition before the formalism.
3. Explain WHY it works better than what came before — the mechanism, not just the numbers.
4. Show it: small diagrams and small runnable Python that make each key idea concrete.
5. Be honest about age. Today is ${new Date().toISOString().slice(0, 10)}. Say what later work has confirmed,
   refined, superseded, disputed or disproved, and what the paper's own experiments could not show.
   If you are not sure whether a later result exists, say so rather than inventing one. Never invent citations.

FORMAT — plain Markdown, with these rules the page depends on:
- Start with "## At a glance": 3–5 bullets, then one sentence on who should care.
- Then 4–8 sections, each "## <short title>". No "#" headings. "###" is fine inside a section.
- Diagrams: a fenced block \`\`\`figure caption="One-line caption"\` containing ONE self-contained <svg> with a
  viewBox and no width/height, no scripts, no external images, no fonts other than inherited ones.
  Colour it ONLY with these classes (the page themes them for light and dark):
  fill: f-accent, f-soft, f-yellow, f-blue, f-green, f-pink, f-paper; stroke: s-ink, s-muted, s-accent;
  text: t-muted, t-accent, t-on (for text on f-accent; text is ink by default). Lines default to the ink colour. Keep text ≥ 11 units.
  One or two figures per key idea is plenty; skip them where words are clearer.
- Code: \`\`\`python title="What this cell shows"\` — short (≤ 40 lines), self-contained, numpy (or torch
  when it matters) only, deterministic (seed it), and it must print something that proves the point.
  Follow each cell with \`\`\`output\` holding what it prints. These cells will be run in Google Colab.
- Caveats: \`\`\`caveat verdict="holds|refined|superseded|disputed|disproved" title="The claim, in a few words"\`
  then 1–4 sentences of Markdown: what changed, and roughly when and by whom (only if you are confident).
  Put a caveat right where the claim is explained, AND end with a section "## Since then" that lists every
  caveat again as a short verdict table followed by what a reader should use today instead.
- Name papers only when you are sure they exist.

MATHS — the page typesets LaTeX, so write every formula, symbol and variable name as LaTeX:
- Inline between single dollars, $\\nabla \\cdot u = 0$; a displayed equation on lines of its own between double dollars:
  $$
  \\partial_t u + (u \\cdot \\nabla) u = \\nu \\Delta u - \\nabla p
  $$
  Never put maths in \`code\` spans or in a plain \`\`\` block, and never write it as Unicode approximations.
- Teach the maths, as much as the paper needs and no more. For each equation that carries the argument: say in words
  what it states, name every symbol the first time it appears (a short "where …" list under a displayed equation works
  well), and give the intuition — what each term does, why it has that form, what happens in a simple or limiting case.
  Walk through the key steps of a derivation or proof one move at a time, saying why each move is allowed, rather than
  jumping to the result. A paper with little maths needs little of this; a mathematical paper needs a lot of it.`;

// ---------------------------------------------------------------------------
// Parsing — forgiving, since it runs on every streamed token
// ---------------------------------------------------------------------------

export type Verdict = 'holds' | 'refined' | 'superseded' | 'disputed' | 'disproved';
export const VERDICTS: Record<Verdict, string> = {
  holds: 'Still holds',
  refined: 'Refined since',
  superseded: 'Superseded',
  disputed: 'Disputed',
  disproved: 'Disproved',
};

export type Block =
  | { kind: 'prose'; md: string }
  | { kind: 'figure'; svg: string; caption: string; open: boolean }
  | { kind: 'code'; lang: string; title: string; code: string; output?: string; open: boolean }
  | { kind: 'caveat'; verdict: Verdict; title: string; md: string }
  // The Implementation page's own blocks (implement.ts): a directory tree, a
  // starter file, and the work in the paper as numbers the page turns into hours.
  | { kind: 'tree'; text: string; open: boolean }
  | { kind: 'file'; path: string; lang: string; code: string; open: boolean }
  | { kind: 'compute'; text: string; open: boolean };

/** The language a starter file is coloured as, from its name. */
export function langOf(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (/^(py|pyi)$/.test(ext)) return 'python';
  if (/^(sh|bash|zsh)$/.test(ext) || /^(makefile|dockerfile)$/i.test(path.split('/').pop() ?? '')) return 'bash';
  if (/^(yml|yaml)$/.test(ext)) return 'yaml';
  if (/^(json|jsonl)$/.test(ext)) return 'json';
  if (/^(toml|cfg|ini)$/.test(ext)) return 'toml';
  if (/^(md|markdown)$/.test(ext)) return 'markdown';
  return 'text';
}

export interface Section {
  id: string;
  title: string;
  blocks: Block[];
}

const attrs = (info: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const match of info.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) out[match[1].toLowerCase()] = match[2];
  return out;
};

const slug = (text: string, taken: Set<string>) => {
  const base = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
};

const asVerdict = (value: string | undefined): Verdict =>
  value && value.toLowerCase() in VERDICTS ? (value.toLowerCase() as Verdict) : 'refined';

/** Marks a fence closed only so the sections after it survive; the block itself is still being written. */
const STILL_OPEN = '<!--open-->';
const CLOSE = /^\s*```\s*(<!--open-->)?\s*$/;

export function parseExplanation(src: string): Section[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const sections: Section[] = [];
  const taken = new Set<string>();
  let current: Section = { id: 'intro', title: '', blocks: [] };
  let prose: string[] = [];

  const flush = () => {
    const md = prose.join('\n').trim();
    if (md) current.blocks.push({ kind: 'prose', md });
    prose = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      if (current.title || current.blocks.length) sections.push(current);
      current = { id: slug(heading[1], taken), title: heading[1], blocks: [] };
      continue;
    }
    const fence = /^\s*```\s*([\w+-]*)(.*)$/.exec(line);
    if (fence) {
      const lang = fence[1].toLowerCase();
      const info = attrs(fence[2] ?? '');
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !CLOSE.test(lines[j])) body.push(lines[j++]);
      // Still streaming: the fence never closed, or a revision closed it for us (see applyEdits).
      const open = j >= lines.length || lines[j].includes(STILL_OPEN);
      const text = body.join('\n');
      i = j;
      if (lang === 'figure' || lang === 'svg') {
        flush();
        current.blocks.push({ kind: 'figure', svg: text, caption: info.caption ?? '', open });
      } else if (lang === 'caveat') {
        flush();
        current.blocks.push({ kind: 'caveat', verdict: asVerdict(info.verdict), title: info.title ?? '', md: text.trim() });
      } else if (lang === 'output') {
        flush();
        const last = current.blocks[current.blocks.length - 1];
        if (last?.kind === 'code') last.output = text;
        else current.blocks.push({ kind: 'code', lang: 'text', title: 'Output', code: text, open });
      } else if (lang === 'python' || lang === 'py') {
        flush();
        current.blocks.push({ kind: 'code', lang: 'python', title: info.title ?? '', code: text, open });
      } else if (lang === 'bash' || lang === 'sh' || lang === 'shell') {
        // A shell cell: a bash block with a title is a cell of the page; one without is ordinary Markdown code.
        if (info.title === undefined) {
          prose.push(line, ...body);
          if (!open) prose.push('```');
        } else {
          flush();
          current.blocks.push({ kind: 'code', lang: 'bash', title: info.title, code: text, open });
        }
      } else if (lang === 'tree') {
        flush();
        current.blocks.push({ kind: 'tree', text: text.replace(/^\s*\n|\s+$/g, ''), open });
      } else if (lang === 'file' && info.path) {
        flush();
        current.blocks.push({ kind: 'file', path: info.path, lang: info.lang ?? langOf(info.path), code: text, open });
      } else if (lang === 'compute') {
        flush();
        current.blocks.push({ kind: 'compute', text, open });
      } else {
        // Any other fence is ordinary Markdown code; hand it back to the prose.
        prose.push(line, ...body);
        if (!open) prose.push('```');
      }
      continue;
    }
    prose.push(line);
  }
  flush();
  if (current.title || current.blocks.length) sections.push(current);
  return sections;
}

export const caveatsOf = (sections: Section[]) =>
  sections.flatMap((section) =>
    section.blocks.filter((b): b is Extract<Block, { kind: 'caveat' }> => b.kind === 'caveat').map((b) => ({ ...b, section: section.id })),
  );

// ---------------------------------------------------------------------------
// A notebook of the whole explanation, for Colab until the page can run cells
// ---------------------------------------------------------------------------

export function notebook(title: string, sections: Section[]): string {
  const cells: object[] = [];
  const md = (text: string) => cells.push({ cell_type: 'markdown', metadata: {}, source: text.split(/(?<=\n)/) });
  md(`# ${title}\n\n*Explained by Claude in Reader. The outputs under each cell were written by Claude, not run — run them to check.*`);
  for (const section of sections) {
    const parts: string[] = section.title ? [`## ${section.title}`] : [];
    const push = () => {
      if (parts.length) md(parts.join('\n\n'));
      parts.length = 0;
    };
    for (const block of section.blocks) {
      if (block.kind === 'prose') parts.push(block.md);
      else if (block.kind === 'caveat') parts.push(`> **${VERDICTS[block.verdict]}${block.title ? ` — ${block.title}` : ''}.** ${block.md.replace(/\n/g, '\n> ')}`);
      else if (block.kind === 'figure') parts.push(`*Figure: ${block.caption || 'see the explanation page'}*`);
      else if (block.kind === 'tree') parts.push(`\`\`\`\n${block.text}\n\`\`\``);
      else if (block.kind === 'compute') parts.push('*The compute budget is on the Implementation page, worked out for your hardware.*');
      else if (block.kind === 'file') {
        // A starter file becomes a cell that writes it, so running the notebook top to bottom lays the repository out.
        push();
        cells.push({
          cell_type: 'code',
          execution_count: null,
          metadata: {},
          outputs: [],
          source: `%%writefile ${block.path}\n${block.code}`.split(/(?<=\n)/),
        });
      } else if (block.kind === 'code' && block.lang === 'bash') {
        push();
        cells.push({
          cell_type: 'code',
          execution_count: null,
          metadata: {},
          outputs: [],
          source: `%%bash\n# ${block.title}\n${block.code}`.split(/(?<=\n)/),
        });
      } else if (block.kind === 'code' && block.lang === 'python') {
        push();
        cells.push({
          cell_type: 'code',
          execution_count: null,
          metadata: {},
          outputs: [],
          source: `# ${block.title}\n${block.code}`.split(/(?<=\n)/),
        });
      }
    }
    push();
  }
  return JSON.stringify(
    { cells, metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' }, language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5 },
    null,
    1,
  );
}

// ---------------------------------------------------------------------------
// Revising: the reader asks from the bar at the top, Claude edits sections
// ---------------------------------------------------------------------------
//
// A question or an adjustment ("simpler", "a PyTorch version", "why √d?")
// does not rewrite the page: Claude answers with operations on its sections,
// which are applied as they stream in, so the one section being revised
// rewrites itself in place while the rest stays put.

const OP = /^<<<\s*(replace|insert after|insert before|delete|note)\s*(?::\s*(.*?))?\s*>>>\s*$/i;

export interface EditOp {
  op: 'replace' | 'insert after' | 'insert before' | 'delete' | 'note';
  target: string;
  body: string;
}

export function parseEdits(text: string): EditOp[] {
  const ops: EditOp[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const match = OP.exec(line.trim());
    if (match) ops.push({ op: match[1].toLowerCase() as EditOp['op'], target: (match[2] ?? '').trim(), body: '' });
    else if (ops.length) ops[ops.length - 1].body += (ops[ops.length - 1].body ? '\n' : '') + line;
  }
  return ops;
}

const titleKey = (title: string) =>
  title
    .toLowerCase()
    .replace(/^\s*(§|section)?\s*\d+[.)]?\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** The page as its `## ` sections: what comes before the first, then each heading with its body. */
function splitSections(content: string): { lead: string; parts: { title: string; text: string }[] } {
  const lines = content.split('\n');
  const parts: { title: string; text: string }[] = [];
  const lead: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = !inFence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) parts.push({ title: heading[1], text: line });
    else if (parts.length) parts[parts.length - 1].text += `\n${line}`;
    else lead.push(line);
  }
  return { lead: lead.join('\n'), parts };
}

export const sectionTitles = (content: string) => splitSections(content).parts.map((part) => part.title);

export interface Applied {
  content: string;
  note: string;
  /** The titles of the sections written or rewritten, in order. */
  touched: string[];
}

/** The page with the edits applied. Safe on a half-streamed reply: the last edit is simply shorter. */
export function applyEdits(base: string, reply: string, fallbackAfter?: string): Applied {
  const { lead, parts } = splitSections(base);
  const touched: string[] = [];
  let note = '';
  const find = (target: string) => {
    const key = titleKey(target);
    const exact = parts.findIndex((part) => titleKey(part.title) === key);
    return exact >= 0 ? exact : parts.findIndex((part) => key && (titleKey(part.title).includes(key) || key.includes(titleKey(part.title))));
  };
  // A new section with no place named goes before "Since then", which stays last.
  const beforeEnd = () => {
    const since = parts.findIndex((part) => /since then/i.test(part.title));
    return since >= 0 ? since : parts.length;
  };
  const section = (body: string, title: string) => {
    let text = body.replace(/^\s*\n/, '').trimEnd();
    // Halfway through a figure or a cell, its fence is still open; close it
    // here, or it would swallow every section after this one.
    if ((text.match(/^\s*```/gm) ?? []).length % 2) text += `\n\`\`\`${STILL_OPEN}`;
    const heading = /^##\s+(.+?)\s*#*\s*$/m.exec(text.split('\n')[0] ?? '');
    return heading ? { title: heading[1], text } : { title, text: `## ${title}\n${text}` };
  };
  const ops = parseEdits(reply);
  if (!ops.length && reply.trim()) {
    // Claude answered without the markers: keep the answer, as a section of its own.
    const answer = section(reply, 'Your question');
    const at = fallbackAfter ? find(fallbackAfter) : -1;
    parts.splice(at >= 0 ? at + 1 : beforeEnd(), 0, answer);
    touched.push(answer.title);
  }
  for (const op of ops) {
    if (op.op === 'note') {
      note = op.body.trim();
      continue;
    }
    const at = find(op.target);
    if (op.op === 'delete') {
      if (at >= 0) parts.splice(at, 1);
      continue;
    }
    const fresh = section(op.body, op.target || 'Your question');
    if (!fresh.text.trim()) continue;
    if (op.op === 'replace' && at >= 0) parts[at] = fresh;
    else if (op.op === 'insert before' && at >= 0) parts.splice(at, 0, fresh);
    else parts.splice(at >= 0 ? at + 1 : beforeEnd(), 0, fresh);
    touched.push(fresh.title);
  }
  const content = [lead.trimEnd(), ...parts.map((part) => part.text.trimEnd())].filter(Boolean).join('\n\n');
  return { content, note, touched };
}

function revisionRequest(content: string, request: string, scope: RevisionScope): string {
  return [
    'The reader has a request about the explanation page you wrote above.',
    tag('request', request),
    tag('about_section', scope.section),
    tag('selected_passage', scope.quote),
    `Change the page to satisfy it. If it is a question, answer it inside the page: expand the section it belongs to, or add a
new section right after that one. If it asks to adjust the content (simpler, deeper, other code, more figures, less maths…),
rewrite only the sections that must change, and keep every other section exactly as it is. Follow the same format rules
(figure, python, output and caveat blocks). If you add or change a caveat, keep "Since then" consistent with it.

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

// ---------------------------------------------------------------------------
// The store: one explanation per paper, streamed once and kept
// ---------------------------------------------------------------------------

export interface RevisionScope {
  /** The section the request is about, if one was picked. */
  section?: string;
  /** A passage selected on the page. */
  quote?: string;
}

export interface Revision {
  request: string;
  /** The page as it was before this request. */
  before: string;
  note: string;
  touched: string[];
  at: number;
}

export interface Explanation {
  paperId: string;
  content: string;
  model: string;
  created: number;
  streaming?: boolean;
  /** While streaming: a summary of what Claude is thinking before (and between) the writing. Not kept. */
  thinking?: string;
  error?: string;
  truncated?: boolean;
  /** Requests made from the bar, oldest first; each keeps the page as it was, for Undo. */
  revisions?: Revision[];
  /** A request being answered: the reply so far, shown applied to the page as it streams. */
  pending?: { request: string; scope: RevisionScope; reply: string; error?: string };
  /** When the page last changed (ms); what decides between this browser's copy and Drive's. */
  updated?: number;
  /** Every request made of it since it was written, oldest first — kept in Drive with the page. */
  requests?: string[];
  /** Its file in Drive, as last written or read. */
  drive?: DriveMark;
}

// ---------------------------------------------------------------------------
// Drive: the page kept in the paper's folder (explainDrive.ts)
// ---------------------------------------------------------------------------

export interface DriveMark {
  fileId: string;
  link?: string;
  modifiedTime?: string;
}

export interface ExplainDriveAdapter {
  /** The copy in Drive: null when there is none, no `explanation` when it is the one `known` already describes. */
  load(paperId: string, known?: DriveMark): Promise<{ file: DriveMark; explanation?: Explanation } | null>;
  save(explanation: Explanation): Promise<DriveMark>;
}

export type DriveState =
  | { state: 'checking' }
  | { state: 'saving' }
  | { state: 'saved'; link?: string; fetched?: boolean }
  | { state: 'error'; message: string }
  | { state: 'none' };

let drive: ExplainDriveAdapter | null = null;
const driveStates = new Map<string, DriveState>();
const driveTimers = new Map<string, number>();
const checks = new Map<string, Promise<void>>();
/** How long a save waits for more changes: a revision and its Undo are one write. */
const DRIVE_DEBOUNCE_MS = 1200;
/** A check of Drive when Explain opens gives up after this, and the page is offered as usual. */
const DRIVE_CHECK_MS = 10_000;

/** Set by the app when Drive is connected, and cleared when it is not. */
export function setExplainDrive(adapter: ExplainDriveAdapter | null) {
  drive = adapter;
}

export const driveStateFor = (paperId: string): DriveState | undefined => driveStates.get(paperId);

function setDriveState(paperId: string, next: DriveState) {
  driveStates.set(paperId, next);
  notify();
}

function scheduleDriveSave(paperId: string) {
  if (!drive) return;
  window.clearTimeout(driveTimers.get(paperId));
  setDriveState(paperId, { state: 'saving' });
  driveTimers.set(
    paperId,
    window.setTimeout(() => {
      driveTimers.delete(paperId);
      void saveToDrive(paperId);
    }, DRIVE_DEBOUNCE_MS),
  );
}

async function saveToDrive(paperId: string) {
  const adapter = drive;
  const entry = cache.get(paperId);
  if (!adapter || !entry?.content || entry.streaming) return;
  try {
    const written = await adapter.save(entry);
    const now = cache.get(paperId);
    // A change made while it was being written goes in the next save; this one only records where the file is.
    if (now) {
      const next = { ...now, drive: written };
      cache.set(paperId, next);
      persistLocal(next);
    }
    setDriveState(paperId, { state: 'saved', link: written.link });
  } catch (error) {
    setDriveState(paperId, { state: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

/** Looks in Drive for this paper's page, and takes it when it is newer than the one here. */
function checkDrive(paperId: string): Promise<void> {
  const adapter = drive;
  if (!adapter) return Promise.resolve();
  const inFlight = checks.get(paperId);
  if (inFlight) return inFlight;
  setDriveState(paperId, { state: 'checking' });
  const check = (async () => {
    const local = cache.get(paperId);
    try {
      const found = await Promise.race([
        adapter.load(paperId, local?.drive),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Drive took too long to answer.')), DRIVE_CHECK_MS)),
      ]);
      const now = cache.get(paperId);
      if (!found) {
        // Nothing in Drive yet: a page written before Drive was connected goes up now.
        if (now?.content && !now.streaming) scheduleDriveSave(paperId);
        else setDriveState(paperId, { state: 'none' });
        return;
      }
      const remote = found.explanation;
      const busy = running?.paperId === paperId || now?.streaming || now?.pending;
      if (remote && !busy && (!now?.content || (remote.updated ?? 0) > (now.updated ?? 0))) {
        const adopted: Explanation = { ...remote, drive: found.file, revisions: [] };
        cache.set(paperId, adopted);
        persistLocal(adopted);
        setDriveState(paperId, { state: 'saved', link: found.file.link, fetched: true });
        return;
      }
      if (now && !now.drive) {
        cache.set(paperId, { ...now, drive: found.file });
        persistLocal(cache.get(paperId)!);
      }
      // This browser has changes Drive has not seen.
      if (remote && now?.content && (now.updated ?? 0) > (remote.updated ?? 0)) scheduleDriveSave(paperId);
      else setDriveState(paperId, { state: 'saved', link: found.file.link });
    } catch (error) {
      setDriveState(paperId, { state: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      checks.delete(paperId);
    }
  })();
  checks.set(paperId, check);
  return check;
}

/** How many past versions are kept for Undo. */
const REVISIONS_KEPT = 12;

const KEY = (paperId: string) => `explain:${paperId}`;
const cache = new Map<string, Explanation>();
const listeners = new Set<() => void>();
let running: { paperId: string; stream: { abort(): void } } | null = null;

const notify = () => listeners.forEach((listener) => listener());

export function subscribeExplain(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const explanationFor = (paperId: string) => cache.get(paperId);

function persistLocal(entry: Explanation) {
  const { pending: _pending, streaming: _streaming, thinking: _thinking, ...kept } = entry;
  void db.setKv(KEY(entry.paperId), kept).catch(() => undefined);
}

/** The page changed: stamp it, keep it here, and send it to Drive. */
function keep(entry: Explanation) {
  const stamped = { ...entry, updated: Date.now() };
  cache.set(entry.paperId, { ...(cache.get(entry.paperId) ?? stamped), updated: stamped.updated });
  persistLocal(stamped);
  scheduleDriveSave(entry.paperId);
}

/**
 * The paper's page, from this browser if it has one, then from Drive when that
 * is connected — which wins when it is newer, so a page written or revised in
 * another browser comes here rather than being written again.
 */
export async function loadExplanation(paperId: string): Promise<Explanation | undefined> {
  if (!cache.has(paperId)) {
    try {
      const kept = await db.getKv<Explanation>(KEY(paperId));
      if (kept && !cache.has(paperId)) {
        cache.set(paperId, { ...kept, streaming: false, thinking: undefined, pending: undefined });
        notify();
      }
    } catch {
      // no IndexedDB: Drive, or writing it again
    }
  }
  await checkDrive(paperId);
  return cache.get(paperId);
}

/** For a demo or a test: put an explanation in place without asking anyone. */
export function putExplanation(explanation: Explanation) {
  cache.set(explanation.paperId, explanation);
  notify();
  keep(explanation);
}

export function stopExplaining() {
  running?.stream.abort();
}

/** The system prompt, identical for the first page and every revision, so the paper is read from the cache. */
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
    { type: 'text' as const, text: EXPLAIN_SYSTEM },
    {
      type: 'text' as const,
      text: [tag('paper', details), tag('abstract', paper.abstract), tag('paper_text', text.slice(0, FULL_TEXT_MAX_CHARS))].filter(Boolean).join('\n\n'),
      cache_control: { type: 'ephemeral' as const },
    },
  ];
}

const firstAsk = (screen: Screen) =>
  screen.fullText?.trim()
    ? 'Write the explanation page for this paper.'
    : 'Only the details and abstract of this paper could be read, not its full text. Write the explanation page from them and what you reliably know of the paper, and say at the top that the full text was not available.';

/** A paper's worth of thinking takes minutes; this is what the page shows meanwhile. */
function setThinking(paperId: string, thinking: string | undefined) {
  const entry = cache.get(paperId);
  if (!entry || entry.thinking === thinking) return;
  cache.set(paperId, { ...entry, thinking });
  notify();
}

/**
 * Streams one request, calling `onText` a frame at a time with everything so far.
 * Thinking is asked for as a summary (the models that think show nothing by
 * default, which on a whole paper reads as a hang) and kept on the entry.
 */
async function streamOnce(
  paperId: string,
  model: string,
  effort: 'low' | 'medium' | 'high',
  params: { system: ReturnType<typeof systemFor>; messages: { role: 'user' | 'assistant'; content: string }[] },
  onText: (text: string) => void,
): Promise<{ stop: string | null }> {
  const stream = await streamModel({ model, maxTokens: MAX_TOKENS, ...params, effort });
  running = { paperId, stream };
  let text = '';
  let thinking = '';
  let frame = 0;
  const paint = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      // The text first: the first page's `onText` puts down a fresh entry.
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
    // Writing again: what it thought before this stretch is spent.
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

export async function generateExplanation(screen: Screen, model: string) {
  const paper = screen.paper;
  if (!paper || running) return;
  const previous = cache.get(paper.id);
  // A rewrite goes over the same file in Drive.
  const entry: Explanation = { paperId: paper.id, content: '', model, created: Date.now(), streaming: true, drive: previous?.drive };
  cache.set(paper.id, entry);
  notify();

  let SDK: SDK | null = null;
  try {
    if (modelSpec(model).provider === 'anthropic') SDK = await sdk();
    const { stop } = await streamOnce(paper.id, model, 'medium', { system: systemFor(screen), messages: [{ role: 'user', content: firstAsk(screen) }] }, (text) => {
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
    // A rewrite can be undone like any other request.
    if (previous?.content && entry.content) {
      entry.revisions = [
        ...(previous.revisions ?? []),
        { request: 'Rewrite the whole page', before: previous.content, note: 'Written again from scratch.', touched: [], at: Date.now() },
      ].slice(-REVISIONS_KEPT);
    }
    cache.set(paper.id, { ...entry });
    notify();
    if (entry.content && !entry.error) keep(entry);
  }
}

/** Answers a request from the bar by editing the page's sections. */
export async function reviseExplanation(screen: Screen, request: string, scope: RevisionScope = {}) {
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
      'medium',
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
    keep(next);
  } catch (error) {
    const message = explainError(error, SDK);
    // Stopping puts the page back as it was, with nothing to report.
    update({ pending: message === 'Stopped.' ? undefined : { ...pending, error: message } });
  } finally {
    running = null;
  }
}

/** Puts the page back as it was before the last request. */
export function undoRevision(paperId: string) {
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
  keep(next);
}

/** Clears a failed request's message. */
export function dismissPending(paperId: string) {
  const entry = cache.get(paperId);
  if (!entry?.pending || running) return;
  cache.set(paperId, { ...entry, pending: undefined });
  notify();
}

export const isExplaining = (paperId: string) => running?.paperId === paperId;
