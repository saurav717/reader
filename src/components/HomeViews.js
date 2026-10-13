import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { STATUS_LABEL, statusOf } from '../lib/status';
import { authorLine, relativeDay } from '../lib/libraryLook';
import { lastVisit } from '../lib/homeViews';
import { CoverTile, ProgressRing, progressLabel } from './LibraryBits';
import { PdfPeek, ReflowPeek, clip, hasPage, sinceLeft, useSpot, whereIn } from './HomeParts';
import { ClockIcon, HighlighterIcon, InboxIcon, StackIcon } from './icons';
const DAY = 24 * 3600 * 1000;
/** A paper in progress not opened for this long is said to have stalled. */
export const STALLED_DAYS = 5;
const idleDays = (paper, now) => (paper.lastOpenedAt ? Math.floor((now.getTime() - new Date(paper.lastOpenedAt).getTime()) / DAY) : 0);
const byOpened = (a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? '');
const byAdded = (a, b) => b.addedAt.localeCompare(a.addedAt);
/** Papers added since the visit before this one — or in the last week, on a first. */
export function inboxOf(papers, now = new Date()) {
    const since = lastVisit() ?? new Date(now.getTime() - 7 * DAY).toISOString();
    return { since, fresh: papers.filter((paper) => statusOf(paper) === 'unread' && paper.addedAt > since).sort(byAdded) };
}
/**
 * Today: a short plan for this sitting, made from the library — carry on with
 * the paper you were reading, pick up the ones that stalled, start the next
 * one, and look over this week's highlights.
 */
