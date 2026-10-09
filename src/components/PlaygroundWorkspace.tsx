// One playground, at /playground/<id>: its notebook, or its files with an
// editor and a console, on the machine it is bound to. The bar says where
// the kernel is and opens the machine's menu; the pane on the right is the
// sync (when the files live somewhere other than the machine), the runtime's
// meters and the metrics the runs print — the same panes the paper's
// notebook has. The store is src/lib/playground.ts.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Backend, JupyterServer } from '../lib/colab';
import { backendLabel, chooseBackend, colabAvailable, colabNow, connect, forgetRun, interrupt, lastActivityAt, machineLabel, restartKernel, runCell, runQuietly, setMachine, stopRuntime } from '../lib/colab';
import type { Machine } from '../lib/colab';
import { notebookFor, runKey, subscribeNotebook } from '../lib/notebook';
import type { ConsoleEntry, FileHost, FilesHome, Playground, SyncReport } from '../lib/playground';
import { blankCells, filesAreOnMachine, homeHost, homeLabelOf, moveFilesOutOfBrowser, useDriveConnected, machineHost, machineRoot, markFolder, notebookKey, pullBack, pushFolder, secureCompanions, serverById, shellCell, takeSeed, updatePlayground, useServers, vscodeLink } from '../lib/playground';
import { COMPANION_VERSION, STARTABLE, companionPort, companionTools, findCompanion, isNewer, isSecure, shutdownCompanion, startCompanion, updateCompanion, vscodeWeb, waitForVersion } from '../lib/companion';
import type { VsCodeWeb } from '../lib/companion';
import { AGENT_KEYS, AGENTS, agentCommand, saveAgentOptions, savedAgentOptions } from '../lib/agents';
import type { AgentOptions, AgentSpec } from '../lib/agents';
import { ASSUMED_TOOLS, runPlan } from '../lib/languages';
import type { MachineTools } from '../lib/languages';
import type { RuntimeEntry } from '../lib/colab';
import { useStore } from '../lib/store';
import type { Screen } from '../lib/assistant';
import { CellRunOutput, ColabMark, ConnectCard, MachinePicker, attachUrl, useColab } from './Colab';
import MetricsPane from './MetricsPane';
import NotebookPage, { Editor } from './Notebook';
import type { NbSide } from './Notebook';
import RuntimePane from './RuntimePane';
import Gutter, { DEFAULT_LAYOUT, TREE_FOLD, loadLayout, readLayout, saveLayout } from './Gutter';
import type { PaneLayout } from './Gutter';
import Terminal, { forgetTerminal, hasTerminals, typeInTerminal } from './Terminal';
import { WhereDialog } from './Playground';
import VsCodeExtension, { VsCodeMark, isCompanion } from './VsCodeExtension';
import { ArrowLeftIcon, ChartIcon, CloseIcon, DriveMark, PlusIcon, SearchIcon, SparkleIcon } from './icons';
import FileIcon, { languageOf } from './FileIcon';
import ProjectAgent from './ProjectAgent';
import { listAll } from '../lib/projectAgent';
import type { AgentChange, ProjectView } from '../lib/projectAgent';

type Tab = 'notebook' | 'files';
/** What the side bar shows, picked in the activity bar; null when it is folded away. */
type Primary = 'explorer' | 'search' | 'sync' | 'runtime' | 'metrics' | null;

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
const uid = () => Math.random().toString(36).slice(2, 10);

/** The backend a playground's compute names, when it can be had: a server that is still in the list. */
function backendOf(playground: Playground): Backend | null {
  if (playground.compute.kind === 'colab') return { kind: 'colab' };
  const server = serverById(playground.compute.serverId);
  return server ? { kind: 'jupyter', server } : null;
}

