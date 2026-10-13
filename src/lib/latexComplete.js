// LaTeX autocomplete for the Write tab's editor, as Overleaf offers it:
// commands as you type a backslash, environments after \begin{ (the \end
// filled in), cite keys after \cite{ (the .bib's and the project's papers),
// labels after \ref{, and the paper's files after \input{, \include{,
// \includegraphics{ and \bibliography{. What is here is the deciding: what is
// being typed at the caret, and what fits it, best first. No DOM, no React,
// so it can be tested without a browser. The editor shows the list
// (src/components/CodeEditor.tsx, `complete`).
const CITE = /\\(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)\*?(?:\[[^\]\n]*\]){0,2}\{([^{}\n]*)$/;
const REF = /\\(?:ref|eqref|pageref|autoref|cref|Cref|nameref|vref)\*?\{([^{}\n]*)$/;
const INPUT = /\\(?:input|include|subfile)\{([^{}\n]*)$/;
const GRAPHICS = /\\includegraphics\*?(?:\[[^\]\n]*\])?\{([^{}\n]*)$/;
const BIB = /\\bibliography\{([^{}\n]*)$/;
const BIBRESOURCE = /\\addbibresource(?:\[[^\]\n]*\])?\{([^{}\n]*)$/;
const BEGIN = /\\begin\{([a-zA-Z*]*)$/;
const END = /\\end\{([a-zA-Z*]*)$/;
const COMMAND = /\\([a-zA-Z]*)$/;
/** What is being typed at the caret, if it is something to complete; null in plain text and comments. */
export function contextAt(text, caret) {
    const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
    const before = text.slice(lineStart, caret);
    // In a comment: % not escaped.
    if (/(^|[^\\])%/.test(before))
        return null;
    // The word may go on past the caret (completing inside a name): it ends at the next delimiter.
    const rest = text.slice(caret).match(/^[^\s{}\\,%]*/)?.[0] ?? '';
    const inBraces = (pattern, kind) => {
        const match = before.match(pattern);
        if (!match)
            return null;
        const inside = match[1];
        const last = inside.slice(inside.lastIndexOf(',') + 1).replace(/^\s+/, '');
        return { kind, prefix: last, from: caret - last.length, to: caret + rest.length };
    };
    return (inBraces(CITE, 'cite') ??
        inBraces(REF, 'ref') ??
        inBraces(GRAPHICS, 'graphics') ??
        inBraces(INPUT, 'input') ??
        inBraces(BIB, 'bib') ??
        inBraces(BIBRESOURCE, 'bibresource') ??
        (() => {
            const begin = before.match(BEGIN);
            if (begin)
                return { kind: 'begin', prefix: begin[1], from: caret - begin[1].length, to: caret + rest.length };
            const end = before.match(END);
            if (end)
                return { kind: 'end', prefix: end[1], from: caret - end[1].length, to: caret + rest.length };
            const command = before.match(COMMAND);
            // A backslash and a letter at least, as Overleaf waits for: a bare \ is often \\ or \, being typed.
            if (command && command[1].length >= 1)
                return { kind: 'command', prefix: command[1], from: caret - command[1].length, to: caret + (text.slice(caret).match(/^[a-zA-Z]*/)?.[0].length ?? 0) };
            return null;
        })());
}
// The commands a paper uses most, Overleaf's suggestions first among them.
export const COMMANDS = [
    ['section', '{}', 'Section'], ['subsection', '{}', 'Subsection'], ['subsubsection', '{}', 'Subsubsection'], ['paragraph', '{}', 'Paragraph'],
    ['chapter', '{}', 'Chapter'], ['part', '{}', 'Part'], ['section*', '{}', 'Unnumbered section'], ['subsection*', '{}', 'Unnumbered subsection'],
    ['textbf', '{}', 'Bold'], ['textit', '{}', 'Italic'], ['emph', '{}', 'Emphasis'], ['underline', '{}', 'Underline'], ['texttt', '{}', 'Monospace'],
    ['textsc', '{}', 'Small caps'], ['textrm', '{}', 'Roman'], ['textsf', '{}', 'Sans serif'], ['mathbf', '{}', 'Bold (maths)'], ['mathrm', '{}', 'Roman (maths)'],
    ['mathcal', '{}', 'Calligraphic (maths)'], ['mathbb', '{}', 'Blackboard bold (maths)'], ['boldsymbol', '{}', 'Bold symbol (maths)'],
    ['cite', '{}', 'Citation'], ['citet', '{}', 'Textual citation (natbib)'], ['citep', '{}', 'Parenthetical citation (natbib)'], ['ref', '{}', 'Reference'],
    ['eqref', '{}', 'Equation reference'], ['autoref', '{}', 'Reference with its name (hyperref)'], ['cref', '{}', 'Clever reference'], ['label', '{}', 'Label'],
    ['footnote', '{}', 'Footnote'], ['url', '{}', 'URL'], ['href', '{}{}', 'Link'], ['caption', '{}', 'Caption'], ['includegraphics', '[width=\\linewidth]{}', 'Image'],
    ['input', '{}', 'Input a file'], ['include', '{}', 'Include a file'], ['usepackage', '{}', 'Use a package'], ['documentclass', '{}', 'Document class'],
    ['begin', '{}', 'Begin an environment'], ['end', '{}', 'End an environment'], ['item', '', 'List item'], ['title', '{}', 'Title'], ['author', '{}', 'Author'],
    ['date', '{}', 'Date'], ['maketitle', '', 'Make the title'], ['tableofcontents', '', 'Table of contents'], ['bibliography', '{}', 'Bibliography (BibTeX)'],
    ['bibliographystyle', '{}', 'Bibliography style'], ['addbibresource', '{}', 'Bibliography (biblatex)'], ['printbibliography', '', 'Print the bibliography (biblatex)'],
    ['newcommand', '{}{}', 'New command'], ['renewcommand', '{}{}', 'Redefine a command'], ['frac', '{}{}', 'Fraction'], ['sqrt', '{}', 'Square root'],
    ['sum', '', 'Sum'], ['prod', '', 'Product'], ['int', '', 'Integral'], ['lim', '', 'Limit'], ['log', '', 'Logarithm'], ['exp', '', 'Exponential'],
    ['left', '', 'Left delimiter'], ['right', '', 'Right delimiter'], ['cdot', '', 'Centred dot'], ['times', '', 'Times'], ['leq', '', 'Less or equal'],
    ['geq', '', 'Greater or equal'], ['neq', '', 'Not equal'], ['approx', '', 'Approximately'], ['infty', '', 'Infinity'], ['partial', '', 'Partial'],
    ['nabla', '', 'Nabla'], ['alpha', '', 'α'], ['beta', '', 'β'], ['gamma', '', 'γ'], ['delta', '', 'δ'], ['epsilon', '', 'ε'], ['theta', '', 'θ'],
    ['lambda', '', 'λ'], ['mu', '', 'μ'], ['sigma', '', 'σ'], ['tau', '', 'τ'], ['phi', '', 'φ'], ['omega', '', 'ω'], ['pi', '', 'π'], ['rho', '', 'ρ'],
    ['mathbb{R}', '', 'The reals'], ['in', '', 'Element of'], ['subseteq', '', 'Subset or equal'], ['rightarrow', '', 'Right arrow'], ['leftarrow', '', 'Left arrow'],
    ['Rightarrow', '', 'Implies'], ['mapsto', '', 'Maps to'], ['ldots', '', 'Dots'], ['cdots', '', 'Centred dots'], ['hat', '{}', 'Hat'], ['bar', '{}', 'Bar'],
    ['tilde', '{}', 'Tilde'], ['vec', '{}', 'Vector'], ['operatorname', '{}', 'Operator name'], ['text', '{}', 'Text in maths'], ['quad', '', 'Space'],
    ['hspace', '{}', 'Horizontal space'], ['vspace', '{}', 'Vertical space'], ['newline', '', 'New line'], ['newpage', '', 'New page'], ['clearpage', '', 'Clear the page'],
    ['centering', '', 'Centre'], ['noindent', '', 'No indent'], ['linewidth', '', 'Line width'], ['textwidth', '', 'Text width'], ['columnwidth', '', 'Column width'],
    ['toprule', '', 'Top rule (booktabs)'], ['midrule', '', 'Middle rule (booktabs)'], ['bottomrule', '', 'Bottom rule (booktabs)'], ['hline', '', 'Horizontal line'],
    ['multicolumn', '{}{}{}', 'Multi-column cell'], ['multirow', '{}{}{}', 'Multi-row cell'], ['appendix', '', 'Appendix'], ['abstract', '', 'Abstract'],
    ['thanks', '{}', 'Thanks'], ['and', '', 'Between authors'], ['textcolor', '{}{}', 'Coloured text'], ['todo', '{}', 'To-do note (todonotes)'],
];
/** The environments a paper uses most; each with what goes inside to start. */
export const ENVIRONMENTS = [
    ['figure', '\\centering\n\\includegraphics[width=\\linewidth]{}\n\\caption{}\n\\label{fig:}', 'Figure'],
    ['figure*', '\\centering\n\\includegraphics[width=\\textwidth]{}\n\\caption{}\n\\label{fig:}', 'Figure across both columns'],
    ['table', '\\centering\n\\caption{}\n\\label{tab:}\n\\begin{tabular}{lc}\n\\toprule\n & \\\\\n\\midrule\n & \\\\\n\\bottomrule\n\\end{tabular}', 'Table'],
    ['tabular', '', 'Tabular'], ['equation', '', 'Numbered equation'], ['equation*', '', 'Unnumbered equation'], ['align', '', 'Aligned equations'],
    ['align*', '', 'Aligned, unnumbered'], ['itemize', '\\item ', 'Bulleted list'], ['enumerate', '\\item ', 'Numbered list'], ['description', '\\item[] ', 'Description list'],
    ['abstract', '', 'Abstract'], ['document', '', 'Document'], ['theorem', '', 'Theorem'], ['lemma', '', 'Lemma'], ['proof', '', 'Proof'], ['definition', '', 'Definition'],
    ['algorithm', '\\caption{}\n\\label{alg:}', 'Algorithm'], ['algorithmic', '', 'Algorithmic'], ['minipage', '', 'Minipage'], ['center', '', 'Centred'],
    ['quote', '', 'Quotation'], ['verbatim', '', 'Verbatim'], ['lstlisting', '', 'Code listing'], ['subfigure', '', 'Subfigure'], ['cases', '', 'Cases (maths)'],
    ['matrix', '', 'Matrix'], ['pmatrix', '', 'Matrix in parentheses'], ['bmatrix', '', 'Matrix in brackets'], ['frame', '', 'Slide (beamer)'],
];
const rank = (label, prefix) => {
    const lower = label.toLowerCase();
    const want = prefix.toLowerCase();
    if (!want)
        return 1;
    if (label.startsWith(prefix))
        return 0;
    if (lower.startsWith(want))
        return 1;
    if (lower.includes(want))
        return 2;
    return -1;
};
function best(items, prefix, limit = 12) {
    return items
        .map((item, index) => ({ item, index, score: rank(item.label, prefix) }))
        .filter((entry) => entry.score >= 0)
        .sort((a, b) => a.score - b.score || a.index - b.index)
        .slice(0, limit)
        .map((entry) => entry.item);
}
/** \newcommand{\name}… and \DeclareMathOperator{\name}… from the paper's files. */
export function definedCommands(files) {
    const names = new Set();
    for (const file of files)
        for (const match of file.text.matchAll(/\\(?:re)?newcommand\*?\{?\\([a-zA-Z]+)\}?|\\DeclareMathOperator\*?\{\\([a-zA-Z]+)\}|\\def\\([a-zA-Z]+)/g))
            names.add(match[1] ?? match[2] ?? match[3]);
    return [...names];
}
/** \label{…} from the paper's files, with the file each is in. */
export function labelsIn(files) {
    const found = [];
    for (const file of files) {
        for (const match of file.text.matchAll(/\\label\{([^{}\n]+)\}/g))
            if (!found.some((item) => item.key === match[1]))
                found.push({ key: match[1], detail: file.path });
    }
    return found;
}
/** What fits the text at the caret, best first; null when nothing is being typed that completes. */
export function complete(text, caret, sources) {
    const context = contextAt(text, caret);
    if (!context)
        return null;
    const at = (items) => (items.length ? { from: context.from, to: context.to, items } : null);
    switch (context.kind) {
        case 'command': {
            const own = definedCommands(sources.files)
                .filter((name) => !COMMANDS.some(([known]) => known === name))
                .map((name) => ({ label: `\\${name}`, detail: 'defined in the paper', insert: name }));
            const known = COMMANDS.map(([name, args, detail]) => {
                const brace = args.indexOf('{}');
                const bracket = args.indexOf('[]');
                // The caret goes in the first argument (or option) to fill.
                const caretAt = bracket >= 0 && (brace < 0 || bracket < brace) ? name.length + bracket + 1 : brace >= 0 ? name.length + brace + 1 : undefined;
                return { label: `\\${name}${args}`, detail, insert: `${name}${args}`, ...(caretAt !== undefined ? { caret: caretAt } : {}) };
            });
            const items = best([...known, ...own].map((item) => ({ ...item, label: item.label })), context.prefix ? `\\${context.prefix}` : '\\', 14);
            // A command typed out in full needs no list.
            if (items.length === 1 && items[0].insert === context.prefix)
                return null;
            return at(items);
        }
        case 'begin': {
            const own = [...new Set(sources.files.flatMap((file) => [...file.text.matchAll(/\\newenvironment\{([^{}]+)\}/g)].map((match) => match[1])))].map((name) => [name, '', 'defined in the paper']);
            const lineStart = text.lastIndexOf('\n', context.from - 1) + 1;
            const indent = text.slice(lineStart, context.from).match(/^\s*/)?.[0] ?? '';
            // The editor closes a brace as it is typed: the } after the name is used for \end's, else one is added.
            const closing = text[context.to] === '}' ? '' : '}';
            return at(best([...ENVIRONMENTS, ...own].map(([name, body, detail]) => {
                const inner = body ? body.split('\n').map((line) => `${indent}    ${line}`).join('\n') : `${indent}    `;
                const insert = `${name}}\n${inner}\n${indent}\\end{${name}${closing}`;
                // The caret at the first {} to fill inside, else at the end of the first inside line.
                const lines = inner.split('\n');
                const row = lines.findIndex((line) => line.includes('{}'));
                const before = `${name}}\n`.length + lines.slice(0, Math.max(0, row)).reduce((sum, line) => sum + line.length + 1, 0);
                const caret = row >= 0 ? before + lines[row].indexOf('{}') + 1 : `${name}}\n`.length + lines[0].length;
                return { label: name, detail, insert, caret };
            }), context.prefix));
        }
        case 'end': {
            // The environment left open nearest before the caret.
            const open = [];
            for (const match of text.slice(0, context.from).matchAll(/\\(begin|end)\{([^{}]+)\}/g)) {
                if (match[1] === 'begin')
                    open.push(match[2]);
                else {
                    const at = open.lastIndexOf(match[2]);
                    if (at >= 0)
                        open.splice(at, 1);
                }
            }
            const names = [...open.reverse(), ...ENVIRONMENTS.map(([name]) => name)].filter((name, index, all) => all.indexOf(name) === index);
            const closing = text[context.to] === '}' ? '' : '}';
            return at(best(names.map((name, index) => ({ label: name, detail: index === 0 && open.length ? 'open' : '', insert: `${name}${closing}` })), context.prefix));
        }
        case 'cite':
            return at(best(sources.keys.map((key) => ({ label: key.key, detail: key.detail, insert: key.key })), context.prefix, 14));
        case 'ref':
            return at(best(labelsIn(sources.files).map((label) => ({ label: label.key, detail: label.detail, insert: label.key })), context.prefix, 14));
        case 'input': {
            const texs = sources.paths.filter((path) => path.endsWith('.tex')).map((path) => path.replace(/\.tex$/, ''));
            return at(best(texs.map((path) => ({ label: path, detail: 'file', insert: path })), context.prefix));
        }
        case 'graphics': {
            const images = sources.paths.filter((path) => /\.(png|jpe?g|pdf|eps|svg)$/i.test(path));
            return at(best(images.map((path) => ({ label: path, detail: 'image', insert: path })), context.prefix));
        }
        case 'bib': {
            // BibTeX's \bibliography takes the name without .bib; biblatex's \addbibresource wants it.
            const bibs = sources.paths.filter((path) => path.endsWith('.bib')).map((path) => path.replace(/\.bib$/, ''));
            return at(best(bibs.map((path) => ({ label: path, detail: 'bibliography', insert: path })), context.prefix));
        }
        case 'bibresource': {
            const bibs = sources.paths.filter((path) => path.endsWith('.bib'));
            return at(best(bibs.map((path) => ({ label: path, detail: 'bibliography', insert: path })), context.prefix));
        }
    }
}
