// A project's paper, written in Overleaf: linking the two, the paper's card
// on the overview, Overleaf opened beside the reader, and the draft edited
// here — in the workspace's Write layout or the dock's Draft tab — when the
// paper is also in a GitHub repository. Which of those a project shows is
// the choice in Settings (types.ts, `OVERLEAF_VIEWS`); the card is in all.
// What the files say is src/lib/overleaf.ts.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useStore } from '../lib/store';
import {
  DraftConflict,
  besideFeatures,
  bibFileOf,
  bibtexFor,
  draftHealth,
  draftTarget,
  keyFor,
  mainFileOf,
  overleafViewOf,
  parseOverleafUrl,
  quoteOf,
  readDraft,
  writeDraft,
  type DraftFile,
} from '../lib/overleaf';
import { parseRepo } from '../lib/github';
import { papersIn, projectsOf, type Project } from '../lib/projects';
import type { OverleafLink, OverleafView, Paper, Settings } from '../types';
import CodeEditor, { type CodeEditorHandle } from './CodeEditor';
import { CheckIcon, CopyIcon, ExternalIcon } from './icons';

// -------------------------------------------------- opening Overleaf --

/** Opens the project in Overleaf: in a window on the right half of the screen when it goes beside, else in a tab. */
export function openOverleaf(link: OverleafLink, projectId: string, view: OverleafView) {
  const opened =
    view === 'beside'
      ? window.open(link.url, `reader-overleaf-${projectId}`, besideFeatures(window.screen))
      : window.open(link.url, `reader-overleaf-${projectId}`);
  if (!opened) {
    window.location.assign(link.url);
    return;
  }
  // Overleaf is another site: it gets no handle back on this page.
  try {
    opened.opener = null;
  } catch {
    // already gone across
  }
  opened.focus();
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------- the draft --
// One draft a project, shared by the card, the Write layout and the dock,
// so an edit made in one is in the others and is saved once.

interface DraftState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  files: DraftFile[];
  /** What was typed here and not yet saved, by path. */
  edits: Record<string, string>;
  error?: string;
  saving?: boolean;
  savedAt?: number;
  /** The paths that moved in the repository under an edit. */
  conflict?: string[];
  /** The repository, branch and folder it was read from: another one is read afresh. */
  key?: string;
}

const EMPTY: DraftState = { status: 'idle', files: [], edits: {} };
const drafts = new Map<string, DraftState>();
const watchers = new Set<() => void>();
const put = (id: string, change: (state: DraftState) => DraftState) => {
  drafts.set(id, change(drafts.get(id) ?? EMPTY));
  watchers.forEach((watcher) => watcher());
};
const watch = (watcher: () => void) => (watchers.add(watcher), () => void watchers.delete(watcher));

/** The files as they read now: as saved, with what was typed here over them. */
export const currentFiles = (state: DraftState): DraftFile[] => {
  const files = state.files.map((file) => (file.path in state.edits ? { ...file, text: state.edits[file.path] } : file));
  for (const [path, text] of Object.entries(state.edits)) if (!state.files.some((file) => file.path === path)) files.push({ path, text, sha: '' });
  return files;
};

async function loadDraft(project: Project, settings: Settings) {
  const link = project.project.overleaf;
  const target = draftTarget(link, settings);
  if (!link || !target) return;
  put(project.id, (state) => ({ ...state, status: 'loading', error: undefined }));
  try {
    const files = await readDraft(target, link);
    put(project.id, (state) => ({ ...state, status: 'ready', files, conflict: undefined }));
  } catch (error) {
    put(project.id, (state) => ({ ...state, status: 'error', error: error instanceof Error ? error.message : String(error) }));
  }
}