export default function PlaygroundWorkspace({ playground, onBack, onOpenPaper }: { playground: Playground; onBack: () => void; onOpenPaper: (id: string) => void }) {
  const colab = useColab();
  const { papers, settings } = useStore();
  useServers();
  const [tab, setTab] = useState<Tab>(playground.kind === 'project' ? 'files' : 'notebook');
  const [side, setSide] = useState<NbSide>(null);
  const [title, setTitle] = useState(playground.title);
  const [changing, setChanging] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const backend = backendOf(playground);
  const machineName = backend ? backendLabel(backend, colab.backend.kind === backend.kind ? colab.runtime : undefined) : 'a server no longer in the list';

  // The kernel follows the playground: its machine is the one the next cell runs on.
  useEffect(() => {
    if (!backend) return;
    chooseBackend(backend);
    if (playground.compute.kind === 'colab') setMachine(playground.compute.machine);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playground.compute.kind === 'server' ? playground.compute.serverId : 'colab', playground.compute.kind === 'colab' ? playground.compute.machine.accelerator : '', backend?.kind === 'jupyter' ? backend.server.url + backend.server.token : '']);

  // A Companion paired over plain http moves to its https address once this computer trusts its certificate.
  useEffect(() => {
    void secureCompanions();
  }, []);

  useEffect(() => {
    document.title = `${playground.title} · Playground · Reader`;
  }, [playground.title]);
  // Off the playground, the paper pages' cells run in Colab again, as their buttons say. The kernel on a
  // Jupyter server stays there, and this tab goes back to the same one when the playground opens again.
  useEffect(
    () => () => {
      if (colabNow().backend.kind === 'jupyter' && !colabNow().running) chooseBackend({ kind: 'colab' });
    },
    [],
  );

  // On Colab: the runtime stopped after the idle time asked for, while the tab is open — a forgotten GPU is units spent.
  useEffect(() => {
    if (playground.compute.kind !== 'colab' || !playground.idleStopMin) return;
    const check = window.setInterval(() => {
      if (colabNow().status !== 'idle') return;
      if (Date.now() - lastActivityAt() < playground.idleStopMin * 60_000) return;
      void stopRuntime();
      setNote(`The Colab runtime was stopped after ${playground.idleStopMin} minutes with nothing running, as this playground asks. The next Run starts a new one.`);
    }, 30_000);
    return () => window.clearInterval(check);
  }, [playground.compute, playground.idleStopMin]);

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
  const usable = Boolean(backend) && colabAvailable(settings.googleClientId);

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
        <button type="button" className="btn sm ghost" onClick={onBack} title="The Playground's home">
          <ArrowLeftIcon size={15} /> Playground
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
          <a className="btn sm ghost" href={vscode} title="Open this project's folder in VS Code (the Reader extension adds the papers, the machine and Open on the site)">
            <VsCodeMark /> Open in VS Code
          </a>
        ) : null}
        {vscode && homeServer ? <VsCodeExtension server={homeServer} compact /> : null}
        <MachineChip playground={playground} name={machineName} usable={usable} onChange={() => setChanging(true)} onNote={setNote} />
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
      {!backend ? (
        <div className="pg-banner is-problem">
          This playground runs on a Jupyter server that is no longer in this browser’s list.{' '}
          <button type="button" className="link" onClick={() => setChanging(true)}>
            Choose where it runs
          </button>
        </div>
      ) : !usable ? (
        <div className="pg-banner is-problem">Colab needs Settings → Google (a client ID) and Settings → Paper proxy before cells can run — or choose a Jupyter server of yours from the machine menu.</div>
      ) : colab.error && colab.status !== 'connecting' ? (
        <div className="pg-banner is-problem">{colab.error}</div>
      ) : null}
      {note ? (
        <div className="pg-banner">
          {note}
          <button type="button" className="icon-btn sm" aria-label="Dismiss" onClick={() => setNote(null)}>
            <CloseIcon size={13} />
          </button>
        </div>
      ) : null}
      {playground.home.kind === 'browser' && playground.kind === 'project' ? <MoveOutOfBrowser playground={playground} machineName={machineName} onNote={setNote} /> : null}
      <div className="pg-body">
        {tab === 'notebook' ? (
          <div className="pg-notebook">
            <NotebookPage paperId={nbKey} title={playground.title} screen={screen} side={side} onSide={setSide} sections={[]} playground={{ hasPaper: cited.some(Boolean), seed }} />
          </div>
        ) : (
          <FilesView key={JSON.stringify(playground.home)} playground={playground} connected={connected} usable={usable} machineName={machineName} />
        )}
      </div>
      {changing ? (
        <WhereDialog
          draft={{ title: playground.title, kind: playground.kind }}
          current={{ compute: playground.compute, home: playground.home, idleStopMin: playground.idleStopMin }}
          onClose={() => setChanging(false)}
          onCreate={(spec) => {
            const movedFiles = JSON.stringify(spec.home) !== JSON.stringify(playground.home);
            updatePlayground(playground.id, { compute: spec.compute, home: spec.home.kind === 'server' && !spec.home.root ? { ...spec.home, root: playground.home.kind === 'server' ? playground.home.root : `playgrounds/${playground.id}` } : spec.home, idleStopMin: spec.idleStopMin });
            setChanging(false);
            setNote(movedFiles ? 'The files now live in the new place; the ones kept in the old place stay there — copy what you need across from the Files tab.' : `Cells now run on ${spec.compute.kind === 'colab' ? 'your Colab' : serverById(spec.compute.serverId)?.name}. The kernel there starts fresh: re-run the cells that set things up.`);
          }}
        />
      ) : null}
    </main>
  );
}

