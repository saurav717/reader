import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { STATUS_LABEL, statusOf } from '../lib/status';
import { driveFolderUrl } from '../lib/driveSync';
import { authorLine, relativeDay } from '../lib/libraryLook';
import { DEFAULT_PREFS, DETAIL_LABEL, GROUP_LABEL, LAYOUT_LABEL, SORT_LABEL, groupPapers, readPrefs, sortPapers, writePrefs, } from '../lib/libraryView';
import { hoverPaper, useNoteCounts } from '../lib/notes';
import { CheckIcon, CloseIcon, CloudCheckIcon, CloudIcon, DriveMark, FlagIcon, FolderMoveIcon, GridIcon, ListIcon, NoteIcon, PlusIcon, SearchIcon, SlidersIcon, TableIcon, TrashIcon } from './icons';
import RemovePaperDialog from './RemovePaperDialog';
import { CoverTile, Menu, PAPERS_MIME, ProgressRing, progressLabel } from './LibraryBits';
function headingFor(view, name) {
    switch (view.kind) {
        case 'all':
            return 'All papers';
        case 'reading':
            return 'Reading now';
        case 'unread':
            return 'Not started';
        case 'finished':
            return 'Finished';
        case 'unsorted':
            return 'Unsorted';
        default:
            return name || 'Collection';
    }
}
/**
 * Where a paper sits in Drive. The folder id is recorded on the first sync;
 * papers saved before per-paper folders existed only have the PDF's own link,
 * which is still somewhere to go.
 */
