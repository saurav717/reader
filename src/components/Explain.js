import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import DOMPurify from 'dompurify';
import { cleanFigure } from '../lib/sanitize';
import { typesetFigureMath } from '../lib/figureMath';
import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ASSISTANT_NAME, geminiNote, getState, looksLikeKey, MODELS, modelSpec, PROVIDERS, saveKey, setAskModel, setExplainModel, subscribe } from '../lib/assistant';
import ModelChip from './ModelChip';
import { applyEdits, caveatsOf, dismissPending, driveStateFor, explanationFor, generateExplanation, loadExplanation, motionOf, parseExplanation, reviseExplanation, sceneRequest, stopExplaining, subscribeExplain, undoRevision, VERDICTS, } from '../lib/explain';
import { dismissImplementPending, generateImplementation, computeOf, implementationFor, loadImplementation, reviseImplementation, bundleOf, notebookBundle, stopImplementing, subscribeImplement, undoImplementRevision, } from '../lib/implement';
import { findPassage, FLASH_EVENT, setExplainLocator, showPassage } from '../lib/locate';
import { markdown } from '../lib/markdown';
import { SHOW_IN_EXPLAIN, addClip, copyOf } from '../lib/notes';
import { selectedText } from '../lib/screen';
import { useStore } from '../lib/store';
import { motionText } from '../lib/motion';
import { MotionView, Stage } from './Motion';
import { typesetMath } from '../lib/typesetMath';
import { CloseIcon, ColabIcon, ExplainIcon, MoonIcon, NoteIcon, OpacityIcon, PlanIcon, SparkleIcon, SunIcon } from './icons';
import PlaygroundWorkspace from './PlaygroundWorkspace';
import { usePlaygrounds } from '../lib/playground';
import { ComputeBlock, FileBlock, HardwareSummary, ImplementEmpty, LocalMenu, PlanContext, RunConsole, runLocally, TreeBlock, useLocal } from './Implement';
import { attachUrl, CellRunOutput, ColabBanner, ColabChip, ColabMark, ConnectCard, RunState, useColab } from './Colab';
import MetricsPane from './MetricsPane';
import RuntimePane from './RuntimePane';
import NotebookPage, { FilesPane } from './Notebook';
import { notebookFileName, notebookFor, subscribeNotebook, toIpynb } from '../lib/notebook';
import { notebookAskFor, rewriteCells, rewriteNotebook, stopNotebookAsk, subscribeNotebookAsk } from '../lib/notebookAsk';
import { holdCell, SHOW_CELL } from '../lib/notebookNav';
import { colabNow } from '../lib/colab';
import { cellKey, colabAvailable, colabGranted, connect as connectColab, forgetRun, interrupt as interruptColab, outputText, runAll, runCell, useClient as useColabClient } from '../lib/colab';
import { KeepButton, KeepContext, tableText, useKept, useKeeper } from './Keep';
import BoxSnip from './BoxSnip';
import FigureCloseUp, { CLOSEUP_ART, closeUpVisuals } from './FigureCloseUp';
import { copyText } from './CopyBlock';
import CopyBlock from './CopyBlock';
import { findFigure, loadPaperFigures, paperFiguresFor, setFigureReader, subscribePaperFigures } from '../lib/paperFigures';
import { figuresOnScreen } from '../lib/figureReader';
// The paper's own figures are read from the Reflow column, or the PDF, when a page is written.
setFigureReader(figuresOnScreen);
import PassageFlash from './PassageFlash';
const LAYOUT_KEY = 'reader.explain.layout';
const LAYOUTS = [
    { id: 'margin', label: 'Margin', note: 'The prose on the left, its figures, code and caveats beside it in a wide margin' },
    { id: 'notebook', label: 'Notebook', note: 'One column of text and cells, the way a Colab notebook reads' },
    { id: 'beside', label: 'Beside the paper', note: 'The explanation over the right of the window, the paper still readable on the left' },
];
/** Scenes on the stage, where a section has one; off, the page is its figures and nothing moves. */
const STAGE_KEY = 'reader.explain.stage';
const readStage = () => {
    try {
        return localStorage.getItem(STAGE_KEY) !== 'off';
    }
    catch {
        return true;
    }
};
const readLayout = () => {
    try {
        const stored = localStorage.getItem(LAYOUT_KEY);
        if (stored === 'margin' || stored === 'notebook' || stored === 'beside')
            return stored;
    }
    catch {
        // private mode
    }
    return 'margin';
};
/**
 * Explain opens on the explanation. The one exception is the progress pill, which opens a paper on the
 * page being written: it asks for that page here, once, and the Explain that opens next takes it. An
 * Explain already open on that paper takes it as it stands, through the event; one open on another
 * paper leaves it for the Explain that mounts in its place.
 */
let askedPage = null;
const OPEN_ON = 'reader:explain-open-on';
/** Which page Explain opens the paper on next: for the progress pill, which opens the one being written. */
export function openExplainOn(paperId, page) {
    askedPage = { paperId, page };
    window.dispatchEvent(new CustomEvent(OPEN_ON, { detail: { paperId, page } }));
}
const STORES = {
    explain: {
        subscribe: subscribeExplain,
        get: explanationFor,
        driveState: driveStateFor,
        load: loadExplanation,
        generate: generateExplanation,
        revise: reviseExplanation,
        undo: undoRevision,
        dismiss: dismissPending,
        stop: stopExplaining,
    },
    implement: {
        subscribe: subscribeImplement,
        get: implementationFor,
        driveState: () => undefined,
        load: loadImplementation,
        generate: generateImplementation,
        revise: reviseImplementation,
        undo: undoImplementRevision,
        dismiss: dismissImplementPending,
        stop: stopImplementing,
    },
};
/** The two written pages, in the bar's tabs. The notebook is not a tab: Colab, beside Local on the right, opens it over whichever page is on. */
const PAGES = [
    { id: 'explain', label: 'Explanation', note: 'What the paper says: the problem, the method, why it works, and what has changed since' },
    { id: 'implement', label: 'Implementation', note: 'How to build it: what to reproduce, the datasets, the repository, the starter files, and what it costs on your machine' },
];
const NOTEBOOK_NOTE = 'Your notebook: cells of your own on your Colab runtime, the same kernel the pages’ cells run in, kept here. Its Export menu takes the notebook, the explanation or the plan’s scaffold out — an .ipynb, a zip, or a commit opened in Colab.';
const VERDICT_CELL = /<td>(Still holds|Holds|Refined(?: since)?|Superseded|Disputed|Disproved)<\/td>/gi;
/** A code block in prose, with a Copy button on its corner; the page's own click handler does the copying (see `copyProseCode`). */
const PROSE_PRE = /<pre(\s[^>]*)?>([\s\S]*?)<\/pre>/g;
/** Prose, with a verdict alone in a table cell (the "Since then" table) drawn as its chip, and each code block copyable. */
const html = (md) => DOMPurify.sanitize(markdown(md)
    .replace(VERDICT_CELL, (_, word) => {
    const verdict = word.toLowerCase().replace(/^still /, '').replace(/ since$/, '');
    return `<td><span class="verdict-chip v-${verdict}">${word}</span></td>`;
})
    .replace(PROSE_PRE, (whole) => `<div class="copy-block prose-code">${whole}<button type="button" class="copy-block-btn" data-copy-code="" aria-label="Copy — the whole block" title="Copy the whole block"></button></div>`), { ADD_ATTR: ['target'] });
/**
 * A click on a prose code block's Copy button, wherever on the page it is: the
 * prose is set as HTML, so its buttons are answered here, by delegation.
 * True when the click was one.
 */
