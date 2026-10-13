// ===========================================================================
//  Ask AI — a chat window that floats over the paper you are reading.
//
//  Three providers answer it, and Explain: Anthropic's Claude, DeepSeek and
//  Google's Gemini. The model picker says which, and each provider has a key
//  of its own.
//
//  THE SITE'S KEYS, AND YOUR OWN. The site comes with keys of its own: the
//  paper proxy holds ANTHROPIC_KEY, DEEPSEEK_KEY and GEMINI_KEY, never typed
//  into the page, and asks the provider for whoever is signed in to it —
//  server/aiRelay.js and server/geminiRelay.js. A provider's models are ready
//  on the site's key when the proxy says it has one and this browser holds
//  the proxy's token or pass. That is the default.
//
//  Anyone may use a key of their own for Claude or DeepSeek instead, under
//  Settings: it is kept in this browser's localStorage and sent straight to
//  its provider's API (api.anthropic.com, or api.deepseek.com — deepseek.ts),
//  never through the proxy. Usage then bills their own account, and nothing
//  about the key reaches anyone else. Neither provider publishes a "sign in
//  with …" for third-party websites — a Claude.ai subscription cannot be
//  spent from a page like this one — so a key it is. Gemini is the site's
//  key only.
//
//  The SDK is imported on first use, not at boot: Vite splits it into a chunk
//  of its own, and a visitor who never opens the window never downloads it.
//
//  The window reads the screen the way a person sitting next to you would:
//  the paper that is open, the passage in view, the text you have selected
//  and the highlights you have made all go along with every question, so
//  there is nothing to paste. Each part has a switch under ⚙.
//
//  With the Web button beside the box on, the model may also look things up
//  as it answers — search the web, read a page — through the paper proxy
//  (webTools.ts): DeepSeek by function calling in a loop (deepseek.ts),
//  Claude by Anthropic's own search tool. Gemini's relay lets no tool
//  through, so the button is off for its models. Off by default: it spends
//  the proxy owner's search key, and most questions are about the paper.
// ===========================================================================
import { DeepSeekStream, proxyReason } from './deepseek';
import { GeminiStream } from './gemini';
import { reportAiUsage } from './aiUsage';
import { api as proxyUrl, apiHeaders, hasProxy, hasProxyToken, onProxyChange, proxyHealth } from './api';
import { checkWeb, MAX_TOOL_CALLS, runWebTool, WEB_TOOLS } from './webTools';
/** What the chat window is called — the models behind it are not all Claude. */
export const ASSISTANT_NAME = 'Ask AI';
export const PROVIDERS = {
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
    gemini: {
        id: 'gemini',
        name: 'Gemini',
        company: 'Google',
        // Never used: the key is the proxy's. Kept so a key saved by an earlier build is found and forgotten.
        keyStore: 'reader.gemini-key',
        keyPrefix: 'AIza',
        placeholder: '',
        consoleUrl: 'https://aistudio.google.com/apikey',
        host: 'your paper proxy',
        viaProxy: true,
    },
};
export const PROVIDER_IDS = Object.keys(PROVIDERS);
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
/** Models offered in the pickers, grouped by provider in this order. */
export const MODELS = [
    { id: 'claude-opus-5', provider: 'anthropic', label: 'Claude Opus 5', note: 'most capable', adaptive: true, vision: true },
    { id: 'claude-sonnet-5', provider: 'anthropic', label: 'Claude Sonnet 5', note: 'faster and cheaper', adaptive: true, vision: true },
    { id: 'claude-haiku-4-5', provider: 'anthropic', label: 'Claude Haiku 4.5', note: 'fastest and cheapest', adaptive: false, vision: true },
    // DeepSeek serves two (deepseek-chat and deepseek-reasoner were retired in July 2026): V4.1 Flash, which reads
    // pictures, twice — thinking first, and answering straight away — and V4 Pro, its larger model, which reads text only.
    { id: 'deepseek-flash', provider: 'deepseek', label: 'DeepSeek V4.1 Flash', note: 'thinks first · very cheap', adaptive: false, vision: true, thinks: true },
    { id: 'deepseek-flash-fast', apiModel: 'deepseek-flash', provider: 'deepseek', label: 'DeepSeek V4.1 Flash, no thinking', note: 'answers at once · cheapest', adaptive: false, vision: true, thinks: false },
    { id: 'deepseek-v4-pro', provider: 'deepseek', label: 'DeepSeek V4 Pro', note: 'DeepSeek’s most capable · text only', adaptive: false, vision: false, thinks: true },
    // Google's current three: its Pro (still filed as a preview), its newest Flash, and Flash-Lite.
    { id: 'gemini-3.1-pro-preview', provider: 'gemini', label: 'Gemini 3.1 Pro', note: 'Google’s most capable', adaptive: false, vision: true, thinking: 'high', maxOutput: 64000 },
    { id: 'gemini-3.8-flash', provider: 'gemini', label: 'Gemini 3.8 Flash', note: 'fast and capable', adaptive: false, vision: true, thinking: 'high', maxOutput: 64000 },
    { id: 'gemini-3.5-flash-lite', provider: 'gemini', label: 'Gemini 3.5 Flash-Lite', note: 'fastest · cheapest', adaptive: false, vision: true, thinking: 'low', maxOutput: 64000 },
];
const DEFAULT_MODEL = 'claude-opus-5';
/** Ids DeepSeek has retired, as they may still be in a browser's preferences or on a page written with them. */
const RETIRED = { 'deepseek-reasoner': 'deepseek-flash', 'deepseek-chat': 'deepseek-flash-fast' };
/** The model with this id, or the default one. */
export const modelSpec = (id) => MODELS.find((m) => m.id === (id && RETIRED[id] ? RETIRED[id] : id)) ?? MODELS[0];
/** The provider behind a model. */
export const providerOf = (model) => PROVIDERS[modelSpec(model).provider];
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
/** How much of the Colab notebook goes with a question: its cells and what they printed. */
const NOTEBOOK_MAX_CHARS = 24_000;
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
  is exactly what the reader is looking at, figures and equations included. Read them. In
  Reflow mode the figures and tables on screen come the same way, each introduced by its
  caption, as do the figures on the Explain page when it is open. A figure that came as a
  picture is one you can see: read it, and never say figures are missing when it is there.
