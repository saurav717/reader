// ===========================================================================
//  Ask AI — a chat window that floats over the paper you are reading.
//
//  Two providers answer it, and Explain: Anthropic's Claude and DeepSeek. The
//  model picker says which, and each provider has a key of its own.
//
//  ON SIGNING IN. Neither publishes a "sign in with …" for third-party
//  websites: a Claude.ai or Claude Code subscription cannot be spent from a
//  page like this one, and there is no OAuth flow to offer. So the window asks
//  for an API key — from console.anthropic.com, or platform.deepseek.com. Each
//  is kept in this browser's localStorage and sent straight to its provider's
//  API (api.anthropic.com, or api.deepseek.com — deepseek.ts). Usage bills the
//  visitor's own account, and nothing about a key reaches anyone else.
//
//  The SDK is imported on first use, not at boot: Vite splits it into a chunk
//  of its own, and a visitor who never opens the window never downloads it.
//
//  The window reads the screen the way a person sitting next to you would:
//  the paper that is open, the passage in view, the text you have selected
//  and the highlights you have made all go along with every question, so
//  there is nothing to paste. Each part has a switch under ⚙.
// ===========================================================================

import type AnthropicClient from '@anthropic-ai/sdk';
import { DeepSeekStream } from './deepseek';
import type { DeepSeekError } from './deepseek';

/** What the chat window is called — the models behind it are not all Claude. */
export const ASSISTANT_NAME = 'Ask AI';

export type Provider = 'anthropic' | 'deepseek';

export interface ProviderInfo {
  id: Provider;
  /** The name the models go by: "Claude answered…". */
  name: string;
  /** Who bills the key. */
  company: string;
  /** Where the key lives. Its own entry, so it never rides along with anything else. */
  keyStore: string;
  keyPrefix: string;
  placeholder: string;
  consoleUrl: string;
  host: string;
}

