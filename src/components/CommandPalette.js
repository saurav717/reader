import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { arxivIdFromQuery, defaultSources, lookupArxiv, search } from '../lib/sources';
import { hasProxy } from '../lib/api';
import { startTour } from '../lib/tour';
import { FileIcon, PlusIcon, SearchIcon, SettingsIcon, StackIcon } from './icons';
export default function CommandPalette({ onClose, onOpenPaper, onOpenSettings }) {
    const { papers, collections, addPaper, createCollection } = useStore();
    const [query, setQuery] = useState('');
    const [remote, setRemote] = useState([]);
    const [busy, setBusy] = useState(false);
    const [cursor, setCursor] = useState(0);
    const abort = useRef(null);
    useEffect(() => {
        const trimmed = query.trim();
        if (trimmed.length < 3) {
            setRemote([]);
            return;
        }
        const timer = window.setTimeout(async () => {
            abort.current?.abort();
            const controller = new AbortController();
            abort.current = controller;
            setBusy(true);
            try {
                const directId = arxivIdFromQuery(trimmed);
                const found = directId && hasProxy()
                    ? await lookupArxiv(directId, controller.signal)
                    : (await search(trimmed, defaultSources(), { signal: controller.signal, limit: 6 })).results;
                setRemote(found);
            }
            catch {
                setRemote([]);
            }
            finally {
                if (abort.current === controller)
                    setBusy(false);
            }
        }, 320);
        return () => window.clearTimeout(timer);
    }, [query]);
    const rows = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const library = papers
            .filter((paper) => !needle ||
            paper.title.toLowerCase().includes(needle) ||
            paper.authors.join(' ').toLowerCase().includes(needle))
            .slice(0, 6)
            .map((paper) => ({
            kind: 'library',
            id: paper.id,
            title: paper.title,
            sub: paper.collectionIds
                .map((id) => collections.find((collection) => collection.id === id)?.name)
                .filter(Boolean)
                .join(', ') || 'Unsorted',
        }));
        const found = remote
            .filter((ref) => !papers.some((paper) => paper.id === ref.id))
            .map((ref) => ({ kind: 'remote', ref }));
        const actions = [];
        if (query.trim()) {
            actions.push({
                kind: 'action',
                id: 'create',
                title: `Create collection “${query.trim()}”`,
                run: () => {
                    void createCollection(query.trim());
                    onClose();
                },
            });
        }
        actions.push({
            kind: 'action',
            id: 'settings',
            title: 'Open settings and Google Drive',
            run: () => {
                onOpenSettings();
                onClose();
            },
        });
        if (!needle || 'take the tour guide help'.includes(needle)) {
            actions.push({
                kind: 'action',
                id: 'tour',
                title: 'Take the tour — a walk round the app and its keys',
                run: () => {
                    onClose();
                    startTour();
                },
            });
        }
        return [...library, ...found, ...actions];
    }, [papers, collections, remote, query, createCollection, onClose, onOpenSettings]);
    useEffect(() => setCursor(0), [rows.length]);
    const activate = useCallback(async (row, alsoOpen) => {
        if (row.kind === 'library') {
            onOpenPaper(row.id);
            onClose();
            return;
        }
        if (row.kind === 'action') {
            row.run();
            return;
        }
        const target = collections[0] ?? (await createCollection('Reading list'));
        await addPaper(row.ref, target.id);
        if (alsoOpen)
            onOpenPaper(row.ref.id);
        onClose();
    }, [addPaper, collections, createCollection, onClose, onOpenPaper]);
    useEffect(() => {
        const onKey = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
            }
            else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setCursor((current) => Math.min(rows.length - 1, current + 1));
            }
            else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setCursor((current) => Math.max(0, current - 1));
            }
            else if (event.key === 'Enter') {
                event.preventDefault();
                const row = rows[cursor];
                if (row)
                    void activate(row, event.shiftKey);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [activate, cursor, onClose, rows]);
    const libraryCount = rows.filter((row) => row.kind === 'library').length;
    const remoteCount = rows.filter((row) => row.kind === 'remote').length;
    return (_jsxs(_Fragment, { children: [_jsx("div", { className: "scrim", onClick: onClose, role: "presentation" }), _jsxs("div", { className: "palette", role: "dialog", "aria-modal": "true", "aria-label": "Search papers and commands", children: [_jsxs("div", { className: "palette-head", children: [_jsx(SearchIcon, { size: 20, style: { color: 'var(--muted)', flexShrink: 0 } }), _jsx("label", { className: "vh", htmlFor: "palette-input", children: "Search your library and arXiv" }), _jsx("input", { id: "palette-input", autoFocus: true, type: "search", value: query, placeholder: "Search your library and arXiv\u2026", onChange: (event) => setQuery(event.target.value) }), busy ? _jsx("span", { className: "spinner", "aria-label": "Searching arXiv" }) : null, _jsx("kbd", { children: "esc" })] }), _jsxs("div", { className: "palette-body", children: [libraryCount ? _jsx("div", { className: "eyebrow", style: { padding: '6px 12px 8px' }, children: "In your library" }) : null, rows.map((row, position) => {
                                const active = position === cursor;
                                const heading = row.kind === 'remote' && position === libraryCount ? 'Found online' : null;
                                const actionHeading = row.kind === 'action' && position === libraryCount + remoteCount ? 'Actions' : null;
                                return (_jsxs("div", { children: [heading ? _jsx("div", { className: "eyebrow", style: { padding: '12px 12px 8px' }, children: heading }) : null, actionHeading ? _jsx("div", { className: "eyebrow", style: { padding: '12px 12px 8px' }, children: actionHeading }) : null, _jsxs("button", { type: "button", className: `palette-row ${active ? 'is-active' : ''}`, onMouseEnter: () => setCursor(position), onClick: (event) => void activate(row, event.shiftKey), children: [row.kind === 'library' ? _jsx(StackIcon, { size: 17 }) : null, row.kind === 'remote' ? _jsx(FileIcon, { size: 17 }) : null, row.kind === 'action' ? (row.id === 'settings' ? _jsx(SettingsIcon, { size: 17 }) : _jsx(PlusIcon, { size: 17 })) : null, _jsxs("span", { style: { flexGrow: 1, minWidth: 0 }, children: [_jsx("span", { style: {
                                                                display: 'block',
                                                                fontSize: 14,
                                                                whiteSpace: 'nowrap',
                                                                overflow: 'hidden',
                                                                textOverflow: 'ellipsis',
                                                            }, children: row.kind === 'remote' ? row.ref.title : row.title }), _jsx("span", { className: "palette-sub", children: row.kind === 'remote'
                                                                ? `${row.ref.arxivId ? `arXiv:${row.ref.arxivId} · ` : ''}${row.ref.authors.slice(0, 2).join(', ')}`
                                                                : row.kind === 'library'
                                                                    ? row.sub
                                                                    : '' })] }), active && row.kind === 'remote' ? (_jsx("span", { style: { fontSize: 11.5, whiteSpace: 'nowrap' }, children: "\u21B5 add" })) : null] })] }, `${row.kind}-${position}`));
                            })] }), _jsxs("div", { className: "palette-foot", children: [_jsxs("span", { children: [_jsx("kbd", { children: "\u2191\u2193" }), " move"] }), _jsxs("span", { children: [_jsx("kbd", { children: "\u21B5" }), " add to collection"] }), _jsxs("span", { children: [_jsx("kbd", { children: "\u21E7\u21B5" }), " add and open"] }), _jsx("span", { style: { flexGrow: 1 } }), _jsx("span", { style: { color: 'var(--muted)' }, children: "every source \u00B7 your library" })] })] })] }));
}
