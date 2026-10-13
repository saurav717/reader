import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
// The playground's agent panel, on the right of the editor as a coding agent
// sits in VS Code: a conversation about the project, answered by the model
// picked here (src/lib/projectAgent.ts). Its answers show the files it read,
// the files it wrote — each opens in the editor, and one Undo puts them all
// back — and the commands it suggests, each a button for the console.
import DOMPurify from 'dompurify';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getState as assistantState, modelSpec, PROVIDERS, setAskModel, subscribe as subscribeAssistant } from '../lib/assistant';
import { markdown } from '../lib/markdown';
import { AGENT_FILE, agentChatFor, askAgent, canUndo, clearAgentChat, dismissAgentError, isAgentRunning, loadAgentChats, openAgentChat, stopAgent, subscribeAgent, undoAgentTurn } from '../lib/projectAgent';
import { followProjectAgent } from '../lib/jobWatch';
import FileIcon from './FileIcon';
import ModelChip, { shortModelName } from './ModelChip';
import { SparkleIcon } from './icons';
const SUGGESTIONS = [
    'Explain what this project does, file by file',
    'Write a small training script for the model in the open file, with a seed and a loss printout',
    'Add a requirements.txt for what the code imports',
    'Fix the error the last command printed',
    'Make it run on the GPU when there is one, and on the CPU otherwise',
];
/** The first suggestion when the project cites a paper. */
const PAPER_SUGGESTION = 'Implement the paper’s method: a small faithful version, a seeded training run sized for this machine, and an evaluation';
export default function ProjectAgent({ projectId, host, machineName, view, context, onOpen, onRun, onWrote, }) {
    const assistant = useSyncExternalStore(subscribeAssistant, assistantState);
    const chat = useSyncExternalStore(subscribeAgent, () => agentChatFor(projectId));
    const running = isAgentRunning(projectId);
    const model = assistant.prefs.askModel ?? assistant.prefs.explainModel ?? assistant.prefs.model;
    const ready = Boolean(assistant.keys[modelSpec(model).provider]);
    const writer = PROVIDERS[modelSpec(model).provider].name;
    const [text, setText] = useState('');
    const log = useRef(null);
    const [showHistory, setShowHistory] = useState(false);
    // The conversations are in the project's folder: read when the panel opens, and again whenever the folder can be reached.
    // Its requests show as the playground's runs from any page, this pane open or not.
    useEffect(() => followProjectAgent(projectId), [projectId]);
    useEffect(() => {
        void loadAgentChats(projectId, host);
    }, [projectId, host]);
    useEffect(() => {
        log.current?.scrollTo({ top: log.current.scrollHeight });
    }, [chat.turns.length, chat.pending?.reply.length, chat.pending?.step]);
    const send = (request) => {
        if (!request.trim() || running || !ready)
            return;
        setText('');
        void askAgent({ projectId, model, request, host, view, onWrote });
    };
    return (_jsxs("div", { className: "vs-agent-chat", children: [chat.history.length || chat.problem ? (_jsxs("div", { className: "vs-agent-bar", children: [chat.history.length ? (_jsxs("div", { className: "menu-wrap", children: [_jsxs("button", { type: "button", className: `link${showHistory ? ' is-on' : ''}`, "aria-expanded": showHistory, onClick: () => setShowHistory(!showHistory), title: `Earlier conversations, kept in the project's folder (${AGENT_FILE})`, children: ["History \u00B7 ", chat.history.length] }), showHistory ? (_jsx("div", { className: "menu vs-history", role: "menu", children: chat.history.map((saved) => (_jsxs("button", { type: "button", role: "menuitem", disabled: running, onClick: () => {
                                        openAgentChat(projectId, saved.id);
                                        setShowHistory(false);
                                    }, children: [_jsx("span", { children: saved.title }), _jsxs("small", { children: [new Date(saved.updated).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), " \u00B7 ", saved.turns.filter((t) => t.role === 'user').length, " asked"] })] }, saved.id))) })) : null] })) : null, chat.problem ? _jsx("span", { className: "pg-note is-problem", title: chat.problem, children: chat.problem }) : null] })) : null, _jsxs("div", { className: "vs-agent-log", ref: log, children: [!chat.turns.length && !chat.pending ? (_jsxs("div", { className: "vs-agent-hello", children: [_jsx("span", { className: "vs-agent-badge", children: _jsx(SparkleIcon, { size: 18 }) }), _jsx("b", { children: "An agent for this project" }), _jsxs("p", { children: ["It reads the files, the one in front of you and what the console printed; it writes files straight into the folder \u2014 one Undo puts them back \u2014 and suggests commands to run on ", machineName, ". Nothing runs by itself."] }), _jsx("div", { className: "vs-agent-sugs", children: (context.paper ? [PAPER_SUGGESTION, ...SUGGESTIONS.slice(1)] : SUGGESTIONS).map((suggestion) => (_jsx("button", { type: "button", className: "ask-suggestion", disabled: !ready, onClick: () => send(suggestion), children: suggestion }, suggestion))) })] })) : null, chat.turns.map((turn) => turn.role === 'user' ? (_jsx("div", { className: "vs-turn is-user", children: _jsx("p", { children: turn.text }) }, turn.at)) : (_jsxs("div", { className: "vs-turn is-agent", children: [_jsxs("div", { className: "vs-turn-who", children: [_jsx(SparkleIcon, { size: 13 }), " ", turn.model ? shortModelName(modelSpec(turn.model).label) : 'Agent'] }), turn.read?.length ? _jsxs("div", { className: "vs-turn-read", children: ["Read ", turn.read.join(', ')] }) : null, turn.text ? _jsx("div", { className: "vs-turn-text", dangerouslySetInnerHTML: { __html: DOMPurify.sanitize(markdown(turn.text)) } }) : null, turn.changes?.length ? (_jsxs("div", { className: `vs-changes${turn.undone ? ' is-undone' : ''}`, children: [_jsxs("div", { className: "vs-changes-head", children: [_jsxs("span", { children: [turn.undone ? 'Undone · ' : '', turn.changes.length, " ", turn.changes.length === 1 ? 'file' : 'files', " changed"] }), !turn.undone && canUndo(turn) ? (_jsx("button", { type: "button", className: "link", onClick: () => void undoAgentTurn(projectId, turn.at, host, onWrote), disabled: running, title: "Put these files back as they were", children: "Undo" })) : null] }), turn.changes.map((change) => (_jsxs("button", { type: "button", className: "vs-change", onClick: () => onOpen(change.path), title: `Open ${change.path}`, children: [_jsx(FileIcon, { path: change.path }), _jsx("span", { className: "vs-change-path", children: change.path }), change.before === null ? _jsx("span", { className: "vs-change-new", children: "new" }) : null, _jsxs("span", { className: "vs-plus", children: ["+", change.added] }), _jsxs("span", { className: "vs-minus", children: ["\u2212", change.removed] })] }, change.path)))] })) : null, turn.commands?.map((command) => (_jsxs("div", { className: "vs-cmd", children: [_jsxs("code", { children: [_jsx("span", { className: "pg-prompt", children: "$" }), " ", command] }), _jsx("button", { type: "button", className: "btn sm", onClick: () => onRun(command), title: `Run it on ${machineName}, in the project's folder`, children: "\u25B6 Run" })] }, command))), turn.cut ? _jsx("p", { className: "pg-note", children: "The answer was cut short: ask for the rest." }) : null] }, turn.at))), chat.pending ? (_jsxs("div", { className: `vs-turn is-agent is-live${chat.pending.error ? ' is-error' : ''}`, children: [_jsxs("div", { className: "vs-turn-who", children: [_jsx(SparkleIcon, { size: 13 }), " ", shortModelName(modelSpec(model).label)] }), chat.pending.error ? (_jsxs(_Fragment, { children: [_jsx("p", { className: "pg-note is-problem", children: chat.pending.error }), _jsx("button", { type: "button", className: "btn sm ghost", onClick: () => dismissAgentError(projectId), children: "Dismiss" })] })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "vs-turn-step", children: [_jsx("span", { className: "spinner" }), " ", chat.pending.step, chat.pending.read.length ? _jsxs("small", { children: [" \u00B7 read ", chat.pending.read.length] }) : null] }), chat.pending.reply ? _jsx("pre", { className: "vs-turn-stream", children: chat.pending.reply.slice(-1400) }) : chat.pending.thinking ? _jsx("p", { className: "vs-turn-think", children: chat.pending.thinking.slice(-280) }) : null] }))] })) : null] }), _jsxs("form", { className: "vs-agent-box", onSubmit: (event) => {
                    event.preventDefault();
                    send(text);
                }, children: [_jsxs("div", { className: "vs-agent-ctx", "aria-label": "What goes with the request", children: [context.active ? (_jsxs("span", { className: "vs-chip", title: "The file in front of you", children: [_jsx(FileIcon, { path: context.active }), " ", context.active.split('/').pop()] })) : null, context.open > (context.active ? 1 : 0) ? _jsxs("span", { className: "vs-chip", children: ["+", context.open - (context.active ? 1 : 0), " open"] }) : null, _jsx("span", { className: "vs-chip", children: "folder" }), context.commands ? _jsxs("span", { className: "vs-chip", children: ["console \u00B7 ", context.commands] }) : null, context.paper ? _jsx("span", { className: "vs-chip", title: context.paper, children: "\u00B6 the paper" }) : null, _jsx("span", { className: "spacer" }), chat.turns.length && !running ? (_jsx("button", { type: "button", className: "link", onClick: () => clearAgentChat(projectId, host), title: "Start a new conversation (the files stay as they are)", children: "New chat" })) : null] }), _jsx("textarea", { value: text, rows: 3, onChange: (event) => setText(event.target.value), onKeyDown: (event) => {
                            event.stopPropagation();
                            if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault();
                                send(text);
                            }
                        }, placeholder: ready ? `Ask ${writer} to write, change or fix the code — ⏎ to send` : `${writer} needs its key in Settings → AI, or pick another model`, "aria-label": "Ask the agent" }), _jsxs("div", { className: "vs-agent-row", children: [_jsx(ModelChip, { value: model, keys: assistant.keys, disabled: running, what: "The agent answers with", up: true, align: "left", view: "list", onChange: (id) => setAskModel(id) }), _jsx("span", { className: "spacer" }), running ? (_jsx("button", { type: "button", className: "btn sm", onClick: stopAgent, children: "\u25A0 Stop" })) : (_jsx("button", { type: "submit", className: "btn sm primary", disabled: !ready || !text.trim(), children: "Send" }))] })] })] }));
}
