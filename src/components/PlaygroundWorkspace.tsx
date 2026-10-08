// One playground, at /playground/<id>: its notebook, or its files with an
// editor and a console, on the machine it is bound to. The bar says where
// the kernel is and opens the machine's menu; the pane on the right is the
// sync (when the files live somewhere other than the machine), the runtime's
// meters and the metrics the runs print — the same panes the paper's
// notebook has. The store is src/lib/playground.ts.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Backend } from '../lib/colab';
import { backendLabel, chooseBackend, colabAvailable, colabNow, connect, forgetRun, interrupt, lastActivityAt, runCell, runQuietly, setMachine, stopRuntime } from '../lib/colab';
import { notebookFor, runKey, subscribeNotebook } from '../lib/notebook';
import type { ConsoleEntry, FileHost, Playground, SyncReport } from '../lib/playground';
import { blankCells, filesAreOnMachine, homeHost, machineHost, machineRoot, notebookKey, pullBack, pushFolder, serverById, shellCell, takeSeed, updatePlayground, useServers } from '../lib/playground';
import type { RuntimeEntry } from '../lib/colab';
import { useStore } from '../lib/store';
import type { Screen } from '../lib/assistant';
import { CellRunOutput, ColabMark, useColab } from './Colab';
import MetricsPane from './MetricsPane';
import NotebookPage, { Editor } from './Notebook';
import type { NbSide } from './Notebook';
import RuntimePane from './RuntimePane';
import { WhereDialog } from './Playground';
import { ArrowLeftIcon, CloseIcon } from './icons';

