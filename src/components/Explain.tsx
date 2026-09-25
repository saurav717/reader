import DOMPurify from 'dompurify';
import { cleanFigure } from '../lib/sanitize';
import type { CSSProperties } from 'react';
import { Fragment, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Screen } from '../lib/assistant';
import { getState, MODELS, saveKey, subscribe } from '../lib/assistant';
import type { Block, Section } from '../lib/explain';
import {
  applyEdits,
  caveatsOf,
  dismissPending,
  driveStateFor,
  explanationFor,
  generateExplanation,
  loadExplanation,
  notebook,
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
  implementationFor,
  loadImplementation,
  reviseImplementation,
  scaffoldNotebook,
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
import { CloseIcon, ExplainIcon, NoteIcon, OpacityIcon, PlanIcon, SparkleIcon } from './icons';
import { ColabMenu, ColabOutput, ColabOutputsContext, ColabRunPanel, ComputeBlock, FileBlock, HardwareSummary, ImplementEmpty, LocalMenu, RunConsole, runLocally, TreeBlock, useColab, useLocal } from './Implement';
import { tableText, useKept, useKeeper } from './Keep';
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
export type ExplainPage = 'explain' | 'implement';
const PAGE_KEY = 'reader.explain.page';
const readPage = (): ExplainPage => {
  try {
    return localStorage.getItem(PAGE_KEY) === 'implement' ? 'implement' : 'explain';
  } catch {
    return 'explain';
  }
};
interface PageStore {
  subscribe: (listener: () => void) => () => void;
  get: (paperId: string) => ReturnType<typeof explanationFor>;
  driveState: (paperId: string) => DriveState | undefined;
  load: (paperId: string) => Promise<unknown>;
  generate: (screen: Screen, model: string) => Promise<void>;
  revise: (screen: Screen, request: string, scope: RevisionScope) => Promise<void>;
  undo: (paperId: string) => void;
  dismiss: (paperId: string) => void;
  stop: () => void;
}
const STORES: Record<ExplainPage, PageStore> = {
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
];

/** Whether the window is one column, where the outline is hidden. */
function useNarrow() {
  const query = '(max-width: 900px)';
  const [narrow, setNarrow] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setNarrow(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

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
function lastThought(thinking?: string) {
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

function CodeCell({ block, index }: { block: Extract<Block, { kind: 'code' }>; index: number }) {
  const [copied, setCopied] = useState(false);
  const python = block.lang === 'python';
  const shell = block.lang === 'bash';
  // A shell cell runs on the reader's own machine once the scaffold is written there (the Local menu).
  const { project, console: local } = useLocal();
  // What the cell printed in Colab, once it has run there (the Colab menu), by its title.
  const fromColab = useContext(ColabOutputsContext).get(block.title);
  return (
    <figure className={`explain-cell${shell ? ' is-shell' : ''}`}>
      <header>
        <span className="cell-index">{python ? `In [${index}]` : shell ? '$' : 'Out'}</span>
        <span className="cell-title">{block.title}</span>
        {python || shell ? (
          <>
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
            {shell && project ? (
              <button type="button" className="btn sm local-run" disabled={local.running || block.open} onClick={() => void runLocally(block.code.trim())} title={`Run in ${project.dir}`}>
                ▶ Run locally
              </button>
            ) : null}
            {python ? (
              <button
                type="button"
                className="btn sm colab"
                disabled
                title="Running cells in Google Colab is coming next. For now, “Notebook” in the bar downloads every cell as an .ipynb that Colab opens."
              >
                <span className="colab-mark" aria-hidden="true">
                  co
                </span>
                Run in Colab
              </button>
            ) : null}
          </>
        ) : null}
      </header>
      <pre className="cell-code">
        <code dangerouslySetInnerHTML={{ __html: python ? highlightPython(block.code) : esc(block.code) }} />
        {block.open ? <span className="caret" aria-hidden="true" /> : null}
      </pre>
      {fromColab ? <ColabOutput outputs={fromColab} /> : null}
      {block.output !== undefined ? (
        <div className={`cell-output${fromColab ? ' is-expected' : ''}`}>
          <div className="cell-output-label">{fromColab ? 'What Claude expected' : 'Expected output · written by Claude, not run yet'}</div>
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
const KEEPABLE = '.explain-figure, .explain-cell, .explain-caveat, .impl-tree, .impl-file, .impl-budget, .explain-prose table, .explain-prose pre, .explain-prose .chat-math-block';

/** What a box dragged over the page keeps, whole: each piece of it the box touches. */
const SNIPPABLE = '.explain-prose > *, .explain-figure, .explain-cell, .explain-caveat, .impl-tree, .impl-file, .impl-budget';

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
  onKeep,
  state,
}: {
  section: Section;
  number: number;
  cells: Map<Block, number>;
  onAdjust?: (title: string) => void;
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
      <CodeCell key={key} block={block} index={cells.get(block) ?? 0} />
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

export default function Explain({ paperId, title, authors, published, screen, onClose }: Props) {
  const assistant = useSyncExternalStore(subscribe, getState);
  const [page, setPage] = useState<ExplainPage>(readPage);
  const store = STORES[page];
  const implementing = page === 'implement';
  const explanation = useSyncExternalStore(store.subscribe, () => store.get(paperId));
  const driveState = useSyncExternalStore(store.subscribe, () => store.driveState(paperId));
  const [layout, setLayout] = useState<ExplainLayout>(readLayout);
  const [model, setModel] = useState<string>(assistant.prefs.model);
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
    try {
      localStorage.setItem(PAGE_KEY, page);
    } catch {
      // private mode
    }
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
      if (event.key === 'Escape' && !document.activeElement?.closest('.assistant-win, .explain-ask') && !document.querySelector('.scrim')) onClose();
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
  const hasCode = cells.size > 0;
  const streaming = Boolean(explanation?.streaming);
  const thought = lastThought(explanation?.thinking);
  const busy = Boolean(streaming || (pending && !pending.error));
  const canAsk = Boolean(explanation?.content && assistant.hasKey && !streaming);

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
  const keeper = useKeeper({ root: docRef, selector: KEEPABLE, onKeep: keepElement });
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
      if (event.metaKey || event.ctrlKey || event.altKey || layout === 'beside') return;
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
  }, [layout, snipping]);
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

  const submit = async (request = ask) => {
    if (!request.trim() || busy) return;
    const read = await screen();
    setAsk('');
    setJustAsked(true);
    const asked = scope;
    setScope({});
    await store.revise(read, request, asked);
  };
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

  const download = () => {
    const blob = new Blob([implementing ? scaffoldNotebook(title, sections) : notebook(title, sections)], { type: 'application/x-ipynb+json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${title.slice(0, 80).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'paper'}${implementing ? '-implementation' : ''}.ipynb`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  };

  // Which model, and the button — or the key, first. The same on both pages' empty states.
  const startControls = (
    <>
              {assistant.hasKey ? (
                <>
                  <div className="explain-start">
                    <div className="model-pick" role="radiogroup" aria-label="Model">
                      {MODELS.map((m) => (
                        <button key={m.id} type="button" role="radio" aria-checked={model === m.id} onClick={() => setModel(m.id)}>
                          <b>{m.label}</b>
                          <span>{m.note}</span>
                        </button>
                      ))}
                    </div>
                    <button type="button" className="btn primary cta" onClick={() => void start()}>
                      <SparkleIcon size={17} /> {implementing ? 'Plan the implementation' : 'Explain this paper'}
                    </button>
                  </div>
                  <p className="hint">
                    <b>Written once</b> and kept for this paper
                    {driveState ? ', in this browser and in the paper’s folder in your Drive' : implementing ? ', in this browser' : ''}. A long paper costs about as much as a few long answers in Ask Claude.
                  </p>
                </>
              ) : (
                <>
                  <form
                    className="explain-start"
                    onSubmit={(event) => {
                      event.preventDefault();
                      saveKey(keyDraft);
                    }}
                  >
                    <input type="password" placeholder="sk-ant-…" value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} aria-label="Anthropic API key" />
                    <button type="submit" className="btn primary cta" disabled={!keyDraft.trim()}>
                      Use this key
                    </button>
                  </form>
                  <p className="hint">
                    <b>The same key as Ask Claude.</b> It stays in this browser and goes only to api.anthropic.com.
                  </p>
                </>
              )}
    </>
  );

  const colabOutputs = useColab(paperId).outputs;
  // The Colab run's panel sits in the outline; where there is no outline — beside the paper, or a phone — it floats.
  const narrow = useNarrow();
  const floating = layout === 'beside' || narrow;

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
          <ExplainIcon size={17} /> <span>Explained by Claude</span>
        </span>
        <span className="explain-bar-title" title={title}>
          {title}
        </span>
        <div className="segmented explain-pages" role="tablist" aria-label="Page">
          {PAGES.map((option) => (
            <button key={option.id} type="button" role="tab" aria-selected={page === option.id} aria-pressed={page === option.id} title={option.note} onClick={() => setPage(option.id)}>
              {option.id === 'implement' ? <PlanIcon size={13} /> : <ExplainIcon size={13} />}
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
        {implementing && explanation?.content && !streaming ? (
          <>
            <ColabMenu paperId={paperId} title={title} content={shown} sections={sections} />
            <LocalMenu title={title} content={shown} sections={sections} />
          </>
        ) : hasCode && !streaming ? (
          <button type="button" className="btn sm" onClick={download} title="Every cell and its explanation as a Jupyter notebook — File → Upload notebook in Colab opens it">
            Notebook ↓
          </button>
        ) : null}
        {explanation?.content && !streaming ? (
          <button type="button" className="btn sm ghost rewrite" onClick={() => void start()} disabled={!assistant.hasKey} title={implementing ? 'Plan it again from scratch, for the machine picked now' : 'Write it again from scratch'}>
            Rewrite
          </button>
        ) : null}
        {streaming ? (
          <button type="button" className="btn sm" onClick={store.stop}>
            Stop
          </button>
        ) : null}
        {explanation?.content ? (
          <button
            type="button"
            className="btn sm ghost snip-toggle"
            aria-pressed={snipping}
            onClick={() => setSnipping(!snipping)}
            title="Snip: drag a box over anything here — prose, a diagram, a code cell, a table — to add it to your notes (S)"
          >
            ✂ Snip
          </button>
        ) : null}
        <OpacityControl value={opacity} fallback={defaultOpacity} onChange={(value) => updateSettings({ explainOpacity: value })} />
        <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close the explanation (Esc)" title="Back to the paper (Esc or E)">
          <CloseIcon size={17} />
        </button>
      </header>

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
                  : scope.section || scope.quote
                    ? 'Ask about this, or say how to change it…'
                    : implementing
                      ? 'Ask about the plan, or change it — a different dataset, framework, scale…  ( / )'
                      : 'Ask anything about this explanation, or tell Claude how to change it…  ( / )'
              }
              aria-label="Ask about the explanation, or ask for a change"
            />
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
            <div className="ask-status">
              <span className="spinner" />
              <span className="ask-note">
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
          {implementing && explanation?.content && !floating ? <ColabRunPanel paperId={paperId} docked /> : null}
          {explanation?.content ? (
            <div className="outline-meta">
              {streaming ? (implementing ? 'Claude is planning…' : 'Claude is writing…') : `${implementing ? 'Planned' : 'Written'} by ${writtenWith} · ${new Date(explanation.created).toLocaleDateString()}`}
              <DriveLine state={driveState} />
            </div>
          ) : null}
        </nav>

        <ColabOutputsContext.Provider value={colabOutputs}>
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
                Claude reads the paper <b>end to end</b> and writes you a walkthrough: <mark>the problem</mark>, <mark>how the method works</mark> and{' '}
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
                  {implementing ? <PlanIcon size={16} /> : <ExplainIcon size={16} />} {implementing ? 'Implementation plan by Claude' : 'Explained by Claude'}
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
                    onKeep={!streaming && section.title ? keepSection : undefined}
                    state={stateOf(section)}
                  />
                </Fragment>
              ))}
              {streaming ? (
                <p className="explain-writing">
                  <span className="spinner" />
                  {thought ? (
                    <span>
                      Claude is thinking — <em>{thought}</em>
                    </span>
                  ) : explanation?.content ? (
                    <span>Claude is writing{sections.length ? ` — ${sections[sections.length - 1].title || 'the opening'}` : ''}…</span>
                  ) : (
                    <span>Claude is reading the paper… a long one can take a minute or two before the first words{implementing ? ' of the plan' : ''}.</span>
                  )}
                </p>
              ) : null}
              {explanation?.error ? <p className="explain-error">{explanation.error}</p> : null}
              {explanation?.truncated ? <p className="explain-error">It ran out of room before the end. Rewrite, or ask about the rest in Ask Claude.</p> : null}
            </>
          )}
        </article>
        </ColabOutputsContext.Provider>
      </div>

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
            title="Ask Claude about this passage of the explanation — it reads the paper too"
          >
            <SparkleIcon size={15} /> Ask Claude
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
      {implementing && explanation?.content && floating ? <ColabRunPanel paperId={paperId} /> : null}
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
