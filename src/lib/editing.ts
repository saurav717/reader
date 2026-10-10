// What the playground's code editor does to text, as VS Code does it, kept
// apart from the page so it can be tested: a line comment toggled, lines
// moved, copied and deleted, the indent carried on a new line, brackets
// closed, matches found, a file's symbols for the outline, and the fuzzy
// match Quick Open and the command palette filter with.
//
// Each edit takes the text and the selection, and says which span of the text
// to replace with what, and where the selection goes after: the editor then
// types that span in, so the browser's own undo keeps it.

export interface Selection {
  start: number;
  end: number;
}

/** One edit: the span [from, to) of the text becomes `insert`; then the selection is `select`. */
export interface Edit {
  from: number;
  to: number;
  insert: string;
  select: Selection;
}

/** The line comment a file's language writes, by its path. */
export function commentFor(path: string): string {
  if (/\.(py|sh|bash|zsh|r|rb|pl|ya?ml|toml|cfg|conf|ini|jl|mk|dockerfile|txt)$/i.test(path) || /(^|\/)(Makefile|Dockerfile|requirements[^/]*)$/i.test(path)) return '#';
  if (/\.(sql|lua|hs)$/i.test(path)) return '--';
  if (/\.(tex|m)$/i.test(path)) return '%';
  return '//';
}

/** The whole lines a selection touches: from the start of its first to the end of its last (a selection ending at a line's start leaves that line out). */
export function lineSpan(text: string, sel: Selection): { from: number; to: number } {
  const from = text.lastIndexOf('\n', sel.start - 1) + 1;
  const endAt = sel.end > sel.start && text[sel.end - 1] === '\n' ? sel.end - 1 : sel.end;
  const next = text.indexOf('\n', endAt);
  return { from, to: next === -1 ? text.length : next };
}

/** ⌘/ — the lines commented, or uncommented when every one with text already is. */
export function toggleComment(text: string, sel: Selection, mark: string): Edit {
  const { from, to } = lineSpan(text, sel);
  const lines = text.slice(from, to).split('\n');
  const filled = lines.filter((line) => line.trim());
  const commented = filled.length > 0 && filled.every((line) => line.trimStart().startsWith(mark));
  const indent = Math.min(...filled.map((line) => line.length - line.trimStart().length), Infinity);
  const at = Number.isFinite(indent) ? indent : 0;
  let shift = 0;
  let firstShift = 0;
  const out = lines.map((line, index) => {
    if (!line.trim()) return line;
    let next: string;
    if (commented) {
      const lead = line.length - line.trimStart().length;
      const rest = line.slice(lead + mark.length);
      const cut = mark.length + (rest.startsWith(' ') ? 1 : 0);
      next = line.slice(0, lead) + line.slice(lead + cut);
    } else next = `${line.slice(0, at)}${mark} ${line.slice(at)}`;
    if (index === 0) firstShift = next.length - line.length;
    shift += next.length - line.length;
    return next;
  });
  const insert = out.join('\n');
  return { from, to, insert, select: { start: Math.max(from, sel.start + firstShift), end: Math.max(from, sel.end + shift) } };
}

/** ⌥↑ / ⌥↓ — the selected lines moved past the line above or below; null at the top or the bottom. */
export function moveLines(text: string, sel: Selection, down: boolean): Edit | null {
  const { from, to } = lineSpan(text, sel);
  const block = text.slice(from, to);
  if (down) {
    if (to >= text.length) return null;
    const nextEnd = text.indexOf('\n', to + 1);
    const end = nextEnd === -1 ? text.length : nextEnd;
    const below = text.slice(to + 1, end);
    const shift = below.length + 1;
    return { from, to: end, insert: `${below}\n${block}`, select: { start: sel.start + shift, end: sel.end + shift } };
  }
  if (from === 0) return null;
  const prevStart = text.lastIndexOf('\n', from - 2) + 1;
  const above = text.slice(prevStart, from - 1);
  const shift = above.length + 1;
  return { from: prevStart, to, insert: `${block}\n${above}`, select: { start: sel.start - shift, end: sel.end - shift } };
}

