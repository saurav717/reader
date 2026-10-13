// ===========================================================================
//  Explain — the whole paper, taught by Claude.
//
//  One long answer per paper: what it claims, how it works, why that works
//  better than what came before, drawn as figures and written as code you can
//  run, and — because a paper does not update itself — what has happened to
//  its claims since. It is written in plain Markdown with four kinds of fenced
//  block the view draws specially:
//
//    ```figure caption="…"      an inline SVG diagram
//    ```python title="…"        a runnable cell (Colab is wired up later)
//    ```output                  what the cell above prints, as Claude expects it
//    ```caveat verdict="…" title="…"   a claim that has aged: holds, refined,
//                                      superseded, disputed or disproved
//    ```motion title="…" figure="…"    a scene: the figure above it with steps,
//                                      drawn and played by the page (motion.ts)
//    ```paper-figure ref="Figure 3" caption="…"   one of the paper's own figures,
//                                      drawn from what paperFigures.ts kept
//
//  Everything else is ordinary Markdown, and `## ` headings are the sections
//  the outline lists. The same key and SDK as Ask Claude (assistant.ts); the
//  finished text is kept per paper in IndexedDB, so it is paid for once.
// ===========================================================================
import { explainError, FULL_TEXT_MAX_CHARS, modelSpec, PROVIDERS, sdk, streamModel, tag } from './assistant';
import { db } from './db';
import { MOTION_FORMAT, parseMotion } from './motion';
import { figureList, gatherPaperFigures } from './paperFigures';
/**
 * The explanation is long by design; this caps a runaway, it does not budget one.
 * Thinking comes out of the same allowance, so it has room for both.
 */
const MAX_TOKENS = 64000;
export const EXPLAIN_SYSTEM = `You are writing the explanation page of a research-paper reader: a long-form,
teach-it-properly walkthrough of ONE paper, which the reader studies instead of (or beside) the paper itself.
The full text of the paper and its details are given below.

Write for a capable reader who is new to this paper — a graduate student or engineer. Your job:
1. Explain what problem the paper solves and why it mattered at the time.
2. Explain HOW the method works, step by step, with the intuition before the formalism.
3. Explain WHY it works better than what came before — the mechanism, not just the numbers.
4. Show it: small diagrams and small runnable Python that make each key idea concrete.
5. Be honest about age. Today is ${new Date().toISOString().slice(0, 10)}. Say what later work has confirmed,
   refined, superseded, disputed or disproved, and what the paper's own experiments could not show.
   If you are not sure whether a later result exists, say so rather than inventing one. Never invent citations.

FORMAT — plain Markdown, with these rules the page depends on:
- Start with "## At a glance": 3–5 bullets, then one sentence on who should care.
- Then 4–8 sections, each "## <short title>". No "#" headings. "###" is fine inside a section.
- Diagrams: a fenced block \`\`\`figure caption="One-line caption"\` containing ONE self-contained <svg> with a
  viewBox and no width/height, no scripts, no external images, no fonts other than inherited ones.
  Colour it ONLY with these classes (the page themes them for light and dark):
  fill: f-accent, f-soft, f-yellow, f-blue, f-green, f-pink, f-paper; stroke: s-ink, s-muted, s-accent;
  text: t-muted, t-accent, t-on (for text on f-accent; text is ink by default). Lines default to the ink colour. Keep text ≥ 11 units.
  Maths in a figure's text is LaTeX between single dollars too, e.g. <text>$\\hat{z}_{t+1} = f_\\theta(z_t)$</text>: the page
  sets it inside the drawing with Unicode, italics, subscripts and superscripts. Keep it to what fits on one line —
  symbols, Greek, accents, sub- and superscripts, \\frac as a/b — and never spell it out as z_hat, theta or ->.
  One or two figures per key idea is plenty; skip them where words are clearer.
- Code: \`\`\`python title="What this cell shows"\` — short (≤ 40 lines), self-contained, numpy (or torch
  when it matters) only, deterministic (seed it), and it must print something that proves the point.
  Follow each cell with \`\`\`output\` holding what it prints. These cells will be run in Google Colab.
- Caveats: \`\`\`caveat verdict="holds|refined|superseded|disputed|disproved" title="The claim, in a few words"\`
  then 1–4 sentences of Markdown: what changed, and roughly when and by whom (only if you are confident).
  Put a caveat right where the claim is explained, AND end with a section "## Since then" that lists every
  caveat again as a short verdict table followed by what a reader should use today instead.
- Scenes: where a figure shows something that happens in stages — a pass through a model, a loss that compares two
  things, a procedure with steps, a quantity that changes with a knob — mark the figure as worth animating with
  animate="yes" in its fence (at most three per page; never a table, a timeline, a list or a definition). Do NOT write
  a scene unless the reader asks for one; when they do, write it as described under SCENES, right after the figure.
- The paper's own figures: when a <paper_figures> list is given, put the paper's figure on the page where the reader
  should look at it — the architecture as the authors drew it, the plot a result rests on, a table of the key numbers,
  qualitative samples — with a fenced block of its own, right after the paragraph that discusses it:
  \`\`\`paper-figure ref="Figure 3" caption="What to look at in it, in one line"\`
  then, inside the block, 1–3 sentences of Markdown that walk the reader through it: what the axes, panels or boxes
  are, and what to notice. Close the block with \`\`\`. Use ONLY names from that list, each at most once, and
  refer to it in the prose ("in Figure 3 of the paper, …"). Where you were shown the pictures, describe what is
  actually in them. Prefer the paper's figure to redrawing the same thing; draw your own figure only to show what
  the paper does not. Two to six of the paper's figures on a page is typical; none when no list is given.
- Name papers only when you are sure they exist.

${MOTION_FORMAT}

MATHS — the page typesets LaTeX, so write every formula, symbol and variable name as LaTeX:
- Inline between single dollars, $\\nabla \\cdot u = 0$; a displayed equation on lines of its own between double dollars:
  $$
  \\partial_t u + (u \\cdot \\nabla) u = \\nu \\Delta u - \\nabla p
  $$
  Never put maths in \`code\` spans or in a plain \`\`\` block, and never write it as Unicode approximations.
- Teach the maths, as much as the paper needs and no more. For each equation that carries the argument: say in words
  what it states, name every symbol the first time it appears (a short "where …" list under a displayed equation works
  well), and give the intuition — what each term does, why it has that form, what happens in a simple or limiting case.
  Walk through the key steps of a derivation or proof one move at a time, saying why each move is allowed, rather than
  jumping to the result. A paper with little maths needs little of this; a mathematical paper needs a lot of it.`;
