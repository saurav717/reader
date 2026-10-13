import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// The Playground's home, at /playground: ways to start something, the
// playgrounds there are, and the machines they can run on — the person's
// Colab and the Jupyter servers they have added. One playground opens at
// /playground/<id> (PlaygroundWorkspace). The store is src/lib/playground.ts;
// the kernel client, Colab's and a Jupyter server's alike, src/lib/colab.ts.
import { useEffect, useMemo, useRef, useState } from 'react';
import { checkJupyter, colabAvailable, MACHINES } from '../lib/colab';
import { COLAB, isOn, serversOn, switched } from '../lib/compute';
import { claimForAccount, forgetDevice, pairForAccount, syncDevices } from '../lib/devices';
import { currentAccount, onProxyChange } from '../lib/api';
import { COMPANION_PORT, COMPANION_TLS_PORT, STARTABLE, companionCommands, companionDownloads, companionPort, desktopSystem, companionRoutes, findCompanion, findLocalCompanion, isSafari, latestDesktopApps, normaliseCode, pairFragment, setStopWithApp, showCompanionCode, shutdownCompanion, startCompanion, vscodeInstall } from '../lib/companion';
import { fromIpynb } from '../lib/notebook';
import { newCell } from '../lib/notebook';
import { blankCells, createPlayground, deletePlayground, configurePlaygroundDrive, filesHere, labelBrowserHome, reachOf, loadPlaygrounds, usePlaygroundsWhere, syncPlaygrounds, modelCells, modelIdOf, paperCells, paperFiles, parseServerUrl, playgroundsLoaded, removeServer, repoNameOf, repoUrlOf, saveServer, serverById, serversNow, useDriveConnected, usePlaygrounds, useServers, } from '../lib/playground';
import { useStore } from '../lib/store';
import { ColabMark } from './Colab';
import { CloseIcon, CodeIcon, DriveMark, TrashIcon } from './icons';
import CopyBlock from './CopyBlock';
import PlaygroundWorkspace from './PlaygroundWorkspace';
import { RunRowAction, RunRowState, RunningChooser, RunningShelf } from './PlaygroundRuns';
import { AwayChooser, homeGroupOf } from './PlaygroundAway';
import { snapshotPlan } from '../lib/away';
import OpenDialog from './PlaygroundOpen';
import { useRunBoard } from '../lib/playgroundRuns';
import VsCodeExtension, { isCompanion } from './VsCodeExtension';
export default function Playground({ id, onOpen, onOpenPaper }) {
    const list = usePlaygrounds();
    const { settings, driveConnected } = useStore();
    const [ready, setReady] = useState(playgroundsLoaded());
    const [fromDrive, setFromDrive] = useState(false);
    useEffect(() => {
        void loadPlaygrounds().then(() => setReady(true));
    }, []);
    // Signed in with Drive: the list is the account's, in its Drive, in every browser it signs in to.
    const clientId = settings.googleClientId.trim();
    useEffect(() => {
        configurePlaygroundDrive(driveConnected && clientId ? { clientId, folderName: settings.driveFolderName, account: currentAccount() ?? undefined } : null);
        if (driveConnected && clientId)
            void syncPlaygrounds().finally(() => setFromDrive(true));
    }, [driveConnected, clientId, settings.driveFolderName]);
    if (id) {
        const found = list.find((p) => p.id === id);
        // A link opened in a browser that hasn't got the list from Drive yet: wait for it before saying there is none.
        if (!found && driveConnected && clientId && !fromDrive) {
            return (_jsx("main", { className: "main pg-page", children: _jsx("div", { className: "pg-scroll", children: _jsx("div", { className: "pg-missing", children: _jsxs("p", { children: [_jsx("span", { className: "spinner" }), " Looking for it in your Drive\u2026"] }) }) }) }));
        }
        if (!found) {
            return (_jsx("main", { className: "main pg-page", children: _jsx("div", { className: "pg-scroll", children: ready ? (_jsxs("div", { className: "pg-missing", children: [_jsx("h1", { children: "No playground here" }), _jsxs("p", { children: ["There is no playground at this address", driveConnected ? ' in your Drive' : ' in this browser', ". ", driveConnected ? 'It may have been deleted, or made by another Google account.' : 'Signed out, playgrounds are kept in the browser they were made in: sign in with Google, with Drive, to have them in every browser.'] }), _jsx("button", { type: "button", className: "btn primary", onClick: () => onOpen(), children: "Go to the Playground" })] })) : (_jsxs("p", { className: "pg-loading", children: [_jsx("span", { className: "spinner" }), " Opening\u2026"] })) }) }));
        }
        return _jsx(PlaygroundWorkspace, { playground: found, onBack: () => onOpen(), onOpenPaper: onOpenPaper }, found.id);
    }
    return _jsx(PlaygroundHome, { list: list, ready: ready, onOpen: onOpen });
}
const ago = (at) => {
    const s = Math.round((Date.now() - at) / 1000);
    if (s < 60)
        return 'just now';
    if (s < 3600)
        return `${Math.round(s / 60)} min ago`;
    if (s < 86_400)
        return `${Math.round(s / 3600)} h ago`;
    const d = Math.round(s / 86_400);
    return d === 1 ? 'yesterday' : `${d} days ago`;
};
/** Where a playground runs, in a few words, with its mark. */
export function ComputeTag({ compute, home }) {
    const servers = useServers();
    const server = compute.kind === 'server' ? servers.find((s) => s.id === compute.serverId) : undefined;
    const homeServer = home?.kind === 'server' ? servers.find((s) => s.id === home.serverId) : undefined;
    const split = Boolean(homeServer && (compute.kind === 'colab' || homeServer.id !== server?.id));
    return (_jsxs("span", { className: "pg-where", children: [split ? (_jsxs(_Fragment, { children: [_jsx("span", { className: "pg-mark is-pc", children: homeServer?.where === 'pc' ? 'PC' : 'FS' }), _jsx("span", { className: "pg-arrow", children: "\u2192" })] })) : null, compute.kind === 'colab' ? _jsx(ColabMark, {}) : _jsx("span", { className: `pg-mark ${(server?.where ?? compute.where) === 'pc' ? 'is-pc' : 'is-gpu'}`, children: (server?.where ?? compute.where) === 'pc' ? 'PC' : 'GPU' }), _jsx("span", { children: compute.kind === 'colab' ? `Colab ${MACHINES.find((m) => m.accelerator === compute.machine.accelerator)?.label ?? 'CPU'}${compute.shared ? ' · shared' : ''}` : server?.name ?? (compute.name ? `${compute.name} · not connected here` : compute.deviceId ? 'a computer not connected here' : 'a server no longer here') })] }));
}
function useLiveCompanions(servers) {
    const [live, setLive] = useState({});
    const key = servers.filter(isCompanion).map((server) => `${server.id}@${server.url}@${server.account ?? ''}`).join(' ');
    useEffect(() => {
        let alive = true;
        let timer = 0;
        const look = async () => {
            const companions = serversNow().filter(isCompanion);
            const answers = await Promise.all(companions.map(async (server) => {
                const info = await findCompanion(server.url, 5000);
                const state = !info ? 'down' : server.account && !(info.owned && info.owner === maskEmail(server.account)) ? 'elsewhere' : 'up';
                return [server.id, state];
            }));
            if (!alive)
                return;
            setLive(Object.fromEntries(answers));
            timer = window.setTimeout(() => void look(), 30_000);
        };
        void look();
        return () => {
            alive = false;
            window.clearTimeout(timer);
        };
    }, [key]);
    return live;
}
function PlaygroundHome({ list, ready, onOpen }) {
    const where = usePlaygroundsWhere();
    const { papers, settings } = useStore();
    const servers = useServers();
    const [draft, setDraft] = useState(null);
    const [asking, setAsking] = useState(null);
    const [answer, setAnswer] = useState('');
    const [problem, setProblem] = useState(null);
    const [addingServer, setAddingServer] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(null);
    const filePick = useRef(null);
    const folderPick = useRef(null);
    const [opening, setOpening] = useState(false);
    const sorted = useMemo(() => [...list].sort((a, b) => b.updated - a.updated), [list]);
    // What each is doing — running, idle with its variables, how its last run ended — when the shelf is chosen.
    const runs = useRunBoard(list);
    const runById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
    const shows = settings.runningShows;
    const awayShows = settings.awayShows;
    const [choosingAway, setChoosingAway] = useState(false);
    const [choosing, setChoosing] = useState(false);
    const colabOk = colabAvailable(settings.googleClientId);
    // The signed-in account's computers, from any browser it signs in to: now, and at each sign-in.
    useEffect(() => {
        void syncDevices();
        // Again every minute: a computer that starts again comes back at a new tunnel address.
        const timer = window.setInterval(() => void syncDevices(), 60_000);
        const stop = onProxyChange(() => void syncDevices());
        return () => {
            window.clearInterval(timer);
            stop();
        };
    }, []);
    // Your compute lists what answers now; the rest are a click away, under Offline.
    const live = useLiveCompanions(servers);
    // Which of the playgrounds kept in a browser have their files in this one (null until looked).
    const [filesInBrowser, setFilesInBrowser] = useState(null);
    const browserKept = list.filter((p) => p.home.kind === 'browser' && p.kind === 'project').map((p) => p.id);
    useEffect(() => {
        let alive = true;
        void Promise.all(browserKept.map(async (id) => [id, await filesHere(id)])).then((found) => {
            if (!alive)
                return;
            const here = found.filter(([, has]) => has).map(([id]) => id);
            setFilesInBrowser(new Set(here));
            // The browser that holds them says so in the record, for the others.
            for (const id of here)
                labelBrowserHome(id);
        });
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [browserKept.join(' ')]);
    const reach = (p) => reachOf(p, {
        serverName: (id) => servers.find((server) => server.id === id)?.name,
        down: (id) => live[id] === 'down',
        browserHasFiles: !filesInBrowser || filesInBrowser.has(p.id),
    });
    const offline = servers.filter((server) => live[server.id] && live[server.id] !== 'up');
    const active = servers.filter((server) => !live[server.id] || live[server.id] === 'up');
    const [showOffline, setShowOffline] = useState(false);
    const begin = (next) => {
        setProblem(null);
        setAsking(null);
        setAnswer('');
        setDraft(next);
    };
    const fromAnswer = () => {
        if (asking === 'repo') {
            const url = repoUrlOf(answer);
            if (!url)
                return setProblem('That is not a repository address — try https://github.com/owner/name, or owner/name.');
            const name = repoNameOf(url);
            begin({ title: name, kind: 'project', start: 'repo', pending: `git clone --depth 1 ${url} . 2>&1 || git -C . pull`, cells: [newCell('markdown', `# ${name}\n\nCloned from ${url.replace(/\.git$/, '')} — the console in **Files** has the clone waiting for a click.`)], note: `The clone waits in the console: run it once the machine is connected.` });
        }
        else if (asking === 'model') {
            const model = modelIdOf(answer);
            if (!model)
                return setProblem('That is not a Hugging Face id — try meta-llama/Llama-3.2-1B, or a huggingface.co link.');
            begin({ title: model.replace(/^datasets\//, ''), kind: 'notebook', start: 'model', cells: modelCells(model) });
        }
    };
    const fromPaper = (paper) => {
        const cite = { paperId: paper.id, title: paper.title };
        const title = `Trying ${paper.title.split(/[:—–-]/)[0].trim().slice(0, 60)}`;
        const about = { ...cite, abstract: paper.abstract, authors: paper.authors, published: paper.published, arxivId: paper.arxivId, doi: paper.doi };
        // A project, as VS Code lays one out: the files, an editor, a console and an agent that knows the paper. The notebook is still a tab away.
        begin({ title, kind: 'project', start: 'paper', cites: [cite], files: paperFiles(title, about), cells: paperCells(paper.title, about) });
    };
    const fromFile = async (file) => {
        if (!file)
            return;
        const text = await file.text();
        const name = file.name.replace(/\.[^.]+$/, '');
        if (/\.ipynb$/i.test(file.name)) {
            const cells = fromIpynb(text);
            if (!cells)
                return setProblem(`${file.name} is not a notebook this page can read.`);
            begin({ title: name, kind: 'notebook', start: 'file', cells });
        }
        else {
            begin({ title: name, kind: 'project', start: 'file', files: { [file.name]: text }, cells: blankCells(name) });
        }
    };
    /** A folder of code, picked from this computer: its code and small text files become the project's, wherever the next step keeps them. */
    const fromFolder = async (list) => {
        const picked = list ? [...list] : [];
        if (!picked.length)
            return;
        const name = picked[0].webkitRelativePath.split('/')[0] || 'folder';
        const byPath = new Map(picked.map((file) => [file.webkitRelativePath.split('/').slice(1).join('/'), file]));
        const plan = snapshotPlan([...byPath].map(([path, file]) => ({ path, size: file.size })));
        if (!plan.take.length)
            return setProblem(`${name} has no code or text files to open${plan.left.length ? ` (only ${plan.left.slice(0, 3).join(', ')}…)` : ''}.`);
        const files = {};
        for (const file of plan.take)
            files[file.path] = await byPath.get(file.path).text();
        const left = plan.left.length ? ` Left out: ${plan.left.slice(0, 6).join(', ')}${plan.left.length > 6 ? ` and ${plan.left.length - 6} more` : ''} — data, checkpoints, caches and large files.` : '';
        begin({ title: name, kind: 'project', start: 'file', files, cells: blankCells(name), note: `${plan.take.length} ${plan.take.length === 1 ? 'file' : 'files'} from ${name} go into the project.${left}` });
    };
    const matches = useMemo(() => {
        const q = answer.trim().toLowerCase();
        return papers
            .filter((paper) => !q || paper.title.toLowerCase().includes(q) || paper.authors.some((a) => a.toLowerCase().includes(q)))
            .slice(0, 8);
    }, [answer, papers]);
    const starts = [
        { key: 'blank', mark: '[ ]', title: 'Blank notebook', text: 'Cells, Markdown, maths, a kernel. The quickest way to try an idea.', go: () => begin({ title: 'Untitled notebook', kind: 'notebook', start: 'blank' }) },
        { key: 'project', mark: '{ }', title: 'Blank project', text: 'Files, an editor and a console — for code that outgrows cells.', go: () => begin({ title: 'Untitled project', kind: 'project', start: 'blank', files: { 'main.py': 'import torch\n\nprint("torch", torch.__version__, "· cuda", torch.cuda.is_available())\n', 'README.md': '# Untitled project\n' } }) },
        { key: 'paper', mark: '¶', title: 'From a paper', text: 'A paper from your library, as a project: files, an editor, a console, and an agent that has read its abstract.', go: () => (setAsking('paper'), setAnswer(''), setProblem(null)) },
        { key: 'repo', mark: '⑂', title: 'From a repository', text: 'A GitHub address — the paper’s own code, cloned onto the machine you pick.', go: () => (setAsking('repo'), setAnswer(''), setProblem(null)) },
        { key: 'model', mark: 'HF', title: 'From a model card', text: 'A Hugging Face model or dataset id: loaded, run once, ready to change.', go: () => (setAsking('model'), setAnswer(''), setProblem(null)) },
        { key: 'open', mark: '.nb', title: 'Open a file or folder', text: 'An .ipynb or a .py — or a whole folder of code, as a project. Then pick where the code lives and where it runs.', go: () => (setOpening(true), setProblem(null)) },
    ];
    const renderRow = (p) => {
        const at = reach(p);
        const run = shows.shelf ? runById.get(p.id) : undefined;
        // With B chosen, a playground whose code is elsewhere still opens: on a card saying where it is.
        const closed = Boolean(at.blocked) && !awayShows.card;
        const openLabel = at.blocked && !closed ? (awayShows.snapshot && p.snapshot ? 'Snapshot' : 'Where is it?') : run?.phase === 'idle' ? 'Resume' : run?.phase === 'ran' ? 'Results' : 'Open';
        return (_jsxs("li", { className: `pg-row${at.blocked ? ' is-blocked' : ''}`, children: [_jsxs("button", { type: "button", className: "pg-row-main", onClick: () => !closed && onOpen(p.id), disabled: closed, title: at.blocked, children: [_jsx("b", { children: p.title }), run && run.phase !== 'never' ? _jsx(RunRowState, { run: run }) : null, _jsxs("span", { children: [p.kind === 'project' ? 'Project' : 'Notebook', p.cites.length ? ` · cites ${p.cites.map((c) => c.title).join(', ').slice(0, 80)}` : ''] }), _jsxs("span", { className: "pg-row-where", children: [_jsxs("span", { title: "Where its code is: it stays there", children: [_jsx("i", { children: "Code" }), " ", at.code] }), _jsxs("span", { title: "Where it ran last; change it from the machine menu in the project", children: [_jsx("i", { children: "Last ran on" }), " ", at.ran] }), _jsxs("span", { children: [_jsx("i", { children: "To open it" }), " ", at.needs] })] }), (at.blocked && !awayShows.group) || at.warn ? _jsx("span", { className: `pg-row-note${at.blocked ? ' is-problem' : ''}`, children: at.blocked ?? at.warn }) : null] }), _jsx(ComputeTag, { compute: p.compute, home: p.home }), _jsx("span", { className: "pg-when", children: ago(run?.at && run.at > p.updated ? run.at : p.updated) }), confirmDelete === p.id ? (_jsxs("span", { className: "pg-confirm", children: [_jsx("button", { type: "button", className: "btn sm danger", onClick: () => void deletePlayground(p.id).then(() => setConfirmDelete(null)), children: "Delete" }), _jsx("button", { type: "button", className: "btn sm ghost", onClick: () => setConfirmDelete(null), children: "Keep" })] })) : (_jsx("button", { type: "button", className: "icon-btn sm", "aria-label": `Delete ${p.title}`, title: "Delete this playground (its record and notebook; its files stay where they are \u2014 in Drive, or in a folder on a computer)", onClick: () => setConfirmDelete(p.id), children: _jsx(TrashIcon, { size: 15 }) })), run ? _jsx(RunRowAction, { run: run }) : null, _jsx("button", { type: "button", className: `btn sm${run?.phase === 'idle' ? ' primary' : ''}`, onClick: () => onOpen(p.id), disabled: closed, title: at.blocked, children: openLabel })] }, p.id));
    };
    // A · grouped by where each playground's code is, with a filter for the ones that open from here.
    const [awayFilter, setAwayFilter] = useState('all');
    const grouped = useMemo(() => {
        const byKey = new Map();
        let here = 0;
        for (const p of sorted) {
            const group = homeGroupOf(p, servers, live, !filesInBrowser || filesInBrowser.has(p.id));
            if (group.openable)
                here++;
            if (awayFilter === 'here' ? !group.openable : awayFilter === 'away' ? group.openable : false)
                continue;
            const known = byKey.get(group.key);
            if (known)
                known.items.push(p);
            else
                byKey.set(group.key, { ...group, items: [p] });
        }
        return { groups: [...byKey.values()].sort((a, b) => a.rank - b.rank), here };
    }, [sorted, servers, live, filesInBrowser, awayFilter]);
    return (_jsxs("main", { className: "main pg-page", children: [_jsxs("div", { className: "pg-scroll", children: [_jsxs("header", { className: "pg-hero", children: [_jsxs("div", { children: [_jsx("span", { className: "eyebrow", children: "Playground" }), _jsx("h1", { children: "Try something" }), _jsx("p", { children: "Code that belongs to no paper \u2014 or to several. Pick a start and where it should run; the machine can be changed later without losing the code." })] }), _jsxs("span", { className: "pg-key", children: [_jsx("kbd", { children: "P" }), " from anywhere"] }), _jsxs("span", { className: "pr-choose-wrap", children: [_jsx("button", { type: "button", className: "pg-key pr-choose-btn", "aria-expanded": choosing, onClick: () => setChoosing(!choosing), title: "How running playgrounds are shown around the app", children: "Show running as\u2026" }), choosing ? (_jsxs("div", { className: "pr-choose-pop", role: "dialog", "aria-label": "How running playgrounds are shown", children: [_jsxs("div", { className: "pr-choose-pop-head", children: [_jsx("b", { children: "Running playgrounds" }), _jsx("button", { type: "button", className: "icon-btn sm", "aria-label": "Close", onClick: () => setChoosing(false), children: _jsx(CloseIcon, { size: 14 }) })] }), _jsx(RunningChooser, { compact: true })] })) : null] }), _jsxs("span", { className: "pr-choose-wrap", children: [_jsx("button", { type: "button", className: "pg-key pr-choose-btn", "aria-expanded": choosingAway, onClick: () => setChoosingAway(!choosingAway), title: "What a playground whose code is on another computer shows", children: "Code on another computer\u2026" }), choosingAway ? (_jsxs("div", { className: "pr-choose-pop", role: "dialog", "aria-label": "What a playground whose code is on another computer shows", children: [_jsxs("div", { className: "pr-choose-pop-head", children: [_jsx("b", { children: "Code on another computer" }), _jsx("button", { type: "button", className: "icon-btn sm", "aria-label": "Close", onClick: () => setChoosingAway(false), children: _jsx(CloseIcon, { size: 14 }) })] }), _jsx(AwayChooser, {})] })) : null] })] }), shows.shelf ? _jsx(RunningShelf, { runs: runs, onOpen: (id) => onOpen(id) }) : null, _jsxs("div", { className: "pg-grid", children: [_jsxs("section", { children: [_jsx("div", { className: "pg-section-head", children: _jsx("span", { className: "eyebrow", children: "Start from" }) }), _jsx("div", { className: "pg-starts", children: starts.map((start) => (_jsxs("button", { type: "button", className: `pg-start${asking === start.key ? ' is-on' : ''}`, onClick: start.go, children: [_jsx("span", { className: "pg-start-mark", children: start.mark }), _jsx("b", { children: start.title }), _jsx("span", { children: start.text })] }, start.key))) }), _jsx("input", { ref: filePick, type: "file", accept: ".ipynb,.py,.txt,.md,application/json", hidden: true, onChange: (event) => void fromFile(event.target.files?.[0]).then(() => (event.target.value = '')) }), _jsx("input", { ref: folderPick, type: "file", hidden: true, webkitdirectory: '', directory: '', multiple: true, onChange: (event) => void fromFolder(event.target.files).then(() => (event.target.value = '')) }), asking ? (_jsxs("div", { className: "pg-ask", children: [_jsxs("form", { onSubmit: (event) => {
                                                    event.preventDefault();
                                                    if (asking === 'paper') {
                                                        if (matches[0])
                                                            fromPaper(matches[0]);
                                                    }
                                                    else
                                                        fromAnswer();
                                                }, children: [_jsx("input", { autoFocus: true, value: answer, onChange: (event) => {
                                                            setAnswer(event.target.value);
                                                            setProblem(null);
                                                        }, placeholder: asking === 'paper' ? 'Find a paper in your library…' : asking === 'repo' ? 'https://github.com/owner/name, or owner/name' : 'meta-llama/Llama-3.2-1B, or datasets/imdb', "aria-label": asking === 'paper' ? 'A paper in your library' : asking === 'repo' ? 'A repository' : 'A Hugging Face id' }), asking !== 'paper' ? (_jsx("button", { type: "submit", className: "btn primary sm", disabled: !answer.trim(), children: "Next" })) : null, _jsx("button", { type: "button", className: "icon-btn sm", "aria-label": "Cancel", onClick: () => setAsking(null), children: _jsx(CloseIcon, { size: 14 }) })] }), asking === 'paper' ? (matches.length ? (_jsx("ul", { className: "pg-papers", children: matches.map((paper) => (_jsx("li", { children: _jsxs("button", { type: "button", onClick: () => fromPaper(paper), children: [_jsx("b", { children: paper.title }), _jsxs("span", { children: [paper.authors.slice(0, 3).join(', '), paper.published ? ` · ${paper.published.slice(0, 4)}` : ''] })] }) }, paper.id))) })) : (_jsx("p", { className: "pg-note", children: papers.length ? 'No paper in your library matches.' : 'Your library is empty — save a paper first, from Home or Discover.' }))) : null, problem ? _jsx("p", { className: "pg-note is-problem", children: problem }) : null] })) : problem ? (_jsx("p", { className: "pg-note is-problem", children: problem })) : null, _jsxs("div", { className: "pg-section-head", children: [_jsx("span", { className: "eyebrow", children: "Your playgrounds" }), _jsx("span", { className: "pg-aside", title: where === 'drive' ? 'Each playground’s name, machine, folder and notebook are in your Google Drive (playgrounds.json in your Reader folder); its files stay where they are.' : undefined, children: where === 'drive' ? 'kept in your Drive' : where === 'error' ? 'kept in this browser · Drive didn’t answer' : 'kept in this browser · sign in with Drive to keep them there' })] }), !ready ? (_jsxs("p", { className: "pg-note", children: [_jsx("span", { className: "spinner" }), " Reading\u2026"] })) : sorted.length ? (awayShows.group ? (_jsxs(_Fragment, { children: [_jsx("div", { className: "away-filter segmented", role: "tablist", "aria-label": "Which playgrounds", children: ['all', 'here', 'away'].map((f) => (_jsx("button", { type: "button", role: "tab", "aria-selected": awayFilter === f, "aria-pressed": awayFilter === f, onClick: () => setAwayFilter(f), children: f === 'all' ? `All · ${sorted.length}` : f === 'here' ? `Open here · ${grouped.here}` : `On other computers · ${sorted.length - grouped.here}` }, f))) }), grouped.groups.map((group) => (_jsxs("div", { className: "away-group", children: [_jsxs("div", { className: "away-group-head", children: [_jsx("b", { children: group.label }), _jsxs("span", { className: `away-pill is-${group.tone}`, children: [_jsx("i", { "aria-hidden": "true" }), group.note] })] }), _jsx("ul", { className: "pg-list", children: group.items.map(renderRow) })] }, group.key))), !grouped.groups.length ? _jsx("p", { className: "pg-note", children: awayFilter === 'here' ? 'None of them open from this browser as it stands.' : 'All of them open from here.' }) : null] })) : (_jsx("ul", { className: "pg-list", children: sorted.map(renderRow) }))) : (_jsxs("div", { className: "pg-empty", children: [_jsx(CodeIcon, { size: 20 }), _jsx("p", { children: "Nothing here yet. Start one above \u2014 a blank notebook runs on your Colab with nothing to install." })] }))] }), _jsxs("aside", { className: "pg-side", children: [_jsxs("div", { className: "pg-section-head", children: [_jsx("span", { className: "eyebrow", children: "Your compute" }), _jsx("button", { type: "button", className: "btn ghost sm", onClick: () => setAddingServer(true), children: "+ Add a server" })] }), _jsxs("div", { className: "pg-card", children: [_jsxs("div", { className: "pg-machine", children: [_jsxs("div", { className: "pg-machine-head", children: [_jsx(ColabMark, {}), _jsx("b", { children: "Google Colab" }), _jsx("span", { children: colabOk ? 'ready' : 'needs set-up' })] }), _jsx("p", { children: colabOk ? 'CPU, T4, L4, A100 — in your own Colab account, on your tier and units.' : 'Running on Colab needs a Google client ID and the reader’s proxy, in Settings.' })] }), active.map((server) => (_jsx(ServerRow, { server: server }, server.id))), offline.length ? (_jsxs("div", { className: "pg-offline", children: [_jsxs("button", { type: "button", className: "pg-offline-toggle", "aria-expanded": showOffline, onClick: () => setShowOffline(!showOffline), children: [_jsx("span", { className: `pg-offline-chevron${showOffline ? ' is-open' : ''}`, "aria-hidden": "true", children: "\u203A" }), "Offline \u00B7 ", offline.length, _jsx("span", { className: "pg-offline-names", children: showOffline ? '' : offline.map((server) => server.name).join(', ') })] }), showOffline ? offline.map((server) => _jsx(ServerRow, { server: server, offline: live[server.id] === 'elsewhere' ? 'elsewhere' : true }, server.id)) : null] })) : null] }), !servers.some((server) => server.where === 'pc') && !addingServer ? _jsx(CompanionConnect, { onManual: () => setAddingServer(true) }) : null, addingServer ? _jsx(ServerForm, { onDone: () => setAddingServer(false) }) : null] })] })] }), _jsx(PairFromLink, {}), opening ? (_jsx(OpenDialog, { onClose: () => setOpening(false), onOpen: (id) => onOpen(id), onUploadFile: () => (setOpening(false), filePick.current?.click()), onUploadFolder: () => (setOpening(false), folderPick.current?.click()), onConnect: () => (setOpening(false), setAddingServer(true)) })) : null, draft ? (_jsx(WhereDialog, { draft: draft, onClose: () => setDraft(null), onCreate: async (spec) => {
                    const made = await createPlayground(spec);
                    setDraft(null);
                    onOpen(made.id);
                } })) : null] }));
}
// -------------------------------------------------------------- servers ----
function ServerRow({ server, offline = false }) {
    const [state, setState] = useState(null);
    const [checking, setChecking] = useState(false);
    const [editing, setEditing] = useState(false);
    const companion = Boolean(server.companionId || companionPort(server.url));
    const [power, setPower] = useState('unknown');
    const [note, setNote] = useState(null);
    /** Whether it shuts down with the Reader app's window: undefined for a Companion from before 0.7.4, or one not answering. */
    const [stopWithApp, setStopWithAppState] = useState(undefined);
    const local = companionPort(server.url) !== null;
    useEffect(() => {
        if (!companion)
            return;
        let live = true;
        void findCompanion(server.url, 2500).then((info) => {
            if (!live)
                return;
            setPower((now) => (now === 'unknown' ? (info ? 'up' : 'down') : now));
            setStopWithAppState(info?.stopWithApp);
        });
        return () => {
            live = false;
        };
    }, [companion, server.url]);
    const account = currentAccount();
    const [claiming, setClaiming] = useState(false);
    const claim = async () => {
        setClaiming(true);
        setNote(null);
        const { problem } = await claimForAccount(server);
        setClaiming(false);
        setNote(problem ?? `Connected to ${account}: it is under Your compute in every browser signed in as it, here and on other computers. Your files stay on this computer.`);
    };
    const toggle = async (on) => {
        setNote(null);
        setState(null);
        if (!on) {
            setPower('stopping');
            try {
                await shutdownCompanion(server);
                setPower('down');
                setNote('Shut down: no Jupyter server, no kernels. It stays off, at your next login too, until you turn it on here, open the Reader app, or run reader-companion start.');
            }
            catch (error) {
                setPower('up');
                setNote(error instanceof Error ? error.message : String(error));
            }
            return;
        }
        setPower('starting');
        const info = await startCompanion(server.url);
        setPower(info ? 'up' : 'down');
        if (!info)
            setNote(`It didn’t start from here. Open the Reader app on this computer, or run reader-companion start in a terminal. (The page can start a Companion from ${STARTABLE} on, installed with the Reader app or the installer.)`);
    };
    const test = async () => {
        setChecking(true);
        const answer = await checkJupyter(server);
        setChecking(false);
        setState(answer.ok ? { ok: true, text: `answers${answer.version ? ` · Jupyter Server ${answer.version}` : ''}` } : { ok: false, text: answer.error });
    };
    if (editing)
        return _jsx(ServerForm, { server: server, onDone: () => setEditing(false) });
    return (_jsxs("div", { className: `pg-machine${offline ? ' is-offline' : ''}`, children: [_jsxs("div", { className: "pg-machine-head", children: [_jsx("span", { className: `pg-mark ${server.where === 'pc' || companion ? 'is-pc' : 'is-gpu'}`, children: server.where === 'pc' || companion ? 'PC' : 'GPU' }), _jsx("b", { children: server.name }), _jsx("span", { className: "mono", children: safeHost(server.url) })] }), state ? _jsx("p", { className: state.ok ? 'pg-ok' : 'pg-bad', children: state.text }) : null, offline === 'elsewhere' ? _jsxs("p", { className: "pg-machine-seen", children: ["It runs, but it isn\u2019t connected to ", server.account, " any more (released on that computer, or connected to another account). Connect it again from that computer \u2014 open the Reader app there \u2014 or Remove it here."] }) : offline ? _jsxs("p", { className: "pg-machine-seen", children: ["Not answering", server.seen ? ` · last seen ${ago(server.seen)}` : '', ". ", server.where === 'pc' ? 'Turn it on below, or open the Reader app.' : 'Start it on that computer: the Reader app, or reader-companion start.'] }) : null, companion && server.account ? _jsxs("p", { children: ["Yours as ", server.account, server.where === 'pc' ? '' : ' · on another computer, through its tunnel', ". Its files stay on it."] }) : null, note ? _jsx("p", { children: note }) : null, state && !state.ok && companion ? (_jsxs("div", { className: "pg-howto", children: [_jsxs("small", { children: ["It\u2019s the Companion: open the ", _jsx("b", { children: "Reader" }), " app on this computer, or start it again in a terminal. Either opens a link here that reconnects it."] }), _jsx(CopyBlock, { code: companionCommands(siteBase(), { tunnel: isSafari() }).unix })] })) : null, _jsx(VsCodeExtension, { server: server }), _jsxs("div", { className: "pg-machine-actions", children: [_jsx("button", { type: "button", className: "btn sm ghost", onClick: () => void test(), disabled: checking, children: checking ? 'Testing…' : 'Test' }), _jsx("button", { type: "button", className: "btn sm ghost", onClick: () => setEditing(true), children: "Edit" }), _jsx("button", { type: "button", className: "btn sm ghost danger", title: server.account ? `Takes it off ${server.account}'s computers, in every browser. Connect it again from that computer to have it back.` : 'Forget it in this browser', onClick: () => {
                            if (server.account && server.companionId)
                                void forgetDevice(server.companionId);
                            removeServer(server.id);
                        }, children: "Remove" }), companion && account && !server.account ? (_jsx("button", { type: "button", className: "btn sm ghost", disabled: claiming, onClick: () => void claim(), title: "Only this Google account reaches it then, from any browser it signs in to; browsers paired before lose it.", children: claiming ? 'Connecting…' : 'Connect to my account' })) : null, companion ? _jsx(PowerSwitch, { power: power, canStart: companionPort(server.url) !== null, onChange: (on) => void toggle(on) }) : null] }), companion && local && stopWithApp !== undefined ? (_jsxs("label", { className: "pg-stop-with-app", title: "The Reader app opens this site in a window of its own and starts the Companion; with this on, closing that window shuts the Companion down too, until you open the app again. Turn it off to keep reaching this computer from your other devices while its window is closed.", children: [_jsx("input", { type: "checkbox", checked: stopWithApp, onChange: (event) => {
                            const on = event.target.checked;
                            setStopWithAppState(on);
                            void setStopWithApp(server, on).then(setStopWithAppState, (error) => (setStopWithAppState(!on), setNote(error instanceof Error ? error.message : String(error))));
                        } }), _jsx("span", { children: "Shut down when the Reader window closes" })] })) : null] }));
}
const safeHost = (url) => {
    try {
        const parsed = new URL(url);
        return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
    }
    catch {
        return url;
    }
};
/**
 * The steps for code on one machine and compute on another, both away from the
 * browser: a Reader Companion on each, through its HTTPS tunnel, connected to
 * the Google account so every browser signed in as it has them.
 */
export function acrossMachinesSteps(site) {
    const base = site.replace(/\/?$/, '/');
    return [
        {
            label: '1 · On the computer that keeps your code (at home, say): installs the Companion for good, with an HTTPS tunnel, starting at every login. It prints a link: open it in the browser you work in (copy it over from an SSH session), signed in with Google.',
            code: `curl -LsSf ${base}companion-setup.sh | sh -s -- --tunnel --no-vscode --name "Home computer"\n# Windows (PowerShell):\n# & ([scriptblock]::Create((irm ${base}companion-setup.ps1))) --tunnel --no-vscode --name "Home computer"`,
        },
        {
            label: '2 · On the GPU machine: the same line where it stays up (a lab server, your own box). On a pod or an SSH session that ends, run it in the foreground instead, in tmux so it survives the session closing; it prints the link the same way.',
            code: `curl -LsSf ${base}companion-setup.sh | sh -s -- --tunnel --no-vscode --name "GPU box"\n# or, on a pod / for one session:\ntmux new -s reader\ncurl -LsSf ${base}companion.sh | sh -s -- --tunnel --no-browser --name "GPU box"`,
        },
        {
            label: 'A new link at any time, on either machine (a link is good for a few minutes):',
            code: '~/.local/bin/reader-companion pair --no-browser',
        },
        {
            label: '3 · In the browser you work in: open both links. Signed in with Google, both computers are kept under your account and show up in every browser you sign in to. Then a new project → “Code on one machine, compute on another”: the code kept on the first, run on the GPU machine. Before each run the folder is copied there (through this browser, text files up to 2 MB); what it writes under runs/ and results/ comes back. Keep data and weights on the GPU machine and fetch them there.',
            code: '',
        },
    ];
}
/** The commands that start a Jupyter server this page may talk to, for this site's origin. */
export function serverCommands(where, origin) {
    // One flag a line, joined with backslashes: easy to read in a narrow card, and still one command when pasted.
    const server = (...extra) => ['jupyter server', `--ServerApp.allow_origin='${origin}'`, '--ServerApp.root_dir="$HOME/reader-playgrounds"', ...extra].join(' \\\n  ');
    const setup = 'mkdir -p "$HOME/reader-playgrounds"\npip install jupyter_server ipykernel';
    if (where === 'pc')
        return [{ label: 'On this PC, in a terminal', code: `${setup}\n${server()}` }];
    return [
        { label: 'On the other machine — a GPU box, a lab server, a cloud VM, or a computer that keeps your code', code: `${setup}\n${server('--ServerApp.port=8888')}` },
        { label: 'Then on this PC — an SSH tunnel to it (a lab server, a cloud VM, a pod with SSH)', code: 'ssh -N -L 8890:localhost:8888 you@that-machine\n# then add http://localhost:8890/?token=… here' },
        { label: 'Or, on RunPod: start it on 0.0.0.0 and use the pod’s own HTTPS address', code: `${setup}\n${server('--ServerApp.ip=0.0.0.0', '--ServerApp.port=8888')}\n# address: https://<pod-id>-8888.proxy.runpod.net/?token=…` },
    ];
}
function ServerForm({ server, onDone, onSaved, defaultWhere = 'pc' }) {
    const [name, setName] = useState(server?.name ?? (defaultWhere === 'pc' ? 'This PC' : 'Another machine'));
    const [where, setWhere] = useState(server?.where ?? defaultWhere);
    /** The steps for code and compute both elsewhere, shown in place of the form. */
    const [across, setAcross] = useState(false);
    const [address, setAddress] = useState(server ? `${server.url}${server.token ? `?token=${server.token}` : ''}` : '');
    const [token, setToken] = useState('');
    const [state, setState] = useState(null);
    const [busy, setBusy] = useState(false);
    const parsed = parseServerUrl(address);
    const effective = parsed ? { url: parsed.url, token: token.trim() || parsed.token || '' } : null;
    const origin = typeof window === 'undefined' ? 'https://saurav717.github.io' : window.location.origin;
    const save = async () => {
        if (!effective)
            return;
        setBusy(true);
        const answer = await checkJupyter(effective);
        setBusy(false);
        if (!answer.ok) {
            setState({ ok: false, text: answer.error });
            return;
        }
        const saved = saveServer({ id: server?.id, name: name.trim() || (where === 'pc' ? 'This PC' : 'Another machine'), where, url: effective.url, token: effective.token });
        onSaved?.(saved);
        onDone();
    };
    return (_jsxs("div", { className: "pg-card pg-server-form", children: [_jsxs("div", { className: "pg-section-head", children: [_jsx("b", { children: server ? 'Edit the server' : 'A Jupyter server of yours' }), _jsx("button", { type: "button", className: "icon-btn sm", "aria-label": "Close", onClick: onDone, children: _jsx(CloseIcon, { size: 14 }) })] }), _jsxs("div", { className: "segmented pg-seg", role: "radiogroup", "aria-label": "Where it runs", children: [_jsx("button", { type: "button", role: "radio", "aria-checked": !across && where === 'pc', className: !across && where === 'pc' ? 'on' : '', onClick: () => (setWhere('pc'), setAcross(false)), children: "On this PC" }), _jsx("button", { type: "button", role: "radio", "aria-checked": !across && where === 'remote', className: !across && where === 'remote' ? 'on' : '', onClick: () => (setWhere('remote'), setAcross(false)), children: "Another machine" }), !server ? (_jsx("button", { type: "button", role: "radio", "aria-checked": across, className: across ? 'on' : '', onClick: () => setAcross(true), title: "Code on one computer, compute on another, this browser on a third", children: "Across machines" })) : null] }), across ? (_jsxs("div", { className: "pg-howto pg-across", children: [_jsx("p", { children: "The browser here, your code on one computer, the GPU on another: a Reader Companion on each of the two, reached through its HTTPS tunnel from wherever you are." }), acrossMachinesSteps(siteBase()).map((step) => (_jsxs("div", { children: [_jsx("small", { children: step.label }), step.code ? _jsx(CopyBlock, { code: step.code }) : null] }, step.label)))] })) : (_jsxs(_Fragment, { children: [_jsxs("details", { className: "pg-howto", open: !server, children: [_jsx("summary", { children: "How to start one" }), serverCommands(where, origin).map((step) => (_jsxs("div", { children: [_jsx("small", { children: step.label }), _jsx(CopyBlock, { code: step.code })] }, step.label))), _jsxs("small", { children: ["Jupyter prints an address with ", _jsx("code", { children: "?token=" }), " \u2014 paste it below. The token stays in this browser. A browser may ask once to let this site reach your local network: allow it."] })] }), _jsxs("label", { children: [_jsx("span", { children: "Name" }), _jsx("input", { value: name, onChange: (event) => setName(event.target.value) })] }), _jsxs("label", { children: [_jsx("span", { children: "Address" }), _jsx("input", { value: address, onChange: (event) => (setAddress(event.target.value), setState(null)), placeholder: "http://localhost:8888/?token=\u2026", spellCheck: false })] }), parsed && !parsed.token ? (_jsxs("label", { children: [_jsx("span", { children: "Token" }), _jsx("input", { value: token, onChange: (event) => setToken(event.target.value), placeholder: "the server\u2019s token, if the address has none", spellCheck: false })] })) : null, state ? _jsx("p", { className: state.ok ? 'pg-ok' : 'pg-bad', children: state.text }) : null, _jsxs("div", { className: "pg-machine-actions", children: [_jsx("button", { type: "button", className: "btn primary sm", disabled: !effective || busy, onClick: () => void save(), children: busy ? 'Testing…' : 'Test and save' }), address && !parsed ? _jsx("span", { className: "pg-bad", children: "That is not an http(s) address." }) : null] })] }))] }));
}
// ------------------------------------------------------------ companion ----
/** This site's address with its base path: what the Companion's installers are served under. */
const siteBase = () => (typeof window === 'undefined' ? 'https://saurav717.github.io/reader/' : `${window.location.origin}${import.meta.env.BASE_URL}`);
/** The first of these addresses a Companion answers on, trying for a while: a new tunnel can take some seconds to be found. */
async function reachCompanion(routes, forMs) {
    const until = Date.now() + forMs;
    for (;;) {
        for (const base of routes) {
            const info = await findCompanion(base, 4000);
            if (info)
                return { base, info };
        }
        if (Date.now() > until)
            return null;
        await new Promise((resolve) => setTimeout(resolve, 1500));
    }
}
/** An address as the Companion shows its owner's (account.mask): sa•••@gmail.com. */
const maskEmail = (email) => {
    if (!email)
        return '';
    const [name, domain] = email.split('@');
    return domain ? `${name.slice(0, 2)}${'•'.repeat(Math.max(1, name.length - 2))}@${domain}` : email;
};
/** The Companion's on/off switch: off shuts it down (kernels, Jupyter server, process) and keeps it off; on starts it through the reader-companion:// link. */
function PowerSwitch({ power, onChange, canStart = true }) {
    const on = power === 'up' || power === 'starting';
    const stuck = power === 'down' && !canStart;
    return (_jsxs("button", { type: "button", role: "switch", "aria-checked": on, "aria-label": "The Companion on this computer", className: `pg-power is-${power}`, disabled: power === 'unknown' || power === 'stopping' || power === 'starting' || stuck, onClick: () => onChange(!on), title: stuck ? 'It is off. Start it on that computer: open the Reader app there, or run reader-companion start.' : on ? 'Shut the Companion down: its kernels and Jupyter server stop, and it stays off until it is turned on again.' : 'Start the Companion on this computer. Your browser asks once whether to open the Reader app.', children: [_jsx("span", { className: "pg-power-track", "aria-hidden": "true", children: _jsx("span", { className: "pg-power-knob" }) }), power === 'stopping' ? 'Stopping…' : power === 'starting' ? 'Starting…' : power === 'unknown' ? '…' : on ? 'On' : 'Off'] }));
}
/** "Connect this computer": the Companion's one-line start, then the code it prints. The page looks for it while this is open. */
export function CompanionConnect({ onPaired, onManual, onClose }) {
    const safari = isSafari();
    const commands = companionCommands(siteBase(), { tunnel: safari });
    const windows = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || navigator.userAgent);
    const [os, setOs] = useState(windows ? 'windows' : 'unix');
    const vscode = vscodeInstall(siteBase(), windows);
    const downloads = companionDownloads(siteBase());
    const [system, setSystem] = useState(desktopSystem);
    // The Reader desktop app, once a release has it for this system; until then the installer scripts.
    const [apps, setApps] = useState({});
    useEffect(() => {
        let live = true;
        void latestDesktopApps().then((found) => live && setApps(found));
        return () => {
            live = false;
        };
    }, []);
    const app = system === 'mac' ? apps.mac : system === 'windows' ? apps.windows : (apps.linux?.appImage ?? apps.linux?.deb ?? apps.linux?.rpm);
    const download = app ? { ...downloads[system], href: app.url, file: app.file } : downloads[system];
    const [found, setFound] = useState(null);
    const [foundAt, setFoundAt] = useState(null);
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState(null);
    const [looks, setLooks] = useState(0);
    // Two ways to start it, side by side: the app (recommended), or a command in a terminal.
    const [way, setWay] = useState('app');
    const [asking, setAsking] = useState(false);
    const [shown, setShown] = useState(null);
    // A Companion this card shut down: still shown, with its switch, rather than the install steps.
    const [stopped, setStopped] = useState(null);
    const [moving, setMoving] = useState(null);
    const power = moving ?? (found ? 'up' : stopped ? 'down' : 'unknown');
    const toggle = async (on) => {
        setProblem(null);
        if (!on) {
            if (!found || !foundAt)
                return;
            const was = { base: foundAt, info: found };
            setMoving('stopping');
            setStopped(was);
            try {
                await shutdownCompanion({ url: foundAt });
                setFound(null);
                setFoundAt(null);
            }
            catch (error) {
                setStopped(null);
                setProblem(error instanceof Error ? error.message : String(error));
            }
            finally {
                setMoving(null);
            }
            return;
        }
        if (!stopped)
            return;
        setMoving('starting');
        const info = await startCompanion(stopped.base);
        setMoving(null);
        if (info) {
            setFound(info);
            setFoundAt(stopped.base);
            setStopped(null);
        }
        else {
            setProblem(`It didn’t start from here. Open the Reader app on this computer, or run reader-companion start in a terminal. (The page can start a Companion from ${STARTABLE} on, installed with the Reader app or the installer.)`);
        }
    };
    const askForCode = async () => {
        setAsking(true);
        setShown(await showCompanionCode(foundAt ?? undefined));
        setAsking(false);
    };
    useEffect(() => {
        // Its https address first (Safari's only way in), then, for the others, its http one.
        let live = true;
        let timer = 0;
        const look = async () => {
            const here = await findLocalCompanion(safari);
            if (!live)
                return;
            // A Companion another Google account owns isn't shown at all: not its name, its folder or its switch.
            const reached = here && (!here.info.owned || here.info.owner === maskEmail(currentAccount())) ? here : null;
            setFound(reached?.info ?? null);
            setFoundAt(reached?.base ?? null);
            if (reached)
                setStopped(null);
            setLooks((n) => n + 1);
            timer = window.setTimeout(() => void look(), reached ? 5000 : 2000);
        };
        void look();
        return () => {
            live = false;
            window.clearTimeout(timer);
        };
    }, [safari]);
    const connect = async () => {
        setBusy(true);
        setProblem(null);
        try {
            if (!foundAt)
                throw new Error('The Companion stopped answering. Is it still running?');
            const { server: saved } = await pairForAccount(code, foundAt);
            onPaired?.(saved);
        }
        catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsxs("div", { className: "pg-card pg-companion", children: [_jsxs("div", { className: "pg-section-head", children: [_jsx("b", { children: "Connect this computer" }), onClose ? (_jsx("button", { type: "button", className: "icon-btn sm", "aria-label": "Close", onClick: onClose, children: _jsx(CloseIcon, { size: 14 }) })) : null] }), found ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "pg-companion-found", children: [_jsx("span", { className: "pg-live" }), _jsxs("div", { children: [_jsx("b", { children: found.name }), _jsxs("small", { children: [found.hardware, " \u00B7 ", _jsx("span", { className: "mono", children: found.root })] })] }), _jsx(PowerSwitch, { power: power, onChange: (on) => void toggle(on) })] }), _jsxs("div", { className: "pg-companion-ask", children: [_jsx("button", { type: "button", className: "btn sm", disabled: asking, onClick: () => void askForCode(), children: asking ? 'Asking…' : 'Show the code on this computer' }), shown === true ? _jsx("small", { className: "pg-companion-note", children: "It\u2019s in a window on this computer\u2019s screen." }) : null, shown === false ? _jsxs("small", { className: "pg-companion-note", children: ["This computer can\u2019t show it in a window. Open the ", _jsx("b", { children: "Reader" }), " app instead, which connects with no code, or run ", _jsx("span", { className: "mono", children: "reader-companion pair" }), "."] }) : null] }), _jsxs("label", { className: "pg-companion-code", children: [_jsx("span", { children: "Type the code it shows" }), _jsxs("span", { className: "pg-companion-row", children: [_jsx("input", { value: code, onChange: (event) => (setCode(event.target.value), setProblem(null)), onKeyDown: (event) => event.key === 'Enter' && normaliseCode(code).length === 7 && void connect(), placeholder: "ABC-DEF", spellCheck: false, autoComplete: "off", maxLength: 9 }), _jsx("button", { type: "button", className: "btn primary sm", disabled: busy || normaliseCode(code).length !== 7, onClick: () => void connect(), children: busy ? 'Connecting…' : 'Connect' })] })] }), _jsx("small", { className: "pg-companion-note", children: "Or open the Reader app, or the link the terminal printed: both connect with no code." })] })) : stopped ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "pg-companion-found is-off", children: [_jsx("span", { className: "pg-off" }), _jsxs("div", { children: [_jsx("b", { children: stopped.info.name }), _jsx("small", { children: "shut down \u00B7 no Jupyter server, no kernels" })] }), _jsx(PowerSwitch, { power: power, onChange: (on) => void toggle(on) })] }), _jsxs("small", { className: "pg-companion-note", children: ["It stays off, at your next login too, until you turn it on here, open the Reader app, or run ", _jsx("span", { className: "mono", children: "reader-companion start" }), "."] })] })) : (_jsxs(_Fragment, { children: [_jsx("p", { className: "pg-companion-lede", children: "Start the Companion on this computer: it runs the local server the site talks to. Pick one way:" }), _jsxs("div", { className: "pg-companion-ways", role: "radiogroup", "aria-label": "How to start the Companion", children: [_jsxs("button", { type: "button", role: "radio", "aria-checked": way === 'app', className: `pg-companion-way${way === 'app' ? ' is-on' : ''}`, onClick: () => setWay('app'), children: [_jsxs("b", { children: ["1 \u00B7 Download the Reader app ", _jsx("small", { children: "recommended" })] }), _jsx("span", { children: "Install once, then open Reader from the Dock or Start menu; it starts the Companion each time, and connects by itself." })] }), _jsxs("button", { type: "button", role: "radio", "aria-checked": way === 'cli', className: `pg-companion-way${way === 'cli' ? ' is-on' : ''}`, onClick: () => setWay('cli'), children: [_jsx("b", { children: "2 \u00B7 Use the command line" }), _jsx("span", { children: "Paste one line into Terminal: it runs until you close the window. Nothing to install as an app." })] })] }), way === 'app' ? (_jsxs("div", { className: "pg-companion-install", children: [_jsxs("p", { className: "pg-companion-lede", children: [_jsx("b", { children: "Get the Reader app." }), " Reader in a window of its own, no browser needed: open it from the Dock, the Start menu or your applications. The first time it opens it sets up the Jupyter server your projects run on (your files stay in ", _jsx("span", { className: "mono", children: "~/Reader" }), ") and adds the Reader extension to VS Code if you have it, then connects to this computer by itself. Nothing else to install first."] }), app && system === 'linux' && apps.linux ? (_jsxs("div", { className: "pg-companion-downloads", children: [apps.linux.deb ? (_jsxs("a", { className: "btn primary pg-companion-download", href: apps.linux.deb.url, children: ["Download .deb ", _jsx("small", { children: "Ubuntu, Debian" })] })) : null, apps.linux.rpm ? (_jsxs("a", { className: "btn pg-companion-download", href: apps.linux.rpm.url, children: [".rpm ", _jsx("small", { children: "Fedora, openSUSE" })] })) : null, apps.linux.appImage ? (_jsxs("a", { className: "btn pg-companion-download", href: apps.linux.appImage.url, children: ["AppImage ", _jsx("small", { children: "any Linux" })] })) : null] })) : !app && system === 'linux' ? (_jsx(CopyBlock, { code: download.command })) : (_jsxs("a", { className: "btn primary pg-companion-download", href: download.href, download: app ? undefined : true, children: ["Download for ", download.label] })), _jsx("small", { className: "pg-companion-note", children: app && system === 'mac' ? (_jsxs(_Fragment, { children: ["Open the .dmg, drag ", _jsx("b", { children: "Reader" }), " to Applications, and open it.", ' ', app.signed ? ('It’s signed and notarized by Apple, so macOS opens it without asking.') : (_jsxs(_Fragment, { children: ["macOS stops it the first time (\u201CApple could not verify\u2026\u201D, as it isn\u2019t notarized): click ", _jsx("b", { children: "Done" }), ", then ", _jsx("b", { children: "Open Anyway" }), " in System Settings \u2192 Privacy & Security, and ", _jsx("b", { children: "Open" }), ". After that it opens like any app."] })), ' ', "To uninstall it: ", _jsx("b", { children: "Reader" }), " menu \u2192 ", _jsx("b", { children: "Uninstall Reader\u2026" })] })) : app && system === 'windows' ? (_jsxs(_Fragment, { children: ["Run ", _jsx("b", { children: app.file }), ": a setup like any program\u2019s, for you or for everyone on this PC.", app.signed ? '' : _jsxs(_Fragment, { children: [" If Windows says it protected your PC, choose ", _jsx("b", { children: "More info" }), " \u2192 ", _jsx("b", { children: "Run anyway" }), "."] }), " To uninstall it: Settings \u2192 Apps \u2192 ", _jsx("b", { children: "Reader" }), " \u2192 Uninstall, or ", _jsx("b", { children: "Uninstall Reader" }), " in the Start menu."] })) : app ? (_jsxs(_Fragment, { children: ["Open the .deb or .rpm with your software installer (or ", _jsxs("span", { className: "mono", children: ["sudo apt install ./", apps.linux?.deb?.file ?? 'reader.deb'] }), "), or make the AppImage executable and run it: Reader is then in your applications. To uninstall it: ", _jsx("b", { children: "Uninstall Reader" }), " in your applications (or right-click Reader), or ", _jsx("span", { className: "mono", children: "sudo apt remove reader" }), "."] })) : system === 'mac' ? (_jsxs(_Fragment, { children: ["Open the zip, then double-click ", _jsx("b", { children: download.file }), ". macOS stops it once (\u201CApple could not verify\u2026\u201D): click ", _jsx("b", { children: "Done" }), ", then ", _jsx("b", { children: "Open Anyway" }), " in System Settings \u2192 Privacy & Security, and confirm. Or paste ", _jsx("span", { className: "mono", children: download.command }), " into Terminal, which macOS doesn\u2019t stop. ", _jsx("span", { className: "mono", children: "reader-companion uninstall" }), " takes it away again."] })) : system === 'windows' ? (_jsxs(_Fragment, { children: ["Double-click ", _jsx("b", { children: download.file }), ". If Windows says it protected your PC, choose ", _jsx("b", { children: "More info" }), " \u2192 ", _jsx("b", { children: "Run anyway" }), ". ", _jsx("span", { className: "mono", children: "reader-companion uninstall" }), " takes it away again."] })) : (_jsxs(_Fragment, { children: ["Paste it into a terminal, or ", _jsx("a", { href: download.href, download: true, children: "download the script" }), " and run ", _jsxs("span", { className: "mono", children: ["sh ", download.file] }), ". ", _jsx("span", { className: "mono", children: "reader-companion uninstall" }), " takes it away again."] })) }), _jsxs("small", { className: "pg-companion-note", children: ["Other systems:", ' ', Object.keys(downloads)
                                        .filter((key) => key !== system)
                                        .map((key, index) => (_jsxs("span", { children: [index ? ' · ' : '', _jsx("button", { type: "button", className: "link-btn", onClick: () => setSystem(key), children: downloads[key].label })] }, key)))] })] })) : null, way === 'cli' ? (_jsxs(_Fragment, { children: [_jsxs("p", { className: "pg-companion-lede", children: ["Paste this into a terminal (on a Mac: Terminal, in Applications \u2192 Utilities), and it runs until you close it.", safari ? ' Safari reaches the installed Companion over https on this Mac (setup asks for your password once, to trust its certificate). Run just for now, it opens a private HTTPS address instead (a Cloudflare quick tunnel; everything through it needs the token).' : ''] }), _jsx("div", { className: "segmented pg-seg", role: "radiogroup", "aria-label": "This computer\u2019s system", children: [
                                    ['unix', 'macOS · Linux'],
                                    ['windows', 'Windows'],
                                    ['uv', 'Have uv'],
                                    ['vscode', 'VS Code'],
                                ].map(([key, label]) => (_jsx("button", { type: "button", role: "radio", "aria-checked": os === key, className: os === key ? 'on' : '', onClick: () => setOs(key), children: label }, key))) }), os === 'vscode' ? (_jsxs(_Fragment, { children: [_jsx(CopyBlock, { code: vscode.command }), _jsxs("small", { className: "pg-companion-note", children: ["That installs the ", _jsx("b", { children: "Reader" }), " extension (or ", _jsx("a", { href: vscode.vsix, children: "download the .vsix" }), " and use Extensions \u2192 \u2026 \u2192 Install from VSIX). Then run ", _jsx("b", { children: "Reader: Start the Companion" }), " from VS Code\u2019s command palette: it starts the same Companion in VS Code\u2019s terminal, and the projects, the papers they cite and the Python the site uses are in its Reader side bar."] })] })) : (_jsxs(_Fragment, { children: [_jsx(CopyBlock, { code: commands[os] }), _jsxs("small", { className: "pg-companion-note", children: [os === 'uv' ? 'Runs the Companion with the uv you have.' : 'It installs uv (a small Python tool) once if it isn’t there, then runs the Companion with its own Python.', " The page may use the folder ", _jsx("span", { className: "mono", children: "~/Reader" }), ", and nothing outside it."] })] }))] })) : null, _jsxs("div", { className: "pg-companion-wait", children: [_jsx("span", { className: "pg-wait" }), looks ? 'Waiting for this computer…' : 'Looking for it…', _jsx("span", { className: "mono", children: safari ? `https://127.0.0.1:${COMPANION_TLS_PORT}` : `127.0.0.1:${COMPANION_PORT}` })] })] })), problem ? _jsx("p", { className: "pg-bad", children: problem }) : null, onManual ? (_jsx("button", { type: "button", className: "btn ghost sm pg-companion-manual", onClick: onManual, children: "Start Jupyter by hand instead" })) : null] }));
}
/** The page opened from the Companion's link, `#pair=CODE&port=N`: asks once, then connects with that code. */
function PairFromLink() {
    const [pending, setPending] = useState(() => (typeof window === 'undefined' ? null : pairFragment(window.location.hash)));
    const [found, setFound] = useState(undefined);
    const info = found === undefined ? undefined : found?.info ?? null;
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState(null);
    const [done, setDone] = useState(null);
    const [reconnecting, setReconnecting] = useState(false);
    // A pairing link opened in a tab already on the Playground changes only the hash.
    useEffect(() => {
        const onHash = () => {
            const next = pairFragment(window.location.hash);
            if (!next)
                return;
            setFound(undefined);
            setDone(null);
            setProblem(null);
            setReconnecting(false);
            setPending(next);
        };
        window.addEventListener('hashchange', onHash);
        return () => window.removeEventListener('hashchange', onHash);
    }, []);
    useEffect(() => {
        if (!pending)
            return;
        // The code is spent either way: off the address, out of history's way.
        window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
        let live = true;
        void reachCompanion(companionRoutes(pending.port, pending.via, isSafari(), isSafari() ? pending.tls ?? COMPANION_TLS_PORT : pending.tls), pending.via ? 30_000 : 0).then((reached) => {
            if (!live)
                return;
            setFound(reached);
            // A Companion this browser already knows, back at a new address (a new tunnel each start): reconnect without asking.
            if (reached?.info.id && serversNow().some((server) => server.companionId === reached.info.id)) {
                setReconnecting(true);
                void connect(reached.base, true);
            }
        });
        return () => {
            live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pending]);
    if (!pending)
        return null;
    // While a computer this browser already knows is being looked for, show nothing: it most likely reconnects by itself.
    if (!problem && (info === undefined || reconnecting) && serversNow().some((server) => server.companionId))
        return null;
    const close = () => setPending(null);
    async function connect(base, again = false) {
        if (!pending)
            return;
        setBusy(true);
        setProblem(null);
        try {
            const { server } = await pairForAccount(pending.code, base);
            // Back again (the Reader app opens this link each time): nothing to say, the page just has it.
            if (again)
                setPending(null);
            else
                setDone({ server, again });
        }
        catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(false);
        }
    }
    return (_jsx("div", { className: "scrim", role: "presentation", onMouseDown: (event) => event.target === event.currentTarget && close(), children: _jsxs("div", { className: "sheet narrow pg-pair", role: "dialog", "aria-label": "Connect this computer?", children: [_jsx("span", { className: "eyebrow", children: "Playground \u00B7 pair a computer" }), _jsx("h2", { children: done ? (done.again ? 'Reconnected' : 'Connected') : 'Connect this computer?' }), done ? (_jsx("p", { className: "lede", children: done.again ? (_jsxs(_Fragment, { children: [_jsx("b", { children: done.server.name }), " is back, and its playgrounds run on it again."] })) : (_jsxs(_Fragment, { children: [_jsx("b", { children: done.server.name }), " is under ", _jsx("b", { children: "Your compute" }), ", and new playgrounds can run on it. Start the Companion again whenever you want to use it: the link it opens reconnects it."] })) })) : info === undefined ? (_jsxs("p", { className: "lede", children: [_jsx("span", { className: "spinner" }), " Looking for the Companion\u2026"] })) : info === null ? (isSafari() && !pending.via ? (_jsxs(_Fragment, { children: [_jsxs("p", { className: "lede", children: ["Safari reaches the Companion only over https, and nothing answers on https://127.0.0.1:", pending.tls ?? COMPANION_TLS_PORT, ". On this Mac, run this once (macOS asks for your password, to trust the Companion\u2019s certificate for this Mac\u2019s own address), then open the Reader app or this link again:"] }), _jsx(CopyBlock, { code: "reader-companion trust" }), _jsx("p", { className: "lede", children: "Or run the Companion with an HTTPS tunnel instead; the link it opens then works here:" }), _jsx(CopyBlock, { code: companionCommands(siteBase(), { tunnel: true }).unix })] })) : (_jsx("p", { className: "lede", children: pending.via ? 'Neither the Companion’s own address nor its tunnel answers. Is it still running in the terminal?' : `Nothing answers on 127.0.0.1:${pending.port}. Is the Companion still running in the terminal?` }))) : (_jsxs(_Fragment, { children: [_jsxs("p", { className: "lede", children: ["A Reader Companion on this computer asked to pair with this browser, with the code ", _jsx("b", { className: "mono", children: pending.code }), "."] }), _jsxs("div", { className: "pg-pair-kv", children: [_jsx("span", { children: "Computer" }), _jsx("b", { children: info.name }), info.hardware ? (_jsxs(_Fragment, { children: [_jsx("span", { children: "Hardware" }), _jsx("b", { children: info.hardware })] })) : null, info.root ? (_jsxs(_Fragment, { children: [_jsx("span", { children: "Folder" }), _jsx("b", { className: "mono", children: info.root })] })) : null, _jsx("span", { children: "Reached" }), _jsx("b", { children: found && found.base.startsWith('https:') ? 'through its HTTPS tunnel' : 'directly, on 127.0.0.1' })] }), _jsx("p", { className: "pg-note", children: "The page may run code there, and read and write files in that folder only. Remove it any time under Your compute." })] })), problem ? _jsx("p", { className: "pg-bad", children: problem }) : null, _jsx("div", { className: "pg-pair-actions", children: done || !info ? (_jsx("button", { type: "button", className: "btn primary", onClick: close, children: done ? 'Done' : 'Close' })) : (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: "btn", onClick: close, children: "Not this one" }), _jsx("button", { type: "button", className: "btn primary", disabled: busy || !found, onClick: () => found && void connect(found.base), children: busy ? 'Connecting…' : 'Connect' })] })) })] }) }));
}
/** In the split mode, the code's home when it is Drive rather than a server. */
const DRIVE = 'drive';
/** Where a playground runs and where its files are kept, from the three modes. */
export function WhereDialog({ draft, current, onClose, onCreate, }) {
    const { settings, updateSettings } = useStore();
    // What is turned off (Settings → Compute) is not offered; a playground's own machine stays, to keep its choice.
    const servers = serversOn(settings, useServers(), current?.compute.kind === 'server' ? current.compute.serverId : current?.home.kind === 'server' ? current.home.serverId : undefined);
    const colabOn = isOn(settings, COLAB) || current?.compute.kind === 'colab';
    const pcs = servers.filter((s) => s.where === 'pc');
    const remotes = servers.filter((s) => s.where === 'remote');
    /** Your computers with a Companion: this one, and those of your account elsewhere, reached through their tunnels. */
    const devices = servers.filter(isCompanion);
    const initialMode = current
        ? current.compute.kind === 'colab' && current.home.kind !== 'server'
            ? 'colab'
            : current.home.kind === 'server' && current.compute.kind === 'server' && current.home.serverId === current.compute.serverId
                ? serverById(current.home.serverId)?.where === 'pc'
                    ? 'pc'
                    : 'device'
                : 'split'
        : colabOn || !servers.length
            ? 'colab'
            : servers.some(isCompanion)
                ? 'device'
                : 'pc';
    const [mode, setMode] = useState(initialMode);
    const [title, setTitle] = useState(draft.title);
    const [machine, setMachine] = useState(current?.compute.kind === 'colab' ? current.compute.machine : { accelerator: 'NONE' });
    /** On Colab: a machine of its own (the default), or the browser's, shared with the paper pages and the other playgrounds that share it. */
    const [shareColab, setShareColab] = useState(current?.compute.kind === 'colab' ? Boolean(current.compute.shared) : false);
    const colabCompute = shareColab ? { kind: 'colab', machine, shared: true } : { kind: 'colab', machine };
    const [pcId, setPcId] = useState(current?.home.kind === 'server' ? current.home.serverId : pcs[0]?.id);
    /** In the device mode: the computer, files and code both. */
    const [deviceId, setDeviceId] = useState(current?.home.kind === 'server' && current.compute.kind === 'server' && current.home.serverId === current.compute.serverId ? current.home.serverId : devices[0]?.id);
    /** In the split mode: the server whose folder keeps the code — any of yours, this PC or elsewhere. */
    const [homeId, setHomeId] = useState(current?.home.kind === 'server' ? current.home.serverId : current?.home.kind === 'drive' && current.compute.kind === 'server' ? DRIVE : (pcs[0] ?? servers[0])?.id ?? DRIVE);
    /** In the split mode: the server it runs on — any other of yours — or 'colab'. */
    const [remoteId, setRemoteId] = useState(current?.compute.kind === 'server' && current.home.kind === 'server' && current.compute.serverId !== current.home.serverId
        ? current.compute.serverId
        : current?.compute.kind === 'colab' && current.home.kind === 'server'
            ? 'colab'
            : (remotes.find((s) => s.id !== homeId) ?? servers.find((s) => s.id !== homeId))?.id ?? 'colab');
    const driveOk = useDriveConnected();
    /** On Colab: the files in your Drive, or on the runtime's own disk. */
    const [colabFiles, setColabFiles] = useState(current?.home.kind === 'machine' ? 'machine' : 'drive');
    const [idleStop, setIdleStop] = useState(current?.compute.kind === 'colab' ? current.idleStopMin : 30);
    const [adding, setAdding] = useState(null);
    /** Starting Jupyter by hand instead of the Companion, for this PC. */
    const [manual, setManual] = useState(false);
    const [busy, setBusy] = useState(false);
    const addingRef = useRef(null);
    const colabOk = colabAvailable(settings.googleClientId) && colabOn;
    // A mode that needs a server none has been added for opens the steps to start one at once,
    // rather than waiting for a click on a tile that reads like a hint.
    const missing = mode === 'colab' ? null : mode === 'device' ? (devices.length ? null : 'pc') : mode === 'split' ? (homeId === DRIVE ? (remoteId !== 'colab' && !servers.length ? 'remote' : null) : !servers.length ? 'pc' : remoteId !== 'colab' && !servers.some((s) => s.id !== homeId) ? 'remote' : null) : !pcs.length ? 'pc' : null;
    useEffect(() => {
        if (missing)
            setAdding(missing);
    }, [missing]);
    // The form opens below the three cards: bring it into view, or it is easy to miss.
    useEffect(() => {
        if (adding)
            addingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, [adding]);
    useEffect(() => {
        if (!pcId && pcs[0])
            setPcId(pcs[0].id);
    }, [pcs, pcId]);
    useEffect(() => {
        if (!deviceId && devices[0])
            setDeviceId(devices[0].id);
    }, [devices, deviceId]);
    useEffect(() => {
        if (!homeId)
            setHomeId((pcs[0] ?? servers[0])?.id ?? DRIVE);
        // The two ends are different machines: the code's server can't also be the one it runs on.
        if (remoteId === homeId)
            setRemoteId(servers.find((s) => s.id !== homeId)?.id ?? 'colab');
    }, [servers, pcs, homeId, remoteId]);
    useEffect(() => {
        const onKey = (event) => {
            if (event.key !== 'Escape')
                return;
            event.stopPropagation();
            onClose();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [onClose]);
    const pc = serverById(pcId);
    const device = serverById(deviceId);
    const root = current?.home.kind === 'server' ? current.home.root : '';
    const choice = mode === 'colab'
        ? { compute: colabCompute, home: colabFiles === 'drive' ? { kind: 'drive', folder: current?.home.kind === 'drive' ? current.home.folder : '' } : { kind: 'machine' } }
        : mode === 'pc'
            ? pc
                ? { compute: { kind: 'server', serverId: pc.id }, home: { kind: 'server', serverId: pc.id, root } }
                : null
            : mode === 'device'
                ? device
                    ? { compute: { kind: 'server', serverId: device.id }, home: { kind: 'server', serverId: device.id, root } }
                    : null
                : homeId === DRIVE && (remoteId === 'colab' || serverById(remoteId))
                    ? { compute: remoteId === 'colab' ? colabCompute : { kind: 'server', serverId: remoteId }, home: { kind: 'drive', folder: current?.home.kind === 'drive' ? current.home.folder : '' } }
                    : homeId && serverById(homeId) && (remoteId === 'colab' || (serverById(remoteId) && remoteId !== homeId))
                        ? { compute: remoteId === 'colab' ? colabCompute : { kind: 'server', serverId: remoteId }, home: { kind: 'server', serverId: homeId, root } }
                        : null;
    const usesColab = choice?.compute.kind === 'colab';
    const needsDrive = choice?.home.kind === 'drive' && !driveOk;
    const blocked = !choice || (usesColab && !colabOk) || needsDrive || !title.trim();
    const colabPicker = (_jsxs(_Fragment, { children: [_jsx("div", { className: "pg-opts", role: "radiogroup", "aria-label": "Colab machine", children: MACHINES.map((option) => (_jsxs("button", { type: "button", role: "radio", "aria-checked": machine.accelerator === option.accelerator, className: `pg-opt${machine.accelerator === option.accelerator ? ' is-on' : ''}`, onClick: () => setMachine({ ...machine, accelerator: option.accelerator }), children: [_jsx(ColabMark, {}), _jsx("b", { children: option.label }), _jsx("small", { children: option.note })] }, option.accelerator))) }), _jsx("small", { className: "pg-pick-label", children: "Its machine" }), _jsxs("div", { className: "pg-opts", role: "radiogroup", "aria-label": "Its own Colab machine, or shared", onClick: (event) => event.stopPropagation(), children: [_jsxs("button", { type: "button", role: "radio", "aria-checked": !shareColab, className: `pg-opt${!shareColab ? ' is-on' : ''}`, onClick: () => setShareColab(false), children: [_jsx(ColabMark, {}), _jsx("b", { children: "A machine of its own" }), _jsx("small", { children: "its own GPU, memory and disk; runs beside your other Colab work; uses units of its own" })] }), _jsxs("button", { type: "button", role: "radio", "aria-checked": shareColab, className: `pg-opt${shareColab ? ' is-on' : ''}`, onClick: () => setShareColab(true), children: [_jsx(ColabMark, {}), _jsx("b", { children: "Shared" }), _jsx("small", { children: "the machine the paper pages use, with the other playgrounds that share it \u2014 fewer units, one GPU between them" })] })] })] }));
    const serverPicker = (list, picked, pick, kind, extra, label, anyKind = false) => (_jsxs("div", { className: "pg-opts", role: "radiogroup", "aria-label": label ?? (kind === 'pc' ? 'This PC' : 'The GPU machine'), children: [list.map((server) => {
                const mark = anyKind ? (server.where === 'pc' ? 'pc' : 'remote') : kind;
                return (_jsxs("button", { type: "button", role: "radio", "aria-checked": picked === server.id, className: `pg-opt${picked === server.id ? ' is-on' : ''}`, onClick: () => pick(server.id), children: [_jsx("span", { className: `pg-mark ${mark === 'pc' ? 'is-pc' : 'is-gpu'}`, children: mark === 'pc' ? 'PC' : 'GPU' }), _jsx("b", { children: server.name }), _jsx("small", { className: "mono", children: safeHost(server.url) })] }, server.id));
            }), extra, anyKind ? (_jsxs(_Fragment, { children: [_jsxs("button", { type: "button", className: "pg-opt is-add", onClick: () => setAdding('pc'), children: [_jsx("b", { children: "+ Connect this computer" }), _jsx("small", { children: "one command in a terminal" })] }), _jsxs("button", { type: "button", className: "pg-opt is-add", onClick: () => setAdding('remote'), children: [_jsx("b", { children: "+ Another machine\u2019s Jupyter server" }), _jsx("small", { children: "a lab server, a cloud VM, a rented GPU, another computer of yours" })] })] })) : (_jsxs("button", { type: "button", className: "pg-opt is-add", onClick: () => setAdding(kind), children: [_jsxs("b", { children: ["+ ", kind === 'pc' ? 'Connect this computer' : 'A GPU machine’s Jupyter server'] }), _jsx("small", { children: kind === 'pc' ? 'one command in a terminal' : 'a rented GPU, a lab server, an SSH tunnel' })] }))] }));
    return (_jsx("div", { className: "scrim pg-scrim", role: "presentation", onMouseDown: (event) => event.target === event.currentTarget && onClose(), children: _jsxs("div", { className: "sheet pg-sheet", role: "dialog", "aria-label": "Where should it run?", children: [_jsxs("header", { className: "pg-sheet-head", children: [_jsxs("div", { children: [_jsx("span", { className: "eyebrow", children: current ? 'Change the machine' : `New ${draft.kind === 'project' ? 'project' : 'notebook'}` }), _jsx("h2", { children: "Where should it run?" }), _jsx("p", { children: "The code is the same whichever you pick; the machine can be changed from the bar later." })] }), _jsx("button", { type: "button", className: "icon-btn", "aria-label": "Close", onClick: onClose, children: _jsx(CloseIcon, { size: 17 }) })] }), !current ? (_jsxs("label", { className: "pg-title-field", children: [_jsx("span", { children: "Name" }), _jsx("input", { value: title, onChange: (event) => setTitle(event.target.value) })] })) : null, 'note' in draft && draft.note ? _jsx("p", { className: "pg-note", children: draft.note }) : null, _jsxs("div", { className: "pg-modes", children: [_jsxs("section", { className: `pg-mode${mode === 'colab' ? ' is-on' : ''}`, onClick: () => setMode('colab'), children: [_jsxs("div", { className: "pg-mode-top", children: [_jsx(ColabMark, {}), _jsx("b", { children: "Colab, in the browser" }), _jsx("span", { className: "pg-radio", "aria-hidden": "true" })] }), _jsxs("div", { className: "pg-flow", children: [_jsx("span", { children: "this tab" }), _jsx("i", { children: "\u21C4" }), _jsx("span", { children: "Colab runtime \u00B7 kernel, shell" }), _jsx("i", { children: "\u21C4" }), _jsx("span", { children: colabFiles === 'drive' ? 'your Google Drive · files' : 'the runtime’s disk · files' })] }), _jsxs("ul", { children: [_jsx("li", { className: "good", children: "Nothing to install; CPU and a T4 on the free tier" }), _jsx("li", { className: "good", children: shareColab ? 'Shares the paper pages’ Colab machine (its own Python on it)' : 'A Colab machine of its own: runs beside your other Colab work' }), _jsx("li", { className: colabFiles === 'drive' ? 'good' : 'bad', children: colabFiles === 'drive' ? 'The files are kept in your Google Drive, copied to the runtime before each run' : 'The files live on the runtime’s disk — they go when the runtime ends' })] }), mode === 'colab' ? (_jsxs(_Fragment, { children: [_jsx("small", { className: "pg-pick-label", children: "The files are kept in" }), _jsxs("div", { className: "pg-opts", role: "radiogroup", "aria-label": "Where the files are kept", onClick: (event) => event.stopPropagation(), children: [_jsxs("button", { type: "button", role: "radio", "aria-checked": colabFiles === 'drive', className: `pg-opt${colabFiles === 'drive' ? ' is-on' : ''}`, onClick: () => setColabFiles('drive'), children: [_jsx(DriveMark, {}), _jsx("b", { children: "Google Drive" }), _jsx("small", { children: "Papers_collection/Playgrounds \u2014 kept, and in every browser you sign in to" })] }), _jsxs("button", { type: "button", role: "radio", "aria-checked": colabFiles === 'machine', className: `pg-opt${colabFiles === 'machine' ? ' is-on' : ''}`, onClick: () => setColabFiles('machine'), children: [_jsx(ColabMark, {}), _jsx("b", { children: "The Colab runtime" }), _jsx("small", { children: "its disk only \u2014 gone when it stops" })] })] }), _jsx("small", { className: "pg-pick-label", children: "The machine" }), colabPicker] })) : null, mode === 'colab' && needsDrive ? _jsx("p", { className: "pg-bad", children: "Keeping the files in Drive needs you signed in with Google, with Drive (Settings \u2192 Google)." }) : null, mode === 'colab' && !colabOn ? (_jsxs("p", { className: "pg-bad", children: ["Colab is turned off.", ' ', _jsx("button", { type: "button", className: "link-btn", onClick: (event) => (event.stopPropagation(), updateSettings({ computeOff: switched(settings.computeOff, COLAB, true) })), children: "Turn it on" })] })) : mode === 'colab' && !colabOk ? (_jsx("p", { className: "pg-bad", children: "Colab needs Settings \u2192 Google (a client ID) and Settings \u2192 Paper proxy first." })) : null] }), _jsxs("section", { className: `pg-mode${mode === 'pc' ? ' is-on' : ''}`, onClick: () => setMode('pc'), children: [_jsxs("div", { className: "pg-mode-top", children: [_jsx("span", { className: "pg-mark is-pc", children: "PC" }), _jsx("b", { children: "This PC" }), _jsx("span", { className: "pg-radio", "aria-hidden": "true" })] }), _jsxs("div", { className: "pg-flow", children: [_jsx("span", { children: "this browser" }), _jsx("i", { children: "\u21C4 127.0.0.1 \u21C4" }), _jsx("span", { children: "the computer it runs on \u00B7 files, kernel" })] }), _jsx("p", { className: "pg-mode-what", children: "The computer you are using right now, reached directly \u2014 only from this browser, on this computer. Pick it to work here and nowhere else." }), _jsxs("ul", { children: [_jsx("li", { className: "good", children: "Your files, your GPU, no session clock; nothing leaves this computer" }), _jsx("li", { className: "good", children: "Any Jupyter server here works, the Reader Companion or one started by hand" }), _jsx("li", { className: "bad", children: "Not from your phone or another laptop \u2014 for that, pick \u201CYour computer, from anywhere\u201D" })] }), mode === 'pc' ? serverPicker(pcs, pcId, setPcId, 'pc') : null] }), _jsxs("section", { className: `pg-mode${mode === 'device' ? ' is-on' : ''}`, onClick: () => setMode('device'), children: [_jsxs("div", { className: "pg-mode-top", children: [_jsx("span", { className: "pg-mark is-pc", children: "PC" }), _jsx("b", { children: "Your computer, from anywhere" }), _jsx("span", { className: "pg-radio", "aria-hidden": "true" })] }), _jsxs("div", { className: "pg-flow", children: [_jsx("span", { children: "any browser you sign in to" }), _jsx("i", { children: "\u21C4 its HTTPS tunnel \u21C4" }), _jsx("span", { children: "that computer \u00B7 files, kernel, shell" })] }), _jsx("p", { className: "pg-mode-what", children: "A computer of yours with the Reader Companion, connected to your Google account \u2014 this one or another. Every browser you sign in to reaches it. Pick it to open the same project from your phone, another laptop, or here." }), _jsxs("ul", { children: [_jsx("li", { className: "good", children: "Code and compute both stay on that computer" }), _jsx("li", { className: "good", children: "It shows up in every browser signed in as you \u2014 nothing to pair again" }), _jsx("li", { className: "bad", children: "Only while that computer is on, online, and its Companion running" })] }), mode === 'device' ? (_jsxs("div", { className: "pg-opts", role: "radiogroup", "aria-label": "Your computer", onClick: (event) => event.stopPropagation(), children: [devices.map((server) => (_jsxs("button", { type: "button", role: "radio", "aria-checked": deviceId === server.id, className: `pg-opt${deviceId === server.id ? ' is-on' : ''}`, onClick: () => setDeviceId(server.id), children: [_jsx("span", { className: "pg-mark is-pc", children: "PC" }), _jsx("b", { children: server.name }), _jsx("small", { className: "mono", children: server.where === 'pc' ? 'this computer' : `from here, through ${safeHost(server.url)}` })] }, server.id))), !devices.length ? _jsx("small", { className: "pg-note", children: "None of your computers is connected yet. Open the Reader app on the one you want, signed in as you: it shows up here, on every device you sign in to." }) : null] })) : null] }), _jsxs("section", { className: `pg-mode is-wide${mode === 'split' ? ' is-on' : ''}`, onClick: () => setMode('split'), children: [_jsxs("div", { className: "pg-mode-top", children: [_jsx("span", { className: "pg-mark is-pc", children: "PC" }), _jsx("span", { className: "pg-arrow", children: "\u2192" }), _jsx("span", { className: "pg-mark is-gpu", children: "GPU" }), _jsx("b", { children: "Code on one machine, compute on another" }), _jsx("span", { className: "pg-radio", "aria-hidden": "true" })] }), _jsxs("div", { className: "pg-flow", children: [_jsx("span", { children: "a folder in Drive or on any machine of yours" }), _jsx("i", { children: "\u21C4 copied before each run \u21C4" }), _jsx("span", { children: "any other \u00B7 kernel, shell" }), _jsx("i", { children: "\u2192" }), _jsx("span", { children: "runs/ & results back" })] }), _jsxs("ul", { children: [_jsx("li", { className: "good", children: "The code lives in your Google Drive, or in a folder on one machine \u2014 this PC, another computer of yours, a lab server" }), _jsx("li", { className: "good", children: "Cells and the console run on another: a GPU box, a rented card, Colab" }), _jsx("li", { className: "good", children: "What a run writes under runs/ and results/ comes back to the code\u2019s folder" })] }), mode === 'split' ? (_jsxs("div", { className: "pg-split", onClick: (event) => event.stopPropagation(), children: [_jsx("small", { children: "The code is kept on" }), serverPicker(servers, homeId, setHomeId, 'pc', (_jsxs("button", { type: "button", role: "radio", "aria-checked": homeId === DRIVE, className: `pg-opt${homeId === DRIVE ? ' is-on' : ''}`, onClick: () => setHomeId(DRIVE), children: [_jsx(DriveMark, {}), _jsx("b", { children: "Google Drive" }), _jsx("small", { children: "Papers_collection/Playgrounds" })] })), 'Where the code is kept', true), homeId === DRIVE && !driveOk ? _jsx("p", { className: "pg-bad", children: "Sign in with Google, with Drive (Settings \u2192 Google), to keep the code there." }) : null, _jsx("small", { children: "It runs on" }), serverPicker(servers.filter((s) => s.id !== homeId), remoteId, setRemoteId, 'remote', (_jsxs("button", { type: "button", role: "radio", "aria-checked": remoteId === 'colab', className: `pg-opt${remoteId === 'colab' ? ' is-on' : ''}`, onClick: () => setRemoteId('colab'), children: [_jsx(ColabMark, {}), _jsx("b", { children: "Your Colab" }), _jsx("small", { children: "a GPU runtime \u2014 pick it below" })] })), 'Where it runs', true), remoteId === 'colab' ? colabPicker : null] })) : null] })] }), adding ? (_jsxs("div", { className: "pg-adding", ref: addingRef, children: [missing === adding && adding === 'remote' ? _jsxs("p", { className: "pg-adding-lede", children: [mode === 'split' ? 'The second machine needs a Jupyter server too.' : 'The GPU machine needs a Jupyter server too.', " Start one there with the commands below, then paste its address."] }) : null, adding === 'pc' && !manual ? (_jsx(CompanionConnect, { onManual: () => setManual(true), onClose: missing === 'pc' ? undefined : () => setAdding(null), onPaired: (saved) => {
                                setPcId(saved.id);
                                setAdding(null);
                            } })) : (_jsx(ServerForm, { defaultWhere: adding, onDone: () => (setAdding(null), setManual(false)), onSaved: (saved) => {
                                if (saved.where === 'pc')
                                    setPcId(saved.id);
                                // In the split mode a new server fills whichever end is missing: the code's first, then where it runs.
                                if (mode === 'split') {
                                    if (!homeId || !serverById(homeId))
                                        setHomeId(saved.id);
                                    else if (saved.id !== homeId)
                                        setRemoteId(saved.id);
                                }
                                else if (saved.where !== 'pc')
                                    setRemoteId(saved.id);
                            } }, adding))] })) : null, _jsxs("footer", { className: "pg-sheet-foot", children: [usesColab ? (_jsxs("label", { className: "pg-idle", children: [_jsx("input", { type: "checkbox", checked: idleStop > 0, onChange: (event) => setIdleStop(event.target.checked ? 30 : 0) }), _jsxs("span", { children: ["Stop the Colab runtime after", _jsx("select", { value: idleStop || 30, disabled: !idleStop, onChange: (event) => setIdleStop(Number(event.target.value)), onClick: (event) => event.stopPropagation(), children: [10, 20, 30, 60, 120].map((n) => (_jsxs("option", { value: n, children: [n, " min"] }, n))) }), "with nothing running, while this tab is open"] })] })) : missing ? (_jsx("span", { className: "pg-note", children: mode === 'split' ? (missing === 'pc' ? 'Add the machine that keeps the code above.' : 'Add a second machine to run it on above, or pick Your Colab.') : missing === 'pc' ? 'Connect this computer above to create it here.' : 'Add the GPU machine’s Jupyter server above, or pick Your Colab.' })) : (_jsx("span", { className: "pg-note", children: "A Jupyter server of yours stays up until you stop it; a rented one is billed by its provider while it is." })), _jsx("span", { className: "spacer" }), _jsx("button", { type: "button", className: "btn", onClick: onClose, children: "Cancel" }), _jsxs("button", { type: "button", className: "btn primary", disabled: blocked || busy, onClick: async () => {
                                if (!choice)
                                    return;
                                setBusy(true);
                                try {
                                    const base = draft;
                                    await onCreate({
                                        title: title.trim(),
                                        kind: draft.kind,
                                        start: base.start ?? 'blank',
                                        cites: base.cites,
                                        cells: base.cells ?? blankCells(title.trim()),
                                        files: base.files,
                                        pending: base.pending,
                                        compute: choice.compute,
                                        home: choice.home,
                                        idleStopMin: usesColab ? idleStop : 0,
                                    });
                                }
                                finally {
                                    setBusy(false);
                                }
                            }, children: [current ? 'Use this' : 'Create', choice ? ` · ${choice.compute.kind === 'colab' ? `Colab ${MACHINES.find((m) => m.accelerator === machine.accelerator)?.label}` : serverById(choice.compute.serverId)?.name}` : ''] })] })] }) }));
}
