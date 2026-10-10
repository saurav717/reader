// "Open a file or folder": where it is first, then the file or folder, then
// how to use it. A computer of yours is browsed where it is — through its
// Companion, the whole computer (0.8.0 on), or the folder a Jupyter server was
// started in — and the folder is used in place (linked into the Companion's
// folder, edits land in it) or copied to Drive or a new folder. This browser
// can still upload a copy. Drive and Colab say plainly what they can't do and
// what to do instead. Above it all: which of your computers have the Reader
// app signed in as you, or that none do.

import { useEffect, useMemo, useState } from 'react';
import { currentAccount } from '../lib/api';
import { snapshotPlan } from '../lib/away';
import type { JupyterServer, RuntimeEntry } from '../lib/colab';
import { colabAvailable } from '../lib/colab';
import { chooseFolder, findCompanion, findLocalCompanion, FOLDERS_VERSION, isNewer, linkFolder, listFolder } from '../lib/companion';
import type { FolderListing } from '../lib/companion';
import { listDevices } from '../lib/devices';
import type { Device } from '../lib/devices';
import { fromIpynb } from '../lib/notebook';
import { blankCells, createPlayground, serverHost, useDriveConnected, useServers } from '../lib/playground';
import type { Compute, FilesHome, Playground } from '../lib/playground';
import { listAll } from '../lib/projectAgent';
import { useStore } from '../lib/store';
import { since } from '../lib/away';
import FileIcon from './FileIcon';
import { CloseIcon } from './icons';
import { isCompanion } from './VsCodeExtension';

type Source = { kind: 'server'; id: string } | { kind: 'browser' } | { kind: 'drive' } | { kind: 'colab' };
interface Probe {
  state: 'checking' | 'up' | 'down';
  version?: string;
}
/** One row of the browser: a folder or a file, by the path the source uses (absolute on a Companion 0.8, relative to a Jupyter root otherwise). */
interface Row {
  name: string;
  path: string;
  dir: boolean;
  size: number | null;
}
interface Place {
  /** Where the listing is, by the source's path, and how it reads. */
  path: string;
  /** The computer's home folder, for writing paths under it as ~. */
  home: string;
  shown: string;
  parent: string | null;
  rows: Row[];
  places: { name: string; path: string }[];
}

