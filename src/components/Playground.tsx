// The Playground's home, at /playground: ways to start something, the
// playgrounds there are, and the machines they can run on — the person's
// Colab and the Jupyter servers they have added. One playground opens at
// /playground/<id> (PlaygroundWorkspace). The store is src/lib/playground.ts;
// the kernel client, Colab's and a Jupyter server's alike, src/lib/colab.ts.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { JupyterServer, Machine } from '../lib/colab';
import { checkJupyter, colabAvailable, MACHINES } from '../lib/colab';
import type { CompanionInfo, MacDmg } from '../lib/companion';
import { claimForAccount, pairForAccount, syncDevices } from '../lib/devices';
import { currentAccount, onProxyChange } from '../lib/api';
import { COMPANION_PORT, COMPANION_TLS_PORT, STARTABLE, companionCommands, companionDownloads, companionPort, desktopSystem, companionRoutes, findCompanion, findLocalCompanion, isSafari, latestMacDmg, normaliseCode, pairFragment, showCompanionCode, shutdownCompanion, startCompanion, vscodeInstall } from '../lib/companion';
import { fromIpynb } from '../lib/notebook';
import { newCell } from '../lib/notebook';
import type { Compute, FilesHome, NewPlayground, Playground as PlaygroundRecord } from '../lib/playground';
import {
  blankCells,
  createPlayground,
  deletePlayground,
  loadPlaygrounds,
  modelCells,
  modelIdOf,
  paperCells,
  parseServerUrl,
  playgroundsLoaded,
  removeServer,
  repoNameOf,
  repoUrlOf,
  saveServer,
  serverById,
  serversNow,
  usePlaygrounds,
  useServers,
} from '../lib/playground';
import { useStore } from '../lib/store';
import type { Paper } from '../types';
import { ColabMark } from './Colab';
import { CloseIcon, CodeIcon, TrashIcon } from './icons';
import CopyBlock from './CopyBlock';
import PlaygroundWorkspace from './PlaygroundWorkspace';
import VsCodeExtension from './VsCodeExtension';

