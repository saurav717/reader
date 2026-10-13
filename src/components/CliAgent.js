import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Claude Code or Codex in the agent pane, on the machine the project runs on
// (src/lib/cliAgent.ts): installed there with a click, signed in to your own
// account there, then a conversation — its words, the files it edited, the
// commands it ran and what they printed, how long it took and what it cost.
// Each request carries the session on, so it remembers the conversation; the
// conversation is kept in the project's folder (.reader/cli-agent.json),
// beside the code, so it opens again in any browser.
import DOMPurify from 'dompurify';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { keyFor } from '../lib/assistant';
import { reportCliAgent } from '../lib/jobWatch';
import { CLI_AGENTS, cliStatus, installArgv, loginArgv, loginPrompt, logoutArgv, parseRun, readJob, runArgv, startJob, stopJob, writeJob } from '../lib/cliAgent';
import { markdown } from '../lib/markdown';
import { readMeta, writeMeta } from '../lib/playground';
import FileIcon from './FileIcon';
const FILE = 'cli-agent.json';
const LINES_KEPT = 4000;
const TURNS_KEPT = 30;
const store = new Map();
const listeners = new Set();
const loaded = new Set();
const polling = new Set();
const EMPTY = { generator: 'reader', version: 1, chats: {} };
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener) => (listeners.add(listener), () => void listeners.delete(listener));
const savedFor = (projectId) => store.get(projectId) ?? EMPTY;
const setChat = (projectId, agent, chat) => {
    const now = savedFor(projectId);
    store.set(projectId, { ...now, chats: { ...now.chats, [agent]: chat } });
    notify();
    // A request at work shows as the playground's run, from any page; what it last said is its last line.
    const open = chat.turns.find((turn) => !turn.done);
    const said = open ? parseRun(agent, open.lines).events.filter((event) => event.kind === 'text' || event.kind === 'tool').pop() : undefined;
    const tail = said ? (said.kind === 'tool' ? `${said.name} ${said.detail}` : said.text).split('\n')[0].slice(0, 160) : undefined;
    reportCliAgent(projectId, agent, CLI_AGENTS[agent].name, Boolean(open), tail, open ? () => void stopJob(open.job, projectId).catch(() => undefined) : undefined);
};
async function persist(projectId, host) {
    const saved = savedFor(projectId);
    const trimmed = { ...saved, chats: Object.fromEntries(Object.entries(saved.chats).map(([agent, chat]) => [agent, { ...chat, turns: chat.turns.slice(-TURNS_KEPT).map((turn) => ({ ...turn, lines: turn.lines.slice(-LINES_KEPT) })) }])) };
    await writeMeta(host, FILE, `${JSON.stringify(trimmed)}\n`).catch(() => undefined);
}
async function load(projectId, host) {
    if (loaded.has(projectId))
        return;
    try {
        const text = await readMeta(host, FILE);
        const parsed = text ? JSON.parse(text) : null;
        if (parsed?.chats && !store.has(projectId))
            store.set(projectId, { generator: 'reader', version: 1, chats: parsed.chats });
        loaded.add(projectId);
        notify();
    }
    catch {
        // not reachable now: tried again when the pane opens next
    }
}
/** A run's log read until it ends, a second at a time; what it said parsed as it comes. */
async function follow(projectId, agent, job, host, onDone) {
    if (polling.has(job))
        return;
    polling.add(job);
    try {
        for (;;) {
            const chat = savedFor(projectId).chats[agent];
            const turn = chat?.turns.find((t) => t.job === job);
            if (!chat || !turn || turn.done)
                break;
            let read;
            try {
                // On the playground's own machine, whichever page is open now: the run is followed to its end.
                read = await readJob(job, turn.offset, projectId);
            }
            catch {
                await new Promise((r) => setTimeout(r, 3000));
                continue;
            }
            const lines = read.data ? read.data.split('\n').filter((line, i, all) => line || i < all.length - 1) : [];
            const all = [...turn.lines, ...lines];
            const { session } = parseRun(agent, all);
            const now = savedFor(projectId).chats[agent];
            setChat(projectId, agent, { session: session ?? now.session, turns: now.turns.map((t) => (t.job === job ? { ...t, lines: all, offset: read.offset, done: read.done, code: read.code } : t)) });
            if (read.done) {
                await persist(projectId, host);
                onDone();
                break;
            }
            await new Promise((r) => setTimeout(r, lines.length ? 600 : 1200));
        }
    }
    finally {
        polling.delete(job);
    }
}
const readPrefs = (agent) => {
    try {
        return { useKey: false, commands: true, model: '', ...JSON.parse(localStorage.getItem(`reader.cliAgent.${agent}`) || '{}') };
    }
    catch {
        return { useKey: false, commands: true, model: '' };
    }
};
export default function CliAgent({ agent, projectId, host, machineName, folder, connected, onConnect, beforeRun, afterRun, onOpen, }) {
    const spec = CLI_AGENTS[agent];
    const saved = useSyncExternalStore(subscribe, () => savedFor(projectId));
    const chat = saved.chats[agent] ?? { turns: [] };
    const [status, setStatus] = useState(null);
    const [problem, setProblem] = useState(null);
    const [busy, setBusy] = useState(null);
    const [jobLog, setJobLog] = useState('');
    const [login, setLogin] = useState(null);
    const [pasted, setPasted] = useState('');
    const [prefs, setPrefsState] = useState(() => readPrefs(agent));
    const [text, setText] = useState('');
    const log = useRef(null);
    const setPrefs = (patch) => setPrefsState((now) => {
        const next = { ...now, ...patch };
        try {
            localStorage.setItem(`reader.cliAgent.${agent}`, JSON.stringify(next));
        }
        catch {
            // private mode
        }
        return next;
    });
    useEffect(() => setPrefsState(readPrefs(agent)), [agent]);
    const siteKey = agent === 'claude' ? keyFor('anthropic') : '';
    const env = useMemo(() => (agent === 'claude' && prefs.useKey && siteKey ? { ANTHROPIC_API_KEY: siteKey } : {}), [agent, prefs.useKey, siteKey]);
    const refresh = useCallback(async () => {
        if (!connected)
            return;
        setBusy('status');
        setProblem(null);
        try {
            setStatus(await cliStatus(agent, env, projectId));
        }
        catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(null);
        }
    }, [agent, connected, env]);
    useEffect(() => {
        setStatus(null);
        void refresh();
    }, [refresh]);
    useEffect(() => {
        void load(projectId, host);
    }, [projectId, host]);
    // A run that was going when the page was left: followed again from where its log was read.
    useEffect(() => {
        if (!connected)
            return;
        const open = chat.turns.find((turn) => !turn.done);
        if (open)
            void follow(projectId, agent, open.job, host, afterRun);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connected, agent, projectId, chat.turns.length]);
    useEffect(() => {
        log.current?.scrollTo({ top: log.current.scrollHeight });
    }, [chat.turns.length, chat.turns[chat.turns.length - 1]?.lines.length]);
    /** A job that isn't a request — the install, a sign-in — followed until it ends, its output shown. */
    const watch = async (job, onLine) => {
        let offset = 0;
        let all = '';
        for (;;) {
            const read = await readJob(job, offset, projectId);
            offset = read.offset;
            all += read.data;
            setJobLog(all);
            onLine?.(all);
            if (read.done)
                return read.code;
            await new Promise((r) => setTimeout(r, 1000));
        }
    };
    const install = async () => {
        setBusy('install');
        setProblem(null);
        try {
            const job = `install-${agent}`;
            await startJob(job, installArgv(agent), {}, projectId);
            const code = await watch(job);
            if (code)
                setProblem(`The install ended with an error (${code}): its last lines are above.`);
        }
        catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(null);
            void refresh();
        }
    };
    const signIn = async (console = false) => {
        setBusy('login');
        setProblem(null);
        setPasted('');
        const job = `login-${agent}`;
        try {
            await startJob(job, loginArgv(agent, console), { stdin: true }, projectId);
            setLogin({ job });
            const code = await watch(job, (all) => {
                const found = loginPrompt(all);
                if (found.url)
                    setLogin((now) => (now ? { ...now, ...found } : now));
            });
            if (code)
                setProblem(`Signing in didn’t finish (${code}).`);
        }
        catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        }
        finally {
            setLogin(null);
            setBusy(null);
            void refresh();
        }
    };
    const sendCode = async () => {
        if (!login || !pasted.trim())
            return;
        try {
            await writeJob(login.job, `${pasted.trim()}\n`, projectId);
            setPasted('');
        }
        catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        }
    };
    const signOut = async () => {
        setBusy('logout');
        try {
            const job = `logout-${agent}`;
            await startJob(job, logoutArgv(agent), {}, projectId);
            await watch(job);
        }
        finally {
            setBusy(null);
            void refresh();
        }
    };
    const running = chat.turns.some((turn) => !turn.done);
    const send = async (request) => {
        const prompt = request.trim();
        if (!prompt || running || !status?.loggedIn)
            return;
        setText('');
        setProblem(null);
        if (!(await beforeRun()))
            return;
        const job = `run-${agent}-${Date.now().toString(36)}`;
        const turn = { at: Date.now(), request: prompt, job, offset: 0, lines: [], done: false };
        setChat(projectId, agent, { ...chat, turns: [...chat.turns, turn].slice(-TURNS_KEPT) });
        try {
            const context = `You are running inside Reader's Playground, on ${machineName}, in the project's folder (the working directory). The person reads your replies in a panel beside their editor and can't answer questions while you work: do what they ask, then say in a few sentences what you did and how to run it. Long trainings belong in the console, which they start themselves; keep your own runs short.`;
            await startJob(job, runArgv(agent, { prompt, session: chat.session, model: prefs.model || undefined, commands: prefs.commands, context }), { cwd: folder, env }, projectId);
            await persist(projectId, host);
            void follow(projectId, agent, job, host, afterRun);
        }
        catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
            const now = savedFor(projectId).chats[agent];
            setChat(projectId, agent, { ...now, turns: now.turns.filter((t) => t.job !== job) });
        }
    };
    const stop = () => {
        const open = chat.turns.find((turn) => !turn.done);
        if (open)
            void stopJob(open.job, projectId);
    };
    const newSession = () => {
        if (running)
            return;
        setChat(projectId, agent, { turns: [] });
        void persist(projectId, host);
    };
    if (!connected) {
        return (_jsxs("div", { className: "cli-setup", children: [_jsx(AgentHead, { agent: agent }), _jsxs("p", { children: [spec.name, " runs on ", machineName, ", in the project\u2019s folder, signed in to your own ", agent === 'claude' ? 'Anthropic' : 'OpenAI', " account. Connect to the machine first."] }), _jsxs("button", { type: "button", className: "btn sm primary", onClick: onConnect, children: ["Connect to ", machineName] })] }));
    }
    if (!status) {
        return (_jsxs("div", { className: "cli-setup", children: [_jsx(AgentHead, { agent: agent }), problem ? (_jsxs(_Fragment, { children: [_jsx("p", { className: "pg-note is-problem", children: problem }), _jsx("button", { type: "button", className: "btn sm", onClick: () => void refresh(), children: "Try again" })] })) : (_jsxs("p", { className: "pg-note", children: [_jsx("span", { className: "spinner" }), " Looking for ", spec.name, " on ", machineName, "\u2026"] }))] }));
    }
    if (!status.installed) {
        return (_jsxs("div", { className: "cli-setup", children: [_jsx(AgentHead, { agent: agent }), _jsxs("p", { children: [spec.name, " isn\u2019t on ", machineName, " yet. Installing it takes a minute", agent === 'claude' ? ' (Anthropic’s installer, into ~/.local/bin)' : ' (npm install -g @openai/codex)', machineName.startsWith('Colab') ? '; on Colab it goes with the runtime, and installs again on the next one' : '', "."] }), _jsx("button", { type: "button", className: "btn sm primary", disabled: busy === 'install', onClick: () => void install(), children: busy === 'install' ? 'Installing…' : `Install ${spec.name} on ${machineName}` }), jobLog && busy === 'install' ? _jsx("pre", { className: "cli-log", children: jobLog.split('\n').slice(-12).join('\n') }) : null, problem ? _jsx("p", { className: "pg-note is-problem", children: problem }) : null] }));
    }
    if (!status.loggedIn) {
        return (_jsxs("div", { className: "cli-setup", children: [_jsx(AgentHead, { agent: agent, version: status.version }), login ? (_jsx("div", { className: "cli-login", children: login.url ? (_jsxs(_Fragment, { children: [_jsx("p", { children: agent === 'claude' ? '1 · Sign in on Anthropic’s page, and allow Claude Code.' : '1 · Open the page, sign in to your ChatGPT or OpenAI account, and enter this code:' }), login.code ? _jsx("code", { className: "cli-code", children: login.code }) : null, _jsx("a", { className: "btn sm primary", href: login.url, target: "_blank", rel: "noreferrer", children: "Open the sign-in page \u2197" }), agent === 'claude' ? (_jsxs("form", { className: "cli-paste", onSubmit: (event) => {
                                    event.preventDefault();
                                    void sendCode();
                                }, children: [_jsxs("label", { children: [_jsx("span", { children: "2 \u00B7 Paste the code the page shows" }), _jsx("input", { value: pasted, onChange: (event) => setPasted(event.target.value), placeholder: "code#state", spellCheck: false, autoComplete: "off" })] }), _jsx("button", { type: "submit", className: "btn sm", disabled: !pasted.trim(), children: "Sign in" })] })) : (_jsx("p", { className: "pg-note", children: "2 \u00B7 This finishes by itself once the page says you\u2019re signed in." }))] })) : (_jsxs("p", { className: "pg-note", children: [_jsx("span", { className: "spinner" }), " Asking ", spec.maker, " for a sign-in page\u2026"] })) })) : (_jsxs(_Fragment, { children: [_jsxs("p", { children: [spec.name, " ", status.version ? `${status.version.split(' ')[0]} ` : '', "is on ", machineName, ". Sign in with your ", agent === 'claude' ? 'Claude account — Pro, Max, Team — or an Anthropic Console account' : 'ChatGPT account (Plus, Pro, Team) or an OpenAI API key', ": the sign-in stays on that machine", machineName.startsWith('Colab') ? ', for as long as the runtime lives' : '', "."] }), _jsxs("div", { className: "cli-buttons", children: [_jsx("button", { type: "button", className: "btn sm primary", disabled: Boolean(busy), onClick: () => void signIn(false), children: agent === 'claude' ? 'Sign in with Claude' : 'Sign in with ChatGPT' }), agent === 'claude' ? (_jsx("button", { type: "button", className: "btn sm", disabled: Boolean(busy), onClick: () => void signIn(true), title: "Pay per use, with an Anthropic Console account", children: "Anthropic Console account" })) : null] }), agent === 'claude' && siteKey ? (_jsxs("label", { className: "cli-check", children: [_jsx("input", { type: "checkbox", checked: prefs.useKey, onChange: (event) => setPrefs({ useKey: event.target.checked }) }), _jsx("span", { children: "Or use the Anthropic API key in Settings \u2192 AI \u2014 handed to Claude Code for each request, never written on the machine" })] })) : null] })), problem ? _jsx("p", { className: "pg-note is-problem", children: problem }) : null] }));
    }
    return (_jsxs("div", { className: "vs-agent-chat cli-chat", children: [_jsxs("div", { className: "vs-agent-bar cli-bar", children: [_jsxs("span", { className: "cli-who", title: status.method, children: [_jsx("span", { className: "colab-dot is-on" }), " ", spec.name, " \u00B7 ", status.method ?? 'signed in'] }), _jsx("span", { className: "spacer" }), _jsx("button", { type: "button", className: "link", onClick: () => void signOut(), disabled: Boolean(busy) || running, children: "Sign out" })] }), _jsxs("div", { className: "vs-agent-log", ref: log, children: [!chat.turns.length ? (_jsxs("div", { className: "vs-agent-hello", children: [_jsx("span", { className: `cli-badge is-${agent}`, children: agent === 'claude' ? '✳' : '◎' }), _jsxs("b", { children: [spec.name, ", on ", machineName] }), _jsxs("p", { children: ["The real ", spec.name, ", working in the project\u2019s folder there: it reads the code, edits files and ", prefs.commands ? 'runs commands' : 'proposes commands', " itself. Each message carries the same session on."] }), _jsx("div", { className: "vs-agent-sugs", children: ['Build a CNN for CIFAR-10 in PyTorch, train it briefly, and report the accuracy', 'Explain this project and how to run it', 'Find and fix the bug in the last run', 'Add TensorBoard logging under runs/'].map((suggestion) => (_jsx("button", { type: "button", className: "ask-suggestion", onClick: () => void send(suggestion), children: suggestion }, suggestion))) })] })) : null, chat.turns.map((turn) => (_jsx(Turn, { agent: agent, turn: turn, folder: folder, onOpen: onOpen }, turn.job)))] }), _jsxs("form", { className: "vs-agent-box", onSubmit: (event) => {
                    event.preventDefault();
                    void send(text);
                }, children: [_jsxs("div", { className: "vs-agent-ctx", children: [_jsxs("span", { className: "vs-chip", title: folder, children: [machineName, " \u00B7 ", folder] }), chat.session ? _jsx("span", { className: "vs-chip", title: `Session ${chat.session}`, children: "session" }) : null, _jsx("span", { className: "spacer" }), chat.turns.length && !running ? (_jsx("button", { type: "button", className: "link", onClick: newSession, title: "A new session: it forgets this conversation", children: "New session" })) : null] }), _jsx("textarea", { value: text, rows: 3, onChange: (event) => setText(event.target.value), onKeyDown: (event) => {
                            event.stopPropagation();
                            if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault();
                                void send(text);
                            }
                        }, placeholder: running ? `${spec.name} is working…` : `Ask ${spec.name} — ⏎ to send`, "aria-label": `Ask ${spec.name}` }), _jsxs("div", { className: "vs-agent-row", children: [spec.models.length > 1 ? (_jsx("select", { className: "cli-select", value: prefs.model, onChange: (event) => setPrefs({ model: event.target.value }), "aria-label": "Model", children: spec.models.map((model) => (_jsx("option", { value: model.id, children: model.label }, model.id))) })) : null, _jsxs("label", { className: "cli-check is-inline", title: agent === 'claude' ? 'Claude Code edits files either way; with this on it runs shell commands too (--allowedTools Bash)' : 'Off: it edits files in the folder only (workspace-write); on: full access, commands included', children: [_jsx("input", { type: "checkbox", checked: prefs.commands, onChange: (event) => setPrefs({ commands: event.target.checked }) }), _jsx("span", { children: "Run commands" })] }), _jsx("span", { className: "spacer" }), running ? (_jsx("button", { type: "button", className: "btn sm", onClick: stop, children: "\u25A0 Stop" })) : (_jsx("button", { type: "submit", className: "btn sm primary", disabled: !text.trim(), children: "Send" }))] }), problem ? _jsx("p", { className: "pg-note is-problem", children: problem }) : null] })] }));
}
function AgentHead({ agent, version }) {
    return (_jsxs("div", { className: "cli-head", children: [_jsx("span", { className: `cli-badge is-${agent}`, children: agent === 'claude' ? '✳' : '◎' }), _jsx("b", { children: CLI_AGENTS[agent].name }), version ? _jsx("small", { children: version.split(' ')[0] }) : null] }));
}
/** One request and what the run did, as it streams. */
function Turn({ agent, turn, folder, onOpen }) {
    /** A path the agent named, as the project's folder has it: after the folder's own path, when it is there. */
    const relative = (path) => {
        const mark = `${folder.replace(/^\.?\/+|\/+$/g, '')}/`;
        const at = path.indexOf(mark);
        return at >= 0 ? path.slice(at + mark.length) : path.replace(/^\.?\/+/, '');
    };
    const { events } = useMemo(() => parseRun(agent, turn.lines), [agent, turn.lines]);
    const outputs = new Map(events.filter((e) => e.kind === 'output').map((e) => [e.id, e]));
    const done = events.find((e) => e.kind === 'done');
    return (_jsxs(_Fragment, { children: [_jsx("div", { className: "vs-turn is-user", children: _jsx("p", { children: turn.request }) }), _jsxs("div", { className: "vs-turn is-agent cli-turn", children: [_jsxs("div", { className: "vs-turn-who", children: [_jsx("span", { className: `cli-badge is-${agent} is-sm`, children: agent === 'claude' ? '✳' : '◎' }), " ", CLI_AGENTS[agent].name] }), events.map((event, index) => {
                        if (event.kind === 'text')
                            return _jsx("div", { className: "vs-turn-text", dangerouslySetInnerHTML: { __html: DOMPurify.sanitize(markdown(event.text)) } }, index);
                        if (event.kind === 'thinking')
                            return _jsx("p", { className: "vs-turn-think", children: event.text.slice(-300) }, index);
                        if (event.kind === 'note')
                            return _jsx("pre", { className: "cli-note", children: event.text }, index);
                        if (event.kind === 'tool') {
                            const out = outputs.get(event.id);
                            const edit = /^(Edit|Write|MultiEdit|NotebookEdit|Delete)$/.test(event.name);
                            return (_jsxs("details", { className: `cli-tool is-${edit ? 'edit' : event.name === 'Bash' ? 'bash' : 'read'}${out?.error ? ' is-error' : ''}`, children: [_jsxs("summary", { children: [_jsx("span", { className: "cli-tool-name", children: event.name === 'Bash' ? '$' : event.name }), event.path ? (_jsxs("button", { type: "button", className: "cli-path", onClick: (e) => {
                                                    e.preventDefault();
                                                    onOpen(relative(event.path));
                                                }, children: [_jsx(FileIcon, { path: event.path }), " ", event.path.split('/').slice(-2).join('/')] })) : (_jsx("code", { children: event.detail.length > 120 ? `${event.detail.slice(0, 120)}…` : event.detail })), !out && !turn.done ? _jsx("span", { className: "spinner" }) : null] }), out?.text ? _jsx("pre", { children: out.text.length > 4000 ? `${out.text.slice(0, 4000)}\n…` : out.text }) : null] }, index));
                        }
                        return null;
                    }), !turn.done ? (_jsxs("div", { className: "vs-turn-step", children: [_jsx("span", { className: "spinner" }), " ", events.length ? 'Working' : `Starting ${CLI_AGENTS[agent].name}`] })) : done ? (_jsxs("div", { className: `cli-done${done.ok ? '' : ' is-error'}`, children: [done.ok ? 'Done' : done.text || 'It stopped with an error', done.ms ? ` · ${Math.round(done.ms / 1000)} s` : '', done.turns ? ` · ${done.turns} steps` : '', done.cost ? ` · $${done.cost.toFixed(3)}` : ''] })) : (_jsx("div", { className: "cli-done is-error", children: turn.code === null || turn.code === undefined ? 'Stopped.' : `It ended (exit ${turn.code}) without an answer — the lines above say why.` }))] })] }));
}
