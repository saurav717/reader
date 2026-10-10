// ===========================================================================
//  The playground's agent: a conversation about a project's files, beside the
//  editor as a coding agent sits in VS Code, answered by the model the pages
//  are written with — so it works on every machine, Colab included, where no
//  terminal can host a command-line agent.
//
//  It reads the project as the editor sees it: the files in the folder, the
//  ones open, what the last commands printed. It answers with a line or two
//  and fenced blocks that say what they are — a whole file to write, a file it
//  wants to read first, a command for the console. Files it asks for are read
//  and handed back to it, a few rounds at most, before it answers; files it
//  writes land in the folder in one move, which one Undo puts back; commands
//  are buttons, and nothing runs on its own.
// ===========================================================================

import type { SDK } from './assistant';
import { explainError, modelSpec, PROVIDERS, sdk, streamModel, tag } from './assistant';
import type { Message, SystemBlock } from './assistant';
import type { FileHost } from './playground';
import { readMeta, writeMeta } from './playground';

const MAX_TOKENS = 32000;
/** How many times it may ask for files before it has to answer. */
const READ_ROUNDS = 4;
const FILE_MAX_CHARS = 60_000;
const OUTPUT_MAX_CHARS = 3_000;
const LISTED_MAX = 400;
const TURNS_KEPT = 40;

export const AGENT_SYSTEM = `You are a coding agent inside the Playground of a research-paper reader: a small project — a folder of
files — edited in the page and run on a machine the reader picked (their Google Colab runtime, or a Jupyter server
of their own, often with a GPU). You sit beside the editor, as a coding agent does in VS Code. The reader asks you
to write code, change it, fix what failed, explain it, or plan a run.

Each request comes with the project as it stands: every file's path and size, the files open in the editor in
full, the one in front of the reader marked, and the last commands run in the console with what they printed — and,
when the project started from a paper, the paper's title and abstract: asked to implement it, write its method as a
small, faithful implementation in modules of its own, a seeded experiment sized for the machine, and an evaluation.

ANSWER FORMAT — the page acts on your answer, so keep to it exactly:
- Write a file: a fenced block whose info string names it, holding the WHOLE new file, never a diff —
  \`\`\`python file=train.py
  \`\`\`text file=configs/small.yaml
  A new path makes a new file. Write only the files that change.
- Read a file first: when you need a file you were not given, answer with ONLY a block listing the paths, one per
  line, and nothing else —
  \`\`\`read
  model.py
  data/prepare.py
  \`\`\`
  They are read and given to you, and you answer again. Ask only for files in the listing.
- Suggest a command: a fenced block \`\`\`sh run holding one shell command, run in the project's folder on the
  machine — python train.py, pip install …, nvidia-smi. The reader runs it with a click; you never see it run
  until they ask again.
- Outside the fences, a few sentences at most: what you changed and why, or the answer to a question. Plain
  words; no headings. Name files by their paths.
- Code should run as written on the machine named: check torch.cuda.is_available() and fall back to the CPU with a
  smaller size rather than fail; seed what is random; print what proves it worked. Nothing that asks for input or
  credentials. Keep the reader's own style and structure; change only what the request needs.

If the request is a question, answer it in prose and write no files.`;

/** One block of a reply: a file written, a list of files to read, a command. */
export type AgentBlock = { kind: 'file'; path: string; lang: string; text: string } | { kind: 'read'; paths: string[] } | { kind: 'run'; command: string };

export interface AgentReply {
  /** The prose outside the fences. */
  note: string;
  blocks: AgentBlock[];
}

