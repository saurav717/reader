import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { linkCells, showNotebookCell } from '../lib/notebookNav';
import DOMPurify from 'dompurify';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ASSISTANT_NAME, CONTEXT_ROWS, PROVIDERS, PROVIDER_IDS, looksLikeKey, modelSpec, clearHistory, deleteChat, forgetKey, siteNote, getState, newChat, openChat, saveKey, send, setContext, setModel, setQuote, setShot, setWeb, webUsable, paperKey, readingList, splitPassages, asksWhere, stop, subscribe, } from '../lib/assistant';
import { FLASH_EVENT, showPassage } from '../lib/locate';
import { typesetMath } from '../lib/typesetMath';
import { STYLES, clamp, clearOf, styleAt } from '../lib/floatWindow';
import { stacked, useFloatingWindow, viewport } from './FloatingWindow';
import { markdown } from '../lib/markdown';
import { placeFigures } from '../lib/figures';
import ModelChip from './ModelChip';
import { CameraIcon, CheckIcon, CloseIcon, FileIcon, GlobeIcon, PlusIcon, SearchIcon, SparkleIcon } from './icons';
import { webNote } from '../lib/webTools';
import { useStore } from '../lib/store';
import { resolvePaper } from '../lib/recommend';
import { PAPER_LAYOUTS, markAdds, placeCards, setLayout, useLayout } from './paperCards';
import { discover } from './HoverCard';
import { canCapture, captureTab } from '../lib/screen';
/** "just now" / "14 mins ago" / "3 days ago" — enough to find a chat by. */
function ago(ts) {
    const secs = Math.max(0, (Date.now() - ts) / 1000);
    if (secs < 90)
        return 'just now';
    const units = [[60, 'min'], [60, 'hour'], [24, 'day'], [7, 'week']];
    let n = secs;
    let label = 'sec';
    for (const [size, name] of units) {
        if (n < size)
            break;
        n /= size;
        label = name;
    }
    const whole = Math.floor(n);
    return `${whole} ${label}${whole === 1 ? '' : 's'} ago`;
}
const ADD_LABEL = { adding: 'Adding…', added: 'In Reading list', missing: 'Not found — try again' };
function AddButton({ paper, actions, compact }) {
    const state = actions.adds[paperKey(paper.title)];
    const label = state ? ADD_LABEL[state] : 'Add to Reading list';
    return (_jsxs("button", { type: "button", className: `btn sm chat-add ${state ? `is-${state}` : ''}`, disabled: state === 'adding' || state === 'added', title: label, "aria-label": compact ? `${label}: ${paper.title}` : undefined, onClick: () => actions.add([paper]), children: [state === 'added' ? _jsx(CheckIcon, { size: 12 }) : _jsx(PlusIcon, { size: 12 }), compact ? null : label] }));
}
/** A paper's card: what the answer said of it, and the two things to do with it. */
function PaperCard({ paper, n, actions }) {
    return (_jsxs(_Fragment, { children: [_jsxs("p", { className: "chat-peek-head", children: [_jsx("span", { className: "chat-num", children: n }), [paper.authors ?? paper.label, paper.year].filter(Boolean).join(' · ')] }), _jsx("h3", { children: paper.title }), paper.why ? _jsx("p", { className: "chat-peek-why", children: paper.why }) : null, _jsxs("div", { className: "chat-peek-actions", children: [_jsxs("button", { type: "button", className: "btn primary sm", onClick: () => actions.find(paper.title), children: [_jsx(SearchIcon, { size: 12 }), "Find in Discover"] }), _jsx(AddButton, { paper: paper, actions: actions })] })] }));
}
/**
 * Every paper the answer brought up, folded to one line under it until
 * opened: numbered as the names in the text are, each a row with what it
 * contributes. A row's title goes back to where the answer named the paper.
 */
