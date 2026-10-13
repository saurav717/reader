// Projects: a collection with a question, papers in roles, a to-do list and
// code of its own (types.ts, `ProjectInfo`). Being a collection is what keeps
// it simple — its papers are the collection's, a paper in two projects is in
// two collections, and Drive keeps a project the way it keeps any collection.
// What is here reads that record and nothing else: no store, no React, so it
// can be tested without a browser.
import { overleafLinkOf } from './overleaf';
export const ROLES = [
    { id: 'core', label: 'Core', note: 'What the project builds on' },
    { id: 'baseline', label: 'Baseline', note: 'What it is measured against' },
    { id: 'method', label: 'Method', note: 'A technique it borrows' },
    { id: 'related', label: 'Related', note: 'Context, for the write-up' },
];
const ROLE_IDS = new Set(ROLES.map((role) => role.id));
export const roleLabel = (role) => ROLES.find((item) => item.id === role)?.label ?? 'Unsorted';
/** A fresh project record. */
export function newProjectInfo(question = '', now = new Date()) {
    return { question: question.trim(), startedAt: now.toISOString(), roles: {}, todos: [] };
}
/**
 * A collection's project as it can be relied on, or null when it is not one.
 * What came from Drive was written by any version of the app, or by hand:
 * whatever is missing or the wrong shape is put right here, not trusted.
 */
export function projectInfo(collection) {
    const raw = collection?.project;
    if (!raw || typeof raw !== 'object')
        return null;
    const roles = {};
    if (raw.roles && typeof raw.roles === 'object') {
        for (const [id, role] of Object.entries(raw.roles))
            if (ROLE_IDS.has(role))
                roles[id] = role;
    }
    const todos = Array.isArray(raw.todos)
        ? raw.todos
            .filter((todo) => Boolean(todo) && typeof todo.id === 'string' && typeof todo.text === 'string')
            .map((todo) => ({ id: todo.id, text: todo.text, done: Boolean(todo.done) }))
        : [];
    return {
        question: typeof raw.question === 'string' ? raw.question : '',
        startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : collection.createdAt,
        roles,
        playgroundId: typeof raw.playgroundId === 'string' && raw.playgroundId ? raw.playgroundId : undefined,
        todos,
        ...(overleafLinkOf(raw.overleaf) ? { overleaf: overleafLinkOf(raw.overleaf) } : {}),
        ...(codeRepoOf(raw.codeRepo) ? { codeRepo: codeRepoOf(raw.codeRepo) } : {}),
    };
}
/** Where the project's code goes on GitHub, as kept: owner/name and a branch, or nothing. */
function codeRepoOf(raw) {
    if (!raw || typeof raw !== 'object')
        return undefined;
    const value = raw;
    if (typeof value.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(value.repo))
        return undefined;
    return {
        repo: value.repo,
        branch: typeof value.branch === 'string' && value.branch ? value.branch : 'main',
        ...(typeof value.pushedAt === 'string' ? { pushedAt: value.pushedAt } : {}),
        ...(typeof value.commit === 'string' ? { commit: value.commit } : {}),
        ...(typeof value.files === 'number' ? { files: value.files } : {}),
    };
}
export const isProject = (collection) => projectInfo(collection) !== null;
/** The collections that are projects, each with its record put right, oldest first. */
export function projectsOf(collections) {
    return collections.flatMap((collection) => {
        const project = projectInfo(collection);
        return project ? [{ ...collection, project }] : [];
    });
}
/** The collections that are not projects. */
export const plainCollections = (collections) => collections.filter((collection) => !isProject(collection));
/** A project's papers, the one opened last first, then the newest added. */
export function papersIn(projectId, papers) {
    return papers
        .filter((paper) => paper.collectionIds.includes(projectId))
        .sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? '') || b.addedAt.localeCompare(a.addedAt));
}
/** A project's papers under their roles, in the order ROLES gives, the unsorted last; empty groups left out. */
export function byRole(project, papers) {
    const mine = papersIn(project.id, papers);
    const groups = ROLES.map((role) => ({ role: role.id, label: role.label, papers: mine.filter((paper) => project.project.roles[paper.id] === role.id) }));
    groups.push({ role: null, label: 'Unsorted', papers: mine.filter((paper) => !project.project.roles[paper.id]) });
    return groups.filter((group) => group.papers.length);
}
/** Where a paper stands, from how far into it the reader has got. */
export function readingState(paper) {
    if (paper.progress >= 0.95)
        return 'done';
    if (paper.progress > 0.01 || paper.lastOpenedAt)
        return 'reading';
    return 'not started';
}
/** The paper to carry on with: the one opened last that is not finished, else the first not started. */
export function continueWith(project, papers) {
    const mine = papersIn(project.id, papers);
    return mine.find((paper) => paper.lastOpenedAt && readingState(paper) !== 'done') ?? mine.find((paper) => readingState(paper) === 'not started');
}
/** When anything in the project last happened that the page knows of: a paper of it opened or added, or the project made. */
export function lastActive(project, papers) {
    let latest = project.project.startedAt;
    for (const paper of papers) {
        if (!paper.collectionIds.includes(project.id))
            continue;
        for (const at of [paper.lastOpenedAt, paper.addedAt])
            if (at && at > latest)
                latest = at;
    }
    return latest;
}
/** How many of a project's papers are in each of the other projects, the most first; none left out. */
export function sharedWith(project, projects, papers) {
    const mine = papers.filter((paper) => paper.collectionIds.includes(project.id));
    return projects
        .filter((other) => other.id !== project.id)
        .map((other) => ({ project: other, count: mine.filter((paper) => paper.collectionIds.includes(other.id)).length }))
        .filter((item) => item.count > 0)
        .sort((a, b) => b.count - a.count);
}
/** Two letters for a project's mark on the rail: the first of its first two words, else its first two. */
export function initialsOf(name) {
    const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!words.length)
        return '?';
    const [first, second] = words;
    const two = second ? first[0] + second[0] : first.slice(0, 2);
    return two.toUpperCase();
}
/** The project with a paper put in a role, or taken out of every role with null. */
export function withRole(info, paperId, role) {
    const roles = { ...info.roles };
    if (role)
        roles[paperId] = role;
    else
        delete roles[paperId];
    return { ...info, roles };
}
/** A paper's collections with a project added or taken away. */
export function toggledIn(collectionIds, projectId, on) {
    const without = collectionIds.filter((id) => id !== projectId);
    return on ? [...without, projectId] : without;
}
const ago = (iso, now) => {
    const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
    if (!Number.isFinite(s))
        return '';
    if (s < 3600)
        return 'just now';
    if (s < 86_400)
        return 'today';
    const d = Math.round(s / 86_400);
    if (d === 1)
        return 'yesterday';
    if (d < 7)
        return `${d} days ago`;
    if (d < 14)
        return 'last week';
    if (d < 60)
        return `${Math.round(d / 7)} weeks ago`;
    return `${Math.round(d / 30)} months ago`;
};
/** When something happened, said the way a person would: "today", "3 days ago", "last week". */
export const whenSaid = (iso, now = Date.now()) => ago(iso, now);
