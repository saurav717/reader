import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Project mode: the projects side by side (the board), one project's
// overview, and its workspace — a paper of the project beside the project's
// code. A switch at the top of every one of them goes between the three, and
// Settings says which of the last two a project opens on.
//
// A project is a collection with a project record (src/lib/projects.ts): its
// papers are the collection's, so adding one from a search is adding it to
// that collection, and a paper can be in several projects at once.
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { ROLES, byRole, continueWith, initialsOf, lastActive, newProjectInfo, papersIn, plainCollections, projectsOf, readingState, roleLabel, sharedWith, toggledIn, whenSaid, withRole, } from '../lib/projects';
import { authorLine } from '../lib/libraryLook';
import { COLLECTION_COLORS } from '../types';
import Playground, { ComputeTag, WhereDialog } from './Playground';
import PaperWindow from './PaperWindow';
import Reader from './Reader';
import Discover from './Discover';
import { CiteButtons, DraftEditor, OpenOverleaf, OverleafCard } from './Overleaf';
import WritePage from './Write';
import { ComputeSwitch } from './Compute';
import { COLAB, computeId, isOn, serversOn, switchesOnCards } from '../lib/compute';
import { overleafViewOf } from '../lib/overleaf';
import { CodeGitHub, ProjectConnections } from './Connections';
import { ArrowLeftIcon, CheckIcon, ChevronDownIcon, CloseIcon, CodeIcon, GridIcon, PlusIcon, TrashIcon } from './icons';
const year = (published) => (published ? new Date(published).getFullYear() || '' : '');
const newTodoId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
/** The view a project opens on, from the rail or the board: the choice in Settings. */
export function projectView(id, opensOn) {
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
    }
    catch {
        // the page opens without it
    }
    window.dispatchEvent(new Event(NEW_PROJECT));
}
export const lastProject = () => {
    try {
        return localStorage.getItem(LAST_PROJECT);
    }
    catch {
        return null;
    }
};
export default function ProjectsPage({ view, onView, onOpenPaper, onAddPapers, }) {
    const { collections, settings } = useStore();
    const projects = useMemo(() => projectsOf(collections), [collections]);
    // "New project…" from the rail's project menus: the page opens with the dialog up.
    const [creating, setCreating] = useState(() => {
        try {
            const asked = sessionStorage.getItem(NEW_PROJECT) === '1';
            sessionStorage.removeItem(NEW_PROJECT);
            return asked;
        }
        catch {
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
            }
            catch {
                // nothing kept
            }
            setCreating(true);
        };
        window.addEventListener(NEW_PROJECT, ask);
        return () => window.removeEventListener(NEW_PROJECT, ask);
    }, []);
    useEffect(() => {
        if (!project)
            return;
        try {
            localStorage.setItem(LAST_PROJECT, project.id);
        }
        catch {
            // only a convenience
        }
    }, [project]);
    const header = (_jsx(ProjectBar, { projects: projects, current: project, mode: view.kind === 'projects' ? 'board' : view.mode === 'read' || view.mode === 'workspace' || view.mode === 'write' ? view.mode : 'overview', onView: onView, onNew: () => setCreating(true) }));
    let body;
    if (view.kind === 'projects') {
        body = _jsx(ProjectBoard, { projects: projects, onEnter: (id, mode) => onView(mode ? { kind: 'project', id, ...(mode === 'workspace' ? { mode } : {}) } : projectView(id, opensOn)), onNew: () => setCreating(true) });
    }
    else if (!project) {
        body = (_jsx("div", { className: "pj-scroll", children: _jsxs("div", { className: "pj-empty", children: [_jsx("h1", { children: "No project here" }), _jsx("p", { children: "It may have been deleted, or it was made by another account. Projects are kept with your library." }), _jsx("button", { type: "button", className: "btn primary", onClick: () => onView({ kind: 'projects' }), children: "See your projects" })] }) }));
    }
    else if (view.mode === 'write') {
        body = _jsx(WritePage, { project: project, onView: onView }, project.id);
    }
    else if (view.mode === 'read' || view.mode === 'workspace') {
        body = _jsx(ProjectWorkspace, { project: project, focus: view.mode === 'read' ? 'read' : 'code', onView: onView, onOpenPaper: onOpenPaper }, `${project.id}:${view.mode}`);
    }
    else {
        body = _jsx(ProjectOverview, { project: project, projects: projects, onView: onView, onOpenPaper: onOpenPaper, onAddPapers: onAddPapers }, project.id);
    }
    return (_jsxs("main", { className: `main pj-page${view.kind === 'project' && (view.mode === 'read' || view.mode === 'workspace') ? ' is-workspace' : ''}${view.kind === 'project' && view.mode === 'write' ? ' is-workspace is-write' : ''}`, children: [header, body, creating ? (_jsx(NewProjectDialog, { onClose: () => setCreating(false), onCreated: (id) => {
                    setCreating(false);
                    onView({ kind: 'project', id });
                } })) : null] }));
}
/** Across the top of every project page: which project, and which of the three views. */
function ProjectBar({ projects, current, mode, onView, onNew, }) {
    const [picking, setPicking] = useState(false);
    // From the board, a view asks which project rather than guessing one: the one picked opens on it.
    const [pickFor, setPickFor] = useState(null);
    const pickRef = useRef(null);
    useEffect(() => {
        if (!picking)
            return;
        const away = (event) => {
            if (!pickRef.current?.contains(event.target))
                setPicking(false);
        };
        window.addEventListener('pointerdown', away);
        return () => window.removeEventListener('pointerdown', away);
    }, [picking]);
    const open = (next) => {
        if (!current) {
            setPickFor(next);
            setPicking(true);
            return;
        }
        onView(next === 'overview' ? { kind: 'project', id: current.id } : { kind: 'project', id: current.id, mode: next });
    };
    const none = projects.length === 0;
    return (_jsxs("div", { className: "pj-bar", children: [_jsxs("div", { className: "pj-which", ref: pickRef, children: [_jsxs("button", { type: "button", className: "pj-which-btn", "aria-expanded": picking, "aria-haspopup": "menu", onClick: () => (setPickFor(null), setPicking(!picking)), children: [current ? _jsx("span", { className: "pj-mark sm", style: { background: current.color }, children: initialsOf(current.name) }) : _jsx(GridIcon, { size: 15 }), _jsx("span", { className: "pj-which-name", children: current ? current.name : 'All projects' }), _jsx(ChevronDownIcon, { size: 13 })] }), picking ? (_jsxs("div", { className: "pj-menu", role: "menu", children: [pickFor ? (_jsx("span", { className: "eyebrow", children: "Which project?" })) : (_jsxs("button", { type: "button", role: "menuitem", onClick: () => (setPicking(false), onView({ kind: 'projects' })), children: [_jsx(GridIcon, { size: 14 }), " All projects"] })), projects.map((project) => (_jsxs("button", { type: "button", role: "menuitem", "aria-current": project.id === current?.id ? 'true' : undefined, onClick: () => {
                                    setPicking(false);
                                    const next = pickFor ?? mode;
                                    onView(next === 'read' || next === 'workspace' || next === 'write' ? { kind: 'project', id: project.id, mode: next } : { kind: 'project', id: project.id });
                                }, children: [_jsx("span", { className: "pj-dot", style: { background: project.color } }), project.name, project.id === current?.id ? _jsx(CheckIcon, { size: 12 }) : null] }, project.id))), _jsxs("button", { type: "button", role: "menuitem", className: "pj-menu-new", onClick: () => (setPicking(false), onNew()), children: [_jsx(PlusIcon, { size: 13 }), " New project\u2026"] })] })) : null] }), _jsx("div", { className: "segmented pj-views", role: "group", "aria-label": "Project overview", children: _jsx("button", { type: "button", "aria-pressed": mode === 'overview', disabled: none, onClick: () => open('overview'), title: "One project: what to read next, its papers, its code, its paper", children: "Overview" }) }), _jsxs("div", { className: "segmented pj-views", role: "group", "aria-label": "Project view", children: [_jsx("button", { type: "button", "aria-pressed": mode === 'read', disabled: none, onClick: () => open('read'), title: "The project\u2019s papers, one at a time", children: "Read" }), _jsx("button", { type: "button", "aria-pressed": mode === 'workspace', disabled: none, onClick: () => open('workspace'), title: "The workspace: the project\u2019s code, a paper beside it, or the paper alone", children: "Code" }), _jsx("button", { type: "button", "aria-pressed": mode === 'write', disabled: none, onClick: () => open('write'), title: "The project\u2019s paper: its LaTeX and the PDF it makes, synced with Overleaf", children: "Write" })] }), _jsx("div", { style: { flex: 1 } }), _jsxs("button", { type: "button", className: "btn sm", onClick: onNew, children: [_jsx(PlusIcon, { size: 13 }), " New project"] })] }));
}
// ------------------------------------------------------------ the board --
function ProjectBoard({ projects, onEnter, onNew }) {
    const { papers } = useStore();
    const playgrounds = usePlaygrounds();
    useEffect(() => {
        void loadPlaygrounds();
    }, []);
    const ordered = useMemo(() => projects.slice().sort((a, b) => lastActive(b, papers).localeCompare(lastActive(a, papers))), [projects, papers]);
    if (!projects.length) {
        return (_jsx("div", { className: "pj-scroll", children: _jsxs("div", { className: "pj-empty", children: [_jsx("span", { className: "eyebrow", children: "Projects" }), _jsx("h1", { children: "Keep each piece of research together" }), _jsx("p", { children: "A project holds the papers one question needs \u2014 the ones it builds on, the baselines, the related work \u2014 with a to-do list and code of its own. Researchers usually have three or four going at once: add a paper from any search to whichever it belongs to, and read it beside the project\u2019s code." }), _jsxs("button", { type: "button", className: "btn primary", onClick: onNew, children: [_jsx(PlusIcon, { size: 14 }), " Start a project"] })] }) }));
    }
    const count = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'][projects.length] ?? String(projects.length);
    return (_jsxs("div", { className: "pj-scroll", children: [_jsxs("div", { className: "pj-hero", children: [_jsx("span", { className: "eyebrow", children: "Projects" }), _jsxs("h1", { children: [count, " ", projects.length === 1 ? 'thing' : 'things', " on the go"] })] }), _jsx(ProjectConnections, {}), _jsxs("div", { className: "pj-board", children: [ordered.map((project) => {
                        const mine = papersIn(project.id, papers);
                        const reading = continueWith(project, papers);
                        const todos = project.project.todos.filter((todo) => !todo.done).slice(0, 3);
                        const code = playgrounds.find((item) => item.id === project.project.playgroundId);
                        const shared = sharedWith(project, projects, papers);
                        return (_jsxs("article", { className: "pj-card", style: { '--pj': project.color }, children: [_jsxs("div", { className: "pj-card-top", children: [_jsx("span", { className: "eyebrow pj-tint", children: whenSaid(lastActive(project, papers)) }), _jsx("h2", { children: project.name }), project.project.question ? _jsx("p", { className: "pj-question", children: project.project.question }) : null, _jsxs("p", { className: "pj-counts", children: [_jsx("b", { children: mine.length }), " ", mine.length === 1 ? 'paper' : 'papers', _jsxs("span", { children: [_jsx("b", { children: project.project.todos.filter((todo) => !todo.done).length }), " to do"] }), code ? (_jsxs("span", { className: "pj-code-tag", children: [_jsx(CodeIcon, { size: 12 }), " ", code.title] })) : null] })] }), reading ? (_jsxs("div", { className: "pj-card-part", children: [_jsx("span", { className: "eyebrow", children: readingState(reading) === 'reading' ? 'Reading' : 'Up next' }), _jsx("span", { className: "pj-paper-title", children: reading.title }), _jsx("span", { className: "pj-bar-track", children: _jsx("span", { style: { width: `${Math.round(reading.progress * 100)}%` } }) })] })) : null, todos.length ? (_jsxs("div", { className: "pj-card-part", children: [_jsx("span", { className: "eyebrow", children: "Next up" }), _jsx("ul", { className: "pj-mini-todos", children: todos.map((todo) => (_jsx("li", { children: todo.text }, todo.id))) })] })) : null, shared.length ? (_jsxs("div", { className: "pj-card-part", children: [_jsx("span", { className: "eyebrow", children: "Shared with" }), shared.slice(0, 3).map((item) => (_jsxs("span", { className: "pj-shared", children: [_jsx("span", { className: "pj-dot", style: { background: item.project.color } }), " ", item.count, " with ", item.project.name] }, item.project.id)))] })) : null, _jsxs("div", { className: "pj-card-actions", children: [_jsx("button", { type: "button", className: "btn primary sm", onClick: () => onEnter(project.id, 'overview'), children: "Overview" }), _jsxs("button", { type: "button", className: "btn sm", onClick: () => onEnter(project.id, 'workspace'), children: [_jsx(CodeIcon, { size: 13 }), " Workspace"] })] })] }, project.id));
                    }), _jsxs("button", { type: "button", className: "pj-card pj-card-new", onClick: onNew, children: [_jsx(PlusIcon, { size: 18 }), "New project", _jsx("span", { children: "Start empty, or turn a collection into one" })] })] })] }));
}
// --------------------------------------------------------- the overview --
function ProjectOverview({ project, projects, onView, onOpenPaper, onAddPapers, }) {
    const { papers, highlights, updateCollection, setPaperCollections, renameCollection, deleteCollection } = useStore();
    const info = project.project;
    const groups = byRole(project, papers);
    const reading = continueWith(project, papers);
    const shared = sharedWith(project, projects, papers);
    const highlightCount = useMemo(() => {
        const counts = new Map();
        for (const highlight of highlights)
            counts.set(highlight.paperId, (counts.get(highlight.paperId) ?? 0) + 1);
        return counts;
    }, [highlights]);
    const setInfo = (change) => void updateCollection(project.id, (collection) => ({ project: change({ ...info, ...(collection.project ?? {}) }) }));
    const [editingQuestion, setEditingQuestion] = useState(false);
    const [question, setQuestion] = useState(info.question);
    const [todo, setTodo] = useState('');
    const [managing, setManaging] = useState(false);
    const mine = papersIn(project.id, papers);
    return (_jsxs("div", { className: "pj-scroll", style: { '--pj': project.color }, children: [_jsxs("div", { className: "pj-hero pj-hero-row", children: [_jsxs("div", { style: { minWidth: 0 }, children: [_jsxs("span", { className: "eyebrow pj-tint", children: ["Project \u00B7 since ", new Date(info.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })] }), _jsx("h1", { children: project.name }), editingQuestion ? (_jsxs("form", { className: "pj-question-edit", onSubmit: (event) => {
                                    event.preventDefault();
                                    setInfo((current) => ({ ...current, question: question.trim() }));
                                    setEditingQuestion(false);
                                }, children: [_jsx("input", { autoFocus: true, value: question, placeholder: "The question this project is asking", onChange: (event) => setQuestion(event.target.value) }), _jsx("button", { type: "submit", className: "btn primary sm", children: "Save" }), _jsx("button", { type: "button", className: "btn ghost sm", onClick: () => (setQuestion(info.question), setEditingQuestion(false)), children: "Cancel" })] })) : (_jsx("button", { type: "button", className: "pj-question pj-question-btn", onClick: () => setEditingQuestion(true), title: "Change the question", children: info.question || 'Add the question this project is asking…' }))] }), _jsxs("div", { className: "pj-hero-actions", children: [_jsxs("button", { type: "button", className: "btn", onClick: onAddPapers, title: "Search the indexes; what you add goes into this project", children: [_jsx(PlusIcon, { size: 14 }), " Add papers"] }), _jsx("button", { type: "button", className: "btn primary", onClick: () => onView({ kind: 'project', id: project.id, mode: 'workspace' }), children: "Open workspace \u2192" })] })] }), _jsxs("div", { className: "pj-top", children: [_jsx("section", { className: "pj-panel pj-continue", children: reading ? (_jsxs(_Fragment, { children: [_jsx("span", { className: "eyebrow", children: readingState(reading) === 'reading' ? `Continue reading · ${Math.round(reading.progress * 100)}%` : 'Up next' }), _jsx("h3", { children: reading.title }), _jsxs("p", { className: "pj-sub", children: [authorLine(reading.authors, 3), reading.published ? ` · ${year(reading.published)}` : ''] }), _jsx("span", { className: "pj-bar-track", children: _jsx("span", { style: { width: `${Math.round(reading.progress * 100)}%` } }) }), _jsxs("div", { className: "pj-row", children: [_jsx("button", { type: "button", className: "btn primary sm", onClick: () => onOpenPaper(reading.id), children: readingState(reading) === 'reading' ? 'Resume' : 'Start reading' }), _jsx("button", { type: "button", className: "btn sm", onClick: () => (rememberWorkspacePaper(project.id, reading.id), onView({ kind: 'project', id: project.id, mode: 'workspace' })), children: "Beside the code" })] })] })) : (_jsxs(_Fragment, { children: [_jsx("span", { className: "eyebrow", children: "Nothing to read yet" }), _jsx("p", { className: "pj-sub", children: "Add the papers this project needs: search from Discover, or from Home, and pick this project in \u201CAdd to\u201D." }), _jsx("div", { className: "pj-row", children: _jsxs("button", { type: "button", className: "btn primary sm", onClick: onAddPapers, children: [_jsx(PlusIcon, { size: 13 }), " Add papers"] }) })] })) }), _jsx(CodeCard, { project: project, onView: onView }), _jsxs("section", { className: "pj-panel", children: [_jsx("span", { className: "eyebrow", children: "Next up" }), _jsx("ul", { className: "pj-todos", children: info.todos.map((item) => (_jsxs("li", { className: item.done ? 'is-done' : undefined, children: [_jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: item.done, onChange: () => setInfo((current) => ({ ...current, todos: current.todos.map((t) => (t.id === item.id ? { ...t, done: !t.done } : t)) })) }), _jsx("span", { children: item.text })] }), _jsx("button", { type: "button", className: "icon-btn pj-x", "aria-label": `Remove “${item.text}”`, onClick: () => setInfo((current) => ({ ...current, todos: current.todos.filter((t) => t.id !== item.id) })), children: _jsx(CloseIcon, { size: 12 }) })] }, item.id))) }), _jsx("form", { className: "pj-todo-add", onSubmit: (event) => {
                                    event.preventDefault();
                                    const text = todo.trim();
                                    if (!text)
                                        return;
                                    setInfo((current) => ({ ...current, todos: [...current.todos, { id: newTodoId(), text, done: false }] }));
                                    setTodo('');
                                }, children: _jsx("input", { value: todo, placeholder: "Add a step \u2014 \u201Creplicate Table 2\u201D", onChange: (event) => setTodo(event.target.value) }) })] })] }), _jsx("div", { className: "pj-paper-row", children: _jsx(OverleafCard, { project: project, onWrite: () => onView({ kind: 'project', id: project.id, mode: 'write' }), onWorkspace: () => {
                        writeWs(WS_LAYOUT, 'write');
                        onView({ kind: 'project', id: project.id, mode: 'workspace' });
                    } }) }), _jsxs("div", { className: "pj-section-head", children: [_jsxs("span", { className: "eyebrow", children: ["Papers in this project \u00B7 ", mine.length] }), _jsx("span", { className: "pj-hint", children: "Give each a role: what the project builds on, measures against, borrows, or cites." })] }), groups.length ? (groups.map((group) => (_jsxs("div", { className: "pj-group", children: [_jsx("h4", { className: "pj-group-head", children: group.label }), _jsx("div", { className: "pj-papers", children: group.papers.map((paper) => (_jsx(PaperCard, { paper: paper, role: info.roles[paper.id], highlights: highlightCount.get(paper.id) ?? 0, others: projects.filter((other) => other.id !== project.id && paper.collectionIds.includes(other.id)), onOpen: () => onOpenPaper(paper.id), onBeside: () => (rememberWorkspacePaper(project.id, paper.id), onView({ kind: 'project', id: project.id, mode: 'workspace' })), onRole: (role) => setInfo((current) => withRole(current, paper.id, role)), onRemove: () => {
                                void setPaperCollections(paper.id, toggledIn(paper.collectionIds, project.id, false));
                                setInfo((current) => withRole(current, paper.id, null));
                            } }, paper.id))) })] }, group.label)))) : (_jsx("p", { className: "pj-none", children: "No papers yet." })), shared.length ? (_jsxs("div", { className: "pj-shared-row", children: [_jsx("span", { className: "eyebrow", children: "Shared with other projects" }), shared.map((item) => (_jsxs("button", { type: "button", className: "pj-chip", onClick: () => onView({ kind: 'project', id: item.project.id }), children: [_jsx("span", { className: "pj-dot", style: { background: item.project.color } }), " ", item.count, " with ", item.project.name] }, item.project.id)))] })) : null, _jsxs("div", { className: "pj-manage", children: [_jsx("button", { type: "button", className: "link-btn", onClick: () => setManaging(!managing), "aria-expanded": managing, children: "Project settings" }), managing ? (_jsxs("div", { className: "pj-manage-body", children: [_jsxs("label", { className: "pj-field-row", children: [_jsx("span", { children: "Name" }), _jsx("input", { defaultValue: project.name, onBlur: (event) => event.target.value.trim() && event.target.value !== project.name && void renameCollection(project.id, event.target.value) })] }), _jsxs("div", { className: "pj-field-row", children: [_jsx("span", { children: "Colour" }), _jsx(Swatches, { value: project.color, onPick: (color) => void updateCollection(project.id, { color }) })] }), _jsxs("div", { className: "pj-row", children: [_jsx("button", { type: "button", className: "btn sm", title: "Its papers stay in the collection; the question, roles and to-dos go", onClick: () => {
                                            if (!window.confirm(`Turn “${project.name}” back into a plain collection? Its papers stay; its question, roles and to-do list are dropped.`))
                                                return;
                                            void updateCollection(project.id, { project: undefined });
                                            onView({ kind: 'collection', id: project.id });
                                        }, children: "Turn back into a collection" }), _jsxs("button", { type: "button", className: "btn sm danger", onClick: () => {
                                            if (!window.confirm(`Delete the project “${project.name}”? Its papers stay in your library and in their other collections.`))
                                                return;
                                            void deleteCollection(project.id);
                                            onView({ kind: 'projects' });
                                        }, children: [_jsx(TrashIcon, { size: 13 }), " Delete project"] })] })] })) : null] })] }));
}
function PaperCard({ paper, role, highlights, others, onOpen, onBeside, onRole, onRemove, }) {
    const state = readingState(paper);
    return (_jsxs("article", { className: "pj-paper", children: [_jsxs("div", { className: "pj-paper-head", children: [_jsxs("select", { className: "pj-role", value: role ?? '', onChange: (event) => onRole((event.target.value || null)), "aria-label": "Role in this project", children: [_jsx("option", { value: "", children: "Unsorted" }), ROLES.map((item) => (_jsx("option", { value: item.id, children: item.label }, item.id)))] }), _jsx("span", { className: `pj-state is-${state.replace(' ', '-')}`, children: state === 'reading' ? `${Math.round(paper.progress * 100)}%` : state }), _jsx("button", { type: "button", className: "icon-btn pj-x", "aria-label": "Take it out of this project", title: "Take it out of this project (it stays in your library)", onClick: onRemove, children: _jsx(CloseIcon, { size: 12 }) })] }), _jsx("button", { type: "button", className: "pj-paper-title-btn", onClick: onOpen, children: paper.title }), _jsxs("span", { className: "pj-sub", children: [authorLine(paper.authors, 2), paper.published ? ` · ${year(paper.published)}` : ''] }), _jsxs("div", { className: "pj-paper-foot", children: [highlights ? _jsxs("span", { className: "pj-chip static", children: [highlights, " highlights"] }) : null, others.map((other) => (_jsxs("span", { className: "pj-chip static", title: `Also in ${other.name}`, children: [_jsx("span", { className: "pj-dot", style: { background: other.color } }), initialsOf(other.name)] }, other.id))), _jsx("button", { type: "button", className: "link-btn pj-beside", onClick: onBeside, children: "Beside the code" })] })] }));
}
/** The project's code: the playground that holds it, or the ways to give it one. */
function CodeCard({ project, onView }) {
    const playgrounds = usePlaygrounds();
    useEffect(() => {
        void loadPlaygrounds();
    }, []);
    const code = playgrounds.find((item) => item.id === project.project.playgroundId);
    return (_jsxs("section", { className: "pj-panel", children: [_jsx("span", { className: "eyebrow", children: "Code" }), code ? (_jsxs(_Fragment, { children: [_jsxs("h3", { className: "pj-code-title", children: [_jsx(CodeIcon, { size: 15 }), " ", code.title] }), _jsxs("p", { className: "pj-sub", children: [_jsx(ComputeTag, { compute: code.compute, home: code.home }), " \u00B7 changed ", whenSaid(new Date(code.updated).toISOString())] }), _jsxs("div", { className: "pj-row", children: [_jsx("button", { type: "button", className: "btn primary sm", onClick: () => onView({ kind: 'project', id: project.id, mode: 'workspace' }), children: "Open beside the papers" }), _jsx("button", { type: "button", className: "btn sm", onClick: () => onView({ kind: 'playground', id: code.id }), children: "Full screen" })] })] })) : (_jsxs(_Fragment, { children: [_jsx("p", { className: "pj-sub", children: "No code yet. Give the project a folder of files, an editor and a console \u2014 on Colab, this computer or a GPU elsewhere." }), _jsx("div", { className: "pj-row", children: _jsx("button", { type: "button", className: "btn primary sm", onClick: () => onView({ kind: 'project', id: project.id, mode: 'workspace' }), children: "Set up code" }) })] }))] }));
}
// -------------------------------------------------------- the workspace --
const WS_PAPER = (id) => `reader.project.${id}.paper`;
const WS_LAYOUT = 'reader.project.layout';
const WS_SPLIT = 'reader.project.split';
const WS_TREE = 'reader.project.tree';
function rememberWorkspacePaper(projectId, paperId) {
    try {
        localStorage.setItem(WS_PAPER(projectId), paperId);
    }
    catch {
        // only a convenience
    }
}
function writeWs(key, value) {
    try {
        localStorage.setItem(key, value);
    }
    catch {
        // only a convenience
    }
}
function readWs(key, allowed, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw && allowed.includes(raw) ? raw : fallback;
    }
    catch {
        return fallback;
    }
}
function ProjectWorkspace({ project, focus, onView, onOpenPaper }) {
    const { papers, highlights, updateCollection, settings } = useStore();
    const mine = papersIn(project.id, papers);
    const writing = overleafViewOf(settings);
    const overleaf = project.project.overleaf;
    const [paperId, setPaperId] = useState(() => {
        try {
            return localStorage.getItem(WS_PAPER(project.id));
        }
        catch {
            return null;
        }
    });
    const shown = mine.find((paper) => paper.id === paperId) ?? continueWith(project, papers) ?? mine[0];
    // With nothing to read, the search takes the cursor as the page opens.
    const [findAt] = useState(() => Date.now());
    // Full code is where a project's work is done: the papers are a strip above it, a card each, and a window over it.
    const [chosenLayout, setLayoutState] = useState(() => readWs(WS_LAYOUT, ['paper', 'both', 'code', 'write'], 'code'));
    // Read is the paper alone; Code is the whole workspace. Write is there only while Settings puts the writing in the workspace.
    const layout = focus === 'read' ? 'paper' : chosenLayout === 'write' && writing !== 'write' ? 'both' : chosenLayout;
    const [floating, setFloating] = useState(null);
    const setLayout = (next) => {
        setLayoutState(next);
        if (next !== 'code')
            setFloating(null);
        try {
            localStorage.setItem(WS_LAYOUT, next);
        }
        catch {
            // only a convenience
        }
    };
    const [treeOpen, setTreeOpenState] = useState(() => readWs(WS_TREE, ['open', 'shut'], 'open') === 'open');
    const setTreeOpen = (open) => {
        setTreeOpenState(open);
        try {
            localStorage.setItem(WS_TREE, open ? 'open' : 'shut');
        }
        catch {
            // only a convenience
        }
    };
    // How much of the room the paper takes beside the code, dragged at the line between them.
    const [split, setSplit] = useState(() => {
        try {
            const saved = Number(localStorage.getItem(WS_SPLIT));
            return saved > 0.2 && saved < 0.8 ? saved : 0.4;
        }
        catch {
            return 0.4;
        }
    });
    const panes = useRef(null);
    const drag = (event) => {
        const box = panes.current?.getBoundingClientRect();
        if (!box)
            return;
        event.preventDefault();
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        let last = split;
        const move = (e) => {
            last = Math.min(0.78, Math.max(0.22, (e.clientX - box.left) / box.width));
            setSplit(last);
        };
        const up = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
            try {
                localStorage.setItem(WS_SPLIT, String(last));
            }
            catch {
                // only a convenience
            }
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
    };
    const [selectedHighlight, setSelectedHighlight] = useState(null);
    const playgrounds = usePlaygrounds();
    useEffect(() => {
        void loadPlaygrounds();
    }, []);
    const codeId = project.project.playgroundId;
    const code = playgrounds.find((item) => item.id === codeId);
    const pick = (id) => {
        setPaperId(id);
        rememberWorkspacePaper(project.id, id);
    };
    const floatPaper = mine.find((paper) => paper.id === floating);
    const link = (id) => void updateCollection(project.id, (collection) => ({ project: { ...project.project, ...(collection.project ?? {}), playgroundId: id } }));
    const showPaper = layout !== 'code';
    const showWrite = layout === 'write';
    const showCode = layout === 'both' || layout === 'code';
    const fullCode = layout === 'code';
    return (_jsxs("div", { className: "pj-ws", style: { '--pj': project.color }, children: [_jsxs("div", { className: "pj-ws-bar", children: [fullCode ? null : (_jsx("button", { type: "button", className: "icon-btn", "aria-pressed": treeOpen, "aria-label": "The project\u2019s papers", title: "The project\u2019s papers", onClick: () => setTreeOpen(!treeOpen), children: _jsx(ArrowLeftIcon, { size: 15, style: { transform: treeOpen ? undefined : 'rotate(180deg)' } }) })), focus === 'read' ? null : (_jsxs("div", { className: "segmented sm", role: "group", "aria-label": "What the workspace shows", children: [_jsx("button", { type: "button", "aria-pressed": layout === 'code', onClick: () => setLayout('code'), title: "The code fills the workspace; the papers are a strip above it", children: "Full code" }), _jsx("button", { type: "button", className: "pj-both", "aria-pressed": layout === 'both', onClick: () => setLayout('both'), title: "A paper and the code side by side", children: "Side by side" }), _jsx("button", { type: "button", "aria-pressed": layout === 'paper', onClick: () => setLayout('paper'), title: "Just the paper", children: "Paper" }), writing === 'write' ? (_jsx("button", { type: "button", "aria-pressed": layout === 'write', onClick: () => setLayout('write'), title: "The paper beside the draft you are writing", children: "Write" })) : null] })), !fullCode && shown ? _jsx("span", { className: "pj-ws-now", children: shown.title }) : null, writing === 'beside' && overleaf && !fullCode ? (_jsxs("span", { className: "pj-ws-overleaf", children: [_jsx(CiteButtons, { project: project, paper: shown }), _jsx(OpenOverleaf, { project: project, view: "beside", primary: false, compact: true })] })) : null, fullCode ? (_jsx(PaperStrip, { project: project, papers: mine, floating: floating, onFloat: (id) => (pick(id), setFloating(id)), onBeside: (id) => (pick(id), setLayout('both')), onOpenPaper: onOpenPaper, onAdd: () => onView({ kind: 'project', id: project.id }) })) : null, focus === 'code' ? (_jsx("span", { className: "pj-ws-github", children: _jsx(CodeGitHub, { project: project, code: code }) })) : null] }), _jsxs("div", { className: "pj-ws-body", children: [treeOpen && !fullCode ? (_jsxs("aside", { className: "pj-tree", "aria-label": "The project", children: [_jsxs("div", { className: "pj-tree-head", children: [_jsx("span", { className: "pj-dot", style: { background: project.color } }), project.name] }), _jsxs("span", { className: "pj-tree-sect", children: ["Papers \u00B7 ", mine.length] }), byRole(project, papers).map((group) => (_jsxs("div", { children: [_jsx("span", { className: "pj-tree-role", children: group.label }), group.papers.map((paper) => (_jsxs("button", { type: "button", className: `pj-tree-item${shown?.id === paper.id ? ' is-on' : ''}`, onClick: () => pick(paper.id), title: paper.title, children: [_jsx("span", { className: "pj-tree-title", children: paper.title }), _jsxs("span", { className: "pj-tree-meta", children: [readingState(paper) === 'reading' ? `${Math.round(paper.progress * 100)}%` : readingState(paper) === 'done' ? '✓' : '', highlights.some((h) => h.paperId === paper.id) ? ` · ${highlights.filter((h) => h.paperId === paper.id).length}✎` : ''] })] }, paper.id)))] }, group.label))), !mine.length ? _jsx("p", { className: "pj-tree-none", children: "No papers yet \u2014 search for some beside this." }) : null, _jsx("span", { className: "pj-tree-sect", children: "Code" }), code ? (_jsxs("div", { className: "pj-tree-code", children: [_jsxs("span", { className: "pj-tree-item is-static", children: [_jsx(CodeIcon, { size: 12 }), " ", code.title] }), _jsx("button", { type: "button", className: "link-btn", onClick: () => link(undefined), children: "Unlink" })] })) : (_jsx("p", { className: "pj-tree-none", children: "Not set up yet." })), _jsx("span", { className: "pj-tree-sect", children: "Next up" }), project.project.todos.filter((todo) => !todo.done).slice(0, 5).map((todo) => (_jsxs("span", { className: "pj-tree-todo", children: ["\u2610 ", todo.text] }, todo.id))), !project.project.todos.some((todo) => !todo.done) ? _jsx("p", { className: "pj-tree-none", children: "Nothing \u2014 add steps in the overview." }) : null] })) : null, _jsxs("div", { className: "pj-ws-panes", ref: panes, children: [showPaper ? (_jsx("div", { className: "pj-ws-pane pj-ws-paper", style: showCode || showWrite ? { flex: `0 0 ${split * 100}%` } : undefined, children: shown ? (_jsx(Reader, { paperId: shown.id, notesOpen: false, selectedHighlightId: selectedHighlight, onBack: () => onView({ kind: 'project', id: project.id }), onHome: () => onView({ kind: 'home' }), onToggleNotes: () => onOpenPaper(shown.id), onNotes: () => undefined, onToggleSidebar: () => setTreeOpen(!treeOpen), zen: false, onToggleZen: () => onOpenPaper(shown.id), onSelectHighlight: setSelectedHighlight, onOrphans: () => undefined }, shown.id)) : (_jsx("div", { className: "pj-ws-find", children: _jsx(Discover, { embedded: { title: `Add papers to ${project.name}` }, here: project.id, focus: findAt, onOpen: pick, onClose: () => undefined }) })) })) : null, showPaper && (showCode || showWrite) ? (_jsx("div", { className: "pj-ws-split", role: "separator", "aria-orientation": "vertical", "aria-label": "Drag to share the room between the paper and the code", tabIndex: 0, onPointerDown: drag, onKeyDown: (event) => {
                                    const step = event.key === 'ArrowLeft' ? -0.04 : event.key === 'ArrowRight' ? 0.04 : 0;
                                    if (step)
                                        setSplit((current) => Math.min(0.78, Math.max(0.22, current + step)));
                                } })) : null, showWrite ? (_jsx("div", { className: "pj-ws-pane pj-ws-code", children: _jsx(DraftEditor, { project: project, paper: shown }) })) : null, showCode ? (_jsx("div", { className: "pj-ws-pane pj-ws-code", children: code ? (_jsx(Playground, { id: code.id, onOpen: (id) => onView(id ? { kind: 'playground', id } : { kind: 'playground' }), onOpenPaper: onOpenPaper })) : (_jsx(SetUpCode, { project: project, papers: mine, missing: Boolean(codeId && !code), onLinked: link, onView: onView })) })) : null] })] }), fullCode && floatPaper ? (_jsx(PaperWindow, { paper: floatPaper, papers: mine, onPick: (id) => (pick(id), setFloating(id)), onDock: () => (pick(floatPaper.id), setLayout('both')), onOpenFull: () => onOpenPaper(floatPaper.id), onClose: () => setFloating(null) })) : null] }));
}
/**
 * Above the code in full-code mode: the project's papers, one chip each in
 * the colour of its role. A chip opens the paper's card — what it is, how far
 * in you are, its abstract and what you highlighted in it — which is most of
 * what the code needs from a paper, and is there even when its PDF cannot be
 * fetched. From the card the paper floats over the code, goes beside it, or
 * opens on its own page.
 */
