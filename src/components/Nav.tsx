// The app's navigation, laid out one of the ways Settings → Navigation offers
// (types.ts, `NavStyle`). Two kinds of thing are in it, and every layout here
// keeps them apart: pages, which the main area goes to (Home, the paper being
// read, the Library, Projects and each project, the Playground), and panels,
// which open beside whatever page is showing (the Library's collections,
// Discover, Notes, Ask AI). The classic rail, which mixed them, is still in
// App.tsx as it was.
//
// App builds one `NavModel` and hands it here; nothing in this file holds
// state of its own beyond whether the sidebar is folded.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { NavStyle, ProjectNav } from '../types';
import { initialsOf } from '../lib/projects';
import { PanelLeftIcon } from './icons';

export interface NavPage {
  key: string;
  label: string;
  /** Said in the tooltip: where it goes. */
  title: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
  /** Shown beside the label in the sidebar: a count, or a key. */
  aside?: string;
  /** Something drawn over the icon — the Playground's count of what runs. */
  badge?: ReactNode;
}

export interface NavPanel {
  key: string;
  label: string;
  title: string;
  icon: ReactNode;
  on: boolean;
  onClick: () => void;
  /** Which side of the page it opens on, for the lit edge in the tray. */
  side: 'left' | 'right' | 'float';
}

export interface NavModel {
  onBrand: () => void;
  brandActive: boolean;
  pages: NavPage[];
  projects: { id: string; name: string; color: string; active: boolean; title: string; count: number }[];
  onProject: (id: string) => void;
  /** How the projects are reached (Settings → Navigation → Projects in the rail). */
  projectNav: ProjectNav;
  /** The project open, else the one opened last: the switcher's and "just the current one"'s. */
  currentProject?: string;
  onBoard: () => void;
  onNewProject: () => void;
  /** Out of every project: the library as a whole. */
  onNoProject: () => void;
  /** The page after which the projects are listed. */
  projectsAfter: string;
  panels: NavPanel[];
  /** At the bottom, above the account: what Explain is writing. */
  progress?: ReactNode;
  /** At the bottom too: the compute chip, when Settings puts it in the rail. Given labelled or not. */
  compute?: (labelled: boolean) => ReactNode;
  account: ReactNode;
  onSettings: () => void;
  settingsIcon: ReactNode;
  settingsTitle: string;
}

const FOLDED = 'reader.nav.folded';

const readFolded = () => {
  try {
    return localStorage.getItem(FOLDED) === 'true';
  } catch {
    return false;
  }
};

export default function Nav({ style, model }: { style: Exclude<NavStyle, 'classic'>; model: NavModel }) {
  const [folded, setFoldedState] = useState(readFolded);
  const setFolded = (next: boolean) => {
    setFoldedState(next);
    try {
      localStorage.setItem(FOLDED, String(next));
    } catch {
      // only a convenience
    }
  };
  if (style === 'sidebar' && !folded) return <Sidebar model={model} onFold={() => setFolded(true)} />;
  if (style === 'labelled') return <LabelledRail model={model} />;
  return <IconRail model={model} tray={style === 'zones' || style === 'sidebar'} onUnfold={style === 'sidebar' ? () => setFolded(false) : undefined} />;
}

/** The brand: Home, the way it always was. */
function Brand({ model }: { model: NavModel }) {
  return (
    <button
      type="button"
      className="brand"
      aria-label="Home"
      aria-current={model.brandActive ? 'page' : undefined}
      title="Home — press G to go between Home and the paper you are reading"
      onClick={model.onBrand}
    >
      R
    </button>
  );
}

function ProjectMarks({ model, small = false }: { model: NavModel; small?: boolean }) {
  if (!model.projects.length) return null;
  return (
    <div className={`nav-marks${small ? ' is-small' : ''}`}>
      {model.projects.slice(0, 6).map((project) => (
        <button
          key={project.id}
          type="button"
          className={`pj-mark rail-mark${project.active ? ' is-on' : ''}`}
          style={{ background: project.color }}
          aria-current={project.active ? 'page' : undefined}
          aria-label={`Project: ${project.name}`}
          title={project.title}
          onClick={() => model.onProject(project.id)}
        >
          {initialsOf(project.name)}
        </button>
      ))}
    </div>
  );
}

/** Where the projects go in a rail, by Settings → Navigation → Projects in the rail. */
function ProjectsPart({ model, wide }: { model: NavModel; wide: boolean }) {
  const mode = model.projectNav;
  if (!model.projects.length) return null;
  if (mode === 'marks') return <ProjectMarks model={model} small />;
  if (mode === 'dots') return <ProjectDots model={model} />;
  if (mode === 'current') return <ProjectCurrent model={model} wide={wide} />;
  if (mode === 'folder') return <ProjectFolder model={model} wide={wide} />;
  return null;
}