export function TodayView({ hero, onOpenPaper, onShowNotes }) {
    const { papers, highlights } = useStore();
    const now = new Date();
    const spot = useSpot(hero?.id);
    const plan = useMemo(() => {
        const items = [];
        if (hero && statusOf(hero) === 'reading') {
            items.push({
                key: `carry-${hero.id}`,
                icon: _jsx(ProgressRing, { progress: hero.progress, size: 30 }),
                title: `Carry on with ${hero.title}`,
                detail: `${progressLabel(hero.progress)}${spot ? ` · ${whereIn(spot)}` : ''}${hero.lastOpenedAt ? ` · left ${sinceLeft(hero.lastOpenedAt, now)}` : ''}`,
                action: 'Resume',
                run: () => onOpenPaper(hero.id),
            });
        }
        for (const paper of papers
            .filter((item) => statusOf(item) === 'reading' && item.id !== hero?.id && idleDays(item, now) >= STALLED_DAYS)
            .sort(byOpened)
            .slice(0, 2)) {
            items.push({
                key: `stalled-${paper.id}`,
                icon: _jsx(ProgressRing, { progress: paper.progress, size: 30 }),
                title: `Pick back up: ${paper.title}`,
                detail: (_jsxs(_Fragment, { children: [progressLabel(paper.progress), " \u00B7 ", _jsxs("span", { className: "home-stalled", children: ["not opened for ", idleDays(paper, now), " days"] })] })),
                action: 'Open',
                run: () => onOpenPaper(paper.id),
            });
        }
        for (const paper of papers.filter((item) => statusOf(item) === 'unread' && item.id !== hero?.id).sort(byAdded).slice(0, 2)) {
            items.push({
                key: `start-${paper.id}`,
                icon: _jsx(CoverTile, { paper: paper, size: "mini" }),
                title: `Start ${paper.title}`,
                detail: `${authorLine(paper.authors, 2)} · added ${relativeDay(paper.addedAt, now)}`,
                action: 'Start',
                run: () => onOpenPaper(paper.id),
            });
        }
        const week = highlights.filter((highlight) => !highlight.orphaned && now.getTime() - new Date(highlight.createdAt).getTime() < 7 * DAY);
        if (week.length) {
            const notes = week.filter((highlight) => highlight.note).length;
            items.push({
                key: 'review',
                icon: (_jsx("span", { className: "home-plan-icon", children: _jsx(HighlighterIcon, { size: 16 }) })),
                title: `Look over ${week.length} highlight${week.length === 1 ? '' : 's'} from this week`,
                detail: `${new Set(week.map((highlight) => highlight.paperId)).size} paper${new Set(week.map((highlight) => highlight.paperId)).size === 1 ? '' : 's'}${notes ? ` · ${notes} with a note` : ''}`,
                action: 'Show',
                run: onShowNotes,
            });
        }
        return items;
        // `now` is this render's; the plan follows the library, not the clock.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [papers, highlights, hero, spot, onOpenPaper, onShowNotes]);
    const openedThisWeek = papers.filter((paper) => paper.lastOpenedAt && now.getTime() - new Date(paper.lastOpenedAt).getTime() < 7 * DAY).length;
    const highlightsThisWeek = highlights.filter((highlight) => now.getTime() - new Date(highlight.createdAt).getTime() < 7 * DAY).length;
    const inProgress = papers.filter((paper) => statusOf(paper) === 'reading').length;
    return (_jsxs("div", { className: "home-view home-today", children: [_jsxs("section", { className: "home-card", children: [_jsxs("div", { className: "home-view-head", children: [_jsx("h2", { children: "Your plan for today" }), _jsx("p", { children: "Made from your library: what you were reading, what stalled, what is next, and what you marked this week." })] }), plan.length ? (plan.map((item, index) => (_jsxs("div", { className: `home-plan${index === 0 ? ' is-first' : ''}`, children: [_jsx("span", { className: "home-plan-step", children: index + 1 }), item.icon, _jsxs("span", { className: "home-row-text", children: [_jsx("span", { className: "home-row-title", children: clip(item.title, 140) }), _jsx("span", { className: "home-row-sub", children: item.detail })] }), _jsx("button", { type: "button", className: `btn${index === 0 ? ' primary' : ''}`, onClick: item.run, children: item.action })] }, item.key)))) : (_jsx("p", { className: "home-view-empty", children: "Nothing is waiting. Add a paper from Discover and it will be here." }))] }), _jsxs("aside", { className: "home-card home-week", children: [_jsx("h2", { className: "home-eyebrow", children: "This week" }), _jsxs("div", { className: "home-stats", children: [_jsxs("span", { children: [_jsx("b", { children: openedThisWeek }), " papers opened"] }), _jsxs("span", { children: [_jsx("b", { children: highlightsThisWeek }), " highlights"] }), _jsxs("span", { children: [_jsx("b", { children: inProgress }), " in progress"] })] })] })] }));
}
const LANES = ['unread', 'reading', 'finished'];
/** Projects: each collection, its papers set out by how far you are with them. */
export function ProjectsView({ hero, onOpenPaper }) {
    const { papers, collections } = useStore();
    const now = new Date();
    const [chosen, setChosen] = useState(() => hero?.collectionIds.find((id) => collections.some((c) => c.id === id)) ?? collections[0]?.id ?? null);
    const collection = collections.find((item) => item.id === chosen) ?? collections[0];
    if (!collection) {
        return (_jsx("div", { className: "home-view", children: _jsxs("section", { className: "home-card home-view-empty-card", children: [_jsx("h2", { children: "No collections yet" }), _jsx("p", { children: "A collection is a project: the papers for one question, set out here by how far you are with each. Make one with the + beside Collections in the library." })] }) }));
    }
    const inIt = papers.filter((paper) => paper.collectionIds.includes(collection.id));
    const lastOpened = inIt.filter((paper) => paper.lastOpenedAt && statusOf(paper) !== 'finished').sort(byOpened)[0];
    return (_jsxs("div", { className: "home-view home-projects", children: [_jsxs("nav", { className: "home-card home-project-list", "aria-label": "Collections", children: [_jsx("h2", { className: "home-eyebrow", children: "Collections" }), collections.map((item) => {
                        const members = papers.filter((paper) => paper.collectionIds.includes(item.id));
                        const reading = members.filter((paper) => statusOf(paper) === 'reading').length;
                        return (_jsxs("button", { type: "button", className: `home-project${item.id === collection.id ? ' is-on' : ''}`, "aria-pressed": item.id === collection.id, onClick: () => setChosen(item.id), children: [_jsx("span", { className: "home-project-dot", style: { background: item.color } }), _jsxs("span", { className: "home-row-text", children: [_jsx("span", { className: "home-project-name", children: item.name }), _jsxs("span", { className: "home-row-sub", children: [members.length, " paper", members.length === 1 ? '' : 's', reading ? ` · ${reading} reading` : ''] })] })] }, item.id));
                    })] }), _jsxs("section", { className: "home-project-main", children: [_jsxs("div", { className: "home-project-head", children: [_jsxs("div", { children: [_jsx("span", { className: "home-eyebrow", children: "Collection" }), _jsx("h2", { children: collection.name })] }), lastOpened ? (_jsxs("button", { type: "button", className: "btn primary", onClick: () => onOpenPaper(lastOpened.id), title: lastOpened.title, children: ["Resume ", clip(lastOpened.title, 34)] })) : null] }), _jsx("div", { className: "home-lanes", children: LANES.map((lane) => {
                            const members = inIt.filter((paper) => statusOf(paper) === lane).sort(lane === 'unread' ? byAdded : byOpened);
                            return (_jsxs("div", { className: "home-lane", children: [_jsxs("div", { className: "home-lane-head", children: [_jsx("span", { className: "home-eyebrow", children: STATUS_LABEL[lane] }), _jsx("span", { className: "home-lane-count", children: members.length })] }), members.map((paper) => (_jsxs("button", { type: "button", className: "home-lane-card", onClick: () => onOpenPaper(paper.id), children: [_jsx("span", { className: "home-row-title", children: paper.title }), _jsx("span", { className: "home-row-sub", children: authorLine(paper.authors, 2) }), lane === 'reading' ? (_jsxs("span", { className: "home-lane-progress", children: [_jsx("span", { className: "home-bar-track", children: _jsx("span", { style: { width: `${Math.round(paper.progress * 100)}%` } }) }), idleDays(paper, now) >= STALLED_DAYS ? _jsx("span", { className: "home-stalled", children: "stalled" }) : null] })) : null] }, paper.id))), !members.length ? _jsx("p", { className: "home-lane-empty", children: "None" }) : null] }, lane));
                        }) })] })] }));
}
/** Inbox: papers added since your last visit, not started yet, to open or set aside. */
export function InboxView({ onOpenPaper }) {
    const { papers, setReadingStatus, removePaper } = useStore();
    const now = new Date();
    const { since, fresh } = useMemo(() => inboxOf(papers, now), [papers]); // eslint-disable-line react-hooks/exhaustive-deps
    const waiting = papers.filter((paper) => statusOf(paper) === 'unread' && !fresh.includes(paper)).sort(byAdded).slice(0, 8);
    const row = (paper) => (_jsxs("div", { className: "home-inbox-row", children: [_jsx(CoverTile, { paper: paper, size: "mini" }), _jsxs("span", { className: "home-row-text", children: [_jsx("span", { className: "home-row-title", children: paper.title }), _jsxs("span", { className: "home-row-sub", children: [authorLine(paper.authors, 3), paper.venue ? ` · ${paper.venue}` : '', " \u00B7 added ", relativeDay(paper.addedAt, now)] })] }), _jsxs("span", { className: "home-inbox-actions", children: [_jsx("button", { type: "button", className: "btn primary sm", onClick: () => onOpenPaper(paper.id), children: "Open" }), _jsx("button", { type: "button", className: "btn sm", onClick: () => void setReadingStatus([paper.id], 'finished'), title: "Mark it as read without opening it", children: "Mark read" }), _jsx("button", { type: "button", className: "btn ghost sm", onClick: () => void removePaper(paper.id), title: "Move it to Junk, where it can be put back", children: "Not for me" })] })] }, paper.id));
    return (_jsxs("div", { className: "home-view home-inbox", children: [_jsxs("section", { className: "home-card", children: [_jsxs("div", { className: "home-view-head", children: [_jsxs("h2", { children: [_jsx(InboxIcon, { size: 18 }), " New since your last visit"] }), _jsxs("p", { children: ["Papers added to your library since ", relativeDay(since, now) === 'today' ? 'earlier today' : relativeDay(since, now), " \u2014 from Discover here, or synced from Drive \u2014 that you have not started."] })] }), fresh.length ? fresh.map(row) : _jsx("p", { className: "home-view-empty", children: "Nothing new since then." })] }), waiting.length ? (_jsxs("section", { className: "home-card", children: [_jsxs("div", { className: "home-view-head", children: [_jsxs("h2", { children: [_jsx(StackIcon, { size: 18 }), " Still waiting"] }), _jsx("p", { children: "Added before that, and not started yet." })] }), waiting.map(row)] })) : null] }));
}
/** On the views other than Continue reading: the paper you left, a few lines of it, one key away. */
export function ResumeStrip({ paper, onOpen }) {
    const spot = useSpot(paper.id);
    const now = new Date();
    return (_jsxs("div", { className: "home-strip", children: [_jsxs("div", { className: "home-strip-meta", children: [_jsxs("span", { className: "home-eyebrow accent", children: [_jsx(ClockIcon, { size: 12 }), " Pick up where you left off"] }), _jsx("span", { className: "home-row-title", children: paper.title }), _jsx("span", { className: "home-row-sub", children: [progressLabel(paper.progress), whereIn(spot), paper.lastOpenedAt ? sinceLeft(paper.lastOpenedAt, now) : ''].filter(Boolean).join(' · ') })] }), hasPage(spot) ? (_jsx("button", { type: "button", className: "home-strip-page", onClick: onOpen, "aria-label": `Open ${paper.title} where you stopped`, children: spot.mode === 'pdf' ? _jsx(PdfPeek, { spot: spot }) : _jsx(ReflowPeek, { spot: spot }) })) : null, _jsxs("button", { type: "button", className: "btn primary home-resume", onClick: onOpen, children: ["Resume ", _jsx("kbd", { children: "\u21B5" })] })] }));
}
