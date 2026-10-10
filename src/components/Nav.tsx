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

import { useState, type ReactNode } from 'react';
import type { NavStyle } from '../types';
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
  projects: { id: string; name: string; color: string; active: boolean; title: string }[];
  onProject: (id: string) => void;
  /** The page after which the projects are listed. */
  projectsAfter: string;
  panels: NavPanel[];
  /** At the bottom, above the account: what Explain is writing. */
  progress?: ReactNode;
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

function Foot({ model, labelled = false }: { model: NavModel; labelled?: boolean }) {
  return (
    <>
      <div style={{ flexGrow: 1 }} />
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
 * A narrow rail of icons with the pages only, or — with `tray` — the pages at
 * the top and the panels in a tray at the bottom, a lit edge on the side each
 * panel opens from while it is out.
 */
function IconRail({ model, tray, onUnfold }: { model: NavModel; tray: boolean; onUnfold?: () => void }) {
  const page = (item: NavPage) => (
    <div key={item.key} className="rail-run">
      <button
        type="button"
        className={`icon-btn${item.active ? ' is-active' : ''}`}
        aria-current={item.active ? 'page' : undefined}
        aria-label={item.label}
        title={`${item.title}`}
        onClick={item.onClick}
      >
        {item.icon}
      </button>
      {item.badge}
    </div>
  );
  return (
    <nav className={`rail nav-rail${tray ? ' has-tray' : ''}`} aria-label="Primary">
      <Brand model={model} />
      {onUnfold ? (
        <button type="button" className="icon-btn sm nav-unfold" onClick={onUnfold} aria-label="Open the sidebar" title="Open the sidebar, with every page by name">
          <PanelLeftIcon size={15} />
        </button>
      ) : null}
      {tray ? <span className="nav-cap">Go to</span> : null}
      {model.pages.flatMap((item) => (item.key === model.projectsAfter ? [page(item), <ProjectMarks key="marks" model={model} small />] : [page(item)]))}
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
      {model.pages.map((item) => (
        <div key={item.key} className="nav-lab-item">
          <div className="rail-run">
            <button type="button" className={`nav-lab${item.active ? ' is-active' : ''}`} aria-current={item.active ? 'page' : undefined} title={item.title} onClick={item.onClick}>
              {item.icon}
              <span>{item.label}</span>
            </button>
            {item.badge}
          </div>
          {item.key === model.projectsAfter ? <ProjectMarks model={model} small /> : null}
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