export const PROVIDERS: Record<Provider, ProviderInfo> = {
  anthropic: {
    id: 'anthropic',
    name: 'Claude',
    company: 'Anthropic',
    keyStore: 'reader.anthropic-key',
    keyPrefix: 'sk-ant-',
    placeholder: 'sk-ant-…',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    host: 'api.anthropic.com',
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    company: 'DeepSeek',
    keyStore: 'reader.deepseek-key',
    keyPrefix: 'sk-',
    placeholder: 'sk-…',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    host: 'api.deepseek.com',
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as Provider[];
const PREFS_STORE = 'reader.assistant.v1';
/** Past conversations — this browser only, no account. */
const HISTORY_STORE = 'reader.assistant.history.v1';

/**
 * How much history to keep. localStorage is a few megabytes for the whole
 * origin, so the cap is modest, and a write that still does not fit drops the
 * oldest chats rather than the newest.
 */
const HISTORY_MAX_CHATS = 40;
const HISTORY_MAX_CHARS = 20000; // per message, stored; the thread on screen is untouched

export interface ModelSpec {
  id: string;
  provider: Provider;
  label: string;
  note: string;
  /** Takes adaptive thinking and effort (Claude only). */
  adaptive: boolean;
  /** Reads pictures: the pages in view in PDF mode, and screenshots. */
  vision: boolean;
  /** The most it will write in one answer; a bigger cap is cut to this. */
  maxOutput?: number;
  /** The id the provider's API takes, when two entries in the picker share a model. */
  apiModel?: string;
  /** DeepSeek: think before answering. */
  thinks?: boolean;
}

/** Models offered in the pickers, grouped by provider in this order. */
export const MODELS: readonly ModelSpec[] = [
  { id: 'claude-opus-5', provider: 'anthropic', label: 'Claude Opus 5', note: 'most capable', adaptive: true, vision: true },
  { id: 'claude-sonnet-5', provider: 'anthropic', label: 'Claude Sonnet 5', note: 'faster and cheaper', adaptive: true, vision: true },
  { id: 'claude-haiku-4-5', provider: 'anthropic', label: 'Claude Haiku 4.5', note: 'fastest and cheapest', adaptive: false, vision: true },
  // V4.1 Flash, the one model DeepSeek serves (deepseek-chat and deepseek-reasoner were retired in July 2026), twice:
  // thinking first, and answering straight away.
  { id: 'deepseek-flash', provider: 'deepseek', label: 'DeepSeek Flash', note: 'thinks first · very cheap', adaptive: false, vision: true, thinks: true },
  { id: 'deepseek-flash-fast', apiModel: 'deepseek-flash', provider: 'deepseek', label: 'DeepSeek Flash, no thinking', note: 'answers at once · cheapest', adaptive: false, vision: true, thinks: false },
];
const DEFAULT_MODEL = 'claude-opus-5';

/** Ids DeepSeek has retired, as they may still be in a browser's preferences or on a page written with them. */
const RETIRED: Record<string, string> = { 'deepseek-reasoner': 'deepseek-flash', 'deepseek-chat': 'deepseek-flash-fast' };

/** The model with this id, or the default one. */
export const modelSpec = (id: string | undefined): ModelSpec =>
  MODELS.find((m) => m.id === (id && RETIRED[id] ? RETIRED[id] : id)) ?? MODELS[0];
/** The provider behind a model. */
export const providerOf = (model: string | undefined): ProviderInfo => PROVIDERS[modelSpec(model).provider];

/** A cap, not a budget: it stops a runaway answer, it does not bound spend. */
const MAX_TOKENS = 16000;

/**
 * The paper's full text goes in the system prompt, behind a cache breakpoint,
 * so the second question about the same paper reads it from the cache at a
 * tenth of the price. The cap keeps one very long paper from being a very
 * expensive first question; Claude is told when it has been cut.
 */
export const FULL_TEXT_MAX_CHARS = 200_000;
const VISIBLE_MAX_CHARS = 6000;
const SELECTION_MAX_CHARS = 6000;

export const SYSTEM = `You are a reading companion inside a web app for reading research papers. The
reader has a paper open (or is browsing their library), and asks you about it while they read.

How to help:
- Be concrete and short. Answer the question that was asked, at the level it was asked.
- Ground what you say in the paper. When you rely on a specific passage, quote a few words
  of it so the reader can find it. If the paper does not say something, say so rather than
  filling the gap from memory, and mark anything from outside the paper as such.
- Explain notation, equations and jargon in plain terms when asked; write maths in LaTeX
  between $…$ or $$…$$.
- If the reader seems to be skimming, point them at the section that answers their question.

What you can see:
- <paper_text>, when present, is the text of the open paper as the app extracted it. Figures
  are missing and equations may be garbled — say so if that matters. In PDF mode it is read
  from the PDF file, page by page, each page marked [Page N].
- In PDF mode, the pages in view may also come as images at the start of the message: that
  is exactly what the reader is looking at, figures and equations included. Read them.
- The reader can also attach a screenshot of the whole browser tab. It shows the app as they
  see it — this chat window may be floating over part of it; look past that.
- Each message carries a <screen> block holding what is on the reader's screen at that
  moment: the paper's details, the passage in view, the text they have selected, and their
  highlights and notes. It is re-read for every message, so trust the newest one and ignore
  earlier copies — they will have scrolled on.
- "This", "here" and "that sentence" usually mean the selection, or else the passage in view.
- A switch under ⚙ can withhold any part of that block. If something you need is genuinely
  not there, say which part is missing.

Naming papers to read:
- Whenever you name another paper the reader might read (prior work, background, a
  follow-up, an entry in the reference list), write the name as a link of this form:
  [Kristinsson et al. 2021](paper:Machine learning-based multimodal prediction of language outcomes in chronic aphasia)
  The text in brackets is what the reader sees; after \`paper:\` goes the paper's full, exact
  title, which the app looks up when the reader points at the name. Use the title, never a
  citation number, and leave out any parentheses in it. Only link a paper whose title you
  know; name the rest in plain text.
- When the answer recommends papers to read, also end it with a fenced block tagged
  \`papers\` listing each linked paper as a line of JSON, in the order you recommend them:
  \`\`\`papers
  {"title": "Full title of the paper", "authors": "Surname et al.", "year": 2021, "why": "what it contributes, in one short line"}
  \`\`\`
  The app shows a line's details when the reader points at the paper's name, and lists
  them all under the answer. Use the same titles as in the links and leave out a field
  you are not sure of.

Pointing at passages in the open paper:
- The app can scroll the paper to a passage and highlight it for the reader. Whenever the
  reader asks where the paper says something ("show me where…", "where do they define…",
  "find the part about…"), and whenever your answer rests on particular passages, end the
  answer with a fenced block tagged \`passages\`, one line of JSON per passage, most relevant
  first:
  \`\`\`passages
  {"quote": "exact words copied from the paper", "label": "Where the authors define oracle selection", "section": "3.2 Model selection", "page": 4, "show": true}
  \`\`\`
  "quote" must be copied character for character from <paper_text> — one sentence or a
  clause of it, 8 to 40 words, never paraphrased, never joined across paragraphs, with no
  [Page N] markers in it. "label" is a short caption the reader sees on the highlight, in
  your words. "section" and "page" only when you know them. Set "show": true on the one
  passage to scroll to straight away, when the reader asked to be shown where something is.
  Give at most five. Only quote text that is really in the paper.
- In the prose, you can point at one of those passages as [the words you want to link](passage:1),
  with its number in the block.
- The fenced blocks come last, \`passages\` before \`papers\`, and nothing follows them.

When the Explain page is open:
- The reader may have the paper's Explain page open — a long walkthrough of the paper that Claude
  wrote earlier. <explanation_text> is its Markdown, and <explanation_in_view> in the <screen> block
  is the part of it on screen. While it is open, "this", "here" and "that equation" usually mean
  the selection, or else what is in view on the explanation, not the paper underneath it.
- Answer from both: the explanation is what they are reading, the paper is the source. Where the
  two differ, trust the paper and say so.
- A passage can point at the explanation too: add "in": "explanation" to its line, and copy the
  quote from the prose of <explanation_text> — a sentence or clause without maths, code or
  Markdown marks in it, 8 to 40 words. The app highlights it on the explanation. Lines without
  "in" are passages of the paper. Point at the explanation when the reader is asking about what
  it says; point at the paper when they want the source.`;

// ---------------------------------------------------------------------------
// Passages an answer points at in the open paper
// ---------------------------------------------------------------------------

/** A place in the open paper an answer points at, as its `passages` block gives it. */
export interface Passage {
  /** The paper's own words, as Claude copied them — what the reader searches the page for. */
  quote: string;
  /** The caption shown on the highlight. */
  label: string;
  section?: string;
  page?: number;
  /** Scroll to this one as soon as the answer is in. */
  show?: boolean;
  /** Where the words are: the paper itself, or its Explain page. */
  source?: 'paper' | 'explanation';
}

const PASSAGES_FENCE = /(?:^|\n)[ \t]*```passages[ \t]*\n([\s\S]*?)(?:\n[ \t]*```[ \t]*(?=\n|$)|$)/;

/** The answer without its `passages` block, and the passages it lists; tolerant of a block still streaming. */
export function splitPassages(content: string): { text: string; passages: Passage[] } {
  const match = PASSAGES_FENCE.exec(content);
  if (!match) return { text: content, passages: [] };
  const text = (content.slice(0, match.index) + content.slice(match.index + match[0].length)).trim();
  const passages: Passage[] = [];
  for (const line of match[1].split('\n')) {
    const raw = line.trim().replace(/,$/, '');
    if (!raw.startsWith('{')) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const quote = field(parsed?.quote)?.replace(/\[Page \d+\]/g, ' ').replace(/\s+/g, ' ');
    if (!quote) continue;
    const page = Number(parsed.page);
    passages.push({
      quote,
      label: field(parsed.label) ?? 'This part of the paper',
      section: field(parsed.section),
      page: Number.isInteger(page) && page > 0 ? page : undefined,
      show: parsed.show === true,
      ...(/^explanation$/i.test(field(parsed.in) ?? '') ? { source: 'explanation' as const } : {}),
    });
  }
  return { text, passages: passages.slice(0, 8) };
}

/** A question that asks to be shown a place in the paper, for an answer that forgot to say which passage to show. */
export const asksWhere = (question: string) =>
  /\b(where|show me|point (me )?to|find|locate|which (part|section|page|paragraph)|take me)\b/i.test(question);

// ---------------------------------------------------------------------------
// Papers an answer recommends
// ---------------------------------------------------------------------------

/** One paper Claude suggests reading, as it listed it in the answer's `papers` block. */
export interface Recommendation {
  title: string;
  /** How the answer named it in the text — "Kristinsson et al. 2021". */
  label?: string;
  authors?: string;
  year?: string;
  why?: string;
}

const PAPERS_FENCE = /(?:^|\n)[ \t]*```papers[ \t]*\n([\s\S]*?)(?:\n[ \t]*```[ \t]*(?=\n|$)|$)/;

