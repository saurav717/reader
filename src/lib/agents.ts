/**
 * The coding agents a playground's agent pane can run, and how each is
 * started: its command, and the options it takes on its command line — the
 * model, how much it may do without asking, a conversation carried on —
 * written out as flags. Once it runs, its own slash commands and keys are a
 * click away. Anything not here goes in as extra arguments, as typed.
 *
 * The ids are the commands the Companion looks for on the machine
 * (companion/reader_companion/tools.py).
 */

export interface AgentChoice {
  key: string;
  label: string;
  flag: string;
  /** How the value is written after the flag, `{}` standing for it: `model_reasoning_effort={}`. */
  template?: string;
  /** The first, with value '', is the agent's own default: no flag at all. */
  values: { value: string; label: string }[];
}

export interface AgentSpec {
  id: string;
  name: string;
  /** What installs it, typed into the pane's terminal. */
  install: string;
  /** What starts it, when not just its id. */
  run?: string;
  model?: { flag: string; suggestions?: string[]; placeholder?: string };
  choices?: AgentChoice[];
  toggles?: { key: string; label: string; flag: string }[];
  /** Carrying on the last conversation in this folder: a flag, or a command of its own. */
  resume?: { flag?: string; run?: string };
  /** Its own commands, typed in while it runs. */
  slash?: string[];
}

export interface AgentOptions {
  model?: string;
  choices?: Record<string, string>;
  toggles?: Record<string, boolean>;
  resume?: boolean;
  extra?: string;
}

const DEFAULT = { value: '', label: 'Its default' };