- The reader can also attach a screenshot of the whole browser tab. It shows the app as they
  see it — this chat window may be floating over part of it; look past that.
- Each message carries a <screen> block holding what is on the reader's screen at that
  moment: the paper's details, the passage in view, the text they have selected, and their
  highlights and notes. It is re-read for every message, so trust the newest one and ignore
  earlier copies — they will have scrolled on.
- "This", "here" and "that sentence" usually mean the selection, or else the passage in view.
- A switch under ⚙ can withhold any part of that block. If something you need is genuinely
  not there, say which part is missing.

Showing a picture in the answer:
- The app can draw a figure of the paper, or a page of the PDF, inside your answer, sized to
  fit the window. To show one, write on a line of its own:
  ![Figure 3: the ablation results](figure:3)
  where the number after \`figure:\` is the figure's number as its caption gives it (use
  \`table:2\` for a table), or in PDF mode ![Page 4](page:4) for a whole page. The text in
  brackets is the caption under the picture. Show a figure when the reader asks to see one,
  and when the answer turns on what a figure shows; only name figures that are in the paper.

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
- When the Colab tab is the one on screen, a passage can point at the notebook instead: add
  "in": "notebook" and "cell": 3 (the cell's number) to its line, and copy the quote from that
  cell's code or output in <colab_notebook>, one to three lines, exactly as they are there. The
  app scrolls the Colab tab to the cell and marks those lines. When the question is about the
  notebook — its code, an error, what a cell printed — point at the notebook, not at the paper
  or the explanation underneath it.

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
  it says; point at the paper when they want the source.

When <colab_notebook> is in the <screen> block:
- It is the reader's own notebook on the paper, on their Google Colab runtime — there whenever the paper has
  one, whether or not the Colab tab is the one on screen: its cells numbered from 1, each with the code or
  text and what it printed when it last ran, tracebacks included, which cell is running now, and the runtime.
  "This cell", "cell 3", "the error", "what it printed" and "which cell is running" mean that notebook. Never
  say you cannot see the notebook while the block is there; when it is not, say the paper has no notebook yet.
- Name cells by their number, as "cell 5" or "cells 3 and 7": the reader can click each such mention to go
  straight to that cell in the notebook. Say which cell holds what the reader asked about whenever you can.
- Answer from it: read the code and the outputs, say what a traceback means and what to change, judge
  whether an output bears out the paper. Show code as a fenced python block the reader can paste into a
  cell. The tab has an ask bar of its own that writes and changes cells in place, so when the reader wants
  cells written rather than explained, say they can ask that bar and it will put them in the notebook.`;
const PASSAGES_FENCE = /(?:^|\n)[ \t]*```passages[ \t]*\n([\s\S]*?)(?:\n[ \t]*```[ \t]*(?=\n|$)|$)/;
/** The answer without its `passages` block, and the passages it lists; tolerant of a block still streaming. */
export function splitPassages(content) {
    const match = PASSAGES_FENCE.exec(content);
    if (!match)
        return { text: content, passages: [] };
    const text = (content.slice(0, match.index) + content.slice(match.index + match[0].length)).trim();
    const passages = [];
    for (const line of match[1].split('\n')) {
        const raw = line.trim().replace(/,$/, '');
        if (!raw.startsWith('{'))
            continue;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            continue;
        }
        const quote = field(parsed?.quote)?.replace(/\[Page \d+\]/g, ' ').replace(/\s+/g, ' ');
        if (!quote)
            continue;
        const page = Number(parsed.page);
        const cell = Number(parsed.cell);
        const where = field(parsed.in) ?? '';
        passages.push({
            quote,
            label: field(parsed.label) ?? 'This part of the paper',
            section: field(parsed.section),
            page: Number.isInteger(page) && page > 0 ? page : undefined,
            show: parsed.show === true,
            ...(/^explanation$/i.test(where) ? { source: 'explanation' } : {}),
            ...(/^(colab_)?notebook$|^colab$|^cell$/i.test(where) ? { source: 'notebook' } : {}),
            ...(Number.isInteger(cell) && cell > 0 ? { cell } : {}),
        });
    }
    return { text, passages: passages.slice(0, 8) };
}
/** A question that asks to be shown a place in the paper, for an answer that forgot to say which passage to show. */
export const asksWhere = (question) => /\b(where|show me|point (me )?to|find|locate|which (part|section|page|paragraph)|take me)\b/i.test(question);
const PAPERS_FENCE = /(?:^|\n)[ \t]*```papers[ \t]*\n([\s\S]*?)(?:\n[ \t]*```[ \t]*(?=\n|$)|$)/;
const field = (value) => {
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    if (Array.isArray(value))
        value = value.filter((item) => typeof item === 'string').join(', ');
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};
/**
 * The answer's prose, and the papers its closing `papers` block lists — one
 * JSON object a line. The block is taken out of the prose even while it is
 * still streaming in, so its raw lines never flash up as code; a line that
 * does not parse (half-written, or not JSON) is skipped.
 */
export function splitPapers(content) {
    const match = PAPERS_FENCE.exec(content);
    if (!match)
        return { text: content, papers: [] };
    const text = (content.slice(0, match.index) + content.slice(match.index + match[0].length)).trim();
    const papers = [];
    const seen = new Set();
    for (const line of match[1].split('\n')) {
        const raw = line.trim().replace(/,$/, '');
        if (!raw.startsWith('{'))
            continue;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            continue;
        }
        const title = field(parsed?.title);
        if (!title || seen.has(title.toLowerCase()))
            continue;
        seen.add(title.toLowerCase());
        papers.push({ title, authors: field(parsed.authors), year: field(parsed.year), why: field(parsed.why) });
    }
    return { text, papers };
}
const MENTION = /\[([^\]\n]+)\]\(paper:\s*([^)\n]+)\)/g;
/** The key a paper is matched by, between a name in the text and a line of the block. */
export const paperKey = (title) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/**
 * The papers an answer brings up, numbered in the order the reader meets
 * them: each `[name](paper:title)` in the text, first mention first, with
 * what the closing `papers` block says of it; then any the block lists that
 * the text never named. A paper named but missing from the block is still
 * listed, with the title and the name it was given.
 */
