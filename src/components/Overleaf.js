import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// A project's paper, written in Overleaf: linking the two, the paper's card
// on the overview, Overleaf opened beside the reader, and the draft edited
// here — in the workspace's Write layout or the dock's Draft tab — when the
// paper is also in a GitHub repository. Which of those a project shows is
// the choice in Settings (types.ts, `OVERLEAF_VIEWS`); the card is in all.
// What the files say is src/lib/overleaf.ts.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useStore } from '../lib/store';
import { DraftConflict, besideFeatures, bibFileOf, bibtexFor, draftHealth, draftTarget, latexLinkAt, latexOwner, keyFor, mainFileOf, overleafGitUrl, overleafViewOf, parseOverleafUrl, quoteOf, readDraft, writeDraft, } from '../lib/overleaf';
import { createPrivateRepo, makeRepoPrivate, parseRepo, repoNameFor, repoState } from '../lib/github';
import { papersIn, projectsOf } from '../lib/projects';
import CodeEditor from './CodeEditor';
import { SyncedThrough, useOverleafAccounts } from './OverleafAccounts';
import { GitHubConnect as Connect } from './Connections';
import { agoShort, lastPlace, notNow, openWriteHome, saidNotNow } from '../lib/writePlace';
import { CheckIcon, CopyIcon, ExternalIcon, LockIcon } from './icons';
// -------------------------------------------------- opening Overleaf --
/** Opens the project in Overleaf: in a window on the right half of the screen when it goes beside, else in a tab. */
export function openOverleaf(link, projectId, view) {
    const opened = view === 'beside'
        ? window.open(link.url, `reader-overleaf-${projectId}`, besideFeatures(window.screen))
        : window.open(link.url, `reader-overleaf-${projectId}`);
    if (!opened) {
        window.location.assign(link.url);
        return;
    }
    // Overleaf is another site: it gets no handle back on this page.
    try {
        opened.opener = null;
    }
    catch {
        // already gone across
    }
    opened.focus();
}
async function copy(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * The project's Open button: Overleaf beside, or in a new tab, as Settings
 * says — in this browser, signed in as Overleaf is here.
 */
export function OpenOverleaf({ project, view, primary = true, compact = false, url }) {
    const own = project.project.overleaf;
    const link = url === undefined ? own : url ? { ...(own ?? {}), url } : undefined;
    if (!link?.url)
        return null;
    return (_jsx("span", { className: `ol-open${compact ? ' is-compact' : ''}`, children: _jsxs("button", { type: "button", className: `btn sm${primary ? ' primary' : ''}`, title: view === 'beside' ? 'Overleaf in a window beside this one' : 'Overleaf in a new tab', onClick: () => openOverleaf(link, project.id, view), children: [_jsx(ExternalIcon, { size: 13 }), " ", compact ? 'Overleaf' : view === 'beside' ? 'Open Overleaf beside' : 'Open in Overleaf'] }) }));
}
const EMPTY = { status: 'idle', files: [], edits: {} };
const drafts = new Map();
const watchers = new Set();
const put = (id, change) => {
    drafts.set(id, change(drafts.get(id) ?? EMPTY));
    watchers.forEach((watcher) => watcher());
};
const watch = (watcher) => (watchers.add(watcher), () => void watchers.delete(watcher));
/** The files as they read now: as saved, with what was typed here over them. */
export const currentFiles = (state) => {
    const files = state.files.map((file) => (file.path in state.edits ? { ...file, text: state.edits[file.path] } : file));
    for (const [path, text] of Object.entries(state.edits))
        if (!state.files.some((file) => file.path === path))
            files.push({ path, text, sha: '' });
    return files;
};
async function loadDraft(project, settings) {
    const link = project.project.overleaf;
    const target = draftTarget(link, settings);
    if (!link || !target)
        return;
    put(project.id, (state) => ({ ...state, status: 'loading', error: undefined }));
    try {
        const files = await readDraft(target, link);
        put(project.id, (state) => ({ ...state, status: 'ready', files, conflict: undefined }));
    }
    catch (error) {
        put(project.id, (state) => ({ ...state, status: 'error', error: error instanceof Error ? error.message : String(error) }));
    }
}
async function saveDraft(project, settings) {
    const target = draftTarget(project.project.overleaf, settings);
    const state = drafts.get(project.id);
    if (!target || !state)
        return;
    const changed = currentFiles(state).filter((file) => file.path in state.edits && state.edits[file.path] !== state.files.find((f) => f.path === file.path)?.text);
    if (!changed.length) {
        put(project.id, (current) => ({ ...current, edits: {} }));
        return;
    }
    put(project.id, (current) => ({ ...current, saving: true, error: undefined }));
    const names = changed.map((file) => file.path.split('/').pop()).join(', ');
    try {
        const saved = await writeDraft(target, changed, `Edit ${names} from Reader`);
        put(project.id, (current) => {
            const files = current.files.filter((file) => !saved.some((s) => s.path === file.path)).concat(saved).sort((a, b) => a.path.localeCompare(b.path));
            const edits = { ...current.edits };
            // What was typed while it saved stays an edit.
            for (const file of saved)
                if (edits[file.path] === file.text)
                    delete edits[file.path];
            return { ...current, files, edits, saving: false, savedAt: Date.now(), conflict: undefined };
        });
    }
    catch (error) {
        put(project.id, (current) => ({
            ...current,
            saving: false,
            conflict: error instanceof DraftConflict ? error.paths : undefined,
            error: error instanceof Error ? error.message : String(error),
        }));
    }
}
/** The project's draft, read from its repository the first time it is asked for. */
function useDraft(project) {
    const { settings } = useStore();
    const state = useSyncExternalStore(watch, () => (project ? drafts.get(project.id) ?? EMPTY : EMPTY));
    const target = draftTarget(project?.project.overleaf, settings);
    const repoKey = project?.project.overleaf ? `${project.project.overleaf.repo}#${project.project.overleaf.branch ?? ''}#${project.project.overleaf.folder ?? ''}` : '';
    useEffect(() => {
        if (!project || !target)
            return;
        const current = drafts.get(project.id);
        if (current && current.status !== 'idle' && current.key === repoKey)
            return;
        drafts.set(project.id, { ...EMPTY, key: repoKey });
        void loadDraft(project, settings);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [project?.id, repoKey, Boolean(target)]);
    const files = useMemo(() => currentFiles(state), [state]);
    return {
        state,
        files,
        target,
        dirty: Object.keys(state.edits).length > 0,
        reload: () => project && void loadDraft(project, settings),
        /** What was typed here and not saved, dropped. */
        drop: () => project && put(project.id, (current) => ({ ...current, edits: {}, conflict: undefined, error: undefined })),
        save: () => project && void saveDraft(project, settings),
        edit: (path, text) => project && put(project.id, (current) => ({ ...current, edits: { ...current.edits, [path]: text } })),
    };
}
/** The paper's entry put in the bib file as an edit, unless the draft already has one for it. */
function addEntry(project, files, paper) {
    const entries = draftHealth(files, []).entries;
    if (entries.some((entry) => entry.key === keyFor(paper, entries)))
        return;
    const path = bibFileOf(files) ?? `${project.project.overleaf?.folder ? `${project.project.overleaf.folder}/` : ''}references.bib`;
    const text = files.find((file) => file.path === path)?.text ?? '';
    put(project.id, (current) => ({ ...current, edits: { ...current.edits, [path]: `${text.replace(/\s*$/, '')}${text.trim() ? '\n\n' : ''}${bibtexFor(paper, entries)}\n` } }));
}
// ---------------------------------------------------------- linking --
function updateLink(updateCollection, project, link) {
    void updateCollection(project.id, (collection) => ({ project: { ...project.project, ...(collection.project ?? {}), overleaf: link } }));
}
/** The form that links a project to Overleaf, and its GitHub repository if it has one. */
// ------------------------------------------------ GitHub, kept private --
/**
 * The GitHub account the paper's repository is reached with: the one
 * connected under Projects → Connections, its token kept by Reader's server.
 */
export function GitHubConnect({ onAccount }) {
    return _jsx(Connect, { compact: true, onAccount: onAccount });
}
/** Whether the paper's repository is private, as the token sees it; and the way to make it so. */
export function RepoPrivacy({ repo }) {
    const { settings } = useStore();
    const token = settings.githubToken.trim();
    const parsed = parseRepo(repo);
    const [state, setState] = useState(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (!token || !parsed)
            return;
        let live = true;
        repoState(token, parsed.owner, parsed.repo).then((found) => live && setState(found), (error) => live && setState({ error: error instanceof Error ? error.message : String(error) }));
        return () => {
            live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token, repo]);
    if (!token || !parsed || !state)
        return null;
    if ('error' in state)
        return _jsxs("span", { className: "gh-privacy is-unknown", title: state.error, children: ["Can\u2019t see ", repo] });
    if (state.private) {
        return (_jsxs("span", { className: "gh-privacy is-private", title: `${state.fullName} is private: only you and the people you add on GitHub can read it`, children: [_jsx(LockIcon, { size: 12 }), " Private"] }));
    }
    return (_jsxs("span", { className: "gh-privacy is-public", children: ["Public: anyone can read this draft", state.admin ? (_jsxs("button", { type: "button", className: "btn sm", disabled: busy, onClick: async () => {
                    setBusy(true);
                    try {
                        setState(await makeRepoPrivate(token, parsed.owner, parsed.repo));
                    }
                    catch (error) {
                        setState({ error: error instanceof Error ? error.message : String(error) });
                    }
                    finally {
                        setBusy(false);
                    }
                }, children: [_jsx(LockIcon, { size: 12 }), " ", busy ? 'Making it private…' : 'Make it private'] })) : null] }));
}
function LinkForm({ project, onDone, note }) {
    const { updateCollection, settings } = useStore();
    const link = project.project.overleaf;
    const [url, setUrl] = useState(link?.url ?? '');
    const [repo, setRepo] = useState(link?.repo ?? '');
    const [branch, setBranch] = useState(link?.branch ?? '');
    const [folder, setFolder] = useState(link?.folder ?? '');
    const parsed = parseOverleafUrl(url);
    const repoParsed = repo.trim() ? parseRepo(repo) : null;
    const [login, setLogin] = useState(null);
    const [making, setMaking] = useState(false);
    const [madeError, setMadeError] = useState(null);
    const makeRepo = async () => {
        setMaking(true);
        setMadeError(null);
        try {
            const made = await createPrivateRepo(settings.githubToken.trim(), repoNameFor(project.name), `The paper for ${project.name}, written in Overleaf and Reader.`);
            setRepo(made.fullName);
            setBranch(made.defaultBranch === 'main' ? '' : made.defaultBranch);
        }
        catch (error) {
            setMadeError(error instanceof Error ? error.message : String(error));
        }
        finally {
            setMaking(false);
        }
    };
    const bad = (url.trim() && !parsed) || (repo.trim() && !repoParsed);
    return (_jsxs("form", { className: "ol-form", onSubmit: (event) => {
            event.preventDefault();
            if (!parsed || bad)
                return;
            updateLink(updateCollection, project, {
                url: parsed,
                ...(repoParsed ? { repo: `${repoParsed.owner}/${repoParsed.repo}` } : {}),
                ...(repoParsed && branch.trim() ? { branch: branch.trim() } : {}),
                ...(repoParsed && folder.trim() ? { folder: folder.trim().replace(/^\/+|\/+$/g, '') } : {}),
            });
            onDone();
        }, children: [note ? _jsx("p", { className: "ol-note", children: note }) : null, _jsxs("label", { className: "ol-field", children: [_jsx("span", { children: "Overleaf project" }), _jsx("input", { autoFocus: true, value: url, placeholder: "https://www.overleaf.com/project/\u2026", onChange: (event) => setUrl(event.target.value) })] }), url.trim() && !parsed ? _jsx("p", { className: "ol-bad", children: "That is not an Overleaf project\u2019s address \u2014 copy it from the address bar with the project open." }) : null, _jsxs("details", { className: "ol-more", open: Boolean(link?.repo), children: [_jsx("summary", { children: "Also in GitHub? Edit and check the draft here \u2014 privately" }), _jsx("p", { className: "pj-sub", children: "With Overleaf\u2019s GitHub sync (Menu \u2192 GitHub), the paper\u2019s .tex and .bib files live in a GitHub repository too: they are read and written there from here, and Overleaf pulls the changes in from the same menu. Keep that repository private: Overleaf syncs with private repositories just the same, and only the people you add on GitHub can read it." }), _jsx(GitHubConnect, { onAccount: setLogin }), _jsxs("label", { className: "ol-field", children: [_jsx("span", { children: "Repository" }), _jsx("input", { value: repo, placeholder: "owner/repo", onChange: (event) => setRepo(event.target.value) })] }), repo.trim() && !repoParsed ? _jsx("p", { className: "ol-bad", children: "Name it as owner/repo, or paste its GitHub address." }) : null, repoParsed ? _jsx(RepoPrivacy, { repo: `${repoParsed.owner}/${repoParsed.repo}` }) : null, login && !repo.trim() ? (_jsx("div", { className: "pj-row", style: { marginTop: 0 }, children: _jsxs("button", { type: "button", className: "btn sm", disabled: making, onClick: () => void makeRepo(), children: [_jsx(LockIcon, { size: 12 }), " ", making ? 'Making it…' : `Make a private repository: ${login}/${repoNameFor(project.name)}`] }) })) : null, madeError ? _jsx("p", { className: "ol-bad", children: madeError }) : null, login ? (_jsx("p", { className: "pj-sub", children: "For an Overleaf project that already exists, make its repository from Overleaf (Menu \u2192 GitHub \u2192 Create a GitHub repository, and tick Private) and name it above. A repository made here is for a new paper: start it in Overleaf with New Project \u2192 Import from GitHub." })) : null, _jsxs("div", { className: "ol-pair", children: [_jsxs("label", { className: "ol-field", children: [_jsx("span", { children: "Branch" }), _jsx("input", { value: branch, placeholder: "main", onChange: (event) => setBranch(event.target.value) })] }), _jsxs("label", { className: "ol-field", children: [_jsx("span", { children: "Folder" }), _jsx("input", { value: folder, placeholder: "the top", onChange: (event) => setFolder(event.target.value) })] })] })] }), _jsxs("div", { className: "pj-row", children: [_jsx("button", { type: "submit", className: "btn primary sm", disabled: !parsed || Boolean(bad), children: link ? 'Save' : 'Link' }), _jsx("button", { type: "button", className: "btn ghost sm", onClick: onDone, children: "Cancel" }), link ? (_jsx("button", { type: "button", className: "btn ghost sm", style: { marginLeft: 'auto' }, onClick: () => {
                            // A link stays until it is taken off on purpose: the folder on each computer, the browser, the compiler go with it.
                            if (!window.confirm(`Unlink “${project.name}” from its Overleaf project? The Overleaf project and the paper’s files on your computers stay as they are; the Write tab asks for them again.`))
                                return;
                            updateLink(updateCollection, project, undefined);
                            drafts.delete(project.id);
                            onDone();
                        }, children: "Unlink" })) : null] })] }));
}
// ------------------------------------------------- the overview card --
/**
 * The paper on the project's overview. It is written here, in the Write tab —
 * Continue writing opens it where it was left — and Overleaf is a sync beside
 * it, linked from here when wanted: never the only way in. With a GitHub
 * repository (Overleaf's GitHub sync), what the draft makes of the project's
 * papers: its sections, what is cited, what is read and not.
 */
export function OverleafCard({ project, onWrite, onWorkspace }) {
    const { papers, settings } = useStore();
    const view = overleafViewOf(settings);
    const link = project.project.overleaf;
    const [linking, setLinking] = useState(false);
    const draft = useDraft(project);
    const mine = useMemo(() => papersIn(project.id, papers), [project.id, papers]);
    const health = useMemo(() => (draft.files.length ? draftHealth(draft.files, mine) : null), [draft.files, mine]);
    const top = health?.headings.filter((heading) => heading.level <= Math.min(...health.headings.map((h) => h.level)) + 1).slice(0, 8) ?? [];
    const most = Math.max(1, ...top.map((heading) => heading.total));
    const place = lastPlace(project.id);
    const started = Boolean(link?.drive?.folder || Object.keys(link?.folders ?? {}).length || place);
    // Each LaTeX project in the paper's folder has an Overleaf project of its own, or none: the one written in last speaks for the card.
    const here = place?.dir ?? '';
    const hereLink = latexLinkAt(link, latexOwner(link, here));
    const onOverleaf = Boolean(overleafGitUrl(hereLink.url));
    // The ones known by their links: the top's when it has one (or was written in), and each folder with a link of its own.
    const latexProjects = link?.drive ? [...(overleafGitUrl(link.url) || (place && !place.dir) ? [''] : []), ...Object.keys(link.latex ?? {})].map((dir) => ({ dir, url: latexLinkAt(link, dir).url })) : [];
    // Overleaf offered, never required: a suggestion for this state, put away with Not now (the button stays).
    const accounts = useOverleafAccounts();
    const [quiet, setQuiet] = useState(() => saidNotNow(project.id, 'card'));
    const accountLabel = accounts?.[0]?.label;
    const suggest = !started || accounts === null || quiet
        ? null
        : onOverleaf && !accounts.length
            ? { text: `${here ? `${here}/ is` : 'This paper is'} linked to Overleaf but isn’t syncing: connect your Overleaf account once, for every project, and it stays in step both ways.`, action: 'Connect account…', tone: 'warn' }
            : !onOverleaf && !accounts.length
                ? { text: 'Coauthors on Overleaf? Optionally connect your Overleaf account and link this LaTeX project to an Overleaf project — kept in step both ways.', action: 'Connect Overleaf…', tone: 'idea' }
                : !onOverleaf
                    ? { text: `Coauthors on Overleaf? Link ${here ? `${here}/` : 'this LaTeX project'} to an Overleaf project as ${accountLabel}${accounts.length > 1 ? ` (or ${accounts.length - 1} other account${accounts.length > 2 ? 's' : ''})` : ''} — nothing more to enter.`, action: 'Sync with Overleaf…', tone: 'idea' }
                    : null;
    const write = (ask) => {
        if (ask)
            openWriteHome(project.id, ask);
        onWrite();
    };
    if (linking) {
        return (_jsxs("section", { className: "pj-panel ol-card", children: [_jsx("span", { className: "eyebrow", children: "The paper \u00B7 its GitHub repository" }), _jsx(LinkForm, { project: project, onDone: () => setLinking(false) })] }));
    }
    return (_jsxs("section", { className: "pj-panel ol-card", children: [_jsxs("div", { className: "ol-head", children: [_jsx("span", { className: "eyebrow", children: "The paper" }), _jsxs("span", { className: `ol-sync${onOverleaf ? ' is-on' : ''}`, title: onOverleaf ? 'This LaTeX project: each save here goes to its Overleaf project, and what coauthors write there comes back' : 'This LaTeX project is kept in Reader only — link it to an Overleaf project of its own to write there too', children: [place && latexProjects.length > 1 ? `${here || 'top'} · ` : '', onOverleaf ? 'Synced with Overleaf' : 'Not on Overleaf'] }), _jsx("span", { style: { flex: 1 } }), link?.repo ? _jsx(RepoPrivacy, { repo: link.repo }) : null, draft.target ? _jsx(DraftStatus, { draft: draft }) : null, link && !link.drive ? (_jsx("button", { type: "button", className: "link-btn", onClick: () => setLinking(true), title: "The GitHub repository Overleaf syncs the paper to: what the outline and citations below are read from", children: "GitHub sync" })) : null] }), _jsxs("div", { className: "ol-card-body", children: [_jsxs("div", { className: "ol-card-main", children: [place ? (_jsxs("p", { className: "ol-place", children: [_jsx("span", { className: "ol-place-label", children: "You left off" }), _jsx("span", { className: "mono", children: place.file }), _jsxs("span", { className: "ol-place-at", children: ["line ", place.line, " \u00B7 ", agoShort(place.at)] })] })) : (_jsx("p", { className: "pj-sub", children: started
                                    ? 'Written in the Write tab: the LaTeX beside its PDF, the project’s papers a click from \\cite.'
                                    : 'Write it here: LaTeX beside its PDF, kept in your Google Drive, the project’s papers a click from \\cite. Overleaf is optional — sync with it whenever you like.' })), _jsxs("div", { className: "pj-row", style: { marginTop: 0 }, children: [_jsx("button", { type: "button", className: "btn primary sm", onClick: () => write(), title: started ? 'The Write tab, at the file and line you were last in' : 'The Write tab: a blank paper, a conference template, or files you upload', children: started ? 'Continue writing →' : 'Start writing' }), view === 'write' && link?.repo ? (_jsx("button", { type: "button", className: "btn sm", onClick: onWorkspace, children: "Write beside the papers" })) : null, onOverleaf ? (_jsx(OpenOverleaf, { project: project, view: view === 'beside' ? 'beside' : 'overview', primary: false, url: hereLink.url })) : suggest ? null : (_jsxs("button", { type: "button", className: "btn ghost sm", onClick: () => write('overleaf'), title: started ? `Link ${here ? `${here}/` : 'this LaTeX project'} to an Overleaf project of its own, kept in step both ways` : 'Already writing it in Overleaf? Bring it here, kept in step both ways', children: [_jsx(ExternalIcon, { size: 13 }), " ", started ? 'Sync with Overleaf…' : 'Bring it from Overleaf…'] }))] }), suggest ? (_jsxs("div", { className: `ol-suggest is-${suggest.tone}`, role: "note", children: [_jsx("p", { children: suggest.text }), _jsxs("span", { className: "ol-suggest-actions", children: [_jsxs("button", { type: "button", className: "btn sm", onClick: () => write('overleaf'), children: [_jsx(ExternalIcon, { size: 13 }), " ", suggest.action] }), _jsx("button", { type: "button", className: "link-btn", onClick: () => (notNow(project.id, 'card'), setQuiet(true)), title: "Put this suggestion away; Overleaf stays a button away", children: "Not now" })] })] })) : null, onOverleaf && accounts?.length ? _jsx(SyncedThrough, { gitAccount: hereLink.gitAccount ?? link?.gitAccount }) : null, latexProjects.length > 1 ? (_jsx("ul", { className: "ol-latex", "aria-label": "Each LaTeX project\u2019s Overleaf project", children: latexProjects.map((one) => (_jsxs("li", { children: [_jsx("span", { className: "mono", children: one.dir ? `${one.dir}/` : 'top of the folder' }), overleafGitUrl(one.url) ? (_jsxs("a", { href: one.url, target: "_blank", rel: "noopener noreferrer", className: "ol-latex-on", children: ["Overleaf \u2026", one.url.slice(-6), " \u2197"] })) : (_jsx("span", { className: "ol-latex-off", children: "not on Overleaf" }))] }, one.dir))) })) : null, view === 'dock' && link?.repo ? _jsx("p", { className: "ol-note", children: "Also in the dock\u2019s Draft tab, beside any paper you open." }) : null, !link?.repo ? null : !draft.target ? (_jsxs("p", { className: "ol-note", children: ["Connect GitHub (Projects \u2192 Connections) to read ", link.repo, " here."] })) : draft.state.status === 'error' && !draft.files.length ? (_jsx("p", { className: "ol-bad", children: draft.state.error })) : null] }), health ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "ol-sections", children: [_jsxs("span", { className: "ol-label", children: ["Sections \u00B7 ", health.words.toLocaleString(), " words"] }), top.length ? (top.map((heading) => (_jsxs("div", { className: `ol-sec${heading.level > top[0].level ? ' is-sub' : ''}`, children: [_jsx("span", { className: "ol-sec-title", children: heading.title || '(untitled)' }), _jsx("span", { className: "ol-sec-bar", children: _jsx("i", { style: { width: `${Math.round((heading.total / most) * 100)}%` } }) }), _jsx("span", { className: "ol-sec-n", children: heading.total.toLocaleString() })] }, `${heading.path}:${heading.line}`)))) : (_jsx("p", { className: "pj-sub", children: "No \\section headings yet." }))] }), _jsxs("div", { className: "ol-cites", children: [_jsxs("span", { className: "ol-label", children: ["Papers \u2194 draft \u00B7 ", health.cited.length, " of ", mine.length, " cited"] }), health.readNotCited.length ? (_jsxs("p", { className: "ol-flag", children: [_jsx("b", { children: "Read, not cited:" }), " ", health.readNotCited.slice(0, 4).map((paper) => paper.title).join(' · '), health.readNotCited.length > 4 ? ` · ${health.readNotCited.length - 4} more` : ''] })) : null, health.missing.length ? (_jsxs("p", { className: "ol-flag is-bad", children: [_jsx("b", { children: "No bib entry for" }), " ", health.missing.slice(0, 5).map((key) => `\\cite{${key}}`).join(', '), health.missing.length > 5 ? ` and ${health.missing.length - 5} more` : ''] })) : null, !health.readNotCited.length && !health.missing.length ? _jsx("p", { className: "ol-flag is-ok", children: "Every paper you have read is cited, and every key has an entry." }) : null] })] })) : draft.state.status === 'loading' ? (_jsxs("p", { className: "pj-sub", children: ["Reading ", link?.repo, "\u2026"] })) : null] })] }));
}
function DraftStatus({ draft }) {
    const { state, dirty } = draft;
    const text = state.saving
        ? 'Saving…'
        : state.status === 'loading'
            ? 'Reading…'
            : dirty
                ? 'Not saved'
                : state.savedAt
                    ? 'Saved to GitHub — pull it into Overleaf'
                    : state.status === 'ready'
                        ? 'Up to date'
                        : '';
    return (_jsxs("span", { className: `ol-status${dirty ? ' is-dirty' : ''}`, title: state.savedAt ? 'In Overleaf: Menu → GitHub → Pull GitHub changes into Overleaf' : undefined, children: [text, state.status !== 'loading' && !state.saving ? (_jsx("button", { type: "button", className: "link-btn", onClick: () => {
                    if (dirty && !window.confirm('Reload the draft from GitHub? What you typed here and did not save is dropped.'))
                        return;
                    draft.drop();
                    draft.reload();
                }, children: "Reload" })) : null] }));
}
// ------------------------------------------- cite keys, for beside --
/** The open paper's \cite key and BibTeX, to copy across to Overleaf. */
export function CiteButtons({ project, paper }) {
    const draft = useDraft(project);
    const [copied, setCopied] = useState(null);
    const entries = useMemo(() => draftHealth(draft.files, []).entries, [draft.files]);
    if (!paper)
        return null;
    const key = keyFor(paper, entries);
    const say = (what) => {
        setCopied(what);
        window.setTimeout(() => setCopied((current) => (current === what ? null : current)), 1600);
    };
    return (_jsxs("span", { className: "ol-cite-btns", children: [_jsxs("button", { type: "button", className: "btn sm", title: `Copy \\cite{${key}}`, onClick: () => void copy(`\\cite{${key}}`).then((ok) => ok && say('cite')), children: [copied === 'cite' ? _jsx(CheckIcon, { size: 12 }) : _jsx(CopyIcon, { size: 12 }), " \\cite"] }), _jsxs("button", { type: "button", className: "btn sm", title: "Copy its BibTeX entry", onClick: () => void copy(bibtexFor(paper, entries)).then((ok) => ok && say('bib')), children: [copied === 'bib' ? _jsx(CheckIcon, { size: 12 }) : _jsx(CopyIcon, { size: 12 }), " BibTeX"] })] }));
}
// ------------------------------------------------------- the editor --
/**
 * The draft's files, edited here and saved to the repository as one commit.
 * `paper` is the one being read beside it: what Cite and Quote put in.
 */