function ReadingList({ papers, actions, onShow }) {
    const stateOf = (paper) => actions.adds[paperKey(paper.title)];
    const waiting = papers.filter((paper) => !stateOf(paper));
    const added = papers.filter((paper) => stateOf(paper) === 'added').length;
    const busy = papers.some((paper) => stateOf(paper) === 'adding');
    return (_jsxs("details", { className: "chat-reading", children: [_jsxs("summary", { children: [_jsxs("span", { className: "chat-reading-count", children: [papers.length, " ", papers.length === 1 ? 'paper' : 'papers', " mentioned"] }), _jsx("span", { className: "segmented sm chat-layout", role: "group", "aria-label": "Where the papers' cards go", children: PAPER_LAYOUTS.map(({ value, short, note }) => (_jsx("button", { type: "button", "aria-pressed": actions.layout === value, title: note, onClick: (event) => {
                                event.preventDefault();
                                setLayout(value);
                            }, children: short }, value))) }), waiting.length ? (_jsxs("button", { type: "button", className: "btn sm", onClick: (event) => {
                            event.preventDefault();
                            actions.add(waiting);
                        }, children: [_jsx(PlusIcon, { size: 12 }), waiting.length === papers.length ? 'Add all to Reading list' : `Add the other ${waiting.length}`] })) : (_jsx("span", { className: `chat-reading-status ${added === papers.length ? 'is-done' : ''}`, "aria-live": "polite", children: busy ? 'Adding…' : added === papers.length ? _jsxs(_Fragment, { children: [_jsx(CheckIcon, { size: 12 }), " All in Reading list"] }) : `${added} of ${papers.length} in Reading list` }))] }), _jsx("ol", { children: papers.map((paper, index) => {
                    const key = paperKey(paper.title);
                    return (_jsxs("li", { children: [_jsx("span", { className: "chat-num", children: index + 1 }), _jsxs("div", { className: "chat-reading-paper", children: [_jsx("button", { type: "button", className: "chat-reading-title", onClick: () => onShow(key), title: "Show where the answer names it", children: paper.title }), _jsx("p", { className: "chat-reading-meta", children: [paper.authors ?? paper.label, paper.year].filter(Boolean).join(' · ') }), paper.why ? _jsx("p", { className: "chat-reading-why", children: paper.why }) : null, stateOf(paper) === 'missing' ? (_jsx("p", { className: "chat-reading-missing", children: "Not found in the indexes by its title \u2014 Find searches Google Scholar too." })) : null] }), _jsxs("div", { className: "chat-reading-actions", children: [_jsx("button", { type: "button", className: "btn sm", onClick: () => actions.find(paper.title), "aria-label": `Find in Discover: ${paper.title}`, title: "Find in Discover", children: _jsx(SearchIcon, { size: 12 }) }), _jsx(AddButton, { paper: paper, actions: actions, compact: true })] })] }, key));
                }) })] }));
}
// ---------------------------------------------------------------------------
// The window's settings: what Claude sees, how answers mark words, how the
// page marks a passage, where paper cards go, and the key
// ---------------------------------------------------------------------------
const CHAT_MARKS = [
    { id: 'auto', label: 'Auto', note: 'Marker fill on paper, a glow in the dark' },
    { id: 'fill', label: 'Fill', note: 'A marker behind the words' },
    { id: 'glow', label: 'Glow', note: 'The words themselves in amber' },
    { id: 'underline', label: 'Underline', note: 'A thick marker stroke beneath' },
    { id: 'tint', label: 'Tint', note: 'The app’s own green' },
    { id: 'outline', label: 'Outline', note: 'A framed chip' },
];
const PAGE_LOOKS = [
    { id: 'marker', label: 'Marker', note: 'Swept over the words' },
    { id: 'spotlight', label: 'Spotlight', note: 'The rest of the page dims' },
    { id: 'outline', label: 'Outline', note: 'Framed, with a bar' },
];
function SetSection({ icon, title, note, children }) {
    return (_jsxs("section", { className: "set-card", children: [_jsxs("header", { children: [_jsx("span", { className: "set-icon", "aria-hidden": "true", children: icon }), _jsxs("span", { children: [_jsx("b", { children: title }), note ? _jsx("small", { children: note }) : null] })] }), children] }));
}
function ChatSettings({ context, paperLayout, marks, look, onMarks, onLook, }) {
    const on = CONTEXT_ROWS.filter(([key]) => context[key]).length;
    return (_jsxs("div", { className: "chat-drawer chat-settings", children: [_jsx(SetSection, { icon: "\u2726", title: "Highlights in answers", note: "How bold words and links to passages are marked", children: _jsx("div", { className: "mark-tiles", role: "radiogroup", "aria-label": "Highlights in answers", children: CHAT_MARKS.map((option) => (_jsxs("button", { type: "button", role: "radio", "aria-checked": marks === option.id, className: "mark-tile", "data-marks": option.id, onClick: () => onMarks(option.id), title: option.note, children: [_jsx("span", { className: "mark-sample chat-claude", children: _jsxs("span", { className: "chat-text", children: ["the ", _jsx("strong", { children: "key idea" }), ", and ", _jsx("span", { className: "chat-passage", "data-passage": "1", children: "where" })] }) }), _jsx("span", { className: "mark-name", children: option.label }), _jsx("span", { className: "mark-note", children: option.note })] }, option.id))) }) }), _jsx(SetSection, { icon: "\u25CE", title: "Passages on the page", note: "When an answer shows you where something is", children: _jsx("div", { className: "look-tiles", role: "radiogroup", "aria-label": "Passages on the page", children: PAGE_LOOKS.map((option) => (_jsxs("button", { type: "button", role: "radio", "aria-checked": look === option.id, className: `look-tile look-${option.id}`, onClick: () => onLook(option.id), children: [_jsxs("span", { className: "look-sample", "aria-hidden": "true", children: [_jsx("i", {}), _jsx("i", { className: "hit" }), _jsx("i", { className: "hit short" }), _jsx("i", {})] }), _jsx("span", { className: "mark-name", children: option.label }), _jsx("span", { className: "mark-note", children: option.note })] }, option.id))) }) }), _jsx(SetSection, { icon: "\u25C9", title: "What the model sees", note: `${on} of ${CONTEXT_ROWS.length} on · read fresh each time you send`, children: _jsx("div", { className: "set-switches", children: CONTEXT_ROWS.map(([key, label, note]) => (_jsxs("label", { className: "set-switch", title: note, children: [_jsxs("span", { className: "set-switch-text", children: [_jsx("b", { children: label }), _jsx("small", { children: note })] }), _jsx("input", { type: "checkbox", role: "switch", checked: context[key], onChange: (event) => setContext(key, event.target.checked) }), _jsx("span", { className: "set-toggle", "aria-hidden": "true" })] }, key))) }) }), _jsx(SetSection, { icon: "\u25A4", title: "Papers an answer names", note: "Where a paper's card goes in the answer", children: _jsx("div", { className: "set-choices", role: "radiogroup", "aria-label": "Where paper cards go", children: PAPER_LAYOUTS.map(({ value, label, note }) => (_jsxs("button", { type: "button", role: "radio", "aria-checked": paperLayout === value, onClick: () => setLayout(value), children: [_jsx("b", { children: label }), _jsx("small", { children: note })] }, value))) }) }), _jsx(SetSection, { icon: "\u26BF", title: "API keys", note: "The site\u2019s by default \u00B7 or your own, kept in this browser and sent straight to its provider", children: PROVIDER_IDS.map((provider) => (_jsx(KeyRow, { provider: provider }, provider))) })] }));
}
/**
 * The places in the open paper an answer points at, under it: each with its
 * caption, the paper's own words, and Show — which scrolls the paper there
 * and marks the passage for a few seconds.
 */
