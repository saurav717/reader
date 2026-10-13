import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
// "Open a file or folder": where it is first, then the file or folder, then
// how to use it. A computer of yours is browsed where it is — through its
// Companion, the whole computer (0.8.0 on), or the folder a Jupyter server was
// started in — and the folder is used in place (linked into the Companion's
// folder, edits land in it) or copied to Drive or a new folder. This browser
// can still upload a copy. Drive and Colab say plainly what they can't do and
// what to do instead. Above it all: which of your computers have the Reader
// app signed in as you, or that none do.
import { useEffect, useMemo, useState } from 'react';
import { currentAccount } from '../lib/api';
import { snapshotPlan } from '../lib/away';
import { colabAvailable } from '../lib/colab';
import { chooseFolder, findCompanion, findLocalCompanion, FOLDERS_VERSION, isNewer, linkFolder, listFolder } from '../lib/companion';
import { listDevices } from '../lib/devices';
import { fromIpynb } from '../lib/notebook';
import { blankCells, createPlayground, serverHost, useDriveConnected, useServers } from '../lib/playground';
import { listAll } from '../lib/projectAgent';
import { useStore } from '../lib/store';
import { since } from '../lib/away';
import FileIcon from './FileIcon';
import { CloseIcon } from './icons';
import { isCompanion } from './VsCodeExtension';
const join = (dir, name, sep = '/') => (dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`);
const parentOf = (path) => path.replace(/[\\/][^\\/]*$/, '') || '/';
const nameOf = (path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const maskEmail = (email) => (email ? email.replace(/^(.)[^@]*(@.*)$/, '$1•••$2') : '');
export default function OpenDialog({ onClose, onOpen, onUploadFile, onUploadFolder, onConnect }) {
    const servers = useServers();
    const { settings } = useStore();
    const drive = useDriveConnected();
    const account = currentAccount();
    const colabOk = colabAvailable(settings.googleClientId);
    // Which computers answer, which Companion is this computer's own, and the account's list.
    const [probes, setProbes] = useState({});
    const [localId, setLocalId] = useState(null);
    const [devices, setDevices] = useState(account ? 'loading' : null);
    useEffect(() => {
        let alive = true;
        void findLocalCompanion(undefined, 1200).then((found) => alive && setLocalId(found?.info.id ?? null));
        if (account)
            void listDevices().then((list) => alive && setDevices(list));
        setProbes(Object.fromEntries(servers.map((s) => [s.id, { state: 'checking' }])));
        for (const server of servers) {
            const look = isCompanion(server)
                ? findCompanion(server.url, 5000).then((info) => (info ? { state: 'up', version: info.version } : { state: 'down' }))
                : serverHost(server, '')
                    .list('')
                    .then(() => ({ state: 'up' }))
                    .catch(() => ({ state: 'down' }));
            void look.then((probe) => alive && setProbes((now) => ({ ...now, [server.id]: probe })));
        }
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [servers.map((s) => s.id).join(' ')]);
    const ordered = useMemo(() => [...servers].sort((a, b) => {
        const rank = (s) => (s.companionId && s.companionId === localId ? 0 : probes[s.id]?.state === 'up' ? 1 : probes[s.id]?.state === 'checking' ? 2 : 3);
        return rank(a) - rank(b);
    }), [servers, probes, localId]);
    const [source, setSource] = useState(null);
    // Start on this computer when it has a Companion that answers, else the first computer that does, else this browser.
    useEffect(() => {
        if (source)
            return;
        const first = ordered.find((s) => probes[s.id]?.state === 'up');
        if (first)
            setSource({ kind: 'server', id: first.id });
        else if (servers.length && servers.every((s) => probes[s.id] && probes[s.id].state !== 'checking'))
            setSource({ kind: 'browser' });
        else if (!servers.length)
            setSource({ kind: 'browser' });
    }, [ordered, probes, servers, source]);
    const server = source?.kind === 'server' ? servers.find((s) => s.id === source.id) : undefined;
    const probe = server ? probes[server.id] : undefined;
    const isHere = Boolean(server?.companionId && server.companionId === localId);
    // A Companion 0.8 on lists the whole computer; an older one, or any other Jupyter server, the folder it serves.
    const mode = server && isCompanion(server) && probe?.version && !isNewer(FOLDERS_VERSION, probe.version) ? 'disk' : 'root';
    // ------------------------------------------------------------ browsing --
    const [place, setPlace] = useState(null);
    const [at, setAt] = useState('');
    const [typed, setTyped] = useState('');
    const [hidden, setHidden] = useState(false);
    const [loading, setLoading] = useState(false);
    const [problem, setProblem] = useState(null);
    const [picked, setPicked] = useState(null);
    useEffect(() => {
        setPlace(null);
        setPicked(null);
        setAt('');
        setProblem(null);
    }, [source?.kind, server?.id, mode]);
    useEffect(() => {
        if (!server || probe?.state !== 'up')
            return;
        let alive = true;
        setLoading(true);
        setProblem(null);
        const go = async () => {
            if (mode === 'disk') {
                const found = await listFolder(server, at, hidden);
                return {
                    path: found.path,
                    home: found.home,
                    shown: found.path.startsWith(found.home) ? `~${found.path.slice(found.home.length)}` : found.path,
                    parent: found.parent,
                    rows: found.entries.map((e) => ({ name: e.name, path: join(found.path, e.name, found.sep), dir: e.dir, size: e.size })),
                    places: found.places,
                };
            }
            const entries = await serverHost(server, '').list(at);
            return {
                path: at,
                home: '',
                shown: `${server.root ?? (isCompanion(server) ? '~/Reader' : 'its folder')}${at ? `/${at}` : ''}`,
                parent: at ? at.split('/').slice(0, -1).join('/') : null,
                rows: entries
                    .filter((e) => hidden || !e.name.startsWith('.'))
                    .map((e) => ({ name: e.name, path: e.path, dir: e.type === 'directory', size: e.size ?? null }))
                    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)),
                places: [],
            };
        };
        void go()
            .then((next) => {
            if (!alive)
                return;
            setPlace(next);
            setTyped(next.shown);
            setPicked((now) => now ?? { name: nameOf(next.path) || 'folder', path: next.path, dir: true, size: null });
        })
            .catch((error) => alive && setProblem(error instanceof Error ? error.message : String(error)))
            .finally(() => alive && setLoading(false));
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [server?.id, probe?.state, mode, at, hidden]);
    const enter = (path) => {
        setPicked(null);
        setAt(path);
    };
    const [how, setHow] = useState('here');
    const upOthers = servers.filter((s) => s.id !== server?.id && probes[s.id]?.state === 'up');
    const [runOn, setRunOn] = useState('');
    useEffect(() => setRunOn(server?.id ?? ''), [server?.id]);
    const [name, setName] = useState('');
    useEffect(() => setName(picked ? nameOf(picked.path).replace(/\.[^.]+$/, '') || 'project' : ''), [picked?.path]);
    const notebookFile = Boolean(picked && !picked.dir && /\.ipynb$/i.test(picked.name));
    const [busy, setBusy] = useState(false);
    const open = async () => {
        if (!server || !picked)
            return;
        setBusy(true);
        setProblem(null);
        try {
            const folder = picked.dir ? picked.path : parentOf(picked.path);
            // The folder as the Companion serves it: linked in from anywhere on the computer, or already under its folder.
            const root = mode === 'disk' ? (await linkFolder(server, folder)).root : picked.dir ? picked.path : picked.path.split('/').slice(0, -1).join('/');
            if (!root)
                throw new Error(`Pick a folder inside ${server.root ?? 'the Reader folder'}, not the Reader folder itself.`);
            const host = serverHost(server, root);
            const compute = runOn === 'colab' ? { kind: 'colab', machine: { accelerator: 'NONE' } } : { kind: 'server', serverId: runOn || server.id };
            const title = name.trim() || nameOf(folder);
            let cells = blankCells(title);
            if (notebookFile) {
                const text = await host.read(nameOf(picked.path));
                const read = text ? fromIpynb(text) : null;
                if (!read)
                    throw new Error(`${picked.name} is not a notebook this page can read.`);
                cells = read;
            }
            let home = { kind: 'server', serverId: server.id, root };
            let files;
            if (how !== 'here') {
                files = {};
                for (const file of snapshotPlan(await listAll(host)).take) {
                    const text = await host.read(file.path).catch(() => null);
                    if (text !== null)
                        files[file.path] = text;
                }
                home = how === 'drive' ? { kind: 'drive', folder: '' } : { kind: 'server', serverId: server.id, root: '' };
            }
            const made = await createPlayground({ title, kind: notebookFile ? 'notebook' : 'project', compute, home, start: 'file', cells, files });
            onOpen(made.id);
            onClose();
        }
        catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(false);
        }
    };
    // -------------------------------------------------------------- account --
    const companions = servers.filter(isCompanion);
    const accountLine = !account ? (_jsxs(_Fragment, { children: [_jsx("b", { children: "Not signed in." }), " Only the computers paired with this browser are listed. Sign in with Google (top of Settings) to see every computer that has the Reader app signed in as you, from any browser."] })) : devices === 'loading' ? (_jsxs(_Fragment, { children: ["Looking up the computers signed in as ", maskEmail(account), "\u2026"] })) : devices && devices.length === 0 ? (_jsxs(_Fragment, { children: [_jsxs("b", { children: ["No computer has the Reader app signed in as ", maskEmail(account), "."] }), " Install it on the computer that has your files and it shows here, from any browser you sign in to.", ' ', _jsx("button", { type: "button", className: "link", onClick: onConnect, children: "Connect this computer" })] })) : devices ? (_jsxs(_Fragment, { children: ["Signed in as ", maskEmail(account), " \u00B7 the Reader app is on ", devices.length, " ", devices.length === 1 ? 'computer' : 'computers', ":", ' ', devices.map((d, i) => (_jsxs("span", { children: [i ? ', ' : '', _jsx("b", { children: d.name }), " ", d.online === false || d.off ? `(offline${d.seen ? `, seen ${since(d.seen)}` : ''})` : '(online)'] }, d.id))), companions.length < devices.length ? ' — the ones not listed below have no address this browser can reach yet.' : ''] })) : (_jsxs(_Fragment, { children: ["Signed in as ", maskEmail(account), "; the list of your computers couldn\u2019t be read just now \u2014 the ones paired with this browser are below."] }));
    const label = (s) => {
        const p = probes[s.id];
        if (s.companionId && s.companionId === localId)
            return 'this computer';
        if (!p || p.state === 'checking')
            return 'looking…';
        if (p.state === 'down')
            return `offline${s.seen ? ` · seen ${since(s.seen)}` : ''}`;
        return s.where === 'pc' ? 'online' : 'online · through its tunnel';
    };
    return (_jsx("div", { className: "scrim op-scrim", onMouseDown: (event) => event.target === event.currentTarget && !busy && onClose(), children: _jsxs("div", { className: "op-dlg", role: "dialog", "aria-modal": "true", "aria-label": "Open a file or folder", children: [_jsxs("header", { className: "op-head", children: [_jsxs("div", { children: [_jsx("span", { className: "eyebrow", children: "Open a file or folder" }), _jsx("h2", { children: "Where is it?" })] }), _jsx("button", { type: "button", className: "icon-btn sm", "aria-label": "Close", onClick: onClose, disabled: busy, children: _jsx(CloseIcon, { size: 14 }) })] }), _jsx("p", { className: `op-account${account && devices && devices !== 'loading' && devices.length === 0 ? ' is-warn' : ''}`, children: accountLine }), _jsxs("div", { className: "op-body", children: [_jsxs("nav", { className: "op-sources", "aria-label": "Where it is", children: [_jsx("span", { className: "op-group", children: "Your computers" }), ordered.length ? (ordered.map((s) => (_jsxs("button", { type: "button", className: `op-source${server?.id === s.id ? ' is-on' : ''}`, onClick: () => setSource({ kind: 'server', id: s.id }), children: [_jsx("span", { className: `op-dot is-${s.companionId && s.companionId === localId ? 'here' : probes[s.id]?.state ?? 'checking'}` }), _jsxs("span", { className: "op-source-text", children: [_jsx("b", { children: s.name }), _jsx("small", { children: label(s) })] })] }, s.id)))) : (_jsxs("p", { className: "op-empty", children: ["None connected to this browser.", ' ', _jsx("button", { type: "button", className: "link", onClick: onConnect, children: "Connect this computer" })] })), _jsx("span", { className: "op-group", children: "Elsewhere" }), _jsxs("button", { type: "button", className: `op-source${source?.kind === 'browser' ? ' is-on' : ''}`, onClick: () => setSource({ kind: 'browser' }), children: [_jsx("span", { className: "op-dot is-up" }), _jsxs("span", { className: "op-source-text", children: [_jsx("b", { children: "Upload from this browser" }), _jsx("small", { children: "a copy, from the computer you\u2019re on" })] })] }), _jsxs("button", { type: "button", className: `op-source${source?.kind === 'drive' ? ' is-on' : ''}`, onClick: () => setSource({ kind: 'drive' }), children: [_jsx("span", { className: `op-dot is-${drive ? 'up' : 'down'}` }), _jsxs("span", { className: "op-source-text", children: [_jsx("b", { children: "Google Drive" }), _jsx("small", { children: drive ? 'what to do with Drive files' : 'not signed in with Drive' })] })] }), _jsxs("button", { type: "button", className: `op-source${source?.kind === 'colab' ? ' is-on' : ''}`, onClick: () => setSource({ kind: 'colab' }), children: [_jsx("span", { className: `op-dot is-${colabOk ? 'up' : 'down'}` }), _jsxs("span", { className: "op-source-text", children: [_jsx("b", { children: "Colab" }), _jsx("small", { children: "files on a Colab runtime" })] })] })] }), _jsxs("section", { className: "op-main", children: [!source ? (_jsxs("p", { className: "pg-note", children: [_jsx("span", { className: "spinner" }), " Looking for your computers\u2026"] })) : source.kind === 'browser' ? (_jsxs("div", { className: "op-guide", children: [_jsx("h3", { children: "Upload a copy from the computer you\u2019re on" }), _jsx("p", { children: "The browser reads the file or folder and the project gets a copy; where that copy is kept \u2014 your Drive, a folder on a computer of yours \u2014 is the next step. Data, checkpoints, caches and files over 200 KB are left out." }), localId ? (_jsxs("p", { className: "op-tip", children: ["This computer has the Reader app: pick ", _jsx("b", { children: servers.find((s) => s.companionId === localId)?.name ?? 'it' }), " on the left to open a folder ", _jsx("b", { children: "where it is" }), ", with nothing copied \u2014 edits change the folder itself."] })) : null, _jsxs("div", { className: "op-acts", children: [_jsx("button", { type: "button", className: "btn", onClick: onUploadFile, children: "Choose a file\u2026" }), _jsx("button", { type: "button", className: "btn", onClick: onUploadFolder, children: "Choose a folder\u2026" })] })] })) : source.kind === 'drive' ? (_jsxs("div", { className: "op-guide", children: [_jsx("h3", { children: "Files in your Google Drive" }), _jsxs("p", { children: ["Reader sees only the files it made in your Drive (Google\u2019s ", _jsx("i", { children: "drive.file" }), " permission), so other Drive folders can\u2019t be browsed from here. Projects already kept in Drive are in your list, and open on any computer."] }), _jsxs("ul", { children: [_jsxs("li", { children: ["To work on a Drive folder with Colab: start a ", _jsx("b", { children: "Blank notebook" }), " on Colab and mount Drive in it \u2014 ", _jsx("code", { children: "from google.colab import drive; drive.mount('/content/drive')" }), "."] }), _jsx("li", { children: "To work on it on a computer: let Google Drive for desktop sync it there, then pick that computer on the left and open the folder where it is." }), _jsxs("li", { children: ["Or download it, and use ", _jsx("b", { children: "Upload from this browser" }), "."] })] }), !drive ? _jsx("p", { className: "op-tip", children: "Sign in with Google, with Drive, to keep projects in Drive." }) : null] })) : source.kind === 'colab' ? (_jsxs("div", { className: "op-guide", children: [_jsx("h3", { children: "Files on a Colab runtime" }), _jsx("p", { children: "A Colab runtime\u2019s disk is wiped when the runtime stops, so there is nothing there to open later. Keep the code somewhere that lasts and run it on Colab:" }), _jsxs("ul", { children: [_jsxs("li", { children: ["Open the folder from a computer of yours (or upload it) and keep it in ", _jsx("b", { children: "your Drive" }), ", then choose ", _jsx("b", { children: "Colab" }), " under \u201CRun it on\u201D \u2014 the code is copied to the runtime before each run."] }), _jsxs("li", { children: ["For a repository, use ", _jsx("b", { children: "From a repository" }), ": the clone runs on the machine you pick."] })] }), !colabOk ? _jsx("p", { className: "op-tip", children: "Colab needs a Google client ID and the reader\u2019s proxy, in Settings." }) : null] })) : !server ? null : probe?.state === 'down' ? (_jsxs("div", { className: "op-guide", children: [_jsxs("h3", { children: [server.name, " isn\u2019t answering"] }), _jsxs("p", { children: ["It may be off or asleep, or its Companion has stopped", server.seen ? ` — last seen ${since(server.seen)}` : '', ". On ", server.name, ", open the Reader app (or run ", _jsx("code", { children: "reader-companion" }), "); it shows here as online, and its folders can be opened."] }), _jsx("p", { className: "op-tip", children: "Its files can\u2019t be opened from here until it answers: nothing of it is kept anywhere else." })] })) : probe?.state !== 'up' ? (_jsxs("p", { className: "pg-note", children: [_jsx("span", { className: "spinner" }), " Reaching ", server.name, "\u2026"] })) : (_jsxs("div", { className: "op-browse", children: [mode === 'root' ? (_jsx("p", { className: "op-tip", children: isCompanion(server)
                                                ? `This Companion (${probe.version ?? 'older'}) shows only its own folder. Update it to ${FOLDERS_VERSION} or later (the machine menu on a project, or Your compute) to browse the whole computer.`
                                                : 'A Jupyter server shows only the folder it was started in.' })) : null, _jsxs("div", { className: "op-path", children: [place?.parent !== null && place?.parent !== undefined ? (_jsx("button", { type: "button", className: "btn sm", onClick: () => enter(place.parent), title: "Up a folder", children: "\u2191" })) : null, _jsx("form", { onSubmit: (event) => {
                                                        event.preventDefault();
                                                        if (mode === 'disk')
                                                            enter(typed);
                                                    }, children: _jsx("input", { value: typed, onChange: (event) => setTyped(event.target.value), readOnly: mode !== 'disk', "aria-label": "The folder", spellCheck: false }) }), _jsxs("label", { className: "op-hidden", children: [_jsx("input", { type: "checkbox", checked: hidden, onChange: (event) => setHidden(event.target.checked) }), " hidden"] }), mode === 'disk' && isHere ? (_jsx("button", { type: "button", className: "btn sm", title: `${server.name}'s own folder chooser`, onClick: () => void chooseFolder(server)
                                                        .then((got) => got.path && (enter(got.path), setPicked({ name: nameOf(got.path), path: got.path, dir: true, size: null })))
                                                        .catch((error) => setProblem(error instanceof Error ? error.message : String(error))), children: "Choose with this computer\u2019s dialog\u2026" })) : null] }), place?.places.length ? (_jsx("div", { className: "op-places", children: place.places.map((p) => (_jsx("button", { type: "button", className: `op-chip${place.path === p.path ? ' is-on' : ''}`, onClick: () => enter(p.path), children: p.name }, p.path))) })) : null, _jsxs("div", { className: "op-list", role: "listbox", "aria-label": "Folders and files", children: [loading && !place ? (_jsxs("p", { className: "pg-note", children: [_jsx("span", { className: "spinner" }), " Listing\u2026"] })) : null, place?.rows.map((row) => (_jsxs("button", { type: "button", role: "option", "aria-selected": picked?.path === row.path, className: `op-row${picked?.path === row.path ? ' is-on' : ''}`, onClick: () => setPicked(row), onDoubleClick: () => row.dir && enter(row.path), children: [row.dir ? _jsx("span", { className: "op-folder", "aria-hidden": "true" }) : _jsx(FileIcon, { path: row.name }), _jsx("span", { className: "op-row-name", children: row.name }), row.dir ? (_jsx("span", { className: "op-in", onClick: (event) => {
                                                                event.stopPropagation();
                                                                enter(row.path);
                                                            }, children: "open \u203A" })) : (_jsx("small", { children: row.size !== null ? `${Math.max(1, Math.round(row.size / 1024))} KB` : '' }))] }, row.path))), place && !place.rows.length ? _jsx("p", { className: "pg-note", children: "Nothing here." }) : null] })] })), problem ? _jsx("p", { className: "pg-note is-problem", children: problem }) : null] })] }), server && probe?.state === 'up' && picked ? (_jsxs("footer", { className: "op-foot", children: [_jsxs("div", { className: "op-picked", children: [_jsx("span", { className: "eyebrow", children: picked.dir ? 'Folder' : notebookFile ? 'Notebook' : 'File' }), _jsx("b", { title: picked.path, children: place?.home && picked.path.startsWith(place.home) ? `~${picked.path.slice(place.home.length)}` : picked.path || '(its folder)' }), !picked.dir ? _jsx("small", { children: notebookFile ? 'opens as a notebook; its folder holds the files' : 'its folder becomes the project, with this file in it' }) : null] }), _jsxs("div", { className: "op-how", role: "radiogroup", "aria-label": "How", children: [_jsxs("label", { className: how === 'here' ? 'is-on' : '', children: [_jsx("input", { type: "radio", checked: how === 'here', onChange: () => setHow('here') }), _jsxs("span", { children: [_jsx("b", { children: "Use it where it is" }), _jsx("small", { children: mode === 'disk' ? `Edits change the folder on ${server.name} itself; it is linked into the Reader folder, nothing copied.` : `The project is that folder on ${server.name}.` })] })] }), _jsxs("label", { className: how === 'drive' ? 'is-on' : '', title: drive ? undefined : 'Sign in with Google, with Drive, first', children: [_jsx("input", { type: "radio", checked: how === 'drive', disabled: !drive, onChange: () => setHow('drive') }), _jsxs("span", { children: [_jsx("b", { children: "Copy it into your Drive" }), _jsx("small", { children: drive ? 'Opens on every computer; the original stays as it is.' : 'Sign in with Google, with Drive, first.' })] })] }), _jsxs("label", { className: how === 'copy' ? 'is-on' : '', children: [_jsx("input", { type: "radio", checked: how === 'copy', onChange: () => setHow('copy') }), _jsxs("span", { children: [_jsxs("b", { children: ["Copy it into a new folder on ", server.name] }), _jsx("small", { children: "To try things without touching the original." })] })] })] }), _jsxs("div", { className: "op-run", children: [_jsxs("label", { children: [_jsx("span", { className: "eyebrow", children: "Name" }), _jsx("input", { value: name, onChange: (event) => setName(event.target.value) })] }), _jsxs("label", { children: [_jsx("span", { className: "eyebrow", children: "Run it on" }), _jsxs("select", { value: runOn, onChange: (event) => setRunOn(event.target.value), children: [_jsxs("option", { value: server.id, children: [server.name, " \u2014 where the code is"] }), upOthers.map((s) => (_jsxs("option", { value: s.id, children: [s.name, " \u2014 the folder copied there before each run"] }, s.id))), colabOk ? _jsx("option", { value: "colab", children: "Colab \u2014 the folder copied to the runtime before each run" }) : null] })] }), _jsx("button", { type: "button", className: "btn primary", disabled: busy || !name.trim(), onClick: () => void open(), children: busy ? 'Opening…' : how === 'here' ? 'Open it' : 'Copy and open' })] })] })) : null] }) }));
}