export const VERDICTS = {
    holds: 'Still holds',
    refined: 'Refined since',
    superseded: 'Superseded',
    disputed: 'Disputed',
    disproved: 'Disproved',
};
/** The language a starter file is coloured as, from its name. */
export function langOf(path) {
    const ext = path.toLowerCase().split('.').pop() ?? '';
    if (/^(py|pyi)$/.test(ext))
        return 'python';
    if (/^(sh|bash|zsh)$/.test(ext) || /^(makefile|dockerfile)$/i.test(path.split('/').pop() ?? ''))
        return 'bash';
    if (/^(yml|yaml)$/.test(ext))
        return 'yaml';
    if (/^(json|jsonl)$/.test(ext))
        return 'json';
    if (/^(toml|cfg|ini)$/.test(ext))
        return 'toml';
    if (/^(md|markdown)$/.test(ext))
        return 'markdown';
    return 'text';
}
const attrs = (info) => {
    const out = {};
    for (const match of info.matchAll(/(\w+)\s*=\s*"([^"]*)"/g))
        out[match[1].toLowerCase()] = match[2];
    return out;
};
const slug = (text, taken) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
    let id = base;
    for (let n = 2; taken.has(id); n++)
        id = `${base}-${n}`;
    taken.add(id);
    return id;
};
const asVerdict = (value) => value && value.toLowerCase() in VERDICTS ? value.toLowerCase() : 'refined';
/** Marks a fence closed only so the sections after it survive; the block itself is still being written. */
const STILL_OPEN = '<!--open-->';
const CLOSE = /^\s*```\s*(<!--open-->)?\s*$/;
export function parseExplanation(src) {
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const sections = [];
    const taken = new Set();
    let current = { id: 'intro', title: '', blocks: [] };
    let prose = [];
    const flush = () => {
        const md = prose.join('\n').trim();
        if (md)
            current.blocks.push({ kind: 'prose', md });
        prose = [];
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const heading = /^##\s+(.+?)\s*#*\s*$/.exec(line);
        if (heading) {
            flush();
            if (current.title || current.blocks.length)
                sections.push(current);
            current = { id: slug(heading[1], taken), title: heading[1], blocks: [] };
            continue;
        }
        const fence = /^\s*```\s*([\w+-]*)(.*)$/.exec(line);
        if (fence) {
            const lang = fence[1].toLowerCase();
            const info = attrs(fence[2] ?? '');
            const body = [];
            let j = i + 1;
            while (j < lines.length && !CLOSE.test(lines[j]))
                body.push(lines[j++]);
            // Still streaming: the fence never closed, or a revision closed it for us (see applyEdits).
            const open = j >= lines.length || lines[j].includes(STILL_OPEN);
            const text = body.join('\n');
            i = j;
            if (lang === 'figure' || lang === 'svg') {
                flush();
                const figure = { kind: 'figure', svg: text, caption: info.caption ?? '', open };
                if (/^(yes|true|1)$/i.test(info.animate ?? ''))
                    figure.animate = true;
                current.blocks.push(figure);
            }
            else if (lang === 'motion' || lang === 'scene') {
                flush();
                current.blocks.push({ kind: 'motion', title: info.title ?? '', figure: info.figure ?? '', src: text, spec: open ? null : parseMotion(text), open });
            }
            else if (/^paper[-_]?(figure|table|fig)$/.test(lang)) {
                flush();
                current.blocks.push({ kind: 'paperFigure', ref: info.ref ?? info.figure ?? info.name ?? '', caption: info.caption ?? '', md: text.trim(), open });
            }
            else if (lang === 'caveat') {
                flush();
                current.blocks.push({ kind: 'caveat', verdict: asVerdict(info.verdict), title: info.title ?? '', md: text.trim() });
            }
            else if (lang === 'output') {
                flush();
                const last = current.blocks[current.blocks.length - 1];
                if (last?.kind === 'code')
                    last.output = text;
                else
                    current.blocks.push({ kind: 'code', lang: 'text', title: 'Output', code: text, open });
            }
            else if (lang === 'python' || lang === 'py') {
                flush();
                current.blocks.push({ kind: 'code', lang: 'python', title: info.title ?? '', code: text, open });
            }
            else if (lang === 'bash' || lang === 'sh' || lang === 'shell') {
                // A shell cell: a bash block with a title is a cell of the page; one without is ordinary Markdown code.
                if (info.title === undefined) {
                    prose.push(line, ...body);
                    if (!open)
                        prose.push('```');
                }
                else {
                    flush();
                    current.blocks.push({ kind: 'code', lang: 'bash', title: info.title, code: text, open });
                }
            }
            else if (lang === 'tree') {
                flush();
                current.blocks.push({ kind: 'tree', text: text.replace(/^\s*\n|\s+$/g, ''), open });
            }
            else if (lang === 'file' && info.path) {
                flush();
                current.blocks.push({ kind: 'file', path: info.path, lang: info.lang ?? langOf(info.path), code: text, open });
            }
            else if (lang === 'compute') {
                flush();
                current.blocks.push({ kind: 'compute', text, open });
            }
            else {
                // Any other fence is ordinary Markdown code; hand it back to the prose.
                prose.push(line, ...body);
                if (!open)
                    prose.push('```');
            }
            continue;
        }
        // A figure of the paper named the way Ask Claude names one, alone on its line: drawn as the block would be.
        const named = /^\s*!\[([^\]]*)\]\(\s*(figure|table)\s*:\s*([\w.]+)\s*\)\s*$/i.exec(line);
        if (named) {
            flush();
            current.blocks.push({ kind: 'paperFigure', ref: `${named[2].toLowerCase() === 'table' ? 'Table' : 'Figure'} ${named[3]}`, caption: named[1], md: '', open: false });
            continue;
        }
        prose.push(line);
    }
    flush();
    if (current.title || current.blocks.length)
        sections.push(current);
    return sections;
}
export const caveatsOf = (sections) => sections.flatMap((section) => section.blocks.filter((b) => b.kind === 'caveat').map((b) => ({ ...b, section: section.id })));
// ---------------------------------------------------------------------------
// A notebook of the whole explanation, for Colab until the page can run cells
// ---------------------------------------------------------------------------
/**
 * `writer` is the model that wrote the page — named in the header, so a page
 * DeepSeek or Gemini wrote is not signed by Claude. Claude, when nothing says.
 */