export const AGENTS: AgentSpec[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    install: 'npm install -g @anthropic-ai/claude-code',
    model: { flag: '--model', suggestions: ['opus', 'sonnet', 'haiku', 'opusplan', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'], placeholder: 'the account’s default' },
    choices: [
      {
        key: 'permission',
        label: 'Permissions',
        flag: '--permission-mode',
        values: [DEFAULT, { value: 'default', label: 'Ask each time' }, { value: 'acceptEdits', label: 'Accept edits' }, { value: 'plan', label: 'Plan only' }, { value: 'auto', label: 'Auto' }, { value: 'bypassPermissions', label: 'Bypass permissions' }],
      },
    ],
    resume: { flag: '--continue' },
    slash: ['/model', '/permissions', '/compact', '/clear', '/resume', '/cost', '/status', '/mcp', '/init', '/help'],
  },
  {
    id: 'codex',
    name: 'Codex',
    install: 'npm install -g @openai/codex',
    model: { flag: '--model', placeholder: 'the account’s default' },
    choices: [
      { key: 'approval', label: 'Approvals', flag: '--ask-for-approval', values: [DEFAULT, { value: 'untrusted', label: 'Untrusted commands' }, { value: 'on-request', label: 'When it asks' }, { value: 'on-failure', label: 'On failure' }, { value: 'never', label: 'Never' }] },
      { key: 'sandbox', label: 'Sandbox', flag: '--sandbox', values: [DEFAULT, { value: 'read-only', label: 'Read only' }, { value: 'workspace-write', label: 'Write in the folder' }, { value: 'danger-full-access', label: 'Full access' }] },
      { key: 'effort', label: 'Reasoning', flag: '-c', template: 'model_reasoning_effort={}', values: [DEFAULT, { value: 'minimal', label: 'Minimal' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] },
    ],
    resume: { run: 'codex resume --last' },
    slash: ['/model', '/approvals', '/status', '/diff', '/compact', '/new', '/init', '/mcp'],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    install: 'npm install -g @google/gemini-cli',
    model: { flag: '--model', placeholder: 'the account’s default' },
    choices: [{ key: 'approval', label: 'Approvals', flag: '--approval-mode', values: [DEFAULT, { value: 'default', label: 'Ask each time' }, { value: 'auto_edit', label: 'Accept edits' }, { value: 'yolo', label: 'Accept everything' }] }],
    slash: ['/stats', '/compress', '/clear', '/tools', '/mcp', '/memory', '/help'],
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    install: 'npm install -g @github/copilot',
    model: { flag: '--model', placeholder: 'the account’s default' },
    toggles: [{ key: 'all', label: 'Allow every tool without asking', flag: '--allow-all-tools' }],
    slash: ['/model', '/help'],
  },
  {
    id: 'cursor-agent',
    name: 'Cursor Agent',
    install: 'curl https://cursor.com/install -fsS | bash',
    model: { flag: '--model', placeholder: 'the account’s default' },
    toggles: [{ key: 'force', label: 'Run commands without asking', flag: '--force' }],
    slash: ['/model', '/help'],
  },
  {
    id: 'aider',
    name: 'Aider',
    install: 'pipx install aider-chat',
    model: { flag: '--model', placeholder: 'from its settings' },
    toggles: [{ key: 'yes', label: 'Say yes to every question', flag: '--yes-always' }],
    resume: { flag: '--restore-chat-history' },
    slash: ['/model', '/add', '/drop', '/diff', '/undo', '/tokens', '/clear', '/help'],
  },
  {
    id: 'opencode',
    name: 'opencode',
    install: 'npm install -g opencode-ai',
    model: { flag: '--model', placeholder: 'provider/model' },
    resume: { flag: '--continue' },
    slash: ['/models', '/new', '/help'],
  },
  { id: 'goose', name: 'Goose', install: 'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash', run: 'goose session', resume: { flag: '--resume' } },
  { id: 'amp', name: 'Amp', install: 'npm install -g @sourcegraph/amp' },
  {
    id: 'qwen',
    name: 'Qwen Code',
    install: 'npm install -g @qwen-code/qwen-code',
    model: { flag: '--model', placeholder: 'the account’s default' },
    toggles: [{ key: 'yolo', label: 'Accept everything', flag: '--yolo' }],
    slash: ['/stats', '/compress', '/clear', '/tools', '/help'],
  },
];

/** Keys an agent's terminal takes while it runs: interrupt, cycle its mode, stop. */
export const AGENT_KEYS = [
  { label: 'Esc', text: '\x1b', title: 'Interrupt it (Esc)' },
  { label: '⇧Tab', text: '\x1b[Z', title: 'Cycle its mode — Claude Code’s permissions (Shift+Tab)' },
  { label: '^C', text: '\x03', title: 'Stop (Ctrl+C)' },
];

/** A word as a shell takes it — the same single quotes in sh, zsh, bash and PowerShell. */
export const shellWord = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

/** The command that starts `spec` with `options`. */
export function agentCommand(spec: AgentSpec, options: AgentOptions = {}): string {
  const resume = options.resume && spec.resume;
  const parts = [resume && spec.resume?.run ? spec.resume.run : spec.run ?? spec.id];
  const model = options.model?.trim();
  if (model && spec.model) parts.push(spec.model.flag, shellWord(model));
  for (const choice of spec.choices ?? []) {
    const value = options.choices?.[choice.key];
    if (value && choice.values.some((v) => v.value === value)) parts.push(choice.flag, shellWord(choice.template ? choice.template.replace('{}', value) : value));
  }
  for (const toggle of spec.toggles ?? []) if (options.toggles?.[toggle.key]) parts.push(toggle.flag);
  if (resume && spec.resume?.flag) parts.push(spec.resume.flag);
  const extra = options.extra?.trim();
  if (extra) parts.push(extra);
  return parts.join(' ');
}

const OPTIONS_KEY = 'reader.agentOptions';

/** The options last used with each agent, kept in this browser. */
export function savedAgentOptions(): Record<string, AgentOptions> {
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, AgentOptions>) : {};
  } catch {
    return {};
  }
}

export function saveAgentOptions(all: Record<string, AgentOptions>) {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(all));
  } catch {
    // private mode: the defaults next time
  }
}
