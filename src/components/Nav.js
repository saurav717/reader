import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
import { useEffect, useRef, useState } from 'react';
import { initialsOf } from '../lib/projects';
import { PanelLeftIcon } from './icons';
const FOLDED = 'reader.nav.folded';
const readFolded = () => {
    try {
        return localStorage.getItem(FOLDED) === 'true';
    }
    catch {
        return false;
    }
};
export default function Nav({ style, model }) {
    const [folded, setFoldedState] = useState(readFolded);
    const setFolded = (next) => {
        setFoldedState(next);
        try {
            localStorage.setItem(FOLDED, String(next));
        }
        catch {
            // only a convenience
        }
    };
    if (style === 'sidebar' && !folded)
        return _jsx(Sidebar, { model: model, onFold: () => setFolded(true) });
    if (style === 'labelled')
        return _jsx(LabelledRail, { model: model });
    return _jsx(IconRail, { model: model, tray: style === 'zones' || style === 'sidebar', onUnfold: style === 'sidebar' ? () => setFolded(false) : undefined });
}
/** The brand: Home, the way it always was. */
function Brand({ model }) {
    return (_jsx("button", { type: "button", className: "brand", "aria-label": "Home", "aria-current": model.brandActive ? 'page' : undefined, title: "Home \u2014 press G to go between Home and the paper you are reading", onClick: model.onBrand, children: "R" }));
}
function ProjectMarks({ model, small = false }) {
    if (!model.projects.length)
        return null;
    return (_jsx("div", { className: `nav-marks${small ? ' is-small' : ''}`, children: model.projects.slice(0, 6).map((project) => (_jsx("button", { type: "button", className: `pj-mark rail-mark${project.active ? ' is-on' : ''}`, style: { background: project.color }, "aria-current": project.active ? 'page' : undefined, "aria-label": `Project: ${project.name}`, title: project.title, onClick: () => model.onProject(project.id), children: initialsOf(project.name) }, project.id))) }));
}
/** Where the projects go in a rail, by Settings → Navigation → Projects in the rail. */
function ProjectsPart({ model, wide }) {
    const mode = model.projectNav;
    if (!model.projects.length)
        return null;
    if (mode === 'marks')
        return _jsx(ProjectMarks, { model: model, small: true });
    if (mode === 'dots')
        return _jsx(ProjectDots, { model: model });
    if (mode === 'current')
        return _jsx(ProjectCurrent, { model: model, wide: wide });
    if (mode === 'folder')
        return _jsx(ProjectFolder, { model: model, wide: wide });
    return null;
}
function ProjectDots({ model }) {
    return (_jsx("div", { className: "nav-dots", children: model.projects.slice(0, 8).map((project) => (_jsx("button", { type: "button", className: project.active ? 'is-on' : undefined, style: { background: project.color }, "aria-current": project.active ? 'page' : undefined, "aria-label": `Project: ${project.name}`, title: `${project.name} · ${project.count} ${project.count === 1 ? 'paper' : 'papers'}`, onClick: () => model.onProject(project.id) }, project.id))) }));
}
function ProjectCurrent({ model, wide }) {
    const project = model.projects.find((item) => item.id === model.currentProject);
    if (!project)
        return null;
    return (_jsxs("button", { type: "button", className: `nav-current${project.active ? ' is-active' : ''}${wide ? ' is-wide' : ''}`, "aria-current": project.active ? 'page' : undefined, title: project.title, onClick: () => model.onProject(project.id), children: [_jsx("span", { className: "pj-mark sm", style: { background: project.color }, children: initialsOf(project.name) }), wide ? _jsx("span", { className: "nav-current-name", children: project.name }) : null] }));
}
const OPEN_FOLDER = 'reader.nav.projects.open';
function ProjectFolder({ model, wide }) {
    const [open] = useFolderOpen();
    if (!open) {
        // Folded: the project open, if one is, as a bar of its colour.
        const current = model.projects.find((item) => item.active);
        return current ? _jsx("span", { className: "nav-folder-bar", style: { background: current.color }, title: current.name }) : null;
    }
    return (_jsxs("div", { className: `nav-folder${wide ? ' is-wide' : ''}`, children: [model.projects.map((project) => (_jsx("button", { type: "button", className: project.active ? 'is-on' : undefined, style: { borderColor: project.color }, "aria-current": project.active ? 'page' : undefined, title: project.title, onClick: () => model.onProject(project.id), children: wide ? project.name : initialsOf(project.name) }, project.id))), _jsx("button", { type: "button", className: "nav-folder-all", onClick: model.onBoard, title: "Every project side by side", children: wide ? 'All projects' : '⊞' })] }));
}
/** Whether "opens like a folder" is open, kept on this device and shared by the rail's parts. */
const folderListeners = new Set();
function useFolderOpen() {
    const [open, setOpenState] = useState(() => {
        try {
            return localStorage.getItem(OPEN_FOLDER) !== 'false';
        }
        catch {
            return true;
        }
    });
    useEffect(() => {
        folderListeners.add(setOpenState);
        return () => void folderListeners.delete(setOpenState);
    }, []);
    const setOpen = (next) => {
        try {
            localStorage.setItem(OPEN_FOLDER, String(next));
        }
        catch {
            // only a convenience
        }
        folderListeners.forEach((listener) => listener(next));
    };
    return [open, setOpen];
}
/** A menu of the projects, next to the button that opened it; fixed to the window so the rail's scrolling cannot clip it. */
function ProjectMenu({ model, anchor, heading, withNone, onClose, }) {
    const menu = useRef(null);
    const box = anchor.getBoundingClientRect();
    useEffect(() => {
        const away = (event) => {
            if (!menu.current?.contains(event.target) && !anchor.contains(event.target))
                onClose();
        };
        const esc = (event) => event.key === 'Escape' && onClose();
        window.addEventListener('pointerdown', away);
        window.addEventListener('keydown', esc);
        return () => {
            window.removeEventListener('pointerdown', away);
            window.removeEventListener('keydown', esc);
        };
    }, [anchor, onClose]);
    const pick = (go) => () => {
        onClose();
        go();
    };
    return (_jsxs("div", { ref: menu, className: "nav-pmenu", role: "menu", style: { left: box.right + 8, top: Math.max(8, Math.min(box.top, window.innerHeight - 320)) }, children: [_jsx("span", { className: "nav-pmenu-head", children: heading }), model.projects.map((project) => (_jsxs("button", { type: "button", role: "menuitem", className: project.id === model.currentProject ? 'is-on' : undefined, onClick: pick(() => model.onProject(project.id)), children: [_jsx("span", { className: "nav-pmenu-sq", style: { background: project.color } }), _jsx("span", { className: "nav-pmenu-name", children: project.name }), _jsx("span", { className: "nav-pmenu-n", children: project.count })] }, project.id))), _jsx("span", { className: "nav-pmenu-line" }), _jsx("button", { type: "button", role: "menuitem", className: "is-quiet", onClick: pick(model.onBoard), children: "\u229E All projects" }), _jsx("button", { type: "button", role: "menuitem", className: "is-quiet", onClick: pick(model.onNewProject), children: "\uFF0B New project\u2026" }), withNone ? (_jsx("button", { type: "button", role: "menuitem", className: "is-quiet", onClick: pick(model.onNoProject), children: "\u25CB No project \u2014 the whole library" })) : null] }));
}
/** The switcher: under the brand, the project you are in (or were in last), opening the others. */
function ProjectSwitcher({ model, wide }) {
    const [open, setOpen] = useState(false);
    const button = useRef(null);
    if (!model.projects.length)
        return null;
    const project = model.projects.find((item) => item.id === model.currentProject);
    return (_jsxs(_Fragment, { children: [_jsxs("button", { ref: button, type: "button", className: `nav-switcher${wide ? ' is-wide' : ''}${project?.active ? ' is-active' : ''}`, "aria-haspopup": "menu", "aria-expanded": open, title: project ? `${project.name} — switch project` : 'Pick a project', onClick: () => setOpen(!open), children: [project ? (_jsx("span", { className: "pj-mark", style: { background: project.color }, children: initialsOf(project.name) })) : (_jsx("span", { className: "pj-mark nav-switcher-none", children: "\uFF0B" })), wide ? _jsx("span", { className: "nav-switcher-name", children: project ? project.name : 'No project' }) : null, _jsxs("span", { className: "nav-switcher-chev", children: ["\u2304", wide ? ' switch' : ''] })] }), open && button.current ? _jsx(ProjectMenu, { model: model, anchor: button.current, heading: "Switch project", withNone: true, onClose: () => setOpen(false) }) : null] }));
}
function Foot({ model, labelled = false }) {
    return (_jsxs(_Fragment, { children: [_jsx("div", { style: { flexGrow: 1 } }), model.compute?.(labelled), model.progress, model.account, _jsxs("button", { type: "button", className: labelled ? 'nav-lab' : 'icon-btn', onClick: model.onSettings, "aria-label": "Settings", title: model.settingsTitle, children: [model.settingsIcon, labelled ? _jsx("span", { children: "Settings" }) : null] })] }));
}
/**
 * A page on a rail, named or not. Projects is where the project options
 * differ: with "menu" it opens the menu of projects (with their count on it),
 * with "folder" it opens and folds the list; otherwise it goes to the board.
 */