const field = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) value = value.filter((item) => typeof item === 'string').join(', ');
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

/**
 * The answer's prose, and the papers its closing `papers` block lists — one
 * JSON object a line. The block is taken out of the prose even while it is
 * still streaming in, so its raw lines never flash up as code; a line that
 * does not parse (half-written, or not JSON) is skipped.
 */
export function splitPapers(content: string): { text: string; papers: Recommendation[] } {
  const match = PAPERS_FENCE.exec(content);
  if (!match) return { text: content, papers: [] };
  const text = (content.slice(0, match.index) + content.slice(match.index + match[0].length)).trim();
  const papers: Recommendation[] = [];
  const seen = new Set<string>();
  for (const line of match[1].split('\n')) {
    const raw = line.trim().replace(/,$/, '');
    if (!raw.startsWith('{')) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const title = field(parsed?.title);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    papers.push({ title, authors: field(parsed.authors), year: field(parsed.year), why: field(parsed.why) });
  }
  return { text, papers };
}

const MENTION = /\[([^\]\n]+)\]\(paper:\s*([^)\n]+)\)/g;

/** The key a paper is matched by, between a name in the text and a line of the block. */
export const paperKey = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The papers an answer brings up, numbered in the order the reader meets
 * them: each `[name](paper:title)` in the text, first mention first, with
 * what the closing `papers` block says of it; then any the block lists that
 * the text never named. A paper named but missing from the block is still
 * listed, with the title and the name it was given.
 */
