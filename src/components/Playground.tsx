// The Playground's home, at /playground: ways to start something, the
// playgrounds there are, and the machines they can run on — the person's
// Colab and the Jupyter servers they have added. One playground opens at
// /playground/<id> (PlaygroundWorkspace). The store is src/lib/playground.ts;
// the kernel client, Colab's and a Jupyter server's alike, src/lib/colab.ts.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { JupyterServer, Machine } from '../lib/colab';
import { checkJupyter, colabAvailable, MACHINES } from '../lib/colab';
import type { CompanionInfo, MacDmg } from '../lib/companion';
import { claimForAccount, forgetDevice, pairForAccount, syncDevices } from '../lib/devices';
import { currentAccount, onProxyChange } from '../lib/api';
import { COMPANION_PORT, COMPANION_TLS_PORT, STARTABLE, companionCommands, companionDownloads, companionPort, desktopSystem, companionRoutes, findCompanion, findLocalCompanion, isSafari, latestMacDmg, normaliseCode, pairFragment, setStopWithApp, showCompanionCode, shutdownCompanion, startCompanion, vscodeInstall } from '../lib/companion';
import { fromIpynb } from '../lib/notebook';
import { newCell } from '../lib/notebook';
import type { Compute, FilesHome, NewPlayground, Playground as PlaygroundRecord } from '../lib/playground';
import {
  blankCells,
  createPlayground,
  deletePlayground,
  configurePlaygroundDrive,
  filesHere,
  labelBrowserHome,
  reachOf,
  loadPlaygrounds,
  usePlaygroundsWhere,
  syncPlaygrounds,
  modelCells,
  modelIdOf,
  paperCells,
  paperFiles,
  parseServerUrl,
  playgroundsLoaded,
  removeServer,
  repoNameOf,
  repoUrlOf,
  saveServer,
  serverById,
  serversNow,
  useDriveConnected,
  usePlaygrounds,
  useServers,
} from '../lib/playground';
import { useStore } from '../lib/store';
import type { Paper } from '../types';
import { ColabMark } from './Colab';
import { CloseIcon, CodeIcon, DriveMark, TrashIcon } from './icons';
import CopyBlock from './CopyBlock';
import PlaygroundWorkspace from './PlaygroundWorkspace';
import { RunRowAction, RunRowState, RunningChooser, RunningShelf } from './PlaygroundRuns';
import { AwayChooser, homeGroupOf } from './PlaygroundAway';
import { snapshotPlan } from '../lib/away';
import type { HomeGroup } from './PlaygroundAway';
import { useRunBoard } from '../lib/playgroundRuns';
import VsCodeExtension, { isCompanion } from './VsCodeExtension';

export default function Playground({ id, onOpen, onOpenPaper }: { id?: string; onOpen: (id?: string) => void; onOpenPaper: (id: string) => void }) {
  const list = usePlaygrounds();
  const { settings, driveConnected } = useStore();
  const [ready, setReady] = useState(playgroundsLoaded());
  const [fromDrive, setFromDrive] = useState(false);
  useEffect(() => {
    void loadPlaygrounds().then(() => setReady(true));
  }, []);
  // Signed in with Drive: the list is the account's, in its Drive, in every browser it signs in to.
  const clientId = settings.googleClientId.trim();
  useEffect(() => {
    configurePlaygroundDrive(driveConnected && clientId ? { clientId, folderName: settings.driveFolderName, account: currentAccount() ?? undefined } : null);
    if (driveConnected && clientId) void syncPlaygrounds().finally(() => setFromDrive(true));
  }, [driveConnected, clientId, settings.driveFolderName]);
  if (id) {
    const found = list.find((p) => p.id === id);
    // A link opened in a browser that hasn't got the list from Drive yet: wait for it before saying there is none.
    if (!found && driveConnected && clientId && !fromDrive) {
      return (
        <main className="main pg-page">
          <div className="pg-scroll">
            <div className="pg-missing">
              <p>
                <span className="spinner" /> Looking for it in your Drive…
              </p>
            </div>
          </div>
        </main>
      );
    }
    if (!found) {
      return (
        <main className="main pg-page">
          <div className="pg-scroll">
            {ready ? (
              <div className="pg-missing">
                <h1>No playground here</h1>
                <p>There is no playground at this address{driveConnected ? ' in your Drive' : ' in this browser'}. {driveConnected ? 'It may have been deleted, or made by another Google account.' : 'Signed out, playgrounds are kept in the browser they were made in: sign in with Google, with Drive, to have them in every browser.'}</p>
                <button type="button" className="btn primary" onClick={() => onOpen()}>
                  Go to the Playground
                </button>
              </div>
            ) : (
              <p className="pg-loading">
                <span className="spinner" /> Opening…
              </p>
            )}
          </div>
        </main>
      );
    }
    return <PlaygroundWorkspace key={found.id} playground={found} onBack={() => onOpen()} onOpenPaper={onOpenPaper} />;
  }
  return <PlaygroundHome list={list} ready={ready} onOpen={onOpen} />;
}

// ---------------------------------------------------------------- the home --

type Draft = Omit<NewPlayground, 'compute' | 'home'> & { note?: string };

const ago = (at: number) => {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86_400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
};

/** Where a playground runs, in a few words, with its mark. */
export function ComputeTag({ compute, home }: { compute: Compute; home?: FilesHome }) {
  const servers = useServers();
  const server = compute.kind === 'server' ? servers.find((s) => s.id === compute.serverId) : undefined;
  const homeServer = home?.kind === 'server' ? servers.find((s) => s.id === home.serverId) : undefined;
  const split = Boolean(homeServer && (compute.kind === 'colab' || homeServer.id !== server?.id));
  return (
    <span className="pg-where">
      {split ? (
        <>
          <span className="pg-mark is-pc">{homeServer?.where === 'pc' ? 'PC' : 'FS'}</span>
          <span className="pg-arrow">→</span>
        </>
      ) : null}
      {compute.kind === 'colab' ? <ColabMark /> : <span className={`pg-mark ${(server?.where ?? compute.where) === 'pc' ? 'is-pc' : 'is-gpu'}`}>{(server?.where ?? compute.where) === 'pc' ? 'PC' : 'GPU'}</span>}
      <span>{compute.kind === 'colab' ? `Colab ${MACHINES.find((m) => m.accelerator === compute.machine.accelerator)?.label ?? 'CPU'}${compute.shared ? ' · shared' : ''}` : server?.name ?? (compute.name ? `${compute.name} · not connected here` : compute.deviceId ? 'a computer not connected here' : 'a server no longer here')}</span>
    </span>
  );
}

/**
 * Which Companions answer now, looked at every half minute: 'up', 'down', or 'elsewhere' for one of your
 * account's that answers but no longer says it is yours (released, or connected to another account), so the
 * token kept for it is no good. Missing until the first look; other Jupyter servers aren't looked at.
 */
type Liveness = 'up' | 'down' | 'elsewhere';
function useLiveCompanions(servers: JupyterServer[]): Record<string, Liveness> {
  const [live, setLive] = useState<Record<string, Liveness>>({});
  const key = servers.filter(isCompanion).map((server) => `${server.id}@${server.url}@${server.account ?? ''}`).join(' ');
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const look = async () => {
      const companions = serversNow().filter(isCompanion);
      const answers = await Promise.all(
        companions.map(async (server) => {
          const info = await findCompanion(server.url, 5000);
          const state: Liveness = !info ? 'down' : server.account && !(info.owned && info.owner === maskEmail(server.account)) ? 'elsewhere' : 'up';
          return [server.id, state] as const;
        }),
      );
      if (!alive) return;
      setLive(Object.fromEntries(answers));
      timer = window.setTimeout(() => void look(), 30_000);
    };
    void look();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [key]);
  return live;
}

