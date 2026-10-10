// Project mode: the projects side by side (the board), one project's
// overview, and its workspace — a paper of the project beside the project's
// code. A switch at the top of every one of them goes between the three, and
// Settings says which of the last two a project opens on.
//
// A project is a collection with a project record (src/lib/projects.ts): its
// papers are the collection's, so adding one from a search is adding it to
// that collection, and a paper can be in several projects at once.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useStore } from '../lib/store';
import { createPlayground, loadPlaygrounds, usePlaygrounds, useServers } from '../lib/playground';
import { colabAvailable } from '../lib/colab';
import { hasProxy } from '../lib/api';

/** Asks the app to open Settings, from a page that has no handle on it. */
export const OPEN_SETTINGS = 'reader:open-settings';

/** Settings, at its Compute section. */
export function openComputeSettings() {
  window.dispatchEvent(new Event(OPEN_SETTINGS));
  window.setTimeout(() => document.getElementById('settings-compute')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 150);
}
import {
  ROLES,
  byRole,
  continueWith,
  initialsOf,
  lastActive,
  newProjectInfo,
  papersIn,
  plainCollections,
  projectsOf,
  readingState,
  roleLabel,
  sharedWith,
  toggledIn,
  whenSaid,
  withRole,
  type Project,
} from '../lib/projects';
import { authorLine } from '../lib/libraryLook';
import { COLLECTION_COLORS, type Paper, type PaperRef, type PaperRole, type ProjectInfo } from '../types';
import type { View } from '../types.view';
import Playground, { ComputeTag, WhereDialog } from './Playground';
import PaperWindow from './PaperWindow';
import Reader from './Reader';
import { CiteButtons, DraftEditor, OpenOverleaf, OverleafCard } from './Overleaf';
import { ComputeSwitch } from './Compute';
import { COLAB, computeId, isOn, serversOn, switchesOnCards } from '../lib/compute';
import { overleafViewOf } from '../lib/overleaf';
import { ArrowLeftIcon, CheckIcon, ChevronDownIcon, CloseIcon, CodeIcon, GridIcon, PlusIcon, TrashIcon } from './icons';

type ProjectPageView = Extract<View, { kind: 'projects' } | { kind: 'project' }>;

const year = (published: string) => (published ? new Date(published).getFullYear() || '' : '');
const newTodoId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/** The view a project opens on, from the rail or the board: the choice in Settings. */
export function projectView(id: string, opensOn: 'overview' | 'workspace'): View {
  return opensOn === 'workspace' ? { kind: 'project', id, mode: 'workspace' } : { kind: 'project', id };
}

// ------------------------------------------------------------- the page --

/** The project opened last on this device: where the switch goes from the board. */
const LAST_PROJECT = 'reader.project.last';
const NEW_PROJECT = 'reader.project.new';
/** Asks the Projects page to open with the new-project dialog; the caller then goes there. */
export function askForNewProject() {
  try {
    sessionStorage.setItem(NEW_PROJECT, '1');
  } catch {
    // the page opens without it
  }
  window.dispatchEvent(new Event(NEW_PROJECT));
}

export const lastProject = () => {
  try {
    return localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
};

export default function ProjectsPage({
  view,
  onView,
  onOpenPaper,
  onAddPapers,
}: {
  view: ProjectPageView;
  onView: (view: View) => void;
  onOpenPaper: (id: string) => void;
  /** Discover, open beside the page, saving to the project on show. */
  onAddPapers: () => void;
}) {
  const { collections, settings } = useStore();
  const projects = useMemo(() => projectsOf(collections), [collections]);
  // "New project…" from the rail's project menus: the page opens with the dialog up.
  const [creating, setCreating] = useState(() => {
    try {
      const asked = sessionStorage.getItem(NEW_PROJECT) === '1';
      sessionStorage.removeItem(NEW_PROJECT);
      return asked;
    } catch {
      return false;
    }
  });
  const project = view.kind === 'project' ? projects.find((item) => item.id === view.id) : undefined;
  const opensOn = settings.projectOpensOn;
  // Asked for while the page is already open: the page is not mounted afresh, so it is told.
  useEffect(() => {
    const ask = () => {
      try {
        sessionStorage.removeItem(NEW_PROJECT);
      } catch {
        // nothing kept
      }
      setCreating(true);
    };
    window.addEventListener(NEW_PROJECT, ask);
    return () => window.removeEventListener(NEW_PROJECT, ask);
  }, []);
  useEffect(() => {
    if (!project) return;
    try {
      localStorage.setItem(LAST_PROJECT, project.id);
    } catch {
      // only a convenience
    }
  }, [project]);

  const header = (
    <ProjectBar
      projects={projects}
      current={project}
      mode={view.kind === 'projects' ? 'board' : view.mode === 'workspace' ? 'workspace' : 'overview'}
      onView={onView}
      onNew={() => setCreating(true)}
    />
  );

  let body: ReactNode;
  if (view.kind === 'projects') {
    body = <ProjectBoard projects={projects} onEnter={(id, mode) => onView(mode ? { kind: 'project', id, ...(mode === 'workspace' ? { mode } : {}) } : projectView(id, opensOn))} onNew={() => setCreating(true)} />;
  } else if (!project) {
    body = (
      <div className="pj-scroll">
        <div className="pj-empty">
          <h1>No project here</h1>
          <p>It may have been deleted, or it was made by another account. Projects are kept with your library.</p>
          <button type="button" className="btn primary" onClick={() => onView({ kind: 'projects' })}>
            See your projects
          </button>
        </div>
      </div>
    );
  } else if (view.mode === 'workspace') {
    body = <ProjectWorkspace key={project.id} project={project} onView={onView} onOpenPaper={onOpenPaper} />;
  } else {
    body = <ProjectOverview key={project.id} project={project} projects={projects} onView={onView} onOpenPaper={onOpenPaper} onAddPapers={onAddPapers} />;
  }

  return (
    <main className={`main pj-page${view.kind === 'project' && view.mode === 'workspace' ? ' is-workspace' : ''}`}>
      {header}
      {body}
      {creating ? (
        <NewProjectDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            onView({ kind: 'project', id });
          }}
        />
      ) : null}
    </main>
  );
}

