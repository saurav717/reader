import DOMPurify from 'dompurify';
import { cleanFigure } from '../lib/sanitize';
import type { CSSProperties } from 'react';
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Screen } from '../lib/assistant';
import { ASSISTANT_NAME, geminiNote, getState, looksLikeKey, MODELS, modelSpec, PROVIDERS, saveKey, setAskModel, setExplainModel, subscribe } from '../lib/assistant';
import ModelChip from './ModelChip';
import type { Block, Section } from '../lib/explain';
import {
  applyEdits,
  caveatsOf,
  dismissPending,
  driveStateFor,
  explanationFor,
  generateExplanation,
  loadExplanation,
  parseExplanation,
  reviseExplanation,
  stopExplaining,
  subscribeExplain,
  undoRevision,
  VERDICTS,
} from '../lib/explain';
import type { DriveState, RevisionScope } from '../lib/explain';
import {
  dismissImplementPending,
  generateImplementation,
  computeOf,
  implementationFor,
  loadImplementation,
  reviseImplementation,
  bundleOf,
  notebookBundle,
  stopImplementing,
  subscribeImplement,
  undoImplementRevision,
} from '../lib/implement';
import { findPassage, FLASH_EVENT, setExplainLocator, showPassage } from '../lib/locate';
import { markdown } from '../lib/markdown';
import { SHOW_IN_EXPLAIN, addClip, copyOf } from '../lib/notes';
import type { NoteSource } from '../lib/notes';
import { selectedText } from '../lib/screen';
import { useStore } from '../lib/store';
import { typesetMath } from '../lib/typesetMath';
import { CloseIcon, ColabIcon, ExplainIcon, MoonIcon, NoteIcon, OpacityIcon, PlanIcon, SparkleIcon, SunIcon } from './icons';
import { ColabMenu, ComputeBlock, FileBlock, HardwareSummary, ImplementEmpty, LocalMenu, PlanContext, RunConsole, runLocally, TreeBlock, useLocal } from './Implement';
import { attachUrl, CellRunOutput, ColabBanner, ColabChip, ColabMark, ConnectCard, RunState, useColab } from './Colab';
import MetricsPane from './MetricsPane';
import RuntimePane from './RuntimePane';
import NotebookPage, { FilesPane } from './Notebook';
import { notebookFileName, notebookFor, subscribeNotebook, toIpynb } from '../lib/notebook';
import { notebookAskFor, rewriteCells, rewriteNotebook, stopNotebookAsk, subscribeNotebookAsk } from '../lib/notebookAsk';
import { holdCell, SHOW_CELL } from '../lib/notebookNav';
import type { ShowCell } from '../lib/notebookNav';
import { colabNow } from '../lib/colab';
import { cellKey, colabAvailable, colabGranted, connect as connectColab, forgetRun, interrupt as interruptColab, outputText, runAll, runCell, useClient as useColabClient } from '../lib/colab';
import { KeepButton, KeepContext, tableText, useKept, useKeeper } from './Keep';
import BoxSnip from './BoxSnip';
import type { Flash } from './PassageFlash';
import PassageFlash from './PassageFlash';

export type ExplainLayout = 'margin' | 'notebook' | 'beside';
const LAYOUT_KEY = 'reader.explain.layout';
const LAYOUTS: { id: ExplainLayout; label: string; note: string }[] = [
  { id: 'margin', label: 'Margin', note: 'The prose on the left, its figures, code and caveats beside it in a wide margin' },
  { id: 'notebook', label: 'Notebook', note: 'One column of text and cells, the way a Colab notebook reads' },
  { id: 'beside', label: 'Beside the paper', note: 'The explanation over the right of the window, the paper still readable on the left' },
];

const readLayout = (): ExplainLayout => {
  try {
    const stored = localStorage.getItem(LAYOUT_KEY);
    if (stored === 'margin' || stored === 'notebook' || stored === 'beside') return stored;
  } catch {
    // private mode
  }
  return 'margin';
};

/**
 * The two pages Explain shows: the explanation, and the implementation plan
 * (implement.ts). They are written, kept, revised and undone the same way,
 * so the view is written once against this shape and given whichever store
 * the tab in the bar picks.
 */
/** The pages with something written on them: the explanation and the plan. */
export type WrittenPage = 'explain' | 'implement';
/** Those, and the Colab tab, which shows Colab's own page on the runtime rather than anything written. */
export type ExplainPage = WrittenPage | 'colab';
/**
 * Explain opens on the explanation. The one exception is the progress pill, which opens a paper on the
 * page being written: it asks for that page here, once, and the Explain that opens next takes it. An
 * Explain already open on that paper takes it as it stands, through the event; one open on another
 * paper leaves it for the Explain that mounts in its place.
 */
let askedPage: { paperId: string; page: ExplainPage } | null = null;
const OPEN_ON = 'reader:explain-open-on';
/** Which page Explain opens the paper on next: for the progress pill, which opens the one being written. */
export function openExplainOn(paperId: string, page: ExplainPage) {
  askedPage = { paperId, page };
  window.dispatchEvent(new CustomEvent<{ paperId: string; page: ExplainPage }>(OPEN_ON, { detail: { paperId, page } }));
}
interface PageStore {
  subscribe: (listener: () => void) => () => void;
  get: (paperId: string) => ReturnType<typeof explanationFor>;
  driveState: (paperId: string) => DriveState | undefined;
  load: (paperId: string) => Promise<unknown>;
  generate: (screen: Screen, model: string) => Promise<void>;
  revise: (screen: Screen, request: string, scope: RevisionScope, model?: string) => Promise<void>;
  undo: (paperId: string) => void;
  dismiss: (paperId: string) => void;
  stop: () => void;
}
const STORES: Record<WrittenPage, PageStore> = {
  explain: {
    subscribe: subscribeExplain,
    get: explanationFor,
    driveState: driveStateFor,
    load: loadExplanation,
    generate: generateExplanation,
    revise: reviseExplanation,
    undo: undoRevision,
    dismiss: dismissPending,
    stop: stopExplaining,
  },
  implement: {
    subscribe: subscribeImplement,
    get: implementationFor,
    driveState: () => undefined,
    load: loadImplementation,
    generate: generateImplementation,
    revise: reviseImplementation,
    undo: undoImplementRevision,
    dismiss: dismissImplementPending,
    stop: stopImplementing,
  },
};
const PAGES: { id: ExplainPage; label: string; note: string }[] = [
  { id: 'explain', label: 'Explanation', note: 'What the paper says: the problem, the method, why it works, and what has changed since' },
  { id: 'implement', label: 'Implementation', note: 'How to build it: what to reproduce, the datasets, the repository, the starter files, and what it costs on your machine' },
  { id: 'colab', label: 'Colab', note: 'A notebook of your own on your Colab runtime: cells to write and run in the same kernel the pages’ cells run in, kept here, out as an .ipynb' },
];

const VERDICT_CELL = /<td>(Still holds|Holds|Refined(?: since)?|Superseded|Disputed|Disproved)<\/td>/gi;
/** Prose, with a verdict alone in a table cell (the "Since then" table) drawn as its chip. */
const html = (md: string) =>
  DOMPurify.sanitize(
    markdown(md).replace(VERDICT_CELL, (_, word: string) => {
      const verdict = word.toLowerCase().replace(/^still /, '').replace(/ since$/, '');
      return `<td><span class="verdict-chip v-${verdict}">${word}</span></td>`;
    }),
    { ADD_ATTR: ['target'] },
  );

// ---------------------------------------------------------------------------
// Python, coloured — a few regular expressions, not a parser
// ---------------------------------------------------------------------------

const PY_KEYWORDS =
  'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield';
