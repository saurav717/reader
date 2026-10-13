import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// The accounts a project's work goes out through, connected once on the
// projects board for every project — both optional: GitHub for the code,
// Overleaf for the paper. Reader's server keeps both tokens, sealed for this
// person alone (worker/secrets.js, worker/github.js, worker/latex.js), and
// never sends them back to a page: the browser holds neither. And, in the
// workspace, the project's code to a GitHub repository: set up from the
// button itself when it has none.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { createPrivateRepo, githubAccount, parseRepo, writableRepos } from '../lib/github';
import { NoTokenServer, ON_SERVER, forgetGitHubToken, githubStatus, keepGitHubToken, signInWithGitHub } from '../lib/githubToken';
import { codeRepoName, pushCode } from '../lib/codeGithub';
import { agoShort } from '../lib/writePlace';
import OverleafAccounts, { useOverleafAccounts } from './OverleafAccounts';
import { CheckIcon, ChevronDownIcon, ExternalIcon } from './icons';
// A fine-grained token, limited to the repositories Reader writes, with an expiry: the safest kind GitHub offers.
const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
/**
 * Whose the GitHub connection is and what it may do: asked of Reader's
 * server, which keeps it (ON_SERVER) — also when this browser knows of none,
 * for the ways it offers (and a connection made on another device) — or of
 * GitHub for a token still in this browser. `status` is null while asking.
 */
