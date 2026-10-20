// One playground, at /playground/<id>: its notebook, or its files with an
// editor and a console, on the machine it is bound to. The bar says where
// the kernel is and opens the machine's menu; the pane on the right is the
// sync (when the files live somewhere other than the machine), the runtime's
// meters and the metrics the runs print — the same panes the paper's
// notebook has. The store is src/lib/playground.ts.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Backend, JupyterServer } from '../lib/colab';
import { renewRuntimeProxy } from '../lib/colab';
import { COMPUTE_SHELL, MOUNT_VERSION, colabTarget, linkCompute, linkState, mountThroughCompanion, mountWords, pushThroughCompanion, remoteLine, renewAt, serverTarget, unmountThroughCompanion, type LinkState } from '../lib/computeLink';
import { backendLabel, shutDownScope, chooseBackend, colabAvailable, colabNow, connect, connectIn, forgetRun, interrupt, joinIfRunning, interruptIn, lastActivityAt, lastActivityIn, machineLabel, outputText, prepareNotebook, restartKernel, runCell, runCellFor, runQuietly, sessionsNow, setMachine, stopRuntime, stopRuntimeIn } from '../lib/colab';
import { KOIOS_HELPER_PATH, KOIOS_PY, KOIOS_PYLIB } from '../lib/koiosHelper';
import { latestCheckpoint } from '../lib/telemetry';
import type { Checkpoint } from '../lib/telemetry';
import type { Machine } from '../lib/colab';
import { notebookFor, runKey, subscribeNotebook } from '../lib/notebook';
import type { ConsoleEntry, FileHost, FilesHome, Playground, ProjectMachine, SyncReport } from '../lib/playground';
import { OPEN_PLAYGROUND, backendOfPlayground, blankCells, filesAreOnMachine, homeHost, pullEdits, homeLabelOf, machineHostFor, machinesOf, moveFilesOutOfBrowser, poolEnv, runLogPath, useDriveConnected, machineHost, machineRoot, markFolder, notebookKey, pullBack, pushFolder, readMeta, writeMeta, secureCompanions, serverById, shellCell, syncRules, unionHost, takeSeed, updatePlayground, useServers, vscodeLink } from '../lib/playground';
import { COMPANION_VERSION, STARTABLE, companionPort, companionTools, findCompanion, isNewer, isSecure, shutdownCompanion, startCompanion, updateCompanion, vscodeFolder, vscodeWeb, waitForVersion } from '../lib/companion';
import type { VsCodeWeb } from '../lib/companion';
import { shellWord, AGENT_KEYS, AGENTS, agentCommand, saveAgentOptions, savedAgentOptions } from '../lib/agents';
import type { AgentOptions, AgentSpec } from '../lib/agents';
import { ASSUMED_TOOLS, runPlan } from '../lib/languages';
import type { MachineTools } from '../lib/languages';
import type { RuntimeEntry } from '../lib/colab';
import { useStore } from '../lib/store';
import { openedPlayground } from '../lib/playgroundRuns';
import type { Screen } from '../lib/assistant';
import { CellRunOutput, ColabMark, ConnectCard, MachinePicker, attachUrl, useColab } from './Colab';
import MetricsPane from './MetricsPane';
import NotebookPage from './Notebook';
import type { NbSide } from './Notebook';
import RuntimePane from './RuntimePane';
import Gutter, { DEFAULT_LAYOUT, TREE_FOLD, loadLayout, readLayout, saveLayout } from './Gutter';
import type { PaneLayout } from './Gutter';
import Terminal, { forgetTerminal, hasTerminals, shareTerminals, typeInTerminal } from './Terminal';
import { WhereDialog } from './Playground';
import VsCodeExtension, { VsCodeMark, isCompanion } from './VsCodeExtension';
import { attachFolder, attachedWords, detach, listAttached } from '../lib/shares';
import type { Attachment, Backends } from '../lib/shares';
import { ArrowLeftIcon, ChartIcon, CloseIcon, DriveMark, PlusIcon, SearchIcon, SparkleIcon } from './icons';
import FileIcon, { languageOf } from './FileIcon';
import ProjectAgent from './ProjectAgent';
import CliAgent, { queueCliRequest } from './CliAgent';
import TensorBoardPane from './TensorBoardPane';
import SimPane from './SimPane';
import ExplainerPane from './ExplainerPane';
import ExperimentFiler from './ExperimentFiler';
import { CATALOGUE_FILE, KOIOS_TELEMETRY_PY, TELEMETRY_FILE } from '../lib/simProject';
import { catalogueJson } from '../lib/simulators';
import KernelTerminal, { closeKernelTerminal } from './KernelTerminal';
import MachinePool, { MachineMark, isConnected, sessionOf, useSessions } from './MachinePool';
import CodeEditor from './CodeEditor';
import type { CodeEditorHandle, Cursor, EditorPeer } from './CodeEditor';
import { noteEdit, reportPlace, useJumps, usePeers } from '../lib/liveRoom';
import { ContextMenu, FolderPlusGlyph, keyLabel, OpenEditors, OutlineGlyph, OutlineView, PaletteGlyph, QuickPick, SplitGlyph, SymbolMark } from './Workbench';
import { symbolPath, symbolsOf } from '../lib/editing';
import { clearAgentChat } from '../lib/projectAgent';
import { agentChatFor, cliWriteRequest, lineDelta, listAll, loadAgentChats, PLAN_FILE, planMarkdown, resumeAgentJob, savedJob, subscribeAgent } from '../lib/projectAgent';
import { implementationFor, loadImplementation, subscribeImplement } from '../lib/implement';
import { currentDbName, subscribeDb } from '../lib/db';
import { useEnsureProject } from '../lib/implementationProject';
import { ensurePaperContext, PAPER_FILES_NOTE, PAPER_TEXT_FILE, paperContextSummary } from '../lib/paperContext';
import { DATA_NOTE, dataConfigPath, dataFolderNameOf, dataHost, dataModulePath, dataPlaceOf, dataSetup, ensureDataLink, forgetDataLink, KOIOS_DATA_PY, OFFER_FREE_BYTES, renewDataLink, type DataLink } from '../lib/dataStore';
import { companionDisk } from '../lib/moves';
import { mayStopIdle } from '../lib/idleWork';
import { offerProject, readProjectFiles } from '../lib/projectScreen';
import { projectsOf } from '../lib/projects';
import ProjectStart from './ProjectStart';
import StoragePanel, { MoveProgress, useMove } from './StoragePanel';
import { AwayCard, BringDialog, SnapshotView, useSnapshots } from './PlaygroundAway';
import { computerOf, useReach } from '../lib/away';
import type { AgentChange, AgentRun, ProjectView } from '../lib/projectAgent';

type Tab = 'notebook' | 'files' | 'explain';
/** What the side bar shows, picked in the activity bar; null when it is folded away. */
type Primary = 'explorer' | 'search' | 'outline' | 'sync' | null;
/** The right-hand pane's tabs: the agent, and the machine's numbers as a run goes. */
type RightTab = 'agent' | 'runtime' | 'metrics' | 'tensorboard' | 'sim';
const RIGHT_TABS: { id: RightTab; label: string; title: string }[] = [
  { id: 'agent', label: 'Agent', title: 'Claude Code, Codex, or the page’s own agent' },
  { id: 'runtime', label: 'Runtime', title: 'The machine: GPU, memory, disk, live' },
  { id: 'metrics', label: 'Metrics', title: 'The numbers the runs print: loss, accuracy' },
  { id: 'tensorboard', label: 'TensorBoard', title: 'The scalars your runs log for TensorBoard' },
  { id: 'sim', label: 'Sim', title: 'Simulation runs: episodes, videos, world-model dreams, notes, what looks wrong' },
];
/** Which agent the pane shows: Claude Code or Codex on the machine, the page's own, or the terminal agents of a Companion. */
type AgentMode = 'claude' | 'codex' | 'reader' | 'cli';

/** One editor group: its tabs (by `where:path`) and the one shown. */
interface EditorGroupState {
  tabs: string[];
  active: string | null;
}

/** The editor's settings, kept in this browser for every project. */
interface EditorSettings {
  fontSize: number;
  minimap: boolean;
  autoSave: boolean;
}
const DEFAULT_EDITOR: EditorSettings = { fontSize: 13, minimap: true, autoSave: false };

/** A menu opened with a right click: where, and what is in it. */
interface MenuItem {
  label: string;
  keys?: string;
  run?: () => void;
  disabled?: boolean;
  danger?: boolean;
}
interface MenuState {
  x: number;
  y: number;
  items: (MenuItem | 'sep')[];
}

/** A command, as the palette lists it. */
export interface WorkbenchCommand {
  id: string;
  label: string;
  keys?: string;
  run: () => void;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const readLocal = <T,>(name: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(name);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const writeLocal = (name: string, value: unknown) => {
  try {
    localStorage.setItem(name, JSON.stringify(value));
  } catch {
    // private mode: the layout starts over next time
  }
};

const FilesGlyph = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7z" />
    <path d="M14 3v4h4M9 21h9a2 2 0 0 0 2-2V9" />
  </svg>
);
const SyncGlyph = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 9a8 8 0 0 1 14.5-3.5L20 7M20 3v4h-4M20 15a8 8 0 0 1-14.5 3.5L4 17M4 21v-4h4" />
  </svg>
);
const TbGlyph = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 20h18M4 16l4.5-6 4 3.5L20 5" />
    <circle cx="20" cy="5" r="1.2" fill="currentColor" />
  </svg>
);
const SimGlyph = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="13" rx="2" />
    <circle cx="9" cy="10.5" r="2.2" />
    <path d="M13 13.5l2.5-3 3 4M8 21h8" />
  </svg>
);
const GaugeGlyph = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
    <path d="M4 18a8 8 0 1 1 16 0" />
    <path d="m12 18 4-6" />
  </svg>
);