export function readingList(content) {
    const { text, papers: listed } = splitPapers(content);
    const byKey = new Map(listed.map((paper) => [paperKey(paper.title), paper]));
    const seen = new Set();
    const papers = [];
    for (const match of text.matchAll(MENTION)) {
        const title = match[2].trim();
        const key = paperKey(title);
        if (!key || seen.has(key))
            continue;
        seen.add(key);
        const said = byKey.get(key);
        papers.push({ ...(said ?? { title }), label: match[1].trim() });
    }
    for (const paper of listed) {
        const key = paperKey(paper.title);
        if (seen.has(key))
            continue;
        seen.add(key);
        papers.push(paper);
    }
    return { text, papers };
}
export const CONTEXT_ROWS = [
    ['paper', 'Paper details', 'title, authors, venue, identifiers and abstract'],
    ['fullText', 'Full text', 'the whole paper as the reader extracted it (cached between questions)'],
    ['visible', 'Passage in view', 'the paragraphs on screen right now, with the figures in view as pictures — in PDF mode, a picture of the pages in view'],
    ['selection', 'Your selection', 'the text you last selected in the paper'],
    ['highlights', 'Highlights and notes', 'what you have marked in this paper, and what you wrote'],
    ['explanation', 'The explanation', 'the paper’s Explain page, when it is open — all of it, and the part in view'],
    ['notebook', 'The Colab notebook', 'your notebook on the Colab tab — every cell, what it printed, which is running — whenever the paper has one'],
    ['library', 'The list on screen', 'the titles in the collection you are looking at'],
];
function loadPrefs() {
    const base = {
        model: DEFAULT_MODEL,
        // All on: the point of the window is not having to paste the screen into it.
        context: { paper: true, fullText: true, visible: true, selection: true, highlights: true, library: true, explanation: true, notebook: true },
    };
    try {
        const saved = JSON.parse(localStorage.getItem(PREFS_STORE) || '{}');
        const known = (id) => (id && (MODELS.some((m) => m.id === id) || RETIRED[id]) ? modelSpec(id).id : undefined);
        const model = known(saved.model) ?? base.model;
        const explainModel = known(saved.explainModel);
        const askModel = known(saved.askModel);
        return { model, ...(explainModel ? { explainModel } : {}), ...(askModel ? { askModel } : {}), context: { ...base.context, ...(saved.context || {}) }, ...(saved.web ? { web: true } : {}) };
    }
    catch {
        return base;
    }
}
function savePrefs() {
    try {
        localStorage.setItem(PREFS_STORE, JSON.stringify(state.prefs));
    }
    catch {
        // private mode: the choice lasts for this page load
    }
}
const memKeys = { anthropic: '', deepseek: '', gemini: '' }; // when localStorage is unavailable
const storedKey = (provider) => {
    try {
        return localStorage.getItem(PROVIDERS[provider].keyStore) || '';
    }
    catch {
        return '';
    }
};
export const keyFor = (provider) => (PROVIDERS[provider].viaProxy ? '' : memKeys[provider] || storedKey(provider));
/** Which providers have a key of this browser's own. */
const ownKeys = () => Object.fromEntries(PROVIDER_IDS.map((provider) => [provider, Boolean(keyFor(provider))]));
/** Whether each provider can answer from here: a key of this browser's own, or the site's, on a proxy ready to ask with it. */
const usableKeys = (own, site) => Object.fromEntries(PROVIDER_IDS.map((provider) => [provider, own[provider] || site[provider] === 'ready']));
/** Whether an answer from this provider goes through the proxy, on the site's key, rather than straight there on this browser's own. */
export const onSiteKey = (provider) => !keyFor(provider);
/** Ask the proxy's /health what it can do for the window: the site's keys, and the web. */
function checkProxy() {
    void checkSite();
    void checkWeb().then((web) => {
        if (web !== state.web)
            set({ web });
    });
}
/** Ask the proxy's /health which keys it holds, and whether this browser may use them. */
async function checkSite() {
    const all = (readiness) => setSite(Object.fromEntries(PROVIDER_IDS.map((provider) => [provider, readiness])));
    if (!hasProxy())
        return all('no-proxy');
    const health = await proxyHealth();
    if (!health)
        return all('no-proxy');
    setSite(Object.fromEntries(PROVIDER_IDS.map((provider) => [
        provider,
        !health.ai[provider] ? 'no-key' : health.auth && !hasProxyToken() ? 'sign-in' : 'ready',
    ])));
}
/** Where the site's key for a provider stands, in a few words for a picker and in a sentence for a card. */
export function siteNote(provider, readiness) {
    const { name } = PROVIDERS[provider];
    const own = PROVIDERS[provider].viaProxy ? '' : ' Or add a key of your own.';
    switch (readiness) {
        case 'ready':
            return { short: 'ready, on the site’s key', long: `${name} runs on the site’s own key, through your paper proxy, so there is nothing to paste here.` };
        case 'no-key':
            return {
                short: 'the proxy has no key for it',
                long: `The site’s ${name} key lives on your paper proxy, and it has none yet. Its owner sets it once with “npx wrangler secret put ${SITE_KEY_NAMES[provider]}” (or ${SITE_KEY_NAMES[provider]} for npm start) and redeploys.${own}`,
            };
        case 'sign-in':
            return {
                short: 'sign in to the proxy first',
                long: `${name} runs on the site’s own key, through your paper proxy, for whoever is signed in to it. Sign in with Google, or paste the proxy’s token under Settings → Paper proxy.${own}`,
            };
        case 'owners':
            return { short: 'the site’s key is the owner’s', long: `The site’s ${name} key is kept for its owner.${own || ' Pick a model from another provider.'}` };
        case 'no-proxy':
            return { short: 'needs a paper proxy', long: `The site’s ${name} key lives on a paper proxy, and this site has no proxy set. Add one under Settings → Paper proxy.${own}` };
        default:
            return { short: 'checking the proxy…', long: `Asking your paper proxy whether it has ${name}…` };
    }
}
/** Where Gemini stands — siteNote, for the callers from before the other two were on the proxy too. */
export const geminiNote = (readiness) => siteNote('gemini', readiness);
/** What each provider's key is set as on the proxy. */
const SITE_KEY_NAMES = { anthropic: 'ANTHROPIC_KEY', deepseek: 'DEEPSEEK_KEY', gemini: 'GEMINI_KEY' };
function setSite(site) {
    if (PROVIDER_IDS.every((provider) => site[provider] === state.site[provider]))
        return;
    const keys = usableKeys(state.own, site);
    set({ site, gemini: site.gemini, keys, hasKey: keys[modelSpec(state.prefs.model).provider] });
}
/**
 * The proxy said the site's key for this provider is its owner's: it stops
 * counting as usable here, so the pickers ask for a key of this browser's
 * own, until the proxy or the sign-in changes.
 */
