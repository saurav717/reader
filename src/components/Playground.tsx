// The Playground's home, at /playground: ways to start something, the
// playgrounds there are, and the machines they can run on — the person's
// Colab and the Jupyter servers they have added. One playground opens at
// /playground/<id> (PlaygroundWorkspace). The store is src/lib/playground.ts;
// the kernel client, Colab's and a Jupyter server's alike, src/lib/colab.ts.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { JupyterServer, Machine } from '../lib/colab';
import { checkJupyter, colabAvailable, MACHINES } from '../lib/colab';
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
  usePlaygrounds,
  useServers,
} from '../lib/playground';
import { useStore } from '../lib/store';
import type { Paper } from '../types';
import { ColabMark } from './Colab';
import { CloseIcon, CodeIcon, TrashIcon } from './icons';
import PlaygroundWorkspace from './PlaygroundWorkspace';

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
              {!servers.length ? (
                <div className="pg-machine">
                  <p>
                    Add a <b>Jupyter server</b> to run on this PC, or on a GPU elsewhere — a rented one, or your lab’s, through an SSH tunnel.
                  </p>
                </div>
              ) : null}
            </div>
            {addingServer ? <ServerForm onDone={() => setAddingServer(false)} /> : null}
          </aside>
        </div>
      </div>
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
        <span className={`pg-mark ${server.where === 'pc' ? 'is-pc' : 'is-gpu'}`}>{server.where === 'pc' ? 'PC' : 'GPU'}</span>
        <b>{server.name}</b>
        <span className="mono">{safeHost(server.url)}</span>
      </div>
      {state ? <p className={state.ok ? 'pg-ok' : 'pg-bad'}>{state.text}</p> : null}
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
  const allow = `--ServerApp.allow_origin='${origin}'`;
  const base = `pip install jupyter_server ipykernel\njupyter server ${allow} --ServerApp.root_dir="$HOME/reader-playgrounds"`;
  if (where === 'pc') return [{ label: 'On this PC, in a terminal', code: `mkdir -p "$HOME/reader-playgrounds"\n${base}` }];
  return [
    { label: 'On the GPU machine', code: `mkdir -p "$HOME/reader-playgrounds"\n${base} --ServerApp.port=8888` },
    { label: 'Then on this PC — an SSH tunnel to it (a lab server, a cloud VM, a pod with SSH)', code: 'ssh -N -L 8890:localhost:8888 you@the-gpu-machine\n# and add http://localhost:8890/?token=… here' },
    { label: 'Or, on RunPod: start it on 0.0.0.0 and use the pod’s own HTTPS address', code: `${base} --ServerApp.ip=0.0.0.0 --ServerApp.port=8888\n# address: https://<pod-id>-8888.proxy.runpod.net/?token=…` },
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
            <pre>{step.code}</pre>
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
  const [busy, setBusy] = useState(false);
  const colabOk = colabAvailable(settings.googleClientId);
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
        <b>+ {kind === 'pc' ? 'This PC’s Jupyter server' : 'A GPU machine’s Jupyter server'}</b>
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
          <div className="pg-adding">
            <ServerForm
              defaultWhere={adding}
              onDone={() => setAdding(null)}
              onSaved={(saved) => {
                if (saved.where === 'pc') setPcId(saved.id);
                else setRemoteId(saved.id);
              }}
            />
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

