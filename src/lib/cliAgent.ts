// ===========================================================================
//  Claude Code and Codex, on the machine the project runs on — Colab
//  included, where the page has no terminal to give them. They run as their
//  own command-line programs, in their non-interactive modes (`claude -p
//  --output-format stream-json`, `codex exec --json`), started in the
//  background by a few lines of Python in the runtime's small second kernel
//  (runQuietly): what they print goes to a log on the machine, which the page
//  reads a second at a time and shows as the conversation — their words, the
//  files they edit, the commands they run. The notebook's kernel stays free,
//  and a page opened again picks a run up where its log is.
//
//  Signing in is theirs too: `claude auth login` prints the address of
//  Anthropic's sign-in page and waits for the code that page shows, which the
//  page passes on; `codex login --device-auth` prints a page and a code to
//  enter there, and finishes by itself. The sign-in is kept on the machine
//  (~/.claude, ~/.codex) — on Colab, for as long as the runtime lives.
// ===========================================================================

import { runQuietly } from './colab';

export type CliAgentId = 'claude' | 'codex';

export const CLI_AGENTS: Record<CliAgentId, { name: string; maker: string; command: string; models: { id: string; label: string }[] }> = {
  claude: {
    name: 'Claude Code',
    maker: 'Anthropic',
    command: 'claude',
    models: [
      { id: '', label: 'Default' },
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'haiku', label: 'Haiku' },
    ],
  },
  codex: {
    name: 'Codex',
    maker: 'OpenAI',
    command: 'codex',
    models: [{ id: '', label: 'Default' }],
  },
};

/**
 * The helper, defined in the second kernel each time it is used (it is
 * small, and the kernel may have started again since): jobs started in the
 * background with their output in ~/.reader-agent/<job>.log and their exit
 * code in <job>.exit, read from an offset, written to, stopped.
 */
const HELPER = String.raw`
import os, json, shutil, signal, subprocess
_RA = os.path.expanduser('~/.reader-agent')
os.makedirs(_RA, exist_ok=True)
_ra_procs = globals().setdefault('_ra_procs', {})
def _ra_env(extra=None):
    e = dict(os.environ)
    e['PATH'] = os.pathsep.join([os.path.expanduser('~/.local/bin'), os.path.expanduser('~/.npm-global/bin'), '/usr/local/bin', e.get('PATH', '')])
    e.setdefault('TERM', 'dumb')
    e['NO_COLOR'] = '1'
    e.update(extra or {})
    return e
def _ra_start(name, argv, cwd=None, env=None, stdin=False):
    log = os.path.join(_RA, name + '.log'); ex = os.path.join(_RA, name + '.exit')
    for p in (log, ex):
        if os.path.exists(p): os.remove(p)
    if cwd: os.makedirs(cwd, exist_ok=True)
    out = open(log, 'wb')
    p = subprocess.Popen(['bash', '-c', '"$@"; echo $? > "' + ex + '"', '_'] + list(argv), cwd=cwd, env=_ra_env(env), stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.PIPE if stdin else subprocess.DEVNULL, start_new_session=True)
    _ra_procs[name] = p
    open(os.path.join(_RA, name + '.pid'), 'w').write(str(p.pid))
    print(json.dumps({'pid': p.pid, 'cwd': os.path.abspath(cwd or '.')}))
def _ra_alive(name):
    try:
        pid = int(open(os.path.join(_RA, name + '.pid')).read())
        os.kill(pid, 0)
        p = _ra_procs.get(name)
        return not (p and p.poll() is not None)
    except Exception:
        return False
def _ra_read(name, offset=0):
    log = os.path.join(_RA, name + '.log'); ex = os.path.join(_RA, name + '.exit')
    data = b''
    if os.path.exists(log):
        with open(log, 'rb') as f:
            f.seek(offset); data = f.read(600000)
    code = None
    if os.path.exists(ex):
        try: code = int(open(ex).read().strip() or '1')
        except Exception: code = 1
    done = code is not None or not _ra_alive(name)
    if not done and b'\n' in data: data = data[:data.rindex(b'\n') + 1]
    elif not done: data = b''
    print(json.dumps({'data': data.decode('utf-8', 'replace'), 'offset': offset + len(data), 'done': done, 'code': code}))
def _ra_write(name, text):
    p = _ra_procs.get(name)
    if not p or p.stdin is None: raise RuntimeError('That sign-in is no longer waiting: start it again.')
    p.stdin.write(text.encode()); p.stdin.flush()
    print('ok')
def _ra_stop(name):
    try:
        pid = int(open(os.path.join(_RA, name + '.pid')).read())
        os.killpg(pid, signal.SIGTERM)
    except Exception: pass
    print('ok')
def _ra_status(agent, env=None):
    e = _ra_env(env)
    exe = shutil.which('claude' if agent == 'claude' else 'codex', path=e['PATH'])
    out = {'installed': bool(exe), 'node': bool(shutil.which('node', path=e['PATH'])), 'npm': bool(shutil.which('npm', path=e['PATH'])), 'curl': bool(shutil.which('curl', path=e['PATH'])), 'root': os.geteuid() == 0 if hasattr(os, 'geteuid') else False}
    if exe:
        try:
            out['version'] = subprocess.run([exe, '--version'], capture_output=True, text=True, timeout=30, env=e).stdout.strip()
            if agent == 'claude':
                r = subprocess.run([exe, 'auth', 'status', '--json'], capture_output=True, text=True, timeout=40, env=e)
                out['auth'] = r.stdout.strip()[-4000:]
            else:
                r = subprocess.run([exe, 'login', 'status'], capture_output=True, text=True, timeout=40, env=e)
                out['auth'] = (r.stdout + r.stderr).strip()[-2000:]
                out['authCode'] = r.returncode
        except Exception as error:
            out['error'] = str(error)
    print(json.dumps(out))
`;