function PaperStrip({ project, papers, floating, onFloat, onBeside, onOpenPaper, onAdd, }) {
    const { highlights } = useStore();
    const [card, setCard] = useState(null);
    const [finding, setFinding] = useState(false);
    const [query, setQuery] = useState('');
    const strip = useRef(null);
    useEffect(() => {
        if (!card && !finding)
            return;
        const away = (event) => {
            if (!strip.current?.contains(event.target))
                (setCard(null), setFinding(false));
        };
        const esc = (event) => event.key === 'Escape' && (setCard(null), setFinding(false));
        window.addEventListener('pointerdown', away);
        window.addEventListener('keydown', esc);
        return () => {
            window.removeEventListener('pointerdown', away);
            window.removeEventListener('keydown', esc);
        };
    }, [card, finding]);
    const roleOrder = (paper) => {
        const at = ROLES.findIndex((role) => role.id === project.project.roles[paper.id]);
        return at < 0 ? ROLES.length : at;
    };
    // The papers opened most recently, newest first, then the core ones not yet opened; the rest are one search away under "All N".
    const recent = (paper) => paper.lastOpenedAt ?? '';
    const ordered = papers
        .slice()
        .sort((a, b) => recent(b).localeCompare(recent(a)) || roleOrder(a) - roleOrder(b))
        .slice(0, STRIP_MAX);
    if (floating && !ordered.some((paper) => paper.id === floating)) {
        const extra = papers.find((paper) => paper.id === floating);
        if (extra)
            ordered.push(extra);
    }
    const open = papers.find((paper) => paper.id === card);
    const todo = project.project.todos.find((item) => !item.done);
    return (_jsxs("div", { className: "pj-strip", ref: strip, children: [_jsx("span", { className: "pj-strip-label", title: "The papers opened most recently", children: "Recent" }), _jsxs("div", { className: "pj-strip-chips", children: [ordered.map((paper) => {
                        const role = project.project.roles[paper.id];
                        const state = readingState(paper);
                        return (_jsxs("button", { type: "button", className: `pj-strip-chip role-${role ?? 'none'}${card === paper.id ? ' is-open' : ''}${floating === paper.id ? ' is-floating' : ''}`, "aria-expanded": card === paper.id, title: `${roleLabel(role)} · ${paper.title}`, onClick: () => setCard(card === paper.id ? null : paper.id), children: [_jsx("span", { className: "pj-strip-role", children: roleLabel(role).slice(0, 1) }), _jsx("span", { className: "pj-strip-title", children: shortTitle(paper.title) }), state === 'reading' ? _jsxs("span", { className: "pj-strip-pct", children: [Math.round(paper.progress * 100), "%"] }) : state === 'done' ? _jsx(CheckIcon, { size: 11 }) : null] }, paper.id));
                    }), !papers.length ? (_jsx("button", { type: "button", className: "link-btn", onClick: onAdd, children: "No papers yet \u2014 add some" })) : null] }), papers.length ? (_jsxs("button", { type: "button", className: `pj-strip-all${finding ? ' is-open' : ''}`, "aria-expanded": finding, onClick: () => (setCard(null), setFinding(!finding)), title: "Every paper in the project, searchable", children: ["All ", papers.length, " ", _jsx(ChevronDownIcon, { size: 12 })] })) : null, todo ? (_jsxs("span", { className: "pj-strip-todo", title: "Next on the project\u2019s to-do list", children: ["Next: ", todo.text] })) : null, finding ? (_jsx(PaperFinder, { project: project, papers: papers, query: query, onQuery: setQuery, marks: highlights, onPick: (id) => (setFinding(false), setCard(id)) })) : null, open ? (_jsx(PaperCardPop, { paper: open, role: project.project.roles[open.id], marks: highlights.filter((item) => item.paperId === open.id && !item.orphaned), floating: floating === open.id, onFloat: () => (onFloat(open.id), setCard(null)), onBeside: () => onBeside(open.id), onOpen: () => onOpenPaper(open.id) })) : null] }));
}
/** How many papers the strip shows before the rest go behind "All N". */
const STRIP_MAX = 6;
/**
 * Every paper in the project, behind "All N" on the strip: searched by title,
 * author, abstract and what you highlighted or noted in it, and grouped by role.
 */