function PlaygroundHome({ list, ready, onOpen }: { list: PlaygroundRecord[]; ready: boolean; onOpen: (id?: string) => void }) {
  const where = usePlaygroundsWhere();
  const { papers, settings } = useStore();
  const servers = useServers();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [asking, setAsking] = useState<'paper' | 'repo' | 'model' | 'open' | null>(null);
  const [answer, setAnswer] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [addingServer, setAddingServer] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const filePick = useRef<HTMLInputElement>(null);
  const folderPick = useRef<HTMLInputElement>(null);
  const sorted = useMemo(() => [...list].sort((a, b) => b.updated - a.updated), [list]);
  // What each is doing — running, idle with its variables, how its last run ended — when the shelf is chosen.
  const runs = useRunBoard(list);
  const runById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
  const shows = settings.runningShows;
  const awayShows = settings.awayShows;
  const [choosingAway, setChoosingAway] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const colabOk = colabAvailable(settings.googleClientId);
  // The signed-in account's computers, from any browser it signs in to: now, and at each sign-in.
  useEffect(() => {
    void syncDevices();
    // Again every minute: a computer that starts again comes back at a new tunnel address.
    const timer = window.setInterval(() => void syncDevices(), 60_000);
    const stop = onProxyChange(() => void syncDevices());
    return () => {
      window.clearInterval(timer);
      stop();
    };
  }, []);
  // Your compute lists what answers now; the rest are a click away, under Offline.
  const live = useLiveCompanions(servers);
  // Which of the playgrounds kept in a browser have their files in this one (null until looked).
  const [filesInBrowser, setFilesInBrowser] = useState<Set<string> | null>(null);
  const browserKept = list.filter((p) => p.home.kind === 'browser' && p.kind === 'project').map((p) => p.id);
  useEffect(() => {
    let alive = true;
    void Promise.all(browserKept.map(async (id) => [id, await filesHere(id)] as const)).then((found) => {
      if (!alive) return;
      const here = found.filter(([, has]) => has).map(([id]) => id);
      setFilesInBrowser(new Set(here));
      // The browser that holds them says so in the record, for the others.
      for (const id of here) labelBrowserHome(id);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserKept.join(' ')]);
  const reach = (p: PlaygroundRecord) =>
    reachOf(p, {
      serverName: (id) => servers.find((server) => server.id === id)?.name,
      down: (id) => live[id] === 'down',
      browserHasFiles: !filesInBrowser || filesInBrowser.has(p.id),
    });
  const offline = servers.filter((server) => live[server.id] && live[server.id] !== 'up');
  const active = servers.filter((server) => !live[server.id] || live[server.id] === 'up');
  const [showOffline, setShowOffline] = useState(false);

  const begin = (next: Draft) => {
    setProblem(null);
    setAsking(null);
    setAnswer('');
    setDraft(next);
  };

  const fromAnswer = () => {
    if (asking === 'repo') {
      const url = repoUrlOf(answer);
      if (!url) return setProblem('That is not a repository address — try https://github.com/owner/name, or owner/name.');
      const name = repoNameOf(url);
      begin({ title: name, kind: 'project', start: 'repo', pending: `git clone --depth 1 ${url} . 2>&1 || git -C . pull`, cells: [newCell('markdown', `# ${name}\n\nCloned from ${url.replace(/\.git$/, '')} — the console in **Files** has the clone waiting for a click.`)], note: `The clone waits in the console: run it once the machine is connected.` });
    } else if (asking === 'model') {
      const model = modelIdOf(answer);
      if (!model) return setProblem('That is not a Hugging Face id — try meta-llama/Llama-3.2-1B, or a huggingface.co link.');
      begin({ title: model.replace(/^datasets\//, ''), kind: 'notebook', start: 'model', cells: modelCells(model) });
    }
  };

  const fromPaper = (paper: Paper) => {
    const cite = { paperId: paper.id, title: paper.title };
    const title = `Trying ${paper.title.split(/[:—–-]/)[0].trim().slice(0, 60)}`;
    const about = { ...cite, abstract: paper.abstract, authors: paper.authors, published: paper.published, arxivId: paper.arxivId, doi: paper.doi };
    // A project, as VS Code lays one out: the files, an editor, a console and an agent that knows the paper. The notebook is still a tab away.
    begin({ title, kind: 'project', start: 'paper', cites: [cite], files: paperFiles(title, about), cells: paperCells(paper.title, about) });
  };

  const fromFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    const name = file.name.replace(/\.[^.]+$/, '');
    if (/\.ipynb$/i.test(file.name)) {
      const cells = fromIpynb(text);
      if (!cells) return setProblem(`${file.name} is not a notebook this page can read.`);
      begin({ title: name, kind: 'notebook', start: 'file', cells });
    } else {
      begin({ title: name, kind: 'project', start: 'file', files: { [file.name]: text }, cells: blankCells(name) });
    }
  };

  /** A folder of code, picked from this computer: its code and small text files become the project's, wherever the next step keeps them. */
  const fromFolder = async (list: FileList | null) => {
    const picked = list ? [...list] : [];
    if (!picked.length) return;
    const name = picked[0].webkitRelativePath.split('/')[0] || 'folder';
    const byPath = new Map(picked.map((file) => [file.webkitRelativePath.split('/').slice(1).join('/'), file]));
    const plan = snapshotPlan([...byPath].map(([path, file]) => ({ path, size: file.size })));
    if (!plan.take.length) return setProblem(`${name} has no code or text files to open${plan.left.length ? ` (only ${plan.left.slice(0, 3).join(', ')}…)` : ''}.`);
    const files: Record<string, string> = {};
    for (const file of plan.take) files[file.path] = await byPath.get(file.path)!.text();
    const left = plan.left.length ? ` Left out: ${plan.left.slice(0, 6).join(', ')}${plan.left.length > 6 ? ` and ${plan.left.length - 6} more` : ''} — data, checkpoints, caches and large files.` : '';
    begin({ title: name, kind: 'project', start: 'file', files, cells: blankCells(name), note: `${plan.take.length} ${plan.take.length === 1 ? 'file' : 'files'} from ${name} go into the project.${left}` });
  };

  const matches = useMemo(() => {
    const q = answer.trim().toLowerCase();
    return papers
      .filter((paper) => !q || paper.title.toLowerCase().includes(q) || paper.authors.some((a) => a.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [answer, papers]);

  const starts: { key: string; mark: string; title: string; text: string; go: () => void }[] = [
    { key: 'blank', mark: '[ ]', title: 'Blank notebook', text: 'Cells, Markdown, maths, a kernel. The quickest way to try an idea.', go: () => begin({ title: 'Untitled notebook', kind: 'notebook', start: 'blank' }) },
    { key: 'project', mark: '{ }', title: 'Blank project', text: 'Files, an editor and a console — for code that outgrows cells.', go: () => begin({ title: 'Untitled project', kind: 'project', start: 'blank', files: { 'main.py': 'import torch\n\nprint("torch", torch.__version__, "· cuda", torch.cuda.is_available())\n', 'README.md': '# Untitled project\n' } }) },
    { key: 'paper', mark: '¶', title: 'From a paper', text: 'A paper from your library, as a project: files, an editor, a console, and an agent that has read its abstract.', go: () => (setAsking('paper'), setAnswer(''), setProblem(null)) },
    { key: 'repo', mark: '⑂', title: 'From a repository', text: 'A GitHub address — the paper’s own code, cloned onto the machine you pick.', go: () => (setAsking('repo'), setAnswer(''), setProblem(null)) },
    { key: 'model', mark: 'HF', title: 'From a model card', text: 'A Hugging Face model or dataset id: loaded, run once, ready to change.', go: () => (setAsking('model'), setAnswer(''), setProblem(null)) },
    { key: 'open', mark: '.nb', title: 'Open a file or folder', text: 'An .ipynb or a .py — or a whole folder of code, as a project. Then pick where the code lives and where it runs.', go: () => (setAsking('open'), setProblem(null)) },
  ];

  const renderRow = (p: PlaygroundRecord) => {
    const at = reach(p);
    const run = shows.shelf ? runById.get(p.id) : undefined;
    // With B chosen, a playground whose code is elsewhere still opens: on a card saying where it is.
    const closed = Boolean(at.blocked) && !awayShows.card;
    const openLabel = at.blocked && !closed ? (awayShows.snapshot && p.snapshot ? 'Snapshot' : 'Where is it?') : run?.phase === 'idle' ? 'Resume' : run?.phase === 'ran' ? 'Results' : 'Open';
    return (
    <li key={p.id} className={`pg-row${at.blocked ? ' is-blocked' : ''}`}>
      <button type="button" className="pg-row-main" onClick={() => !closed && onOpen(p.id)} disabled={closed} title={at.blocked}>
        <b>{p.title}</b>
        {run && run.phase !== 'never' ? <RunRowState run={run} /> : null}
        <span>
          {p.kind === 'project' ? 'Project' : 'Notebook'}
          {p.cites.length ? ` · cites ${p.cites.map((c) => c.title).join(', ').slice(0, 80)}` : ''}
        </span>
        <span className="pg-row-where">
          <span title="Where its code is: it stays there">
            <i>Code</i> {at.code}
          </span>
          <span title="Where it ran last; change it from the machine menu in the project">
            <i>Last ran on</i> {at.ran}
          </span>
          <span>
            <i>To open it</i> {at.needs}
          </span>
        </span>
        {(at.blocked && !awayShows.group) || at.warn ? <span className={`pg-row-note${at.blocked ? ' is-problem' : ''}`}>{at.blocked ?? at.warn}</span> : null}
      </button>
      <ComputeTag compute={p.compute} home={p.home} />
      <span className="pg-when">{ago(run?.at && run.at > p.updated ? run.at : p.updated)}</span>
      {confirmDelete === p.id ? (
        <span className="pg-confirm">
          <button type="button" className="btn sm danger" onClick={() => void deletePlayground(p.id).then(() => setConfirmDelete(null))}>
            Delete
          </button>
          <button type="button" className="btn sm ghost" onClick={() => setConfirmDelete(null)}>
            Keep
          </button>
        </span>
      ) : (
        <button type="button" className="icon-btn sm" aria-label={`Delete ${p.title}`} title="Delete this playground (its record and notebook; its files stay where they are — in Drive, or in a folder on a computer)" onClick={() => setConfirmDelete(p.id)}>
          <TrashIcon size={15} />
        </button>
      )}
      {run ? <RunRowAction run={run} /> : null}
      <button type="button" className={`btn sm${run?.phase === 'idle' ? ' primary' : ''}`} onClick={() => onOpen(p.id)} disabled={closed} title={at.blocked}>
        {openLabel}
      </button>
    </li>
    );
  };
  // A · grouped by where each playground's code is, with a filter for the ones that open from here.
  const [awayFilter, setAwayFilter] = useState<'all' | 'here' | 'away'>('all');
  const grouped = useMemo(() => {
    const byKey = new Map<string, HomeGroup & { items: PlaygroundRecord[] }>();
    let here = 0;
    for (const p of sorted) {
      const group = homeGroupOf(p, servers, live, !filesInBrowser || filesInBrowser.has(p.id));
      if (group.openable) here++;
      if (awayFilter === 'here' ? !group.openable : awayFilter === 'away' ? group.openable : false) continue;
      const known = byKey.get(group.key);
      if (known) known.items.push(p);
      else byKey.set(group.key, { ...group, items: [p] });
    }
    return { groups: [...byKey.values()].sort((a, b) => a.rank - b.rank), here };
  }, [sorted, servers, live, filesInBrowser, awayFilter]);
  return (
    <main className="main pg-page">
      <div className="pg-scroll">
        <header className="pg-hero">
          <div>
            <span className="eyebrow">Playground</span>
            <h1>Try something</h1>
            <p>Code that belongs to no paper — or to several. Pick a start and where it should run; the machine can be changed later without losing the code.</p>
          </div>
          <span className="pg-key">
            <kbd>P</kbd> from anywhere
          </span>
          <span className="pr-choose-wrap">
            <button type="button" className="pg-key pr-choose-btn" aria-expanded={choosing} onClick={() => setChoosing(!choosing)} title="How running playgrounds are shown around the app">
              Show running as…
            </button>
            {choosing ? (
              <div className="pr-choose-pop" role="dialog" aria-label="How running playgrounds are shown">
                <div className="pr-choose-pop-head">
                  <b>Running playgrounds</b>
                  <button type="button" className="icon-btn sm" aria-label="Close" onClick={() => setChoosing(false)}>
                    <CloseIcon size={14} />
                  </button>
                </div>
                <RunningChooser compact />
              </div>
            ) : null}
          </span>
          <span className="pr-choose-wrap">
            <button type="button" className="pg-key pr-choose-btn" aria-expanded={choosingAway} onClick={() => setChoosingAway(!choosingAway)} title="What a playground whose code is on another computer shows">
              Code on another computer…
            </button>
            {choosingAway ? (
              <div className="pr-choose-pop" role="dialog" aria-label="What a playground whose code is on another computer shows">
                <div className="pr-choose-pop-head">
                  <b>Code on another computer</b>
                  <button type="button" className="icon-btn sm" aria-label="Close" onClick={() => setChoosingAway(false)}>
                    <CloseIcon size={14} />
                  </button>
                </div>
                <AwayChooser />
              </div>
            ) : null}
          </span>
        </header>
        {shows.shelf ? <RunningShelf runs={runs} onOpen={(id) => onOpen(id)} /> : null}
        <div className="pg-grid">
          <section>
            <div className="pg-section-head">
              <span className="eyebrow">Start from</span>
            </div>
            <div className="pg-starts">
              {starts.map((start) => (
                <button key={start.key} type="button" className={`pg-start${asking === start.key ? ' is-on' : ''}`} onClick={start.go}>
                  <span className="pg-start-mark">{start.mark}</span>
                  <b>{start.title}</b>
                  <span>{start.text}</span>
                </button>
              ))}
            </div>
            <input ref={filePick} type="file" accept=".ipynb,.py,.txt,.md,application/json" hidden onChange={(event) => void fromFile(event.target.files?.[0]).then(() => (event.target.value = ''))} />
            <input ref={folderPick} type="file" hidden {...{ webkitdirectory: '', directory: '' }} multiple onChange={(event) => void fromFolder(event.target.files).then(() => (event.target.value = ''))} />
            {asking === 'open' ? (
              <div className="pg-ask pg-open">
                <div className="pg-open-choices">
                  <button type="button" className="pg-open-choice" onClick={() => filePick.current?.click()}>
                    <b>A file</b>
                    <span>An .ipynb opens as a notebook; a .py, .md or .txt starts a project with it.</span>
                  </button>
                  <button type="button" className="pg-open-choice" onClick={() => folderPick.current?.click()}>
                    <b>A folder</b>
                    <span>Its code and small text files become a project, with the editor, console and agent. Data, checkpoints, caches and large files are left where they are.</span>
                  </button>
                  <button type="button" className="icon-btn sm" aria-label="Cancel" onClick={() => setAsking(null)}>
                    <CloseIcon size={14} />
                  </button>
                </div>
                <p className="pg-note">Next: where its code is kept — your Drive, a folder on a computer of yours, or this browser — and where it runs, as for any new playground.</p>
                {problem ? <p className="pg-note is-problem">{problem}</p> : null}
              </div>
            ) : asking ? (
              <div className="pg-ask">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (asking === 'paper') {
                      if (matches[0]) fromPaper(matches[0]);
                    } else fromAnswer();
                  }}
                >
                  <input
                    autoFocus
                    value={answer}
                    onChange={(event) => {
                      setAnswer(event.target.value);
                      setProblem(null);
                    }}
                    placeholder={asking === 'paper' ? 'Find a paper in your library…' : asking === 'repo' ? 'https://github.com/owner/name, or owner/name' : 'meta-llama/Llama-3.2-1B, or datasets/imdb'}
                    aria-label={asking === 'paper' ? 'A paper in your library' : asking === 'repo' ? 'A repository' : 'A Hugging Face id'}
                  />
                  {asking !== 'paper' ? (
                    <button type="submit" className="btn primary sm" disabled={!answer.trim()}>
                      Next
                    </button>
                  ) : null}
                  <button type="button" className="icon-btn sm" aria-label="Cancel" onClick={() => setAsking(null)}>
                    <CloseIcon size={14} />
                  </button>
                </form>
                {asking === 'paper' ? (
                  matches.length ? (
                    <ul className="pg-papers">
                      {matches.map((paper) => (
                        <li key={paper.id}>
                          <button type="button" onClick={() => fromPaper(paper)}>
                            <b>{paper.title}</b>
                            <span>
                              {paper.authors.slice(0, 3).join(', ')}
                              {paper.published ? ` · ${paper.published.slice(0, 4)}` : ''}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="pg-note">{papers.length ? 'No paper in your library matches.' : 'Your library is empty — save a paper first, from Home or Discover.'}</p>
                  )
                ) : null}
                {problem ? <p className="pg-note is-problem">{problem}</p> : null}
              </div>
            ) : problem ? (
              <p className="pg-note is-problem">{problem}</p>
            ) : null}

            <div className="pg-section-head">
              <span className="eyebrow">Your playgrounds</span>
              <span className="pg-aside" title={where === 'drive' ? 'Each playground’s name, machine, folder and notebook are in your Google Drive (playgrounds.json in your Reader folder); its files stay where they are.' : undefined}>
                {where === 'drive' ? 'kept in your Drive' : where === 'error' ? 'kept in this browser · Drive didn’t answer' : 'kept in this browser · sign in with Drive to keep them there'}
              </span>
            </div>
            {!ready ? (
              <p className="pg-note">
                <span className="spinner" /> Reading…
              </p>
            ) : sorted.length ? (
              awayShows.group ? (
                <>
                  <div className="away-filter segmented" role="tablist" aria-label="Which playgrounds">
                    {(['all', 'here', 'away'] as const).map((f) => (
                      <button key={f} type="button" role="tab" aria-selected={awayFilter === f} aria-pressed={awayFilter === f} onClick={() => setAwayFilter(f)}>
                        {f === 'all' ? `All · ${sorted.length}` : f === 'here' ? `Open here · ${grouped.here}` : `On other computers · ${sorted.length - grouped.here}`}
                      </button>
                    ))}
                  </div>
                  {grouped.groups.map((group) => (
                    <div key={group.key} className="away-group">
                      <div className="away-group-head">
                        <b>{group.label}</b>
                        <span className={`away-pill is-${group.tone}`}>
                          <i aria-hidden="true" />
                          {group.note}
                        </span>
                      </div>
                      <ul className="pg-list">{group.items.map(renderRow)}</ul>
                    </div>
                  ))}
                  {!grouped.groups.length ? <p className="pg-note">{awayFilter === 'here' ? 'None of them open from this browser as it stands.' : 'All of them open from here.'}</p> : null}
                </>
              ) : (
              <ul className="pg-list">
                {sorted.map(renderRow)}
              </ul>
              )
            ) : (
              <div className="pg-empty">
                <CodeIcon size={20} />
                <p>Nothing here yet. Start one above — a blank notebook runs on your Colab with nothing to install.</p>
              </div>
            )}
          </section>

          <aside className="pg-side">
            <div className="pg-section-head">
              <span className="eyebrow">Your compute</span>
              <button type="button" className="btn ghost sm" onClick={() => setAddingServer(true)}>
                + Add a server
              </button>
            </div>
            <div className="pg-card">
              <div className="pg-machine">
                <div className="pg-machine-head">
                  <ColabMark />
                  <b>Google Colab</b>
                  <span>{colabOk ? 'ready' : 'needs set-up'}</span>
                </div>
                <p>{colabOk ? 'CPU, T4, L4, A100 — in your own Colab account, on your tier and units.' : 'Running on Colab needs a Google client ID and the reader’s proxy, in Settings.'}</p>
              </div>
              {active.map((server) => (
                <ServerRow key={server.id} server={server} />
              ))}
              {offline.length ? (
                <div className="pg-offline">
                  <button type="button" className="pg-offline-toggle" aria-expanded={showOffline} onClick={() => setShowOffline(!showOffline)}>
                    <span className={`pg-offline-chevron${showOffline ? ' is-open' : ''}`} aria-hidden="true">
                      ›
                    </span>
                    Offline · {offline.length}
                    <span className="pg-offline-names">{showOffline ? '' : offline.map((server) => server.name).join(', ')}</span>
                  </button>
                  {showOffline ? offline.map((server) => <ServerRow key={server.id} server={server} offline={live[server.id] === 'elsewhere' ? 'elsewhere' : true} />) : null}
                </div>
              ) : null}
            </div>
            {!servers.some((server) => server.where === 'pc') && !addingServer ? <CompanionConnect onManual={() => setAddingServer(true)} /> : null}
            {addingServer ? <ServerForm onDone={() => setAddingServer(false)} /> : null}
          </aside>
        </div>
      </div>
      <PairFromLink />
      {draft ? (
        <WhereDialog
          draft={draft}
          onClose={() => setDraft(null)}
          onCreate={async (spec) => {
            const made = await createPlayground(spec);
            setDraft(null);
            onOpen(made.id);
          }}
        />
      ) : null}
    </main>
  );
}

// -------------------------------------------------------------- servers ----

function ServerRow({ server, offline = false }: { server: JupyterServer; offline?: boolean | 'elsewhere' }) {
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [editing, setEditing] = useState(false);
  const companion = Boolean(server.companionId || companionPort(server.url));
  const [power, setPower] = useState<Power>('unknown');
  const [note, setNote] = useState<string | null>(null);
  /** Whether it shuts down with the Reader app's window: undefined for a Companion from before 0.7.4, or one not answering. */
  const [stopWithApp, setStopWithAppState] = useState<boolean | undefined>(undefined);
  const local = companionPort(server.url) !== null;
  useEffect(() => {
    if (!companion) return;
    let live = true;
    void findCompanion(server.url, 2500).then((info) => {
      if (!live) return;
      setPower((now) => (now === 'unknown' ? (info ? 'up' : 'down') : now));
      setStopWithAppState(info?.stopWithApp);
    });
    return () => {
      live = false;
    };
  }, [companion, server.url]);
  const account = currentAccount();
  const [claiming, setClaiming] = useState(false);
  const claim = async () => {
    setClaiming(true);
    setNote(null);
    const { problem } = await claimForAccount(server);
    setClaiming(false);
    setNote(problem ?? `Connected to ${account}: it is under Your compute in every browser signed in as it, here and on other computers. Your files stay on this computer.`);
  };
  const toggle = async (on: boolean) => {
    setNote(null);
    setState(null);
    if (!on) {
      setPower('stopping');
      try {
        await shutdownCompanion(server);
        setPower('down');
        setNote('Shut down: no Jupyter server, no kernels. It stays off, at your next login too, until you turn it on here, open the Reader app, or run reader-companion start.');
      } catch (error) {
        setPower('up');
        setNote(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    setPower('starting');
    const info = await startCompanion(server.url);
    setPower(info ? 'up' : 'down');
    if (!info) setNote(`It didn’t start from here. Open the Reader app on this computer, or run reader-companion start in a terminal. (The page can start a Companion from ${STARTABLE} on, installed with the Reader app or the installer.)`);
  };
  const test = async () => {
    setChecking(true);
    const answer = await checkJupyter(server);
    setChecking(false);
    setState(answer.ok ? { ok: true, text: `answers${answer.version ? ` · Jupyter Server ${answer.version}` : ''}` } : { ok: false, text: answer.error });
  };
  if (editing) return <ServerForm server={server} onDone={() => setEditing(false)} />;
  return (
    <div className={`pg-machine${offline ? ' is-offline' : ''}`}>
      <div className="pg-machine-head">
        <span className={`pg-mark ${server.where === 'pc' || companion ? 'is-pc' : 'is-gpu'}`}>{server.where === 'pc' || companion ? 'PC' : 'GPU'}</span>
        <b>{server.name}</b>
        <span className="mono">{safeHost(server.url)}</span>
      </div>
      {state ? <p className={state.ok ? 'pg-ok' : 'pg-bad'}>{state.text}</p> : null}
      {offline === 'elsewhere' ? <p className="pg-machine-seen">It runs, but it isn’t connected to {server.account} any more (released on that computer, or connected to another account). Connect it again from that computer — open the Reader app there — or Remove it here.</p> : offline ? <p className="pg-machine-seen">Not answering{server.seen ? ` · last seen ${ago(server.seen)}` : ''}. {server.where === 'pc' ? 'Turn it on below, or open the Reader app.' : 'Start it on that computer: the Reader app, or reader-companion start.'}</p> : null}
      {companion && server.account ? <p>Yours as {server.account}{server.where === 'pc' ? '' : ' · on another computer, through its tunnel'}. Its files stay on it.</p> : null}
      {note ? <p>{note}</p> : null}
      {state && !state.ok && companion ? (
        <div className="pg-howto">
          <small>It’s the Companion: open the <b>Reader</b> app on this computer, or start it again in a terminal. Either opens a link here that reconnects it.</small>
          <CopyBlock code={companionCommands(siteBase(), { tunnel: isSafari() }).unix} />
        </div>
      ) : null}
      <VsCodeExtension server={server} />
      <div className="pg-machine-actions">
        <button type="button" className="btn sm ghost" onClick={() => void test()} disabled={checking}>
          {checking ? 'Testing…' : 'Test'}
        </button>
        <button type="button" className="btn sm ghost" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button
          type="button"
          className="btn sm ghost danger"
          title={server.account ? `Takes it off ${server.account}'s computers, in every browser. Connect it again from that computer to have it back.` : 'Forget it in this browser'}
          onClick={() => {
            if (server.account && server.companionId) void forgetDevice(server.companionId);
            removeServer(server.id);
          }}
        >
          Remove
        </button>
        {companion && account && !server.account ? (
          <button type="button" className="btn sm ghost" disabled={claiming} onClick={() => void claim()} title="Only this Google account reaches it then, from any browser it signs in to; browsers paired before lose it.">
            {claiming ? 'Connecting…' : 'Connect to my account'}
          </button>
        ) : null}
        {companion ? <PowerSwitch power={power} canStart={companionPort(server.url) !== null} onChange={(on) => void toggle(on)} /> : null}
      </div>
      {companion && local && stopWithApp !== undefined ? (
        <label className="pg-stop-with-app" title="The Reader app opens this site in a window of its own and starts the Companion; with this on, closing that window shuts the Companion down too, until you open the app again. Turn it off to keep reaching this computer from your other devices while its window is closed.">
          <input
            type="checkbox"
            checked={stopWithApp}
            onChange={(event) => {
              const on = event.target.checked;
              setStopWithAppState(on);
              void setStopWithApp(server, on).then(setStopWithAppState, (error) => (setStopWithAppState(!on), setNote(error instanceof Error ? error.message : String(error))));
            }}
          />
          <span>Shut down when the Reader window closes</span>
        </label>
      ) : null}
    </div>
  );
}

const safeHost = (url: string) => {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url;
  }
};

/**
 * The steps for code on one machine and compute on another, both away from the
 * browser: a Reader Companion on each, through its HTTPS tunnel, connected to
 * the Google account so every browser signed in as it has them.
 */
export function acrossMachinesSteps(site: string): { label: string; code: string }[] {
  const base = site.replace(/\/?$/, '/');
  return [
    {
      label: '1 · On the computer that keeps your code (at home, say): installs the Companion for good, with an HTTPS tunnel, starting at every login. It prints a link: open it in the browser you work in (copy it over from an SSH session), signed in with Google.',
      code: `curl -LsSf ${base}companion-setup.sh | sh -s -- --tunnel --no-vscode --name "Home computer"\n# Windows (PowerShell):\n# & ([scriptblock]::Create((irm ${base}companion-setup.ps1))) --tunnel --no-vscode --name "Home computer"`,
    },
    {
      label: '2 · On the GPU machine: the same line where it stays up (a lab server, your own box). On a pod or an SSH session that ends, run it in the foreground instead, in tmux so it survives the session closing; it prints the link the same way.',
      code: `curl -LsSf ${base}companion-setup.sh | sh -s -- --tunnel --no-vscode --name "GPU box"\n# or, on a pod / for one session:\ntmux new -s reader\ncurl -LsSf ${base}companion.sh | sh -s -- --tunnel --no-browser --name "GPU box"`,
    },
    {
      label: 'A new link at any time, on either machine (a link is good for a few minutes):',
      code: '~/.local/bin/reader-companion pair --no-browser',
    },
    {
      label: '3 · In the browser you work in: open both links. Signed in with Google, both computers are kept under your account and show up in every browser you sign in to. Then a new project → “Code on one machine, compute on another”: the code kept on the first, run on the GPU machine. Before each run the folder is copied there (through this browser, text files up to 2 MB); what it writes under runs/ and results/ comes back. Keep data and weights on the GPU machine and fetch them there.',
      code: '',
    },
  ];
}

/** The commands that start a Jupyter server this page may talk to, for this site's origin. */
export function serverCommands(where: 'pc' | 'remote', origin: string): { label: string; code: string }[] {
  // One flag a line, joined with backslashes: easy to read in a narrow card, and still one command when pasted.
  const server = (...extra: string[]) => ['jupyter server', `--ServerApp.allow_origin='${origin}'`, '--ServerApp.root_dir="$HOME/reader-playgrounds"', ...extra].join(' \\\n  ');
  const setup = 'mkdir -p "$HOME/reader-playgrounds"\npip install jupyter_server ipykernel';
  if (where === 'pc') return [{ label: 'On this PC, in a terminal', code: `${setup}\n${server()}` }];
  return [
    { label: 'On the other machine — a GPU box, a lab server, a cloud VM, or a computer that keeps your code', code: `${setup}\n${server('--ServerApp.port=8888')}` },
    { label: 'Then on this PC — an SSH tunnel to it (a lab server, a cloud VM, a pod with SSH)', code: 'ssh -N -L 8890:localhost:8888 you@that-machine\n# then add http://localhost:8890/?token=… here' },
    { label: 'Or, on RunPod: start it on 0.0.0.0 and use the pod’s own HTTPS address', code: `${setup}\n${server('--ServerApp.ip=0.0.0.0', '--ServerApp.port=8888')}\n# address: https://<pod-id>-8888.proxy.runpod.net/?token=…` },
  ];
}

function ServerForm({ server, onDone, onSaved, defaultWhere = 'pc' }: { server?: JupyterServer; onDone: () => void; onSaved?: (server: JupyterServer) => void; defaultWhere?: 'pc' | 'remote' }) {
  const [name, setName] = useState(server?.name ?? (defaultWhere === 'pc' ? 'This PC' : 'Another machine'));
  const [where, setWhere] = useState<'pc' | 'remote'>(server?.where ?? defaultWhere);
  /** The steps for code and compute both elsewhere, shown in place of the form. */
  const [across, setAcross] = useState(false);
  const [address, setAddress] = useState(server ? `${server.url}${server.token ? `?token=${server.token}` : ''}` : '');
  const [token, setToken] = useState('');
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = parseServerUrl(address);
  const effective = parsed ? { url: parsed.url, token: token.trim() || parsed.token || '' } : null;
  const origin = typeof window === 'undefined' ? 'https://saurav717.github.io' : window.location.origin;
  const save = async () => {
    if (!effective) return;
    setBusy(true);
    const answer = await checkJupyter(effective);
    setBusy(false);
    if (!answer.ok) {
      setState({ ok: false, text: answer.error });
      return;
    }
    const saved = saveServer({ id: server?.id, name: name.trim() || (where === 'pc' ? 'This PC' : 'Another machine'), where, url: effective.url, token: effective.token });
    onSaved?.(saved);
    onDone();
  };
  return (
    <div className="pg-card pg-server-form">
      <div className="pg-section-head">
        <b>{server ? 'Edit the server' : 'A Jupyter server of yours'}</b>
        <button type="button" className="icon-btn sm" aria-label="Close" onClick={onDone}>
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="segmented pg-seg" role="radiogroup" aria-label="Where it runs">
        <button type="button" role="radio" aria-checked={!across && where === 'pc'} className={!across && where === 'pc' ? 'on' : ''} onClick={() => (setWhere('pc'), setAcross(false))}>
          On this PC
        </button>
        <button type="button" role="radio" aria-checked={!across && where === 'remote'} className={!across && where === 'remote' ? 'on' : ''} onClick={() => (setWhere('remote'), setAcross(false))}>
          Another machine
        </button>
        {!server ? (
          <button type="button" role="radio" aria-checked={across} className={across ? 'on' : ''} onClick={() => setAcross(true)} title="Code on one computer, compute on another, this browser on a third">
            Across machines
          </button>
        ) : null}
      </div>
      {across ? (
        <div className="pg-howto pg-across">
          <p>The browser here, your code on one computer, the GPU on another: a Reader Companion on each of the two, reached through its HTTPS tunnel from wherever you are.</p>
          {acrossMachinesSteps(siteBase()).map((step) => (
            <div key={step.label}>
              <small>{step.label}</small>
              {step.code ? <CopyBlock code={step.code} /> : null}
            </div>
          ))}
        </div>
      ) : (
      <>
      <details className="pg-howto" open={!server}>
        <summary>How to start one</summary>
        {serverCommands(where, origin).map((step) => (
          <div key={step.label}>
            <small>{step.label}</small>
            <CopyBlock code={step.code} />
          </div>
        ))}
        <small>Jupyter prints an address with <code>?token=</code> — paste it below. The token stays in this browser. A browser may ask once to let this site reach your local network: allow it.</small>
      </details>
      <label>
        <span>Name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        <span>Address</span>
        <input value={address} onChange={(event) => (setAddress(event.target.value), setState(null))} placeholder="http://localhost:8888/?token=…" spellCheck={false} />
      </label>
      {parsed && !parsed.token ? (
        <label>
          <span>Token</span>
          <input value={token} onChange={(event) => setToken(event.target.value)} placeholder="the server’s token, if the address has none" spellCheck={false} />
        </label>
      ) : null}
      {state ? <p className={state.ok ? 'pg-ok' : 'pg-bad'}>{state.text}</p> : null}
      <div className="pg-machine-actions">
        <button type="button" className="btn primary sm" disabled={!effective || busy} onClick={() => void save()}>
          {busy ? 'Testing…' : 'Test and save'}
        </button>
        {address && !parsed ? <span className="pg-bad">That is not an http(s) address.</span> : null}
      </div>
      </>
      )}
    </div>
  );
}

// ------------------------------------------------------------ companion ----

/** This site's address with its base path: what the Companion's installers are served under. */
const siteBase = () => (typeof window === 'undefined' ? 'https://saurav717.github.io/reader/' : `${window.location.origin}${import.meta.env.BASE_URL}`);

/** The first of these addresses a Companion answers on, trying for a while: a new tunnel can take some seconds to be found. */
async function reachCompanion(routes: string[], forMs: number): Promise<{ base: string; info: CompanionInfo } | null> {
  const until = Date.now() + forMs;
  for (;;) {
    for (const base of routes) {
      const info = await findCompanion(base, 4000);
      if (info) return { base, info };
    }
    if (Date.now() > until) return null;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

type Power = 'unknown' | 'up' | 'down' | 'stopping' | 'starting';

/** An address as the Companion shows its owner's (account.mask): sa•••@gmail.com. */
const maskEmail = (email: string | null) => {
  if (!email) return '';
  const [name, domain] = email.split('@');
  return domain ? `${name.slice(0, 2)}${'•'.repeat(Math.max(1, name.length - 2))}@${domain}` : email;
};

/** The Companion's on/off switch: off shuts it down (kernels, Jupyter server, process) and keeps it off; on starts it through the reader-companion:// link. */
function PowerSwitch({ power, onChange, canStart = true }: { power: Power; onChange: (on: boolean) => void; canStart?: boolean }) {
  const on = power === 'up' || power === 'starting';
  const stuck = power === 'down' && !canStart;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="The Companion on this computer"
      className={`pg-power is-${power}`}
      disabled={power === 'unknown' || power === 'stopping' || power === 'starting' || stuck}
      onClick={() => onChange(!on)}
      title={stuck ? 'It is off. Start it on that computer: open the Reader app there, or run reader-companion start.' : on ? 'Shut the Companion down: its kernels and Jupyter server stop, and it stays off until it is turned on again.' : 'Start the Companion on this computer. Your browser asks once whether to open the Reader app.'}
    >
      <span className="pg-power-track" aria-hidden="true">
        <span className="pg-power-knob" />
      </span>
      {power === 'stopping' ? 'Stopping…' : power === 'starting' ? 'Starting…' : power === 'unknown' ? '…' : on ? 'On' : 'Off'}
    </button>
  );
}

/** "Connect this computer": the Companion's one-line start, then the code it prints. The page looks for it while this is open. */
function CompanionConnect({ onPaired, onManual, onClose }: { onPaired?: (server: JupyterServer) => void; onManual?: () => void; onClose?: () => void }) {
  const safari = isSafari();
  const commands = companionCommands(siteBase(), { tunnel: safari });
  const windows = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || navigator.userAgent);
  const [os, setOs] = useState<'unix' | 'windows' | 'uv' | 'vscode'>(windows ? 'windows' : 'unix');
  const vscode = vscodeInstall(siteBase(), windows);
  const downloads = companionDownloads(siteBase());
  const [system, setSystem] = useState(desktopSystem);
  const [dmg, setDmg] = useState<MacDmg | null>(null);
  useEffect(() => {
    let live = true;
    void latestMacDmg().then((url) => live && setDmg(url));
    return () => {
      live = false;
    };
  }, []);
  const download = system === 'mac' && dmg ? { ...downloads.mac, href: dmg.url, file: 'Reader.dmg' } : downloads[system];
  const [found, setFound] = useState<CompanionInfo | null>(null);
  const [foundAt, setFoundAt] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [looks, setLooks] = useState(0);
  const [asking, setAsking] = useState(false);
  const [shown, setShown] = useState<boolean | null>(null);
  // A Companion this card shut down: still shown, with its switch, rather than the install steps.
  const [stopped, setStopped] = useState<{ base: string; info: CompanionInfo } | null>(null);
  const [moving, setMoving] = useState<'stopping' | 'starting' | null>(null);
  const power: Power = moving ?? (found ? 'up' : stopped ? 'down' : 'unknown');
  const toggle = async (on: boolean) => {
    setProblem(null);
    if (!on) {
      if (!found || !foundAt) return;
      const was = { base: foundAt, info: found };
      setMoving('stopping');
      setStopped(was);
      try {
        await shutdownCompanion({ url: foundAt });
        setFound(null);
        setFoundAt(null);
      } catch (error) {
        setStopped(null);
        setProblem(error instanceof Error ? error.message : String(error));
      } finally {
        setMoving(null);
      }
      return;
    }
    if (!stopped) return;
    setMoving('starting');
    const info = await startCompanion(stopped.base);
    setMoving(null);
    if (info) {
      setFound(info);
      setFoundAt(stopped.base);
      setStopped(null);
    } else {
      setProblem(`It didn’t start from here. Open the Reader app on this computer, or run reader-companion start in a terminal. (The page can start a Companion from ${STARTABLE} on, installed with the Reader app or the installer.)`);
    }
  };
  const askForCode = async () => {
    setAsking(true);
    setShown(await showCompanionCode(foundAt ?? undefined));
    setAsking(false);
  };
  useEffect(() => {
    // Its https address first (Safari's only way in), then, for the others, its http one.
    let live = true;
    let timer = 0;
    const look = async () => {
      const here = await findLocalCompanion(safari);
      if (!live) return;
      // A Companion another Google account owns isn't shown at all: not its name, its folder or its switch.
      const reached = here && (!here.info.owned || here.info.owner === maskEmail(currentAccount())) ? here : null;
      setFound(reached?.info ?? null);
      setFoundAt(reached?.base ?? null);
      if (reached) setStopped(null);
      setLooks((n) => n + 1);
      timer = window.setTimeout(() => void look(), reached ? 5000 : 2000);
    };
    void look();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [safari]);
  const connect = async () => {
    setBusy(true);
    setProblem(null);
    try {
      if (!foundAt) throw new Error('The Companion stopped answering. Is it still running?');
      const { server: saved } = await pairForAccount(code, foundAt);
      onPaired?.(saved);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pg-card pg-companion">
      <div className="pg-section-head">
        <b>Connect this computer</b>
        {onClose ? (
          <button type="button" className="icon-btn sm" aria-label="Close" onClick={onClose}>
            <CloseIcon size={14} />
          </button>
        ) : null}
      </div>
      {found ? (
        <>
          <div className="pg-companion-found">
            <span className="pg-live" />
            <div>
              <b>{found.name}</b>
              <small>
                {found.hardware} · <span className="mono">{found.root}</span>
              </small>
            </div>
            <PowerSwitch power={power} onChange={(on) => void toggle(on)} />
          </div>
          <div className="pg-companion-ask">
            <button type="button" className="btn sm" disabled={asking} onClick={() => void askForCode()}>
              {asking ? 'Asking…' : 'Show the code on this computer'}
            </button>
            {shown === true ? <small className="pg-companion-note">It’s in a window on this computer’s screen.</small> : null}
            {shown === false ? <small className="pg-companion-note">This computer can’t show it in a window. Open the <b>Reader</b> app instead, which connects with no code, or run <span className="mono">reader-companion pair</span>.</small> : null}
          </div>
          <label className="pg-companion-code">
            <span>Type the code it shows</span>
            <span className="pg-companion-row">
              <input value={code} onChange={(event) => (setCode(event.target.value), setProblem(null))} onKeyDown={(event) => event.key === 'Enter' && normaliseCode(code).length === 7 && void connect()} placeholder="ABC-DEF" spellCheck={false} autoComplete="off" maxLength={9} />
              <button type="button" className="btn primary sm" disabled={busy || normaliseCode(code).length !== 7} onClick={() => void connect()}>
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            </span>
          </label>
          <small className="pg-companion-note">Or open the Reader app, or the link the terminal printed: both connect with no code.</small>
        </>
      ) : stopped ? (
        <>
          <div className="pg-companion-found is-off">
            <span className="pg-off" />
            <div>
              <b>{stopped.info.name}</b>
              <small>shut down · no Jupyter server, no kernels</small>
            </div>
            <PowerSwitch power={power} onChange={(on) => void toggle(on)} />
          </div>
          <small className="pg-companion-note">It stays off, at your next login too, until you turn it on here, open the Reader app, or run <span className="mono">reader-companion start</span>.</small>
        </>
      ) : (
        <>
          <div className="pg-companion-install">
            <p className="pg-companion-lede">
              <b>Get the Reader app.</b> One install sets up the Jupyter server your projects run on (your files stay in <span className="mono">~/Reader</span>), adds the Reader extension to VS Code if you have it, and makes a <b>Reader</b> app: open it from the Dock, the Start menu or Spotlight, and the site opens in its own window, connected to this computer. Nothing else to install first.
            </p>
            {system === 'linux' ? (
              <CopyBlock code={download.command} />
            ) : (
              <a className="btn primary pg-companion-download" href={download.href} download={system === 'mac' && dmg ? undefined : true}>
                Download for {download.label}
              </a>
            )}
            <small className="pg-companion-note">
              {system === 'mac' ? (
                <>
                  {dmg ? (
                    <>
                      Open the .dmg, drag <b>Reader</b> to Applications, and open it.{' '}
                      {dmg.notarized ? (
                        'It’s signed and notarized by Apple, so macOS opens it without asking.'
                      ) : (
                        <>
                          macOS stops it the first time (“Apple could not verify…”, as it isn’t notarized): click <b>Done</b>, then <b>Open Anyway</b> in System Settings → Privacy &amp; Security, and <b>Open</b>. After that it opens like any app. To skip that step, paste <span className="mono">{download.command}</span> into Terminal instead: it makes the same Reader app.
                        </>
                      )}{' '}
                      The first time, it sets itself up in a minute or two.
                    </>
                  ) : (
                    <>
                      Open the zip, then double-click <b>{download.file}</b>. macOS stops it once (“Apple could not verify…”): click <b>Done</b>, then <b>Open Anyway</b> in System Settings → Privacy &amp; Security, and confirm. Or paste <span className="mono">{download.command}</span> into Terminal, which macOS doesn’t stop. The Reader app it makes is made on your Mac, so that one opens without asking.
                    </>
                  )}
                </>
              ) : system === 'windows' ? (
                <>
                  Double-click <b>{download.file}</b>. If Windows says it protected your PC, choose <b>More info</b> → <b>Run anyway</b>.
                </>
              ) : (
                <>
                  Paste it into a terminal, or <a href={download.href} download>download the script</a> and run <span className="mono">sh {download.file}</span>.
                </>
              )}{' '}
              <span className="mono">reader-companion uninstall</span> takes it away again.
            </small>
            <small className="pg-companion-note">
              Other systems:{' '}
              {(Object.keys(downloads) as (keyof typeof downloads)[])
                .filter((key) => key !== system)
                .map((key, index) => (
                  <span key={key}>
                    {index ? ' · ' : ''}
                    <button type="button" className="link-btn" onClick={() => setSystem(key)}>
                      {downloads[key].label}
                    </button>
                  </span>
                ))}
            </small>
          </div>
          <p className="pg-companion-lede">
            Or run it just for now: paste this into a terminal, and it runs until you close it.
            {safari ? ' Safari reaches the installed Companion over https on this Mac (setup asks for your password once, to trust its certificate). Run just for now, it opens a private HTTPS address instead (a Cloudflare quick tunnel; everything through it needs the token).' : ''}
          </p>
          <div className="segmented pg-seg" role="radiogroup" aria-label="This computer’s system">
            {(
              [
                ['unix', 'macOS · Linux'],
                ['windows', 'Windows'],
                ['uv', 'Have uv'],
                ['vscode', 'VS Code'],
              ] as const
            ).map(([key, label]) => (
              <button key={key} type="button" role="radio" aria-checked={os === key} className={os === key ? 'on' : ''} onClick={() => setOs(key)}>
                {label}
              </button>
            ))}
          </div>
          {os === 'vscode' ? (
            <>
              <CopyBlock code={vscode.command} />
              <small className="pg-companion-note">
                That installs the <b>Reader</b> extension (or <a href={vscode.vsix}>download the .vsix</a> and use Extensions → … → Install from VSIX). Then run <b>Reader: Start the Companion</b> from VS Code’s command palette: it starts the same Companion in VS Code’s terminal, and the projects, the papers they cite and the Python the site uses are in its Reader side bar.
              </small>
            </>
          ) : (
            <>
              <CopyBlock code={commands[os]} />
              <small className="pg-companion-note">
                {os === 'uv' ? 'Runs the Companion with the uv you have.' : 'It installs uv (a small Python tool) once if it isn’t there, then runs the Companion with its own Python.'} The page may use the folder <span className="mono">~/Reader</span>, and nothing outside it.
              </small>
            </>
          )}
          <div className="pg-companion-wait">
            <span className="pg-wait" />
            {looks ? 'Waiting for this computer…' : 'Looking for it…'}
            <span className="mono">{safari ? `https://127.0.0.1:${COMPANION_TLS_PORT}` : `127.0.0.1:${COMPANION_PORT}`}</span>
          </div>
        </>
      )}
      {problem ? <p className="pg-bad">{problem}</p> : null}
      {onManual ? (
        <button type="button" className="btn ghost sm pg-companion-manual" onClick={onManual}>
          Start Jupyter by hand instead
        </button>
      ) : null}
    </div>
  );
}

/** The page opened from the Companion's link, `#pair=CODE&port=N`: asks once, then connects with that code. */
function PairFromLink() {
  const [pending, setPending] = useState(() => (typeof window === 'undefined' ? null : pairFragment(window.location.hash)));
  const [found, setFound] = useState<{ base: string; info: CompanionInfo } | null | undefined>(undefined);
  const info = found === undefined ? undefined : found?.info ?? null;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<{ server: JupyterServer; again: boolean } | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  // A pairing link opened in a tab already on the Playground changes only the hash.
  useEffect(() => {
    const onHash = () => {
      const next = pairFragment(window.location.hash);
      if (!next) return;
      setFound(undefined);
      setDone(null);
      setProblem(null);
      setReconnecting(false);
      setPending(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (!pending) return;
    // The code is spent either way: off the address, out of history's way.
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    let live = true;
    void reachCompanion(companionRoutes(pending.port, pending.via, isSafari(), isSafari() ? pending.tls ?? COMPANION_TLS_PORT : pending.tls), pending.via ? 30_000 : 0).then((reached) => {
      if (!live) return;
      setFound(reached);
      // A Companion this browser already knows, back at a new address (a new tunnel each start): reconnect without asking.
      if (reached?.info.id && serversNow().some((server) => server.companionId === reached.info.id)) {
        setReconnecting(true);
        void connect(reached.base, true);
      }
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);
  if (!pending) return null;
  // While a computer this browser already knows is being looked for, show nothing: it most likely reconnects by itself.
  if (!problem && (info === undefined || reconnecting) && serversNow().some((server) => server.companionId)) return null;
  const close = () => setPending(null);
  async function connect(base: string, again = false) {
    if (!pending) return;
    setBusy(true);
    setProblem(null);
    try {
      const { server } = await pairForAccount(pending.code, base);
      // Back again (the Reader app opens this link each time): nothing to say, the page just has it.
      if (again) setPending(null);
      else setDone({ server, again });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div className="sheet narrow pg-pair" role="dialog" aria-label="Connect this computer?">
        <span className="eyebrow">Playground · pair a computer</span>
        <h2>{done ? (done.again ? 'Reconnected' : 'Connected') : 'Connect this computer?'}</h2>
        {done ? (
          <p className="lede">
            {done.again ? (
              <>
                <b>{done.server.name}</b> is back, and its playgrounds run on it again.
              </>
            ) : (
              <>
                <b>{done.server.name}</b> is under <b>Your compute</b>, and new playgrounds can run on it. Start the Companion again whenever you want to use it: the link it opens reconnects it.
              </>
            )}
          </p>
        ) : info === undefined ? (
          <p className="lede">
            <span className="spinner" /> Looking for the Companion…
          </p>
        ) : info === null ? (
          isSafari() && !pending.via ? (
            <>
              <p className="lede">Safari reaches the Companion only over https, and nothing answers on https://127.0.0.1:{pending.tls ?? COMPANION_TLS_PORT}. On this Mac, run this once (macOS asks for your password, to trust the Companion’s certificate for this Mac’s own address), then open the Reader app or this link again:</p>
              <CopyBlock code="reader-companion trust" />
              <p className="lede">Or run the Companion with an HTTPS tunnel instead; the link it opens then works here:</p>
              <CopyBlock code={companionCommands(siteBase(), { tunnel: true }).unix} />
            </>
          ) : (
            <p className="lede">{pending.via ? 'Neither the Companion’s own address nor its tunnel answers. Is it still running in the terminal?' : `Nothing answers on 127.0.0.1:${pending.port}. Is the Companion still running in the terminal?`}</p>
          )
        ) : (
          <>
            <p className="lede">
              A Reader Companion on this computer asked to pair with this browser, with the code <b className="mono">{pending.code}</b>.
            </p>
            <div className="pg-pair-kv">
              <span>Computer</span>
              <b>{info.name}</b>
              {info.hardware ? (
                <>
                  <span>Hardware</span>
                  <b>{info.hardware}</b>
                </>
              ) : null}
              {info.root ? (
                <>
                  <span>Folder</span>
                  <b className="mono">{info.root}</b>
                </>
              ) : null}
              <span>Reached</span>
              <b>{found && found.base.startsWith('https:') ? 'through its HTTPS tunnel' : 'directly, on 127.0.0.1'}</b>
            </div>
            <p className="pg-note">The page may run code there, and read and write files in that folder only. Remove it any time under Your compute.</p>
          </>
        )}
        {problem ? <p className="pg-bad">{problem}</p> : null}
        <div className="pg-pair-actions">
          {done || !info ? (
            <button type="button" className="btn primary" onClick={close}>
              {done ? 'Done' : 'Close'}
            </button>
          ) : (
            <>
              <button type="button" className="btn" onClick={close}>
                Not this one
              </button>
              <button type="button" className="btn primary" disabled={busy || !found} onClick={() => found && void connect(found.base)}>
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------- where it runs ----

type Mode = 'colab' | 'pc' | 'device' | 'split';
/** In the split mode, the code's home when it is Drive rather than a server. */
const DRIVE = 'drive';


/** Where a playground runs and where its files are kept, from the three modes. */
export function WhereDialog({
  draft,
  current,
  onClose,
  onCreate,
}: {
  draft: Draft | { title: string; kind: PlaygroundRecord['kind'] };
  /** Changing an existing playground's machine: its choice as it stands. */
  current?: { compute: Compute; home: FilesHome; idleStopMin: number };
  onClose: () => void;
  onCreate: (spec: NewPlayground & { idleStopMin: number }) => void | Promise<void>;
}) {
  const servers = useServers();
  const { settings } = useStore();
  const pcs = servers.filter((s) => s.where === 'pc');
  const remotes = servers.filter((s) => s.where === 'remote');
  /** Your computers with a Companion: this one, and those of your account elsewhere, reached through their tunnels. */
  const devices = servers.filter(isCompanion);
  const initialMode: Mode = current
    ? current.compute.kind === 'colab' && current.home.kind !== 'server'
      ? 'colab'
      : current.home.kind === 'server' && current.compute.kind === 'server' && current.home.serverId === current.compute.serverId
        ? serverById(current.home.serverId)?.where === 'pc'
          ? 'pc'
          : 'device'
        : 'split'
    : 'colab';
  const [mode, setMode] = useState<Mode>(initialMode);
  const [title, setTitle] = useState(draft.title);
  const [machine, setMachine] = useState<Machine>(current?.compute.kind === 'colab' ? current.compute.machine : { accelerator: 'NONE' });
  /** On Colab: a machine of its own (the default), or the browser's, shared with the paper pages and the other playgrounds that share it. */
  const [shareColab, setShareColab] = useState(current?.compute.kind === 'colab' ? Boolean(current.compute.shared) : false);
  const colabCompute: Compute = shareColab ? { kind: 'colab', machine, shared: true } : { kind: 'colab', machine };
  const [pcId, setPcId] = useState<string | undefined>(current?.home.kind === 'server' ? current.home.serverId : pcs[0]?.id);
  /** In the device mode: the computer, files and code both. */
  const [deviceId, setDeviceId] = useState<string | undefined>(current?.home.kind === 'server' && current.compute.kind === 'server' && current.home.serverId === current.compute.serverId ? current.home.serverId : devices[0]?.id);
  /** In the split mode: the server whose folder keeps the code — any of yours, this PC or elsewhere. */
  const [homeId, setHomeId] = useState<string | undefined>(current?.home.kind === 'server' ? current.home.serverId : current?.home.kind === 'drive' && current.compute.kind === 'server' ? DRIVE : (pcs[0] ?? servers[0])?.id ?? DRIVE);
  /** In the split mode: the server it runs on — any other of yours — or 'colab'. */
  const [remoteId, setRemoteId] = useState<string>(
    current?.compute.kind === 'server' && current.home.kind === 'server' && current.compute.serverId !== current.home.serverId
      ? current.compute.serverId
      : current?.compute.kind === 'colab' && current.home.kind === 'server'
        ? 'colab'
        : (remotes.find((s) => s.id !== homeId) ?? servers.find((s) => s.id !== homeId))?.id ?? 'colab',
  );
  const driveOk = useDriveConnected();
  /** On Colab: the files in your Drive, or on the runtime's own disk. */
  const [colabFiles, setColabFiles] = useState<'drive' | 'machine'>(current?.home.kind === 'machine' ? 'machine' : 'drive');
  const [idleStop, setIdleStop] = useState(current?.compute.kind === 'colab' ? current.idleStopMin : 30);
  const [adding, setAdding] = useState<'pc' | 'remote' | null>(null);
  /** Starting Jupyter by hand instead of the Companion, for this PC. */
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const addingRef = useRef<HTMLDivElement>(null);
  const colabOk = colabAvailable(settings.googleClientId);
  // A mode that needs a server none has been added for opens the steps to start one at once,
  // rather than waiting for a click on a tile that reads like a hint.
  const missing: 'pc' | 'remote' | null =
    mode === 'colab' ? null : mode === 'device' ? (devices.length ? null : 'pc') : mode === 'split' ? (homeId === DRIVE ? (remoteId !== 'colab' && !servers.length ? 'remote' : null) : !servers.length ? 'pc' : remoteId !== 'colab' && !servers.some((s) => s.id !== homeId) ? 'remote' : null) : !pcs.length ? 'pc' : null;
  useEffect(() => {
    if (missing) setAdding(missing);
  }, [missing]);
  // The form opens below the three cards: bring it into view, or it is easy to miss.
  useEffect(() => {
    if (adding) addingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [adding]);
  useEffect(() => {
    if (!pcId && pcs[0]) setPcId(pcs[0].id);
  }, [pcs, pcId]);
  useEffect(() => {
    if (!deviceId && devices[0]) setDeviceId(devices[0].id);
  }, [devices, deviceId]);
  useEffect(() => {
    if (!homeId) setHomeId((pcs[0] ?? servers[0])?.id ?? DRIVE);
    // The two ends are different machines: the code's server can't also be the one it runs on.
    if (remoteId === homeId) setRemoteId(servers.find((s) => s.id !== homeId)?.id ?? 'colab');
  }, [servers, pcs, homeId, remoteId]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const pc = serverById(pcId);
  const device = serverById(deviceId);
  const root = current?.home.kind === 'server' ? current.home.root : '';
  const choice: { compute: Compute; home: FilesHome } | null =
    mode === 'colab'
      ? { compute: colabCompute, home: colabFiles === 'drive' ? { kind: 'drive', folder: current?.home.kind === 'drive' ? current.home.folder : '' } : { kind: 'machine' } }
      : mode === 'pc'
        ? pc
          ? { compute: { kind: 'server', serverId: pc.id }, home: { kind: 'server', serverId: pc.id, root } }
          : null
        : mode === 'device'
          ? device
            ? { compute: { kind: 'server', serverId: device.id }, home: { kind: 'server', serverId: device.id, root } }
            : null
        : homeId === DRIVE && (remoteId === 'colab' || serverById(remoteId))
          ? { compute: remoteId === 'colab' ? colabCompute : { kind: 'server', serverId: remoteId }, home: { kind: 'drive', folder: current?.home.kind === 'drive' ? current.home.folder : '' } }
          : homeId && serverById(homeId) && (remoteId === 'colab' || (serverById(remoteId) && remoteId !== homeId))
            ? { compute: remoteId === 'colab' ? colabCompute : { kind: 'server', serverId: remoteId }, home: { kind: 'server', serverId: homeId, root } }
            : null;
  const usesColab = choice?.compute.kind === 'colab';
  const needsDrive = choice?.home.kind === 'drive' && !driveOk;
  const blocked = !choice || (usesColab && !colabOk) || needsDrive || !title.trim();

  const colabPicker = (
    <>
      <div className="pg-opts" role="radiogroup" aria-label="Colab machine">
        {MACHINES.map((option) => (
          <button key={option.accelerator} type="button" role="radio" aria-checked={machine.accelerator === option.accelerator} className={`pg-opt${machine.accelerator === option.accelerator ? ' is-on' : ''}`} onClick={() => setMachine({ ...machine, accelerator: option.accelerator })}>
            <ColabMark />
            <b>{option.label}</b>
            <small>{option.note}</small>
          </button>
        ))}
      </div>
      <small className="pg-pick-label">Its machine</small>
      <div className="pg-opts" role="radiogroup" aria-label="Its own Colab machine, or shared" onClick={(event) => event.stopPropagation()}>
        <button type="button" role="radio" aria-checked={!shareColab} className={`pg-opt${!shareColab ? ' is-on' : ''}`} onClick={() => setShareColab(false)}>
          <ColabMark />
          <b>A machine of its own</b>
          <small>its own GPU, memory and disk; runs beside your other Colab work; uses units of its own</small>
        </button>
        <button type="button" role="radio" aria-checked={shareColab} className={`pg-opt${shareColab ? ' is-on' : ''}`} onClick={() => setShareColab(true)}>
          <ColabMark />
          <b>Shared</b>
          <small>the machine the paper pages use, with the other playgrounds that share it — fewer units, one GPU between them</small>
        </button>
      </div>
    </>
  );
  const serverPicker = (list: JupyterServer[], picked: string | undefined, pick: (id: string) => void, kind: 'pc' | 'remote', extra?: React.ReactNode, label?: string, anyKind = false) => (
    <div className="pg-opts" role="radiogroup" aria-label={label ?? (kind === 'pc' ? 'This PC' : 'The GPU machine')}>
      {list.map((server) => {
        const mark = anyKind ? (server.where === 'pc' ? 'pc' : 'remote') : kind;
        return (
          <button key={server.id} type="button" role="radio" aria-checked={picked === server.id} className={`pg-opt${picked === server.id ? ' is-on' : ''}`} onClick={() => pick(server.id)}>
            <span className={`pg-mark ${mark === 'pc' ? 'is-pc' : 'is-gpu'}`}>{mark === 'pc' ? 'PC' : 'GPU'}</span>
            <b>{server.name}</b>
            <small className="mono">{safeHost(server.url)}</small>
          </button>
        );
      })}
      {extra}
      {anyKind ? (
        <>
          <button type="button" className="pg-opt is-add" onClick={() => setAdding('pc')}>
            <b>+ Connect this computer</b>
            <small>one command in a terminal</small>
          </button>
          <button type="button" className="pg-opt is-add" onClick={() => setAdding('remote')}>
            <b>+ Another machine’s Jupyter server</b>
            <small>a lab server, a cloud VM, a rented GPU, another computer of yours</small>
          </button>
        </>
      ) : (
        <button type="button" className="pg-opt is-add" onClick={() => setAdding(kind)}>
          <b>+ {kind === 'pc' ? 'Connect this computer' : 'A GPU machine’s Jupyter server'}</b>
          <small>{kind === 'pc' ? 'one command in a terminal' : 'a rented GPU, a lab server, an SSH tunnel'}</small>
        </button>
      )}
    </div>
  );

  return (
    <div className="scrim pg-scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="sheet pg-sheet" role="dialog" aria-label="Where should it run?">
        <header className="pg-sheet-head">
          <div>
            <span className="eyebrow">{current ? 'Change the machine' : `New ${draft.kind === 'project' ? 'project' : 'notebook'}`}</span>
            <h2>Where should it run?</h2>
            <p>The code is the same whichever you pick; the machine can be changed from the bar later.</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon size={17} />
          </button>
        </header>
        {!current ? (
          <label className="pg-title-field">
            <span>Name</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
        ) : null}
        {'note' in draft && draft.note ? <p className="pg-note">{draft.note}</p> : null}
        <div className="pg-modes">
          <section className={`pg-mode${mode === 'colab' ? ' is-on' : ''}`} onClick={() => setMode('colab')}>
            <div className="pg-mode-top">
              <ColabMark />
              <b>Colab, in the browser</b>
              <span className="pg-radio" aria-hidden="true" />
            </div>
            <div className="pg-flow">
              <span>this tab</span>
              <i>⇄</i>
              <span>Colab runtime · kernel, shell</span>
              <i>⇄</i>
              <span>{colabFiles === 'drive' ? 'your Google Drive · files' : 'the runtime’s disk · files'}</span>
            </div>
            <ul>
              <li className="good">Nothing to install; CPU and a T4 on the free tier</li>
              <li className="good">{shareColab ? 'Shares the paper pages’ Colab machine (its own Python on it)' : 'A Colab machine of its own: runs beside your other Colab work'}</li>
              <li className={colabFiles === 'drive' ? 'good' : 'bad'}>{colabFiles === 'drive' ? 'The files are kept in your Google Drive, copied to the runtime before each run' : 'The files live on the runtime’s disk — they go when the runtime ends'}</li>
            </ul>
            {mode === 'colab' ? (
              <>
                <small className="pg-pick-label">The files are kept in</small>
                <div className="pg-opts" role="radiogroup" aria-label="Where the files are kept" onClick={(event) => event.stopPropagation()}>
                  <button type="button" role="radio" aria-checked={colabFiles === 'drive'} className={`pg-opt${colabFiles === 'drive' ? ' is-on' : ''}`} onClick={() => setColabFiles('drive')}>
                    <DriveMark />
                    <b>Google Drive</b>
                    <small>Papers_collection/Playgrounds — kept, and in every browser you sign in to</small>
                  </button>
                  <button type="button" role="radio" aria-checked={colabFiles === 'machine'} className={`pg-opt${colabFiles === 'machine' ? ' is-on' : ''}`} onClick={() => setColabFiles('machine')}>
                    <ColabMark />
                    <b>The Colab runtime</b>
                    <small>its disk only — gone when it stops</small>
                  </button>
                </div>
                <small className="pg-pick-label">The machine</small>
                {colabPicker}
              </>
            ) : null}
            {mode === 'colab' && needsDrive ? <p className="pg-bad">Keeping the files in Drive needs you signed in with Google, with Drive (Settings → Google).</p> : null}
            {mode === 'colab' && !colabOk ? <p className="pg-bad">Colab needs Settings → Google (a client ID) and Settings → Paper proxy first.</p> : null}
          </section>
          <section className={`pg-mode${mode === 'pc' ? ' is-on' : ''}`} onClick={() => setMode('pc')}>
            <div className="pg-mode-top">
              <span className="pg-mark is-pc">PC</span>
              <b>This PC</b>
              <span className="pg-radio" aria-hidden="true" />
            </div>
            <div className="pg-flow">
              <span>this browser</span>
              <i>⇄ 127.0.0.1 ⇄</i>
              <span>the computer it runs on · files, kernel</span>
            </div>
            <p className="pg-mode-what">The computer you are using right now, reached directly — only from this browser, on this computer. Pick it to work here and nowhere else.</p>
            <ul>
              <li className="good">Your files, your GPU, no session clock; nothing leaves this computer</li>
              <li className="good">Any Jupyter server here works, the Reader Companion or one started by hand</li>
              <li className="bad">Not from your phone or another laptop — for that, pick “Your computer, from anywhere”</li>
            </ul>
            {mode === 'pc' ? serverPicker(pcs, pcId, setPcId, 'pc') : null}
          </section>
          <section className={`pg-mode${mode === 'device' ? ' is-on' : ''}`} onClick={() => setMode('device')}>
            <div className="pg-mode-top">
              <span className="pg-mark is-pc">PC</span>
              <b>Your computer, from anywhere</b>
              <span className="pg-radio" aria-hidden="true" />
            </div>
            <div className="pg-flow">
              <span>any browser you sign in to</span>
              <i>⇄ its HTTPS tunnel ⇄</i>
              <span>that computer · files, kernel, shell</span>
            </div>
            <p className="pg-mode-what">A computer of yours with the Reader Companion, connected to your Google account — this one or another. Every browser you sign in to reaches it. Pick it to open the same project from your phone, another laptop, or here.</p>
            <ul>
              <li className="good">Code and compute both stay on that computer</li>
              <li className="good">It shows up in every browser signed in as you — nothing to pair again</li>
              <li className="bad">Only while that computer is on, online, and its Companion running</li>
            </ul>
            {mode === 'device' ? (
              <div className="pg-opts" role="radiogroup" aria-label="Your computer" onClick={(event) => event.stopPropagation()}>
                {devices.map((server) => (
                  <button key={server.id} type="button" role="radio" aria-checked={deviceId === server.id} className={`pg-opt${deviceId === server.id ? ' is-on' : ''}`} onClick={() => setDeviceId(server.id)}>
                    <span className="pg-mark is-pc">PC</span>
                    <b>{server.name}</b>
                    <small className="mono">{server.where === 'pc' ? 'this computer' : `from here, through ${safeHost(server.url)}`}</small>
                  </button>
                ))}
                {!devices.length ? <small className="pg-note">None of your computers is connected yet. Open the Reader app on the one you want, signed in as you: it shows up here, on every device you sign in to.</small> : null}
              </div>
            ) : null}
          </section>
          <section className={`pg-mode is-wide${mode === 'split' ? ' is-on' : ''}`} onClick={() => setMode('split')}>
            <div className="pg-mode-top">
              <span className="pg-mark is-pc">PC</span>
              <span className="pg-arrow">→</span>
              <span className="pg-mark is-gpu">GPU</span>
              <b>Code on one machine, compute on another</b>
              <span className="pg-radio" aria-hidden="true" />
            </div>
            <div className="pg-flow">
              <span>a folder in Drive or on any machine of yours</span>
              <i>⇄ copied before each run ⇄</i>
              <span>any other · kernel, shell</span>
              <i>→</i>
              <span>runs/ &amp; results back</span>
            </div>
            <ul>
              <li className="good">The code lives in your Google Drive, or in a folder on one machine — this PC, another computer of yours, a lab server</li>
              <li className="good">Cells and the console run on another: a GPU box, a rented card, Colab</li>
              <li className="good">What a run writes under runs/ and results/ comes back to the code’s folder</li>
            </ul>
            {mode === 'split' ? (
              <div className="pg-split" onClick={(event) => event.stopPropagation()}>
                <small>The code is kept on</small>
                {serverPicker(servers, homeId, setHomeId, 'pc', (
                  <button type="button" role="radio" aria-checked={homeId === DRIVE} className={`pg-opt${homeId === DRIVE ? ' is-on' : ''}`} onClick={() => setHomeId(DRIVE)}>
                    <DriveMark />
                    <b>Google Drive</b>
                    <small>Papers_collection/Playgrounds</small>
                  </button>
                ), 'Where the code is kept', true)}
                {homeId === DRIVE && !driveOk ? <p className="pg-bad">Sign in with Google, with Drive (Settings → Google), to keep the code there.</p> : null}
                <small>It runs on</small>
                {serverPicker(servers.filter((s) => s.id !== homeId), remoteId, setRemoteId, 'remote', (
                  <button type="button" role="radio" aria-checked={remoteId === 'colab'} className={`pg-opt${remoteId === 'colab' ? ' is-on' : ''}`} onClick={() => setRemoteId('colab')}>
                    <ColabMark />
                    <b>Your Colab</b>
                    <small>a GPU runtime — pick it below</small>
                  </button>
                ), 'Where it runs', true)}
                {remoteId === 'colab' ? colabPicker : null}
              </div>
            ) : null}
          </section>
        </div>
        {adding ? (
          <div className="pg-adding" ref={addingRef}>
            {missing === adding && adding === 'remote' ? <p className="pg-adding-lede">{mode === 'split' ? 'The second machine needs a Jupyter server too.' : 'The GPU machine needs a Jupyter server too.'} Start one there with the commands below, then paste its address.</p> : null}
            {adding === 'pc' && !manual ? (
              <CompanionConnect
                onManual={() => setManual(true)}
                onClose={missing === 'pc' ? undefined : () => setAdding(null)}
                onPaired={(saved) => {
                  setPcId(saved.id);
                  setAdding(null);
                }}
              />
            ) : (
              <ServerForm
                key={adding}
                defaultWhere={adding}
                onDone={() => (setAdding(null), setManual(false))}
                onSaved={(saved) => {
                  if (saved.where === 'pc') setPcId(saved.id);
                  // In the split mode a new server fills whichever end is missing: the code's first, then where it runs.
                  if (mode === 'split') {
                    if (!homeId || !serverById(homeId)) setHomeId(saved.id);
                    else if (saved.id !== homeId) setRemoteId(saved.id);
                  } else if (saved.where !== 'pc') setRemoteId(saved.id);
                }}
              />
            )}
          </div>
        ) : null}
        <footer className="pg-sheet-foot">
          {usesColab ? (
            <label className="pg-idle">
              <input type="checkbox" checked={idleStop > 0} onChange={(event) => setIdleStop(event.target.checked ? 30 : 0)} />
              <span>
                Stop the Colab runtime after
                <select value={idleStop || 30} disabled={!idleStop} onChange={(event) => setIdleStop(Number(event.target.value))} onClick={(event) => event.stopPropagation()}>
                  {[10, 20, 30, 60, 120].map((n) => (
                    <option key={n} value={n}>
                      {n} min
                    </option>
                  ))}
                </select>
                with nothing running, while this tab is open
              </span>
            </label>
          ) : missing ? (
            <span className="pg-note">{mode === 'split' ? (missing === 'pc' ? 'Add the machine that keeps the code above.' : 'Add a second machine to run it on above, or pick Your Colab.') : missing === 'pc' ? 'Connect this computer above to create it here.' : 'Add the GPU machine’s Jupyter server above, or pick Your Colab.'}</span>
          ) : (
            <span className="pg-note">A Jupyter server of yours stays up until you stop it; a rented one is billed by its provider while it is.</span>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={blocked || busy}
            onClick={async () => {
              if (!choice) return;
              setBusy(true);
              try {
                const base = draft as Draft;
                await onCreate({
                  title: title.trim(),
                  kind: draft.kind,
                  start: base.start ?? 'blank',
                  cites: base.cites,
                  cells: base.cells ?? blankCells(title.trim()),
                  files: base.files,
                  pending: base.pending,
                  compute: choice.compute,
                  home: choice.home,
                  idleStopMin: usesColab ? idleStop : 0,
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            {current ? 'Use this' : 'Create'}
            {choice ? ` · ${choice.compute.kind === 'colab' ? `Colab ${MACHINES.find((m) => m.accelerator === machine.accelerator)?.label}` : serverById(choice.compute.serverId)?.name}` : ''}
          </button>
        </footer>
      </div>
    </div>
  );
}

