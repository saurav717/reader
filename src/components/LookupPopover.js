import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { candidateWords, lookupBackground, lookupWord, referenceLinks } from '../lib/lookup';
import { lookupLineage } from '../lib/sources';
import { placeLookup } from '../lib/lookupPlace';
import { HIGHLIGHT_COLORS } from '../types';
import { BookIcon, CloseIcon, ExternalIcon, NoteIcon, TrashIcon, TreeIcon } from './icons';
const PANES = [
    { id: 'dictionary', label: 'Meaning' },
    { id: 'origins', label: 'Origins' },
    { id: 'comment', label: 'Comment' },
];
function yearOf(published) {
    const year = published ? new Date(published).getFullYear() : NaN;
    return Number.isFinite(year) ? String(year) : '—';
}
export default function LookupPopover({ paperId, target, onClose, onSelectHighlight }) {
    const { highlights, addHighlight, updateHighlight, deleteHighlight } = useStore();
    const box = useRef(null);
    const phrase = target.selector.exact.trim();
    const wordCount = phrase.split(/\s+/).length;
    // A word or a short phrase is most likely being looked up; a passage is
    // most likely being commented on.
    const [pane, setPane] = useState(() => (wordCount <= 3 ? 'dictionary' : 'comment'));
    // A two- or three-word phrase is asked about whole first — Wiktionary has
    // "neural network" and "gradient descent" — then word by word.
    const words = useMemo(() => {
        const single = candidateWords(phrase);
        const whole = phrase.toLowerCase().replace(/[^\p{L}\p{N}\s'-]+/gu, ' ').replace(/\s+/g, ' ').trim();
        return wordCount >= 2 && wordCount <= 3 && whole.length <= 40 && whole.includes(' ') ? [whole, ...single] : single;
    }, [phrase, wordCount]);
    const [word, setWord] = useState(() => words[0] || phrase);
    const [height, setHeight] = useState(260);
    const [entry, setEntry] = useState(null);
    const [wordState, setWordState] = useState('loading');
    const [wordError, setWordError] = useState('');
    const [background, setBackground] = useState(null);
    const [lineage, setLineage] = useState(null);
    const [originsState, setOriginsState] = useState('loading');
    const [originsError, setOriginsError] = useState('');
    // The comment pane writes a real highlight, so the text is marked up in the
    // paper the moment there is something to mark up — Acrobat's behaviour.
    const [commentId, setCommentId] = useState(null);
    const [colour, setColour] = useState('yellow');
    const comment = highlights.find((highlight) => highlight.id === commentId);
    const placement = placeLookup(target, height);
    // The card's height follows what it holds; the placement follows the height.
    useLayoutEffect(() => {
        const element = box.current;
        if (!element)
            return;
        const observer = new ResizeObserver(() => setHeight(element.offsetHeight));
        observer.observe(element);
        setHeight(element.offsetHeight);
        return () => observer.disconnect();
    }, []);
    useEffect(() => {
        setWord(words[0] || phrase);
    }, [words, phrase]);
    useEffect(() => {
        if (!word)
            return;
        const controller = new AbortController();
        setWordState('loading');
        setEntry(null);
        lookupWord(word, controller.signal)
            .then((found) => {
            setEntry(found);
            setWordState(found ? 'done' : 'missing');
        })
            .catch((error) => {
            if (error instanceof DOMException && error.name === 'AbortError')
                return;
            setWordError(error instanceof Error ? error.message : String(error));
            setWordState('error');
        });
        return () => controller.abort();
    }, [word]);
    // A phrase the dictionaries do not carry falls through to its first word.
    useEffect(() => {
        if (wordState === 'missing' && word === words[0] && word.includes(' ') && words[1])
            setWord(words[1]);
    }, [wordState, word, words]);
    useEffect(() => {
        const controller = new AbortController();
        setOriginsState('loading');
        Promise.all([
            lookupBackground(phrase, controller.signal).catch(() => null),
            lookupLineage(phrase, controller.signal),
        ])
            .then(([found, trail]) => {
            setBackground(found);
            setLineage(trail);
            setOriginsState('done');
        })
            .catch((error) => {
            if (error instanceof DOMException && error.name === 'AbortError')
                return;
            setOriginsError(error instanceof Error ? error.message : String(error));
            setOriginsState('error');
        });
        return () => controller.abort();
    }, [phrase]);
    useEffect(() => {
        const onKey = (event) => {
            if (event.key === 'Escape')
                onClose();
        };
        const onDown = (event) => {
            if (!box.current?.contains(event.target))
                onClose();
        };
        window.addEventListener('keydown', onKey);
        // Wait for the click that opened the box to finish before listening.
        const timer = window.setTimeout(() => window.addEventListener('mousedown', onDown), 0);
        return () => {
            window.clearTimeout(timer);
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('mousedown', onDown);
        };
    }, [onClose]);
    /** Mark the passage now, so the highlight appears as the comment is written. */
    const startComment = useCallback(async (withColour) => {
        setColour(withColour);
        if (commentId) {
            await updateHighlight(commentId, { color: withColour });
            return commentId;
        }
        const created = await addHighlight({
            paperId,
            color: withColour,
            exact: target.selector.exact,
            prefix: target.selector.prefix,
            suffix: target.selector.suffix,
            hint: target.selector.hint,
            section: target.section,
            tags: [],
            note: '',
        });
        setCommentId(created.id);
        onSelectHighlight(created.id);
        return created.id;
    }, [addHighlight, commentId, onSelectHighlight, paperId, target, updateHighlight]);
    const onCommentChange = async (text) => {
        const id = commentId ?? (await startComment(colour));
        await updateHighlight(id, { note: text });
    };
    const links = referenceLinks(phrase);
    return (_jsxs("div", { ref: box, className: `lookup is-${placement.side}`, style: { top: placement.top, left: placement.left, width: placement.width, maxHeight: placement.maxHeight }, role: "dialog", "aria-label": `Look up “${phrase.slice(0, 60)}”`, onContextMenu: (event) => event.stopPropagation(), children: [_jsxs("div", { className: "lookup-head", children: [_jsxs("p", { className: "lookup-quote", title: phrase, children: ["\u201C", phrase, "\u201D"] }), _jsx("button", { type: "button", className: "icon-btn sm", onClick: onClose, "aria-label": "Close the lookup box", children: _jsx(CloseIcon, { size: 15 }) })] }), _jsx("div", { className: "lookup-tabs", role: "tablist", "aria-label": "Lookup panes", children: PANES.map((item) => (_jsxs("button", { type: "button", role: "tab", id: `lookup-tab-${item.id}`, "aria-selected": pane === item.id, "aria-controls": `lookup-pane-${item.id}`, onClick: () => setPane(item.id), onKeyDown: (event) => {
                        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')
                            return;
                        const index = PANES.findIndex((entry) => entry.id === pane);
                        const next = PANES[(index + (event.key === 'ArrowRight' ? 1 : PANES.length - 1)) % PANES.length];
                        setPane(next.id);
                        document.getElementById(`lookup-tab-${next.id}`)?.focus();
                    }, tabIndex: pane === item.id ? 0 : -1, children: [item.id === 'dictionary' ? _jsx(BookIcon, { size: 13 }) : item.id === 'origins' ? _jsx(TreeIcon, { size: 13 }) : _jsx(NoteIcon, { size: 13 }), item.label] }, item.id))) }), _jsxs("div", { className: "lookup-panes", children: [_jsxs("section", { className: "lookup-pane", role: "tabpanel", id: "lookup-pane-dictionary", "aria-labelledby": "lookup-tab-dictionary", hidden: pane !== 'dictionary', children: [words.length > 1 ? (_jsx("div", { className: "lookup-words", children: words.map((item) => (_jsx("button", { type: "button", className: "chip", "aria-pressed": item === word, onClick: () => setWord(item), children: item }, item))) })) : null, wordState === 'loading' ? (_jsxs("p", { className: "lookup-note", children: [_jsx("span", { className: "spinner" }), " Looking up \u201C", word, "\u201D\u2026"] })) : null, wordState === 'missing' ? (_jsxs("p", { className: "lookup-note", children: ["No dictionary entry for \u201C", word, "\u201D. It may be a term of art \u2014 Origins traces where it came from."] })) : null, wordState === 'error' ? _jsx("p", { className: "lookup-note", children: wordError || 'The dictionary could not be reached.' }) : null, entry ? (_jsxs(_Fragment, { children: [_jsxs("p", { className: "lookup-word", children: [entry.word, entry.phonetic ? _jsxs("span", { className: "mono", children: [" ", entry.phonetic] }) : null] }), entry.formOf ? _jsx("p", { className: "lookup-form", children: entry.formOf }) : null, entry.senses.map((sense, index) => (_jsxs("div", { className: "lookup-sense", children: [_jsx("span", { className: "eyebrow", children: sense.partOfSpeech }), _jsx("ol", { children: sense.definitions.map((definition) => (_jsxs("li", { children: [definition.definition, definition.example ? _jsxs("em", { children: [" \u201C", definition.example, "\u201D"] }) : null] }, definition.definition))) }), sense.synonyms.length ? (_jsxs("p", { className: "lookup-synonyms", children: ["Also: ", sense.synonyms.join(', ')] })) : null] }, `${sense.partOfSpeech}-${index}`)))] })) : null, _jsxs("div", { className: "lookup-links", children: [entry ? _jsxs("span", { className: "lookup-credit", children: ["From ", entry.source] }) : null, _jsxs("a", { className: "lookup-link", href: `https://en.wiktionary.org/wiki/${encodeURIComponent(word.replace(/ /g, '_'))}`, target: "_blank", rel: "noreferrer noopener", children: ["Wiktionary ", _jsx(ExternalIcon, { size: 11 })] })] })] }), _jsxs("section", { className: "lookup-pane", role: "tabpanel", id: "lookup-pane-origins", "aria-labelledby": "lookup-tab-origins", hidden: pane !== 'origins', children: [originsState === 'loading' ? (_jsxs("p", { className: "lookup-note", children: [_jsx("span", { className: "spinner" }), " Tracing the phrase\u2026"] })) : null, originsState === 'error' ? _jsx("p", { className: "lookup-note", children: originsError }) : null, background ? (_jsxs("div", { className: "lookup-background", children: [_jsxs("a", { href: background.url, target: "_blank", rel: "noreferrer noopener", children: [background.title, " ", _jsx(ExternalIcon, { size: 11 })] }), background.description ? _jsx("span", { className: "lookup-kicker", children: background.description }) : null, _jsx("p", { children: background.extract })] })) : null, lineage?.earliest.length ? (_jsxs(_Fragment, { children: [_jsx("span", { className: "eyebrow", children: "Earliest papers using it" }), _jsx("ul", { className: "lookup-papers", children: lineage.earliest.map((paper) => (_jsxs("li", { children: [_jsx("a", { href: paper.landingUrl || `https://openalex.org/${paper.id}`, target: "_blank", rel: "noreferrer noopener", children: paper.title }), _jsxs("span", { className: "lookup-paper-meta", children: [yearOf(paper.published), paper.authors[0] ? ` · ${paper.authors[0]}${paper.authors.length > 1 ? ' et al.' : ''}` : ''] })] }, paper.id))) })] })) : null, lineage?.influential.length ? (_jsxs(_Fragment, { children: [_jsx("span", { className: "eyebrow", children: "Most cited since" }), _jsx("ul", { className: "lookup-papers", children: lineage.influential.map((paper) => (_jsxs("li", { children: [_jsx("a", { href: paper.landingUrl || `https://openalex.org/${paper.id}`, target: "_blank", rel: "noreferrer noopener", children: paper.title }), _jsxs("span", { className: "lookup-paper-meta", children: [yearOf(paper.published), typeof paper.citedBy === 'number' ? ` · ${paper.citedBy.toLocaleString()} citations` : ''] })] }, paper.id))) })] })) : null, originsState === 'done' && !background && !lineage?.earliest.length && !lineage?.influential.length ? (_jsx("p", { className: "lookup-note", children: "Nothing indexed for this phrase. The links below search it directly." })) : null, _jsx("div", { className: "lookup-links", children: links.map((link) => (_jsxs("a", { className: "lookup-link", href: link.url, target: "_blank", rel: "noreferrer noopener", children: [link.label, " ", _jsx(ExternalIcon, { size: 11 })] }, link.label))) })] }), _jsxs("section", { className: "lookup-pane", role: "tabpanel", id: "lookup-pane-comment", "aria-labelledby": "lookup-tab-comment", hidden: pane !== 'comment', children: [_jsx("div", { className: "lookup-colours", role: "group", "aria-label": "Highlight colour", children: HIGHLIGHT_COLORS.map((item) => (_jsx("button", { type: "button", "aria-pressed": colour === item.id, "aria-label": item.label, title: item.label, onClick: () => void startComment(item.id), children: _jsx("span", { className: "swatch", style: { background: item.swatch } }) }, item.id))) }), _jsx("label", { className: "vh", htmlFor: "lookup-comment", children: "Comment on this passage" }), _jsx("textarea", { id: "lookup-comment", value: comment?.note ?? '', placeholder: "Write a comment \u2014 the passage is highlighted as you type.", onChange: (event) => void onCommentChange(event.target.value) }), _jsx("p", { className: "lookup-note", children: commentId
                                    ? `Highlighted and saved${target.section ? ` under “${target.section}”` : ''}. It is in the Highlights pane too.`
                                    : 'Typing here highlights the passage and pins the comment to it.' }), _jsxs("div", { className: "lookup-actions", children: [_jsx("button", { type: "button", className: "btn primary sm", onClick: onClose, disabled: !commentId, children: "Done" }), commentId ? (_jsxs("button", { type: "button", className: "btn sm danger", onClick: () => {
                                            void deleteHighlight(commentId);
                                            onSelectHighlight(null);
                                            setCommentId(null);
                                        }, children: [_jsx(TrashIcon, { size: 13 }), " Discard"] })) : null] })] })] })] }));
}
