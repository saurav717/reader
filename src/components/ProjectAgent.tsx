// The playground's agent panel, on the right of the editor as a coding agent
// sits in VS Code: a conversation about the project, answered by the model
// picked here (src/lib/projectAgent.ts). Its answers show the files it read,
// the files it wrote — each opens in the editor, and one Undo puts them all
// back — and the commands it suggests, each a button for the console.

import DOMPurify from 'dompurify';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getState as assistantState, modelSpec, PROVIDERS, setAskModel, subscribe as subscribeAssistant } from '../lib/assistant';
import { markdown } from '../lib/markdown';
import type { FileHost } from '../lib/playground';
import type { AgentChange, ProjectView } from '../lib/projectAgent';
import { AGENT_FILE, agentChatFor, askAgent, canUndo, clearAgentChat, dismissAgentError, isAgentRunning, loadAgentChats, openAgentChat, stopAgent, subscribeAgent, undoAgentTurn } from '../lib/projectAgent';
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

export default function ProjectAgent({
  projectId,
  host,
  machineName,
  view,
  context,
  onOpen,
  onRun,
  onWrote,
}: {
  projectId: string;
  host: FileHost;
  machineName: string;
  /** The project as the agent reads it, built when a request is sent. */
  view: () => Promise<ProjectView>;
  /** What goes with the next request, in words, for the chips over the box. */
  context: { active?: string; open: number; commands: number };
  onOpen: (path: string) => void;
  onRun: (command: string) => void;
  onWrote: (changes: AgentChange[]) => void;
}) {
  const assistant = useSyncExternalStore(subscribeAssistant, assistantState);
  const chat = useSyncExternalStore(subscribeAgent, () => agentChatFor(projectId));
  const running = isAgentRunning(projectId);
  const model = assistant.prefs.askModel ?? assistant.prefs.explainModel ?? assistant.prefs.model;
  const ready = Boolean(assistant.keys[modelSpec(model).provider]);
  const writer = PROVIDERS[modelSpec(model).provider].name;
  const [text, setText] = useState('');
  const log = useRef<HTMLDivElement>(null);
  const [showHistory, setShowHistory] = useState(false);
  // The conversations are in the project's folder: read when the panel opens, and again whenever the folder can be reached.
  useEffect(() => {
    void loadAgentChats(projectId, host);
  }, [projectId, host]);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [chat.turns.length, chat.pending?.reply.length, chat.pending?.step]);

  const send = (request: string) => {
    if (!request.trim() || running || !ready) return;
    setText('');
    void askAgent({ projectId, model, request, host, view, onWrote });
  };

  return (
    <div className="vs-agent-chat">
      {chat.history.length || chat.problem ? (
        <div className="vs-agent-bar">
          {chat.history.length ? (
            <div className="menu-wrap">
              <button type="button" className={`link${showHistory ? ' is-on' : ''}`} aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)} title={`Earlier conversations, kept in the project's folder (${AGENT_FILE})`}>
                History · {chat.history.length}
              </button>
              {showHistory ? (
                <div className="menu vs-history" role="menu">
                  {chat.history.map((saved) => (
                    <button
                      key={saved.id}
                      type="button"
                      role="menuitem"
                      disabled={running}
                      onClick={() => {
                        openAgentChat(projectId, saved.id);
                        setShowHistory(false);
                      }}
                    >
                      <span>{saved.title}</span>
                      <small>
                        {new Date(saved.updated).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {saved.turns.filter((t) => t.role === 'user').length} asked
                      </small>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {chat.problem ? <span className="pg-note is-problem" title={chat.problem}>{chat.problem}</span> : null}
        </div>
      ) : null}
      <div className="vs-agent-log" ref={log}>
        {!chat.turns.length && !chat.pending ? (
          <div className="vs-agent-hello">
            <span className="vs-agent-badge">
              <SparkleIcon size={18} />
            </span>
            <b>An agent for this project</b>
            <p>
              It reads the files, the one in front of you and what the console printed; it writes files straight into the folder — one Undo puts them back — and suggests commands to run on {machineName}. Nothing runs by itself.
            </p>
            <div className="vs-agent-sugs">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} type="button" className="ask-suggestion" disabled={!ready} onClick={() => send(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {chat.turns.map((turn) =>
          turn.role === 'user' ? (
            <div key={turn.at} className="vs-turn is-user">
              <p>{turn.text}</p>
            </div>
          ) : (
            <div key={turn.at} className="vs-turn is-agent">
              <div className="vs-turn-who">
                <SparkleIcon size={13} /> {turn.model ? shortModelName(modelSpec(turn.model).label) : 'Agent'}
              </div>
              {turn.read?.length ? <div className="vs-turn-read">Read {turn.read.join(', ')}</div> : null}
              {turn.text ? <div className="vs-turn-text" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(markdown(turn.text)) }} /> : null}
              {turn.changes?.length ? (
                <div className={`vs-changes${turn.undone ? ' is-undone' : ''}`}>
                  <div className="vs-changes-head">
                    <span>
                      {turn.undone ? 'Undone · ' : ''}
                      {turn.changes.length} {turn.changes.length === 1 ? 'file' : 'files'} changed
                    </span>
                    {!turn.undone && canUndo(turn) ? (
                      <button type="button" className="link" onClick={() => void undoAgentTurn(projectId, turn.at, host, onWrote)} disabled={running} title="Put these files back as they were">
                        Undo
                      </button>
                    ) : null}
                  </div>
                  {turn.changes.map((change) => (
                    <button key={change.path} type="button" className="vs-change" onClick={() => onOpen(change.path)} title={`Open ${change.path}`}>
                      <FileIcon path={change.path} />
                      <span className="vs-change-path">{change.path}</span>
                      {change.before === null ? <span className="vs-change-new">new</span> : null}
                      <span className="vs-plus">+{change.added}</span>
                      <span className="vs-minus">−{change.removed}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {turn.commands?.map((command) => (
                <div key={command} className="vs-cmd">
                  <code>
                    <span className="pg-prompt">$</span> {command}
                  </code>
                  <button type="button" className="btn sm" onClick={() => onRun(command)} title={`Run it on ${machineName}, in the project's folder`}>
                    ▶ Run
                  </button>
                </div>
              ))}
              {turn.cut ? <p className="pg-note">The answer was cut short: ask for the rest.</p> : null}
            </div>
          ),
        )}
        {chat.pending ? (
          <div className={`vs-turn is-agent is-live${chat.pending.error ? ' is-error' : ''}`}>
            <div className="vs-turn-who">
              <SparkleIcon size={13} /> {shortModelName(modelSpec(model).label)}
            </div>
            {chat.pending.error ? (
              <>
                <p className="pg-note is-problem">{chat.pending.error}</p>
                <button type="button" className="btn sm ghost" onClick={() => dismissAgentError(projectId)}>
                  Dismiss
                </button>
              </>
            ) : (
              <>
                <div className="vs-turn-step">
                  <span className="spinner" /> {chat.pending.step}
                  {chat.pending.read.length ? <small> · read {chat.pending.read.length}</small> : null}
                </div>
                {chat.pending.reply ? <pre className="vs-turn-stream">{chat.pending.reply.slice(-1400)}</pre> : chat.pending.thinking ? <p className="vs-turn-think">{chat.pending.thinking.slice(-280)}</p> : null}
              </>
            )}
          </div>
        ) : null}
      </div>
      <form
        className="vs-agent-box"
        onSubmit={(event) => {
          event.preventDefault();
          send(text);
        }}
      >
        <div className="vs-agent-ctx" aria-label="What goes with the request">
          {context.active ? (
            <span className="vs-chip" title="The file in front of you">
              <FileIcon path={context.active} /> {context.active.split('/').pop()}
            </span>
          ) : null}
          {context.open > (context.active ? 1 : 0) ? <span className="vs-chip">+{context.open - (context.active ? 1 : 0)} open</span> : null}
          <span className="vs-chip">folder</span>
          {context.commands ? <span className="vs-chip">console · {context.commands}</span> : null}
          <span className="spacer" />
          {chat.turns.length && !running ? (
            <button type="button" className="link" onClick={() => clearAgentChat(projectId, host)} title="Start a new conversation (the files stay as they are)">
              New chat
            </button>
          ) : null}
        </div>
        <textarea
          value={text}
          rows={3}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send(text);
            }
          }}
          placeholder={ready ? `Ask ${writer} to write, change or fix the code — ⏎ to send` : `${writer} needs its key in Settings → AI, or pick another model`}
          aria-label="Ask the agent"
        />
        <div className="vs-agent-row">
          <ModelChip value={model} keys={assistant.keys} disabled={running} what="The agent answers with" up align="left" view="list" onChange={(id) => setAskModel(id)} />
          <span className="spacer" />
          {running ? (
            <button type="button" className="btn sm" onClick={stopAgent}>
              ■ Stop
            </button>
          ) : (
            <button type="submit" className="btn sm primary" disabled={!ready || !text.trim()}>
              Send
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
