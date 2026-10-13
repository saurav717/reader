import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { JUNK_FOLDER, ROOT_FOLDER } from '../lib/driveSync';
import { authorLine, relativeDay } from '../lib/libraryLook';
import { CloseIcon, RestoreIcon, SearchIcon, TrashIcon } from './icons';
import { CoverTile } from './LibraryBits';
const DRIVE_NOTE = {
    junked: 'Its Drive folder is in Junk too, and comes back with it',
    kept: 'Its Drive folder was left where it was',
    'not-connected': 'Its Drive folder was left where it was — Drive was not connected',
    'not-in-drive': 'Never saved to Drive',
};
/**
 * Everything that has been taken out of the library, most recently first,
 * to be put back — collections, highlights and Drive folder with it — or
 * forgotten for good.
 */
export default function JunkView() {
    const { junk, restorePaper, purgeJunk, settings, driveConnected } = useStore();
    const [filter, setFilter] = useState('');
    const [selected, setSelected] = useState(() => new Set());
    const [busy, setBusy] = useState(null);
    const [error, setError] = useState(null);
    const [confirm, setConfirm] = useState(null);
    const rows = useMemo(() => {
        const needle = filter.trim().toLowerCase();
        const list = needle
            ? junk.filter((entry) => entry.paper.title.toLowerCase().includes(needle) || entry.paper.authors.join(' ').toLowerCase().includes(needle))
            : junk;
        return list.slice().sort((a, b) => b.removedAt.localeCompare(a.removedAt));
    }, [junk, filter]);
    useEffect(() => {
        const here = new Set(rows.map((entry) => entry.paper.id));
        setSelected((current) => {
            const kept = [...current].filter((id) => here.has(id));
            return kept.length === current.size ? current : new Set(kept);
        });
    }, [rows]);
    const rootName = settings.driveFolderName || ROOT_FOLDER;
    const chosen = rows.filter((entry) => selected.has(entry.paper.id));
    const allChosen = rows.length > 0 && chosen.length === rows.length;
    const toggle = (id) => setSelected((current) => {
        const next = new Set(current);
        if (next.has(id))
            next.delete(id);
        else
            next.add(id);
        return next;
    });
    const restore = async (ids) => {
        setError(null);
        for (const id of ids) {
            setBusy(id);
            try {
                await restorePaper(id);
            }
            catch (failure) {
                const title = junk.find((entry) => entry.paper.id === id)?.paper.title ?? 'A paper';
                setError(`${title} could not be put back: its Drive folder would not come out of ${rootName}/${JUNK_FOLDER} (${failure instanceof Error ? failure.message : String(failure)}).`);
                break;
            }
        }
        setBusy(null);
    };
    const purge = async (ids) => {
        await purgeJunk(ids);
        setConfirm(null);
    };
    const junkedInDrive = junk.some((entry) => entry.drive === 'junked');
    return (_jsxs("div", { className: "main library-main", children: [_jsxs("div", { className: "collection-head", children: [_jsxs("div", { className: "collection-titlebar", children: [_jsx("span", { className: "junk-mark", children: _jsx(TrashIcon, { size: 18 }) }), _jsx("h1", { className: "collection-title", children: "Junk" }), _jsx("span", { style: { flexGrow: 1 } }), junk.length ? (_jsx("button", { type: "button", className: "btn danger-ghost", onClick: () => setConfirm(junk.map((entry) => entry.paper.id)), children: "Empty Junk" })) : null] }), _jsxs("p", { className: "collection-sub", children: [_jsxs("span", { children: [junk.length, " removed paper", junk.length === 1 ? '' : 's'] }), _jsx("span", { children: "kept until you empty it" }), junkedInDrive ? (_jsxs("span", { children: ["Drive copies in ", rootName, "/", JUNK_FOLDER] })) : null] }), _jsxs("div", { className: "collection-toolbar", children: [_jsx("span", { className: `select-all${allChosen ? ' is-all' : chosen.length ? ' is-some' : ''}`, role: "checkbox", "aria-checked": allChosen ? true : chosen.length ? 'mixed' : false, "aria-label": allChosen ? 'Select none' : 'Select everything in Junk', tabIndex: rows.length ? 0 : -1, onClick: () => rows.length && setSelected(allChosen ? new Set() : new Set(rows.map((entry) => entry.paper.id))), onKeyDown: (event) => {
                                    if ((event.key === ' ' || event.key === 'Enter') && rows.length) {
                                        event.preventDefault();
                                        setSelected(allChosen ? new Set() : new Set(rows.map((entry) => entry.paper.id)));
                                    }
                                }, children: _jsx("span", { className: "box" }) }), _jsxs("div", { className: "field collection-filter", children: [_jsx(SearchIcon, { size: 15, style: { color: 'var(--muted)', flexShrink: 0 } }), _jsx("input", { type: "search", value: filter, onChange: (event) => setFilter(event.target.value), placeholder: "Filter Junk", "aria-label": "Filter Junk" })] })] }), error ? _jsx("p", { className: "banner error", style: { margin: '0 0 12px' }, children: error }) : null, junkedInDrive && !driveConnected ? (_jsxs("p", { className: "banner warn", style: { margin: '0 0 12px' }, children: ["Drive is not connected, so a paper put back now leaves its folder in ", rootName, "/", JUNK_FOLDER, ". Connect Drive in Settings first to have it moved back too."] })) : null] }), _jsxs("div", { className: `scroll library-scroll${chosen.length ? ' has-selection' : ''}`, children: [!rows.length ? (_jsxs("div", { className: "empty", children: [_jsx("h3", { children: filter ? 'Nothing matches that' : 'Junk is empty' }), _jsx("p", { children: "Papers you remove from the library wait here, highlights and all, until you put them back or empty Junk." })] })) : null, _jsx("div", { className: "lib-list", children: rows.map((entry) => {
                            const { paper } = entry;
                            const isSelected = selected.has(paper.id);
                            return (_jsxs("div", { className: `lib-row is-junk${isSelected ? ' is-selected' : ''}`, children: [_jsx(CoverTile, { paper: paper, selected: isSelected, selecting: chosen.length > 0, onToggle: () => toggle(paper.id), label: `Select ${paper.title}` }), _jsxs("div", { className: "lib-main", children: [_jsx("span", { className: "paper-name", children: paper.title }), _jsx("span", { className: "lib-authors", children: authorLine(paper.authors) }), _jsxs("span", { className: "lib-meta", children: [_jsxs("span", { children: ["Removed ", relativeDay(entry.removedAt)] }), entry.highlights.length ? (_jsxs("span", { className: "lib-chip hl", children: [entry.highlights.length, " highlight", entry.highlights.length === 1 ? '' : 's'] })) : null, _jsx("span", { className: "lib-chip", children: DRIVE_NOTE[entry.drive] })] })] }), _jsxs("div", { className: "junk-actions", children: [_jsxs("button", { type: "button", className: "btn sm", onClick: () => void restore([paper.id]), disabled: busy !== null, children: [busy === paper.id ? _jsx("span", { className: "spinner" }) : _jsx(RestoreIcon, { size: 14 }), " Restore"] }), _jsx("button", { type: "button", className: "icon-btn sm", onClick: () => setConfirm([paper.id]), title: "Delete forever", "aria-label": `Delete ${paper.title} forever`, children: _jsx(CloseIcon, { size: 15 }) })] })] }, paper.id));
                        }) })] }), chosen.length ? (_jsxs("div", { className: "selection-bar", role: "toolbar", "aria-label": "What to do with the selected papers", children: [_jsxs("span", { className: "selection-count", children: [_jsx("strong", { children: chosen.length }), " selected"] }), _jsx("span", { className: "selection-sep" }), _jsxs("button", { type: "button", className: "btn sm ghost", onClick: () => void restore(chosen.map((entry) => entry.paper.id)), disabled: busy !== null, children: [_jsx(RestoreIcon, { size: 15 }), " Restore"] }), _jsxs("button", { type: "button", className: "btn sm danger-ghost", onClick: () => setConfirm(chosen.map((entry) => entry.paper.id)), children: [_jsx(TrashIcon, { size: 15 }), " Delete forever"] }), _jsx("button", { type: "button", className: "icon-btn sm", onClick: () => setSelected(new Set()), "aria-label": "Clear the selection", children: _jsx(CloseIcon, { size: 15 }) })] })) : null, confirm ? (_jsxs(_Fragment, { children: [_jsx("div", { className: "scrim", onClick: () => setConfirm(null), role: "presentation" }), _jsxs("div", { className: "sheet narrow", role: "dialog", "aria-modal": "true", "aria-labelledby": "purge-title", children: [_jsx("h2", { id: "purge-title", children: confirm.length === junk.length && confirm.length > 1 ? 'Empty Junk?' : `Delete ${confirm.length === 1 ? 'this paper' : `${confirm.length} papers`} forever?` }), _jsxs("p", { className: "lede", children: [confirm.length === 1 ? 'It' : 'They', " and ", confirm.length === 1 ? 'its' : 'their', " highlights are forgotten for good and cannot be restored here.", junkedInDrive ? ` Anything in ${rootName}/${JUNK_FOLDER} in Drive stays there — delete it in Drive if you want the files gone too.` : ''] }), _jsxs("div", { className: "dialog-actions", children: [_jsx("button", { type: "button", className: "btn ghost", onClick: () => setConfirm(null), autoFocus: true, children: "Cancel" }), _jsx("button", { type: "button", className: "btn danger", onClick: () => void purge(confirm), children: "Delete forever" })] })] })] })) : null] }));
}