function PassageList({ passages, shown, onShow, onPage }) {
    return (_jsxs("div", { className: "chat-passages", children: [_jsxs("div", { className: "chat-passages-head", children: [_jsxs("span", { className: "chat-passages-title", children: [_jsx(SparkleIcon, { size: 12 }), ' ', passages.every((p) => p.source === 'explanation') ? 'Found in the explanation' : passages.some((p) => p.source === 'explanation') ? 'Found in the paper and its explanation' : 'Found in the paper'] }), _jsx("span", { className: "chat-passages-count", children: passages.length }), _jsx("span", { className: "chat-passages-hint", children: "Click one to see it on the page" })] }), _jsx("ol", { children: passages.map((passage, index) => {
                    const state = shown[index];
                    const live = onPage === passage.quote;
                    const missing = state && state !== 'looking' && !state.found;
                    return (_jsx("li", { className: `${live ? 'is-live' : ''}${missing ? ' is-missing' : ''}`, children: _jsxs("button", { type: "button", className: "chat-passage-row", onClick: () => onShow(index), title: passage.source === 'explanation' ? 'Scroll the explanation to this passage and mark it' : 'Scroll the paper to this passage and mark it', children: [_jsx("span", { className: "chat-passage-n", children: index + 1 }), _jsxs("span", { className: "chat-passage-body", children: [_jsx("b", { children: passage.label }), _jsx("q", { children: passage.quote }), _jsxs("span", { className: "chat-passage-meta", children: [passage.section ? _jsx("i", { children: passage.section }) : null, passage.page ? _jsxs("i", { children: ["p. ", passage.page] }) : null, live && state && state !== 'looking' && state.pageOnly ? (_jsxs("span", { className: "ok live", children: [_jsx("span", { className: "dot" }), " Opened at page ", state.page] })) : live ? (_jsxs("span", { className: "ok live", children: [_jsx("span", { className: "dot" }), " On the page now"] })) : state === 'looking' ? (_jsx("span", { children: "Finding it\u2026" })) : state?.found && state.pageOnly ? (_jsxs("span", { className: "ok", children: ["Opened at page ", state.page] })) : missing ? (_jsx("span", { className: "bad", children: state.reason ?? 'Not found on the page' })) : null] })] }), _jsxs("span", { className: "chat-passage-go", children: [live ? 'Shown' : 'Show', _jsx("svg", { viewBox: "0 0 16 16", width: "12", height: "12", "aria-hidden": "true", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", children: _jsx("path", { d: "M4 8h8M8.5 4.5 12 8l-3.5 3.5" }) })] })] }) }, index));
                }) })] }));
}
/** The quote of the passage marked on the page right now, if any. */
function usePassageOnPage() {
    const [quote, setQuote] = useState(null);
    useEffect(() => {
        const on = (event) => setQuote(event.detail?.quote ?? null);
        window.addEventListener(FLASH_EVENT, on);
        return () => window.removeEventListener(FLASH_EVENT, on);
    }, []);
    return quote;
}
const PEEK_WIDTH = 320;
/** Under the name when there is room, over it when there is not; always on the page. */
function peekPlace(box) {
    const left = clamp(box.left, 8, window.innerWidth - PEEK_WIDTH - 8);
    const below = window.innerHeight - box.bottom > 230;
    return below
        ? { left, top: box.bottom + 6, width: PEEK_WIDTH }
        : { left, bottom: window.innerHeight - box.top + 6, width: PEEK_WIDTH };
}
/** A picture in the chat: a click opens it at full size in the window, another puts it back. */
const togglePicture = (target) => {
    const picture = target.closest('img.chat-image, .chat-attachments img');
    if (!picture || !picture.src)
        return false;
    picture.classList.toggle('is-open');
    return true;
};
/** A page's site, for the line that says it was read. */
function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    }
    catch {
        return url;
    }
}
function TurnView({ turn, index, actions, question, sent }) {
    const textRef = useRef(null);
    const isClaude = turn.role !== 'user';
    const pointed = isClaude ? splitPassages(turn.content) : { text: turn.content, passages: [] };
    const passages = pointed.passages;
    const { text, papers } = isClaude ? readingList(pointed.text) : { text: turn.content, papers: [] };
    const [shown, setShown] = useState({});
    const onPage = usePassageOnPage();
    const showAt = useCallback((at) => {
        const passage = passages[at];
        if (!passage)
            return;
        setShown((current) => ({ ...current, [at]: 'looking' }));
        void showPassage({ ...passage, n: at + 1 }).then((result) => setShown((current) => ({ ...current, [at]: result })));
    }, 
    // The passages are re-read from the content on every render; their text is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(passages)]);
    // The moment an answer finishes, the passage it was asked for is shown —
    // not when an old conversation is reopened, which never streams.
    const wasStreaming = useRef(turn.streaming);
    useEffect(() => {
        if (wasStreaming.current && !turn.streaming && passages.length) {
            const pick = passages.findIndex((passage) => passage.show);
            const at = pick >= 0 ? pick : question && asksWhere(question) ? 0 : -1;
            if (at >= 0)
                showAt(at);
        }
        wasStreaming.current = turn.streaming;
    }, [turn.streaming, passages, question, showAt]);
    const order = papers.map((paper) => paperKey(paper.title)).join('\n');
    // Each name in the text carries its paper's number, as its row in the list
    // does; once the answer is in, the papers' cards are set into it.
    useLayoutEffect(() => {
        const container = textRef.current;
        if (!container)
            return;
        const keys = order.split('\n');
        container.querySelectorAll('.chat-mention').forEach((mention) => {
            const n = keys.indexOf(paperKey(mention.dataset.paper ?? '')) + 1;
            if (n)
                mention.dataset.n = String(n);
            mention.dataset.turn = String(index);
        });
        void typesetMath(container);
        if (turn.streaming)
            return;
        placeFigures(container, sent);
        placeCards(container, papers, actions.layout);
        markAdds(container, (title) => actions.adds[paperKey(title)]);
    });
    if (!isClaude) {
        return (_jsxs("div", { className: "chat-turn chat-user", children: [turn.images?.length ? (_jsx("div", { className: "chat-attachments", onClick: (event) => togglePicture(event.target), children: turn.images.map((image, at) => (_jsx("img", { src: `data:image/jpeg;base64,${image.data}`, alt: image.label, title: `${image.label.replace(/:$/, '')} — click to see it at full size`, loading: "lazy", decoding: "async" }, at))) })) : turn.shot ? (_jsx("span", { className: "chat-shot-tag", children: "Screenshot attached" })) : null, _jsx("div", { className: "chat-text", 
                    // The quote that leads a question renders as a quote; the rest is plain text.
                    dangerouslySetInnerHTML: { __html: DOMPurify.sanitize(markdown(turn.content)) } })] }));
    }
    // Cell mentions link to the notebook while the Explain page is open, where the Colab tab is a click away.
    const explainOpen = typeof document !== 'undefined' && Boolean(document.querySelector('.explain'));
    const show = (key) => {
        const mention = Array.from(textRef.current?.querySelectorAll('.chat-mention') ?? []).find((el) => paperKey(el.dataset.paper ?? '') === key);
        if (!mention)
            return;
        mention.scrollIntoView({ block: 'center', behavior: 'smooth' });
        mention.classList.remove('is-flash');
        void mention.offsetWidth;
        mention.classList.add('is-flash');
        window.setTimeout(() => actions.peek(index, key, mention, true), 380);
    };
    return (_jsxs("div", { className: `chat-turn chat-claude${turn.streaming ? ' is-streaming' : ''}`, children: [_jsxs("div", { className: "chat-who", "aria-hidden": "true", children: [_jsx("span", { className: "chat-avatar", children: _jsx(SparkleIcon, { size: 11 }) }), turn.model ? modelSpec(turn.model).label : 'Claude'] }), turn.steps?.length ? (_jsx("ul", { className: "chat-steps", "aria-label": "What the model looked up", children: turn.steps.map((step, at) => {
                    const busy = !step.outcome && turn.streaming;
                    const what = step.tool === 'web_search' ? `${busy ? 'Searching' : 'Searched'} for “${step.what}”` : `${busy ? 'Reading' : 'Read'} ${hostOf(step.what)}`;
                    return (_jsxs("li", { className: busy ? 'is-busy' : undefined, title: step.tool === 'read_page' ? step.what : undefined, children: [step.tool === 'web_search' ? _jsx(SearchIcon, { size: 12 }) : _jsx(FileIcon, { size: 12 }), _jsx("span", { children: what }), step.outcome ? _jsxs("span", { className: "chat-step-outcome", children: ["\u00B7 ", step.outcome] }) : null] }, at));
                }) })) : null, turn.thinking?.trim() ? (_jsxs("details", { className: "chat-thinking", children: [_jsx("summary", { children: "Reasoning" }), _jsx("div", { children: turn.thinking })] })) : null, text ? (_jsx("div", { ref: textRef, className: "chat-text", onClick: (event) => {
                    const target = event.target;
                    if (togglePicture(target))
                        return;
                    const cell = target.closest('.chat-cell');
                    if (cell) {
                        // A cell named in the answer: the notebook brings it into view, on the Colab tab.
                        event.preventDefault();
                        showNotebookCell(Number(cell.dataset.cell));
                        return;
                    }
                    const link = target.closest('.chat-passage');
                    if (!link)
                        return;
                    event.preventDefault();
                    showAt(Number(link.dataset.passage) - 1);
                }, dangerouslySetInnerHTML: { __html: DOMPurify.sanitize(explainOpen ? linkCells(markdown(text)) : markdown(text), { ADD_ATTR: ['target'] }) } }, actions.layout)) : null, passages.length && !turn.streaming ? _jsx(PassageList, { passages: passages, shown: shown, onShow: showAt, onPage: onPage }) : null, papers.length && !turn.streaming ? _jsx(ReadingList, { papers: papers, actions: actions, onShow: show }) : null, text || papers.length || passages.length ? null : turn.streaming ? (_jsxs("p", { className: "chat-wait", children: [_jsx("span", { className: "chat-dot" }), _jsx("span", { className: "chat-dot" }), _jsx("span", { className: "chat-dot" })] })) : null, turn.error ? _jsx("p", { className: "chat-err", children: turn.error }) : null, turn.truncated ? _jsx("p", { className: "chat-note", children: "The answer hit the length cap. Ask for the rest." }) : null] }));
}
/** Save a key for a provider, after a second look if it does not look like one of theirs. */
function saveChecked(value, provider) {
    const key = value.trim();
    if (!key)
        return false;
    const info = PROVIDERS[provider];
    if (!looksLikeKey(key, provider) && !confirm(`That does not look like one of ${info.company}’s API keys (they start with "${info.keyPrefix}"). Save it anyway?`))
        return false;
    saveKey(key, provider);
    return true;
}
function KeyInput({ provider, onSaved }) {
    const [value, setValue] = useState('');
    const info = PROVIDERS[provider];
    const save = () => {
        if (saveChecked(value, provider)) {
            setValue('');
            onSaved?.();
        }
    };
    return (_jsxs("div", { className: "chat-key-row", children: [_jsx("input", { type: "password", className: "chat-key-input", placeholder: info.placeholder, autoComplete: "off", spellCheck: false, value: value, onChange: (event) => setValue(event.target.value), onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        save();
                    }
                }, "aria-label": `${info.company} API key` }), _jsx("button", { type: "button", className: "btn primary sm", onClick: save, children: "Save" })] }));
}
/**
 * A provider's key in the ⚙ menu and Settings. By default a provider runs on
 * the site's key, through the paper proxy; a key of your own, pasted here,
 * goes before it, and forgetting it goes back. Gemini is the site's key only.
 */
export function KeyRow({ provider }) {
    const info = PROVIDERS[provider];
    const own = useSyncExternalStore(subscribe, () => getState().own[provider]);
    const site = useSyncExternalStore(subscribe, () => getState().site[provider]);
    const [adding, setAdding] = useState(false);
    const note = siteNote(provider, site);
    if (info.viaProxy) {
        return (_jsxs("div", { className: site === 'ready' ? 'set-key' : 'set-key-add', children: [site === 'ready' ? _jsx("span", { className: "set-key-dot", "aria-hidden": "true" }) : null, _jsxs("span", { children: [_jsx("b", { children: info.company }), " \u00B7 ", info.name, " \u00B7 ", note.short, " \u2014 no key is kept in this browser"] })] }));
    }
    if (own) {
        return (_jsxs("div", { className: "set-key", children: [_jsx("span", { className: "set-key-dot", "aria-hidden": "true" }), _jsxs("span", { children: [_jsx("b", { children: info.company }), " \u00B7 your own key \u00B7 usage bills your own account"] }), _jsx("button", { type: "button", className: "btn sm danger", onClick: () => forgetKey(provider), title: site === 'ready' ? `Forget your key and go back to the site’s ${info.name} key` : 'Forget your key', children: site === 'ready' ? 'Use the site’s key' : 'Forget' })] }));
    }
    if (site === 'ready' && !adding) {
        return (_jsxs("div", { className: "set-key", children: [_jsx("span", { className: "set-key-dot", "aria-hidden": "true" }), _jsxs("span", { children: [_jsx("b", { children: info.company }), " \u00B7 on the site\u2019s key, through your paper proxy"] }), _jsx("button", { type: "button", className: "btn sm", onClick: () => setAdding(true), title: `Use a ${info.company} key of your own instead, sent straight to ${info.host}`, children: "Use my own key" })] }));
    }
    return (_jsxs("div", { className: "set-key-add", children: [_jsxs("span", { children: [_jsx("b", { children: info.company }), " \u00B7 ", site === 'ready' ? 'your own key, in place of the site’s' : `no key yet (the site’s: ${note.short})`, " \u2014", ' ', _jsx("a", { href: info.consoleUrl, target: "_blank", rel: "noopener noreferrer", children: "get one" }), site === 'ready' ? (_jsxs(_Fragment, { children: [' ', "\u00B7", ' ', _jsx("button", { type: "button", className: "link-btn", onClick: () => setAdding(false), children: "keep the site\u2019s" })] })) : null] }), _jsx(KeyInput, { provider: provider, onSaved: () => setAdding(false) })] }));
}
function KeyCard({ provider }) {
    const info = PROVIDERS[provider];
    const readiness = useSyncExternalStore(subscribe, () => getState().site[provider]);
    if (info.viaProxy) {
        return (_jsxs("div", { className: "chat-card", children: [_jsxs("h3", { children: [info.name, " runs on your paper proxy"] }), _jsx("p", { children: siteNote(provider, readiness).long }), _jsx("p", { className: "chat-card-note", children: "Or pick a Claude or DeepSeek model above." })] }));
    }
    return (_jsxs("div", { className: "chat-card", children: [_jsxs("h3", { children: ["Connect your ", info.company, " account"] }), _jsx("p", { className: "chat-card-note", children: siteNote(provider, readiness).long }), _jsxs("p", { children: [info.company, " does not offer a \u201Csign in with ", info.name, "\u201D for other websites", provider === 'anthropic' ? ', and a Claude.ai subscription cannot be spent from a web page' : '', " \u2014 so ", info.name, " models need an", ' ', _jsx("strong", { children: "API key" }), " from the developer console. Or pick a model from another provider above."] }), _jsxs("ol", { children: [_jsxs("li", { children: ["Open", ' ', _jsx("a", { href: info.consoleUrl, target: "_blank", rel: "noopener noreferrer", children: info.consoleUrl.replace(/^https:\/\//, '') }), ' ', "and create a key."] }), _jsxs("li", { children: ["Paste it below. It is stored in this browser only and sent straight to ", info.host, " \u2014 nobody else sees it."] })] }), _jsx(KeyInput, { provider: provider }), _jsxs("p", { className: "chat-card-note", children: ["Usage bills your own ", info.company, " account. Forget the key any time from the \u2699 menu."] })] }));
}
export default function Assistant({ onClose, screen, reading }) {
    const s = useSyncExternalStore(subscribe, getState);
    const [drawer, setDrawer] = useState(null);
    const [input, setInput] = useState('');
    const [said, setSaid] = useState('');
    const [shooting, setShooting] = useState(false);
    const [shotError, setShotError] = useState('');
    // The browser asks each time; a refusal is not an error worth more than a line.
    const takeShot = async () => {
        if (shooting)
            return;
        setShooting(true);
        setShotError('');
        try {
            setShot(await captureTab());
        }
        catch (error) {
            const name = error?.name;
            setShotError(name === 'NotAllowedError' || name === 'AbortError' ? '' : `No screenshot — ${String(error?.message ?? error).replace(/\.$/, '')}.`);
        }
        finally {
            setShooting(false);
            inputRef.current?.focus();
        }
    };
    // ---- the frame ------------------------------------------------------------
    const { win, rectRef, floating, persist, place, frame: raise, position, bar, grips } = useFloatingWindow({
        id: 'assistant',
        store: 'reader.assistant.window',
        name: `${ASSISTANT_NAME} window`,
        say: setSaid,
    });
    // A paper named in an answer is searched for in Discover. The pane opens on the
    // right, which is where the window stands by default, so the window steps
    // left of it once it is there — the result it opened is the point.
    const findPaper = (title) => {
        discover(title, title);
        if (stacked())
            return;
        let tries = 0;
        const step = () => {
            const pane = document.querySelector('.discover-panel');
            if (!pane) {
                if ((tries += 1) < 20)
                    requestAnimationFrame(step);
                return;
            }
            const next = clearOf(rectRef.current, pane.getBoundingClientRect().left, viewport());
            if (next)
                place(next);
        };
        requestAnimationFrame(step);
    };
    // ---- the papers an answer names ------------------------------------------
    // Pointing at a name shows its paper's card beside it; a press keeps the card
    // until it is closed. The card lives on the page, not in the window, so the
    // window's edge never clips it.
    const { collections, createCollection, addPaper, papers: library, settings, updateSettings } = useStore();
    const [peek, setPeek] = useState(null);
    const peekTimer = useRef(0);
    const [adds, setAdds] = useState({});
    // A paper already in the library is added already.
    const inLibrary = new Set(library.map((paper) => paperKey(paper.title)));
    const addState = { ...Object.fromEntries([...inLibrary].map((key) => [key, 'added'])), ...adds };
    const addPapers = async (wanted) => {
        const todo = wanted.filter((paper) => addState[paperKey(paper.title)] !== 'added');
        if (!todo.length)
            return;
        setAdds((current) => ({ ...current, ...Object.fromEntries(todo.map((paper) => [paperKey(paper.title), 'adding'])) }));
        const list = collections.find((collection) => collection.name === 'Reading list') ?? (await createCollection('Reading list'));
        // Two at a time: every one is a search of every source.
        const queue = [...todo];
        const next = async () => {
            const paper = queue.shift();
            if (!paper)
                return;
            const key = paperKey(paper.title);
            let state = 'missing';
            try {
                const found = await resolvePaper(paper.title);
                if (found) {
                    await addPaper(found, list.id);
                    state = 'added';
                }
            }
            catch {
                state = 'missing';
            }
            setAdds((current) => ({ ...current, [key]: state }));
            return next();
        };
        await Promise.all([next(), next()]);
    };
    const showPeek = (turn, key, anchor, pinned) => {
        clearTimeout(peekTimer.current);
        setPeek({ turn, key, anchor, pinned });
    };
    const hidePeekSoon = () => {
        clearTimeout(peekTimer.current);
        peekTimer.current = window.setTimeout(() => setPeek((current) => (current?.pinned ? current : null)), 220);
    };
    const paperLayout = useLayout();
    const actions = { layout: paperLayout, find: findPaper, peek: showPeek, adds: addState, add: (wanted) => void addPapers(wanted) };
    useEffect(() => {
        if (!peek?.pinned)
            return;
        const onKey = (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                setPeek(null);
            }
        };
        const onDown = (event) => {
            const target = event.target;
            if (!target.closest('.chat-peek, .chat-mention'))
                setPeek(null);
        };
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('pointerdown', onDown);
        return () => {
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('pointerdown', onDown);
        };
    }, [peek?.pinned]);
    // The name whose card is open reads as pressed.
    useEffect(() => {
        const anchor = peek?.anchor;
        anchor?.setAttribute('aria-expanded', 'true');
        return () => anchor?.setAttribute('aria-expanded', 'false');
    }, [peek?.anchor]);
    const peeked = peek ? readingList(s.turns[peek.turn]?.content ?? '').papers : [];
    const peekIndex = peek ? peeked.findIndex((paper) => paperKey(paper.title) === peek.key) : -1;
    const cycleStyle = () => {
        const i = STYLES.findIndex((x) => x.id === win.style);
        const next = STYLES[(i + 1) % STYLES.length];
        persist(rectRef.current, { style: next.id, tint: next.tint });
        setSaid(`Window style: ${next.label}`);
    };
    // ---- the keyboard ---------------------------------------------------------
    // Moving the window by the keys is the frame's (`useFloatingWindow`).
    // Escape from inside the window closes it.
    useEffect(() => {
        const onKey = (event) => {
            if (event.key === 'Escape' && !(event.metaKey || event.ctrlKey) && frame.current?.contains(document.activeElement)) {
                event.preventDefault();
                if (s.live)
                    stop();
                else
                    onClose();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose, s.live]);
    // ---- the thread -----------------------------------------------------------
    const frame = useRef(null);
    const body = useRef(null);
    const inputRef = useRef(null);
    const following = useRef(true);
    useEffect(() => {
        inputRef.current?.focus();
    }, []);
    // A quote attached from the paper is something to ask about: go to the box.
    useEffect(() => {
        if (s.quote)
            inputRef.current?.focus();
    }, [s.quote]);
    // Follow a streaming answer down, unless the reader has scrolled up to reread.
    useLayoutEffect(() => {
        const el = body.current;
        if (el && following.current)
            el.scrollTop = el.scrollHeight;
    }, [s.turns]);
    // Every code block gets a Copy button, once.
    useEffect(() => {
        body.current?.querySelectorAll('.chat-claude pre').forEach((pre) => {
            if (pre.querySelector('.chat-copy'))
                return;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn sm chat-copy';
            button.textContent = 'Copy';
            pre.append(button);
        });
    });
    const grow = () => {
        const el = inputRef.current;
        if (!el)
            return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    };
    const submit = (event) => {
        event?.preventDefault();
        const text = input.trim();
        if (!text || s.live || !s.hasKey)
            return;
        following.current = true;
        setInput('');
        requestAnimationFrame(grow);
        void send(text, screen());
    };
    const ideas = reading
        ? ['What is the main contribution, in two sentences?', 'Explain the passage I am looking at.', 'What would I need to know to follow section 3?']
        : ['Which of these papers should I read first?', 'What do these papers have in common?'];
    const model = modelSpec(s.prefs.model);
    const provider = PROVIDERS[model.provider];
    // The Web button: whether this model can use the web from here, and whether it is on.
    const webReady = webUsable(model.id, s.web);
    const webOn = Boolean(s.prefs.web) && webReady;
    const style = styleAt(win.style);
    return (_jsxs("section", { ref: frame, className: `assistant-win${floating ? ' is-floating' : ' is-sheet'}`, "data-win-style": style.id, style: position, role: "dialog", "aria-modal": "false", "aria-label": ASSISTANT_NAME, ...raise, children: [_jsxs("header", { className: "win-bar", ...bar, children: [_jsx(SparkleIcon, { size: 15, className: "win-mark" }), _jsx("span", { className: "win-name", children: ASSISTANT_NAME }), _jsxs("span", { className: "win-ctl", children: [floating ? (_jsxs(_Fragment, { children: [_jsxs("label", { className: "win-tint", title: "Window transparency", children: [_jsx("span", { "aria-hidden": "true", children: "\u25D0" }), _jsx("input", { type: "range", min: 25, max: 100, step: 5, value: Math.round(win.tint * 100), "aria-label": "Window opacity", onChange: (event) => persist(rectRef.current, { tint: clamp(Number(event.target.value) / 100, 0.25, 1) }) })] }), _jsx("button", { type: "button", className: "win-btn win-style", onClick: cycleStyle, title: "Change the window's look", children: style.label })] })) : null, _jsx("button", { type: "button", className: "win-btn", onClick: onClose, "aria-label": `Close ${ASSISTANT_NAME}`, title: "Close (Esc, or \u2318\\)", children: _jsx(CloseIcon, { size: 14 }) })] })] }), _jsxs("div", { className: "chat-toolbar", children: [_jsx(ModelChip, { value: model.id, keys: s.keys, disabled: s.live, what: "Answers with", align: "left", view: "list", onChange: setModel }), _jsx("span", { style: { flexGrow: 1 } }), _jsxs("button", { type: "button", className: "btn ghost sm", "aria-pressed": drawer === 'history', onClick: () => setDrawer(drawer === 'history' ? null : 'history'), title: "Earlier conversations, kept in this browser", children: ["History", s.history.length ? _jsx("span", { className: "chat-count", children: s.history.length }) : null] }), _jsx("button", { type: "button", className: "btn ghost sm", disabled: s.live || !s.turns.length, onClick: () => {
                            newChat();
                            setDrawer(null);
                        }, title: "File this conversation in History and start a new one", children: "New chat" }), _jsx("button", { type: "button", className: "btn ghost sm", "aria-pressed": drawer === 'settings', onClick: () => setDrawer(drawer === 'settings' ? null : 'settings'), title: "What the model sees, where paper cards go, and your keys", "aria-label": "Settings", children: "\u2699" })] }), drawer === 'settings' ? (_jsx(ChatSettings, { context: s.prefs.context, paperLayout: paperLayout, marks: settings.chatMarks ?? 'auto', look: settings.passageLook ?? 'marker', onMarks: (chatMarks) => updateSettings({ chatMarks }), onLook: (passageLook) => updateSettings({ passageLook }) })) : drawer === 'history' ? (_jsxs("div", { className: "chat-drawer", children: [_jsx("div", { className: "chat-set-title", children: "Previous chats" }), s.history.length ? (_jsxs(_Fragment, { children: [s.history.map((chat) => {
                                const asks = chat.turns.filter((t) => t.role === 'user').length;
                                const current = chat.id === s.threadId;
                                return (_jsxs("div", { className: `chat-hist-row${current ? ' is-on' : ''}`, children: [_jsxs("button", { type: "button", className: "chat-hist-open", title: chat.title, "aria-current": current || undefined, disabled: s.live, onClick: () => {
                                                openChat(chat.id);
                                                setDrawer(null);
                                            }, children: [_jsx("span", { className: "chat-hist-title", children: chat.title }), _jsxs("span", { className: "chat-hist-meta", children: [asks, " question", asks === 1 ? '' : 's', " \u00B7 ", ago(chat.updated), current ? ' · open' : ''] })] }), _jsx("button", { type: "button", className: "chat-hist-del", onClick: () => deleteChat(chat.id), "aria-label": "Delete this chat", title: "Delete this chat", children: "\u2715" })] }, chat.id));
                            }), _jsxs("div", { className: "chat-hist-foot", children: [_jsx("p", { className: "chat-set-note", children: "Kept in this browser only \u2014 no account, nothing uploaded. The screen that went with each question is not stored." }), _jsx("button", { type: "button", className: "btn sm", onClick: () => {
                                            if (confirm(`Delete all ${s.history.length} saved chat${s.history.length === 1 ? '' : 's'} from this browser? This cannot be undone.`))
                                                clearHistory();
                                        }, children: "Delete all" })] })] })) : (_jsx("p", { className: "chat-set-note", children: "No chats yet. Every conversation is filed here as soon as it is answered, and stays in this browser until you delete it." }))] })) : null, _jsxs("div", { className: "chat-body", "data-marks": settings.chatMarks ?? 'auto', ref: body, onScroll: (event) => {
                    const el = event.currentTarget;
                    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                    // A kept card follows its name; one that was only pointed at goes.
                    if (peek)
                        setPeek(peek.pinned ? { ...peek } : null);
                }, onPointerOver: (event) => {
                    if (event.pointerType !== 'mouse')
                        return;
                    const mention = event.target.closest('.chat-mention');
                    if (!mention || peek?.pinned)
                        return;
                    clearTimeout(peekTimer.current);
                    peekTimer.current = window.setTimeout(() => showPeek(Number(mention.dataset.turn), paperKey(mention.dataset.paper ?? ''), mention, false), 180);
                }, onPointerOut: (event) => {
                    if (event.pointerType === 'mouse' && event.target.closest('.chat-mention'))
                        hidePeekSoon();
                }, onClick: (event) => {
                    const mention = event.target.closest('.chat-mention');
                    const cardButton = event.target.closest('.chat-card-find, .chat-card-add');
                    if (cardButton?.dataset.paper) {
                        const title = cardButton.dataset.paper;
                        return cardButton.classList.contains('chat-card-add') ? void addPapers([{ title }]) : findPaper(title);
                    }
                    if (mention) {
                        const key = paperKey(mention.dataset.paper ?? '');
                        if (peek?.pinned && peek.key === key)
                            return setPeek(null);
                        return showPeek(Number(mention.dataset.turn), key, mention, true);
                    }
                    const copy = event.target.closest('.chat-copy');
                    if (!copy)
                        return;
                    const code = copy.parentElement?.querySelector('code')?.textContent ?? '';
                    void navigator.clipboard?.writeText(code);
                    copy.textContent = 'Copied';
                    window.setTimeout(() => (copy.textContent = 'Copy'), 1200);
                }, children: [!s.hasKey ? _jsx(KeyCard, { provider: model.provider }) : null, s.hasKey && !s.turns.length ? (_jsxs("div", { className: "chat-empty", children: [_jsxs("p", { children: ["Just ask \u2014 ", model.label, " reads your screen first. ", reading ? 'The paper, the passage in view, what you have selected and your highlights' : 'The list you are looking at', ' ', "go along with the question, so there is nothing to paste. The \u2699 menu says exactly what, and lets you hold anything back."] }), _jsx("ul", { children: ideas.map((idea) => (_jsx("li", { children: _jsx("button", { type: "button", className: "link-btn", onClick: () => setInput(idea), children: idea }) }, idea))) })] })) : null, s.turns.map((turn, index) => (_jsx(TurnView, { index: index, turn: turn, actions: actions, question: s.turns[index - 1]?.role === 'user' ? s.turns[index - 1].content : undefined, sent: s.turns[index - 1]?.role === 'user' ? s.turns[index - 1].images : undefined }, index)))] }), s.quote ? (_jsxs("div", { className: "chat-quote", children: [_jsxs("span", { className: "chat-quote-text", children: ["\u201C", s.quote.length > 220 ? `${s.quote.slice(0, 219)}…` : s.quote, "\u201D"] }), _jsx("button", { type: "button", className: "win-btn", onClick: () => setQuote(''), "aria-label": "Remove the quoted passage", title: "Remove", children: _jsx(CloseIcon, { size: 12 }) })] })) : null, s.shot ? (_jsxs("div", { className: "chat-quote chat-shot", children: [_jsx("img", { src: `data:image/jpeg;base64,${s.shot}`, alt: "The screenshot that goes with the next question" }), _jsx("span", { className: "chat-quote-text", children: "A screenshot of this tab goes with your next question." }), _jsx("button", { type: "button", className: "win-btn", onClick: () => setShot(''), "aria-label": "Remove the screenshot", title: "Remove", children: _jsx(CloseIcon, { size: 12 }) })] })) : shotError ? (_jsx("p", { className: "chat-shot-error", children: shotError })) : null, _jsxs("form", { className: "chat-compose", onSubmit: submit, children: [canCapture() ? (_jsx("button", { type: "button", className: "btn sm chat-shot-btn", onClick: () => void takeShot(), disabled: !s.hasKey || s.live || shooting || !model.vision, "aria-label": "Attach a screenshot of this tab", title: model.vision ? 'Attach a screenshot of this tab — your browser asks first' : `${model.label} reads text only — pick a Claude model to send a screenshot`, children: _jsx(CameraIcon, { size: 16 }) })) : null, _jsx("button", { type: "button", className: `btn sm chat-web-btn${webOn ? ' is-on' : ''}`, "aria-pressed": webOn, disabled: !s.hasKey || s.live || !webReady, onClick: () => setWeb(!s.prefs.web), "aria-label": "Search the web", title: !webReady
                            ? model.provider === 'gemini'
                                ? `${model.label} cannot search the web from here — pick a Claude or DeepSeek model`
                                : webNote(s.web)
                            : webOn
                                ? `Web search is on: ${model.label} may search the web and read pages as it answers — click to turn it off`
                                : `Let ${model.label} search the web and read pages as it answers — click to turn it on${model.provider === 'anthropic' ? ' (Anthropic bills each search to your key)' : ''}`, children: _jsx(GlobeIcon, { size: 16 }) }), _jsx("textarea", { ref: inputRef, rows: 1, value: input, disabled: !s.hasKey, placeholder: s.hasKey ? (reading ? `Ask ${model.label} about this paper…` : `Ask ${model.label}…`) : provider.viaProxy ? `${provider.name} is not available yet — see above` : `Add a ${provider.company} API key above to start`, "aria-label": ASSISTANT_NAME, title: "\u21B5 sends \u00B7 \u21E7\u21B5 makes a new line", onChange: (event) => {
                            setInput(event.target.value);
                            grow();
                        }, onKeyDown: (event) => {
                            // ↵ sends, ⇧↵ makes a new line — the convention every chat box uses.
                            if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                submit();
                            }
                        } }), s.live ? (_jsx("button", { type: "button", className: "btn sm", onClick: stop, children: "Stop" })) : (_jsx("button", { type: "submit", className: "btn primary sm", disabled: !s.hasKey || !input.trim(), title: "Send (\u21B5) \u2014 \u21E7\u21B5 makes a new line", children: "Send" }))] }), grips.map(({ key, ...grip }) => (_jsx("div", { ...grip }, key))), _jsx("span", { className: "vh", "aria-live": "polite", children: said }), peek && peekIndex >= 0 && peek.anchor.isConnected
                ? createPortal(_jsxs("div", { className: "chat-peek", role: "dialog", "aria-label": peeked[peekIndex].title, style: peekPlace(peek.anchor.getBoundingClientRect()), onPointerEnter: () => clearTimeout(peekTimer.current), onPointerLeave: (event) => {
                        if (event.pointerType === 'mouse')
                            hidePeekSoon();
                    }, children: [peek.pinned ? (_jsx("button", { type: "button", className: "icon-btn chat-peek-close", "aria-label": "Close", onClick: () => setPeek(null), children: _jsx(CloseIcon, { size: 13 }) })) : null, _jsx(PaperCard, { paper: peeked[peekIndex], n: peekIndex + 1, actions: actions })] }), document.body)
                : null] }));
}