export function readingList(content: string): { text: string; papers: Recommendation[] } {
  const { text, papers: listed } = splitPapers(content);
  const byKey = new Map(listed.map((paper) => [paperKey(paper.title), paper]));
  const seen = new Set<string>();
  const papers: Recommendation[] = [];
  for (const match of text.matchAll(MENTION)) {
    const title = match[2].trim();
    const key = paperKey(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const said = byKey.get(key);
    papers.push({ ...(said ?? { title }), label: match[1].trim() });
  }
  for (const paper of listed) {
    const key = paperKey(paper.title);
    if (seen.has(key)) continue;
    seen.add(key);
    papers.push(paper);
  }
  return { text, papers };
}

// ---------------------------------------------------------------------------
// What the screen holds
// ---------------------------------------------------------------------------

export interface ScreenPaper {
  id: string;
  title: string;
  authors: string[];
  published?: string;
  venue?: string;
  arxivId?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  /** "Reflow" or "PDF". */
  mode?: string;
  /** 0..100 — how far down the reader is. */
  progress?: number;
}

export interface ScreenHighlight {
  exact: string;
  kind: string;
  note?: string;
  section?: string;
}

/** Everything the window is allowed to know about the page, gathered at the moment of sending. */
export interface Screen {
  /** "Reading a paper", "Collection “Surveys”", "All papers" … */
  where: string;
  paper?: ScreenPaper;
  fullText?: string;
  visible?: string;
  selection?: string;
  highlights?: ScreenHighlight[];
  /** The pages in view as JPEG pictures (base64), in PDF mode, each with the line that introduces it. */
  images?: { label: string; data: string }[];
  /** Titles in the list on screen, when no paper is open. */
  library?: string[];
  /** The paper's Explain page, when it is open. */
  explanation?: ScreenExplanation;
  /** Where the selection was made. */
  selectionIn?: 'paper' | 'explanation';
}

export interface ScreenExplanation {
  /** The page as Claude wrote it, in Markdown. */
  text: string;
  /** The sections of it on screen, as text. */
  visible?: string;
  /** How it is laid out, and whether it hides the paper. */
  layout?: string;
  covers?: boolean;
}

export type ContextKey = 'paper' | 'fullText' | 'visible' | 'selection' | 'highlights' | 'library' | 'explanation';

export const CONTEXT_ROWS: [ContextKey, string, string][] = [
  ['paper', 'Paper details', 'title, authors, venue, identifiers and abstract'],
  ['fullText', 'Full text', 'the whole paper as the reader extracted it (cached between questions)'],
  ['visible', 'Passage in view', 'the paragraphs on screen right now — in PDF mode, a picture of the pages in view'],
  ['selection', 'Your selection', 'the text you last selected in the paper'],
  ['highlights', 'Highlights and notes', 'what you have marked in this paper, and what you wrote'],
  ['explanation', 'The explanation', 'the paper’s Explain page, when it is open — all of it, and the part in view'],
  ['library', 'The list on screen', 'the titles in the collection you are looking at'],
];

// ---------------------------------------------------------------------------
// Preferences and the key
// ---------------------------------------------------------------------------

export interface Prefs {
  /** The model that answers in the chat window. */
  model: string;
  /** The model Explain and Implementation start with; unset follows the chat's. */
  explainModel?: string;
  context: Record<ContextKey, boolean>;
}

function loadPrefs(): Prefs {
  const base: Prefs = {
    model: DEFAULT_MODEL,
    // All on: the point of the window is not having to paste the screen into it.
    context: { paper: true, fullText: true, visible: true, selection: true, highlights: true, library: true, explanation: true },
  };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_STORE) || '{}') as Partial<Prefs>;
    const known = (id: string | undefined) => (id && (MODELS.some((m) => m.id === id) || RETIRED[id]) ? modelSpec(id).id : undefined);
    const model = known(saved.model) ?? base.model;
    const explainModel = known(saved.explainModel);
    return { model, ...(explainModel ? { explainModel } : {}), context: { ...base.context, ...(saved.context || {}) } };
  } catch {
    return base;
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_STORE, JSON.stringify(state.prefs));
  } catch {
    // private mode: the choice lasts for this page load
  }
}

const memKeys: Record<Provider, string> = { anthropic: '', deepseek: '' }; // when localStorage is unavailable
const storedKey = (provider: Provider) => {
  try {
    return localStorage.getItem(PROVIDERS[provider].keyStore) || '';
  } catch {
    return '';
  }
};
const keyFor = (provider: Provider) => memKeys[provider] || storedKey(provider);
const storedKeys = () =>
  Object.fromEntries(PROVIDER_IDS.map((provider) => [provider, Boolean(keyFor(provider))])) as Record<Provider, boolean>;

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  streaming?: boolean;
  error?: string;
  truncated?: boolean;
  /** A screenshot went with this question. */
  shot?: boolean;
  /** Which model wrote an answer. Chats from before there was a choice have none: they were Claude's. */
  model?: string;
}

export interface Chat {
  id: string;
  title: string;
  created: number;
  updated: number;
  turns: { role: 'user' | 'assistant'; content: string; model?: string }[];
}

export interface AssistantState {
  turns: Turn[];
  /** Which stored chat the thread on screen is. Null until it has been filed. */
  threadId: string | null;
  /** Newest first. */
  history: Chat[];
  live: boolean;
  prefs: Prefs;
  /** Which providers have a key in this browser. */
  keys: Record<Provider, boolean>;
  /** Whether the chat's model has a key — whether the window can send. */
  hasKey: boolean;
  /** A passage attached to the next question with "Ask Claude" on a selection. */
  quote: string;
  /** A screenshot of the tab (base64 JPEG) attached to the next question. */
  shot: string;
}

let state: AssistantState = {
  turns: [],
  threadId: null,
  history: [],
  live: false,
  prefs: { model: DEFAULT_MODEL, context: { paper: true, fullText: true, visible: true, selection: true, highlights: true, library: true, explanation: true } },
  keys: { anthropic: false, deepseek: false },
  hasKey: false,
  quote: '',
  shot: '',
};
let loaded = false;
const listeners = new Set<() => void>();