export function notebook(title, sections, writer = 'Claude') {
    const cells = [];
    const md = (text) => cells.push({ cell_type: 'markdown', metadata: {}, source: text.split(/(?<=\n)/) });
    md(`# ${title}\n\n*Explained by ${writer} in Reader. The outputs under each cell were written by ${writer}, not run — run them to check.*`);
    for (const section of sections) {
        const parts = section.title ? [`## ${section.title}`] : [];
        const push = () => {
            if (parts.length)
                md(parts.join('\n\n'));
            parts.length = 0;
        };
        for (const block of section.blocks) {
            if (block.kind === 'prose')
                parts.push(block.md);
            else if (block.kind === 'caveat')
                parts.push(`> **${VERDICTS[block.verdict]}${block.title ? ` — ${block.title}` : ''}.** ${block.md.replace(/\n/g, '\n> ')}`);
            else if (block.kind === 'figure')
                parts.push(`*Figure: ${block.caption || 'see the explanation page'}*`);
            else if (block.kind === 'paperFigure')
                parts.push(`*${block.ref} of the paper${block.caption ? ` — ${block.caption}` : ''}*${block.md ? `\n\n${block.md}` : ''}`);
            else if (block.kind === 'motion')
                parts.push(`*Scene${block.title ? `: ${block.title}` : ''} — played on the explanation page${block.spec ? `. ${block.spec.steps.map((s) => s.caption).filter(Boolean).join(' ')}` : ''}*`);
            else if (block.kind === 'tree')
                parts.push(`\`\`\`\n${block.text}\n\`\`\``);
            else if (block.kind === 'compute')
                parts.push('*The compute budget is on the Implementation page, worked out for your hardware.*');
            else if (block.kind === 'file') {
                // A starter file becomes a cell that writes it, so running the notebook top to bottom lays the repository out.
                push();
                cells.push({
                    cell_type: 'code',
                    execution_count: null,
                    metadata: {},
                    outputs: [],
                    source: `%%writefile ${block.path}\n${block.code}`.split(/(?<=\n)/),
                });
            }
            else if (block.kind === 'code' && block.lang === 'bash') {
                push();
                cells.push({
                    cell_type: 'code',
                    execution_count: null,
                    metadata: {},
                    outputs: [],
                    source: `%%bash\n# ${block.title}\n${block.code}`.split(/(?<=\n)/),
                });
            }
            else if (block.kind === 'code' && block.lang === 'python') {
                push();
                cells.push({
                    cell_type: 'code',
                    execution_count: null,
                    metadata: {},
                    outputs: [],
                    source: `# ${block.title}\n${block.code}`.split(/(?<=\n)/),
                });
            }
        }
        push();
    }
    return JSON.stringify({ cells, metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' }, language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5 }, null, 1);
}
// ---------------------------------------------------------------------------
// Revising: the reader asks from the bar at the top, Claude edits sections
// ---------------------------------------------------------------------------
//
// A question or an adjustment ("simpler", "a PyTorch version", "why √d?")
// does not rewrite the page: Claude answers with operations on its sections,
// which are applied as they stream in, so the one section being revised
// rewrites itself in place while the rest stays put.
const OP = /^<<<\s*(replace|insert after|insert before|delete|note)\s*(?::\s*(.*?))?\s*>>>\s*$/i;
export function parseEdits(text) {
    const ops = [];
    for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
        const match = OP.exec(line.trim());
        if (match)
            ops.push({ op: match[1].toLowerCase(), target: (match[2] ?? '').trim(), body: '' });
        else if (ops.length)
            ops[ops.length - 1].body += (ops[ops.length - 1].body ? '\n' : '') + line;
    }
    return ops;
}
const titleKey = (title) => title
    .toLowerCase()
    .replace(/^\s*(§|section)?\s*\d+[.)]?\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
/** The page as its `## ` sections: what comes before the first, then each heading with its body. */
function splitSections(content) {
    const lines = content.split('\n');
    const parts = [];
    const lead = [];
    let inFence = false;
    for (const line of lines) {
        if (/^\s*```/.test(line))
            inFence = !inFence;
        const heading = !inFence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
        if (heading)
            parts.push({ title: heading[1], text: line });
        else if (parts.length)
            parts[parts.length - 1].text += `\n${line}`;
        else
            lead.push(line);
    }
    return { lead: lead.join('\n'), parts };
}
export const sectionTitles = (content) => splitSections(content).parts.map((part) => part.title);
/** The page with the edits applied. Safe on a half-streamed reply: the last edit is simply shorter. */
export function applyEdits(base, reply, fallbackAfter) {
    const { lead, parts } = splitSections(base);
    const touched = [];
    let note = '';
    const find = (target) => {
        const key = titleKey(target);
        const exact = parts.findIndex((part) => titleKey(part.title) === key);
        return exact >= 0 ? exact : parts.findIndex((part) => key && (titleKey(part.title).includes(key) || key.includes(titleKey(part.title))));
    };
    // A new section with no place named goes before "Since then", which stays last.
    const beforeEnd = () => {
        const since = parts.findIndex((part) => /since then/i.test(part.title));
        return since >= 0 ? since : parts.length;
    };
    const section = (body, title) => {
        let text = body.replace(/^\s*\n/, '').trimEnd();
        // Halfway through a figure or a cell, its fence is still open; close it
        // here, or it would swallow every section after this one.
        if ((text.match(/^\s*```/gm) ?? []).length % 2)
            text += `\n\`\`\`${STILL_OPEN}`;
        const heading = /^##\s+(.+?)\s*#*\s*$/m.exec(text.split('\n')[0] ?? '');
        return heading ? { title: heading[1], text } : { title, text: `## ${title}\n${text}` };
    };
    const ops = parseEdits(reply);
    if (!ops.length && reply.trim()) {
        // Claude answered without the markers: keep the answer, as a section of its own.
        const answer = section(reply, 'Your question');
        const at = fallbackAfter ? find(fallbackAfter) : -1;
        parts.splice(at >= 0 ? at + 1 : beforeEnd(), 0, answer);
        touched.push(answer.title);
    }
    for (const op of ops) {
        if (op.op === 'note') {
            note = op.body.trim();
            continue;
        }
        const at = find(op.target);
        if (op.op === 'delete') {
            if (at >= 0)
                parts.splice(at, 1);
            continue;
        }
        const fresh = section(op.body, op.target || 'Your question');
        if (!fresh.text.trim())
            continue;
        if (op.op === 'replace' && at >= 0)
            parts[at] = fresh;
        else if (op.op === 'insert before' && at >= 0)
            parts.splice(at, 0, fresh);
        else
            parts.splice(at >= 0 ? at + 1 : beforeEnd(), 0, fresh);
        touched.push(fresh.title);
    }
    const content = [lead.trimEnd(), ...parts.map((part) => part.text.trimEnd())].filter(Boolean).join('\n\n');
    return { content, note, touched };
}
function revisionRequest(content, request, scope) {
    return [
        'The reader has a request about the explanation page you wrote above.',
        tag('request', request),
        tag('about_section', scope.section),
        tag('selected_passage', scope.quote),
        `Change the page to satisfy it. If it is a question, answer it inside the page: expand the section it belongs to, or add a
new section right after that one. If it asks to adjust the content (simpler, deeper, other code, more figures, less maths…),
rewrite only the sections that must change, and keep every other section exactly as it is. Follow the same format rules
(figure, paper-figure, python, output, caveat and motion blocks). If you add or change a caveat, keep "Since then" consistent with it.
If the request is to animate a figure or a section, add ONE motion block right after the figure it animates (keep the
figure), with a step for each paragraph of the section, and change nothing else in it.

Reply ONLY with edit operations, each marker on a line of its own:
<<<replace: Exact title of an existing section>>>
## Title (the same one, or a better one)
the whole new content of that section
<<<insert after: Exact title of an existing section>>>
## A new section's title
its content
<<<delete: Exact title of an existing section>>>
and last of all:
<<<note>>>
One short sentence to the reader on what you changed.`,
        tag('existing_sections', sectionTitles(content).map((title) => `- ${title}`).join('\n')),
    ]
        .filter(Boolean)
        .join('\n\n');
}
/** What the Animate button asks for: a scene for one figure, as a request the bar could have been given. */
export function sceneRequest(section, caption) {
    const figure = caption ? `the figure “${caption}”` : 'the key figure';
    return `Animate ${figure} in the section “${section}”: add a motion block right after it, one step per paragraph of the section, that shows what the paragraphs describe happening.`;
}
/** The section's scene, when it has one. */
export const motionOf = (section) => section.blocks.find((b) => b.kind === 'motion');
let drive = null;
const driveStates = new Map();
const driveTimers = new Map();
const checks = new Map();
/** How long a save waits for more changes: a revision and its Undo are one write. */
const DRIVE_DEBOUNCE_MS = 1200;
/** A check of Drive when Explain opens gives up after this, and the page is offered as usual. */
const DRIVE_CHECK_MS = 10_000;
/** Set by the app when Drive is connected, and cleared when it is not. */
export function setExplainDrive(adapter) {
    drive = adapter;
}
export const driveStateFor = (paperId) => driveStates.get(paperId);
function setDriveState(paperId, next) {
    driveStates.set(paperId, next);
    notify();
}
function scheduleDriveSave(paperId) {
    if (!drive)
        return;
    window.clearTimeout(driveTimers.get(paperId));
    setDriveState(paperId, { state: 'saving' });
    driveTimers.set(paperId, window.setTimeout(() => {
        driveTimers.delete(paperId);
        void saveToDrive(paperId);
    }, DRIVE_DEBOUNCE_MS));
}
async function saveToDrive(paperId) {
    const adapter = drive;
    const entry = cache.get(paperId);
    if (!adapter || !entry?.content || entry.streaming)
        return;
    try {
        const written = await adapter.save(entry);
        const now = cache.get(paperId);
        // A change made while it was being written goes in the next save; this one only records where the file is.
        if (now) {
            const next = { ...now, drive: written };
            cache.set(paperId, next);
            persistLocal(next);
        }
        setDriveState(paperId, { state: 'saved', link: written.link });
    }
    catch (error) {
        setDriveState(paperId, { state: 'error', message: error instanceof Error ? error.message : String(error) });
    }
}
/** Looks in Drive for this paper's page, and takes it when it is newer than the one here. */
function checkDrive(paperId) {
    const adapter = drive;
    if (!adapter)
        return Promise.resolve();
    const inFlight = checks.get(paperId);
    if (inFlight)
        return inFlight;
    setDriveState(paperId, { state: 'checking' });
    const check = (async () => {
        const local = cache.get(paperId);
        try {
            const found = await Promise.race([
                adapter.load(paperId, local?.drive),
                new Promise((_, reject) => window.setTimeout(() => reject(new Error('Drive took too long to answer.')), DRIVE_CHECK_MS)),
            ]);
            const now = cache.get(paperId);
            if (!found) {
                // Nothing in Drive yet: a page written before Drive was connected goes up now.
                if (now?.content && !now.streaming)
                    scheduleDriveSave(paperId);
                else
                    setDriveState(paperId, { state: 'none' });
                return;
            }
            const remote = found.explanation;
            const busy = running?.paperId === paperId || now?.streaming || now?.pending;
            if (remote && !busy && (!now?.content || (remote.updated ?? 0) > (now.updated ?? 0))) {
                const adopted = { ...remote, drive: found.file, revisions: [] };
                cache.set(paperId, adopted);
                persistLocal(adopted);
                setDriveState(paperId, { state: 'saved', link: found.file.link, fetched: true });
                return;
            }
            if (now && !now.drive) {
                cache.set(paperId, { ...now, drive: found.file });
                persistLocal(cache.get(paperId));
            }
            // This browser has changes Drive has not seen.
            if (remote && now?.content && (now.updated ?? 0) > (remote.updated ?? 0))
                scheduleDriveSave(paperId);
            else
                setDriveState(paperId, { state: 'saved', link: found.file.link });
        }
        catch (error) {
            setDriveState(paperId, { state: 'error', message: error instanceof Error ? error.message : String(error) });
        }
        finally {
            checks.delete(paperId);
        }
    })();
    checks.set(paperId, check);
    return check;
}
/** How many past versions are kept for Undo. */
const REVISIONS_KEPT = 12;
const KEY = (paperId) => `explain:${paperId}`;
const cache = new Map();
const listeners = new Set();
let running = null;
const notify = () => listeners.forEach((listener) => listener());
export function subscribeExplain(listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
export const explanationFor = (paperId) => cache.get(paperId);
function persistLocal(entry) {
    const { pending: _pending, streaming: _streaming, thinking: _thinking, ...kept } = entry;
    void db.setKv(KEY(entry.paperId), kept).catch(() => undefined);
}
/** The page changed: stamp it, keep it here, and send it to Drive. */
function keep(entry) {
    const stamped = { ...entry, updated: Date.now() };
    cache.set(entry.paperId, { ...(cache.get(entry.paperId) ?? stamped), updated: stamped.updated });
    persistLocal(stamped);
    scheduleDriveSave(entry.paperId);
}
/**
 * The paper's page, from this browser if it has one, then from Drive when that
 * is connected — which wins when it is newer, so a page written or revised in
 * another browser comes here rather than being written again.
 */
export async function loadExplanation(paperId) {
    if (!cache.has(paperId)) {
        try {
            const kept = await db.getKv(KEY(paperId));
            if (kept && !cache.has(paperId)) {
                cache.set(paperId, { ...kept, streaming: false, thinking: undefined, pending: undefined });
                notify();
            }
        }
        catch {
            // no IndexedDB: Drive, or writing it again
        }
    }
    await checkDrive(paperId);
    return cache.get(paperId);
}
/** For a demo or a test: put an explanation in place without asking anyone. */
export function putExplanation(explanation) {
    cache.set(explanation.paperId, explanation);
    notify();
    keep(explanation);
}
export function stopExplaining() {
    running?.stream.abort();
}
/** The system prompt, identical for the first page and every revision, so the paper is read from the cache. */
function systemFor(screen, figures = []) {
    const paper = screen.paper;
    const text = screen.fullText?.trim() ?? '';
    const details = [
        `Title: ${paper.title}`,
        paper.authors.length ? `Authors: ${paper.authors.join(', ')}` : '',
        paper.published ? `Published: ${paper.published}` : '',
        paper.venue ? `Venue: ${paper.venue}` : '',
        paper.arxivId ? `arXiv: ${paper.arxivId}` : '',
    ]
        .filter(Boolean)
        .join('\n');
    return [
        { type: 'text', text: EXPLAIN_SYSTEM },
        {
            type: 'text',
            text: [tag('paper', details), tag('abstract', paper.abstract), tag('paper_text', text.slice(0, FULL_TEXT_MAX_CHARS)), figures.length ? tag('paper_figures', figureList(figures)) : '']
                .filter(Boolean)
                .join('\n\n'),
            cache_control: { type: 'ephemeral' },
        },
    ];
}
const firstAsk = (screen) => screen.fullText?.trim()
    ? 'Write the explanation page for this paper.'
    : 'Only the details and abstract of this paper could be read, not its full text. Write the explanation page from them and what you reliably know of the paper, and say at the top that the full text was not available.';
/**
 * The first request, the same for the page and every revision of it: the ask,
 * led by the paper's figures as pictures, each named, when the model can see
 * them. Claude's copy is cached at its end, so a revision pays for the
 * pictures once.
 */
export function firstMessage(screen, figures, model) {
    const ask = firstAsk(screen);
    const spec = modelSpec(model);
    if (!figures.length || !spec.vision)
        return ask;
    return [
        ...figures.flatMap((figure) => [
            { type: 'text', text: `${figure.ref} of the paper — ${figure.caption || 'no caption'}` },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: figure.data } },
        ]),
        {
            type: 'text',
            text: `Those are the paper's own figures, as listed in <paper_figures>. ${ask}`,
            ...(spec.provider === 'anthropic' ? { cache_control: { type: 'ephemeral' } } : {}),
        },
    ];
}
/** A paper's worth of thinking takes minutes; this is what the page shows meanwhile. */
function setThinking(paperId, thinking) {
    const entry = cache.get(paperId);
    if (!entry || entry.thinking === thinking)
        return;
    cache.set(paperId, { ...entry, thinking });
    notify();
}
/**
 * Streams one request, calling `onText` a frame at a time with everything so far.
 * Thinking is asked for as a summary (the models that think show nothing by
 * default, which on a whole paper reads as a hang) and kept on the entry.
 */
