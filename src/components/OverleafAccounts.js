import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
// The Overleaf accounts connected to Reader's server: each one's Git token,
// given once, kept encrypted by the Worker for every project and device of
// this Reader account (worker/latex.js). A token opens the projects of its own
// Overleaf account and those shared with it, so a project in another Overleaf
// account needs that account connected too: each project syncs with whichever
// connected account opens it, and remembers it (OverleafLink.gitAccount).
import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { projectsOf } from '../lib/projects';
import { WriteGuideLink } from './WriteGuide';
import { overleafGitUrl } from '../lib/overleaf';
import { connectOverleaf, forgetOverleafToken, onOverleafAccounts, overleafAccounts } from '../lib/overleafCloud';
/** Settings, at its Overleaf accounts (the app listens for this event: Projects.tsx's OPEN_SETTINGS). */
export function openOverleafAccounts() {
    window.dispatchEvent(new Event('reader:open-settings'));
    window.setTimeout(() => document.getElementById('settings-overleaf-accounts')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 150);
}
/** Which Overleaf account a project syncs through, as its overview says it, with the way to the accounts. */
export function SyncedThrough({ gitAccount }) {
    const { driveConnected } = useStore();
    const accounts = useOverleafAccounts();
    if (!driveConnected || accounts === null)
        return null;
    const account = accounts.find((item) => item.id === gitAccount);
    return (_jsxs("p", { className: "ol-note ol-through", children: [account ? (_jsxs(_Fragment, { children: ["Synced through your Overleaf account ", _jsx("b", { children: account.label }), ".", ' '] })) : accounts.length ? (_jsxs(_Fragment, { children: ["Syncs through whichever of your ", accounts.length === 1 ? 'connected Overleaf account' : `${accounts.length} connected Overleaf accounts`, " can open it. "] })) : (_jsx(_Fragment, { children: "No Overleaf account connected yet: connect it once, and every project syncs with it. " })), _jsx("button", { type: "button", className: "link-btn", onClick: openOverleafAccounts, children: accounts.length ? 'Overleaf accounts' : 'Connect Overleaf' })] }));
}
/** The accounts connected, kept current on the page: null while asked. */
export function useOverleafAccounts() {
    const [accounts, setAccounts] = useState(null);
    useEffect(() => {
        const stop = onOverleafAccounts(setAccounts);
        // Answered whatever the server says: an answer that isn't the list (signed out, a server without accounts) is none.
        overleafAccounts().then(setAccounts, () => setAccounts([]));
        return stop;
    }, []);
    return accounts;
}
/**
 * The accounts, each removable, and the way to connect one: open at once when
 * there is none (or `open`), else behind "Connect another Overleaf account".
 * `onConnected` hears the new account's id, for whatever was waiting on it.
 */
