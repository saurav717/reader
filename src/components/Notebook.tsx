// The Colab tab: a notebook of the reader's own, on the Colab runtime.
//
// Colab's API gives the page a runtime and its kernel (src/lib/colab.ts),
// so the notebook is the reader's — cells to edit, add, move and run, in
// the same kernel the Explanation and Implementation pages' cells run in,
// with what they printed kept under them, the loss curves and the
// machine's use drawn as they are under those cells, and the runtime's
// disk a pane away. It is seeded from the page's own cells the first time,
// goes out as an .ipynb — to a file, to GitHub, to Colab's own page — and
// takes one in. The model and the store are src/lib/notebook.ts. Nothing
// runs without a click or a Shift-Enter on that cell; Run all asks first.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import DOMPurify from 'dompurify';
import { getState as assistantState, modelSpec, PROVIDERS, subscribe as subscribeAssistant } from '../lib/assistant';
import type { Screen } from '../lib/assistant';
import { colabAvailable, colabGranted, connect as connectColab, interrupt as interruptColab, listContents, machineLabel, runAll, runCell } from '../lib/colab';
import type { CellRun, RuntimeEntry } from '../lib/colab';
import { explanationFor } from '../lib/explain';
import type { Section } from '../lib/explain';
import { commitFiles, targetFrom } from '../lib/github';
import { computeOf, implementationFor } from '../lib/implement';
import { askNotebook, dismissNotebookAsk, loadNotebookAsk, notebookAskFor, outputText, stopNotebookAsk, subscribeNotebookAsk, undoNotebookReply } from '../lib/notebookAsk';
import type { AskScope } from '../lib/notebookAsk';
import { findPassage, findSquashed, FLASH_EVENT, setNotebookLocator, squash, takeHeldPassage } from '../lib/locate';
import type { LocateRequest, LocateResult } from '../lib/locate';
import { SHOW_CELL, takeHeldCell } from '../lib/notebookNav';
import type { ShowCell } from '../lib/notebookNav';
import { markdown } from '../lib/markdown';
import { appendCells, cellStatus, clearOutputs, fromIpynb, insertCell, loadNotebook, moveCell, notebookFileName, notebookFor, removeCell, runKey, seedCells, setOutputs, setSource, setType, subscribeNotebook, toIpynb } from '../lib/notebook';
import type { NbCell } from '../lib/notebook';
import { useStore } from '../lib/store';
import { attachUrl, CellRunOutput, ColabMark, ConnectCard, RunState, useColab } from './Colab';
import { highlightPython, lastThought } from './Explain';
import { CloseIcon, SparkleIcon } from './icons';
import MetricsPane from './MetricsPane';
import PassageFlash from './PassageFlash';
import type { Flash } from './PassageFlash';
import RuntimePane from './RuntimePane';

const useNotebook = (paperId: string) => useSyncExternalStore(subscribeNotebook, () => notebookFor(paperId));