/** Loaded lazily so importing this module in a test touches no storage. */
function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  const prefs = loadPrefs();
  const keys = storedKeys();
  state = { ...state, prefs, history: loadHistory(), keys, hasKey: keys[modelSpec(prefs.model).provider] };
}

function set(patch: Partial<AssistantState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void) {
  ensureLoaded();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getState(): AssistantState {
  ensureLoaded();
  return state;
}

// Streaming appends a token at a time; one repaint a frame is plenty.
let painting = false;
function schedulePaint() {
  if (painting) return;
  painting = true;
  const flush = () => {
    painting = false;
    set({ turns: [...state.turns] });
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
  else setTimeout(flush, 16);
}

export function setModel(model: string) {
  if (!MODELS.some((m) => m.id === model)) return;
  set({ prefs: { ...state.prefs, model }, hasKey: state.keys[modelSpec(model).provider] });
  savePrefs();
}

/** The model Explain and Implementation start with. */
export function setExplainModel(model: string) {
  if (!MODELS.some((m) => m.id === model)) return;
  set({ prefs: { ...state.prefs, explainModel: model } });
  savePrefs();
}

/** Whether this model's provider has a key. */
export const hasKeyFor = (model: string) => getState().keys[modelSpec(model).provider];

export function setContext(key: ContextKey, on: boolean) {
  set({ prefs: { ...state.prefs, context: { ...state.prefs.context, [key]: on } } });
  savePrefs();
}

/** Keep a key for a provider — by default, the one behind the chat's model. */
export function saveKey(key: string, provider: Provider = modelSpec(state.prefs.model).provider) {
  const value = key.trim();
  memKeys[provider] = value;
  try {
    if (value) localStorage.setItem(PROVIDERS[provider].keyStore, value);
    else localStorage.removeItem(PROVIDERS[provider].keyStore);
  } catch {
    // private mode: the key lives for this page load only
  }
  if (provider === 'anthropic') client = null;
  const keys = { ...state.keys, [provider]: Boolean(value) };
  set({ keys, hasKey: keys[modelSpec(state.prefs.model).provider] });
}

export function forgetKey(provider: Provider = modelSpec(state.prefs.model).provider) {
  saveKey('', provider);
}

/** Whether a pasted key looks like one this provider issues. */
export const looksLikeKey = (key: string, provider: Provider) => {
  const trimmed = key.trim();
  if (!trimmed.startsWith(PROVIDERS[provider].keyPrefix)) return false;
  // A Claude key pasted into DeepSeek's box starts with "sk-" too.
  return provider === 'anthropic' || !trimmed.startsWith(PROVIDERS.anthropic.keyPrefix);
};

export function setShot(shot: string) {
  set({ shot });
}

export function setQuote(quote: string) {
  set({ quote: quote.trim().slice(0, SELECTION_MAX_CHARS) });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
//
// Every conversation is filed in this browser as it happens, so closing the
// window — or the tab — never throws an answer away. What is stored is the
// text of the turns, not the <screen> block that rode along with them: that is
// rebuilt from the live page every time, and a stale copy is not worth keeping.

export function loadHistory(): Chat[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_STORE) || '[]');
    return normaliseHistory(raw);
  } catch {
    return [];
  }
}

export function normaliseHistory(raw: unknown): Chat[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c.id === 'string' && Array.isArray(c.turns) && c.turns.length)
    .map((c) => ({
      id: c.id as string,
      title: String(c.title || '').slice(0, 120),
      created: Number(c.created) || Date.now(),
      updated: Number(c.updated) || Number(c.created) || Date.now(),
      turns: (c.turns as { role?: string; content?: unknown; model?: unknown }[])
        .filter((t) => t && (t.role === 'user' || t.role === 'assistant'))
        .map((t) => ({
          role: t.role as 'user' | 'assistant',
          content: String(t.content ?? ''),
          ...(typeof t.model === 'string' && t.model ? { model: t.model } : {}),
        })),
    }))
    .filter((c) => c.turns.length)
    .slice(0, HISTORY_MAX_CHATS);
}

/** Write the list back, shedding the oldest chats until it fits. */
function saveHistory() {
  let history = state.history;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      localStorage.setItem(HISTORY_STORE, JSON.stringify(history));
      if (history !== state.history) set({ history });
      return;
    } catch {
      if (history.length <= 1) break;
      history = history.slice(0, Math.max(1, Math.floor(history.length / 2)));
    }
  }
  try {
    localStorage.removeItem(HISTORY_STORE);
  } catch {
    // private mode
  }
}

const chatId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A chat is named after the question that started it. */
export function titleFor(turns: { role: string; content: string }[]): string {
  const first = turns.find((t) => t.role === 'user' && t.content.trim());
  // A quoted passage leads the message; the question after it is the better name.
  const lines = (first?.content ?? '').split('\n').filter((l) => !l.startsWith('>'));
  const line = lines.join(' ').replace(/\s+/g, ' ').trim() || (first?.content ?? '').replace(/[>\s]+/g, ' ').trim();
  if (!line) return 'Untitled chat';
  return line.length > 70 ? `${line.slice(0, 69)}…` : line;
}

