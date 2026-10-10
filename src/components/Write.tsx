// The Write tab: a project's paper, the whole page an editor — its files, the
// LaTeX, and the PDF it makes — as Overleaf is, but on this computer. The
// files are in a folder under the Companion's (read and written through
// Jupyter, as the Playground's are), the Companion compiles them (latexmk, or
// Tectonic) and keeps the folder in step with Overleaf through its Git, or
// Dropbox does. When it compiles, how it is laid out, when it syncs and the
// citations drawer are Settings → Projects → The Write tab (types.ts,
// `WRITE_OPTIONS`). The folder is chosen once on each computer: a project
// remembers it by the computer's Companion.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { jupyterList, jupyterRead, jupyterWrite } from '../lib/colab';
import { PAPER_VERSION, chooseFolder, clonePaper, compilePaper, installTectonic, linkFolder, paperEngines, paperRemote, syncPaper, type Compiled, type PaperEngines, type Synced, type TexProblem } from '../lib/companion';
import { bibEntries, isBuildFile, isTextFile, keyFor, overleafGitUrl, paperFolderFor, withEntry } from '../lib/overleaf';
import { openPdf } from '../lib/pdfReflow';
import { papersIn, type Project } from '../lib/projects';
import { thisComputer, type ThisComputer } from '../lib/thisComputer';
import type { PaperFolder, WriteOptions } from '../types';
import { WRITE_DEFAULTS } from '../types';
import type { View } from '../types.view';
import CodeEditor, { type CodeEditorHandle } from './CodeEditor';
import { OpenOverleaf } from './Overleaf';

type Here = Extract<ThisComputer, { server: unknown }>;

/** The tab, for a project: this computer's Companion, then the paper's folder on it, then the desk. */
export default function WritePage({ project, onView }: { project: Project; onView: (view: View) => void }) {
  const [here, setHere] = useState<ThisComputer | null>(null);
  const ask = useCallback((again = false) => {
    setHere(null);
    void thisComputer(PAPER_VERSION, 'write the paper here', again).then(setHere);
  }, []);
  useEffect(() => ask(), [ask]);
  const link = project.project.overleaf;
  const folder = here && 'id' in here ? link?.folders?.[here.id] : undefined;

  if (!here) return <div className="wr-center"><p className="wr-quiet">Looking for this computer’s Companion…</p></div>;
  if ('error' in here) {
    return (
      <div className="wr-center">
        <div className="wr-card">
          <span className="eyebrow">The paper</span>
          <h2>Write it on this computer</h2>
          <p>The Write tab keeps the paper in a folder on your computer, compiles it there and syncs it with Overleaf, so it needs the Companion.</p>
          <p className="wr-bad">{here.error}</p>
          <div className="wr-row">
            <button type="button" className="btn primary" onClick={() => ask(true)}>
              Try again
            </button>
            <button type="button" className="btn" onClick={() => onView({ kind: 'playground' })}>
              Connect this computer
            </button>
            {link ? <OpenOverleaf project={project} view="beside" primary={false} /> : null}
          </div>
        </div>
      </div>
    );
  }
  if (!folder) return <WriteSetUp project={project} here={here} />;
  return <WriteDesk key={`${here.id}:${folder.path}`} project={project} here={here} folder={folder} />;
}

// ------------------------------------------------------------- set-up --

function useSaveFolder(project: Project) {
  const { updateCollection } = useStore();
  return (computer: string, folder: PaperFolder | undefined, url?: string) =>
    void updateCollection(project.id, (collection) => {
      const info = { ...project.project, ...(collection.project ?? {}) };
      const link = info.overleaf ?? (url ? { url } : undefined);
      if (!link) return {};
      const folders = { ...(link.folders ?? {}) };
      if (folder) folders[computer] = folder;
      else delete folders[computer];
      const { folders: _old, ...rest } = link;
      return { project: { ...info, overleaf: { ...rest, ...(Object.keys(folders).length ? { folders } : {}) } } };
    });
}