export function DraftEditor({ project, paper, compact = false }) {
    const { papers, settings } = useStore();
    const draft = useDraft(project);
    const link = project.project.overleaf;
    const editor = useRef(null);
    const texFiles = draft.files.filter((file) => /\.(tex|bib)$/i.test(file.path));
    const pathKey = `reader.project.${project.id}.draftFile`;
    const [path, setPathState] = useState(() => {
        try {
            return localStorage.getItem(pathKey);
        }
        catch {
            return null;
        }
    });
    const shown = texFiles.find((file) => file.path === path) ?? texFiles.find((file) => file.path === mainFileOf(texFiles)) ?? texFiles[0];
    const setPath = (next) => {
        setPathState(next);
        try {
            localStorage.setItem(pathKey, next);
        }
        catch {
            // only a convenience
        }
    };
    const entries = useMemo(() => draftHealth(draft.files, []).entries, [draft.files]);
    const mine = papersIn(project.id, papers);
    const health = useMemo(() => (paper ? draftHealth(draft.files, [paper]) : null), [draft.files, paper]);
    const citedAt = health?.cited[0]?.at ?? [];
    const prefix = link?.folder ? `${link.folder}/` : '';
    const short = (full) => (full.startsWith(prefix) ? full.slice(prefix.length) : full);
    // The text typed is the editor's own, so the caret stays where it is; the shared draft follows it,
    // and what comes from elsewhere — a reload, a save, the dock — is taken in.
    const [text, setText] = useState(shown?.text ?? '');
    const pushed = useRef(shown?.text ?? null);
    useEffect(() => {
        if (!shown || shown.text === pushed.current)
            return;
        pushed.current = shown.text;
        setText(shown.text);
    }, [shown?.path, shown?.text]);
    const cite = (target, how, passage = '') => {
        const key = keyFor(target, entries);
        editor.current?.insert(how === 'quote' ? quoteOf(passage, key) : `\\${how}{${key}}`);
        addEntry(project, draft.files, target);
    };
    let body;
    if (!link)
        body = _jsx("p", { className: "ol-empty", children: "Link this project to Overleaf on its overview first." });
    else if (!link.repo)
        body = (_jsxs("div", { className: "ol-empty", children: [_jsx("p", { children: "Overleaf can\u2019t be edited from another site. To write here, turn on Overleaf\u2019s GitHub sync for the project and name the repository on the overview\u2019s paper card \u2014 or write in Overleaf itself." }), _jsxs("button", { type: "button", className: "btn sm", onClick: () => openOverleaf(link, project.id, 'beside'), children: [_jsx(ExternalIcon, { size: 13 }), " Open Overleaf beside"] })] }));
    else if (!draft.target)
        body = _jsxs("p", { className: "ol-empty", children: ["Add a GitHub token in Settings \u2192 Git mirror, with Contents read and write on ", link.repo, ", to edit the draft here."] });
    else if (draft.state.status === 'loading' && !draft.files.length)
        body = _jsxs("p", { className: "ol-empty", children: ["Reading ", link.repo, "\u2026"] });
    else if (draft.state.status === 'error' && !draft.files.length)
        body = _jsx("p", { className: "ol-empty ol-bad", children: draft.state.error });
    else if (!shown)
        body = _jsxs("p", { className: "ol-empty", children: ["No .tex or .bib files in ", link.repo, link.folder ? `/${link.folder}` : '', "."] });
    else
        body = (_jsx(CodeEditor, { ref: editor, value: text, path: shown.path, fontSize: compact ? 12 : 13, minimap: !compact, onChange: (next) => {
                pushed.current = next;
                setText(next);
                draft.edit(shown.path, next);
            }, onKeyDown: (event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                    event.preventDefault();
                    draft.save();
                }
            } }, shown.path));
    return (_jsxs("div", { className: `ol-editor${compact ? ' is-compact' : ''}`, children: [_jsxs("div", { className: "ol-editor-bar", children: [texFiles.length ? (_jsx("select", { value: shown?.path, onChange: (event) => setPath(event.target.value), "aria-label": "File", children: texFiles.map((file) => (_jsxs("option", { value: file.path, children: [short(file.path), file.path in draft.state.edits ? ' ●' : ''] }, file.path))) })) : (_jsx("span", { className: "ol-editor-name", children: "Draft" })), _jsx("span", { style: { flex: 1 } }), draft.target ? _jsx(DraftStatus, { draft: draft }) : null, draft.target ? (_jsx("button", { type: "button", className: "btn primary sm", disabled: !draft.dirty || draft.state.saving, onClick: draft.save, title: "One commit to GitHub (\u2318S)", children: "Save" })) : null, link ? (_jsx("button", { type: "button", className: "icon-btn", title: "Open in Overleaf", "aria-label": "Open in Overleaf", onClick: () => openOverleaf(link, project.id, overleafViewOf(settings) === 'beside' ? 'beside' : 'overview'), children: _jsx(ExternalIcon, { size: 14 }) })) : null] }), draft.state.error && draft.files.length ? _jsx("p", { className: "ol-banner", children: draft.state.error }) : null, draft.state.savedAt && !draft.dirty ? _jsxs("p", { className: "ol-banner is-ok", children: ["Saved to ", link?.repo, ". In Overleaf: Menu \u2192 GitHub \u2192 Pull GitHub changes into Overleaf."] }) : null, _jsx("div", { className: "ol-editor-body", children: body }), shown && draft.target ? (_jsxs("div", { className: "ol-cite-bar", children: [paper ? (_jsxs(_Fragment, { children: [_jsxs("span", { className: "ol-cite-paper", title: paper.title, children: [paper.title, _jsx("small", { children: citedAt.length ? ` · cited ${citedAt.map((at) => `${short(at.path)}:${at.line}`).join(', ')}` : ' · not cited yet' })] }), _jsx("button", { type: "button", className: "btn sm", onClick: () => cite(paper, 'cite'), title: "\\cite it at the caret, and add its BibTeX if the draft has none", children: "\\cite" }), _jsx("button", { type: "button", className: "btn sm", onClick: () => cite(paper, 'citet'), children: "\\citet" }), _jsx("button", { type: "button", className: "btn sm", title: "Select a passage in the paper, then quote it at the caret", onMouseDown: (event) => event.preventDefault(), onClick: () => {
                                    const passage = window.getSelection()?.toString().trim() ?? '';
                                    if (passage)
                                        cite(paper, 'quote', passage);
                                    else
                                        window.alert('Select a passage in the paper first, then Quote puts it in the draft with its citation.');
                                }, children: "Quote selection" })] })) : (_jsx("span", { className: "pj-sub", children: "Open a paper of the project to cite it." })), !compact && mine.length > 1 ? (_jsxs("select", { className: "ol-cite-other", value: "", "aria-label": "Cite another paper of the project", onChange: (event) => {
                            const other = mine.find((item) => item.id === event.target.value);
                            if (other)
                                cite(other, 'cite');
                        }, children: [_jsx("option", { value: "", children: "Cite another\u2026" }), mine
                                .filter((item) => item.id !== paper?.id)
                                .map((item) => (_jsx("option", { value: item.id, children: item.title }, item.id)))] })) : null] })) : null] }));
}
// ---------------------------------------------------------- the dock --
const DOCK_PROJECT = 'reader.draft.project';
/** Whether the dock has a Draft tab to show: the choice is the dock, and a project is linked to Overleaf. */
export function useDraftDock() {
    const { collections, settings } = useStore();
    return overleafViewOf(settings) === 'dock' && projectsOf(collections).some((project) => project.project.overleaf);
}
/** The Draft tab: the outline of a project's paper and its editor, beside the paper open on the page. */
export function DraftDock({ paperId }) {
    const { collections, papers } = useStore();
    const linked = projectsOf(collections).filter((project) => project.project.overleaf);
    const paper = papers.find((item) => item.id === paperId);
    const [picked, setPicked] = useState(() => {
        try {
            return localStorage.getItem(DOCK_PROJECT);
        }
        catch {
            return null;
        }
    });
    const project = linked.find((item) => paper?.collectionIds.includes(item.id) && item.id === picked) ?? linked.find((item) => paper?.collectionIds.includes(item.id)) ?? linked.find((item) => item.id === picked) ?? linked[0];
    const draft = useDraft(project);
    const health = useMemo(() => (draft.files.length ? draftHealth(draft.files, []) : null), [draft.files]);
    if (!project)
        return _jsx("p", { className: "ol-empty", children: "Link a project to Overleaf on its overview, and its draft is here." });
    return (_jsxs("div", { className: "ol-dock", children: [_jsxs("div", { className: "ol-dock-head", children: [linked.length > 1 ? (_jsx("select", { value: project.id, "aria-label": "Which project\u2019s paper", onChange: (event) => {
                            setPicked(event.target.value);
                            try {
                                localStorage.setItem(DOCK_PROJECT, event.target.value);
                            }
                            catch {
                                // only a convenience
                            }
                        }, children: linked.map((item) => (_jsx("option", { value: item.id, children: item.name }, item.id))) })) : (_jsx("b", { children: project.name })), health ? _jsxs("span", { className: "pj-sub", children: [health.words.toLocaleString(), " words"] }) : null] }), health?.headings.length ? (_jsx("div", { className: "ol-dock-outline", children: health.headings
                    .filter((heading) => heading.level <= Math.min(...health.headings.map((h) => h.level)))
                    .slice(0, 8)
                    .map((heading) => (_jsxs("span", { children: [heading.title || '(untitled)', _jsx("small", { children: heading.total.toLocaleString() })] }, `${heading.path}:${heading.line}`))) })) : null, _jsx(DraftEditor, { project: project, paper: paper, compact: true })] }));
}