const py = (value: unknown) => JSON.stringify(value);

/** Runs the helper on the machine of `scope`'s session — a playground's, whichever page is open — or the foreground's. */
async function call(code: string, scope?: string): Promise<string> {
  const answer = await runQuietly(`${HELPER}\n${code}`, scope);
  if (!answer) throw new Error('The machine isn’t connected: connect from the bar, or run a cell, first.');
  if (!answer.ok) throw new Error(answer.text.trim().split('\n').pop() || 'The machine couldn’t do that.');
  return answer.text.trim().split('\n').pop() ?? '';
}

export interface CliStatus {
  installed: boolean;
  version?: string;
  node: boolean;
  npm: boolean;
  curl: boolean;
  root: boolean;
  loggedIn: boolean;
  /** How it is signed in, in words: a Claude subscription, an API key, ChatGPT. */
  method?: string;
  error?: string;
}

/** Whether an agent is on the machine, and whether it is signed in. `env` carries an API key, when one is used instead. */
export async function cliStatus(agent: CliAgentId, env: Record<string, string> = {}, scope?: string): Promise<CliStatus> {
  const raw = JSON.parse(await call(`_ra_status(${py(agent)}, ${py(env)})`, scope)) as { installed: boolean; version?: string; node: boolean; npm: boolean; curl: boolean; root: boolean; auth?: string; authCode?: number; error?: string };
  let loggedIn = false;
  let method: string | undefined;
  if (agent === 'claude' && raw.auth) {
    try {
      const auth = JSON.parse(raw.auth) as { loggedIn?: boolean; authMethod?: string; apiKeySource?: string; email?: string; subscriptionType?: string };
      loggedIn = Boolean(auth.loggedIn);
      method = auth.authMethod === 'api_key' ? `API key${auth.apiKeySource ? ` (${auth.apiKeySource})` : ''}` : auth.authMethod === 'claude.ai' || auth.authMethod === 'oauth_token' ? `Claude account${auth.subscriptionType ? ` · ${auth.subscriptionType}` : ''}${auth.email ? ` · ${auth.email}` : ''}` : auth.authMethod;
    } catch {
      loggedIn = false;
    }
  } else if (agent === 'codex' && raw.auth) {
    loggedIn = raw.authCode === 0 && !/not logged in/i.test(raw.auth);
    method = loggedIn ? raw.auth.replace(/^Logged in (using|with)\s*/i, '').split('\n')[0] : undefined;
  }
  return { installed: raw.installed, version: raw.version, node: raw.node, npm: raw.npm, curl: raw.curl, root: raw.root, loggedIn, method, error: raw.error };
}

/** The job that installs an agent on the machine: Anthropic's installer for Claude Code (npm when there is no curl), npm for Codex. */
export function installArgv(agent: CliAgentId): string[] {
  return agent === 'claude'
    ? ['bash', '-c', 'if command -v curl >/dev/null; then curl -fsSL https://claude.ai/install.sh | bash; else npm install -g @anthropic-ai/claude-code; fi']
    : ['bash', '-c', 'command -v npm >/dev/null || { curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs; }; npm install -g @openai/codex']
}

