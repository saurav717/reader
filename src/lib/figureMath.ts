// ===========================================================================
//  Maths in a figure's words — typeset inside the SVG itself.
//
//  The prose of the Explain and Implementation pages is typeset by KaTeX, but
//  a figure is SVG, and its labels are plain <text>: whatever the model wrote
//  is drawn character for character, so `z_hat_{t+1}`, `F_theta` or
//  `||x||^2` came out as just that. KaTeX cannot draw into SVG text (it
//  needs HTML, and a figure may not carry a foreignObject), so the labels are
//  set here, with what SVG text has: Unicode for the symbols, and <tspan>s
//  for italics, subscripts and superscripts.
//
//  Two kinds of label are read:
//    - LaTeX between $…$ (or \(…\)), as the prompts now ask for: `$\hat z_{t+1}$`.
//    - What models write when they forget: `z_hat_{t+1}`, `e_phi`, `L_pred`,
//      `Delta z`, `||a - b||^2`, `->`. Only words that are plainly maths are
//      touched — a single letter or a Greek name with a subscript, a Greek
//      name beside one — so `train_step` or a sentence stays as it is.
//
//  It runs on the figure after it is sanitised, and writes only <tspan>s with
//  numeric positions and font attributes, and escaped text.
// ===========================================================================

/** A run of a label in one style: its text, and how it sits on the line. */
export interface Piece {
  text: string;
  italic?: boolean;
  bold?: boolean;
  /** 0 on the line, -1 a subscript, 1 a superscript. */
  level: -1 | 0 | 1;
}

const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ',
  varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

/** Symbols, and whether TeX spaces them as a relation (`rel`) or a binary operator (`bin`). */
const SYMBOLS: Record<string, [string, ('rel' | 'bin')?]> = {
  cdot: ['·', 'bin'], times: ['×', 'bin'], div: ['÷', 'bin'], pm: ['±', 'bin'], mp: ['∓', 'bin'], ast: ['∗', 'bin'], star: ['⋆', 'bin'],
  circ: ['∘', 'bin'], odot: ['⊙', 'bin'], oplus: ['⊕', 'bin'], otimes: ['⊗', 'bin'], cup: ['∪', 'bin'], cap: ['∩', 'bin'],
  setminus: ['∖', 'bin'], wedge: ['∧', 'bin'], vee: ['∨', 'bin'],
  leq: ['≤', 'rel'], le: ['≤', 'rel'], geq: ['≥', 'rel'], ge: ['≥', 'rel'], neq: ['≠', 'rel'], ne: ['≠', 'rel'], approx: ['≈', 'rel'],
  equiv: ['≡', 'rel'], sim: ['∼', 'rel'], simeq: ['≃', 'rel'], propto: ['∝', 'rel'], ll: ['≪', 'rel'], gg: ['≫', 'rel'],
  in: ['∈', 'rel'], notin: ['∉', 'rel'], subset: ['⊂', 'rel'], subseteq: ['⊆', 'rel'], supset: ['⊃', 'rel'], coloneqq: ['≔', 'rel'],
  to: ['→', 'rel'], rightarrow: ['→', 'rel'], leftarrow: ['←', 'rel'], gets: ['←', 'rel'], leftrightarrow: ['↔', 'rel'],
  Rightarrow: ['⇒', 'rel'], Leftarrow: ['⇐', 'rel'], Leftrightarrow: ['⇔', 'rel'], implies: ['⇒', 'rel'], iff: ['⇔', 'rel'],
  mapsto: ['↦', 'rel'], longrightarrow: ['⟶', 'rel'], mid: ['∣', 'rel'], perp: ['⊥', 'rel'],
  sum: ['∑'], prod: ['∏'], int: ['∫'], oint: ['∮'], nabla: ['∇'], partial: ['∂'], infty: ['∞'], forall: ['∀'], exists: ['∃'],
  emptyset: ['∅'], varnothing: ['∅'], neg: ['¬'], lnot: ['¬'], ell: ['ℓ'], hbar: ['ℏ'], top: ['⊤'], bot: ['⊥'], dagger: ['†'],
  prime: ['′'], cdots: ['⋯'], ldots: ['…'], dots: ['…'], vdots: ['⋮'], ddots: ['⋱'], langle: ['⟨'], rangle: ['⟩'],
  lceil: ['⌈'], rceil: ['⌉'], lfloor: ['⌊'], rfloor: ['⌋'], lVert: ['‖'], rVert: ['‖'], Vert: ['‖'], lvert: ['|'], rvert: ['|'], vert: ['|'],
  sqrt: ['√'], angle: ['∠'], triangle: ['△'], square: ['□'], checkmark: ['✓'],
};

