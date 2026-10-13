import { STATUS_LABEL, STATUS_ORDER, statusOf } from './status';
import { coverFor, dayGroup } from './libraryLook';
export const DEFAULT_PREFS = {
    layout: 'list',
    group: 'added',
    sort: 'added',
    show: ['authors', 'venue', 'collections', 'highlights', 'progress'],
};
export const LAYOUT_LABEL = { list: 'List', grid: 'Cards', compact: 'Compact table' };
export const GROUP_LABEL = {
    added: 'Date added',
    status: 'Reading status',
    collection: 'Collection',
    venue: 'Journal or conference',
    year: 'Year published',
    kind: 'Kind (journal, arXiv, book…)',
    none: 'No grouping',
};
export const SORT_LABEL = {
    added: 'Recently added',
    opened: 'Recently opened',
    title: 'Title',
    author: 'First author',
    year: 'Year published',
    progress: 'Progress',
};
export const DETAIL_LABEL = {
    authors: 'Authors',
    venue: 'Journal or conference',
    collections: 'Collections and tags',
    highlights: 'Highlight count',
    progress: 'Reading progress',
};
const KEY = 'reader.libraryView';
/** The key the layout alone was kept under before the View menu. */
const OLD_LAYOUT_KEY = 'reader.libraryLayout';
const pick = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
/** What was chosen last on this device, anything unknown or missing falling back to the default. */
export function readPrefs(storage = globalThis.localStorage) {
    try {
        const raw = JSON.parse(storage?.getItem(KEY) || 'null');
        const old = storage?.getItem(OLD_LAYOUT_KEY);
        const details = Object.keys(DETAIL_LABEL);
        return {
            layout: pick(raw?.layout ?? old, Object.keys(LAYOUT_LABEL), DEFAULT_PREFS.layout),
            group: pick(raw?.group, Object.keys(GROUP_LABEL), DEFAULT_PREFS.group),
            sort: pick(raw?.sort, Object.keys(SORT_LABEL), DEFAULT_PREFS.sort),
            show: Array.isArray(raw?.show) ? raw.show.filter((detail) => details.includes(detail)) : DEFAULT_PREFS.show,
        };
    }
    catch {
        return DEFAULT_PREFS;
    }
}
export function writePrefs(prefs, storage = globalThis.localStorage) {
    try {
        storage?.setItem(KEY, JSON.stringify(prefs));
    }
    catch {
        // kept for this visit only
    }
}
const yearOf = (paper) => Number(/^\d{4}/.exec(paper.published || '')?.[0]) || 0;
const surname = (paper) => (paper.authors[0] || '').trim().split(/\s+/).pop()?.toLowerCase() || '￿';
export function sortPapers(papers, sort) {
    return papers.slice().sort((a, b) => {
        if (sort === 'title')
            return a.title.localeCompare(b.title);
        if (sort === 'author')
            return surname(a).localeCompare(surname(b)) || a.title.localeCompare(b.title);
        if (sort === 'progress')
            return b.progress - a.progress;
        if (sort === 'year')
            return yearOf(b) - yearOf(a);
        if (sort === 'opened')
            return (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || '');
        return b.addedAt.localeCompare(a.addedAt);
    });
}
/**
 * The papers, already in order, under headings. The groups come in an order
 * of their own — newest day first, the statuses as the side pane has them,
 * collections as they are listed, journals by name, years newest first —
 * with whatever has no value last. Within each, the papers keep their order.
 * A paper in two collections is under both.
 */
export function groupPapers(papers, group, collections = [], now = new Date()) {
    if (group === 'none')
        return [{ key: 'all', name: '', items: papers }];
    const buckets = new Map();
    const put = (key, name, rank, paper, color) => {
        const known = buckets.get(key);
        if (known)
            known.items.push(paper);
        else
            buckets.set(key, { key, name, rank, color, items: [paper] });
    };
    const LAST = '￿';
    for (const paper of papers) {
        if (group === 'added') {
            put(dayGroup(paper.addedAt, now), dayGroup(paper.addedAt, now), -new Date(paper.addedAt).getTime() || 0, paper);
        }
        else if (group === 'status') {
            const status = statusOf(paper);
            put(status, STATUS_LABEL[status], STATUS_ORDER.indexOf(status), paper);
        }
        else if (group === 'collection') {
            const mine = collections.filter((collection) => paper.collectionIds.includes(collection.id));
            if (!mine.length)
                put('none', 'In no collection', collections.length, paper);
            for (const collection of mine)
                put(collection.id, collection.name, collections.indexOf(collection), paper, collection.color);
        }
        else if (group === 'venue') {
            const venue = paper.venue?.trim();
            put(venue ? venue.toLowerCase() : 'none', venue || 'No journal or conference', venue ? venue.toLowerCase() : LAST, paper);
        }
        else if (group === 'year') {
            const year = yearOf(paper);
            put(String(year || 'none'), year ? String(year) : 'No year', year ? -year : 0, paper);
        }
        else if (group === 'kind') {
            const { kind } = coverFor(paper);
            put(kind, kind, kind.toLowerCase(), paper);
        }
    }
    // A day's rank is its newest paper, so the rank of a bucket is the least seen.
    if (group === 'added') {
        for (const bucket of buckets.values())
            bucket.rank = Math.min(...bucket.items.map((paper) => -new Date(paper.addedAt).getTime() || 0));
    }
    return [...buckets.values()]
        .sort((a, b) => (typeof a.rank === 'number' && typeof b.rank === 'number' ? a.rank - b.rank : String(a.rank).localeCompare(String(b.rank))))
        .map(({ key, name, color, items }) => ({ key, name, color, items }));
}