/** The job that signs an agent in: Claude Code to a Claude subscription or an Anthropic Console account; Codex with a device code. */
export function loginArgv(agent: CliAgentId, console = false): string[] {
  return agent === 'claude' ? ['claude', 'auth', 'login', console ? '--console' : '--claudeai'] : ['codex', 'login', '--device-auth'];
}
export const logoutArgv = (agent: CliAgentId) => (agent === 'claude' ? ['claude', 'auth', 'logout'] : ['codex', 'logout']);

export interface RunOptions {
  prompt: string;
  /** Its session from before, to carry the conversation on. */
  session?: string;
  model?: string;
  /** Whether it may run shell commands as well as edit files. */
  commands: boolean;
  /** What it is told about where it is. */
  context: string;
}

/** The command line of one request. */
export function runArgv(agent: CliAgentId, options: RunOptions): string[] {
  if (agent === 'claude') {
    return [
      'claude',
      '-p',
      options.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      ...(options.commands ? ['--allowedTools', 'Bash'] : []),
      ...(options.model ? ['--model', options.model] : []),
      ...(options.session ? ['--resume', options.session] : []),
      '--append-system-prompt',
      options.context,
    ];
  }
  const head = ['codex', 'exec', '--json', '--skip-git-repo-check', '-s', options.commands ? 'danger-full-access' : 'workspace-write', ...(options.model ? ['-m', options.model] : [])];
  const prompt = `${options.context}\n\n${options.prompt}`;
  return options.session ? [...head, 'resume', options.session, prompt] : [...head, prompt];
}

export async function startJob(name: string, argv: string[], options: { cwd?: string; env?: Record<string, string>; stdin?: boolean } = {}, scope?: string): Promise<void> {
  await call(`_ra_start(${py(name)}, ${py(argv)}, cwd=${options.cwd ? py(options.cwd) : 'None'}, env=${py(options.env ?? {})}, stdin=${options.stdin ? 'True' : 'False'})`, scope);
}
export async function readJob(name: string, offset: number, scope?: string): Promise<{ data: string; offset: number; done: boolean; code: number | null }> {
  return JSON.parse(await call(`_ra_read(${py(name)}, ${offset})`, scope));
}
export async function writeJob(name: string, text: string, scope?: string): Promise<void> {
  await call(`_ra_write(${py(name)}, ${py(text)})`, scope);
}
export async function stopJob(name: string, scope?: string): Promise<void> {
  await call(`_ra_stop(${py(name)})`, scope);
}

/** The sign-in page an agent's login printed, and the code to enter there (Codex's device code). */
export function loginPrompt(output: string): { url?: string; code?: string } {
  const plain = output.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  const url = /https:\/\/[^\s"'<>]+/.exec(plain.split('\n').find((line) => /oauth|authorize|device|login/i.test(line)) ?? '')?.[0];
  const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b/.exec(plain)?.[1];
  return { url, code };
}

// ------------------------------------------------------- what they say --

/** One thing a run did, as the panel shows it. */
export type CliEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; detail: string; path?: string }
  | { kind: 'output'; id: string; text: string; error: boolean }
  | { kind: 'done'; ok: boolean; text: string; cost?: number; ms?: number; turns?: number }
  | { kind: 'note'; text: string };

/** A tool use, in a line: what Claude Code edited, read or ran. */
function toolDetail(name: string, input: Record<string, unknown>): { detail: string; path?: string } {
  const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : typeof input.path === 'string' ? input.path : undefined;
  if (name === 'Bash') return { detail: String(input.command ?? '') };
  if (path) return { detail: path, path };
  if (typeof input.pattern === 'string') return { detail: input.pattern };
  if (typeof input.url === 'string') return { detail: input.url };
  if (typeof input.query === 'string') return { detail: input.query };
  if (typeof input.description === 'string') return { detail: input.description };
  return { detail: '' };
}

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '')).join('\n') : '';

/**
 * Claude Code's stream-json, a line at a time: the session it is in, its
 * words, the tools it used and what they gave back, and the result. Lines
 * that aren't JSON (an error from the shell, an installer's message) are
 * kept as notes.
 */
