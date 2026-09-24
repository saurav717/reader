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

import { anthropic, explainError, FULL_TEXT_MAX_CHARS, MODELS, sdk, tag } from './assistant';
import type { Screen, SDK } from './assistant';
import { db } from './db';

/** The explanation is long by design; this caps a runaway, it does not budget one. */
const MAX_TOKENS = 32000;

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
- Name papers only when you are sure they exist. Math in plain text or \`code\`, not LaTeX.`;

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
  | { kind: 'caveat'; verdict: Verdict; title: string; md: string };

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
      while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) body.push(lines[j++]);
      const open = j >= lines.length; // still streaming
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
      else if (block.kind === 'code' && block.lang === 'python') {
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
// The store: one explanation per paper, streamed once and kept
// ---------------------------------------------------------------------------

export interface Explanation {
  paperId: string;
  content: string;
  model: string;
  created: number;
  streaming?: boolean;
  error?: string;
  truncated?: boolean;
}

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

/** Reads a kept explanation from IndexedDB into the cache, once. */
export async function loadExplanation(paperId: string): Promise<Explanation | undefined> {
  if (cache.has(paperId)) return cache.get(paperId);
  try {
    const kept = await db.getKv<Explanation>(KEY(paperId));
    if (kept && !cache.has(paperId)) {
      cache.set(paperId, { ...kept, streaming: false });
      notify();
    }
  } catch {
    // no IndexedDB: it is generated again next time
  }
  return cache.get(paperId);
}

/** For a demo or a test: put an explanation in place without asking anyone. */
export function putExplanation(explanation: Explanation) {
  cache.set(explanation.paperId, explanation);
  notify();
  void db.setKv(KEY(explanation.paperId), explanation).catch(() => undefined);
}

export function stopExplaining() {
  running?.stream.abort();
}

export async function generateExplanation(screen: Screen, model: string) {
  const paper = screen.paper;
  if (!paper || running) return;
  const entry: Explanation = { paperId: paper.id, content: '', model, created: Date.now(), streaming: true };
  cache.set(paper.id, entry);
  notify();

  let SDK: SDK | null = null;
  let frame = 0;
  const paint = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      cache.set(paper.id, { ...entry });
      notify();
    });
  };
  try {
    SDK = await sdk();
    const api = await anthropic();
    const spec = MODELS.find((m) => m.id === model) ?? MODELS[0];
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
    const stream = api.messages.stream({
      model: spec.id,
      max_tokens: MAX_TOKENS,
      system: [
        { type: 'text', text: EXPLAIN_SYSTEM },
        {
          type: 'text',
          text: [tag('paper', details), tag('abstract', paper.abstract), tag('paper_text', text.slice(0, FULL_TEXT_MAX_CHARS))].filter(Boolean).join('\n\n'),
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: text
            ? 'Write the explanation page for this paper.'
            : 'Only the details and abstract of this paper could be read, not its full text. Write the explanation page from them and what you reliably know of the paper, and say at the top that the full text was not available.',
        },
      ],
      ...(spec.adaptive ? { thinking: { type: 'adaptive' as const }, output_config: { effort: 'high' as const } } : {}),
    });
    running = { paperId: paper.id, stream };
    stream.on('text', (delta: string) => {
      entry.content += delta;
      paint();
    });
    const final = await stream.finalMessage();
    if (final.stop_reason === 'max_tokens') entry.truncated = true;
    if (final.stop_reason === 'refusal') entry.error = 'Claude declined to write this one.';
  } catch (error) {
    entry.error = explainError(error, SDK);
  } finally {
    running = null;
    if (frame) cancelAnimationFrame(frame);
    entry.streaming = false;
    cache.set(paper.id, { ...entry });
    notify();
    if (entry.content && !entry.error) void db.setKv(KEY(paper.id), { ...entry }).catch(() => undefined);
  }
}

export const isExplaining = (paperId: string) => running?.paperId === paperId;