function ProjectDots({ model }: { model: NavModel }) {
  return (
    <div className="nav-dots">
      {model.projects.slice(0, 8).map((project) => (
        <button
          key={project.id}
          type="button"
          className={project.active ? 'is-on' : undefined}
          style={{ background: project.color }}
          aria-current={project.active ? 'page' : undefined}
          aria-label={`Project: ${project.name}`}
          title={`${project.name} · ${project.count} ${project.count === 1 ? 'paper' : 'papers'}`}
          onClick={() => model.onProject(project.id)}
        />
      ))}
    </div>
  );
}

function ProjectCurrent({ model, wide }: { model: NavModel; wide: boolean }) {
  const project = model.projects.find((item) => item.id === model.currentProject);
  if (!project) return null;
  return (
    <button
      type="button"
      className={`nav-current${project.active ? ' is-active' : ''}${wide ? ' is-wide' : ''}`}
      aria-current={project.active ? 'page' : undefined}
      title={project.title}
      onClick={() => model.onProject(project.id)}
    >
      <span className="pj-mark sm" style={{ background: project.color }}>
        {initialsOf(project.name)}
      </span>
      {wide ? <span className="nav-current-name">{project.name}</span> : null}
    </button>
  );
}

const OPEN_FOLDER = 'reader.nav.projects.open';

function ProjectFolder({ model, wide }: { model: NavModel; wide: boolean }) {
  const [open] = useFolderOpen();
  if (!open) {
    // Folded: the project open, if one is, as a bar of its colour.
    const current = model.projects.find((item) => item.active);
    return current ? <span className="nav-folder-bar" style={{ background: current.color }} title={current.name} /> : null;
  }
  return (
    <div className={`nav-folder${wide ? ' is-wide' : ''}`}>
      {model.projects.map((project) => (
        <button
          key={project.id}
          type="button"
          className={project.active ? 'is-on' : undefined}
          style={{ borderColor: project.color }}
          aria-current={project.active ? 'page' : undefined}
          title={project.title}
          onClick={() => model.onProject(project.id)}
        >
          {wide ? project.name : initialsOf(project.name)}
        </button>
      ))}
      <button type="button" className="nav-folder-all" onClick={model.onBoard} title="Every project side by side">
        {wide ? 'All projects' : '⊞'}
      </button>
    </div>
  );
}

/** Whether "opens like a folder" is open, kept on this device and shared by the rail's parts. */
const folderListeners = new Set<(open: boolean) => void>();
function useFolderOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(() => {
    try {
      return localStorage.getItem(OPEN_FOLDER) !== 'false';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    folderListeners.add(setOpenState);
    return () => void folderListeners.delete(setOpenState);
  }, []);
  const setOpen = (next: boolean) => {
    try {
      localStorage.setItem(OPEN_FOLDER, String(next));
    } catch {
      // only a convenience
    }
    folderListeners.forEach((listener) => listener(next));
  };
  return [open, setOpen];
}

/** A menu of the projects, next to the button that opened it; fixed to the window so the rail's scrolling cannot clip it. */
function ProjectMenu({
  model,
  anchor,
  heading,
  withNone,
  onClose,
}: {
  model: NavModel;
  anchor: HTMLElement;
  heading: string;
  withNone?: boolean;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const box = anchor.getBoundingClientRect();
  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) onClose();
    };
    const esc = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [anchor, onClose]);
  const pick = (go: () => void) => () => {
    onClose();
    go();
  };
  return (
    <div ref={menu} className="nav-pmenu" role="menu" style={{ left: box.right + 8, top: Math.max(8, Math.min(box.top, window.innerHeight - 320)) }}>
      <span className="nav-pmenu-head">{heading}</span>
      {model.projects.map((project) => (
        <button key={project.id} type="button" role="menuitem" className={project.id === model.currentProject ? 'is-on' : undefined} onClick={pick(() => model.onProject(project.id))}>
          <span className="nav-pmenu-sq" style={{ background: project.color }} />
          <span className="nav-pmenu-name">{project.name}</span>
          <span className="nav-pmenu-n">{project.count}</span>
        </button>
      ))}
      <span className="nav-pmenu-line" />
      <button type="button" role="menuitem" className="is-quiet" onClick={pick(model.onBoard)}>
        ⊞ All projects
      </button>
      <button type="button" role="menuitem" className="is-quiet" onClick={pick(model.onNewProject)}>
        ＋ New project…
      </button>
      {withNone ? (
        <button type="button" role="menuitem" className="is-quiet" onClick={pick(model.onNoProject)}>
          ○ No project — the whole library
        </button>
      ) : null}
    </div>
  );
}