export default function OverleafAccounts({ open = false, why, onConnected, current, onChoose, projectUrl }) {
    const { collections, driveConnected } = useStore();
    const accounts = useOverleafAccounts();
    const [adding, setAdding] = useState(open);
    // The account whose email and token are being changed: the new token replaces it once it is connected.
    const [changing, setChanging] = useState(null);
    const [token, setToken] = useState('');
    const [label, setLabel] = useState('');
    const [check, setCheck] = useState(projectUrl ?? '');
    // Known only once the project is read: filled in then, unless something was typed.
    useEffect(() => {
        if (projectUrl)
            setCheck((now) => now || projectUrl);
    }, [projectUrl]);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState(null);
    if (!driveConnected)
        return _jsx("p", { className: "wr-quiet", children: "Sign in with Google first: your Overleaf accounts are kept with your Reader account, for every device." });
    if (accounts === null)
        return _jsx("p", { className: "wr-quiet", children: "Asking Reader\u2019s server about your Overleaf accounts\u2026" });
    const used = (id) => projectsOf(collections).filter((project) => project.project.overleaf?.gitAccount === id);
    const connect = async () => {
        // Optional: with a project, the token is tried on it now; without, at its first sync.
        const project = check.trim() ? overleafGitUrl(check.trim()) : undefined;
        if (project === null)
            return setProblem('That isn’t an Overleaf project’s link (https://www.overleaf.com/project/…). Leave it empty to connect without checking.');
        setBusy(true);
        setProblem(null);
        try {
            const id = await connectOverleaf(token.trim(), label.trim(), project);
            if (changing && changing.id !== id)
                await forgetOverleafToken(changing.id);
            setChanging(null);
            setToken('');
            setLabel('');
            setCheck('');
            setAdding(false);
            onConnected?.(id);
        }
        catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(false);
        }
    };
    const showForm = Boolean(changing) || adding || open || !accounts.length;
    return (_jsxs("div", { className: "ol-accounts", children: [accounts.length ? (_jsx("ul", { className: "ol-account-list", "aria-label": "Connected Overleaf accounts", children: accounts.map((account) => {
                    const projects = used(account.id);
                    return (_jsxs("li", { className: `ol-account${account.id === current ? ' is-current' : ''}`, children: [_jsx("span", { className: "ol-account-mark", "aria-hidden": "true", children: account.label.trim().charAt(0).toUpperCase() || 'O' }), _jsxs("span", { className: "ol-account-text", children: [_jsx("b", { children: account.label }), _jsxs("small", { children: [account.id === current ? 'This project syncs with it · ' : '', projects.length ? `${projects.length} project${projects.length === 1 ? '' : 's'}: ${projects.map((project) => project.name).slice(0, 3).join(', ')}${projects.length > 3 ? '…' : ''}` : 'No project synced with it yet'] })] }), onChoose && account.id !== current ? (_jsx("button", { type: "button", className: "link-btn", onClick: () => onChoose(account.id), title: "For a project shared with this account too: its syncs go through this account (and show as it in Overleaf\u2019s history)", children: "Sync with this one" })) : null, _jsx("button", { type: "button", className: "link-btn", title: "A new email or Git token for this account: every project that syncs with it goes on syncing with the new one", onClick: () => {
                                    setChanging(account);
                                    setLabel(account.label);
                                    setToken('');
                                    setCheck('');
                                    setProblem(null);
                                }, children: "Change" }), _jsx("button", { type: "button", className: "link-btn", onClick: () => {
                                    if (!window.confirm(`Disconnect “${account.label}” from Reader? Its projects stop syncing until it is connected again. (To make its token useless everywhere, delete it in Overleaf too: Account Settings → Git integration.)`))
                                        return;
                                    void forgetOverleafToken(account.id);
                                }, children: "Disconnect" })] }, account.id));
                }) })) : null, why ? _jsx("p", { className: "wr-bad", children: why }) : null, showForm ? (_jsxs("div", { className: "ol-connect", children: [_jsx("b", { children: changing ? `Change ${changing.label}` : accounts.length ? 'Connect another Overleaf account' : 'Connect your Overleaf account' }), _jsx("p", { className: "wr-quiet", children: "Once, for every project and every device: in Overleaf, Account Settings \u2192 Git integration \u2192 Generate token, and paste it here. A token opens that account\u2019s projects and the ones shared with it \u2014 for a project in another Overleaf account, connect that one too." }), _jsxs("label", { className: "wr-field", children: [_jsx("span", { children: "Your Overleaf email" }), _jsx("input", { value: label, placeholder: "you@university.edu", onChange: (event) => setLabel(event.target.value), "aria-label": "Which Overleaf account" })] }), _jsxs("label", { className: "wr-field", children: [_jsx("span", { children: "Its Overleaf Git token" }), _jsx("input", { type: "password", value: token, autoComplete: "off", placeholder: "olp_\u2026", onChange: (event) => setToken(event.target.value), "aria-label": "Overleaf Git token" }), _jsx("small", { children: "The token and your email are kept encrypted by Reader\u2019s server, for you alone and your syncs only \u2014 never sent back to any page, in a paper, in Drive or in this browser \u2014 and forgotten after six months unused. Overleaf\u2019s Git integration needs a paid Overleaf plan." })] }), _jsxs("label", { className: "wr-field", children: [_jsx("span", { children: "Optional: one of this account\u2019s Overleaf projects, to check the token on" }), _jsx("input", { value: check, placeholder: "https://www.overleaf.com/project/\u2026", onChange: (event) => setCheck(event.target.value), "aria-label": "An Overleaf project of this account" }), _jsx("small", { children: "Overleaf doesn\u2019t say which account a token belongs to, so Reader opens this project with it: a token from another account can\u2019t, and isn\u2019t kept. Pick one this account owns \u2014 a project only shared with it would pass too. Left empty, the token is checked the first time a project syncs with it." })] }), _jsxs("div", { className: "wr-row", children: [_jsx("button", { type: "button", className: "btn primary", disabled: busy || !token.trim(), onClick: () => void connect(), children: busy ? (check.trim() ? 'Checking the token…' : 'Connecting…') : changing ? 'Save' : 'Connect Overleaf' }), _jsx("a", { className: "link-btn", href: "https://www.overleaf.com/user/settings", target: "_blank", rel: "noopener noreferrer", children: "Overleaf\u2019s account settings \u2197" }), _jsx(WriteGuideLink, { section: "accounts", children: "What is this?" }), changing || (accounts.length && !open) ? (_jsx("button", { type: "button", className: "link-btn", onClick: () => (setChanging(null), setAdding(false), setLabel(''), setToken('')), children: "Cancel" })) : null] }), problem ? _jsx("p", { className: "wr-bad", children: problem }) : null] })) : (_jsx("button", { type: "button", className: "link-btn", onClick: () => setAdding(true), children: "+ Connect another Overleaf account" }))] }));
}