function copyProseCode(target) {
    const button = target instanceof Element ? target.closest('button[data-copy-code]') : null;
    const pre = button?.parentElement?.querySelector('pre');
    if (!button || !pre)
        return false;
    // The label is drawn by the stylesheet, so the page's text — what is quoted, kept or sent — never reads "Copy".
    void copyText(pre.textContent ?? '').then((ok) => {
        button.classList.add(ok ? 'is-done' : 'is-failed');
        window.setTimeout(() => button.classList.remove('is-done', 'is-failed'), 1600);
    });
    return true;
}
// ---------------------------------------------------------------------------
// Python, coloured — a few regular expressions, not a parser
// ---------------------------------------------------------------------------
const PY_KEYWORDS = 'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield';
const PY_TOKENS = new RegExp([
    '(#[^\\n]*)', // comment
    '("""[\\s\\S]*?(?:"""|$)|\'\'\'[\\s\\S]*?(?:\'\'\'|$)|[rbfu]*"(?:\\\\.|[^"\\\\\\n])*"?|[rbfu]*\'(?:\\\\.|[^\'\\\\\\n])*\'?)', // string
    `\\b(${PY_KEYWORDS})\\b`, // keyword
    '\\b(\\d+(?:\\.\\d*)?(?:e[+-]?\\d+)?)\\b', // number
    '\\b([A-Za-z_]\\w*)(?=\\()', // a call
].join('|'), 'g');
/** The latest line of Claude's thinking summary, short enough for a status line. */
export function lastThought(thinking) {
    const line = thinking?.split('\n').map((l) => l.replace(/[*#_`]/g, '').trim()).filter(Boolean).at(-1);
    if (!line)
        return '';
    return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function highlightPython(code) {
    let out = '';
    let last = 0;
    for (const match of code.matchAll(PY_TOKENS)) {
        out += esc(code.slice(last, match.index));
        const [text, comment, string, keyword, number, call] = match;
        const kind = comment ? 'c' : string ? 's' : keyword ? 'k' : number ? 'n' : call ? 'f' : '';
        out += kind ? `<span class="tok-${kind}">${esc(text)}</span>` : esc(text);
        last = (match.index ?? 0) + text.length;
    }
    return out + esc(code.slice(last));
}
// ---------------------------------------------------------------------------
// The blocks
// ---------------------------------------------------------------------------
function CodeCell({ block, index, onAsk, asker, writer }) {
    const [copied, setCopied] = useState(false);
    const python = block.lang === 'python';
    const shell = block.lang === 'bash';
    // A shell cell runs on the reader's own machine once the scaffold is written there (the Local menu).
    const { project, console: local } = useLocal();
    // A Python cell runs in the reader's own Google Colab (src/lib/colab.ts). Its run is kept
    // under its code, so a cell Claude rewrites comes back as not run.
    const colab = useColab();
    const { settings } = useStore();
    const key = cellKey(block.code);
    const run = python ? colab.runs[key] : undefined;
    const live = run?.state === 'running' || run?.state === 'queued';
    const [card, setCard] = useState(false);
    const canRun = python && !block.open && colabAvailable(settings.googleClientId);
    const runIt = () => {
        // The first run in a tab that has never connected explains itself first; anything after runs on the click.
        if (colab.status === 'off' && !colabGranted()) {
            setCard(true);
            return;
        }
        void runCell(key, block.code).catch(() => undefined);
    };
    const runTitle = !python
        ? ''
        : block.open
            ? 'Ready once the cell is written'
            : !settings.googleClientId.trim()
                ? 'Running cells needs a Google client ID: Settings → Google'
                : !canRun
                    ? 'Running cells needs the reader’s proxy: Settings → Paper proxy'
                    : colab.status === 'connecting'
                        ? 'Connecting to Colab…'
                        : colab.running
                            ? 'Another cell is running'
                            : run
                                ? 'Run this cell again in your Colab runtime'
                                : 'Run exactly this code in your own Google Colab, and see what it prints here';
    return (_jsxs("figure", { className: `explain-cell${shell ? ' is-shell' : ''}${run ? ` has-run is-${run.state}` : ''}`, "data-key": python ? key : undefined, children: [_jsxs("header", { children: [_jsx("span", { className: `cell-index${live ? ' is-busy' : ''}`, children: python ? (live ? 'In [*]' : `In [${run?.executionCount ?? index}]`) : shell ? '$' : 'Out' }), _jsx("span", { className: "cell-title", children: block.title }), run ? _jsx(RunState, { run: run }) : null, _jsx(KeepButton, { selector: ".explain-cell", what: "cell" }), !live && !block.open ? (_jsx("button", { type: "button", className: "btn sm ghost", onClick: () => {
                            void copyText(block.code).then((ok) => {
                                setCopied(ok);
                                if (ok)
                                    window.setTimeout(() => setCopied(false), 1400);
                            });
                        }, title: "Copy the code of this cell", children: copied ? 'Copied ✓' : 'Copy' })) : null, python || shell ? (_jsxs(_Fragment, { children: [shell && project ? (_jsx("button", { type: "button", className: "btn sm local-run", disabled: local.running || block.open, onClick: () => void runLocally(block.code.trim()), title: `Run in ${project.dir}`, children: "\u25B6 Run locally" })) : null, python && live ? (_jsx("button", { type: "button", className: "btn sm colab-stop", onClick: () => void interruptColab(), title: "Interrupt the kernel", children: "\u25A0 Stop" })) : python ? (_jsxs("button", { type: "button", className: `btn sm colab${canRun && !run ? ' is-go' : ''}`, disabled: !canRun || colab.status === 'connecting' || Boolean(colab.running), onClick: runIt, title: runTitle, children: [_jsx(ColabMark, {}), run ? '▶ Run again' : '▶ Run in Colab'] })) : null] })) : null, card ? (_jsx(ConnectCard, { cellLabel: `In [${index}]`, busy: colab.status === 'connecting', onClose: () => setCard(false), onConnect: (machine) => {
                            void connectColab(machine)
                                .then(() => {
                                setCard(false);
                                return runCell(key, block.code);
                            })
                                .catch(() => undefined);
                        } })) : null] }), _jsxs("pre", { className: "cell-code", children: [_jsx("code", { dangerouslySetInnerHTML: { __html: python ? highlightPython(block.code) : esc(block.code) } }), block.open ? _jsx("span", { className: "caret", "aria-hidden": "true" }) : null] }), run ? (_jsx(CellRunOutput, { run: run, expected: block.output, asker: asker, writer: writer, onAsk: onAsk ? (request) => onAsk(request, block.code.slice(0, 1500)) : undefined, onForget: () => forgetRun(key) })) : block.output !== undefined ? (_jsxs("div", { className: "cell-output", children: [_jsx("div", { className: "cell-output-label", children: "Expected output \u00B7 written by Claude, not run yet" }), _jsx(CopyBlock, { code: block.output, label: "Copy output" })] })) : null] }));
}
function Figure({ block, onAnimate, writer }) {
    // Its labels' maths set as maths: SVG text is drawn as written, so `z_hat_{t+1}` would read as just that.
    const svg = useMemo(() => (block.open ? '' : typesetFigureMath(cleanFigure(block.svg))), [block.svg, block.open]);
    return (_jsxs("figure", { className: "explain-figure", children: [svg ? (
            // Click it, or press Enter on it, and the drawing opens close up, in the middle of the window.
            _jsx("div", { className: "figure-art", role: "button", tabIndex: 0, "aria-label": `See the figure close up${block.caption ? `: ${block.caption}` : ''}`, title: "Click for a close-up", dangerouslySetInnerHTML: { __html: svg } })) : (_jsx("div", { className: "figure-art drawing", children: "Drawing\u2026" })), block.caption ? _jsx("figcaption", { children: block.caption }) : null, onAnimate && block.animate && !block.open ? (_jsxs("div", { className: "figure-animate", children: [_jsx("button", { type: "button", className: "btn sm", onClick: () => onAnimate(block.caption), title: "Ask for this figure as a scene: the same drawing with a step for each paragraph, kept in view while you read the section", children: "\u25B6 Animate this figure" }), _jsxs("span", { children: ["Motion would help here, ", writer ?? 'the model', " thinks: the scene follows the paragraphs as you read."] })] })) : null] }));
}
/** The paper the page is about, for the paper's own figures it places (paperFigures.ts). */
const PaperContext = createContext(null);
/** One of the paper's own figures, where the page placed it: the picture kept from the paper, its name, and what to look at in it. */
function PaperFigureView({ block }) {
    const paperId = useContext(PaperContext);
    const figures = useSyncExternalStore(subscribePaperFigures, () => (paperId ? paperFiguresFor(paperId) : undefined));
    const figure = figures ? findFigure(figures, block.ref) : undefined;
    const name = figure?.ref ?? (block.ref || 'A figure');
    return (_jsxs("figure", { className: "explain-figure is-paper", "data-ref": name, children: [figure ? (
            // Click it, or press Enter on it, and it opens close up, like the figures the model drew.
            _jsx("div", { className: "figure-art paper-art", role: "button", tabIndex: 0, "aria-label": `See ${name} of the paper close up`, title: "Click for a close-up", children: _jsx("img", { src: `data:image/jpeg;base64,${figure.data}`, width: figure.width, height: figure.height, alt: `${name} of the paper${figure.caption ? `: ${figure.caption}` : ''}` }) })) : (_jsx("div", { className: "figure-art drawing paper-missing", children: block.open ? 'Placing the figure…' : figures ? `${name} is not among the figures read from this paper.` : `${name} of the paper — open the paper in Reflow, or write the page again, to read its figures.` })), _jsxs("figcaption", { children: [_jsxs("span", { className: "paper-figure-ref", children: [name, " \u00B7 from the paper"] }), block.caption ? ` — ${block.caption}` : null] }), block.md ? _jsx("div", { className: "paper-figure-note", dangerouslySetInnerHTML: { __html: html(block.md) } }) : null] }));
}
function Caveat({ block }) {
    return (_jsxs("aside", { className: `explain-caveat v-${block.verdict}`, children: [_jsxs("div", { className: "caveat-head", children: [_jsx("span", { className: "verdict", children: VERDICTS[block.verdict] }), block.title ? _jsx("strong", { children: block.title }) : null] }), _jsx("div", { className: "caveat-body", dangerouslySetInnerHTML: { __html: html(block.md) } })] }));
}
// ---------------------------------------------------------------------------
// Keeping a piece of the page in your notes
// ---------------------------------------------------------------------------
/** What on the page can be kept whole, by pointing at it. */
const KEEPABLE = '.explain-figure, .explain-motion, .explain-cell, .explain-caveat, .impl-tree, .impl-file, .impl-budget, .impl-colab, .explain-prose table, .explain-prose pre, .explain-prose .chat-math-block';
/** The pieces whose header holds the button itself (a KeepButton), so the corner button keeps off them. */
const OWN_BUTTON = '.explain-cell, .explain-motion, .impl-file, .impl-budget, .impl-colab';
/** What a box dragged over the page keeps, whole: each piece of it the box touches. */
const SNIPPABLE = '.explain-prose > *, .explain-figure, .explain-motion, .explain-cell, .explain-caveat, .impl-tree, .impl-file, .impl-budget, .impl-colab';
const firstLine = (text) => text.split('\n').map((line) => line.trim()).find(Boolean);
/** What a piece is called in the notes, and what it says as text. */
function describe(element) {
    if (element.matches('.explain-figure')) {
        const caption = element.querySelector('figcaption')?.textContent?.trim();
        return { label: 'Diagram', text: caption ? `[Diagram: ${caption}]` : '[Diagram]', quote: caption };
    }
    if (element.matches('.explain-motion')) {
        const text = element.getAttribute('data-text') ?? '[Scene]';
        const caption = element.querySelector('.motion-caption')?.textContent?.trim();
        return { label: 'Scene', text, quote: caption };
    }
    if (element.matches('.explain-cell')) {
        const code = element.querySelector('.cell-code')?.textContent ?? '';
        const output = element.querySelector('.cell-output pre')?.textContent;
        const title = element.querySelector('.cell-title')?.textContent?.trim();
        const input = element.querySelector('.cell-index')?.textContent?.startsWith('In');
        return {
            label: `${input ? 'Code' : 'Output'}${title ? ` · ${title}` : ''}`,
            text: output != null ? `${code}\n\n# Expected output\n${output}` : code,
            quote: firstLine(code),
        };
    }
    if (element.matches('.explain-caveat')) {
        const verdict = element.querySelector('.verdict')?.textContent?.trim();
        const body = element.querySelector('.caveat-body')?.textContent?.trim() ?? '';
        return { label: `Caveat${verdict ? ` · ${verdict}` : ''}`, text: body, quote: body.slice(0, 80) };
    }
    if (element.matches('.impl-tree')) {
        const rows = Array.from(element.querySelectorAll('.tree-name')).map((row) => row.textContent?.trim() ?? '');
        return { label: 'Repository layout', text: rows.join('\n'), quote: rows[0] };
    }
    if (element.matches('.impl-file')) {
        const path = element.getAttribute('data-path') ?? 'file';
        const code = element.querySelector('.cell-code')?.textContent ?? '';
        return { label: `File · ${path}`, text: `# ${path}\n${code}`, quote: firstLine(code) };
    }
    if (element.matches('.impl-budget')) {
        const table = element.querySelector('table');
        const machine = element.querySelector('.cell-title')?.textContent?.trim();
        return { label: machine ?? 'Compute budget', text: table ? tableText(table) : element.textContent ?? '' };
    }
    if (element.matches('.impl-colab')) {
        const rows = Array.from(element.querySelectorAll('.need-row, .colab-step, .live-tile')).map((row) => (row.textContent ?? '').replace(/\s+/g, ' ').trim());
        return { label: 'Run it on Colab', text: rows.join('\n') || (element.textContent ?? '') };
    }
    if (element.matches('table')) {
        const cell = element.querySelector('tr:nth-child(2) > *, td');
        return { label: 'Table', text: tableText(element), quote: cell?.textContent?.trim() };
    }
    if (element.matches('.chat-math-block'))
        return { label: 'Equation', text: `$$${element.dataset.tex ?? ''}$$` };
    const code = element.textContent ?? '';
    return { label: 'Code', text: code, quote: firstLine(code) };
}
/** A section as text: its prose, and a line for each figure, cell and caveat in it. */
function sectionText(section) {
    return section.blocks
        .map((block) => block.kind === 'prose'
        ? block.md
        : block.kind === 'figure'
            ? `[Diagram${block.caption ? `: ${block.caption}` : ''}]`
            : block.kind === 'paperFigure'
                ? `[${block.ref} of the paper${block.caption ? `: ${block.caption}` : ''}]${block.md ? ` ${block.md}` : ''}`
                : block.kind === 'motion'
                    ? motionText(block.title, block.spec)
                    : block.kind === 'code'
                        ? `\`\`\`\n${block.code}\n\`\`\`${block.output !== undefined ? `\n\nExpected output:\n\`\`\`\n${block.output}\n\`\`\`` : ''}`
                        : block.kind === 'tree'
                            ? `\`\`\`\n${block.text}\n\`\`\``
                            : block.kind === 'file'
                                ? `# ${block.path}\n\`\`\`\n${block.code}\n\`\`\``
                                : block.kind === 'compute'
                                    ? `Compute budget:\n${block.text}`
                                    : `${VERDICTS[block.verdict]}${block.title ? ` — ${block.title}` : ''}: ${block.md}`)
        .join('\n\n');
}
/**
 * A section, as rows: a run of prose, then whatever figures, cells and
 * caveats follow it. In the margin layout the two halves of a row sit side
 * by side, so a figure stands next to the paragraph it illustrates.
 */
function SectionView({ section, number, cells, onAdjust, onAsk, onKeep, onAnimate, stage, state, asker, writer, }) {
    const ref = useRef(null);
    const rows = [];
    // A tree, a starter file or the budget is a table's width: it goes in the reading column, not the margin.
    const wide = (block) => block.kind === 'prose' || block.kind === 'tree' || block.kind === 'file' || block.kind === 'compute';
    const motion = stage === 'off' ? undefined : motionOf(section);
    // The scene on the stage beside the whole section, not in a row of its own; with the stage off, not at all.
    const staged = stage === 'margin' && motion;
    for (const block of section.blocks) {
        if (block.kind === 'motion' && (staged || stage === 'off'))
            continue;
        const row = rows[rows.length - 1];
        if (wide(block)) {
            if (row && !row.side.length && block.kind === 'prose')
                row.prose.push(block);
            else
                rows.push({ prose: [block], side: [], wide: block.kind !== 'prose' });
        }
        else if (row)
            row.side.push(block);
        else
            rows.push({ prose: [], side: [block] });
    }
    const draw = (block, key) => block.kind === 'prose' ? (_jsx("div", { className: "explain-prose", dangerouslySetInnerHTML: { __html: html(block.md) } }, key)) : block.kind === 'figure' ? (_jsx(Figure, { block: block, writer: writer, onAnimate: onAnimate && stage !== 'off' && !motion && state !== 'revising' ? (caption) => onAnimate(section.title, caption) : undefined }, key)) : block.kind === 'paperFigure' ? (_jsx(PaperFigureView, { block: block }, key)) : block.kind === 'motion' ? (_jsx(MotionView, { block: block, compact: stage === 'inline', writer: asker ?? writer }, key)) : block.kind === 'code' ? (_jsx(CodeCell, { block: block, index: cells.get(block) ?? 0, asker: asker, writer: writer, onAsk: onAsk ? (request, quote) => onAsk(section.title, request, quote) : undefined }, key)) : block.kind === 'tree' ? (_jsx(TreeBlock, { block: block }, key)) : block.kind === 'file' ? (_jsx(FileBlock, { block: block }, key)) : block.kind === 'compute' ? (_jsx(ComputeBlock, { block: block }, key)) : (_jsx(Caveat, { block: block }, key));
    return (_jsxs("section", { ref: ref, className: `explain-section${state ? ` is-${state}` : ''}${staged ? ' has-stage' : ''}`, id: `explain-${section.id}`, "data-section": section.id, "data-title": section.title, children: [section.title ? (_jsxs("header", { className: "explain-section-head", children: [_jsx("span", { className: "section-number", children: String(number).padStart(2, '0') }), _jsx("h2", { children: section.title }), state === 'revising' ? (_jsxs("span", { className: "revised-pill live", children: [_jsx("span", { className: "spinner" }), " Revising"] })) : state ? (_jsx("span", { className: "revised-pill", children: "Revised at your request" })) : null, onKeep && state !== 'revising' ? (_jsx("button", { type: "button", className: "btn sm ghost ask", onClick: (event) => {
                            const element = event.currentTarget.closest('.explain-section');
                            if (element)
                                onKeep(section, element);
                        }, title: "Keep this whole section in your notes", children: "Add to notes" })) : null, onAdjust ? (_jsx("button", { type: "button", className: "btn sm ghost ask", onClick: () => onAdjust(section.title), title: "Ask a question about this section, or ask for it to be changed, in the bar at the top", children: "Ask or adjust" })) : null] })) : null, staged ? (
            // Two columns for the whole section: the prose, and beside it the stage with the rest of the margin under it.
            _jsxs("div", { className: "stage-grid", children: [_jsx("div", { className: "stage-main", children: rows.flatMap((row, index) => row.prose.map((block, i) => draw(block, index * 100 + i))) }), _jsxs("div", { className: "stage-side", children: [_jsx(Stage, { block: motion, section: ref, writer: asker ?? writer }), rows.flatMap((row, index) => row.side.map((block, i) => draw(block, index * 100 + 50 + i)))] })] })) : (rows.map((row, index) => (_jsxs("div", { className: `explain-row${row.wide ? ' is-wide' : ''}`, children: [_jsx("div", { className: "row-main", children: row.prose.map(draw) }), row.side.length ? _jsx("div", { className: "row-side", children: row.side.map(draw) }) : null] }, index))))] }));
}
/** Where the page is kept: a line under the outline, and a link to the file in Drive. */
function DriveLine({ state }) {
    if (!state || state.state === 'none')
        return null;
    return (_jsxs("div", { className: `drive-line is-${state.state}`, children: [_jsx("span", { className: "drive-dot", "aria-hidden": "true" }), state.state === 'checking' ? ('Checking your Drive…') : state.state === 'saving' ? ('Saving to your Drive…') : state.state === 'error' ? (_jsxs("span", { title: state.message, children: ["Not saved to Drive \u2014 ", state.message] })) : (_jsxs(_Fragment, { children: [state.fetched ? 'Fetched from your Drive' : 'Saved in your Drive', state.link ? (_jsxs(_Fragment, { children: [' · ', _jsx("a", { href: state.link, target: "_blank", rel: "noreferrer noopener", children: "Open \u2197" })] })) : null] }))] }));
}
/**
 * How solid the page is over the paper behind it. `value` is what was chosen,
 * null for the material's own default, which is `fallback`; Reset goes back
 * to it. Moving the slider shows the change live, so there is nothing to apply.
 */
function OpacityControl({ value, fallback, onChange }) {
    const [open, setOpen] = useState(false);
    const box = useRef(null);
    useEffect(() => {
        if (!open)
            return;
        const away = (event) => {
            if (!box.current?.contains(event.target))
                setOpen(false);
        };
        // Esc closes this, not Explain behind it.
        const key = (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                setOpen(false);
            }
        };
        window.addEventListener('mousedown', away);
        window.addEventListener('keydown', key, true);
        return () => {
            window.removeEventListener('mousedown', away);
            window.removeEventListener('keydown', key, true);
        };
    }, [open]);
    const shown = value ?? fallback;
    const percent = Math.round(shown * 100);
    return (_jsxs("div", { className: "menu-wrap", ref: box, children: [_jsx("button", { type: "button", className: "icon-btn sm", "aria-haspopup": "dialog", "aria-expanded": open, "aria-pressed": value !== null, onClick: () => setOpen((now) => !now), "aria-label": "Background opacity", title: "How see-through the page is", children: _jsx(OpacityIcon, { size: 16 }) }), open ? (_jsxs("div", { className: "menu right opacity-pop", role: "dialog", "aria-label": "Background opacity", children: [_jsx("div", { className: "menu-label", children: "Background" }), _jsxs("label", { className: "frost-row", children: [_jsx("span", { children: "Clear" }), _jsx("input", { type: "range", min: 0.2, max: 1, step: 0.05, value: shown, "aria-label": "How opaque the explanation's background is", "aria-valuetext": `${percent}% opaque`, onChange: (event) => onChange(Number(event.target.value)) }), _jsx("span", { children: "Solid" })] }), _jsxs("div", { className: "opacity-foot", children: [_jsxs("span", { children: [percent, "%", value === null ? ' · default' : ''] }), _jsx("button", { type: "button", className: "btn sm ghost", disabled: value === null, onClick: () => onChange(null), children: "Reset" })] })] })) : null] }));
}
const NB_REWRITE_KEY = 'reader.colab.rewrite';
const readNotebookRewrite = () => {
    try {
        return localStorage.getItem(NB_REWRITE_KEY) === 'notebook' ? 'notebook' : 'cells';
    }
    catch {
        return 'cells';
    }
};
const REWRITE_VIEW_KEY = 'reader.rewrite.view';
const readRewriteView = () => {
    try {
        return localStorage.getItem(REWRITE_VIEW_KEY) === 'list' ? 'list' : 'grid';
    }
    catch {
        return 'grid';
    }
};
/**
 * Rewrite, in the bar: the page written again from scratch, by the model
 * chosen here — the same one as before, or any other with a key.
 */
function RewriteMenu({ current, keys, disabled, implementing, forNotebook, notebookMode, onNotebookMode, onRewrite, }) {
    const [open, setOpen] = useState(false);
    const [view, setView] = useState(readRewriteView);
    const box = useRef(null);
    const pickView = (next) => {
        setView(next);
        try {
            localStorage.setItem(REWRITE_VIEW_KEY, next);
        }
        catch {
            // private mode
        }
    };
    const choose = (id) => {
        setOpen(false);
        onRewrite(id);
    };
    const shortName = (label) => label.replace(/^(Claude|Gemini|DeepSeek) /, '');
    const tagsOf = (note) => note.split(' · ').map((tag) => (_jsx("span", { className: "rw-tag", children: tag }, tag)));
    useEffect(() => {
        if (!open)
            return;
        const away = (event) => {
            if (!box.current?.contains(event.target))
                setOpen(false);
        };
        // Esc closes this, not Explain behind it.
        const key = (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                setOpen(false);
            }
        };
        window.addEventListener('mousedown', away);
        window.addEventListener('keydown', key, true);
        return () => {
            window.removeEventListener('mousedown', away);
            window.removeEventListener('keydown', key, true);
        };
    }, [open]);
    useEffect(() => {
        if (disabled)
            setOpen(false);
    }, [disabled]);
    return (_jsxs("div", { className: "menu-wrap", ref: box, children: [_jsxs("button", { type: "button", className: "btn sm ghost rewrite", "aria-haspopup": "menu", "aria-expanded": open, disabled: disabled, onClick: () => setOpen((now) => !now), title: forNotebook ? 'Write the notebook again — the whole notebook from scratch, or every code cell in turn, in place — with the model you choose' : implementing ? 'Plan it again from scratch, for the machine picked now — with the model you choose' : 'Write it again from scratch — with the model you choose', children: ["Rewrite ", _jsx("span", { className: "caret", "aria-hidden": "true", children: "\u25BE" })] }), open ? (_jsxs("div", { className: `menu right rewrite-menu is-${view}`, role: "menu", "aria-label": "Rewrite with", children: [_jsxs("div", { className: "rw-head", children: [_jsxs("span", { className: "rw-head-text", children: [_jsxs("b", { children: ["Rewrite ", forNotebook ? 'the notebook ' : '', "with"] }), _jsx("span", { children: forNotebook ? (notebookMode === 'cells' ? 'Every code cell again, one by one, each in its place · Undo brings them back' : 'The whole notebook again from scratch · Undo brings it back') : 'Written again from scratch · Undo brings it back' }), forNotebook && onNotebookMode ? (_jsxs("span", { className: "segmented sm rw-nb-mode", role: "radiogroup", "aria-label": "What Rewrite does to the notebook", children: [_jsx("button", { type: "button", role: "radio", "aria-checked": notebookMode === 'cells', "aria-pressed": notebookMode === 'cells', onClick: () => onNotebookMode('cells'), title: "Each code cell asked for in turn and replaced in place; text cells and the order stay", children: "Cell by cell" }), _jsx("button", { type: "button", role: "radio", "aria-checked": notebookMode !== 'cells', "aria-pressed": notebookMode !== 'cells', onClick: () => onNotebookMode('notebook'), title: "The paper\u2019s method and an experiment as new cells; every current cell replaced", children: "Whole notebook" })] })) : null] }), _jsxs("span", { className: "rw-views", role: "group", "aria-label": "Show the models as", children: [_jsx("button", { type: "button", "aria-pressed": view === 'grid', onClick: () => pickView('grid'), title: "Boxes in a grid", children: _jsxs("svg", { viewBox: "0 0 16 16", width: "14", height: "14", fill: "none", stroke: "currentColor", strokeWidth: "1.5", "aria-hidden": "true", children: [_jsx("rect", { x: "2", y: "2", width: "5", height: "5", rx: "1.2" }), _jsx("rect", { x: "9", y: "2", width: "5", height: "5", rx: "1.2" }), _jsx("rect", { x: "2", y: "9", width: "5", height: "5", rx: "1.2" }), _jsx("rect", { x: "9", y: "9", width: "5", height: "5", rx: "1.2" })] }) }), _jsx("button", { type: "button", "aria-pressed": view === 'list', onClick: () => pickView('list'), title: "A list, by maker", children: _jsx("svg", { viewBox: "0 0 16 16", width: "14", height: "14", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", "aria-hidden": "true", children: _jsx("path", { d: "M2.5 4h11M2.5 8h11M2.5 12h11" }) }) })] })] }), view === 'grid' ? (_jsx("div", { className: "rw-grid", children: MODELS.map((m) => {
                            const isCurrent = m.id === current;
                            const ready = Boolean(keys[m.provider]);
                            return (_jsxs("button", { type: "button", role: "menuitemradio", "aria-checked": isCurrent, className: `rw-card p-${m.provider}${isCurrent ? ' is-current' : ''}`, disabled: !ready, onClick: () => choose(m.id), title: ready ? `Write it again with ${m.label}` : `Add a ${PROVIDERS[m.provider].company} key in Settings to use ${m.label}`, children: [_jsxs("span", { className: "rw-card-top", children: [_jsx("span", { className: "rw-mark", "aria-hidden": "true", children: PROVIDERS[m.provider].name.slice(0, 1) }), _jsx("span", { className: "rw-maker", children: PROVIDERS[m.provider].company }), isCurrent ? (_jsx("span", { className: "rw-current", title: "Current: the page on screen was written with this one", "aria-label": "Current", children: "\u2713" })) : ready ? (_jsx("span", { className: "rw-go", "aria-hidden": "true", children: "\u21BB" })) : null] }), _jsx("b", { className: "rw-name", children: shortName(m.label) }), _jsx("span", { className: "rw-tags", children: ready ? tagsOf(m.note) : _jsx("span", { className: "rw-tag rw-need", children: "Needs a key" }) })] }, m.id));
                        }) })) : (Object.keys(PROVIDERS).map((provider) => {
                        const models = MODELS.filter((m) => m.provider === provider);
                        if (!models.length)
                            return null;
                        const ready = Boolean(keys[provider]);
                        return (_jsxs("div", { className: `rw-group p-${provider}`, role: "group", "aria-label": PROVIDERS[provider].company, children: [_jsxs("div", { className: "rw-provider", children: [_jsx("span", { className: "rw-mark", "aria-hidden": "true", children: PROVIDERS[provider].name.slice(0, 1) }), PROVIDERS[provider].company, ready ? null : _jsx("span", { className: "rw-need", children: "Needs a key" })] }), models.map((m) => {
                                    const isCurrent = m.id === current;
                                    return (_jsxs("button", { type: "button", role: "menuitemradio", "aria-checked": isCurrent, className: `rw-model${isCurrent ? ' is-current' : ''}`, disabled: !ready, onClick: () => choose(m.id), title: ready ? `Write it again with ${m.label}` : `Add a ${PROVIDERS[m.provider].company} key in Settings to use ${m.label}`, children: [_jsx("b", { className: "rw-name", children: shortName(m.label) }), _jsx("span", { className: "rw-tags", children: tagsOf(m.note) }), isCurrent ? (_jsx("span", { className: "rw-current", title: "The page on screen was written with this one", children: "Current" })) : (_jsx("span", { className: "rw-go", "aria-hidden": "true", children: "\u21BB" }))] }, m.id));
                                })] }, provider));
                    }))] })) : null] }));
}
export default function Explain({ paperId, title, authors, published, screen, onClose }) {
    const assistant = useSyncExternalStore(subscribe, getState);
    const [page, setPage] = useState(() => (askedPage?.paperId === paperId ? askedPage.page : 'explain'));
    // The written page under the notebook: Colab in the bar opens the notebook over it, and a second click comes back to it.
    // The plan set up as a project (Local → Open as a project): its editor opens here, over the page, not on the Playground.
    const playgrounds = usePlaygrounds();
    const [projectId, setProjectId] = useState(null);
    const project = projectId ? playgrounds.find((p) => p.id === projectId) : undefined;
    const projectOpen = Boolean(project);
    const paperProject = useMemo(() => playgrounds.filter((p) => p.kind === 'project' && p.start === 'paper' && p.cites.some((c) => c.paperId === paperId)).sort((a, b) => b.updated - a.updated)[0], [playgrounds, paperId]);
    const goTo = (next) => {
        setProjectId(null);
        setPage(next);
    };
    const written = useRef('explain');
    useEffect(() => {
        if (page !== 'colab')
            written.current = page;
    }, [page]);
    useEffect(() => {
        // The asked page is this Explain's now; whatever opens later opens on the explanation.
        if (askedPage?.paperId === paperId)
            askedPage = null;
        const onOpenOn = (event) => {
            const asked = event.detail;
            if (asked.paperId !== paperId)
                return;
            askedPage = null;
            setPage(asked.page);
        };
        window.addEventListener(OPEN_ON, onOpenOn);
        return () => window.removeEventListener(OPEN_ON, onOpenOn);
    }, [paperId]);
    // The Colab tab sits over the explanation: what is written, kept and asked about is the explanation's while it is up.
    const store = STORES[page === 'colab' ? 'explain' : page];
    const implementing = page === 'implement';
    const explanation = useSyncExternalStore(store.subscribe, () => store.get(paperId));
    const driveState = useSyncExternalStore(store.subscribe, () => store.driveState(paperId));
    const [layout, setLayout] = useState(readLayout);
    const [stage, setStage] = useState(readStage);
    // Kept with the chat's preferences, so Settings and this page pick the same one.
    const model = assistant.prefs.explainModel ?? assistant.prefs.model;
    const setModel = setExplainModel;
    const chosen = modelSpec(model);
    const provider = PROVIDERS[chosen.provider];
    const hasKey = assistant.keys[chosen.provider];
    // Who wrote the page on screen — or who is about to.
    // Named by the model, not its maker: the reader picks a model, and sees that model's name wherever it acts.
    const writer = modelSpec(explanation?.model ?? model).label;
    // Who answers the bar: the model picked for it, else the page's writer.
    const askModel = assistant.prefs.askModel ?? explanation?.model ?? model;
    const asker = modelSpec(askModel).label;
    const [keyDraft, setKeyDraft] = useState('');
    const [active, setActive] = useState('');
    const [checked, setChecked] = useState(false);
    const scrollRef = useRef(null);
    const askRef = useRef(null);
    const [ask, setAsk] = useState('');
    const [scope, setScope] = useState({});
    const [askFocused, setAskFocused] = useState(false);
    // Once a request is sent, the line under the bar reports on it rather than offering more.
    const [justAsked, setJustAsked] = useState(false);
    // Drive connected after Explain opened is looked in too.
    const { driveConnected, settings, updateSettings } = useStore();
    const opacity = settings.explainOpacity;
    // What the material shows when nothing is chosen: frosted glass, or solid paper.
    const defaultOpacity = settings.glass ? Math.round((0.5 + 0.2 * settings.glassFrost) * 100) / 100 : 1;
    useEffect(() => {
        setChecked(false);
        void store.load(paperId).finally(() => setChecked(true));
    }, [paperId, driveConnected, store]);
    // The paper's own figures the page places, as they were kept when it was written.
    useEffect(() => void loadPaperFigures(paperId), [paperId]);
    useEffect(() => {
        // A new page: the bar's chips were about the other one.
        setScope({});
        setJustAsked(false);
    }, [page]);
    useEffect(() => {
        try {
            localStorage.setItem(LAYOUT_KEY, layout);
        }
        catch {
            // private mode
        }
    }, [layout]);
    useEffect(() => {
        try {
            localStorage.setItem(STAGE_KEY, stage ? 'on' : 'off');
        }
        catch {
            // private mode
        }
    }, [stage]);
    useEffect(() => {
        const onKey = (event) => {
            // Not from the ask bar, the assistant, or the notebook, where Escape leaves an editor or drops a picked cell first.
            // Judged by where the key was pressed, not where focus is now: an editor that closed on this Escape has already let focus go.
            const from = event.target instanceof Element ? event.target : document.activeElement;
            // Nor while a figure is open close up: its Esc puts the figure back, not the page away.
            if (event.key === 'Escape' && !from?.closest('.assistant-win, .explain-ask, .nb-page, .pg-work') && !document.querySelector('.scrim, .figure-closeup'))
                onClose();
            // "/" goes to the bar at the top, as it does to a search box.
            if (event.key === '/' && !event.target?.closest('input, textarea, [contenteditable="true"]')) {
                event.preventDefault();
                askRef.current?.focus();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    // While a request is answered, the page on screen is the page with the reply so far applied to it.
    const pending = explanation?.pending;
    const live = pending && !pending.error ? applyEdits(explanation?.content ?? '', pending.reply, pending.scope.section) : null;
    const shown = live ? live.content : explanation?.content ?? '';
    const sections = useMemo(() => parseExplanation(shown), [shown]);
    const revisions = explanation?.revisions ?? [];
    const lastRevision = revisions[revisions.length - 1];
    const revising = live?.touched[live.touched.length - 1];
    const revised = useMemo(() => new Set(revisions.flatMap((r) => r.touched)), [revisions]);
    const stateOf = (section) => revising && section.title === revising
        ? 'revising'
        : !pending && lastRevision?.touched.includes(section.title) && Date.now() - lastRevision.at < 60_000
            ? 'fresh'
            : revised.has(section.title)
                ? 'revised'
                : undefined;
    const caveats = useMemo(() => caveatsOf(sections), [sections]);
    const cells = useMemo(() => {
        const numbers = new Map();
        let n = 0;
        for (const section of sections)
            for (const block of section.blocks)
                if (block.kind === 'code' && block.lang === 'python')
                    numbers.set(block, ++n);
        return numbers;
    }, [sections]);
    // The Python cells in the order they read, for Run all; a run is kept under the cell's code.
    const runnable = useMemo(() => Array.from(cells.entries()).map(([block, n]) => ({ key: cellKey(block.code), code: block.code, label: `In [${n}]` })), [cells]);
    useColabClient(settings.googleClientId);
    const streaming = Boolean(explanation?.streaming);
    // The pane beside the page, as the Colab tab has it, whenever the page has
    // cells to run: the runtime's meters, the metrics its cells print, its
    // files. It opens by itself when a runtime connects, and folds when the
    // runtime goes — unless it was opened or closed by hand.
    const colab = useColab();
    const [side, setSide] = useState(null);
    const sideByHand = useRef(false);
    const connected = colab.status === 'idle' || colab.status === 'busy';
    useEffect(() => {
        if (connected) {
            if (!sideByHand.current)
                setSide((current) => current ?? 'runtime');
        }
        else {
            setSide((current) => (current === 'runtime' && !sideByHand.current ? null : current));
            sideByHand.current = false;
        }
    }, [connected]);
    const pickSide = (next) => {
        sideByHand.current = true;
        setSide(next);
    };
    const codeCells = useMemo(() => runnable.map((cell) => ({ key: cell.key, id: cell.key, label: cell.label })), [runnable]);
    const metricCells = useMemo(() => runnable.map((cell) => {
        const run = colab.runs[cell.key];
        return { key: cell.key, id: cell.key, label: cell.label, text: run ? outputText(run.outputs) : '', at: run?.startedAt || 0 };
    }), [runnable, colab.runs]);
    // The plan's compute block, for the ticks on the pane's meters: this page's when it is the plan, else the paper's plan when it has one.
    const compute = useMemo(() => {
        const plan = implementing ? sections : implementationFor(paperId)?.content ? parseExplanation(implementationFor(paperId).content) : null;
        return plan ? computeOf(plan) : null;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [side, implementing, sections, explanation?.content]);
    const goToCell = (key) => {
        const cell = docRef.current?.querySelector(`.explain-cell[data-key="${CSS.escape(key)}"]`);
        cell?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    // The Colab tab's own request, for the header's Rewrite and Stop while that tab is the one open.
    const nbAsk = useSyncExternalStore(subscribeNotebookAsk, () => notebookAskFor(paperId));
    const nbBusy = Boolean(nbAsk.pending && !nbAsk.pending.error);
    // What Local in the header takes out of the page: the plan's scaffold, the explanation and its cells, or the notebook while it is the one open.
    const nb = useSyncExternalStore(subscribeNotebook, () => notebookFor(paperId));
    const bundle = useMemo(() => {
        if (page === 'colab')
            return nb ? notebookBundle(`notebooks/${notebookFileName(title)}`, toIpynb(nb)) : null;
        return explanation?.content && !streaming ? bundleOf(title, shown, sections, implementing ? 'plan' : 'page', writer) : null;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [page, nb?.updated, explanation?.content, streaming, shown, sections, implementing, title, writer]);
    // The plan's scaffold, whichever page is open: what Local sets up as a project, in the Playground's editor.
    const planBundle = useMemo(() => {
        if (implementing)
            return explanation?.content && !streaming ? bundleOf(title, shown, sections, 'plan', writer) : null;
        const plan = implementationFor(paperId);
        return plan?.content ? bundleOf(title, plan.content, parseExplanation(plan.content), 'plan', modelSpec(plan.model ?? model).label) : null;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [implementing, explanation?.content, streaming, shown, sections, title, writer, paperId]);
    const [nbRewrite, setNbRewriteState] = useState(readNotebookRewrite);
    // Snip is the pages' own; on the Colab tab its layer would only sit over the cells.
    useEffect(() => {
        if (page === 'colab')
            setSnipping(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [page]);
    // A cell named in the Ask AI window, from another page: the Colab tab opens, and the notebook takes the cell as it mounts.
    useEffect(() => {
        const onShow = (event) => {
            if (page === 'colab')
                return;
            holdCell(event.detail.cell);
            setPage('colab');
        };
        window.addEventListener(SHOW_CELL, onShow);
        return () => window.removeEventListener(SHOW_CELL, onShow);
    }, [page]);
    const setNbRewrite = (mode) => {
        setNbRewriteState(mode);
        try {
            localStorage.setItem(NB_REWRITE_KEY, mode);
        }
        catch {
            // private mode
        }
    };
    // Who writes the notebook: the model Rewrite last picked for it, else the pages'.
    const nbWriter = modelSpec(nbAsk.model ?? model).label;
    const thought = lastThought(explanation?.thinking);
    const busy = Boolean(streaming || (pending && !pending.error));
    const canAsk = Boolean(explanation?.content && explanation.model && assistant.keys[modelSpec(askModel).provider] && !streaming);
    // Ask Claude, while this is open, points at passages here: the explanation's
    // own words are marked on it; the paper's are left to the paper when it is
    // beside this, and found here if they are here when this covers it.
    const docRef = useRef(null);
    const layoutNow = useRef(layout);
    layoutNow.current = layout;
    const [flash, setFlash] = useState(null);
    const flashKey = useRef(0);
    useEffect(() => {
        const release = setExplainLocator(async (request) => {
            const doc = docRef.current;
            const scroller = scrollRef.current;
            if (!doc || !scroller)
                return null;
            const ofPaper = request.source !== 'explanation';
            const paperShows = layoutNow.current === 'beside';
            if (ofPaper && paperShows)
                return null;
            const range = findPassage(doc, request.quote);
            if (!range) {
                if (ofPaper)
                    return paperShows ? null : { found: false, reason: 'It is in the paper, under the explanation — choose “Beside the paper”, or close Explain, to see it.' };
                return { found: false, reason: 'Those words are not on the explanation.' };
            }
            const top = range.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
            scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 3), behavior: 'smooth' });
            const section = range.startContainer.parentElement?.closest('.explain-section')?.dataset.title;
            setFlash({ range, label: request.label, where: ['The explanation', section].filter(Boolean).join(' · '), clip: scroller, anchor: scroller, key: ++flashKey.current, n: request.n });
            window.dispatchEvent(new CustomEvent(FLASH_EVENT, { detail: { quote: request.quote } }));
            return { found: true };
        });
        return () => {
            release();
            window.dispatchEvent(new CustomEvent(FLASH_EVENT, { detail: { quote: null } }));
        };
    }, []);
    // A rewritten page is a different page: the mark goes.
    useEffect(() => {
        setFlash(null);
        window.dispatchEvent(new CustomEvent(FLASH_EVENT, { detail: { quote: null } }));
    }, [paperId, layout]);
    // A passage selected here can be taken to Ask Claude, as one selected in the paper can.
    const [picked, setPicked] = useState(null);
    useEffect(() => {
        if (!picked)
            return;
        const drop = () => {
            if (window.getSelection()?.isCollapsed)
                setPicked(null);
        };
        const away = () => setPicked(null);
        const scroller = scrollRef.current;
        document.addEventListener('selectionchange', drop);
        scroller?.addEventListener('scroll', away, { passive: true });
        return () => {
            document.removeEventListener('selectionchange', drop);
            scroller?.removeEventListener('scroll', away);
        };
    }, [picked]);
    // The maths the Markdown set aside is typeset once it is on screen. Only what
    // is new is touched, so this is cheap on every render of a stream.
    useEffect(() => {
        void typesetMath(scrollRef.current);
    });
    // The outline follows the reading: the section whose head last crossed the top third.
    useEffect(() => {
        const scroller = scrollRef.current;
        if (!scroller)
            return;
        const onScroll = () => {
            const line = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
            let current = '';
            for (const element of scroller.querySelectorAll('.explain-section')) {
                if (element.getBoundingClientRect().top <= line)
                    current = element.dataset.section ?? '';
            }
            setActive(current);
        };
        onScroll();
        scroller.addEventListener('scroll', onScroll, { passive: true });
        return () => scroller.removeEventListener('scroll', onScroll);
    }, [sections.length]);
    // The section being revised is brought into view once, when the reply first names it.
    const followed = useRef('');
    useEffect(() => {
        if (!revising || followed.current === revising)
            return;
        followed.current = revising;
        const element = Array.from(scrollRef.current?.querySelectorAll('.explain-section') ?? []).find((el) => el.dataset.title === revising);
        element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, [revising]);
    useEffect(() => {
        if (!pending)
            followed.current = '';
    }, [pending]);
    // ---- keeping pieces in your notes ------------------------------------------
    // Pointing at a diagram, a code cell, a table, an equation or a caveat puts
    // an "Add to notes" button on its corner; a selection has one in its
    // toolbar; a section's heading has one for the whole section. What is kept
    // is a copy, so a later rewrite of the page leaves your notes as they were.
    const { announce, toast } = useKept();
    const keep = async (clip) => {
        const html = await clip.html;
        if (!html.trim() && !clip.text.trim())
            return;
        addClip(paperId, { ...clip, html });
        announce(clip.label);
    };
    const sectionOf = (element) => element.closest('.explain-section')?.dataset.title || undefined;
    const keepElement = (element) => {
        const { label, text, quote } = describe(element);
        void keep({ label, html: copyOf(element), text, source: { from: 'explain', section: sectionOf(element), quote } });
    };
    const keeper = useKeeper({ root: docRef, selector: KEEPABLE, onKeep: keepElement, own: OWN_BUTTON });
    // ---- a figure, close up ------------------------------------------------------
    // A click on a diagram — or a scene, on its step — lifts it off the page to
    // the middle of the window, as large as the window allows; Tab goes on to
    // the next, Esc puts it back. Judged from the page itself, so a figure in
    // the margin, in the flow, on the stage or in a revised section all count.
    const [closeUp, setCloseUp] = useState(null);
    const openCloseUp = (art) => {
        const visuals = closeUpVisuals(docRef.current);
        const index = visuals.findIndex((visual) => visual.art === art);
        if (index >= 0)
            setCloseUp({ visuals, index });
    };
    const artOf = (target) => {
        if (!(target instanceof Element))
            return null;
        // The buttons under a figure, a scene's own controls and the corner button are theirs, not a click on the drawing.
        if (target.closest('button, a, input, .figure-animate, .motion-steps, .motion-head'))
            return null;
        const art = target.closest(CLOSEUP_ART);
        return art && art.querySelector(':scope > svg, :scope > img') ? art : null;
    };
    const onDocClick = (event) => {
        // A code block's Copy button in the prose, which is set as HTML and so answered here.
        if (copyProseCode(event.target))
            return;
        const art = artOf(event.target);
        // Dragging across a figure to select the text round it is not a click on it.
        if (!art || window.getSelection()?.toString())
            return;
        openCloseUp(art);
    };
    const onDocKey = (event) => {
        if (event.key !== 'Enter' && event.key !== ' ')
            return;
        const art = event.target instanceof HTMLElement && event.target.matches(CLOSEUP_ART) ? artOf(event.target) : null;
        if (!art)
            return;
        event.preventDefault();
        openCloseUp(art);
    };
    // The plan, for the Colab panel under its budget: the title and the sections, as one value so the panel is not redrawn for nothing.
    const plan = useMemo(() => (implementing ? { title, sections } : null), [implementing, title, sections]);
    // ✂ Snip, or S while this covers the paper: a box dragged over the page
    // keeps every piece of it the box touches, as it is set.
    const [snipping, setSnipping] = useState(false);
    const keepBox = (elements) => {
        const copy = document.createDocumentFragment();
        elements.forEach((element) => copy.appendChild(element.cloneNode(true)));
        const text = elements.map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n\n');
        void keep({ label: 'Snip', html: copyOf(copy), text, source: { from: 'explain', section: sectionOf(elements[0]), quote: text.slice(0, 120) || undefined } });
    };
    useEffect(() => {
        const onKey = (event) => {
            if (event.metaKey || event.ctrlKey || event.altKey || layout === 'beside' || page === 'colab' || projectOpen)
                return;
            const target = event.target;
            if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))
                return;
            if (event.key.toLowerCase() === 's') {
                event.preventDefault();
                setSnipping((current) => !current);
            }
            else if (event.key === 'Escape' && snipping) {
                event.stopPropagation();
                setSnipping(false);
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [layout, snipping, page, projectOpen]);
    const keepSection = (section, element) => {
        // Its rows, not the section itself: a copy that called itself a section of the page would be taken for one.
        const rows = document.createDocumentFragment();
        element.querySelectorAll(':scope > .explain-row').forEach((row) => rows.appendChild(row.cloneNode(true)));
        void keep({ label: 'Section', html: copyOf(rows), text: sectionText(section), source: { from: 'explain', section: section.title || undefined } });
    };
    const keepSelection = () => {
        const selection = window.getSelection();
        if (!picked || !selection?.rangeCount)
            return;
        const range = selection.getRangeAt(0);
        void keep({ label: 'Passage', html: copyOf(range.cloneContents()), text: picked.text, source: { from: 'explain', section: picked.section, quote: picked.text.slice(0, 160) } });
        selection.removeAllRanges();
        setPicked(null);
    };
    // Back from your notes: the passage marked, or its section brought into view.
    useEffect(() => {
        const onShow = (event) => {
            const source = event.detail;
            const scroller = scrollRef.current;
            const section = Array.from(scroller?.querySelectorAll('.explain-section') ?? []).find((element) => element.dataset.title === source.section);
            const toSection = () => section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            if (!source.quote)
                return toSection();
            void showPassage({ quote: source.quote, label: 'From your notes', section: source.section, source: 'explanation' }).then((shown) => {
                if (!shown.found)
                    toSection();
            });
        };
        window.addEventListener(SHOW_IN_EXPLAIN, onShow);
        return () => window.removeEventListener(SHOW_IN_EXPLAIN, onShow);
    }, []);
    const submitWith = async (request, asked) => {
        if (!request.trim() || busy)
            return;
        const read = await screen();
        setAsk('');
        setJustAsked(true);
        setScope({});
        await store.revise(read, request, asked, askModel);
    };
    const submit = (request = ask) => submitWith(request, scope);
    // A cell's output, or its error, taken to the bar as a question about that cell.
    const askCell = (sectionTitle, request, quote) => void submitWith(request, { section: sectionTitle || undefined, quote });
    const adjust = (sectionTitle) => {
        setScope({ section: sectionTitle });
        askRef.current?.focus();
    };
    // A figure's Animate button: the request the bar could have been given, about that section.
    const animate = (sectionTitle, caption) => void submitWith(sceneRequest(sectionTitle, caption), { section: sectionTitle || undefined });
    // A passage selected on the page becomes what the next request is about.
    const takeSelection = () => {
        const selection = window.getSelection();
        const text = selection ? selectedText(selection) : '';
        const node = selection?.anchorNode;
        const element = node instanceof Element ? node : node?.parentElement;
        const section = element?.closest('.explain-section');
        if (text.length < 3 || !section || !selection?.rangeCount) {
            setPicked(null);
            return;
        }
        setScope({ section: section.dataset.title || undefined, quote: text.slice(0, 1500) });
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        setPicked({ text, section: section.dataset.title || undefined, top: rect.bottom + 8, left: Math.max(12, Math.min(window.innerWidth - 340, rect.left)) });
    };
    const start = async () => {
        const read = await screen();
        await store.generate(read, model);
    };
    // Rewrite, with the model picked in its menu — the one chosen now, or another.
    const rewriteWith = async (id) => {
        const read = await screen();
        if (page === 'colab') {
            // On the Colab tab, Rewrite is the notebook's: its cells written again by the model picked, not the page under it — every code cell in turn, or the whole notebook.
            const params = { paperId, screen: read, model: id, runs: colabNow().runs, pages: { explanation: STORES.explain.get(paperId)?.content, plan: implementationFor(paperId)?.content } };
            await (nbRewrite === 'cells' ? rewriteCells(params) : rewriteNotebook(params));
            return;
        }
        await store.generate(read, id);
    };
    // Which model, and the button — or the key, first. The same on both pages' empty states.
    const startControls = (_jsxs(_Fragment, { children: [_jsxs("div", { className: "explain-start", children: [_jsx("div", { className: "model-pick", role: "radiogroup", "aria-label": "Model", children: MODELS.map((m) => (_jsxs("button", { type: "button", role: "radio", "aria-checked": model === m.id, onClick: () => setModel(m.id), children: [_jsx("b", { children: m.label }), _jsxs("span", { children: [m.note, assistant.keys[m.provider] ? '' : PROVIDERS[m.provider].viaProxy ? ` · ${geminiNote(assistant.gemini).short}` : ' · needs a key'] })] }, m.id))) }), hasKey ? (_jsxs("button", { type: "button", className: "btn primary cta", onClick: () => void start(), children: [_jsx(SparkleIcon, { size: 17 }), " ", implementing ? 'Plan the implementation' : 'Explain this paper'] })) : null] }), hasKey ? (_jsxs("p", { className: "hint", children: [_jsx("b", { children: "Written once" }), " and kept for this paper", driveState ? ', in this browser and in the paper’s folder in your Drive' : implementing ? ', in this browser' : '', ". A long paper costs about as much as a few long answers in ", ASSISTANT_NAME, "."] })) : provider.viaProxy ? (_jsx("p", { className: "hint", children: geminiNote(assistant.gemini).long })) : (_jsxs(_Fragment, { children: [_jsxs("form", { className: "explain-start", onSubmit: (event) => {
                            event.preventDefault();
                            const key = keyDraft.trim();
                            if (!looksLikeKey(key, provider.id) && !confirm(`That does not look like one of ${provider.company}’s API keys (they start with "${provider.keyPrefix}"). Save it anyway?`))
                                return;
                            saveKey(key, provider.id);
                            setKeyDraft('');
                        }, children: [_jsx("input", { type: "password", placeholder: provider.placeholder, value: keyDraft, onChange: (event) => setKeyDraft(event.target.value), "aria-label": `${provider.company} API key` }), _jsxs("button", { type: "submit", className: "btn primary cta", disabled: !keyDraft.trim(), children: ["Use this ", provider.company, " key"] })] }), _jsxs("p", { className: "hint", children: [_jsxs("b", { children: ["The same ", provider.company, " key as ", ASSISTANT_NAME, "."] }), " Get one at", ' ', _jsx("a", { href: provider.consoleUrl, target: "_blank", rel: "noopener noreferrer", children: provider.consoleUrl.replace(/^https:\/\//, '') }), ". It stays in this browser and goes only to ", provider.host, "."] })] }))] }));
    const year = published?.slice(0, 4);
    const byline = [authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : ''), year].filter(Boolean).join(' · ');
    const writtenWith = MODELS.find((m) => m.id === explanation?.model)?.label ?? explanation?.model;
    return (_jsxs("div", { className: `explain layout-${layout} page-${page}${opacity !== null && opacity < 1 ? ' is-see-through' : ''}`, style: opacity !== null ? { '--explain-a': opacity } : undefined, role: "dialog", "aria-label": `${implementing ? 'Implementation plan for' : 'Explanation of'} ${title}`, children: [_jsxs("header", { className: "explain-bar", children: [_jsxs("span", { className: "explain-brand", children: [page === 'colab' ? _jsx(ColabIcon, { size: 17 }) : _jsx(ExplainIcon, { size: 17 }), " ", _jsx("span", { children: page === 'colab' ? `Notebook with ${nbWriter}` : `Explained by ${writer}` })] }), _jsx("span", { className: "explain-bar-title", title: title, children: title }), _jsx("div", { className: "segmented explain-pages", role: "tablist", "aria-label": "Page", children: PAGES.map((option) => (_jsxs("button", { type: "button", role: "tab", "aria-selected": page === option.id && !projectOpen, "aria-pressed": page === option.id && !projectOpen, title: option.note, onClick: () => goTo(option.id), children: [option.id === 'implement' ? _jsx(PlanIcon, { size: 13 }) : _jsx(ExplainIcon, { size: 13 }), _jsx("span", { children: option.label })] }, option.id))) }), _jsx("div", { className: "segmented", role: "group", "aria-label": "Layout", children: LAYOUTS.map((option) => (_jsx("button", { type: "button", "aria-pressed": layout === option.id, title: option.note, onClick: () => setLayout(option.id), children: option.label }, option.id))) }), _jsx("button", { type: "button", className: `btn sm ghost stage-toggle${stage ? ' is-on' : ''}`, "aria-pressed": stage, onClick: () => setStage(!stage), title: stage ? `Scenes are on: a figure ${asker} animated plays beside its section as you read. Off, the page is its figures and nothing moves.` : `Scenes are off: the page is its figures, as always. On, a figure ${asker} animated plays beside its section as you read.`, children: "\u25B6 Stage" }), _jsx(ColabChip, { cells: runnable }), _jsx("button", { type: "button", className: `btn sm ghost${side === 'runtime' ? ' is-on' : ''}`, "aria-pressed": side === 'runtime', onClick: () => pickSide(side === 'runtime' ? null : 'runtime'), title: "The machine: how busy it is, the last ten minutes, what is left of the session", children: "Runtime" }), _jsx("button", { type: "button", className: `btn sm ghost${side === 'metrics' ? ' is-on' : ''}`, "aria-pressed": side === 'metrics', onClick: () => pickSide(side === 'metrics' ? null : 'metrics'), title: "Training metrics, read off what the cells print: loss, accuracy, lr\u2026 a chart a metric, live", children: "Metrics" }), _jsxs("button", { type: "button", className: `btn sm colab-open${page === 'colab' && !projectOpen ? ' is-on' : ''}`, "aria-pressed": page === 'colab' && !projectOpen, onClick: () => goTo(page === 'colab' && !projectOpen ? written.current : 'colab'), title: page === 'colab' ? `Back to the ${written.current === 'implement' ? 'Implementation' : 'Explanation'} page` : NOTEBOOK_NOTE, children: [_jsx(ColabIcon, { size: 15 }), " ", _jsx("span", { children: "Colab" })] }), _jsx(LocalMenu, { title: title, bundle: bundle, sections: page === 'colab' ? [] : sections, plan: planBundle, paper: { paperId, title, authors, published }, onPlan: () => goTo('implement'), existing: paperProject, projectOpen: projectOpen, onProject: setProjectId }), page === 'colab' ? (nbBusy ? (_jsx("button", { type: "button", className: "btn sm", onClick: stopNotebookAsk, children: "Stop" })) : (_jsx(RewriteMenu, { current: nbAsk.model ?? model, keys: assistant.keys, disabled: !assistant.keys[modelSpec(nbAsk.model ?? model).provider], implementing: false, forNotebook: true, notebookMode: nbRewrite, onNotebookMode: setNbRewrite, onRewrite: (id) => {
                            setModel(id);
                            void rewriteWith(id);
                        } }))) : streaming ? (_jsx("button", { type: "button", className: "btn sm", onClick: store.stop, children: "Stop" })) : (_jsx(RewriteMenu, { current: explanation?.model ?? model, keys: assistant.keys, disabled: !explanation?.content || busy, implementing: implementing, onRewrite: (id) => {
                            setModel(id);
                            void rewriteWith(id);
                        } })), _jsx("button", { type: "button", className: "btn sm ghost snip-toggle", "aria-pressed": snipping, disabled: !explanation?.content, onClick: () => setSnipping(!snipping), title: "Snip: drag a box over anything here \u2014 prose, a diagram, a code cell, a table \u2014 to add it to your notes (S)", children: "\u2702 Snip" }), _jsx(OpacityControl, { value: opacity, fallback: defaultOpacity, onChange: (value) => updateSettings({ explainOpacity: value }) }), _jsx("button", { type: "button", className: "icon-btn sm", onClick: () => updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' }), "aria-label": settings.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode', title: settings.theme === 'dark' ? 'Light mode — the whole app, as in Settings' : 'Dark mode — the whole app, as in Settings', children: settings.theme === 'dark' ? _jsx(SunIcon, { size: 16 }) : _jsx(MoonIcon, { size: 16 }) }), _jsx("button", { type: "button", className: "icon-btn sm", onClick: onClose, "aria-label": "Close the explanation (Esc)", title: "Back to the paper (Esc or E)", children: _jsx(CloseIcon, { size: 17 }) })] }), _jsx(ColabBanner, {}), project ? (_jsx("div", { className: "explain-project", children: _jsx(PlaygroundWorkspace, { playground: project, onBack: () => setProjectId(null), onOpenPaper: (id) => id === paperId && setProjectId(null), backLabel: written.current === 'implement' ? 'Implementation' : 'Explanation' }, project.id) })) : page === 'colab' ? (_jsx(NotebookPage, { paperId: paperId, title: title, screen: screen, side: side, onSide: pickSide, sections: STORES.explain.get(paperId)?.content ? parseExplanation(STORES.explain.get(paperId).content) : sections, planSections: () => (implementationFor(paperId)?.content ? parseExplanation(implementationFor(paperId).content) : null) })) : (_jsxs(_Fragment, { children: [_jsx("div", { className: "explain-ask", children: _jsxs("div", { className: "ask-column", children: [_jsxs("form", { className: `ask-field${busy ? ' is-busy' : ''}${askFocused ? ' is-focused' : ''}${!canAsk ? ' is-off' : ''}`, onSubmit: (event) => {
                                        event.preventDefault();
                                        void submit();
                                    }, children: [_jsx(SparkleIcon, { size: 16 }), scope.section ? (_jsxs("span", { className: "ask-chip", title: `About the section “${scope.section}”`, children: ["\u00A7 ", scope.section, _jsx("button", { type: "button", "aria-label": "Not about this section", onClick: () => setScope({ ...scope, section: undefined }), children: "\u00D7" })] })) : null, scope.quote ? (_jsxs("span", { className: "ask-chip quote", title: scope.quote, children: ["\u201C", scope.quote.length > 42 ? `${scope.quote.slice(0, 42)}…` : scope.quote, "\u201D", _jsx("button", { type: "button", "aria-label": "Not about this passage", onClick: () => setScope({ ...scope, quote: undefined }), children: "\u00D7" })] })) : null, _jsx("input", { ref: askRef, value: ask, disabled: !canAsk || busy, onChange: (event) => {
                                                setAsk(event.target.value);
                                                setJustAsked(false);
                                            }, onFocus: () => {
                                                setAskFocused(true);
                                                setJustAsked(false);
                                            }, onBlur: () => window.setTimeout(() => setAskFocused(false), 150), onKeyDown: (event) => {
                                                if (event.key !== 'Escape')
                                                    return;
                                                if (scope.section || scope.quote)
                                                    setScope({});
                                                else
                                                    event.currentTarget.blur();
                                            }, placeholder: !explanation?.content
                                                ? `Ask questions or request changes here, once the ${implementing ? 'plan' : 'explanation'} is written`
                                                : !assistant.keys[modelSpec(askModel).provider]
                                                    ? `${MODELS.find((m) => m.id === askModel)?.label ?? asker} needs its key in Settings — or pick another model here`
                                                    : scope.section || scope.quote
                                                        ? 'Ask about this, or say how to change it…'
                                                        : implementing
                                                            ? `Ask ${asker} about the plan, or to change it — a different dataset, framework, scale…  ( / )`
                                                            : `Ask ${asker} anything about this explanation, or how to change it…  ( / )`, "aria-label": "Ask about the explanation, or ask for a change" }), _jsx(ModelChip, { value: askModel, writer: explanation?.model, keys: assistant.keys, disabled: busy || !explanation?.content, what: "Answers here with", onChange: (id) => setAskModel(id === explanation?.model ? '' : id) }), busy && pending ? (_jsx("button", { type: "button", className: "btn sm", onClick: store.stop, children: "Stop" })) : (_jsx("button", { type: "submit", className: "btn sm primary", disabled: !canAsk || !ask.trim(), children: "Ask" }))] }), pending && !pending.error ? (_jsxs("div", { className: "ask-status is-live", children: [_jsx("span", { className: "spinner" }), _jsxs("span", { className: "ask-note", title: thought || undefined, children: [revising ? `Rewriting “${revising}”` : thought ? `Thinking — ${thought}` : 'Reading your request', " \u2014 ", _jsx("em", { children: pending.request })] })] })) : pending?.error ? (_jsxs("div", { className: "ask-status is-error", children: [_jsx("span", { className: "ask-note", children: pending.error }), _jsx("button", { type: "button", className: "btn sm ghost", onClick: () => store.dismiss(paperId), children: "Dismiss" })] })) : askFocused && !ask && canAsk && !justAsked ? (_jsx("div", { className: "ask-suggestions", children: (implementing
                                        ? scope.section || scope.quote
                                            ? ['Go into more detail here', 'Give me the full file, not a skeleton', 'What could go wrong at this step?', 'Is there a smaller version of this?', 'Add a figure for this']
                                            : [
                                                'Plan the smallest version that still tests the idea',
                                                'Use PyTorch Lightning and Hydra configs',
                                                'Use JAX instead of PyTorch',
                                                'Swap the dataset for one I can download in an hour',
                                                'Write every starter file in full',
                                                'Add a Dockerfile and a Makefile',
                                            ]
                                        : scope.section || scope.quote
                                            ? ['Explain this more simply', 'Go deeper into the maths', 'Add a figure for this', 'Animate the key figure in this section', 'Add a PyTorch version of the code', 'Is this still true today?']
                                            : ['Make the whole page simpler, for a beginner', 'Add a section on how to implement it today', 'Use PyTorch instead of numpy', 'What has changed in the last two years?', 'Typeset the maths, and walk through it step by step', 'Fewer figures, more intuition']).map((suggestion) => (_jsx("button", { type: "button", className: "ask-suggestion", onMouseDown: (event) => event.preventDefault(), onClick: () => void submit(suggestion), children: suggestion }, suggestion))) })) : lastRevision ? (_jsxs("div", { className: "ask-status is-done", children: [_jsx("span", { className: "check", children: "\u2713" }), _jsx("span", { className: "ask-note", children: lastRevision.note || `Done: ${lastRevision.request}` }), _jsx("button", { type: "button", className: "btn sm ghost", onClick: () => store.undo(paperId), title: `Put the page back as it was before “${lastRevision.request}”`, children: "Undo" })] })) : null] }) }), _jsxs("div", { className: `explain-split${side ? ' has-side' : ''}`, children: [_jsxs("div", { className: "explain-scroll", ref: scrollRef, children: [_jsxs("nav", { className: "explain-outline", "aria-label": "Sections", children: [_jsxs("div", { className: "outline-paper", children: [_jsx("div", { className: "outline-title", children: title }), byline ? _jsx("div", { className: "outline-byline", children: byline }) : null] }), sections.filter((s) => s.title).length ? (_jsx("ol", { children: sections
                                                    .filter((s) => s.title)
                                                    .map((section, index) => {
                                                    const marks = section.blocks.filter((b) => b.kind === 'caveat');
                                                    const scene = stage && !implementing ? (motionOf(section) ? 'has' : section.blocks.some((b) => b.kind === 'figure' && b.animate) ? 'offered' : '') : '';
                                                    return (_jsx("li", { className: active === section.id ? 'active' : '', children: _jsxs("a", { href: `#explain-${section.id}`, onClick: (event) => {
                                                                event.preventDefault();
                                                                document.getElementById(`explain-${section.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                                            }, children: [_jsx("span", { className: "n", children: String(index + 1).padStart(2, '0') }), _jsx("span", { className: "t", children: section.title }), marks.map((mark, i) => (_jsx("span", { className: `dot v-${mark.verdict}`, title: `${VERDICTS[mark.verdict]}: ${mark.title}` }, i))), scene ? _jsx("span", { className: `play ${scene}`, title: scene === 'has' ? 'This section has a scene on the stage' : `${writer} marked a figure here as worth animating` }) : null] }) }, section.id));
                                                }) })) : null, caveats.length ? (_jsxs("div", { className: "outline-aged", children: [_jsx("div", { className: "aged-label", children: "How it has aged" }), Object.keys(VERDICTS)
                                                        .map((verdict) => [verdict, caveats.filter((c) => c.verdict === verdict).length])
                                                        .filter(([, count]) => count)
                                                        .map(([verdict, count]) => (_jsxs("div", { className: `aged-row v-${verdict}`, children: [_jsx("span", { className: "dot" }), " ", VERDICTS[verdict], " ", _jsx("span", { className: "count", children: count })] }, verdict)))] })) : null, implementing && explanation?.content ? _jsx(HardwareSummary, { sections: sections }) : null, explanation?.content ? (_jsxs("div", { className: "outline-meta", children: [streaming ? (implementing ? `${writer} is planning…` : `${writer} is writing…`) : `${implementing ? 'Planned' : 'Written'} by ${writtenWith} · ${new Date(explanation.created).toLocaleDateString()}`, _jsx(DriveLine, { state: driveState })] })) : null] }), _jsx(PaperContext.Provider, { value: paperId, children: _jsx(KeepContext.Provider, { value: keepElement, children: _jsx(PlanContext.Provider, { value: plan, children: _jsx("article", { className: "explain-doc", ref: docRef, onMouseUp: takeSelection, onMouseOver: keeper.onMouseOver, onMouseLeave: keeper.onMouseLeave, onClick: onDocClick, onKeyDown: onDocKey, children: !explanation?.content && !checked ? (_jsxs("p", { className: "explain-looking", children: [_jsx("span", { className: "spinner" }), driveState?.state === 'checking' ? 'Looking in your Drive for an explanation of this paper…' : implementing ? 'Opening the plan…' : 'Opening the explanation…'] })) : !explanation?.content && checked && !streaming && implementing ? (_jsx(ImplementEmpty, { title: title, byline: byline, children: startControls })) : !explanation?.content && checked && !streaming ? (_jsxs("div", { className: "explain-empty", children: [_jsxs("div", { className: "explain-kicker pill", children: [_jsx(ExplainIcon, { size: 15 }), " The whole paper, explained"] }), _jsx("h1", { children: title }), byline ? _jsx("div", { className: "byline", children: byline }) : null, _jsxs("p", { className: "explain-lede", children: [writer, " reads the paper ", _jsx("b", { children: "end to end" }), " and writes you a walkthrough: ", _jsx("mark", { children: "the problem" }), ", ", _jsx("mark", { children: "how the method works" }), " and", ' ', _jsx("mark", { children: "why it beats what came before" }), ". It adds diagrams, small Python cells you can run, and an honest account of", ' ', _jsx("b", { children: "what has changed since" }), " it was published."] }), _jsxs("ul", { className: "explain-promises", children: [_jsxs("li", { className: "p-figures", children: [_jsx("span", { className: "promise-icon", "aria-hidden": "true", children: _jsxs("svg", { viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", children: [_jsx("rect", { x: "3.5", y: "4.5", width: "17", height: "15", rx: "3" }), _jsx("path", { d: "M7 15l3.2-3.6 2.6 2.4L17 9" })] }) }), _jsx("b", { children: "Figures" }), _jsx("span", { children: "drawn for each key idea" })] }), _jsxs("li", { className: "p-code", children: [_jsx("span", { className: "promise-icon", "aria-hidden": "true", children: _jsx("span", { className: "colab-mark", children: "co" }) }), _jsx("b", { children: "Code cells" }), _jsx("span", { children: "runnable in Google Colab" })] }), _jsxs("li", { className: "p-caveats", children: [_jsx("span", { className: "promise-icon", "aria-hidden": "true", children: _jsxs("span", { className: "dots", children: [_jsx("i", { className: "v-holds" }), _jsx("i", { className: "v-superseded" }), _jsx("i", { className: "v-disproved" })] }) }), _jsx("b", { children: "Caveats" }), _jsx("span", { children: "what still holds, and what was superseded or disproved" })] })] }), startControls] })) : (_jsxs(_Fragment, { children: [_jsxs("header", { className: "explain-title", children: [_jsxs("div", { className: "explain-kicker", children: [implementing ? _jsx(PlanIcon, { size: 16 }) : _jsx(ExplainIcon, { size: 16 }), " ", implementing ? `Implementation plan by ${writer}` : `Explained by ${writer}`] }), _jsx("h1", { children: title }), byline ? _jsx("div", { className: "byline", children: byline }) : null] }), sections.map((section, index) => (_jsx(Fragment, { children: _jsx(SectionView, { section: section, number: index + (sections[0]?.title ? 1 : 0), cells: cells, onAdjust: canAsk && !busy && section.title ? adjust : undefined, onAsk: canAsk && !busy ? askCell : undefined, onKeep: !streaming && section.title ? keepSection : undefined, onAnimate: canAsk && !busy && !implementing && section.title ? animate : undefined, stage: implementing || !stage ? 'off' : layout === 'margin' ? 'margin' : 'inline', state: stateOf(section), asker: asker, writer: writer }, stateOf(section) === 'fresh' ? `${section.id}-${lastRevision?.at}` : section.id) }, section.id))), streaming ? (_jsxs("p", { className: "explain-writing", children: [_jsx("span", { className: "spinner" }), thought ? (_jsxs("span", { children: [writer, " is thinking \u2014 ", _jsx("em", { children: thought })] })) : explanation?.content ? (_jsxs("span", { children: [writer, " is writing", sections.length ? ` — ${sections[sections.length - 1].title || 'the opening'}` : '', "\u2026"] })) : (_jsxs("span", { children: [writer, " is reading the paper\u2026 a long one can take a minute or two before the first words", implementing ? ' of the plan' : '', "."] }))] })) : null, explanation?.error ? _jsx("p", { className: "explain-error", children: explanation.error }) : null, explanation?.truncated ? _jsxs("p", { className: "explain-error", children: ["It ran out of room before the end. Rewrite, or ask about the rest in ", ASSISTANT_NAME, "."] }) : null] })) }) }) }) })] }), side ? (_jsxs("aside", { className: "nb-side explain-side", "aria-label": side === 'runtime' ? 'The runtime' : side === 'metrics' ? 'Training metrics' : 'Files on the runtime', children: [_jsxs("div", { className: "nb-side-tabs", role: "tablist", children: [_jsx("button", { type: "button", role: "tab", "aria-selected": side === 'runtime', onClick: () => pickSide('runtime'), children: "Runtime" }), _jsx("button", { type: "button", role: "tab", "aria-selected": side === 'metrics', onClick: () => pickSide('metrics'), children: "Metrics" }), _jsx("button", { type: "button", role: "tab", "aria-selected": side === 'files', onClick: () => pickSide('files'), children: "Files" }), _jsx("span", { className: "spacer" }), _jsx("button", { type: "button", className: "icon-btn sm", onClick: () => pickSide(null), "aria-label": "Close the pane", children: _jsx(CloseIcon, { size: 14 }) })] }), side === 'runtime' ? (_jsx(RuntimePane, { cells: codeCells, compute: compute, onGoTo: goToCell, onRunAll: colabAvailable(settings.googleClientId) && runnable.length ? () => void runAll(runnable).catch(() => undefined) : undefined })) : side === 'metrics' ? (_jsx(MetricsPane, { cells: metricCells, running: colab.running, onGoTo: goToCell, colabUrl: colab.runtime && colab.backend.kind === 'colab' ? attachUrl(colab.runtime.endpoint) : undefined })) : (_jsx(FilesPane, {}))] })) : null] })] })), picked ? (_jsxs("div", { className: "selection-toolbar", style: { top: picked.top, left: picked.left }, role: "toolbar", "aria-label": "The selection", children: [_jsxs("button", { type: "button", className: "wide", onMouseDown: (event) => event.preventDefault(), onClick: () => {
                            window.dispatchEvent(new CustomEvent('reader:ask-claude', { detail: { text: picked.text } }));
                            setPicked(null);
                        }, title: `${ASSISTANT_NAME} about this passage of the explanation — it reads the paper too`, children: [_jsx(SparkleIcon, { size: 15 }), " ", ASSISTANT_NAME] }), _jsx("span", { className: "divider" }), _jsxs("button", { type: "button", className: "wide", onMouseDown: (event) => event.preventDefault(), onClick: keepSelection, title: "Keep this passage in your notes, maths and all", children: [_jsx(NoteIcon, { size: 15 }), " Add to notes"] })] })) : null, implementing ? _jsx(RunConsole, { sections: sections }) : null, keeper.button, toast, snipping ? _jsx(BoxSnip, { root: docRef, selector: SNIPPABLE, onKeep: keepBox }) : null, closeUp ? _jsx(FigureCloseUp, { visuals: closeUp.visuals, index: closeUp.index, onIndex: (index) => setCloseUp({ visuals: closeUp.visuals, index }), onClose: () => setCloseUp(null), onKeep: keepElement }) : null, flash ? (_jsx(PassageFlash, { flash: flash, look: settings.passageLook, onDone: () => {
                    setFlash(null);
                    window.dispatchEvent(new CustomEvent(FLASH_EVENT, { detail: { quote: null } }));
                } })) : null] }));
}