function siteRefused(provider, reason) {
    if (reason === 'OWNERS_ONLY')
        setSite({ ...state.site, [provider]: 'owners' });
    else if (reason === 'NO_KEY')
        setSite({ ...state.site, [provider]: 'no-key' });
}
let state = {
    turns: [],
    threadId: null,
    history: [],
    live: false,
    prefs: { model: DEFAULT_MODEL, context: { paper: true, fullText: true, visible: true, selection: true, highlights: true, library: true, explanation: true, notebook: true } },
    keys: { anthropic: false, deepseek: false, gemini: false },
    own: { anthropic: false, deepseek: false, gemini: false },
    site: { anthropic: 'checking', deepseek: 'checking', gemini: 'checking' },
    hasKey: false,
    gemini: 'checking',
    web: 'checking',
    quote: '',
    shot: '',
};
let loaded = false;
const listeners = new Set();
/** Loaded lazily so importing this module in a test touches no storage. */
function ensureLoaded() {
    if (loaded)
        return;
    loaded = true;
    const prefs = loadPrefs();
    const own = ownKeys();
    const keys = usableKeys(own, state.site);
    state = { ...state, prefs, history: loadHistory(), own, keys, hasKey: keys[modelSpec(prefs.model).provider] };
    // A Gemini key an earlier build kept in this browser is not needed any more.
    try {
        localStorage.removeItem(PROVIDERS.gemini.keyStore);
    }
    catch {
        // no storage: nothing kept
    }
    if (typeof window !== 'undefined') {
        checkProxy();
        onProxyChange(checkProxy);
    }
}
function set(patch) {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
}
export function subscribe(listener) {
    ensureLoaded();
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
export function getState() {
    ensureLoaded();
    return state;
}
// Streaming appends a token at a time; one repaint a frame is plenty.
let painting = false;
function schedulePaint() {
    if (painting)
        return;
    painting = true;
    const flush = () => {
        painting = false;
        set({ turns: [...state.turns] });
    };
    if (typeof requestAnimationFrame === 'function')
        requestAnimationFrame(flush);
    else
        setTimeout(flush, 16);
}
export function setModel(model) {
    if (!MODELS.some((m) => m.id === model))
        return;
    set({ prefs: { ...state.prefs, model }, hasKey: state.keys[modelSpec(model).provider] });
    savePrefs();
}
/** The model Explain and Implementation start with. */
export function setExplainModel(model) {
    if (!MODELS.some((m) => m.id === model))
        return;
    set({ prefs: { ...state.prefs, explainModel: model } });
    savePrefs();
}
/** The model that answers the ask bars, whoever wrote the page; '' goes back to the page's writer. */
export function setAskModel(model) {
    if (model && !MODELS.some((m) => m.id === model))
        return;
    const { askModel: _was, ...rest } = state.prefs;
    set({ prefs: model ? { ...rest, askModel: model } : rest });
    savePrefs();
}
/** Whether this model's provider has a key. */
export const hasKeyFor = (model) => getState().keys[modelSpec(model).provider];
/** The Web button: let the model search the web and read pages as it answers. */
export function setWeb(on) {
    const { web: _was, ...rest } = state.prefs;
    set({ prefs: on ? { ...rest, web: true } : rest });
    savePrefs();
}
/**
 * Whether a model can use the web from here: Claude through Anthropic's own
 * search, DeepSeek through the proxy when it is ready to search; Gemini not
 * at all, since its relay lets no tool through.
 */
export function webUsable(model, web = state.web) {
    const provider = modelSpec(model).provider;
    if (provider === 'anthropic')
        return true;
    if (provider === 'deepseek')
        return web === 'ready';
    return false;
}
export function setContext(key, on) {
    set({ prefs: { ...state.prefs, context: { ...state.prefs.context, [key]: on } } });
    savePrefs();
}
/** Keep a key of this browser's own for a provider — by default, the one behind the chat's model — used before the site's. */
export function saveKey(key, provider = modelSpec(state.prefs.model).provider) {
    // The proxy's key, not one of this browser's.
    if (PROVIDERS[provider].viaProxy)
        return;
    const value = key.trim();
    memKeys[provider] = value;
    try {
        if (value)
            localStorage.setItem(PROVIDERS[provider].keyStore, value);
        else
            localStorage.removeItem(PROVIDERS[provider].keyStore);
    }
    catch {
        // private mode: the key lives for this page load only
    }
    if (provider === 'anthropic')
        clients.own = null;
    const own = { ...state.own, [provider]: Boolean(value) };
    const keys = usableKeys(own, state.site);
    set({ own, keys, hasKey: keys[modelSpec(state.prefs.model).provider] });
}
/** Forget this browser's own key for a provider: its models go back to the site's key, where there is one. */
export function forgetKey(provider = modelSpec(state.prefs.model).provider) {
    saveKey('', provider);
}
/** Whether a pasted key looks like one this provider issues. */
export const looksLikeKey = (key, provider) => {
    const trimmed = key.trim();
    if (!trimmed.startsWith(PROVIDERS[provider].keyPrefix))
        return false;
    // A Claude key pasted into DeepSeek's box starts with "sk-" too.
    return provider !== 'deepseek' || !trimmed.startsWith(PROVIDERS.anthropic.keyPrefix);
};
export function setShot(shot) {
    set({ shot });
}
export function setQuote(quote) {
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
export function loadHistory() {
    try {
        const raw = JSON.parse(localStorage.getItem(HISTORY_STORE) || '[]');
        return normaliseHistory(raw);
    }
    catch {
        return [];
    }
}
export function normaliseHistory(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .filter((c) => c && typeof c.id === 'string' && Array.isArray(c.turns) && c.turns.length)
        .map((c) => ({
        id: c.id,
        title: String(c.title || '').slice(0, 120),
        created: Number(c.created) || Date.now(),
        updated: Number(c.updated) || Number(c.created) || Date.now(),
        turns: c.turns
            .filter((t) => t && (t.role === 'user' || t.role === 'assistant'))
            .map((t) => ({
            role: t.role,
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
            if (history !== state.history)
                set({ history });
            return;
        }
        catch {
            if (history.length <= 1)
                break;
            history = history.slice(0, Math.max(1, Math.floor(history.length / 2)));
        }
    }
    try {
        localStorage.removeItem(HISTORY_STORE);
    }
    catch {
        // private mode
    }
}
const chatId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** A chat is named after the question that started it. */
export function titleFor(turns) {
    const first = turns.find((t) => t.role === 'user' && t.content.trim());
    // A quoted passage leads the message; the question after it is the better name.
    const lines = (first?.content ?? '').split('\n').filter((l) => !l.startsWith('>'));
    const line = lines.join(' ').replace(/\s+/g, ' ').trim() || (first?.content ?? '').replace(/[>\s]+/g, ' ').trim();
    if (!line)
        return 'Untitled chat';
    return line.length > 70 ? `${line.slice(0, 69)}…` : line;
}
/** File the thread on screen. Called after every completed answer — there is no Save button to forget. */
function rememberThread() {
    const stored = state.turns
        .filter((t) => t.content && t.content.trim() && !t.streaming)
        .map((t) => ({ role: t.role, content: t.content.slice(0, HISTORY_MAX_CHARS), ...(t.model ? { model: t.model } : {}) }));
    if (!stored.length)
        return;
    const now = Date.now();
    const history = [...state.history];
    const at = history.findIndex((c) => c.id === state.threadId);
    const id = state.threadId ?? chatId();
    const entry = {
        id,
        title: at >= 0 ? history[at].title : titleFor(stored),
        created: at >= 0 ? history[at].created : now,
        updated: now,
        turns: stored,
    };
    if (at >= 0)
        history.splice(at, 1);
    history.unshift(entry); // newest first, and a reply promotes it
    set({ history: history.slice(0, HISTORY_MAX_CHATS), threadId: id });
    saveHistory();
}
/** Put the current thread away and start an empty one. */
export function newChat() {
    if (state.live)
        return;
    rememberThread();
    set({ turns: [], threadId: null });
}
/** Reopen a stored chat. The one on screen is filed first, never dropped. */
export function openChat(id) {
    if (state.live)
        return;
    const chat = state.history.find((c) => c.id === id);
    if (!chat)
        return;
    if (state.threadId !== id)
        rememberThread();
    set({ threadId: chat.id, turns: chat.turns.map((t) => ({ ...t })) });
}
export function deleteChat(id) {
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
    }
    catch {
        // private mode
    }
}
let sdkModule = null;
/** One client on this browser's own key, one on the site's through the proxy. */
const clients = { own: null, site: null };
let stream = null;
export async function sdk() {
    if (!sdkModule)
        sdkModule = (await import('@anthropic-ai/sdk')).default;
    return sdkModule;
}
export async function anthropic() {
    const SDK = await sdk();
    if (keyFor('anthropic')) {
        clients.own ??= new SDK({
            // Deliberate, and the only way a static site can work: the visitor's own
            // key, in the visitor's own browser, going straight to Anthropic.
            dangerouslyAllowBrowser: true,
            apiKey: keyFor('anthropic'),
            maxRetries: 1,
        });
        return clients.own;
    }
    clients.site ??= new SDK({
        dangerouslyAllowBrowser: true,
        // The key is the proxy's; this one is never sent anywhere.
        apiKey: 'site-key',
        maxRetries: 1,
        fetch: siteFetch,
    });
    return clients.site;
}
/**
 * The SDK's fetch, for the site's key: the Messages API request goes to the
 * proxy's /ai/anthropic instead, with the proxy's headers in place of the
 * SDK's (the key placeholder among them), and the answer comes back as
 * Anthropic sent it. A refusal of the proxy's own is not one to retry.
 */
async function siteFetch(_input, init = {}) {
    const response = await fetch(proxyUrl('/ai/anthropic'), {
        method: 'POST',
        body: init.body,
        signal: init.signal,
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
    });
    if (response.ok)
        return response;
    const text = await response.text();
    let body = null;
    try {
        body = JSON.parse(text);
    }
    catch {
        // not JSON: passed on as it came
    }
    const ours = typeof body?.error === 'string';
    if (ours)
        siteRefused('anthropic', proxyReason(body));
    return new Response(text, {
        status: response.status,
        headers: { 'Content-Type': 'application/json', ...(ours ? { 'x-should-retry': 'false' } : {}) },
    });
}
/**
 * One streamed answer from whichever provider the model belongs to. Claude
 * thinks adaptively where the model takes it; DeepSeek's reasoner streams its
 * reasoning as thinking of its own accord; Gemini thinks at the model's level,
 * or lower for a low effort, and streams a summary of it.
 */
export async function streamModel(params) {
    const spec = modelSpec(params.model);
    const web = Boolean(params.web) && webUsable(spec.id);
    const maxTokens = spec.maxOutput ? Math.min(params.maxTokens, spec.maxOutput) : params.maxTokens;
    if (spec.provider === 'deepseek') {
        const site = onSiteKey('deepseek');
        const answer = new DeepSeekStream({
            // This browser's own key, straight to DeepSeek; or the site's, through the proxy.
            ...(site ? { url: proxyUrl('/ai/deepseek'), headers: apiHeaders() } : { apiKey: keyFor('deepseek') }),
            model: spec.apiModel ?? spec.id,
            maxTokens,
            thinking: !spec.thinks ? 'off' : params.effort === 'low' ? 'low' : 'high',
            system: params.system.map((block) => block.text).join('\n\n'),
            messages: params.messages,
            ...(web ? { tools: WEB_TOOLS, runTool: runWebTool, maxToolCalls: MAX_TOOL_CALLS } : {}),
            onUsage: (usage) => {
                // The proxy counts what goes through it on the site's key itself.
                if (site)
                    return;
                const hit = usage.prompt_cache_hit_tokens || 0;
                const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens || 0) - hit);
                reportAiUsage('deepseek', spec.apiModel ?? spec.id, { input: miss, cacheRead: hit, output: usage.completion_tokens || 0 }, spec.id);
            },
        });
        answer.finalMessage().catch((error) => {
            if (error?.fromProxy)
                siteRefused('deepseek', error.reason);
        });
        return answer;
    }
    if (spec.provider === 'gemini') {
        const level = spec.thinking ?? 'high';
        const answer = new GeminiStream({
            url: proxyUrl('/ai/gemini'),
            headers: apiHeaders(),
            model: spec.apiModel ?? spec.id,
            maxTokens,
            thinking: params.effort === 'low' ? 'low' : params.effort === 'medium' && level === 'high' ? 'medium' : level,
            system: params.system.map((block) => block.text).join('\n\n'),
            messages: params.messages,
            // The proxy counts Gemini's tokens itself, as they pass through it.
        });
        answer.finalMessage().catch((error) => {
            if (error?.fromProxy)
                siteRefused('gemini', error.reason);
        });
        return answer;
    }
    const site = onSiteKey('anthropic');
    const api = await anthropic();
    const sdkStream = api.messages.stream({
        model: spec.apiModel ?? spec.id,
        max_tokens: maxTokens,
        system: params.system,
        messages: params.messages,
        ...(spec.adaptive
            ? { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: params.effort ?? 'medium' } }
            : {}),
        // Anthropic's own search, run on Anthropic's side; the basic tool, which every Claude model takes. $10 a thousand searches.
        ...(web ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_TOOL_CALLS }] } : {}),
    });
    // Each search the server made, as a step: the query when it is asked, how many results when they come.
    const stepListeners = [];
    const queries = new Map();
    sdkStream.on('contentBlock', (block) => {
        if (block.type === 'server_tool_use' && block.name === 'web_search') {
            const query = String(block.input?.query ?? '');
            queries.set(block.id, query);
            stepListeners.forEach((listener) => listener({ tool: 'web_search', what: query }));
        }
        else if (block.type === 'web_search_tool_result') {
            const what = queries.get(block.tool_use_id) ?? '';
            const outcome = Array.isArray(block.content) ? `${block.content.length} result${block.content.length === 1 ? '' : 's'}` : `failed: ${String(block.content?.error_code ?? 'error').replace(/_/g, ' ')}`;
            stepListeners.forEach((listener) => listener({ tool: 'web_search', what, outcome }));
        }
    });
    // Once the answer is in, the tokens it took go on the owner's tally (aiUsage.ts).
    sdkStream.on('finalMessage', (message) => {
        // The proxy counts what goes through it on the site's key itself.
        if (site)
            return;
        const usage = message.usage;
        reportAiUsage('claude', spec.apiModel ?? spec.id, {
            input: usage.input_tokens || 0,
            output: usage.output_tokens || 0,
            cacheRead: usage.cache_read_input_tokens || 0,
            cacheWrite: usage.cache_creation_input_tokens || 0,
        }, spec.id);
    });
    return {
        on(event, listener) {
            if (event === 'step')
                stepListeners.push(listener);
            else if (event === 'text')
                sdkStream.on('text', listener);
            else
                sdkStream.on('thinking', listener);
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
export function tag(name, body, attrs = {}) {
    const text = String(body ?? '').trim();
    if (!text)
        return '';
    const a = Object.entries(attrs)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, "'")}"`)
        .join('');
    return `<${name}${a}>\n${text}\n</${name}>`;
}
const clip = (text, max) => !text ? '' : text.length > max ? `${text.slice(0, max)}\n[…cut at ${max.toLocaleString('en')} characters]` : text;
/**
 * Everything on the screen, as the text block that leads the newest question.
 * Each part is here only if its switch is on, so a part that is switched off
 * is never assembled at all.
 */