type Tab = 'notebook' | 'files';
type FilesSide = 'sync' | 'runtime' | 'metrics' | null;

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
  const [filesSide, setFilesSide] = useState<FilesSide>(filesAreOnMachine(playground) ? null : 'sync');
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
        <MachineChip playground={playground} name={machineName} usable={usable} onChange={() => setChanging(true)} />
        {tab === 'notebook' ? (
          <>
            <button type="button" className={`btn sm ghost${side === 'runtime' ? ' is-on' : ''}`} aria-pressed={side === 'runtime'} onClick={() => setSide(side === 'runtime' ? null : 'runtime')}>
              Runtime
            </button>
            <button type="button" className={`btn sm ghost${side === 'metrics' ? ' is-on' : ''}`} aria-pressed={side === 'metrics'} onClick={() => setSide(side === 'metrics' ? null : 'metrics')}>
              Metrics
            </button>
          </>
        ) : (
          <>
            {!filesAreOnMachine(playground) ? (
              <button type="button" className={`btn sm ghost${filesSide === 'sync' ? ' is-on' : ''}`} aria-pressed={filesSide === 'sync'} onClick={() => setFilesSide(filesSide === 'sync' ? null : 'sync')}>
                Sync
              </button>
            ) : null}
            <button type="button" className={`btn sm ghost${filesSide === 'runtime' ? ' is-on' : ''}`} aria-pressed={filesSide === 'runtime'} onClick={() => setFilesSide(filesSide === 'runtime' ? null : 'runtime')}>
              Runtime
            </button>
            <button type="button" className={`btn sm ghost${filesSide === 'metrics' ? ' is-on' : ''}`} aria-pressed={filesSide === 'metrics'} onClick={() => setFilesSide(filesSide === 'metrics' ? null : 'metrics')}>
              Metrics
            </button>
          </>
        )}
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
      <div className="pg-body">
        {tab === 'notebook' ? (
          <div className="pg-notebook">
            <NotebookPage paperId={nbKey} title={playground.title} screen={screen} side={side} onSide={setSide} sections={[]} playground={{ hasPaper: cited.some(Boolean), seed }} />
          </div>
        ) : (
          <FilesView playground={playground} side={filesSide} onSide={setFilesSide} connected={connected} usable={usable} machineName={machineName} />
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

/** The chip in the bar: where the kernel is, how it is, and its menu — connect, restart, change, stop. */
function MachineChip({ playground, name, usable, onChange }: { playground: Playground; name: string; usable: boolean; onChange: () => void }) {
  const colab = useColab();
  const [open, setOpen] = useState(false);
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
  const dot = colab.status === 'busy' || colab.status === 'connecting' ? 'busy' : connected ? 'on' : colab.status === 'lost' || colab.status === 'error' ? 'lost' : 'off';
  const sample = colab.sample;
  const busy = sample ? [sample.gpu ? `GPU ${sample.gpu.util}%` : '', sample.cpu !== undefined ? `CPU ${sample.cpu}%` : ''].filter(Boolean).join(' · ') : '';
  const state = colab.status === 'connecting' ? 'connecting…' : colab.reconnecting ? 'reconnecting…' : colab.status === 'busy' ? busy || 'running' : connected ? 'idle' : colab.status === 'lost' ? 'ended' : 'not connected';
  return (
    <div className="menu-wrap" ref={box}>
      <button type="button" className={`colab-chip pg-chip is-${dot}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title={colab.error || `Cells run on ${name}`}>
        {playground.compute.kind === 'colab' ? <ColabMark /> : <span className={`pg-mark ${serverById(playground.compute.serverId)?.where === 'pc' ? 'is-pc' : 'is-gpu'}`}>{serverById(playground.compute.serverId)?.where === 'pc' ? 'PC' : 'GPU'}</span>}
        <span className={`colab-dot is-${dot}`} aria-hidden="true" />
        {name} · {state}
        {connected && colab.startedAt ? ` · ${clock(colab.startedAt, now)}` : ''}
      </button>
      {open ? (
        <div className="menu right pg-chip-menu" role="menu">
          <div className="menu-label">Where the code runs</div>
          <p className="pg-chip-note">
            <b>{name}</b>
            {colab.specs?.gpuName ? ` · ${colab.specs.gpuName}` : ''}
            {colab.specs?.ramTotalMb ? ` · ${Math.round(colab.specs.ramTotalMb / 1024)} GB RAM` : ''}
          </p>
          {!connected ? (
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
              onClick={() => {
                setOpen(false);
                void interrupt();
              }}
            >
              Stop what is running
            </button>
          )}
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
          {connected ? (
            <>
              <hr />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  void stopRuntime();
                }}
              >
                {playground.compute.kind === 'colab' ? 'Stop the Colab runtime' : 'Shut down the kernel'}
              </button>
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

function FilesView({ playground, side, onSide, connected, usable, machineName }: { playground: Playground; side: FilesSide; onSide: (next: FilesSide) => void; connected: boolean; usable: boolean; machineName: string }) {
  const colab = useColab();
  const servers = useServers();
  const split = !filesAreOnMachine(playground);
  // The hosts follow the servers' list, so an edited address is used at once.
  const home = useMemo(() => homeHost(playground), [playground, servers]);
  const machine = useMemo(() => machineHost(playground, machineName), [playground, machineName, servers]);
  const homeLabel = playground.home.kind === 'server' ? `${serverById(playground.home.serverId)?.name ?? 'a server'} · ${playground.home.root}` : 'this browser';
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [report, setReport] = useState<(SyncReport & { at: number; what: 'push' | 'pull' }) | null>(null);
  const [syncing, setSyncing] = useState<'push' | 'pull' | null>(null);
  const [command, setCommand] = useState(playground.pending ?? '');
  const [base, setBase] = useState<string | null>(null);
  const current = files.find((file) => `${file.where}:${file.path}` === active) ?? null;

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

  return (
    <div className="pg-files">
      <aside className="pg-tree">
        <Tree key={`home-${refresh}`} host={home} label={split ? `Files · ${homeLabel}` : `Files · ${homeLabel}`} onOpen={(path) => void open('home', path)} activePath={current?.where === 'home' ? current.path : null} onNew={() => void newFile()} />
        {split ? <Tree key={`machine-${refresh}-${connected}`} host={machine} label={`On ${machineName}`} note={connected ? undefined : 'Connect to see the folder on the machine.'} disabled={!connected} onOpen={(path) => void open('machine', path)} activePath={current?.where === 'machine' ? current.path : null} /> : null}
      </aside>
      <section className="pg-center">
        <div className="pg-tabs" role="tablist">
          {files.map((file) => {
            const key = `${file.where}:${file.path}`;
            return (
              <span key={key} className={`pg-tab${key === active ? ' is-on' : ''}`}>
                <button type="button" role="tab" aria-selected={key === active} onClick={() => setActive(key)} title={`${file.where === 'home' ? homeLabel : machineName} · ${file.path}`}>
                  {file.where === 'machine' ? '⇣ ' : ''}
                  {file.path.split('/').pop()}
                  {file.text !== file.saved ? ' •' : ''}
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
                  ×
                </button>
              </span>
            );
          })}
          <span className="spacer" />
          {current ? (
            <button type="button" className="btn sm" disabled={!dirty} onClick={() => void save(current)} title="⌘S">
              {dirty ? 'Save' : 'Saved'}
            </button>
          ) : null}
        </div>
        <div
          className="pg-editor"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && current) {
              event.preventDefault();
              void save(current);
            }
          }}
        >
          {current ? (
            <Editor value={current.text} python={/\.py$/.test(current.path)} onChange={(text) => setFiles((list) => list.map((f) => (f === current ? { ...f, text } : f)))} onKeyDown={() => undefined} />
          ) : (
            <div className="pg-editor-empty">
              <p>Open a file from the left, or make one.</p>
              <p className="pg-note">
                {playground.home.kind === 'server' ? `The folder is ${playground.home.root} on ${serverById(playground.home.serverId)?.name ?? 'the server'} — a plain folder: edit it in any editor too.` : 'These files are kept in this browser, and copied onto the machine before each command.'}
              </p>
            </div>
          )}
          {problem ? <p className="pg-note is-problem">{problem}</p> : null}
        </div>
        <div className="pg-console">
          <div className="pg-console-head">
            <b>Console</b>
            <span className="mono">
              {machineName}:{base ?? machineRoot(playground)}
            </span>
            <span className="spacer" />
            {colab.running?.startsWith('pgsh:') ? (
              <button type="button" className="btn sm colab-stop" onClick={() => void interrupt()}>
                ■ Stop
              </button>
            ) : null}
          </div>
          <div className="pg-console-log" ref={consoleLog}>
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
      {side ? (
        <aside className="nb-side pg-side-pane">
          <div className="nb-side-tabs" role="tablist">
            {split ? (
              <button type="button" role="tab" aria-selected={side === 'sync'} onClick={() => onSide('sync')}>
                Sync
              </button>
            ) : null}
            <button type="button" role="tab" aria-selected={side === 'runtime'} onClick={() => onSide('runtime')}>
              Runtime
            </button>
            <button type="button" role="tab" aria-selected={side === 'metrics'} onClick={() => onSide('metrics')}>
              Metrics
            </button>
            <span className="spacer" />
            <button type="button" className="icon-btn sm" onClick={() => onSide(null)} aria-label="Close the pane">
              <CloseIcon size={14} />
            </button>
          </div>
          {side === 'sync' && split ? (
            <SyncPane playground={playground} homeLabel={homeLabel} machineName={machineName} report={report} syncing={syncing} connected={connected} onPush={() => void push()} onPull={() => void pull()} />
          ) : side === 'runtime' ? (
            connected ? <RuntimePane cells={consoleCells} onGoTo={() => undefined} /> : <p className="pg-note pg-pad">Connect from the bar, or run a command, and the machine is read here: GPU, memory, disk.</p>
          ) : (
            <MetricsPane cells={metricCells} running={colab.running} />
          )}
        </aside>
      ) : null}
    </div>
  );
}

function Tree({ host, label, note, disabled, onOpen, activePath, onNew }: { host: FileHost; label: string; note?: string; disabled?: boolean; onOpen: (path: string) => void; activePath: string | null; onNew?: () => void }) {
  return (
    <div className="pg-tree-part">
      <div className="pg-tree-head">
        <span>{label}</span>
        {onNew ? (
          <button type="button" className="icon-btn sm" onClick={onNew} title="A new file" aria-label="A new file">
            +
          </button>
        ) : null}
      </div>
      {disabled ? <p className="pg-note pg-pad">{note}</p> : <Folder host={host} path="" depth={0} onOpen={onOpen} activePath={activePath} />}
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
                {entry.name}
              </button>
              {openDirs.has(entry.path) ? <Folder host={host} path={entry.path} depth={depth + 1} onOpen={onOpen} activePath={activePath} /> : null}
            </>
          ) : (
            <button type="button" className={`pg-entry${activePath === entry.path ? ' is-on' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onOpen(entry.path)}>
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