const FENCE = /^(`{3,}|~{3,})[ \t]*([A-Za-z0-9_.+-]*)([^\n]*)\n([\s\S]*?)^\1[ \t]*$/gm;

/** A path as the folder knows it: relative, forward slashes, no dots climbing out. */
export function cleanPath(raw: string): string | null {
  const path = raw.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  if (!path || path.split('/').some((part) => part === '..' || part === '')) return null;
  return path;
}

/** A reply read into its prose and its blocks; a fence that is none of the three is prose. */
export function parseAgentReply(text: string): AgentReply {
  const blocks: AgentBlock[] = [];
  const prose: string[] = [];
  let last = 0;
  for (const match of text.matchAll(FENCE)) {
    const [whole, , lang, info, body] = match;
    const at = match.index ?? 0;
    const words = `${lang} ${info}`;
    const file = /(?:^|\s)(?:file|path)=("[^"]+"|'[^']+'|\S+)/.exec(words);
    let block: AgentBlock | null = null;
    if (file) {
      const path = cleanPath(file[1]);
      if (path) block = { kind: 'file', path, lang: lang && !/=/.test(lang) ? lang : '', text: body.endsWith('\n') ? body : `${body}\n` };
    } else if (lang === 'read') {
      const paths = body.split('\n').map(cleanPath).filter((path): path is string => Boolean(path));
      if (paths.length) block = { kind: 'read', paths };
    } else if (/^(sh|bash|shell|console|zsh)$/.test(lang) && /(?:^|\s)run\b/.test(info)) {
      const command = body.replace(/^\s*\$\s?/gm, '').trim();
      if (command) block = { kind: 'run', command };
    }
    if (!block) continue;
    prose.push(text.slice(last, at));
    last = at + whole.length;
    blocks.push(block);
  }
  prose.push(text.slice(last));
  // Two files of the same path: the later one is the answer.
  const files = new Map<string, number>();
  blocks.forEach((block, index) => block.kind === 'file' && files.set(block.path, index));
  const kept = blocks.filter((block, index) => block.kind !== 'file' || files.get(block.path) === index);
  return { note: prose.join('').replace(/\n{3,}/g, '\n\n').trim(), blocks: kept };
}

/** Whether a reply only asks to read files: the page reads them and asks again. */
export const onlyReads = (reply: AgentReply) => reply.blocks.length > 0 && reply.blocks.every((block) => block.kind === 'read');

const clip = (text: string | undefined, max: number) => (!text ? '' : text.length > max ? `${text.slice(0, max)}\n[…cut at ${max.toLocaleString('en')} characters]` : text);

/** What the agent is given with each request: the project as the editor sees it. */
export interface ProjectView {
  /** Where the files live and where they run, in words. */
  where: string;
  /** Every file in the folder, with its size. */
  listing: { path: string; size: number | null }[];
  /** The files open in the editor, what is on screen (unsaved edits included). */
  open: { path: string; text: string; active: boolean; unsaved: boolean }[];
  /** The last commands, newest last, with what they printed. */
  console: { command: string; output: string; state: string }[];
  /** The paper the project cites, when it started from one: what "implement the paper" means. */
  paper?: { title: string; authors?: string[]; published?: string; abstract?: string };
}

export function projectBlock(view: ProjectView): string {
  const listing = view.listing.length
    ? view.listing
        .slice(0, LISTED_MAX)
        .map((file) => `${file.path}${file.size !== null ? ` (${file.size.toLocaleString('en')} B)` : ''}`)
        .join('\n') + (view.listing.length > LISTED_MAX ? `\n[…and ${view.listing.length - LISTED_MAX} more]` : '')
    : 'The folder is empty.';
  const open = view.open.map((file) => tag('file', clip(file.text, FILE_MAX_CHARS) || '(empty)', { path: file.path, in_front: file.active ? 'yes' : '', unsaved: file.unsaved ? 'yes — what is on screen, not yet saved' : '' })).join('\n\n');
  const runs = view.console.map((entry) => tag('command', `$ ${entry.command}\n${clip(entry.output, OUTPUT_MAX_CHARS) || '(nothing printed)'}`, { state: entry.state })).join('\n\n');
  const paper = view.paper
    ? tag(
        'paper',
        [view.paper.title, view.paper.authors?.length ? `by ${view.paper.authors.slice(0, 6).join(', ')}` : '', view.paper.published ? `(${view.paper.published.slice(0, 4)})` : ''].filter(Boolean).join(' ') +
          (view.paper.abstract ? `\n\nAbstract: ${view.paper.abstract.replace(/\s+/g, ' ').trim()}` : ''),
      )
    : '';
  return [paper, tag('where', view.where), tag('files', listing), tag('open_files', open), tag('console', runs)].filter(Boolean).join('\n\n');
}

/** Every file under `path`, depth first, as far as `max` files: what the listing shows the agent. */
export async function listAll(host: FileHost, max = LISTED_MAX + 50, path = '', out: { path: string; size: number | null }[] = [], depth = 0): Promise<{ path: string; size: number | null }[]> {
  if (out.length >= max || depth > 6) return out;
  const entries = await host.list(path).catch(() => []);
  for (const entry of entries) {
    if (out.length >= max) break;
    if (entry.type === 'directory') {
      if (/^(\.git|\.reader|__pycache__|node_modules|\.ipynb_checkpoints|\.venv|venv|wandb)$/.test(entry.name)) continue;
      await listAll(host, max, entry.path, out, depth + 1);
    } else out.push({ path: entry.path, size: entry.size });
  }
  return out;
}

// ------------------------------------------------------------- the store ---

/** A file the agent wrote: what was there before, for Undo, and how much changed. */
export interface AgentChange {
  path: string;
  /** null: the file is new. Left out, with `after`, on an older answer saved without its text: it can't be undone. */
  before?: string | null;
  after?: string;
  added: number;
  removed: number;
}

export interface AgentTurn {
  role: 'user' | 'agent';
  text: string;
  at: number;
  /** The agent's: the files it read on the way, the files it wrote, the commands it suggests. */
  read?: string[];
  changes?: AgentChange[];
  commands?: string[];
  model?: string;
  /** Set once Undo has put its files back. */
  undone?: boolean;
  /** Cut short: the answer ran out of room. */
  cut?: boolean;
}

export interface AgentPending {
  request: string;
  reply: string;
  thinking?: string;
  started: number;
  /** What it is doing now, in words: reading files, writing. */
  step: string;
  read: string[];
  error?: string;
}

/** A conversation as it is kept: its turns, when it started, and a title from its first request. */
export interface SavedChat {
  id: string;
  title: string;
  started: number;
  updated: number;
  turns: AgentTurn[];
}

export interface AgentChat {
  /** The conversation in the panel. */
  id: string;
  started: number;
  turns: AgentTurn[];
  /** The earlier ones, newest first, as the project's folder keeps them. */
  history: SavedChat[];
  pending?: AgentPending;
  /** Whether the folder's copy has been read; and why not, when it couldn't be. */
  loaded?: boolean;
  problem?: string;
}

/**
 * The conversations live in the project's own folder, beside its code —
 * `.reader/agent.json`, in Drive, on the computer or on the machine, wherever
 * the person chose to keep the files — so they open again in any browser, and
 * nothing of them is kept in this one. The model's API keeps nothing: each
 * request carries the conversation itself.
 */
export const AGENT_FILE = '.reader/agent.json';
const AGENT_NAME = 'agent.json';
const CHATS_KEPT = 20;
/** The answers whose files' text is kept, for Undo: the newest few; older ones keep their paths and counts. */
const UNDOABLE_KEPT = 6;

interface AgentFile {
  generator: 'reader';
  version: 1;
  chats: SavedChat[];
}

const newId = () => Math.random().toString(36).slice(2, 10);
const titleOf = (turns: AgentTurn[]) => {
  const first = turns.find((turn) => turn.role === 'user')?.text.trim() ?? '';
  return first.length > 70 ? `${first.slice(0, 70)}…` : first || 'A conversation';
};

/** A chat as it is written: only the newest answers keep their files' text, so the file stays small. */
export function slimChat(chat: SavedChat): SavedChat {
  let left = UNDOABLE_KEPT;
  const turns = [...chat.turns]
    .reverse()
    .map((turn) => {
      if (!turn.changes?.length) return turn;
      if (left > 0 && !turn.undone) {
        left--;
        return turn;
      }
      return { ...turn, changes: turn.changes.map(({ before: _b, after: _a, ...rest }) => rest) };
    })
    .reverse();
  return { ...chat, turns };
}

/** The file read back, checked enough that a stray or hand-edited one can't break the panel. */
export function parseAgentFile(text: string | null): SavedChat[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as Partial<AgentFile>;
    if (!Array.isArray(parsed.chats)) return [];
    return parsed.chats.filter((chat) => chat && typeof chat.id === 'string' && Array.isArray(chat.turns)).map((chat) => ({ ...chat, title: String(chat.title ?? titleOf(chat.turns)), started: Number(chat.started) || 0, updated: Number(chat.updated) || 0 }));
  } catch {
    return [];
  }
}

/** Two lists of chats as one: by id, the one changed last; newest first; empty ones left out. */
export function mergeChats(a: SavedChat[], b: SavedChat[]): SavedChat[] {
  const byId = new Map<string, SavedChat>();
  for (const chat of [...a, ...b]) {
    const held = byId.get(chat.id);
    if (!held || chat.updated > held.updated) byId.set(chat.id, chat);
  }
  return [...byId.values()].filter((chat) => chat.turns.length).sort((x, y) => y.updated - x.updated).slice(0, CHATS_KEPT);
}

const chats = new Map<string, AgentChat>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
let running: { projectId: string; abort: () => void } | null = null;
const EMPTY: AgentChat = { id: '', started: 0, turns: [], history: [] };

export function subscribeAgent(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const agentChatFor = (projectId: string): AgentChat => chats.get(projectId) ?? EMPTY;
export const isAgentRunning = (projectId: string) => running?.projectId === projectId;

const update = (projectId: string, patch: Partial<AgentChat>) => {
  const now = chats.get(projectId) ?? { ...EMPTY, id: newId(), started: Date.now() };
  chats.set(projectId, { ...now, ...patch });
  notify();
};

/** The conversation in the panel, as it is kept. */
const currentChat = (chat: AgentChat): SavedChat => ({ id: chat.id, title: titleOf(chat.turns), started: chat.started, updated: chat.turns[chat.turns.length - 1]?.at ?? chat.started, turns: chat.turns });

/** The conversations, read from the project's folder: the newest open in the panel, the rest under History. */
export async function loadAgentChats(projectId: string, host: FileHost) {
  const here = chats.get(projectId);
  if (here?.loaded || isAgentRunning(projectId)) return;
  try {
    const saved = parseAgentFile(await readMeta(host, AGENT_NAME));
    const now = chats.get(projectId);
    const all = mergeChats(saved, now?.turns.length ? [currentChat(now), ...now.history] : now?.history ?? []);
    const open = now?.turns.length ? all.find((chat) => chat.id === now.id) ?? currentChat(now) : all[0];
    update(projectId, { ...(open ? { id: open.id, started: open.started, turns: open.turns } : {}), history: all.filter((chat) => chat.id !== open?.id), loaded: true, problem: undefined });
  } catch (error) {
    update(projectId, { loaded: false, problem: `The conversations couldn’t be read from the project’s folder: ${error instanceof Error ? error.message : String(error)}` });
  }
}

/** The conversations, written to the project's folder — merged with what is there, so two browsers keep both. */
export async function saveAgentChats(projectId: string, host: FileHost) {
  const chat = chats.get(projectId);
  if (!chat) return;
  try {
    const there = parseAgentFile(await readMeta(host, AGENT_NAME));
    const all = mergeChats(there, [currentChat(chat), ...chat.history]).map(slimChat);
    const body: AgentFile = { generator: 'reader', version: 1, chats: all };
    await writeMeta(host, AGENT_NAME, `${JSON.stringify(body, null, 1)}\n`);
    if (chat.problem) update(projectId, { problem: undefined });
  } catch (error) {
    update(projectId, { problem: `This conversation isn’t saved: ${error instanceof Error ? error.message : String(error)}` });
  }
}

/** A new conversation; the one in the panel goes under History. */
export function clearAgentChat(projectId: string, host: FileHost) {
  if (isAgentRunning(projectId)) return;
  const chat = agentChatFor(projectId);
  const history = chat.turns.length ? mergeChats([currentChat(chat)], chat.history) : chat.history;
  update(projectId, { id: newId(), started: Date.now(), turns: [], history, pending: undefined });
  void saveAgentChats(projectId, host);
}

/** An earlier conversation, back in the panel; the one there goes under History. */
export function openAgentChat(projectId: string, id: string) {
  if (isAgentRunning(projectId)) return;
  const chat = agentChatFor(projectId);
  const picked = chat.history.find((c) => c.id === id);
  if (!picked) return;
  const history = mergeChats(chat.turns.length ? [currentChat(chat)] : [], chat.history.filter((c) => c.id !== id));
  update(projectId, { id: picked.id, started: picked.started, turns: picked.turns, history, pending: undefined });
}
export function stopAgent() {
  running?.abort();
}
export function dismissAgentError(projectId: string) {
  update(projectId, { pending: undefined });
}

/** Lines added and removed, as a line diff counts them: the shared head and tail left out, the rest compared as sets of lines. */
export function lineDelta(before: string | null, after: string): { added: number; removed: number } {
  const a = before === null ? [] : before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const old = a.slice(head, a.length - tail);
  const now = b.slice(head, b.length - tail);
  const pool = new Map<string, number>();
  old.forEach((line) => pool.set(line, (pool.get(line) ?? 0) + 1));
  let same = 0;
  for (const line of now) {
    const left = pool.get(line) ?? 0;
    if (left > 0) {
      same++;
      pool.set(line, left - 1);
    }
  }
  return { added: now.length - same, removed: old.length - same };
}

/** The conversation so far as the model reads it: the requests and its own answers, the project only with the newest. */
function historyMessages(turns: AgentTurn[]): Message[] {
  const out: Message[] = [];
  for (const turn of turns.slice(-12)) {
    const text = turn.role === 'user' ? turn.text : [turn.text, turn.changes?.length ? `(Wrote ${turn.changes.map((c) => c.path).join(', ')}${turn.undone ? ' — the reader undid this' : ''}.)` : '', turn.commands?.length ? `(Suggested: ${turn.commands.join(' ; ')})` : ''].filter(Boolean).join('\n');
    if (!text.trim()) continue;
    const role = turn.role === 'user' ? 'user' : 'assistant';
    // Turns alternate; two in a row of one side are joined.
    const prev = out[out.length - 1];
    if (prev && prev.role === role && typeof prev.content === 'string') prev.content = `${prev.content}\n\n${text}`;
    else out.push({ role, content: text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

/**
 * One request to the agent: streamed, its reads answered, its files written.
 * The folder changes only when the whole answer is in, so a half-written file
 * is never saved; `onWrote` lets the editor take the new text of files it has open.
 */
export async function askAgent(params: { projectId: string; model: string; request: string; host: FileHost; view: () => Promise<ProjectView>; onWrote?: (changes: AgentChange[]) => void }): Promise<void> {
  const { projectId, model, host } = params;
  const request = params.request.trim();
  if (!request || running) return;
  // The folder couldn't be read when the panel opened (the machine wasn't connected): its conversations first, so this one joins them.
  if (!chats.get(projectId)?.loaded) await loadAgentChats(projectId, host);
  const before = agentChatFor(projectId).turns;
  const userTurn: AgentTurn = { role: 'user', text: request, at: Date.now() };
  const pending: AgentPending = { request, reply: '', started: Date.now(), step: 'Reading the project', read: [] };
  update(projectId, { turns: [...before, userTurn].slice(-TURNS_KEPT), pending: { ...pending } });
  let SDK: SDK | null = null;
  const writer = PROVIDERS[modelSpec(model).provider].name;
  try {
    if (modelSpec(model).provider === 'anthropic') SDK = await sdk();
    const view = await params.view();
    const system: SystemBlock[] = [{ type: 'text', text: AGENT_SYSTEM, cache_control: { type: 'ephemeral' } }];
    const messages: Message[] = [...historyMessages(before), { role: 'user', content: `${projectBlock(view)}\n\nRequest: ${request}` }];
    if (messages.length > 1 && messages[messages.length - 2].role === 'user') messages.splice(messages.length - 2, 1);
    const known = new Set(view.listing.map((file) => file.path));
    let reply: AgentReply = { note: '', blocks: [] };
    let stop: string | null = null;
    for (let round = 0; ; round++) {
      pending.reply = '';
      pending.thinking = undefined;
      pending.step = round ? `Reading ${pending.read.slice(-3).join(', ')}` : 'Thinking';
      update(projectId, { pending: { ...pending } });
      const stream = await streamModel({ model, maxTokens: MAX_TOKENS, system, messages, effort: 'medium' });
      running = { projectId, abort: () => stream.abort() };
      let frame = 0;
      const paint = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          update(projectId, { pending: { ...pending } });
        });
      };
      stream.on('thinking', (delta: string) => {
        pending.thinking = `${pending.thinking ?? ''}${delta}`;
        paint();
      });
      stream.on('text', (delta: string) => {
        pending.reply += delta;
        pending.thinking = undefined;
        pending.step = /```[^\n]*file=/.test(pending.reply) ? 'Writing' : 'Answering';
        paint();
      });
      const final = await stream.finalMessage();
      if (frame) cancelAnimationFrame(frame);
      stop = final.stop_reason;
      if (stop === 'refusal') throw new Error(`${writer} declined that request.`);
      reply = parseAgentReply(pending.reply);
      if (!onlyReads(reply) || round >= READ_ROUNDS) break;
      // The files it asked for, read now and handed back.
      const paths = [...new Set(reply.blocks.flatMap((block) => (block.kind === 'read' ? block.paths : [])))].slice(0, 12);
      const read = await Promise.all(
        paths.map(async (path) => {
          if (!known.has(path)) return tag('file', 'There is no such file in the folder.', { path });
          const text = await host.read(path).catch(() => null);
          return tag('file', text === null ? 'It could not be read.' : clip(text, FILE_MAX_CHARS) || '(empty)', { path });
        }),
      );
      pending.read.push(...paths.filter((path) => known.has(path)));
      messages.push({ role: 'assistant', content: pending.reply }, { role: 'user', content: `${read.join('\n\n')}\n\nNow answer the request.` });
    }
    // The files, written in one move; what was there before is kept for Undo.
    const changes: AgentChange[] = [];
    for (const block of reply.blocks) {
      if (block.kind !== 'file') continue;
      const old = known.has(block.path) ? await host.read(block.path).catch(() => null) : null;
      if (old === block.text) continue;
      await host.write(block.path, block.text);
      changes.push({ path: block.path, before: old, after: block.text, ...lineDelta(old, block.text) });
    }
    const commands = reply.blocks.flatMap((block) => (block.kind === 'run' ? [block.command] : []));
    if (!reply.note && !changes.length && !commands.length) throw new Error(`${writer} answered with nothing the page could use.${stop === 'max_tokens' ? ' It ran out of room — ask for less at once.' : ''}`);
    const agentTurn: AgentTurn = { role: 'agent', text: reply.note, at: Date.now(), model, ...(pending.read.length ? { read: [...pending.read] } : {}), ...(changes.length ? { changes } : {}), ...(commands.length ? { commands } : {}), ...(stop === 'max_tokens' ? { cut: true } : {}) };
    update(projectId, { pending: undefined, turns: [...agentChatFor(projectId).turns, agentTurn].slice(-TURNS_KEPT) });
    if (changes.length) params.onWrote?.(changes);
  } catch (error) {
    const message = explainError(error, SDK);
    update(projectId, { pending: message === 'Stopped.' ? undefined : { ...pending, error: message } });
  } finally {
    running = null;
  }
  await saveAgentChats(projectId, host);
}

/** Undo one answer: its files put back as they were (a new file is left empty — the folder has no delete). */
export async function undoAgentTurn(projectId: string, at: number, host: FileHost, onWrote?: (changes: AgentChange[]) => void) {
  const turn = agentChatFor(projectId).turns.find((t) => t.at === at && t.role === 'agent');
  if (!turn?.changes?.length || turn.undone || !canUndo(turn)) return;
  const back: AgentChange[] = [];
  for (const change of turn.changes) {
    const text = change.before ?? '';
    await host.write(change.path, text);
    back.push({ ...change, before: change.after, after: text });
  }
  update(projectId, { turns: agentChatFor(projectId).turns.map((t) => (t === turn ? { ...t, undone: true } : t)) });
  onWrote?.(back);
  await saveAgentChats(projectId, host);
}

/** Whether an answer still has its files' text, so Undo can put them back. */
export const canUndo = (turn: AgentTurn) => Boolean(turn.changes?.every((change) => change.after !== undefined));