export function screenBlock(screen, on) {
    const parts = [];
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
        if (p.abstract)
            parts.push(tag('abstract', p.abstract));
    }
    const explanation = on.explanation ? screen.explanation : undefined;
    if (explanation) {
        parts.push(tag('explain_page', `Open${explanation.layout ? `, as “${explanation.layout}”` : ''}. ${explanation.covers ? 'It covers the paper, so the reader is looking at the explanation, not the paper.' : 'The paper is still visible beside it.'}`));
        parts.push(tag('explanation_in_view', clip(explanation.visible, VISIBLE_MAX_CHARS)));
    }
    // The notebook has a switch of its own, and goes whether or not the Colab tab is the one on screen: it is the reader's own work on the paper.
    if (on.notebook && screen.notebook) {
        const n = screen.notebook;
        const head = [
            `The reader's own notebook on the paper, in the Colab tab${n.open ? ' — the tab on screen now' : ' (not the tab on screen now; the reader can switch to it)'}`,
            n.runtime ? `on their ${n.runtime} runtime` : 'with no runtime connected yet',
            n.running ? `Running now: ${n.running}.` : 'Nothing is running now.',
        ].join('; ');
        parts.push(tag('colab_notebook', `${head}\nIts cells, numbered, with what each printed when it last ran:\n\n${clip(n.text, NOTEBOOK_MAX_CHARS)}`));
    }
    // The paper behind an explanation that covers it is not what is in view.
    if (on.visible && !explanation?.covers)
        parts.push(tag('passage_in_view', clip(screen.visible, VISIBLE_MAX_CHARS)));
    if (on.selection) {
        const fromExplanation = screen.selectionIn === 'explanation';
        parts.push(tag('selected_text', clip(screen.selection, SELECTION_MAX_CHARS), { in: fromExplanation ? 'the explanation' : '' }));
    }
    if (on.highlights && screen.highlights?.length) {
        parts.push(tag('highlights', screen.highlights
            .map((h, i) => {
            const where = h.section ? ` (${h.section})` : '';
            const note = h.note?.trim() ? `\n   note: ${h.note.trim()}` : '';
            return `${i + 1}. [${h.kind}]${where} “${h.exact}”${note}`;
        })
            .join('\n')));
    }
    if (on.library && !p && screen.library?.length) {
        parts.push(tag('list_on_screen', screen.library.slice(0, 80).map((t) => `- ${t}`).join('\n')));
    }
    const body = parts.filter(Boolean).join('\n\n');
    return body ? `<screen>\n${body}\n</screen>` : '';
}
/** The system prompt: the instructions, then the paper behind a cache breakpoint. */
export function systemBlocks(screen, on) {
    const blocks = [{ type: 'text', text: SYSTEM }];
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
export function buildMessages(turns, block, images = []) {
    const sent = turns.filter((t) => t.role === 'user' || t.content);
    const newest = sent.map((t) => t.role).lastIndexOf('user');
    return sent.map((t, i) => {
        const text = i === newest && block ? `${block}\n\n${t.content}` : t.content;
        if (i !== newest || !images?.length)
            return { role: t.role, content: text };
        // The pages in view lead the newest question, each named, then the text.
        return {
            role: t.role,
            content: [
                ...images.flatMap((image) => [
                    { type: 'text', text: image.label },
                    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.data } },
                ]),
                { type: 'text', text },
            ],
        };
    });
}
/**
 * Said with the Web button on: when to look, when not to, and how to show
 * what was found. DeepSeek has the two tools by name; Claude has Anthropic's
 * search, which reads pages for it.
 */