function useGitHubStatus() {
    const { settings, updateSettings } = useStore();
    const token = settings.githubToken.trim();
    const [state, setState] = useState({ status: null, problem: null, local: false });
    useEffect(() => {
        let live = true;
        setState({ status: null, problem: null, local: Boolean(token) && token !== ON_SERVER });
        if (!token) {
            githubStatus().then((status) => {
                if (!live)
                    return;
                // Connected from another device: this one uses it too.
                if (status.connected)
                    updateSettings({ githubToken: ON_SERVER });
                else
                    setState({ status, problem: null, local: false });
            }, () => live && setState({ status: { connected: false }, problem: null, local: false }));
        }
        else {
            const asked = token === ON_SERVER ? githubStatus() : githubAccount(token).then((account) => ({ connected: true, login: account.login, via: 'token' }));
            asked.then((status) => {
                if (!live)
                    return;
                // Kept by the server for whoever was signed in to Reader in this browser before, not for this account: forgotten here.
                if (token === ON_SERVER && !status.connected)
                    updateSettings({ githubToken: '' });
                else
                    setState({ status, problem: null, local: token !== ON_SERVER });
            }, (error) => live && setState({ status: { connected: false }, problem: error instanceof Error ? error.message : String(error), local: token !== ON_SERVER }));
        }
        return () => {
            live = false;
        };
    }, [token, updateSettings]);
    return state;
}
const dateOf = (at) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const appRepositories = (slug) => (slug ? `https://github.com/apps/${slug}/installations/new` : 'https://github.com/settings/installations');
/** The three ways to connect GitHub, side by side: what each lets Reader do, and which to pick. */
function WhichGitHub() {
    return (_jsxs("details", { className: "cx-which", children: [_jsx("summary", { children: "Which should I pick?" }), _jsxs("table", { className: "cx-compare", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", {}), _jsx("th", { children: "GitHub App" }), _jsx("th", { children: "Sign in with GitHub" }), _jsx("th", { children: "Paste a token" })] }) }), _jsxs("tbody", { children: [_jsxs("tr", { children: [_jsx("th", { children: "Setting up" }), _jsx("td", { children: "Sign in, then tick the repositories Reader may use" }), _jsx("td", { children: "One click, as in VS Code" }), _jsx("td", { children: "Make a token on GitHub, copy it here" })] }), _jsxs("tr", { children: [_jsx("th", { children: "What Reader can reach" }), _jsx("td", { children: "Only the repositories you tick" }), _jsxs("td", { children: ["Every repository of yours, private ones too (GitHub\u2019s ", _jsx("span", { className: "mono", children: "repo" }), " scope)"] }), _jsx("td", { children: "What you give the token: a fine-grained one can be limited to a few repositories" })] }), _jsxs("tr", { children: [_jsx("th", { children: "What it can do there" }), _jsx("td", { children: "Read and write files; make repositories" }), _jsx("td", { children: "Anything you can (Reader itself only makes the few calls it needs)" }), _jsx("td", { children: "The permissions you pick" })] }), _jsxs("tr", { children: [_jsx("th", { children: "How long it lasts" }), _jsx("td", { children: "Eight hours, renewed by Reader\u2019s server for up to six months of use" }), _jsx("td", { children: "Until you disconnect, or six months unused" }), _jsx("td", { children: "Until the expiry you set (or six months unused)" })] })] })] }), _jsx("p", { className: "cx-quiet", children: "Whichever you pick, Reader\u2019s server keeps the token encrypted for you alone, never sends it back to a page, and makes only the GitHub calls Reader needs; Disconnect revokes it with GitHub. You can switch at any time." }), _jsxs("p", { className: "cx-quiet", children: [_jsx("b", { children: "Recommended: the GitHub App." }), " It is as easy as signing in, and if anything went wrong \u2014 this site, its server, your browser \u2014 what could be reached is only the repositories you ticked, with a token that runs out within hours. Sign in with GitHub is the quickest, and fine if you are comfortable with Reader being able to reach all your repositories; a fine-grained token is for when neither sign-in is set up on this server."] })] }));
}
/**
 * GitHub, connected one of three ways, the person's choice: Reader's GitHub
 * App (recommended), Sign in with GitHub, or a pasted token. Reader's server
 * keeps what it gets, sealed, and nothing of it stays in this browser. Where
 * the server can't keep a token, keeping it in this browser is offered, with
 * what that means.
 */
export function GitHubConnect({ compact = false, onAccount }) {
    const { settings, updateSettings } = useStore();
    const { status, problem: refused, local } = useGitHubStatus();
    const [typed, setTyped] = useState('');
    const [busy, setBusy] = useState(null);
    const [problem, setProblem] = useState(null);
    const [noServer, setNoServer] = useState(false);
    const [pasting, setPasting] = useState(false);
    const saved = settings.githubToken.trim();
    const login = status?.connected ? status.login ?? '' : null;
    const methods = status?.methods;
    useEffect(() => {
        if (status)
            onAccount?.(login || null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [login, status]);
    if (status === null)
        return _jsx("p", { className: "cx-quiet", children: "Asking about your GitHub connection\u2026" });
    const signIn = async (via) => {
        setBusy(via);
        setProblem(null);
        try {
            await signInWithGitHub(via);
            updateSettings({ githubToken: ON_SERVER });
        }
        catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(null);
        }
    };
    if (saved && status.connected) {
        const via = local ? 'browser' : status.via ?? 'token';
        const warnings = [
            local ? 'It is kept in this browser, where any script on this site’s address could read it.' : null,
            status.kind === 'classic' ? `It is a classic token${status.scopes ? ` (${status.scopes})` : ''}, which opens every repository of yours: a fine-grained one, or the GitHub App, is safer.` : null,
            via === 'token' && !status.expiresAt ? 'It never expires: one with an expiry date is safer.' : null,
        ].filter((line) => Boolean(line));
        return (_jsxs("div", { className: "cx-form", children: [_jsxs("div", { className: "cx-account", children: [_jsxs("span", { className: "cx-ok", children: [_jsx(CheckIcon, { size: 13 }), " Connected as ", _jsx("b", { children: status.login }), _jsx("span", { className: "cx-via", children: via === 'app' ? 'GitHub App' : via === 'oauth' ? 'Signed in with GitHub' : via === 'browser' ? 'Token in this browser' : 'Token' })] }), _jsx("button", { type: "button", className: "link-btn", onClick: async () => {
                                // Forgotten by the server first: until it is, asking it would find the connection and take it up again.
                                if (saved === ON_SERVER)
                                    await forgetGitHubToken();
                                updateSettings({ githubToken: '' });
                            }, title: via === 'app' || via === 'oauth' ? 'Disconnect, and revoke Reader’s access with GitHub' : 'Forget the token (revoke it on GitHub too, if you are done with it)', children: "Disconnect" })] }), _jsxs("p", { className: "cx-quiet", children: [via === 'app'
                            ? _jsxs(_Fragment, { children: ["Only the repositories you chose for Reader\u2019s GitHub App. ", _jsx("a", { href: appRepositories(methods?.appSlug), target: "_blank", rel: "noopener noreferrer", children: "Choose repositories \u2197" }), " \u00B7 Its token lasts eight hours and is renewed by Reader\u2019s server", status.expiresAt ? ` until ${dateOf(status.expiresAt)}` : '', "."] })
                            : via === 'oauth'
                                ? 'Every repository of yours (GitHub’s repo scope) until you disconnect.'
                                : via === 'browser'
                                    ? 'Kept in this browser.'
                                    : `${status.kind === 'fine-grained' ? 'Fine-grained' : status.kind === 'classic' ? 'Classic' : 'A'} token${status.expiresAt ? `, expires ${dateOf(status.expiresAt)}` : ''}.`, ' ', !local ? 'Kept encrypted by Reader’s server for you alone, never sent back to a page' : '', !local && status.lastUsedAt ? `; last used ${dateOf(status.lastUsedAt)}` : '', !local ? '.' : ''] }), via === 'oauth' && methods?.app ? (_jsxs("p", { className: "cx-tip", children: ["Want Reader to reach only some repositories?", ' ', _jsx("button", { type: "button", className: "link-btn", disabled: Boolean(busy), onClick: () => void signIn('app'), children: "Switch to the GitHub App" })] })) : null, warnings.length ? (_jsxs("p", { className: "cx-warn", children: [warnings.join(' '), ' ', local ? (_jsx("button", { type: "button", className: "link-btn", disabled: Boolean(busy), onClick: async () => {
                                setBusy('token');
                                setProblem(null);
                                try {
                                    await keepGitHubToken(saved);
                                    updateSettings({ githubToken: ON_SERVER });
                                }
                                catch (error) {
                                    setProblem(error instanceof Error ? error.message : String(error));
                                }
                                finally {
                                    setBusy(null);
                                }
                            }, children: "Move it to Reader\u2019s server" })) : null] })) : null, problem ? _jsx("p", { className: "cx-bad", children: problem }) : null] }));
    }
    const paste = async (here = false) => {
        setBusy('token');
        setProblem(null);
        try {
            if (here) {
                await githubAccount(typed.trim());
                updateSettings({ githubToken: typed.trim() });
            }
            else {
                await keepGitHubToken(typed.trim());
                updateSettings({ githubToken: ON_SERVER });
            }
            setTyped('');
            setNoServer(false);
        }
        catch (error) {
            if (error instanceof NoTokenServer)
                setNoServer(true);
            setProblem(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(null);
        }
    };
    const anySignIn = Boolean(methods?.app || methods?.oauth);
    const pasteShown = pasting || !anySignIn;
    return (_jsxs("div", { className: "cx-form", children: [status.forgotten ? _jsx("p", { className: "cx-warn", children: status.forgotten === 'expired' ? 'Your GitHub connection expired and was forgotten: connect again.' : 'Your GitHub connection went unused for six months and was forgotten: connect again when you need it.' }) : null, anySignIn ? (_jsxs("div", { className: `cx-ways${compact ? ' is-compact' : ''}`, children: [methods?.app ? (_jsxs("button", { type: "button", className: "cx-way is-recommended", disabled: Boolean(busy), onClick: () => void signIn('app'), children: [_jsxs("b", { children: [_jsx(GitHubMark, {}), " ", busy === 'app' ? 'Waiting for GitHub…' : 'Use Reader’s GitHub App', " ", _jsx("small", { children: "recommended" })] }), compact ? null : _jsx("span", { children: "Sign in, then pick which repositories Reader may use \u2014 only those. Its token lasts hours and renews itself." })] })) : null, methods?.oauth ? (_jsxs("button", { type: "button", className: "cx-way", disabled: Boolean(busy), onClick: () => void signIn('oauth'), children: [_jsxs("b", { children: [_jsx(GitHubMark, {}), " ", busy === 'oauth' ? 'Waiting for GitHub…' : 'Sign in with GitHub', " ", _jsx("small", { children: "quickest" })] }), compact ? null : _jsx("span", { children: "One click, as in VS Code. Reader can then reach all your repositories, private ones too, until you disconnect." })] })) : null] })) : null, anySignIn && !pasting ? (_jsx("button", { type: "button", className: "link-btn cx-paste-toggle", onClick: () => setPasting(true), children: "Or paste a token instead" })) : null, pasteShown ? (_jsxs(_Fragment, { children: [!compact ? (_jsxs("p", { className: "cx-quiet", children: [anySignIn ? 'A token instead:' : 'Connect with a token:', ' ', _jsx("a", { href: TOKEN_URL, target: "_blank", rel: "noopener noreferrer", children: "a fine-grained one \u2197" }), ' ', "limited to the repositories Reader should write (or \u201CAll repositories\u201D if it is to make new ones), with Contents \u2014 and, to make repositories, Administration \u2014 read and write, and an expiry date."] })) : null, _jsxs("div", { className: "cx-row", children: [_jsx("input", { type: "password", value: typed, autoComplete: "off", placeholder: "github_pat_\u2026", onChange: (event) => setTyped(event.target.value), "aria-label": "GitHub token" }), _jsx("button", { type: "button", className: "btn sm", disabled: Boolean(busy) || !typed.trim(), onClick: () => void paste(), children: busy === 'token' ? 'Checking…' : 'Connect' })] }), compact ? (_jsx("a", { className: "cx-quiet", href: TOKEN_URL, target: "_blank", rel: "noopener noreferrer", children: "Make a fine-grained token on GitHub \u2197" })) : null] })) : null, problem || refused ? _jsx("p", { className: "cx-bad", children: problem ?? refused }) : null, noServer ? (_jsxs("p", { className: "cx-warn", children: ["Reader\u2019s server can\u2019t keep it right now.", ' ', _jsx("button", { type: "button", className: "link-btn", disabled: Boolean(busy) || !typed.trim(), onClick: () => void paste(true), children: "Keep it in this browser instead" }), ' ', "\u2014 less safe: any script on this site\u2019s address could read it."] })) : null, compact ? null : _jsx(WhichGitHub, {})] }));
}
/**
 * A GitHub token still in this browser's settings (from before the server
 * kept them) moved to Reader's server, once it can take it, and removed from
 * here. Tried once a session for each token; nothing is said if it can't.
 */
export function useMoveGitHubToken() {
    const { settings, updateSettings, driveConnected } = useStore();
    const token = settings.githubToken.trim();
    const tried = useRef(new Set());
    useEffect(() => {
        if (!token || token === ON_SERVER || !driveConnected || tried.current.has(token))
            return;
        tried.current.add(token);
        keepGitHubToken(token).then(() => updateSettings({ githubToken: ON_SERVER }), () => undefined);
    }, [token, driveConnected, updateSettings]);
}
/**
 * The board's Connections: GitHub and Overleaf, connected once for every
 * project — both optional. Reader works without either; each is there for
 * when the code or the paper should sync somewhere. Folded to a line of what
 * is connected until it is opened.
 */
export function ProjectConnections() {
    const { settings } = useStore();
    const { status } = useGitHubStatus();
    const login = status?.connected ? status.login : '';
    const overleaf = useOverleafAccounts();
    const github = Boolean(settings.githubToken.trim() && login);
    const [shown, setOpen] = useState(false);
    return (_jsxs("section", { className: `cx-panel${shown ? ' is-open' : ''}`, "aria-label": "Connections", children: [_jsxs("button", { type: "button", className: "cx-head", "aria-expanded": shown, onClick: () => setOpen(!shown), children: [_jsx("span", { className: "eyebrow", children: "Connections" }), _jsxs("span", { className: `cx-chip${github ? ' is-on' : ''}`, children: ["GitHub", github ? ` · ${login}` : ' · not connected'] }), _jsxs("span", { className: `cx-chip${overleaf?.length ? ' is-on' : ''}`, children: ["Overleaf", overleaf?.length ? ` · ${overleaf.map((account) => account.label).join(', ')}` : ' · not connected'] }), _jsx("span", { className: "cx-hint cx-optional", children: "Optional \u2014 only to sync code to GitHub or a paper to Overleaf" }), _jsx("span", { style: { flex: 1 } }), _jsx("span", { className: "cx-hint", children: shown ? 'Hide' : github || overleaf?.length ? 'Manage' : 'Connect…' }), _jsx(ChevronDownIcon, { size: 14, style: { transform: shown ? 'rotate(180deg)' : undefined } })] }), shown ? (_jsxs("div", { className: "cx-grid", children: [_jsxs("div", { className: "cx-card", children: [_jsxs("b", { children: ["GitHub ", _jsx("small", { className: "cx-quiet", children: "\u00B7 optional" })] }), _jsx("p", { className: "cx-lede", children: "For pushing a project\u2019s code to a repository of yours from the workspace\u2019s Sync to GitHub \u2014 made for it in a click, or one you have. Without it, the code stays where it is." }), _jsx(GitHubConnect, {})] }), _jsxs("div", { className: "cx-card", children: [_jsxs("b", { children: ["Overleaf ", _jsx("small", { className: "cx-quiet", children: "\u00B7 optional" })] }), _jsx("p", { className: "cx-lede", children: "For keeping a paper in step with Overleaf: your Overleaf email and its Git token, once, and the Write tab never asks again. Without it, papers are written and kept in Reader only." }), _jsx(OverleafAccounts, {})] })] })) : null] }));
}
/**
 * The workspace's Sync to GitHub: the project's code as one commit to its
 * repository. With no GitHub connected, or no repository yet, the menu sets
 * them up: a private repository made for the code, or one of the account's.
 */
export function CodeGitHub({ project, code }) {
    const { settings, updateCollection, updateSettings } = useStore();
    const token = settings.githubToken.trim();
    const repo = project.project.codeRepo;
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(null);
    const [problem, setProblem] = useState(null);
    const [message, setMessage] = useState('');
    const [name, setName] = useState(() => codeRepoName(project.name));
    const [mine, setMine] = useState(null);
    const [picked, setPicked] = useState('');
    const [changing, setChanging] = useState(false);
    const box = useRef(null);
    useEffect(() => {
        if (!open)
            return;
        const away = (event) => box.current && !box.current.contains(event.target) && setOpen(false);
        document.addEventListener('mousedown', away);
        return () => document.removeEventListener('mousedown', away);
    }, [open]);
    // Whether GitHub is connected — and how (Reader's GitHub App reaches only the repositories it was given) — asked of
    // Reader's server as the menu opens: this browser's setting says only that a connection was kept there, by whoever
    // was signed in to Reader then; the server answers for whoever is signed in now. Undefined while asking.
    const [connection, setConnection] = useState(undefined);
    const [connectionProblem, setConnectionProblem] = useState(null);
    useEffect(() => {
        if (!open || token !== ON_SERVER)
            return;
        setConnection(undefined);
        setConnectionProblem(null);
        githubStatus().then((status) => {
            setConnection(status);
            // None for this Reader account (another one connected it in this browser, or it was forgotten): the setting goes.
            if (!status.connected)
                updateSettings({ githubToken: '' });
        }, (error) => {
            setConnection({ connected: false });
            setConnectionProblem(error instanceof Error ? error.message : String(error));
        });
    }, [open, token, updateSettings]);
    const asking = token === ON_SERVER && connection === undefined;
    const linked = Boolean(token) && (token !== ON_SERVER || connection?.connected === true);
    const choosing = linked && (!repo || changing);
    // The repositories asked afresh each time the menu opens, and when the person comes back to this tab
    // (from giving Reader's GitHub App its repositories on GitHub).
    useEffect(() => {
        if (!open)
            return;
        setMine(null);
        const back = () => setMine(null);
        window.addEventListener('focus', back);
        return () => window.removeEventListener('focus', back);
    }, [open]);
    useEffect(() => {
        if (!open || !choosing || mine)
            return;
        setListProblem(null);
        writableRepos(token).then(setMine, (error) => {
            // Said, not shown as an empty list: an error is not "no repositories".
            setMine([]);
            setListProblem(error instanceof Error ? error.message : String(error));
        });
    }, [open, choosing, mine, token]);
    const [listProblem, setListProblem] = useState(null);
    const disconnect = async () => {
        // Forgotten by the server first: until it is, asking it would find the connection and take it up again.
        if (token === ON_SERVER)
            await forgetGitHubToken();
        updateSettings({ githubToken: '' });
        setConnection(null);
        setMine(null);
        setChanging(false);
    };
    const viaApp = connection?.via === 'app';
    const chooseRepos = `https://github.com/apps/${connection?.methods?.appSlug ?? ''}/installations/new`;
    const setRepo = (next) => updateCollection(project.id, (collection) => {
        const info = { ...project.project, ...(collection.project ?? {}) };
        return { project: { ...info, codeRepo: { ...next } } };
    });
    const run = async (label, work) => {
        setBusy(label);
        setProblem(null);
        try {
            await work();
        }
        catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(null);
        }
    };
    const create = () => run('Making the repository…', async () => {
        const made = await createPrivateRepo(token, name.trim(), `The code for ${project.name}, from Reader.`).catch((error) => {
            // A GitHub App only reaches the repositories it was given: one made outside it has to be given to it first.
            const said = error instanceof Error ? error.message : String(error);
            throw new Error(/refused|not found|403|404/i.test(said) ? `${said} With Reader’s GitHub App, make the repository on GitHub, add it to the app (Projects → Connections → Choose repositories), then pick it below.` : said);
        });
        await setRepo({ repo: made.fullName, branch: made.defaultBranch || 'main' });
        setChanging(false);
    });
    const use = () => run('Linking…', async () => {
        const chosen = mine?.find((one) => one.fullName === picked);
        if (!chosen)
            throw new Error('Pick a repository first.');
        await setRepo({ repo: chosen.fullName, branch: chosen.defaultBranch || 'main' });
        setChanging(false);
    });
    const push = () => run('Pushing…', async () => {
        if (!repo || !code)
            return;
        const parsed = parseRepo(repo.repo);
        if (!parsed)
            throw new Error('The repository’s name isn’t owner/name.');
        const done = await pushCode(code, { ...parsed, branch: repo.branch, token }, message.trim() || `Code from Reader: ${project.name}`, (at, of) => setBusy(`Reading the files… ${at} of ${of}`));
        setMessage('');
        await updateCollection(project.id, (collection) => {
            const info = { ...project.project, ...(collection.project ?? {}) };
            return { project: { ...info, codeRepo: { ...repo, pushedAt: new Date().toISOString(), commit: done.commit ?? repo.commit, files: done.files } } };
        });
    });
    const label = !repo ? 'Sync to GitHub' : repo.repo.split('/').pop();
    return (_jsxs("div", { className: "cx-gh", ref: box, children: [_jsxs("button", { type: "button", className: `btn sm cx-gh-btn${repo ? ' is-linked' : ''}`, "aria-expanded": open, "aria-haspopup": "dialog", onClick: () => setOpen(!open), title: repo ? `The code goes to ${repo.repo} (${repo.branch})` : 'Push the project’s code to a GitHub repository', children: [_jsx(GitHubMark, {}), " ", label, repo?.pushedAt ? _jsxs("small", { children: [" \u00B7 ", agoShort(Date.parse(repo.pushedAt))] }) : null, _jsx(ChevronDownIcon, { size: 12 })] }), open ? (_jsxs("div", { className: "cx-pop", role: "dialog", "aria-label": "The code on GitHub", children: [asking ? (_jsx("p", { className: "cx-quiet", children: "Checking your GitHub connection\u2026" })) : !linked ? (_jsxs(_Fragment, { children: [_jsx("b", { children: "Connect GitHub first" }), _jsx("p", { className: "cx-quiet", children: connectionProblem && /sign in/i.test(connectionProblem)
                                    ? 'Sign in to Reader (with Google) first: your GitHub connection is kept with your Reader account.'
                                    : 'Once, for every project: then pick or make the repository for this one. Optional — the code stays where it is without it.' }), connectionProblem && !/sign in/i.test(connectionProblem) ? _jsx("p", { className: "cx-bad", children: connectionProblem }) : null, connectionProblem && /sign in/i.test(connectionProblem) ? null : _jsx(GitHubConnect, { compact: true })] })) : choosing ? (_jsxs(_Fragment, { children: [_jsx("b", { children: repo ? 'Another repository for the code' : 'Where should the code go?' }), _jsxs("div", { className: "cx-way", children: [_jsx("span", { className: "cx-way-title", children: "Make a private repository" }), _jsxs("div", { className: "cx-row", children: [_jsx("input", { value: name, onChange: (event) => setName(event.target.value), "aria-label": "New repository\u2019s name" }), _jsx("button", { type: "button", className: "btn primary sm", disabled: Boolean(busy) || !name.trim(), onClick: () => void create(), children: "Create" })] })] }), _jsxs("div", { className: "cx-way", children: [_jsx("span", { className: "cx-way-title", children: "Or use one of yours" }), _jsxs("div", { className: "cx-row", children: [_jsxs("select", { value: picked, onChange: (event) => setPicked(event.target.value), "aria-label": "One of your repositories", disabled: !mine?.length, children: [_jsx("option", { value: "", children: mine === null ? 'Asking GitHub…' : mine.length ? 'Pick a repository' : viaApp ? 'None given to Reader’s GitHub App yet' : 'None the token can write to' }), mine?.map((one) => (_jsxs("option", { value: one.fullName, children: [one.fullName, one.private ? ' (private)' : ''] }, one.fullName)))] }), _jsx("button", { type: "button", className: "btn sm", disabled: Boolean(busy) || !picked, onClick: () => void use(), children: "Use" })] }), listProblem ? (_jsxs("p", { className: "cx-bad", children: ["GitHub didn\u2019t list your repositories: ", listProblem, ' ', _jsx("button", { type: "button", className: "link-btn", onClick: () => setMine(null), children: "Try again" })] })) : mine && !mine.length ? (_jsxs("p", { className: "cx-quiet", children: [viaApp ? (_jsxs(_Fragment, { children: ["Reader\u2019s GitHub App reaches only the repositories you give it, and has none yet: install it on your account and pick them (or All repositories, so Create can use the ones it makes).", ' ', _jsx("a", { href: connection?.methods?.appSlug ? chooseRepos : 'https://github.com/settings/installations', target: "_blank", rel: "noopener noreferrer", children: "Choose repositories \u2197" })] })) : ('Your GitHub connection can’t write to any repository: give the token access to one (or connect another way under Projects → Connections).'), ' ', _jsx("button", { type: "button", className: "link-btn", onClick: () => setMine(null), children: "Look again" })] })) : viaApp ? (_jsxs("p", { className: "cx-quiet", children: ["Only the repositories given to Reader\u2019s GitHub App are listed.", ' ', _jsx("a", { href: connection?.methods?.appSlug ? chooseRepos : 'https://github.com/settings/installations', target: "_blank", rel: "noopener noreferrer", children: "Choose repositories \u2197" })] })) : null] }), repo ? (_jsxs("button", { type: "button", className: "link-btn", onClick: () => setChanging(false), children: ["Keep ", repo.repo] })) : null] })) : repo ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "cx-pop-head", children: [_jsx("b", { className: "mono", children: repo.repo }), _jsx("span", { className: "cx-quiet", children: repo.branch }), _jsx("span", { style: { flex: 1 } }), _jsxs("a", { className: "link-btn", href: `https://github.com/${repo.repo}`, target: "_blank", rel: "noopener noreferrer", children: [_jsx(ExternalIcon, { size: 12 }), " GitHub"] })] }), _jsxs("p", { className: "cx-quiet", children: [repo.pushedAt ? `Last pushed ${agoShort(Date.parse(repo.pushedAt))}: ${repo.files ?? 0} files${repo.commit ? `, ${repo.commit.slice(0, 7)}` : ''}.` : 'Nothing pushed yet.', " Every text file of the code goes as one commit; the sync rules leave out data and checkpoints, and nothing is deleted on GitHub."] }), code ? (_jsxs(_Fragment, { children: [_jsx("input", { value: message, placeholder: `Code from Reader: ${project.name}`, onChange: (event) => setMessage(event.target.value), "aria-label": "Commit message" }), _jsxs("div", { className: "cx-row", children: [_jsx("button", { type: "button", className: "btn primary sm", disabled: Boolean(busy), onClick: () => void push(), children: "Push to GitHub" }), _jsx("button", { type: "button", className: "link-btn", onClick: () => setChanging(true), children: "Change repository" })] })] })) : (_jsx("p", { className: "cx-quiet", children: "Set up the project\u2019s code first: then it can go here." }))] })) : null, busy ? _jsx("p", { className: "cx-quiet", children: busy }) : null, linked ? (_jsxs("div", { className: "cx-pop-foot", children: [_jsxs("span", { className: "cx-quiet", children: ["GitHub: ", _jsx("b", { children: token === ON_SERVER ? connection?.login ?? '…' : 'a token in this browser' }), connection?.via === 'app' ? ' · Reader’s GitHub App' : connection?.via === 'oauth' ? ' · Signed in with GitHub' : ''] }), _jsx("button", { type: "button", className: "link-btn", onClick: () => {
                                    if (!window.confirm('Disconnect GitHub from Reader? Reader’s access is revoked with GitHub and its token forgotten, for every project. (To sign in as another GitHub account next time, sign out of github.com first.)'))
                                        return;
                                    void disconnect();
                                }, title: "Sign out of GitHub in Reader: its access revoked, the token forgotten", children: "Disconnect" })] })) : null, problem ? _jsx("p", { className: "cx-bad", children: problem }) : null] })) : null] }));
}
function GitHubMark() {
    return (_jsx("svg", { width: "13", height: "13", viewBox: "0 0 16 16", "aria-hidden": "true", fill: "currentColor", children: _jsx("path", { d: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" }) }));
}