/** ⇧⌥↓ / ⇧⌥↑ — the selected lines copied below (or above, the selection staying on the upper copy). */
export function copyLines(text: string, sel: Selection, down: boolean): Edit {
  const { from, to } = lineSpan(text, sel);
  const block = text.slice(from, to);
  const shift = down ? block.length + 1 : 0;
  return { from: to, to, insert: `\n${block}`, select: { start: sel.start + shift, end: sel.end + shift } };
}

/** ⇧⌘K — the selected lines deleted. */
export function deleteLines(text: string, sel: Selection): Edit {
  const { from, to } = lineSpan(text, sel);
  const end = to < text.length ? to + 1 : to;
  const start = to >= text.length && from > 0 ? from - 1 : from;
  return { from: start, to: end, insert: '', select: { start, end: start } };
}

const OPENS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };

/** ↵ — a new line with the indent of this one, one level more after an opening `:`, `{`, `(` or `[`; between a pair, the closer on a line of its own. */
export function newLine(text: string, sel: Selection, unit = '    '): Edit {
  const lineStart = text.lastIndexOf('\n', sel.start - 1) + 1;
  const before = text.slice(lineStart, sel.start);
  const indent = /^[ \t]*/.exec(before)?.[0] ?? '';
  const opens = /[:{([]\s*$/.test(before.replace(/\s*#.*$/, ''));
  const after = text[sel.end];
  const opener = before.trimEnd().slice(-1);
  const pair = opens && after !== undefined && opener in OPENS && OPENS[opener] === after;
  if (pair) {
    const insert = `\n${indent}${unit}\n${indent}`;
    const caret = sel.start + 1 + indent.length + unit.length;
    return { from: sel.start, to: sel.end, insert, select: { start: caret, end: caret } };
  }
  const insert = `\n${indent}${opens ? unit : ''}`;
  return { from: sel.start, to: sel.end, insert, select: { start: sel.start + insert.length, end: sel.start + insert.length } };
}

/** A bracket or quote typed: closed at once, or the selection wrapped; a closer typed before the same closer steps over it. Null when the key is typed as it is. */
export function typeBracket(text: string, sel: Selection, key: string): Edit | null {
  const closers = new Set(Object.values(OPENS));
  if (sel.start === sel.end && closers.has(key) && text[sel.start] === key && !(key in OPENS && key !== OPENS[key])) {
    return { from: sel.start, to: sel.start, insert: '', select: { start: sel.start + 1, end: sel.start + 1 } };
  }
  const close = OPENS[key];
  if (!close) return null;
  if (sel.start !== sel.end) {
    const inner = text.slice(sel.start, sel.end);
    return { from: sel.start, to: sel.end, insert: `${key}${inner}${close}`, select: { start: sel.start + 1, end: sel.end + 1 } };
  }
  // A quote after a letter is an apostrophe; before a letter, a bracket is typed alone.
  const prev = text[sel.start - 1] ?? '';
  const next = text[sel.start] ?? '';
  if (key === close && /[\w\\]/.test(prev)) return null;
  if (next && /\w/.test(next)) return null;
  return { from: sel.start, to: sel.start, insert: `${key}${close}`, select: { start: sel.start + 1, end: sel.start + 1 } };
}

/** ⌫ between a pair just opened — both go. */
export function deletePair(text: string, sel: Selection): Edit | null {
  if (sel.start !== sel.end || sel.start === 0) return null;
  const open = text[sel.start - 1];
  if (OPENS[open] && OPENS[open] === text[sel.start]) return { from: sel.start - 1, to: sel.start + 1, insert: '', select: { start: sel.start - 1, end: sel.start - 1 } };
  return null;
}

/** Line and column of an offset, from 1, as the status bar says them. */
export function lineCol(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, col: offset - (before.lastIndexOf('\n') + 1) + 1 };
}

/** The offset where a line (from 1) starts, kept within the text. */
export function offsetOfLine(text: string, line: number): number {
  let at = 0;
  for (let n = 1; n < line; n++) {
    const next = text.indexOf('\n', at);
    if (next === -1) return at;
    at = next + 1;
  }
  return at;
}

// ------------------------------------------------------------- find --

export interface FindOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

/** Every match of a query, as spans; a regular expression that doesn't parse finds nothing (and says so). */
export function findAll(text: string, query: string, options: FindOptions = {}): { matches: Selection[]; error?: string } {
  if (!query) return { matches: [] };
  let pattern: RegExp;
  try {
    const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(options.wholeWord ? `\\b(?:${source})\\b` : source, options.caseSensitive ? 'g' : 'gi');
  } catch (error) {
    return { matches: [], error: error instanceof Error ? error.message : String(error) };
  }
  const matches: Selection[] = [];
  for (const match of text.matchAll(pattern)) {
    if (!match[0].length) continue;
    matches.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
    if (matches.length >= 5000) break;
  }
  return { matches };
}

/** Replace every match at once, `$1` and the like working in regex mode. */
export function replaceAll(text: string, query: string, replacement: string, options: FindOptions = {}): { text: string; count: number } {
  const { matches, error } = findAll(text, query, options);
  if (error || !matches.length) return { text, count: 0 };
  const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(options.wholeWord ? `\\b(?:${source})\\b` : source, options.caseSensitive ? 'g' : 'gi');
  const next = options.regex ? text.replace(pattern, replacement) : text.replace(pattern, () => replacement);
  return { text: next, count: matches.length };
}

// ---------------------------------------------------------- symbols --

export interface CodeSymbol {
  name: string;
  kind: 'class' | 'function' | 'method' | 'heading' | 'variable';
  line: number;
  depth: number;
}

/** A file's symbols for the outline and the breadcrumbs: classes and functions, and a Markdown file's headings. */
export function symbolsOf(text: string, path: string): CodeSymbol[] {
  const lines = text.split('\n');
  const out: CodeSymbol[] = [];
  const markdown = /\.(md|markdown)$/i.test(path);
  const python = /\.(py|pyi)$/i.test(path);
  const js = /\.(m?[jt]sx?|cjs)$/i.test(path);
  lines.forEach((line, index) => {
    const n = index + 1;
    if (markdown) {
      const head = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (head) out.push({ name: head[2], kind: 'heading', line: n, depth: head[1].length - 1 });
      return;
    }
    const indent = line.length - line.trimStart().length;
    if (python) {
      const m = /^\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(line);
      if (m) out.push({ name: m[2], kind: m[1] === 'class' ? 'class' : indent ? 'method' : 'function', line: n, depth: Math.floor(indent / 4) });
      return;
    }
    if (js) {
      const m = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:(class)\s+([A-Za-z_$][\w$]*)|function\*?\s+([A-Za-z_$][\w$]*)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/.exec(line);
      if (m) out.push({ name: m[2] ?? m[3] ?? m[4], kind: m[1] ? 'class' : 'function', line: n, depth: Math.floor(indent / 2) });
      return;
    }
    const m = /^\s*(?:pub\s+)?(?:fn|func|function|def|sub)\s+([A-Za-z_]\w*)/.exec(line) ?? /^(?:[\w:<>*&\s]+?)\s+\**([A-Za-z_]\w*)\s*\([^;]*$/.exec(line);
    if (m && !/^\s*(if|for|while|switch|return|else)\b/.test(line)) out.push({ name: m[1], kind: 'function', line: n, depth: 0 });
  });
  return out;
}

/** The symbols a line is inside, outermost first, for the breadcrumbs. */
export function symbolPath(symbols: CodeSymbol[], line: number): CodeSymbol[] {
  const path: CodeSymbol[] = [];
  for (const symbol of symbols) {
    if (symbol.line > line) break;
    while (path.length && path[path.length - 1].depth >= symbol.depth) path.pop();
    path.push(symbol);
  }
  return path;
}

// ------------------------------------------------------------- fuzzy --

/** How well a query matches a name, as Quick Open ranks it: every letter in order; a run, a word's start and the file's own name count more. Null when it doesn't match. */
export function fuzzyScore(query: string, target: string): { score: number; hits: number[] } | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return { score: 0, hits: [] };
  const t = target.toLowerCase();
  const base = target.lastIndexOf('/') + 1;
  const hits: number[] = [];
  let score = 0;
  let at = 0;
  let prev = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, at);
    if (found === -1) return null;
    hits.push(found);
    score += 1;
    if (found === prev + 1) score += 3;
    if (found === 0 || /[\s/_.\-]/.test(t[found - 1]) || (target[found] !== t[found] && target[found - 1] === t[found - 1])) score += 4;
    if (found >= base) score += 2;
    prev = found;
    at = found + 1;
  }
  return { score: score - target.length * 0.01, hits };
}