/** File the thread on screen. Called after every completed answer — there is no Save button to forget. */
function rememberThread() {
  const stored = state.turns
    .filter((t) => t.content && t.content.trim() && !t.streaming)
    .map((t) => ({ role: t.role, content: t.content.slice(0, HISTORY_MAX_CHARS), ...(t.model ? { model: t.model } : {}) }));
  if (!stored.length) return;
  const now = Date.now();
  const history = [...state.history];
  const at = history.findIndex((c) => c.id === state.threadId);
  const id = state.threadId ?? chatId();
  const entry: Chat = {
    id,
    title: at >= 0 ? history[at].title : titleFor(stored),
    created: at >= 0 ? history[at].created : now,
    updated: now,
    turns: stored,
  };
  if (at >= 0) history.splice(at, 1);
  history.unshift(entry); // newest first, and a reply promotes it
  set({ history: history.slice(0, HISTORY_MAX_CHATS), threadId: id });
  saveHistory();
}

/** Put the current thread away and start an empty one. */
export function newChat() {
  if (state.live) return;
  rememberThread();
  set({ turns: [], threadId: null });
}

/** Reopen a stored chat. The one on screen is filed first, never dropped. */
export function openChat(id: string) {
  if (state.live) return;
  const chat = state.history.find((c) => c.id === id);
  if (!chat) return;
  if (state.threadId !== id) rememberThread();
  set({ threadId: chat.id, turns: chat.turns.map((t) => ({ ...t })) });
}

export function deleteChat(id: string) {
  set({
    history: state.history.filter((c) => c.id !== id),
    threadId: state.threadId === id ? null : state.threadId,
  });
  saveHistory();
}

export function clearHistory() {
  set({ history: [], threadId: null });
  try {
    localStorage.removeItem(HISTORY_STORE);
  } catch {
    // private mode
  }
}

// ---------------------------------------------------------------------------
// The SDK, loaded on demand
// ---------------------------------------------------------------------------

export type SDK = typeof AnthropicClient;
let sdkModule: SDK | null = null;
let client: AnthropicClient | null = null;
let stream: ModelStream | null = null;

export async function sdk(): Promise<SDK> {
  if (!sdkModule) sdkModule = (await import('@anthropic-ai/sdk')).default;
  return sdkModule;
}

export async function anthropic(): Promise<AnthropicClient> {
  if (client) return client;
  const SDK = await sdk();
  client = new SDK({
    // Deliberate, and the only way a static site can work: the visitor's own
    // key, in the visitor's own browser, going straight to Anthropic.
    dangerouslyAllowBrowser: true,
    apiKey: keyFor('anthropic'),
    maxRetries: 1,
  });
  return client;
}

/** What callers hold while an answer streams in, whichever provider is writing it. */
export interface ModelStream {
  on(event: 'text' | 'thinking', listener: (delta: string) => void): unknown;
  abort(): void;
  finalMessage(): Promise<{ stop_reason: string | null }>;
}

export type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };
export type Message = { role: 'user' | 'assistant'; content: string | ReturnType<typeof buildMessages>[number]['content'] };

/**
 * One streamed answer from whichever provider the model belongs to. Claude
 * thinks adaptively where the model takes it; DeepSeek's reasoner streams its
 * reasoning as thinking of its own accord.
 */
export async function streamModel(params: {
  model: string;
  maxTokens: number;
  system: SystemBlock[];
  messages: Message[];
  effort?: 'low' | 'medium' | 'high';
}): Promise<ModelStream> {
  const spec = modelSpec(params.model);
  const maxTokens = spec.maxOutput ? Math.min(params.maxTokens, spec.maxOutput) : params.maxTokens;
  if (spec.provider === 'deepseek') {
    return new DeepSeekStream({
      apiKey: keyFor('deepseek'),
      model: spec.apiModel ?? spec.id,
      maxTokens,
      thinking: !spec.thinks ? 'off' : params.effort === 'low' ? 'low' : 'high',
      system: params.system.map((block) => block.text).join('\n\n'),
      messages: params.messages as ConstructorParameters<typeof DeepSeekStream>[0]['messages'],
    });
  }
  const api = await anthropic();
  const sdkStream = api.messages.stream({
    model: spec.apiModel ?? spec.id,
    max_tokens: maxTokens,
    system: params.system,
    messages: params.messages as Parameters<AnthropicClient['messages']['stream']>[0]['messages'],
    ...(spec.adaptive
      ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const }, output_config: { effort: params.effort ?? ('medium' as const) } }
      : {}),
  });
  return {
    on(event, listener) {
      if (event === 'text') sdkStream.on('text', listener);
      else sdkStream.on('thinking', listener);
      return this;
    },
    abort: () => sdkStream.abort(),
    finalMessage: async () => ({ stop_reason: (await sdkStream.finalMessage()).stop_reason }),
  };
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** An XML-ish tag with attributes, skipped entirely when the body is empty. */
export function tag(name: string, body: unknown, attrs: Record<string, unknown> = {}): string {
  const text = String(body ?? '').trim();
  if (!text) return '';
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, "'")}"`)
    .join('');
  return `<${name}${a}>\n${text}\n</${name}>`;
}