function PageButton({ model, item, labelled }) {
    const [menu, setMenu] = useState(false);
    const [folderOpen, setFolderOpen] = useFolderOpen();
    const button = useRef(null);
    const isProjects = item.key === model.projectsAfter && model.projects.length > 0;
    const mode = isProjects ? model.projectNav : null;
    const onClick = mode === 'menu' ? () => setMenu(!menu) : mode === 'folder' ? () => setFolderOpen(!folderOpen) : item.onClick;
    const label = mode === 'folder' ? `${item.label} ${folderOpen ? '▾' : '▸'}` : item.label;
    return (_jsxs("div", { className: "rail-run", children: [_jsxs("button", { ref: button, type: "button", className: labelled ? `nav-lab${item.active ? ' is-active' : ''}` : `icon-btn${item.active ? ' is-active' : ''}`, "aria-current": item.active ? 'page' : undefined, "aria-label": labelled ? undefined : item.label, "aria-haspopup": mode === 'menu' ? 'menu' : undefined, "aria-expanded": mode === 'menu' ? menu : mode === 'folder' ? folderOpen : undefined, title: mode === 'menu' ? 'Your projects' : mode === 'folder' ? (folderOpen ? 'Fold the projects away' : 'Show your projects') : item.title, onClick: onClick, children: [item.icon, labelled ? _jsx("span", { children: label }) : null, mode === 'menu' ? _jsx("span", { className: "nav-count", children: model.projects.length }) : null] }), item.badge, menu && button.current ? _jsx(ProjectMenu, { model: model, anchor: button.current, heading: "Projects", onClose: () => setMenu(false) }) : null] }));
}
/**
 * A narrow rail of icons with the pages only, or — with `tray` — the pages at
 * the top and the panels in a tray at the bottom, a lit edge on the side each
 * panel opens from while it is out.
 */