/** Whether the ask bar is shown: open unless hidden, and remembered. */
const ASK_BAR_KEY = 'reader.colab.ask-bar';
const readAskBar = (): boolean => {
  try {
    return localStorage.getItem(ASK_BAR_KEY) !== 'hidden';
  } catch {
    return true;
  }
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mdHtml = (md: string) => DOMPurify.sanitize(markdown(md), { ADD_ATTR: ['target'] });
const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const bytes = (n: number | null) => (n === null ? '' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`);

function download(name: string, blob: Blob) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}

// ---------------------------------------------------------------------------
// The editor: a textarea over the same text coloured, so what is typed is
// what is highlighted; the two share a grid cell, so the height is the text's.
// ---------------------------------------------------------------------------

function Editor({ value, python, autoFocus, onChange, onKeyDown, onBlur, placeholder }: { value: string; python: boolean; autoFocus?: boolean; onChange: (next: string) => void; onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void; onBlur?: () => void; placeholder?: string }) {
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) {
      const element = box.current;
      element?.focus();
      element?.setSelectionRange(element.value.length, element.value.length);
    }
  }, [autoFocus]);
  return (
    <div className="nb-editor">
      <pre className="cell-code nb-shadow" aria-hidden="true">
        <code dangerouslySetInnerHTML={{ __html: (python ? highlightPython(value) : esc(value)) + '\n' }} />
      </pre>
      <textarea
        ref={box}
        className="cell-code nb-text"
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder={placeholder}
        aria-label={python ? 'Code' : 'Text'}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
            // Four spaces, as Colab does; a selection is indented or outdented a line at a time.
            event.preventDefault();
            const element = event.currentTarget;
            const { selectionStart: start, selectionEnd: end, value: text } = element;
            const lineStart = text.lastIndexOf('\n', start - 1) + 1;
            if (event.shiftKey) {
              const chunk = text.slice(lineStart, end);
              const outdented = chunk.replace(/^ {1,4}/gm, '');
              const next = text.slice(0, lineStart) + outdented + text.slice(end);
              onChange(next);
              const shift = chunk.length - outdented.length;
              window.requestAnimationFrame(() => element.setSelectionRange(Math.max(lineStart, start - Math.min(4, shift)), Math.max(lineStart, end - shift)));
            } else if (start !== end && text.slice(start, end).includes('\n')) {
              const chunk = text.slice(lineStart, end);
              const indented = chunk.replace(/^/gm, '    ');
              onChange(text.slice(0, lineStart) + indented + text.slice(end));
              window.requestAnimationFrame(() => element.setSelectionRange(start + 4, end + (indented.length - chunk.length)));
            } else {
              onChange(text.slice(0, start) + '    ' + text.slice(end));
              window.requestAnimationFrame(() => element.setSelectionRange(start + 4, start + 4));
            }
            return;
          }
          onKeyDown(event);
        }}
        onBlur={onBlur}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// One cell
// ---------------------------------------------------------------------------

function Cell({
  paperId,
  cell,
  index,
  selected,
  editing,
  run,
  canRun,
  busy,
  onSelect,
  onEdit,
  onRun,
  onAsk,
  lit,
}: {
  paperId: string;
  cell: NbCell;
  index: number;
  selected: boolean;
  editing: boolean;
  run?: CellRun;
  canRun: boolean;
  busy: boolean;
  onSelect: () => void;
  onEdit: (on: boolean) => void;
  /** Run this cell; `then` says where the selection goes after. */
  onRun: (then: 'stay' | 'next' | 'insert') => void;
  onAsk?: (request: string, quote: string) => void;
  /** Brought into view from the Ask AI window: lit for a moment. */
  lit?: boolean;
}) {
  const live = run?.state === 'running' || run?.state === 'queued';
  // What is shown under the cell: the run in the Colab store while there is one, else what the notebook kept.
  const shown: CellRun | undefined = run ?? (cell.outputs.length || cell.count !== null ? { state: 'ran', outputs: cell.outputs, startedAt: cell.ranAt ?? 0, where: cell.ranAt ? 'Colab · kept with the notebook' : 'kept with the notebook', executionCount: cell.count ?? undefined } : undefined);
  // A run that has ended goes into the notebook, so it is there after a reload.
  useEffect(() => {
    if (!run || live) return;
    if (run.outputs !== cell.outputs) setOutputs(paperId, cell.id, run.outputs, run.executionCount ?? cell.count, run.startedAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.state]);
  const keys = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)) {
      event.preventDefault();
      if (cell.type === 'markdown') {
        onEdit(false);
        if (event.shiftKey) onRun('next');
        return;
      }
      onRun(event.altKey ? 'insert' : event.shiftKey ? 'next' : 'stay');
    } else if (event.key === 'Escape') {
      // Leaves the editor, and goes no further: the page's own Escape would close it, since a text cell's editor is gone by the time it looks.
      event.preventDefault();
      event.stopPropagation();
      onEdit(false);
    }
  };
  const python = cell.type === 'code';
  const status = cellStatus(cell, run);
  const statusText =
    status === 'running' ? 'running' : status === 'queued' ? 'queued' : status === 'ran' ? `ran${cell.ranAt ? ` ${time(cell.ranAt)}` : ''}` : status === 'failed' ? 'failed' : status === 'stopped' ? 'stopped' : status === 'changed' ? 'changed since it ran' : status === 'earlier' ? 'ran earlier, elsewhere' : status === 'never' ? 'not run yet' : '';
  return (
    <section
      className={`nb-cell is-${cell.type}${selected ? ' is-selected' : ''}${editing ? ' is-editing' : ''}${run ? ` is-${run.state}` : ''}${cell.fresh ? ' is-fresh' : ''}${lit ? ' is-shown' : ''}`}
      data-cell={cell.id}
      onMouseDown={onSelect}
      aria-label={`${cell.type === 'code' ? 'Code' : 'Text'} cell ${index + 1}`}
    >
      <div className="nb-gutter">
        {python ? (
          live ? (
            <button type="button" className="nb-run is-busy" onClick={() => void interruptColab()} title="Interrupt the kernel" aria-label="Stop">
              ■
            </button>
          ) : (
            <button type="button" className="nb-run" disabled={!canRun || busy} onClick={() => onRun('stay')} title={canRun ? 'Run this cell in your Colab runtime (Shift-Enter runs and moves on)' : 'Running cells needs a Google client ID and the reader’s proxy'} aria-label="Run">
              ▶
            </button>
          )
        ) : (
          <span className="nb-mark" aria-hidden="true">
            ¶
          </span>
        )}
        <span className="nb-count">{python ? (live ? '[*]' : `[${run?.executionCount ?? cell.count ?? ' '}]`) : ''}</span>
        {status ? <span className={`nb-ran is-${status}`} role="img" aria-label={`This cell: ${statusText}`} title={statusText} /> : null}
      </div>
      <div className="nb-body">
        {cell.fresh ? (
          <span className="revised-pill nb-fresh" title="From the ask bar; the mark goes when the cell is edited or run">
            {cell.fresh === 'new' ? 'New · from the ask bar' : 'Rewritten at your request'}
          </span>
        ) : null}
        {cell.type === 'code' || editing ? (
          <Editor value={cell.source} python={python} autoFocus={editing} onChange={(next) => setSource(paperId, cell.id, next)} onKeyDown={keys} placeholder={python ? '# Python, on your Colab runtime' : 'Markdown'} onBlur={() => (python ? onEdit(false) : undefined)} />
        ) : (
          <div className="nb-markdown explain-prose" onDoubleClick={() => onEdit(true)} dangerouslySetInnerHTML={{ __html: cell.source.trim() ? mdHtml(cell.source) : '<p class="nb-empty">Empty text cell — double-click to write</p>' }} />
        )}
        {python && run ? <RunState run={run} /> : null}
        {python && shown ? <CellRunOutput run={shown} onAsk={onAsk ? (request) => onAsk(request, cell.source.slice(0, 1500)) : undefined} onForget={() => setOutputs(paperId, cell.id, [], null, undefined)} /> : null}
      </div>
      <div className="nb-tools" role="toolbar" aria-label="Cell">
        {status ? <span className={`nb-tools-state is-${status}`}>{statusText}</span> : null}
        <button
          type="button"
          onClick={(event) => {
            // Into the editor: the code's textarea, or a text cell's editor, with the caret at the end.
            onEdit(true);
            const area = (event.currentTarget.closest('.nb-cell') as HTMLElement | null)?.querySelector<HTMLTextAreaElement>('.nb-text');
            if (area) {
              area.focus();
              area.setSelectionRange(area.value.length, area.value.length);
            }
          }}
          title={cell.type === 'code' ? 'Edit the code — or just click into it and type' : 'Edit the text (or double-click it)'}
        >
          Edit
        </button>
        <button type="button" onClick={() => moveCell(paperId, cell.id, -1)} title="Move up" aria-label="Move up">
          ↑
        </button>
        <button type="button" onClick={() => moveCell(paperId, cell.id, 1)} title="Move down" aria-label="Move down">
          ↓
        </button>
        <button type="button" onClick={() => setType(paperId, cell.id, cell.type === 'code' ? 'markdown' : 'code')} title={cell.type === 'code' ? 'Make it a text cell (M)' : 'Make it a code cell (Y)'}>
          {cell.type === 'code' ? 'Text' : 'Code'}
        </button>
        <button type="button" onClick={() => insertCell(paperId, cell.id, 'below')} title="A code cell below (B)" aria-label="Add a cell below">
          +
        </button>
        <button type="button" className="is-danger" onClick={() => removeCell(paperId, cell.id)} title="Delete the cell (D D)" aria-label="Delete">
          <CloseIcon size={13} />
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The runtime's disk
// ---------------------------------------------------------------------------

export function FilesPane() {
  const colab = useColab();
  const connected = colab.status === 'idle' || colab.status === 'busy';
  const [path, setPath] = useState('');
  const [listing, setListing] = useState<{ path: string; entries: RuntimeEntry[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async (at: string) => {
    setLoading(true);
    setProblem(null);
    try {
      setListing(await listContents(at));
      setPath(at);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (connected) void load(path);
    else setListing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, colab.runtime?.endpoint]);
  return (
    <aside className="nb-files" aria-label="Files on the runtime">
      <header>
        <b>Files</b>
        <span className="nb-files-path">/content{path ? `/${path}` : ''}</span>
        <button type="button" className="icon-btn sm" onClick={() => void load(path)} disabled={!connected || loading} title="Read the disk again" aria-label="Refresh">
          ↻
        </button>
      </header>
      {!connected ? (
        <p className="nb-files-note">Connect a runtime and its disk is listed here: what the cells wrote, the data they fetched, the checkpoints.</p>
      ) : problem ? (
        <p className="nb-files-note is-problem">{problem}</p>
      ) : !listing ? (
        <p className="nb-files-note">
          <span className="spinner" /> Reading the disk…
        </p>
      ) : (
        <ul>
          {path ? (
            <li>
              <button type="button" onClick={() => void load(path.split('/').slice(0, -1).join('/'))}>
                <span className="nb-file-icon">↰</span> ..
              </button>
            </li>
          ) : null}
          {listing.entries.map((entry) => (
            <li key={entry.path} className={`is-${entry.type}`}>
              {entry.type === 'directory' ? (
                <button type="button" onClick={() => void load(entry.path)}>
                  <span className="nb-file-icon">▸</span> {entry.name}/
                </button>
              ) : (
                <span>
                  <span className="nb-file-icon">{entry.type === 'notebook' ? '▤' : '·'}</span> {entry.name}
                  <small>{bytes(entry.size)}</small>
                </span>
              )}
            </li>
          ))}
          {!listing.entries.length ? <li className="nb-files-note">Nothing here yet.</li> : null}
        </ul>
      )}
      <p className="nb-files-foot">The runtime's disk goes when the runtime does; keep what matters in Drive or a commit.</p>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

type Push = { state: 'idle' } | { state: 'pushing' } | { state: 'pushed'; url: string } | { state: 'error'; message: string };

export default function NotebookPage({ paperId, title, screen, sections, planSections }: { paperId: string; title: string; screen: () => Promise<Screen>; sections: Section[]; planSections?: () => Section[] | null }) {
  const nb = useNotebook(paperId);
  const colab = useColab();
  const { settings } = useStore();
  const assistant = useSyncExternalStore(subscribeAssistant, assistantState);
  const nbAsk = useSyncExternalStore(subscribeNotebookAsk, () => notebookAskFor(paperId));
  const [ask, setAsk] = useState('');
  const [askBar, setAskBar] = useState<boolean>(readAskBar);
  const showAskBar = (on: boolean) => {
    setAskBar(on);
    try {
      localStorage.setItem(ASK_BAR_KEY, on ? 'shown' : 'hidden');
    } catch {
      // private mode
    }
  };
  const [askFocused, setAskFocused] = useState(false);
  const [justAsked, setJustAsked] = useState(false);
  /** A passage the next request is about: an output, a traceback, a bit of code. The cell it is about is the one picked. */
  const [quote, setQuote] = useState<string | undefined>(undefined);
  const askRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  /** The pane on the right: the runtime, the files, or nothing. It opens on its own when a runtime connects, and folds when it ends. */
  const [side, setSide] = useState<'runtime' | 'files' | 'metrics' | null>(null);
  const closedByHand = useRef(false);
  const [card, setCard] = useState<{ then: () => void } | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [push, setPush] = useState<Push>({ state: 'idle' });
  const [note, setNote] = useState<string | null>(null);
  const lastKey = useRef<{ key: string; at: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const filePick = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void loadNotebook(paperId, title, () => seedCells(title, sections));
    void loadNotebookAsk(paperId);
    // Seeded once; the cells are the notebook's from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId]);
  const cells = nb?.cells ?? [];
  // The ask bar: the model the pages are written with, or the one Rewrite last picked here; a key for it; nothing being answered.
  const model = nbAsk.model ?? assistant.prefs.explainModel ?? assistant.prefs.model;
  const writer = PROVIDERS[modelSpec(model).provider].name;
  const asking = Boolean(nbAsk.pending && !nbAsk.pending.error);
  const canAsk = Boolean(nb && assistant.keys[modelSpec(model).provider] && !asking);
  const thought = lastThought(nbAsk.pending?.thinking);
  const available = colabAvailable(settings.googleClientId);
  const connected = colab.status === 'idle' || colab.status === 'busy';
  useEffect(() => {
    if (connected) {
      if (!closedByHand.current) setSide((current) => current ?? 'runtime');
    } else {
      setSide((current) => (current === 'runtime' ? null : current));
      closedByHand.current = false;
    }
  }, [connected]);
  const closeSide = () => {
    closedByHand.current = true;
    setSide(null);
  };
  // The plan's compute block, for the ticks on the pane's meters, when the paper has a plan.
  const compute = useMemo(() => {
    const plan = planSections?.();
    return plan ? computeOf(plan) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, nb?.updated]);
  const codeCells = useMemo(() => cells.map((cell, index) => ({ cell, index })).filter(({ cell }) => cell.type === 'code').map(({ cell, index }) => ({ key: runKey(cell.id), id: cell.id, label: `cell ${index + 1}` })), [cells]);
  // What each code cell printed, for the Metrics tab: live from the run while there is one.
  const metricCells = useMemo(
    () =>
      cells
        .map((cell, index) => ({ cell, index }))
        .filter(({ cell }) => cell.type === 'code')
        .map(({ cell, index }) => {
          const run = colab.runs[runKey(cell.id)];
          return { key: runKey(cell.id), id: cell.id, label: `cell ${index + 1}`, text: outputText(cell, run), at: run?.startedAt || cell.ranAt || 0 };
        }),
    [cells, colab.runs],
  );
  const goTo = (id: string) => {
    setSelected(id);
    root.current?.querySelector<HTMLElement>(`[data-cell="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const selectedIndex = selected ? cells.findIndex((cell) => cell.id === selected) : -1;
  /** The cell shown on request from the Ask AI window: picked, scrolled to, and lit for a moment. */
  const [shown, setShown] = useState<string | null>(null);
  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  const showCell = (n: number) => {
    const cell = cellsRef.current[n - 1];
    if (!cell) {
      setNote(`There is no cell ${n} — the notebook has ${cellsRef.current.length}.`);
      window.setTimeout(() => setNote(null), 4000);
      return;
    }
    goTo(cell.id);
    setShown(cell.id);
    window.setTimeout(() => setShown((current) => (current === cell.id ? null : current)), 2400);
  };
  useEffect(() => {
    const onShow = (event: Event) => showCell((event as CustomEvent<ShowCell>).detail.cell);
    window.addEventListener(SHOW_CELL, onShow);
    return () => window.removeEventListener(SHOW_CELL, onShow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A passage of the notebook the Ask AI window points at: the cell brought
  // into view and lit, and the words marked on it for a moment — in the code
  // as it is coloured, in a text cell's prose, or in what the cell printed.
  const [flash, setFlash] = useState<Flash | null>(null);
  const flashKey = useRef(0);
  const runsRef = useRef(colab.runs);
  runsRef.current = colab.runs;
  const locateHere = useCallback(async (request: LocateRequest): Promise<LocateResult> => {
    const list = cellsRef.current;
    const textOf = (cell: NbCell) => `${cell.source}\n${cell.type === 'code' ? outputText(cell, runsRef.current[runKey(cell.id)]) : ''}`;
    const named = request.cell && list[request.cell - 1] ? request.cell - 1 : -1;
    // The cell the answer named first, then the rest: the whole quote, or the cell holding most of it.
    const order = named >= 0 ? [named, ...list.keys()] : [...list.keys()];
    let best: { index: number; words: number } | null = null;
    for (const index of order) {
      const hit = findSquashed(squash(textOf(list[index])).text, request.quote);
      if (!hit) continue;
      if (hit.words === hit.of) {
        best = { index, words: hit.words };
        break;
      }
      if (!best || hit.words > best.words) best = { index, words: hit.words };
    }
    const index = best?.index ?? named;
    if (index < 0) return { found: false, reason: list.length ? 'Those words are not in the notebook.' : 'The notebook has no cells yet.' };
    const cell = list[index];
    goTo(cell.id);
    setShown(cell.id);
    window.setTimeout(() => setShown((current) => (current === cell.id ? null : current)), 2400);
    const section = root.current?.querySelector<HTMLElement>(`[data-cell="${cell.id}"]`);
    const scroller = root.current?.querySelector<HTMLElement>('.nb-cells') ?? null;
    let range: Range | null = null;
    if (section && best) {
      // The coloured code first — the textarea over it holds the same text but draws no rectangles.
      for (const part of ['.nb-shadow', '.nb-markdown', '.nb-body']) {
        const element = section.querySelector<HTMLElement>(part);
        range = element ? findPassage(element, request.quote) : null;
        if (range) break;
      }
    }
    if (range) {
      setFlash({ range, label: request.label, where: `The notebook · cell ${index + 1}`, clip: scroller, anchor: scroller, key: ++flashKey.current, n: request.n });
      window.dispatchEvent(new CustomEvent(FLASH_EVENT, { detail: { quote: request.quote } }));
    }
    return { found: true };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const release = setNotebookLocator(locateHere);
    return () => {
      release();
      window.dispatchEvent(new CustomEvent(FLASH_EVENT, { detail: { quote: null } }));
    };
  }, [locateHere]);
  // Asked for while another page was open: taken once the cells are here.
  useEffect(() => {
    if (!nb) return;
    const held = takeHeldCell();
    if (held) window.setTimeout(() => showCell(held), 50);
    const passage = takeHeldPassage();
    if (passage) window.setTimeout(() => void locateHere(passage.request).then(passage.reply), 80);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nb?.paperId]);
  /** A request to the bar: about the cell picked, and the passage taken, unless the caller says otherwise. */
  const submit = async (request = ask, scope: AskScope = { cell: selectedIndex >= 0 ? selectedIndex + 1 : undefined, quote }) => {
    if (!request.trim() || !canAsk) return;
    if (!askBar) showAskBar(true);
    const read = await screen();
    setAsk('');
    setQuote(undefined);
    setJustAsked(true);
    await askNotebook({ paperId, screen: read, model, request, scope, runs: colab.runs, pages: { explanation: explanationFor(paperId)?.content, plan: implementationFor(paperId)?.content } });
  };
  // A reply landed: the first cell it wrote or changed comes into view, picked.
  const lastAt = nbAsk.last?.at;
  useEffect(() => {
    const first = nbAsk.last?.touched[0];
    if (lastAt && first && Date.now() - lastAt < 5000) goTo(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastAt]);
  /** Runs the cells the last reply wrote, in order. */
  const runFresh = () => {
    const touched = new Set(nbAsk.last?.touched ?? []);
    const fresh = cells.filter((cell) => touched.has(cell.id) && cell.type === 'code' && cell.source.trim());
    if (!fresh.length) return;
    const go = () => void runAll(fresh.map((cell) => ({ key: runKey(cell.id), code: cell.source })));
    if (colab.status === 'off' && !colabGranted()) setCard({ then: go });
    else go();
  };
  const busy = Boolean(colab.running) || colab.status === 'connecting';
  const target = targetFrom(settings);
  const ranCount = useMemo(() => cells.filter((cell) => cell.type === 'code' && (colab.runs[runKey(cell.id)]?.state === 'ran' || cell.count !== null)).length, [cells, colab.runs]);

  /** Runs a cell; the first time in a tab that never connected, the card says what will happen first. */
  const runOne = (cell: NbCell, then: 'stay' | 'next' | 'insert') => {
    if (cell.type !== 'code') return;
    const go = () => {
      void runCell(runKey(cell.id), cell.source).catch(() => undefined);
      const at = cells.findIndex((c) => c.id === cell.id);
      if (then === 'insert') {
        const id = insertCell(paperId, cell.id, 'below');
        setSelected(id);
        setEditing(id);
      } else if (then === 'next') {
        const next = cells[at + 1];
        if (next) {
          // On to the next: into its editor when it is code; a text cell is picked, not opened, so typing does not land in rendered prose.
          setSelected(next.id);
          setEditing(next.type === 'code' ? next.id : null);
        } else {
          const id = insertCell(paperId, cell.id, 'below');
          setSelected(id);
          setEditing(id);
        }
      }
    };
    if (colab.status === 'off' && !colabGranted()) {
      setCard({ then: go });
      return;
    }
    go();
  };
  const runEverything = () => {
    setConfirmAll(false);
    void runAll(cells.filter((cell) => cell.type === 'code' && cell.source.trim()).map((cell) => ({ key: runKey(cell.id), code: cell.source })));
  };

  // Command mode: the keys Colab and Jupyter share, when no cell is being typed in.
  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (event.key === 'Escape' && !selected) {
      // Nothing picked: the next Escape is the page's, and closes Explain.
      root.current?.blur();
      return;
    }
    if (!selected || event.metaKey || event.ctrlKey || event.altKey) return;
    const at = cells.findIndex((cell) => cell.id === selected);
    const cell = cells[at];
    if (!cell) return;
    const key = event.key;
    const now = Date.now();
    const twice = lastKey.current?.key === key && now - lastKey.current.at < 600;
    lastKey.current = { key, at: now };
    if (key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) runOne(cell, 'next');
      else setEditing(cell.id);
    } else if (key === 'ArrowUp' || key === 'k') {
      event.preventDefault();
      if (at > 0) setSelected(cells[at - 1].id);
    } else if (key === 'ArrowDown' || key === 'j') {
      event.preventDefault();
      if (at < cells.length - 1) setSelected(cells[at + 1].id);
    } else if (key === 'a' || key === 'b') {
      event.preventDefault();
      setSelected(insertCell(paperId, cell.id, key === 'a' ? 'above' : 'below'));
    } else if (key === 'm' || key === 'y') {
      event.preventDefault();
      setType(paperId, cell.id, key === 'm' ? 'markdown' : 'code');
    } else if (key === 'd' && twice) {
      event.preventDefault();
      const next = cells[at + 1] ?? cells[at - 1];
      removeCell(paperId, cell.id);
      setSelected(next?.id ?? cell.id);
      lastKey.current = null;
    } else if (key === 'Escape') {
      setSelected(null);
    }
  };

  const addFromSections = (from: Section[] | null | undefined, what: string) => {
    if (!from?.length) {
      setNote(`There is no ${what} yet.`);
      return;
    }
    const more = seedCells(title, from);
    appendCells(paperId, more);
    setNote(`${more.length} cells from the ${what} added at the end.`);
  };
  const addFromFile = async (file: File | undefined) => {
    if (!file) return;
    const read = fromIpynb(await file.text());
    if (!read) {
      setNote(`${file.name} is not a Jupyter notebook.`);
      return;
    }
    appendCells(paperId, read);
    setNote(`${read.length} cells from ${file.name} added at the end.`);
  };
  const commit = async () => {
    if (!nb || !target) return;
    setPush({ state: 'pushing' });
    try {
      const path = `notebooks/${notebookFileName(title)}`;
      await commitFiles(target, { [path]: toIpynb(nb) }, `Notebook for “${title.slice(0, 72)}”, from Reader`);
      setPush({ state: 'pushed', url: `https://colab.research.google.com/github/${target.owner}/${target.repo}/blob/${target.branch}/${path}` });
    } catch (error) {
      setPush({ state: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };
  useEffect(() => {
    if (!note) return;
    const timer = window.setTimeout(() => setNote(null), 4000);
    return () => window.clearTimeout(timer);
  }, [note]);

  const menu = (label: string, items: ReactNode) => <NbMenu label={label}>{items}</NbMenu>;

  return (
    <div className="nb-page" ref={root} onKeyDown={onKey} tabIndex={-1}>
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
      <div className="nb-toolbar" role="toolbar" aria-label="Notebook">
        <ColabMark />
        <span className="nb-title">
          <b>Your notebook</b>
          <span>
            {connected && colab.runtime ? `on your ${machineLabel(colab.runtime)} runtime — the kernel the pages' cells run in` : available ? `runs on your own Colab, from here — the first Run starts a ${machineLabel(colab.machine)} runtime` : 'running cells needs Settings → Google and Settings → Paper proxy'}
            {' · '}
            {cells.length} {cells.length === 1 ? 'cell' : 'cells'}, {ranCount} run
          </span>
        </span>
        <button type="button" className="btn sm" onClick={() => setSelected(insertCell(paperId, selected, 'below', 'code'))}>
          + Code
        </button>
        <button type="button" className="btn sm" onClick={() => setSelected(insertCell(paperId, selected, 'below', 'markdown'))}>
          + Text
        </button>
        {colab.running ? (
          <button type="button" className="btn sm colab-stop" onClick={() => void interruptColab()}>
            ■ Stop
          </button>
        ) : confirmAll ? (
          <span className="nb-confirm">
            Run every code cell, top to bottom? It stops at the first that fails.
            <button type="button" className="btn sm primary" onClick={runEverything}>
              Run all
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setConfirmAll(false)}>
              Not now
            </button>
          </span>
        ) : (
          <button type="button" className="btn sm colab" disabled={!available || busy || !cells.some((cell) => cell.type === 'code')} onClick={() => (colab.status === 'off' && !colabGranted() ? setCard({ then: runEverything }) : setConfirmAll(true))} title="Every code cell in order; asks first, stops at the first error">
            ▶ Run all
          </button>
        )}
        {menu(
          'Cells',
          <>
            <button type="button" role="menuitem" onClick={() => addFromSections(sections, 'explanation')}>
              Add the explanation's cells
            </button>
            <button type="button" role="menuitem" onClick={() => addFromSections(planSections?.(), 'plan')}>
              Add the plan's cells
            </button>
            <button type="button" role="menuitem" onClick={() => filePick.current?.click()}>
              Add the cells of a .ipynb…
            </button>
            <hr />
            <button type="button" role="menuitem" onClick={() => clearOutputs(paperId)}>
              Clear every output
            </button>
          </>,
        )}
        {menu(
          'Notebook',
          <>
            <button type="button" role="menuitem" onClick={() => nb && download(notebookFileName(title), new Blob([toIpynb(nb)], { type: 'application/x-ipynb+json' }))}>
              Download as .ipynb
            </button>
            <button type="button" role="menuitem" disabled={!target || push.state === 'pushing'} onClick={() => void commit()} title={target ? `notebooks/ in ${target.owner}/${target.repo}` : 'Settings → Git repository first'}>
              {push.state === 'pushing' ? 'Committing…' : 'Commit to GitHub, and open in Colab'}
            </button>
            {colab.runtime ? (
              <a role="menuitem" href={attachUrl(colab.runtime.endpoint)} target="_blank" rel="noreferrer noopener">
                Open this runtime in Colab's own page ↗
              </a>
            ) : null}
          </>,
        )}
        <button type="button" className={`btn sm ghost${askBar ? ' is-on' : ''}`} aria-pressed={askBar} onClick={() => showAskBar(!askBar)} title={askBar ? 'Hide the ask bar' : 'Show the ask bar: cells written, changed and fixed for you'}>
          Ask
        </button>
        <button type="button" className={`btn sm ghost${side === 'runtime' ? ' is-on' : ''}`} aria-pressed={side === 'runtime'} onClick={() => (side === 'runtime' ? closeSide() : setSide('runtime'))} title="The machine: how busy it is, the last ten minutes, what is left of the session">
          Runtime
        </button>
        <button type="button" className={`btn sm ghost${side === 'metrics' ? ' is-on' : ''}`} aria-pressed={side === 'metrics'} onClick={() => (side === 'metrics' ? closeSide() : setSide('metrics'))} title="Training metrics, read off what the cells print: loss, accuracy, lr… a chart a metric, live">
          Metrics
        </button>
        <button type="button" className={`btn sm ghost${side === 'files' ? ' is-on' : ''}`} aria-pressed={side === 'files'} onClick={() => (side === 'files' ? closeSide() : setSide('files'))} title="What is on the runtime's disk">
          Files
        </button>
        <input ref={filePick} type="file" accept=".ipynb,application/x-ipynb+json,application/json" hidden onChange={(event) => void addFromFile(event.target.files?.[0]).then(() => (event.target.value = ''))} />
      </div>
      {askBar ? (
        <div className="explain-ask nb-ask">
          <div className="ask-column">
          <form
            className={`ask-field${asking ? ' is-busy' : ''}${askFocused ? ' is-focused' : ''}${!canAsk ? ' is-off' : ''}`}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <SparkleIcon size={16} />
            {selectedIndex >= 0 ? (
              <span className="ask-chip" title={`About cell ${selectedIndex + 1}: a new cell goes after it, a change is to it`}>
                cell {selectedIndex + 1}
                <button type="button" aria-label="Not about this cell" onClick={() => setSelected(null)}>
                  ×
                </button>
              </span>
            ) : null}
            {quote ? (
              <span className="ask-chip quote" title={quote}>
                “{quote.length > 42 ? `${quote.slice(0, 42)}…` : quote}”
                <button type="button" aria-label="Not about this passage" onClick={() => setQuote(undefined)}>
                  ×
                </button>
              </span>
            ) : null}
            <input
              ref={askRef}
              value={ask}
              disabled={!canAsk}
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
                if (event.key === 'Escape') event.currentTarget.blur();
                event.stopPropagation();
              }}
              placeholder={
                !assistant.keys[modelSpec(model).provider]
                  ? `Ask ${writer} to write or change cells here, once its key is in Settings`
                  : selectedIndex >= 0
                    ? `Ask ${writer} to write a cell after cell ${selectedIndex + 1}, or to change it…`
                    : `Ask ${writer} to write code from the paper, change a cell, or fix one…`
              }
              aria-label="Ask for a cell, or a change to one"
            />
            {asking ? (
              <button type="button" className="btn sm" onClick={stopNotebookAsk}>
                Stop
              </button>
            ) : (
              <button type="submit" className="btn sm primary" disabled={!canAsk || !ask.trim()}>
                Ask
              </button>
            )}
            <button type="button" className="icon-btn sm nb-ask-hide" onClick={() => showAskBar(false)} aria-label="Hide the ask bar" title="Hide the ask bar — Ask in the toolbar brings it back">
              <CloseIcon size={13} />
            </button>
          </form>
          {nbAsk.pending && !nbAsk.pending.error ? (
            <div className="ask-status is-live">
              <span className="spinner" />
              <span className="ask-note" title={thought || undefined}>
                {nbAsk.pending.progress ? `Rewriting ${nbAsk.pending.progress.label} — ${nbAsk.pending.progress.done} of ${nbAsk.pending.progress.total} done` : nbAsk.pending.reply ? 'Writing the cells' : thought ? `Thinking — ${thought}` : 'Reading the notebook and the paper'} — <em>{nbAsk.pending.request}</em>
              </span>
            </div>
          ) : nbAsk.pending?.error ? (
            <div className="ask-status is-error">
              <span className="ask-note">{nbAsk.pending.error}</span>
              <button type="button" className="btn sm ghost" onClick={() => dismissNotebookAsk(paperId)}>
                Dismiss
              </button>
            </div>
          ) : askFocused && !ask && canAsk && !justAsked ? (
            <div className="ask-suggestions">
              {(selectedIndex >= 0
                ? [
                    `Rewrite cell ${selectedIndex + 1} in PyTorch, on the GPU`,
                    `Explain what cell ${selectedIndex + 1} does in a text cell above it`,
                    `Make cell ${selectedIndex + 1} print a check that it is right`,
                    `Split cell ${selectedIndex + 1} into smaller steps`,
                    `Fix the error in cell ${selectedIndex + 1}`,
                  ]
                : [
                    "Write the paper's core method as a runnable cell",
                    'Rewrite the whole notebook from scratch, in PyTorch, with a small training run',
                    'Write a cell that trains a small version on a toy dataset',
                    'Add a cell that plots the loss curve',
                    'Reproduce the main table on a tiny scale',
                    'Rewrite the code in JAX',
                    'Add a cell that times a forward pass on this GPU',
                  ]
              ).map((suggestion) => (
                <button key={suggestion} type="button" className="ask-suggestion" onMouseDown={(event) => event.preventDefault()} onClick={() => void submit(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          ) : nbAsk.last ? (
            <div className="ask-status is-done">
              <span className="check">✓</span>
              <span className="ask-note">
                {nbAsk.last.note || `Done: ${nbAsk.last.request}`}
                {nbAsk.last.touched.length ? ` · ${nbAsk.last.touched.length} ${nbAsk.last.touched.length === 1 ? 'cell' : 'cells'}` : ''}
              </span>
              {nbAsk.last.touched.some((id) => cells.find((cell) => cell.id === id)?.type === 'code') ? (
                <button type="button" className="btn sm ghost" disabled={!available || busy} onClick={runFresh} title="Run the cells it wrote, in order">
                  Run them
                </button>
              ) : null}
              {nbAsk.last.touched.length ? (
                <button type="button" className="btn sm ghost" onClick={() => undoNotebookReply(paperId)} title={`Put the cells back as they were before “${nbAsk.last.request}”`}>
                  Undo
                </button>
              ) : null}
            </div>
          ) : null}
          </div>
        </div>
      ) : null}
      {note || push.state === 'pushed' || push.state === 'error' ? (
        <div className={`nb-note${push.state === 'error' ? ' is-problem' : ''}`} role="status">
          {note ??
            (push.state === 'pushed' ? (
              <>
                Committed.{' '}
                <a href={push.url} target="_blank" rel="noreferrer noopener">
                  Open it in Colab ↗
                </a>
              </>
            ) : push.state === 'error' ? (
              push.message
            ) : null)}
        </div>
      ) : null}
      {card ? (
        <div className="nb-card">
          <ConnectCard
            onClose={() => setCard(null)}
            busy={colab.status === 'connecting'}
            onConnect={(machine) => {
              void connectColab(machine)
                .then(() => {
                  setCard(null);
                  card.then();
                })
                .catch(() => undefined);
            }}
          />
        </div>
      ) : null}
      <div className={`nb-split${side ? ' has-side' : ''}`}>
        <div className="nb-cells" onMouseDown={(event) => (event.target === event.currentTarget ? setSelected(null) : undefined)}>
          {!nb ? (
            <p className="nb-loading">
              <span className="spinner" /> Opening the notebook…
            </p>
          ) : (
            cells.map((cell, index) => (
              <Cell
                key={cell.id}
                paperId={paperId}
                cell={cell}
                index={index}
                selected={selected === cell.id}
                editing={editing === cell.id}
                run={colab.runs[runKey(cell.id)]}
                canRun={available}
                busy={busy}
                onSelect={() => setSelected(cell.id)}
                onEdit={(on) => setEditing((current) => (on ? cell.id : current === cell.id ? null : current))}
                onRun={(then) => runOne(cell, then)}
                onAsk={canAsk ? (request, cellQuote) => void submit(request, { cell: index + 1, quote: cellQuote }) : undefined}
                lit={shown === cell.id}
              />
            ))
          )}
          <button type="button" className="nb-add" onClick={() => setSelected(insertCell(paperId, null, 'below'))}>
            + Code
          </button>
          <p className="nb-hint">
            Every cell is yours to edit: click into the code and type, or double-click a text cell. Shift-Enter runs a cell and moves on; Alt-Enter runs and adds one. With a cell picked and nothing being typed: <kbd>A</kbd> and <kbd>B</kbd> add above and below, <kbd>M</kbd> and <kbd>Y</kbd> make it text or code, <kbd>D D</kbd> deletes, <kbd>↑</kbd> <kbd>↓</kbd> move. The cells share the kernel with the Explanation and
            Implementation pages; the runtime's menu is the chip in the bar. Kept in this browser{nb ? `, last changed ${time(nb.updated)}` : ''}.
          </p>
        </div>
        {side ? (
          <aside className="nb-side" aria-label={side === 'runtime' ? 'The runtime' : side === 'metrics' ? 'Training metrics' : 'Files on the runtime'}>
            <div className="nb-side-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={side === 'runtime'} onClick={() => setSide('runtime')}>
                Runtime
              </button>
              <button type="button" role="tab" aria-selected={side === 'metrics'} onClick={() => setSide('metrics')}>
                Metrics
              </button>
              <button type="button" role="tab" aria-selected={side === 'files'} onClick={() => setSide('files')}>
                Files
              </button>
              <span className="spacer" />
              <button type="button" className="icon-btn sm" onClick={closeSide} aria-label="Close the pane">
                <CloseIcon size={14} />
              </button>
            </div>
            {side === 'runtime' ? (
              <RuntimePane cells={codeCells} compute={compute} onGoTo={goTo} onRunAll={available ? runEverything : undefined} picked={selectedIndex >= 0 && cells[selectedIndex]?.type === 'code' && available && !busy ? { label: `cell ${selectedIndex + 1}`, run: () => runOne(cells[selectedIndex], 'stay') } : undefined} />
            ) : side === 'metrics' ? (
              <MetricsPane cells={metricCells} running={colab.running} onGoTo={goTo} colabUrl={colab.runtime ? attachUrl(colab.runtime.endpoint) : undefined} />
            ) : (
              <FilesPane />
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/** A small menu in the toolbar. */
function NbMenu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [open]);
  return (
    <div className="menu-wrap" ref={box}>
      <button type="button" className="btn sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label} ▾
      </button>
      {open ? (
        <div className="menu nb-menu" role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