/** Where the paper's folder comes from, the first time on this computer. */
function WriteSetUp({ project, here }: { project: Project; here: Here }) {
  const { settings } = useStore();
  const link = project.project.overleaf;
  const save = useSaveFolder(project);
  const gitUrl = overleafGitUrl(link?.url);
  const [way, setWay] = useState<'git' | 'dropbox' | 'github' | 'folder'>(gitUrl ? 'git' : link?.repo ? 'github' : 'dropbox');
  const [token, setToken] = useState('');
  const [where, setWhere] = useState(paperFolderFor(project.name));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [engines, setEngines] = useState<PaperEngines | null>(null);
  useEffect(() => {
    void paperEngines(here.server).then(setEngines, () => setEngines(null));
  }, [here]);

  const clone = async (url: string, secret: string) => {
    setBusy(true);
    setProblem(null);
    try {
      const done = await clonePaper(here.server, where, url, secret);
      save(here.id, { path: done.folder, sync: 'git' });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const pick = async (sync: 'dropbox' | 'folder') => {
    setBusy(true);
    setProblem(null);
    try {
      const chosen = await chooseFolder(here.server);
      if (!chosen.path) return;
      const linked = await linkFolder(here.server, chosen.path);
      save(here.id, { path: linked.root, sync });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wr-scroll">
      <div className="wr-card wr-setup">
        <span className="eyebrow">The paper · on {here.name}</span>
        <h2>Where should the paper’s files be?</h2>
        <p>The Write tab edits the paper in a folder on this computer, compiles it here as you type, and keeps it in step with Overleaf. Pick how, once for this computer.</p>
        {!link ? <p className="wr-bad">Link the Overleaf project on the project’s overview first (the paper card), so the tab knows which paper it is.</p> : null}
        <div className="wr-ways" role="radiogroup" aria-label="Where the paper’s files come from">
          <button type="button" role="radio" aria-checked={way === 'git'} className={`wr-way${way === 'git' ? ' is-on' : ''}`} onClick={() => setWay('git')} disabled={!gitUrl}>
            <b>
              Overleaf’s Git <small>recommended</small>
            </b>
            <span>A clone of the Overleaf project. Edits go to Overleaf seconds after you stop typing, and coauthors’ edits come in. Needs a paid Overleaf plan.</span>
            {!gitUrl && link ? <span className="wr-bad">This needs the project’s address in Overleaf (overleaf.com/project/…), not a share link: change it on the paper card.</span> : null}
          </button>
          <button type="button" role="radio" aria-checked={way === 'dropbox'} className={`wr-way${way === 'dropbox' ? ' is-on' : ''}`} onClick={() => setWay('dropbox')}>
            <b>Overleaf’s Dropbox folder</b>
            <span>If Overleaf syncs the project to Dropbox, pick that folder: Dropbox carries edits both ways by itself. Needs a paid Overleaf plan and Dropbox here.</span>
          </button>
          <button type="button" role="radio" aria-checked={way === 'github'} className={`wr-way${way === 'github' ? ' is-on' : ''}`} onClick={() => setWay('github')} disabled={!link?.repo}>
            <b>Its GitHub repository</b>
            <span>{link?.repo ? `A clone of ${link.repo}, with the token from Settings → Git mirror. Overleaf takes the edits in from Menu → GitHub → Pull.` : 'Name the repository on the paper card first (Overleaf’s GitHub sync).'}</span>
          </button>
          <button type="button" role="radio" aria-checked={way === 'folder'} className={`wr-way${way === 'folder' ? ' is-on' : ''}`} onClick={() => setWay('folder')}>
            <b>A folder already here</b>
            <span>Any folder with the paper in it, compiled here and not synced: copy it to Overleaf yourself.</span>
          </button>
        </div>

        {way === 'git' && gitUrl ? (
          <div className="wr-form">
            <label className="wr-field">
              <span>Overleaf Git token</span>
              <input type="password" value={token} autoComplete="off" placeholder="olp_…" onChange={(event) => setToken(event.target.value)} />
              <small>In Overleaf: Account Settings → Git integration → Generate token. The Companion keeps it on this computer, readable only by you.</small>
            </label>
            <label className="wr-field">
              <span>Folder, inside the Companion’s</span>
              <input value={where} onChange={(event) => setWhere(event.target.value)} />
            </label>
            <div className="wr-row">
              <button type="button" className="btn primary" disabled={busy || !token.trim() || !where.trim()} onClick={() => void clone(gitUrl, token.trim())}>
                {busy ? 'Cloning…' : 'Clone from Overleaf'}
              </button>
              <span className="wr-quiet mono">{gitUrl}</span>
            </div>
          </div>
        ) : null}
        {way === 'github' && link?.repo ? (
          <div className="wr-form">
            <label className="wr-field">
              <span>Folder, inside the Companion’s</span>
              <input value={where} onChange={(event) => setWhere(event.target.value)} />
            </label>
            <div className="wr-row">
              <button type="button" className="btn primary" disabled={busy || !settings.githubToken.trim()} onClick={() => void clone(`https://github.com/${link.repo}`, settings.githubToken.trim())}>
                {busy ? 'Cloning…' : `Clone ${link.repo}`}
              </button>
              {!settings.githubToken.trim() ? <span className="wr-bad">Add a GitHub token in Settings → Git mirror first.</span> : null}
            </div>
          </div>
        ) : null}
        {way === 'dropbox' || way === 'folder' ? (
          <div className="wr-row">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void pick(way)}>
              {busy ? 'Waiting for the folder…' : 'Choose the folder on this computer'}
            </button>
            <span className="wr-quiet">{way === 'dropbox' ? 'Usually Dropbox → Apps → Overleaf → the project.' : 'It opens this computer’s own folder chooser.'}</span>
          </div>
        ) : null}
        {problem ? <p className="wr-bad">{problem}</p> : null}
        {engines && !engines.latexmk && !engines.tectonic ? (
          <p className="wr-note">
            There’s no TeX on this computer yet: the first compile offers to fetch Tectonic, or install TeX Live or MacTeX yourself.
          </p>
        ) : null}
        {engines && !engines.git && (way === 'git' || way === 'github') ? <p className="wr-bad">git isn’t installed on this computer: install it (git-scm.com, or xcode-select --install on a Mac) to sync.</p> : null}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- desk --

interface FileState {
  /** What the file says now, typed here. */
  text: string;
  /** What is on disk. */
  disk: string;
}

const COMPILE_PAUSE_MS = 1000;
const SAVE_PAUSE_MS = 600;
const SYNC_PAUSE_MS = 4000;
const PULL_EVERY_MS = 30_000;
const MAX_FILES = 400;

/** Every file under the folder, as paths relative to it; what compiling leaves and .git left out. */
async function listAll(server: Here['server'], folder: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 5 || found.length >= MAX_FILES) return;
    const listing = await jupyterList(server, dir);
    for (const entry of listing.entries) {
      const relative = entry.path.startsWith(`${folder}/`) ? entry.path.slice(folder.length + 1) : entry.name;
      if (entry.name.startsWith('.')) continue;
      if (entry.type === 'directory') await walk(entry.path, depth + 1);
      else if (!isBuildFile(relative)) found.push(relative);
    }
  };
  await walk(folder, 0);
  return found.sort((a, b) => (a.includes('/') === b.includes('/') ? a.localeCompare(b) : a.includes('/') ? 1 : -1));
}

const toBlob = (base64: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'application/pdf' });
};