/** Across the top of every project page: which project, and which of the three views. */
function ProjectBar({
  projects,
  current,
  mode,
  onView,
  onNew,
}: {
  projects: Project[];
  current: Project | undefined;
  mode: 'board' | 'overview' | 'workspace';
  onView: (view: View) => void;
  onNew: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const pickRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!picking) return;
    const away = (event: PointerEvent) => {
      if (!pickRef.current?.contains(event.target as Node)) setPicking(false);
    };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [picking]);
  // The board has no project of its own: the switch takes the one opened last, else the first.
  const target = current ?? projects.find((project) => project.id === lastProject()) ?? projects[0];
  return (
    <div className="pj-bar">
      <div className="pj-which" ref={pickRef}>
        <button type="button" className="pj-which-btn" aria-expanded={picking} aria-haspopup="menu" onClick={() => setPicking(!picking)}>
          {current ? <span className="pj-mark sm" style={{ background: current.color }}>{initialsOf(current.name)}</span> : <GridIcon size={15} />}
          <span className="pj-which-name">{current ? current.name : 'All projects'}</span>
          <ChevronDownIcon size={13} />
        </button>
        {picking ? (
          <div className="pj-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => (setPicking(false), onView({ kind: 'projects' }))}>
              <GridIcon size={14} /> All projects
            </button>
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                role="menuitem"
                aria-current={project.id === current?.id ? 'true' : undefined}
                onClick={() => {
                  setPicking(false);
                  onView(mode === 'workspace' ? { kind: 'project', id: project.id, mode: 'workspace' } : { kind: 'project', id: project.id });
                }}
              >
                <span className="pj-dot" style={{ background: project.color }} />
                {project.name}
                {project.id === current?.id ? <CheckIcon size={12} /> : null}
              </button>
            ))}
            <button type="button" role="menuitem" className="pj-menu-new" onClick={() => (setPicking(false), onNew())}>
              <PlusIcon size={13} /> New project…
            </button>
          </div>
        ) : null}
      </div>
      <div className="segmented pj-views" role="group" aria-label="Project view">
        <button type="button" aria-pressed={mode === 'board'} onClick={() => onView({ kind: 'projects' })} title="Every project side by side">
          Board
        </button>
        <button type="button" aria-pressed={mode === 'overview'} disabled={!target} onClick={() => target && onView({ kind: 'project', id: target.id })} title="One project: what to read next, its papers, its code">
          Overview
        </button>
        <button type="button" aria-pressed={mode === 'workspace'} disabled={!target} onClick={() => target && onView({ kind: 'project', id: target.id, mode: 'workspace' })} title="A paper of the project beside its code">
          Workspace
        </button>
      </div>
      <div style={{ flex: 1 }} />
      <button type="button" className="btn sm" onClick={onNew}>
        <PlusIcon size={13} /> New project
      </button>
    </div>
  );
}

// ------------------------------------------------------------ the board --