/** Named functions TeX sets upright. */
const FUNCTIONS = new Set([
  'log', 'ln', 'exp', 'sin', 'cos', 'tan', 'tanh', 'sinh', 'cosh', 'min', 'max', 'arg', 'argmin', 'argmax', 'lim', 'sup', 'inf',
  'det', 'dim', 'ker', 'Pr', 'tr', 'Tr', 'deg', 'gcd', 'softmax', 'sign', 'diag', 'rank', 'var', 'Var', 'Cov', 'KL', 'sgn',
]);

/** Combining marks for the accents. */
const ACCENTS: Record<string, string> = {
  hat: '̂', widehat: '̂', bar: '̄', overline: '̅', tilde: '̃', widetilde: '̃', dot: '̇',
  ddot: '̈', vec: '⃗', check: '̌', breve: '̆', acute: '́', grave: '̀', underline: '̲',
};

const CAL = '𝒜ℬ𝒞𝒟ℰℱ𝒢ℋℐ𝒥𝒦ℒℳ𝒩𝒪𝒫𝒬ℛ𝒮𝒯𝒰𝒱𝒲𝒳𝒴𝒵';
const BB: Record<string, string> = { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' };

type Font = 'math' | 'rm' | 'text' | 'bf' | 'bfit' | 'it' | 'cal' | 'bb';

function styled(ch: string, font: Font): { text: string; italic?: boolean; bold?: boolean } {
  const upper = ch.charCodeAt(0) - 65;
  if (font === 'cal' && upper >= 0 && upper < 26) return { text: Array.from(CAL)[upper] };
  if (font === 'bb' && upper >= 0 && upper < 26) return { text: BB[ch] ?? String.fromCodePoint(0x1d538 + upper) };
  const letter = /[A-Za-z]/.test(ch);
  if (font === 'math' || font === 'it') return { text: ch, italic: letter };
  if (font === 'bf') return { text: ch, bold: true };
  if (font === 'bfit') return { text: ch, bold: true, italic: letter };
  return { text: ch };
}

/** A small reader of the LaTeX that labels use, into pieces. Anything it does not know is shown by name, never dropped. */
class TeX {
  out: Piece[] = [];
  constructor(private src: string) {}
  i = 0;

  /** The next argument: a {group}, a \command, or one character. */
  arg(): string {
    while (this.src[this.i] === ' ') this.i++;
    const c = this.src[this.i];
    if (c === undefined) return '';
    if (c === '{') {
      let depth = 0;
      const start = ++this.i;
      for (; this.i < this.src.length; this.i++) {
        if (this.src[this.i] === '\\') { this.i++; continue; }
        if (this.src[this.i] === '{') depth++;
        else if (this.src[this.i] === '}' && depth-- === 0) break;
      }
      return this.src.slice(start, this.i++);
    }
    if (c === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(this.src.slice(this.i));
      this.i += m ? m[0].length : 1;
      return m ? m[0] : '\\';
    }
    const ch = String.fromCodePoint(this.src.codePointAt(this.i) ?? 0);
    this.i += ch.length;
    return ch;
  }

  /** An optional [argument], as \sqrt[3]{x} has. */
  optional(): string | null {
    if (this.src[this.i] !== '[') return null;
    const end = this.src.indexOf(']', this.i);
    if (end < 0) return null;
    const value = this.src.slice(this.i + 1, end);
    this.i = end + 1;
    return value;
  }

  push(text: string, level: Piece['level'], extra: { italic?: boolean; bold?: boolean } = {}) {
    if (text) this.out.push({ text, level, ...extra });
  }

  /** An operator, with TeX's spacing round it on the line, and none in a script or where it is a sign. */
  operator(sym: string, kind: 'rel' | 'bin' | undefined, level: Piece['level']) {
    if (!kind || level !== 0) return this.push(sym, level);
    const before = this.out.map((p) => p.text).join('').trimEnd();
    const unary = kind === 'bin' && (!before || /[(\[{,=<>≤≥≈≠→←∈∼|‖⟨]$/.test(before));
    if (unary) return this.push(sym, level);
    this.push(kind === 'rel' ? ` ${sym} ` : ` ${sym} `, level);
  }

  /** Reads `src` from here to its end into pieces at `level` in `font`. */
  run(level: Piece['level'], font: Font) {
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (/\s/.test(c)) {
        this.i++;
        if (font === 'text') this.push(' ', level);
        continue;
      }
      if (c === '{') {
        this.sub(this.arg(), level, font);
        continue;
      }
      if (c === '}') { this.i++; continue; }
      if (c === '_' || c === '^') {
        this.i++;
        // A script of a script is drawn at the script's own height: SVG text has one line to work with.
        const to: Piece['level'] = level !== 0 ? level : c === '_' ? -1 : 1;
        this.sub(this.arg(), to, font === 'text' ? 'math' : font);
        continue;
      }
      if (c === '\\') {
        this.command(level, font);
        continue;
      }
      if (font === 'text') { this.push(this.arg(), level); continue; }
      const ch = String.fromCodePoint(this.src.codePointAt(this.i) ?? 0);
      this.i += ch.length;
      if (c === '-') this.operator('−', 'bin', level);
      else if (c === '+') this.operator('+', 'bin', level);
      else if (c === '*') this.operator('∗', 'bin', level);
      else if (c === '=' || c === '<' || c === '>') this.operator(c, 'rel', level);
      else if (c === ',') this.push(level === 0 ? ', ' : ',', level);
      else if (c === "'") this.push('′', level);
      else if (c === ':') this.operator(':', 'rel', level);
      else if (c === '~') this.push(' ', level);
      else {
        const s = styled(ch, font);
        this.push(s.text, level, { italic: s.italic, bold: s.bold });
      }
    }
  }

  /** Reads a group on its own, in a new style, into these pieces. */
  sub(src: string, level: Piece['level'], font: Font) {
    const inner = new TeX(src);
    inner.out = this.out;
    inner.run(level, font);
  }

  command(level: Piece['level'], font: Font) {
    const m = /^\\([A-Za-z]+|.)/.exec(this.src.slice(this.i)) ?? ['\\', ''];
    this.i += m[0].length;
    const name = m[1];
    if (GREEK[name]) return this.push(GREEK[name], level, font === 'bf' || font === 'bfit' ? { bold: true } : {});
    if (SYMBOLS[name]) return this.operator(SYMBOLS[name][0], SYMBOLS[name][1], level);
    if (FUNCTIONS.has(name)) {
      this.push(name, level);
      // A function name is followed by a thin space, unless brackets or a script follow.
      if (level === 0 && !/^\s*[(\[{_^]/.test(this.src.slice(this.i))) this.push(' ', level);
      return;
    }
    if (ACCENTS[name]) {
      const start = this.out.length;
      this.sub(this.arg(), level, font);
      const added = this.out.slice(start);
      if (name === 'overline' || name === 'underline') {
        for (const p of added) p.text = Array.from(p.text).map((ch) => ch + ACCENTS[name]).join('');
      } else {
        // The mark goes on the last letter: `\hat{x}` is x̂, and a wider argument is marked at its end.
        const last = [...added].reverse().find((p) => p.text.trim());
        if (last) last.text += ACCENTS[name];
      }
      return;
    }
    switch (name) {
      case 'mathrm': case 'operatorname': case 'mathsf': case 'mathtt': case 'textrm': case 'textsf': case 'texttt':
        return this.sub(this.arg(), level, 'rm');
      case 'text': case 'mbox': case 'textnormal':
        return this.sub(this.arg(), level, 'text');
      case 'mathbf': case 'textbf':
        return this.sub(this.arg(), level, 'bf');
      case 'boldsymbol': case 'bm':
        return this.sub(this.arg(), level, 'bfit');
      case 'mathit': case 'textit': case 'emph':
        return this.sub(this.arg(), level, 'it');
      case 'mathcal': case 'mathscr':
        return this.sub(this.arg(), level, 'cal');
      case 'mathbb':
        return this.sub(this.arg(), level, 'bb');
      case 'frac': case 'dfrac': case 'tfrac': {
        const top = this.arg(), bottom = this.arg();
        const wrap = (s: string) => (/[\s+\-=,]|\\[a-z]+\s|\\frac/.test(s.trim()) || s.trim().length > 1 && /[+\-]/.test(s) ? `(${s})` : s);
        this.sub(wrap(top), level, font);
        this.push('/', level);
        this.sub(wrap(bottom), level, font);
        return;
      }
      case 'sqrt': {
        const index = this.optional();
        if (index) this.sub(index, 1, font);
        const body = this.arg();
        this.push('√', level);
        this.sub(Array.from(body.trim()).length > 1 && !/^\\[A-Za-z]+$/.test(body.trim()) ? `(${body})` : body, level, font);
        return;
      }
      case 'left': case 'right': case 'big': case 'Big': case 'bigg': case 'Bigg': case 'bigl': case 'bigr': case 'Bigl': case 'Bigr': {
        if (this.src[this.i] === '.') this.i++;
        return;
      }
      case 'limits': case 'nolimits': case 'displaystyle': case 'textstyle': case 'scriptstyle': case '!':
        return;
      case ',': case ':': case ';': case '>':
        return this.push(' ', level);
      case ' ':
        return this.push(' ', level);
      case 'quad':
        return this.push(' ', level);
      case 'qquad':
        return this.push('  ', level);
      case '{': case '}': case '_': case '%': case '$': case '#': case '&':
        return this.push(name, level);
      case '|':
        return this.push('‖', level);
      case '\\':
        return this.push(' ', level);
      default:
        // Not known here: shown by its name, upright, rather than lost.
        return this.push(name, level);
    }
  }
}

/** Merges neighbouring pieces in the same style. */
function merge(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last && last.level === p.level && !!last.italic === !!p.italic && !!last.bold === !!p.bold) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

/** LaTeX, as pieces. */
export function texPieces(tex: string): Piece[] {
  const reader = new TeX(tex);
  reader.run(0, 'math');
  return merge(reader.out).map((p) => ({ ...p, text: p.text.replace(/ {2,}/g, ' ') }));
}

// ---------------------------------------------------------------------------
// Labels written without LaTeX: `z_hat_{t+1}`, `e_phi`, `||a - b||^2`
// ---------------------------------------------------------------------------

const GREEK_NAMES = Object.keys(GREEK).filter((k) => !k.startsWith('var')).join('|');
const MODIFIER = /^(hat|bar|tilde|dot|ddot|vec|star|prime)$/;

/** A word with subscripts or superscripts on it: `z_t`, `z_hat_{t+1}`, `L_pred`, `x^2`. */
const SCRIPTED = /(?<![A-Za-z0-9\\])([A-Za-z]+)((?:[_^](?:\{[^{}]*\}|[A-Za-z0-9]+|\*|'))+)('*)/g;
/** The pieces of a label that are maths when it is written as plain text. */
const PLAIN_MATH = new RegExp(
  [
    SCRIPTED.source,
    `(?<![A-Za-z\\\\])(${GREEK_NAMES})(?![A-Za-z])`, // a Greek letter by name
    '(\\|\\|)', // a norm's bars
    '(?<=[)\\]}‖|])(\\^(?:\\{[^{}]*\\}|[A-Za-z0-9]+))', // a power on a bracket: )^2, ||^2
    '(\\\\[A-Za-z]+)', // a TeX command written without dollars
  ].join('|'),
  'g',
);

/** Whether a word with scripts is maths: a letter, a Greek name or a letter with a mark, not `train_step` or `file_name`. */
function isMathBase(base: string, scripts: string): boolean {
  if (base.length === 1) return true;
  if (GREEK[base] && !base.startsWith('var')) return true;
  if (/^[A-Za-z](hat|bar|tilde|dot|vec)$/.test(base)) return true;
  // A short name with a single short script is notation too: `sg_t`, `KL_q`; a long one is a variable name.
  return base.length <= 3 && /^[_^](\{[^{}]{1,6}\}|[A-Za-z0-9]{1,2})$/.test(scripts) && !/^[a-z]+_[a-z]{2}$/.test(base + scripts);
}

/** The inside of a script, as TeX: Greek names become letters, longer words stay upright. */
function scriptTeX(body: string): string {
  if (body.startsWith('{')) body = body.slice(1, -1);
  if (body === '*') return '*';
  if (GREEK[body]) return `\\${body}`;
  if (/^[A-Za-z]{2,}$/.test(body)) return `\\mathrm{${body}}`;
  // Inside braces: Greek names to letters, words of two or more letters upright.
  return body.replace(/(?<!\\)[A-Za-z]{2,}/g, (w) => (GREEK[w] ? `\\${w} ` : `\\mathrm{${w}}`));
}

/** `z_hat_{t+1}` as TeX: `\hat{z}_{t+1}`. */
function scriptedTeX(base: string, scripts: string, primes: string): string {
  let core = GREEK[base] ? `\\${base}` : base.length === 1 ? base : `\\mathrm{${base}}`;
  const mark = /^([A-Za-z])(hat|bar|tilde|dot|vec)$/.exec(base);
  if (mark) core = `\\${mark[2]}{${mark[1]}}`;
  const subs: string[] = [], sups: string[] = [];
  for (const m of scripts.matchAll(/([_^])(\{[^{}]*\}|[A-Za-z0-9]+|\*|')/g)) {
    const [, kind, body] = m;
    if (kind === '_' && MODIFIER.test(body)) {
      if (body === 'star') sups.push('*');
      else if (body === 'prime') primes += "'";
      else core = `\\${body}{${core}}`;
      continue;
    }
    (kind === '_' ? subs : sups).push(scriptTeX(body));
  }
  return `${core}${primes}${subs.length ? `_{${subs.join(',')}}` : ''}${sups.length ? `^{${sups.join('')}}` : ''}`;
}

/** Arrows and comparisons typed as ASCII. */
function plainSymbols(text: string): string {
  return text
    .replace(/<->|<=>/g, '↔')
    .replace(/-->|->/g, '→')
    .replace(/<--|<-(?!\d)/g, '←')
    .replace(/=>/g, '⇒')
    .replace(/<=/g, '≤')
    .replace(/>=/g, '≥')
    .replace(/!=/g, '≠')
    .replace(/~=/g, '≈')
    .replace(/\+-|\+\/-/g, '±');
}

/** A label written as plain text, with whatever in it is maths set as maths. */
function plainPieces(text: string): Piece[] {
  // Greek names on their own are only read as letters when something else in the label is plainly maths.
  const mathy = [...text.matchAll(new RegExp(SCRIPTED.source, 'g'))].some((m) => isMathBase(m[1], m[2])) || /\|\||\\[A-Za-z]|[)\]]\^/.test(text);
  const out: Piece[] = [];
  let at = 0;
  let greekBefore = false;
  const plain = (s: string) => {
    if (!s) return;
    // A minus between spaces, in a label with maths in it, is a minus sign.
    out.push({ text: plainSymbols(mathy ? s.replace(/ - /g, ' − ') : s), level: 0 });
  };
  for (const m of text.matchAll(PLAIN_MATH)) {
    const [whole, base, scripts, primes, greek, bars, power, command] = m;
    let tex: string | null = null;
    if (base && isMathBase(base, scripts)) tex = scriptedTeX(base, scripts, primes ?? '');
    else if (greek && mathy) tex = `\\${greek}`;
    else if (bars) tex = '\\|';
    else if (power) tex = `{}${power.replace(/\^([A-Za-z]{2,})$/, '^{\\mathrm{$1}}')}`;
    else if (command && /^\\[A-Za-z]+$/.test(command) && (GREEK[command.slice(1)] || SYMBOLS[command.slice(1)])) tex = command;
    if (tex === null) continue;
    const between = text.slice(at, m.index);
    // `Delta z` is Δz, as `\Delta z` would be: a Greek name and the symbol it qualifies, with no gap.
    if (!(between === ' ' && greekBefore && base)) plain(between);
    greekBefore = !!greek;
    out.push(...texPieces(tex));
    at = (m.index ?? 0) + whole.length;
  }
  plain(text.slice(at));
  return merge(out);
}

/** A label as pieces: its $…$ as LaTeX, and the rest read for maths written plainly. */
export function labelPieces(text: string): Piece[] {
  const out: Piece[] = [];
  const re = /\$\$([^$]+)\$\$|\$([^$]+)\$|\\\((.+?)\\\)/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    out.push(...plainPieces(text.slice(at, m.index)));
    out.push(...texPieces(m[1] ?? m[2] ?? m[3]));
    at = (m.index ?? 0) + m[0].length;
  }
  out.push(...plainPieces(text.slice(at)));
  return merge(out);
}

// ---------------------------------------------------------------------------
// Into the SVG
// ---------------------------------------------------------------------------

/** How far a script sits from the line, in the label's own font size: down is positive, as in SVG. */
const SHIFT = { [-1]: 0.22, 0: 0, 1: -0.38 } as const;
/** A script's size, against the label's. */
const SCRIPT = 0.7;

const em = (n: number) => `${Math.round(n * 1000) / 1000}em`;
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Pieces as SVG: plain text where nothing moves, <tspan>s where something is set off the line or in another face. */
export function piecesToSvg(pieces: Piece[]): string {
  if (pieces.every((p) => p.level === 0 && !p.italic && !p.bold)) return escape(pieces.map((p) => p.text).join(''));
  let offset = 0; // where the baseline is now, in the label's em
  let out = '';
  for (const p of pieces) {
    const target = SHIFT[p.level];
    const scale = p.level === 0 ? 1 : SCRIPT;
    const attrs: string[] = [];
    if (target !== offset) attrs.push(`dy="${em((target - offset) / scale)}"`);
    if (scale !== 1) attrs.push(`font-size="${em(scale)}"`);
    if (p.italic) attrs.push('font-style="italic"');
    if (p.bold) attrs.push('font-weight="bold"');
    out += attrs.length ? `<tspan ${attrs.join(' ')}>${escape(p.text)}</tspan>` : escape(p.text);
    offset = target;
  }
  // Back onto the line, so what follows in the same <text> — another line of it, say — is not set off too.
  if (offset !== 0) out += `<tspan dy="${em(-offset)}">​</tspan>`;
  return out;
}

/**
 * A figure's SVG, with the maths in its <text> set as maths. The SVG is the
 * sanitiser's output: well formed, every element closed. Only the text inside
 * <text> and <tspan> is changed; titles, descriptions and everything else is
 * passed through as it is.
 */
export function typesetFigureMath(svg: string): string {
  const stack: string[] = [];
  let out = '';
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?([A-Za-z][\w:-]*)(?:[^>"']|"[^"]*"|'[^']*')*>/g;
  let at = 0;
  const text = (chunk: string) => {
    const inside = stack[stack.length - 1];
    if ((inside === 'text' || inside === 'tspan' || inside === 'textpath') && chunk.trim()) {
      const plain = decode(chunk);
      out += piecesToSvg(labelPieces(plain));
    } else out += chunk;
  };
  for (const m of svg.matchAll(tag)) {
    text(svg.slice(at, m.index));
    const [whole, name] = m;
    out += whole;
    at = (m.index ?? 0) + whole.length;
    if (!name) continue;
    const lower = name.toLowerCase();
    if (whole.startsWith('</')) {
      const open = stack.lastIndexOf(lower);
      if (open >= 0) stack.length = open;
    } else if (!whole.endsWith('/>')) stack.push(lower);
  }
  text(svg.slice(at));
  return out;
}