const PY_TOKENS = new RegExp(
  [
    '(#[^\\n]*)', // comment
    '("""[\\s\\S]*?(?:"""|$)|\'\'\'[\\s\\S]*?(?:\'\'\'|$)|[rbfu]*"(?:\\\\.|[^"\\\\\\n])*"?|[rbfu]*\'(?:\\\\.|[^\'\\\\\\n])*\'?)', // string
    `\\b(${PY_KEYWORDS})\\b`, // keyword
    '\\b(\\d+(?:\\.\\d*)?(?:e[+-]?\\d+)?)\\b', // number
    '\\b([A-Za-z_]\\w*)(?=\\()', // a call
  ].join('|'),
  'g',
);
/** The latest line of Claude's thinking summary, short enough for a status line. */
export function lastThought(thinking?: string) {
  const line = thinking?.split('\n').map((l) => l.replace(/[*#_`]/g, '').trim()).filter(Boolean).at(-1);
  if (!line) return '';
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function highlightPython(code: string): string {
  let out = '';
  let last = 0;
  for (const match of code.matchAll(PY_TOKENS)) {
    out += esc(code.slice(last, match.index));
    const [text, comment, string, keyword, number, call] = match;
    const kind = comment ? 'c' : string ? 's' : keyword ? 'k' : number ? 'n' : call ? 'f' : '';
    out += kind ? `<span class="tok-${kind}">${esc(text)}</span>` : esc(text);
    last = (match.index ?? 0) + text.length;
  }
  return out + esc(code.slice(last));
}

// ---------------------------------------------------------------------------
// The blocks
// ---------------------------------------------------------------------------

function CodeCell({ block, index, onAsk, asker, writer }: { block: Extract<Block, { kind: 'code' }>; index: number; onAsk?: (request: string, quote: string) => void; asker?: string; writer?: string }) {
  const [copied, setCopied] = useState(false);
  const python = block.lang === 'python';
  const shell = block.lang === 'bash';
  // A shell cell runs on the reader's own machine once the scaffold is written there (the Local menu).
  const { project, console: local } = useLocal();
  // A Python cell runs in the reader's own Google Colab (src/lib/colab.ts). Its run is kept
  // under its code, so a cell Claude rewrites comes back as not run.
  const colab = useColab();
  const { settings } = useStore();
  const key = cellKey(block.code);
  const run = python ? colab.runs[key] : undefined;
  const live = run?.state === 'running' || run?.state === 'queued';
  const [card, setCard] = useState(false);
  const canRun = python && !block.open && colabAvailable(settings.googleClientId);
  const runIt = () => {
    // The first run in a tab that has never connected explains itself first; anything after runs on the click.
    if (colab.status === 'off' && !colabGranted()) {
      setCard(true);
      return;
    }
    void runCell(key, block.code).catch(() => undefined);
  };
  const runTitle = !python
    ? ''
    : block.open
      ? 'Ready once the cell is written'
      : !settings.googleClientId.trim()
        ? 'Running cells needs a Google client ID: Settings → Google'
        : !canRun
          ? 'Running cells needs the reader’s proxy: Settings → Paper proxy'
          : colab.status === 'connecting'
            ? 'Connecting to Colab…'
            : colab.running
              ? 'Another cell is running'
              : run
                ? 'Run this cell again in your Colab runtime'
                : 'Run exactly this code in your own Google Colab, and see what it prints here';
  return (
    <figure className={`explain-cell${shell ? ' is-shell' : ''}${run ? ` has-run is-${run.state}` : ''}`} data-key={python ? key : undefined}>
      <header>
        <span className={`cell-index${live ? ' is-busy' : ''}`}>{python ? (live ? 'In [*]' : `In [${run?.executionCount ?? index}]`) : shell ? '$' : 'Out'}</span>
        <span className="cell-title">{block.title}</span>
        {run ? <RunState run={run} /> : null}
        {/* In the header, beside Copy — a button on the corner would sit on Run in Colab. */}
        <KeepButton selector=".explain-cell" what="cell" />
        {python || shell ? (
          <>
            {!live ? (
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => {
                  void navigator.clipboard?.writeText(block.code).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1400);
                  });
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            ) : null}
            {shell && project ? (
              <button type="button" className="btn sm local-run" disabled={local.running || block.open} onClick={() => void runLocally(block.code.trim())} title={`Run in ${project.dir}`}>
                ▶ Run locally
              </button>
            ) : null}
            {python && live ? (
              <button type="button" className="btn sm colab-stop" onClick={() => void interruptColab()} title="Interrupt the kernel">
                ■ Stop
              </button>
            ) : python ? (
              <button type="button" className={`btn sm colab${canRun && !run ? ' is-go' : ''}`} disabled={!canRun || colab.status === 'connecting' || Boolean(colab.running)} onClick={runIt} title={runTitle}>
                <ColabMark />
                {run ? '▶ Run again' : '▶ Run in Colab'}
              </button>
            ) : null}
          </>
        ) : null}
        {card ? (
          <ConnectCard
            cellLabel={`In [${index}]`}
            busy={colab.status === 'connecting'}
            onClose={() => setCard(false)}
            onConnect={(machine) => {
              void connectColab(machine)
                .then(() => {
                  setCard(false);
                  return runCell(key, block.code);
                })
                .catch(() => undefined);
            }}
          />
        ) : null}
      </header>
      <pre className="cell-code">
        <code dangerouslySetInnerHTML={{ __html: python ? highlightPython(block.code) : esc(block.code) }} />
        {block.open ? <span className="caret" aria-hidden="true" /> : null}
      </pre>
      {run ? (
        <CellRunOutput run={run} expected={block.output} asker={asker} writer={writer} onAsk={onAsk ? (request) => onAsk(request, block.code.slice(0, 1500)) : undefined} onForget={() => forgetRun(key)} />
      ) : block.output !== undefined ? (
        <div className="cell-output">
          <div className="cell-output-label">Expected output · written by Claude, not run yet</div>
          <pre>{block.output}</pre>
        </div>
      ) : null}
    </figure>
  );
}

function Figure({ block }: { block: Extract<Block, { kind: 'figure' }> }) {
  const svg = useMemo(
    () => (block.open ? '' : cleanFigure(block.svg)),
    [block.svg, block.open],
  );
  return (
    <figure className="explain-figure">
      {svg ? <div className="figure-art" dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="figure-art drawing">Drawing…</div>}
      {block.caption ? <figcaption>{block.caption}</figcaption> : null}
    </figure>
  );
}

function Caveat({ block }: { block: Extract<Block, { kind: 'caveat' }> }) {
  return (
    <aside className={`explain-caveat v-${block.verdict}`}>
      <div className="caveat-head">
        <span className="verdict">{VERDICTS[block.verdict]}</span>
        {block.title ? <strong>{block.title}</strong> : null}
      </div>
      <div className="caveat-body" dangerouslySetInnerHTML={{ __html: html(block.md) }} />
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Keeping a piece of the page in your notes
// ---------------------------------------------------------------------------

/** What on the page can be kept whole, by pointing at it. */
const KEEPABLE = '.explain-figure, .explain-cell, .explain-caveat, .impl-tree, .impl-file, .impl-budget, .impl-colab, .explain-prose table, .explain-prose pre, .explain-prose .chat-math-block';

/** The pieces whose header holds the button itself (a KeepButton), so the corner button keeps off them. */
const OWN_BUTTON = '.explain-cell, .impl-file, .impl-budget, .impl-colab';

/** What a box dragged over the page keeps, whole: each piece of it the box touches. */
const SNIPPABLE = '.explain-prose > *, .explain-figure, .explain-cell, .explain-caveat, .impl-tree, .impl-file, .impl-budget, .impl-colab';

const firstLine = (text: string) => text.split('\n').map((line) => line.trim()).find(Boolean);

/** What a piece is called in the notes, and what it says as text. */
function describe(element: HTMLElement): { label: string; text: string; quote?: string } {
  if (element.matches('.explain-figure')) {
    const caption = element.querySelector('figcaption')?.textContent?.trim();
    return { label: 'Diagram', text: caption ? `[Diagram: ${caption}]` : '[Diagram]', quote: caption };
  }
  if (element.matches('.explain-cell')) {
    const code = element.querySelector('.cell-code')?.textContent ?? '';
    const output = element.querySelector('.cell-output pre')?.textContent;
    const title = element.querySelector('.cell-title')?.textContent?.trim();
    const input = element.querySelector('.cell-index')?.textContent?.startsWith('In');
    return {
      label: `${input ? 'Code' : 'Output'}${title ? ` · ${title}` : ''}`,
      text: output != null ? `${code}\n\n# Expected output\n${output}` : code,
      quote: firstLine(code),
    };
  }
  if (element.matches('.explain-caveat')) {
    const verdict = element.querySelector('.verdict')?.textContent?.trim();
    const body = element.querySelector('.caveat-body')?.textContent?.trim() ?? '';
    return { label: `Caveat${verdict ? ` · ${verdict}` : ''}`, text: body, quote: body.slice(0, 80) };
  }
  if (element.matches('.impl-tree')) {
    const rows = Array.from(element.querySelectorAll('.tree-name')).map((row) => row.textContent?.trim() ?? '');
    return { label: 'Repository layout', text: rows.join('\n'), quote: rows[0] };
  }
  if (element.matches('.impl-file')) {
    const path = element.getAttribute('data-path') ?? 'file';
    const code = element.querySelector('.cell-code')?.textContent ?? '';
    return { label: `File · ${path}`, text: `# ${path}\n${code}`, quote: firstLine(code) };
  }
  if (element.matches('.impl-budget')) {
    const table = element.querySelector('table');
    const machine = element.querySelector('.cell-title')?.textContent?.trim();
    return { label: machine ?? 'Compute budget', text: table ? tableText(table) : element.textContent ?? '' };
  }
  if (element.matches('.impl-colab')) {
    const rows = Array.from(element.querySelectorAll('.need-row, .colab-step, .live-tile')).map((row) => (row.textContent ?? '').replace(/\s+/g, ' ').trim());
    return { label: 'Run it on Colab', text: rows.join('\n') || (element.textContent ?? '') };
  }
  if (element.matches('table')) {
    const cell = element.querySelector('tr:nth-child(2) > *, td');
    return { label: 'Table', text: tableText(element), quote: cell?.textContent?.trim() };
  }
  if (element.matches('.chat-math-block')) return { label: 'Equation', text: `$$${element.dataset.tex ?? ''}$$` };
  const code = element.textContent ?? '';
  return { label: 'Code', text: code, quote: firstLine(code) };
}

/** A section as text: its prose, and a line for each figure, cell and caveat in it. */
function sectionText(section: Section): string {
  return section.blocks
    .map((block) =>
      block.kind === 'prose'
        ? block.md
        : block.kind === 'figure'
          ? `[Diagram${block.caption ? `: ${block.caption}` : ''}]`
          : block.kind === 'code'
            ? `\`\`\`\n${block.code}\n\`\`\`${block.output !== undefined ? `\n\nExpected output:\n\`\`\`\n${block.output}\n\`\`\`` : ''}`
            : block.kind === 'tree'
              ? `\`\`\`\n${block.text}\n\`\`\``
              : block.kind === 'file'
                ? `# ${block.path}\n\`\`\`\n${block.code}\n\`\`\``
                : block.kind === 'compute'
                  ? `Compute budget:\n${block.text}`
                  : `${VERDICTS[block.verdict]}${block.title ? ` — ${block.title}` : ''}: ${block.md}`,
    )
    .join('\n\n');
}

/**
 * A section, as rows: a run of prose, then whatever figures, cells and
 * caveats follow it. In the margin layout the two halves of a row sit side
 * by side, so a figure stands next to the paragraph it illustrates.
 */
function SectionView({
  section,
  number,
  cells,
  onAdjust,
  onAsk,
  onKeep,
  state,
  asker,
  writer,
}: {
  section: Section;
  number: number;
  cells: Map<Block, number>;
  onAdjust?: (title: string) => void;
  /** A question about one of this section's cells — its output, or its error — for the bar. */
  onAsk?: (section: string, request: string, quote: string) => void;
  /** Who the bar answers with, and who wrote the page, for the labels under a cell's output. */
  asker?: string;
  writer?: string;
  /** Keep the whole section in your notes. */
  onKeep?: (section: Section, element: HTMLElement) => void;
  /** Being rewritten now, just rewritten, or changed by an earlier request. */
  state?: 'revising' | 'fresh' | 'revised';
}) {
  const rows: { prose: Block[]; side: Block[]; wide?: boolean }[] = [];
  // A tree, a starter file or the budget is a table's width: it goes in the reading column, not the margin.
  const wide = (block: Block) => block.kind === 'prose' || block.kind === 'tree' || block.kind === 'file' || block.kind === 'compute';
  for (const block of section.blocks) {
    const row = rows[rows.length - 1];
    if (wide(block)) {
      if (row && !row.side.length && block.kind === 'prose') row.prose.push(block);
      else rows.push({ prose: [block], side: [], wide: block.kind !== 'prose' });
    } else if (row) row.side.push(block);
    else rows.push({ prose: [], side: [block] });
  }
  const draw = (block: Block, key: number) =>
    block.kind === 'prose' ? (
      <div key={key} className="explain-prose" dangerouslySetInnerHTML={{ __html: html(block.md) }} />
    ) : block.kind === 'figure' ? (
      <Figure key={key} block={block} />
    ) : block.kind === 'code' ? (
      <CodeCell key={key} block={block} index={cells.get(block) ?? 0} asker={asker} writer={writer} onAsk={onAsk ? (request, quote) => onAsk(section.title, request, quote) : undefined} />
    ) : block.kind === 'tree' ? (
      <TreeBlock key={key} block={block} />
    ) : block.kind === 'file' ? (
      <FileBlock key={key} block={block} />
    ) : block.kind === 'compute' ? (
      <ComputeBlock key={key} block={block} />
    ) : (
      <Caveat key={key} block={block} />
    );
  return (
    <section className={`explain-section${state ? ` is-${state}` : ''}`} id={`explain-${section.id}`} data-section={section.id} data-title={section.title}>
      {section.title ? (
        <header className="explain-section-head">
          <span className="section-number">{String(number).padStart(2, '0')}</span>
          <h2>{section.title}</h2>
          {state === 'revising' ? (
            <span className="revised-pill live">
              <span className="spinner" /> Revising
            </span>
          ) : state ? (
            <span className="revised-pill">Revised at your request</span>
          ) : null}
          {onKeep && state !== 'revising' ? (
            <button
              type="button"
              className="btn sm ghost ask"
              onClick={(event) => {
                const element = event.currentTarget.closest<HTMLElement>('.explain-section');
                if (element) onKeep(section, element);
              }}
              title="Keep this whole section in your notes"
            >
              Add to notes
            </button>
          ) : null}
          {onAdjust ? (
            <button type="button" className="btn sm ghost ask" onClick={() => onAdjust(section.title)} title="Ask a question about this section, or ask for it to be changed, in the bar at the top">
              Ask or adjust
            </button>
          ) : null}
        </header>
      ) : null}
      {rows.map((row, index) => (
        <div key={index} className={`explain-row${row.wide ? ' is-wide' : ''}`}>
          <div className="row-main">{row.prose.map(draw)}</div>
          {row.side.length ? <div className="row-side">{row.side.map(draw)}</div> : null}
        </div>
      ))}
    </section>
  );
}

/** Where the page is kept: a line under the outline, and a link to the file in Drive. */
function DriveLine({ state }: { state?: DriveState }) {
  if (!state || state.state === 'none') return null;
  return (
    <div className={`drive-line is-${state.state}`}>
      <span className="drive-dot" aria-hidden="true" />
      {state.state === 'checking' ? (
        'Checking your Drive…'
      ) : state.state === 'saving' ? (
        'Saving to your Drive…'
      ) : state.state === 'error' ? (
        <span title={state.message}>Not saved to Drive — {state.message}</span>
      ) : (
        <>
          {state.fetched ? 'Fetched from your Drive' : 'Saved in your Drive'}
          {state.link ? (
            <>
              {' · '}
              <a href={state.link} target="_blank" rel="noreferrer noopener">
                Open ↗
              </a>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

interface Props {
  paperId: string;
  title: string;
  authors: string[];
  published?: string;
  screen: () => Promise<Screen>;
  onClose: () => void;
}

/**
 * How solid the page is over the paper behind it. `value` is what was chosen,
 * null for the material's own default, which is `fallback`; Reset goes back
 * to it. Moving the slider shows the change live, so there is nothing to apply.
 */
function OpacityControl({ value, fallback, onChange }: { value: number | null; fallback: number; onChange: (value: number | null) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    // Esc closes this, not Explain behind it.
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);
  const shown = value ?? fallback;
  const percent = Math.round(shown * 100);
  return (
    <div className="menu-wrap" ref={box}>
      <button
        type="button"
        className="icon-btn sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-pressed={value !== null}
        onClick={() => setOpen((now) => !now)}
        aria-label="Background opacity"
        title="How see-through the page is"
      >
        <OpacityIcon size={16} />
      </button>
      {open ? (
        <div className="menu right opacity-pop" role="dialog" aria-label="Background opacity">
          <div className="menu-label">Background</div>
          <label className="frost-row">
            <span>Clear</span>
            <input
              type="range"
              min={0.2}
              max={1}
              step={0.05}
              value={shown}
              aria-label="How opaque the explanation's background is"
              aria-valuetext={`${percent}% opaque`}
              onChange={(event) => onChange(Number(event.target.value))}
            />
            <span>Solid</span>
          </label>
          <div className="opacity-foot">
            <span>{percent}%{value === null ? ' · default' : ''}</span>
            <button type="button" className="btn sm ghost" disabled={value === null} onClick={() => onChange(null)}>
              Reset
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** How the Rewrite menu lays out the models: boxes in a grid, or a list by maker. Remembered. */
type RewriteView = 'grid' | 'list';
/** What Rewrite does to the notebook on the Colab tab: every code cell in turn, in place, or the whole notebook from scratch. Remembered. */
type NotebookRewrite = 'cells' | 'notebook';
const NB_REWRITE_KEY = 'reader.colab.rewrite';
const readNotebookRewrite = (): NotebookRewrite => {
  try {
    return localStorage.getItem(NB_REWRITE_KEY) === 'notebook' ? 'notebook' : 'cells';
  } catch {
    return 'cells';
  }
};
const REWRITE_VIEW_KEY = 'reader.rewrite.view';
const readRewriteView = (): RewriteView => {
  try {
    return localStorage.getItem(REWRITE_VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
};

/**
 * Rewrite, in the bar: the page written again from scratch, by the model
 * chosen here — the same one as before, or any other with a key.
 */
function RewriteMenu({
  current,
  keys,
  disabled,
  implementing,
  forNotebook,
  notebookMode,
  onNotebookMode,
  onRewrite,
}: {
  current: string;
  keys: Record<string, unknown>;
  disabled: boolean;
  implementing: boolean;
  /** On the Colab tab: the notebook, not the page. */
  forNotebook?: boolean;
  /** On the Colab tab: the whole notebook again, or every code cell in turn, in place. */
  notebookMode?: NotebookRewrite;
  onNotebookMode?: (mode: NotebookRewrite) => void;
  onRewrite: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<RewriteView>(readRewriteView);
  const box = useRef<HTMLDivElement>(null);
  const pickView = (next: RewriteView) => {
    setView(next);
    try {
      localStorage.setItem(REWRITE_VIEW_KEY, next);
    } catch {
      // private mode
    }
  };
  const choose = (id: string) => {
    setOpen(false);
    onRewrite(id);
  };
  const shortName = (label: string) => label.replace(/^(Claude|Gemini|DeepSeek) /, '');
  const tagsOf = (note: string) =>
    note.split(' · ').map((tag) => (
      <span key={tag} className="rw-tag">
        {tag}
      </span>
    ));
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    // Esc closes this, not Explain behind it.
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <div className="menu-wrap" ref={box}>
      <button
        type="button"
        className="btn sm ghost rewrite"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((now) => !now)}
        title={forNotebook ? 'Write the notebook again — the whole notebook from scratch, or every code cell in turn, in place — with the model you choose' : implementing ? 'Plan it again from scratch, for the machine picked now — with the model you choose' : 'Write it again from scratch — with the model you choose'}
      >
        Rewrite <span className="caret" aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className={`menu right rewrite-menu is-${view}`} role="menu" aria-label="Rewrite with">
          <div className="rw-head">
            <span className="rw-head-text">
              <b>Rewrite {forNotebook ? 'the notebook ' : ''}with</b>
              <span>{forNotebook ? (notebookMode === 'cells' ? 'Every code cell again, one by one, each in its place · Undo brings them back' : 'The whole notebook again from scratch · Undo brings it back') : 'Written again from scratch · Undo brings it back'}</span>
              {forNotebook && onNotebookMode ? (
                <span className="segmented sm rw-nb-mode" role="radiogroup" aria-label="What Rewrite does to the notebook">
                  <button type="button" role="radio" aria-checked={notebookMode === 'cells'} aria-pressed={notebookMode === 'cells'} onClick={() => onNotebookMode('cells')} title="Each code cell asked for in turn and replaced in place; text cells and the order stay">
                    Cell by cell
                  </button>
                  <button type="button" role="radio" aria-checked={notebookMode !== 'cells'} aria-pressed={notebookMode !== 'cells'} onClick={() => onNotebookMode('notebook')} title="The paper’s method and an experiment as new cells; every current cell replaced">
                    Whole notebook
                  </button>
                </span>
              ) : null}
            </span>
            <span className="rw-views" role="group" aria-label="Show the models as">
              <button type="button" aria-pressed={view === 'grid'} onClick={() => pickView('grid')} title="Boxes in a grid">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <rect x="2" y="2" width="5" height="5" rx="1.2" />
                  <rect x="9" y="2" width="5" height="5" rx="1.2" />
                  <rect x="2" y="9" width="5" height="5" rx="1.2" />
                  <rect x="9" y="9" width="5" height="5" rx="1.2" />
                </svg>
              </button>
              <button type="button" aria-pressed={view === 'list'} onClick={() => pickView('list')} title="A list, by maker">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                  <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
                </svg>
              </button>
            </span>
          </div>
          {view === 'grid' ? (
            <div className="rw-grid">
              {MODELS.map((m) => {
                const isCurrent = m.id === current;
                const ready = Boolean(keys[m.provider]);
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isCurrent}
                    className={`rw-card p-${m.provider}${isCurrent ? ' is-current' : ''}`}
                    disabled={!ready}
                    onClick={() => choose(m.id)}
                    title={ready ? `Write it again with ${m.label}` : `Add a ${PROVIDERS[m.provider].company} key in Settings to use ${m.label}`}
                  >
                    <span className="rw-card-top">
                      <span className="rw-mark" aria-hidden="true">
                        {PROVIDERS[m.provider].name.slice(0, 1)}
                      </span>
                      <span className="rw-maker">{PROVIDERS[m.provider].company}</span>
                      {isCurrent ? (
                        <span className="rw-current" title="Current: the page on screen was written with this one" aria-label="Current">
                          ✓
                        </span>
                      ) : ready ? (
                        <span className="rw-go" aria-hidden="true">
                          ↻
                        </span>
                      ) : null}
                    </span>
                    <b className="rw-name">{shortName(m.label)}</b>
                    <span className="rw-tags">{ready ? tagsOf(m.note) : <span className="rw-tag rw-need">Needs a key</span>}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            (Object.keys(PROVIDERS) as (keyof typeof PROVIDERS)[]).map((provider) => {
              const models = MODELS.filter((m) => m.provider === provider);
              if (!models.length) return null;
              const ready = Boolean(keys[provider]);
              return (
                <div key={provider} className={`rw-group p-${provider}`} role="group" aria-label={PROVIDERS[provider].company}>
                  <div className="rw-provider">
                    <span className="rw-mark" aria-hidden="true">
                      {PROVIDERS[provider].name.slice(0, 1)}
                    </span>
                    {PROVIDERS[provider].company}
                    {ready ? null : <span className="rw-need">Needs a key</span>}
                  </div>
                  {models.map((m) => {
                    const isCurrent = m.id === current;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isCurrent}
                        className={`rw-model${isCurrent ? ' is-current' : ''}`}
                        disabled={!ready}
                        onClick={() => choose(m.id)}
                        title={ready ? `Write it again with ${m.label}` : `Add a ${PROVIDERS[m.provider].company} key in Settings to use ${m.label}`}
                      >
                        <b className="rw-name">{shortName(m.label)}</b>
                        <span className="rw-tags">{tagsOf(m.note)}</span>
                        {isCurrent ? (
                          <span className="rw-current" title="The page on screen was written with this one">
                            Current
                          </span>
                        ) : (
                          <span className="rw-go" aria-hidden="true">
                            ↻
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

export default function Explain({ paperId, title, authors, published, screen, onClose }: Props) {
  const assistant = useSyncExternalStore(subscribe, getState);
  const [page, setPage] = useState<ExplainPage>(() => (askedPage?.paperId === paperId ? askedPage.page : 'explain'));
  useEffect(() => {
    // The asked page is this Explain's now; whatever opens later opens on the explanation.
    if (askedPage?.paperId === paperId) askedPage = null;
    const onOpenOn = (event: Event) => {
      const asked = (event as CustomEvent<{ paperId: string; page: ExplainPage }>).detail;
      if (asked.paperId !== paperId) return;
      askedPage = null;
      setPage(asked.page);
    };
    window.addEventListener(OPEN_ON, onOpenOn);
    return () => window.removeEventListener(OPEN_ON, onOpenOn);
  }, [paperId]);
  // The Colab tab sits over the explanation: what is written, kept and asked about is the explanation's while it is up.
  const store = STORES[page === 'colab' ? 'explain' : page];
  const implementing = page === 'implement';
  const explanation = useSyncExternalStore(store.subscribe, () => store.get(paperId));
  const driveState = useSyncExternalStore(store.subscribe, () => store.driveState(paperId));
  const [layout, setLayout] = useState<ExplainLayout>(readLayout);
  // Kept with the chat's preferences, so Settings and this page pick the same one.
  const model = assistant.prefs.explainModel ?? assistant.prefs.model;
  const setModel = setExplainModel;
  const chosen = modelSpec(model);
  const provider = PROVIDERS[chosen.provider];
  const hasKey = assistant.keys[chosen.provider];
  // Who wrote the page on screen — or who is about to.
  // Named by the model, not its maker: the reader picks a model, and sees that model's name wherever it acts.
  const writer = modelSpec(explanation?.model ?? model).label;
  // Who answers the bar: the model picked for it, else the page's writer.
  const askModel = assistant.prefs.askModel ?? explanation?.model ?? model;
  const asker = modelSpec(askModel).label;
  const [keyDraft, setKeyDraft] = useState('');
  const [active, setActive] = useState('');
  const [checked, setChecked] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const askRef = useRef<HTMLInputElement>(null);
  const [ask, setAsk] = useState('');
  const [scope, setScope] = useState<RevisionScope>({});
  const [askFocused, setAskFocused] = useState(false);
  // Once a request is sent, the line under the bar reports on it rather than offering more.
  const [justAsked, setJustAsked] = useState(false);

  // Drive connected after Explain opened is looked in too.
  const { driveConnected, settings, updateSettings } = useStore();
  const opacity = settings.explainOpacity;
  // What the material shows when nothing is chosen: frosted glass, or solid paper.
  const defaultOpacity = settings.glass ? Math.round((0.5 + 0.2 * settings.glassFrost) * 100) / 100 : 1;
  useEffect(() => {
    setChecked(false);
    void store.load(paperId).finally(() => setChecked(true));
  }, [paperId, driveConnected, store]);
  useEffect(() => {
    // A new page: the bar's chips were about the other one.
    setScope({});
    setJustAsked(false);
  }, [page]);

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      // private mode
    }
  }, [layout]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Not from the ask bar, the assistant, or the notebook, where Escape leaves an editor or drops a picked cell first.
      // Judged by where the key was pressed, not where focus is now: an editor that closed on this Escape has already let focus go.
      const from = event.target instanceof Element ? event.target : document.activeElement;
      if (event.key === 'Escape' && !from?.closest('.assistant-win, .explain-ask, .nb-page') && !document.querySelector('.scrim')) onClose();
      // "/" goes to the bar at the top, as it does to a search box.
      if (event.key === '/' && !(event.target as HTMLElement | null)?.closest('input, textarea, [contenteditable="true"]')) {
        event.preventDefault();
        askRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // While a request is answered, the page on screen is the page with the reply so far applied to it.
  const pending = explanation?.pending;
  const live = pending && !pending.error ? applyEdits(explanation?.content ?? '', pending.reply, pending.scope.section) : null;
  const shown = live ? live.content : explanation?.content ?? '';
  const sections = useMemo(() => parseExplanation(shown), [shown]);
  const revisions = explanation?.revisions ?? [];
  const lastRevision = revisions[revisions.length - 1];
  const revising = live?.touched[live.touched.length - 1];
  const revised = useMemo(() => new Set(revisions.flatMap((r) => r.touched)), [revisions]);
  const stateOf = (section: Section): 'revising' | 'fresh' | 'revised' | undefined =>
    revising && section.title === revising
      ? 'revising'
      : !pending && lastRevision?.touched.includes(section.title) && Date.now() - lastRevision.at < 60_000
        ? 'fresh'
        : revised.has(section.title)
          ? 'revised'
          : undefined;
  const caveats = useMemo(() => caveatsOf(sections), [sections]);
  const cells = useMemo(() => {
    const numbers = new Map<Block, number>();
    let n = 0;
    for (const section of sections) for (const block of section.blocks) if (block.kind === 'code' && block.lang === 'python') numbers.set(block, ++n);
    return numbers;
  }, [sections]);
  // The Python cells in the order they read, for Run all; a run is kept under the cell's code.
  const runnable = useMemo(() => Array.from(cells.entries()).map(([block, n]) => ({ key: cellKey((block as Extract<Block, { kind: 'code' }>).code), code: (block as Extract<Block, { kind: 'code' }>).code, label: `In [${n}]` })), [cells]);
  useColabClient(settings.googleClientId);
  const streaming = Boolean(explanation?.streaming);
  // The pane beside the page, as the Colab tab has it, whenever the page has
  // cells to run: the runtime's meters, the metrics its cells print, its
  // files. It opens by itself when a runtime connects, and folds when the
  // runtime goes — unless it was opened or closed by hand.
  const colab = useColab();
  const [side, setSide] = useState<'runtime' | 'metrics' | 'files' | null>(null);
  const sideByHand = useRef(false);
  const connected = colab.status === 'idle' || colab.status === 'busy';
  useEffect(() => {
    if (connected) {
      if (!sideByHand.current) setSide((current) => current ?? 'runtime');
    } else {
      setSide((current) => (current === 'runtime' && !sideByHand.current ? null : current));
      sideByHand.current = false;
    }
  }, [connected]);
  const pickSide = (next: 'runtime' | 'metrics' | 'files' | null) => {
    sideByHand.current = true;
    setSide(next);
  };
  const codeCells = useMemo(() => runnable.map((cell) => ({ key: cell.key, id: cell.key, label: cell.label })), [runnable]);
  const metricCells = useMemo(
    () =>
      runnable.map((cell) => {
        const run = colab.runs[cell.key];
        return { key: cell.key, id: cell.key, label: cell.label, text: run ? outputText(run.outputs) : '', at: run?.startedAt || 0 };
      }),
    [runnable, colab.runs],
  );
  // The plan's compute block, for the ticks on the pane's meters: this page's when it is the plan, else the paper's plan when it has one.
  const compute = useMemo(() => {
    const plan = implementing ? sections : implementationFor(paperId)?.content ? parseExplanation(implementationFor(paperId)!.content) : null;
    return plan ? computeOf(plan) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, implementing, sections, explanation?.content]);
  const goToCell = (key: string) => {
    const cell = docRef.current?.querySelector<HTMLElement>(`.explain-cell[data-key="${CSS.escape(key)}"]`);
    cell?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  // The Colab tab's own request, for the header's Rewrite and Stop while that tab is the one open.
  const nbAsk = useSyncExternalStore(subscribeNotebookAsk, () => notebookAskFor(paperId));
  const nbBusy = Boolean(nbAsk.pending && !nbAsk.pending.error);
  // What Colab and Local in the header take out of the tab: the plan's scaffold, the explanation and its cells, or the Colab tab's notebook.
  const nb = useSyncExternalStore(subscribeNotebook, () => notebookFor(paperId));
  const bundle = useMemo(() => {
    if (page === 'colab') return nb ? notebookBundle(`notebooks/${notebookFileName(title)}`, toIpynb(nb)) : null;
    return explanation?.content && !streaming ? bundleOf(title, shown, sections, implementing ? 'plan' : 'page', writer) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, nb?.updated, explanation?.content, streaming, shown, sections, implementing, title, writer]);
  const [nbRewrite, setNbRewriteState] = useState<NotebookRewrite>(readNotebookRewrite);
  // Snip is the pages' own; on the Colab tab its layer would only sit over the cells.
  useEffect(() => {
    if (page === 'colab') setSnipping(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);
  // A cell named in the Ask AI window, from another page: the Colab tab opens, and the notebook takes the cell as it mounts.
  useEffect(() => {
    const onShow = (event: Event) => {
      if (page === 'colab') return;
      holdCell((event as CustomEvent<ShowCell>).detail.cell);
      setPage('colab');
    };
    window.addEventListener(SHOW_CELL, onShow);
    return () => window.removeEventListener(SHOW_CELL, onShow);
  }, [page]);
  const setNbRewrite = (mode: NotebookRewrite) => {
    setNbRewriteState(mode);
    try {
      localStorage.setItem(NB_REWRITE_KEY, mode);
    } catch {
      // private mode
    }
  };
  // Who writes the notebook: the model Rewrite last picked for it, else the pages'.
  const nbWriter = modelSpec(nbAsk.model ?? model).label;
  const thought = lastThought(explanation?.thinking);
  const busy = Boolean(streaming || (pending && !pending.error));
  const canAsk = Boolean(explanation?.content && explanation.model && assistant.keys[modelSpec(askModel).provider] && !streaming);

  // Ask Claude, while this is open, points at passages here: the explanation's
  // own words are marked on it; the paper's are left to the paper when it is
  // beside this, and found here if they are here when this covers it.
  const docRef = useRef<HTMLElement>(null);
  const layoutNow = useRef(layout);
  layoutNow.current = layout;
  const [flash, setFlash] = useState<Flash | null>(null);
  const flashKey = useRef(0);
  useEffect(() => {
    const release = setExplainLocator(async (request) => {
      const doc = docRef.current;
      const scroller = scrollRef.current;
      if (!doc || !scroller) return null;
      const ofPaper = request.source !== 'explanation';
      const paperShows = layoutNow.current === 'beside';
      if (ofPaper && paperShows) return null;
      const range = findPassage(doc, request.quote);
      if (!range) {
        if (ofPaper) return paperShows ? null : { found: false, reason: 'It is in the paper, under the explanation — choose “Beside the paper”, or close Explain, to see it.' };
        return { found: false, reason: 'Those words are not on the explanation.' };
      }
      const top = range.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 3), behavior: 'smooth' });
      const section = range.startContainer.parentElement?.closest<HTMLElement>('.explain-section')?.dataset.title;
      setFlash({ range, label: request.label, where: ['The explanation', section].filter(Boolean).join(' · '), clip: scroller, anchor: scroller, key: ++flashKey.current, n: request.n });
      window.dispatchEvent(new CustomEvent(FLASH_EVENT, { detail: { quote: request.quote } }));
      return { found: true };
    });
    return () => {
      release();
      window.dispatchEvent(new CustomEvent(FLASH_EVENT, { detail: { quote: null } }));
    };
  }, []);
  // A rewritten page is a different page: the mark goes.
  useEffect(() => {
    setFlash(null);
    window.dispatchEvent(new CustomEvent(FLASH_EVENT, { detail: { quote: null } }));
  }, [paperId, layout]);

  // A passage selected here can be taken to Ask Claude, as one selected in the paper can.
  const [picked, setPicked] = useState<{ text: string; section?: string; top: number; left: number } | null>(null);
  useEffect(() => {
    if (!picked) return;
    const drop = () => {
      if (window.getSelection()?.isCollapsed) setPicked(null);
    };
    const away = () => setPicked(null);
    const scroller = scrollRef.current;
    document.addEventListener('selectionchange', drop);
    scroller?.addEventListener('scroll', away, { passive: true });
    return () => {
      document.removeEventListener('selectionchange', drop);
      scroller?.removeEventListener('scroll', away);
    };
  }, [picked]);

  // The maths the Markdown set aside is typeset once it is on screen. Only what
  // is new is touched, so this is cheap on every render of a stream.
  useEffect(() => {
    void typesetMath(scrollRef.current);
  });

  // The outline follows the reading: the section whose head last crossed the top third.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onScroll = () => {
      const line = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
      let current = '';
      for (const element of scroller.querySelectorAll<HTMLElement>('.explain-section')) {
        if (element.getBoundingClientRect().top <= line) current = element.dataset.section ?? '';
      }
      setActive(current);
    };
    onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [sections.length]);

  // The section being revised is brought into view once, when the reply first names it.
  const followed = useRef('');
  useEffect(() => {
    if (!revising || followed.current === revising) return;
    followed.current = revising;
    const element = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>('.explain-section') ?? []).find((el) => el.dataset.title === revising);
    element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [revising]);
  useEffect(() => {
    if (!pending) followed.current = '';
  }, [pending]);

  // ---- keeping pieces in your notes ------------------------------------------
  // Pointing at a diagram, a code cell, a table, an equation or a caveat puts
  // an "Add to notes" button on its corner; a selection has one in its
  // toolbar; a section's heading has one for the whole section. What is kept
  // is a copy, so a later rewrite of the page leaves your notes as they were.
  const { announce, toast } = useKept();
  const keep = async (clip: { label: string; html: Promise<string>; text: string; source: NoteSource }) => {
    const html = await clip.html;
    if (!html.trim() && !clip.text.trim()) return;
    addClip(paperId, { ...clip, html });
    announce(clip.label);
  };
  const sectionOf = (element: Element) => element.closest<HTMLElement>('.explain-section')?.dataset.title || undefined;
  const keepElement = (element: HTMLElement) => {
    const { label, text, quote } = describe(element);
    void keep({ label, html: copyOf(element), text, source: { from: 'explain', section: sectionOf(element), quote } });
  };
  const keeper = useKeeper({ root: docRef, selector: KEEPABLE, onKeep: keepElement, own: OWN_BUTTON });
  // The plan, for the Colab panel under its budget: the title and the sections, as one value so the panel is not redrawn for nothing.
  const plan = useMemo(() => (implementing ? { title, sections } : null), [implementing, title, sections]);
  // ✂ Snip, or S while this covers the paper: a box dragged over the page
  // keeps every piece of it the box touches, as it is set.
  const [snipping, setSnipping] = useState(false);
  const keepBox = (elements: HTMLElement[]) => {
    const copy = document.createDocumentFragment();
    elements.forEach((element) => copy.appendChild(element.cloneNode(true)));
    const text = elements.map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n\n');
    void keep({ label: 'Snip', html: copyOf(copy), text, source: { from: 'explain', section: sectionOf(elements[0]), quote: text.slice(0, 120) || undefined } });
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || layout === 'beside' || page === 'colab') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        setSnipping((current) => !current);
      } else if (event.key === 'Escape' && snipping) {
        event.stopPropagation();
        setSnipping(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [layout, snipping, page]);
  const keepSection = (section: Section, element: HTMLElement) => {
    // Its rows, not the section itself: a copy that called itself a section of the page would be taken for one.
    const rows = document.createDocumentFragment();
    element.querySelectorAll(':scope > .explain-row').forEach((row) => rows.appendChild(row.cloneNode(true)));
    void keep({ label: 'Section', html: copyOf(rows), text: sectionText(section), source: { from: 'explain', section: section.title || undefined } });
  };
  const keepSelection = () => {
    const selection = window.getSelection();
    if (!picked || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    void keep({ label: 'Passage', html: copyOf(range.cloneContents()), text: picked.text, source: { from: 'explain', section: picked.section, quote: picked.text.slice(0, 160) } });
    selection.removeAllRanges();
    setPicked(null);
  };

  // Back from your notes: the passage marked, or its section brought into view.
  useEffect(() => {
    const onShow = (event: Event) => {
      const source = (event as CustomEvent<NoteSource>).detail;
      const scroller = scrollRef.current;
      const section = Array.from(scroller?.querySelectorAll<HTMLElement>('.explain-section') ?? []).find((element) => element.dataset.title === source.section);
      const toSection = () => section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (!source.quote) return toSection();
      void showPassage({ quote: source.quote, label: 'From your notes', section: source.section, source: 'explanation' }).then((shown) => {
        if (!shown.found) toSection();
      });
    };
    window.addEventListener(SHOW_IN_EXPLAIN, onShow);
    return () => window.removeEventListener(SHOW_IN_EXPLAIN, onShow);
  }, []);

  const submitWith = async (request: string, asked: RevisionScope) => {
    if (!request.trim() || busy) return;
    const read = await screen();
    setAsk('');
    setJustAsked(true);
    setScope({});
    await store.revise(read, request, asked, askModel);
  };
  const submit = (request = ask) => submitWith(request, scope);
  // A cell's output, or its error, taken to the bar as a question about that cell.
  const askCell = (sectionTitle: string, request: string, quote: string) => void submitWith(request, { section: sectionTitle || undefined, quote });
  const adjust = (sectionTitle: string) => {
    setScope({ section: sectionTitle });
    askRef.current?.focus();
  };
  // A passage selected on the page becomes what the next request is about.
  const takeSelection = () => {
    const selection = window.getSelection();
    const text = selection ? selectedText(selection) : '';
    const node = selection?.anchorNode;
    const element = node instanceof Element ? node : node?.parentElement;
    const section = element?.closest<HTMLElement>('.explain-section');
    if (text.length < 3 || !section || !selection?.rangeCount) {
      setPicked(null);
      return;
    }
    setScope({ section: section.dataset.title || undefined, quote: text.slice(0, 1500) });
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    setPicked({ text, section: section.dataset.title || undefined, top: rect.bottom + 8, left: Math.max(12, Math.min(window.innerWidth - 340, rect.left)) });
  };

  const start = async () => {
    const read = await screen();
    await store.generate(read, model);
  };
  // Rewrite, with the model picked in its menu — the one chosen now, or another.
  const rewriteWith = async (id: string) => {
    const read = await screen();
    if (page === 'colab') {
      // On the Colab tab, Rewrite is the notebook's: its cells written again by the model picked, not the page under it — every code cell in turn, or the whole notebook.
      const params = { paperId, screen: read, model: id, runs: colabNow().runs, pages: { explanation: STORES.explain.get(paperId)?.content, plan: implementationFor(paperId)?.content } };
      await (nbRewrite === 'cells' ? rewriteCells(params) : rewriteNotebook(params));
      return;
    }
    await store.generate(read, id);
  };

  // Which model, and the button — or the key, first. The same on both pages' empty states.
  const startControls = (
    <>
              <div className="explain-start">
                <div className="model-pick" role="radiogroup" aria-label="Model">
                  {MODELS.map((m) => (
                    <button key={m.id} type="button" role="radio" aria-checked={model === m.id} onClick={() => setModel(m.id)}>
                      <b>{m.label}</b>
                      <span>
                        {m.note}
                        {assistant.keys[m.provider] ? '' : PROVIDERS[m.provider].viaProxy ? ` · ${geminiNote(assistant.gemini).short}` : ' · needs a key'}
                      </span>
                    </button>
                  ))}
                </div>
                {hasKey ? (
                  <button type="button" className="btn primary cta" onClick={() => void start()}>
                    <SparkleIcon size={17} /> {implementing ? 'Plan the implementation' : 'Explain this paper'}
                  </button>
                ) : null}
              </div>
              {hasKey ? (
                <p className="hint">
                  <b>Written once</b> and kept for this paper
                  {driveState ? ', in this browser and in the paper’s folder in your Drive' : implementing ? ', in this browser' : ''}. A long paper costs about as much as a few long answers in {ASSISTANT_NAME}.
                </p>
              ) : provider.viaProxy ? (
                <p className="hint">{geminiNote(assistant.gemini).long}</p>
              ) : (
                <>
                  <form
                    className="explain-start"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const key = keyDraft.trim();
                      if (!looksLikeKey(key, provider.id) && !confirm(`That does not look like one of ${provider.company}’s API keys (they start with "${provider.keyPrefix}"). Save it anyway?`)) return;
                      saveKey(key, provider.id);
                      setKeyDraft('');
                    }}
                  >
                    <input type="password" placeholder={provider.placeholder} value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} aria-label={`${provider.company} API key`} />
                    <button type="submit" className="btn primary cta" disabled={!keyDraft.trim()}>
                      Use this {provider.company} key
                    </button>
                  </form>
                  <p className="hint">
                    <b>The same {provider.company} key as {ASSISTANT_NAME}.</b> Get one at{' '}
                    <a href={provider.consoleUrl} target="_blank" rel="noopener noreferrer">
                      {provider.consoleUrl.replace(/^https:\/\//, '')}
                    </a>
                    . It stays in this browser and goes only to {provider.host}.
                  </p>
                </>
              )}
    </>
  );

  const year = published?.slice(0, 4);
  const byline = [authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : ''), year].filter(Boolean).join(' · ');
  const writtenWith = MODELS.find((m) => m.id === explanation?.model)?.label ?? explanation?.model;

  return (
    <div
      className={`explain layout-${layout} page-${page}${opacity !== null && opacity < 1 ? ' is-see-through' : ''}`}
      style={opacity !== null ? ({ '--explain-a': opacity } as CSSProperties) : undefined}
      role="dialog"
      aria-label={`${implementing ? 'Implementation plan for' : 'Explanation of'} ${title}`}
    >
      <header className="explain-bar">
        <span className="explain-brand">
          {page === 'colab' ? <ColabIcon size={17} /> : <ExplainIcon size={17} />} <span>{page === 'colab' ? `Notebook with ${nbWriter}` : `Explained by ${writer}`}</span>
        </span>
        <span className="explain-bar-title" title={title}>
          {title}
        </span>
        <div className="segmented explain-pages" role="tablist" aria-label="Page">
          {PAGES.map((option) => (
            <button key={option.id} type="button" role="tab" aria-selected={page === option.id} aria-pressed={page === option.id} title={option.note} onClick={() => setPage(option.id)}>
              {option.id === 'implement' ? <PlanIcon size={13} /> : option.id === 'colab' ? <ColabIcon size={13} /> : <ExplainIcon size={13} />}
              <span>{option.label}</span>
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Layout">
          {LAYOUTS.map((option) => (
            <button key={option.id} type="button" aria-pressed={layout === option.id} title={option.note} onClick={() => setLayout(option.id)}>
              {option.label}
            </button>
          ))}
        </div>
        {/* The runtime the page's Python cells run in, when there is one to show or one could be started. */}
        <ColabChip cells={runnable} />
        {/* The same actions on every tab, always in the same places: Runtime and Metrics open the pane whatever the page holds — the machine is the same machine, and the plan's steps print metrics as the cells do. */}
        <button type="button" className={`btn sm ghost${side === 'runtime' ? ' is-on' : ''}`} aria-pressed={side === 'runtime'} onClick={() => pickSide(side === 'runtime' ? null : 'runtime')} title="The machine: how busy it is, the last ten minutes, what is left of the session">
          Runtime
        </button>
        <button type="button" className={`btn sm ghost${side === 'metrics' ? ' is-on' : ''}`} aria-pressed={side === 'metrics'} onClick={() => pickSide(side === 'metrics' ? null : 'metrics')} title="Training metrics, read off what the cells print: loss, accuracy, lr… a chart a metric, live">
          Metrics
        </button>
        <ColabMenu title={title} bundle={bundle} />
        <LocalMenu title={title} bundle={bundle} sections={page === 'colab' ? [] : sections} />
        {page === 'colab' ? (
          nbBusy ? (
            <button type="button" className="btn sm" onClick={stopNotebookAsk}>
              Stop
            </button>
          ) : (
            <RewriteMenu
              current={nbAsk.model ?? model}
              keys={assistant.keys}
              disabled={!assistant.keys[modelSpec(nbAsk.model ?? model).provider]}
              implementing={false}
              forNotebook
              notebookMode={nbRewrite}
              onNotebookMode={setNbRewrite}
              onRewrite={(id) => {
                setModel(id);
                void rewriteWith(id);
              }}
            />
          )
        ) : streaming ? (
          <button type="button" className="btn sm" onClick={store.stop}>
            Stop
          </button>
        ) : (
          <RewriteMenu
            current={explanation?.model ?? model}
            keys={assistant.keys}
            disabled={!explanation?.content || busy}
            implementing={implementing}
            onRewrite={(id) => {
              setModel(id);
              void rewriteWith(id);
            }}
          />
        )}
        <button
          type="button"
          className="btn sm ghost snip-toggle"
          aria-pressed={snipping}
          disabled={!explanation?.content}
          onClick={() => setSnipping(!snipping)}
          title="Snip: drag a box over anything here — prose, a diagram, a code cell, a table — to add it to your notes (S)"
        >
          ✂ Snip
        </button>
        <OpacityControl value={opacity} fallback={defaultOpacity} onChange={(value) => updateSettings({ explainOpacity: value })} />
        <button
          type="button"
          className="icon-btn sm"
          onClick={() => updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })}
          aria-label={settings.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={settings.theme === 'dark' ? 'Light mode — the whole app, as in Settings' : 'Dark mode — the whole app, as in Settings'}
        >
          {settings.theme === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
        </button>
        <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close the explanation (Esc)" title="Back to the paper (Esc or E)">
          <CloseIcon size={17} />
        </button>
      </header>
      <ColabBanner />

      {page === 'colab' ? (
        <NotebookPage paperId={paperId} title={title} screen={screen} side={side} onSide={pickSide} sections={STORES.explain.get(paperId)?.content ? parseExplanation(STORES.explain.get(paperId)!.content) : sections} planSections={() => (implementationFor(paperId)?.content ? parseExplanation(implementationFor(paperId)!.content) : null)} />
      ) : (
        <>
      <div className="explain-ask">
        <div className="ask-column">
          <form
            className={`ask-field${busy ? ' is-busy' : ''}${askFocused ? ' is-focused' : ''}${!canAsk ? ' is-off' : ''}`}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <SparkleIcon size={16} />
            {scope.section ? (
              <span className="ask-chip" title={`About the section “${scope.section}”`}>
                § {scope.section}
                <button type="button" aria-label="Not about this section" onClick={() => setScope({ ...scope, section: undefined })}>
                  ×
                </button>
              </span>
            ) : null}
            {scope.quote ? (
              <span className="ask-chip quote" title={scope.quote}>
                “{scope.quote.length > 42 ? `${scope.quote.slice(0, 42)}…` : scope.quote}”
                <button type="button" aria-label="Not about this passage" onClick={() => setScope({ ...scope, quote: undefined })}>
                  ×
                </button>
              </span>
            ) : null}
            <input
              ref={askRef}
              value={ask}
              disabled={!canAsk || busy}
              onChange={(event) => {
                setAsk(event.target.value);
                setJustAsked(false);
              }}
              onFocus={() => {
                setAskFocused(true);
                setJustAsked(false);
              }}
              onBlur={() => window.setTimeout(() => setAskFocused(false), 150)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                if (scope.section || scope.quote) setScope({});
                else event.currentTarget.blur();
              }}
              placeholder={
                !explanation?.content
                  ? `Ask questions or request changes here, once the ${implementing ? 'plan' : 'explanation'} is written`
                  : !assistant.keys[modelSpec(askModel).provider]
                    ? `${MODELS.find((m) => m.id === askModel)?.label ?? asker} needs its key in Settings — or pick another model here`
                    : scope.section || scope.quote
                      ? 'Ask about this, or say how to change it…'
                      : implementing
                        ? `Ask ${asker} about the plan, or to change it — a different dataset, framework, scale…  ( / )`
                        : `Ask ${asker} anything about this explanation, or how to change it…  ( / )`
              }
              aria-label="Ask about the explanation, or ask for a change"
            />
            <ModelChip value={askModel} writer={explanation?.model} keys={assistant.keys} disabled={busy || !explanation?.content} what="Answers here with" onChange={(id) => setAskModel(id === explanation?.model ? '' : id)} />
            {busy && pending ? (
              <button type="button" className="btn sm" onClick={store.stop}>
                Stop
              </button>
            ) : (
              <button type="submit" className="btn sm primary" disabled={!canAsk || !ask.trim()}>
                Ask
              </button>
            )}
          </form>
          {pending && !pending.error ? (
            <div className="ask-status is-live">
              <span className="spinner" />
              <span className="ask-note" title={thought || undefined}>
                {revising ? `Rewriting “${revising}”` : thought ? `Thinking — ${thought}` : 'Reading your request'} — <em>{pending.request}</em>
              </span>
            </div>
          ) : pending?.error ? (
            <div className="ask-status is-error">
              <span className="ask-note">{pending.error}</span>
              <button type="button" className="btn sm ghost" onClick={() => store.dismiss(paperId)}>
                Dismiss
              </button>
            </div>
          ) : askFocused && !ask && canAsk && !justAsked ? (
            <div className="ask-suggestions">
              {(implementing
                ? scope.section || scope.quote
                  ? ['Go into more detail here', 'Give me the full file, not a skeleton', 'What could go wrong at this step?', 'Is there a smaller version of this?', 'Add a figure for this']
                  : [
                      'Plan the smallest version that still tests the idea',
                      'Use PyTorch Lightning and Hydra configs',
                      'Use JAX instead of PyTorch',
                      'Swap the dataset for one I can download in an hour',
                      'Write every starter file in full',
                      'Add a Dockerfile and a Makefile',
                    ]
                : scope.section || scope.quote
                  ? ['Explain this more simply', 'Go deeper into the maths', 'Add a figure for this', 'Add a PyTorch version of the code', 'Is this still true today?']
                  : ['Make the whole page simpler, for a beginner', 'Add a section on how to implement it today', 'Use PyTorch instead of numpy', 'What has changed in the last two years?', 'Typeset the maths, and walk through it step by step', 'Fewer figures, more intuition']
              ).map((suggestion) => (
                <button key={suggestion} type="button" className="ask-suggestion" onMouseDown={(event) => event.preventDefault()} onClick={() => void submit(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          ) : lastRevision ? (
            <div className="ask-status is-done">
              <span className="check">✓</span>
              <span className="ask-note">{lastRevision.note || `Done: ${lastRevision.request}`}</span>
              <button type="button" className="btn sm ghost" onClick={() => store.undo(paperId)} title={`Put the page back as it was before “${lastRevision.request}”`}>
                Undo
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className={`explain-split${side ? ' has-side' : ''}`}>
      <div className="explain-scroll" ref={scrollRef}>
        <nav className="explain-outline" aria-label="Sections">
          <div className="outline-paper">
            <div className="outline-title">{title}</div>
            {byline ? <div className="outline-byline">{byline}</div> : null}
          </div>
          {sections.filter((s) => s.title).length ? (
            <ol>
              {sections
                .filter((s) => s.title)
                .map((section, index) => {
                  const marks = section.blocks.filter((b) => b.kind === 'caveat') as Extract<Block, { kind: 'caveat' }>[];
                  return (
                    <li key={section.id} className={active === section.id ? 'active' : ''}>
                      <a
                        href={`#explain-${section.id}`}
                        onClick={(event) => {
                          event.preventDefault();
                          document.getElementById(`explain-${section.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }}
                      >
                        <span className="n">{String(index + 1).padStart(2, '0')}</span>
                        <span className="t">{section.title}</span>
                        {marks.map((mark, i) => (
                          <span key={i} className={`dot v-${mark.verdict}`} title={`${VERDICTS[mark.verdict]}: ${mark.title}`} />
                        ))}
                      </a>
                    </li>
                  );
                })}
            </ol>
          ) : null}
          {caveats.length ? (
            <div className="outline-aged">
              <div className="aged-label">How it has aged</div>
              {(Object.keys(VERDICTS) as (keyof typeof VERDICTS)[])
                .map((verdict) => [verdict, caveats.filter((c) => c.verdict === verdict).length] as const)
                .filter(([, count]) => count)
                .map(([verdict, count]) => (
                  <div key={verdict} className={`aged-row v-${verdict}`}>
                    <span className="dot" /> {VERDICTS[verdict]} <span className="count">{count}</span>
                  </div>
                ))}
            </div>
          ) : null}
          {implementing && explanation?.content ? <HardwareSummary sections={sections} /> : null}
          {explanation?.content ? (
            <div className="outline-meta">
              {streaming ? (implementing ? `${writer} is planning…` : `${writer} is writing…`) : `${implementing ? 'Planned' : 'Written'} by ${writtenWith} · ${new Date(explanation.created).toLocaleDateString()}`}
              <DriveLine state={driveState} />
            </div>
          ) : null}
        </nav>

        <KeepContext.Provider value={keepElement}>
        <PlanContext.Provider value={plan}>
        <article
          className="explain-doc"
          ref={docRef}
          onMouseUp={takeSelection}
          onMouseOver={keeper.onMouseOver}
          onMouseLeave={keeper.onMouseLeave}
        >
          {!explanation?.content && !checked ? (
            <p className="explain-looking">
              <span className="spinner" />
              {driveState?.state === 'checking' ? 'Looking in your Drive for an explanation of this paper…' : implementing ? 'Opening the plan…' : 'Opening the explanation…'}
            </p>
          ) : !explanation?.content && checked && !streaming && implementing ? (
            <ImplementEmpty title={title} byline={byline}>
              {startControls}
            </ImplementEmpty>
          ) : !explanation?.content && checked && !streaming ? (
            <div className="explain-empty">
              <div className="explain-kicker pill">
                <ExplainIcon size={15} /> The whole paper, explained
              </div>
              <h1>{title}</h1>
              {byline ? <div className="byline">{byline}</div> : null}
              <p className="explain-lede">
                {writer} reads the paper <b>end to end</b> and writes you a walkthrough: <mark>the problem</mark>, <mark>how the method works</mark> and{' '}
                <mark>why it beats what came before</mark>. It adds diagrams, small Python cells you can run, and an honest account of{' '}
                <b>what has changed since</b> it was published.
              </p>
              <ul className="explain-promises">
                <li className="p-figures">
                  <span className="promise-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
                      <path d="M7 15l3.2-3.6 2.6 2.4L17 9" />
                    </svg>
                  </span>
                  <b>Figures</b>
                  <span>drawn for each key idea</span>
                </li>
                <li className="p-code">
                  <span className="promise-icon" aria-hidden="true">
                    <span className="colab-mark">co</span>
                  </span>
                  <b>Code cells</b>
                  <span>runnable in Google Colab</span>
                </li>
                <li className="p-caveats">
                  <span className="promise-icon" aria-hidden="true">
                    <span className="dots">
                      <i className="v-holds" />
                      <i className="v-superseded" />
                      <i className="v-disproved" />
                    </span>
                  </span>
                  <b>Caveats</b>
                  <span>what still holds, and what was superseded or disproved</span>
                </li>
              </ul>
              {startControls}
            </div>
          ) : (
            <>
              <header className="explain-title">
                <div className="explain-kicker">
                  {implementing ? <PlanIcon size={16} /> : <ExplainIcon size={16} />} {implementing ? `Implementation plan by ${writer}` : `Explained by ${writer}`}
                </div>
                <h1>{title}</h1>
                {byline ? <div className="byline">{byline}</div> : null}
              </header>
              {sections.map((section, index) => (
                <Fragment key={section.id}>
                  <SectionView
                    key={stateOf(section) === 'fresh' ? `${section.id}-${lastRevision?.at}` : section.id}
                    section={section}
                    number={index + (sections[0]?.title ? 1 : 0)}
                    cells={cells}
                    onAdjust={canAsk && !busy && section.title ? adjust : undefined}
                    onAsk={canAsk && !busy ? askCell : undefined}
                    onKeep={!streaming && section.title ? keepSection : undefined}
                    state={stateOf(section)}
                    asker={asker}
                    writer={writer}
                  />
                </Fragment>
              ))}
              {streaming ? (
                <p className="explain-writing">
                  <span className="spinner" />
                  {thought ? (
                    <span>
                      {writer} is thinking — <em>{thought}</em>
                    </span>
                  ) : explanation?.content ? (
                    <span>{writer} is writing{sections.length ? ` — ${sections[sections.length - 1].title || 'the opening'}` : ''}…</span>
                  ) : (
                    <span>{writer} is reading the paper… a long one can take a minute or two before the first words{implementing ? ' of the plan' : ''}.</span>
                  )}
                </p>
              ) : null}
              {explanation?.error ? <p className="explain-error">{explanation.error}</p> : null}
              {explanation?.truncated ? <p className="explain-error">It ran out of room before the end. Rewrite, or ask about the rest in {ASSISTANT_NAME}.</p> : null}
            </>
          )}
        </article>
        </PlanContext.Provider>
        </KeepContext.Provider>
      </div>
      {side ? (
        <aside className="nb-side explain-side" aria-label={side === 'runtime' ? 'The runtime' : side === 'metrics' ? 'Training metrics' : 'Files on the runtime'}>
          <div className="nb-side-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={side === 'runtime'} onClick={() => pickSide('runtime')}>
              Runtime
            </button>
            <button type="button" role="tab" aria-selected={side === 'metrics'} onClick={() => pickSide('metrics')}>
              Metrics
            </button>
            <button type="button" role="tab" aria-selected={side === 'files'} onClick={() => pickSide('files')}>
              Files
            </button>
            <span className="spacer" />
            <button type="button" className="icon-btn sm" onClick={() => pickSide(null)} aria-label="Close the pane">
              <CloseIcon size={14} />
            </button>
          </div>
          {side === 'runtime' ? (
            <RuntimePane cells={codeCells} compute={compute} onGoTo={goToCell} onRunAll={colabAvailable(settings.googleClientId) && runnable.length ? () => void runAll(runnable).catch(() => undefined) : undefined} />
          ) : side === 'metrics' ? (
            <MetricsPane cells={metricCells} running={colab.running} onGoTo={goToCell} colabUrl={colab.runtime ? attachUrl(colab.runtime.endpoint) : undefined} />
          ) : (
            <FilesPane />
          )}
        </aside>
      ) : null}
      </div>
        </>
      )}

      {picked ? (
        <div className="selection-toolbar" style={{ top: picked.top, left: picked.left }} role="toolbar" aria-label="The selection">
          <button
            type="button"
            className="wide"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              window.dispatchEvent(new CustomEvent('reader:ask-claude', { detail: { text: picked.text } }));
              setPicked(null);
            }}
            title={`${ASSISTANT_NAME} about this passage of the explanation — it reads the paper too`}
          >
            <SparkleIcon size={15} /> {ASSISTANT_NAME}
          </button>
          <span className="divider" />
          <button
            type="button"
            className="wide"
            onMouseDown={(event) => event.preventDefault()}
            onClick={keepSelection}
            title="Keep this passage in your notes, maths and all"
          >
            <NoteIcon size={15} /> Add to notes
          </button>
        </div>
      ) : null}

      {implementing ? <RunConsole sections={sections} /> : null}
      {keeper.button}
      {toast}
      {snipping ? <BoxSnip root={docRef} selector={SNIPPABLE} onKeep={keepBox} /> : null}

      {flash ? (
        <PassageFlash
          flash={flash}
          look={settings.passageLook}
          onDone={() => {
            setFlash(null);
            window.dispatchEvent(new CustomEvent(FLASH_EVENT, { detail: { quote: null } }));
          }}
        />
      ) : null}
    </div>
  );
}