export default function Playground({ id, onOpen, onOpenPaper }: { id?: string; onOpen: (id?: string) => void; onOpenPaper: (id: string) => void }) {
  const list = usePlaygrounds();
  const [ready, setReady] = useState(playgroundsLoaded());
  useEffect(() => {
    void loadPlaygrounds().then(() => setReady(true));
  }, []);
  if (id) {
    const found = list.find((p) => p.id === id);
    if (!found) {
      return (
        <main className="main pg-page">
          <div className="pg-scroll">
            {ready ? (
              <div className="pg-missing">
                <h1>No playground here</h1>
                <p>There is no playground at this address in this browser. Playgrounds are kept in the browser they were made in.</p>
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
      {compute.kind === 'colab' ? <ColabMark /> : <span className={`pg-mark ${server?.where === 'pc' ? 'is-pc' : 'is-gpu'}`}>{server?.where === 'pc' ? 'PC' : 'GPU'}</span>}
      <span>{compute.kind === 'colab' ? `Colab ${MACHINES.find((m) => m.accelerator === compute.machine.accelerator)?.label ?? 'CPU'}` : server?.name ?? 'a server no longer here'}</span>
    </span>
  );
}

function PlaygroundHome({ list, ready, onOpen }: { list: PlaygroundRecord[]; ready: boolean; onOpen: (id?: string) => void }) {
  const { papers, settings } = useStore();
  const servers = useServers();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [asking, setAsking] = useState<'paper' | 'repo' | 'model' | null>(null);
  const [answer, setAnswer] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [addingServer, setAddingServer] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const filePick = useRef<HTMLInputElement>(null);
  const sorted = useMemo(() => [...list].sort((a, b) => b.updated - a.updated), [list]);
  const colabOk = colabAvailable(settings.googleClientId);
  // The signed-in account's computers, from any browser it signs in to: now, and at each sign-in.
  useEffect(() => {
    void syncDevices();
    return onProxyChange(() => void syncDevices());
  }, []);

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
    begin({ title: `Trying ${paper.title.split(/[:—–-]/)[0].trim().slice(0, 60)}`, kind: 'notebook', start: 'paper', cites: [cite], cells: paperCells(paper.title, { ...cite, abstract: paper.abstract, authors: paper.authors }) });
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

  const matches = useMemo(() => {
    const q = answer.trim().toLowerCase();
    return papers
      .filter((paper) => !q || paper.title.toLowerCase().includes(q) || paper.authors.some((a) => a.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [answer, papers]);

  const starts: { key: string; mark: string; title: string; text: string; go: () => void }[] = [
    { key: 'blank', mark: '[ ]', title: 'Blank notebook', text: 'Cells, Markdown, maths, a kernel. The quickest way to try an idea.', go: () => begin({ title: 'Untitled notebook', kind: 'notebook', start: 'blank' }) },
    { key: 'project', mark: '{ }', title: 'Blank project', text: 'Files, an editor and a console — for code that outgrows cells.', go: () => begin({ title: 'Untitled project', kind: 'project', start: 'blank', files: { 'main.py': 'import torch\n\nprint("torch", torch.__version__, "· cuda", torch.cuda.is_available())\n', 'README.md': '# Untitled project\n' } }) },
    { key: 'paper', mark: '¶', title: 'From a paper', text: 'A paper from your library: the notebook cites it, and the model that writes cells reads its abstract.', go: () => (setAsking('paper'), setAnswer(''), setProblem(null)) },
    { key: 'repo', mark: '⑂', title: 'From a repository', text: 'A GitHub address — the paper’s own code, cloned onto the machine you pick.', go: () => (setAsking('repo'), setAnswer(''), setProblem(null)) },
    { key: 'model', mark: 'HF', title: 'From a model card', text: 'A Hugging Face model or dataset id: loaded, run once, ready to change.', go: () => (setAsking('model'), setAnswer(''), setProblem(null)) },
    { key: 'file', mark: '.nb', title: 'Open a file', text: 'An .ipynb from anywhere, or a .py to start a project with.', go: () => filePick.current?.click() },
  ];

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
        </header>
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
            {asking ? (
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
              <span className="pg-aside">kept in this browser</span>
            </div>
            {!ready ? (
              <p className="pg-note">
                <span className="spinner" /> Reading…
              </p>
            ) : sorted.length ? (
              <ul className="pg-list">
                {sorted.map((p) => (
                  <li key={p.id} className="pg-row">
                    <button type="button" className="pg-row-main" onClick={() => onOpen(p.id)}>
                      <b>{p.title}</b>
                      <span>
                        {p.kind === 'project' ? 'Project' : 'Notebook'}
                        {p.cites.length ? ` · cites ${p.cites.map((c) => c.title).join(', ').slice(0, 80)}` : ''}
                      </span>
                    </button>
                    <ComputeTag compute={p.compute} home={p.home} />
                    <span className="pg-when">{ago(p.updated)}</span>
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
                      <button type="button" className="icon-btn sm" aria-label={`Delete ${p.title}`} title="Delete this playground (its notebook and the files kept in this browser; a folder on a server stays)" onClick={() => setConfirmDelete(p.id)}>
                        <TrashIcon size={15} />
                      </button>
                    )}
                    <button type="button" className="btn sm" onClick={() => onOpen(p.id)}>
                      Open
                    </button>
                  </li>
                ))}
              </ul>
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
              {servers.map((server) => (
                <ServerRow key={server.id} server={server} />
              ))}
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

function ServerRow({ server }: { server: JupyterServer }) {
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [editing, setEditing] = useState(false);
  const companion = Boolean(server.companionId || companionPort(server.url));
  const [power, setPower] = useState<Power>('unknown');
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!companion) return;
    let live = true;
    void findCompanion(server.url, 2500).then((info) => live && setPower((now) => (now === 'unknown' ? (info ? 'up' : 'down') : now)));
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
    <div className="pg-machine">
      <div className="pg-machine-head">
        <span className={`pg-mark ${server.where === 'pc' || companion ? 'is-pc' : 'is-gpu'}`}>{server.where === 'pc' || companion ? 'PC' : 'GPU'}</span>
        <b>{server.name}</b>
        <span className="mono">{safeHost(server.url)}</span>
      </div>
      {state ? <p className={state.ok ? 'pg-ok' : 'pg-bad'}>{state.text}</p> : null}
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
        <button type="button" className="btn sm ghost danger" onClick={() => removeServer(server.id)}>
          Remove
        </button>
        {companion && account && !server.account ? (
          <button type="button" className="btn sm ghost" disabled={claiming} onClick={() => void claim()} title="Only this Google account reaches it then, from any browser it signs in to; browsers paired before lose it.">
            {claiming ? 'Connecting…' : 'Connect to my account'}
          </button>
        ) : null}
        {companion ? <PowerSwitch power={power} canStart={companionPort(server.url) !== null} onChange={(on) => void toggle(on)} /> : null}
      </div>
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

/** The commands that start a Jupyter server this page may talk to, for this site's origin. */
export function serverCommands(where: 'pc' | 'remote', origin: string): { label: string; code: string }[] {
  // One flag a line, joined with backslashes: easy to read in a narrow card, and still one command when pasted.
  const server = (...extra: string[]) => ['jupyter server', `--ServerApp.allow_origin='${origin}'`, '--ServerApp.root_dir="$HOME/reader-playgrounds"', ...extra].join(' \\\n  ');
  const setup = 'mkdir -p "$HOME/reader-playgrounds"\npip install jupyter_server ipykernel';
  if (where === 'pc') return [{ label: 'On this PC, in a terminal', code: `${setup}\n${server()}` }];
  return [
    { label: 'On the GPU machine', code: `${setup}\n${server('--ServerApp.port=8888')}` },
    { label: 'Then on this PC — an SSH tunnel to it (a lab server, a cloud VM, a pod with SSH)', code: 'ssh -N -L 8890:localhost:8888 you@the-gpu-machine\n# then add http://localhost:8890/?token=… here' },
    { label: 'Or, on RunPod: start it on 0.0.0.0 and use the pod’s own HTTPS address', code: `${setup}\n${server('--ServerApp.ip=0.0.0.0', '--ServerApp.port=8888')}\n# address: https://<pod-id>-8888.proxy.runpod.net/?token=…` },
  ];
}

function ServerForm({ server, onDone, onSaved, defaultWhere = 'pc' }: { server?: JupyterServer; onDone: () => void; onSaved?: (server: JupyterServer) => void; defaultWhere?: 'pc' | 'remote' }) {
  const [name, setName] = useState(server?.name ?? (defaultWhere === 'pc' ? 'This PC' : 'GPU machine'));
  const [where, setWhere] = useState<'pc' | 'remote'>(server?.where ?? defaultWhere);
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
    const saved = saveServer({ id: server?.id, name: name.trim() || (where === 'pc' ? 'This PC' : 'GPU machine'), where, url: effective.url, token: effective.token });
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
        <button type="button" role="radio" aria-checked={where === 'pc'} className={where === 'pc' ? 'on' : ''} onClick={() => setWhere('pc')}>
          On this PC
        </button>
        <button type="button" role="radio" aria-checked={where === 'remote'} className={where === 'remote' ? 'on' : ''} onClick={() => setWhere('remote')}>
          A GPU elsewhere
        </button>
      </div>
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

type Mode = 'colab' | 'pc' | 'split';

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
  const initialMode: Mode = current
    ? current.compute.kind === 'colab' && current.home.kind === 'browser'
      ? 'colab'
      : current.home.kind === 'server' && current.compute.kind === 'server' && current.home.serverId === current.compute.serverId
        ? 'pc'
        : 'split'
    : 'colab';
  const [mode, setMode] = useState<Mode>(initialMode);
  const [title, setTitle] = useState(draft.title);
  const [machine, setMachine] = useState<Machine>(current?.compute.kind === 'colab' ? current.compute.machine : { accelerator: 'NONE' });
  const [pcId, setPcId] = useState<string | undefined>(current?.home.kind === 'server' ? current.home.serverId : pcs[0]?.id);
  /** In the split mode: a remote server's id, or 'colab'. */
  const [remoteId, setRemoteId] = useState<string>(current?.compute.kind === 'server' && current.home.kind === 'server' && current.compute.serverId !== current.home.serverId ? current.compute.serverId : current?.compute.kind === 'colab' && current.home.kind === 'server' ? 'colab' : remotes[0]?.id ?? 'colab');
  const [idleStop, setIdleStop] = useState(current?.compute.kind === 'colab' ? current.idleStopMin : 30);
  const [adding, setAdding] = useState<'pc' | 'remote' | null>(null);
  /** Starting Jupyter by hand instead of the Companion, for this PC. */
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const addingRef = useRef<HTMLDivElement>(null);
  const colabOk = colabAvailable(settings.googleClientId);
  // A mode that needs a server none has been added for opens the steps to start one at once,
  // rather than waiting for a click on a tile that reads like a hint.
  const missing: 'pc' | 'remote' | null = mode === 'colab' ? null : !pcs.length ? 'pc' : mode === 'split' && !remotes.length && remoteId !== 'colab' ? 'remote' : null;
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
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const pc = serverById(pcId);
  const root = current?.home.kind === 'server' ? current.home.root : '';
  const choice: { compute: Compute; home: FilesHome } | null =
    mode === 'colab'
      ? { compute: { kind: 'colab', machine }, home: { kind: 'browser' } }
      : mode === 'pc'
        ? pc
          ? { compute: { kind: 'server', serverId: pc.id }, home: { kind: 'server', serverId: pc.id, root } }
          : null
        : pc && (remoteId === 'colab' || serverById(remoteId))
          ? { compute: remoteId === 'colab' ? { kind: 'colab', machine } : { kind: 'server', serverId: remoteId }, home: { kind: 'server', serverId: pc.id, root } }
          : null;
  const usesColab = choice?.compute.kind === 'colab';
  const blocked = !choice || (usesColab && !colabOk) || !title.trim();

  const colabPicker = (
    <div className="pg-opts" role="radiogroup" aria-label="Colab machine">
      {MACHINES.map((option) => (
        <button key={option.accelerator} type="button" role="radio" aria-checked={machine.accelerator === option.accelerator} className={`pg-opt${machine.accelerator === option.accelerator ? ' is-on' : ''}`} onClick={() => setMachine({ ...machine, accelerator: option.accelerator })}>
          <ColabMark />
          <b>{option.label}</b>
          <small>{option.note}</small>
        </button>
      ))}
    </div>
  );
  const serverPicker = (list: JupyterServer[], picked: string | undefined, pick: (id: string) => void, kind: 'pc' | 'remote', extra?: React.ReactNode) => (
    <div className="pg-opts" role="radiogroup" aria-label={kind === 'pc' ? 'This PC' : 'The GPU machine'}>
      {list.map((server) => (
        <button key={server.id} type="button" role="radio" aria-checked={picked === server.id} className={`pg-opt${picked === server.id ? ' is-on' : ''}`} onClick={() => pick(server.id)}>
          <span className={`pg-mark ${kind === 'pc' ? 'is-pc' : 'is-gpu'}`}>{kind === 'pc' ? 'PC' : 'GPU'}</span>
          <b>{server.name}</b>
          <small className="mono">{safeHost(server.url)}</small>
        </button>
      ))}
      {extra}
      <button type="button" className="pg-opt is-add" onClick={() => setAdding(kind)}>
        <b>+ {kind === 'pc' ? 'Connect this computer' : 'A GPU machine’s Jupyter server'}</b>
        <small>{kind === 'pc' ? 'one command in a terminal' : 'a rented GPU, a lab server, an SSH tunnel'}</small>
      </button>
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
              <span>Colab runtime · code, kernel, disk</span>
            </div>
            <ul>
              <li className="good">Nothing to install; CPU and a T4 on the free tier</li>
              <li className="good">The same kernel as the Explain pages’ cells</li>
              <li className="bad">The runtime’s disk goes with it — the files are kept in this browser</li>
            </ul>
            {mode === 'colab' ? colabPicker : null}
            {mode === 'colab' && !colabOk ? <p className="pg-bad">Colab needs Settings → Google (a client ID) and Settings → Paper proxy first.</p> : null}
          </section>
          <section className={`pg-mode${mode === 'pc' ? ' is-on' : ''}`} onClick={() => setMode('pc')}>
            <div className="pg-mode-top">
              <span className="pg-mark is-pc">PC</span>
              <b>This PC</b>
              <span className="pg-radio" aria-hidden="true" />
            </div>
            <div className="pg-flow">
              <span>this tab</span>
              <i>⇄</i>
              <span>Jupyter on this PC · kernel and files</span>
            </div>
            <ul>
              <li className="good">Your files, your GPU, no session clock</li>
              <li className="good">Free, and private data stays put</li>
              <li className="bad">Only as much GPU as the PC has</li>
            </ul>
            {mode === 'pc' ? serverPicker(pcs, pcId, setPcId, 'pc') : null}
          </section>
          <section className={`pg-mode is-wide${mode === 'split' ? ' is-on' : ''}`} onClick={() => setMode('split')}>
            <div className="pg-mode-top">
              <span className="pg-mark is-pc">PC</span>
              <span className="pg-arrow">→</span>
              <span className="pg-mark is-gpu">GPU</span>
              <b>Code on this PC, GPU in the cloud</b>
              <span className="pg-radio" aria-hidden="true" />
            </div>
            <div className="pg-flow">
              <span>a folder on this PC</span>
              <i>⇄ copied before each run ⇄</i>
              <span>the GPU machine · kernel, shell</span>
              <i>→</i>
              <span>runs/ &amp; results back</span>
            </div>
            <ul>
              <li className="good">The files live in a folder on your PC — edit them here, or in any editor</li>
              <li className="good">Cells and the console run on the remote card</li>
              <li className="good">What a run writes under runs/ and results/ comes back</li>
            </ul>
            {mode === 'split' ? (
              <div className="pg-split" onClick={(event) => event.stopPropagation()}>
                <small>The files, on</small>
                {serverPicker(pcs, pcId, setPcId, 'pc')}
                <small>The code runs on</small>
                {serverPicker(remotes, remoteId, setRemoteId, 'remote', (
                  <button type="button" role="radio" aria-checked={remoteId === 'colab'} className={`pg-opt${remoteId === 'colab' ? ' is-on' : ''}`} onClick={() => setRemoteId('colab')}>
                    <ColabMark />
                    <b>Your Colab</b>
                    <small>a GPU runtime — pick it below</small>
                  </button>
                ))}
                {remoteId === 'colab' ? colabPicker : null}
              </div>
            ) : null}
          </section>
        </div>
        {adding ? (
          <div className="pg-adding" ref={addingRef}>
            {missing === adding && adding === 'remote' ? <p className="pg-adding-lede">The GPU machine needs a Jupyter server too. Start one there with the commands below, then paste its address.</p> : null}
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
                  else setRemoteId(saved.id);
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
            <span className="pg-note">{missing === 'pc' ? 'Connect this computer above to create it here.' : 'Add the GPU machine’s Jupyter server above, or pick Your Colab.'}</span>
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