async function saveDraft(project: Project, settings: Settings) {
  const target = draftTarget(project.project.overleaf, settings);
  const state = drafts.get(project.id);
  if (!target || !state) return;
  const changed = currentFiles(state).filter((file) => file.path in state.edits && state.edits[file.path] !== state.files.find((f) => f.path === file.path)?.text);
  if (!changed.length) {
    put(project.id, (current) => ({ ...current, edits: {} }));
    return;
  }
  put(project.id, (current) => ({ ...current, saving: true, error: undefined }));
  const names = changed.map((file) => file.path.split('/').pop()).join(', ');
  try {
    const saved = await writeDraft(target, changed, `Edit ${names} from Reader`);
    put(project.id, (current) => {
      const files = current.files.filter((file) => !saved.some((s) => s.path === file.path)).concat(saved).sort((a, b) => a.path.localeCompare(b.path));
      const edits = { ...current.edits };
      // What was typed while it saved stays an edit.
      for (const file of saved) if (edits[file.path] === file.text) delete edits[file.path];
      return { ...current, files, edits, saving: false, savedAt: Date.now(), conflict: undefined };
    });
  } catch (error) {
    put(project.id, (current) => ({
      ...current,
      saving: false,
      conflict: error instanceof DraftConflict ? error.paths : undefined,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

/** The project's draft, read from its repository the first time it is asked for. */
function useDraft(project: Project | undefined) {
  const { settings } = useStore();
  const state = useSyncExternalStore(watch, () => (project ? drafts.get(project.id) ?? EMPTY : EMPTY));
  const target = draftTarget(project?.project.overleaf, settings);
  const repoKey = project?.project.overleaf ? `${project.project.overleaf.repo}#${project.project.overleaf.branch ?? ''}#${project.project.overleaf.folder ?? ''}` : '';
  useEffect(() => {
    if (!project || !target) return;
    const current = drafts.get(project.id);
    if (current && current.status !== 'idle' && current.key === repoKey) return;
    drafts.set(project.id, { ...EMPTY, key: repoKey });
    void loadDraft(project, settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, repoKey, Boolean(target)]);
  const files = useMemo(() => currentFiles(state), [state]);
  return {
    state,
    files,
    target,
    dirty: Object.keys(state.edits).length > 0,
    reload: () => project && void loadDraft(project, settings),
    /** What was typed here and not saved, dropped. */
    drop: () => project && put(project.id, (current) => ({ ...current, edits: {}, conflict: undefined, error: undefined })),
    save: () => project && void saveDraft(project, settings),
    edit: (path: string, text: string) => project && put(project.id, (current) => ({ ...current, edits: { ...current.edits, [path]: text } })),
  };
}

/** The paper's entry put in the bib file as an edit, unless the draft already has one for it. */
function addEntry(project: Project, files: DraftFile[], paper: Paper) {
  const entries = draftHealth(files, []).entries;
  if (entries.some((entry) => entry.key === keyFor(paper, entries))) return;
  const path = bibFileOf(files) ?? `${project.project.overleaf?.folder ? `${project.project.overleaf.folder}/` : ''}references.bib`;
  const text = files.find((file) => file.path === path)?.text ?? '';
  put(project.id, (current) => ({ ...current, edits: { ...current.edits, [path]: `${text.replace(/\s*$/, '')}${text.trim() ? '\n\n' : ''}${bibtexFor(paper, entries)}\n` } }));
}

// ---------------------------------------------------------- linking --

function updateLink(updateCollection: ReturnType<typeof useStore>['updateCollection'], project: Project, link: OverleafLink | undefined) {
  void updateCollection(project.id, (collection) => ({ project: { ...project.project, ...(collection.project ?? {}), overleaf: link } }));
}

/** The form that links a project to Overleaf, and its GitHub repository if it has one. */
function LinkForm({ project, onDone }: { project: Project; onDone: () => void }) {
  const { updateCollection, settings } = useStore();
  const link = project.project.overleaf;
  const [url, setUrl] = useState(link?.url ?? '');
  const [repo, setRepo] = useState(link?.repo ?? '');
  const [branch, setBranch] = useState(link?.branch ?? '');
  const [folder, setFolder] = useState(link?.folder ?? '');
  const parsed = parseOverleafUrl(url);
  const repoParsed = repo.trim() ? parseRepo(repo) : null;
  const bad = (url.trim() && !parsed) || (repo.trim() && !repoParsed);
  return (
    <form
      className="ol-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!parsed || bad) return;
        updateLink(updateCollection, project, {
          url: parsed,
          ...(repoParsed ? { repo: `${repoParsed.owner}/${repoParsed.repo}` } : {}),
          ...(repoParsed && branch.trim() ? { branch: branch.trim() } : {}),
          ...(repoParsed && folder.trim() ? { folder: folder.trim().replace(/^\/+|\/+$/g, '') } : {}),
        });
        onDone();
      }}
    >
      <label className="ol-field">
        <span>Overleaf project</span>
        <input autoFocus value={url} placeholder="https://www.overleaf.com/project/…" onChange={(event) => setUrl(event.target.value)} />
      </label>
      {url.trim() && !parsed ? <p className="ol-bad">That is not an Overleaf project’s address — copy it from the address bar with the project open.</p> : null}
      <details className="ol-more" open={Boolean(link?.repo)}>
        <summary>Also in GitHub? Edit and check the draft here</summary>
        <p className="pj-sub">
          If the project uses Overleaf’s GitHub sync (Menu → GitHub), name that repository: the paper’s .tex and .bib files are read and written there with the token from Settings → Git mirror
          {settings.githubToken.trim() ? '' : ' — none set yet'}, and Overleaf pulls the changes in from the same menu.
        </p>
        <label className="ol-field">
          <span>Repository</span>
          <input value={repo} placeholder="owner/repo" onChange={(event) => setRepo(event.target.value)} />
        </label>
        {repo.trim() && !repoParsed ? <p className="ol-bad">Name it as owner/repo, or paste its GitHub address.</p> : null}
        <div className="ol-pair">
          <label className="ol-field">
            <span>Branch</span>
            <input value={branch} placeholder="main" onChange={(event) => setBranch(event.target.value)} />
          </label>
          <label className="ol-field">
            <span>Folder</span>
            <input value={folder} placeholder="the top" onChange={(event) => setFolder(event.target.value)} />
          </label>
        </div>
      </details>
      <div className="pj-row">
        <button type="submit" className="btn primary sm" disabled={!parsed || Boolean(bad)}>
          {link ? 'Save' : 'Link'}
        </button>
        <button type="button" className="btn ghost sm" onClick={onDone}>
          Cancel
        </button>
        {link ? (
          <button
            type="button"
            className="btn ghost sm"
            style={{ marginLeft: 'auto' }}
            onClick={() => {
              updateLink(updateCollection, project, undefined);
              drafts.delete(project.id);
              onDone();
            }}
          >
            Unlink
          </button>
        ) : null}
      </div>
    </form>
  );
}

// ------------------------------------------------- the overview card --

const WHERE: Record<OverleafView, string> = {
  beside: 'Overleaf opens in a window beside the reader.',
  write: 'Write beside the project’s papers in the workspace.',
  dock: 'The draft is in the dock’s Draft tab, beside any paper you open.',
  overview: 'Overleaf opens in a tab.',
};

/** The paper on the project's overview: its link, where it is written, and what the draft makes of the project's papers. */
export function OverleafCard({ project, onWrite }: { project: Project; /** The workspace, on its Write layout. */ onWrite: () => void }) {
  const { papers, settings } = useStore();
  const view = overleafViewOf(settings);
  const link = project.project.overleaf;
  const [linking, setLinking] = useState(false);
  const draft = useDraft(project);
  const mine = useMemo(() => papersIn(project.id, papers), [project.id, papers]);
  const health = useMemo(() => (draft.files.length ? draftHealth(draft.files, mine) : null), [draft.files, mine]);
  const top = health?.headings.filter((heading) => heading.level <= Math.min(...health.headings.map((h) => h.level)) + 1).slice(0, 8) ?? [];
  const most = Math.max(1, ...top.map((heading) => heading.total));

  if (!link || linking) {
    return (
      <section className="pj-panel ol-card">
        <span className="eyebrow">The paper</span>
        {link ? null : <p className="pj-sub">Writing this up in Overleaf? Link the Overleaf project, and the paper is a click away from what you read and the code — {WHERE[view].charAt(0).toLowerCase() + WHERE[view].slice(1)}</p>}
        {linking ? (
          <LinkForm project={project} onDone={() => setLinking(false)} />
        ) : (
          <div className="pj-row">
            <button type="button" className="btn sm" onClick={() => setLinking(true)}>
              Link an Overleaf project
            </button>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="pj-panel ol-card">
      <div className="ol-head">
        <span className="eyebrow">The paper · Overleaf</span>
        <span style={{ flex: 1 }} />
        {draft.target ? <DraftStatus draft={draft} /> : null}
        <button type="button" className="link-btn" onClick={() => setLinking(true)}>
          Change
        </button>
      </div>
      <div className="ol-card-body">
        <div className="ol-card-main">
          <p className="pj-sub">{WHERE[view]}</p>
          <div className="pj-row" style={{ marginTop: 0 }}>
            {view === 'write' ? (
              <button type="button" className="btn primary sm" onClick={onWrite}>
                Write beside the papers
              </button>
            ) : null}
            <button type="button" className={`btn sm${view === 'write' ? '' : ' primary'}`} onClick={() => openOverleaf(link, project.id, view)}>
              <ExternalIcon size={13} /> {view === 'beside' ? 'Open Overleaf beside' : 'Open in Overleaf'}
            </button>
          </div>
          {!link.repo ? (
            <p className="ol-note">Overleaf can’t be read from another site, so this is only the link. If the project syncs with GitHub, add the repository (Change) to see its sections and citations here.</p>
          ) : !draft.target ? (
            <p className="ol-note">Add a GitHub token in Settings → Git mirror to read {link.repo} here.</p>
          ) : draft.state.status === 'error' && !draft.files.length ? (
            <p className="ol-bad">{draft.state.error}</p>
          ) : null}
        </div>
        {health ? (
          <>
            <div className="ol-sections">
              <span className="ol-label">
                Sections · {health.words.toLocaleString()} words
              </span>
              {top.length ? (
                top.map((heading) => (
                  <div key={`${heading.path}:${heading.line}`} className={`ol-sec${heading.level > top[0].level ? ' is-sub' : ''}`}>
                    <span className="ol-sec-title">{heading.title || '(untitled)'}</span>
                    <span className="ol-sec-bar">
                      <i style={{ width: `${Math.round((heading.total / most) * 100)}%` }} />
                    </span>
                    <span className="ol-sec-n">{heading.total.toLocaleString()}</span>
                  </div>
                ))
              ) : (
                <p className="pj-sub">No \section headings yet.</p>
              )}
            </div>
            <div className="ol-cites">
              <span className="ol-label">
                Papers ↔ draft · {health.cited.length} of {mine.length} cited
              </span>
              {health.readNotCited.length ? (
                <p className="ol-flag">
                  <b>Read, not cited:</b> {health.readNotCited.slice(0, 4).map((paper) => paper.title).join(' · ')}
                  {health.readNotCited.length > 4 ? ` · ${health.readNotCited.length - 4} more` : ''}
                </p>
              ) : null}
              {health.missing.length ? (
                <p className="ol-flag is-bad">
                  <b>No bib entry for</b> {health.missing.slice(0, 5).map((key) => `\\cite{${key}}`).join(', ')}
                  {health.missing.length > 5 ? ` and ${health.missing.length - 5} more` : ''}
                </p>
              ) : null}
              {!health.readNotCited.length && !health.missing.length ? <p className="ol-flag is-ok">Every paper you have read is cited, and every key has an entry.</p> : null}
            </div>
          </>
        ) : draft.state.status === 'loading' ? (
          <p className="pj-sub">Reading {link.repo}…</p>
        ) : null}
      </div>
    </section>
  );
}

function DraftStatus({ draft }: { draft: ReturnType<typeof useDraft> }) {
  const { state, dirty } = draft;
  const text = state.saving
    ? 'Saving…'
    : state.status === 'loading'
      ? 'Reading…'
      : dirty
        ? 'Not saved'
        : state.savedAt
          ? 'Saved to GitHub — pull it into Overleaf'
          : state.status === 'ready'
            ? 'Up to date'
            : '';
  return (
    <span className={`ol-status${dirty ? ' is-dirty' : ''}`} title={state.savedAt ? 'In Overleaf: Menu → GitHub → Pull GitHub changes into Overleaf' : undefined}>
      {text}
      {state.status !== 'loading' && !state.saving ? (
        <button type="button" className="link-btn" onClick={() => {
            if (dirty && !window.confirm('Reload the draft from GitHub? What you typed here and did not save is dropped.')) return;
            draft.drop();
            draft.reload();
          }}>
          Reload
        </button>
      ) : null}
    </span>
  );
}

// ------------------------------------------- cite keys, for beside --

/** The open paper's \cite key and BibTeX, to copy across to Overleaf. */
export function CiteButtons({ project, paper }: { project: Project; paper: Paper | undefined }) {
  const draft = useDraft(project);
  const [copied, setCopied] = useState<string | null>(null);
  const entries = useMemo(() => draftHealth(draft.files, []).entries, [draft.files]);
  if (!paper) return null;
  const key = keyFor(paper, entries);
  const say = (what: string) => {
    setCopied(what);
    window.setTimeout(() => setCopied((current) => (current === what ? null : current)), 1600);
  };
  return (
    <span className="ol-cite-btns">
      <button type="button" className="btn sm" title={`Copy \\cite{${key}}`} onClick={() => void copy(`\\cite{${key}}`).then((ok) => ok && say('cite'))}>
        {copied === 'cite' ? <CheckIcon size={12} /> : <CopyIcon size={12} />} \cite
      </button>
      <button type="button" className="btn sm" title="Copy its BibTeX entry" onClick={() => void copy(bibtexFor(paper, entries)).then((ok) => ok && say('bib'))}>
        {copied === 'bib' ? <CheckIcon size={12} /> : <CopyIcon size={12} />} BibTeX
      </button>
    </span>
  );
}

// ------------------------------------------------------- the editor --

/**
 * The draft's files, edited here and saved to the repository as one commit.
 * `paper` is the one being read beside it: what Cite and Quote put in.
 */
export function DraftEditor({ project, paper, compact = false }: { project: Project; paper: Paper | undefined; compact?: boolean }) {
  const { papers, settings } = useStore();
  const draft = useDraft(project);
  const link = project.project.overleaf;
  const editor = useRef<CodeEditorHandle>(null);
  const texFiles = draft.files.filter((file) => /\.(tex|bib)$/i.test(file.path));
  const pathKey = `reader.project.${project.id}.draftFile`;
  const [path, setPathState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(pathKey);
    } catch {
      return null;
    }
  });
  const shown = texFiles.find((file) => file.path === path) ?? texFiles.find((file) => file.path === mainFileOf(texFiles)) ?? texFiles[0];
  const setPath = (next: string) => {
    setPathState(next);
    try {
      localStorage.setItem(pathKey, next);
    } catch {
      // only a convenience
    }
  };
  const entries = useMemo(() => draftHealth(draft.files, []).entries, [draft.files]);
  const mine = papersIn(project.id, papers);
  const health = useMemo(() => (paper ? draftHealth(draft.files, [paper]) : null), [draft.files, paper]);
  const citedAt = health?.cited[0]?.at ?? [];
  const prefix = link?.folder ? `${link.folder}/` : '';
  const short = (full: string) => (full.startsWith(prefix) ? full.slice(prefix.length) : full);

  // The text typed is the editor's own, so the caret stays where it is; the shared draft follows it,
  // and what comes from elsewhere — a reload, a save, the dock — is taken in.
  const [text, setText] = useState(shown?.text ?? '');
  const pushed = useRef<string | null>(shown?.text ?? null);
  useEffect(() => {
    if (!shown || shown.text === pushed.current) return;
    pushed.current = shown.text;
    setText(shown.text);
  }, [shown?.path, shown?.text]);

  const cite = (target: Paper, how: 'cite' | 'citet' | 'quote', passage = '') => {
    const key = keyFor(target, entries);
    editor.current?.insert(how === 'quote' ? quoteOf(passage, key) : `\\${how}{${key}}`);
    addEntry(project, draft.files, target);
  };

  let body: ReactNode;
  if (!link) body = <p className="ol-empty">Link this project to Overleaf on its overview first.</p>;
  else if (!link.repo)
    body = (
      <div className="ol-empty">
        <p>Overleaf can’t be edited from another site. To write here, turn on Overleaf’s GitHub sync for the project and name the repository on the overview’s paper card — or write in Overleaf itself.</p>
        <button type="button" className="btn sm" onClick={() => openOverleaf(link, project.id, 'beside')}>
          <ExternalIcon size={13} /> Open Overleaf beside
        </button>
      </div>
    );
  else if (!draft.target) body = <p className="ol-empty">Add a GitHub token in Settings → Git mirror, with Contents read and write on {link.repo}, to edit the draft here.</p>;
  else if (draft.state.status === 'loading' && !draft.files.length) body = <p className="ol-empty">Reading {link.repo}…</p>;
  else if (draft.state.status === 'error' && !draft.files.length) body = <p className="ol-empty ol-bad">{draft.state.error}</p>;
  else if (!shown) body = <p className="ol-empty">No .tex or .bib files in {link.repo}{link.folder ? `/${link.folder}` : ''}.</p>;
  else
    body = (
      <CodeEditor
        key={shown.path}
        ref={editor}
        value={text}
        path={shown.path}
        fontSize={compact ? 12 : 13}
        minimap={!compact}
        onChange={(next) => {
          pushed.current = next;
          setText(next);
          draft.edit(shown.path, next);
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            draft.save();
          }
        }}
      />
    );

  return (
    <div className={`ol-editor${compact ? ' is-compact' : ''}`}>
      <div className="ol-editor-bar">
        {texFiles.length ? (
          <select value={shown?.path} onChange={(event) => setPath(event.target.value)} aria-label="File">
            {texFiles.map((file) => (
              <option key={file.path} value={file.path}>
                {short(file.path)}
                {file.path in draft.state.edits ? ' ●' : ''}
              </option>
            ))}
          </select>
        ) : (
          <span className="ol-editor-name">Draft</span>
        )}
        <span style={{ flex: 1 }} />
        {draft.target ? <DraftStatus draft={draft} /> : null}
        {draft.target ? (
          <button type="button" className="btn primary sm" disabled={!draft.dirty || draft.state.saving} onClick={draft.save} title="One commit to GitHub (⌘S)">
            Save
          </button>
        ) : null}
        {link ? (
          <button type="button" className="icon-btn" title="Open in Overleaf" aria-label="Open in Overleaf" onClick={() => openOverleaf(link, project.id, overleafViewOf(settings) === 'beside' ? 'beside' : 'overview')}>
            <ExternalIcon size={14} />
          </button>
        ) : null}
      </div>
      {draft.state.error && draft.files.length ? <p className="ol-banner">{draft.state.error}</p> : null}
      {draft.state.savedAt && !draft.dirty ? <p className="ol-banner is-ok">Saved to {link?.repo}. In Overleaf: Menu → GitHub → Pull GitHub changes into Overleaf.</p> : null}
      <div className="ol-editor-body">{body}</div>
      {shown && draft.target ? (
        <div className="ol-cite-bar">
          {paper ? (
            <>
              <span className="ol-cite-paper" title={paper.title}>
                {paper.title}
                <small>{citedAt.length ? ` · cited ${citedAt.map((at) => `${short(at.path)}:${at.line}`).join(', ')}` : ' · not cited yet'}</small>
              </span>
              <button type="button" className="btn sm" onClick={() => cite(paper, 'cite')} title="\cite it at the caret, and add its BibTeX if the draft has none">
                \cite
              </button>
              <button type="button" className="btn sm" onClick={() => cite(paper, 'citet')}>
                \citet
              </button>
              <button
                type="button"
                className="btn sm"
                title="Select a passage in the paper, then quote it at the caret"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const passage = window.getSelection()?.toString().trim() ?? '';
                  if (passage) cite(paper, 'quote', passage);
                  else window.alert('Select a passage in the paper first, then Quote puts it in the draft with its citation.');
                }}
              >
                Quote selection
              </button>
            </>
          ) : (
            <span className="pj-sub">Open a paper of the project to cite it.</span>
          )}
          {!compact && mine.length > 1 ? (
            <select
              className="ol-cite-other"
              value=""
              aria-label="Cite another paper of the project"
              onChange={(event) => {
                const other = mine.find((item) => item.id === event.target.value);
                if (other) cite(other, 'cite');
              }}
            >
              <option value="">Cite another…</option>
              {mine
                .filter((item) => item.id !== paper?.id)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
            </select>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------- the dock --

const DOCK_PROJECT = 'reader.draft.project';

/** Whether the dock has a Draft tab to show: the choice is the dock, and a project is linked to Overleaf. */
export function useDraftDock(): boolean {
  const { collections, settings } = useStore();
  return overleafViewOf(settings) === 'dock' && projectsOf(collections).some((project) => project.project.overleaf);
}

/** The Draft tab: the outline of a project's paper and its editor, beside the paper open on the page. */
export function DraftDock({ paperId }: { paperId: string }) {
  const { collections, papers } = useStore();
  const linked = projectsOf(collections).filter((project) => project.project.overleaf);
  const paper = papers.find((item) => item.id === paperId);
  const [picked, setPicked] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DOCK_PROJECT);
    } catch {
      return null;
    }
  });
  const project = linked.find((item) => paper?.collectionIds.includes(item.id) && item.id === picked) ?? linked.find((item) => paper?.collectionIds.includes(item.id)) ?? linked.find((item) => item.id === picked) ?? linked[0];
  const draft = useDraft(project);
  const health = useMemo(() => (draft.files.length ? draftHealth(draft.files, []) : null), [draft.files]);
  if (!project) return <p className="ol-empty">Link a project to Overleaf on its overview, and its draft is here.</p>;
  return (
    <div className="ol-dock">
      <div className="ol-dock-head">
        {linked.length > 1 ? (
          <select
            value={project.id}
            aria-label="Which project’s paper"
            onChange={(event) => {
              setPicked(event.target.value);
              try {
                localStorage.setItem(DOCK_PROJECT, event.target.value);
              } catch {
                // only a convenience
              }
            }}
          >
            {linked.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        ) : (
          <b>{project.name}</b>
        )}
        {health ? <span className="pj-sub">{health.words.toLocaleString()} words</span> : null}
      </div>
      {health?.headings.length ? (
        <div className="ol-dock-outline">
          {health.headings
            .filter((heading) => heading.level <= Math.min(...health.headings.map((h) => h.level)))
            .slice(0, 8)
            .map((heading) => (
              <span key={`${heading.path}:${heading.line}`}>
                {heading.title || '(untitled)'}
                <small>{heading.total.toLocaleString()}</small>
              </span>
            ))}
        </div>
      ) : null}
      <DraftEditor project={project} paper={paper} compact />
    </div>
  );
}
