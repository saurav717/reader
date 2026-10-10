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
import type { CliAgentId, CliEvent, CliStatus } from '../lib/cliAgent';
import { CLI_AGENTS, cliStatus, installArgv, loginArgv, loginPrompt, logoutArgv, parseRun, readJob, runArgv, startJob, stopJob, writeJob } from '../lib/cliAgent';
import { markdown } from '../lib/markdown';
import type { FileHost } from '../lib/playground';
import { readMeta, writeMeta } from '../lib/playground';
import FileIcon from './FileIcon';

// ------------------------------------------------------------ the store --

interface CliTurn {
  at: number;
  request: string;
  /** The job on the machine, and how far its log has been read. */
  job: string;
  offset: number;
  lines: string[];
  done: boolean;
  code?: number | null;
}
interface CliChat {
  session?: string;
  turns: CliTurn[];
}
interface Saved {
  generator: 'reader';
  version: 1;
  chats: Partial<Record<CliAgentId, CliChat>>;
}

const FILE = 'cli-agent.json';
const LINES_KEPT = 4000;
const TURNS_KEPT = 30;
const store = new Map<string, Saved>();
const listeners = new Set<() => void>();
const loaded = new Set<string>();
const polling = new Set<string>();
const EMPTY: Saved = { generator: 'reader', version: 1, chats: {} };
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener));
const savedFor = (projectId: string) => store.get(projectId) ?? EMPTY;
const setChat = (projectId: string, agent: CliAgentId, chat: CliChat) => {
  const now = savedFor(projectId);
  store.set(projectId, { ...now, chats: { ...now.chats, [agent]: chat } });
  notify();
};
async function persist(projectId: string, host: FileHost) {
  const saved = savedFor(projectId);
  const trimmed: Saved = { ...saved, chats: Object.fromEntries(Object.entries(saved.chats).map(([agent, chat]) => [agent, { ...chat, turns: chat!.turns.slice(-TURNS_KEPT).map((turn) => ({ ...turn, lines: turn.lines.slice(-LINES_KEPT) })) }])) };
  await writeMeta(host, FILE, `${JSON.stringify(trimmed)}\n`).catch(() => undefined);
}
async function load(projectId: string, host: FileHost) {
  if (loaded.has(projectId)) return;
  try {
    const text = await readMeta(host, FILE);
    const parsed = text ? (JSON.parse(text) as Saved) : null;
    if (parsed?.chats && !store.has(projectId)) store.set(projectId, { generator: 'reader', version: 1, chats: parsed.chats });
    loaded.add(projectId);
    notify();
  } catch {
    // not reachable now: tried again when the pane opens next
  }
}