const clip = (text: string | undefined, max: number) =>
  !text ? '' : text.length > max ? `${text.slice(0, max)}\n[…cut at ${max.toLocaleString('en')} characters]` : text;

/**
 * Everything on the screen, as the text block that leads the newest question.
 * Each part is here only if its switch is on, so a part that is switched off
 * is never assembled at all.
 */
export function screenBlock(screen: Screen, on: Record<ContextKey, boolean>): string {
  const parts: string[] = [];
  parts.push(`<where>${screen.where}</where>`);

  const p = screen.paper;
  if (p && on.paper) {
    const lines = [
      `Title: ${p.title}`,
      p.authors.length ? `Authors: ${p.authors.join(', ')}` : '',
      p.published ? `Published: ${p.published}` : '',
      p.venue ? `Venue: ${p.venue}` : '',
      p.arxivId ? `arXiv: ${p.arxivId}` : '',
      p.doi ? `DOI: ${p.doi}` : '',
      p.url ? `Link: ${p.url}` : '',
      p.mode ? `Viewing as: ${p.mode}` : '',
      typeof p.progress === 'number' ? `Read so far: ${p.progress}%` : '',
    ].filter(Boolean);
    parts.push(tag('paper', lines.join('\n')));
    if (p.abstract) parts.push(tag('abstract', p.abstract));
  }
  const explanation = on.explanation ? screen.explanation : undefined;
  if (explanation) {
    parts.push(
      tag(
        'explain_page',
        `Open${explanation.layout ? `, as “${explanation.layout}”` : ''}. ${explanation.covers ? 'It covers the paper, so the reader is looking at the explanation, not the paper.' : 'The paper is still visible beside it.'}`,
      ),
    );
    parts.push(tag('explanation_in_view', clip(explanation.visible, VISIBLE_MAX_CHARS)));
  }
  // The paper behind an explanation that covers it is not what is in view.
  if (on.visible && !explanation?.covers) parts.push(tag('passage_in_view', clip(screen.visible, VISIBLE_MAX_CHARS)));
  if (on.selection) {
    const fromExplanation = screen.selectionIn === 'explanation';
    parts.push(tag('selected_text', clip(screen.selection, SELECTION_MAX_CHARS), { in: fromExplanation ? 'the explanation' : '' }));
  }
  if (on.highlights && screen.highlights?.length) {
    parts.push(
      tag(
        'highlights',
        screen.highlights
          .map((h, i) => {
            const where = h.section ? ` (${h.section})` : '';
            const note = h.note?.trim() ? `\n   note: ${h.note.trim()}` : '';
            return `${i + 1}. [${h.kind}]${where} “${h.exact}”${note}`;
          })
          .join('\n'),
      ),
    );
  }
  if (on.library && !p && screen.library?.length) {
    parts.push(tag('list_on_screen', screen.library.slice(0, 80).map((t) => `- ${t}`).join('\n')));
  }
  const body = parts.filter(Boolean).join('\n\n');
  return body ? `<screen>\n${body}\n</screen>` : '';
}

/** The system prompt: the instructions, then the paper behind a cache breakpoint. */
export function systemBlocks(screen: Screen, on: Record<ContextKey, boolean>) {
  const blocks: SystemBlock[] = [{ type: 'text', text: SYSTEM }];
  const text = on.fullText ? screen.fullText?.trim() : '';
  if (text && screen.paper) {
    const cut = text.length > FULL_TEXT_MAX_CHARS;
    blocks.push({
      type: 'text',
      text: tag('paper_text', cut ? text.slice(0, FULL_TEXT_MAX_CHARS) : text, {
        title: screen.paper.title,
        truncated: cut ? `yes, first ${FULL_TEXT_MAX_CHARS.toLocaleString('en')} characters only` : '',
      }),
      cache_control: { type: 'ephemeral' },
    });
  }
  // The explanation after the paper, so a question about it still reads the paper from the cache.
  const explanation = on.explanation ? screen.explanation?.text.trim() : '';
  if (explanation) {
    blocks.push({
      type: 'text',
      text: tag('explanation_text', explanation.slice(0, FULL_TEXT_MAX_CHARS), { title: screen.paper?.title }),
      cache_control: { type: 'ephemeral' },
    });
  }
  return blocks;
}

/**
 * The messages as sent: the stored turns, with the screen leading the newest
 * user turn — not the first one, because "what does this mean?" is about the
 * passage on screen now, not the one from ten minutes ago.
 */
export function buildMessages(turns: Turn[], block: string, images: Screen['images'] = []) {
  const sent = turns.filter((t) => t.role === 'user' || t.content);
  const newest = sent.map((t) => t.role).lastIndexOf('user');
  return sent.map((t, i) => {
    const text = i === newest && block ? `${block}\n\n${t.content}` : t.content;
    if (i !== newest || !images?.length) return { role: t.role, content: text };
    // The pages in view lead the newest question, each named, then the text.
    return {
      role: t.role,
      content: [
        ...images.flatMap((image) => [
          { type: 'text' as const, text: image.label },
          { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: image.data } },
        ]),
        { type: 'text' as const, text },
      ],
    };
  });
}