const clock = (since: number | undefined, now: number) => {
  if (!since) return '';
  const s = Math.max(0, Math.round((now - since) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};

const consoleKey = (playgroundId: string, entryId: string) => `pgsh:${playgroundId}:${entryId}`;
/** A console command's run key on one pool member: the entry's key, the member's id after an `@` (the first machine keeps the plain key). */
const memberKey = (key: string, member: string | null) => (member ? `${key}@${member}` : key);
/** The runs a console entry has: one on the project's first machine, or one a machine when it was run on a member or on all. */
const entryRuns = (playgroundId: string, machines: ProjectMachine[], entry: ConsoleEntry): { key: string; machine: ProjectMachine }[] => {
  const key = consoleKey(playgroundId, entry.id);
  const on = entry.machine === 'all' ? machines : entry.machine ? machines.filter((m) => m.member === entry.machine) : machines.slice(0, 1);
  return (on.length ? on : machines.slice(0, 1)).map((machine) => ({ key: memberKey(key, machine.member), machine }));
};
/** Which machine a terminal tab is on: the member's id after an `@` in its id; the first machine otherwise. */
const shellMember = (id: string): string | null => (id.includes('@') ? id.slice(id.lastIndexOf('@') + 1) : null);
/** A terminal tab on the project's compute, reached from the files' computer (`koios shell`), rather than a shell there. */
const COMPUTE_TAB = '!compute';
const isComputeTab = (id: string) => id.endsWith(COMPUTE_TAB);
const uid = () => Math.random().toString(36).slice(2, 10);

/** The backend a playground's compute names, when it can be had: its Colab machine, or a server that is still in the list. */
const backendOf = (playground: Playground): Backend | null => backendOfPlayground(playground);

/** `backLabel` names where Back goes when the workspace is opened somewhere other than the Playground — a paper's Explain page. */
/** By playground: what the idle stop does before it stops a Colab runtime — the files view's Bring back, while the results are copied rather than mounted. */
const beforeIdleStop = new Map<string, () => Promise<void>>();
/** Where a project's runs are kept, beside the machine: the data place (runs go there as they go) and the project's own folder (where runs from before were brought back), read as one. */
function keptRunsHost(playground: Playground, home: FileHost): FileHost | undefined {
  const own = playground.home.kind === 'machine' ? null : home;
  const data = dataHost(playground);
  if (data && own) return unionHost(data, own);
  return data ?? own ?? undefined;
}

/** A project's terminal tabs and the server terminal each is, for every browser (in the project's .reader/). */
const TERMINALS_FILE = 'terminals.json';

/** By playground: a file the Explain page asked to open, opened by the files view when it shows. */
const openFromExplain = new Map<string, string>();
const OPEN_FROM_EXPLAIN = 'reader:open-from-explain';

/**
 * One of the workspace's views (Notebook, Files, Explain), kept once it has been opened: hidden, not unmounted, when
 * another is chosen — the files open, the terminals, the panes, the runs read, all as they were on coming back.
 */
function KeepView({ show, children }: { show: boolean; children: React.ReactNode }) {
  const [seen, setSeen] = useState(show);
  useEffect(() => {
    if (show) setSeen(true);
  }, [show]);
  if (!seen && !show) return null;
  return (
    <div className="pg-keep" hidden={!show}>
      {children}
    </div>
  );
}

export default function PlaygroundWorkspace({ playground, onBack, onOpenPaper, backLabel }: { playground: Playground; onBack: () => void; onOpenPaper: (id: string) => void; backLabel?: string }) {
  const colab = useColab();
  const { papers, settings } = useStore();
  const servers = useServers();
  const [tab, setTab] = useState<Tab>(playground.kind === 'project' ? 'files' : 'notebook');
  const [side, setSide] = useState<NbSide>(null);
  const [title, setTitle] = useState(playground.title);
  const [changing, setChanging] = useState(false);
  const [storage, setStorage] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** The pool row shown with Add a machine out, from the chip's menu, before the project has a pool. */
  const [poolOpen, setPoolOpen] = useState(false);
  const backend = backendOf(playground);
  const machineName = backend
    ? backendLabel(backend, colab.backend.kind === backend.kind ? colab.runtime : undefined)
    : playground.compute.kind === 'server' && playground.compute.name
      ? `${playground.compute.name}, not connected here`
      : 'a computer not connected here';
  // Where the code is, when it is on one computer: here, or away — and what the reader chose to see of that.
  const [reach, retryReach] = useReach(playground);
  const away = reach.state === 'down' || reach.state === 'unknown' ? reach : null;
  const shows = settings.awayShows;
  const driveOn = useDriveConnected();
  const [snapView, setSnapView] = useState(false);
  const [bringing, setBringing] = useState(false);
  useSnapshots(playground, shows.snapshot && reach.state === 'here' && playground.home.kind === 'server' && driveOn);

  // This page is open: the dock and the toasts leave its own runs to it.
  useEffect(() => openedPlayground(playground.id), [playground.id]);
  // The kernel follows the playground: its own kernel, on its machine, comes to the foreground — the one this tab
  // already has for it, if it has one. Whatever another playground is running goes on in its own, behind.
  useEffect(() => {
    if (!backend) return;
    chooseBackend(backend, playground.id);
    if (playground.compute.kind === 'colab') setMachine(playground.compute.machine);
    // Still running — after a reload (the site updated), or from another browser of the account's: joined, so what
    // runs there (cells, commands, terminals, agents) is seen and followed, never left looking stopped. Never a new machine.
    let open = true;
    void joinIfRunning(playground.id).then(({ state, by }) => {
      if (!open) return;
      if (state === 'needs-click') setNote(`This project's Colab runtime is still running${by ? ` (last used in ${by})` : ''}. Connect from the chip to join it — what runs there carries on; nothing is restarted.`);
    });
    return () => {
      open = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playground.id, playground.compute.kind === 'server' ? playground.compute.serverId : playground.compute.shared ? 'colab-shared' : 'colab', playground.compute.kind === 'colab' ? playground.compute.machine.accelerator : '', backend?.kind === 'jupyter' ? backend.server.url + backend.server.token : '']);

  // A Companion paired over plain http moves to its https address once this computer trusts its certificate.
  useEffect(() => {
    void secureCompanions();
  }, []);

  useEffect(() => {
    document.title = `${playground.title} · Playground · Koios`;
  }, [playground.title]);
  // Off the playground, the paper pages' cells run in their own Colab kernel again, as their buttons say. This
  // playground's kernel stays connected behind, running or idle, and comes back to the front when it opens again.
  useEffect(
    () => () => {
      chooseBackend({ kind: 'colab' });
    },
    [],
  );

  // On Colab: the runtime stopped after the idle time asked for, while the tab is open — a forgotten GPU is units spent.
  // Every Colab machine of the project: its first, and each pool member's, by its own session.
  useEffect(() => {
    if (!playground.idleStopMin) return;
    const colabMachines = machinesOf(playground).filter((m) => m.compute.kind === 'colab');
    if (!colabMachines.length) return;
    const check = window.setInterval(() => {
      for (const machine of colabMachines) {
        const first = machine.member === null;
        const state = first ? colabNow() : sessionOf(sessionsNow(), machine.scope);
        const since = first ? lastActivityAt() : lastActivityIn(machine.scope);
        if (state?.status !== 'idle' || since === undefined) continue;
        // The kernel idle that long: the machine asked too — a training in the terminal, or an agent, keeps it.
        void mayStopIdle(first ? '' : machine.scope, since, playground.idleStopMin * 60_000).then(async (stop) => {
          if (!stop) return;
          // Copied, not mounted: the run's results (videos too) come home first — the runtime's disk goes with it.
          const bringBack = beforeIdleStop.get(playground.id);
          if (first && bringBack) await bringBack().catch(() => undefined);
          void (first ? stopRuntime() : stopRuntimeIn(machine.scope));
          setNote(`The Colab runtime${first ? '' : ` of machine ${machine.rank}`} was stopped after ${playground.idleStopMin} minutes with nothing running on it — no cell, no command in a terminal, no agent, the GPU unused — as this playground asks. The next Run starts a new one. Storage & compute changes the time, or turns this off.`);
        });
      }
    }, 30_000);
    return () => window.clearInterval(check);
  }, [playground.compute, playground.pool, playground.idleStopMin]);

  const cited = playground.cites.map((cite) => papers.find((paper) => paper.id === cite.paperId) ?? null);
  const screen = useCallback(async (): Promise<Screen> => {
    const paper = cited.find(Boolean);
    return {
      where: `In the Playground — “${playground.title}”, running on ${machineName}`,
      paper: paper ? { id: paper.id, title: paper.title, authors: paper.authors, published: paper.published, arxivId: paper.arxivId, doi: paper.doi, abstract: paper.abstract } : undefined,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playground.title, machineName, cited.map((p) => p?.id).join()]);

  const nbKey = notebookKey(playground.id);
  const seed = useCallback(() => takeSeed(playground.id) ?? blankCells(playground.title), [playground.id, playground.title]);
  const connected = colab.status === 'idle' || colab.status === 'busy';
  // The project's own folder, for the Explain page.
  const explainHost = useMemo(() => homeHost(playground), [playground, servers]);
  const explainKept = useMemo(() => keptRunsHost(playground, explainHost), [playground, explainHost]);
  const usable = Boolean(backend) && colabAvailable(settings.googleClientId);
  // A move of the files under way, from any browser: followed from here, and finished here when it is done.
  const { move, problem: moveProblem } = useMove(playground, connected);

  const vscode = vscodeLink(playground);
  const homeServer = playground.home.kind === 'server' ? serverById(playground.home.serverId) : undefined;
  // The folder says which playground it is, for VS Code's Reader extension; once per opening is enough.
  useEffect(() => {
    if (playground.home.kind !== 'server') return;
    void markFolder(playground, `${window.location.origin}${import.meta.env.BASE_URL}`).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playground.id, playground.title, playground.cites.length, playground.home.kind === 'server' ? playground.home.serverId : '']);

  return (
    <main className="main pg-page pg-work">
      <header className="pg-bar">
        <button type="button" className="btn sm ghost" onClick={onBack} title={backLabel ? `Back to the ${backLabel} page` : "The Playground's home"}>
          <ArrowLeftIcon size={15} /> {backLabel ?? 'Playground'}
        </button>
        <input
          className="pg-name"
          value={title}
          aria-label="The playground's name"
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => title.trim() && title.trim() !== playground.title && updatePlayground(playground.id, { title: title.trim() })}
          onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
        />
        <div className="segmented" role="tablist" aria-label="Show">
          <button type="button" role="tab" aria-selected={tab === 'notebook'} aria-pressed={tab === 'notebook'} onClick={() => setTab('notebook')}>
            Notebook
          </button>
          <button type="button" role="tab" aria-selected={tab === 'files'} aria-pressed={tab === 'files'} onClick={() => setTab('files')}>
            Files
          </button>
          <button type="button" role="tab" aria-selected={tab === 'explain'} aria-pressed={tab === 'explain'} onClick={() => setTab('explain')} title="An illustrated account of the project: how the code works, what was done with it, what the runs show">
            Explain
          </button>
        </div>
        {playground.cites.length ? (
          <span className="pg-cites">
            {playground.cites.map((cite) => (
              <button key={cite.paperId} type="button" className="pg-cite" onClick={() => onOpenPaper(cite.paperId)} title="Open the paper" disabled={!papers.some((p) => p.id === cite.paperId)}>
                ¶ {cite.title.length > 42 ? `${cite.title.slice(0, 42)}…` : cite.title}
              </button>
            ))}
          </span>
        ) : null}
        <span className="spacer" />
        {vscode ? (
          <a className="btn sm ghost" href={vscode} title="Open this project's folder in VS Code (the Koios extension adds the papers, the machine and Open on the site)">
            <VsCodeMark /> Open in VS Code
          </a>
        ) : null}
        {vscode && homeServer ? <VsCodeExtension server={homeServer} compact /> : null}
        {shows.bring && computerOf(playground) && reach.state === 'here' ? (
          <button type="button" className="btn sm ghost" onClick={() => setBringing(true)} title={`Its code is on ${computerOf(playground)} only: copy it, or move it to Drive so every computer opens it`}>
            Open everywhere…
          </button>
        ) : null}
        <button type="button" className={`btn sm ghost${storage ? ' is-on' : ''}`} onClick={() => setStorage(true)} title="Where the files are kept and where the code runs: move the files, or change the machine">
          Storage & compute
        </button>
        <MachineChip playground={playground} name={machineName} usable={usable} onChange={() => setChanging(true)} onPool={() => setPoolOpen(true)} onNote={setNote} />
        {tab === 'notebook' ? (
          <>
            <button type="button" className={`btn sm ghost${side === 'runtime' ? ' is-on' : ''}`} aria-pressed={side === 'runtime'} onClick={() => setSide(side === 'runtime' ? null : 'runtime')}>
              Runtime
            </button>
            <button type="button" className={`btn sm ghost${side === 'metrics' ? ' is-on' : ''}`} aria-pressed={side === 'metrics'} onClick={() => setSide(side === 'metrics' ? null : 'metrics')}>
              Metrics
            </button>
          </>
        ) : null}
      </header>
      {!backend && away && shows.card && tab === 'files' ? null : !backend ? (
        <div className="pg-banner is-problem">
          This playground runs on {playground.compute.kind === 'server' && playground.compute.name ? playground.compute.name : 'a computer'}, which isn’t connected to this browser.{' '}
          <button type="button" className="link" onClick={() => setChanging(true)}>
            Choose where it runs
          </button>
        </div>
      ) : !usable ? (
        <div className="pg-banner is-problem">Colab needs Settings → Google (a client ID) and Settings → Paper proxy before cells can run — or choose a Jupyter server of yours from the machine menu.</div>
      ) : colab.error && colab.status !== 'connecting' ? (
        <div className="pg-banner is-problem">{colab.error}</div>
      ) : colab.sharing && colab.scope === playground.id ? (
        <div className="pg-banner">{colab.sharing}</div>
      ) : null}
      {playground.moving ? <MoveProgress playground={playground} move={move} problem={moveProblem} compact onShow={() => setStorage(true)} /> : null}
      {storage ? <StoragePanel playground={playground} machineName={machineName} connected={connected} move={move} problem={moveProblem} onConnect={() => void connect().catch(() => undefined)} onClose={() => setStorage(false)} onNote={setNote} /> : null}
      {note ? (
        <div className="pg-banner">
          {note}
          <button type="button" className="icon-btn sm" aria-label="Dismiss" onClick={() => setNote(null)}>
            <CloseIcon size={13} />
          </button>
        </div>
      ) : null}
      {playground.home.kind === 'browser' && playground.kind === 'project' ? <MoveOutOfBrowser playground={playground} machineName={machineName} onNote={setNote} /> : null}
      <MachinePool playground={playground} usable={usable} open={poolOpen} onOpen={setPoolOpen} onNote={setNote} />
      <div className="pg-body">
        <KeepView show={tab === 'explain'}>
          <ExplainerPane
            title={playground.title}
            projectId={playground.id}
            host={explainHost}
            where={`Files in ${explainHost.label} · runs on ${machineName}${connected ? '' : ' (not connected)'}`}
            place={{ machineFolder: connected ? machineRoot(playground) : null, kept: explainKept }}
            consoleLines={playground.console.map((entry) => entry.command)}
            metricTexts={playground.console.flatMap((entry) => {
              const run = colab.runs[consoleKey(playground.id, entry.id)];
              return run ? [{ label: `$ ${entry.command.slice(0, 32)}${entry.command.length > 32 ? '…' : ''}`, text: run.outputs.map((o) => ('text' in o ? o.text : '')).join('') }] : [];
            })}
            onOpen={(path) => {
              openFromExplain.set(playground.id, path);
              window.dispatchEvent(new CustomEvent(OPEN_FROM_EXPLAIN, { detail: { id: playground.id } }));
              setTab('files');
            }}
          />
        </KeepView>
        <KeepView show={tab === 'notebook'}>
          <div className="pg-notebook">
            <NotebookPage paperId={nbKey} title={playground.title} screen={screen} side={side} onSide={setSide} sections={[]} playground={{ hasPaper: cited.some(Boolean), seed }} />
          </div>
        </KeepView>
        <KeepView show={tab === 'files'}>
        {snapView && shows.snapshot ? (
          <SnapshotView playground={playground} reach={reach} onBring={shows.bring ? () => setBringing(true) : undefined} onBack={() => setSnapView(false)} />
        ) : away && shows.card ? (
          <AwayCard
            playground={playground}
            reach={away}
            onSnapshot={() => setSnapView(true)}
            onBring={() => setBringing(true)}
            onRetry={retryReach}
            onConnect={onBack}
            onNotebook={() => setTab('notebook')}
          />
        ) : (
          <FilesView key={JSON.stringify(playground.home)} playground={playground} connected={connected} usable={usable} machineName={machineName} />
        )}
        </KeepView>
      </div>
      {bringing ? <BringDialog playground={playground} reach={reach} onClose={() => setBringing(false)} onOpen={(id) => window.dispatchEvent(new CustomEvent(OPEN_PLAYGROUND, { detail: { id } }))} /> : null}
      {changing ? (
        <WhereDialog
          draft={{ title: playground.title, kind: playground.kind }}
          current={{ compute: playground.compute, home: playground.home, idleStopMin: playground.idleStopMin }}
          onClose={() => setChanging(false)}
          onCreate={(spec) => {
            const movedFiles = JSON.stringify(spec.home) !== JSON.stringify(playground.home);
            // Off a Colab machine of its own: that machine is stopped (when nothing runs on it), not left to use units until Colab's idle limit.
            const ownColab = (c: Playground['compute']) => c.kind === 'colab' && !c.shared;
            if (ownColab(playground.compute) && !ownColab(spec.compute)) void shutDownScope(playground.id);
            updatePlayground(playground.id, { compute: spec.compute, home: spec.home.kind === 'server' && !spec.home.root ? { ...spec.home, root: playground.home.kind === 'server' ? playground.home.root : `playgrounds/${playground.id}` } : spec.home, idleStopMin: spec.idleStopMin });
            setChanging(false);
            setNote(movedFiles ? 'The project now looks for its files in the new place; the ones in the old place stay there. To have the machines move them across for you, use Storage & compute instead.' : `Cells now run on ${spec.compute.kind === 'colab' ? 'your Colab' : serverById(spec.compute.serverId)?.name}. The kernel there starts fresh: re-run the cells that set things up.`);
          }}
        />
      ) : null}
    </main>
  );
}

/** The chip in the bar: where the kernel is, how it is, and its menu — connect, interrupt, change, shut down; and for a Companion on this computer, shut it down and start it again. */
function MachineChip({ playground, name, usable, onChange, onPool, onNote }: { playground: Playground; name: string; usable: boolean; onChange: () => void; /** Opens the pool row with Add a machine: more machines for the project, one job each. */ onPool: () => void; onNote: (note: string | null) => void }) {
  const colab = useColab();
  const [open, setOpen] = useState(false);
  const server = playground.compute.kind === 'server' ? serverById(playground.compute.serverId) : undefined;
  // A Companion on this computer: the page can shut it down, and start it again (a tunnel's address changes each start).
  const companion = server && server.where === 'pc' && isCompanion(server) && companionPort(server.url) !== null ? server : undefined;
  const [power, setPower] = useState<'unknown' | 'up' | 'down' | 'stopping' | 'starting'>('unknown');
  const [now, setNow] = useState(Date.now());
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!colab.startedAt) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [colab.startedAt]);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => !box.current?.contains(event.target as Node) && setOpen(false);
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [open]);
  const connected = colab.status === 'idle' || colab.status === 'busy';
  const onColab = playground.compute.kind === 'colab';
  const colabMachine: Machine = playground.compute.kind === 'colab' ? playground.compute.machine : colab.machine;
  const [changingMachine, setChangingMachine] = useState(false);
  useEffect(() => {
    if (!open) setChangingMachine(false);
  }, [open]);
  /** The machine picked here becomes the playground's own, so it opens on it next time and in other browsers. */
  const pickMachine = (machine: Machine) => {
    setMachine(machine);
    if (playground.compute.kind === 'colab') updatePlayground(playground.id, { compute: { kind: 'colab', machine } });
  };
  // Whether the Companion answers, looked at when the menu opens and it isn't connected.
  useEffect(() => {
    if (!open || !companion || connected || power === 'stopping' || power === 'starting') return;
    let live = true;
    void findCompanion(companion.url, 2500).then((info) => live && setPower(info ? 'up' : 'down'));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, companion?.url, connected]);
  useEffect(() => {
    if (connected) setPower('up');
  }, [connected]);
  const dot = colab.status === 'busy' || colab.status === 'connecting' || power === 'starting' || power === 'stopping' ? 'busy' : connected ? 'on' : colab.status === 'lost' || colab.status === 'error' ? 'lost' : 'off';
  const sample = colab.sample;
  const busy = sample ? [sample.gpu ? `GPU ${sample.gpu.util}%` : '', sample.cpu !== undefined ? `CPU ${sample.cpu}%` : ''].filter(Boolean).join(' · ') : '';
  const state =
    power === 'stopping' ? 'shutting down…' : power === 'starting' ? 'starting…' : colab.status === 'connecting' ? 'connecting…' : colab.reconnecting ? 'reconnecting…' : colab.status === 'busy' ? busy || 'running' : connected ? 'idle' : power === 'down' ? 'shut down' : colab.status === 'lost' ? 'ended' : playground.compute.kind === 'server' ? 'kernel not started' : 'not connected';

  const shutDown = async () => {
    if (!companion) return;
    if (colab.status === 'busy' && !window.confirm(`A cell is running on ${name}. Shut the Companion down anyway? What is running stops, and every variable goes.`)) return;
    setPower('stopping');
    onNote(null);
    try {
      await stopRuntime();
      await shutdownCompanion(companion);
      setPower('down');
      onNote(`The Koios Companion on ${name} is shut down: no Jupyter server, no kernels. It stays off, at your next login too, until you start it — Start the Companion in this menu, the Koios app, or reader-companion start in a terminal.`);
    } catch (error) {
      setPower('unknown');
      onNote(error instanceof Error ? error.message : String(error));
    }
  };
  const startUp = async () => {
    if (!companion) return;
    setPower('starting');
    onNote(null);
    const info = await startCompanion(companion.url);
    if (!info) {
      setPower('down');
      onNote(`The Companion didn’t start from here. Open the Koios app on ${name}, or run reader-companion start in a terminal there. (The page can start a Companion from ${STARTABLE} on, installed with the Koios app or the installer: update it in Settings → Updates.)`);
      return;
    }
    setPower('up');
    await connect().catch(() => undefined);
  };
  return (
    <div className="menu-wrap" ref={box}>
      <button type="button" className={`colab-chip pg-chip is-${dot}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title={colab.error || (state === 'kernel not started' ? `Cells run on ${name}. Its kernel starts with the first cell or command; the terminal, the files and the agent don't need it — they reach the computer through its Companion.` : `Cells run on ${name}`)}>
        {playground.compute.kind === 'colab' ? <ColabMark /> : <span className={`pg-mark ${(serverById(playground.compute.serverId)?.where ?? playground.compute.where) === 'pc' ? 'is-pc' : 'is-gpu'}`}>{(serverById(playground.compute.serverId)?.where ?? playground.compute.where) === 'pc' ? 'PC' : 'GPU'}</span>}
        <span className={`colab-dot is-${dot}`} aria-hidden="true" />
        {name} · {state}
        {connected && colab.startedAt ? ` · ${clock(colab.startedAt, now)}` : ''}
      </button>
      {open && onColab && !connected ? (
        // Colab, not connected: the same card as a paper's cells — the machine, what Google is asked for, what the reader can and can't do.
        <ConnectCard
          playground
          initial={colabMachine}
          busy={colab.status === 'connecting'}
          onClose={() => setOpen(false)}
          onConnect={(machine) => {
            setOpen(false);
            pickMachine(machine);
            void connect(machine).catch(() => undefined);
          }}
          footer={
            <>
              <button
                type="button"
                className="colab-action"
                onClick={() => {
                  setOpen(false);
                  onChange();
                }}
              >
                <b>Change where it runs…</b>
                <span>This PC, a computer of yours, a GPU server — or the code on one machine and run on another</span>
              </button>
              <button
                type="button"
                className="colab-action"
                onClick={() => {
                  setOpen(false);
                  onPool();
                }}
              >
                <b>{playground.pool?.length ? 'The project’s machines' : 'Run on more machines…'}</b>
                <span>{playground.pool?.length ? `${1 + playground.pool.length} machines, one job each` : 'More Colab machines, or a computer of yours beside Colab: one job each, for a sweep or a few seeds side by side'}</span>
              </button>
            </>
          }
        />
      ) : open ? (
        <div className={`menu right pg-chip-menu${onColab ? ' colab-menu' : ''}`} role="menu">
          <div className="menu-label">Where the code runs</div>
          <p className="pg-chip-note">
            <b>{name}</b>
            {colab.specs?.gpuName ? ` · ${colab.specs.gpuName}` : ''}
            {colab.specs?.ramTotalMb ? ` · ${Math.round(colab.specs.ramTotalMb / 1024)} GB RAM` : ''}
            {server ? (
              <small className="pg-chip-secure" title={isSecure(server.url) ? 'The page and the server talk over https: encrypted, and the server’s certificate checked.' : 'The page and the Companion talk over plain http on 127.0.0.1: it never leaves this computer, and every call needs the Companion’s token. Safari, and the others once this computer trusts the Companion’s certificate, use https instead.'}>
                {isSecure(server.url) ? 'HTTPS · encrypted' : companion ? 'HTTP · on this computer only' : 'HTTP · not encrypted'}
              </small>
            ) : null}
          </p>
          {companion && !connected && (power === 'down' || power === 'starting') ? (
            <button
              type="button"
              role="menuitem"
              disabled={power === 'starting'}
              title="Starts the Koios Companion (the Jupyter server on this computer) through the Koios app. Your browser asks once whether to open it."
              onClick={() => {
                setOpen(false);
                void startUp();
              }}
            >
              {power === 'starting' ? 'Starting the Companion…' : 'Start the Companion'}
            </button>
          ) : !connected ? (
            <button
              type="button"
              role="menuitem"
              disabled={!usable || colab.status === 'connecting'}
              onClick={() => {
                setOpen(false);
                void connect().catch(() => undefined);
              }}
            >
              Connect now
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              disabled={colab.status !== 'busy'}
              title="Stops the cell that is running now, as Ctrl-C would. The kernel, its variables and the server stay."
              onClick={() => {
                setOpen(false);
                void interrupt();
              }}
            >
              Interrupt the running cell
            </button>
          )}
          {onColab && connected ? (
            <>
              <div className="colab-stats">
                <div>
                  <span className="k">Machine</span>
                  <span className="v">{colab.runtime ? machineLabel(colab.runtime) : machineLabel(colabMachine)}</span>
                </div>
                <div>
                  <span className="k">Up for</span>
                  <span className="v">{clock(colab.startedAt, now) || '—'}</span>
                </div>
                <div>
                  <span className="k">Compute units</span>
                  <span className="v">
                    {colab.units?.balance !== undefined ? colab.units.balance.toFixed(1) : colab.runtime?.accelerator ? 'your tier’s' : '0'}
                    {colab.units?.ratePerHour ? <small> · {colab.units.ratePerHour.toFixed(2)}/h</small> : !colab.runtime?.accelerator ? <small> · free</small> : null}
                  </span>
                </div>
              </div>
              {changingMachine ? (
                <div className="colab-status">
                  A new runtime on another machine; this one is stopped, and every variable with it.
                  <MachinePicker
                    machine={colabMachine}
                    disabled={colab.status === 'busy'}
                    onPick={(machine) => {
                      setOpen(false);
                      setChangingMachine(false);
                      pickMachine(machine);
                      void stopRuntime().then(() => connect(machine));
                    }}
                  />
                </div>
              ) : (
                <button type="button" role="menuitem" className="pg-chip-two" disabled={colab.status === 'busy'} onClick={() => setChangingMachine(true)}>
                  Change machine… <small className="pg-chip-sub">CPU, T4, L4, A100 — a new runtime</small>
                </button>
              )}
              {colab.runtime && colab.backend.kind === 'colab' ? (
                <a role="menuitem" className="pg-chip-link" href={attachUrl(colab.runtime.endpoint)} target="_blank" rel="noreferrer noopener" title="Colab's own notebook page on the same machine — for plots, a terminal, or Drive, on purpose">
                  Open this runtime in Colab ↗
                </a>
              ) : null}
              <button
                type="button"
                role="menuitem"
                disabled={colab.status === 'busy'}
                title="Forgets every variable; keeps the machine and the files on it"
                onClick={() => {
                  setOpen(false);
                  void restartKernel();
                }}
              >
                Restart the kernel
              </button>
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onChange();
            }}
          >
            Change where it runs…
          </button>
          <button
            type="button"
            role="menuitem"
            className="pg-chip-two"
            title="One more machine for this project — a Colab machine of its own, or a computer of yours — to run a sweep or a few seeds side by side, one job each"
            onClick={() => {
              setOpen(false);
              onPool();
            }}
          >
            {playground.pool?.length ? 'The project’s machines' : 'Run on more machines…'} <small className="pg-chip-sub">{playground.pool?.length ? `${1 + playground.pool.length} machines, one job each` : 'a pool: several machines, one job each'}</small>
          </button>
          {connected || (companion && power === 'up') ? (
            <>
              <hr />
              {connected ? (
                <button
                  type="button"
                  role="menuitem"
                  title={playground.compute.kind === 'colab' ? undefined : 'Ends this notebook’s Python process: its variables go. The Jupyter server keeps running.'}
                  onClick={() => {
                    setOpen(false);
                    void stopRuntime();
                  }}
                >
                  {playground.compute.kind === 'colab' ? 'Stop the Colab runtime' : 'Shut down the kernel'}
                </button>
              ) : null}
              {companion ? (
                <button
                  type="button"
                  role="menuitem"
                  title="Stops the Koios Companion, the Jupyter server on this computer, and every kernel in it. It stays off until you start it again from this menu or the Koios app."
                  onClick={() => {
                    setOpen(false);
                    void shutDown();
                  }}
                >
                  Shut down the Companion
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------- the files --

interface OpenFile {
  where: 'home' | 'machine';
  path: string;
  text: string;
  saved: string;
}

/** What a server's computer can run: a Companion says (/companion/tools); anything else is taken to be a Linux box with Python and a compiler. */
function useMachineTools(server: JupyterServer | undefined): { tools: MachineTools; asked: boolean } {
  const [found, setFound] = useState<{ id: string; tools: MachineTools | null } | null>(null);
  useEffect(() => {
    if (!server || !isCompanion(server)) return;
    let live = true;
    void companionTools(server).then((tools) => live && setFound({ id: server.id, tools }));
    return () => {
      live = false;
    };
  }, [server?.id, server?.url, server?.token]);
  const tools = server && found && found.id === server.id ? found.tools : null;
  return { tools: tools ?? ASSUMED_TOOLS, asked: Boolean(tools) };
}

/** The project's folder on the server's computer, absolute, when the page knows the Companion's: /Users/me/Reader/<root>. */
const absoluteFolder = (server: JupyterServer | undefined, relative: string) => {
  if (!server?.root) return null;
  const windows = /^[A-Za-z]:\\/.test(server.root);
  const root = server.root.replace(/[\\/]+$/, '');
  return windows ? `${root}\\${relative.replace(/\//g, '\\')}` : `${root}/${relative}`;
};

const readSession = <T,>(name: string, fallback: T): T => {
  try {
    const raw = sessionStorage.getItem(name);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const writeSession = (name: string, value: unknown) => {
  try {
    sessionStorage.setItem(name, JSON.stringify(value));
  } catch {
    // private mode: the tabs start over next time
  }
};
const shortId = () => Math.random().toString(36).slice(2, 8);

/**
 * The agent pane: a coding agent picked from the list, run in a terminal of
 * its own in the project's folder, beside the editor as in VS Code. Before it
 * starts, its options — the model, what it may do without asking, carrying
 * on the last conversation, any other flags — make up its command line, shown
 * as it will be typed; while it runs, its own slash commands and keys are
 * buttons. The session lives on the machine, so closing the pane and opening
 * it again finds the same conversation; Start again begins a new one.
 */
function AgentPane({ server, machineName, agents, asked, cwd, inFolder, playgroundId, briefing, note, os }: { server: JupyterServer | undefined; machineName: string; agents: { id: string; name: string }[]; asked: boolean; cwd: string; inFolder: (command: string) => string; playgroundId: string; /** What Claude Code is told about where it is (its --append-system-prompt); other agents are told by the person. */ briefing?: string; /** A line over the pane saying where the agent works. */ note?: string; /** The computer's system, for how a word is quoted in its shell: PowerShell on Windows, a POSIX shell elsewhere. */ os?: 'mac' | 'linux' | 'windows' }) {
  const installed = new Set(agents.map((agent) => agent.id));
  // An agent the Companion found that the list doesn't name yet still shows, by its own name, with extra arguments only.
  const catalog: AgentSpec[] = [...AGENTS, ...agents.filter((agent) => !AGENTS.some((known) => known.id === agent.id)).map((agent) => ({ ...agent, install: '' }))];
  const sorted = [...catalog].sort((a, b) => Number(installed.has(b.id)) - Number(installed.has(a.id)));
  const key = `pgagent:${playgroundId}`;
  const [session, setSession] = useState<{ agent: string; id: string; command: string } | null>(() => readSession(key, null));
  const [pick, setPick] = useState(() => session?.agent ?? sorted.find((agent) => installed.has(agent.id))?.id ?? 'claude');
  const [allOptions, setAllOptions] = useState(savedAgentOptions);
  const [showOptions, setShowOptions] = useState(!session);
  const chosen = catalog.find((agent) => agent.id === pick) ?? catalog[0];
  const options = allOptions[chosen.id] ?? {};
  const setOptions = (patch: Partial<AgentOptions>) => {
    const next = { ...allOptions, [chosen.id]: { ...options, ...patch } };
    setAllOptions(next);
    saveAgentOptions(next);
  };
  // PowerShell takes a single-quoted word with the quotes inside doubled; a POSIX shell with '\''.
  const quoted = (word: string) => (os === 'windows' ? `'${word.replace(/'/g, "''")}'` : shellWord(word));
  const command = agentCommand(chosen, options) + (briefing && chosen.id === 'claude' ? ` --append-system-prompt ${quoted(briefing)}` : '');
  const isThere = installed.has(chosen.id);
  const running = session ? catalog.find((agent) => agent.id === session.agent) : undefined;
  // What a new session types, once its shell is open (queued until then by typeInTerminal).
  const pending = useRef<{ id: string; text: string } | null>(null);
  useEffect(() => {
    if (session && pending.current?.id === session.id) {
      typeInTerminal(session.id, pending.current.text);
      pending.current = null;
    }
  }, [session]);

  if (!server) return <p className="pg-note pg-pad">An agent runs in a terminal on the machine: choose a Jupyter server of yours — a Koios Companion — from the machine menu.</p>;
  const start = (line: string) => {
    if (session) forgetTerminal(server, session.id);
    const next = { agent: chosen.id, id: `${playgroundId}~agent~${shortId()}`, command: line };
    pending.current = { id: next.id, text: `${inFolder(line)}\r` };
    writeSession(key, next);
    setSession(next);
    setShowOptions(false);
  };
  const stop = () => {
    if (session) forgetTerminal(server, session.id);
    writeSession(key, null);
    setSession(null);
    setShowOptions(true);
  };
  const send = (text: string) => session && typeInTerminal(session.id, text);
  return (
    <div className="pg-agent">
      <div className="pg-agent-bar">
        <select value={pick} onChange={(event) => setPick(event.target.value)} aria-label="The coding agent">
          {sorted.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
              {installed.has(agent.id) ? '' : asked ? ' · not installed' : ''}
            </option>
          ))}
        </select>
        {isThere || !asked ? (
          <button type="button" className="btn sm primary" onClick={() => start(command)} title={`${command} — in this project's folder on ${machineName}`}>
            {session ? 'Start again' : 'Start'}
          </button>
        ) : chosen.install ? (
          <button type="button" className="btn sm" onClick={() => start(chosen.install)} title={chosen.install}>
            Install
          </button>
        ) : null}
        {session ? (
          <button type="button" className="btn sm ghost" onClick={stop} title="End this agent's terminal">
            End
          </button>
        ) : null}
        <button type="button" className={`icon-btn sm${showOptions ? ' is-on' : ''}`} aria-expanded={showOptions} onClick={() => setShowOptions(!showOptions)} title="Its options: the model, permissions, and more" aria-label="Options">
          ⚙
        </button>
      </div>
      {note ? <p className="pg-note pg-agent-note">{note}</p> : null}
      {showOptions ? (
        <div className="pg-agent-options">
          {chosen.model ? (
            <label>
              <span>Model</span>
              <input list={`pg-agent-models-${chosen.id}`} value={options.model ?? ''} onChange={(event) => setOptions({ model: event.target.value })} placeholder={chosen.model.placeholder ?? 'its default'} spellCheck={false} />
              {chosen.model.suggestions ? (
                <datalist id={`pg-agent-models-${chosen.id}`}>
                  {chosen.model.suggestions.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              ) : null}
            </label>
          ) : null}
          {(chosen.choices ?? []).map((choice) => (
            <label key={choice.key}>
              <span>{choice.label}</span>
              <select value={options.choices?.[choice.key] ?? ''} onChange={(event) => setOptions({ choices: { ...options.choices, [choice.key]: event.target.value } })}>
                {choice.values.map((value) => (
                  <option key={value.value} value={value.value}>
                    {value.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {(chosen.toggles ?? []).map((toggle) => (
            <label key={toggle.key} className="pg-agent-check">
              <input type="checkbox" checked={Boolean(options.toggles?.[toggle.key])} onChange={(event) => setOptions({ toggles: { ...options.toggles, [toggle.key]: event.target.checked } })} />
              <span>{toggle.label}</span>
            </label>
          ))}
          {chosen.resume ? (
            <label className="pg-agent-check">
              <input type="checkbox" checked={Boolean(options.resume)} onChange={(event) => setOptions({ resume: event.target.checked })} />
              <span>Carry on the last conversation in this folder</span>
            </label>
          ) : null}
          <label>
            <span>Other flags</span>
            <input value={options.extra ?? ''} onChange={(event) => setOptions({ extra: event.target.value })} placeholder="anything else it takes, as typed" spellCheck={false} />
          </label>
          <code className="pg-agent-line" title="What Start types, in the project's folder">
            $ {command}
          </code>
        </div>
      ) : null}
      {!asked ? <p className="pg-note pg-pad">The Companion on {machineName} can’t say which agents are installed (update it in Settings → Updates): Start runs the command and the shell says if it is missing.</p> : null}
      {session ? (
        <>
          <div className="pg-agent-keys" aria-label={`${running?.name ?? session.agent}: its commands`}>
            {(running?.slash ?? []).map((slash) => (
              <button key={slash} type="button" className="pg-agent-key mono" onClick={() => send(`${slash}\r`)} title={`Types ${slash} into ${running?.name ?? 'the agent'}`}>
                {slash}
              </button>
            ))}
            {AGENT_KEYS.map((key) => (
              <button key={key.label} type="button" className="pg-agent-key is-key" onClick={() => send(key.text)} title={key.title}>
                {key.label}
              </button>
            ))}
          </div>
          <div className="pg-agent-term">
            <Terminal key={session.id} server={server} cwd={cwd} sessionId={session.id} label={`${running?.name ?? session.agent} on ${machineName}`} playgroundId={playgroundId} />
          </div>
        </>
      ) : (
        <div className="pg-agent-empty">
          <p>
            <b>{chosen.name}</b> {isThere ? `is on ${machineName}. Start it and it works in this project's folder, in a terminal of its own here.` : asked ? `isn’t on ${machineName} yet. Install types its installer into a terminal here; then Start.` : ''}
          </p>
          {!isThere && chosen.install ? <code className="mono pg-note">{chosen.install}</code> : null}
          <p className="pg-note">{agents.length ? `On ${machineName}: ${agents.map((agent) => agent.name).join(', ')}.` : asked ? `No agents found on ${machineName} yet.` : ''}</p>
        </div>
      )}
    </div>
  );
}

/** The page's editor or VS Code, for a project whose files are on a Companion with VS Code. */
function EditorSwitch({ playground }: { playground: Playground }) {
  const mode = playground.editor ?? 'reader';
  return (
    <div className="segmented pg-seg pg-editor-switch" role="radiogroup" aria-label="Editor">
      <button type="button" role="radio" aria-checked={mode === 'reader'} className={mode === 'reader' ? 'on' : ''} onClick={() => updatePlayground(playground.id, () => ({ editor: 'reader' }))}>
        Editor
      </button>
      <button type="button" role="radio" aria-checked={mode === 'vscode'} className={mode === 'vscode' ? 'on' : ''} onClick={() => updatePlayground(playground.id, () => ({ editor: 'vscode' }))} title="VS Code from that computer, in the page: your extensions and coding agents, on the same files">
        VS Code
      </button>
    </div>
  );
}


/** VS Code from the Companion's computer, in the page (code serve-web, through the Companion): started on first open. */
function VsCodePane({ server, folder, playground }: { server: JupyterServer; folder: string; playground: Playground }) {
  const [status, setStatus] = useState<VsCodeWeb | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [showLog, setShowLog] = useState(false);
  // VS Code in the page leans on the Companion's fixes (0.7.2: started again when it stops answering): an older one is offered the update here.
  const [companion, setCompanion] = useState<{ version: string; updating?: boolean; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    void findCompanion(server.url.replace(/\/?$/, '/'), 3000).then((info) => live && info && setCompanion({ version: info.version }));
    return () => {
      live = false;
    };
  }, [server.url, round]);
  const outdated = companion && isNewer(COMPANION_VERSION, companion.version) ? companion : null;
  const update = async () => {
    if (!outdated) return;
    setCompanion({ ...outdated, updating: true, error: undefined });
    try {
      const done = await updateCompanion(server);
      const back = done.updated ? await waitForVersion(server.url.replace(/\/?$/, '/'), done.version) : null;
      setCompanion({ version: back?.version ?? done.version });
      setRound((n) => n + 1);
    } catch (error) {
      setCompanion({ ...outdated, updating: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  useEffect(() => {
    let live = true;
    let timer = 0;
    setProblem(null);
    const look = async (start: boolean) => {
      try {
        const now = await vscodeWeb(server, folder, start);
        if (!live) return;
        setStatus(now);
        if (now.state === 'starting' || (now.state === 'off' && !start)) timer = window.setTimeout(() => void look(now.state === 'off'), 1500);
        // Up: asked again now and then (start checks that it answers, and starts it again if not), so VS Code
        // stopping — the computer slept — shows here and comes back by itself.
        else if (now.state === 'ready') timer = window.setTimeout(() => void look(true), 15_000);
      } catch (error) {
        if (live) setProblem(error instanceof Error ? error.message : String(error));
      }
    };
    void look(true);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [server.id, server.url, server.token, folder, round]);
  const src = status?.state === 'ready' && status.path ? `${server.url.replace(/\/?$/, '/')}${status.path.replace(/^\//, '')}?folder=${encodeURIComponent(vscodeFolder(status.folder))}` : null;
  // A frame that came up again after a restart is a new one, so it loads VS Code afresh.
  const [frameRound, setFrameRound] = useState(0);
  const wasReady = useRef(true);
  useEffect(() => {
    const ready = status?.state === 'ready';
    if (ready && !wasReady.current) setFrameRound((n) => n + 1);
    wasReady.current = ready;
  }, [status?.state]);
  return (
    <div className="pg-vscode-pane">
      <div className="pg-tabs pg-vscode-head">
        <EditorSwitch playground={playground} />
        <span className="pg-note mono">{status?.folder || folder}</span>
        <span className="spacer" />
        {status?.log.length ? (
          <button type="button" className={`btn sm ghost${showLog ? ' is-on' : ''}`} aria-pressed={showLog} onClick={() => setShowLog(!showLog)} title="What VS Code itself printed last, on that computer">
            VS Code’s output
          </button>
        ) : null}
        {src ? (
          <a className="btn sm ghost" href={src} target="_blank" rel="noreferrer" title="If the frame stays blank (some browsers keep a frame from another site out of its sign-in), it opens in a tab of its own">
            Open in a new tab
          </a>
        ) : null}
      </div>
      {outdated ? (
        <div className="pg-banner is-problem">
          {outdated.error ?? `The Companion on ${server.name} is ${outdated.version}; VS Code in the page needs ${COMPANION_VERSION}, which starts VS Code again when it stops answering and lets it connect through the HTTPS tunnel (before, it hung on “Reconnecting…” there).`}
          <button type="button" className="btn sm" disabled={outdated.updating} onClick={() => void update()}>
            {outdated.updating ? 'Updating…' : 'Update it'}
          </button>
        </div>
      ) : null}
      {showLog && status?.log.length ? <pre className="pg-vscode-log">{status.log.join('\n')}</pre> : null}
      {src ? (
        <iframe key={frameRound} className="pg-vscode-frame" src={src} title={`VS Code on ${server.name}`} allow="clipboard-read; clipboard-write" />
      ) : (
        <div className="pg-vscode-wait">
          {problem || status?.state === 'failed' ? (
            <>
              <p className="pg-note is-problem">{problem || status?.error}</p>
              <button type="button" className="btn sm" onClick={() => setRound((n) => n + 1)}>
                Try again
              </button>
            </>
          ) : (
            <p>
              <span className="spinner" /> Starting VS Code on {server.name}… The first time, it downloads VS Code’s server (a minute or two), and your extensions — coding agents included — come from the VS Code installed there. Starting it accepts the{' '}
              <a href="https://code.visualstudio.com/license/server" target="_blank" rel="noreferrer">
                VS Code Server license
              </a>
              .
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function FilesView({ playground, connected, usable, machineName }: { playground: Playground; connected: boolean; usable: boolean; machineName: string }) {
  const colab = useColab();
  const { papers, settings: readerSettings } = useStore();
  const driveOn = useDriveConnected();
  const servers = useServers();
  // The project's data place (src/lib/dataStore.ts): Google Drive by default, where its datasets, checkpoints and run
  // outputs go while the code runs here or on Colab. For Drive, a link on the Worker holds the account's token for the
  // machine's koios_data, started when the project opens and renewed every twenty minutes while it is open.
  const dataPlace = dataPlaceOf(playground, driveOn);
  const [dataLink, setDataLink] = useState<DataLink | null>(null);
  useEffect(() => {
    if (dataPlace.kind !== 'drive') {
      setDataLink(null);
      return;
    }
    let live = true;
    const start = () => ensureDataLink(playground).then((link) => live && setDataLink(link)).catch(() => undefined);
    void start();
    const timer = window.setInterval(() => void renewDataLink(playground).then(start), 20 * 60_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playground.id, playground.title, dataPlace.kind, driveOn]);
  /** What the compute is told about the data place, for a command in `folder` there. A computer of yours that is not in the list any more falls back to the machine's disk. */
  const dataServer = dataPlace.kind === 'server' ? serverById(dataPlace.serverId) : undefined;
  const dataFor = (folder: string) => dataSetup(dataPlace, folder, machineName, dataLink ?? undefined, dataServer ? { url: dataServer.url, token: dataServer.token, name: dataServer.name, root: dataServer.root, project: dataFolderNameOf(playground) } : null);
  // A computer of yours with room (the Companion, online, 20 GB or more free) offered as the data place, once, while the
  // project is on Drive's default: the person may well prefer their own disk, and it is faster.
  const offerKey = `reader.pgDataAsked:${playground.id}`;
  const [dataOffer, setDataOffer] = useState<{ server: JupyterServer; free: number } | null>(null);
  useEffect(() => {
    if (playground.data || !driveOn || readLocal(offerKey, false)) return;
    let live = true;
    void (async () => {
      for (const server of servers.filter((s) => isCompanion(s))) {
        const disk = await companionDisk(server).catch(() => null);
        if (!live) return;
        if (disk && disk.free >= OFFER_FREE_BYTES) {
          setDataOffer({ server, free: disk.free });
          return;
        }
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playground.id, playground.data?.kind, driveOn, servers.map((s) => s.id).join()]);
  const settleOffer = (choice: 'server' | 'drive' | 'later') => {
    writeLocal(offerKey, true);
    if (choice === 'server' && dataOffer) {
      forgetDataLink(playground.id);
      updatePlayground(playground.id, { data: { kind: 'server', serverId: dataOffer.server.id } });
    } else if (choice === 'drive') updatePlayground(playground.id, { data: { kind: 'drive' } });
    setDataOffer(null);
  };
  const split = !filesAreOnMachine(playground);
  // The hosts follow the servers' list, so an edited address is used at once.
  const home = useMemo(() => homeHost(playground), [playground, servers]);
  const machine = useMemo(() => machineHost(playground, machineName), [playground, machineName, servers]);
  const homeLabel = homeLabelOf(playground, machineName);
  // The workbench, as VS Code lays it out: the activity bar's view in the side bar, the agent on the right, the panel below.
  const [primary, setPrimary] = useState<Primary>(() => readLocal<Primary>('reader.pgPrimary', 'explorer'));
  const [agentOpen, setAgentOpenState] = useState(() => readLocal('reader.pgAgent', true));
  // Unset until chosen: by the files when the agent can work there (the compute link up), else Claude Code on the machine.
  const [agentMode, setAgentMode] = useState<AgentMode | 'unset'>(() => readLocal<AgentMode | 'unset'>('reader.pgAgentMode', 'unset'));
  const [rightTab, setRightTabState] = useState<RightTab>(() => readLocal<RightTab>('reader.pgRight', 'agent'));
  const setRightTab = (tab: RightTab) => (setRightTabState(tab), writeLocal('reader.pgRight', tab));
  /** The right-hand pane on a tab, or closed when that tab was already showing. */
  const toggleRight = (tab: RightTab) => {
    if (agentOpen && rightTab === tab) setAgentOpen(false);
    else (setRightTab(tab), setAgentOpen(true));
  };
  const [panelOpen, setPanelOpen] = useState(true);
  const setAgentOpen = (open: boolean) => (setAgentOpenState(open), writeLocal('reader.pgAgent', open));
  useEffect(() => writeLocal('reader.pgPrimary', primary), [primary]);
  useEffect(() => writeLocal('reader.pgAgentMode', agentMode), [agentMode]);
  const [files, setFiles] = useState<OpenFile[]>([]);
  // The editor groups, as VS Code's split editor: one, or two side by side, each with its tabs and the one shown.
  const [groups, setGroups] = useState<EditorGroupState[]>([{ tabs: [], active: null }]);
  const [focus, setFocusState] = useState(0);
  const focused = Math.min(focus, groups.length - 1);
  const active = groups[focused]?.active ?? null;
  const setFocus = (index: number) => setFocusState(index);
  const editors = useRef<(CodeEditorHandle | null)[]>([]);
  const goTo = useRef<{ group: number; line: number } | null>(null);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [settings, setSettingsState] = useState<EditorSettings>(() => ({ ...DEFAULT_EDITOR, ...readLocal<Partial<EditorSettings>>('reader.pgEditor', {}) }));
  const setSettings = (patch: Partial<EditorSettings>) =>
    setSettingsState((now) => {
      const next = { ...now, ...patch };
      writeLocal('reader.pgEditor', next);
      return next;
    });
  const [zen, setZen] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [splitAt, setSplitAt] = useState(50);
  const [dragging, setDragging] = useState<{ group: number; key: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const groupsBox = useRef<HTMLDivElement>(null);
  const splitFrom = useRef(50);
  const closed = useRef<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [report, setReport] = useState<(SyncReport & { at: number; what: 'push' | 'pull' }) | null>(null);
  const [syncing, setSyncing] = useState<'push' | 'pull' | null>(null);
  const [command, setCommand] = useState(playground.pending ?? '');
  const [base, setBase] = useState<string | null>(null);
  // The project's machines: its first, and its pool. A command goes to one of them, or to all at once (one job each).
  const machines = useMemo(() => machinesOf(playground), [playground, servers]); // eslint-disable-line react-hooks/exhaustive-deps
  const pooled = machines.length > 1;
  const sessions = useSessions();
  const targetKey = `pgtarget:${playground.id}`;
  const [targetState, setTargetState] = useState<string>(() => readSession(targetKey, 'first'));
  const target = targetState === 'all' || machines.some((m) => (m.member ?? 'first') === targetState) ? targetState : 'first';
  const setTarget = (next: string) => (setTargetState(next), writeSession(targetKey, next));
  /** The folder's absolute path on each pool member, once asked (the first machine's is `base`). */
  const memberBases = useRef<Record<string, string>>({});
  /** The machines a command goes to now. */
  const targets = target === 'all' ? machines : [machines.find((m) => (m.member ?? 'first') === target) ?? machines[0]];
  const runningOn = (m: ProjectMachine) => (m.member === null ? colab.running : sessionOf(sessions, m.scope)?.running);
  /** The machines the koios helper has been written to in this tab (src/lib/koiosHelper.ts), by scope. */
  const helperOn = useRef(new Set<string>());
  /**
   * A machine that went away while connected — the Companion closed, the network gone, the runtime ended — and the
   * last checkpoint a run on it reported, for the notice and for picking the job up again.
   */
  const [gone, setGone] = useState<{ machine: ProjectMachine; at: number; reason?: string; checkpoint?: Checkpoint; entry?: ConsoleEntry } | null>(null);
  const [resumeOn, setResumeOn] = useState<string>('same');
  const lastStatus = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const m of machines) {
      const state = m.member === null ? colab : sessionOf(sessions, m.scope);
      const now = state?.status ?? 'off';
      const before = lastStatus.current[m.scope];
      lastStatus.current[m.scope] = now;
      if (now !== 'lost' || (before !== 'idle' && before !== 'busy')) continue;
      // The last checkpoint any command on that machine said it saved (the koios helper's line), newest run first.
      let best: { checkpoint: Checkpoint; entry: ConsoleEntry; startedAt: number } | undefined;
      for (const entry of playground.console) {
        for (const { key, machine: on } of entryRuns(playground.id, machines, entry)) {
          if (on.scope !== m.scope) continue;
          const run = colab.runs[key];
          const checkpoint = run ? latestCheckpoint(outputText(run.outputs)) : undefined;
          if (checkpoint && (!best || run!.startedAt > best.startedAt)) best = { checkpoint, entry, startedAt: run!.startedAt };
        }
      }
      setGone({ machine: m, at: Date.now(), reason: state?.error, checkpoint: best?.checkpoint, entry: best?.entry });
      setResumeOn('same');
    }
  }, [sessions, colab, machines, playground.console, playground.id]);
  const current = files.find((file) => `${file.where}:${file.path}` === active) ?? null;
  // Where you are, to the others in a shared project (src/lib/liveRoom.ts): the file and the caret, as you move; their
  // carets are drawn in the editor and their names in the tree; a jump from one of them opens their file at their line.
  const peers = usePeers('code');
  const peersByPath = useMemo(() => {
    const map = new Map<string, EditorPeer[]>();
    for (const peer of peers) {
      if (!peer.place.path) continue;
      const list = map.get(peer.place.path) ?? [];
      list.push({ id: peer.id, name: peer.name, color: peer.color, offset: peer.place.offset ?? 0, sel: peer.place.sel });
      map.set(peer.place.path, list);
    }
    return map;
  }, [peers]);
  useEffect(() => {
    if (!current) return;
    reportPlace({ tab: 'code', path: current.path, ...(cursor ? { line: cursor.line, col: cursor.col, offset: cursor.offset, ...(cursor.selected ? { sel: [Math.max(0, cursor.offset - cursor.selected), cursor.offset] as [number, number] } : {}) } : {}) });
  }, [current?.path, cursor]); // eslint-disable-line react-hooks/exhaustive-deps
  useJumps('code', undefined, (jump) => void (jump.path && open('home', jump.path, { line: jump.line })));
  // The file shown is read again from its folder every couple of seconds, and when the window comes back: an agent, a
  // terminal or another editor may have written it. Untouched here, it takes the new text; changed here too, the bar asks.
  // The panes' sizes and places, dragged and toggled; kept for every project.
  const [layout, setLayoutState] = useState<PaneLayout>(loadLayout);
  const setLayout = (patch: Partial<PaneLayout>) =>
    setLayoutState((now) => {
      const next = readLayout({ ...now, ...patch });
      saveLayout(next);
      return next;
    });
  const dragFrom = useRef<PaneLayout>(layout);
  const centerBox = useRef<HTMLElement>(null);
  const [onDisk, setOnDisk] = useState<{ key: string; text: string } | null>(null);
  const dismissed = useRef<{ key: string; text: string } | null>(null);
  const currentKey = current ? `${current.where}:${current.path}` : null;
  useEffect(() => {
    if (!current || !currentKey) return;
    const { where, path } = current;
    const host = where === 'home' ? home : machine;
    let live = true;
    let reading = false;
    const check = async () => {
      if (reading || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
      reading = true;
      try {
        const disk = (await host.read(path)) ?? '';
        if (!live) return;
        setFiles((list) => list.map((f) => (`${f.where}:${f.path}` === currentKey && disk !== f.saved && f.text === f.saved ? { ...f, text: disk, saved: disk } : f)));
        const shown = filesRef.current.find((f) => `${f.where}:${f.path}` === currentKey);
        const stale = shown && disk !== shown.saved && shown.text !== shown.saved && !(dismissed.current?.key === currentKey && dismissed.current.text === disk);
        setOnDisk(stale ? { key: currentKey, text: disk } : null);
      } catch {
        // not reachable now (the machine not connected): the next read tries again
      } finally {
        reading = false;
      }
    };
    const every = window.setInterval(() => void check(), 2000);
    window.addEventListener('focus', check);
    return () => {
      live = false;
      window.clearInterval(every);
      window.removeEventListener('focus', check);
    };
  }, [currentKey, home, machine]);
  const filesRef = useRef(files);
  filesRef.current = files;
  const activeRef = useRef<string | undefined>(undefined);
  activeRef.current = current?.where === 'home' ? current.path : undefined;
  // Ask AI reads this project's files while it is on screen: the one in front, the open tabs (unsaved edits too), the
  // rest of its code and notes within a question's budget (projectScreen.ts). Nothing once the workspace goes.
  const { collections } = useStore();
  const researchProject = projectsOf(collections).find((item) => item.project.playgroundId === playground.id)?.name;
  useEffect(() => {
    offerProject(async () => {
      const open = filesRef.current.filter((file) => file.where === 'home').map((file) => ({ path: file.path, text: file.text, unsaved: file.text !== file.saved }));
      const read = await readProjectFiles(home, open, activeRef.current);
      return {
        title: playground.title,
        kind: researchProject ? `the code of the research project “${researchProject}”` : playground.kind === 'project' ? 'a playground project' : 'a playground notebook',
        where: `Its files are in ${home.label}; its code runs on ${machineName}.`,
        ...read,
      };
    });
    return () => offerProject(null);
  }, [home, playground.id, playground.title, playground.kind, machineName, researchProject]);
  // A real terminal when the machine is a Jupyter server that offers one (a Reader Companion does); the command box otherwise, and on Colab.
  const computeServer = playground.compute.kind === 'server' ? servers.find((server) => server.id === (playground.compute.kind === 'server' ? playground.compute.serverId : '')) : undefined;
  const [terminals, setTerminals] = useState<boolean | null>(null);
  useEffect(() => {
    setTerminals(null);
    if (!computeServer) return;
    let live = true;
    void hasTerminals(computeServer).then((yes) => live && setTerminals(yes));
    return () => {
      live = false;
    };
  }, [computeServer?.id, computeServer?.url, computeServer?.token]);
  // In split mode the command box copies the folder over before each command and brings results back; the terminal doesn't, so the box stays first there.
  const [shellView, setShellView] = useState<'terminal' | 'commands' | null>(null);
  // Where the machine has no terminals API (Colab), the terminal is a shell the page runs through the kernel (KernelTerminal).
  const kernelTerms = !(terminals && computeServer);
  const view = shellView ?? 'terminal';
  const { tools: machineTools, asked } = useMachineTools(computeServer);
  const homeServer = playground.home.kind === 'server' ? servers.find((server) => server.id === (playground.home.kind === 'server' ? playground.home.serverId : '')) : undefined;
  const { tools: homeTools } = useMachineTools(homeServer);
  // The files on a computer with the Companion, the code elsewhere: the shell opens there, by the files, and reaches the
  // compute through the Companion (src/lib/computeLink.ts) — at a local shell's speed, the machine a command away.
  const filesHere = split && playground.home.kind === 'server' && homeServer && isCompanion(homeServer) ? homeServer : undefined;
  const homeRoot = playground.home.kind === 'server' ? playground.home.root : '';
  const proxy = playground.compute.kind === 'colab' && connected ? colab.runtime?.proxy : undefined;
  const linkTarget = !filesHere
    ? null
    : proxy && proxy.kind !== 'jupyter'
      ? colabTarget(proxy, machineName, machineRoot(playground), syncRules(playground).ignore)
      : computeServer && computeServer.id !== filesHere.id
        ? serverTarget(computeServer, machineRoot(playground), syncRules(playground).ignore)
        : null;
  const [link, setLink] = useState<LinkState | null>(null);
  const linkKey = linkTarget ? `${linkTarget.url}|${linkTarget.token}|${linkTarget.folder}|${linkTarget.ignore}|${linkTarget.label}` : '';
  // The code back on the files' own computer, or on a server no longer listed: the link there is stale, and forgotten.
  // (Colab merely not connected keeps it: its pass says when it has run out.)
  const stale = !filesHere && homeServer && isCompanion(homeServer) && playground.compute.kind !== 'colab';
  useEffect(() => {
    if (!filesHere || !linkTarget) {
      setLink(null);
      if (stale && homeServer) void linkCompute(homeServer, homeRoot, null);
      return;
    }
    let live = true;
    void linkCompute(filesHere, homeRoot, linkTarget).then((state) => live && setLink(state));
    // Colab's pass runs out after an hour or so: renewed while the page is open, and handed over again.
    const at = renewAt(linkTarget);
    const timer = at ? window.setTimeout(() => void renewRuntimeProxy(playground.id), at - Date.now()) : 0;
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [filesHere?.id, filesHere?.url, filesHere?.token, homeRoot, linkKey, stale]); // eslint-disable-line react-hooks/exhaustive-deps
  const linked = Boolean(filesHere && link?.linked);
  // Mounted there (Companion 0.19.0): the machine reads the folder where it is, through the Companion's tunnel, so a
  // run copies nothing first and brings nothing back after. Started whenever the project asks for it and the machine
  // doesn't have it (a new Colab runtime has none); a machine that drops it is copied to again until it is back.
  const wantMount = Boolean(playground.sync.mount);
  const mountKnown = Boolean(linked && link?.mount);
  const [mounting, setMounting] = useState<{ busy: boolean; words?: string; problem?: string }>({ busy: false });
  const mounted = Boolean(linked && wantMount && (link?.mount?.connected ?? 0) > 0);
  const mountTried = useRef('');
  // One start at a time: the switch and the effect below both start it, and a second start used to stop the first's mount
  // under whatever was working in it (a ref, not the state: two calls in one render both see busy as false).
  const mountBusy = useRef(false);
  // Each mount that comes up: the notebook's kernel is moved into it (below), whatever it was in before.
  const [mountEpoch, setMountEpoch] = useState(0);
  const startMount = async (force = false) => {
    if (!filesHere || mountBusy.current) return;
    if (!force && mountTried.current === linkKey) return;
    mountTried.current = linkKey;
    mountBusy.current = true;
    setMounting({ busy: true });
    try {
      const status = await mountThroughCompanion(filesHere, homeRoot);
      setMounting({ busy: false, words: mountWords(status, machineName) });
      setMountEpoch((n) => n + 1);
    } catch (error) {
      setMounting({ busy: false, problem: error instanceof Error ? error.message : String(error) });
    } finally {
      mountBusy.current = false;
    }
    const fresh = await linkState(filesHere, homeRoot);
    if (fresh) setLink(fresh);
  };
  useEffect(() => {
    if (!linked || !wantMount || !link?.mount || link.mount.connected) return;
    void startMount();
  }, [linked, wantMount, link?.mount?.connected, linkKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // While it is meant to be mounted: whether the machine still has it, every half minute.
  useEffect(() => {
    if (!linked || !wantMount || !filesHere) return;
    const timer = window.setInterval(() => void linkState(filesHere, homeRoot).then((fresh) => fresh && setLink(fresh)), 30_000);
    return () => window.clearInterval(timer);
  }, [linked, wantMount, filesHere?.id, homeRoot]); // eslint-disable-line react-hooks/exhaustive-deps
  const setMount = async (on: boolean) => {
    updatePlayground(playground.id, { sync: { ...playground.sync, mount: on } });
    if (on) return void startMount(true);
    if (!filesHere) return;
    setMounting({ busy: true });
    try {
      await unmountThroughCompanion(filesHere, homeRoot);
      setMounting({ busy: false });
    } catch (error) {
      setMounting({ busy: false, problem: error instanceof Error ? error.message : String(error) });
    }
    const fresh = await linkState(filesHere, homeRoot);
    if (fresh) setLink(fresh);
  };
  // VS Code in the page opens a folder on a Companion's computer: the project's, when its files are kept there —
  // in a folder of its (home) or on its own disk as the machine the code runs on.
  const vscodeAt: { server: JupyterServer; folder: string } | null =
    playground.home.kind === 'server' && homeServer && isCompanion(homeServer) && homeTools.vscode
      ? { server: homeServer, folder: playground.home.root }
      : playground.home.kind === 'machine' && computeServer && isCompanion(computeServer) && machineTools.vscode
        ? { server: computeServer, folder: machineRoot(playground) }
        : null;
  // VS Code in the page: for files on a Companion whose computer has VS Code.
  const vscodeHere = Boolean(vscodeAt);
  const terminalHere = Boolean(view === 'terminal' || (terminals && computeServer && !split));
  const projectFolder = terminalHere ? absoluteFolder(computeServer, machineRoot(playground)) : null;
  // The agent's terminal is its own, so it goes to the folder whatever the console below shows.
  const agentFolder = terminals && computeServer ? absoluteFolder(computeServer, machineRoot(playground)) : null;
  // Several shells, as tabs: the first is the playground's own (its session from before carries on), the others new ones. Each stays open while another is shown.
  const shellsKey = `pgshells:${playground.id}`;
  const [shells, setShells] = useState<string[]>(() => {
    const kept = readSession<string[]>(shellsKey, []);
    return kept.length ? kept : [playground.id];
  });
  const [activeShell, setActiveShell] = useState(shells[0]);
  const keepShells = (next: string[]) => {
    setShells(next);
    writeSession(shellsKey, next);
  };
  // The terminals, for every browser of the account's: which tabs the project has, and which server terminal each is,
  // kept in its folder (.reader/terminals.json). A reload, or another browser, finds the shells running there — a
  // training started in one, an agent's — rather than opening new ones beside them.
  const termsRead = useRef(false);
  useEffect(() => {
    termsRead.current = false;
    let live = true;
    const readTerms = async (): Promise<{ tabs: string[]; names: Record<string, string> }> => {
      try {
        const kept = JSON.parse((await readMeta(home, TERMINALS_FILE)) ?? '{}') as { tabs?: string[]; names?: Record<string, string> };
        return { tabs: Array.isArray(kept.tabs) ? kept.tabs : [], names: kept.names && typeof kept.names === 'object' ? kept.names : {} };
      } catch {
        return { tabs: [], names: {} };
      }
    };
    shareTerminals(playground.id, {
      get: async (key) => (await readTerms()).names[key] ?? null,
      put: async (key, name) => {
        const kept = await readTerms();
        kept.names[key] = name;
        await writeMeta(home, TERMINALS_FILE, `${JSON.stringify(kept)}\n`);
      },
    });
    void readTerms().then((kept) => {
      if (!live) return;
      const mine = readSession<string[]>(shellsKey, []);
      const extra = kept.tabs.filter((tab) => tab.startsWith(playground.id) && !mine.includes(tab));
      if (extra.length) keepShells([...(mine.length ? mine : [playground.id]), ...extra]);
      termsRead.current = true;
    });
    return () => {
      live = false;
      shareTerminals(playground.id, null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home, playground.id]);
  useEffect(() => {
    // The tabs as they are now, once the folder's list has been read (so a new browser's lone tab doesn't replace it).
    if (!termsRead.current) return;
    void (async () => {
      try {
        const kept = JSON.parse((await readMeta(home, TERMINALS_FILE)) ?? '{}') as { tabs?: string[]; names?: Record<string, string> };
        if (JSON.stringify(kept.tabs ?? []) === JSON.stringify(shells)) return;
        await writeMeta(home, TERMINALS_FILE, `${JSON.stringify({ tabs: shells, names: kept.names ?? {} })}\n`);
      } catch {
        // the folder can't be reached now: the next change writes it
      }
    })();
  }, [shells, home]);
  /** A new terminal: on the project's first machine, or on a pool member (its id after an `@`, so the tab comes back to it). */
  const addShell = (member: string | null = null) => {
    const id = `${playground.id}~${shortId()}${member ? `@${member}` : ''}`;
    keepShells([...shells, id]);
    setActiveShell(id);
  };
  /** A terminal on the compute, from the files' computer: `koios shell` typed into a shell there, the tab closing with it. */
  const addComputeShell = () => {
    const id = `${playground.id}~${shortId()}${COMPUTE_TAB}`;
    keepShells([...shells, id]);
    setActiveShell(id);
    return id;
  };
  const [addShellMenu, setAddShellMenu] = useState(false);
  const addShellBox = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!addShellMenu) return;
    const away = (event: MouseEvent) => !addShellBox.current?.contains(event.target as Node) && setAddShellMenu(false);
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [addShellMenu]);
  /** Which machine a terminal tab is on, and how its shell is reached: through its server's terminals, or a shell in its kernel. */
  const shellOn = (id: string): { machine: ProjectMachine; server: JupyterServer | undefined; kernel: boolean; here?: boolean; via?: boolean } => {
    const member = shellMember(id);
    const machine = (member ? machines.find((m) => m.member === member) : undefined) ?? machines[0];
    // By the files: a shell on their computer. A compute tab, there too, running `koios shell` while the link holds.
    if (machine.member === null && filesHere && !isComputeTab(id)) return { machine, server: filesHere, kernel: false, here: true };
    if (machine.member === null && filesHere && linked) return { machine, server: filesHere, kernel: false, via: true };
    if (machine.member === null) return { machine, server: computeServer, kernel: kernelTerms || !computeServer };
    // A member's server: its own terminals when it is a Companion (which has them); a shell in its kernel otherwise.
    const server = machine.compute.kind === 'server' ? serverById(machine.compute.serverId) : undefined;
    return { machine, server, kernel: !server || !isCompanion(server) };
  };
  // Files on one computer and the compute on another: two terminals from the start, one by the files and one on the
  // compute (where the agents and the runs are). Added once a session; a compute tab closed stays closed.
  const seededKey = `pgshells-compute:${playground.id}`;
  useEffect(() => {
    if (!filesHere || shells.some(isComputeTab) || readSession(seededKey, false)) return;
    writeSession(seededKey, true);
    keepShells([...shells, `${playground.id}~${shortId()}${COMPUTE_TAB}`]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesHere?.id, playground.id]);
  const closeShell = (id: string) => {
    const on = shellOn(id);
    if (on.kernel) closeKernelTerminal(id, on.machine.member === null ? undefined : on.machine.scope);
    else if (on.server) forgetTerminal(on.server, id);
    const left = shells.filter((shell) => shell !== id);
    const next = left.length ? left : [`${playground.id}~${shortId()}`];
    keepShells(next);
    if (id === activeShell) setActiveShell(next[Math.max(0, shells.indexOf(id) - 1)] ?? next[0]);
  };
  /** A command, in the project's folder when the page knows it: the agent pane's. */
  const inFolder = (command: string) => (agentFolder ? (machineTools.os === 'windows' ? `cd "${agentFolder}"; ${command}` : `cd '${agentFolder.replace(/'/g, `'\\''`)}' && ${command}`) : command);
  /** A command into the terminal shown below, in the project's folder: the Run button's. */
  const inTerminal = async (command: string) => {
    setShellView('terminal');
    setPanelOpen(true);
    // The folder kept elsewhere: copied over first, so the command runs the code on screen.
    if (split && !(await push())) return;
    const on = shellOn(activeShell);
    if (on.here) {
      // The shell by the files runs it on the compute, its output here; without the link, a terminal on the compute does.
      if (linked) typeInTerminal(activeShell, `${remoteLine(command)}\r`);
      else typeInTerminal(shells.find((id) => isComputeTab(id)) ?? addComputeShell(), `${command}\r`);
      return;
    }
    typeInTerminal(activeShell, `${command}\r`);
  };

  /** A tab shown in a group (the focused one unless said; one past the last splits the editor), the group focused. */
  const show = (key: string, group = focused) => {
    setGroups((list) => {
      const next = group >= list.length ? [...list, { tabs: [], active: null }] : [...list];
      const g = next[Math.min(group, next.length - 1)];
      next[Math.min(group, next.length - 1)] = { tabs: g.tabs.includes(key) ? g.tabs : [...g.tabs, key], active: key };
      return next.slice(0, 2);
    });
    setFocus(Math.min(group, 1));
  };
  const open = async (where: 'home' | 'machine', path: string, at: { group?: number; line?: number } = {}) => {
    const key = `${where}:${path}`;
    const group = at.group ?? focused;
    if (at.line) goTo.current = { group: Math.min(group, 1), line: at.line };
    if (files.some((file) => `${file.where}:${file.path}` === key)) return show(key, group);
    setProblem(null);
    try {
      const text = (await (where === 'home' ? home : machine).read(path)) ?? '';
      setFiles((list) => (list.some((f) => `${f.where}:${f.path}` === key) ? list : [...list, { where, path, text, saved: text }]));
      show(key, group);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };
  // A project started from a paper opens on its README the first time, the paper and its abstract in front.
  useEffect(() => {
    if (playground.start !== 'paper' || readLocal(`reader.pgFirstOpen:${playground.id}`, false)) return;
    void home
      .read('README.md')
      .then((text) => {
        if (text === null) return;
        writeLocal(`reader.pgFirstOpen:${playground.id}`, true);
        void open('home', 'README.md');
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playground.id]);
  // A line asked for (Go to Line, Outline, search, Quick Open), once its editor is there.
  useEffect(() => {
    const want = goTo.current;
    if (!want) return;
    const editor = editors.current[want.group];
    if (!editor) return;
    goTo.current = null;
    window.requestAnimationFrame(() => editor.goToLine(want.line));
  });
  /** A tab closed in a group: asked first when it holds unsaved work shown nowhere else; the file let go when no group shows it. */
  const closeTab = (group: number, key: string, ask = true) => {
    const file = files.find((f) => `${f.where}:${f.path}` === key);
    const elsewhere = groups.some((g, index) => index !== group && g.tabs.includes(key));
    if (ask && file && file.text !== file.saved && !elsewhere && !window.confirm(`${file.path.split('/').pop()} has changes that aren’t saved. Close it and lose them?`)) return false;
    const next = groups.map((g, index) => {
      if (index !== group) return g;
      const at = g.tabs.indexOf(key);
      const tabs = g.tabs.filter((t) => t !== key);
      return { tabs, active: g.active === key ? tabs[Math.min(at, tabs.length - 1)] ?? null : g.active };
    });
    const kept = next.filter((g, index) => g.tabs.length || index === 0 || next.length === 1);
    const merged = kept.length ? kept : [{ tabs: [], active: null }];
    setGroups(merged);
    if (focused >= merged.length) setFocus(merged.length - 1);
    if (!merged.some((g) => g.tabs.includes(key))) {
      setFiles((list) => list.filter((f) => `${f.where}:${f.path}` !== key));
      closed.current = [key, ...closed.current.filter((k) => k !== key)].slice(0, 20);
    }
    return true;
  };
  const closeMany = (group: number, keys: string[]) => {
    for (const key of keys) if (!closeTabRef.current(group, key)) break;
  };
  const closeTabRef = useRef(closeTab);
  closeTabRef.current = closeTab;
  /** A tab moved to the other group (or to a new one on the right). */
  const moveTab = (from: number, key: string, to: number) => {
    if (from === to) return;
    setGroups((list) => {
      let next = list.map((g, index) => {
        if (index !== from) return g;
        const tabs = g.tabs.filter((t) => t !== key);
        return { tabs, active: g.active === key ? tabs[tabs.length - 1] ?? null : g.active };
      });
      if (to >= next.length) next = [...next, { tabs: [], active: null }];
      next[to] = { tabs: next[to].tabs.includes(key) ? next[to].tabs : [...next[to].tabs, key], active: key };
      const kept = next.filter((g) => g.tabs.length);
      return (kept.length ? kept : [{ tabs: [], active: null }]).slice(0, 2);
    });
    setFocus(Math.min(to, 1));
  };
  /** ⌘\\ — the file in front, opened in the other group too (a second one made on the right). */
  const splitRight = () => {
    if (!active) return;
    show(active, groups.length === 1 ? 1 : focused === 0 ? 1 : 0);
  };
  const save = async (file: OpenFile) => {
    setProblem(null);
    try {
      await (file.where === 'home' ? home : machine).write(file.path, file.text);
      setFiles((list) => list.map((f) => (f === file ? { ...f, saved: f.text } : f)));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };
  const fail = (error: unknown) => setProblem(error instanceof Error ? error.message : String(error));
  const newFile = async (dir = '') => {
    const path = window.prompt('A new file — its path in the folder:', dir ? `${dir}/` : 'train.py');
    if (!path?.trim() || path.trim().endsWith('/')) return;
    const clean = path.trim().replace(/^\/+/, '');
    try {
      if ((await home.read(clean).catch(() => null)) === null) await home.write(clean, '');
      setRefresh((n) => n + 1);
      await open('home', clean);
    } catch (error) {
      fail(error);
    }
  };
  const newFolder = async (dir = '') => {
    const path = window.prompt('A new folder — its path in the folder:', dir ? `${dir}/` : 'src');
    const clean = path?.trim().replace(/^\/+|\/+$/g, '');
    if (!clean) return;
    try {
      // A host that can't make an empty folder gets one with a placeholder in it, as git keeps one.
      if (home.mkdir) await home.mkdir(clean);
      else await home.write(`${clean}/.gitkeep`, '');
      setRefresh((n) => n + 1);
    } catch (error) {
      fail(error);
    }
  };
  /** A path renamed in the folder; open tabs of it, or of anything under it, follow. */
  const renamePath = async (from: string) => {
    if (!home.rename) return;
    const to = window.prompt(`Rename ${from} to:`, from)?.trim().replace(/^\/+|\/+$/g, '');
    if (!to || to === from) return;
    try {
      await home.rename(from, to);
      const moved = (key: string) => (key === `home:${from}` ? `home:${to}` : key.startsWith(`home:${from}/`) ? `home:${to}${key.slice(5 + from.length)}` : key);
      setFiles((list) => list.map((f) => (f.where === 'home' ? { ...f, path: moved(`home:${f.path}`).slice(5) } : f)));
      setGroups((list) => list.map((g) => ({ tabs: g.tabs.map(moved), active: g.active ? moved(g.active) : null })));
      setRefresh((n) => n + 1);
    } catch (error) {
      fail(error);
    }
  };
  /** A path deleted from the folder (Drive puts it in its trash), after asking; its tabs close. */
  const removePath = async (path: string, dir: boolean) => {
    if (!home.remove) return;
    const where = playground.home.kind === 'drive' ? ' It goes to your Drive’s trash, where it can be restored for 30 days.' : ' This can’t be undone.';
    if (!window.confirm(`Delete ${dir ? 'the folder ' : ''}${path}${dir ? ' and everything in it' : ''}?${where}`)) return;
    try {
      await home.remove(path);
      const gone = (key: string) => key === `home:${path}` || key.startsWith(`home:${path}/`);
      setFiles((list) => list.filter((f) => !gone(`${f.where}:${f.path}`)));
      setGroups((list) => {
        const next = list.map((g) => {
          const tabs = g.tabs.filter((t) => !gone(t));
          return { tabs, active: g.active && !gone(g.active) ? g.active : tabs[tabs.length - 1] ?? null };
        });
        const kept = next.filter((g, index) => g.tabs.length || index === 0);
        return kept.length ? kept : [{ tabs: [], active: null }];
      });
      setRefresh((n) => n + 1);
    } catch (error) {
      fail(error);
    }
  };
  // The explorer follows the folder, as VS Code's does: a terminal, a run or an agent writes files there too. Read again
  // every few seconds while it shows and the tab is in view — a folder on a computer or the machine cheaply, Drive less often.
  useEffect(() => {
    if (primary !== 'explorer') return;
    const every = playground.home.kind === 'drive' ? 20_000 : 5_000;
    const timer = window.setInterval(() => document.visibilityState === 'visible' && setRefresh((n) => n + 1), every);
    return () => window.clearInterval(timer);
  }, [primary, playground.home.kind]);
  const saveAll = async () => {
    for (const file of filesRef.current) if (file.text !== file.saved) await save(file);
  };
  // Auto Save, as VS Code's afterDelay: a second after the typing stops, what has changed is saved.
  useEffect(() => {
    if (!settings.autoSave || !files.some((f) => f.text !== f.saved)) return;
    const timer = window.setTimeout(() => void saveAll(), 1000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, settings.autoSave]);

  const push = async () => {
    setSyncing('push');
    setProblem(null);
    try {
      // Unsaved edits first: what is sent is what is on screen.
      for (const file of files) if (file.where === 'home' && file.text !== file.saved) await save(file);
      // Linked: the Companion sends what changed, as one archive, straight to the machine.
      const done = linked && filesHere ? await pushThroughCompanion(filesHere, homeRoot).then((r) => ({ sent: r.sent, skipped: r.big, back: [] })) : await pushFolder(playground, machine);
      setReport({ ...done, at: Date.now(), what: 'push' });
      return true;
    } catch (error) {
      setProblem(`Copying to ${machineName}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      setSyncing(null);
    }
  };
  const pull = async () => {
    setSyncing('pull');
    try {
      const done = await pullBack(playground, machine);
      setReport({ ...done, at: Date.now(), what: 'pull' });
      if (done.back.length) setRefresh((n) => n + 1);
    } catch (error) {
      setProblem(`Bringing back from ${machineName}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSyncing(null);
    }
  };

  // What the idle stop does before it stops the runtime: bring the results back, when they are copied.
  if (!mounted && playground.home.kind !== 'machine') beforeIdleStop.set(playground.id, pull);
  else beforeIdleStop.delete(playground.id);

  /** The folder on the machine, as an absolute path the shell can cd into: the small kernel's start, joined to the folder. */
  const folderOnMachine = async (machine?: ProjectMachine) => {
    if (machine && machine.member !== null) {
      // A pool member's: asked of its own kernel, and kept.
      const kept = memberBases.current[machine.scope];
      if (kept) return kept;
      const answer = await runQuietly(`import os\nprint(os.path.abspath(${JSON.stringify(machineRoot(playground))}))`, machine.scope);
      const found = answer?.ok ? answer.text.trim().split('\n').pop() ?? null : null;
      if (found) memberBases.current[machine.scope] = found;
      return found ?? machineRoot(playground);
    }
    if (base) return base;
    const answer = await runQuietly(`import os\nprint(os.path.abspath(${JSON.stringify(machineRoot(playground))}))`);
    const found = answer?.ok ? answer.text.trim().split('\n').pop() ?? null : null;
    if (found) setBase(found);
    return found ?? machineRoot(playground);
  };

  // Mounted: the notebook's kernel works in the project's folder there, as the console does — `import mymodule` and
  // relative paths in a cell find the project. Once per kernel (a restart starts it in the machine's home again).
  const preparedFor = useRef('');
  useEffect(() => {
    if (!mounted || !connected || !colab.kernel) return;
    const key = `${colab.kernel}|${linkKey}|${mountEpoch}`;
    if (preparedFor.current === key) return;
    preparedFor.current = key;
    void (async () => {
      const folder = await folderOnMachine();
      // By path, never relative to where the kernel is: that may be a mount since replaced, which no longer answers.
      const ok = await prepareNotebook(`import os as _os, sys as _sys\n_d = ${JSON.stringify(folder)}\nif _os.path.isdir(_d):\n    _os.chdir(_d)\n    _sys.path.insert(0, _d) if _d not in _sys.path else None\ndel _os, _sys, _d`);
      if (!ok) preparedFor.current = '';
    })();
  }, [mounted, connected, colab.kernel, linkKey, mountEpoch]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The koios helper written to a machine's folder, once per machine in this tab, so `import koios` works there. */
  const ensureHelper = async (m: ProjectMachine) => {
    const host = m.member === null ? machine : machineHostFor(playground, m);
    // The data place, written each time: the link to Drive is renewed as the project stays open (src/lib/dataStore.ts).
    await host.write(dataConfigPath, JSON.stringify(dataFor(await folderOnMachine(m.member === null ? undefined : m)).config)).catch(() => undefined);
    if (helperOn.current.has(m.scope)) return;
    await host.write(KOIOS_HELPER_PATH, KOIOS_PY);
    await host.write(dataModulePath, KOIOS_DATA_PY);
    // The simulation telemetry beside it, so `import koios_telemetry` works in any project's commands (src/sim/).
    await host.write(`${KOIOS_PYLIB}/${TELEMETRY_FILE}`, KOIOS_TELEMETRY_PY);
    await host.write(`${KOIOS_PYLIB}/${CATALOGUE_FILE}`, catalogueJson());
    helperOn.current.add(m.scope);
  };
  /** One command on one machine of the project: its own kernel connected if need be, the folder copied over when it is kept elsewhere, the command run there, results brought back. */
  const runOn = async (m: ProjectMachine, entry: ConsoleEntry, trimmed: string, world: number, extra: Record<string, string> = {}) => {
    // In a pool the command is told its place, so one script can take its seed or slice by KOIOS_RANK.
    const place = pooled ? poolEnv(m, world) : {};
    if (m.member === null) {
      if (!connected) {
        try {
          await connect();
        } catch {
          return;
        }
      }
      // Mounted: the machine has the folder as it is here — only the edits on screen need saving.
      if (split && mounted) for (const file of files) if (file.where === 'home' && file.text !== file.saved) await save(file);
      if (split && !mounted && !(await push())) return;
      const folder = await folderOnMachine();
      await ensureHelper(m).catch(() => undefined);
      const env = { ...place, KOIOS_PYLIB: `${folder}/${KOIOS_PYLIB}`, ...dataFor(folder).env, ...extra };
      // Logged on the machine as it runs, so the project picked up from another computer shows it from the start.
      const log = runLogPath(folder, entry.id);
      await runCell(consoleKey(playground.id, entry.id), shellCell(folder, trimmed, env, log), { log });
      if (split && !mounted) await pull();
      return;
    }
    if (!m.backend) {
      setProblem(`${m.label} isn’t connected to this browser.`);
      return;
    }
    try {
      if (!isConnected(sessionOf(sessionsNow(), m.scope))) await connectIn(m.backend, m.scope);
      // The folder kept elsewhere: copied to this machine first (the edits on screen were saved by `run`).
      if (split) await pushFolder(playground, machineHostFor(playground, m));
      const folder = await folderOnMachine(m);
      await ensureHelper(m).catch(() => undefined);
      const env = { ...place, KOIOS_PYLIB: `${folder}/${KOIOS_PYLIB}`, ...dataFor(folder).env, ...extra };
      const log = runLogPath(folder, entry.id);
      await runCellFor(m.backend, m.scope, memberKey(consoleKey(playground.id, entry.id), m.member), shellCell(folder, trimmed, env, log), { log });
      if (split) await pullBack(playground, machineHostFor(playground, m));
    } catch (error) {
      setProblem(`${m.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** The command a machine that went away was running, run again — there or on another machine — from its last checkpoint (KOIOS_RESUME, which koios.resume takes up). */
  const resume = async () => {
    if (!gone?.checkpoint || !gone.entry) return;
    const on = (resumeOn === 'same' ? machines.find((m) => m.scope === gone.machine.scope) : machines.find((m) => (m.member ?? 'first') === resumeOn)) ?? machines[0];
    const entry: ConsoleEntry = { id: uid(), command: gone.entry.command, at: Date.now(), ...(on.member ? { machine: on.member } : {}) };
    updatePlayground(playground.id, (p) => ({ console: [...p.console, entry].slice(-40) }));
    setGone(null);
    setPanelOpen(true);
    setShellView('commands');
    await runOn(on, entry, gone.entry.command, 1, { KOIOS_RESUME: gone.checkpoint.path });
    setRefresh((n) => n + 1);
  };

  const run = async (text: string): Promise<ConsoleEntry | null> => {
    const trimmed = text.trim();
    if (!trimmed || targets.some(runningOn)) return null;
    setProblem(null);
    const entry: ConsoleEntry = { id: uid(), command: trimmed, at: Date.now(), ...(target !== 'first' ? { machine: target } : {}) };
    updatePlayground(playground.id, (p) => ({ console: [...p.console, entry].slice(-40), pending: p.pending === trimmed ? undefined : p.pending }));
    setCommand('');
    // Unsaved edits first, once: what is sent to every machine is what is on screen.
    if (split) for (const file of files) if (file.where === 'home' && file.text !== file.saved) await save(file);
    // On all machines at once: each gets the command in its own kernel, side by side.
    await Promise.all(targets.map((machine) => runOn(machine, entry, trimmed, targets.length)));
    setRefresh((n) => n + 1);
    return entry;
  };
  /** A command run for the page's agent: in the console as any other, on the machine (the first of a pool), its output handed back once it ends. */
  const runForAgent = async (command: string): Promise<AgentRun> => {
    setPanelOpen(true);
    setShellView('commands');
    const entry = await run(command);
    if (!entry) return { command, output: targets.some(runningOn) ? 'The console is busy with another command; wait for it, or stop it.' : '', state: 'not run' };
    const done = colabNow().runs[consoleKey(playground.id, entry.id)];
    if (!done) return { command, output: 'The command could not be started on the machine — is it connected?', state: 'not run' };
    return { command, output: outputText(done.outputs), state: done.state === 'ran' ? 'ran' : done.state === 'interrupted' ? 'interrupted' : done.state === 'failed' ? 'failed' : 'not run' };
  };

  const plan = current ? runPlan(current.path, terminalHere ? projectFolder : null, machineTools) : null;
  const runFile = async () => {
    if (!current || !plan || !('command' in plan)) return;
    if (current.text !== current.saved) await save(current);
    if (terminalHere) inTerminal(plan.command);
    else void run(plan.command);
  };

  const consoleCells = playground.console.flatMap((entry, index) => entryRuns(playground.id, machines, entry).map(({ key, machine }) => ({ key, id: entry.id, label: `command ${index + 1}${pooled ? ` · machine ${machine.rank}` : ''}` })));
  const nbCells = useSyncExternalStore(subscribeNotebook, () => notebookFor(notebookKey(playground.id)));
  // Where the Sim pane reads runs from beside the machine (kept stable: it restarts its reading when this changes).
  const keptRuns = useMemo(() => keptRunsHost(playground, home), [playground, home]);
  // A file named on the Explain page: opened here as the Files tab comes back (mounted then, or kept from before).
  useEffect(() => {
    const take = () => {
      const path = openFromExplain.get(playground.id);
      if (!path) return;
      openFromExplain.delete(playground.id);
      void open('home', path);
    };
    take();
    const onAsk = (event: Event) => (event as CustomEvent<{ id: string }>).detail?.id === playground.id && take();
    window.addEventListener(OPEN_FROM_EXPLAIN, onAsk);
    return () => window.removeEventListener(OPEN_FROM_EXPLAIN, onAsk);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playground.id]);
  const metricCells = useMemo(
    () => [
      ...playground.console.flatMap((entry, index) =>
        entryRuns(playground.id, machines, entry).map(({ key, machine }) => {
          const run = colab.runs[key];
          return { key, id: entry.id, label: `$ ${entry.command.slice(0, 32)}${entry.command.length > 32 ? '…' : ''} (${index + 1}${pooled ? ` · m${machine.rank}` : ''})`, text: run ? run.outputs.map((o) => ('text' in o ? o.text : '')).join('') : '', at: run?.startedAt ?? entry.at };
        }),
      ),
      ...(nbCells?.cells ?? [])
        .map((cell, index) => ({ cell, index }))
        .filter(({ cell }) => cell.type === 'code')
        .map(({ cell, index }) => {
          const run = colab.runs[runKey(cell.id)];
          return { key: runKey(cell.id), id: cell.id, label: `cell ${index + 1}`, text: run ? run.outputs.map((o) => ('text' in o ? o.text : '')).join('') : '', at: run?.startedAt ?? 0 };
        }),
    ],
    [playground.console, colab.runs, nbCells, playground.id, machines, pooled],
  );

  /** Whether a run key is a machine's: a pool member's end in `@` and its id; the first machine's (the notebook's cells, its commands) have no `@`. */
  const onMachine = (key: string, m: ProjectMachine) => (m.member === null ? !key.includes('@') : key.endsWith(`@${m.member}`));
  /** Each machine's session for its Runtime pane, with only its own runs, so the ruler and the peaks are that machine's. */
  const paneStates = useMemo(() => {
    const map = new Map<string, (typeof sessions)[number]>();
    if (!pooled) return map;
    for (const m of machines) {
      const state = m.member === null ? colab : sessionOf(sessions, m.scope);
      if (state) map.set(m.scope, { ...state, runs: Object.fromEntries(Object.entries(state.runs).filter(([key]) => onMachine(key, m))) });
    }
    return map;
  }, [pooled, machines, colab, sessions]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = current ? current.text !== current.saved : false;
  // The newest command in view from its top: what was typed, then what it printed.
  const consoleLog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const last = consoleLog.current?.querySelector<HTMLElement>('.pg-console-entry:last-of-type');
    if (last && consoleLog.current) consoleLog.current.scrollTop = last.offsetTop - 4;
  }, [playground.console.length]);

  const cited = playground.cites.map((cite) => papers.find((paper) => paper.id === cite.paperId)).find(Boolean);
  // A project from a paper has a Project on the Projects page, whose logbook its runs are filed in: made now when it has none.
  useEnsureProject(cited?.id, playground);
  // The paper's Implementation page, when it has one: the plan goes with the agent's requests.
  // Read again when the browser's database moves to the signed-in account's.
  const dbName = useSyncExternalStore(subscribeDb, currentDbName);
  useEffect(() => {
    if (cited) void loadImplementation(cited.id);
  }, [cited?.id, dbName]);
  const paperPlan = useSyncExternalStore(subscribeImplement, () => (cited ? implementationFor(cited.id)?.content : undefined));
  // The paper itself in the folder — paper/paper.md (its full text), paper/EXPLANATION.md, paper/paper.pdf — so every agent reads
  // it there and none goes looking for it online. Once per project open, and again before an agent is asked anything.
  const paperFiling = useRef<{ key: string; done: Promise<void> } | null>(null);
  const [paperNote, setPaperNote] = useState<string | null>(null);
  const ensurePaper = useCallback((): Promise<void> => {
    if (!cited) return Promise.resolve();
    const key = `${playground.id}:${cited.id}`;
    if (paperFiling.current?.key === key) return paperFiling.current.done;
    const done = ensurePaperContext(home, cited, { drive: { clientId: readerSettings.googleClientId, folderName: readerSettings.driveFolderName, connected: driveOn } })
      .then((report) => {
        if (report.wrote.length) setRefresh((n) => n + 1);
        setPaperNote(report.missing.length ? paperContextSummary(report) : null);
      })
      .catch((error: unknown) => {
        paperFiling.current = null;
        setPaperNote(`The paper’s files couldn’t be put in the folder: ${error instanceof Error ? error.message : String(error)}`);
      });
    paperFiling.current = { key, done };
    return done;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cited?.id, home, playground.id, readerSettings.googleClientId, readerSettings.driveFolderName, driveOn]);
  useEffect(() => {
    if (cited) void ensurePaper();
  }, [cited?.id, ensurePaper]);
  /**
   * The Implementation page's plan in the folder as IMPLEMENTATION_PLAN.md, whenever there is one: every agent's briefing
   * sends it there, whether the project was started from the plan or the agent was simply asked to build it. Written
   * again when the plan changes (a revision on the Implementation page), never while it is still being written.
   */
  const ensurePlan = async () => {
    if (!cited) return;
    const entry = (await loadImplementation(cited.id).catch(() => undefined)) ?? implementationFor(cited.id);
    if (!entry?.content.trim() || entry.streaming) return;
    const text = planMarkdown({ title: cited.title, authors: cited.authors, published: cited.published, abstract: cited.abstract, plan: entry.content });
    const before = await home.read(PLAN_FILE).catch(() => null);
    if (before === text) return;
    await home.write(PLAN_FILE, text);
    tookAgentFiles([{ path: PLAN_FILE, before, after: text, ...lineDelta(before, text) }]);
  };
  useEffect(() => {
    if (paperPlan) void ensurePlan().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperPlan, playground.id, home]);
  // A project from a paper starts with the model choosing and writing its files, until that is done or put aside.
  const startKey = `reader.pgStart:${playground.id}`;
  const [startState, setStartState] = useState(() => readLocal<'done' | 'dismissed' | null>(startKey, null));
  const settleStart = (state: 'done' | 'dismissed') => (setStartState(state), writeLocal(startKey, state));
  const agentChat = useSyncExternalStore(subscribeAgent, () => agentChatFor(playground.id));
  useEffect(() => {
    if (playground.start === 'paper') void loadAgentChats(playground.id, home).catch(() => undefined);
  }, [playground.id, home]);
  const wroteBefore = agentChat.turns.some((turn) => turn.role === 'agent' && turn.changes?.length);
  const showStart = playground.start === 'paper' && !startState && !wroteBefore && Boolean(cited);
  /** The project as the agent reads it: the folder's files, the ones open, the last commands and what they printed. */
  const agentView = async (): Promise<ProjectView> => ({
    where: `Files kept in ${homeLabel}; code runs on ${machineName}${split ? ', the folder copied there before each command' : ''}.`,
    paper: cited ? { title: cited.title, authors: cited.authors, published: cited.published, abstract: cited.abstract, plan: paperPlan, fullText: (await ensurePaper().then(() => home.read(PAPER_TEXT_FILE)).catch(() => null)) ?? undefined } : undefined,
    listing: await listAll(home),
    open: files.filter((file) => file.where === 'home').map((file) => ({ path: file.path, text: file.text, active: `${file.where}:${file.path}` === active, unsaved: file.text !== file.saved })),
    console: playground.console.slice(-4).map((entry) => {
      const done = colab.runs[consoleKey(playground.id, entry.id)];
      return { command: entry.command, output: done ? done.outputs.map((o) => ('text' in o ? o.text : '')).join('') : '', state: done ? done.state : 'output not in this tab' };
    }),
  });
  /** Files the agent wrote (or put back): open ones take the new text unless edited here, and the explorer reads the folder again. */
  const tookAgentFiles = (changes: AgentChange[]) => {
    setFiles((list) => list.map((file) => {
      const change = file.where === 'home' ? changes.find((c) => c.path === file.path) : undefined;
      return change?.after !== undefined && file.text === file.saved ? { ...file, text: change.after, saved: change.after } : file;
    }));
    setRefresh((n) => n + 1);
    const first = changes.find((c) => c.after);
    if (first && !files.length) void open('home', first.path);
  };

  /** Claude Code or Codex writes the project: the paper and the plan put in the folder for it, and the request queued in its pane, sent once it is installed and signed in. */
  const writeWithCli = async (agent: 'claude' | 'codex') => {
    if (!cited) return;
    await ensurePaper();
    const text = planMarkdown({ title: cited.title, authors: cited.authors, published: cited.published, abstract: cited.abstract, plan: paperPlan });
    try {
      const before = await home.read(PLAN_FILE).catch(() => null);
      await home.write(PLAN_FILE, text);
      tookAgentFiles([{ path: PLAN_FILE, before, after: text, ...lineDelta(before, text) }]);
    } catch (error) {
      alert(`${PLAN_FILE} couldn’t be written to the folder: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    queueCliRequest(playground.id, agent, cliWriteRequest(Boolean(paperPlan)));
    setAgentMode(agent);
    setRightTab('agent');
    setAgentOpen(true);
    settleStart('dismissed');
  };
  // An answer the agent was writing on the server when this page was last left — reloaded, closed, cut off: joined, its files landing here.
  const resumeTried = useRef<string | null>(null);
  useEffect(() => {
    if (resumeTried.current === playground.id || !savedJob(playground.id)) return;
    resumeTried.current = playground.id;
    setAgentMode('reader');
    setRightTab('agent');
    setAgentOpen(true);
    void resumeAgentJob({ projectId: playground.id, host: home, view: agentView, onWrote: tookAgentFiles }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playground.id, home]);

  /** Open files read again from the folder, where they aren't being edited here: an agent or a run wrote them. */
  const reloadOpen = async () => {
    for (const file of filesRef.current) {
      if (file.text !== file.saved) continue;
      const disk = await (file.where === 'home' ? home : machine).read(file.path).catch(() => null);
      if (disk !== null && disk !== file.saved) setFiles((list) => list.map((f) => (f.where === file.where && f.path === file.path && f.text === f.saved ? { ...f, text: disk, saved: disk } : f)));
    }
  };
  /** Before Claude Code or Codex works: what is on screen saved, and the folder copied to the machine when it is kept elsewhere. */
  const beforeAgentRun = async () => {
    await saveAll();
    // The paper's files in the folder before the agent reads it, so it never has to go and find the paper.
    await ensurePaper();
    await ensurePlan().catch(() => undefined);
    // The helpers on the machine before the agent starts, as before a console command: `python koios_telemetry.py use …` works from its shell.
    if (connected && machines[0]) await ensureHelper(machines[0]).catch(() => undefined);
    return split ? push() : true;
  };
  /** While it works: its edits brought home a few seconds after each (when the folder is kept elsewhere) and the open files read again, so the editor follows it; one pull at a time, and never while a push is on. */
  const liveEdit = useRef<{ timer: number | null; busy: boolean; again: boolean }>({ timer: null, busy: false, again: false });
  const onAgentEdit = () => {
    const live = liveEdit.current;
    if (live.timer !== null) return;
    live.timer = window.setTimeout(async () => {
      live.timer = null;
      if (live.busy) {
        live.again = true;
        return;
      }
      live.busy = true;
      try {
        if (split) await pullEdits(playground, machine).catch(() => undefined);
        setRefresh((n) => n + 1);
        await reloadOpen();
      } finally {
        live.busy = false;
        if (live.again) {
          live.again = false;
          onAgentEdit();
        }
      }
    }, 2500);
  };
  /** After: what it changed on the machine brought home (when the folder is kept elsewhere), and the explorer and open files read again. */
  const afterAgentRun = async () => {
    if (split) {
      try {
        const done = await pullEdits(playground, machine);
        setReport({ ...done, at: Date.now(), what: 'pull' });
      } catch (error) {
        setProblem(`Bringing the agent’s changes back from ${machineName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    setRefresh((n) => n + 1);
    await reloadOpen();
  };
  // Back to the editor when a box closes — unless another has opened since (⇧⌘P, Esc, ⌘P in a row).
  const focusEditor = () => window.requestAnimationFrame(() => !document.querySelector('.vs-pick') && editors.current[focused]?.focus());
  const commands: WorkbenchCommand[] = [
    { id: 'files', label: 'Go to File…', keys: 'mod+p', run: () => setPick('') },
    { id: 'line', label: 'Go to Line/Column…', keys: 'ctrl+g', run: () => setPick(':') },
    { id: 'symbol', label: 'Go to Symbol in Editor…', keys: 'mod+shift+o', run: () => setPick('@') },
    { id: 'find', label: 'Find', keys: 'mod+f', run: () => editors.current[focused]?.openFind() },
    { id: 'replace', label: 'Replace', keys: isMac ? 'mod+alt+f' : 'ctrl+h', run: () => editors.current[focused]?.openFind(true) },
    { id: 'findFiles', label: 'Search: Find in Files', keys: 'mod+shift+f', run: () => setPrimary('search') },
    { id: 'newFile', label: 'File: New File…', run: () => void newFile() },
    { id: 'newFolder', label: 'File: New Folder…', run: () => void newFolder() },
    { id: 'save', label: 'File: Save', keys: 'mod+s', run: () => current && void save(current) },
    { id: 'saveAll', label: 'File: Save All', keys: 'mod+alt+s', run: () => void saveAll() },
    { id: 'autoSave', label: `File: ${settings.autoSave ? 'Turn Off' : 'Turn On'} Auto Save`, run: () => setSettings({ autoSave: !settings.autoSave }) },
    { id: 'close', label: 'View: Close Editor', keys: 'alt+w', run: () => active && closeTab(focused, active) },
    { id: 'closeAll', label: 'View: Close All Editors in Group', run: () => closeMany(focused, groups[focused]?.tabs ?? []) },
    { id: 'reopen', label: 'View: Reopen Closed Editor', keys: 'alt+shift+t', run: () => closed.current[0] && void open(closed.current[0].startsWith('home:') ? 'home' : 'machine', closed.current[0].slice(closed.current[0].indexOf(':') + 1)) },
    { id: 'split', label: 'View: Split Editor Right', keys: 'mod+\\', run: splitRight },
    { id: 'group1', label: 'View: Focus First Editor Group', keys: 'mod+1', run: () => (setFocus(0), focusEditor()) },
    { id: 'group2', label: 'View: Focus Second Editor Group', keys: 'mod+2', run: () => (groups.length > 1 ? (setFocus(1), focusEditor()) : splitRight()) },
    { id: 'sidebar', label: 'View: Toggle Primary Side Bar', keys: 'mod+b', run: () => setPrimary(primary ? null : 'explorer') },
    { id: 'explorer', label: 'View: Show Explorer', keys: 'mod+shift+e', run: () => setPrimary('explorer') },
    { id: 'outline', label: 'View: Show Outline', run: () => setPrimary('outline') },
    { id: 'panel', label: 'View: Toggle Panel', keys: 'mod+j', run: () => setPanelOpen(!panelOpen) },
    { id: 'terminal', label: 'View: Toggle Terminal', keys: 'ctrl+`', run: () => (setPanelOpen(!panelOpen || view !== 'terminal'), setShellView('terminal')) },
    { id: 'newTerminal', label: 'Terminal: Create New Terminal', keys: 'ctrl+shift+`', run: () => (setPanelOpen(true), setShellView('terminal'), addShell()) },
    { id: 'agent', label: 'View: Toggle Agent', keys: 'ctrl+alt+i', run: () => toggleRight('agent') },
    { id: 'runtimePane', label: 'View: Show Runtime', run: () => (setRightTab('runtime'), setAgentOpen(true)) },
    { id: 'metricsPane', label: 'View: Show Metrics', run: () => (setRightTab('metrics'), setAgentOpen(true)) },
    { id: 'simPane', label: 'View: Show Simulation Runs', run: () => (setRightTab('sim'), setAgentOpen(true)) },
    { id: 'tensorboard', label: 'View: Show TensorBoard', run: () => (setRightTab('tensorboard'), setAgentOpen(true)) },
    { id: 'claudeCode', label: 'Agent: Claude Code', run: () => (setAgentMode('claude'), setRightTab('agent'), setAgentOpen(true)) },
    { id: 'codex', label: 'Agent: Codex', run: () => (setAgentMode('codex'), setRightTab('agent'), setAgentOpen(true)) },
    { id: 'zen', label: 'View: Toggle Zen Mode', keys: 'mod+k z', run: () => setZen(!zen) },
    { id: 'minimap', label: 'View: Toggle Minimap', run: () => setSettings({ minimap: !settings.minimap }) },
    { id: 'zoomIn', label: 'View: Editor Font Bigger', keys: 'mod+=', run: () => setSettings({ fontSize: Math.min(24, settings.fontSize + 1) }) },
    { id: 'zoomOut', label: 'View: Editor Font Smaller', keys: 'mod+-', run: () => setSettings({ fontSize: Math.max(10, settings.fontSize - 1) }) },
    { id: 'zoomReset', label: 'View: Reset Editor Font Size', keys: 'mod+0', run: () => setSettings({ fontSize: DEFAULT_EDITOR.fontSize }) },
    ...(current && plan && 'command' in plan ? [{ id: 'run', label: `Run: ${plan.command}`, keys: 'mod+enter', run: () => void runFile() }] : []),
    ...(split ? [{ id: 'push', label: `Sync: Copy the Folder to ${machineName}`, run: () => void push() }, { id: 'pull', label: `Sync: Bring Results Back from ${machineName}`, run: () => void pull() }] : []),
    { id: 'refresh', label: 'Explorer: Refresh', run: () => setRefresh((n) => n + 1) },
    { id: 'newChat', label: 'Agent: New Chat', run: () => (setAgentOpen(true), clearAgentChat(playground.id, home)) },
    ...(vscodeAt ? [{ id: 'vscode', label: 'Open in VS Code (in the page)', run: () => updatePlayground(playground.id, () => ({ editor: 'vscode' })) }] : []),
  ];
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  // The workbench's keys, VS Code's, while the page is on it: taken before the site's own (⌘J, ⌘\\ mean the panel and split here).
  const chord = useRef(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (pick !== null || !root.current) return;
      const target = document.activeElement;
      if (target && target !== document.body && !root.current.contains(target)) return;
      if (target instanceof HTMLElement && target.closest('.xterm') && !(event.metaKey || event.ctrlKey)) return;
      const parts = [event.ctrlKey && !isMac ? 'mod' : event.ctrlKey ? 'ctrl' : '', event.metaKey && isMac ? 'mod' : '', event.altKey ? 'alt' : '', event.shiftKey ? 'shift' : ''].filter(Boolean);
      const key = event.code === 'Backquote' ? '`' : event.code === 'Backslash' ? '\\' : event.code === 'Equal' ? '=' : event.code === 'Minus' ? '-' : event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : event.code.startsWith('Digit') ? event.code.slice(5) : event.key === 'Enter' ? 'enter' : event.key === 'F1' ? 'F1' : '';
      if (!key) return;
      const combo = [...parts, key].join('+');
      if (chord.current) {
        chord.current = false;
        const hit = commandsRef.current.find((c) => c.keys === `mod+k ${combo}`);
        if (hit) {
          event.preventDefault();
          event.stopPropagation();
          hit.run();
        }
        return;
      }
      if (combo === 'mod+k') {
        chord.current = true;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (combo === 'mod+shift+p' || combo === 'F1') {
        event.preventDefault();
        event.stopPropagation();
        setPick('>');
        return;
      }
      // ⌘F and ⌘H inside the editor are its own (it opens its find bar); from anywhere else in the workbench, the focused editor's.
      const inEditor = target instanceof HTMLTextAreaElement && target.classList.contains('ce-text');
      const hit = commandsRef.current.find((c) => c.keys === combo && !(inEditor && (c.id === 'find' || c.id === 'replace')));
      if (!hit) return;
      event.preventDefault();
      event.stopPropagation();
      hit.run();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pick]);
  // Zen mode leaves with Escape, as VS Code's does with a second press.
  useEffect(() => {
    if (!zen) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !document.querySelector('.ce-find') && setZen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zen]);
  const symbols = useMemo(() => (current ? symbolsOf(current.text, current.path) : []), [current?.text, current?.path]);

  if (vscodeAt && playground.editor === 'vscode') {
    return <VsCodePane server={vscodeAt.server} folder={vscodeAt.folder} playground={playground} />;
  }

  // The files on a Companion of yours and the code elsewhere, linked: an agent can run in a terminal *by the files*,
  // editing them where they are, and reach the compute with `koios run` — rather than on the machine's copy.
  const agentsHere = Boolean(filesHere && linked);
  const cliAgents = Boolean((terminals && computeServer && isCompanion(computeServer)) || agentsHere);
  const mode: AgentMode = agentMode === 'unset' ? (agentsHere ? 'cli' : 'claude') : agentMode === 'cli' && !cliAgents ? 'claude' : agentMode;
  const copyNote = split ? `, on its copy of the folder; its edits come back to ${homeLabel} when it finishes` : '';
  const agentChoices: { id: AgentMode; label: string; mark: string; title: string }[] = [
    { id: 'claude', label: 'Claude Code', mark: '✳', title: `Anthropic’s Claude Code, on ${machineName}${copyNote}, signed in to your account` },
    { id: 'codex', label: 'Codex', mark: '◎', title: `OpenAI’s Codex, on ${machineName}${copyNote}, signed in to your account` },
    { id: 'reader', label: 'Koios AI', mark: '✦', title: 'The page’s own agent, answered by the model you pick in Settings → AI' },
    ...(cliAgents ? [{ id: 'cli' as const, label: agentsHere ? `On ${filesHere!.name}` : 'Terminal', mark: '$', title: agentsHere ? `Claude Code, Codex or any agent with a command line, in a terminal on ${filesHere!.name} by the files: it edits them where they are, and runs on ${machineName} with koios run` : `Any agent with a command line, in a terminal on ${machineName}` }] : []),
  ];
  const homeFolder = agentsHere ? absoluteFolder(filesHere, homeRoot) : null;
  const inHomeFolder = (command: string) => (homeFolder ? (homeTools.os === 'windows' ? `cd "${homeFolder}"; ${command}` : `cd '${homeFolder.replace(/'/g, `'\\''`)}' && ${command}`) : command);
  const hereBriefing = agentsHere
    ? `You are in the project's folder on ${filesHere!.name}, where its files are kept; its code runs on ${machineName}. Edit the files here, where they are. Run anything that needs that machine — training, evaluation, the GPU, a simulator — with \`koios run <command>\`: it copies the files changed since the last push over, runs the command there in the project's folder, and prints its output here. \`koios shell\` opens a shell there; \`koios pull <path>\` brings files from there here (runs/, results/); \`koios status\` says whether it can be reached. Quick checks can run here. Koios's simulation toolkit: \`python koios_telemetry.py simulators\` lists 31 simulators, \`python koios_telemetry.py use <simulator> [env]\` writes env.py and setup.sh (run setup.sh there: koios run bash setup.sh); runs logged through koios_telemetry.Run show in the Sim pane and are filed as experiments. Read AGENTS.md when there is one.${cited ? ` ${PAPER_FILES_NOTE}` : ''} ${DATA_NOTE(dataFor(machineRoot(playground)).label)}`
    : undefined;
  const sideKey = mode === 'cli' ? 'agent' : 'side';
  const views: { id: Primary; label: string; icon: React.ReactNode; keys?: string; hidden?: boolean }[] = [
    { id: 'explorer', label: 'Explorer', icon: <FilesGlyph />, keys: 'mod+shift+e' },
    { id: 'search', label: 'Search', icon: <SearchIcon size={19} />, keys: 'mod+shift+f' },
    { id: 'outline', label: 'Outline', icon: <OutlineGlyph /> },
    { id: 'sync', label: `Sync with ${machineName}`, icon: <SyncGlyph />, hidden: !split },
  ];
  const togglePrimary = (id: Primary) => setPrimary(primary === id ? null : id);
  const fileOf = (key: string | null) => (key ? files.find((f) => `${f.where}:${f.path}` === key) ?? null : null);
  const canEdit = { rename: Boolean(home.rename), remove: Boolean(home.remove) };
  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => undefined);
  const openMenu = (event: React.MouseEvent, items: (MenuItem | 'sep')[]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };
  /** The explorer's right-click menu, on a file, a folder, or the empty space under them. */
  const explorerMenu = (event: React.MouseEvent, entry: { path: string; dir: boolean } | null) => {
    const dir = entry ? (entry.dir ? entry.path : entry.path.split('/').slice(0, -1).join('/')) : '';
    openMenu(event, [
      ...(entry && !entry.dir ? [{ label: 'Open', run: () => void open('home', entry.path) }, { label: 'Open to the Side', run: () => void open('home', entry.path, { group: groups.length === 1 ? 1 : focused === 0 ? 1 : 0 }) }, 'sep' as const] : []),
      { label: 'New File…', run: () => void newFile(dir) },
      { label: 'New Folder…', run: () => void newFolder(dir) },
      ...(entry
        ? [
            'sep' as const,
            { label: 'Copy Path', run: () => copy(entry.path) },
            'sep' as const,
            { label: 'Rename…', run: () => void renamePath(entry.path), disabled: !canEdit.rename },
            { label: 'Delete', run: () => void removePath(entry.path, entry.dir), disabled: !canEdit.remove, danger: true },
          ]
        : ['sep' as const, { label: 'Refresh', run: () => setRefresh((n) => n + 1) }]),
    ]);
  };
  const tabMenu = (event: React.MouseEvent, group: number, key: string) => {
    const tabs = groups[group]?.tabs ?? [];
    const at = tabs.indexOf(key);
    const file = fileOf(key);
    openMenu(event, [
      { label: 'Close', keys: keyLabel('alt+w'), run: () => closeTab(group, key) },
      { label: 'Close Others', run: () => closeMany(group, tabs.filter((t) => t !== key)), disabled: tabs.length < 2 },
      { label: 'Close to the Right', run: () => closeMany(group, tabs.slice(at + 1)), disabled: at === tabs.length - 1 },
      { label: 'Close Saved', run: () => closeMany(group, tabs.filter((t) => { const f = fileOf(t); return f && f.text === f.saved; })) },
      { label: 'Close All', run: () => closeMany(group, tabs) },
      'sep',
      { label: 'Copy Path', run: () => file && copy(file.path) },
      { label: 'Reveal in Explorer', run: () => setPrimary('explorer') },
      'sep',
      groups.length === 1 ? { label: 'Split Right', keys: keyLabel('mod+\\'), run: () => show(key, 1) } : { label: `Move to the ${group === 0 ? 'Right' : 'Left'} Group`, run: () => moveTab(group, key, group === 0 ? 1 : 0) },
    ]);
  };

  /** One editor group: its tabs, the breadcrumbs, the editor; a drop target for a tab dragged from the other. */
  const renderGroup = (g: EditorGroupState, index: number) => {
    const file = fileOf(g.active);
    const isFocused = index === focused;
    const fileDirty = file ? file.text !== file.saved : false;
    const filePlan = file ? runPlan(file.path, terminalHere ? projectFolder : null, machineTools) : null;
    const path = file ? symbolPath(isFocused ? symbols : symbolsOf(file.text, file.path), isFocused ? cursor?.line ?? 1 : 1) : [];
    return (
      <section
        key={index}
        className={`vs-group${isFocused ? ' is-focused' : ''}`}
        style={groups.length > 1 ? { flexBasis: `${index === 0 ? splitAt : 100 - splitAt}%` } : undefined}
        onMouseDown={() => index !== focused && setFocus(index)}
        onDragOver={(event) => dragging && event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (dragging) moveTab(dragging.group, dragging.key, index);
          setDragging(null);
        }}
      >
        <div className="pg-tabs vs-tabs" role="tablist" aria-label={groups.length > 1 ? `Editor group ${index + 1}` : 'Open editors'}>
          {g.tabs.map((key) => {
            const tab = fileOf(key);
            if (!tab) return null;
            const dirtyTab = tab.text !== tab.saved;
            return (
              <span
                key={key}
                className={`pg-tab vs-tab${key === g.active ? ' is-on' : ''}${dirtyTab ? ' is-dirty' : ''}`}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', tab.path);
                  setDragging({ group: index, key });
                }}
                onDragEnd={() => setDragging(null)}
                onAuxClick={(event) => event.button === 1 && closeTab(index, key)}
                onContextMenu={(event) => tabMenu(event, index, key)}
              >
                <button type="button" role="tab" aria-selected={key === g.active} onClick={() => show(key, index)} title={`${tab.where === 'home' ? homeLabel : machineName} · ${tab.path}`}>
                  <FileIcon path={tab.path} />
                  {tab.where === 'machine' ? '⇣ ' : ''}
                  {tab.path.split('/').pop()}
                </button>
                <button type="button" className="pg-tab-x" aria-label={`Close ${tab.path}`} title={`Close (${keyLabel('alt+w')})`} onClick={() => closeTab(index, key)}>
                  <span className="vs-dot" aria-hidden="true">●</span>
                  <span className="vs-x" aria-hidden="true">×</span>
                </button>
              </span>
            );
          })}
          <span className="vs-tabs-fill" />
          {file ? (
            <span className="vs-tab-actions">
              {filePlan ? (
                <button
                  type="button"
                  className="vs-action is-run"
                  disabled={!('command' in filePlan) || !usable}
                  onClick={() => (setFocus(index), void runFile())}
                  title={'command' in filePlan ? `${filePlan.command}${asked ? '' : ` (${machineName} couldn’t say what is installed: this is a guess)`} — ${keyLabel('mod+enter')}` : `Running ${filePlan.language} needs ${filePlan.missing} on ${machineName}`}
                  aria-label="Run the file"
                >
                  ▶
                </button>
              ) : null}
              <button type="button" className="vs-action" onClick={() => (setFocus(index), groups.length === 1 ? show(g.active!, 1) : show(g.active!, index === 0 ? 1 : 0))} title={`Split Editor Right (${keyLabel('mod+\\')})`} aria-label="Split the editor">
                <SplitGlyph />
              </button>
              <button type="button" className="vs-action" onClick={(event) => openMenu(event, [
                { label: 'Close All', run: () => closeMany(index, g.tabs) },
                { label: 'Close Saved', run: () => closeMany(index, g.tabs.filter((t) => { const f = fileOf(t); return f && f.text === f.saved; })) },
                'sep',
                { label: settings.minimap ? 'Hide Minimap' : 'Show Minimap', run: () => setSettings({ minimap: !settings.minimap }) },
                { label: settings.autoSave ? 'Turn Off Auto Save' : 'Turn On Auto Save', run: () => setSettings({ autoSave: !settings.autoSave }) },
              ])} title="More Actions…" aria-label="More actions">
                ⋯
              </button>
            </span>
          ) : null}
        </div>
        {file ? (
          <div className="vs-crumbs">
            {[file.where === 'home' ? homeLabel : machineName, ...file.path.split('/')].map((part, i, all) => (
              <span key={`${i}-${part}`} className={`${i === all.length - 1 ? 'is-file' : ''}${i === all.length - 1 && !path.length ? ' is-last' : ''}`} title={part}>
                {i === all.length - 1 ? <FileIcon path={part} /> : null}
                <span className="vs-crumb-text">{part}</span>
              </span>
            ))}
            {path.map((symbol, i) => (
              <button key={`${symbol.line}-${symbol.name}`} type="button" className={`vs-crumb-sym is-${symbol.kind}${i === path.length - 1 ? ' is-last' : ''}`} onClick={() => (setFocus(index), setPick('@'))} title="Go to Symbol in Editor">
                <SymbolMark kind={symbol.kind} />
                <span className="vs-crumb-text">{symbol.name}</span>
              </button>
            ))}
            <span className="spacer" />
            <button type="button" className="vs-action" disabled={!fileDirty} onClick={() => void save(file)} title={keyLabel('mod+s')}>
              {fileDirty ? 'Save' : settings.autoSave ? 'Auto Save' : 'Saved'}
            </button>
            {vscodeHere && index === groups.length - 1 ? <EditorSwitch playground={playground} /> : null}
          </div>
        ) : null}
        <div className="vs-editor">
          {file ? (
            <CodeEditor
              key={g.active!}
              ref={(handle) => (editors.current[index] = handle)}
              value={file.text}
              path={file.path}
              fontSize={settings.fontSize}
              minimap={settings.minimap}
              onChange={(text) => (noteEdit(), setFiles((list) => list.map((f) => (f.where === file.where && f.path === file.path ? { ...f, text } : f))))}
              peers={peersByPath.get(file.path)}
              onCursor={isFocused ? setCursor : undefined}
              onFocus={() => setFocus(index)}
            />
          ) : (
            <div className="pg-editor-empty vs-welcome">
              <b>{playground.title}</b>
              <dl className="vs-keys">
                {[
                  ['Show All Commands', 'mod+shift+p'],
                  ['Go to File', 'mod+p'],
                  ['Find in Files', 'mod+shift+f'],
                  ['Toggle Panel', 'mod+j'],
                  ['Toggle Agent', 'ctrl+alt+i'],
                ].map(([label, combo]) => (
                  <Fragment key={label}>
                    <dt>{label}</dt>
                    <dd>
                      <kbd>{keyLabel(combo)}</kbd>
                    </dd>
                  </Fragment>
                ))}
              </dl>
              <div className="vs-welcome-keys">
                <button type="button" className="link" onClick={() => void newFile()}>
                  New file…
                </button>
                <button type="button" className="link" onClick={() => setPick('')}>
                  Open a file…
                </button>
                <button type="button" className="link" onClick={() => setAgentOpen(true)}>
                  Ask the agent
                </button>
                {vscodeHere ? <EditorSwitch playground={playground} /> : null}
              </div>
              <p className="pg-note">
                {playground.home.kind === 'server'
                  ? `The folder is ${playground.home.root} on ${serverById(playground.home.serverId)?.name ?? 'the server'} — a plain folder: edit it in any editor too.`
                  : playground.home.kind === 'drive'
                    ? `The files are kept in your Google Drive, in Papers_collection/Playgrounds/${playground.home.folder}${split ? `, and copied onto ${machineName} before each command` : ''}.`
                    : playground.home.kind === 'machine'
                      ? playground.compute.kind === 'colab'
                        ? 'The files are on the Colab runtime’s disk: they go when it stops. Change the machine to keep them in Drive.'
                        : `The files are on ${machineName}.`
                      : 'These files are still kept in this browser: move them out from the banner above.'}
              </p>
            </div>
          )}
          {dragging && groups.length === 1 ? (
            <div
              className="vs-drop-split"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                moveTab(dragging.group, dragging.key, 1);
                setDragging(null);
              }}
            >
              Drop to split right
            </div>
          ) : null}
        </div>
        {file && onDisk && onDisk.key === `${file.where}:${file.path}` ? (
          <div className="pg-banner pg-disk-banner">
            {file.path.split('/').pop()} changed in its folder while you were editing it here.
            <button type="button" className="btn sm" onClick={() => (setFiles((list) => list.map((f) => (f === file ? { ...f, text: onDisk.text, saved: onDisk.text } : f))), setOnDisk(null))}>
              Load it
            </button>
            <button type="button" className="btn sm ghost" onClick={() => ((dismissed.current = onDisk), setOnDisk(null))} title="Keep what is here; Save writes it over the folder's">
              Keep mine
            </button>
          </div>
        ) : null}
      </section>
    );
  };

  const openEditors = groups.flatMap((g, index) => g.tabs.map((key) => ({ key, group: index })));

  return (
    <div className={`vs-shell${zen ? ' is-zen' : ''}`} ref={root}>
      {gone ? (
        <div className="pg-banner is-problem pg-gone" role="alert">
          <span className="pg-gone-text">
            <b>{gone.machine.member === null ? machineName : gone.machine.label} disconnected</b> at {new Date(gone.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {gone.reason ? ` — ${gone.reason.replace(/\.$/, '')}` : ''}. What was running there stopped with it.{' '}
            {gone.checkpoint ? (
              <>
                Last checkpoint: <b>step {gone.checkpoint.step ?? '?'}</b>
                {gone.checkpoint.at ? ` at ${gone.checkpoint.at.replace(/^\d{4}-\d{2}-\d{2}T/, '').replace(/[+-]\d{4}$/, '')}` : ''} · <code>{gone.checkpoint.path.split('/').pop()}</code>
                {gone.checkpoint.reason === 'stop' ? ' · saved as the machine stopped' : ''}
                {gone.checkpoint.metrics && Object.keys(gone.checkpoint.metrics).length ? ` · ${Object.entries(gone.checkpoint.metrics).slice(0, 3).map(([k, v]) => `${k} ${Number(v).toPrecision(3)}`).join(', ')}` : ''}. It is on that machine's disk: resume there when it is back, or elsewhere if the checkpoint folder is one they share.
              </>
            ) : (
              <>No checkpoint was reported by its runs. A script that uses the koios helper (import koios; see docs/compute-continuity.md) saves one on a cadence and as the machine stops.</>
            )}
          </span>
          {gone.checkpoint && gone.entry ? (
            <>
              <select className="pg-console-target" value={resumeOn} onChange={(event) => setResumeOn(event.target.value)} aria-label="Where to resume">
                <option value="same">on the same machine</option>
                {machines.filter((m) => m.scope !== gone.machine.scope).map((m) => (
                  <option key={m.scope} value={m.member ?? 'first'}>
                    on {m.rank} · {m.label}
                  </option>
                ))}
              </select>
              <button type="button" className="btn sm primary" onClick={() => void resume()} title={`Runs the command again with KOIOS_RESUME=${gone.checkpoint.path}`}>
                ▶ Resume from step {gone.checkpoint.step ?? '?'}
              </button>
            </>
          ) : null}
          <button type="button" className="icon-btn sm" aria-label="Dismiss" onClick={() => setGone(null)}>
            <CloseIcon size={13} />
          </button>
        </div>
      ) : null}
      <div
        className={`pg-files vs-work${layout.big ? ` is-big-${layout.big}` : ''}${!panelOpen ? ' is-panel-closed' : ''}`}
        style={{ '--pg-tree-w': `${Math.max(layout.tree, 200)}px`, '--pg-side-w': `${layout[sideKey]}px`, '--pg-console-h': `${layout.console}%` } as React.CSSProperties}
      >
        {!zen ? (
          <nav className="vs-activity" aria-label="Views">
            {views
              .filter((v) => !v.hidden)
              .map((v) => (
                <button key={v.id} type="button" className={`vs-act${primary === v.id ? ' is-on' : ''}`} aria-pressed={primary === v.id} onClick={() => togglePrimary(v.id)} title={`${v.label}${v.keys ? ` (${keyLabel(v.keys)})` : ''}`} aria-label={v.label}>
                  {v.icon}
                </button>
              ))}
            <span className="spacer" />
            {vscodeHere ? (
              <button type="button" className="vs-act" onClick={() => updatePlayground(playground.id, () => ({ editor: 'vscode' }))} title="Open in VS Code — the VS Code on that computer, in the page, with your extensions" aria-label="Open in VS Code">
                <VsCodeMark />
              </button>
            ) : null}
            <button type="button" className="vs-act" onClick={() => setPick('>')} title={`Command Palette (${keyLabel('mod+shift+p')})`} aria-label="Command palette">
              <PaletteGlyph />
            </button>
            <span className="vs-act-sep" aria-hidden="true" />
            <button type="button" className={`vs-act${agentOpen && rightTab === 'runtime' ? ' is-on is-right' : ''}`} aria-pressed={agentOpen && rightTab === 'runtime'} onClick={() => toggleRight('runtime')} title="Runtime — GPU, memory, disk (in the right-hand pane)" aria-label="Runtime">
              <GaugeGlyph />
            </button>
            <button type="button" className={`vs-act${agentOpen && rightTab === 'metrics' ? ' is-on is-right' : ''}`} aria-pressed={agentOpen && rightTab === 'metrics'} onClick={() => toggleRight('metrics')} title="Metrics the runs print (in the right-hand pane)" aria-label="Metrics">
              <ChartIcon size={19} />
            </button>
            <button type="button" className={`vs-act${agentOpen && rightTab === 'tensorboard' ? ' is-on is-right' : ''}`} aria-pressed={agentOpen && rightTab === 'tensorboard'} onClick={() => toggleRight('tensorboard')} title="TensorBoard’s scalars (in the right-hand pane)" aria-label="TensorBoard">
              <TbGlyph />
            </button>
            <button type="button" className={`vs-act${agentOpen && rightTab === 'sim' ? ' is-on is-right' : ''}`} aria-pressed={agentOpen && rightTab === 'sim'} onClick={() => toggleRight('sim')} title="Simulation runs — episodes, videos, dreams (in the right-hand pane)" aria-label="Simulation">
              <SimGlyph />
            </button>
            <button type="button" className={`vs-act is-agent${agentOpen && rightTab === 'agent' ? ' is-on is-right' : ''}`} aria-pressed={agentOpen && rightTab === 'agent'} onClick={() => toggleRight('agent')} title={`The agent — Claude Code, Codex (${keyLabel('ctrl+alt+i')})`} aria-label="The agent">
              <SparkleIcon size={19} />
            </button>
          </nav>
        ) : null}
        {primary && !zen ? (
          <aside className="pg-tree vs-sidebar">
            <div className="vs-side-title">
              <span>{views.find((v) => v.id === primary)?.label.split(' —')[0]}</span>
              {primary === 'explorer' ? (
                <>
                  <button type="button" className="icon-btn sm" onClick={() => void newFile()} title="New File…" aria-label="New file">
                    <PlusIcon size={14} />
                  </button>
                  <button type="button" className="icon-btn sm" onClick={() => void newFolder()} title="New Folder…" aria-label="New folder">
                    <FolderPlusGlyph />
                  </button>
                  <button type="button" className="icon-btn sm" onClick={() => setRefresh((n) => n + 1)} title="Refresh Explorer" aria-label="Refresh">
                    ↻
                  </button>
                </>
              ) : null}
            </div>
            {primary === 'explorer' ? (
              <div className="vs-explorer" onContextMenu={(event) => explorerMenu(event, null)}>
                {openEditors.length ? (
                  <OpenEditors
                    items={openEditors.map(({ key, group }) => ({ key, group, file: fileOf(key) })).filter((item): item is { key: string; group: number; file: OpenFile } => Boolean(item.file))}
                    split={groups.length > 1}
                    activeKey={active}
                    focusedGroup={focused}
                    onShow={(key, group) => show(key, group)}
                    onClose={(key, group) => closeTab(group, key)}
                  />
                ) : null}
                <Tree version={refresh} host={home} label={homeLabel} icon={playground.home.kind === 'drive' ? <DriveMark size={12} /> : undefined} onOpen={(path) => void open('home', path)} activePath={current?.where === 'home' ? current.path : null} onContext={explorerMenu} />
                {split ? (
                  // The machine's copy is a working copy: the files go over before each run and the runtime's disk goes with the
                  // runtime; what a run writes there (runs/, results/) is what comes back. Folded, so it doesn't read as a second set of files.
                  <Tree version={refresh + (connected ? 1000 : 0)} host={machine} label={`Working copy on ${machineName}`} note={connected ? `Sent before each run, gone with the runtime. What runs write here — runs/, results/ — comes back to ${homeLabel}.` : 'Connect to see the working copy on the machine.'} disabled={!connected} onOpen={(path) => void open('machine', path)} activePath={current?.where === 'machine' ? current.path : null} collapsed />
                ) : null}
              </div>
            ) : primary === 'search' ? (
              <SearchView host={home} onOpen={(path, line) => void open('home', path, { line })} />
            ) : primary === 'outline' ? (
              <OutlineView file={current} symbols={symbols} line={cursor?.line ?? 1} onGo={(line) => editors.current[focused]?.goToLine(line)} />
            ) : primary === 'sync' && split ? (
              <SyncPane playground={playground} homeLabel={homeLabel} machineName={machineName} report={report} syncing={syncing} connected={connected} onPush={() => void push()} onPull={() => void pull()} mount={filesHere ? { known: mountKnown, linked, on: wantMount, mounted, busy: mounting.busy, words: mounting.words, problem: mounting.problem, awake: Boolean(link?.mount?.keepingAwake), computer: filesHere.name, set: (on) => void setMount(on) } : undefined} filesComputer={homeServer && isCompanion(homeServer) ? homeServer : undefined} folder={homeServer?.root ? `${homeServer.root.replace(/\/+$/, '')}/${homeRoot}` : homeRoot} />
            ) : null}
          </aside>
        ) : null}
        {primary && !zen ? (
          <Gutter
            axis="x"
            label="The side bar’s width"
            onStart={() => (dragFrom.current = layout)}
            onMove={(delta) => {
              const width = dragFrom.current.tree + delta;
              if (width < TREE_FOLD) setPrimary(null);
              else setLayout({ tree: width });
            }}
            onReset={() => setLayout({ tree: DEFAULT_LAYOUT.tree })}
          />
        ) : null}
        <section className="pg-center" ref={centerBox}>
          {showStart && cited ? (
            <div className="pg-write-wrap">
              <ProjectStart
                projectId={playground.id}
                host={home}
                machineName={machineName}
                paperTitle={cited.title}
                hasPlan={Boolean(paperPlan)}
                view={agentView}
                onWriting={() => (setAgentMode('reader'), setRightTab('agent'), setAgentOpen(true))}
                onWrote={(changes) => {
                  tookAgentFiles(changes);
                  const first = changes.find((c) => c.path === 'main.py' && c.after) ?? changes.find((c) => c.after && !/\.md$/.test(c.path));
                  if (first) void open('home', first.path);
                }}
                onDone={() => settleStart('done')}
                onDismiss={() => settleStart('dismissed')}
                onCli={(agent) => void writeWithCli(agent)}
              />
            </div>
          ) : null}
          <div className={`vs-groups${groups.length > 1 ? ' is-split' : ''}`} ref={groupsBox} hidden={showStart}>
            {renderGroup(groups[0], 0)}
            {groups.length > 1 ? (
              <Gutter
                axis="x"
                label="The editor groups’ widths"
                onStart={() => (splitFrom.current = splitAt)}
                onMove={(delta) => setSplitAt(Math.min(85, Math.max(15, splitFrom.current + (delta / Math.max(1, groupsBox.current?.clientWidth ?? 1)) * 100)))}
                onReset={() => setSplitAt(50)}
              />
            ) : null}
            {groups.length > 1 ? renderGroup(groups[1], 1) : null}
          </div>
          {problem ? (
            <p className="pg-note is-problem vs-problem">
              {problem}
              <button type="button" className="icon-btn sm" aria-label="Dismiss" onClick={() => setProblem(null)}>
                <CloseIcon size={12} />
              </button>
            </p>
          ) : null}
          {dataOffer ? (
            <p className="pg-note vs-offer">
              <span>
                <b>{dataOffer.server.name}</b> has {Math.round(dataOffer.free / 1024 ** 3)} GB free. Keep this project’s data — datasets, checkpoints, run outputs — there instead of Google Drive? The code still runs on {machineName}; its disk is only a cache either way.
              </span>
              <button type="button" className="btn sm primary" onClick={() => settleOffer('server')}>
                Use {dataOffer.server.name}
              </button>
              <button type="button" className="btn sm" onClick={() => settleOffer('drive')}>
                Keep Google Drive
              </button>
              <button type="button" className="icon-btn sm" aria-label="Not now" onClick={() => settleOffer('later')}>
                <CloseIcon size={12} />
              </button>
            </p>
          ) : null}
          {panelOpen && !zen && layout.big !== 'console' ? (
            <Gutter
              axis="y"
              label="The panel’s height"
              onStart={() => (dragFrom.current = layout)}
              onMove={(delta) => setLayout({ console: dragFrom.current.console - (delta / Math.max(1, centerBox.current?.clientHeight ?? 1)) * 100 })}
              onReset={() => setLayout({ console: DEFAULT_LAYOUT.console })}
            />
          ) : null}
          <div className={`pg-console vs-panel${view === 'terminal' ? ' is-terminal' : ''}`} hidden={!panelOpen || zen}>
            <div className="pg-console-head vs-panel-head">
              <div className="vs-panel-tabs" role="tablist" aria-label="Panel">
                <button type="button" role="tab" aria-selected={view === 'terminal'} className={view === 'terminal' ? 'is-on' : ''} onClick={() => setShellView('terminal')} title={kernelTerms ? `A shell on ${machineName}, run through its kernel` : `A shell on ${machineName}`}>
                  Terminal
                </button>
                <button type="button" role="tab" aria-selected={view === 'commands'} className={view === 'commands' ? 'is-on' : ''} onClick={() => setShellView('commands')}>
                  {split ? 'Copy & run' : 'Console'}
                </button>
              </div>
              {view === 'terminal' ? (
                <div className="pg-shell-tabs" role="tablist" aria-label="Terminals">
                  {shells.map((id, index) => (
                    <span key={id} className={`pg-shell-tab${id === activeShell ? ' is-on' : ''}`}>
                      <button type="button" role="tab" aria-selected={id === activeShell} onClick={() => setActiveShell(id)} title={filesHere && shellOn(id).machine.member === null ? (shellOn(id).here ? `Terminal ${index + 1}: on ${filesHere.name}, in the folder where the code is kept` : `Terminal ${index + 1}: on ${machineName}, where the code runs (and the agents work)`) : pooled ? `Terminal ${index + 1}, on machine ${shellOn(id).machine.rank}: ${shellOn(id).machine.label}` : undefined}>
                        {index + 1}
                        {filesHere && shellOn(id).machine.member === null ? <small className="pg-shell-on">{shellOn(id).here ? 'files' : playground.compute.kind === 'colab' ? 'colab' : 'compute'}</small> : pooled ? <small className="pg-shell-on">m{shellOn(id).machine.rank}</small> : null}
                      </button>
                      {shells.length > 1 ? (
                        <button type="button" className="pg-tab-x" aria-label={`Close terminal ${index + 1}`} title="Close this terminal (its shell ends)" onClick={() => closeShell(id)}>
                          ×
                        </button>
                      ) : null}
                    </span>
                  ))}
                  {pooled || filesHere ? (
                    <span className="menu-wrap" ref={addShellBox}>
                      <button type="button" className="icon-btn sm" onClick={() => setAddShellMenu(!addShellMenu)} aria-haspopup="menu" aria-expanded={addShellMenu} aria-label="A new terminal, on one of the machines" title="New Terminal — on which machine">
                        +
                      </button>
                      {addShellMenu ? (
                        <div className="menu pg-chip-menu" role="menu">
                          <div className="menu-label">A terminal on</div>
                          {filesHere ? (
                            <button type="button" role="menuitem" onClick={() => (setAddShellMenu(false), addShell(null))} title="A shell by the files: koios run, koios shell and koios pull reach the compute from it">
                              <span className="pg-shell-on">here</span> {filesHere.name} — the files
                            </button>
                          ) : null}
                          {machines.map((m) => (
                            <button key={m.scope} type="button" role="menuitem" onClick={() => (setAddShellMenu(false), m.member === null && filesHere ? addComputeShell() : addShell(m.member))}>
                              <MachineMark compute={m.compute} /> {pooled ? `${m.rank} · ` : ''}
                              {m.member === null ? machineName : m.label}
                              {m.member === null && filesHere && linked ? <small className="pg-menu-note"> through {filesHere.name}</small> : null}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </span>
                  ) : (
                    <button type="button" className="icon-btn sm" onClick={() => addShell()} aria-label="A new terminal" title={`New Terminal (${keyLabel('ctrl+shift+`')})`}>
                      +
                    </button>
                  )}
                </div>
              ) : null}
              {view === 'terminal' && filesHere && shellOn(activeShell).here ? (
                <span className="vs-panel-where" title={`${filesHere.name}:${homeRoot}${linked ? ` — koios run, koios shell and koios pull reach ${machineName} from here` : ''}`}>
                  <span className="vs-panel-machine">{filesHere.name}</span>
                  <span className="vs-panel-sep" aria-hidden="true">›</span>
                  <span className="vs-panel-folder">{homeRoot.split('/').filter(Boolean).pop()}</span>
                  {linked ? <span className="vs-panel-link">⇄ {machineName}</span> : null}
                </span>
              ) : (
                <span className="vs-panel-where" title={`${machineName}:${base ?? machineRoot(playground)}`}>
                  <span className="vs-panel-machine">{machineName}</span>
                  <span className="vs-panel-sep" aria-hidden="true">›</span>
                  <span className="vs-panel-folder">{(base ?? machineRoot(playground)).split('/').filter(Boolean).pop()}</span>
                </span>
              )}
              <span className="spacer" />
              {split && mounted ? (
                <span className="vs-copy-chip is-mounted" title={`Your code is kept in ${homeLabel} and mounted on ${machineName} through the Companion's tunnel: a save here is there at once, and what a run writes there is written here. Checkpoints and data (the project's rules) stay on the machine and go to the data place.`}>
                  <SyncGlyph />
                  <span>Mounted on {machineName.split(' · ')[0]}</span>
                  <b>⇄ live</b>
                </span>
              ) : split ? (
                <button
                  type="button"
                  className={`vs-copy-chip${syncing === 'push' ? ' is-busy' : ''}`}
                  disabled={!connected || Boolean(syncing)}
                  onClick={() => void push()}
                  title={`Your code is kept in ${homeLabel}, and runs on ${machineName} from a copy of the folder there. This sends the files you changed to that copy now. ▶ Run, Copy & run and the agents send them by themselves before they run anything, so you need it only for a command you type into the compute's terminal yourself.`}
                >
                  <SyncGlyph />
                  <span>Send code to {machineName.split(' · ')[0]}</span>
                  <b>{syncing === 'push' ? 'Sending…' : report?.what === 'push' && Date.now() - report.at < 60_000 ? `✓ ${report.sent.length ? `${report.sent.length} ${report.sent.length === 1 ? 'file' : 'files'} sent` : 'up to date'}` : '↑ Send now'}</b>
                </button>
              ) : null}
              {view === 'commands' && machines.some((m) => runningOn(m)?.startsWith('pgsh:')) ? (
                <button type="button" className="btn sm colab-stop" title={pooled ? 'Stops the command on every machine it runs on' : undefined} onClick={() => void Promise.all(machines.filter((m) => runningOn(m)?.startsWith('pgsh:')).map((m) => (m.member === null ? interrupt() : interruptIn(m.scope))))}>
                  ■ Stop
                </button>
              ) : null}
              <button type="button" className={`icon-btn sm${layout.big === 'console' ? ' is-on' : ''}`} onClick={() => setLayout({ big: layout.big === 'console' ? null : 'console' })} aria-pressed={layout.big === 'console'} title={layout.big === 'console' ? 'Restore Panel Size' : 'Maximize Panel Size'} aria-label={layout.big === 'console' ? 'Restore the panel' : 'Maximise the panel'}>
                {layout.big === 'console' ? '⤡' : '⤢'}
              </button>
              <button type="button" className="icon-btn sm" onClick={() => (setPanelOpen(false), layout.big === 'console' && setLayout({ big: null }))} aria-label="Hide the panel" title={`Hide Panel (${keyLabel('mod+j')})`}>
                <CloseIcon size={13} />
              </button>
            </div>
            {view === 'terminal'
              ? shells.map((id) => {
                  const on = shellOn(id);
                  const first = on.machine.member === null;
                  const label = first ? machineName : on.machine.label;
                  const up = first ? connected : isConnected(sessionOf(sessions, on.machine.scope));
                  return (
                    <div key={id} className="pg-terminal-slot" hidden={id !== activeShell}>
                      {on.kernel || !on.server ? (
                        <KernelTerminal name={id} cwd={machineRoot(playground)} label={label} connected={up} playgroundId={playground.id} scope={first ? undefined : on.machine.scope} />
                      ) : (
                        <Terminal server={on.server} cwd={on.here || on.via ? homeRoot : machineRoot(playground)} sessionId={id} label={on.here ? on.server.name : on.via ? `${machineName} (through ${on.server.name})` : label} playgroundId={playground.id} first={on.via ? `${COMPUTE_SHELL}\r` : undefined} />
                      )}
                    </div>
                  );
                })
              : null}
            <div className="pg-console-log" ref={consoleLog} hidden={view === 'terminal'}>
              {playground.console.slice(-12).map((entry) => {
                const runsOf = entryRuns(playground.id, machines, entry);
                return (
                  <div key={entry.id} className="pg-console-entry">
                    <div className="pg-console-cmd">
                      <span className="pg-prompt">$</span> {entry.command}
                      {pooled ? <span className="pg-console-on">{entry.machine === 'all' ? `all ${runsOf.length} machines` : `machine ${runsOf[0]?.machine.rank ?? 0}`}</span> : null}
                      <button type="button" className="link" onClick={() => setCommand(entry.command)} title="Put it in the box again">
                        again
                      </button>
                    </div>
                    {runsOf.map(({ key, machine }) => {
                      const runNow = colab.runs[key];
                      return (
                        <div key={key} className={runsOf.length > 1 ? 'pg-console-one' : undefined}>
                          {runsOf.length > 1 ? (
                            <div className="pg-console-which">
                              <MachineMark compute={machine.compute} /> machine {machine.rank} · {machine.label}
                            </div>
                          ) : null}
                          {runNow ? <CellRunOutput run={runNow} onForget={() => forgetRun(key)} /> : <div className="pg-note">ran {new Date(entry.at).toLocaleString()} — the output was in that tab</div>}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <form
              hidden={view === 'terminal'}
              className="pg-console-input"
              onSubmit={(event) => {
                event.preventDefault();
                void run(command);
              }}
            >
              <span className="pg-prompt">$</span>
              <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={`A command, run in a shell on ${target === 'all' ? `all ${machines.length} machines` : targets[0].member === null ? machineName : targets[0].label} — python main.py, pip install …, nvidia-smi`} spellCheck={false} aria-label="A command" disabled={!usable} />
              {pooled ? (
                <select className="pg-console-target" value={target} onChange={(event) => setTarget(event.target.value)} aria-label="Which machine the command runs on" title="Which machine the command runs on. On all: every machine gets it at once, told its rank as KOIOS_RANK (0, 1, …) and the count as KOIOS_WORLD, so one script can take its own seed, config or slice of the data.">
                  {machines.map((m) => (
                    <option key={m.scope} value={m.member ?? 'first'}>
                      on {m.rank} · {m.label}
                    </option>
                  ))}
                  <option value="all">on all {machines.length} machines</option>
                </select>
              ) : null}
              <button type="submit" className="btn sm primary" disabled={!usable || !command.trim() || targets.some(runningOn)}>
                {split ? 'Copy & run' : 'Run'}
              </button>
            </form>
          </div>
        </section>
        {agentOpen && !zen ? (
          <Gutter
            axis="x"
            className="is-side"
            label="The agent’s width"
            onStart={() => (dragFrom.current = layout)}
            onMove={(delta) => setLayout({ [sideKey]: dragFrom.current[sideKey] - delta, big: null })}
            onReset={() => setLayout({ [sideKey]: DEFAULT_LAYOUT[sideKey], big: null })}
          />
        ) : null}
        {agentOpen && !zen ? (
          <aside className={`nb-side pg-side-pane vs-agent vs-right${rightTab === 'agent' && mode === 'cli' ? ' is-agent' : ''}`}>
            <div className="vs-agent-head vs-right-tabs" role="tablist" aria-label="The right-hand pane">
              {RIGHT_TABS.map((tab) => (
                <button key={tab.id} type="button" role="tab" aria-selected={rightTab === tab.id} className={rightTab === tab.id ? 'is-on' : ''} onClick={() => setRightTab(tab.id)} title={tab.title}>
                  {tab.label}
                </button>
              ))}
              <span className="spacer" />
              <button type="button" className={`icon-btn sm${layout.big === 'side' ? ' is-on' : ''}`} onClick={() => setLayout({ big: layout.big === 'side' ? null : 'side' })} aria-pressed={layout.big === 'side'} title={layout.big === 'side' ? 'Back to its width' : 'Give the pane most of the width'} aria-label={layout.big === 'side' ? 'Restore the pane' : 'Widen the pane'}>
                {layout.big === 'side' ? '⤡' : '⤢'}
              </button>
              <button type="button" className="icon-btn sm" onClick={() => setAgentOpen(false)} aria-label="Close the pane">
                <CloseIcon size={14} />
              </button>
            </div>
            <KeepTab id="agent" active={rightTab}>
              <>
                <div className="vs-agent-pick" role="radiogroup" aria-label="Which agent">
                  {agentChoices.map((choice) => (
                    <button key={choice.id} type="button" role="radio" aria-checked={mode === choice.id} className={mode === choice.id ? 'is-on' : ''} onClick={() => setAgentMode(choice.id)} title={choice.title}>
                      <span className={`cli-badge is-${choice.id} is-sm`}>{choice.mark}</span>
                      {choice.label}
                    </button>
                  ))}
                </div>
                {paperNote ? <p className="pg-note pg-agent-note">{paperNote}</p> : null}
                {mode === 'cli' ? (
                  agentsHere ? (
                    <AgentPane server={filesHere} machineName={filesHere!.name} agents={homeTools.agents} asked={asked} cwd={homeRoot} inFolder={inHomeFolder} playgroundId={playground.id} os={homeTools.os} briefing={hereBriefing} note={`By the files, on ${filesHere!.name}: the agent edits them where they are. Anything for ${machineName} — training, the GPU — it runs with koios run; results come back with koios pull. Claude Code is told this; tell another agent in your first message.`} />
                  ) : (
                    <AgentPane server={computeServer} machineName={machineName} agents={machineTools.agents} asked={asked} cwd={machineRoot(playground)} inFolder={inFolder} playgroundId={playground.id} os={machineTools.os} />
                  )
                ) : mode === 'claude' || mode === 'codex' ? (
                  <CliAgent
                    key={mode}
                    agent={mode}
                    projectId={playground.id}
                    host={home}
                    machineName={machineName}
                    folder={machineRoot(playground)}
                    paper={Boolean(cited)}
                    extraEnv={dataFor(machineRoot(playground)).env}
                    dataNote={DATA_NOTE(dataFor(machineRoot(playground)).label)}
                    connected={connected}
                    onConnect={() => void connect().catch(() => undefined)}
                    beforeRun={beforeAgentRun}
                    afterRun={() => void afterAgentRun()}
                    onEdit={onAgentEdit}
                    onOpen={(path) => void open('home', path)}
                  />
                ) : (
                  <ProjectAgent
                    projectId={playground.id}
                    host={home}
                    machineName={machineName}
                    view={agentView}
                    context={{ active: current?.path, open: files.length, commands: Math.min(4, playground.console.length), paper: cited?.title }}
                    onOpen={(path) => void open('home', path)}
                    onRun={(line) => {
                      setPanelOpen(true);
                      if (terminalHere) inTerminal(line);
                      else void run(line);
                    }}
                    onWrote={tookAgentFiles}
                    run={runForAgent}
                    interrupt={() => void interrupt().catch(() => undefined)}
                  />
                )}
              </>
            </KeepTab>
            <KeepTab id="runtime" active={rightTab}>
              {              pooled ? (
                <div className="pg-pool-panes">
                  {machines.map((m) => {
                    const first = m.member === null;
                    const pane = paneStates.get(m.scope);
                    const up = first ? connected : isConnected(pane);
                    return (
                      <section key={m.scope} className="pg-pool-pane">
                        <h4 className="pg-pool-pane-head">
                          <MachineMark compute={m.compute} /> machine {m.rank} · {first && connected ? machineName : m.label}
                        </h4>
                        {up && pane ? <RuntimePane cells={consoleCells.filter((cell) => onMachine(cell.key, m))} onGoTo={() => undefined} session={pane} /> : <p className="pg-note pg-pad">Not connected. Its chip in the row above connects it, or a command run on it does.</p>}
                      </section>
                    );
                  })}
                </div>
              ) : connected ? (
                <RuntimePane cells={consoleCells} onGoTo={() => undefined} />
              ) : (
                <p className="pg-note pg-pad">Connect from the bar, or run a command, and {machineName} is read here: GPU, memory, disk, live.</p>
              )
              }
            </KeepTab>
            <KeepTab id="metrics" active={rightTab}>
              <MetricsPane cells={metricCells} running={colab.running} />
            </KeepTab>
            <KeepTab id="sim" active={rightTab}>
              <SimPane folder={machineRoot(playground)} connected={connected} machineName={machineName} busy={colab.status === 'busy'} server={computeServer} playgroundId={playground.id} kept={keptRuns} />
            </KeepTab>
            <KeepTab id="tensorboard" active={rightTab}>
              <TensorBoardPane folder={machineRoot(playground)} connected={connected} machineName={machineName} busy={colab.status === 'busy'} />
            </KeepTab>
          </aside>
        ) : null}
      </div>
      <ExperimentFiler playground={playground} folder={machineRoot(playground)} connected={connected} />
      {zen ? (
        <button type="button" className="vs-zen-exit" onClick={() => setZen(false)}>
          Zen mode · Esc to leave
        </button>
      ) : (
        <footer className="vs-status" aria-label="Status">
          <span className={`vs-status-item is-machine is-${connected ? 'on' : colab.status === 'connecting' ? 'busy' : 'off'}`} title={`Runs on ${machineName}`}>
            <span className="colab-dot" aria-hidden="true" /> {machineName}
            {colab.status === 'busy' ? ' · running' : connected ? '' : ' · not connected'}
          </span>
          {playground.home.kind !== 'machine' ? (
            <span className="vs-status-item" title="Where the files are kept">
              {playground.home.kind === 'drive' ? <DriveMark size={11} /> : null} {homeLabel}
            </span>
          ) : null}
          {split ? (
            <>
              <button type="button" className="vs-status-item is-btn" disabled={!connected || Boolean(syncing)} onClick={() => void push()} title={`Copy the folder to ${machineName}`}>
                {syncing === 'push' ? 'Copying…' : '↑ Copy'}
              </button>
              <button type="button" className="vs-status-item is-btn" disabled={!connected || Boolean(syncing)} onClick={() => void pull()} title={`Bring results back from ${machineName}`}>
                {syncing === 'pull' ? 'Bringing back…' : '↓ Bring back'}
              </button>
            </>
          ) : null}
          <span className="spacer" />
          {current && cursor ? (
            <>
              <button type="button" className="vs-status-item is-btn" onClick={() => setPick(':')} title={`Go to Line/Column (${keyLabel('ctrl+g')})`}>
                Ln {cursor.line}, Col {cursor.col}
                {cursor.selected ? ` (${cursor.selected} selected)` : ''}
              </button>
              <span className="vs-status-item">Spaces: 4</span>
              <span className="vs-status-item">UTF-8</span>
              <span className="vs-status-item">LF</span>
            </>
          ) : null}
          {current ? <span className="vs-status-item">{languageOf(current.path)}</span> : null}
          {settings.autoSave ? (
            <button type="button" className="vs-status-item is-btn" onClick={() => setSettings({ autoSave: false })} title="Auto Save is on: a second after typing stops, changes are saved. Click to turn it off.">
              Auto Save
            </button>
          ) : current ? (
            <span className="vs-status-item">{dirty ? '● Unsaved' : 'Saved'}</span>
          ) : null}
          {settings.fontSize !== DEFAULT_EDITOR.fontSize ? (
            <button type="button" className="vs-status-item is-btn" onClick={() => setSettings({ fontSize: DEFAULT_EDITOR.fontSize })} title={`Reset the editor's font size (${keyLabel('mod+0')})`}>
              {settings.fontSize}px
            </button>
          ) : null}
          <button type="button" className={`vs-status-item is-btn${panelOpen ? ' is-on' : ''}`} onClick={() => setPanelOpen(!panelOpen)} title={`Toggle Panel (${keyLabel('mod+j')})`}>
            {view === 'terminal' ? 'Terminal' : 'Console'}
          </button>
          <button type="button" className={`vs-status-item is-btn is-agent${agentOpen ? ' is-on' : ''}`} onClick={() => setAgentOpen(!agentOpen)} title={`Toggle Agent (${keyLabel('ctrl+alt+i')})`}>
            <SparkleIcon size={11} /> Agent
          </button>
        </footer>
      )}
      {menu ? <ContextMenu menu={menu} onClose={() => setMenu(null)} /> : null}
      {pick !== null ? (
        <QuickPick
          initial={pick}
          host={home}
          commands={commands}
          symbols={symbols}
          lines={current ? current.text.split('\n').length : 0}
          onClose={() => (setPick(null), focusEditor())}
          onFile={(path, side) => void open('home', path, side ? { group: groups.length === 1 ? 1 : focused === 0 ? 1 : 0 } : {})}
          onLine={(line) => editors.current[focused]?.goToLine(line)}
        />
      ) : null}
    </div>
  );
}

function Tree({ host, label, icon, note, disabled, onOpen, activePath, version = 0, onContext, collapsed = false }: { host: FileHost; label: string; icon?: React.ReactNode; note?: string; disabled?: boolean; onOpen: (path: string) => void; activePath: string | null; version?: number; onContext?: (event: React.MouseEvent, entry: { path: string; dir: boolean } | null) => void; /** Folded when first shown: a working copy, not the files themselves. */ collapsed?: boolean }) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <div className="pg-tree-part">
      <button type="button" className={`pg-tree-head vs-section${open ? ' is-open' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="vs-chev" aria-hidden="true">›</span>
        {icon}
        <span>{label}</span>
      </button>
      {!open ? null : disabled ? <p className="pg-note pg-pad">{note}</p> : <Folder host={host} path="" depth={0} onOpen={onOpen} activePath={activePath} version={version} onContext={onContext} />}
    </div>
  );
}

/** Search, as VS Code's: every text file in the folder read, and the lines that hold the words, by file. */
function SearchView({ host, onOpen }: { host: FileHost; onOpen: (path: string, line?: number) => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ path: string; lines: { n: number; text: string }[] }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const search = async (words: string) => {
    if (!words.trim()) return setHits(null);
    setBusy(true);
    const needle = words.toLowerCase();
    const found: { path: string; lines: { n: number; text: string }[] }[] = [];
    for (const file of await listAll(host, 200)) {
      if (file.size !== null && file.size > 400_000) continue;
      if (/\.(png|jpe?g|gif|pt|pth|ckpt|safetensors|bin|npz|npy|h5|zip|gz)$/i.test(file.path)) continue;
      const text = await host.read(file.path).catch(() => null);
      if (!text) continue;
      const lines = text.split('\n').flatMap((line, index) => (line.toLowerCase().includes(needle) ? [{ n: index + 1, text: line.trim().slice(0, 160) }] : [])).slice(0, 20);
      if (lines.length || file.path.toLowerCase().includes(needle)) found.push({ path: file.path, lines });
    }
    setHits(found);
    setBusy(false);
  };
  return (
    <div className="vs-search">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void search(query);
        }}
      >
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search — ⏎" aria-label="Search the files" spellCheck={false} />
      </form>
      {busy ? (
        <p className="pg-note pg-pad">
          <span className="spinner" /> Reading the files…
        </p>
      ) : hits ? (
        hits.length ? (
          <ul className="vs-hits">
            {hits.map((hit) => (
              <li key={hit.path}>
                <button type="button" className="pg-entry" onClick={() => onOpen(hit.path)}>
                  <FileIcon path={hit.path} />
                  {hit.path}
                  <small>{hit.lines.length}</small>
                </button>
                {hit.lines.map((line) => (
                  <button key={line.n} type="button" className="vs-hit-line mono" onClick={() => onOpen(hit.path, line.n)} title={`Line ${line.n}`}>
                    <i>{line.n}</i> {line.text}
                  </button>
                ))}
              </li>
            ))}
          </ul>
        ) : (
          <p className="pg-note pg-pad">Nothing in the folder says “{query}”.</p>
        )
      ) : (
        <p className="pg-note pg-pad">Words to find in every file of the folder.</p>
      )}
    </div>
  );
}

/**
 * A project made before files left the browser: its files are still there.
 * Moved to Drive, to a computer of yours, or to the machine, in one click;
 * nothing is taken out of the browser until it is all written there.
 */
function MoveOutOfBrowser({ playground, machineName, onNote }: { playground: Playground; machineName: string; onNote: (note: string | null) => void }) {
  const driveOk = useDriveConnected();
  const [busy, setBusy] = useState(false);
  const move = async (to: FilesHome) => {
    setBusy(true);
    try {
      const n = await moveFilesOutOfBrowser(playground.id, to);
      onNote(`${n} ${n === 1 ? 'file' : 'files'} moved to ${to.kind === 'drive' ? 'your Google Drive' : machineName}; nothing of this project is kept in the browser now.`);
    } catch (error) {
      onNote(`The files stayed where they were: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pg-banner is-problem">
      This project’s files are still kept in this browser. Move them out — they are then kept only there:
      <button type="button" className="btn sm primary" disabled={!driveOk || busy} onClick={() => void move({ kind: 'drive', folder: '' })} title={driveOk ? 'Papers_collection/Playgrounds in your Drive' : 'Sign in with Google, with Drive, first'}>
        <DriveMark size={12} /> To Google Drive
      </button>
      {playground.compute.kind === 'server' ? (
        <button type="button" className="btn sm" disabled={busy} onClick={() => void move({ kind: 'machine' })}>
          To {machineName}
        </button>
      ) : null}
    </div>
  );
}

function Folder({ host, path, depth, onOpen, activePath, version, onContext }: { host: FileHost; path: string; depth: number; onOpen: (path: string) => void; activePath: string | null; version: number; onContext?: (event: React.MouseEvent, entry: { path: string; dir: boolean } | null) => void }) {
  // Who else is in a file, in a shared project: a chip in their colour by its name.
  const peers = usePeers('code');
  const [entries, setEntries] = useState<RuntimeEntry[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    host
      .list(path)
      .then((list) => live && setEntries(list))
      .catch((error) => live && setProblem(error instanceof Error ? error.message : String(error)));
    return () => {
      live = false;
    };
  }, [host, path, version]);
  if (problem) return <p className="pg-note is-problem pg-pad">{problem}</p>;
  if (!entries) return <p className="pg-note pg-pad">…</p>;
  if (!entries.length && depth === 0) return <p className="pg-note pg-pad">Empty.</p>;
  return (
    <ul className="pg-folder">
      {entries.map((entry) => (
        <li key={entry.path}>
          {entry.type === 'directory' ? (
            <>
              <button
                type="button"
                className={`pg-entry is-dir${openDirs.has(entry.path) ? ' is-open' : ''}`}
                style={{ paddingLeft: 8 + depth * 14 }}
                onContextMenu={(event) => onContext?.(event, { path: entry.path, dir: true })}
                onClick={() =>
                  setOpenDirs((set) => {
                    const next = new Set(set);
                    if (next.has(entry.path)) next.delete(entry.path);
                    else next.add(entry.path);
                    return next;
                  })
                }
              >
                <span className="vs-chev" aria-hidden="true">›</span>
                <FileIcon path={entry.path} folder open={openDirs.has(entry.path)} />
                {entry.name}
              </button>
              {openDirs.has(entry.path) ? <Folder host={host} path={entry.path} depth={depth + 1} onOpen={onOpen} activePath={activePath} version={version} onContext={onContext} /> : null}
            </>
          ) : (
            <button type="button" className={`pg-entry${activePath === entry.path ? ' is-on' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onOpen(entry.path)} onContextMenu={(event) => onContext?.(event, { path: entry.path, dir: false })}>
              <FileIcon path={entry.path} />
              {entry.name}
              {peers
                .filter((peer) => peer.place.path === entry.path)
                .map((peer) => (
                  <i key={peer.id} className={`pj-peer-chip${peer.place.active ? '' : ' is-away'}`} style={{ background: peer.color }} title={`${peer.name} is in this file`}>
                    {peer.name.split(' ')[0]}
                  </i>
                ))}
              {entry.size !== null ? <small>{entry.size < 1024 ? `${entry.size} B` : entry.size < 1048576 ? `${Math.round(entry.size / 1024)} KB` : `${(entry.size / 1048576).toFixed(1)} MB`}</small> : null}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

interface MountControl {
  /** The Companion knows mounts (0.19.0 on). */
  known: boolean;
  linked: boolean;
  on: boolean;
  mounted: boolean;
  busy: boolean;
  words?: string;
  problem?: string;
  /** The Companion keeps this computer from sleeping while the folder is mounted. */
  awake: boolean;
  /** The computer the files are on, by its name alone ("Saurav’s MacBook Air"). */
  computer: string;
  set: (on: boolean) => void;
}

/**
 * One tab of the right-hand pane, kept once it has been opened: hidden, not unmounted, when another is chosen — so
 * coming back finds it as it was (the runs read, an agent's conversation and sign-in), not read again from nothing.
 */
function KeepTab({ id, active, children }: { id: RightTab; active: RightTab; children: React.ReactNode }) {
  const [seen, setSeen] = useState(id === active);
  useEffect(() => {
    if (id === active) setSeen(true);
  }, [id, active]);
  if (!seen && id !== active) return null;
  return (
    <div className="vs-right-tab" hidden={id !== active}>
      {children}
    </div>
  );
}

/** Which attachment of this project's folder is on which computer, by project and computer: kept in this browser to find it again in the list. */
const attachedKey = (playgroundId: string, serverId: string) => `reader.attachedOn.${playgroundId}.${serverId}`;
const attachedIdOn = (playgroundId: string, serverId: string) => {
  try {
    return localStorage.getItem(attachedKey(playgroundId, serverId));
  } catch {
    return null;
  }
};

/**
 * The project's folder on the account's other computers, as a disk of their own (src/lib/shares.ts, Companion 0.20.0):
 * Attach shares it from the computer it is on and mounts it on the other — Finder, File Explorer, any program there.
 */
function OnOtherComputers({ playground, filesComputer, folder }: { playground: Playground; filesComputer: JupyterServer; /** The folder on its computer: absolute, or relative to its Companion's folder. */ folder: string }) {
  const others = useServers().filter((server) => isCompanion(server) && server.id !== filesComputer.id && (!server.companionId || server.companionId !== filesComputer.companionId));
  const [state, setState] = useState<Record<string, { item?: Attachment; problem?: string; busy?: boolean; fuse?: Backends['fuse'] }>>({});
  const [, setTick] = useState(0);
  const look = useCallback(async () => {
    const found = await Promise.all(
      others.map(async (server) => {
        try {
          const list = await listAttached(server);
          const id = attachedIdOn(playground.id, server.id);
          return [server.id, { item: list.attached.find((a) => a.id === id), fuse: list.backends.fuse }] as const;
        } catch (error) {
          return [server.id, { problem: error instanceof Error ? error.message : String(error) }] as const;
        }
      }),
    );
    setState(Object.fromEntries(found));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [others.map((s) => s.id).join('|'), playground.id]);
  useEffect(() => {
    void look();
  }, [look]);
  if (!others.length) {
    return (
      <div className="pg-other-computers">
        <b>On your other computers</b>
        <p className="pg-note">Sign in to the Koios app on another computer (Mac, Windows or Linux) with this account, and this folder can be attached there as a disk of its own — in Finder or File Explorer, for any program.</p>
      </div>
    );
  }
  const attach = async (server: JupyterServer) => {
    setState((now) => ({ ...now, [server.id]: { ...now[server.id], busy: true, problem: undefined } }));
    try {
      const done = await attachFolder(filesComputer, server, folder, 'used', playground.title);
      try {
        localStorage.setItem(attachedKey(playground.id, server.id), done.id);
      } catch {
        // private mode: found again by Settings → Compute's list
      }
      setTick((n) => n + 1);
    } catch (error) {
      setState((now) => ({ ...now, [server.id]: { ...now[server.id], busy: false, problem: error instanceof Error ? error.message : String(error) } }));
      return;
    }
    await look();
  };
  const letGo = async (server: JupyterServer, id: string) => {
    setState((now) => ({ ...now, [server.id]: { ...now[server.id], busy: true } }));
    await detach(server, id).catch(() => undefined);
    await look();
  };
  return (
    <div className="pg-other-computers">
      <b>On your other computers</b>
      <p className="pg-note">
        The folder as a disk of its own on another computer of yours: it stays on {filesComputer.name}, and files come over as they are opened there. (To run the code on another computer instead of {playground.compute.kind === 'colab' ? 'Colab' : 'this machine'}, pick it in <b>Storage &amp; compute</b>: the switch above then mounts the folder there.)
      </p>
      {others.map((server) => {
        const here = state[server.id] ?? {};
        const item = here.item;
        return (
          <div key={server.id} className="pg-other-row">
            <span className="pg-other-name">{server.name}</span>
            <span className="pg-other-state">{here.busy ? 'Working…' : item ? attachedWords(item) : here.problem ? '' : 'not attached'}</span>
            {item ? (
              <button type="button" className="btn sm" disabled={here.busy} onClick={() => void letGo(server, item.id)}>
                Detach
              </button>
            ) : (
              <button type="button" className="btn sm" disabled={here.busy} onClick={() => void attach(server)} title={`Attach this project's folder on ${server.name}, as a disk`}>
                Attach
              </button>
            )}
            {here.problem ? <small className="pg-error">{here.problem}</small> : null}
            {item && here.fuse && !here.fuse.ok ? <small className="pg-note">A network drive there; {here.fuse.driver} makes it faster (Settings → Compute & playgrounds).</small> : null}
          </div>
        );
      })}
    </div>
  );
}

function SyncPane({ playground, homeLabel, machineName, report, syncing, connected, onPush, onPull, mount, filesComputer, folder }: { playground: Playground; homeLabel: string; machineName: string; report: (SyncReport & { at: number; what: 'push' | 'pull' }) | null; syncing: 'push' | 'pull' | null; connected: boolean; onPush: () => void; onPull: () => void; mount?: MountControl; /** The Companion computer the files are on, when they are on one: the folder can be attached on the account's other computers. */ filesComputer?: JupyterServer; folder?: string }) {
  const [ignore, setIgnore] = useState(playground.sync.ignore);
  const [bringBack, setBringBack] = useState(playground.sync.bringBack);
  const changed = ignore !== playground.sync.ignore || bringBack !== playground.sync.bringBack;
  return (
    <div className="pg-sync">
      <div className="pg-sync-flow">
        <b>{homeLabel}</b>
        <span>⇄</span>
        <b>{machineName}</b>
      </div>
      {mount ? (
        <div className="pg-mount">
          <label className="pg-mount-switch">
            <input type="checkbox" checked={mount.on} disabled={mount.busy || !mount.linked || !mount.known} onChange={(event) => mount.set(event.target.checked)} />
            <span>
              <b>Mount the folder on {machineName}</b> instead of copying it
            </span>
          </label>
          <p className="pg-note">
            {!mount.linked
              ? `Connect ${machineName} first: the Companion on ${mount.computer} mounts the folder through the link it keeps to it.`
              : !mount.known
                ? `Mounting needs Koios Companion ${MOUNT_VERSION} on ${mount.computer}: update it in Settings → Updates.`
                : mount.busy
                  ? `Starting the mount on ${machineName}… (the first time on Colab it installs fusepy, a minute or so)`
                  : mount.mounted
                    ? `${mount.words ?? `The folder is mounted on ${machineName}: nothing is copied before a run.`} The rest of the files follow in the background, so a run keeps reading if ${mount.computer} goes to sleep${mount.awake ? ` — which it won’t while the folder is mounted` : ''}; what it writes meanwhile waits and comes over when ${mount.computer} is back. A terminal on ${machineName} opened before the mount: run cd "$PWD" there to see it.`
                    : mount.on
                      ? `${machineName} doesn’t have the folder mounted now: runs copy the changed files until it does.`
                      : `${machineName} reads the folder where it is — on ${mount.computer} — through the Companion’s Cloudflare tunnel: a save here is there at once, what a run writes there is written here, and nothing is copied before a run. What the rules below leave out (checkpoints, data) stays on the machine and goes to the data place.`}
          </p>
          {mount.problem ? <p className="pg-error">{mount.problem}</p> : null}
        </div>
      ) : null}
      {filesComputer && folder !== undefined ? <OnOtherComputers playground={playground} filesComputer={filesComputer} folder={folder} /> : null}
      <p className="pg-note">{mount?.mounted ? 'While it is mounted the rules below say what stays on the machine (and goes to the data place) and what is yours; nothing needs copying or bringing back.' : 'The folder is copied onto the machine before each command in the console, and what a run writes under the folders below comes back after it. Text files up to 2 MB; data and weights stay on the machine — fetch them there.'}</p>
      {syncRules(playground).runsInData ? (
        <p className="pg-note">
          <b>Runs</b> (<code>runs/</code>) stay on {machineName} and go to the data place as they run — not to {homeLabel}. The Sim pane and Explain read them there. To keep them with the code instead: Storage &amp; compute → Data &amp; results.
        </p>
      ) : null}
      {mount?.mounted ? null : (
        <div className="pg-machine-actions">
          <button type="button" className="btn sm" disabled={!connected || Boolean(syncing)} onClick={onPush}>
            {syncing === 'push' ? 'Copying…' : 'Copy to the machine now'}
          </button>
          <button type="button" className="btn sm" disabled={!connected || Boolean(syncing)} onClick={onPull}>
            {syncing === 'pull' ? 'Bringing back…' : 'Bring results back'}
          </button>
        </div>
      )}
      {report && !mount?.mounted ? (
        <p className="pg-ok">
          {report.what === 'push' ? `${report.sent.length} ${report.sent.length === 1 ? 'file' : 'files'} copied to the machine` : `${report.back.length} ${report.back.length === 1 ? 'file' : 'files'} brought back`}
          {report.skipped.length ? ` · ${report.skipped.length} left where they were: over 2 MB, or not text (videos, images, weights)` : ''} · {new Date(report.at).toLocaleTimeString()}
        </p>
      ) : null}
      <label className="pg-rules">
        <span>Not copied (like .gitignore)</span>
        <textarea value={ignore} onChange={(event) => setIgnore(event.target.value)} rows={6} spellCheck={false} />
      </label>
      <label className="pg-rules">
        <span>Brought back after a run</span>
        <textarea value={bringBack} onChange={(event) => setBringBack(event.target.value)} rows={5} spellCheck={false} />
      </label>
      <button type="button" className="btn sm primary" disabled={!changed} onClick={() => updatePlayground(playground.id, { sync: { ...playground.sync, ignore, bringBack } })}>
        Keep these rules
      </button>
    </div>
  );
}