function WriteDesk({ project, here, folder }: { project: Project; here: Here; folder: PaperFolder }) {
  const { settings, papers } = useStore();
  const options: WriteOptions = { ...WRITE_DEFAULTS, ...(settings.write ?? {}) };
  const save = useSaveFolder(project);
  const server = here.server;
  const [paths, setPaths] = useState<string[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, FileState>>({});
  const filesRef = useRef(files);
  filesRef.current = files;
  const [open, setOpenState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(`reader.write.${project.id}.file`);
    } catch {
      return null;
    }
  });
  const editor = useRef<CodeEditorHandle>(null);
  const [compiled, setCompiled] = useState<Compiled | null>(null);
  const [pdf, setPdf] = useState<Blob | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [engines, setEngines] = useState<PaperEngines | null>(null);
  const [installing, setInstalling] = useState(false);
  const [synced, setSynced] = useState<Synced | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(0);
  const [showLog, setShowLog] = useState(false);
  const [pane, setPane] = useState<'source' | 'pdf'>('source');
  const [drawer, setDrawer] = useState(true);
  const typedAt = useRef(0);
  const timers = useRef<{ save?: number; compile?: number; sync?: number }>({});
  const git = folder.sync === 'git';
  const at = (relative: string) => `${folder.path}/${relative}`;

  const setOpen = (path: string) => {
    setOpenState(path);
    try {
      localStorage.setItem(`reader.write.${project.id}.file`, path);
    } catch {
      // only a convenience
    }
  };

  const load = useCallback(
    async (relative: string, force = false) => {
      if (!force && filesRef.current[relative]) return;
      const read = await jupyterRead(server, at(relative));
      const text = read?.text ?? '';
      setFiles((current) => (!force && current[relative] ? current : { ...current, [relative]: { text, disk: text } }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [server, folder.path],
  );

  const refreshList = useCallback(async () => {
    try {
      setPaths(await listAll(server, folder.path));
      setListError(null);
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    }
  }, [server, folder.path]);

  useEffect(() => {
    void refreshList();
    void paperEngines(server).then(setEngines, () => setEngines(null));
    if (git) void paperRemote(server, folder.path).then((remote) => setNeedToken(!remote.token && /overleaf|github/.test(remote.url)), () => undefined);
  }, [refreshList, server, folder.path, git]);

  const texts = (paths ?? []).filter(isTextFile);
  const mainGuess = texts.find((path) => path === compiled?.main) ?? texts.find((path) => /(^|\/)main\.tex$/.test(path)) ?? texts.find((path) => path.endsWith('.tex'));
  const shown = open && texts.includes(open) ? open : mainGuess;
  useEffect(() => {
    if (shown) void load(shown);
  }, [shown, load]);

  // ---- compile
  const compile = useCallback(async () => {
    setCompiling(true);
    setCompileError(null);
    try {
      const done = await compilePaper(server, folder.path, options.engine);
      setCompiled(done);
      if (done.pdf) setPdf(toBlob(done.pdf));
      if (done.errors.length && !done.pdf) setShowLog(true);
    } catch (error) {
      setCompileError(error instanceof Error ? error.message : String(error));
    } finally {
      setCompiling(false);
    }
  }, [server, folder.path, options.engine]);
  useEffect(() => {
    if (paths && texts.length && engines && (engines.latexmk || engines.tectonic) && !compiled && !compiling) void compile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths, engines]);

  // ---- sync
  const sync = useCallback(
    async (quiet = false) => {
      if (!git) return;
      setSyncing(true);
      if (!quiet) setSyncError(null);
      try {
        const done = await syncPaper(server, folder.path, 'Edits from Reader', token.trim() || undefined);
        setSynced(done);
        setSyncError(done.ok ? null : done.error ?? 'The sync didn’t finish.');
        if (token.trim() && done.ok) setNeedToken(false);
        const incoming = (done.incoming ?? []).map((path) => path.replace(/^\.\//, ''));
        const conflicted = done.conflicts ?? [];
        const reload = [...new Set([...incoming, ...conflicted])].filter((path) => filesRef.current[path] && filesRef.current[path].text === filesRef.current[path].disk);
        if (reload.length || incoming.some((path) => !(paths ?? []).includes(path))) void refreshList();
        await Promise.all(reload.map((path) => load(path, true)));
        if (incoming.length && options.compile !== 'manual') void compile();
      } catch (error) {
        setSyncError(error instanceof Error ? error.message : String(error));
      } finally {
        setSyncing(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [git, server, folder.path, token, paths, options.compile, compile],
  );
  // What coauthors write in Overleaf comes in while nothing is being typed here.
  useEffect(() => {
    if (!git || options.sync === 'manual') return;
    const timer = window.setInterval(() => {
      const dirty = Object.values(filesRef.current).some((file) => file.text !== file.disk);
      if (!dirty && Date.now() - typedAt.current > 5000) void sync(true);
    }, PULL_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [git, options.sync, sync]);

  // ---- save
  const writeOut = useCallback(
    async (relative: string) => {
      const file = filesRef.current[relative];
      if (!file || file.text === file.disk) return false;
      const text = file.text;
      setSaving((n) => n + 1);
      try {
        await jupyterWrite(server, at(relative), text);
        setFiles((current) => (current[relative] ? { ...current, [relative]: { ...current[relative], disk: text } } : current));
        return true;
      } finally {
        setSaving((n) => n - 1);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [server, folder.path],
  );
  const saveAll = useCallback(async () => {
    const dirty = Object.keys(filesRef.current).filter((path) => filesRef.current[path].text !== filesRef.current[path].disk);
    const results = await Promise.all(dirty.map(writeOut));
    return results.some(Boolean);
  }, [writeOut]);

  const afterSave = (how: 'pause' | 'save') => {
    window.clearTimeout(timers.current.compile);
    window.clearTimeout(timers.current.sync);
    if (options.compile === how) timers.current.compile = window.setTimeout(() => void compile(), how === 'pause' ? COMPILE_PAUSE_MS : 0);
    if (git && options.sync === how) timers.current.sync = window.setTimeout(() => void sync(true), how === 'pause' ? SYNC_PAUSE_MS : 0);
  };

  const edit = (relative: string, text: string) => {
    typedAt.current = Date.now();
    setFiles((current) => ({ ...current, [relative]: { disk: current[relative]?.disk ?? '', text } }));
    window.clearTimeout(timers.current.save);
    window.clearTimeout(timers.current.compile);
    window.clearTimeout(timers.current.sync);
    timers.current.save = window.setTimeout(() => void saveAll().then((wrote) => wrote && afterSave('pause')), SAVE_PAUSE_MS);
  };
  useEffect(() => () => {
    window.clearTimeout(timers.current.save);
    window.clearTimeout(timers.current.compile);
    window.clearTimeout(timers.current.sync);
  }, []);

  const saveNow = async () => {
    window.clearTimeout(timers.current.save);
    await saveAll();
    afterSave('save');
  };

  // ---- citations
  const mine = useMemo(() => papersIn(project.id, papers), [project.id, papers]);
  const bibPath = texts.find((path) => path.endsWith('.bib'));
  const bibText = bibPath ? files[bibPath]?.text : undefined;
  useEffect(() => {
    if (bibPath && options.citations === 'drawer') void load(bibPath);
  }, [bibPath, options.citations, load]);
  const entries = useMemo(() => bibEntries(bibPath && bibText !== undefined ? [{ path: bibPath, text: bibText }] : []), [bibPath, bibText]);
  const cite = (paperId: string) => {
    const paper = mine.find((item) => item.id === paperId);
    if (!paper || !shown) return;
    editor.current?.insert(`\\cite{${keyFor(paper, entries)}}`);
    if (bibPath && bibText !== undefined) {
      const added = withEntry(bibText, paper, entries);
      if (added) edit(bibPath, added);
    }
  };

  const goTo = (problem: TexProblem) => {
    const file = problem.file ? problem.file.replace(/^\.\//, '') : compiled?.main;
    if (file && texts.includes(file)) setOpen(file);
    if (options.layout === 'tabs') setPane('source');
    if (problem.line) window.setTimeout(() => editor.current?.goToLine(problem.line!), 60);
  };

  const current = shown ? files[shown] : undefined;
  const dirtyCount = Object.values(files).filter((file) => file.text !== file.disk).length;
  const noTex = engines && !engines.latexmk && !engines.tectonic;

  const source = (
    <section className="wr-source">
      <div className="wr-tabs">
        {shown ? <span className="wr-file mono">{shown}{current && current.text !== current.disk ? ' ●' : ''}</span> : null}
        <span className="wr-sp" />
        {options.layout === 'tabs' ? (
          <span className="segmented sm">
            <button type="button" aria-pressed={pane === 'source'} onClick={() => setPane('source')}>Source</button>
            <button type="button" aria-pressed={pane === 'pdf'} onClick={() => setPane('pdf')}>PDF</button>
          </span>
        ) : null}
      </div>
      <div className="wr-editor">
        {shown && current ? (
          <CodeEditor
            key={shown}
            ref={editor}
            value={current.text}
            path={shown}
            wrap
            minimap={false}
            onChange={(next) => edit(shown, next)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                event.preventDefault();
                void saveNow();
              }
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void saveNow().then(() => compile());
              }
            }}
          />
        ) : (
          <p className="wr-quiet wr-pad">{paths === null ? 'Reading the folder…' : texts.length ? 'Opening…' : 'No .tex file in this folder yet.'}</p>
        )}
      </div>
    </section>
  );

  const preview = (
    <section className="wr-preview">
      <div className="wr-tabs">
        <b>PDF</b>
        {compiled ? <span className="wr-quiet">{compiled.engine} · {(compiled.ms / 1000).toFixed(1)} s</span> : null}
        <span className="wr-sp" />
        <button type="button" className="btn sm primary" disabled={compiling || Boolean(noTex)} onClick={() => void saveNow().then(() => compile())} title="Recompile (⌘↵)">
          {compiling ? 'Compiling…' : 'Recompile'}
        </button>
        {options.layout === 'tabs' ? (
          <span className="segmented sm">
            <button type="button" aria-pressed={pane === 'source'} onClick={() => setPane('source')}>Source</button>
            <button type="button" aria-pressed={pane === 'pdf'} onClick={() => setPane('pdf')}>PDF</button>
          </span>
        ) : null}
      </div>
      {noTex ? (
        <div className="wr-pad">
          <p>There’s no TeX on this computer to compile with.</p>
          {engines?.tectonicInstallable ? (
            <button
              type="button"
              className="btn primary sm"
              disabled={installing}
              onClick={async () => {
                setInstalling(true);
                try {
                  await installTectonic(server);
                  setEngines(await paperEngines(server));
                  void compile();
                } catch (error) {
                  setCompileError(error instanceof Error ? error.message : String(error));
                } finally {
                  setInstalling(false);
                }
              }}
            >
              {installing ? 'Fetching Tectonic…' : 'Fetch Tectonic (about 30 MB)'}
            </button>
          ) : null}
          <p className="wr-quiet">Or install TeX Live (Linux, Windows) or MacTeX (Mac), and compile again.</p>
        </div>
      ) : null}
      {compileError ? <p className="wr-banner">{compileError}</p> : null}
      <PdfPages blob={pdf} />
    </section>
  );

  const layoutClass = options.layout === 'stacked' ? ' is-stacked' : options.layout === 'tabs' ? ` is-tabs show-${pane}` : '';
  return (
    <div className="wr-desk">
      <aside className="wr-side">
        <div className="wr-side-head">
          <b>Files</b>
          <button type="button" className="link-btn" onClick={() => void refreshList()} title="Read the folder again">
            ↻
          </button>
        </div>
        <div className="wr-tree">
          {listError ? <p className="wr-bad wr-pad">{listError}</p> : null}
          {(paths ?? []).map((path) => (
            <button
              key={path}
              type="button"
              className={`wr-tree-item${path === shown ? ' is-on' : ''}${isTextFile(path) ? '' : ' is-other'}`}
              disabled={!isTextFile(path)}
              onClick={() => setOpen(path)}
              title={path}
            >
              {path.includes('/') ? <span className="wr-tree-dir">{path.slice(0, path.lastIndexOf('/') + 1)}</span> : null}
              {path.split('/').pop()}
              {files[path] && files[path].text !== files[path].disk ? <i> ●</i> : null}
              {path === compiled?.main ? <small> main</small> : null}
            </button>
          ))}
        </div>
        {options.citations === 'drawer' ? (
          <div className={`wr-drawer${drawer ? ' is-open' : ''}`}>
            <button type="button" className="wr-side-head wr-drawer-head" aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>
              <b>Cite · {mine.length}</b>
              <span>{drawer ? '▾' : '▸'}</span>
            </button>
            {drawer ? (
              <div className="wr-cites">
                {mine.map((paper) => (
                  <button key={paper.id} type="button" className="wr-cite" onMouseDown={(event) => event.preventDefault()} onClick={() => cite(paper.id)} title={`\\cite{${keyFor(paper, entries)}} at the cursor${bibPath ? `, its entry added to ${bibPath} if missing` : ''}`}>
                    <span>{paper.title}</span>
                    <small className="mono">{keyFor(paper, entries)}</small>
                  </button>
                ))}
                {!mine.length ? <p className="wr-quiet wr-pad">The project has no papers yet.</p> : null}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="wr-side-foot">
          <span className="wr-quiet mono" title={folder.path}>
            {here.name} · {folder.path}
          </span>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              if (window.confirm('Use another folder for the paper on this computer? This folder stays as it is.')) save(here.id, undefined);
            }}
          >
            Change
          </button>
        </div>
      </aside>
      <div className={`wr-panes${layoutClass}`}>
        {source}
        {preview}
      </div>
      {showLog && compiled ? (
        <div className="wr-log">
          <div className="wr-tabs">
            <b>{compiled.errors.length} errors · {compiled.warnings.length} warnings</b>
            <span className="wr-sp" />
            <button type="button" className="link-btn" onClick={() => setShowLog(false)}>
              Close
            </button>
          </div>
          <div className="wr-log-body">
            {[...compiled.errors.map((item) => ({ ...item, kind: 'error' })), ...compiled.warnings.map((item) => ({ ...item, kind: 'warning' }))].map((item, index) => (
              <button key={index} type="button" className={`wr-problem is-${item.kind}`} onClick={() => goTo(item)}>
                <b>{item.kind === 'error' ? 'Error' : 'Warning'}</b>
                <span>{item.message}</span>
                <small className="mono">{item.file || compiled.main}{item.line ? `:${item.line}` : ''}</small>
              </button>
            ))}
            {!compiled.errors.length && !compiled.warnings.length ? <p className="wr-quiet wr-pad">Nothing to say.</p> : null}
            <details className="wr-raw">
              <summary>The whole log</summary>
              <pre>{compiled.log}</pre>
            </details>
          </div>
        </div>
      ) : null}
      <footer className="wr-status">
        {git ? (
          <>
            <span className={`wr-dot is-${syncError ? 'bad' : syncing ? 'busy' : synced?.ok ? 'ok' : 'idle'}`} />
            <span>
              {syncing ? 'Syncing with Overleaf…' : syncError ? 'Not synced' : synced?.at ? `Synced with ${/github/.test(project.project.overleaf?.repo ?? '') && !overleafGitUrl(project.project.overleaf?.url) ? 'GitHub' : 'Overleaf'} · ${new Date(synced.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Git · not synced yet'}
            </span>
            <button type="button" className="link-btn" disabled={syncing} onClick={() => void saveNow().then(() => sync())}>
              Sync
            </button>
          </>
        ) : (
          <span>{folder.sync === 'dropbox' ? 'Dropbox keeps this folder in step with Overleaf' : 'Not synced: a folder on this computer'}</span>
        )}
        <span className="wr-sep">·</span>
        <span>{saving > 0 ? 'Saving…' : dirtyCount ? `${dirtyCount} not saved` : 'Saved'}</span>
        <span className="wr-sep">·</span>
        {compiled ? (
          <button type="button" className={`link-btn wr-counts${compiled.errors.length ? ' is-bad' : ''}`} onClick={() => setShowLog(!showLog)}>
            {compiled.errors.length} errors · {compiled.warnings.length} warnings
          </button>
        ) : (
          <span>{compiling ? 'Compiling…' : 'Not compiled yet'}</span>
        )}
        <span className="wr-sp" />
        <OpenOverleaf project={project} view="beside" primary={false} compact />
      </footer>
      {syncError || needToken || (synced?.conflicts.length ?? 0) > 0 ? (
        <div className="wr-sync-banner">
          {synced?.conflicts.length ? (
            <span>
              <b>Overleaf changed the same lines.</b> Look for <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> in {synced.conflicts.map((path) => (
                <button key={path} type="button" className="link-btn" onClick={() => setOpen(path)}>
                  {path}
                </button>
              ))}
              , keep what should stay, and sync again.
            </span>
          ) : needToken ? (
            <span>The Companion has no token for this folder’s remote yet.</span>
          ) : (
            <span>{syncError}</span>
          )}
          {needToken || /auth|token|403|401|denied/i.test(syncError ?? '') ? (
            <span className="wr-token">
              <input type="password" placeholder="Overleaf Git token" value={token} onChange={(event) => setToken(event.target.value)} />
              <button type="button" className="btn sm primary" disabled={!token.trim()} onClick={() => void sync()}>
                Use it
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- pdf --

/** The compiled PDF, every page drawn at the pane's width; where you were stays put across compiles. */
function PdfPages({ blob }: { blob: Blob | null }) {
  const box = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(Math.round(element.clientWidth)));
    observer.observe(element);
    setWidth(Math.round(element.clientWidth));
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!blob || !width || !pagesRef.current) return;
    let cancelled = false;
    let close: (() => void) | null = null;
    const scroller = box.current;
    const ratio = scroller && scroller.scrollHeight > scroller.clientHeight ? scroller.scrollTop / scroller.scrollHeight : 0;
    void (async () => {
      try {
        const opened = await openPdf(blob);
        close = opened.close;
        const canvases: HTMLCanvasElement[] = [];
        const scale = window.devicePixelRatio || 1;
        for (let n = 1; n <= opened.doc.numPages; n += 1) {
          const page = await opened.doc.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const fit = Math.max(0.2, (width - 32) / base.width);
          const viewport = page.getViewport({ scale: fit * scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${Math.floor(viewport.width / scale)}px`;
          canvas.style.height = `${Math.floor(viewport.height / scale)}px`;
          canvas.className = 'wr-page';
          await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
          if (cancelled) return;
          canvases.push(canvas);
        }
        if (cancelled || !pagesRef.current) return;
        // Swapped in whole, so the pane never shows half a PDF; the place you were in is kept.
        pagesRef.current.replaceChildren(...canvases);
        if (scroller) scroller.scrollTop = ratio * scroller.scrollHeight;
        setProblem(null);
      } catch (error) {
        if (!cancelled) setProblem(error instanceof Error ? error.message : String(error));
      } finally {
        close?.();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blob, width]);
  return (
    <div className="wr-pdf" ref={box}>
      {problem ? <p className="wr-bad wr-pad">The PDF couldn’t be drawn: {problem}</p> : null}
      {!blob ? <p className="wr-quiet wr-pad">The PDF shows here once it compiles.</p> : null}
      <div className="wr-pdf-pages" ref={pagesRef} />
    </div>
  );
}
