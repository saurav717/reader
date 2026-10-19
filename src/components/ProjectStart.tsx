// A project started from a paper, before anything is written: which model
// writes it — the same cards as the notebook's start and the pages' empty
// states — and the button that has it write every file the implementation
// needs into the folder, through the project's agent (src/lib/projectAgent.ts).
// While it writes, the files appear here as the answer reaches them; once
// they are in, the editor opens on them and the conversation is the agent's.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { getState as assistantState, geminiNote, looksLikeKey, modelSpec, MODELS, PROVIDERS, saveKey, setAskModel, subscribe as subscribeAssistant } from '../lib/assistant';
import type { FileHost } from '../lib/playground';
import type { CliAgentId } from '../lib/cliAgent';
import type { AgentChange, ProjectView } from '../lib/projectAgent';
import { agentChatFor, askAgent, dismissAgentError, filesInReply, isAgentRunning, PROJECT_MAX_TOKENS, stopAgent, subscribeAgent, WRITE_PROJECT } from '../lib/projectAgent';
import FileIcon from './FileIcon';
import { SparkleIcon } from './icons';

const elapsed = (since: number, now: number) => {
  const s = Math.max(0, Math.round((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default function ProjectStart({
  projectId,
  host,
  machineName,
  paperTitle,
  hasPlan,
  view,
  onWriting,
  onWrote,
  onDone,
  onDismiss,
  onCli,
}: {
  projectId: string;
  host: FileHost;
  machineName: string;
  paperTitle: string;
  /** Whether the paper has a plan on its Implementation page, which goes with the request. */
  hasPlan: boolean;
  view: () => Promise<ProjectView>;
  /** The write has begun: the agent's pane can show the conversation. */
  onWriting: () => void;
  onWrote: (changes: AgentChange[]) => void;
  /** The files are in: the start goes. */
  onDone: () => void;
  /** Written some other way: the start goes without writing. */
  onDismiss: () => void;
  /** Written by Claude Code or Codex on the machine, signed in to the person's own account, from the paper and the plan. */
  onCli?: (agent: CliAgentId) => void;
}) {
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
    if (!writing) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [writing]);

  const write = async () => {
    if (pending?.error) dismissAgentError(projectId);
    onWriting();
    await askAgent({ projectId, model: chosen.id, request: WRITE_PROJECT, host, view, onWrote, maxTokens: PROJECT_MAX_TOKENS });
    const after = agentChatFor(projectId);
    const last = after.turns[after.turns.length - 1];
    if (!after.pending && last?.role === 'agent' && last.changes?.length) onDone();
  };

  const files = pending ? filesInReply(pending.reply) : [];
  const reads = ['the paper’s abstract', hasPlan ? 'your plan from its Implementation page' : ''].filter(Boolean).join(' and ');

  return (
    <section className="nb-start pg-write" aria-label="Write the project">
      <div className="nb-start-head">
        <span className="explain-kicker pill">
          <SparkleIcon size={15} /> {writing ? 'Writing' : 'Nothing written yet'}
        </span>
        <h2>{writing ? `${chosen.label} is writing the project` : 'Which model writes this project?'}</h2>
        <p>
          It reads {reads} for <b>{paperTitle}</b> and writes every file the implementation needs, straight into this folder: the method in modules of its own, a config, a seeded experiment sized for {machineName} in{' '}
          <code>main.py</code>, a <code>requirements.txt</code> and the README. Every file is yours to edit, one Undo in the agent’s pane puts them all back, and nothing runs until you click.
        </p>
      </div>
      {writing && pending ? (
        <div className="pg-write-live" aria-live="polite">
          <div className="pg-write-step">
            <span className="pg-write-dot" aria-hidden="true" />
            <b>{pending.step}</b>
            <span className="pg-write-clock">{elapsed(pending.started, now)}</span>
            {pending.onServer ? <span className={`pg-write-where${pending.offline ? ' is-offline' : ''}`}>{pending.offline ? 'offline · still writing on the server' : 'on the server'}</span> : null}
            <span className="spacer" />
            <button type="button" className="btn sm ghost" onClick={stopAgent}>
              Stop
            </button>
          </div>
          {files.length ? (
            <ul className="pg-write-files">
              {files.map((path, index) => (
                <li key={path} className={index === files.length - 1 ? 'is-now' : ''}>
                  <FileIcon path={path} /> {path}
                  <small>{index === files.length - 1 ? 'writing…' : 'written'}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">{pending.thinking ? 'Thinking it through before the first file…' : 'The files appear here as it reaches them; they go into the folder together once the answer is whole.'}</p>
          )}
          {pending.onServer ? (
            <p className="hint">
              {pending.offline
                ? 'This page has lost its connection. The answer goes on being written on the server; the files come in here once you’re back, or when you open the project again in this browser.'
                : 'Written on the server: losing the connection, reloading or closing this page doesn’t stop it. Open the project again in this browser and the files land in the folder.'}
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <div className="explain-start">
            <div className="model-pick" role="radiogroup" aria-label="Model">
              {MODELS.map((m) => (
                <button key={m.id} type="button" role="radio" aria-checked={chosen.id === m.id} onClick={() => setAskModel(m.id)}>
                  <b>{m.label}</b>
                  <span>
                    {m.note}
                    {assistant.keys[m.provider] ? '' : PROVIDERS[m.provider].viaProxy ? ` · ${geminiNote(assistant.gemini).short}` : ' · needs a key'}
                  </span>
                </button>
              ))}
            </div>
            {hasKey ? (
              <button type="button" className="btn primary cta" disabled={busyElsewhere} onClick={() => void write()} title={busyElsewhere ? 'The agent is answering another request' : undefined}>
                <SparkleIcon size={17} /> {pending?.error ? 'Try again' : 'Write the project'} with {chosen.label}
              </button>
            ) : null}
          </div>
          {pending?.error ? <p className="pg-note is-problem">{pending.error}</p> : null}
          {hasKey ? (
            <p className="hint">
              <b>Written once</b>, into the folder; afterwards the agent on the right changes it a request at a time, with any model.
            </p>
          ) : provider.viaProxy ? (
            <p className="hint">{geminiNote(assistant.gemini).long}</p>
          ) : (
            <>
              <form
                className="explain-start"
                onSubmit={(event) => {
                  event.preventDefault();
                  const key = keyDraft.trim();
                  if (!looksLikeKey(key, provider.id) && !confirm(`That does not look like one of ${provider.company}’s API keys (they start with "${provider.keyPrefix}"). Save it anyway?`)) return;
                  saveKey(key, provider.id);
                  setKeyDraft('');
                }}
              >
                <input type="password" placeholder={provider.placeholder} value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} aria-label={`${provider.company} API key`} />
                <button type="submit" className="btn primary cta" disabled={!keyDraft.trim()}>
                  Use this {provider.company} key
                </button>
              </form>
              <p className="hint">
                <b>The same {provider.company} key as the rest of the reader.</b> Get one at{' '}
                <a href={provider.consoleUrl} target="_blank" rel="noopener noreferrer">
                  {provider.consoleUrl.replace(/^https:\/\//, '')}
                </a>
                . It stays in this browser and goes only to {provider.host}.
              </p>
            </>
          )}
          {onCli ? (
            <div className="pg-write-cli">
              <p className="hint">
                <b>Or with your own Claude Code or Codex account.</b> It runs on {machineName}, in the project’s folder, signed in there to your Claude or ChatGPT plan — the pane on the right installs it and signs you in. It is handed {hasPlan ? 'the paper and your plan' : 'the paper'} as <code>IMPLEMENTATION_PLAN.md</code>, and keeps working on the machine if this page goes.
              </p>
              <div className="cli-buttons">
                <button type="button" className="btn" onClick={() => onCli('claude')}>
                  <span className="cli-badge is-claude is-sm">✳</span> Write it with Claude Code
                </button>
                <button type="button" className="btn" onClick={() => onCli('codex')}>
                  <span className="cli-badge is-codex is-sm">◎</span> Write it with Codex
                </button>
              </div>
            </div>
          ) : null}
          <p className="hint nb-start-other">
            Or start another way:{' '}
            <button type="button" className="link" onClick={onDismiss}>
              write the files yourself
            </button>
            , or ask Claude Code or Codex in the agent’s pane — they read <code>AGENTS.md</code>.
          </p>
        </>
      )}
    </section>
  );
}