export function parseClaude(lines: string[]): { events: CliEvent[]; session?: string; model?: string } {
  const events: CliEvent[] = [];
  let session: string | undefined;
  let model: string | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      events.push({ kind: 'note', text: line });
      continue;
    }
    if (typeof message.session_id === 'string') session = message.session_id;
    if (message.type === 'system' && message.subtype === 'init') {
      if (typeof message.model === 'string') model = message.model;
      continue;
    }
    // Anthropic's API refused or failed, and Claude Code is trying again: said, so a wrong sign-in doesn't look like a long think.
    if (message.type === 'system' && message.subtype === 'api_retry') {
      const status = message.error_status ? `${message.error_status} ` : '';
      events.push({ kind: 'note', text: `The API answered ${status}${String(message.error ?? 'an error').replace(/_/g, ' ')} — trying again (${message.attempt}/${message.max_retries})${message.error_status === 401 ? '. Sign out and in again if this goes on.' : ''}` });
      continue;
    }
    const body = message.message as { content?: unknown } | undefined;
    if (message.type === 'assistant' && Array.isArray(body?.content)) {
      for (const part of body!.content as Record<string, unknown>[]) {
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) events.push({ kind: 'text', text: part.text });
        else if (part.type === 'thinking' && typeof part.thinking === 'string') events.push({ kind: 'thinking', text: part.thinking });
        else if (part.type === 'tool_use') events.push({ kind: 'tool', id: String(part.id ?? ''), name: String(part.name ?? 'Tool'), ...toolDetail(String(part.name ?? ''), (part.input as Record<string, unknown>) ?? {}) });
      }
    } else if (message.type === 'user' && Array.isArray(body?.content)) {
      for (const part of body!.content as Record<string, unknown>[]) {
        if (part.type === 'tool_result') events.push({ kind: 'output', id: String(part.tool_use_id ?? ''), text: textOf(part.content), error: Boolean(part.is_error) });
      }
    } else if (message.type === 'result') {
      const ok = message.subtype === 'success' && !message.is_error;
      events.push({ kind: 'done', ok, text: typeof message.result === 'string' ? message.result : String(message.subtype ?? ''), cost: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : undefined, ms: typeof message.duration_ms === 'number' ? message.duration_ms : undefined, turns: typeof message.num_turns === 'number' ? message.num_turns : undefined });
    }
  }
  return { events, session, model };
}

/** Codex's --json events, a line at a time: its thread, its messages, the commands it ran and the files it changed. */
export function parseCodex(lines: string[]): { events: CliEvent[]; session?: string; model?: string } {
  const events: CliEvent[] = [];
  let session: string | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      if (!/^\s*(WARNING|Reading prompt)/.test(line)) events.push({ kind: 'note', text: line });
      continue;
    }
    if (message.type === 'thread.started' && typeof message.thread_id === 'string') session = message.thread_id;
    const item = message.item as Record<string, unknown> | undefined;
    if (item && (message.type === 'item.completed' || message.type === 'item.started')) {
      const id = String(item.id ?? '');
      if (item.type === 'agent_message' && message.type === 'item.completed') events.push({ kind: 'text', text: String(item.text ?? '') });
      else if (item.type === 'reasoning' && message.type === 'item.completed') events.push({ kind: 'thinking', text: String(item.text ?? '') });
      else if (item.type === 'command_execution') {
        if (message.type === 'item.started') events.push({ kind: 'tool', id, name: 'Bash', detail: String(item.command ?? '') });
        else events.push({ kind: 'output', id, text: String(item.aggregated_output ?? ''), error: typeof item.exit_code === 'number' && item.exit_code !== 0 });
      } else if (item.type === 'file_change' && message.type === 'item.completed') {
        for (const change of (item.changes as { path?: string; kind?: string }[]) ?? []) events.push({ kind: 'tool', id: `${id}:${change.path}`, name: change.kind === 'add' ? 'Write' : change.kind === 'delete' ? 'Delete' : 'Edit', detail: String(change.path ?? ''), path: change.path });
      } else if (item.type === 'error' && message.type === 'item.completed') events.push({ kind: 'note', text: String(item.message ?? 'error') });
    } else if (message.type === 'turn.completed') events.push({ kind: 'done', ok: true, text: '' });
    else if (message.type === 'turn.failed' || message.type === 'error') events.push({ kind: 'done', ok: false, text: String((message.error as { message?: string })?.message ?? message.message ?? 'It stopped with an error.') });
  }
  return { events, session };
}

export const parseRun = (agent: CliAgentId, lines: string[]) => (agent === 'claude' ? parseClaude(lines) : parseCodex(lines));
