import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// A project started from a paper, before anything is written: which model
// writes it — the same cards as the notebook's start and the pages' empty
// states — and the button that has it write every file the implementation
// needs into the folder, through the project's agent (src/lib/projectAgent.ts).
// While it writes, the files appear here as the answer reaches them; once
// they are in, the editor opens on them and the conversation is the agent's.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getState as assistantState, geminiNote, looksLikeKey, modelSpec, MODELS, PROVIDERS, saveKey, setAskModel, subscribe as subscribeAssistant } from '../lib/assistant';
import { agentChatFor, askAgent, dismissAgentError, filesInReply, isAgentRunning, PROJECT_MAX_TOKENS, stopAgent, subscribeAgent, WRITE_PROJECT } from '../lib/projectAgent';
import FileIcon from './FileIcon';
import { SparkleIcon } from './icons';
const elapsed = (since, now) => {
    const s = Math.max(0, Math.round((now - since) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export default function ProjectStart({ projectId, host, machineName, paperTitle, hasPlan, view, onWriting, onWrote, onDone, onDismiss, }) {
    const assistant = useSyncExternalStore(subscribeAssistant, assistantState);
    const chat = useSyncExternalStore(subscribeAgent, () => agentChatFor(projectId));
    const model = assistant.prefs.askModel ?? assistant.prefs.explainModel ?? assistant.prefs.model;
    const chosen = modelSpec(model);
    const provider = PROVIDERS[chosen.provider];
    const hasKey = Boolean(assistant.keys[chosen.provider]);
    const [keyDraft, setKeyDraft] = useState('');
    const pending = chat.pending?.request === WRITE_PROJECT ? chat.pending : undefined;
    const writing = Boolean(pending && !pending.error && isAgentRunning(projectId));
    const busyElsewhere = !writing && isAgentRunning(projectId);
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!writing)
            return;
        const tick = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(tick);
    }, [writing]);
    const write = async () => {
        if (pending?.error)
            dismissAgentError(projectId);
        onWriting();
        await askAgent({ projectId, model: chosen.id, request: WRITE_PROJECT, host, view, onWrote, maxTokens: PROJECT_MAX_TOKENS });
        const after = agentChatFor(projectId);
        const last = after.turns[after.turns.length - 1];
        if (!after.pending && last?.role === 'agent' && last.changes?.length)
            onDone();
    };
    const files = pending ? filesInReply(pending.reply) : [];
    const reads = ['the paper’s abstract', hasPlan ? 'your plan from its Implementation page' : ''].filter(Boolean).join(' and ');
    return (_jsxs("section", { className: "nb-start pg-write", "aria-label": "Write the project", children: [_jsxs("div", { className: "nb-start-head", children: [_jsxs("span", { className: "explain-kicker pill", children: [_jsx(SparkleIcon, { size: 15 }), " ", writing ? 'Writing' : 'Nothing written yet'] }), _jsx("h2", { children: writing ? `${chosen.label} is writing the project` : 'Which model writes this project?' }), _jsxs("p", { children: ["It reads ", reads, " for ", _jsx("b", { children: paperTitle }), " and writes every file the implementation needs, straight into this folder: the method in modules of its own, a config, a seeded experiment sized for ", machineName, " in", ' ', _jsx("code", { children: "main.py" }), ", a ", _jsx("code", { children: "requirements.txt" }), " and the README. Every file is yours to edit, one Undo in the agent\u2019s pane puts them all back, and nothing runs until you click."] })] }), writing && pending ? (_jsxs("div", { className: "pg-write-live", "aria-live": "polite", children: [_jsxs("div", { className: "pg-write-step", children: [_jsx("span", { className: "pg-write-dot", "aria-hidden": "true" }), _jsx("b", { children: pending.step }), _jsx("span", { className: "pg-write-clock", children: elapsed(pending.started, now) }), _jsx("span", { className: "spacer" }), _jsx("button", { type: "button", className: "btn sm ghost", onClick: stopAgent, children: "Stop" })] }), files.length ? (_jsx("ul", { className: "pg-write-files", children: files.map((path, index) => (_jsxs("li", { className: index === files.length - 1 ? 'is-now' : '', children: [_jsx(FileIcon, { path: path }), " ", path, _jsx("small", { children: index === files.length - 1 ? 'writing…' : 'written' })] }, path))) })) : (_jsx("p", { className: "hint", children: pending.thinking ? 'Thinking it through before the first file…' : 'The files appear here as it reaches them; they go into the folder together once the answer is whole.' }))] })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "explain-start", children: [_jsx("div", { className: "model-pick", role: "radiogroup", "aria-label": "Model", children: MODELS.map((m) => (_jsxs("button", { type: "button", role: "radio", "aria-checked": chosen.id === m.id, onClick: () => setAskModel(m.id), children: [_jsx("b", { children: m.label }), _jsxs("span", { children: [m.note, assistant.keys[m.provider] ? '' : PROVIDERS[m.provider].viaProxy ? ` · ${geminiNote(assistant.gemini).short}` : ' · needs a key'] })] }, m.id))) }), hasKey ? (_jsxs("button", { type: "button", className: "btn primary cta", disabled: busyElsewhere, onClick: () => void write(), title: busyElsewhere ? 'The agent is answering another request' : undefined, children: [_jsx(SparkleIcon, { size: 17 }), " ", pending?.error ? 'Try again' : 'Write the project', " with ", chosen.label] })) : null] }), pending?.error ? _jsx("p", { className: "pg-note is-problem", children: pending.error }) : null, hasKey ? (_jsxs("p", { className: "hint", children: [_jsx("b", { children: "Written once" }), ", into the folder; afterwards the agent on the right changes it a request at a time, with any model."] })) : provider.viaProxy ? (_jsx("p", { className: "hint", children: geminiNote(assistant.gemini).long })) : (_jsxs(_Fragment, { children: [_jsxs("form", { className: "explain-start", onSubmit: (event) => {
                                    event.preventDefault();
                                    const key = keyDraft.trim();
                                    if (!looksLikeKey(key, provider.id) && !confirm(`That does not look like one of ${provider.company}’s API keys (they start with "${provider.keyPrefix}"). Save it anyway?`))
                                        return;
                                    saveKey(key, provider.id);
                                    setKeyDraft('');
                                }, children: [_jsx("input", { type: "password", placeholder: provider.placeholder, value: keyDraft, onChange: (event) => setKeyDraft(event.target.value), "aria-label": `${provider.company} API key` }), _jsxs("button", { type: "submit", className: "btn primary cta", disabled: !keyDraft.trim(), children: ["Use this ", provider.company, " key"] })] }), _jsxs("p", { className: "hint", children: [_jsxs("b", { children: ["The same ", provider.company, " key as the rest of the reader."] }), " Get one at", ' ', _jsx("a", { href: provider.consoleUrl, target: "_blank", rel: "noopener noreferrer", children: provider.consoleUrl.replace(/^https:\/\//, '') }), ". It stays in this browser and goes only to ", provider.host, "."] })] })), _jsxs("p", { className: "hint nb-start-other", children: ["Or start another way:", ' ', _jsx("button", { type: "button", className: "link", onClick: onDismiss, children: "write the files yourself" }), ", or ask Claude Code or Codex in the agent\u2019s pane \u2014 they read ", _jsx("code", { children: "AGENTS.md" }), "."] })] }))] }));
}