/** Said to a model that reads text only, in place of the pictures the system prompt mentions. */
export const TEXT_ONLY = `This model reads text only: no pictures of the pages or screenshots are attached, whatever the
instructions above say about images. Work from <paper_text> and the <screen> block, and if the answer hangs on a figure,
say that you cannot see it.`;

/** A quoted passage, as the Markdown blockquote that leads the question. */
export function withQuote(quote: string, text: string): string {
  if (!quote.trim()) return text;
  const quoted = quote
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `${quoted}\n\n${text}`;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** What a failure should say to someone who is not holding the SDK docs. */
export function explainError(err: unknown, SDK: SDK | null): string {
  if ((err as Error)?.name === 'AbortError') return 'Stopped.';
  // By name, not instanceof: the class may come from another copy of the module (a test bundle).
  if ((err as Error)?.name === 'DeepSeekError') {
    const { status, message } = err as DeepSeekError;
    if (status === 0) return 'Could not reach api.deepseek.com. Check your connection, or whether something is blocking the request.';
    if (status === 401) return 'DeepSeek rejected that API key. Check it on platform.deepseek.com, then enter it again under ⚙.';
    if (status === 402) return 'Your DeepSeek balance has run out. Top it up on platform.deepseek.com and ask again.';
    if (status === 429) return 'Rate limited by DeepSeek. Wait a moment and ask again.';
    if (status >= 500) return `DeepSeek is having trouble (${status}): ${message}. Try again in a moment.`;
    return `DeepSeek returned ${status}: ${message}`;
  }
  if (SDK && err instanceof SDK.AuthenticationError) {
    return 'Anthropic rejected that API key. Check it in the console, then enter it again under ⚙.';
  }
  if (SDK && err instanceof SDK.PermissionDeniedError) {
    return 'That key is not allowed to use this model. Try a different model, or a key with broader access.';
  }
  if (SDK && err instanceof SDK.RateLimitError) return 'Rate limited by Anthropic. Wait a moment and ask again.';
  if (SDK && err instanceof SDK.APIUserAbortError) return 'Stopped.';
  if (SDK && err instanceof SDK.APIConnectionError) {
    return 'Could not reach api.anthropic.com. Check your connection, or whether something is blocking the request.';
  }
  if (SDK && err instanceof SDK.APIError) return `Anthropic returned ${err.status}: ${err.message}`;
  return String((err as Error)?.message ?? err);
}

export function stop() {
  stream?.abort();
}

export async function send(text: string, screenOrPending: Screen | Promise<Screen>) {
  const question = withQuote(state.quote, text.trim());
  if (!text.trim() || state.live || !state.hasKey) return;

  const reply: Turn = { role: 'assistant', content: '', thinking: '', streaming: true, model: state.prefs.model };
  const shot = state.shot;
  set({ turns: [...state.turns, { role: 'user', content: question, ...(shot ? { shot: true } : {}) }, reply], live: true, quote: '', shot: '' });

  let SDK: SDK | null = null;
  try {
    // Reading a PDF's text can take a moment the first time; the question is already on screen.
    const screen = await screenOrPending;
    const model = modelSpec(state.prefs.model);
    if (model.provider === 'anthropic') SDK = await sdk();
    const on = state.prefs.context;
    // A model that reads text only gets no pictures; the system prompt says why.
    const images = model.vision
      ? [
          ...(on.visible ? screen.images ?? [] : []),
          ...(shot ? [{ label: 'A screenshot of the reader’s browser tab, taken as they asked:', data: shot }] : []),
        ]
      : [];
    const messages = buildMessages(state.turns.filter((t) => t !== reply), screenBlock(screen, on), images);
    const system = systemBlocks(screen, on);
    if (!model.vision) system.push({ type: 'text', text: TEXT_ONLY });

    // Adaptive thinking earns its latency on "why does this bound hold";
    // the models that do not take it simply go without.
    stream = await streamModel({ model: model.id, maxTokens: MAX_TOKENS, system, messages, effort: 'medium' });
    stream.on('text', (delta: string) => {
      reply.content += delta;
      schedulePaint();
    });
    stream.on('thinking', (delta: string) => {
      reply.thinking = (reply.thinking ?? '') + delta;
      schedulePaint();
    });

    const final = await stream.finalMessage();
    if (final.stop_reason === 'max_tokens') reply.truncated = true;
    if (final.stop_reason === 'refusal') reply.error = `${PROVIDERS[model.provider].name} declined to answer that one.`;
  } catch (e) {
    reply.error = explainError(e, SDK);
    // An abort with nothing streamed yet is a cancelled turn, not an answer.
    if (!reply.content && reply.error === 'Stopped.') {
      set({ turns: state.turns.filter((t) => t !== reply) });
    }
  } finally {
    stream = null;
    reply.streaming = false;
    set({ turns: [...state.turns], live: false });
    rememberThread();
  }
}