/** A run's log read until it ends, a second at a time; what it said parsed as it comes. */
async function follow(projectId: string, agent: CliAgentId, job: string, host: FileHost, onDone: () => void) {
  if (polling.has(job)) return;
  polling.add(job);
  try {
    for (;;) {
      const chat = savedFor(projectId).chats[agent];
      const turn = chat?.turns.find((t) => t.job === job);
      if (!chat || !turn || turn.done) break;
      let read: Awaited<ReturnType<typeof readJob>>;
      try {
        read = await readJob(job, turn.offset);
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      const lines = read.data ? read.data.split('\n').filter((line, i, all) => line || i < all.length - 1) : [];
      const all = [...turn.lines, ...lines];
      const { session } = parseRun(agent, all);
      const now = savedFor(projectId).chats[agent]!;
      setChat(projectId, agent, { session: session ?? now.session, turns: now.turns.map((t) => (t.job === job ? { ...t, lines: all, offset: read.offset, done: read.done, code: read.code } : t)) });
      if (read.done) {
        await persist(projectId, host);
        onDone();
        break;
      }
      await new Promise((r) => setTimeout(r, lines.length ? 600 : 1200));
    }
  } finally {
    polling.delete(job);
  }
}

// ------------------------------------------------------------ the pane --

interface Prefs {
  useKey: boolean;
  commands: boolean;
  model: string;
}
const readPrefs = (agent: CliAgentId): Prefs => {
  try {
    return { useKey: false, commands: true, model: '', ...JSON.parse(localStorage.getItem(`reader.cliAgent.${agent}`) || '{}') };
  } catch {
    return { useKey: false, commands: true, model: '' };
  }
};

export default function CliAgent({
  agent,
  projectId,
  host,
  machineName,
  folder,
  connected,
  onConnect,
  beforeRun,
  afterRun,
  onOpen,
}: {
  agent: CliAgentId;
  projectId: string;
  /** The project's own folder, where the conversation is kept. */
  host: FileHost;
  machineName: string;
  /** The project's folder on the machine, where the agent works. */
  folder: string;
  connected: boolean;
  onConnect: () => void;
  /** Before a request: unsaved files saved, the folder copied over when it is kept elsewhere. */
  beforeRun: () => Promise<boolean>;
  /** After it: its edits brought home, the explorer and the open files read again. */
  afterRun: () => void;
  onOpen: (path: string) => void;
}) {
  const spec = CLI_AGENTS[agent];
  const saved = useSyncExternalStore(subscribe, () => savedFor(projectId));
  const chat = saved.chats[agent] ?? { turns: [] };
  const [status, setStatus] = useState<CliStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'status' | 'install' | 'login' | 'logout'>(null);
  const [jobLog, setJobLog] = useState('');
  const [login, setLogin] = useState<{ job: string; url?: string; code?: string } | null>(null);
  const [pasted, setPasted] = useState('');
  const [prefs, setPrefsState] = useState<Prefs>(() => readPrefs(agent));
  const [text, setText] = useState('');
  const log = useRef<HTMLDivElement>(null);
  const setPrefs = (patch: Partial<Prefs>) =>
    setPrefsState((now) => {
      const next = { ...now, ...patch };
      try {
        localStorage.setItem(`reader.cliAgent.${agent}`, JSON.stringify(next));
      } catch {
        // private mode
      }
      return next;
    });
  useEffect(() => setPrefsState(readPrefs(agent)), [agent]);
  const siteKey = agent === 'claude' ? keyFor('anthropic') : '';
  const env = useMemo<Record<string, string>>(() => (agent === 'claude' && prefs.useKey && siteKey ? { ANTHROPIC_API_KEY: siteKey } : ({} as Record<string, string>)), [agent, prefs.useKey, siteKey]);

  const refresh = useCallback(async () => {
    if (!connected) return;
    setBusy('status');
    setProblem(null);
    try {
      setStatus(await cliStatus(agent, env));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
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
    if (!connected) return;
    const open = chat.turns.find((turn) => !turn.done);
    if (open) void follow(projectId, agent, open.job, host, afterRun);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, agent, projectId, chat.turns.length]);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [chat.turns.length, chat.turns[chat.turns.length - 1]?.lines.length]);

  /** A job that isn't a request — the install, a sign-in — followed until it ends, its output shown. */
  const watch = async (job: string, onLine?: (all: string) => void) => {
    let offset = 0;
    let all = '';
    for (;;) {
      const read = await readJob(job, offset);
      offset = read.offset;
      all += read.data;
      setJobLog(all);
      onLine?.(all);
      if (read.done) return read.code;
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  const install = async () => {
    setBusy('install');
    setProblem(null);
    try {
      const job = `install-${agent}`;
      await startJob(job, installArgv(agent));
      const code = await watch(job);
      if (code) setProblem(`The install ended with an error (${code}): its last lines are above.`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
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
      await startJob(job, loginArgv(agent, console), { stdin: true });
      setLogin({ job });
      const code = await watch(job, (all) => {
        const found = loginPrompt(all);
        if (found.url) setLogin((now) => (now ? { ...now, ...found } : now));
      });
      if (code) setProblem(`Signing in didn’t finish (${code}).`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setLogin(null);
      setBusy(null);
      void refresh();
    }
  };
  const sendCode = async () => {
    if (!login || !pasted.trim()) return;
    try {
      await writeJob(login.job, `${pasted.trim()}\n`);
      setPasted('');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };
  const signOut = async () => {
    setBusy('logout');
    try {
      const job = `logout-${agent}`;
      await startJob(job, logoutArgv(agent));
      await watch(job);
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const running = chat.turns.some((turn) => !turn.done);
  const send = async (request: string) => {
    const prompt = request.trim();
    if (!prompt || running || !status?.loggedIn) return;
    setText('');
    setProblem(null);
    if (!(await beforeRun())) return;
    const job = `run-${agent}-${Date.now().toString(36)}`;
    const turn: CliTurn = { at: Date.now(), request: prompt, job, offset: 0, lines: [], done: false };
    setChat(projectId, agent, { ...chat, turns: [...chat.turns, turn].slice(-TURNS_KEPT) });
    try {
      const context = `You are running inside Reader's Playground, on ${machineName}, in the project's folder (the working directory). The person reads your replies in a panel beside their editor and can't answer questions while you work: do what they ask, then say in a few sentences what you did and how to run it. Long trainings belong in the console, which they start themselves; keep your own runs short.`;
      await startJob(job, runArgv(agent, { prompt, session: chat.session, model: prefs.model || undefined, commands: prefs.commands, context }), { cwd: folder, env });
      await persist(projectId, host);
      void follow(projectId, agent, job, host, afterRun);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      const now = savedFor(projectId).chats[agent]!;
      setChat(projectId, agent, { ...now, turns: now.turns.filter((t) => t.job !== job) });
    }
  };
  const stop = () => {
    const open = chat.turns.find((turn) => !turn.done);
    if (open) void stopJob(open.job);
  };
  const newSession = () => {
    if (running) return;
    setChat(projectId, agent, { turns: [] });
    void persist(projectId, host);
  };

  if (!connected) {
    return (
      <div className="cli-setup">
        <AgentHead agent={agent} />
        <p>
          {spec.name} runs on {machineName}, in the project’s folder, signed in to your own {agent === 'claude' ? 'Anthropic' : 'OpenAI'} account. Connect to the machine first.
        </p>
        <button type="button" className="btn sm primary" onClick={onConnect}>
          Connect to {machineName}
        </button>
      </div>
    );
  }
  if (!status) {
    return (
      <div className="cli-setup">
        <AgentHead agent={agent} />
        {problem ? (
          <>
            <p className="pg-note is-problem">{problem}</p>
            <button type="button" className="btn sm" onClick={() => void refresh()}>
              Try again
            </button>
          </>
        ) : (
          <p className="pg-note">
            <span className="spinner" /> Looking for {spec.name} on {machineName}…
          </p>
        )}
      </div>
    );
  }
  if (!status.installed) {
    return (
      <div className="cli-setup">
        <AgentHead agent={agent} />
        <p>
          {spec.name} isn’t on {machineName} yet. Installing it takes a minute{agent === 'claude' ? ' (Anthropic’s installer, into ~/.local/bin)' : ' (npm install -g @openai/codex)'}
          {machineName.startsWith('Colab') ? '; on Colab it goes with the runtime, and installs again on the next one' : ''}.
        </p>
        <button type="button" className="btn sm primary" disabled={busy === 'install'} onClick={() => void install()}>
          {busy === 'install' ? 'Installing…' : `Install ${spec.name} on ${machineName}`}
        </button>
        {jobLog && busy === 'install' ? <pre className="cli-log">{jobLog.split('\n').slice(-12).join('\n')}</pre> : null}
        {problem ? <p className="pg-note is-problem">{problem}</p> : null}
      </div>
    );
  }
  if (!status.loggedIn) {
    return (
      <div className="cli-setup">
        <AgentHead agent={agent} version={status.version} />
        {login ? (
          <div className="cli-login">
            {login.url ? (
              <>
                <p>{agent === 'claude' ? '1 · Sign in on Anthropic’s page, and allow Claude Code.' : '1 · Open the page, sign in to your ChatGPT or OpenAI account, and enter this code:'}</p>
                {login.code ? <code className="cli-code">{login.code}</code> : null}
                <a className="btn sm primary" href={login.url} target="_blank" rel="noreferrer">
                  Open the sign-in page ↗
                </a>
                {agent === 'claude' ? (
                  <form
                    className="cli-paste"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void sendCode();
                    }}
                  >
                    <label>
                      <span>2 · Paste the code the page shows</span>
                      <input value={pasted} onChange={(event) => setPasted(event.target.value)} placeholder="code#state" spellCheck={false} autoComplete="off" />
                    </label>
                    <button type="submit" className="btn sm" disabled={!pasted.trim()}>
                      Sign in
                    </button>
                  </form>
                ) : (
                  <p className="pg-note">2 · This finishes by itself once the page says you’re signed in.</p>
                )}
              </>
            ) : (
              <p className="pg-note">
                <span className="spinner" /> Asking {spec.maker} for a sign-in page…
              </p>
            )}
          </div>
        ) : (
          <>
            <p>
              {spec.name} {status.version ? `${status.version.split(' ')[0]} ` : ''}is on {machineName}. Sign in with your {agent === 'claude' ? 'Claude account — Pro, Max, Team — or an Anthropic Console account' : 'ChatGPT account (Plus, Pro, Team) or an OpenAI API key'}: the sign-in stays on that machine{machineName.startsWith('Colab') ? ', for as long as the runtime lives' : ''}.
            </p>
            <div className="cli-buttons">
              <button type="button" className="btn sm primary" disabled={Boolean(busy)} onClick={() => void signIn(false)}>
                {agent === 'claude' ? 'Sign in with Claude' : 'Sign in with ChatGPT'}
              </button>
              {agent === 'claude' ? (
                <button type="button" className="btn sm" disabled={Boolean(busy)} onClick={() => void signIn(true)} title="Pay per use, with an Anthropic Console account">
                  Anthropic Console account
                </button>
              ) : null}
            </div>
            {agent === 'claude' && siteKey ? (
              <label className="cli-check">
                <input type="checkbox" checked={prefs.useKey} onChange={(event) => setPrefs({ useKey: event.target.checked })} />
                <span>Or use the Anthropic API key in Settings → AI — handed to Claude Code for each request, never written on the machine</span>
              </label>
            ) : null}
          </>
        )}
        {problem ? <p className="pg-note is-problem">{problem}</p> : null}
      </div>
    );
  }

  return (
    <div className="vs-agent-chat cli-chat">
      <div className="vs-agent-bar cli-bar">
        <span className="cli-who" title={status.method}>
          <span className="colab-dot is-on" /> {spec.name} · {status.method ?? 'signed in'}
        </span>
        <span className="spacer" />
        <button type="button" className="link" onClick={() => void signOut()} disabled={Boolean(busy) || running}>
          Sign out
        </button>
      </div>
      <div className="vs-agent-log" ref={log}>
        {!chat.turns.length ? (
          <div className="vs-agent-hello">
            <span className={`cli-badge is-${agent}`}>{agent === 'claude' ? '✳' : '◎'}</span>
            <b>{spec.name}, on {machineName}</b>
            <p>
              The real {spec.name}, working in the project’s folder there: it reads the code, edits files and {prefs.commands ? 'runs commands' : 'proposes commands'} itself. Each message carries the same session on.
            </p>
            <div className="vs-agent-sugs">
              {['Build a CNN for CIFAR-10 in PyTorch, train it briefly, and report the accuracy', 'Explain this project and how to run it', 'Find and fix the bug in the last run', 'Add TensorBoard logging under runs/'].map((suggestion) => (
                <button key={suggestion} type="button" className="ask-suggestion" onClick={() => void send(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {chat.turns.map((turn) => (
          <Turn key={turn.job} agent={agent} turn={turn} folder={folder} onOpen={onOpen} />
        ))}
      </div>
      <form
        className="vs-agent-box"
        onSubmit={(event) => {
          event.preventDefault();
          void send(text);
        }}
      >
        <div className="vs-agent-ctx">
          <span className="vs-chip" title={folder}>
            {machineName} · {folder}
          </span>
          {chat.session ? <span className="vs-chip" title={`Session ${chat.session}`}>session</span> : null}
          <span className="spacer" />
          {chat.turns.length && !running ? (
            <button type="button" className="link" onClick={newSession} title="A new session: it forgets this conversation">
              New session
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
              void send(text);
            }
          }}
          placeholder={running ? `${spec.name} is working…` : `Ask ${spec.name} — ⏎ to send`}
          aria-label={`Ask ${spec.name}`}
        />
        <div className="vs-agent-row">
          {spec.models.length > 1 ? (
            <select className="cli-select" value={prefs.model} onChange={(event) => setPrefs({ model: event.target.value })} aria-label="Model">
              {spec.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          ) : null}
          <label className="cli-check is-inline" title={agent === 'claude' ? 'Claude Code edits files either way; with this on it runs shell commands too (--allowedTools Bash)' : 'Off: it edits files in the folder only (workspace-write); on: full access, commands included'}>
            <input type="checkbox" checked={prefs.commands} onChange={(event) => setPrefs({ commands: event.target.checked })} />
            <span>Run commands</span>
          </label>
          <span className="spacer" />
          {running ? (
            <button type="button" className="btn sm" onClick={stop}>
              ■ Stop
            </button>
          ) : (
            <button type="submit" className="btn sm primary" disabled={!text.trim()}>
              Send
            </button>
          )}
        </div>
        {problem ? <p className="pg-note is-problem">{problem}</p> : null}
      </form>
    </div>
  );
}

function AgentHead({ agent, version }: { agent: CliAgentId; version?: string }) {
  return (
    <div className="cli-head">
      <span className={`cli-badge is-${agent}`}>{agent === 'claude' ? '✳' : '◎'}</span>
      <b>{CLI_AGENTS[agent].name}</b>
      {version ? <small>{version.split(' ')[0]}</small> : null}
    </div>
  );
}

/** One request and what the run did, as it streams. */
function Turn({ agent, turn, folder, onOpen }: { agent: CliAgentId; turn: CliTurn; folder: string; onOpen: (path: string) => void }) {
  /** A path the agent named, as the project's folder has it: after the folder's own path, when it is there. */
  const relative = (path: string) => {
    const mark = `${folder.replace(/^\.?\/+|\/+$/g, '')}/`;
    const at = path.indexOf(mark);
    return at >= 0 ? path.slice(at + mark.length) : path.replace(/^\.?\/+/, '');
  };
  const { events } = useMemo(() => parseRun(agent, turn.lines), [agent, turn.lines]);
  const outputs = new Map(events.filter((e): e is Extract<CliEvent, { kind: 'output' }> => e.kind === 'output').map((e) => [e.id, e]));
  const done = events.find((e): e is Extract<CliEvent, { kind: 'done' }> => e.kind === 'done');
  return (
    <>
      <div className="vs-turn is-user">
        <p>{turn.request}</p>
      </div>
      <div className="vs-turn is-agent cli-turn">
        <div className="vs-turn-who">
          <span className={`cli-badge is-${agent} is-sm`}>{agent === 'claude' ? '✳' : '◎'}</span> {CLI_AGENTS[agent].name}
        </div>
        {events.map((event, index) => {
          if (event.kind === 'text') return <div key={index} className="vs-turn-text" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(markdown(event.text)) }} />;
          if (event.kind === 'thinking') return <p key={index} className="vs-turn-think">{event.text.slice(-300)}</p>;
          if (event.kind === 'note') return <pre key={index} className="cli-note">{event.text}</pre>;
          if (event.kind === 'tool') {
            const out = outputs.get(event.id);
            const edit = /^(Edit|Write|MultiEdit|NotebookEdit|Delete)$/.test(event.name);
            return (
              <details key={index} className={`cli-tool is-${edit ? 'edit' : event.name === 'Bash' ? 'bash' : 'read'}${out?.error ? ' is-error' : ''}`}>
                <summary>
                  <span className="cli-tool-name">{event.name === 'Bash' ? '$' : event.name}</span>
                  {event.path ? (
                    <button
                      type="button"
                      className="cli-path"
                      onClick={(e) => {
                        e.preventDefault();
                        onOpen(relative(event.path!));
                      }}
                    >
                      <FileIcon path={event.path} /> {event.path.split('/').slice(-2).join('/')}
                    </button>
                  ) : (
                    <code>{event.detail.length > 120 ? `${event.detail.slice(0, 120)}…` : event.detail}</code>
                  )}
                  {!out && !turn.done ? <span className="spinner" /> : null}
                </summary>
                {out?.text ? <pre>{out.text.length > 4000 ? `${out.text.slice(0, 4000)}\n…` : out.text}</pre> : null}
              </details>
            );
          }
          return null;
        })}
        {!turn.done ? (
          <div className="vs-turn-step">
            <span className="spinner" /> {events.length ? 'Working' : `Starting ${CLI_AGENTS[agent].name}`}
          </div>
        ) : done ? (
          <div className={`cli-done${done.ok ? '' : ' is-error'}`}>
            {done.ok ? 'Done' : done.text || 'It stopped with an error'}
            {done.ms ? ` · ${Math.round(done.ms / 1000)} s` : ''}
            {done.turns ? ` · ${done.turns} steps` : ''}
            {done.cost ? ` · $${done.cost.toFixed(3)}` : ''}
          </div>
        ) : (
          <div className="cli-done is-error">{turn.code === null || turn.code === undefined ? 'Stopped.' : `It ended (exit ${turn.code}) without an answer — the lines above say why.`}</div>
        )}
      </div>
    </>
  );
}