/** The switcher: under the brand, the project you are in (or were in last), opening the others. */
function ProjectSwitcher({ model, wide }: { model: NavModel; wide: boolean }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (!model.projects.length) return null;
  const project = model.projects.find((item) => item.id === model.currentProject);
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`nav-switcher${wide ? ' is-wide' : ''}${project?.active ? ' is-active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={project ? `${project.name} — switch project` : 'Pick a project'}
        onClick={() => setOpen(!open)}
      >
        {project ? (
          <span className="pj-mark" style={{ background: project.color }}>
            {initialsOf(project.name)}
          </span>
        ) : (
          <span className="pj-mark nav-switcher-none">＋</span>
        )}
        {wide ? <span className="nav-switcher-name">{project ? project.name : 'No project'}</span> : null}
        <span className="nav-switcher-chev">⌄{wide ? ' switch' : ''}</span>
      </button>
      {open && button.current ? <ProjectMenu model={model} anchor={button.current} heading="Switch project" withNone onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function Foot({ model, labelled = false }: { model: NavModel; labelled?: boolean }) {
  return (
    <>
      <div style={{ flexGrow: 1 }} />
      {model.compute?.(labelled)}
      {model.progress}
      {model.account}
      <button type="button" className={labelled ? 'nav-lab' : 'icon-btn'} onClick={model.onSettings} aria-label="Settings" title={model.settingsTitle}>
        {model.settingsIcon}
        {labelled ? <span>Settings</span> : null}
      </button>
    </>
  );
}

/**
 * A page on a rail, named or not. Projects is where the project options
 * differ: with "menu" it opens the menu of projects (with their count on it),
 * with "folder" it opens and folds the list; otherwise it goes to the board.
 */
function PageButton({ model, item, labelled }: { model: NavModel; item: NavPage; labelled: boolean }) {
  const [menu, setMenu] = useState(false);
  const [folderOpen, setFolderOpen] = useFolderOpen();
  const button = useRef<HTMLButtonElement>(null);
  const isProjects = item.key === model.projectsAfter && model.projects.length > 0;
  const mode = isProjects ? model.projectNav : null;
  const onClick = mode === 'menu' ? () => setMenu(!menu) : mode === 'folder' ? () => setFolderOpen(!folderOpen) : item.onClick;
  const label = mode === 'folder' ? `${item.label} ${folderOpen ? '▾' : '▸'}` : item.label;
  return (
    <div className="rail-run">
      <button
        ref={button}
        type="button"
        className={labelled ? `nav-lab${item.active ? ' is-active' : ''}` : `icon-btn${item.active ? ' is-active' : ''}`}
        aria-current={item.active ? 'page' : undefined}
        aria-label={labelled ? undefined : item.label}
        aria-haspopup={mode === 'menu' ? 'menu' : undefined}
        aria-expanded={mode === 'menu' ? menu : mode === 'folder' ? folderOpen : undefined}
        title={mode === 'menu' ? 'Your projects' : mode === 'folder' ? (folderOpen ? 'Fold the projects away' : 'Show your projects') : item.title}
        onClick={onClick}
      >
        {item.icon}
        {labelled ? <span>{label}</span> : null}
        {mode === 'menu' ? <span className="nav-count">{model.projects.length}</span> : null}
      </button>
      {item.badge}
      {menu && button.current ? <ProjectMenu model={model} anchor={button.current} heading="Projects" onClose={() => setMenu(false)} /> : null}
    </div>
  );
}

/**
 * A narrow rail of icons with the pages only, or — with `tray` — the pages at
 * the top and the panels in a tray at the bottom, a lit edge on the side each
 * panel opens from while it is out.
 */
function IconRail({ model, tray, onUnfold }: { model: NavModel; tray: boolean; onUnfold?: () => void }) {
  const page = (item: NavPage) => <PageButton key={item.key} model={model} item={item} labelled={false} />;
  return (
    <nav className={`rail nav-rail${tray ? ' has-tray' : ''}`} aria-label="Primary">
      <Brand model={model} />
      {onUnfold ? (
        <button type="button" className="icon-btn sm nav-unfold" onClick={onUnfold} aria-label="Open the sidebar" title="Open the sidebar, with every page by name">
          <PanelLeftIcon size={15} />
        </button>
      ) : null}
      {model.projectNav === 'switcher' ? <ProjectSwitcher model={model} wide={false} /> : null}
      {tray ? <span className="nav-cap">Go to</span> : null}
      {model.pages.flatMap((item) => (item.key === model.projectsAfter ? [page(item), <ProjectsPart key="projects" model={model} wide={false} />] : [page(item)]))}
      {tray ? (
        <>
          <div style={{ flexGrow: 1 }} />
          <span className="nav-cap">Beside</span>
          <div className="nav-tray" role="group" aria-label="Panels beside the page">
            {model.panels.map((panel) => (
              <button
                key={panel.key}
                type="button"
                className={`icon-btn nav-panel-btn side-${panel.side}`}
                aria-pressed={panel.on}
                aria-label={panel.label}
                title={`${panel.label} — ${panel.title}`}
                onClick={panel.onClick}
              >
                {panel.icon}
              </button>
            ))}
          </div>
          <span className="nav-sep" />
          {model.compute?.(false)}
          {model.progress}
          {model.account}
          <button type="button" className="icon-btn" onClick={model.onSettings} aria-label="Settings" title={model.settingsTitle}>
            {model.settingsIcon}
          </button>
        </>
      ) : (
        <Foot model={model} />
      )}
    </nav>
  );
}

/** A slightly wider rail, each page named under its icon; the panels are in the page's own bar (PanelBar). */
function LabelledRail({ model }: { model: NavModel }) {
  return (
    <nav className="rail nav-rail is-labelled" aria-label="Primary">
      <Brand model={model} />
      {model.projectNav === 'switcher' ? <ProjectSwitcher model={model} wide /> : null}
      {model.pages.map((item) => (
        <div key={item.key} className="nav-lab-item">
          <PageButton model={model} item={item} labelled />
          {item.key === model.projectsAfter ? <ProjectsPart model={model} wide /> : null}
        </div>
      ))}
      <Foot model={model} labelled />
    </nav>
  );
}

/** The wide sidebar: pages by name, the projects under Projects, the panels as switches; folds to the narrow rail. */
function Sidebar({ model, onFold }: { model: NavModel; onFold: () => void }) {
  return (
    <nav className="rail nav-sidebar" aria-label="Primary">
      <div className="nav-sb-head">
        <Brand model={model} />
        <b>Reader</b>
        <button type="button" className="icon-btn sm" onClick={onFold} aria-label="Fold the sidebar" title="Fold to a narrow rail">
          <PanelLeftIcon size={15} />
        </button>
      </div>
      <span className="nav-sb-cap">Go to</span>
      {model.pages.map((item) => (
        <div key={item.key}>
          <button type="button" className={`nav-sb-row${item.active ? ' is-active' : ''}`} aria-current={item.active ? 'page' : undefined} title={item.title} onClick={item.onClick}>
            {item.icon}
            <span className="nav-sb-label">{item.label}</span>
            {item.aside ? <span className="nav-sb-aside">{item.aside}</span> : null}
          </button>
          {item.key === model.projectsAfter
            ? model.projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className={`nav-sb-row is-sub${project.active ? ' is-active' : ''}`}
                  aria-current={project.active ? 'page' : undefined}
                  title={project.title}
                  onClick={() => model.onProject(project.id)}
                >
                  <span className="pj-dot" style={{ background: project.color }} />
                  <span className="nav-sb-label">{project.name}</span>
                </button>
              ))
            : null}
        </div>
      ))}
      <div style={{ flexGrow: 1 }} />
      <span className="nav-sb-cap">Show beside the page</span>
      {model.panels.map((panel) => (
        <button key={panel.key} type="button" role="switch" aria-checked={panel.on} className="nav-sb-row" title={panel.title} onClick={panel.onClick}>
          {panel.icon}
          <span className="nav-sb-label">{panel.label}</span>
          <span className={`nav-switch${panel.on ? ' is-on' : ''}`} aria-hidden="true" />
        </button>
      ))}
      <span className="nav-sb-line" />
      <div className="nav-sb-foot">
        {model.compute?.(true)}
        {model.progress}
        {model.account}
        <button type="button" className="nav-sb-row" onClick={model.onSettings} title={model.settingsTitle}>
          {model.settingsIcon}
          <span className="nav-sb-label">Settings</span>
        </button>
      </div>
    </nav>
  );
}

/** For the labelled rail: the panels as switches at the top of the page, beside what they open into. */
export function PanelBar({ panels, where }: { panels: NavPanel[]; where: string }) {
  return (
    <div className="nav-panelbar">
      <span className="nav-panelbar-where">{where}</span>
      <span style={{ flex: 1 }} />
      <span className="nav-panelbar-cap">Beside the page</span>
      <div className="nav-panelbar-group" role="group" aria-label="Panels beside the page">
        {panels.map((panel) => (
          <button key={panel.key} type="button" aria-pressed={panel.on} title={panel.title} onClick={panel.onClick}>
            {panel.icon}
            <span>{panel.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** For the edge layout: the panels as drawer tabs on the right edge of the page. */
export function EdgeTabs({ panels }: { panels: NavPanel[] }) {
  return (
    <div className="nav-edge" role="group" aria-label="Panels beside the page">
      {panels.map((panel) => (
        <button key={panel.key} type="button" aria-pressed={panel.on} title={`${panel.label} — ${panel.title}`} onClick={panel.onClick}>
          {panel.icon}
          <span>{panel.label}</span>
        </button>
      ))}
    </div>
  );
}