function IconRail({ model, tray, onUnfold }) {
    const page = (item) => _jsx(PageButton, { model: model, item: item, labelled: false }, item.key);
    return (_jsxs("nav", { className: `rail nav-rail${tray ? ' has-tray' : ''}`, "aria-label": "Primary", children: [_jsx(Brand, { model: model }), onUnfold ? (_jsx("button", { type: "button", className: "icon-btn sm nav-unfold", onClick: onUnfold, "aria-label": "Open the sidebar", title: "Open the sidebar, with every page by name", children: _jsx(PanelLeftIcon, { size: 15 }) })) : null, model.projectNav === 'switcher' ? _jsx(ProjectSwitcher, { model: model, wide: false }) : null, tray ? _jsx("span", { className: "nav-cap", children: "Go to" }) : null, model.pages.flatMap((item) => (item.key === model.projectsAfter ? [page(item), _jsx(ProjectsPart, { model: model, wide: false }, "projects")] : [page(item)])), tray ? (_jsxs(_Fragment, { children: [_jsx("div", { style: { flexGrow: 1 } }), _jsx("span", { className: "nav-cap", children: "Beside" }), _jsx("div", { className: "nav-tray", role: "group", "aria-label": "Panels beside the page", children: model.panels.map((panel) => (_jsx("button", { type: "button", className: `icon-btn nav-panel-btn side-${panel.side}`, "aria-pressed": panel.on, "aria-label": panel.label, title: `${panel.label} — ${panel.title}`, onClick: panel.onClick, children: panel.icon }, panel.key))) }), _jsx("span", { className: "nav-sep" }), model.compute?.(false), model.progress, model.account, _jsx("button", { type: "button", className: "icon-btn", onClick: model.onSettings, "aria-label": "Settings", title: model.settingsTitle, children: model.settingsIcon })] })) : (_jsx(Foot, { model: model }))] }));
}
/** A slightly wider rail, each page named under its icon; the panels are in the page's own bar (PanelBar). */
function LabelledRail({ model }) {
    return (_jsxs("nav", { className: "rail nav-rail is-labelled", "aria-label": "Primary", children: [_jsx(Brand, { model: model }), model.projectNav === 'switcher' ? _jsx(ProjectSwitcher, { model: model, wide: true }) : null, model.pages.map((item) => (_jsxs("div", { className: "nav-lab-item", children: [_jsx(PageButton, { model: model, item: item, labelled: true }), item.key === model.projectsAfter ? _jsx(ProjectsPart, { model: model, wide: true }) : null] }, item.key))), _jsx(Foot, { model: model, labelled: true })] }));
}
/** The wide sidebar: pages by name, the projects under Projects, the panels as switches; folds to the narrow rail. */
function Sidebar({ model, onFold }) {
    return (_jsxs("nav", { className: "rail nav-sidebar", "aria-label": "Primary", children: [_jsxs("div", { className: "nav-sb-head", children: [_jsx(Brand, { model: model }), _jsx("b", { children: "Reader" }), _jsx("button", { type: "button", className: "icon-btn sm", onClick: onFold, "aria-label": "Fold the sidebar", title: "Fold to a narrow rail", children: _jsx(PanelLeftIcon, { size: 15 }) })] }), _jsx("span", { className: "nav-sb-cap", children: "Go to" }), model.pages.map((item) => (_jsxs("div", { children: [_jsxs("button", { type: "button", className: `nav-sb-row${item.active ? ' is-active' : ''}`, "aria-current": item.active ? 'page' : undefined, title: item.title, onClick: item.onClick, children: [item.icon, _jsx("span", { className: "nav-sb-label", children: item.label }), item.aside ? _jsx("span", { className: "nav-sb-aside", children: item.aside }) : null] }), item.key === model.projectsAfter
                        ? model.projects.map((project) => (_jsxs("button", { type: "button", className: `nav-sb-row is-sub${project.active ? ' is-active' : ''}`, "aria-current": project.active ? 'page' : undefined, title: project.title, onClick: () => model.onProject(project.id), children: [_jsx("span", { className: "pj-dot", style: { background: project.color } }), _jsx("span", { className: "nav-sb-label", children: project.name })] }, project.id)))
                        : null] }, item.key))), _jsx("div", { style: { flexGrow: 1 } }), _jsx("span", { className: "nav-sb-cap", children: "Show beside the page" }), model.panels.map((panel) => (_jsxs("button", { type: "button", role: "switch", "aria-checked": panel.on, className: "nav-sb-row", title: panel.title, onClick: panel.onClick, children: [panel.icon, _jsx("span", { className: "nav-sb-label", children: panel.label }), _jsx("span", { className: `nav-switch${panel.on ? ' is-on' : ''}`, "aria-hidden": "true" })] }, panel.key))), _jsx("span", { className: "nav-sb-line" }), _jsxs("div", { className: "nav-sb-foot", children: [model.compute?.(true), model.progress, model.account, _jsxs("button", { type: "button", className: "nav-sb-row", onClick: model.onSettings, title: model.settingsTitle, children: [model.settingsIcon, _jsx("span", { className: "nav-sb-label", children: "Settings" })] })] })] }));
}
/** For the labelled rail: the panels as switches at the top of the page, beside what they open into. */
export function PanelBar({ panels, where }) {
    return (_jsxs("div", { className: "nav-panelbar", children: [_jsx("span", { className: "nav-panelbar-where", children: where }), _jsx("span", { style: { flex: 1 } }), _jsx("span", { className: "nav-panelbar-cap", children: "Beside the page" }), _jsx("div", { className: "nav-panelbar-group", role: "group", "aria-label": "Panels beside the page", children: panels.map((panel) => (_jsxs("button", { type: "button", "aria-pressed": panel.on, title: panel.title, onClick: panel.onClick, children: [panel.icon, _jsx("span", { children: panel.label })] }, panel.key))) })] }));
}
/** For the edge layout: the panels as drawer tabs on the right edge of the page. */
export function EdgeTabs({ panels }) {
    return (_jsx("div", { className: "nav-edge", role: "group", "aria-label": "Panels beside the page", children: panels.map((panel) => (_jsxs("button", { type: "button", "aria-pressed": panel.on, title: `${panel.label} — ${panel.title}`, onClick: panel.onClick, children: [panel.icon, _jsx("span", { children: panel.label })] }, panel.key))) }));
}