/** The chip in the bar: where the kernel is, how it is, and its menu — connect, interrupt, change, shut down; and for a Companion on this computer, shut it down and start it again. */
function MachineChip({ playground, name, usable, onChange, onNote }: { playground: Playground; name: string; usable: boolean; onChange: () => void; onNote: (note: string | null) => void }) {
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
      onNote(`The Reader Companion on ${name} is shut down: no Jupyter server, no kernels. It stays off, at your next login too, until you start it — Start the Companion in this menu, the Reader app, or reader-companion start in a terminal.`);
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
      onNote(`The Companion didn’t start from here. Open the Reader app on ${name}, or run reader-companion start in a terminal there. (The page can start a Companion from ${STARTABLE} on, installed with the Reader app or the installer: update it in Settings → Updates.)`);
      return;
    }
    setPower('up');
    await connect().catch(() => undefined);
  };
  return (
    <div className="menu-wrap" ref={box}>
      <button type="button" className={`colab-chip pg-chip is-${dot}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title={colab.error || (state === 'kernel not started' ? `Cells run on ${name}. Its kernel starts with the first cell or command; the terminal, the files and the agent don't need it — they reach the computer through its Companion.` : `Cells run on ${name}`)}>
        {playground.compute.kind === 'colab' ? <ColabMark /> : <span className={`pg-mark ${serverById(playground.compute.serverId)?.where === 'pc' ? 'is-pc' : 'is-gpu'}`}>{serverById(playground.compute.serverId)?.where === 'pc' ? 'PC' : 'GPU'}</span>}
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
              title="Starts the Reader Companion (the Jupyter server on this computer) through the Reader app. Your browser asks once whether to open it."
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
                  title="Stops the Reader Companion, the Jupyter server on this computer, and every kernel in it. It stays off until you start it again from this menu or the Reader app."
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
function AgentPane({ server, machineName, agents, asked, cwd, inFolder, playgroundId }: { server: JupyterServer | undefined; machineName: string; agents: { id: string; name: string }[]; asked: boolean; cwd: string; inFolder: (command: string) => string; playgroundId: string }) {
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
  const command = agentCommand(chosen, options);
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

  if (!server) return <p className="pg-note pg-pad">An agent runs in a terminal on the machine: choose a Jupyter server of yours — a Reader Companion — from the machine menu.</p>;
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
            <Terminal key={session.id} server={server} cwd={cwd} sessionId={session.id} label={`${running?.name ?? session.agent} on ${machineName}`} />
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
  const src = status?.state === 'ready' && status.path ? `${server.url.replace(/\/?$/, '/')}${status.path.replace(/^\//, '')}?folder=${encodeURIComponent(status.folder)}` : null;
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
          {outdated.error ?? `The Companion on ${server.name} is ${outdated.version}; VS Code in the page needs ${COMPANION_VERSION}, which starts VS Code again when it stops answering instead of showing “500: Internal Server Error”.`}
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
  const servers = useServers();
  const split = !filesAreOnMachine(playground);
  // The hosts follow the servers' list, so an edited address is used at once.
  const home = useMemo(() => homeHost(playground), [playground, servers]);
  const machine = useMemo(() => machineHost(playground, machineName), [playground, machineName, servers]);
  const homeLabel = homeLabelOf(playground, machineName);
  // The workbench, as VS Code lays it out: the activity bar's view in the side bar, the agent on the right, the panel below.
  const [primary, setPrimary] = useState<Primary>(() => readLocal<Primary>('reader.pgPrimary', 'explorer'));
  const [agentOpen, setAgentOpenState] = useState(() => readLocal('reader.pgAgent', true));
  const [agentMode, setAgentMode] = useState<'reader' | 'cli'>(() => readLocal('reader.pgAgentMode', 'reader'));
  const [panelOpen, setPanelOpen] = useState(true);
  const setAgentOpen = (open: boolean) => (setAgentOpenState(open), writeLocal('reader.pgAgent', open));
  useEffect(() => writeLocal('reader.pgPrimary', primary), [primary]);
  useEffect(() => writeLocal('reader.pgAgentMode', agentMode), [agentMode]);
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [report, setReport] = useState<(SyncReport & { at: number; what: 'push' | 'pull' }) | null>(null);
  const [syncing, setSyncing] = useState<'push' | 'pull' | null>(null);
  const [command, setCommand] = useState(playground.pending ?? '');
  const [base, setBase] = useState<string | null>(null);
  const current = files.find((file) => `${file.where}:${file.path}` === active) ?? null;
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
  const view = terminals && computeServer ? shellView ?? (split ? 'commands' : 'terminal') : 'commands';
  const { tools: machineTools, asked } = useMachineTools(computeServer);
  const homeServer = playground.home.kind === 'server' ? servers.find((server) => server.id === (playground.home.kind === 'server' ? playground.home.serverId : '')) : undefined;
  const { tools: homeTools } = useMachineTools(homeServer);
  // VS Code in the page: for files on a Companion whose computer has VS Code.
  const vscodeHere = Boolean(homeServer && isCompanion(homeServer) && homeTools.vscode);
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
  const addShell = () => {
    const id = `${playground.id}~${shortId()}`;
    keepShells([...shells, id]);
    setActiveShell(id);
  };
  const closeShell = (id: string) => {
    if (computeServer) forgetTerminal(computeServer, id);
    const left = shells.filter((shell) => shell !== id);
    const next = left.length ? left : [`${playground.id}~${shortId()}`];
    keepShells(next);
    if (id === activeShell) setActiveShell(next[Math.max(0, shells.indexOf(id) - 1)] ?? next[0]);
  };
  /** A command, in the project's folder when the page knows it: the agent pane's. */
  const inFolder = (command: string) => (agentFolder ? (machineTools.os === 'windows' ? `cd "${agentFolder}"; ${command}` : `cd '${agentFolder.replace(/'/g, `'\\''`)}' && ${command}`) : command);
  /** A command into the terminal shown below, in the project's folder: the Run button's. */
  const inTerminal = (command: string) => {
    setShellView('terminal');
    typeInTerminal(activeShell, `${command}\r`);
  };

  const open = async (where: 'home' | 'machine', path: string) => {
    const key = `${where}:${path}`;
    if (files.some((file) => `${file.where}:${file.path}` === key)) return setActive(key);
    setProblem(null);
    try {
      const text = (await (where === 'home' ? home : machine).read(path)) ?? '';
      setFiles((list) => [...list, { where, path, text, saved: text }]);
      setActive(key);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
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
  const newFile = async () => {
    const path = window.prompt('A new file — its path in the folder:', 'train.py');
    if (!path?.trim()) return;
    const clean = path.trim().replace(/^\/+/, '');
    try {
      await home.write(clean, '');
      setRefresh((n) => n + 1);
      await open('home', clean);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  const push = async () => {
    setSyncing('push');
    setProblem(null);
    try {
      // Unsaved edits first: what is sent is what is on screen.
      for (const file of files) if (file.where === 'home' && file.text !== file.saved) await save(file);
      const done = await pushFolder(playground, machine);
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

  /** The folder on the machine, as an absolute path the shell can cd into: the small kernel's start, joined to the folder. */
  const folderOnMachine = async () => {
    if (base) return base;
    const answer = await runQuietly(`import os\nprint(os.path.abspath(${JSON.stringify(machineRoot(playground))}))`);
    const found = answer?.ok ? answer.text.trim().split('\n').pop() ?? null : null;
    if (found) setBase(found);
    return found ?? machineRoot(playground);
  };

  const run = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || colab.running) return;
    setProblem(null);
    if (!connected) {
      try {
        await connect();
      } catch {
        return;
      }
    }
    if (split && !(await push())) return;
    const entry: ConsoleEntry = { id: uid(), command: trimmed, at: Date.now() };
    updatePlayground(playground.id, (p) => ({ console: [...p.console, entry].slice(-40), pending: p.pending === trimmed ? undefined : p.pending }));
    setCommand('');
    const folder = await folderOnMachine();
    await runCell(consoleKey(playground.id, entry.id), shellCell(folder, trimmed));
    if (split) await pull();
    setRefresh((n) => n + 1);
  };

  const plan = current ? runPlan(current.path, terminalHere ? projectFolder : null, machineTools) : null;
  const runFile = async () => {
    if (!current || !plan || !('command' in plan)) return;
    if (current.text !== current.saved) await save(current);
    if (terminalHere) inTerminal(plan.command);
    else void run(plan.command);
  };

  const consoleCells = playground.console.map((entry, index) => ({ key: consoleKey(playground.id, entry.id), id: entry.id, label: `command ${index + 1}` }));
  const nbCells = useSyncExternalStore(subscribeNotebook, () => notebookFor(notebookKey(playground.id)));
  const metricCells = useMemo(
    () => [
      ...playground.console.map((entry, index) => {
        const run = colab.runs[consoleKey(playground.id, entry.id)];
        return { key: consoleKey(playground.id, entry.id), id: entry.id, label: `$ ${entry.command.slice(0, 32)}${entry.command.length > 32 ? '…' : ''} (${index + 1})`, text: run ? run.outputs.map((o) => ('text' in o ? o.text : '')).join('') : '', at: run?.startedAt ?? entry.at };
      }),
      ...(nbCells?.cells ?? [])
        .map((cell, index) => ({ cell, index }))
        .filter(({ cell }) => cell.type === 'code')
        .map(({ cell, index }) => {
          const run = colab.runs[runKey(cell.id)];
          return { key: runKey(cell.id), id: cell.id, label: `cell ${index + 1}`, text: run ? run.outputs.map((o) => ('text' in o ? o.text : '')).join('') : '', at: run?.startedAt ?? 0 };
        }),
    ],
    [playground.console, colab.runs, nbCells, playground.id],
  );

  const dirty = current ? current.text !== current.saved : false;
  // The newest command in view from its top: what was typed, then what it printed.
  const consoleLog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const last = consoleLog.current?.querySelector<HTMLElement>('.pg-console-entry:last-of-type');
    if (last && consoleLog.current) consoleLog.current.scrollTop = last.offsetTop - 4;
  }, [playground.console.length]);

  /** The project as the agent reads it: the folder's files, the ones open, the last commands and what they printed. */
  const agentView = async (): Promise<ProjectView> => ({
    where: `Files kept in ${homeLabel}; code runs on ${machineName}${split ? ', the folder copied there before each command' : ''}.`,
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
      return change && file.text === file.saved ? { ...file, text: change.after, saved: change.after } : file;
    }));
    setRefresh((n) => n + 1);
    const first = changes.find((c) => c.after);
    if (first && !files.length) void open('home', first.path);
  };

  if (vscodeHere && homeServer && playground.editor === 'vscode' && playground.home.kind === 'server') {
    return <VsCodePane server={homeServer} folder={playground.home.root} playground={playground} />;
  }

  const cliAgents = Boolean(terminals && computeServer && isCompanion(computeServer));
  const mode = cliAgents ? agentMode : 'reader';
  const sideKey = mode === 'cli' ? 'agent' : 'side';
  const crumbs = current ? [current.where === 'home' ? homeLabel : machineName, ...current.path.split('/')] : [];
  const views: { id: Primary; label: string; icon: React.ReactNode; hidden?: boolean }[] = [
    { id: 'explorer', label: 'Explorer', icon: <FilesGlyph /> },
    { id: 'search', label: 'Search the files', icon: <SearchIcon size={19} /> },
    { id: 'sync', label: `Sync with ${machineName}`, icon: <SyncGlyph />, hidden: !split },
    { id: 'runtime', label: 'Runtime — GPU, memory, disk', icon: <GaugeGlyph /> },
    { id: 'metrics', label: 'Metrics the runs print', icon: <ChartIcon size={19} /> },
  ];
  const togglePrimary = (id: Primary) => setPrimary(primary === id ? null : id);

  return (
    <div className="vs-shell">
      <div
        className={`pg-files vs-work${layout.big ? ` is-big-${layout.big}` : ''}${!panelOpen ? ' is-panel-closed' : ''}`}
        style={{ '--pg-tree-w': `${Math.max(layout.tree, 200)}px`, '--pg-side-w': `${layout[sideKey]}px`, '--pg-console-h': `${layout.console}%` } as React.CSSProperties}
      >
        <nav className="vs-activity" aria-label="Views">
          {views
            .filter((v) => !v.hidden)
            .map((v) => (
              <button key={v.id} type="button" className={`vs-act${primary === v.id ? ' is-on' : ''}`} aria-pressed={primary === v.id} onClick={() => togglePrimary(v.id)} title={v.label} aria-label={v.label}>
                {v.icon}
              </button>
            ))}
          <span className="spacer" />
          <button type="button" className={`vs-act is-agent${agentOpen ? ' is-on' : ''}`} aria-pressed={agentOpen} onClick={() => setAgentOpen(!agentOpen)} title="The agent: ask it to write, change or fix the code" aria-label="The agent">
            <SparkleIcon size={19} />
          </button>
        </nav>
        {primary ? (
          <aside className="pg-tree vs-sidebar">
            <div className="vs-side-title">
              <span>{views.find((v) => v.id === primary)?.label.split(' —')[0]}</span>
              {primary === 'explorer' ? (
                <>
                  <button type="button" className="icon-btn sm" onClick={() => void newFile()} title="A new file" aria-label="A new file">
                    <PlusIcon size={14} />
                  </button>
                  <button type="button" className="icon-btn sm" onClick={() => setRefresh((n) => n + 1)} title="Read the folder again" aria-label="Refresh">
                    ↻
                  </button>
                </>
              ) : null}
            </div>
            {primary === 'explorer' ? (
              <>
                <Tree key={`home-${refresh}`} host={home} label={homeLabel} icon={playground.home.kind === 'drive' ? <DriveMark size={12} /> : undefined} onOpen={(path) => void open('home', path)} activePath={current?.where === 'home' ? current.path : null} />
                {split ? <Tree key={`machine-${refresh}-${connected}`} host={machine} label={`On ${machineName}`} note={connected ? undefined : 'Connect to see the folder on the machine.'} disabled={!connected} onOpen={(path) => void open('machine', path)} activePath={current?.where === 'machine' ? current.path : null} /> : null}
              </>
            ) : primary === 'search' ? (
              <SearchView host={home} onOpen={(path) => void open('home', path)} />
            ) : primary === 'sync' && split ? (
              <SyncPane playground={playground} homeLabel={homeLabel} machineName={machineName} report={report} syncing={syncing} connected={connected} onPush={() => void push()} onPull={() => void pull()} />
            ) : primary === 'runtime' ? (
              connected ? <RuntimePane cells={consoleCells} onGoTo={() => undefined} /> : <p className="pg-note pg-pad">Connect from the bar, or run a command, and the machine is read here: GPU, memory, disk.</p>
            ) : (
              <MetricsPane cells={metricCells} running={colab.running} />
            )}
          </aside>
        ) : null}
        {primary ? (
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
          <div className="pg-tabs vs-tabs" role="tablist">
            {files.map((file) => {
              const key = `${file.where}:${file.path}`;
              const dirtyTab = file.text !== file.saved;
              return (
                <span key={key} className={`pg-tab vs-tab${key === active ? ' is-on' : ''}${dirtyTab ? ' is-dirty' : ''}`}>
                  <button type="button" role="tab" aria-selected={key === active} onClick={() => setActive(key)} title={`${file.where === 'home' ? homeLabel : machineName} · ${file.path}`}>
                    <FileIcon path={file.path} />
                    {file.where === 'machine' ? '⇣ ' : ''}
                    {file.path.split('/').pop()}
                  </button>
                  <button
                    type="button"
                    className="pg-tab-x"
                    aria-label={`Close ${file.path}`}
                    onClick={() => {
                      setFiles((list) => list.filter((f) => f !== file));
                      if (key === active) setActive(null);
                    }}
                  >
                    <span className="vs-dot" aria-hidden="true">●</span>
                    <span className="vs-x" aria-hidden="true">×</span>
                  </button>
                </span>
              );
            })}
          </div>
          {current ? (
            <div className="vs-crumbs">
              {crumbs.map((part, index) => (
                <span key={`${index}-${part}`} className={index === crumbs.length - 1 ? 'is-last' : ''}>
                  {index === crumbs.length - 1 ? <FileIcon path={part} /> : null}
                  {part}
                </span>
              ))}
              <span className="spacer" />
              {plan ? (
                <button
                  type="button"
                  className="vs-action is-run"
                  disabled={!('command' in plan) || !usable}
                  onClick={() => void runFile()}
                  title={'command' in plan ? `${plan.command}${asked ? '' : ` (${machineName} couldn’t say what is installed: this is a guess)`} — ⌘↵` : `Running ${plan.language} needs ${plan.missing} on ${machineName}`}
                >
                  ▶ Run
                </button>
              ) : null}
              <button type="button" className="vs-action" disabled={!dirty} onClick={() => void save(current)} title="⌘S">
                {dirty ? 'Save' : 'Saved'}
              </button>
              {vscodeHere ? <EditorSwitch playground={playground} /> : null}
            </div>
          ) : null}
          <div
            className="pg-editor"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && current) {
                event.preventDefault();
                void save(current);
              }
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && current) {
                event.preventDefault();
                void runFile();
              }
            }}
          >
            {current ? (
              <Editor value={current.text} python={/\.py$/.test(current.path)} path={current.path} onChange={(text) => setFiles((list) => list.map((f) => (f === current ? { ...f, text } : f)))} onKeyDown={() => undefined} />
            ) : (
              <div className="pg-editor-empty vs-welcome">
                <b>{playground.title}</b>
                <p>Open a file from the explorer, make one, or ask the agent on the right to write it.</p>
                <div className="vs-welcome-keys">
                  <button type="button" className="link" onClick={() => void newFile()}>
                    New file…
                  </button>
                  <button type="button" className="link" onClick={() => setAgentOpen(true)}>
                    Ask the agent
                  </button>
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
            {problem ? <p className="pg-note is-problem">{problem}</p> : null}
          </div>
          {current && onDisk && onDisk.key === currentKey ? (
            <div className="pg-banner pg-disk-banner">
              {current.path.split('/').pop()} changed in its folder while you were editing it here.
              <button type="button" className="btn sm" onClick={() => (setFiles((list) => list.map((f) => (f === current ? { ...f, text: onDisk.text, saved: onDisk.text } : f))), setOnDisk(null))}>
                Load it
              </button>
              <button type="button" className="btn sm ghost" onClick={() => ((dismissed.current = onDisk), setOnDisk(null))} title="Keep what is here; Save writes it over the folder's">
                Keep mine
              </button>
            </div>
          ) : null}
          {panelOpen && layout.big !== 'console' ? (
            <Gutter
              axis="y"
              label="The panel’s height"
              onStart={() => (dragFrom.current = layout)}
              onMove={(delta) => setLayout({ console: dragFrom.current.console - (delta / Math.max(1, centerBox.current?.clientHeight ?? 1)) * 100 })}
              onReset={() => setLayout({ console: DEFAULT_LAYOUT.console })}
            />
          ) : null}
          <div className={`pg-console vs-panel${view === 'terminal' ? ' is-terminal' : ''}`} hidden={!panelOpen}>
            <div className="pg-console-head vs-panel-head">
              <div className="vs-panel-tabs" role="tablist" aria-label="Panel">
                {terminals && computeServer ? (
                  <button type="button" role="tab" aria-selected={view === 'terminal'} className={view === 'terminal' ? 'is-on' : ''} onClick={() => setShellView('terminal')}>
                    Terminal
                  </button>
                ) : null}
                <button type="button" role="tab" aria-selected={view === 'commands'} className={view === 'commands' ? 'is-on' : ''} onClick={() => setShellView('commands')}>
                  {split ? 'Copy & run' : 'Console'}
                </button>
              </div>
              {view === 'terminal' && terminals && computeServer ? (
                <div className="pg-shell-tabs" role="tablist" aria-label="Terminals">
                  {shells.map((id, index) => (
                    <span key={id} className={`pg-shell-tab${id === activeShell ? ' is-on' : ''}`}>
                      <button type="button" role="tab" aria-selected={id === activeShell} onClick={() => setActiveShell(id)}>
                        {index + 1}
                      </button>
                      {shells.length > 1 ? (
                        <button type="button" className="pg-tab-x" aria-label={`Close terminal ${index + 1}`} title="Close this terminal (its shell ends)" onClick={() => closeShell(id)}>
                          ×
                        </button>
                      ) : null}
                    </span>
                  ))}
                  <button type="button" className="icon-btn sm" onClick={addShell} aria-label="A new terminal" title="A new terminal">
                    +
                  </button>
                </div>
              ) : null}
              <span className="mono">
                {machineName}:{base ?? machineRoot(playground)}
              </span>
              <span className="spacer" />
              {view === 'terminal' && split ? <span className="pg-note">The terminal doesn’t copy the folder over — use Sync, or Copy &amp; run.</span> : null}
              {view === 'commands' && colab.running?.startsWith('pgsh:') ? (
                <button type="button" className="btn sm colab-stop" onClick={() => void interrupt()}>
                  ■ Stop
                </button>
              ) : null}
              <button type="button" className={`icon-btn sm${layout.big === 'console' ? ' is-on' : ''}`} onClick={() => setLayout({ big: layout.big === 'console' ? null : 'console' })} aria-pressed={layout.big === 'console'} title={layout.big === 'console' ? 'Give the editor its room back' : 'Give the panel the whole column'} aria-label={layout.big === 'console' ? 'Restore the panel' : 'Maximise the panel'}>
                {layout.big === 'console' ? '⤡' : '⤢'}
              </button>
              <button type="button" className="icon-btn sm" onClick={() => (setPanelOpen(false), layout.big === 'console' && setLayout({ big: null }))} aria-label="Hide the panel" title="Hide the panel (the status bar brings it back)">
                <CloseIcon size={13} />
              </button>
            </div>
            {view === 'terminal' && computeServer
              ? shells.map((id) => (
                  <div key={id} className="pg-terminal-slot" hidden={id !== activeShell}>
                    <Terminal server={computeServer} cwd={machineRoot(playground)} sessionId={id} label={machineName} />
                  </div>
                ))
              : null}
            <div className="pg-console-log" ref={consoleLog} hidden={view === 'terminal'}>
              {playground.console.slice(-12).map((entry) => {
                const key = consoleKey(playground.id, entry.id);
                const runNow = colab.runs[key];
                return (
                  <div key={entry.id} className="pg-console-entry">
                    <div className="pg-console-cmd">
                      <span className="pg-prompt">$</span> {entry.command}
                      <button type="button" className="link" onClick={() => setCommand(entry.command)} title="Put it in the box again">
                        again
                      </button>
                    </div>
                    {runNow ? <CellRunOutput run={runNow} onForget={() => forgetRun(key)} /> : <div className="pg-note">ran {new Date(entry.at).toLocaleString()} — the output was in that tab</div>}
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
              <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={`A command, run in a shell on ${machineName} — python main.py, pip install …, nvidia-smi`} spellCheck={false} aria-label="A command" disabled={!usable} />
              <button type="submit" className="btn sm primary" disabled={!usable || !command.trim() || Boolean(colab.running)}>
                {split ? 'Copy & run' : 'Run'}
              </button>
            </form>
          </div>
        </section>
        {agentOpen ? (
          <Gutter
            axis="x"
            className="is-side"
            label="The agent’s width"
            onStart={() => (dragFrom.current = layout)}
            onMove={(delta) => setLayout({ [sideKey]: dragFrom.current[sideKey] - delta, big: null })}
            onReset={() => setLayout({ [sideKey]: DEFAULT_LAYOUT[sideKey], big: null })}
          />
        ) : null}
        {agentOpen ? (
          <aside className={`nb-side pg-side-pane vs-agent${mode === 'cli' ? ' is-agent' : ''}`}>
            <div className="vs-agent-head">
              <span className="vs-agent-title">
                <SparkleIcon size={14} /> Agent
              </span>
              {cliAgents ? (
                <div className="segmented pg-seg" role="tablist" aria-label="Which agent">
                  <button type="button" role="tab" aria-selected={mode === 'reader'} className={mode === 'reader' ? 'on' : ''} onClick={() => setAgentMode('reader')} title="An agent in the page, answered by the model you pick">
                    In the page
                  </button>
                  <button type="button" role="tab" aria-selected={mode === 'cli'} className={mode === 'cli' ? 'on' : ''} onClick={() => setAgentMode('cli')} title={`Claude Code, Codex, Gemini CLI… in a terminal on ${machineName}`}>
                    In a terminal
                  </button>
                </div>
              ) : null}
              <span className="spacer" />
              <button type="button" className={`icon-btn sm${layout.big === 'side' ? ' is-on' : ''}`} onClick={() => setLayout({ big: layout.big === 'side' ? null : 'side' })} aria-pressed={layout.big === 'side'} title={layout.big === 'side' ? 'Back to its width' : 'Give the agent most of the width'} aria-label={layout.big === 'side' ? 'Restore the agent' : 'Widen the agent'}>
                {layout.big === 'side' ? '⤡' : '⤢'}
              </button>
              <button type="button" className="icon-btn sm" onClick={() => setAgentOpen(false)} aria-label="Close the agent">
                <CloseIcon size={14} />
              </button>
            </div>
            {mode === 'cli' ? (
              <AgentPane server={computeServer} machineName={machineName} agents={machineTools.agents} asked={asked} cwd={machineRoot(playground)} inFolder={inFolder} playgroundId={playground.id} />
            ) : (
              <ProjectAgent
                projectId={playground.id}
                host={home}
                machineName={machineName}
                view={agentView}
                context={{ active: current?.path, open: files.length, commands: Math.min(4, playground.console.length) }}
                onOpen={(path) => void open('home', path)}
                onRun={(line) => {
                  setPanelOpen(true);
                  if (terminalHere) inTerminal(line);
                  else void run(line);
                }}
                onWrote={tookAgentFiles}
              />
            )}
          </aside>
        ) : null}
      </div>
      <footer className="vs-status" aria-label="Status">
        <span className={`vs-status-item is-machine is-${connected ? 'on' : colab.status === 'connecting' ? 'busy' : 'off'}`} title={`Runs on ${machineName}`}>
          <span className="colab-dot" aria-hidden="true" /> {machineName}
          {colab.status === 'busy' ? ' · running' : connected ? '' : ' · not connected'}
        </span>
        <span className="vs-status-item" title="Where the files are kept">
          {playground.home.kind === 'drive' ? <DriveMark size={11} /> : null} {homeLabel}
        </span>
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
        {current ? (
          <>
            <span className="vs-status-item">{languageOf(current.path)}</span>
            <span className="vs-status-item">{dirty ? '● Unsaved' : 'Saved'}</span>
          </>
        ) : null}
        <button type="button" className={`vs-status-item is-btn${panelOpen ? ' is-on' : ''}`} onClick={() => setPanelOpen(!panelOpen)} title="Show or hide the panel: the console and terminals">
          {view === 'terminal' ? 'Terminal' : 'Console'}
        </button>
        <button type="button" className={`vs-status-item is-btn is-agent${agentOpen ? ' is-on' : ''}`} onClick={() => setAgentOpen(!agentOpen)} title="Show or hide the agent">
          <SparkleIcon size={11} /> Agent
        </button>
      </footer>
    </div>
  );
}

function Tree({ host, label, icon, note, disabled, onOpen, activePath }: { host: FileHost; label: string; icon?: React.ReactNode; note?: string; disabled?: boolean; onOpen: (path: string) => void; activePath: string | null }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="pg-tree-part">
      <button type="button" className={`pg-tree-head vs-section${open ? ' is-open' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="vs-chev" aria-hidden="true">›</span>
        {icon}
        <span>{label}</span>
      </button>
      {!open ? null : disabled ? <p className="pg-note pg-pad">{note}</p> : <Folder host={host} path="" depth={0} onOpen={onOpen} activePath={activePath} />}
    </div>
  );
}

/** Search, as VS Code's: every text file in the folder read, and the lines that hold the words, by file. */
function SearchView({ host, onOpen }: { host: FileHost; onOpen: (path: string) => void }) {
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
                  <button key={line.n} type="button" className="vs-hit-line mono" onClick={() => onOpen(hit.path)} title={`Line ${line.n}`}>
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

function Folder({ host, path, depth, onOpen, activePath }: { host: FileHost; path: string; depth: number; onOpen: (path: string) => void; activePath: string | null }) {
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
  }, [host, path]);
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
              {openDirs.has(entry.path) ? <Folder host={host} path={entry.path} depth={depth + 1} onOpen={onOpen} activePath={activePath} /> : null}
            </>
          ) : (
            <button type="button" className={`pg-entry${activePath === entry.path ? ' is-on' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onOpen(entry.path)}>
              <FileIcon path={entry.path} />
              {entry.name}
              {entry.size !== null ? <small>{entry.size < 1024 ? `${entry.size} B` : entry.size < 1048576 ? `${Math.round(entry.size / 1024)} KB` : `${(entry.size / 1048576).toFixed(1)} MB`}</small> : null}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function SyncPane({ playground, homeLabel, machineName, report, syncing, connected, onPush, onPull }: { playground: Playground; homeLabel: string; machineName: string; report: (SyncReport & { at: number; what: 'push' | 'pull' }) | null; syncing: 'push' | 'pull' | null; connected: boolean; onPush: () => void; onPull: () => void }) {
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
      <p className="pg-note">The folder is copied onto the machine before each command in the console, and what a run writes under the folders below comes back after it. Text files up to 2 MB; data and weights stay on the machine — fetch them there.</p>
      <div className="pg-machine-actions">
        <button type="button" className="btn sm" disabled={!connected || Boolean(syncing)} onClick={onPush}>
          {syncing === 'push' ? 'Copying…' : 'Copy to the machine now'}
        </button>
        <button type="button" className="btn sm" disabled={!connected || Boolean(syncing)} onClick={onPull}>
          {syncing === 'pull' ? 'Bringing back…' : 'Bring results back'}
        </button>
      </div>
      {report ? (
        <p className="pg-ok">
          {report.what === 'push' ? `${report.sent.length} ${report.sent.length === 1 ? 'file' : 'files'} copied to the machine` : `${report.back.length} ${report.back.length === 1 ? 'file' : 'files'} brought back`}
          {report.skipped.length ? ` · ${report.skipped.length} left where they were, over 2 MB` : ''} · {new Date(report.at).toLocaleTimeString()}
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
      <button type="button" className="btn sm primary" disabled={!changed} onClick={() => updatePlayground(playground.id, { sync: { ignore, bringBack } })}>
        Keep these rules
      </button>
    </div>
  );
}

