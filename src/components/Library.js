import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { STATUS_LABEL, STATUS_ORDER, statusOf } from '../lib/status';
import { coverFor } from '../lib/libraryLook';
import { hoverPaper, useNoteCounts } from '../lib/notes';
import { CheckIcon, ChevronDownIcon, ClockIcon, CloseIcon, GridIcon, InboxIcon, NoteIcon, PlusIcon, StackIcon, TrashIcon } from './icons';
import { plainCollections, projectsOf } from '../lib/projects';
import RemovePaperDialog from './RemovePaperDialog';
import { PAPERS_MIME, ProgressRing, carriesPapers, draggedPapers } from './LibraryBits';
/** Which papers the status groups below the nav are about. */
function scopeOf(papers, view, collectionId) {
    if (collectionId)
        return papers.filter((paper) => paper.collectionIds.includes(collectionId));
    if (view.kind === 'unsorted')
        return papers.filter((paper) => paper.collectionIds.length === 0);
    return papers;
}
const yearOf = (paper) => /^\d{4}/.exec(paper.published || '')?.[0];
export default function Library({ view, activePaperId, onSelect, onOpenPaper, onClose }) {
    const { papers, collections, createCollection, junk, setPaperCollections, setReadingStatus } = useStore();
    const projects = useMemo(() => projectsOf(collections), [collections]);
    const noteCounts = useNoteCounts();
    const [adding, setAdding] = useState(false);
    const [name, setName] = useState('');
    const [collapsed, setCollapsed] = useState([]);
    /** The nav item papers are being dragged over, to light it up. */
    const [over, setOver] = useState(null);
    const [removing, setRemoving] = useState(null);
    // Inside a project the panel is the project's papers alone, until asked for the whole library.
    const inProject = view.kind === 'project' ? projects.find((item) => item.id === view.id) : undefined;
    const [wide, setWide] = useState(false);
    useEffect(() => setWide(false), [inProject?.id]);
    const focused = Boolean(inProject && !wide);
    // Opening a paper leaves the view on the paper, so the panel remembers the
    // collection you came from rather than falling back to everything.
    // A project lists its own papers too: it is a collection underneath.
    const [lastCollectionId, setLastCollectionId] = useState(view.kind === 'collection' || view.kind === 'project' ? view.id : null);
    const collectionId = view.kind === 'collection' || view.kind === 'project' ? view.id : view.kind === 'paper' ? lastCollectionId : null;
    const collection = collections.find((item) => item.id === collectionId);
    // Opened from the rail or a link, not from here: still the one a paper opened next is listed under.
    const scopeId = view.kind === 'collection' || view.kind === 'project' ? view.id : null;
    useEffect(() => {
        if (scopeId)
            setLastCollectionId(scopeId);
    }, [scopeId]);
    const counts = useMemo(() => {
        const tally = { reading: 0, unread: 0, finished: 0 };
        for (const paper of papers)
            tally[statusOf(paper)] += 1;
        return tally;
    }, [papers]);
    const unsorted = papers.filter((paper) => paper.collectionIds.length === 0).length;
    const groups = useMemo(() => {
        const scope = scopeOf(papers, view, collectionId);
        const sorted = scope.slice().sort((a, b) => (b.lastOpenedAt || b.addedAt).localeCompare(a.lastOpenedAt || a.addedAt));
        return STATUS_ORDER.map((status) => ({ status, items: sorted.filter((paper) => statusOf(paper) === status) }));
    }, [papers, view, collectionId]);
    const scopeName = collection ? collection.name : view.kind === 'unsorted' ? 'Unsorted' : 'Everything';
    const scopeTotal = groups.reduce((total, group) => total + group.items.length, 0);
    const select = (next) => {
        if (next.kind === 'collection' || next.kind === 'project')
            setLastCollectionId(next.id);
        else if (next.kind !== 'paper')
            setLastCollectionId(null);
        onSelect(next);
    };
    const submit = async () => {
        const trimmed = name.trim();
        if (trimmed) {
            const created = await createCollection(trimmed);
            select({ kind: 'collection', id: created.id });
        }
        setName('');
        setAdding(false);
    };
    /** What dropping papers on a nav item does: file them, mark them, or send them to Junk. */
    const drop = async (target, ids) => {
        const dropped = ids.map((id) => papers.find((paper) => paper.id === id)).filter((paper) => Boolean(paper));
        if (!dropped.length)
            return;
        if (target === 'junk')
            return setRemoving(dropped);
        if (target === 'reading' || target === 'unread' || target === 'finished')
            return setReadingStatus(ids, target);
        for (const paper of dropped) {
            if (target === 'unsorted') {
                if (paper.collectionIds.length)
                    await setPaperCollections(paper.id, []);
            }
            else if (target.startsWith('collection:')) {
                const id = target.slice('collection:'.length);
                if (!paper.collectionIds.includes(id))
                    await setPaperCollections(paper.id, [...paper.collectionIds, id]);
            }
        }
    };
    const dropProps = (target) => ({
        onDragOver: (event) => {
            if (!carriesPapers(event))
                return;
            event.preventDefault();
            event.dataTransfer.dropEffect = target === 'junk' ? 'move' : 'copy';
            if (over !== target)
                setOver(target);
        },
        onDragLeave: () => setOver((current) => (current === target ? null : current)),
        onDrop: (event) => {
            const ids = draggedPapers(event);
            setOver(null);
            if (!ids)
                return;
            event.preventDefault();
            void drop(target, ids);
        },
    });
    const navItem = (key, next, icon, label, count, hint) => (_jsxs("button", { type: "button", className: `nav-item${(next.kind === 'collection' ? collectionId === next.id : next.kind === 'project' ? view.kind === 'project' && view.id === next.id : view.kind === next.kind) ? ' is-active' : ''}${over === key ? ' is-drop' : ''}`, onClick: () => select(next), title: hint, ...(key === 'all' ? {} : dropProps(key)), children: [icon, " ", _jsx("span", { className: "nav-label", children: label }), " ", _jsx("span", { className: "count", children: count })] }, key));
    return (_jsxs("aside", { className: "panel narrow library-panel", "aria-label": "Library", children: [_jsxs("div", { className: "panel-head", children: [_jsx("h2", { children: "Library" }), _jsx("button", { type: "button", className: "icon-btn sm", onClick: onClose, "aria-label": "Close the library panel", children: _jsx(CloseIcon, { size: 17 }) })] }), focused ? null : (_jsxs(_Fragment, { children: [inProject ? (_jsxs("div", { className: "library-section-head", children: [_jsx("span", { className: "eyebrow", children: "Whole library" }), _jsxs("button", { type: "button", className: "link-btn", onClick: () => setWide(false), title: `Only the papers of ${inProject.name}`, children: ["Just ", inProject.name] })] })) : null, _jsxs("nav", { className: "library-nav", "aria-label": "Views", children: [navItem('all', { kind: 'all' }, _jsx(StackIcon, { size: 16 }), 'All papers', papers.length), navItem('reading', { kind: 'reading' }, _jsx(ClockIcon, { size: 16 }), 'Reading now', counts.reading, 'Drop papers here to mark them as being read'), navItem('unread', { kind: 'unread' }, _jsx(InboxIcon, { size: 16 }), 'Not started', counts.unread, 'Drop papers here to mark them as not started'), navItem('finished', { kind: 'finished' }, _jsx(CheckIcon, { size: 16 }), 'Finished', counts.finished, 'Drop papers here to mark them as finished'), navItem('unsorted', { kind: 'unsorted' }, _jsx(StackIcon, { size: 16 }), 'Unsorted', unsorted, 'Drop papers here to take them out of every collection')] }), projects.length ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "library-section-head", children: [_jsx("span", { className: "eyebrow", children: "Projects" }), _jsx("button", { type: "button", className: "icon-btn sm", onClick: () => select({ kind: 'projects' }), "aria-label": "Every project", title: "Every project, side by side", children: _jsx(GridIcon, { size: 14 }) })] }), _jsx("div", { className: "library-nav", children: projects.map((item) => navItem(`collection:${item.id}`, { kind: 'project', id: item.id }, _jsx("span", { className: "swatch-dot is-project", style: { background: item.color } }), item.name, papers.filter((paper) => paper.collectionIds.includes(item.id)).length, `Open the project. Drop papers here to add them to ${item.name}`)) })] })) : null, _jsxs("div", { className: "library-section-head", children: [_jsx("span", { className: "eyebrow", children: "Collections" }), _jsx("button", { type: "button", className: "icon-btn sm", onClick: () => setAdding(true), "aria-label": "New collection", title: "New collection", children: _jsx(PlusIcon, { size: 15 }) })] }), _jsxs("div", { className: "library-nav", children: [adding ? (_jsxs("form", { onSubmit: (event) => {
                                    event.preventDefault();
                                    void submit();
                                }, style: { padding: '2px 0 6px' }, children: [_jsx("label", { className: "vh", htmlFor: "new-collection", children: "Collection name" }), _jsx("input", { id: "new-collection", className: "collection-name-input", autoFocus: true, value: name, onChange: (event) => setName(event.target.value), onBlur: () => void submit(), placeholder: "Collection name" })] })) : null, plainCollections(collections).map((item) => navItem(`collection:${item.id}`, { kind: 'collection', id: item.id }, _jsx("span", { className: "swatch-dot", style: { background: item.color } }), item.name, papers.filter((paper) => paper.collectionIds.includes(item.id)).length, `Drop papers here to add them to ${item.name}`)), navItem('junk', { kind: 'junk' }, _jsx(TrashIcon, { size: 16 }), 'Junk', junk.length, 'Removed papers, to restore or delete for good. Drop papers here to remove them.')] })] })), _jsxs("div", { className: "library-scope", children: [_jsx("span", { className: "eyebrow", children: scopeName }), _jsxs("span", { className: "mono", children: [scopeTotal, " paper", scopeTotal === 1 ? '' : 's', focused ? (_jsxs(_Fragment, { children: [' · ', _jsx("button", { type: "button", className: "link-btn", onClick: () => setWide(true), title: "Every paper, collection and project", children: "whole library" })] })) : null] })] }), _jsxs("div", { className: "scroll library-list", children: [!scopeTotal ? _jsx("p", { className: "library-empty", children: inProject ? 'No papers in this project yet. Add some from its overview, or drop them on it in the whole library.' : 'Nothing here yet. Open Discover on the right to add a paper.' }) : null, groups.map((group) => {
                        if (!group.items.length)
                            return null;
                        const isCollapsed = collapsed.includes(group.status);
                        return (_jsxs("section", { className: "status-group", children: [_jsxs("button", { type: "button", className: "status-head", "aria-expanded": !isCollapsed, onClick: () => setCollapsed((current) => (current.includes(group.status) ? current.filter((item) => item !== group.status) : [...current, group.status])), children: [_jsx(ChevronDownIcon, { size: 14, style: { transform: isCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 120ms' } }), _jsx("span", { className: `status-dot is-${group.status}` }), STATUS_LABEL[group.status], _jsx("span", { className: "count", children: group.items.length })] }), isCollapsed
                                    ? null
                                    : group.items.map((paper) => (_jsxs("button", { type: "button", className: `paper-row ${activePaperId === paper.id ? 'is-active' : ''}`, onClick: () => onOpenPaper(paper.id), onMouseEnter: () => hoverPaper(paper.id), onMouseLeave: () => hoverPaper(null), title: paper.title, draggable: true, onDragStart: (event) => {
                                            event.dataTransfer.setData(PAPERS_MIME, JSON.stringify([paper.id]));
                                            event.dataTransfer.setData('text/plain', paper.title);
                                        }, style: { ['--h']: String(coverFor(paper).hue) }, children: [_jsx("span", { className: "paper-row-spine", "aria-hidden": "true" }), _jsxs("span", { className: "paper-row-text", children: [_jsx("span", { className: "paper-row-title", children: paper.title }), _jsxs("span", { className: "paper-row-meta", children: [paper.authors[0] || 'Unknown author', paper.authors.length > 1 ? ' et al.' : '', yearOf(paper) ? ` · ${yearOf(paper)}` : '', noteCounts.get(paper.id) ? (_jsxs("span", { className: "paper-row-notes", title: "Pieces in this paper's notes", children: [' · ', _jsx(NoteIcon, { size: 10 }), " ", noteCounts.get(paper.id)] })) : null] })] }), group.status === 'reading' ? (_jsxs("span", { className: "paper-row-ring", title: `${Math.round(paper.progress * 100)}% read`, children: [_jsx(ProgressRing, { progress: paper.progress, size: 22 }), _jsxs("span", { className: "mono", children: [Math.max(1, Math.round(paper.progress * 100)), "%"] })] })) : null] }, paper.id)))] }, group.status));
                    })] }), removing ? _jsx(RemovePaperDialog, { papers: removing, onClose: () => setRemoving(null) }) : null] }));
}