async function streamOnce(paperId, model, effort, params, onText) {
    const stream = await streamModel({ model, maxTokens: MAX_TOKENS, ...params, effort });
    running = { paperId, stream };
    let text = '';
    let thinking = '';
    let frame = 0;
    const paint = () => {
        if (frame)
            return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            // The text first: the first page's `onText` puts down a fresh entry.
            onText(text);
            setThinking(paperId, thinking || undefined);
        });
    };
    stream.on('thinking', (delta) => {
        thinking += delta;
        paint();
    });
    stream.on('text', (delta) => {
        text += delta;
        // Writing again: what it thought before this stretch is spent.
        thinking = '';
        paint();
    });
    try {
        const final = await stream.finalMessage();
        return { stop: final.stop_reason };
    }
    finally {
        if (frame)
            cancelAnimationFrame(frame);
        onText(text);
        setThinking(paperId, undefined);
    }
}
export async function generateExplanation(screen, model) {
    const paper = screen.paper;
    if (!paper || running)
        return;
    const previous = cache.get(paper.id);
    // A rewrite goes over the same file in Drive.
    const entry = { paperId: paper.id, content: '', model, created: Date.now(), streaming: true, drive: previous?.drive };
    cache.set(paper.id, entry);
    notify();
    let SDK = null;
    try {
        if (modelSpec(model).provider === 'anthropic')
            SDK = await sdk();
        // The paper's own figures, read afresh: the page places them, and a model that can see is shown them.
        const figures = await gatherPaperFigures(paper.id, { fresh: true });
        const { stop } = await streamOnce(paper.id, model, 'medium', { system: systemFor(screen, figures), messages: [{ role: 'user', content: firstMessage(screen, figures, model) }] }, (text) => {
            entry.content = text;
            cache.set(paper.id, { ...entry });
            notify();
        });
        if (stop === 'max_tokens')
            entry.truncated = true;
        if (stop === 'refusal')
            entry.error = `${PROVIDERS[modelSpec(model).provider].name} declined to write this one.`;
    }
    catch (error) {
        entry.error = explainError(error, SDK);
    }
    finally {
        running = null;
        entry.streaming = false;
        // A rewrite can be undone like any other request.
        if (previous?.content && entry.content) {
            entry.revisions = [
                ...(previous.revisions ?? []),
                { request: 'Rewrite the whole page', before: previous.content, note: 'Written again from scratch.', touched: [], at: Date.now() },
            ].slice(-REVISIONS_KEPT);
        }
        cache.set(paper.id, { ...entry });
        notify();
        if (entry.content && !entry.error)
            keep(entry);
    }
}
/** Answers a request from the bar by editing the page's sections — with the model the bar picked, else the page's writer. */
export async function reviseExplanation(screen, request, scope = {}, model) {
    const paper = screen.paper;
    const current = paper && cache.get(paper.id);
    if (!paper || !current?.content || running || current.streaming || !request.trim())
        return;
    // Answered by the model the bar picked, else by the one that wrote the page.
    const answerer = model || current.model;
    const before = current.content;
    const pending = { request: request.trim(), scope, reply: '', started: Date.now() };
    const update = (patch) => {
        const next = { ...cache.get(paper.id), ...patch };
        cache.set(paper.id, next);
        notify();
        return next;
    };
    update({ pending: { ...pending }, error: undefined });
    let SDK = null;
    try {
        if (modelSpec(answerer).provider === 'anthropic')
            SDK = await sdk();
        // The figures the page was written with, so the request reads as the page did.
        const figures = await gatherPaperFigures(paper.id);
        const { stop } = await streamOnce(paper.id, answerer, 'medium', {
            system: systemFor(screen, figures),
            messages: [
                { role: 'user', content: firstMessage(screen, figures, answerer) },
                { role: 'assistant', content: before },
                { role: 'user', content: revisionRequest(before, pending.request, scope) },
            ],
        }, (reply) => {
            pending.reply = reply;
            update({ pending: { ...pending } });
        });
        if (stop === 'refusal')
            throw new Error(`${PROVIDERS[modelSpec(answerer).provider].name} declined that request.`);
        const applied = applyEdits(before, pending.reply, scope.section);
        if (!applied.touched.length && applied.content === before)
            throw new Error(applied.note || `${PROVIDERS[modelSpec(answerer).provider].name} left the page as it was.`);
        const revision = { request: pending.request, before, note: applied.note, touched: applied.touched, at: Date.now() };
        const next = update({
            content: applied.content,
            pending: undefined,
            truncated: stop === 'max_tokens' ? true : undefined,
            revisions: [...(current.revisions ?? []), revision].slice(-REVISIONS_KEPT),
            requests: [...(current.requests ?? []), revision.request],
        });
        keep(next);
    }
    catch (error) {
        const message = explainError(error, SDK);
        // Stopping puts the page back as it was, with nothing to report.
        update({ pending: message === 'Stopped.' ? undefined : { ...pending, error: message } });
    }
    finally {
        running = null;
    }
}
/** Puts the page back as it was before the last request. */
export function undoRevision(paperId) {
    const entry = cache.get(paperId);
    const last = entry?.revisions?.[entry.revisions.length - 1];
    if (!entry || !last || running)
        return;
    const next = {
        ...entry,
        content: last.before,
        revisions: entry.revisions.slice(0, -1),
        requests: entry.requests?.at(-1) === last.request ? entry.requests.slice(0, -1) : entry.requests,
        pending: undefined,
        error: undefined,
        truncated: undefined,
    };
    cache.set(paperId, next);
    notify();
    keep(next);
}
/** Clears a failed request's message. */
export function dismissPending(paperId) {
    const entry = cache.get(paperId);
    if (!entry?.pending || running)
        return;
    cache.set(paperId, { ...entry, pending: undefined });
    notify();
}
export const isExplaining = (paperId) => running?.paperId === paperId;
/** Every page being written or revised right now: what the progress pill outside Explain follows. */
export const explanationsAtWork = () => Array.from(cache.values()).filter((entry) => entry.streaming || (entry.pending && !entry.pending.error));