function ProjectBoard({ projects, onEnter, onNew }: { projects: Project[]; onEnter: (id: string, mode?: 'overview' | 'workspace') => void; onNew: () => void }) {
  const { papers } = useStore();
  const playgrounds = usePlaygrounds();
  useEffect(() => {
    void loadPlaygrounds();
  }, []);
  const ordered = useMemo(() => projects.slice().sort((a, b) => lastActive(b, papers).localeCompare(lastActive(a, papers))), [projects, papers]);
  if (!projects.length) {
    return (
      <div className="pj-scroll">
        <div className="pj-empty">
          <span className="eyebrow">Projects</span>
          <h1>Keep each piece of research together</h1>
          <p>
            A project holds the papers one question needs — the ones it builds on, the baselines, the related work — with a to-do list and
            code of its own. Researchers usually have three or four going at once: add a paper from any search to whichever it belongs to, and
            read it beside the project’s code.
          </p>
          <button type="button" className="btn primary" onClick={onNew}>
            <PlusIcon size={14} /> Start a project
          </button>
        </div>
      </div>
    );
  }
  const count = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'][projects.length] ?? String(projects.length);
  return (
    <div className="pj-scroll">
      <div className="pj-hero">
        <span className="eyebrow">Projects</span>
        <h1>
          {count} {projects.length === 1 ? 'thing' : 'things'} on the go
        </h1>
      </div>
      <div className="pj-board">
        {ordered.map((project) => {
          const mine = papersIn(project.id, papers);
          const reading = continueWith(project, papers);
          const todos = project.project.todos.filter((todo) => !todo.done).slice(0, 3);
          const code = playgrounds.find((item) => item.id === project.project.playgroundId);
          const shared = sharedWith(project, projects, papers);
          return (
            <article key={project.id} className="pj-card" style={{ '--pj': project.color } as CSSProperties}>
              <div className="pj-card-top">
                <span className="eyebrow pj-tint">{whenSaid(lastActive(project, papers))}</span>
                <h2>{project.name}</h2>
                {project.project.question ? <p className="pj-question">{project.project.question}</p> : null}
                <p className="pj-counts">
                  <b>{mine.length}</b> {mine.length === 1 ? 'paper' : 'papers'}
                  <span>
                    <b>{project.project.todos.filter((todo) => !todo.done).length}</b> to do
                  </span>
                  {code ? (
                    <span className="pj-code-tag">
                      <CodeIcon size={12} /> {code.title}
                    </span>
                  ) : null}
                </p>
              </div>
              {reading ? (
                <div className="pj-card-part">
                  <span className="eyebrow">{readingState(reading) === 'reading' ? 'Reading' : 'Up next'}</span>
                  <span className="pj-paper-title">{reading.title}</span>
                  <span className="pj-bar-track">
                    <span style={{ width: `${Math.round(reading.progress * 100)}%` }} />
                  </span>
                </div>
              ) : null}
              {todos.length ? (
                <div className="pj-card-part">
                  <span className="eyebrow">Next up</span>
                  <ul className="pj-mini-todos">
                    {todos.map((todo) => (
                      <li key={todo.id}>{todo.text}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {shared.length ? (
                <div className="pj-card-part">
                  <span className="eyebrow">Shared with</span>
                  {shared.slice(0, 3).map((item) => (
                    <span key={item.project.id} className="pj-shared">
                      <span className="pj-dot" style={{ background: item.project.color }} /> {item.count} with {item.project.name}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="pj-card-actions">
                <button type="button" className="btn primary sm" onClick={() => onEnter(project.id, 'overview')}>
                  Overview
                </button>
                <button type="button" className="btn sm" onClick={() => onEnter(project.id, 'workspace')}>
                  <CodeIcon size={13} /> Workspace
                </button>
              </div>
            </article>
          );
        })}
        <button type="button" className="pj-card pj-card-new" onClick={onNew}>
          <PlusIcon size={18} />
          New project
          <span>Start empty, or turn a collection into one</span>
        </button>
      </div>
    </div>
  );
}

// --------------------------------------------------------- the overview --

function ProjectOverview({
  project,
  projects,
  onView,
  onOpenPaper,
  onAddPapers,
}: {
  project: Project;
  projects: Project[];
  onView: (view: View) => void;
  onOpenPaper: (id: string) => void;
  onAddPapers: () => void;
}) {
  const { papers, highlights, updateCollection, setPaperCollections, renameCollection, deleteCollection } = useStore();
  const info = project.project;
  const groups = byRole(project, papers);
  const reading = continueWith(project, papers);
  const shared = sharedWith(project, projects, papers);
  const highlightCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const highlight of highlights) counts.set(highlight.paperId, (counts.get(highlight.paperId) ?? 0) + 1);
    return counts;
  }, [highlights]);
  const setInfo = (change: (info: ProjectInfo) => ProjectInfo) => void updateCollection(project.id, (collection) => ({ project: change({ ...info, ...(collection.project ?? {}) }) }));
  const [editingQuestion, setEditingQuestion] = useState(false);
  const [question, setQuestion] = useState(info.question);
  const [todo, setTodo] = useState('');
  const [managing, setManaging] = useState(false);
  const mine = papersIn(project.id, papers);

  return (
    <div className="pj-scroll" style={{ '--pj': project.color } as CSSProperties}>
      <div className="pj-hero pj-hero-row">
        <div style={{ minWidth: 0 }}>
          <span className="eyebrow pj-tint">Project · since {new Date(info.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
          <h1>{project.name}</h1>
          {editingQuestion ? (
            <form
              className="pj-question-edit"
              onSubmit={(event) => {
                event.preventDefault();
                setInfo((current) => ({ ...current, question: question.trim() }));
                setEditingQuestion(false);
              }}
            >
              <input autoFocus value={question} placeholder="The question this project is asking" onChange={(event) => setQuestion(event.target.value)} />
              <button type="submit" className="btn primary sm">
                Save
              </button>
              <button type="button" className="btn ghost sm" onClick={() => (setQuestion(info.question), setEditingQuestion(false))}>
                Cancel
              </button>
            </form>
          ) : (
            <button type="button" className="pj-question pj-question-btn" onClick={() => setEditingQuestion(true)} title="Change the question">
              {info.question || 'Add the question this project is asking…'}
            </button>
          )}
        </div>
        <div className="pj-hero-actions">
          <button type="button" className="btn" onClick={onAddPapers} title="Search the indexes; what you add goes into this project">
            <PlusIcon size={14} /> Add papers
          </button>
          <button type="button" className="btn primary" onClick={() => onView({ kind: 'project', id: project.id, mode: 'workspace' })}>
            Open workspace →
          </button>
        </div>
      </div>

      <div className="pj-top">
        <section className="pj-panel pj-continue">
          {reading ? (
            <>
              <span className="eyebrow">{readingState(reading) === 'reading' ? `Continue reading · ${Math.round(reading.progress * 100)}%` : 'Up next'}</span>
              <h3>{reading.title}</h3>
              <p className="pj-sub">
                {authorLine(reading.authors, 3)}
                {reading.published ? ` · ${year(reading.published)}` : ''}
              </p>
              <span className="pj-bar-track">
                <span style={{ width: `${Math.round(reading.progress * 100)}%` }} />
              </span>
              <div className="pj-row">
                <button type="button" className="btn primary sm" onClick={() => onOpenPaper(reading.id)}>
                  {readingState(reading) === 'reading' ? 'Resume' : 'Start reading'}
                </button>
                <button type="button" className="btn sm" onClick={() => (rememberWorkspacePaper(project.id, reading.id), onView({ kind: 'project', id: project.id, mode: 'workspace' }))}>
                  Beside the code
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="eyebrow">Nothing to read yet</span>
              <p className="pj-sub">Add the papers this project needs: search from Discover, or from Home, and pick this project in “Add to”.</p>
              <div className="pj-row">
                <button type="button" className="btn primary sm" onClick={onAddPapers}>
                  <PlusIcon size={13} /> Add papers
                </button>
              </div>
            </>
          )}
        </section>
        <CodeCard project={project} onView={onView} />
        <section className="pj-panel">
          <span className="eyebrow">Next up</span>
          <ul className="pj-todos">
            {info.todos.map((item) => (
              <li key={item.id} className={item.done ? 'is-done' : undefined}>
                <label>
                  <input type="checkbox" checked={item.done} onChange={() => setInfo((current) => ({ ...current, todos: current.todos.map((t) => (t.id === item.id ? { ...t, done: !t.done } : t)) }))} />
                  <span>{item.text}</span>
                </label>
                <button type="button" className="icon-btn pj-x" aria-label={`Remove “${item.text}”`} onClick={() => setInfo((current) => ({ ...current, todos: current.todos.filter((t) => t.id !== item.id) }))}>
                  <CloseIcon size={12} />
                </button>
              </li>
            ))}
          </ul>
          <form
            className="pj-todo-add"
            onSubmit={(event) => {
              event.preventDefault();
              const text = todo.trim();
              if (!text) return;
              setInfo((current) => ({ ...current, todos: [...current.todos, { id: newTodoId(), text, done: false }] }));
              setTodo('');
            }}
          >
            <input value={todo} placeholder="Add a step — “replicate Table 2”" onChange={(event) => setTodo(event.target.value)} />
          </form>
        </section>
      </div>

      <div className="pj-paper-row">
        <OverleafCard
          project={project}
          onWrite={() => {
            writeWs(WS_LAYOUT, 'write');
            onView({ kind: 'project', id: project.id, mode: 'workspace' });
          }}
        />
      </div>

      <div className="pj-section-head">
        <span className="eyebrow">Papers in this project · {mine.length}</span>
        <span className="pj-hint">Give each a role: what the project builds on, measures against, borrows, or cites.</span>
      </div>
      {groups.length ? (
        groups.map((group) => (
          <div key={group.label} className="pj-group">
            <h4 className="pj-group-head">{group.label}</h4>
            <div className="pj-papers">
              {group.papers.map((paper) => (
                <PaperCard
                  key={paper.id}
                  paper={paper}
                  role={info.roles[paper.id]}
                  highlights={highlightCount.get(paper.id) ?? 0}
                  others={projects.filter((other) => other.id !== project.id && paper.collectionIds.includes(other.id))}
                  onOpen={() => onOpenPaper(paper.id)}
                  onBeside={() => (rememberWorkspacePaper(project.id, paper.id), onView({ kind: 'project', id: project.id, mode: 'workspace' }))}
                  onRole={(role) => setInfo((current) => withRole(current, paper.id, role))}
                  onRemove={() => {
                    void setPaperCollections(paper.id, toggledIn(paper.collectionIds, project.id, false));
                    setInfo((current) => withRole(current, paper.id, null));
                  }}
                />
              ))}
            </div>
          </div>
        ))
      ) : (
        <p className="pj-none">No papers yet.</p>
      )}

      {shared.length ? (
        <div className="pj-shared-row">
          <span className="eyebrow">Shared with other projects</span>
          {shared.map((item) => (
            <button key={item.project.id} type="button" className="pj-chip" onClick={() => onView({ kind: 'project', id: item.project.id })}>
              <span className="pj-dot" style={{ background: item.project.color }} /> {item.count} with {item.project.name}
            </button>
          ))}
        </div>
      ) : null}

      <div className="pj-manage">
        <button type="button" className="link-btn" onClick={() => setManaging(!managing)} aria-expanded={managing}>
          Project settings
        </button>
        {managing ? (
          <div className="pj-manage-body">
            <label className="pj-field-row">
              <span>Name</span>
              <input defaultValue={project.name} onBlur={(event) => event.target.value.trim() && event.target.value !== project.name && void renameCollection(project.id, event.target.value)} />
            </label>
            <div className="pj-field-row">
              <span>Colour</span>
              <Swatches value={project.color} onPick={(color) => void updateCollection(project.id, { color })} />
            </div>
            <div className="pj-row">
              <button
                type="button"
                className="btn sm"
                title="Its papers stay in the collection; the question, roles and to-dos go"
                onClick={() => {
                  if (!window.confirm(`Turn “${project.name}” back into a plain collection? Its papers stay; its question, roles and to-do list are dropped.`)) return;
                  void updateCollection(project.id, { project: undefined });
                  onView({ kind: 'collection', id: project.id });
                }}
              >
                Turn back into a collection
              </button>
              <button
                type="button"
                className="btn sm danger"
                onClick={() => {
                  if (!window.confirm(`Delete the project “${project.name}”? Its papers stay in your library and in their other collections.`)) return;
                  void deleteCollection(project.id);
                  onView({ kind: 'projects' });
                }}
              >
                <TrashIcon size={13} /> Delete project
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PaperCard({
  paper,
  role,
  highlights,
  others,
  onOpen,
  onBeside,
  onRole,
  onRemove,
}: {
  paper: Paper;
  role: PaperRole | undefined;
  highlights: number;
  others: Project[];
  onOpen: () => void;
  onBeside: () => void;
  onRole: (role: PaperRole | null) => void;
  onRemove: () => void;
}) {
  const state = readingState(paper);
  return (
    <article className="pj-paper">
      <div className="pj-paper-head">
        <select className="pj-role" value={role ?? ''} onChange={(event) => onRole((event.target.value || null) as PaperRole | null)} aria-label="Role in this project">
          <option value="">Unsorted</option>
          {ROLES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <span className={`pj-state is-${state.replace(' ', '-')}`}>{state === 'reading' ? `${Math.round(paper.progress * 100)}%` : state}</span>
        <button type="button" className="icon-btn pj-x" aria-label="Take it out of this project" title="Take it out of this project (it stays in your library)" onClick={onRemove}>
          <CloseIcon size={12} />
        </button>
      </div>
      <button type="button" className="pj-paper-title-btn" onClick={onOpen}>
        {paper.title}
      </button>
      <span className="pj-sub">
        {authorLine(paper.authors, 2)}
        {paper.published ? ` · ${year(paper.published)}` : ''}
      </span>
      <div className="pj-paper-foot">
        {highlights ? <span className="pj-chip static">{highlights} highlights</span> : null}
        {others.map((other) => (
          <span key={other.id} className="pj-chip static" title={`Also in ${other.name}`}>
            <span className="pj-dot" style={{ background: other.color }} />
            {initialsOf(other.name)}
          </span>
        ))}
        <button type="button" className="link-btn pj-beside" onClick={onBeside}>
          Beside the code
        </button>
      </div>
    </article>
  );
}

/** The project's code: the playground that holds it, or the ways to give it one. */
function CodeCard({ project, onView }: { project: Project; onView: (view: View) => void }) {
  const playgrounds = usePlaygrounds();
  useEffect(() => {
    void loadPlaygrounds();
  }, []);
  const code = playgrounds.find((item) => item.id === project.project.playgroundId);
  return (
    <section className="pj-panel">
      <span className="eyebrow">Code</span>
      {code ? (
        <>
          <h3 className="pj-code-title">
            <CodeIcon size={15} /> {code.title}
          </h3>
          <p className="pj-sub">
            <ComputeTag compute={code.compute} home={code.home} /> · changed {whenSaid(new Date(code.updated).toISOString())}
          </p>
          <div className="pj-row">
            <button type="button" className="btn primary sm" onClick={() => onView({ kind: 'project', id: project.id, mode: 'workspace' })}>
              Open beside the papers
            </button>
            <button type="button" className="btn sm" onClick={() => onView({ kind: 'playground', id: code.id })}>
              Full screen
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="pj-sub">No code yet. Give the project a folder of files, an editor and a console — on Colab, this computer or a GPU elsewhere.</p>
          <div className="pj-row">
            <button type="button" className="btn primary sm" onClick={() => onView({ kind: 'project', id: project.id, mode: 'workspace' })}>
              Set up code
            </button>
          </div>
        </>
      )}
    </section>
  );
}

// -------------------------------------------------------- the workspace --

const WS_PAPER = (id: string) => `reader.project.${id}.paper`;
const WS_LAYOUT = 'reader.project.layout';
const WS_SPLIT = 'reader.project.split';
const WS_TREE = 'reader.project.tree';
/** Write: the paper being read beside the draft, when Settings puts the writing in the workspace. */
type WsLayout = 'paper' | 'both' | 'code' | 'write';

function rememberWorkspacePaper(projectId: string, paperId: string) {
  try {
    localStorage.setItem(WS_PAPER(projectId), paperId);
  } catch {
    // only a convenience
  }
}

function writeWs(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // only a convenience
  }
}

function readWs<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

function ProjectWorkspace({ project, onView, onOpenPaper }: { project: Project; onView: (view: View) => void; onOpenPaper: (id: string) => void }) {
  const { papers, highlights, updateCollection, settings } = useStore();
  const mine = papersIn(project.id, papers);
  const writing = overleafViewOf(settings);
  const overleaf = project.project.overleaf;
  const [paperId, setPaperId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(WS_PAPER(project.id));
    } catch {
      return null;
    }
  });
  const shown = mine.find((paper) => paper.id === paperId) ?? continueWith(project, papers) ?? mine[0];
  // Full code is where a project's work is done: the papers are a strip above it, a card each, and a window over it.
  const [chosenLayout, setLayoutState] = useState<WsLayout>(() => readWs(WS_LAYOUT, ['paper', 'both', 'code', 'write'] as const, 'code'));
  // Write is there only while Settings puts the writing in the workspace.
  const layout: WsLayout = chosenLayout === 'write' && writing !== 'write' ? 'both' : chosenLayout;
  const [floating, setFloating] = useState<string | null>(null);
  const setLayout = (next: WsLayout) => {
    setLayoutState(next);
    if (next !== 'code') setFloating(null);
    try {
      localStorage.setItem(WS_LAYOUT, next);
    } catch {
      // only a convenience
    }
  };
  const [treeOpen, setTreeOpenState] = useState(() => readWs(WS_TREE, ['open', 'shut'] as const, 'open') === 'open');
  const setTreeOpen = (open: boolean) => {
    setTreeOpenState(open);
    try {
      localStorage.setItem(WS_TREE, open ? 'open' : 'shut');
    } catch {
      // only a convenience
    }
  };
  // How much of the room the paper takes beside the code, dragged at the line between them.
  const [split, setSplit] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(WS_SPLIT));
      return saved > 0.2 && saved < 0.8 ? saved : 0.4;
    } catch {
      return 0.4;
    }
  });
  const panes = useRef<HTMLDivElement>(null);
  const drag = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = panes.current?.getBoundingClientRect();
    if (!box) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    let last = split;
    const move = (e: PointerEvent) => {
      last = Math.min(0.78, Math.max(0.22, (e.clientX - box.left) / box.width));
      setSplit(last);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      try {
        localStorage.setItem(WS_SPLIT, String(last));
      } catch {
        // only a convenience
      }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  };
  const [selectedHighlight, setSelectedHighlight] = useState<string | null>(null);
  const playgrounds = usePlaygrounds();
  useEffect(() => {
    void loadPlaygrounds();
  }, []);
  const codeId = project.project.playgroundId;
  const code = playgrounds.find((item) => item.id === codeId);
  const pick = (id: string) => {
    setPaperId(id);
    rememberWorkspacePaper(project.id, id);
  };
  const floatPaper = mine.find((paper) => paper.id === floating);
  const link = (id: string | undefined) => void updateCollection(project.id, (collection) => ({ project: { ...project.project, ...(collection.project ?? {}), playgroundId: id } }));
  const showPaper = layout !== 'code';
  const showWrite = layout === 'write';
  const showCode = layout === 'both' || layout === 'code';
  const fullCode = layout === 'code';

  return (
    <div className="pj-ws" style={{ '--pj': project.color } as CSSProperties}>
      <div className="pj-ws-bar">
        {fullCode ? null : (
          <button type="button" className="icon-btn" aria-pressed={treeOpen} aria-label="The project’s papers" title="The project’s papers" onClick={() => setTreeOpen(!treeOpen)}>
            <ArrowLeftIcon size={15} style={{ transform: treeOpen ? undefined : 'rotate(180deg)' }} />
          </button>
        )}
        <div className="segmented sm" role="group" aria-label="What the workspace shows">
          <button type="button" aria-pressed={layout === 'code'} onClick={() => setLayout('code')} title="The code fills the workspace; the papers are a strip above it">
            Full code
          </button>
          <button type="button" className="pj-both" aria-pressed={layout === 'both'} onClick={() => setLayout('both')} title="A paper and the code side by side">
            Side by side
          </button>
          <button type="button" aria-pressed={layout === 'paper'} onClick={() => setLayout('paper')} title="Just the paper">
            Paper
          </button>
          {writing === 'write' ? (
            <button type="button" aria-pressed={layout === 'write'} onClick={() => setLayout('write')} title="The paper beside the draft you are writing">
              Write
            </button>
          ) : null}
        </div>
        {!fullCode && shown ? <span className="pj-ws-now">{shown.title}</span> : null}
        {writing === 'beside' && overleaf && !fullCode ? (
          <span className="pj-ws-overleaf">
            <CiteButtons project={project} paper={shown} />
            <OpenOverleaf project={project} view="beside" primary={false} compact />
          </span>
        ) : null}
      {fullCode ? (
        <PaperStrip
          project={project}
          papers={mine}
          floating={floating}
          onFloat={(id) => (pick(id), setFloating(id))}
          onBeside={(id) => (pick(id), setLayout('both'))}
          onOpenPaper={onOpenPaper}
          onAdd={() => onView({ kind: 'project', id: project.id })}
        />
      ) : null}
      </div>
      <div className="pj-ws-body">
        {treeOpen && !fullCode ? (
          <aside className="pj-tree" aria-label="The project">
            <div className="pj-tree-head">
              <span className="pj-dot" style={{ background: project.color }} />
              {project.name}
            </div>
            <span className="pj-tree-sect">Papers · {mine.length}</span>
            {byRole(project, papers).map((group) => (
              <div key={group.label}>
                <span className="pj-tree-role">{group.label}</span>
                {group.papers.map((paper) => (
                  <button key={paper.id} type="button" className={`pj-tree-item${shown?.id === paper.id ? ' is-on' : ''}`} onClick={() => pick(paper.id)} title={paper.title}>
                    <span className="pj-tree-title">{paper.title}</span>
                    <span className="pj-tree-meta">
                      {readingState(paper) === 'reading' ? `${Math.round(paper.progress * 100)}%` : readingState(paper) === 'done' ? '✓' : ''}
                      {highlights.some((h) => h.paperId === paper.id) ? ` · ${highlights.filter((h) => h.paperId === paper.id).length}✎` : ''}
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {!mine.length ? <p className="pj-tree-none">No papers yet — add some from the overview.</p> : null}
            <span className="pj-tree-sect">Code</span>
            {code ? (
              <div className="pj-tree-code">
                <span className="pj-tree-item is-static">
                  <CodeIcon size={12} /> {code.title}
                </span>
                <button type="button" className="link-btn" onClick={() => link(undefined)}>
                  Unlink
                </button>
              </div>
            ) : (
              <p className="pj-tree-none">Not set up yet.</p>
            )}
            <span className="pj-tree-sect">Next up</span>
            {project.project.todos.filter((todo) => !todo.done).slice(0, 5).map((todo) => (
              <span key={todo.id} className="pj-tree-todo">
                ☐ {todo.text}
              </span>
            ))}
            {!project.project.todos.some((todo) => !todo.done) ? <p className="pj-tree-none">Nothing — add steps in the overview.</p> : null}
          </aside>
        ) : null}
        <div className="pj-ws-panes" ref={panes}>
        {showPaper ? (
          <div className="pj-ws-pane pj-ws-paper" style={showCode || showWrite ? { flex: `0 0 ${split * 100}%` } : undefined}>
            {shown ? (
              <Reader
                key={shown.id}
                paperId={shown.id}
                notesOpen={false}
                selectedHighlightId={selectedHighlight}
                onBack={() => onView({ kind: 'project', id: project.id })}
                onHome={() => onView({ kind: 'home' })}
                onToggleNotes={() => onOpenPaper(shown.id)}
                onNotes={() => undefined}
                onToggleSidebar={() => setTreeOpen(!treeOpen)}
                zen={false}
                onToggleZen={() => onOpenPaper(shown.id)}
                onSelectHighlight={setSelectedHighlight}
                onOrphans={() => undefined}
              />
            ) : (
              <div className="pj-ws-empty">
                <p>This project has no papers yet.</p>
                <button type="button" className="btn sm" onClick={() => onView({ kind: 'project', id: project.id })}>
                  Go to the overview to add some
                </button>
              </div>
            )}
          </div>
        ) : null}
        {showPaper && (showCode || showWrite) ? (
          <div
            className="pj-ws-split"
            role="separator"
            aria-orientation="vertical"
            aria-label="Drag to share the room between the paper and the code"
            tabIndex={0}
            onPointerDown={drag}
            onKeyDown={(event) => {
              const step = event.key === 'ArrowLeft' ? -0.04 : event.key === 'ArrowRight' ? 0.04 : 0;
              if (step) setSplit((current) => Math.min(0.78, Math.max(0.22, current + step)));
            }}
          />
        ) : null}
        {showWrite ? (
          <div className="pj-ws-pane pj-ws-code">
            <DraftEditor project={project} paper={shown} />
          </div>
        ) : null}
        {showCode ? (
          <div className="pj-ws-pane pj-ws-code">
            {code ? (
              <Playground id={code.id} onOpen={(id) => onView(id ? { kind: 'playground', id } : { kind: 'playground' })} onOpenPaper={onOpenPaper} />
            ) : (
              <SetUpCode project={project} papers={mine} missing={Boolean(codeId && !code)} onLinked={link} onView={onView} />
            )}
          </div>
        ) : null}
        </div>
      </div>
      {fullCode && floatPaper ? (
        <PaperWindow
          paper={floatPaper}
          papers={mine}
          onPick={(id) => (pick(id), setFloating(id))}
          onDock={() => (pick(floatPaper.id), setLayout('both'))}
          onOpenFull={() => onOpenPaper(floatPaper.id)}
          onClose={() => setFloating(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Above the code in full-code mode: the project's papers, one chip each in
 * the colour of its role. A chip opens the paper's card — what it is, how far
 * in you are, its abstract and what you highlighted in it — which is most of
 * what the code needs from a paper, and is there even when its PDF cannot be
 * fetched. From the card the paper floats over the code, goes beside it, or
 * opens on its own page.
 */
function PaperStrip({
  project,
  papers,
  floating,
  onFloat,
  onBeside,
  onOpenPaper,
  onAdd,
}: {
  project: Project;
  papers: Paper[];
  floating: string | null;
  onFloat: (id: string) => void;
  onBeside: (id: string) => void;
  onOpenPaper: (id: string) => void;
  onAdd: () => void;
}) {
  const { highlights } = useStore();
  const [card, setCard] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!card && !finding) return;
    const away = (event: PointerEvent) => {
      if (!strip.current?.contains(event.target as Node)) (setCard(null), setFinding(false));
    };
    const esc = (event: KeyboardEvent) => event.key === 'Escape' && (setCard(null), setFinding(false));
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [card, finding]);
  const roleOrder = (paper: Paper) => {
    const at = ROLES.findIndex((role) => role.id === project.project.roles[paper.id]);
    return at < 0 ? ROLES.length : at;
  };
  // The papers opened most recently, newest first, then the core ones not yet opened; the rest are one search away under "All N".
  const recent = (paper: Paper) => paper.lastOpenedAt ?? '';
  const ordered = papers
    .slice()
    .sort((a, b) => recent(b).localeCompare(recent(a)) || roleOrder(a) - roleOrder(b))
    .slice(0, STRIP_MAX);
  if (floating && !ordered.some((paper) => paper.id === floating)) {
    const extra = papers.find((paper) => paper.id === floating);
    if (extra) ordered.push(extra);
  }
  const open = papers.find((paper) => paper.id === card);
  const todo = project.project.todos.find((item) => !item.done);
  return (
    <div className="pj-strip" ref={strip}>
      <span className="pj-strip-label" title="The papers opened most recently">Recent</span>
      <div className="pj-strip-chips">
        {ordered.map((paper) => {
          const role = project.project.roles[paper.id];
          const state = readingState(paper);
          return (
            <button
              key={paper.id}
              type="button"
              className={`pj-strip-chip role-${role ?? 'none'}${card === paper.id ? ' is-open' : ''}${floating === paper.id ? ' is-floating' : ''}`}
              aria-expanded={card === paper.id}
              title={`${roleLabel(role)} · ${paper.title}`}
              onClick={() => setCard(card === paper.id ? null : paper.id)}
            >
              <span className="pj-strip-role">{roleLabel(role).slice(0, 1)}</span>
              <span className="pj-strip-title">{shortTitle(paper.title)}</span>
              {state === 'reading' ? <span className="pj-strip-pct">{Math.round(paper.progress * 100)}%</span> : state === 'done' ? <CheckIcon size={11} /> : null}
            </button>
          );
        })}
        {!papers.length ? (
          <button type="button" className="link-btn" onClick={onAdd}>
            No papers yet — add some
          </button>
        ) : null}
      </div>
      {papers.length ? (
        <button type="button" className={`pj-strip-all${finding ? ' is-open' : ''}`} aria-expanded={finding} onClick={() => (setCard(null), setFinding(!finding))} title="Every paper in the project, searchable">
          All {papers.length} <ChevronDownIcon size={12} />
        </button>
      ) : null}
      {todo ? (
        <span className="pj-strip-todo" title="Next on the project’s to-do list">
          Next: {todo.text}
        </span>
      ) : null}
      {finding ? (
        <PaperFinder
          project={project}
          papers={papers}
          query={query}
          onQuery={setQuery}
          marks={highlights}
          onPick={(id) => (setFinding(false), setCard(id))}
        />
      ) : null}
      {open ? (
        <PaperCardPop
          paper={open}
          role={project.project.roles[open.id]}
          marks={highlights.filter((item) => item.paperId === open.id && !item.orphaned)}
          floating={floating === open.id}
          onFloat={() => (onFloat(open.id), setCard(null))}
          onBeside={() => onBeside(open.id)}
          onOpen={() => onOpenPaper(open.id)}
        />
      ) : null}
    </div>
  );
}

/** How many papers the strip shows before the rest go behind "All N". */
const STRIP_MAX = 6;

/**
 * Every paper in the project, behind "All N" on the strip: searched by title,
 * author, abstract and what you highlighted or noted in it, and grouped by role.
 */
function PaperFinder({
  project,
  papers,
  query,
  onQuery,
  marks,
  onPick,
}: {
  project: Project;
  papers: Paper[];
  query: string;
  onQuery: (query: string) => void;
  marks: { paperId: string; exact: string; note?: string }[];
  onPick: (id: string) => void;
}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (paper: Paper) => {
    if (!words.length) return { ok: true, why: '' };
    const own = `${paper.title} ${paper.authors.join(' ')} ${paper.abstract}`.toLowerCase();
    const kept = marks.filter((mark) => mark.paperId === paper.id);
    const keptText = kept.map((mark) => `${mark.exact} ${mark.note ?? ''}`).join(' ').toLowerCase();
    const ok = words.every((word) => own.includes(word) || keptText.includes(word));
    const hit = ok && !words.every((word) => own.includes(word)) ? kept.find((mark) => words.some((word) => `${mark.exact} ${mark.note ?? ''}`.toLowerCase().includes(word))) : undefined;
    return { ok, why: hit ? `“${(hit.note || hit.exact).slice(0, 90)}${(hit.note || hit.exact).length > 90 ? '…' : ''}”` : '' };
  };
  const groups = byRole(project, papers)
    .map((group) => ({ ...group, rows: group.papers.map((paper) => ({ paper, ...matches(paper) })).filter((row) => row.ok) }))
    .filter((group) => group.rows.length);
  const first = groups[0]?.rows[0]?.paper;
  return (
    <div className="pj-pop pj-find" role="dialog" aria-label="The project’s papers">
      <input
        autoFocus
        className="pj-find-input"
        value={query}
        placeholder={`Search ${papers.length} papers — titles, authors, abstracts, your highlights and notes`}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && first) onPick(first.id);
        }}
      />
      <div className="pj-pop-body">
        {groups.map((group) => (
          <div key={group.label}>
            <span className="pj-find-role">
              {group.label} · {group.rows.length}
            </span>
            {group.rows.map(({ paper, why }) => {
              const state = readingState(paper);
              const count = marks.filter((mark) => mark.paperId === paper.id).length;
              return (
                <button key={paper.id} type="button" className="pj-find-row" onClick={() => onPick(paper.id)}>
                  <span className="pj-find-title">{paper.title}</span>
                  <span className="pj-find-meta">
                    {authorLine(paper.authors, 1)}
                    {paper.published ? ` · ${year(paper.published)}` : ''}
                    {state === 'reading' ? ` · ${Math.round(paper.progress * 100)}%` : state === 'done' ? ' · read' : ''}
                    {count ? ` · ${count} highlights` : ''}
                  </span>
                  {why ? <span className="pj-find-why">{why}</span> : null}
                </button>
              );
            })}
          </div>
        ))}
        {!groups.length ? <p className="pj-sub">Nothing in this project matches “{query}”.</p> : null}
      </div>
    </div>
  );
}

/** A paper's title cut to what fits a chip: up to its colon, else its first words. */
const shortTitle = (title: string) => {
  const head = title.split(/:\s/)[0];
  return head.length <= 34 ? head : `${head.slice(0, 32).replace(/\s+\S*$/, '')}…`;
};

function PaperCardPop({
  paper,
  role,
  marks,
  floating,
  onFloat,
  onBeside,
  onOpen,
}: {
  paper: Paper;
  role: PaperRole | undefined;
  marks: { id: string; exact: string; note?: string; color: string; section?: string }[];
  floating: boolean;
  onFloat: () => void;
  onBeside: () => void;
  onOpen: () => void;
}) {
  const state = readingState(paper);
  return (
    <div className="pj-pop" role="dialog" aria-label={paper.title}>
      <span className="eyebrow pj-tint">
        {roleLabel(role)} · {state === 'reading' ? `${Math.round(paper.progress * 100)}% read` : state}
      </span>
      <h3>{paper.title}</h3>
      <p className="pj-sub">
        {authorLine(paper.authors, 4)}
        {paper.published ? ` · ${year(paper.published)}` : ''}
        {paper.venue ? ` · ${paper.venue}` : ''}
        {paper.arxivId ? ` · arXiv:${paper.arxivId}` : ''}
      </p>
      <div className="pj-pop-body">
        {paper.abstract ? <p className="pj-pop-abstract">{paper.abstract}</p> : null}
        {marks.length ? (
          <>
            <span className="eyebrow">Your highlights · {marks.length}</span>
            <ul className="pj-pop-marks">
              {marks.slice(0, 8).map((mark) => (
                <li key={mark.id} style={{ borderColor: `var(--ul-${mark.color})` }}>
                  <q>{mark.exact.length > 220 ? `${mark.exact.slice(0, 218)}…` : mark.exact}</q>
                  {mark.note ? <span className="pj-pop-note">{mark.note}</span> : null}
                  {mark.section ? <span className="pj-pop-sect">{mark.section}</span> : null}
                </li>
              ))}
            </ul>
          </>
        ) : !paper.abstract ? (
          <p className="pj-sub">Nothing kept from it yet: open it, and what you highlight shows here.</p>
        ) : null}
      </div>
      <div className="pj-row pj-pop-actions">
        <button type="button" className="btn primary sm" onClick={onFloat} disabled={floating}>
          {floating ? 'Floating over the code' : 'Float over the code'}
        </button>
        <button type="button" className="btn sm" onClick={onBeside}>
          Side by side
        </button>
        <button type="button" className="btn ghost sm" onClick={onOpen}>
          Open its page
        </button>
      </div>
    </div>
  );
}

/** In the code's place while the project has none: start a project of files, or link a playground made before. */
function SetUpCode({ project, papers, missing, onLinked, onView }: { project: Project; papers: Paper[]; missing: boolean; onLinked: (id: string) => void; onView: (view: View) => void }) {
  const playgrounds = usePlaygrounds();
  const servers = useServers();
  const { settings, driveConnected } = useStore();
  const [where, setWhere] = useState(false);
  // What each place to run needs, said before the choice rather than as a greyed-out button after it.
  const colabSetUp = colabAvailable(settings.googleClientId);
  const colabOn = isOn(settings, COLAB);
  const colabOk = colabSetUp && colabOn;
  const colabNeeds = [!settings.googleClientId.trim() ? 'a Google client ID' : '', !hasProxy() ? 'the paper proxy' : ''].filter(Boolean);
  const allComputers = servers.filter((server) => server.where === 'pc' || server.companionId);
  const computers = serversOn(settings, allComputers);
  const ready = colabOk || computers.length > 0;
  const switches = switchesOnCards(settings);
  const cites = papers.slice(0, 12).map((paper) => ({ paperId: paper.id, title: paper.title }));
  const readme = [
    `# ${project.name}`,
    '',
    project.project.question ? `> ${project.project.question}` : '',
    '',
    '## Papers',
    '',
    ...papers.map((paper) => `- ${paper.title}${paper.arxivId ? ` (arXiv:${paper.arxivId})` : ''}${project.project.roles[paper.id] ? ` — ${roleLabel(project.project.roles[paper.id])}` : ''}`),
    '',
  ]
    .filter((line, at, all) => line || all[at - 1])
    .join('\n');
  return (
    <div className="pj-setup">
      <span className="eyebrow">The project’s code</span>
      <h2>{missing ? 'Its playground is not here' : 'Give this project code'}</h2>
      <p>
        {missing
          ? 'The playground this project was linked to is not in this browser or your Drive. Start a new one, or link another.'
          : 'A folder of files, an editor, a console and an agent that knows the project’s papers — the same as a playground, kept beside the papers you read for it.'}
      </p>
      <ul className="pj-ready" aria-label="Where it can run">
        <li className={colabOk ? 'is-ok' : colabSetUp ? 'is-off' : 'is-missing'}>
          <b>Colab</b>
          {!colabSetUp ? (
            <span>
              needs {colabNeeds.join(' and ') || 'a Google sign-in'} —{' '}
              <button type="button" className="link-btn" onClick={() => window.dispatchEvent(new Event(OPEN_SETTINGS))}>
                set it up in Settings
              </button>
            </span>
          ) : colabOn ? (
            <span>ready — CPU and a T4 on the free tier{driveConnected ? ', the files kept in your Drive' : ''}</span>
          ) : (
            <span>turned off — not offered as a place to run</span>
          )}
          {switches && colabSetUp ? <ComputeSwitch id={COLAB} label="Colab" /> : null}
        </li>
        {allComputers.length && switches ? (
          allComputers.map((server) => (
            <li key={server.id} className={isOn(settings, computeId(server)) ? 'is-ok' : 'is-off'}>
              <b>Your computer</b>
              <span>{isOn(settings, computeId(server)) ? `set up — ${server.name || 'this computer'}` : `${server.name || 'this computer'} — turned off`}</span>
              <ComputeSwitch id={computeId(server)} label={server.name || 'This computer'} />
            </li>
          ))
        ) : (
          <li className={computers.length ? 'is-ok' : allComputers.length ? 'is-off' : 'is-missing'}>
            <b>Your computer</b>
            {computers.length ? (
              <span>set up — {computers.map((server) => server.name || 'this computer').join(', ')}</span>
            ) : allComputers.length ? (
              <span>turned off in Settings → Compute</span>
            ) : (
              <span>
                needs the Reader app, one command —{' '}
                <button type="button" className="link-btn" onClick={() => onView({ kind: 'playground' })}>
                  connect this computer
                </button>
              </span>
            )}
          </li>
        )}
      </ul>
      {switches ? (
        <button type="button" className="link-btn pj-manage-compute" onClick={openComputeSettings}>
          Manage compute — stop what runs, or turn places on and off
        </button>
      ) : null}
      <div className="pj-row">
        <button type="button" className="btn primary" onClick={() => setWhere(true)} title={ready ? undefined : 'Nowhere to run it yet — see above'}>
          <CodeIcon size={14} /> Start the project’s code
        </button>
        {!ready ? <span className="pj-hint">You can look at the choices now; creating it waits for one of the two above.</span> : null}
      </div>
      {playgrounds.length ? (
        <div className="pj-link-list">
          <span className="eyebrow">Or link a playground you have</span>
          {playgrounds.slice(0, 8).map((item) => (
            <button key={item.id} type="button" className="pj-link-item" onClick={() => onLinked(item.id)}>
              <CodeIcon size={13} />
              <span>{item.title}</span>
              <ComputeTag compute={item.compute} home={item.home} />
            </button>
          ))}
        </div>
      ) : null}
      {where ? (
        <WhereDialog
          draft={{
            title: project.name,
            kind: 'project',
            start: papers.length ? 'paper' : 'blank',
            cites,
            files: { 'README.md': readme, 'main.py': '# Start here.\n' },
          }}
          onClose={() => setWhere(false)}
          onCreate={async (spec) => {
            const made = await createPlayground(spec);
            setWhere(false);
            onLinked(made.id);
          }}
        />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------ a new project --

function Swatches({ value, onPick }: { value: string; onPick: (color: string) => void }) {
  return (
    <div className="pj-swatches" role="radiogroup" aria-label="Colour">
      {COLLECTION_COLORS.map((color) => (
        <button key={color} type="button" role="radio" aria-checked={value === color} aria-label={color} className="pj-swatch" style={{ background: color }} onClick={() => onPick(color)} />
      ))}
    </div>
  );
}

export function NewProjectDialog({ onClose, onCreated, from }: { onClose: () => void; onCreated: (id: string) => void; from?: string }) {
  const { collections, papers, createCollection, updateCollection } = useStore();
  const plain = plainCollections(collections);
  const used = new Set(projectsOf(collections).map((project) => project.color));
  const [name, setName] = useState('');
  const [question, setQuestion] = useState('');
  const [color, setColor] = useState(() => COLLECTION_COLORS.find((item) => !used.has(item)) ?? COLLECTION_COLORS[0]);
  const [source, setSource] = useState<string>(from ?? '');
  const [busy, setBusy] = useState(false);
  const sourceName = plain.find((item) => item.id === source)?.name;
  const create = async () => {
    setBusy(true);
    try {
      const info = newProjectInfo(question);
      if (source) {
        // The collection becomes the project: its papers come with it, in Drive too.
        await updateCollection(source, { name: name.trim() || sourceName || 'Untitled project', color, project: info });
        onCreated(source);
      } else {
        const made = await createCollection(name.trim() || 'Untitled project');
        await updateCollection(made.id, { color, project: info });
        onCreated(made.id);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="scrim" onClick={busy ? undefined : onClose} role="presentation" />
      <div className="sheet narrow pj-new" role="dialog" aria-modal="true" aria-labelledby="pj-new-title">
        <span className="eyebrow">New project</span>
        <h2 id="pj-new-title">What are you working on?</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label className="pj-label">
            Name
            <input autoFocus value={name} placeholder={sourceName ?? 'Diffusion quantization'} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="pj-label">
            Research question <span className="pj-hint">— optional; shown on the project, and handed to its agent</span>
            <textarea rows={2} value={question} placeholder="Can DiT weights go to 4-bit post-training without FID collapse?" onChange={(event) => setQuestion(event.target.value)} />
          </label>
          <div className="pj-label">
            Colour
            <Swatches value={color} onPick={setColor} />
          </div>
          <div className="pj-label">
            Start with
            <div className="pj-chips">
              <button type="button" className="pj-chip" aria-pressed={!source} onClick={() => setSource('')}>
                Nothing yet
              </button>
              {plain.map((collection) => {
                const count = papers.filter((paper) => paper.collectionIds.includes(collection.id)).length;
                return (
                  <button key={collection.id} type="button" className="pj-chip" aria-pressed={source === collection.id} onClick={() => setSource(collection.id)}>
                    <span className="pj-dot" style={{ background: collection.color }} />
                    {collection.name} · {count}
                  </button>
                );
              })}
            </div>
            {source ? <span className="pj-hint">“{sourceName}” becomes the project, with its papers. It stops being listed as a collection.</span> : null}
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? <span className="spinner" /> : null} Create project
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

// ---------------------------------------------- add to a project, from a search --

/**
 * "Projects ▾" on a search result: a tick for each project the paper is in,
 * and its role there. Ticking one adds the paper to the library first, if it
 * is not in it yet.
 */
export function AddToProject({
  paperRef,
  onAdd,
  compact = false,
  align = 'left',
}: {
  paperRef: PaperRef;
  onAdd?: (ref: PaperRef, projectId: string) => Promise<Paper>;
  compact?: boolean;
  /** Which edge of the button the menu lines up with: the one with room beside it. */
  align?: 'left' | 'right';
}) {
  const { papers, collections, addPaper, setPaperCollections, updateCollection } = useStore();
  const projects = useMemo(() => projectsOf(collections), [collections]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const esc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
      const at = Number(event.key);
      if (at >= 1 && at <= 9 && projects[at - 1] && !(event.target as HTMLElement)?.closest('input, textarea, select')) {
        event.preventDefault();
        void toggle(projects[at - 1]);
      }
    };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  });
  const saved = papers.find((paper) => paper.id === paperRef.id);
  const inProjects = projects.filter((project) => saved?.collectionIds.includes(project.id));
  const toggle = async (project: Project) => {
    const now = papers.find((paper) => paper.id === paperRef.id);
    if (!now) {
      await (onAdd ? onAdd(paperRef, project.id) : addPaper(paperRef, project.id));
      return;
    }
    const on = !now.collectionIds.includes(project.id);
    await setPaperCollections(now.id, toggledIn(now.collectionIds, project.id, on));
    if (!on && project.project.roles[now.id]) void updateCollection(project.id, { project: withRole(project.project, now.id, null) });
  };
  return (
    <span className="pj-add" ref={ref}>
      <button
        type="button"
        className={`btn sm${inProjects.length ? ' pj-add-in' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Add it to one of your projects"
        onClick={() => setOpen(!open)}
      >
        {inProjects.length ? (
          <>
            {inProjects.slice(0, 3).map((project) => (
              <span key={project.id} className="pj-dot" style={{ background: project.color }} />
            ))}
            {compact ? (inProjects.length === 1 ? 'Project' : `${inProjects.length} projects`) : inProjects.length === 1 ? clipName(inProjects[0].name) : `${inProjects.length} projects`}
          </>
        ) : (
          <>
            <PlusIcon size={12} /> {compact ? 'Project' : 'Add to project'}
          </>
        )}
        <ChevronDownIcon size={12} />
      </button>
      {open ? (
        <div className={`pj-menu pj-add-menu${align === 'right' ? ' is-right' : ''}`} role="menu">
          <span className="eyebrow">Projects</span>
          {projects.map((project, at) => {
            const on = Boolean(saved?.collectionIds.includes(project.id));
            return (
              <div key={project.id} className={`pj-add-row${on ? ' is-on' : ''}`}>
                <button type="button" role="menuitemcheckbox" aria-checked={on} onClick={() => void toggle(project)}>
                  <span className={`pj-tick${on ? ' is-on' : ''}`}>{on ? <CheckIcon size={11} /> : null}</span>
                  <span className="pj-dot" style={{ background: project.color }} />
                  <span className="pj-add-name">{project.name}</span>
                  {at < 9 ? <kbd>{at + 1}</kbd> : null}
                </button>
                {on && saved ? (
                  <div className="pj-add-roles" role="group" aria-label={`Role in ${project.name}`}>
                    {ROLES.map((role) => (
                      <button
                        key={role.id}
                        type="button"
                        title={role.note}
                        aria-pressed={project.project.roles[saved.id] === role.id}
                        onClick={() => void updateCollection(project.id, { project: withRole(project.project, saved.id, project.project.roles[saved.id] === role.id ? null : role.id) })}
                      >
                        {role.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
          {!projects.length ? <p className="pj-hint" style={{ padding: '2px 8px 6px' }}>No projects yet.</p> : null}
          <button type="button" role="menuitem" className="pj-menu-new" onClick={() => (setOpen(false), setCreating(true))}>
            <PlusIcon size={12} /> New project…
          </button>
        </div>
      ) : null}
      {creating ? (
        <NewProjectDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            // A paper already in the library is added to the new project the same way: addPaper keeps its other collections.
            void (onAdd ? onAdd(paperRef, id) : addPaper(paperRef, id));
          }}
        />
      ) : null}
    </span>
  );
}

const clipName = (name: string) => (name.length > 18 ? `${name.slice(0, 17)}…` : name);

// ------------------------------------------------------------ the rail --

/** The rail's way into projects: the board, and a mark for each project, the one open lit. */
export function RailProjects({ current, onBoard, onOpen, onBoardActive }: { current?: string; onBoard: () => void; onOpen: (id: string) => void; onBoardActive: boolean }) {
  const { collections } = useStore();
  const projects = projectsOf(collections);
  return (
    <div className="rail-projects">
      <button type="button" className={`icon-btn${onBoardActive ? ' is-active' : ''}`} aria-current={onBoardActive ? 'page' : undefined} aria-label="Projects" title="Projects — every project side by side" onClick={onBoard}>
        <GridIcon size={18} />
      </button>
      {projects.slice(0, 6).map((project) => (
        <button
          key={project.id}
          type="button"
          className={`pj-mark rail-mark${current === project.id ? ' is-on' : ''}`}
          style={{ background: project.color }}
          aria-current={current === project.id ? 'page' : undefined}
          aria-label={`Project: ${project.name}`}
          title={`${project.name}${project.project.question ? ` — ${project.project.question}` : ''}`}
          onClick={() => onOpen(project.id)}
        >
          {initialsOf(project.name)}
        </button>
      ))}
    </div>
  );
}
