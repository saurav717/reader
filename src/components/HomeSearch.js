import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { arxivIdFromQuery, defaultSources, lookupArxiv, openAlexWorks, search, sourceError, sourceList } from '../lib/sources';
import { authorLine } from '../lib/libraryLook';
import { statusOf } from '../lib/status';
import { progressLabel } from './LibraryBits';
import { PdfPeek, ReflowPeek, clip, hasPage, sinceLeft, useSpot, whereIn } from './HomeParts';
import { CheckIcon, ChevronDownIcon, ExternalIcon, PlusIcon, SearchIcon } from './icons';
import { Locations } from './Discover';
import { AddToProject } from './Projects';
import { plainCollections } from '../lib/projects';
/** A search result dragged onto a collection carries itself. */
const REF_MIME = 'application/x-reader-ref';
const LIMIT = 20;
const norm = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/**
 * Find papers: the search box first, and one step from a result to a
 * collection — the + button saves to the collection chosen beside the box,
 * its ▾ to any other, and a result can be dragged onto one on the right.
 */
export function FindPapers({ hero, ask, focusBox = true, saveTo, onSaveTo, onOpenPaper, onDiscover }) {
    const { papers, collections, addPaper, createCollection, setPaperCollections, removePaper } = useStore();
    const [query, setQuery] = useState(ask ?? '');
    const [asked, setAsked] = useState('');
    const [sources, setSources] = useState(defaultSources);
    const [results, setResults] = useState([]);
    const [errors, setErrors] = useState([]);
    const [busy, setBusy] = useState(false);
    const [selected, setSelected] = useState(0);
    const [picking, setPicking] = useState(null);
    /** The result opened to show everywhere it can be read, as Discover's are. */
    const [openId, setOpenId] = useState(null);
    const [added, setAdded] = useState(null);
    const [dropOn, setDropOn] = useState(null);
    const [suggestions, setSuggestions] = useState(null);
    const input = useRef(null);
    const abort = useRef(null);
    // Saving puts a paper in a collection, never a project: a project takes a paper only from its own menu (+ Project).
    const plain = useMemo(() => plainCollections(collections), [collections]);
    const target = plain.find((item) => item.id === saveTo) ?? plain[0];
    // The box has the cursor as a visit opens on it, and / puts it there from anywhere on Home.
    useEffect(() => {
        if (focusBox || ask)
            input.current?.focus();
        const onKey = (event) => {
            if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey)
                return;
            const typing = event.target;
            if (typing && (typing.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(typing.tagName)))
                return;
            if (document.querySelector('.scrim, .sheet, .palette'))
                return;
            event.preventDefault();
            input.current?.focus();
            input.current?.select();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
        // Once, as the view opens.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // A paper is in the library by its id, or by its title under another source's id.
    const inLibrary = useMemo(() => {
        const byId = new Map(papers.map((paper) => [paper.id, paper]));
        const byTitle = new Map(papers.map((paper) => [norm(paper.title), paper]));
        return (ref) => byId.get(ref.id) ?? byTitle.get(norm(ref.title));
    }, [papers]);
    const run = useCallback(async (text = query) => {
        const trimmed = text.trim();
        if (!trimmed) {
            setAsked('');
            setResults([]);
            setErrors([]);
            return;
        }
        abort.current?.abort();
        const controller = new AbortController();
        abort.current = controller;
        setBusy(true);
        setErrors([]);
        setAsked(trimmed);
        setSelected(0);
        setPicking(null);
        try {
            const id = arxivIdFromQuery(trimmed);
            if (id) {
                setResults(await lookupArxiv(id, controller.signal));
            }
            else {
                const outcome = await search(trimmed, sources, { limit: LIMIT, signal: controller.signal });
                setResults(outcome.results);
                setErrors(outcome.errors);
            }
        }
        catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError')
                return;
            const reported = sourceError(sources[0] ?? 'openalex', error);
            setErrors(reported ? [reported] : []);
            setResults([]);
        }
        finally {
            if (abort.current === controller)
                setBusy(false);
        }
    }, [query, sources]);
    // A question brought from elsewhere is asked straight away.
    const asking = useRef(ask);
    useEffect(() => {
        if (asking.current)
            void run(asking.current);
        // Once, as the view opens with it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // Before anything is asked: papers near the one being read, from OpenAlex,
    // which a browser can ask directly. Kept for the visit, per paper.
    useEffect(() => {
        if (!hero) {
            setSuggestions([]);
            return;
        }
        const key = `reader.suggest.${hero.id}`;
        try {
            const kept = sessionStorage.getItem(key);
            if (kept) {
                setSuggestions(JSON.parse(kept));
                return;
            }
        }
        catch {
            // asked afresh
        }
        const controller = new AbortController();
        const near = openAlexWorks(new URLSearchParams({ search: hero.title, per_page: '8' }), controller.signal).then((refs) => refs.map((ref) => ({ ref, why: `Related to ${clip(hero.title, 60)}, which you are reading` })));
        const first = hero.authors[0];
        const by = first
            ? openAlexWorks(new URLSearchParams({ filter: `raw_author_name.search:${first.replace(/[,:|]+/g, ' ')}`, sort: 'cited_by_count:desc', per_page: '6' }), controller.signal).then((refs) => refs.map((ref) => ({ ref, why: `More by ${first}` })))
            : Promise.resolve([]);
        void Promise.allSettled([near, by]).then((settled) => {
            if (controller.signal.aborted)
                return;
            const seen = new Set();
            const out = [];
            for (const outcome of settled) {
                if (outcome.status !== 'fulfilled')
                    continue;
                for (const item of outcome.value) {
                    const title = norm(item.ref.title);
                    if (!title || seen.has(title) || title === norm(hero.title))
                        continue;
                    seen.add(title);
                    out.push(item);
                }
            }
            // Interleaved, so both reasons show; the ones already in the library are left for the list to mark.
            const near = out.filter((item) => item.why.startsWith('Related'));
            const byAuthor = out.filter((item) => !item.why.startsWith('Related'));
            const mixed = [];
            while ((near.length || byAuthor.length) && mixed.length < 6) {
                if (near.length)
                    mixed.push(near.shift());
                if (byAuthor.length && mixed.length < 6)
                    mixed.push(byAuthor.shift());
            }
            setSuggestions(mixed);
            try {
                sessionStorage.setItem(key, JSON.stringify(mixed));
            }
            catch {
                // asked again next time
            }
        });
        return () => controller.abort();
    }, [hero]);
    const save = useCallback(async (ref, collection) => {
        const existing = inLibrary(ref);
        // With no collection yet, it goes to the library, unsorted.
        const paper = await addPaper(existing ? { ...ref, id: existing.id } : ref, collection?.id);
        setAdded({ paperId: paper.id, title: ref.title, collection: collection?.name ?? 'your library', before: existing ? existing.collectionIds : undefined });
        setPicking(null);
    }, [addPaper, inLibrary]);
    const read = useCallback(async (ref) => {
        const existing = inLibrary(ref);
        if (existing)
            return onOpenPaper(existing.id);
        const paper = await addPaper(ref, target?.id);
        onOpenPaper(paper.id);
    }, [addPaper, inLibrary, onOpenPaper, target]);
    const undo = async () => {
        if (!added)
            return;
        if (added.before)
            await setPaperCollections(added.paperId, added.before);
        else
            await removePaper(added.paperId);
        setAdded(null);
    };
    const newCollection = async (ref) => {
        const name = window.prompt('Name the new collection');
        if (!name?.trim())
            return;
        const made = await createCollection(name.trim());
        onSaveTo(made.id);
        if (ref)
            await save(ref, made);
    };
    // The toast goes by itself, unless the pointer is on it.
    const [holdToast, setHoldToast] = useState(false);
    useEffect(() => {
        if (!added || holdToast)
            return;
        const timer = window.setTimeout(() => setAdded(null), 7000);
        return () => window.clearTimeout(timer);
    }, [added, holdToast]);
    const shown = asked ? results : (suggestions ?? []).map((item) => item.ref);
    const why = new Map((suggestions ?? []).map((item) => [item.ref.id, item.why]));
    // In the list: ↑↓ move, ↵ read, A saves to the chosen collection; with the
    // picker open, 1–9 choose from it. Typing in the box, ↓ steps into the list.
    const onListKey = (event) => {
        const ref = shown[selected];
        if (picking && /^[1-9]$/.test(event.key)) {
            const collection = plain[Number(event.key) - 1];
            const pickRef = shown.find((item) => item.id === picking);
            if (collection && pickRef) {
                event.preventDefault();
                event.stopPropagation();
                void save(pickRef, collection);
            }
            return;
        }
        if (event.key === 'Escape' && picking) {
            event.stopPropagation();
            setPicking(null);
            return;
        }
        if (event.target instanceof HTMLInputElement) {
            if (event.key === 'ArrowDown' && shown.length) {
                event.preventDefault();
                setSelected(0);
                document.querySelector('.find-row')?.focus();
            }
            return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const next = Math.max(0, Math.min(shown.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1)));
            if (event.key === 'ArrowUp' && selected === 0) {
                input.current?.focus();
                return;
            }
            setSelected(next);
            document.querySelectorAll('.find-row')[next]?.focus();
        }
        else if (ref && event.key.toLowerCase() === 'a' && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            event.stopPropagation();
            void save(ref, target);
        }
        else if (ref && event.key === 'Enter' && event.target.classList.contains('find-row')) {
            event.preventDefault();
            event.stopPropagation();
            setOpenId((current) => (current === ref.id ? null : ref.id));
        }
    };
    const toggleSource = (id) => setSources((current) => (current.includes(id) ? (current.length > 1 ? current.filter((item) => item !== id) : current) : [...current, id]));
    return (_jsxs("div", { className: "home-view find", onKeyDown: onListKey, children: [_jsxs("section", { className: "find-hero", children: [!asked ? (_jsxs(_Fragment, { children: [_jsx("h2", { children: "Find your next paper" }), _jsx("p", { children: "Search the indexes at once \u2014 or paste an arXiv id. Whatever you save goes straight into a collection." })] })) : null, _jsxs("form", { className: "find-box", role: "search", onSubmit: (event) => {
                            event.preventDefault();
                            void run();
                        }, children: [_jsx(SearchIcon, { size: 19 }), _jsx("input", { ref: input, value: query, onChange: (event) => {
                                    setQuery(event.target.value);
                                    if (!event.target.value.trim())
                                        void run('');
                                }, placeholder: "Papers or topics \u2014 \u201Cscaling laws for mixture of experts\u201D, or 2401.02954", "aria-label": "Search for papers" }), busy ? _jsx("span", { className: "spinner" }) : asked ? _jsxs("span", { className: "find-count", children: [results.length, " results"] }) : _jsx("kbd", { children: "/" }), _jsx("button", { type: "submit", className: "btn primary", children: "Search" })] }), _jsxs("div", { className: "find-options", children: [_jsx("span", { className: "find-label", children: "Search in" }), sourceList().map((source) => (_jsx("button", { type: "button", className: `chip${sources.includes(source.id) ? ' is-on' : ''}`, "aria-pressed": sources.includes(source.id), onClick: () => toggleSource(source.id), children: source.label }, source.id))), _jsx("span", { className: "find-gap" }), _jsx("span", { className: "find-label", children: "Save to" }), _jsxs("label", { className: "find-dest", children: [_jsx("span", { className: "home-dot", style: { background: target?.color ?? 'var(--accent)' } }), _jsxs("select", { value: target?.id ?? '', onChange: (event) => (event.target.value === '+new' ? void newCollection() : onSaveTo(event.target.value)), "aria-label": "Save to collection", children: [!plain.length ? _jsx("option", { value: "", children: "Library (no collection)" }) : null, plain.map((collection) => (_jsx("option", { value: collection.id, children: collection.name }, collection.id))), _jsx("option", { value: "+new", children: "+ New collection\u2026" })] })] })] })] }), _jsxs("div", { className: "find-cols", children: [_jsxs("section", { className: "home-card find-list", "aria-label": asked ? 'Search results' : 'Suggestions', children: [_jsxs("div", { className: "find-list-head", children: [_jsx("span", { className: "home-eyebrow", children: asked ? `Results for “${clip(asked, 60)}”` : 'Suggested from what you are reading' }), asked ? (_jsx("button", { type: "button", className: "link-btn", onClick: () => onDiscover(asked), children: "People, more pages and Scholar in Discover \u2192" })) : null] }), errors.length ? (_jsxs("p", { className: "find-note", children: [errors.map((error) => error.message).join(' '), ' ', _jsx("button", { type: "button", className: "link-btn", onClick: () => onDiscover(asked), children: "Try it in Discover" })] })) : null, asked && !busy && !results.length && !errors.length ? _jsx("p", { className: "find-note", children: "Nothing found. Try other words, or more sources." }) : null, !asked && suggestions === null ? _jsx("p", { className: "find-note", children: "Looking for papers near what you are reading\u2026" }) : null, !asked && suggestions?.length === 0 ? _jsx("p", { className: "find-note", children: "Search above, and what you save shows up in your collections on the right." }) : null, shown.map((ref, index) => {
                                const have = inLibrary(ref);
                                const year = /^\d{4}/.exec(ref.published || '')?.[0];
                                const open = openId === ref.id;
                                return (_jsxs("div", { className: `find-item${open ? ' is-open' : ''}`, children: [_jsxs("div", { className: `find-row${index === selected ? ' is-selected' : ''}`, tabIndex: 0, draggable: true, "aria-expanded": open, title: "Click to see everywhere it can be read", onFocus: () => setSelected(index), onClick: (event) => {
                                                // The buttons on the row do their own thing; anywhere else opens it.
                                                if (event.target.closest('button, a, select, .find-pick'))
                                                    return;
                                                setOpenId(open ? null : ref.id);
                                            }, onDragStart: (event) => {
                                                event.dataTransfer.setData(REF_MIME, JSON.stringify(ref));
                                                event.dataTransfer.effectAllowed = 'copy';
                                            }, children: [_jsxs("div", { className: "find-row-text", children: [!asked && why.get(ref.id) ? _jsx("span", { className: "find-why", children: why.get(ref.id) }) : null, _jsx("span", { className: "find-title", children: ref.title }), _jsxs("span", { className: "home-row-sub", children: [authorLine(ref.authors, 3), ref.venue ? ` · ${clip(ref.venue, 50)}` : '', year ? ` · ${year}` : '', typeof ref.citedBy === 'number' ? ` · ${ref.citedBy.toLocaleString()} citations` : '', ref.scholarVersions ? ` · ${ref.scholarVersions} versions` : '', ref.pdfUrl ? ' · PDF' : ''] })] }), have ? (_jsxs("span", { className: "find-have", children: [_jsx(CheckIcon, { size: 13 }), " In ", collections.find((c) => have.collectionIds.includes(c.id))?.name ?? 'your library', " \u00B7 ", statusOf(have) === 'unread' ? 'not started' : progressLabel(have.progress)] })) : null, _jsx("button", { type: "button", className: "btn sm", onClick: () => void read(ref), children: have ? 'Open' : 'Read' }), _jsx(AddToProject, { paperRef: have ? { ...ref, id: have.id } : ref, compact: true, align: "right" }), have && target && have.collectionIds.includes(target.id) ? null : (_jsxs("span", { className: "find-split", children: [_jsxs("button", { type: "button", className: "btn primary sm", onClick: () => void save(ref, target), title: target ? `Save to ${target.name} (A)` : 'Save to your library, in no collection (A)', children: [_jsx(PlusIcon, { size: 13 }), " ", target ? clip(target.name, 22) : 'Library'] }), _jsx("button", { type: "button", className: "btn primary sm", "aria-label": "Save to another collection", "aria-expanded": picking === ref.id, onClick: () => setPicking(picking === ref.id ? null : ref.id), children: _jsx(ChevronDownIcon, { size: 13 }) }), picking === ref.id ? (_jsxs("div", { className: "find-pick", role: "menu", children: [_jsx("span", { className: "home-eyebrow", children: "Save to" }), plain.map((collection, at) => (_jsxs("button", { type: "button", role: "menuitem", onClick: () => void save(ref, collection), children: [_jsx("span", { className: "home-dot", style: { background: collection.color } }), collection.name, have?.collectionIds.includes(collection.id) ? _jsx(CheckIcon, { size: 12 }) : null, at < 9 ? _jsx("kbd", { children: at + 1 }) : null] }, collection.id))), _jsxs("button", { type: "button", role: "menuitem", className: "find-pick-new", onClick: () => void newCollection(ref), children: [_jsx(PlusIcon, { size: 12 }), " New collection\u2026"] })] })) : null] }))] }), open ? (_jsxs("div", { className: "find-detail", children: [ref.abstract ? (_jsxs("p", { className: "find-abstract", children: [ref.abstract.slice(0, 420), ref.abstract.length > 420 ? '…' : ''] })) : null, _jsx(Locations, { paper: ref }), _jsxs("div", { className: "find-detail-actions", children: [have && target && have.collectionIds.includes(target.id) ? (_jsxs("span", { className: "find-have", children: [_jsx(CheckIcon, { size: 13 }), " In ", target.name] })) : (_jsxs("button", { type: "button", className: "btn primary sm", onClick: () => void save(ref, target), children: [_jsx(PlusIcon, { size: 13 }), " Save to ", target ? clip(target.name, 24) : 'your library'] })), _jsx("button", { type: "button", className: "btn sm", onClick: () => void read(ref), children: have ? 'Open' : 'Read' }), ref.landingUrl ? (_jsxs("a", { className: "btn sm", href: ref.landingUrl, target: "_blank", rel: "noreferrer noopener", children: ["Source ", _jsx(ExternalIcon, { size: 12 })] })) : null] })] })) : null] }, `${ref.id}-${index}`));
                            }), shown.length ? (_jsxs("p", { className: "find-keys", children: ["Click a paper to see everywhere it can be read \u00B7 ", _jsx("kbd", { children: "\u2191" }), _jsx("kbd", { children: "\u2193" }), " move \u00B7 ", _jsx("kbd", { children: "\u21B5" }), " open it \u00B7 ", _jsx("kbd", { children: "A" }), " save to ", target?.name ?? 'a collection', " \u00B7 ", _jsx("kbd", { children: "\u25BE" }), " then ", _jsx("kbd", { children: "1" }), "\u2013", _jsx("kbd", { children: "9" }), " another \u00B7 drag onto a collection"] })) : null] }), _jsxs("aside", { className: "home-card find-colls", "aria-label": "Your collections", children: [_jsx("span", { className: "home-eyebrow", children: "Your collections" }), plain.map((collection) => {
                                const count = papers.filter((paper) => paper.collectionIds.includes(collection.id)).length;
                                return (_jsxs("button", { type: "button", className: `find-coll${dropOn === collection.id ? ' is-drop' : ''}${target?.id === collection.id ? ' is-target' : ''}`, title: `Save to ${collection.name} by default`, onClick: () => onSaveTo(collection.id), onDragOver: (event) => {
                                        if (!event.dataTransfer.types.includes(REF_MIME))
                                            return;
                                        event.preventDefault();
                                        setDropOn(collection.id);
                                    }, onDragLeave: () => setDropOn((current) => (current === collection.id ? null : current)), onDrop: (event) => {
                                        setDropOn(null);
                                        const raw = event.dataTransfer.getData(REF_MIME);
                                        if (!raw)
                                            return;
                                        event.preventDefault();
                                        void save(JSON.parse(raw), collection);
                                    }, children: [_jsx("span", { className: "home-dot", style: { background: collection.color } }), _jsx("span", { className: "find-coll-name", children: collection.name }), _jsx("span", { className: "find-coll-count", children: count })] }, collection.id));
                            }), _jsxs("button", { type: "button", className: "find-coll find-coll-new", onClick: () => void newCollection(), children: [_jsx(PlusIcon, { size: 13 }), " New collection"] }), _jsx("p", { className: "find-hint", children: "Click one to save there by default; drop a result on one to save it there." })] })] }), hero && statusOf(hero) === 'reading' ? _jsx(CarryOn, { hero: hero, papers: papers, onOpenPaper: onOpenPaper }) : null, added ? (_jsxs("div", { className: "find-toast", role: "status", onPointerEnter: () => setHoldToast(true), onPointerLeave: () => setHoldToast(false), children: [_jsx(CheckIcon, { size: 14 }), " Added ", _jsx("b", { children: clip(added.title, 48) }), " to ", _jsx("b", { children: added.collection }), _jsx("button", { type: "button", className: "link-btn", onClick: () => void undo(), children: "Undo" }), _jsx("button", { type: "button", className: "btn primary sm", onClick: () => onOpenPaper(added.paperId), children: "Read now" })] })) : null] }));
}
/** Continue reading, made small: the papers in progress, each a sliver of where you stopped. */
function CarryOn({ hero, papers, onOpenPaper }) {
    const others = papers
        .filter((paper) => statusOf(paper) === 'reading' && paper.id !== hero.id)
        .sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''))
        .slice(0, 2);
    return (_jsxs("section", { className: "find-carry", "aria-label": "Continue reading", children: [_jsxs("div", { className: "find-list-head", children: [_jsx("span", { className: "home-eyebrow", children: "Continue reading" }), _jsx("span", { className: "home-row-sub", children: "R while reading lays these out large" })] }), _jsx("div", { className: "find-carry-row", children: [hero, ...others].map((paper) => (_jsx(CarryCard, { paper: paper, onOpen: () => onOpenPaper(paper.id) }, paper.id))) })] }));
}
function CarryCard({ paper, onOpen }) {
    const spot = useSpot(paper.id);
    return (_jsxs("button", { type: "button", className: "home-card find-carry-card", onClick: onOpen, children: [_jsx("span", { className: "find-carry-thumb", "aria-hidden": "true", children: hasPage(spot) ? spot.mode === 'pdf' ? _jsx(PdfPeek, { spot: spot }) : _jsx(ReflowPeek, { spot: spot }) : null }), _jsxs("span", { className: "home-row-text", children: [_jsx("span", { className: "home-row-title", children: paper.title }), _jsx("span", { className: "home-row-sub", children: [progressLabel(paper.progress), whereIn(spot), paper.lastOpenedAt ? sinceLeft(paper.lastOpenedAt) : ''].filter(Boolean).join(' · ') })] })] }));
}