function PaperFinder({ project, papers, query, onQuery, marks, onPick, }) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (paper) => {
        if (!words.length)
            return { ok: true, why: '' };
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
    return (_jsxs("div", { className: "pj-pop pj-find", role: "dialog", "aria-label": "The project\u2019s papers", children: [_jsx("input", { autoFocus: true, className: "pj-find-input", value: query, placeholder: `Search ${papers.length} papers — titles, authors, abstracts, your highlights and notes`, onChange: (event) => onQuery(event.target.value), onKeyDown: (event) => {
                    if (event.key === 'Enter' && first)
                        onPick(first.id);
                } }), _jsxs("div", { className: "pj-pop-body", children: [groups.map((group) => (_jsxs("div", { children: [_jsxs("span", { className: "pj-find-role", children: [group.label, " \u00B7 ", group.rows.length] }), group.rows.map(({ paper, why }) => {
                                const state = readingState(paper);
                                const count = marks.filter((mark) => mark.paperId === paper.id).length;
                                return (_jsxs("button", { type: "button", className: "pj-find-row", onClick: () => onPick(paper.id), children: [_jsx("span", { className: "pj-find-title", children: paper.title }), _jsxs("span", { className: "pj-find-meta", children: [authorLine(paper.authors, 1), paper.published ? ` · ${year(paper.published)}` : '', state === 'reading' ? ` · ${Math.round(paper.progress * 100)}%` : state === 'done' ? ' · read' : '', count ? ` · ${count} highlights` : ''] }), why ? _jsx("span", { className: "pj-find-why", children: why }) : null] }, paper.id));
                            })] }, group.label))), !groups.length ? _jsxs("p", { className: "pj-sub", children: ["Nothing in this project matches \u201C", query, "\u201D."] }) : null] })] }));
}
/** A paper's title cut to what fits a chip: up to its colon, else its first words. */
const shortTitle = (title) => {
    const head = title.split(/:\s/)[0];
    return head.length <= 34 ? head : `${head.slice(0, 32).replace(/\s+\S*$/, '')}…`;
};
function PaperCardPop({ paper, role, marks, floating, onFloat, onBeside, onOpen, }) {
    const state = readingState(paper);
    return (_jsxs("div", { className: "pj-pop", role: "dialog", "aria-label": paper.title, children: [_jsxs("span", { className: "eyebrow pj-tint", children: [roleLabel(role), " \u00B7 ", state === 'reading' ? `${Math.round(paper.progress * 100)}% read` : state] }), _jsx("h3", { children: paper.title }), _jsxs("p", { className: "pj-sub", children: [authorLine(paper.authors, 4), paper.published ? ` · ${year(paper.published)}` : '', paper.venue ? ` · ${paper.venue}` : '', paper.arxivId ? ` · arXiv:${paper.arxivId}` : ''] }), _jsxs("div", { className: "pj-pop-body", children: [paper.abstract ? _jsx("p", { className: "pj-pop-abstract", children: paper.abstract }) : null, marks.length ? (_jsxs(_Fragment, { children: [_jsxs("span", { className: "eyebrow", children: ["Your highlights \u00B7 ", marks.length] }), _jsx("ul", { className: "pj-pop-marks", children: marks.slice(0, 8).map((mark) => (_jsxs("li", { style: { borderColor: `var(--ul-${mark.color})` }, children: [_jsx("q", { children: mark.exact.length > 220 ? `${mark.exact.slice(0, 218)}…` : mark.exact }), mark.note ? _jsx("span", { className: "pj-pop-note", children: mark.note }) : null, mark.section ? _jsx("span", { className: "pj-pop-sect", children: mark.section }) : null] }, mark.id))) })] })) : !paper.abstract ? (_jsx("p", { className: "pj-sub", children: "Nothing kept from it yet: open it, and what you highlight shows here." })) : null] }), _jsxs("div", { className: "pj-row pj-pop-actions", children: [_jsx("button", { type: "button", className: "btn primary sm", onClick: onFloat, disabled: floating, children: floating ? 'Floating over the code' : 'Float over the code' }), _jsx("button", { type: "button", className: "btn sm", onClick: onBeside, children: "Side by side" }), _jsx("button", { type: "button", className: "btn ghost sm", onClick: onOpen, children: "Open its page" })] })] }));
}
/** In the code's place while the project has none: start a project of files, or link a playground made before. */
function SetUpCode({ project, papers, missing, onLinked, onView }) {
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
    return (_jsxs("div", { className: "pj-setup", children: [_jsx("span", { className: "eyebrow", children: "The project\u2019s code" }), _jsx("h2", { children: missing ? 'Its playground is not here' : 'Give this project code' }), _jsx("p", { children: missing
                    ? 'The playground this project was linked to is not in this browser or your Drive. Start a new one, or link another.'
                    : 'A folder of files, an editor, a console and an agent that knows the project’s papers — the same as a playground, kept beside the papers you read for it.' }), _jsxs("ul", { className: "pj-ready", "aria-label": "Where it can run", children: [_jsxs("li", { className: colabOk ? 'is-ok' : colabSetUp ? 'is-off' : 'is-missing', children: [_jsx("b", { children: "Colab" }), !colabSetUp ? (_jsxs("span", { children: ["needs ", colabNeeds.join(' and ') || 'a Google sign-in', " \u2014", ' ', _jsx("button", { type: "button", className: "link-btn", onClick: () => window.dispatchEvent(new Event(OPEN_SETTINGS)), children: "set it up in Settings" })] })) : colabOn ? (_jsxs("span", { children: ["ready \u2014 CPU and a T4 on the free tier", driveConnected ? ', the files kept in your Drive' : ''] })) : (_jsx("span", { children: "turned off \u2014 not offered as a place to run" })), switches && colabSetUp ? _jsx(ComputeSwitch, { id: COLAB, label: "Colab" }) : null] }), allComputers.length && switches ? (allComputers.map((server) => (_jsxs("li", { className: isOn(settings, computeId(server)) ? 'is-ok' : 'is-off', children: [_jsx("b", { children: "Your computer" }), _jsx("span", { children: isOn(settings, computeId(server)) ? `set up — ${server.name || 'this computer'}` : `${server.name || 'this computer'} — turned off` }), _jsx(ComputeSwitch, { id: computeId(server), label: server.name || 'This computer' })] }, server.id)))) : (_jsxs("li", { className: computers.length ? 'is-ok' : allComputers.length ? 'is-off' : 'is-missing', children: [_jsx("b", { children: "Your computer" }), computers.length ? (_jsxs("span", { children: ["set up \u2014 ", computers.map((server) => server.name || 'this computer').join(', ')] })) : allComputers.length ? (_jsx("span", { children: "turned off in Settings \u2192 Compute" })) : (_jsxs("span", { children: ["needs the Reader app, one command \u2014", ' ', _jsx("button", { type: "button", className: "link-btn", onClick: () => onView({ kind: 'playground' }), children: "connect this computer" })] }))] }))] }), switches ? (_jsx("button", { type: "button", className: "link-btn pj-manage-compute", onClick: openComputeSettings, children: "Manage compute \u2014 stop what runs, or turn places on and off" })) : null, _jsxs("div", { className: "pj-row", children: [_jsxs("button", { type: "button", className: "btn primary", onClick: () => setWhere(true), title: ready ? undefined : 'Nowhere to run it yet — see above', children: [_jsx(CodeIcon, { size: 14 }), " Start the project\u2019s code"] }), !ready ? _jsx("span", { className: "pj-hint", children: "You can look at the choices now; creating it waits for one of the two above." }) : null] }), playgrounds.length ? (_jsxs("div", { className: "pj-link-list", children: [_jsx("span", { className: "eyebrow", children: "Or link a playground you have" }), playgrounds.slice(0, 8).map((item) => (_jsxs("button", { type: "button", className: "pj-link-item", onClick: () => onLinked(item.id), children: [_jsx(CodeIcon, { size: 13 }), _jsx("span", { children: item.title }), _jsx(ComputeTag, { compute: item.compute, home: item.home })] }, item.id)))] })) : null, where ? (_jsx(WhereDialog, { draft: {
                    title: project.name,
                    kind: 'project',
                    start: papers.length ? 'paper' : 'blank',
                    cites,
                    files: { 'README.md': readme, 'main.py': '# Start here.\n' },
                }, onClose: () => setWhere(false), onCreate: async (spec) => {
                    const made = await createPlayground(spec);
                    setWhere(false);
                    onLinked(made.id);
                } })) : null] }));
}
// ------------------------------------------------------ a new project --
function Swatches({ value, onPick }) {
    return (_jsx("div", { className: "pj-swatches", role: "radiogroup", "aria-label": "Colour", children: COLLECTION_COLORS.map((color) => (_jsx("button", { type: "button", role: "radio", "aria-checked": value === color, "aria-label": color, className: "pj-swatch", style: { background: color }, onClick: () => onPick(color) }, color))) }));
}
export function NewProjectDialog({ onClose, onCreated, from }) {
    const { collections, papers, createCollection, updateCollection } = useStore();
    const plain = plainCollections(collections);
    const used = new Set(projectsOf(collections).map((project) => project.color));
    const [name, setName] = useState('');
    const [question, setQuestion] = useState('');
    const [color, setColor] = useState(() => COLLECTION_COLORS.find((item) => !used.has(item)) ?? COLLECTION_COLORS[0]);
    const [source, setSource] = useState(from ?? '');
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
            }
            else {
                const made = await createCollection(name.trim() || 'Untitled project');
                await updateCollection(made.id, { color, project: info });
                onCreated(made.id);
            }
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsxs(_Fragment, { children: [_jsx("div", { className: "scrim", onClick: busy ? undefined : onClose, role: "presentation" }), _jsxs("div", { className: "sheet narrow pj-new", role: "dialog", "aria-modal": "true", "aria-labelledby": "pj-new-title", children: [_jsx("span", { className: "eyebrow", children: "New project" }), _jsx("h2", { id: "pj-new-title", children: "What are you working on?" }), _jsxs("form", { onSubmit: (event) => {
                            event.preventDefault();
                            void create();
                        }, children: [_jsxs("label", { className: "pj-label", children: ["Name", _jsx("input", { autoFocus: true, value: name, placeholder: sourceName ?? 'Diffusion quantization', onChange: (event) => setName(event.target.value) })] }), _jsxs("label", { className: "pj-label", children: ["Research question ", _jsx("span", { className: "pj-hint", children: "\u2014 optional; shown on the project, and handed to its agent" }), _jsx("textarea", { rows: 2, value: question, placeholder: "Can DiT weights go to 4-bit post-training without FID collapse?", onChange: (event) => setQuestion(event.target.value) })] }), _jsxs("div", { className: "pj-label", children: ["Colour", _jsx(Swatches, { value: color, onPick: setColor })] }), _jsxs("div", { className: "pj-label", children: ["Start with", _jsxs("div", { className: "pj-chips", children: [_jsx("button", { type: "button", className: "pj-chip", "aria-pressed": !source, onClick: () => setSource(''), children: "Nothing yet" }), plain.map((collection) => {
                                                const count = papers.filter((paper) => paper.collectionIds.includes(collection.id)).length;
                                                return (_jsxs("button", { type: "button", className: "pj-chip", "aria-pressed": source === collection.id, onClick: () => setSource(collection.id), children: [_jsx("span", { className: "pj-dot", style: { background: collection.color } }), collection.name, " \u00B7 ", count] }, collection.id));
                                            })] }), source ? _jsxs("span", { className: "pj-hint", children: ["\u201C", sourceName, "\u201D becomes the project, with its papers. It stops being listed as a collection."] }) : null] }), _jsxs("div", { className: "dialog-actions", children: [_jsx("button", { type: "button", className: "btn ghost", onClick: onClose, disabled: busy, children: "Cancel" }), _jsxs("button", { type: "submit", className: "btn primary", disabled: busy, children: [busy ? _jsx("span", { className: "spinner" }) : null, " Create project"] })] })] })] })] }));
}
// ------------------------------------- file it anywhere, from a search --
/**
 * "Add to ▾" on a search result: every project and collection, a tick for
 * each one the paper is in — as many as you like — and its role in each
 * project. Ticking one adds the paper to the library first, if it is not in
 * it yet; unticking takes it out of that one only.
 */