export function webInstructions(provider) {
    const tools = provider === 'deepseek'
        ? 'You have two tools: web_search, which searches the web, and read_page, which reads a page by its URL.'
        : 'You have a web search tool, which searches the web and returns what it finds, with the sources.';
    return `Looking things up:
- The reader has turned the Web button on. ${tools}
- Use the web for what the paper on screen cannot answer: later work that cites or builds on it,
  what a cited paper actually found, a term or method the paper assumes, a code or data
  release, what has happened since it was written — and whenever the reader asks you to look
  something up. Do not search for what the paper itself says: the paper is in front of you.
- Keep to a few searches; most questions need none, or one. Search before you answer, not
  after; then answer in one piece.
- Say what came from the web. Link each source where you use it, as a Markdown link —
  [title or site](https://…) — and never present a search result as something the paper says.`;
}
/** Said to a model that reads text only, in place of the pictures the system prompt mentions. */
export const TEXT_ONLY = `This model reads text only: no pictures of the pages or screenshots are attached, whatever the
instructions above say about images. Work from <paper_text> and the <screen> block, and if the answer hangs on a figure,
say that you cannot see it.`;
/** A quoted passage, as the Markdown blockquote that leads the question. */
export function withQuote(quote, text) {
    if (!quote.trim())
        return text;
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
/** What the proxy saying no to the site's key should say: why, and what to do instead. */
function siteRefusal(provider, status, reason, message) {
    const { name } = PROVIDERS[provider];
    const own = PROVIDERS[provider].viaProxy ? ' Pick a model from another provider instead.' : ' Or add a key of your own under ⚙.';
    if (reason === 'NO_KEY')
        return `The paper proxy has no ${name} key yet. Its owner sets it with “npx wrangler secret put ${SITE_KEY_NAMES[provider]}” and redeploys.${own}`;
    if (reason === 'SIGN_IN' || status === 401)
        return `Sign in to the paper proxy to use ${name} on the site’s key — with Google, or its token under Settings → Paper proxy.${own}`;
    if (reason === 'OWNERS_ONLY')
        return `${name} on the site’s key is for its owner.${own}`;
    if (status === 429)
        return 'Too many questions at once. Wait a minute and ask again.';
    return `The paper proxy would not ask ${name}: ${message}`;
}
/** What a failure should say to someone who is not holding the SDK docs. */
export function explainError(err, SDK) {
    if (err?.name === 'AbortError')
        return 'Stopped.';
    // By name, not instanceof: the class may come from another copy of the module (a test bundle).
    if (err?.name === 'DeepSeekError') {
        const { status, message, fromProxy, reason, viaProxy: site } = err;
        if (fromProxy)
            return siteRefusal('deepseek', status, reason, message);
        if (status === 0)
            return site ? 'Could not reach the paper proxy that asks DeepSeek. Check your connection, or Settings → Paper proxy.' : 'Could not reach api.deepseek.com. Check your connection, or whether something is blocking the request.';
        if (site && status === 401)
            return 'DeepSeek rejected the site’s key. Its owner checks DEEPSEEK_KEY on the proxy — or add a key of your own under ⚙.';
        if (site && status === 402)
            return 'The site’s DeepSeek balance has run out. Add a key of your own under ⚙, or ask the owner to top it up.';
        if (status === 401)
            return 'DeepSeek rejected that API key. Check it on platform.deepseek.com, then enter it again under ⚙.';
        if (status === 402)
            return 'Your DeepSeek balance has run out. Top it up on platform.deepseek.com and ask again.';
        if (status === 429)
            return 'Rate limited by DeepSeek. Wait a moment and ask again.';
        if (status >= 500)
            return `DeepSeek is having trouble (${status}): ${message}. Try again in a moment.`;
        return `DeepSeek returned ${status}: ${message}`;
    }
    if (err?.name === 'GeminiError') {
        const { status, message, reason, fromProxy } = err;
        if (status === 0)
            return 'Could not reach the paper proxy that asks Gemini. Check your connection, or Settings → Paper proxy.';
        if (fromProxy)
            return siteRefusal('gemini', status, reason, message);
        // Google answers a bad key with a 400 of its own wording, not a 401.
        if (status === 401 || /API key not valid|API_KEY_INVALID/i.test(message)) {
            return 'Google rejected the paper proxy’s Gemini key. Its owner checks GEMINI_KEY on aistudio.google.com and sets it again.';
        }
        if (status === 403)
            return `Google would not let that key use this model: ${message}`;
        if (status === 404)
            return `Google does not serve that model to this key: ${message}. Try another Gemini model.`;
        if (status === 429 || reason === 'RESOURCE_EXHAUSTED')
            return 'Rate limited by Google, or the proxy’s Gemini quota is spent. Wait a moment and ask again.';
        if (status >= 500)
            return `Gemini is having trouble (${status}): ${message}. Try again in a moment.`;
        return `Gemini returned ${status}: ${message}`;
    }
    // The proxy's own refusal, on the site's key: its error is a string, where Anthropic's is an object.
    if (SDK && err instanceof SDK.APIError && typeof err.error?.error === 'string') {
        const body = err.error;
        return siteRefusal('anthropic', err.status ?? 0, proxyReason(body), body.error);
    }
    const site = onSiteKey('anthropic');
    if (SDK && err instanceof SDK.AuthenticationError) {
        return site
            ? 'Anthropic rejected the site’s key. Its owner checks ANTHROPIC_KEY on the proxy — or add a key of your own under ⚙.'
            : 'Anthropic rejected that API key. Check it in the console, then enter it again under ⚙.';
    }
    if (SDK && err instanceof SDK.PermissionDeniedError) {
        return 'That key is not allowed to use this model. Try a different model, or a key with broader access.';
    }
    if (SDK && err instanceof SDK.RateLimitError)
        return 'Rate limited by Anthropic. Wait a moment and ask again.';
    if (SDK && err instanceof SDK.APIUserAbortError)
        return 'Stopped.';
    if (SDK && err instanceof SDK.APIConnectionError) {
        return site
            ? 'Could not reach the paper proxy that asks Claude. Check your connection, or Settings → Paper proxy.'
            : 'Could not reach api.anthropic.com. Check your connection, or whether something is blocking the request.';
    }
    if (SDK && err instanceof SDK.APIError)
        return `Anthropic returned ${err.status}: ${err.message}`;
    return String(err?.message ?? err);
}
export function stop() {
    stream?.abort();
}
export async function send(text, screenOrPending) {
    const question = withQuote(state.quote, text.trim());
    if (!text.trim() || state.live || !state.hasKey)
        return;
    const reply = { role: 'assistant', content: '', thinking: '', streaming: true, model: state.prefs.model };
    const shot = state.shot;
    const asked = { role: 'user', content: question, ...(shot ? { shot: true } : {}) };
    set({ turns: [...state.turns, asked, reply], live: true, quote: '', shot: '' });
    let SDK = null;
    try {
        // Reading a PDF's text can take a moment the first time; the question is already on screen.
        const screen = await screenOrPending;
        const model = modelSpec(state.prefs.model);
        if (model.provider === 'anthropic')
            SDK = await sdk();
        const on = state.prefs.context;
        // A model that reads text only gets no pictures; the system prompt says why.
        const images = model.vision
            ? [
                ...(on.visible ? screen.images ?? [] : []),
                ...(shot ? [{ label: 'A screenshot of the reader’s browser tab, taken as they asked:', data: shot }] : []),
            ]
            : [];
        // The question shows what went with it, as it was sent.
        if (images.length) {
            asked.images = images;
            set({ turns: [...state.turns] });
        }
        const messages = buildMessages(state.turns.filter((t) => t !== reply), screenBlock(screen, on), images);
        const system = systemBlocks(screen, on);
        if (!model.vision)
            system.push({ type: 'text', text: TEXT_ONLY });
        // The Web button, when it is on and this model can use it from here.
        const web = Boolean(state.prefs.web) && webUsable(model.id);
        if (web)
            system.push({ type: 'text', text: webInstructions(model.provider) });
        // Adaptive thinking earns its latency on "why does this bound hold";
        // the models that do not take it simply go without.
        stream = await streamModel({ model: model.id, maxTokens: MAX_TOKENS, system, messages, effort: 'medium', web });
        stream.on('text', (delta) => {
            reply.content += delta;
            schedulePaint();
        });
        stream.on('thinking', (delta) => {
            reply.thinking = (reply.thinking ?? '') + delta;
            schedulePaint();
        });
        stream.on('step', (step) => {
            // A search is one step: announced as it is asked, finished when its results come.
            const steps = reply.steps ?? [];
            const last = steps[steps.length - 1];
            if (last && !last.outcome && last.tool === step.tool && last.what === step.what && step.outcome)
                last.outcome = step.outcome;
            else
                steps.push(step);
            reply.steps = steps;
            schedulePaint();
        });
        const final = await stream.finalMessage();
        if (final.stop_reason === 'max_tokens')
            reply.truncated = true;
        if (final.stop_reason === 'refusal')
            reply.error = `${PROVIDERS[model.provider].name} declined to answer that one.`;
    }
    catch (e) {
        reply.error = explainError(e, SDK);
        // An abort with nothing streamed yet is a cancelled turn, not an answer.
        if (!reply.content && reply.error === 'Stopped.') {
            set({ turns: state.turns.filter((t) => t !== reply) });
        }
    }
    finally {
        stream = null;
        reply.streaming = false;
        set({ turns: [...state.turns], live: false });
        rememberThread();
    }
}