function driveFolderLink(paper) {
    if (paper.drive?.folderId)
        return paper.drive.folderLink || driveFolderUrl(paper.drive.folderId);
    return paper.drive?.pdfLink ?? null;
}
const yearOf = (paper) => /^\d{4}/.exec(paper.published || '')?.[0] ?? '';
export default function CollectionView({ view, onOpenPaper, onDiscover }) {
    const { papers, collections, highlights, driveConnected, syncPaper, syncStateFor, setPaperCollections, setReadingStatus, createCollection } = useStore();
    const [filter, setFilter] = useState('');
    const [prefs, setPrefs] = useState(() => readPrefs());
    const { layout, sort, group: groupBy } = prefs;
    const shows = (detail) => prefs.show.includes(detail);
    const [selected, setSelected] = useState(() => new Set());
    const anchor = useRef(null);
    /** The papers the bin was pressed on, while the notice asks whether to go ahead. */
    const [removing, setRemoving] = useState(null);
    const [toast, setToast] = useState(null);
    const collection = view.kind === 'collection' ? collections.find((item) => item.id === view.id) : undefined;
    const heading = headingFor(view, collection?.name);
    const viewKey = view.kind === 'collection' ? `collection:${view.id}` : view.kind;
    // A selection belongs to the list it was made in.
    useEffect(() => {
        setSelected(new Set());
        anchor.current = null;
    }, [viewKey]);
    useEffect(() => {
        if (!toast)
            return;
        const timer = window.setTimeout(() => setToast(null), 3200);
        return () => window.clearTimeout(timer);
    }, [toast]);
    const choose = (patch) => setPrefs((current) => {
        const next = { ...current, ...patch };
        writePrefs(next);
        return next;
    });
    const chooseLayout = (layout) => choose({ layout });
    const toggleDetail = (detail) => choose({ show: prefs.show.includes(detail) ? prefs.show.filter((item) => item !== detail) : [...prefs.show, detail] });
    const scoped = useMemo(() => {
        let list = papers;
        if (view.kind === 'collection')
            list = list.filter((paper) => paper.collectionIds.includes(view.id));
        if (view.kind === 'unsorted')
            list = list.filter((paper) => paper.collectionIds.length === 0);
        if (view.kind === 'reading')
            list = list.filter((paper) => statusOf(paper) === 'reading');
        if (view.kind === 'unread')
            list = list.filter((paper) => statusOf(paper) === 'unread');
        if (view.kind === 'finished')
            list = list.filter((paper) => statusOf(paper) === 'finished');
        return list;
    }, [papers, view]);
    const rows = useMemo(() => {
        let list = scoped;
        const needle = filter.trim().toLowerCase();
        if (needle) {
            list = list.filter((paper) => paper.title.toLowerCase().includes(needle) ||
                paper.authors.join(' ').toLowerCase().includes(needle) ||
                (paper.venue || '').toLowerCase().includes(needle) ||
                paper.tags.join(' ').toLowerCase().includes(needle));
        }
        return sortPapers(list, sort);
    }, [scoped, filter, sort]);
    // Inside a collection, grouping by collection would put everything under its own name.
    const grouping = groupBy === 'collection' && collection ? 'none' : groupBy;
    const groups = useMemo(() => groupPapers(rows, grouping, collections), [rows, grouping, collections]);
    /** The papers in the order they are shown, once each: what a shift-click's range runs along. */
    const shown = useMemo(() => [...new Set(groups.flatMap((group) => group.items.map((paper) => paper.id)))], [groups]);
    const highlightCounts = useMemo(() => {
        const counts = new Map();
        for (const highlight of highlights)
            counts.set(highlight.paperId, (counts.get(highlight.paperId) ?? 0) + 1);
        return counts;
    }, [highlights]);
    const noteCounts = useNoteCounts();
    // The pointer on a row lights that paper's notes in the pane beside, and dims the rest.
    const pointAt = (paper) => ({ onMouseEnter: () => hoverPaper(paper.id), onMouseLeave: () => hoverPaper(null) });
    useEffect(() => () => hoverPaper(null), []);
    const highlightTotal = rows.reduce((total, paper) => total + (highlightCounts.get(paper.id) ?? 0), 0);
    const readingCount = rows.filter((paper) => statusOf(paper) === 'reading').length;
    // Papers that leave the list — removed, moved elsewhere — leave the selection with it.
    useEffect(() => {
        const here = new Set(rows.map((paper) => paper.id));
        setSelected((current) => {
            const kept = [...current].filter((id) => here.has(id));
            return kept.length === current.size ? current : new Set(kept);
        });
    }, [rows]);
    const chosen = rows.filter((paper) => selected.has(paper.id));
    const selecting = selected.size > 0;
    const allChosen = rows.length > 0 && chosen.length === rows.length;
    const toggle = useCallback((id, event) => {
        setSelected((current) => {
            const next = new Set(current);
            if (event?.shiftKey && anchor.current && anchor.current !== id) {
                // A range, from the last one ticked to this one, all set the way the anchor is.
                const ids = shown;
                const from = ids.indexOf(anchor.current);
                const to = ids.indexOf(id);
                if (from !== -1 && to !== -1) {
                    const on = current.has(anchor.current);
                    for (const each of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) {
                        if (on)
                            next.add(each);
                        else
                            next.delete(each);
                    }
                    return next;
                }
            }
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            anchor.current = id;
            return next;
        });
    }, [shown]);
    const selectAll = () => setSelected(allChosen ? new Set() : new Set(rows.map((paper) => paper.id)));
    const clear = () => setSelected(new Set());
    // Escape lets go of the selection; ⌘A / Ctrl+A takes the whole list, outside a text field.
    useEffect(() => {
        const onKey = (event) => {
            const target = event.target;
            const typing = Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'));
            if (event.key === 'Escape' && selected.size && !document.querySelector('.sheet'))
                clear();
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && !typing && rows.length && !document.querySelector('.sheet')) {
                event.preventDefault();
                setSelected(new Set(rows.map((paper) => paper.id)));
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [rows, selected.size]);
    const open = (paper, event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || selecting) {
            event.preventDefault();
            toggle(paper.id, event);
            return;
        }
        onOpenPaper(paper.id);
    };
    const onDragStart = (paper, event) => {
        const ids = selected.has(paper.id) ? chosen.map((item) => item.id) : [paper.id];
        event.dataTransfer.setData(PAPERS_MIME, JSON.stringify(ids));
        event.dataTransfer.setData('text/plain', ids.length === 1 ? paper.title : `${ids.length} papers`);
        event.dataTransfer.effectAllowed = 'copyMove';
        // The picture that follows the pointer says how many are going.
        const ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.textContent = ids.length === 1 ? paper.title : `${ids.length} papers`;
        document.body.appendChild(ghost);
        event.dataTransfer.setDragImage(ghost, 14, 14);
        window.setTimeout(() => ghost.remove(), 0);
    };
    const plural = (count) => `${count} paper${count === 1 ? '' : 's'}`;
    const moveTo = async (targetId) => {
        const target = targetId ? collections.find((item) => item.id === targetId) : undefined;
        for (const paper of chosen) {
            let ids = paper.collectionIds;
            // Moved out of the collection being looked at; elsewhere, added to the one chosen.
            if (collection)
                ids = ids.filter((id) => id !== collection.id);
            if (targetId === null)
                ids = collection ? ids : [];
            else if (!ids.includes(targetId))
                ids = [...ids, targetId];
            if (ids.join() !== paper.collectionIds.join())
                await setPaperCollections(paper.id, ids);
        }
        setToast(targetId === null
            ? collection
                ? `Took ${plural(chosen.length)} out of ${collection.name}`
                : `Took ${plural(chosen.length)} out of every collection`
            : `${collection ? 'Moved' : 'Added'} ${plural(chosen.length)} to ${target?.name ?? 'the collection'}`);
        clear();
    };
    const moveToNew = async () => {
        const name = window.prompt('Name the new collection');
        if (!name?.trim())
            return;
        const created = await createCollection(name.trim());
        await moveTo(created.id);
    };
    const mark = async (status) => {
        await setReadingStatus(chosen.map((paper) => paper.id), status);
        setToast(`Marked ${plural(chosen.length)} ${STATUS_LABEL[status].toLowerCase()}`);
        clear();
    };
    const saveAll = () => {
        for (const paper of chosen)
            syncPaper(paper.id);
        setToast(`Saving ${plural(chosen.length)} to Drive`);
    };
    const actions = (paper) => {
        const state = syncStateFor(paper.id);
        const folderLink = driveFolderLink(paper);
        return (_jsxs("div", { className: "lib-actions", children: [folderLink ? (_jsx("a", { className: "icon-btn sm", href: folderLink, target: "_blank", rel: "noreferrer", title: `Open ${paper.drive?.folderName || paper.title} in Google Drive`, "aria-label": `Find ${paper.title} on Google Drive`, children: _jsx(DriveMark, { size: 15 }) })) : null, driveConnected ? (_jsx("button", { type: "button", className: "icon-btn sm", title: state === 'error'
                        ? `Drive sync failed: ${paper.drive?.error ?? 'unknown error'}`
                        : paper.drive?.syncedAt
                            ? `Saved to Drive ${new Date(paper.drive.syncedAt).toLocaleString()}`
                            : 'Save to Drive', "aria-label": "Save this paper to Drive", onClick: () => syncPaper(paper.id), children: state === 'running' || state === 'queued' ? (_jsx("span", { className: "spinner" })) : paper.drive?.syncedAt ? (_jsx(CloudCheckIcon, { size: 16, style: { color: 'var(--accent)' } })) : (_jsx(CloudIcon, { size: 16 })) })) : null, _jsx("button", { type: "button", className: "icon-btn sm", title: "Move to Junk", "aria-label": `Remove ${paper.title} from the library`, onClick: () => setRemoving([paper]), children: _jsx(TrashIcon, { size: 16 }) })] }));
    };
    const meta = (paper) => {
        const count = highlightCounts.get(paper.id) ?? 0;
        const noted = noteCounts.get(paper.id) ?? 0;
        const elsewhere = paper.collectionIds
            .filter((id) => id !== collection?.id)
            .map((id) => collections.find((item) => item.id === id))
            .filter((item) => Boolean(item));
        return (_jsxs("span", { className: "lib-meta", children: [!shows('venue') ? null : paper.venue ? _jsx("span", { className: "lib-venue", children: paper.venue }) : paper.arxivId ? _jsxs("span", { className: "mono", children: ["arXiv:", paper.arxivId] }) : null, !shows('collections') ? null : elsewhere.slice(0, 2).map((item) => (_jsxs("span", { className: "lib-chip", children: [_jsx("span", { className: "dot", style: { background: item.color } }), item.name] }, item.id))), count && shows('highlights') ? _jsxs("span", { className: "lib-chip hl", children: [count, " highlight", count === 1 ? '' : 's'] }) : null, noted && shows('highlights') ? (_jsxs("span", { className: "lib-chip note", title: "Pieces in this paper's notes", children: [_jsx(NoteIcon, { size: 11 }), " ", noted, " note", noted === 1 ? '' : 's'] })) : null, !shows('collections') ? null : paper.tags.slice(0, 2).map((tag) => (_jsxs("span", { className: "lib-chip", children: ["#", tag] }, tag)))] }));
    };
    const row = (paper) => {
        const isSelected = selected.has(paper.id);
        return (_jsxs("div", { className: `lib-row${isSelected ? ' is-selected' : ''}`, draggable: true, onDragStart: (event) => onDragStart(paper, event), ...pointAt(paper), children: [_jsx(CoverTile, { paper: paper, selected: isSelected, selecting: selecting, onToggle: (event) => toggle(paper.id, event), label: `Select ${paper.title}` }), _jsxs("button", { type: "button", className: "lib-main", onClick: (event) => open(paper, event), title: selecting ? 'Click to select or unselect' : undefined, children: [_jsx("span", { className: "paper-name", children: paper.title }), shows('authors') ? _jsx("span", { className: "lib-authors", children: authorLine(paper.authors) }) : null, meta(paper)] }), _jsx("div", { className: "lib-status", title: `Added ${relativeDay(paper.addedAt)}${paper.lastOpenedAt ? `, last opened ${relativeDay(paper.lastOpenedAt)}` : ''}`, children: shows('progress') ? (_jsxs(_Fragment, { children: [_jsx(ProgressRing, { progress: paper.progress }), _jsx("span", { children: progressLabel(paper.progress) })] })) : null }), actions(paper)] }, paper.id));
    };
    const card = (paper) => {
        const isSelected = selected.has(paper.id);
        return (_jsxs("div", { className: `lib-card${isSelected ? ' is-selected' : ''}`, draggable: true, onDragStart: (event) => onDragStart(paper, event), ...pointAt(paper), children: [_jsxs("div", { className: "lib-card-band", children: [_jsx(CoverTile, { paper: paper, size: "card", selected: isSelected, selecting: selecting, onToggle: (event) => toggle(paper.id, event), label: `Select ${paper.title}` }), shows('progress') ? (_jsx("span", { className: "lib-card-ring", children: _jsx(ProgressRing, { progress: paper.progress, size: 26 }) })) : null, paper.venue && shows('venue') ? _jsx("span", { className: "lib-card-venue", children: paper.venue }) : null] }), _jsxs("button", { type: "button", className: "lib-card-body", onClick: (event) => open(paper, event), title: selecting ? 'Click to select or unselect' : undefined, children: [_jsx("span", { className: "paper-name", children: paper.title }), shows('authors') ? _jsx("span", { className: "lib-authors", children: authorLine(paper.authors, 2) }) : null, shows('collections') || shows('highlights') ? meta({ ...paper, venue: undefined, arxivId: undefined }) : null] }), _jsxs("div", { className: "lib-card-foot", children: [_jsx("span", { className: "lib-card-state", children: shows('progress') ? progressLabel(paper.progress) : '' }), actions(paper)] })] }, paper.id));
    };
    /** One line to a paper: the columns the View menu leaves on, and nothing that wraps. */
    const line = (paper) => {
        const isSelected = selected.has(paper.id);
        const count = highlightCounts.get(paper.id) ?? 0;
        const noted = noteCounts.get(paper.id) ?? 0;
        return (_jsxs("div", { className: `lib-line${isSelected ? ' is-selected' : ''}`, draggable: true, onDragStart: (event) => onDragStart(paper, event), ...pointAt(paper), style: { gridTemplateColumns: columns }, children: [_jsx(CoverTile, { paper: paper, size: "mini", selected: isSelected, selecting: selecting, onToggle: (event) => toggle(paper.id, event), label: `Select ${paper.title}` }), _jsxs("button", { type: "button", className: "lib-line-title", onClick: (event) => open(paper, event), title: paper.title, children: [_jsx("span", { className: "lib-line-text", children: paper.title }), count && shows('highlights') ? _jsx("span", { className: "lib-line-count", title: `${count} highlight${count === 1 ? '' : 's'}`, children: count }) : null, noted && shows('highlights') ? (_jsxs("span", { className: "lib-line-count is-notes", title: `${noted} piece${noted === 1 ? '' : 's'} in its notes`, children: [_jsx(NoteIcon, { size: 10 }), noted] })) : null] }), shows('authors') ? _jsx("span", { className: "lib-line-cell", children: authorLine(paper.authors, 2) }) : null, shows('venue') ? _jsx("span", { className: "lib-line-cell lib-venue", children: paper.venue || (paper.arxivId ? `arXiv:${paper.arxivId}` : '') }) : null, _jsx("span", { className: "lib-line-cell mono", children: yearOf(paper) }), _jsx("span", { className: "lib-line-cell", children: relativeDay(paper.addedAt) }), shows('progress') ? (_jsxs("span", { className: "lib-line-cell lib-line-progress", children: [_jsx(ProgressRing, { progress: paper.progress, size: 18 }), progressLabel(paper.progress).replace(' read', '')] })) : null, actions(paper)] }, paper.id));
    };
    const columns = [
        '22px',
        'minmax(180px, 3fr)',
        shows('authors') ? 'minmax(100px, 1.4fr)' : '',
        shows('venue') ? 'minmax(100px, 1.4fr)' : '',
        '46px',
        '84px',
        shows('progress') ? '104px' : '',
        '100px',
    ]
        .filter(Boolean)
        .join(' ');
    const tableHead = (_jsxs("div", { className: "lib-line lib-line-head", style: { gridTemplateColumns: columns }, "aria-hidden": "true", children: [_jsx("span", {}), _jsx("span", { children: "Title" }), shows('authors') ? _jsx("span", { children: "Authors" }) : null, shows('venue') ? _jsx("span", { children: "Journal" }) : null, _jsx("span", { children: "Year" }), _jsx("span", { children: "Added" }), shows('progress') ? _jsx("span", { children: "Progress" }) : null, _jsx("span", {})] }));
    const option = (checked, label, onPick, role = 'menuitemradio') => (_jsxs("button", { type: "button", role: role, "aria-checked": checked, className: checked ? 'is-checked' : '', onClick: onPick, children: [_jsx("span", { className: "menu-tick", children: checked ? _jsx(CheckIcon, { size: 13, strokeWidth: 2.4 }) : null }), label] }, label));
    return (_jsxs("div", { className: "main library-main", children: [_jsxs("div", { className: "collection-head", children: [_jsxs("div", { className: "collection-titlebar", children: [collection ? _jsx("span", { className: "collection-swatch", style: { background: collection.color } }) : null, _jsx("h1", { className: "collection-title", children: heading }), _jsx("span", { style: { flexGrow: 1 } }), _jsxs("button", { type: "button", className: "btn primary", onClick: onDiscover, title: collection
                                    ? `Search for papers, books or a PDF link in the Discover panel, and add them to ${collection.name}`
                                    : 'Search for papers, books or a PDF link in the Discover panel, and add them to your library', children: [_jsx(PlusIcon, { size: 15 }), " Add papers"] })] }), _jsxs("p", { className: "collection-sub", children: [_jsx("span", { children: plural(rows.length) }), readingCount ? _jsxs("span", { children: [readingCount, " in progress"] }) : null, _jsxs("span", { children: [highlightTotal, " highlight", highlightTotal === 1 ? '' : 's'] }), driveConnected ? _jsx("span", { children: "mirrored to Drive" }) : null] }), _jsxs("div", { className: "collection-toolbar", children: [_jsx("span", { className: `select-all${allChosen ? ' is-all' : selecting ? ' is-some' : ''}`, role: "checkbox", "aria-checked": allChosen ? true : selecting ? 'mixed' : false, "aria-label": allChosen ? 'Select none' : 'Select every paper in the list', title: allChosen ? 'Select none' : 'Select all (⌘A)', tabIndex: rows.length ? 0 : -1, onClick: () => rows.length && selectAll(), onKeyDown: (event) => {
                                    if (event.key === ' ' || event.key === 'Enter') {
                                        event.preventDefault();
                                        if (rows.length)
                                            selectAll();
                                    }
                                }, children: _jsx("span", { className: "box" }) }), _jsx("label", { className: "vh", htmlFor: "collection-filter", children: "Filter papers" }), _jsxs("div", { className: "field collection-filter", children: [_jsx(SearchIcon, { size: 15, style: { color: 'var(--muted)', flexShrink: 0 } }), _jsx("input", { id: "collection-filter", type: "search", value: filter, onChange: (event) => setFilter(event.target.value), placeholder: collection ? `Filter ${collection.name}` : 'Filter by title, author, journal or tag' })] }), _jsx("span", { style: { flexGrow: 1 } }), _jsxs("div", { className: "segmented", role: "group", "aria-label": "Layout", children: [_jsx("button", { type: "button", "aria-pressed": layout === 'list', onClick: () => chooseLayout('list'), title: "List", "aria-label": "Show as a list", children: _jsx(ListIcon, { size: 15 }) }), _jsx("button", { type: "button", "aria-pressed": layout === 'grid', onClick: () => chooseLayout('grid'), title: "Cards", "aria-label": "Show as cards", children: _jsx(GridIcon, { size: 15 }) }), _jsx("button", { type: "button", "aria-pressed": layout === 'compact', onClick: () => chooseLayout('compact'), title: "Compact table", "aria-label": "Show as a compact table", children: _jsx(TableIcon, { size: 15 }) })] }), _jsx(Menu, { label: "View", icon: _jsx(SlidersIcon, { size: 15 }), className: "btn view-btn", title: "Choose how the papers are shown", align: "right", children: () => (_jsxs("div", { className: "view-menu", children: [_jsxs("div", { children: [_jsx("p", { className: "menu-label", children: "Layout" }), Object.keys(LAYOUT_LABEL).map((each) => option(layout === each, LAYOUT_LABEL[each], () => chooseLayout(each))), _jsx("p", { className: "menu-label", children: "Group by" }), Object.keys(GROUP_LABEL)
                                                    .filter((each) => !(each === 'collection' && collection))
                                                    .map((each) => option(groupBy === each, GROUP_LABEL[each], () => choose({ group: each })))] }), _jsxs("div", { children: [_jsx("p", { className: "menu-label", children: "Sort by" }), Object.keys(SORT_LABEL).map((each) => option(sort === each, SORT_LABEL[each], () => choose({ sort: each }))), _jsx("p", { className: "menu-label", children: "Show" }), Object.keys(DETAIL_LABEL).map((each) => option(shows(each), DETAIL_LABEL[each], () => toggleDetail(each), 'menuitemcheckbox')), _jsx("hr", {}), _jsxs("button", { type: "button", role: "menuitem", onClick: () => choose(DEFAULT_PREFS), children: [_jsx("span", { className: "menu-tick" }), "Reset to default"] })] })] })) })] }), _jsxs("p", { className: "view-summary", children: [LAYOUT_LABEL[layout], grouping !== 'none' ? ` · grouped by ${GROUP_LABEL[grouping].replace(/ \(.*\)$/, '').toLowerCase()}` : '', " \u00B7 sorted by ", SORT_LABEL[sort].toLowerCase()] })] }), _jsxs("div", { className: `scroll library-scroll${selecting ? ' has-selection' : ''}`, children: [!rows.length ? (_jsxs("div", { className: "empty", children: [_jsx("h3", { children: filter ? 'Nothing matches that' : 'Nothing here yet' }), _jsx("p", { children: filter
                                    ? 'Try part of a title, an author’s surname, a journal or a tag.'
                                    : 'Search for a paper or a book in the Discover panel — or paste the link to any PDF there — and add it to this collection.' }), filter ? null : (_jsxs("button", { type: "button", className: "btn primary", onClick: onDiscover, style: { marginTop: 10 }, children: [_jsx(PlusIcon, { size: 15 }), " Find papers"] }))] })) : null, layout === 'compact' && rows.length ? tableHead : null, groups.map((group) => (_jsxs(Fragment, { children: [group.name ? (_jsxs("h2", { className: "lib-group", children: [group.color ? _jsx("span", { className: "dot", style: { background: group.color } }) : null, group.name, _jsx("span", { children: group.items.length })] })) : null, layout === 'grid' ? (_jsx("div", { className: "lib-grid", children: group.items.map(card) })) : layout === 'compact' ? (_jsx("div", { className: "lib-table", children: group.items.map(line) })) : (_jsx("div", { className: "lib-list", children: group.items.map(row) }))] }, group.key)))] }), selecting ? _jsx("div", { className: "selection-haze", "aria-hidden": "true" }) : null, selecting ? (_jsxs("div", { className: "selection-bar", role: "toolbar", "aria-label": "What to do with the selected papers", children: [_jsxs("span", { className: "selection-count", children: [_jsx("strong", { children: chosen.length }), " selected", !allChosen ? (_jsxs("button", { type: "button", className: "link-btn", onClick: selectAll, children: ["Select all ", rows.length] })) : null] }), _jsx("span", { className: "selection-sep" }), _jsx(Menu, { up: true, label: collection ? 'Move to' : 'Add to', icon: _jsx(FolderMoveIcon, { size: 15 }), className: "btn sm ghost", children: (close) => (_jsxs(_Fragment, { children: [_jsx("p", { className: "menu-label", children: collection ? `Move out of ${collection.name} into` : 'Add to the collection' }), collections
                                    .filter((item) => item.id !== collection?.id)
                                    .map((item) => (_jsxs("button", { type: "button", role: "menuitem", onClick: () => {
                                        close();
                                        void moveTo(item.id);
                                    }, children: [_jsx("span", { className: "dot", style: { background: item.color } }), " ", item.name] }, item.id))), _jsxs("button", { type: "button", role: "menuitem", onClick: () => {
                                        close();
                                        void moveToNew();
                                    }, children: [_jsx(PlusIcon, { size: 13 }), " New collection\u2026"] }), _jsx("hr", {}), _jsx("button", { type: "button", role: "menuitem", onClick: () => {
                                        close();
                                        void moveTo(null);
                                    }, children: collection ? `Take out of ${collection.name}` : 'Take out of every collection' })] })) }), _jsx(Menu, { up: true, label: "Mark as", icon: _jsx(FlagIcon, { size: 15 }), className: "btn sm ghost", children: (close) => ['unread', 'reading', 'finished'].map((status) => (_jsxs("button", { type: "button", role: "menuitem", onClick: () => {
                                close();
                                void mark(status);
                            }, children: [_jsx("span", { className: `status-dot is-${status}` }), " ", STATUS_LABEL[status]] }, status))) }), driveConnected ? (_jsxs("button", { type: "button", className: "btn sm ghost", onClick: saveAll, children: [_jsx(CloudIcon, { size: 15 }), " Save to Drive"] })) : null, _jsxs("button", { type: "button", className: "btn sm danger-ghost", onClick: () => setRemoving(chosen), children: [_jsx(TrashIcon, { size: 15 }), " Move to Junk"] }), _jsx("button", { type: "button", className: "icon-btn sm", onClick: clear, "aria-label": "Clear the selection", title: "Clear the selection (Esc)", children: _jsx(CloseIcon, { size: 15 }) })] })) : null, toast ? (_jsx("div", { className: `lib-toast${selecting ? ' raised' : ''}`, role: "status", children: toast })) : null, removing ? (_jsx(RemovePaperDialog, { papers: removing, onClose: () => setRemoving(null), onRemoved: (ids) => ids.length && setToast(`Moved ${plural(ids.length)} to Junk`) })) : null] }));
}