export function AddToProject({ paperRef, onAdd, compact = false, align = 'left', }) {
    const { papers, collections, addPaper, createCollection, setPaperCollections, updateCollection } = useStore();
    const projects = useMemo(() => projectsOf(collections), [collections]);
    const plain = useMemo(() => plainCollections(collections), [collections]);
    // One list for the number keys: the projects, then the collections.
    const places = useMemo(() => [...projects, ...plain], [projects, plain]);
    const [open, setOpen] = useState(false);
    const [creating, setCreating] = useState(false);
    const [naming, setNaming] = useState(null);
    const ref = useRef(null);
    useEffect(() => {
        if (!open)
            return;
        const away = (event) => {
            if (!ref.current?.contains(event.target))
                (setOpen(false), setNaming(null));
        };
        const esc = (event) => {
            if (event.key === 'Escape')
                (setOpen(false), setNaming(null));
            const at = Number(event.key);
            if (at >= 1 && at <= 9 && places[at - 1] && !event.target?.closest('input, textarea, select')) {
                event.preventDefault();
                void toggle(places[at - 1]);
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
    const inPlaces = places.filter((place) => saved?.collectionIds.includes(place.id));
    const toggle = async (place) => {
        const now = papers.find((paper) => paper.id === paperRef.id);
        if (!now) {
            await (onAdd ? onAdd(paperRef, place.id) : addPaper(paperRef, place.id));
            return;
        }
        const on = !now.collectionIds.includes(place.id);
        await setPaperCollections(now.id, toggledIn(now.collectionIds, place.id, on));
        if (!on && place.project?.roles[now.id])
            void updateCollection(place.id, { project: withRole(place.project, now.id, null) });
    };
    const newCollection = async () => {
        const name = naming?.trim();
        setNaming(null);
        if (!name)
            return;
        const made = await createCollection(name);
        await (onAdd ? onAdd(paperRef, made.id) : addPaper(paperRef, made.id));
    };
    const row = (place, at) => {
        const on = Boolean(saved?.collectionIds.includes(place.id));
        const project = place.project ? place : null;
        return (_jsxs("div", { className: `pj-add-row${on ? ' is-on' : ''}`, children: [_jsxs("button", { type: "button", role: "menuitemcheckbox", "aria-checked": on, onClick: () => void toggle(place), children: [_jsx("span", { className: `pj-tick${on ? ' is-on' : ''}`, children: on ? _jsx(CheckIcon, { size: 11 }) : null }), _jsx("span", { className: project ? 'pj-dot' : 'swatch-dot', style: { background: place.color } }), _jsx("span", { className: "pj-add-name", children: place.name }), at < 9 ? _jsx("kbd", { children: at + 1 }) : null] }), on && saved && project ? (_jsx("div", { className: "pj-add-roles", role: "group", "aria-label": `Role in ${project.name}`, children: ROLES.map((role) => (_jsx("button", { type: "button", title: role.note, "aria-pressed": project.project.roles[saved.id] === role.id, onClick: () => void updateCollection(project.id, { project: withRole(project.project, saved.id, project.project.roles[saved.id] === role.id ? null : role.id) }), children: role.label }, role.id))) })) : null] }, place.id));
    };
    return (_jsxs("span", { className: "pj-add", ref: ref, children: [_jsxs("button", { type: "button", className: `btn sm${inPlaces.length ? ' pj-add-in' : ''}`, "aria-haspopup": "menu", "aria-expanded": open, title: "Put it in any of your projects and collections \u2014 as many as you like", onClick: () => setOpen(!open), children: [inPlaces.length ? (_jsxs(_Fragment, { children: [inPlaces.slice(0, 3).map((place) => (_jsx("span", { className: "pj-dot", style: { background: place.color } }, place.id))), inPlaces.length === 1 ? (compact ? 'In 1 place' : clipName(inPlaces[0].name)) : `In ${inPlaces.length} places`] })) : (_jsxs(_Fragment, { children: [_jsx(PlusIcon, { size: 12 }), " Add to\u2026"] })), _jsx(ChevronDownIcon, { size: 12 })] }), open ? (_jsxs("div", { className: `pj-menu pj-add-menu${align === 'right' ? ' is-right' : ''}`, role: "menu", children: [_jsx("span", { className: "eyebrow", children: "Projects" }), projects.map((project, at) => row(project, at)), !projects.length ? _jsx("p", { className: "pj-hint", style: { padding: '2px 8px 6px' }, children: "No projects yet." }) : null, _jsxs("button", { type: "button", role: "menuitem", className: "pj-add-new", onClick: () => (setOpen(false), setCreating(true)), children: [_jsx(PlusIcon, { size: 12 }), " New project\u2026"] }), _jsx("span", { className: "eyebrow pj-add-sect", children: "Collections" }), plain.map((collection, at) => row(collection, projects.length + at)), naming !== null ? (_jsx("form", { className: "pj-add-name-form", onSubmit: (event) => {
                            event.preventDefault();
                            void newCollection();
                        }, children: _jsx("input", { autoFocus: true, value: naming, placeholder: "Collection name", "aria-label": "Collection name", onChange: (event) => setNaming(event.target.value), onBlur: () => void newCollection() }) })) : (_jsxs("button", { type: "button", role: "menuitem", className: "pj-add-new", onClick: () => setNaming(''), children: [_jsx(PlusIcon, { size: 12 }), " New collection\u2026"] }))] })) : null, creating ? (_jsx(NewProjectDialog, { onClose: () => setCreating(false), onCreated: (id) => {
                    setCreating(false);
                    // A paper already in the library is added to the new project the same way: addPaper keeps its other collections.
                    void (onAdd ? onAdd(paperRef, id) : addPaper(paperRef, id));
                } })) : null] }));
}
const clipName = (name) => (name.length > 18 ? `${name.slice(0, 17)}…` : name);
// ------------------------------------------------------------ the rail --
/** The rail's way into projects: the board, and a mark for each project, the one open lit. */
export function RailProjects({ current, onBoard, onOpen, onBoardActive }) {
    const { collections } = useStore();
    const projects = projectsOf(collections);
    return (_jsxs("div", { className: "rail-projects", children: [_jsx("button", { type: "button", className: `icon-btn${onBoardActive ? ' is-active' : ''}`, "aria-current": onBoardActive ? 'page' : undefined, "aria-label": "Projects", title: "Projects \u2014 every project side by side", onClick: onBoard, children: _jsx(GridIcon, { size: 18 }) }), projects.slice(0, 6).map((project) => (_jsx("button", { type: "button", className: `pj-mark rail-mark${current === project.id ? ' is-on' : ''}`, style: { background: project.color }, "aria-current": current === project.id ? 'page' : undefined, "aria-label": `Project: ${project.name}`, title: `${project.name}${project.project.question ? ` — ${project.project.question}` : ''}`, onClick: () => onOpen(project.id), children: initialsOf(project.name) }, project.id)))] }));
}