const join = (dir: string, name: string, sep = '/') => (dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`);
const parentOf = (path: string) => path.replace(/[\\/][^\\/]*$/, '') || '/';
const nameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const maskEmail = (email: string | null) => (email ? email.replace(/^(.)[^@]*(@.*)$/, '$1•••$2') : '');

export default function OpenDialog({ onClose, onOpen, onUploadFile, onUploadFolder, onConnect }: { onClose: () => void; onOpen: (id: string) => void; onUploadFile: () => void; onUploadFolder: () => void; onConnect: () => void }) {
  const servers = useServers();
  const { settings } = useStore();
  const drive = useDriveConnected();
  const account = currentAccount();
  const colabOk = colabAvailable(settings.googleClientId);

  // Which computers answer, which Companion is this computer's own, and the account's list.
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [localId, setLocalId] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[] | null | 'loading'>(account ? 'loading' : null);
  useEffect(() => {
    let alive = true;
    void findLocalCompanion(undefined, 1200).then((found) => alive && setLocalId(found?.info.id ?? null));
    if (account) void listDevices().then((list) => alive && setDevices(list));
    setProbes(Object.fromEntries(servers.map((s) => [s.id, { state: 'checking' } as Probe])));
    for (const server of servers) {
      const look = isCompanion(server)
        ? findCompanion(server.url, 5000).then((info) => (info ? ({ state: 'up', version: info.version } as Probe) : ({ state: 'down' } as Probe)))
        : serverHost(server, '')
            .list('')
            .then(() => ({ state: 'up' }) as Probe)
            .catch(() => ({ state: 'down' }) as Probe);
      void look.then((probe) => alive && setProbes((now) => ({ ...now, [server.id]: probe })));
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers.map((s) => s.id).join(' ')]);

  const ordered = useMemo(
    () =>
      [...servers].sort((a, b) => {
        const rank = (s: JupyterServer) => (s.companionId && s.companionId === localId ? 0 : probes[s.id]?.state === 'up' ? 1 : probes[s.id]?.state === 'checking' ? 2 : 3);
        return rank(a) - rank(b);
      }),
    [servers, probes, localId],
  );
  const [source, setSource] = useState<Source | null>(null);
  // Start on this computer when it has a Companion that answers, else the first computer that does, else this browser.
  useEffect(() => {
    if (source) return;
    const first = ordered.find((s) => probes[s.id]?.state === 'up');
    if (first) setSource({ kind: 'server', id: first.id });
    else if (servers.length && servers.every((s) => probes[s.id] && probes[s.id].state !== 'checking')) setSource({ kind: 'browser' });
    else if (!servers.length) setSource({ kind: 'browser' });
  }, [ordered, probes, servers, source]);

  const server = source?.kind === 'server' ? servers.find((s) => s.id === source.id) : undefined;
  const probe = server ? probes[server.id] : undefined;
  const isHere = Boolean(server?.companionId && server.companionId === localId);
  // A Companion 0.8 on lists the whole computer; an older one, or any other Jupyter server, the folder it serves.
  const mode: 'disk' | 'root' = server && isCompanion(server) && probe?.version && !isNewer(FOLDERS_VERSION, probe.version) ? 'disk' : 'root';

  // ------------------------------------------------------------ browsing --
  const [place, setPlace] = useState<Place | null>(null);
  const [at, setAt] = useState<string>('');
  const [typed, setTyped] = useState('');
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [picked, setPicked] = useState<Row | null>(null);
  useEffect(() => {
    setPlace(null);
    setPicked(null);
    setAt('');
    setProblem(null);
  }, [source?.kind, server?.id, mode]);
  useEffect(() => {
    if (!server || probe?.state !== 'up') return;
    let alive = true;
    setLoading(true);
    setProblem(null);
    const go = async (): Promise<Place> => {
      if (mode === 'disk') {
        const found: FolderListing = await listFolder(server, at, hidden);
        return {
          path: found.path,
          home: found.home,
          shown: found.path.startsWith(found.home) ? `~${found.path.slice(found.home.length)}` : found.path,
          parent: found.parent,
          rows: found.entries.map((e) => ({ name: e.name, path: join(found.path, e.name, found.sep), dir: e.dir, size: e.size })),
          places: found.places,
        };
      }
      const entries: RuntimeEntry[] = await serverHost(server, '').list(at);
      return {
        path: at,
        home: '',
        shown: `${server.root ?? (isCompanion(server) ? '~/Reader' : 'its folder')}${at ? `/${at}` : ''}`,
        parent: at ? at.split('/').slice(0, -1).join('/') : null,
        rows: entries
          .filter((e) => hidden || !e.name.startsWith('.'))
          .map((e) => ({ name: e.name, path: e.path, dir: e.type === 'directory', size: e.size ?? null }))
          .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)),
        places: [],
      };
    };
    void go()
      .then((next) => {
        if (!alive) return;
        setPlace(next);
        setTyped(next.shown);
        setPicked((now) => now ?? { name: nameOf(next.path) || 'folder', path: next.path, dir: true, size: null });
      })
      .catch((error) => alive && setProblem(error instanceof Error ? error.message : String(error)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.id, probe?.state, mode, at, hidden]);
  const enter = (path: string) => {
    setPicked(null);
    setAt(path);
  };

  // ----------------------------------------------------------- how to use --
  type How = 'here' | 'drive' | 'copy';
  const [how, setHow] = useState<How>('here');
  const upOthers = servers.filter((s) => s.id !== server?.id && probes[s.id]?.state === 'up');
  const [runOn, setRunOn] = useState<string>('');
  useEffect(() => setRunOn(server?.id ?? ''), [server?.id]);
  const [name, setName] = useState('');
  useEffect(() => setName(picked ? nameOf(picked.path).replace(/\.[^.]+$/, '') || 'project' : ''), [picked?.path]);
  const notebookFile = Boolean(picked && !picked.dir && /\.ipynb$/i.test(picked.name));
  const [busy, setBusy] = useState(false);

  const open = async () => {
    if (!server || !picked) return;
    setBusy(true);
    setProblem(null);
    try {
      const folder = picked.dir ? picked.path : parentOf(picked.path);
      // The folder as the Companion serves it: linked in from anywhere on the computer, or already under its folder.
      const root = mode === 'disk' ? (await linkFolder(server, folder)).root : picked.dir ? picked.path : picked.path.split('/').slice(0, -1).join('/');
      if (!root) throw new Error(`Pick a folder inside ${server.root ?? 'the Reader folder'}, not the Reader folder itself.`);
      const host = serverHost(server, root);
      const compute: Compute = runOn === 'colab' ? { kind: 'colab', machine: { accelerator: 'NONE' } } : { kind: 'server', serverId: runOn || server.id };
      const title = name.trim() || nameOf(folder);
      let cells = blankCells(title);
      if (notebookFile) {
        const text = await host.read(nameOf(picked.path));
        const read = text ? fromIpynb(text) : null;
        if (!read) throw new Error(`${picked.name} is not a notebook this page can read.`);
        cells = read;
      }
      let home: FilesHome = { kind: 'server', serverId: server.id, root };
      let files: Record<string, string> | undefined;
      if (how !== 'here') {
        files = {};
        for (const file of snapshotPlan(await listAll(host)).take) {
          const text = await host.read(file.path).catch(() => null);
          if (text !== null) files[file.path] = text;
        }
        home = how === 'drive' ? { kind: 'drive', folder: '' } : { kind: 'server', serverId: server.id, root: '' };
      }
      const made: Playground = await createPlayground({ title, kind: notebookFile ? 'notebook' : 'project', compute, home, start: 'file', cells, files });
      onOpen(made.id);
      onClose();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  // -------------------------------------------------------------- account --
  const companions = servers.filter(isCompanion);
  const accountLine = !account ? (
    <>
      <b>Not signed in.</b> Only the computers paired with this browser are listed. Sign in with Google (top of Settings) to see every computer that has the Reader app signed in as you, from any browser.
    </>
  ) : devices === 'loading' ? (
    <>Looking up the computers signed in as {maskEmail(account)}…</>
  ) : devices && devices.length === 0 ? (
    <>
      <b>No computer has the Reader app signed in as {maskEmail(account)}.</b> Install it on the computer that has your files and it shows here, from any browser you sign in to.{' '}
      <button type="button" className="link" onClick={onConnect}>
        Connect this computer
      </button>
    </>
  ) : devices ? (
    <>
      Signed in as {maskEmail(account)} · the Reader app is on {devices.length} {devices.length === 1 ? 'computer' : 'computers'}:{' '}
      {devices.map((d, i) => (
        <span key={d.id}>
          {i ? ', ' : ''}
          <b>{d.name}</b> {d.online === false || d.off ? `(offline${d.seen ? `, seen ${since(d.seen)}` : ''})` : '(online)'}
        </span>
      ))}
      {companions.length < devices.length ? ' — the ones not listed below have no address this browser can reach yet.' : ''}
    </>
  ) : (
    <>Signed in as {maskEmail(account)}; the list of your computers couldn’t be read just now — the ones paired with this browser are below.</>
  );

  const label = (s: JupyterServer) => {
    const p = probes[s.id];
    if (s.companionId && s.companionId === localId) return 'this computer';
    if (!p || p.state === 'checking') return 'looking…';
    if (p.state === 'down') return `offline${s.seen ? ` · seen ${since(s.seen)}` : ''}`;
    return s.where === 'pc' ? 'online' : 'online · through its tunnel';
  };

  return (
    <div className="scrim op-scrim" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div className="op-dlg" role="dialog" aria-modal="true" aria-label="Open a file or folder">
        <header className="op-head">
          <div>
            <span className="eyebrow">Open a file or folder</span>
            <h2>Where is it?</h2>
          </div>
          <button type="button" className="icon-btn sm" aria-label="Close" onClick={onClose} disabled={busy}>
            <CloseIcon size={14} />
          </button>
        </header>
        <p className={`op-account${account && devices && devices !== 'loading' && devices.length === 0 ? ' is-warn' : ''}`}>{accountLine}</p>
        <div className="op-body">
          <nav className="op-sources" aria-label="Where it is">
            <span className="op-group">Your computers</span>
            {ordered.length ? (
              ordered.map((s) => (
                <button key={s.id} type="button" className={`op-source${server?.id === s.id ? ' is-on' : ''}`} onClick={() => setSource({ kind: 'server', id: s.id })}>
                  <span className={`op-dot is-${s.companionId && s.companionId === localId ? 'here' : probes[s.id]?.state ?? 'checking'}`} />
                  <span className="op-source-text">
                    <b>{s.name}</b>
                    <small>{label(s)}</small>
                  </span>
                </button>
              ))
            ) : (
              <p className="op-empty">
                None connected to this browser.{' '}
                <button type="button" className="link" onClick={onConnect}>
                  Connect this computer
                </button>
              </p>
            )}
            <span className="op-group">Elsewhere</span>
            <button type="button" className={`op-source${source?.kind === 'browser' ? ' is-on' : ''}`} onClick={() => setSource({ kind: 'browser' })}>
              <span className="op-dot is-up" />
              <span className="op-source-text">
                <b>Upload from this browser</b>
                <small>a copy, from the computer you’re on</small>
              </span>
            </button>
            <button type="button" className={`op-source${source?.kind === 'drive' ? ' is-on' : ''}`} onClick={() => setSource({ kind: 'drive' })}>
              <span className={`op-dot is-${drive ? 'up' : 'down'}`} />
              <span className="op-source-text">
                <b>Google Drive</b>
                <small>{drive ? 'what to do with Drive files' : 'not signed in with Drive'}</small>
              </span>
            </button>
            <button type="button" className={`op-source${source?.kind === 'colab' ? ' is-on' : ''}`} onClick={() => setSource({ kind: 'colab' })}>
              <span className={`op-dot is-${colabOk ? 'up' : 'down'}`} />
              <span className="op-source-text">
                <b>Colab</b>
                <small>files on a Colab runtime</small>
              </span>
            </button>
          </nav>

          <section className="op-main">
            {!source ? (
              <p className="pg-note">
                <span className="spinner" /> Looking for your computers…
              </p>
            ) : source.kind === 'browser' ? (
              <div className="op-guide">
                <h3>Upload a copy from the computer you’re on</h3>
                <p>The browser reads the file or folder and the project gets a copy; where that copy is kept — your Drive, a folder on a computer of yours — is the next step. Data, checkpoints, caches and files over 200 KB are left out.</p>
                {localId ? (
                  <p className="op-tip">
                    This computer has the Reader app: pick <b>{servers.find((s) => s.companionId === localId)?.name ?? 'it'}</b> on the left to open a folder <b>where it is</b>, with nothing copied — edits change the folder itself.
                  </p>
                ) : null}
                <div className="op-acts">
                  <button type="button" className="btn" onClick={onUploadFile}>
                    Choose a file…
                  </button>
                  <button type="button" className="btn" onClick={onUploadFolder}>
                    Choose a folder…
                  </button>
                </div>
              </div>
            ) : source.kind === 'drive' ? (
              <div className="op-guide">
                <h3>Files in your Google Drive</h3>
                <p>
                  Reader sees only the files it made in your Drive (Google’s <i>drive.file</i> permission), so other Drive folders can’t be browsed from here. Projects already kept in Drive are in your list, and open on any computer.
                </p>
                <ul>
                  <li>To work on a Drive folder with Colab: start a <b>Blank notebook</b> on Colab and mount Drive in it — <code>from google.colab import drive; drive.mount('/content/drive')</code>.</li>
                  <li>To work on it on a computer: let Google Drive for desktop sync it there, then pick that computer on the left and open the folder where it is.</li>
                  <li>Or download it, and use <b>Upload from this browser</b>.</li>
                </ul>
                {!drive ? <p className="op-tip">Sign in with Google, with Drive, to keep projects in Drive.</p> : null}
              </div>
            ) : source.kind === 'colab' ? (
              <div className="op-guide">
                <h3>Files on a Colab runtime</h3>
                <p>A Colab runtime’s disk is wiped when the runtime stops, so there is nothing there to open later. Keep the code somewhere that lasts and run it on Colab:</p>
                <ul>
                  <li>Open the folder from a computer of yours (or upload it) and keep it in <b>your Drive</b>, then choose <b>Colab</b> under “Run it on” — the code is copied to the runtime before each run.</li>
                  <li>For a repository, use <b>From a repository</b>: the clone runs on the machine you pick.</li>
                </ul>
                {!colabOk ? <p className="op-tip">Colab needs a Google client ID and the reader’s proxy, in Settings.</p> : null}
              </div>
            ) : !server ? null : probe?.state === 'down' ? (
              <div className="op-guide">
                <h3>{server.name} isn’t answering</h3>
                <p>
                  It may be off or asleep, or its Companion has stopped{server.seen ? ` — last seen ${since(server.seen)}` : ''}. On {server.name}, open the Reader app (or run <code>reader-companion</code>); it shows here as online, and its folders can be opened.
                </p>
                <p className="op-tip">Its files can’t be opened from here until it answers: nothing of it is kept anywhere else.</p>
              </div>
            ) : probe?.state !== 'up' ? (
              <p className="pg-note">
                <span className="spinner" /> Reaching {server.name}…
              </p>
            ) : (
              <div className="op-browse">
                {mode === 'root' ? (
                  <p className="op-tip">
                    {isCompanion(server)
                      ? `This Companion (${probe.version ?? 'older'}) shows only its own folder. Update it to ${FOLDERS_VERSION} or later (the machine menu on a project, or Your compute) to browse the whole computer.`
                      : 'A Jupyter server shows only the folder it was started in.'}
                  </p>
                ) : null}
                <div className="op-path">
                  {place?.parent !== null && place?.parent !== undefined ? (
                    <button type="button" className="btn sm" onClick={() => enter(place.parent!)} title="Up a folder">
                      ↑
                    </button>
                  ) : null}
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (mode === 'disk') enter(typed);
                    }}
                  >
                    <input value={typed} onChange={(event) => setTyped(event.target.value)} readOnly={mode !== 'disk'} aria-label="The folder" spellCheck={false} />
                  </form>
                  <label className="op-hidden">
                    <input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} /> hidden
                  </label>
                  {mode === 'disk' && isHere ? (
                    <button
                      type="button"
                      className="btn sm"
                      title={`${server.name}'s own folder chooser`}
                      onClick={() =>
                        void chooseFolder(server)
                          .then((got) => got.path && (enter(got.path), setPicked({ name: nameOf(got.path), path: got.path, dir: true, size: null })))
                          .catch((error) => setProblem(error instanceof Error ? error.message : String(error)))
                      }
                    >
                      Choose with this computer’s dialog…
                    </button>
                  ) : null}
                </div>
                {place?.places.length ? (
                  <div className="op-places">
                    {place.places.map((p) => (
                      <button key={p.path} type="button" className={`op-chip${place.path === p.path ? ' is-on' : ''}`} onClick={() => enter(p.path)}>
                        {p.name}
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="op-list" role="listbox" aria-label="Folders and files">
                  {loading && !place ? (
                    <p className="pg-note">
                      <span className="spinner" /> Listing…
                    </p>
                  ) : null}
                  {place?.rows.map((row) => (
                    <button
                      key={row.path}
                      type="button"
                      role="option"
                      aria-selected={picked?.path === row.path}
                      className={`op-row${picked?.path === row.path ? ' is-on' : ''}`}
                      onClick={() => setPicked(row)}
                      onDoubleClick={() => row.dir && enter(row.path)}
                    >
                      {row.dir ? <span className="op-folder" aria-hidden="true" /> : <FileIcon path={row.name} />}
                      <span className="op-row-name">{row.name}</span>
                      {row.dir ? (
                        <span
                          className="op-in"
                          onClick={(event) => {
                            event.stopPropagation();
                            enter(row.path);
                          }}
                        >
                          open ›
                        </span>
                      ) : (
                        <small>{row.size !== null ? `${Math.max(1, Math.round(row.size / 1024))} KB` : ''}</small>
                      )}
                    </button>
                  ))}
                  {place && !place.rows.length ? <p className="pg-note">Nothing here.</p> : null}
                </div>
              </div>
            )}
            {problem ? <p className="pg-note is-problem">{problem}</p> : null}
          </section>
        </div>

        {server && probe?.state === 'up' && picked ? (
          <footer className="op-foot">
            <div className="op-picked">
              <span className="eyebrow">{picked.dir ? 'Folder' : notebookFile ? 'Notebook' : 'File'}</span>
              <b title={picked.path}>{place?.home && picked.path.startsWith(place.home) ? `~${picked.path.slice(place.home.length)}` : picked.path || '(its folder)'}</b>
              {!picked.dir ? <small>{notebookFile ? 'opens as a notebook; its folder holds the files' : 'its folder becomes the project, with this file in it'}</small> : null}
            </div>
            <div className="op-how" role="radiogroup" aria-label="How">
              <label className={how === 'here' ? 'is-on' : ''}>
                <input type="radio" checked={how === 'here'} onChange={() => setHow('here')} />
                <span>
                  <b>Use it where it is</b>
                  <small>{mode === 'disk' ? `Edits change the folder on ${server.name} itself; it is linked into the Reader folder, nothing copied.` : `The project is that folder on ${server.name}.`}</small>
                </span>
              </label>
              <label className={how === 'drive' ? 'is-on' : ''} title={drive ? undefined : 'Sign in with Google, with Drive, first'}>
                <input type="radio" checked={how === 'drive'} disabled={!drive} onChange={() => setHow('drive')} />
                <span>
                  <b>Copy it into your Drive</b>
                  <small>{drive ? 'Opens on every computer; the original stays as it is.' : 'Sign in with Google, with Drive, first.'}</small>
                </span>
              </label>
              <label className={how === 'copy' ? 'is-on' : ''}>
                <input type="radio" checked={how === 'copy'} onChange={() => setHow('copy')} />
                <span>
                  <b>Copy it into a new folder on {server.name}</b>
                  <small>To try things without touching the original.</small>
                </span>
              </label>
            </div>
            <div className="op-run">
              <label>
                <span className="eyebrow">Name</span>
                <input value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <label>
                <span className="eyebrow">Run it on</span>
                <select value={runOn} onChange={(event) => setRunOn(event.target.value)}>
                  <option value={server.id}>{server.name} — where the code is</option>
                  {upOthers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} — the folder copied there before each run
                    </option>
                  ))}
                  {colabOk ? <option value="colab">Colab — the folder copied to the runtime before each run</option> : null}
                </select>
              </label>
              <button type="button" className="btn primary" disabled={busy || !name.trim()} onClick={() => void open()}>
                {busy ? 'Opening…' : how === 'here' ? 'Open it' : 'Copy and open'}
              </button>
            </div>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
