/**
 * Reflowing a PDF: from the glyph runs and drawings pdf.js finds on each page
 * to a document — headings, paragraphs, figures with their captions, tables,
 * display equations, footnotes — laid out as HTML the reader can highlight.
 *
 * A PDF has no paragraphs. It has glyphs at coordinates, and everything above
 * that is inferred: runs on one baseline are a line; lines in one column are
 * read top to bottom before the next column; lines a line-height apart are
 * one paragraph; a line larger or bolder than the body is a heading; a line
 * that says "Figure 3." is a caption, and the drawings above it are the
 * figure. This module is that inference, with no pdf.js in it — it takes
 * plain numbers and strings so it can be tested on synthetic pages — and
 * `pdfReflow.ts` is the part that talks to pdf.js and paints the crops.
 *
 * Coordinates throughout are in points, with the origin at the top-left of
 * the page and y growing downwards, as on screen.
 */

import { ORDER_MEANS_NOTHING } from './byline';

// ---------------------------------------------------------------- inputs ---

/** One run of glyphs in one font, as pdf.js reports it. */
export interface TextRun {
  str: string;
  /** Left edge of the run, and its baseline. */
  x: number;
  y: number;
  width: number;
  /** Font size in points. */
  size: number;
  /** The font's own name where known — "NimbusRomNo9L-Medi", "CMMI10". */
  font: string;
  /** Where the run links to, when it sits inside one of the page's links. */
  href?: string;
}

/** A link on the page — a URL or an email address — and the box it answers clicks in. */
export interface PageLink {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  url: string;
}

/** The axis-aligned box of one drawing on the page: an image or a path. */
export interface GraphicBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  kind: 'image' | 'path';
}

export interface PageInput {
  /** Zero-based. */
  index: number;
  width: number;
  height: number;
  runs: TextRun[];
  graphics: GraphicBox[];
  links?: PageLink[];
  /** Text set sideways, by its box: a table's labels for groups of rows, the arXiv stamp. */
  sideways?: SidewaysRun[];
  /** How far the page was turned, clockwise, to be read: a table set sideways on it. */
  turned?: 90 | 270;
}

/** A run of text set sideways, and the box it fills on the page. */
export interface SidewaysRun {
  str: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  size: number;
}

// --------------------------------------------------------------- outputs ---

/** A region of a page to be painted and shown as an image. */
export interface Crop {
  id: number;
  page: number;
  /** The page turned so, clockwise, as it was read: the box is on the page turned. */
  turned?: 90 | 270;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  mono?: boolean;
  sup?: boolean;
  sub?: boolean;
  href?: string;
}

export interface TableCell {
  spans: Span[];
  colspan?: number;
  /** Rows a label covers: "Complex", over its Success and Abnormal motion rows. */
  rowspan?: number;
  /** A heading cell: the table's header row, or the title of one of its panels. */
  head?: boolean;
  /** The title of one of the table's panels — "A. Component contributions" — which starts it. */
  panel?: boolean;
}

export type Block =
  | { kind: 'heading'; level: 2 | 3 | 4; spans: Span[]; page: number }
  | { kind: 'paragraph'; spans: Span[]; page: number; list?: 'bullet' | 'number'; /** A listing — code, a prompt — its lines kept as they are set. */ code?: boolean }
  | { kind: 'figure'; crop: Crop; caption: Span[]; label: string; page: number }
  | { kind: 'table'; crop: Crop; caption: Span[]; label: string; rows: TableCell[][] | null; notes?: Span[]; page: number }
  | { kind: 'equation'; crop: Crop; label: string; page: number }
  | { kind: 'footnote'; spans: Span[]; page: number };

export interface Layout {
  blocks: Block[];
  crops: Crop[];
  /** Characters of running text found, for telling a scanned PDF from a real one. */
  characters: number;
  /**
   * Whether the text reads as text: mostly letters, in words of a sane
   * length. A PDF whose fonts carry no mapping to Unicode comes out as
   * "!"# $!"#", and one that lost its spaces as one word a line long.
   */
  readable: boolean;
  /** The font size most of the text is set in. */
  bodySize: number;
  /** The authors named on the first page, in order, where they could be read. */
  authors?: string[];
  /**
   * What the first page says about its authors besides their names — the
   * affiliations, "∗Equal contribution", the corresponding author's address
   * — one entry a line, with the byline itself where its marks point there.
   */
  front?: Span[][];
  /**
   * The byline read whole: each author's marks, what each mark stands for,
   * and the institutions named — where the authors were when they wrote it.
   */
  byline?: PaperByline;
}

export interface BylineAuthor {
  name: string;
  /** The marks set on the name, as printed: "∗", "†", "1". */
  marks: string[];
  /** The institutions the marks point at, or the one the whole byline shares. */
  affiliations: string[];
  /** What the name's other marks say: "Equal contribution", "Corresponding authors". */
  notes: string[];
  /**
   * What the paper says they did, in its own sentences, where a note on
   * the byline — a contributions statement — names them: "Ashish, with
   * Illia, designed and implemented the first Transformer models…".
   */
  contributions?: string[];
  /**
   * Their addresses as the paper prints them — the only place a whole one
   * is to be had: Google Scholar shows no more than the domain it verified.
   */
  emails: string[];
}

export interface PaperByline {
  authors: BylineAuthor[];
  /**
   * Each mark and what it stands for, in the order the page gives them —
   * what it says of them all; the sentences of it that name one of them are
   * `contributions`, and theirs.
   */
  notes: { mark: string; text: string; contributions?: string[] }[];
  affiliations: { mark?: string; text: string }[];
  /** Every address the first page gives, whether or not it could be put to a name. */
  emails: string[];
  /**
   * What the paper says of who did what, in its own words — a footnote to
   * the byline, an "Author Contributions" section — for a reader to put to
   * each author where the names in it are initials or roles.
   */
  statement?: string;
}

// ------------------------------------------------------------------ fonts --

// Linux Libertine and Biolinum, which ACM's acmart sets, name their faces
// by letters after an "O": LinLibertineOB is bold, OI italic, OBI both,
// OZ semibold, OC small capitals.
const BOLD = /bold|black|heavy|semibold|demibold|extrab|ultrab|-medi|medium(?!ital)|cmbx|cmb\d|ptmb|ntxb|txb|sfbx|sfsx|cmssbx|lmssbx|,bold|-bd\b|\bbd\b|\.b$|-b$|lin(?:libertine|biolinum)o[bz]/i;
const ITALIC = /italic|oblique|ital\b|-it\b|cmti|cmmi|cmsl|slanted|,italic|\.i$|-i$|\bit$|lin(?:libertine|biolinum)o[bz]?i\b/i;
// Typewriter faces by the names TeX and word processors embed them under:
// newtx's and txfonts' txtt, cm-super's SFTT, the EC fonts' ectt, TeX Gyre
// Cursor, Courier's own pcr files, and the usual system faces.
const MONO = /mono|cmtt|courier|typewriter|consolas|menlo|inconsolata|nimbusmon|luximono|lmtt|beramono|dejavusansmono|sourcecodepro|firamono|t1?xtt|sftt|ectt|tgcursor|texgyrecursor|\bpcr[rbo]\d|lucidaconsole|monaco|cousine/i;
/** Fonts that only ever set mathematics. */
const MATH = /xcharter-?math|newtxmath|newpxmath|zmath|cmmi|cmsy|cmex|cmmib|cmbsy|msam|msbm|rsfs|eufm|eufb|eurm|eusm|txsy|txmi|txex|pxsy|pxmi|pxex|stixmath|cambriamath|mathematica|symbol\b|standardsym|esint|wasy|stmary|mtsy|mtmi|mtex|lmmi|lmsy|lmex|xits-?math|latinmodernmath/i;

/** The face a run is set in, from its font's name. Subset prefixes ("ABCDEF+") are ignored. */
export function faceOf(font: string): { bold: boolean; italic: boolean; mono: boolean; math: boolean } {
  const name = font.replace(/^[A-Z]{6}\+/, '');
  return { bold: BOLD.test(name), italic: ITALIC.test(name), mono: MONO.test(name), math: MATH.test(name) };
}

// ------------------------------------------------------------------ lines --

interface Run extends TextRun {
  /** Part of a fraction set in the line, in smaller type: it counts at the line's size. */
  fraction?: boolean;
  /** Set after a space of its own — a run pdf.js reports as a blank — which the gap alone may not show. */
  spaced?: boolean;
  bold: boolean;
  italic: boolean;
  mono: boolean;
  math: boolean;
}

interface Line {
  page: number;
  runs: Run[];
  x0: number;
  x1: number;
  /** The baseline, and the size, of the run that carries most of the line. */
  baseline: number;
  size: number;
  top: number;
  bottom: number;
  text: string;
  /** Whether every run is bold, every run italic. */
  allBold: boolean;
  allItalic: boolean;
  /** Share of the glyphs that come from a mathematics font, and from a monospaced one. */
  mathShare: number;
  monoShare: number;
  /** Set once the line is placed in a figure, table or equation region. */
  taken?: boolean;
  /** A caption's label — "Figure", "Table" — when the line starts one. */
  caption?: { kind: 'figure' | 'table'; label: string };
  /** The caption's first line, on the lines that carry it on. */
  captionOf?: Line;
  /** A heading set in the text's own type, on a line of its own with space over it: "Early fusion". */
  subheading?: boolean;
}

const norm = (text: string): string => text.replace(/\s+/g, ' ').trim();
const LONE_BULLET = /^\s*[•◦▪■●○◆◇►▸‣⁃]\s*$/;

const ACCENTS: Record<string, string> = {
  '´': '\u0301', '`': '\u0300', 'ˆ': '\u0302', '¨': '\u0308', '˜': '\u0303', '¯': '\u0304',
  '˘': '\u0306', '˙': '\u0307', '˚': '\u030a', '¸': '\u0327', '˝': '\u030b', 'ˇ': '\u030c', '^': '\u0302', '~': '\u0303',
};

/**
 * Accents as TeX sets them — the mark before the letter, "na¨ıve" — put
 * back on their letters.
 */
export function composeAccents(text: string): string {
  if (!/[´`ˆ¨˜¯˘˙˚¸˝ˇ]/.test(text)) return text;
  return text
    .replace(/([´`ˆ¨˜¯˘˙˚¸˝ˇ])(ı|[A-Za-z])/g, (_, mark: string, letter: string) => (letter === 'ı' ? 'i' : letter) + ACCENTS[mark])
    .normalize('NFC');
}

/**
 * Punctuation that closes what is before it: pdf.js reports a blank after a
 * script's shift of the pen as well as a space — "d_k ." — and no space
 * comes before these.
 */
const CLOSING = /^[.,;:!?)\]}’”%]/;

/** Runs on one baseline, left to right, with the spaces between them restored. */
function joinRuns(runs: Run[], size: number): string {
  let text = '';
  let end = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    const piece = run.str;
    if (!piece) continue;
    if (text && (run.x - end > 0.08 * size || (run.spaced && !CLOSING.test(piece))) && !text.endsWith(' ') && !piece.startsWith(' ')) text += ' ';
    text += piece;
    end = run.x + run.width;
  }
  return norm(text);
}

/**
 * Runs cut where a link on the page starts and ends, the piece inside it
 * carrying the link. pdf.js reports a run per font, so "code is at
 * https://…/." is one run with the address in the middle of it: the link
 * is the words that sit inside its box, since a link is a whole address or
 * a whole word, and a full stop after it is the sentence's.
 */
export function linkRuns(runs: TextRun[], links: PageLink[]): TextRun[] {
  if (!links.length) return runs;
  const out: TextRun[] = [];
  // A run can hold two addresses; what follows the first is looked at again.
  const queue = runs.map((run) => ({ run, tried: new Set<PageLink>() }));
  while (queue.length) {
    const { run, tried } = queue.shift()!;
    const height = run.size;
    const link = links.find((box) => {
      if (tried.has(box)) return false;
      const inside = Math.min(box.x1, run.x + run.width) - Math.max(box.x0, run.x);
      return inside > Math.min(run.width, box.x1 - box.x0) * 0.5 - 0.5 && run.y - 0.3 * height > box.y0 - 1 && run.y - 0.3 * height < box.y1 + 1;
    });
    if (!link || !run.str.trim()) {
      out.push(run);
      continue;
    }
    const length = run.str.length;
    const per = run.width / Math.max(1, length);
    // The words whose middles are inside the link's box: the widths of the
    // letters are not known, only the run's, so a cut placed by counting
    // characters can land a letter or two off; a word's middle will not.
    let start = -1;
    let end = -1;
    for (const word of run.str.matchAll(/\S+/g)) {
      const middle = run.x + (word.index! + word[0].length / 2) * per;
      if (middle < link.x0 - per || middle > link.x1 + per) continue;
      if (start < 0) start = word.index!;
      end = word.index! + word[0].length;
    }
    if (start < 0) {
      out.push(run);
      continue;
    }
    // Punctuation after the address is the sentence's — unless it is the
    // address's own: "https://example." broken before "org/" keeps its stop.
    const inAddress = (from: number, to: number) => link.url.toLowerCase().includes(run.str.slice(from, to).toLowerCase());
    while (end > start && /[.,;:)\]'"”’]/.test(run.str[end - 1]) && !inAddress(start, end)) end -= 1;
    // A stop on its own, caught at the edge of the box, is not the link.
    if (end <= start || !/[\p{L}\p{N}]/u.test(run.str.slice(start, end))) {
      out.push(run);
      continue;
    }
    const piece = (from: number, to: number, href?: string): TextRun => ({
      ...run,
      str: run.str.slice(from, to),
      x: run.x + from * per,
      width: (to - from) * per,
      ...(href ? { href } : {}),
    });
    out.push(piece(start, end, link.url));
    const rest = new Set([...tried, link]);
    if (start > 0) queue.unshift({ run: piece(0, start), tried: rest });
    if (end < length) queue.unshift({ run: piece(end, length), tried: rest });
  }
  return out;
}

/**
 * Accents set over the letter before them — mathematics' R̄, x̂, ẍ, drawn
 * as a letter and then a bar placed back over it — put on the letter. TeX's
 * accents in text come before their letter instead ("na¨ıve"), and
 * `composeAccents` puts those back.
 */
function overstrike(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    const mark = run.str.trim();
    const previous = out[out.length - 1];
    if (mark.length === 1 && ACCENTS[mark] && previous && /\p{L}$/u.test(previous.str)) {
      // The width of one letter of the run before, and where its last one sits.
      const letter = previous.width / Math.max(1, previous.str.length);
      const last = previous.x + previous.width - letter;
      const middle = run.x + run.width / 2;
      // Drawn back over it: starting inside the letter, not after it, as a
      // text accent waiting for the next letter would.
      if (run.x < previous.x + previous.width - 0.15 * letter && middle > last - 0.3 * letter && middle < previous.x + previous.width + 0.5 * letter) {
        out[out.length - 1] = { ...previous, str: (previous.str + ACCENTS[mark]).normalize('NFC') };
        continue;
      }
    }
    out.push(run);
  }
  return out;
}

/** A run with no letter or digit in it: an accent, an arrow, a bracket. */
const bareRun = (run: TextRun): boolean => !/[\p{L}\p{N}]/u.test(run.str);

/**
 * Runs into lines: one baseline, read left to right, with a gap of more than
 * a line's own em between two runs starting a new line — which is what keeps
 * the two columns of a page apart when both have a line on the same
 * baseline, and what separates the cells of a table row. A run that sits a
 * little above or below the baseline — a superscript, a subscript — still
 * belongs to the line, so the baselines are gathered first and each one is
 * cut at its gaps afterwards, once every run on it is known.
 */
/** TeX's large operators, which its extension font sets at letters' codes: its "P" is a Σ. */
const CMEX: Record<string, string> = { P: '∑', X: '∑', Q: '∏', Y: '∏', R: '∫', Z: '∫', S: '∮' };
/**
 * Springer's symbol fonts, which set their glyphs at other characters'
 * codes: the "•" between authors' names is an "&", the "©" a "#", and
 * parentheses in mathematics "ð" and "Þ".
 */
const SPRINGER: [RegExp, Record<string, string>][] = [
  [/AdvP0005/, { '&': '•' }],
  [/AdvPi3/, { '#': '©' }],
  [/AdvP4C4E74/, { ð: '(', Þ: ')', '¼': '=', þ: '+' }],
];

/** A run's text as it is seen, where its font sets glyphs at codes of the wrong characters. */
function glyphsOf(run: TextRun): string {
  if (/cmex/i.test(run.font)) return run.str.replace(/[PQRSXYZ]/g, (glyph) => CMEX[glyph]);
  // Computer Modern's mathematics italic sets its ϵ at the code pdf.js
  // reads as "ǫ", an o with an ogonek, which no formula has.
  if (/cmmi/i.test(run.font)) return run.str.replace(/ǫ/g, 'ϵ');
  for (const [font, map] of SPRINGER) if (font.test(run.font)) return Array.from(run.str, (glyph) => map[glyph] ?? glyph).join('');
  return run.str;
}

function buildLines(page: PageInput): Line[] {
  // A blank run between two words is their space, though the word before
  // it is measured as reaching the next — "budget" then "𝐶", the space its own run.
  // Text set a letter at a time — a licence's address, "h t t p : / / c r e …",
  // each letter its own run, set flush against the one before — which pdf.js
  // reports with a space leading many of the letters that has no width: the
  // letter without it, before a link's words are cut out by their widths.
  const letters = page.runs.map((run, index) => {
    const previous = page.runs[index - 1];
    if (!previous || !/^\s+\S$/.test(run.str) || previous.str.trim().length !== 1) return run;
    if (Math.abs(run.y - previous.y) > 0.3 * run.size || Math.abs(run.x - (previous.x + previous.width)) > 0.15 * run.size) return run;
    return { ...run, str: run.str.trimStart() };
  });
  const linked = linkRuns(letters, page.links || []);
  const spaced = new Set<TextRun>();
  linked.forEach((run, index) => {
    const next = linked[index + 1];
    if (!run.str.trim() && run.str.length && next?.str.trim() && Math.abs(next.y - run.y) < 0.3 * Math.max(run.size, next.size) && Math.abs(next.x - (run.x + run.width)) < 0.5 * next.size) spaced.add(next);
  });
  const runs: Run[] = linked
    .map((run) => (spaced.has(run) ? { ...run, spaced: true } : run))
    .filter((run) => run.str.trim().length && run.size > 0)
    .map((run) => ({ ...run, str: composeAccents(glyphsOf(run)), ...faceOf(run.font) }))
    // A glyph drawn twice where it stands — a bold faked by overprinting — once.
    .filter((run, index, all) => !all.some((other, at) => at < index && other.str === run.str && Math.abs(other.x - run.x) < 0.5 && Math.abs(other.y - run.y) < 0.5))
    // The baselines are laid by the text's own size first, and the smaller
    // runs — a superscript, a footnote mark — are placed on them after: a
    // superscript met first would otherwise start a baseline of its own
    // and pull half its line onto it. So would a bar set over a letter, and
    // among runs of one size the words lay the baselines before the marks.
    .sort((a, b) => round(b.size) - round(a.size) || Number(bareRun(a)) - Number(bareRun(b)) || a.y - b.y || a.x - b.x);

  const baselines: { runs: Run[]; baseline: number; size: number }[] = [];
  for (const run of runs) {
    let home: (typeof baselines)[number] | undefined;
    let best = Number.POSITIVE_INFINITY;
    for (let at = baselines.length - 1; at >= 0; at -= 1) {
      const candidate = baselines[at];
      const drift = Math.abs(run.y - candidate.baseline);
      if (drift > 0.55 * Math.max(candidate.size, run.size)) continue;
      // Not a run set over or under one already there: that is the next
      // line of its column, drawn into this baseline by a line of larger
      // type in the column beside it, which sits between the two.
      // (A subscript under a superscript — the ₂ under the ² of ‖x‖²₂ — is
      // not that: two small runs stacked are one expression's scripts.)
      const script = (item: Run) => item.size < 0.85 * candidate.size;
      const stacked = candidate.runs.some(
        (other) =>
          !(script(run) && script(other)) &&
          Math.abs(other.y - run.y) > 0.3 * Math.min(other.size, run.size) &&
          Math.min(other.x + other.width, run.x + run.width) - Math.max(other.x, run.x) > 1,
      );
      if (stacked) continue;
      // A run off the baseline — a subscript, a superscript — belongs with
      // the words beside it, not with a line in the other column whose
      // baseline happens to fall nearer: only a run on the baseline itself
      // joins one across a gap, as a table's cells do.
      const em = Math.max(candidate.size, run.size);
      // Beside is touching, or nearly: a script is set against its letter,
      // and the gap between two columns is wider than half an em.
      const beside = candidate.runs.some((other) => run.x - (other.x + other.width) < 0.5 * em && other.x - (run.x + run.width) < 0.5 * em);
      if (!beside && drift > 0.15 * em) continue;
      const score = drift + (beside ? 0 : em);
      if (score < best) {
        best = score;
        home = candidate;
      }
    }
    if (home) {
      home.runs.push(run);
      // The baseline is that of the largest run on it, so a superscript
      // arriving first does not set it.
      if (run.size > home.size) {
        home.size = run.size;
        home.baseline = run.y;
      }
    } else {
      baselines.push({ runs: [run], baseline: run.y, size: run.size });
    }
  }

  // A fraction set in a line of text, in small type — its numerator over
  // its denominator, one either side of the line's baseline, the line's
  // words against them — is the line's, read "(a)/(b)".
  const extent = (runs: Run[]) => ({ x0: Math.min(...runs.map((run) => run.x)), x1: Math.max(...runs.map((run) => run.x + run.width)) });
  for (const home of baselines.slice()) {
    if (!baselines.includes(home)) continue;
    const small = (run: Run) => run.size <= 0.85 * home.size;
    const rise = (run: Run) => home.baseline - run.y;
    // The denominator: small runs lowered under the line — on it, or on a baseline of their own.
    const lowered = baselines
      .filter((group) => group === home || group.runs.every(small))
      .flatMap((group) => group.runs)
      .filter((run) => small(run) && rise(run) < -0.15 * home.size && rise(run) > -0.7 * home.size)
      .sort((a, b) => a.x - b.x);
    // Each stretch of them, parted by a gap, a denominator to try.
    const stretches: Run[][] = [];
    for (const run of lowered) {
      const last = stretches[stretches.length - 1];
      if (last && run.x - Math.max(...last.map((one) => one.x + one.width)) < 0.5 * home.size) last.push(run);
      else stretches.push([run]);
    }
    for (const denominator of stretches) {
      const b = extent(denominator);
      const overlaps = (run: Run) => Math.min(run.x + run.width, b.x1) - Math.max(run.x, b.x0) > 0;
      // The numerator: small runs raised over the line, over the denominator
      // — on whatever baseline they were laid, the other column's included.
      const raised = baselines
        .flatMap((group) => group.runs)
        .filter((run) => small(run) && rise(run) > 0.15 * home.size && rise(run) < 0.7 * home.size);
      const core = raised.filter(overlaps);
      if (!core.length) continue;
      // And its brackets, set just past the denominator's ends.
      const reach = extent(core);
      const numerator = raised.filter((run) => core.includes(run) || (Math.abs(run.y - core[0].y) < 0.5 && run.x + run.width >= reach.x0 - 0.5 * home.size && run.x <= reach.x1 + 0.5 * home.size));
      const a = extent(numerator);
      if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) < 0.5 * Math.min(a.x1 - a.x0, b.x1 - b.x0)) continue;
      // Short, and centred on each other, as a fraction is — not two lines of
      // small type either side of a line in the column beside them, nor a
      // letter's two scripts stacked, x²ᵢ.
      const wide = Math.max(a.x1 - a.x0, b.x1 - b.x0);
      if (wide > 16 * home.size || Math.min(a.x1 - a.x0, b.x1 - b.x0) < 1.5 * home.size) continue;
      if (Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2) > 0.15 * wide) continue;
      const x0 = Math.min(a.x0, b.x0);
      const x1 = Math.max(a.x1, b.x1);
      const parts = new Set([...numerator, ...denominator]);
      // Alone on their baselines, as a fraction's halves are: two cells of a
      // table stacked in its first column have the row's other cells beside them.
      const everyRun = baselines.flatMap((group) => group.runs);
      const accompanied = [numerator[0], denominator[0]].some((half) =>
        everyRun.some((run) => !parts.has(run) && small(run) && Math.abs(run.y - half.y) < 0.3 * half.size && (run.x > x1 ? run.x - x1 : x0 - (run.x + run.width)) < 12 * home.size),
      );
      if (accompanied) continue;
      const words = home.runs.filter((run) => !parts.has(run));
      const against = words.some((run) => (run.x >= x1 - 1 && run.x - x1 < 1.5 * home.size) || (run.x + run.width <= x0 + 1 && x0 - (run.x + run.width) < 1.5 * home.size));
      if (!against) continue;
      // Read in order: the numerator in the first half of its space, the denominator in the second.
      const half = (x1 - x0) / 2;
      const squeeze = (runs: Run[], from: { x0: number; x1: number }, start: number) =>
        runs.map((run) => {
          const scale = half / Math.max(1, from.x1 - from.x0);
          return { ...run, x: start + (run.x - from.x0) * scale, width: run.width * scale, y: home.baseline, fraction: true };
        });
      const size = numerator[0].size;
      for (const group of baselines) group.runs = group.runs.filter((run) => !parts.has(run));
      home.runs = [...words, ...squeeze(numerator, a, x0), { ...numerator[0], str: '/', x: x0 + half, width: 0.01, y: home.baseline, size, fraction: true }, ...squeeze(denominator, b, x0 + half + 0.02)];
      for (let at = baselines.length - 1; at >= 0; at -= 1) if (!baselines[at].runs.length) baselines.splice(at, 1);
    }
  }

  // A radical or a large operator set in the line — the √ of √d_model —
  // sits higher than its letters, on a baseline of its own; it is the
  // line's it touches, and the scripts after it with it.
  for (const lone of baselines.slice()) {
    if (!lone.runs.every((run) => bareRun(run) || run.math) || lone.runs.reduce((width, run) => width + run.width, 0) > 2.5 * lone.size) continue;
    // TeX raises these over the baseline, never lowers them: the line is
    // the one level with it or under it, with a word set against it —
    // the radicand, the summand — not the line over it.
    const x0 = Math.min(...lone.runs.map((run) => run.x));
    const x1 = Math.max(...lone.runs.map((run) => run.x + run.width));
    const home = baselines
      .filter(
        (group) =>
          group !== lone &&
          group.runs.some((run) => !bareRun(run)) &&
          group.baseline >= lone.baseline - 0.1 * group.size &&
          group.baseline - lone.baseline <= 0.9 * group.size &&
          group.runs.some((other) => (other.x - x1 > -0.3 * group.size && other.x - x1 < 0.6 * group.size && other.x >= x0) || (x0 - (other.x + other.width) > -0.3 * group.size && x0 - (other.x + other.width) < 0.6 * group.size)),
      )
      .sort((a, b) => Math.abs(a.baseline - lone.baseline) - Math.abs(b.baseline - lone.baseline))[0];
    if (!home) continue;
    home.runs.push(...lone.runs);
    baselines.splice(baselines.indexOf(lone), 1);
  }

  // A script's own scripts — ℝ^(d_hidden×d_model) — can gather on a
  // baseline of their own, closer to each other than to the line: a group
  // of small runs touching a line of larger type, within a script's
  // distance of its baseline, is that line's.
  for (const small of baselines.slice()) {
    const most = Math.max(...small.runs.map((run) => run.size));
    const home = baselines.find(
      (group) =>
        group !== small &&
        group.size * 0.85 >= most &&
        Math.abs(group.baseline - small.baseline) <= 0.55 * group.size &&
        small.runs.some((run) => group.runs.some((other) => run.x - (other.x + other.width) < 0.5 * group.size && other.x - (run.x + run.width) < 0.5 * group.size && run.x + run.width > other.x - 0.5 * group.size)),
    );
    if (!home) continue;
    home.runs.push(...small.runs);
    baselines.splice(baselines.indexOf(small), 1);
  }

  const lines: { runs: Run[]; baseline: number; size: number; x0: number; x1: number }[] = [];
  for (const group of baselines) {
    group.runs.sort((a, b) => a.x - b.x);
    let current: (typeof lines)[number] | null = null;
    for (const run of group.runs) {
      const em = Math.max(run.size, current?.size ?? 0);
      if (current && run.x <= current.x1 + em) {
        current.runs.push(run);
        current.x1 = Math.max(current.x1, run.x + run.width);
        current.size = Math.max(current.size, run.size);
      } else {
        current = { runs: [run], baseline: group.baseline, size: run.size, x0: run.x, x1: run.x + run.width };
        lines.push(current);
      }
    }
  }

  // A bullet drawn rather than typed — a filled dot just left of the line
  // — is the item's first run too.
  for (const box of page.graphics) {
    const width = box.x1 - box.x0;
    const height = box.y1 - box.y0;
    if (width < 1 || height < 1 || width > 6 || height > 6) continue;
    // Alone, as a bullet is: not one piece of a badge drawn of many — a licence's logo.
    if (page.graphics.some((other) => other !== box && other.x0 < box.x1 + 3 && other.x1 > box.x0 - 3 && other.y0 < box.y1 + 3 && other.y1 > box.y0 - 3)) continue;
    const item = lines.find(
      (line) => line.x0 - box.x1 >= 0 && line.x0 - box.x1 < 3 * line.size && box.y1 > line.baseline - 0.8 * line.size && box.y0 < line.baseline,
    );
    if (!item || LONE_BULLET.test(item.runs[0].str)) continue;
    item.runs.unshift({ ...item.runs[0], str: '•', x: box.x0, width, bold: false, italic: false, mono: false, math: false });
    item.x0 = box.x0;
  }

  // A bullet set well apart from its item — "●    Worked with…" — is the
  // item's first run, not a line of its own.
  for (const bullet of lines.slice()) {
    if (bullet.runs.length !== 1 || !LONE_BULLET.test(bullet.runs[0].str)) continue;
    const item = lines.find(
      (line) => line !== bullet && line.x0 >= bullet.x1 - 1 && line.x0 - bullet.x1 < 3 * line.size && Math.abs(line.baseline - bullet.baseline) < 0.8 * Math.max(line.size, bullet.size),
    );
    if (!item) continue;
    item.runs.unshift(bullet.runs[0]);
    item.x0 = Math.min(item.x0, bullet.x0);
    lines.splice(lines.indexOf(bullet), 1);
  }

  return lines.map((line) => {
    line.runs.sort((a, b) => a.x - b.x);
    line.runs = overstrike(line.runs);
    // The line's size is the size most of its glyphs are set in, and its
    // baseline that of those glyphs — a line that is mostly a superscript
    // is a footnote mark, not a paragraph.
    // Small capitals — "I. INTRODUCTION", "REFERENCES" as IEEE sets them —
    // are capitals set smaller on the same baseline, and count at the size
    // of the capitals they go with.
    const largest = line.runs.reduce((best, run) => (run.size > best.size ? run : best), line.runs[0]);
    const smallCaps = (run: Run) =>
      run !== largest &&
      run.size >= largest.size * 0.6 &&
      run.size <= largest.size * 0.92 &&
      Math.abs(run.y - largest.y) < 0.1 * largest.size &&
      /\p{Lu}/u.test(run.str) &&
      !/\p{Ll}/u.test(run.str);
    const weight = new Map<number, number>();
    // A typewriter face is set larger than the text about it to look its
    // size — an address in a reference, LMMono at 12pt in 10.9pt text — and
    // is counted at the text's size where the line has any.
    const text = line.runs.filter((run) => !run.mono && /[\p{L}\p{N}.,;:]/u.test(run.str));
    const textSize = text.length ? text.reduce((best, run) => (run.str.length > best.str.length ? run : best), text[0]).size : 0;
    for (const run of line.runs) {
      const counted = smallCaps(run) || run.fraction ? largest.size : run.mono && textSize && run.size > textSize && run.size <= 1.25 * textSize ? textSize : run.size;
      weight.set(counted, (weight.get(counted) || 0) + run.str.length);
    }
    let size = line.size;
    let best = -1;
    for (const [candidate, count] of weight) {
      if (count > best) {
        best = count;
        size = candidate;
      }
    }
    const carrier = line.runs.find((run) => run.size === size) || line.runs[0];
    const glyphs = line.runs.reduce((sum, run) => sum + run.str.length, 0) || 1;
    const math = line.runs.filter((run) => run.math).reduce((sum, run) => sum + run.str.length, 0);
    const mono = line.runs.filter((run) => run.mono).reduce((sum, run) => sum + run.str.length, 0);
    // The face of the line is the face of most of its letters: a bold
    // caption with a "3%" set in a mathematics font is still bold, and so is
    // a line of a bold abstract with "3.7%" set in upright roman.
    // A line with no letters — "2.1" set apart from its heading — goes by its digits.
    const worded = line.runs.filter((run) => /\p{L}/u.test(run.str) && !run.math);
    const lettered = worded.length ? worded : line.runs.filter((run) => /\w/.test(run.str));
    const letters = lettered.reduce((sum, run) => sum + run.str.length, 0);
    const bold = lettered.filter((run) => run.bold).reduce((sum, run) => sum + run.str.length, 0);
    const italic = lettered.filter((run) => run.italic).reduce((sum, run) => sum + run.str.length, 0);
    return {
      page: page.index,
      runs: line.runs,
      x0: line.x0,
      x1: line.x1,
      baseline: carrier.y,
      size,
      top: carrier.y - 0.8 * size,
      bottom: carrier.y + 0.22 * size,
      text: joinRuns(line.runs, size),
      allBold: letters > 0 && bold / letters >= 0.85,
      allItalic: letters > 0 && italic / letters >= 0.85,
      mathShare: math / glyphs,
      monoShare: mono / glyphs,
    };
  });
}

// -------------------------------------------------------------- measures --

interface Measures {
  bodySize: number;
  /** The width of a column of body text — the width most full lines have. */
  columnWidth: number;
  /** Whether body text is justified: most full lines end at the same edge. */
  justified: boolean;
  /** The distance from one line of body text to the next, most often. */
  pitch: number;
}

const round = (value: number, step = 0.5): number => Math.round(value / step) * step;

function measure(pages: Line[][]): Measures {
  const bySize = new Map<number, number>();
  for (const lines of pages) {
    for (const line of lines) bySize.set(round(line.size), (bySize.get(round(line.size)) || 0) + line.text.length);
  }
  let bodySize = 10;
  let most = -1;
  for (const [size, count] of bySize) {
    if (count > most) {
      most = count;
      bodySize = size;
    }
  }

  // Full lines of body text are the ones as wide as the column: the modal
  // width, to the nearest 4pt, among lines near the body size.
  const byWidth = new Map<number, number>();
  const body = pages.flat().filter((line) => Math.abs(line.size - bodySize) <= 0.6);
  for (const line of body) {
    const width = round(line.x1 - line.x0, 4);
    byWidth.set(width, (byWidth.get(width) || 0) + 1);
  }
  let columnWidth = 0;
  most = -1;
  for (const [width, count] of byWidth) {
    if (width < 80) continue;
    if (count > most || (count === most && width > columnWidth)) {
      most = count;
      columnWidth = width;
    }
  }
  if (!columnWidth) columnWidth = Math.max(80, ...body.map((line) => line.x1 - line.x0), 0);

  const full = body.filter((line) => line.x1 - line.x0 >= columnWidth - 6);
  const byRight = new Map<number, number>();
  for (const line of full) byRight.set(round(line.x1, 2), (byRight.get(round(line.x1, 2)) || 0) + 1);
  const aligned = Math.max(0, ...byRight.values());
  const justified = full.length >= 8 && aligned / full.length >= 0.5;

  // From each line of body text to the next one under it in its column.
  const byPitch = new Map<number, number>();
  for (const lines of pages) {
    const column = lines.filter((line) => Math.abs(line.size - bodySize) <= 0.6).sort((a, b) => a.baseline - b.baseline);
    for (const [index, line] of column.entries()) {
      const next = column.slice(index + 1).find((other) => other.baseline - line.baseline > 0.5 * bodySize && Math.min(other.x1, line.x1) - Math.max(other.x0, line.x0) > 0);
      if (!next) continue;
      const pitch = round(next.baseline - line.baseline, 0.25);
      if (pitch < 2.5 * bodySize) byPitch.set(pitch, (byPitch.get(pitch) || 0) + 1);
    }
  }
  const pitch = Array.from(byPitch.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 1.2 * bodySize;

  return { bodySize, columnWidth, justified, pitch };
}

/**
 * A line of justified text stretched so wide that its spaces are wider
 * than an em — "I. Loshchilov and F. Hutter.   Decoupled weight decay
 * regularization.   arXiv preprint" — was cut into pieces at them, as the
 * columns of a page are: one line again where the pieces together are a
 * column's full line, set in the text's size, and spaced evenly as
 * justification spaces them. Two columns' lines together are twice as wide.
 */
function mendJustified(lines: Line[], measures: Measures): void {
  const body = measures.bodySize;
  // The text's lines, and the footnotes' — set smaller, in the same
  // measure, and justified the same way — but not a table's cells, nor a
  // heading's, set larger.
  const text = lines
    .filter((line) => line.size <= body + 0.6 && line.size >= 0.7 * body && line.mathShare < 0.3 && /\p{L}{2}/u.test(line.text))
    .sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
  // The right edges the full lines of text end at: a justified line ends
  // at its column's edge however it starts.
  const edges = lines.filter((line) => Math.abs(line.size - body) <= 0.6 && line.x1 - line.x0 >= measures.columnWidth - 6).map((line) => line.x1);
  const rows: Line[][] = [];
  for (const line of text) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].baseline - line.baseline) < 0.3 * line.size && Math.abs(row[0].size - line.size) <= 0.6) row.push(line);
    else rows.push([line]);
  }
  for (const row of rows) {
    if (row.length < 2) continue;
    row.sort((a, b) => a.x0 - b.x0);
    const em = row[0].size;
    const gaps = row.slice(1).map((line, index) => line.x0 - row[index].x1);
    const span = row[row.length - 1].x1 - row[0].x0;
    // A column's full line; or a paragraph's first line, indented at its
    // start, that ends at the edge the full lines end at.
    const full = Math.abs(span - measures.columnWidth) <= 0.6 * em;
    const indented = measures.columnWidth - span > 0 && measures.columnWidth - span <= 3 * em && edges.some((edge) => Math.abs(edge - row[row.length - 1].x1) < 1.5);
    if ((!full && !indented) || gaps.some((gap) => gap <= 0 || gap > 2.5 * em)) continue;
    if (gaps.length === 1 ? gaps[0] > 1.6 * em : Math.max(...gaps) - Math.min(...gaps) > 1) continue;
    const runs = row.flatMap((line) => line.runs).sort((a, b) => a.x - b.x);
    const letters = (line: Line) => line.text.length || 1;
    const total = row.reduce((sum, line) => sum + letters(line), 0);
    const merged: Line = {
      ...row[0],
      runs,
      x1: row[row.length - 1].x1,
      text: joinRuns(runs, row[0].size),
      allBold: row.every((line) => line.allBold),
      allItalic: row.every((line) => line.allItalic),
      mathShare: row.reduce((sum, line) => sum + line.mathShare * letters(line), 0) / total,
      monoShare: row.reduce((sum, line) => sum + line.monoShare * letters(line), 0) / total,
    };
    lines.splice(lines.indexOf(row[0]), 1, merged);
    for (const line of row.slice(1)) lines.splice(lines.indexOf(line), 1);
  }
}

// -------------------------------------------------------- headers, feet --

/**
 * Running heads, page numbers and the arXiv stamp: lines in the top or
 * bottom margin that are short, numeric, or the same on page after page.
 */
/**
 * A line that opens with a note's mark: "∗", "†", or a small raised number
 * — a footnote, however low on the page it is set.
 */
function noteMark(line: Line): boolean {
  const run = line.runs.find((item) => item.str.trim());
  if (!run) return false;
  if (/^[∗*†‡§¶]/.test(run.str.trim())) return true;
  return /^\d{1,2}$/.test(run.str.trim()) && run.size < 0.85 * line.size && line.baseline - run.y > 0.15 * line.size && line.runs.some((other) => other !== run && /\p{L}{2}/u.test(other.str));
}

function dropFurniture(pages: Line[][], inputs: PageInput[], measures: Measures): void {
  const seen = new Map<string, { page: number; x0: number; x1: number; baseline: number }[]>();
  const marginal = (line: Line, page: PageInput) => line.baseline < page.height * 0.1 || line.baseline > page.height * 0.9;
  for (const [at, lines] of pages.entries()) {
    const page = inputs[at];
    for (const line of lines) {
      if (!marginal(line, page)) continue;
      const key = norm(line.text.replace(/\d+/g, '#')).toLowerCase();
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key)!.push({ page: at, x0: line.x0, x1: line.x1, baseline: line.baseline });
    }
  }
  // A running head is set in the same place on page after page. A table's
  // heading — "Model", "MNLI-m" — at the head of a page where a table
  // floats to the top is not, though the word comes round on page after
  // page: each table sets it where its column falls.
  const placedAlike = (line: Line, other: { x0: number; x1: number; baseline: number }) =>
    Math.abs(other.baseline - line.baseline) < 3 && (Math.abs(other.x0 - line.x0) < 3 || Math.abs(other.x1 - line.x1) < 3 || Math.abs((other.x0 + other.x1) / 2 - (line.x0 + line.x1) / 2) < 3);
  const pageCount = pages.length;
  for (const [at, lines] of pages.entries()) {
    const page = inputs[at];
    // A note's number hung in the margin, its text beside it, is no page
    // number — unless what is beside it is the running head itself: Springer
    // sets the article's number in a box before "Page 2 of 11".
    const hung = new Map<Line, Line>();
    for (const line of lines) {
      if (!marginal(line, page) || !/^\d{1,2}$/.test(line.text)) continue;
      const beside = lines.find((other) => other !== line && Math.abs(other.baseline - line.baseline) < 0.6 * other.size && other.x0 > line.x1 && other.x0 - line.x1 < 4 * other.size);
      if (beside) hung.set(line, beside);
    }
    for (const line of lines) {
      if (!marginal(line, page) || hung.has(line)) continue;
      const text = line.text;
      const key = norm(text.replace(/\d+/g, '#')).toLowerCase();
      const repeats = new Set((seen.get(key) ?? []).filter((other) => placedAlike(line, other)).map((other) => other.page)).size;
      const short = line.x1 - line.x0 < measures.columnWidth * 0.6;
      if (
        /^\d+$/.test(text) ||
        /^(page\s+)?\d+\s*(of|\/)\s*\d+$/i.test(text) ||
        (repeats >= Math.min(3, Math.max(2, pageCount - 1)) && pageCount > 1) ||
        (short && line.size < measures.bodySize - 0.4 && line.baseline > page.height * 0.92 && !noteMark(line)) ||
        (short && line.baseline < page.height * 0.06)
      ) {
        line.taken = true;
      }
    }
    for (const [line, beside] of hung) if (beside.taken) line.taken = true;
    // A page number set higher than the margins above count — article's
    // is 88% of the way down a letter page — is still the page's last
    // line, a number alone, well clear of the text above it.
    const kept = lines.filter((line) => !line.taken);
    const last = kept.reduce<Line | null>((low, line) => (!low || line.baseline > low.baseline ? line : low), null);
    if (last && /^(page\s+)?\d{1,4}$/i.test(last.text) && last.baseline > page.height * 0.75) {
      const above = Math.max(0, ...kept.filter((line) => line !== last).map((line) => line.baseline));
      if (last.baseline - above > 1.8 * last.size) last.taken = true;
    }
  }
}

// -------------------------------------------------------------- contents --

const CONTENTS = /^(?:table\s+of\s+)?contents$/i;

/**
 * A table of contents: "Contents", then its entries — a title, dots led
 * to a page number set at the right edge. The reflowed paper has no pages
 * for it to point at, and its entries are no headings of the text: it is
 * left out, and so is its run on to the page after.
 */
function dropContents(pages: Line[][], inputs: PageInput[]): void {
  const numeral = (line: Line) => /^(?:\d{1,4}|[ivxlc]{1,6})$/i.test(line.text);
  const leaders = (line: Line) => /(?:\.\s?){4,}\s*(?:\d{1,4}|[ivxlc]{1,6})?$/i.test(line.text);
  // The page numbers set against one right edge, most of them.
  const edgeOf = (lines: Line[]): { right: number; numbers: Line[] } | null => {
    const numbers = lines.filter((line) => !line.taken && numeral(line));
    const byRight = new Map<number, Line[]>();
    for (const line of numbers) {
      const key = round(line.x1, 2);
      byRight.set(key, [...(byRight.get(key) ?? []), line]);
    }
    // The page numbers are the column furthest right: the entries' own
    // numbers, "1", "2.1", may line up at their left as many times.
    const most = Math.max(0, ...Array.from(byRight.values()).map((column) => column.length));
    const best = Array.from(byRight.entries()).filter(([, column]) => column.length >= 3 && column.length >= 0.6 * most).sort((a, b) => b[0] - a[0])[0];
    return best ? { right: best[0], numbers: best[1] } : null;
  };
  for (let at = 0; at < pages.length; at += 1) {
    const lines = pages[at];
    const heading = lines.find((line) => !line.taken && CONTENTS.test(line.text.trim()) && line.baseline < inputs[at].height * 0.5);
    if (!heading) continue;
    const edge = edgeOf(lines.filter((line) => line.baseline > heading.baseline));
    if (!edge) continue;
    const take = (from: number, to: number, page: Line[]) => {
      for (const line of page) if (!line.taken && line.baseline >= from && line.baseline <= to + 1 && line.x1 <= edge.right + 2) line.taken = true;
    };
    take(heading.baseline, Math.max(...edge.numbers.map((line) => line.baseline)), lines);
    // The contents running on to the next page: its lines mostly entries, numbered at the same edge.
    for (let next = at + 1; next < pages.length; next += 1) {
      const page = pages[next].filter((line) => !line.taken);
      const numbers = page.filter((line) => numeral(line) && Math.abs(line.x1 - edge.right) < 2);
      const entries = page.filter((line) => leaders(line) || numbers.some((number) => Math.abs(number.baseline - line.baseline) < 0.5 * line.size));
      if (numbers.length < 3 || entries.length < 0.6 * page.length) break;
      take(Math.min(...entries.map((line) => line.baseline)), Math.max(...numbers.map((line) => line.baseline)), pages[next]);
    }
  }
}

// -------------------------------------------------------------- captions --

// IEEE numbers its tables in capital Roman numerals: "TABLE IV".
// Springer sets the label in bold and the caption straight after it, with
// no stop: "Fig. 1 Anatomical masks" — which takes the bold to tell it apart.
const CAPTION = /^(fig(?:ure)?s?|tables?|tab|algorithm|listing|scheme|chart|plate)\.?\s*(s?\d+[a-z]?(?:\.\d+)?|[IVXL]{1,6}\b)(\s*[.:|—–-]|\s+(?=\S)|\s*$)/i;

/**
 * Whether a caption's label — its first `length` letters, "Fig. 1" — is set
 * in a face of its own, apart from the words after it: bold, or another
 * font where the PDF's font names say nothing of weight, as Springer's do.
 */
function labelApart(line: Line, length: number): boolean {
  const runs = line.runs.filter((run) => run.str.trim());
  const label: Run[] = [];
  let seen = 0;
  for (const run of runs) {
    if (seen >= length) break;
    label.push(run);
    seen += run.str.trim().length + (label.length > 1 ? 1 : 0);
  }
  const after = runs[label.length];
  if (!label.length || !after || seen > length + 1) return false;
  return label.every((run) => (run.bold && !after.bold) || run.font !== after.font);
}

function findCaptions(lines: Line[], measures: Measures): void {
  for (const line of lines) {
    if (line.taken) continue;
    const match = CAPTION.exec(line.text);
    if (!match) continue;
    const first = line.runs.find((run) => /\w/.test(run.str));
    const styled = Boolean(first && (first.bold || first.italic || Math.abs(first.size - measures.bodySize) > 0.4));
    const punctuated = /[.:|—–-]/.test(match[3]);
    // The caption straight after the number: only where the label alone is
    // bold — "Fig. 1" in bold, then the caption in roman.
    const runOn = /^\s+$/.test(match[3]) && line.text.length > match[0].length;
    // An algorithm's caption is set bold whole, between the rules over it:
    // "Algorithm 1 Column-by-column compilation."
    const algorithm = /^(algorithm|listing)/i.test(match[1]) && line.allBold && line.text.length <= 120;
    if (!algorithm && (runOn ? !labelApart(line, match[0].trim().length) : !styled && !punctuated)) continue;
    // "Table in" is not a table; Roman numerals are capitals.
    if (/^[ivxl]/i.test(match[2]) && match[2] !== match[2].toUpperCase()) continue;
    // A line of the text that happens to begin "Table 7. RoBERTa achieves…"
    // — carrying on the sentence of the full line of text set just over
    // it, which no caption does.
    if (!styled && bodyLike(line, measures)) {
      const over = lines
        .filter((other) => other !== line && !other.taken && !other.caption && overlapX(other, line) > 0 && other.baseline < line.baseline && line.baseline - other.baseline < 1.6 * line.size && Math.abs(other.size - line.size) <= 0.6)
        .sort((a, b) => b.baseline - a.baseline)[0];
      if (over && bodyLike(over, measures) && !/[.!?:]["'”’)]?$/.test(over.text)) continue;
    }
    const word = match[1].toLowerCase();
    const kind = word.startsWith('tab') ? 'table' : 'figure';
    line.caption = { kind, label: `${match[1]} ${match[2]}`.replace(/\.$/, '') };
  }
}

// -------------------------------------------------------------- graphics --

interface Cluster {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  images: number;
  /** Drawings that are not hairlines: a plot, a diagram, a shaded cell. */
  bodies: number;
  rules: number;
}

/**
 * Drawings that sit near each other are one thing — a plot and its axes, a
 * diagram's boxes and arrows, the rules of a table. Page-sized boxes
 * (backgrounds, clipping frames) are not figures and are left out.
 */
function clusterGraphics(page: PageInput): Cluster[] {
  const area = page.width * page.height;
  const boxes = page.graphics.filter((box) => {
    const width = box.x1 - box.x0;
    const height = box.y1 - box.y0;
    if (!(width >= 0) || !(height >= 0)) return false;
    if (width * height > area * 0.6) return false;
    if (width > page.width * 0.95 && height > page.height * 0.5) return false;
    return box.x1 > 0 && box.y1 > 0 && box.x0 < page.width && box.y0 < page.height;
  });
  const parent = boxes.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index])));
  const near = (a: GraphicBox, b: GraphicBox, gap: number) =>
    a.x0 <= b.x1 + gap && b.x0 <= a.x1 + gap && a.y0 <= b.y1 + gap && b.y0 <= a.y1 + gap;
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (near(boxes[i], boxes[j], 6)) parent[find(i)] = find(j);
    }
  }
  const clusters = new Map<number, Cluster>();
  boxes.forEach((box, index) => {
    const root = find(index);
    const rule = box.x1 - box.x0 < 1.5 || box.y1 - box.y0 < 1.5;
    const cluster = clusters.get(root) || { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1, images: 0, bodies: 0, rules: 0 };
    cluster.x0 = Math.min(cluster.x0, box.x0);
    cluster.y0 = Math.min(cluster.y0, box.y0);
    cluster.x1 = Math.max(cluster.x1, box.x1);
    cluster.y1 = Math.max(cluster.y1, box.y1);
    // A hairline is a rule whatever it was drawn as: a dvips PDF draws a
    // table's rules as image masks a pixel high.
    if (rule) cluster.rules += 1;
    else if (box.kind === 'image') cluster.images += 1;
    else cluster.bodies += 1;
    clusters.set(root, cluster);
  });
  return Array.from(clusters.values()).filter((cluster) => {
    const width = cluster.x1 - cluster.x0;
    const height = cluster.y1 - cluster.y0;
    if (cluster.images) return true;
    // A lone rule under a heading or above the footnotes is not a figure.
    if (!cluster.bodies && cluster.rules < 2) return false;
    return width >= 24 && height >= 8;
  });
}

// --------------------------------------------------------------- regions --

interface Region {
  kind: 'figure' | 'table' | 'equation';
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  caption?: Line;
  label: string;
  lines: Line[];
  /** A box of text between rules — a prompt, an example — rather than a grid of cells. */
  box?: boolean;
}

const overlapX = (a: { x0: number; x1: number }, b: { x0: number; x1: number }) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);

/** A full line of running text — not code, which is set in a listing, nor mathematics. */
function bodyLike(line: Line, measures: Measures): boolean {
  return (
    Math.abs(line.size - measures.bodySize) <= 0.6 &&
    line.x1 - line.x0 >= measures.columnWidth * 0.7 &&
    line.mathShare < 0.3 &&
    line.monoShare < 0.5
  );
}

/**
 * The figure or table a caption belongs to: everything between the caption
 * and the text on the far side of it. Figures are captioned below, tables
 * above, so each is looked for on its own side first. The far side is the
 * nearest line of running text in the caption's column — a full line of
 * body text, or the short last line of a paragraph sitting under one — or
 * another caption. What lies between is the figure: its drawings, its
 * axis labels, its legend; or the table: its rules and its cells. A side
 * with nothing on it is not the side the figure is on.
 */
/**
 * The lines a caption runs on to: set under it in its size, each alone on
 * its baseline, starting where it starts or centred where it is. A table's
 * caption is above the table, and without these its second line would be
 * read as the table's first row.
 */
function captionTail(caption: Line, lines: Line[], graphics: GraphicBox[] = []): Line[] {
  const tail: Line[] = [];
  let last = caption;
  const middle = (line: Line) => (line.x0 + line.x1) / 2;
  for (;;) {
    const next = lines
      .filter((line) => line !== last && !line.taken && !line.caption && line.page === caption.page && line.baseline > last.baseline + 0.5 * last.size)
      .filter((line) => overlapX(line, caption) > 0)
      .sort((a, b) => a.baseline - b.baseline)[0];
    if (!next || next.baseline - last.baseline > 1.7 * caption.size || Math.abs(next.size - caption.size) > 0.4) break;
    // Not across a rule drawn under it: an algorithm's caption is ruled off from its steps.
    if (graphics.some((box) => box.y1 - box.y0 < 1.5 && overlapX(box, caption) > 0.5 * (caption.x1 - caption.x0) && box.y0 > last.baseline && box.y1 < next.top + 0.2 * next.size)) break;
    if (Math.abs(next.x0 - caption.x0) > 0.6 * caption.size && Math.abs(middle(next) - middle(caption)) > 0.6 * caption.size) break;
    // Not the first row of a table: nothing else on its baseline.
    if (lines.some((other) => other !== next && !other.taken && Math.abs(other.baseline - next.baseline) < 0.5 * next.size && overlapX(other, caption) > 0)) break;
    tail.push(next);
    last = next;
  }
  return tail;
}

/**
 * Where a paper sets its tables, over their captions or under them: `placed`
 * says, where the paper's own captions with a table on one side only have
 * shown it, and `only` looks on one side alone.
 */
interface TableSide {
  placed?: 'above' | 'below';
  only?: 'above' | 'below';
}

function regionFor(caption: Line, lines: Line[], clusters: Cluster[], measures: Measures, page: PageInput, found: Region[] = [], { placed, only }: TableSide = {}): Region | null {
  const kind = caption.caption!.kind;
  const sides: ('above' | 'below')[] = only ? [only] : kind === 'table' ? [placed === 'above' ? 'above' : 'below', placed === 'above' ? 'below' : 'above'] : ['above', 'below'];
  const tail = lines.filter((line) => line.captionOf === caption);
  const captionBottom = tail.length ? tail[tail.length - 1].bottom : caption.bottom;
  // Another caption's lines are its own, and never running text to measure by.
  const free = lines.filter((line) => line !== caption && !line.taken && !line.captionOf);
  const em = measures.bodySize;
  // Tables or figures set side by side, their captions beside each other:
  // each has its own side of the page, up to halfway to the other's caption.
  const beside = lines.filter((line) => line.caption && line !== caption && Math.abs(line.baseline - caption.baseline) < 3 * em && overlapX(line, caption) <= 0);
  const side0 = Math.max(Number.NEGATIVE_INFINITY, ...beside.filter((line) => line.x1 <= caption.x0).map((line) => (line.x1 + caption.x0) / 2));
  const side1 = Math.min(Number.POSITIVE_INFINITY, ...beside.filter((line) => line.x0 >= caption.x1).map((line) => (caption.x1 + line.x0) / 2));
  const ours = (box: { x0: number; x1: number }) => (box.x0 + box.x1) / 2 > side0 && (box.x0 + box.x1) / 2 < side1;
  // The rules drawn across the page: a table's own, top, bottom and between.
  const rules = page.graphics.filter((box) => box.y1 - box.y0 < 1.5 && box.x1 - box.x0 > 3 * em);

  // An algorithm, or a listing with a caption: ruled off, boxed, or set
  // as bare numbered steps — painted as it is set.
  if (/^(algorithm|listing)/i.test(caption.caption!.label)) {
    const region = algorithmRegion(caption, captionBottom, free, clusters, rules, measures, page);
    if (region) return region;
  }

  // A table captioned beside it, as Springer sets one in the margin: the
  // rule over the table starts a little right of the caption, level with
  // its top, and the table is what the rules of that width enclose — and
  // the note set close under the last of them.
  if (kind === 'table' && !only) {
    const top = rules
      .filter((rule) => rule.x0 >= caption.x1 - 2 && rule.x0 - caption.x1 < 6 * em && Math.abs(rule.y0 - caption.top) < 1.5 * em && rule.x1 - rule.x0 > 8 * em)
      .sort((a, b) => a.x0 - b.x0)[0];
    if (top) {
      const same = rules.filter((rule) => Math.abs(rule.x0 - top.x0) < 3 && Math.abs(rule.x1 - top.x1) < 3 && rule.y0 >= top.y0 - 1);
      const bottom = Math.max(...same.map((rule) => rule.y1));
      const box = { x0: top.x0 - 2, x1: top.x1 + 2 };
      const inside = free.filter((line) => line.x0 >= box.x0 && line.x1 <= box.x1 && line.top >= top.y0 - 1 && line.bottom <= bottom + 1);
      const under = free
        .filter((line) => line.x0 >= box.x0 - em && line.x1 <= box.x1 + em && line.top > bottom && line.size < measures.bodySize - 0.3)
        .sort((a, b) => a.top - b.top);
      const notes: Line[] = [];
      for (const line of under) {
        const above = notes.length ? notes[notes.length - 1].bottom : bottom;
        if (line.top - above > (notes.length ? 1.5 : 2.5) * line.size) break;
        notes.push(line);
      }
      const held = [...inside, ...notes];
      if (inside.length >= 4 && bottom - top.y0 > 2 * em) {
        return {
          kind,
          page: page.index,
          x0: box.x0,
          y0: Math.min(top.y0, ...held.map((line) => line.top)),
          x1: box.x1,
          y1: Math.max(bottom, ...held.map((line) => line.bottom)),
          caption,
          label: caption.caption!.label,
          lines: held,
        };
      }
    }
  }

  // A figure captioned beside it, in the margin: its drawings start a
  // little right of the caption, level with its top, and go on down —
  // panels under panels, however far under the caption they reach.
  if (kind === 'figure' && caption.x1 - caption.x0 < measures.columnWidth * 0.8) {
    const drawn = clusters.filter((cluster) => cluster.images || cluster.bodies);
    const first = drawn
      .filter((cluster) => cluster.x0 >= caption.x1 - 2 && cluster.x0 - caption.x1 < 10 * em && cluster.y0 <= caption.top + 2 * em && cluster.y1 >= caption.top - em)
      .sort((a, b) => a.x0 - b.x0)[0];
    if (first) {
      const box = { x0: first.x0, y0: first.y0, x1: first.x1, y1: first.y1 };
      for (let grew = true; grew; ) {
        grew = false;
        for (const cluster of drawn) {
          const inBox = cluster.x0 >= box.x0 - 1 && cluster.x1 <= box.x1 + 1 && cluster.y0 >= box.y0 - 1 && cluster.y1 <= box.y1 + 1;
          if (inBox || cluster.x0 < caption.x1 - em) continue;
          const near = cluster.y0 <= box.y1 + 3 * em && cluster.y1 >= box.y0 - em && overlapX(cluster, { x0: caption.x1, x1: page.width }) > 0;
          if (!near) continue;
          box.x0 = Math.min(box.x0, cluster.x0);
          box.y0 = Math.min(box.y0, cluster.y0);
          box.x1 = Math.max(box.x1, cluster.x1);
          box.y1 = Math.max(box.y1, cluster.y1);
          grew = true;
        }
      }
      // Its labels: the text inside the box, or just around it, that is not running text.
      const held = free.filter(
        (line) => !line.caption && !bodyLike(line, measures) && line.x0 >= box.x0 - 2 * em && line.x1 <= box.x1 + 2 * em && line.top >= box.y0 - 1.5 * em && line.bottom <= box.y1 + 1.5 * em && line.x0 >= caption.x1 - 2,
      );
      const all = [box, ...held.map((line) => ({ x0: line.x0, y0: line.top, x1: line.x1, y1: line.bottom }))];
      return {
        kind,
        page: page.index,
        x0: Math.min(...all.map((one) => one.x0)),
        y0: Math.min(...all.map((one) => one.y0)),
        x1: Math.max(...all.map((one) => one.x1)),
        y1: Math.max(...all.map((one) => one.y1)),
        caption,
        label: caption.caption!.label,
        lines: held,
      };
    }
  }

  // Where the caption is short, set at its column's edge, its table or
  // figure may sit anywhere across the column — centred, clear of the
  // caption's words: where nothing is found from the caption's own width —
  // the measure for tables set side by side, and for one wider than the
  // text — the search starts again from the column the body text about it fills.
  const around = free.filter((line) => bodyLike(line, measures) && overlapX(line, caption) > 0);
  const column = around.length ? { x0: Math.min(...around.map((line) => line.x0)), x1: Math.max(...around.map((line) => line.x1)) } : null;
  const wide = column && caption.x0 >= column.x0 - em && caption.x1 <= column.x1 + em ? { x0: Math.min(caption.x0, column.x0), x1: Math.max(caption.x1, column.x1) } : null;
  const candidates: { region: Region; gap: number }[] = [];
  for (const [start, side] of [...sides.map((one) => [{ x0: caption.x0, x1: caption.x1 }, one] as const), ...(wide ? sides.map((one) => [wide, one] as const) : [])]) {
    if (start === wide && candidates.length) break;
    let span = start;
    const inSpan = (box: { x0: number; x1: number }) => overlapX(box, span) > 0;
    const body = free.filter((line) => !line.caption && bodyLike(line, measures) && inSpan(line));
    const columnLeft = body.length ? Math.min(...body.map((line) => line.x0)) : caption.x0;
    // The rules a table is drawn between, on this side of the caption:
    // what lies between the first and the last of them is the table's,
    // however it is set — a label for a group of rows, "Our
    // reimplementation (without NSP loss):", set in italics as wide as a
    // line of text, is no return to the text.
    const frame = kind === 'table' ? tableFrame(caption, captionBottom, side, free, rules, measures) : null;
    const inFrame = (line: Line) => Boolean(frame && line.top >= frame.y0 - 1 && line.bottom <= frame.y1 + 1 && line.x0 >= frame.x0 - 2 && line.x1 <= frame.x1 + 2);
    // A line of running text: a full one, or a paragraph's short last
    // line, which is body-sized, starts at the column's edge and sits a
    // line under a full one.
    const wall = (line: Line) => {
      if (line.caption) return true;
      if (inFrame(line)) return false;
      // A line set wholly inside a drawn frame — a panel's title in a
      // diagram, its subtitle as wide as a line of text — is the figure's.
      const framed = clusters.some((cluster) => (cluster.images || cluster.bodies) && line.x0 >= cluster.x0 - 1 && line.x1 <= cluster.x1 + 1 && line.top >= cluster.y0 - 1 && line.bottom <= cluster.y1 + 1);
      if (bodyLike(line, measures)) return !framed;
      // A heading, by its shape or set large and bold, is the text resuming
      // — unless it sits inside the drawings, as a panel's title does.
      const drawnOver = clusters.some((cluster) => overlapX(cluster, line) > 0 && cluster.y0 <= line.bottom && cluster.y1 >= line.top);
      // A bold section number, "A.5", or a line it starts — a heading, its
      // number set an em apart from its title.
      // (A number alone — "71.9" in bold, the best in its column — only
      // where its title follows on the line.)
      const titled = /^(?:[A-Z]|\d{1,2})(?:\.\d{1,2})*\.?\s+\p{Lu}/u.test(line.text);
      const bare =
        /^(?:[A-Z]|\d{1,2})(?:\.\d{1,2})*\.?$/.test(line.text) &&
        lines.some((other) => other !== line && other.allBold && Math.abs(other.baseline - line.baseline) < 0.3 * line.size && other.x0 > line.x1 && other.x0 - line.x1 < 3 * em && /^\p{Lu}\p{Ll}/u.test(other.text));
      // (Or the title itself, its number set apart beside it in the margin
      // of the caption's span: "A.4" / "Compilation Metrics".)
      const numberedBeside =
        line.allBold &&
        /^\p{Lu}/u.test(line.text) &&
        lines.some((other) => other !== line && other.allBold && /^(?:[A-Z]|\d{1,2})(?:\.\d{1,2})*\.?$/.test(other.text) && Math.abs(other.baseline - line.baseline) < 0.3 * line.size && other.x1 <= line.x0 && line.x0 - other.x1 < 3 * em);
      const numbered = line.allBold && (titled || bare || numberedBeside) && line.text.split(' ').length <= 14 && line.size >= measures.bodySize - 0.6;
      if (!drawnOver && (headingLine(line, measures, columnLeft) || numbered || (line.allBold && line.size >= measures.bodySize * 1.1))) return true;
      // A title, or a heading set large: never part of a figure.
      if (line.size >= measures.bodySize * 1.3 && !drawnOver) return true;
      if (Math.abs(line.size - measures.bodySize) > 0.6 || line.x0 > columnLeft + em * 0.3) return false;
      // A paragraph's last line carried over to the head of the page — the
      // page's first line, ending its sentence, alone on its baseline — is
      // the text's, with no full line over it on this page to say so.
      if (/[.!?]["'”’)]?$/.test(line.text) && !free.some((other) => other !== line && (other.bottom <= line.top + 1 || Math.abs(other.baseline - line.baseline) < 0.5 * line.size))) return true;
      return body.some((other) => other.bottom <= line.top + 1 && line.top - other.bottom < line.size * 1.2);
    };
    let far: number;
    if (side === 'above') {
      far = Math.max(0, ...free.filter((line) => inSpan(line) && line.bottom <= caption.top + 1 && wall(line)).map((line) => line.bottom));
    } else {
      const walls = free.filter((line) => inSpan(line) && line.top >= captionBottom - 1 && wall(line));
      far = Math.min(page.height, ...walls.map((line) => line.top));
      // A figure with nothing over its caption is not the table under it,
      // whose own caption is the next thing down.
      const next = walls.find((line) => line.top === far);
      if (kind === 'figure' && next?.caption) continue;
      // A table over a figure ends where the figure's drawings begin: a
      // plot drawn, not pasted in, is paths as a table's rules are, and its
      // tick labels rows of numbers. From the figure's caption up, through
      // its panels, one over another.
      // (Its tick labels may sit between the drawing and the caption: the
      // drawing nearest over the caption is the figure's, however far up.)
      if (kind === 'table' && next?.caption?.kind === 'figure') {
        const drawn = clusters.filter((cluster) => (cluster.images || cluster.bodies) && inSpan(cluster) && cluster.y0 >= captionBottom && cluster.y1 <= far + 1);
        const lowest = drawn.reduce<Cluster | null>((low, cluster) => (!low || cluster.y1 > low.y1 ? cluster : low), null);
        if (lowest) {
          far = lowest.y0;
          for (let grew = true; grew; ) {
            grew = false;
            for (const cluster of drawn) {
              if (cluster.y0 >= far || cluster.y1 < far - 2 * em) continue;
              far = cluster.y0;
              grew = true;
            }
          }
        }
      }
    }
    // Nor does one reach into a figure or a table already found in its way.
    const others = found.filter((region) => overlapX(region, span) > 0);
    if (side === 'above') far = Math.max(far, ...others.filter((region) => region.y1 <= caption.top + 1).map((region) => region.y1));
    else far = Math.min(far, ...others.filter((region) => region.y0 >= captionBottom - 1).map((region) => region.y0));
    // A table ends where a figure's pictures begin, under it or over it.
    if (kind === 'table') {
      const pictures = clusters.filter((cluster) => cluster.images && inSpan(cluster));
      if (side === 'below') far = Math.min(far, ...pictures.filter((cluster) => cluster.y0 >= captionBottom).map((cluster) => cluster.y0));
      else far = Math.max(far, ...pictures.filter((cluster) => cluster.y1 <= caption.top).map((cluster) => cluster.y1));
    }
    const band = side === 'above' ? { y0: far, y1: caption.top } : { y0: captionBottom, y1: far };
    if (band.y1 - band.y0 < em * 0.5) continue;
    const within = (box: { y0: number; y1: number }) => box.y0 >= band.y0 - 2 && box.y1 <= band.y1 + 2;

    // What the band holds, letting a drawing wider than the caption widen
    // the band once so that its labels are found too.
    let members: Cluster[] = [];
    let held: Line[] = [];
    for (let pass = 0; pass < 6; pass += 1) {
      members = clusters.filter((cluster) => inSpan(cluster) && within(cluster) && ours(cluster));
      // A cell on the same row as one already held is held too, however
      // far right the column is.
      // A table as wide as the page, its caption as short as a column,
      // reaches as far as the rules drawn across it.
      // (A rule that starts in the caption's column and runs past it: a
      // table across both columns under a caption in the first.)
      // (And one set across a page with no text on it, an appendix of
      // tables: its rules are the only measure of it, either way.)
      const across = kind === 'table' ? rules.filter((rule) => within(rule) && ((Math.abs(rule.x0 - columnLeft) < 2 * em && rule.x1 > columnLeft + measures.columnWidth + em) || (!body.length && inSpan(rule)))) : [];
      const reach = {
        x0: Math.min(columnLeft, ...members.map((cluster) => cluster.x0), ...across.map((rule) => rule.x0), ...(frame ? [frame.x0] : [])) - em,
        x1: Math.max(columnLeft + measures.columnWidth, span.x1, ...across.map((rule) => rule.x1), ...(frame ? [frame.x1] : [])) + em,
      };
      // Text is only ever held inside the caption's column, or under the
      // drawings: a title or a byline centred across the page overlaps a
      // figure's column without being in it, and widening the figure to
      // take it in would take the other column's text with it.
      const inReach = (line: Line) => line.x0 >= reach.x0 && line.x1 <= reach.x1 && ours(line);
      const onRow = (line: Line) => held.some((other) => Math.abs(other.baseline - line.baseline) < 0.5 * line.size);
      // A figure's labels sit by its drawings; text further off is not the figure's.
      const drawn = kind === 'figure' && members.length ? { y0: Math.min(...members.map((cluster) => cluster.y0)) - 2.5 * em, y1: Math.max(...members.map((cluster) => cluster.y1)) + 2.5 * em } : null;
      const nearDrawing = (line: Line) => !drawn || (line.bottom >= drawn.y0 && line.top <= drawn.y1);
      held = free.filter((line) => !line.caption && !wall(line) && inReach(line) && nearDrawing(line) && (inSpan(line) || onRow(line)) && within({ y0: line.top, y1: line.bottom }));
      const x0 = Math.min(span.x0, ...members.map((cluster) => cluster.x0), ...held.map((line) => line.x0));
      const x1 = Math.max(span.x1, ...members.map((cluster) => cluster.x1), ...held.map((line) => line.x1));
      // The first pass finds the rows; the second, their cells beyond the
      // caption's width; a later one stops when nothing is found.
      if (pass > 0 && x0 === span.x0 && x1 === span.x1) break;
      span = { x0, x1 };
    }
    // Rows of cells: baselines carrying more than one run of text.
    const baselines = new Map<number, number>();
    for (const line of held) baselines.set(round(line.baseline, 2), (baselines.get(round(line.baseline, 2)) || 0) + 1);
    const rows = Array.from(baselines.values()).filter((count) => count >= 2).length;
    const small = held.filter((line) => line.size < measures.bodySize - 0.5).length;
    if (!members.length && rows < 2 && small < 2) continue;

    const boxes = [...members, ...held.map((line) => ({ x0: line.x0, y0: line.top, x1: line.x1, y1: line.bottom }))];
    const region: Region = {
      kind,
      page: page.index,
      x0: Math.min(...boxes.map((box) => box.x0)),
      y0: Math.min(...boxes.map((box) => box.y0)),
      x1: Math.max(...boxes.map((box) => box.x1)),
      y1: Math.max(...boxes.map((box) => box.y1)),
      caption,
      label: caption.caption!.label,
      lines: held,
    };
    // A figure is looked for above its caption first, and taken there.
    if (kind === 'figure') return region;
    candidates.push({ region, gap: side === 'above' ? caption.top - region.y1 : region.y0 - captionBottom });
  }
  // A table's caption may be over it or under it, and papers do both; two
  // tables set one over the other put a caption between them either way.
  // It is the table set nearer it — a table is set close under its caption
  // or close over it, with the space before the next thing.
  // (Not for a side looked at alone, to tell which side a paper sets its tables on.)
  if (!candidates.length) return kind === 'table' && !only ? ruledBox(caption, captionBottom, free, rules, measures, page) : null;
  candidates.sort((a, b) => a.gap - b.gap);
  const [first, second] = candidates;
  // Two tables set one over the other, a caption between them: it is the
  // one on the side the paper sets its tables, unless that is much further off.
  if (second && placed) {
    const wanted = candidates.find((candidate) => (candidate.region.y0 >= captionBottom - 1 ? 'below' : 'above') === placed);
    if (wanted && wanted.gap - Math.min(first.gap, second.gap) < 2 * em) return wanted.region;
  }
  if (second && sides[0] === (second.region.y0 >= captionBottom - 1 ? 'below' : 'above') && second.gap - first.gap < 0.5 * em) return second.region;
  return first.region;
}

/**
 * An algorithm's steps, by its caption, in the three ways algorithm
 * packages set them: ruled — the caption between two rules, the steps under
 * them as far as the rule that closes them (algorithmic's "ruled",
 * algorithm2e's "ruled" and "algoruled"); boxed — the steps in a frame
 * drawn round them, the caption over or under it, or inside its top or its
 * foot (algorithm2e's "boxed"); and plain — no rules at all, the caption
 * over or under steps set tight one under another, numbered, led by a
 * keyword in bold, or set in from the column (algorithm2e's "plain").
 */
function algorithmRegion(caption: Line, captionBottom: number, free: Line[], clusters: Cluster[], rules: GraphicBox[], measures: Measures, page: PageInput): Region | null {
  const em = measures.bodySize;
  const kind = caption.caption!.kind;
  const make = (box: Box, held: Line[]): Region => ({ kind, page: page.index, ...box, caption, label: caption.caption!.label, lines: held });
  const inside = (box: Box, line: Line) => line.top >= box.y0 - 1 && line.bottom <= box.y1 + 1 && line.x0 >= box.x0 - 2 && line.x1 <= box.x1 + 2;
  const steps = (lines: Line[]) => lines.filter((line) => !line.caption);

  // Ruled.
  const across = (rule: GraphicBox) => rule.x1 - rule.x0 > 8 * em && overlapX(rule, caption) > 0.8 * (caption.x1 - caption.x0);
  const under = rules.filter((rule) => across(rule) && rule.y0 >= captionBottom - 2 && rule.y0 - captionBottom < 1.5 * em).sort((a, b) => a.y0 - b.y0)[0];
  const closing = under && rules.filter((rule) => Math.abs(rule.x0 - under.x0) < 3 && Math.abs(rule.x1 - under.x1) < 3 && rule.y0 > under.y1 + em).sort((a, b) => a.y0 - b.y0)[0];
  if (under && closing) {
    const box = { x0: under.x0, y0: under.y1 + 2, x1: under.x1, y1: closing.y1 };
    const held = steps(free.filter((line) => inside({ ...box, x0: box.x0 - em, x1: box.x1 + em }, line)));
    if (held.length) return make(box, held);
  }

  // Boxed: a frame of rules, or a shaded box, with text in it, set close
  // over or under the caption — or with the caption inside it.
  const framed = clusters
    .filter((cluster) => !cluster.images && (cluster.rules >= 2 || cluster.bodies) && overlapX(cluster, caption) > 0.5 * (caption.x1 - caption.x0))
    .filter((cluster) => {
      const over = cluster.y1 <= caption.top + 2 && caption.top - cluster.y1 < 2 * em;
      const beneath = cluster.y0 >= captionBottom - 2 && cluster.y0 - captionBottom < 2 * em;
      const holds = cluster.y0 <= caption.top + 1 && cluster.y1 >= captionBottom - 1 && cluster.x0 <= caption.x0 + 1 && cluster.x1 >= caption.x1 - 1;
      return over || beneath || holds;
    })
    .sort((a, b) => Math.min(Math.abs(a.y1 - caption.top), Math.abs(a.y0 - captionBottom)) - Math.min(Math.abs(b.y1 - caption.top), Math.abs(b.y0 - captionBottom)));
  for (const cluster of framed) {
    let box: Box = { x0: cluster.x0, y0: cluster.y0, x1: cluster.x1, y1: cluster.y1 };
    // The caption inside the frame, at its top or its foot: the steps are the rest of it.
    if (box.y0 <= caption.top + 1 && box.y1 >= captionBottom - 1) box = caption.top - box.y0 < box.y1 - captionBottom ? { ...box, y0: captionBottom + 1 } : { ...box, y1: caption.top - 1 };
    const held = steps(free.filter((line) => inside(box, line)));
    if (held.length >= 2) return make(box, held);
  }

  // Plain: the steps set tight over the caption, or under it — numbered
  // ("3:", "3."), led by a keyword in bold ("while", "Input:"), or set in
  // from the column — as far as a line of the text resuming.
  const stepLike = (line: Line, left: number) => /^\d{1,3}[:.]?(?:\s|$)/.test(line.text) || boldAt(line, 'start') || line.x0 - left > 0.5 * em || !bodyLike(line, measures);
  for (const side of ['above', 'below'] as const) {
    const near = (box: { x0: number; x1: number }) => overlapX(box, caption) > 0 || overlapX(box, { x0: caption.x0 - measures.columnWidth * 0.2, x1: caption.x0 + measures.columnWidth }) > 0;
    const candidates = free
      .filter((line) => !line.caption && near(line) && (side === 'above' ? line.bottom <= caption.top + 1 : line.top >= captionBottom - 1))
      .sort((a, b) => (side === 'above' ? b.baseline - a.baseline : a.baseline - b.baseline));
    // Lines on one baseline — a step's number set apart from it — are one row.
    const rows: Line[][] = [];
    for (const line of candidates) {
      const row = rows.find((one) => Math.abs(one[0].baseline - line.baseline) < 0.5 * line.size);
      if (row) row.push(line);
      else rows.push([line]);
    }
    const held: Line[] = [];
    let edge = side === 'above' ? caption.top : captionBottom;
    let numbered = 0;
    for (const row of rows) {
      const top = Math.min(...row.map((line) => line.top));
      const bottom = Math.max(...row.map((line) => line.bottom));
      const gap = side === 'above' ? edge - bottom : top - edge;
      if (gap > (held.length ? 0.9 : 1.6) * em) break;
      const first = row.slice().sort((a, b) => a.x0 - b.x0)[0];
      const left = Math.min(first.x0, caption.x0);
      if (!stepLike(first, left)) break;
      if (/^\d{1,3}[:.]?(?:\s|$)/.test(first.text)) numbered += 1;
      held.push(...row);
      edge = side === 'above' ? top : bottom;
    }
    // Steps, not a paragraph that happens to sit by the caption: more than
    // one, most of them numbered or led by a keyword.
    if (held.length >= 2 && (numbered >= 2 || held.filter((line) => boldAt(line, 'start')).length >= 2)) {
      return make({ x0: Math.min(...held.map((line) => line.x0)), y0: Math.min(...held.map((line) => line.top)), x1: Math.max(...held.map((line) => line.x1)), y1: Math.max(...held.map((line) => line.bottom)) }, held);
    }
  }
  return null;
}

/**
 * The rules a table is drawn between, on one side of its caption: the
 * nearest rule as wide as a table's on that side, with no line of text
 * between it and the caption, and the rules of the same width stacked
 * beyond it with nothing but the table's own lines between them — no
 * caption, no heading, nothing wider than the rules. The box they
 * enclose, or null where there is no such rule.
 */
function tableFrame(caption: Line, captionBottom: number, side: 'above' | 'below', free: Line[], rules: GraphicBox[], measures: Measures): Box | null {
  const em = measures.bodySize;
  const wide = rules.filter((rule) => rule.x1 - rule.x0 > 8 * em && overlapX(rule, caption) > 0);
  const tail = free.filter((line) => line.captionOf === caption);
  const text = (y0: number, y1: number, x: { x0: number; x1: number }) => free.filter((line) => line !== caption && !tail.includes(line) && line.bottom > y0 + 1 && line.top < y1 - 1 && overlapX(line, x) > 0);
  const edge =
    side === 'above'
      ? wide.filter((rule) => rule.y1 <= caption.top + 1 && caption.top - rule.y1 < 5 * em).sort((a, b) => b.y0 - a.y0)[0]
      : wide.filter((rule) => rule.y0 >= captionBottom - 1 && rule.y0 - captionBottom < 5 * em).sort((a, b) => a.y0 - b.y0)[0];
  if (!edge) return null;
  // Nothing but the caption's own lines between the rule and the caption.
  if (text(side === 'above' ? edge.y1 : captionBottom, side === 'above' ? caption.top : edge.y0, edge).some((line) => bodyLike(line, measures) || line.caption)) return null;
  const inside = (line: Line) => line.x0 >= edge.x0 - 2 && line.x1 <= edge.x1 + 2;
  const heading = (line: Line) => (line.allBold && line.size >= em * 1.1) || headingLine(line, measures, line.x0);
  const stack = wide
    .filter((rule) => rule !== edge && Math.abs(rule.x0 - edge.x0) < 3 && Math.abs(rule.x1 - edge.x1) < 3 && (side === 'above' ? rule.y1 < edge.y0 : rule.y0 > edge.y1))
    .sort((a, b) => (side === 'above' ? b.y0 - a.y0 : a.y0 - b.y0));
  let far = edge;
  for (const rule of stack) {
    const [y0, y1] = side === 'above' ? [rule.y1, far.y0] : [far.y1, rule.y0];
    if (y1 - y0 > 25 * em) break;
    if (text(y0, y1, edge).some((line) => line.caption || line.captionOf || heading(line) || !inside(line))) break;
    far = rule;
  }
  if (far === edge) return null;
  return { x0: edge.x0, y0: Math.min(far.y0, edge.y0), x1: edge.x1, y1: Math.max(far.y1, edge.y1) };
}

/**
 * A table that is a box of text between rules — an example prompt, its
 * options under a rule of their own, captioned "Table 18 | An example of
 * AGIEval" — whose lines, as wide as the text's, were taken for running
 * text: from the rule set close by the caption, through the rules drawn
 * as wide as it, as far as a caption, a heading, or a line wider than the
 * box. Not the rules of the page's head or foot.
 */
function ruledBox(caption: Line, captionBottom: number, free: Line[], rules: GraphicBox[], measures: Measures, page: PageInput): Region | null {
  const em = measures.bodySize;
  const wide = rules.filter((rule) => rule.x1 - rule.x0 > 8 * em && rule.x0 <= caption.x1 && rule.x1 >= caption.x0 && rule.y0 > page.height * 0.08 && rule.y1 < page.height * 0.92);
  const over = wide.filter((rule) => rule.y1 <= caption.top + 1 && caption.top - rule.y1 < 2.5 * em).sort((a, b) => b.y0 - a.y0)[0];
  const under = wide.filter((rule) => rule.y0 >= captionBottom - 1 && rule.y0 - captionBottom < 2.5 * em).sort((a, b) => a.y0 - b.y0)[0];
  const heading = (line: Line) => (line.allBold && line.size >= em * 1.1) || headingLine(line, measures, line.x0);
  for (const [edge, away] of [[over, -1], [under, 1]] as const) {
    if (!edge) continue;
    const inside = (line: Line) => line.x0 >= edge.x0 - 2 && line.x1 <= edge.x1 + 2;
    const stack = wide
      .filter((rule) => rule !== edge && Math.abs(rule.x0 - edge.x0) < 3 && Math.abs(rule.x1 - edge.x1) < 3 && (away < 0 ? rule.y1 < edge.y0 : rule.y0 > edge.y1))
      .sort((a, b) => (away < 0 ? b.y0 - a.y0 : a.y0 - b.y0));
    let far = edge;
    for (const rule of stack) {
      const [y0, y1] = away < 0 ? [rule.y1, far.y0] : [far.y1, rule.y0];
      const between = free.filter((line) => line !== caption && line.bottom > y0 && line.top < y1 && overlapX(line, edge) > 0);
      if (between.some((line) => line.caption || line.captionOf || heading(line) || !inside(line))) break;
      far = rule;
    }
    if (far === edge) continue;
    const y0 = Math.min(far.y0, edge.y0);
    const y1 = Math.max(far.y1, edge.y1);
    if (y1 - y0 > page.height * 0.85) continue;
    const held = free.filter((line) => line !== caption && !line.caption && line.top >= y0 - 1 && line.bottom <= y1 + 1 && inside(line));
    if (!held.length) continue;
    return { kind: 'table', page: page.index, x0: edge.x0, y0, x1: edge.x1, y1, caption, label: caption.caption!.label, lines: held, box: true };
  }
  return null;
}

/**
 * A box of text as a table of one column: each part between two rules a
 * row, a label over it set bold — "PROMPT", "OPTIONS" — a heading row of its
 * own, and its lines broken where the box breaks them: an option a line,
 * "Q:" and "A:" each on theirs; text run on runs on.
 */
function boxRows(lines: Line[], rules: TableRule[]): TableCell[][] {
  const ordered = lines.slice().sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
  const parts: Line[][] = [];
  for (const line of ordered) {
    const last = parts[parts.length - 1];
    const previous = last?.[last.length - 1];
    const ruled = previous && rules.some((rule) => rule.y > previous.baseline && rule.y < line.top);
    if (!last || ruled) parts.push([line]);
    else last.push(line);
  }
  const right = Math.max(...lines.map((line) => line.x1));
  const left = Math.min(...lines.map((line) => line.x0));
  const rows: TableCell[][] = [];
  for (const part of parts) {
    let body = part;
    const label = part[0].allBold && part[0].text.split(' ').length <= 4 && part.length > 1 ? part[0] : null;
    if (label) {
      rows.push([{ spans: spansOf([label], true), head: true }]);
      body = part.slice(1);
    }
    let spans: Span[] = [];
    body.forEach((line, index) => {
      const next = spansOf([line], false, true);
      if (!index) {
        spans = next;
        return;
      }
      const before = body[index - 1];
      // A line stopping short of the box, a blank line's space over the next,
      // or the next set as an item of its own: the line is broken there.
      const short = before.x1 < right - 0.15 * (right - left);
      const gap = line.baseline - before.baseline > 1.6 * line.size;
      // (Not "- 3 girls = 7": a sum run on to the line.)
      const item = /^(?:[-•–]\s(?!\d)|[A-Z]\s*[:.)]\s|Q:|A:|\(?[a-z0-9]\)\s)/.test(line.text);
      // (A blank line's space kept as one: the examples of a prompt set apart.)
      spans = cellTurnover(spans, gap ? [{ text: '\n' }, ...next] : next, short || gap || item);
    });
    if (spans.length) rows.push([{ spans }]);
  }
  return rows;
}

/** The figures and tables on a page, by their captions, the lines inside them taken from the flow. */
function captionRegions(lines: Line[], clusters: Cluster[], measures: Measures, page: PageInput, placed?: 'above' | 'below', probe?: (caption: Line) => void): Region[] {
  const regions: Region[] = [];
  for (const line of lines) {
    if (!line.caption || line.taken) continue;
    if (probe && line.caption!.kind === 'table') {
      probe(line);
      continue;
    }
    const region = regionFor(line, lines, clusters, measures, page, regions, { placed });
    if (!region) continue;
    regions.push(region);
    for (const held of region.lines) held.taken = true;
  }
  return regions;
}

/**
 * Whether the paper sets its tables over their captions or under them, by
 * the captions that have a table on one side only. Where two tables are
 * set one over the other, the caption between them is the one that side's.
 */
function tablesPlaced(pages: Line[][], inputs: PageInput[], measures: Measures): 'above' | 'below' | undefined {
  const votes = { above: 0, below: 0 };
  for (const [at, lines] of pages.entries()) {
    if (!lines.some((line) => line.caption?.kind === 'table' && !line.taken)) continue;
    const page = inputs[at];
    const clusters = clusterGraphics(page);
    const was = new Set(lines.filter((line) => line.taken));
    const found: Region[] = [];
    captionRegions(lines, clusters, measures, page, undefined, (caption) => {
      const above = regionFor(caption, lines, clusters, measures, page, found, { only: 'above' });
      const below = regionFor(caption, lines, clusters, measures, page, found, { only: 'below' });
      if (above && !below) votes.above += 1;
      else if (below && !above) votes.below += 1;
    });
    for (const line of lines) line.taken = was.has(line);
  }
  if (votes.above > votes.below) return 'above';
  if (votes.below > votes.above) return 'below';
  return undefined;
}

/**
 * Display mathematics is set apart: a line numbered "(3)" at the column's
 * right edge, or a line mostly in a mathematics font, and the lines set
 * tight above and below it that a fraction or a sum spreads over.
 */
function equationRegions(lines: Line[], clusters: Cluster[], measures: Measures, page: PageInput): Region[] {
  const regions: Region[] = [];
  const free = () => lines.filter((line) => !line.taken && !line.caption);
  // "(3)", "(S2)", "(4a)", "(2.1)": a number of one to three digits —
  // "(2019)" at the end of a citation, cut from its line by a wide
  // justified space, is a year.
  const isNumber = (line: Line) => /^\(\s*[A-Z]?\d{1,3}[a-z]?\s*\)$/.test(line.text) || /^\(\s*\d{1,2}\.\d{1,3}\s*\)$/.test(line.text);
  const columnLeftOf = (line: Line) => {
    const peers = lines.filter((other) => !other.taken && bodyLike(other, measures) && overlapX(other, line) > 0);
    return peers.length ? Math.min(...peers.map((other) => other.x0)) : line.x0;
  };
  const seeds = free().filter((line) => {
    if (isNumber(line)) return true;
    if (line.mathShare < 0.4 || line.x1 - line.x0 >= measures.columnWidth * 0.9) return false;
    // Set apart from the text: indented, or centred, and more than a
    // stray symbol.
    if (line.text.replace(/\s/g, '').length < 3) return false;
    return line.x0 - columnLeftOf(line) > line.size * 1.2;
  });
  // A numbered equation is the surer seed, and carries the label.
  seeds.sort((a, b) => Number(isNumber(b)) - Number(isNumber(a)));
  for (const seed of seeds) {
    if (seed.taken) continue;
    let label = '';
    let box = { x0: seed.x0, y0: seed.top, x1: seed.x1, y1: seed.bottom };
    if (isNumber(seed)) {
      label = seed.text;
      // The number sits at the right edge of the column; the formula is to
      // its left on the same baseline, and there must be one.
      const left = columnLeftOf(seed) - measures.bodySize;
      const same = free().filter((line) => line !== seed && Math.abs(line.baseline - seed.baseline) <= seed.size && line.x1 <= seed.x0 + 2 && line.x0 >= left && seed.x0 - line.x1 < measures.columnWidth);
      if (!same.length) continue;
      if (same.some((line) => bodyLike(line, measures))) continue;
      for (const line of same) box = { x0: Math.min(box.x0, line.x0), y0: Math.min(box.y0, line.top), x1: Math.max(box.x1, line.x1), y1: Math.max(box.y1, line.bottom) };
    }
    // The equation stays in its column: the lines beside it in the next
    // column over — an abstract in a smaller size, a table's cells — are
    // not body text either, and are not the equation's.
    const home = columnLeftOf(seed);
    const columnLeft = Math.min(box.x0, home) - measures.bodySize;
    const columnRight = Math.max(box.x1, home + measures.columnWidth) + measures.bodySize;
    const members = new Set<Line>([seed]);
    // A line of a display is as tall as its largest glyphs, however many of
    // its letters are scripts — "𝑀 = 72 𝑛layer 𝑑²model", set mostly in the
    // size of "layer" and "model".
    const reach = (line: Line) => {
      const tall = Math.max(line.size, ...line.runs.filter((run) => !run.fraction).map((run) => run.size));
      return { top: Math.min(line.top, line.baseline - 0.8 * tall), bottom: Math.max(line.bottom, line.baseline + 0.22 * tall) };
    };
    let grew = true;
    while (grew) {
      grew = false;
      for (const line of free()) {
        if (members.has(line) || line.caption) continue;
        if (line.x0 < columnLeft || line.x1 > columnRight) continue;
        if (bodyLike(line, measures)) continue;
        if (overlapX(line, { x0: box.x0 - 30, x1: box.x1 + 30 }) <= 0) continue;
        const { top, bottom } = reach(line);
        const gap = top > box.y1 ? top - box.y1 : bottom < box.y0 ? box.y0 - bottom : 0;
        if (gap > seed.size * 0.9) continue;
        // A line that is words rather than symbols, sitting just under the
        // formula, is the paragraph carrying on ("where x is ...").
        if (line.mathShare < 0.2 && /^[A-Za-z][a-z]+\s+[a-z]/.test(line.text) && line.x1 - line.x0 > measures.columnWidth * 0.5) continue;
        // Nor is a sentence, whatever it is set in, nor the short last line
        // of the paragraph above — words, at the column's edge, where a
        // display is never set.
        const wordy = (line.text.match(/\p{L}{2,}/gu) || []).length;
        if (line.mathShare < 0.15 && wordy >= 6) continue;
        if (line.mathShare < 0.1 && wordy >= 2 && Math.abs(line.x0 - home) < line.size * 0.3) continue;
        // Nor a line of text heavy with inline mathematics — "layer. W1, W2 ∈
        // R^(dhidden×dmodel), where …" — which fills the column from its edge
        // as no display does.
        if (wordy >= 2 && Math.abs(line.x0 - home) < line.size * 0.3 && line.x1 - line.x0 > 0.9 * measures.columnWidth) continue;
        members.add(line);
        box = { x0: Math.min(box.x0, line.x0), y0: Math.min(box.y0, top), x1: Math.max(box.x1, line.x1), y1: Math.max(box.y1, bottom) };
        grew = true;
      }
    }
    // Fraction bars and radicals are drawn, not typed.
    for (const cluster of clusters) {
      if (cluster.images || cluster.bodies) continue;
      if (cluster.x0 >= box.x1 || cluster.x1 <= box.x0 || cluster.y0 >= box.y1 + 3 || cluster.y1 <= box.y0 - 3) continue;
      box = { x0: Math.min(box.x0, cluster.x0), y0: Math.min(box.y0, cluster.y0), x1: Math.max(box.x1, cluster.x1), y1: Math.max(box.y1, cluster.y1) };
    }
    const region: Region = { kind: 'equation', page: page.index, ...box, label: label ? `Equation ${label}` : 'Equation', lines: Array.from(members) };
    for (const line of members) line.taken = true;
    regions.push(region);
  }
  return regions;
}

// ----------------------------------------------------------------- order --

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Reading order, by recursive XY-cut: the lines of a page are split at the
 * widest band of white space that runs right through them — a vertical
 * band being the gutter between two columns, a horizontal one the gap
 * under a title or above a footnote — and each side is ordered the same
 * way, left before right, top before bottom. A gutter counts for more than
 * a gap of the same width, because gutters are narrow and the gaps around
 * a full-width title are not, and it is the title gap that must be cut
 * first for the columns under it to be found.
 */
export function readingOrder<T extends Box>(boxes: T[], minGap = 1): T[] {
  if (boxes.length <= 1) return boxes.slice();
  const x0 = Math.min(...boxes.map((box) => box.x0));
  const x1 = Math.max(...boxes.map((box) => box.x1));
  const y0 = Math.min(...boxes.map((box) => box.y0));
  const y1 = Math.max(...boxes.map((box) => box.y1));

  const gaps = (axis: 'x' | 'y') => {
    const spans = boxes
      .map((box) => (axis === 'x' ? [box.x0, box.x1] : [box.y0, box.y1]))
      .sort((a, b) => a[0] - b[0]);
    const found: { at: number; width: number }[] = [];
    let reach = spans[0][1];
    for (const [start, end] of spans.slice(1)) {
      if (start - reach >= minGap) found.push({ at: (start + reach) / 2, width: start - reach });
      reach = Math.max(reach, end);
    }
    return found;
  };
  const vertical = gaps('x').filter((gap) => gap.at > x0 && gap.at < x1);
  const horizontal = gaps('y').filter((gap) => gap.at > y0 && gap.at < y1);
  const bestV = vertical.reduce<{ at: number; width: number } | null>((best, gap) => (!best || gap.width > best.width ? gap : best), null);
  const bestH = horizontal.reduce<{ at: number; width: number } | null>((best, gap) => (!best || gap.width > best.width ? gap : best), null);
  if (!bestV && !bestH) return boxes.slice().sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

  const useVertical = bestV && (!bestH || bestV.width * 3 >= bestH.width);
  if (useVertical) {
    const left = boxes.filter((box) => (box.x0 + box.x1) / 2 < bestV!.at);
    const right = boxes.filter((box) => (box.x0 + box.x1) / 2 >= bestV!.at);
    return [...readingOrder(left, minGap), ...readingOrder(right, minGap)];
  }
  // Cut at the topmost horizontal gap rather than the widest, so a page is
  // read in strips from the top and a title never ends up after the text —
  // of the gaps wide enough to be cut before the gutter: not the space
  // between two lines of one column where the column beside it has ended.
  const topmost = horizontal.filter((gap) => !bestV || gap.width > bestV.width * 3).reduce((best, gap) => (gap.at < best.at ? gap : best));
  const above = boxes.filter((box) => (box.y0 + box.y1) / 2 < topmost.at);
  const below = boxes.filter((box) => (box.y0 + box.y1) / 2 >= topmost.at);
  return [...readingOrder(above, minGap), ...readingOrder(below, minGap)];
}

// ------------------------------------------------------------ paragraphs --

interface Paragraph {
  lines: Line[];
  page: number;
  /** The left edge of the column the paragraph sits in. */
  columnLeft: number;
  region?: Region;
}

// A dash set against its item with no space — "—We provide…", as ACM's
// itemize sets them — is a bullet too; a hyphen is one only with a space after it.
const BULLET = /^(?:[•◦▪■●○◆◇►▸‣⁃–—-]\s+\S|[–—](?=\p{Lu}))/u;
const NUMBERED = /^(\(?\d{1,2}[.)]|\(?[a-z][.)]|\(?[ivx]{1,4}[.)])\s+\S/i;

/**
 * Lines into paragraphs. A new paragraph begins at a change of size or
 * face, at a gap wider than a line, at an indented first line, and — in
 * justified text — after a line that stopped short of the column's edge.
 */
const REFERENCES = /^(\d+(\.\d+)*\.?\s+)?(references|bibliography|literature cited)\s*$/i;

/** A line set in typewriter type, all but a stray glyph: a line of a listing, or of an address. */
const codeLine = (line: Line): boolean => line.monoShare >= 0.85 && line.text.trim().length >= 1 && !line.caption && !line.captionOf;

/**
 * Lines in typewriter type that are a listing — code, a prompt — and not
 * an address or a name set on a line of its own: more than one line of it,
 * or one set in from the column, or one that reads as code.
 */
function isListing(lines: Line[], columnLeft: number, measures: Measures): boolean {
  if (!lines.length || !lines.every(codeLine)) return false;
  if (lines.length >= 2) return true;
  const [line] = lines;
  // (An address — "{jqiu, zchen}@nju.edu.cn" included — is not code.)
  if (/^(?:https?:\/\/|www\.)\S+$|@[\w-]+(?:\.[\w-]+)+$/.test(line.text.trim())) return false;
  return line.x0 - columnLeft > 0.5 * measures.bodySize || /[=;{}()[\]#]|\/\//.test(line.text);
}

/** Whether the line's first, or last, run of letters is set bold. */
function boldAt(line: Line, side: 'start' | 'end'): boolean {
  const worded = line.runs.filter((run) => /\p{L}{2}/u.test(run.str));
  const run = side === 'start' ? worded[0] : worded[worded.length - 1];
  return Boolean(run?.bold);
}

function paragraphs(ordered: Line[], measures: Measures, columns: Map<Line, number>, references: boolean): Paragraph[] {
  const out: Paragraph[] = [];
  let current: Paragraph | null = null;
  for (const line of ordered) {
    // A line that is the one word, capitalised, is the heading however it is
    // set: not every style sets it bold or large, and the lines under it are
    // entries with hanging indents rather than paragraphs.
    if (REFERENCES.test(line.text) && (line.allBold || line.size > measures.bodySize || /^[\d.\s]*[A-Z]/.test(line.text))) references = true;
    const columnLeft = columns.get(line) ?? line.x0;
    const previous = current?.lines[current.lines.length - 1];
    let fresh = !current || !previous;
    if (current && previous) {
      const pitch = line.baseline - previous.baseline;
      const em = Math.max(line.size, previous.size);
      const listItem = BULLET.test(current.lines[0].text) || NUMBERED.test(current.lines[0].text);
      const headed = [headingLine(previous, measures, current.columnLeft), headingLine(line, measures, columnLeft)];
      if (line.subheading || previous.subheading) fresh = true;
      else if (line.captionOf && current.lines.includes(line.captionOf)) fresh = false;
      // A caption starts a paragraph of its own, even beside another on its
      // baseline: "Table 8: …" and "Table 9: …" set side by side.
      else if (line.caption) fresh = true;
      // Same baseline: one line split by a gap — a heading's number an em
      // from its title, "A.1   One-shot vs. …", included.
      else if (Math.abs(line.baseline - previous.baseline) < em * 0.5 && line.page === previous.page && line.x0 > previous.x0) fresh = false;
      // A listing — code, or a prompt set in typewriter type — is one block
      // of lines, however they are indented or end, until the text resumes
      // in its own type or a blank line's space or more parts it from the next.
      else if (!references && codeLine(line) && current.lines.every(codeLine)) fresh = pitch < 0 || pitch > em * 2.4 || Math.abs(current.columnLeft - columnLeft) > 3 * em;
      else if (!references && current.lines.every(codeLine) && isListing(current.lines, current.columnLeft, measures)) fresh = true;
      // One starts where a line in typewriter type is set in from the
      // column, or after a line ending in a colon, or with space over it.
      else if (!references && codeLine(line) && (line.x0 - columnLeft > 0.5 * em || /:$/.test(previous.text) || pitch > 1.4 * measures.pitch)) fresh = true;
      // A heading is a paragraph of its own — two lines of one, set tight, still one.
      else if (headed[0] || headed[1]) fresh = !(headed[0] && headed[1] && line.baseline - previous.baseline > 0 && line.baseline - previous.baseline < 1.5 * Math.max(line.size, previous.size));
      // (A reference's lines hang an indent from its first: one column still.)
      else if (current.columnLeft !== columnLeft && !(references && Math.abs(current.columnLeft - columnLeft) < 3 * em)) fresh = true;
      else if (pitch < 0 || pitch > em * 1.9) fresh = true;
      // Space between paragraphs rather than an indent: a line set further
      // under one that stopped short than the text's lines are set apart.
      else if (Math.abs(line.size - measures.bodySize) <= 0.6 && Math.abs(previous.size - measures.bodySize) <= 0.6 && pitch > 1.3 * measures.pitch && previous.x1 < Math.max(columnLeft + measures.columnWidth, ...current.lines.map((one) => one.x1)) - 0.6 * em) fresh = true;
      else if (line.caption || previous.caption) fresh = Boolean(line.caption);
      else if (Math.abs(line.size - previous.size) > 0.6) fresh = true;
      // A change of face starts a paragraph — not a run-in heading, bold to
      // the end of a full line, whose sentence carries on in roman.
      // (Nor where a bold phrase runs over the break — "Security and privacy →
      // Software" / "and application security" — the line before ending in
      // bold and this one beginning in it.)
      else if (
        line.allBold !== previous.allBold &&
        /\w{3}/.test(line.text) &&
        /\w{3}/.test(previous.text) &&
        !(previous.allBold && previous.x1 >= columnLeft + measures.columnWidth - em && !/[.:!?]$/.test(previous.text)) &&
        !(boldAt(previous, 'end') && boldAt(line, 'start') && previous.x1 >= columnLeft + measures.columnWidth - em)
      )
        fresh = true;
      // Two bold headings one over the other — an appendix's title, then
      // its first section's — are set further apart than a heading's own lines.
      else if (previous.allBold && line.allBold && pitch > 1.5 * em) fresh = true;
      // A bold heading's second line — "4.2 Model Input Format and Next
      // Sentence" / "Prediction" — is set tight under it, hung in from the
      // edge, with no stop between: the heading goes on.
      else if (
        previous.allBold &&
        line.allBold &&
        previous.size >= measures.bodySize - 0.6 &&
        !/[.!?:;]$/.test(previous.text) &&
        pitch < 1.6 * em &&
        line.x0 - columnLeft < 4 * em &&
        line.x1 - line.x0 < measures.columnWidth * 0.9 &&
        !BULLET.test(line.text) &&
        /^\p{Lu}/u.test(line.text) &&
        /^(?:[A-Z]|\d{1,2})(?:\.\d{1,2})*\.?\s+\S/.test(previous.text)
      )
        fresh = false;
      else if (listItem) {
        // An item set as a paragraph — its bullet indented, its lines turning
        // over to the column's edge — runs on while the line before it runs
        // to the edge; one set with a hanging indent, at that indent.
        const edge = Math.max(columnLeft + measures.columnWidth, ...current.lines.map((one) => one.x1));
        const flush = current.lines.slice(1).every((one) => one.x0 - columnLeft < em * 0.3);
        const turned = flush && current.lines[0].x0 - columnLeft >= em * 0.3 && previous.x1 >= edge - em;
        // A paragraph that only opens with a number — "1. Fixed-width
        // columns. The compiler needs…", its run-in heading in bold — turns over to
        // the column's edge, the number flush with it: after a full line —
        // to the column's edge, though a line of code overran it — the text
        // runs on.
        const numberedParagraph = flush && current.lines[0].x0 - columnLeft < em * 0.3 && previous.x1 >= Math.min(edge, columnLeft + measures.columnWidth) - em;
        fresh = BULLET.test(line.text) || NUMBERED.test(line.text) || (line.x0 - columnLeft < em * 0.3 && !turned && !numberedParagraph);
      }
      else if (references) {
        // Hanging indents: an entry starts at the left, its turnover lines
        // are indented; or entries are numbered "[12]".
        const left = Math.min(columnLeft, current.columnLeft);
        const indented = line.x0 - left > em * 0.5;
        const previousIndented = previous.x0 - left > em * 0.5;
        if (/^\[\d+\]/.test(line.text)) fresh = true;
        else if (!indented && previousIndented) fresh = true;
        else if (indented && !previousIndented && current.lines.length > 1) fresh = false;
      } else if (BULLET.test(line.text) || (NUMBERED.test(line.text) && line.x0 - columnLeft > em * 0.3)) fresh = true;
      else if (line.x0 - Math.min(columnLeft, current.lines[0].x0) > em * 0.7 && !(previous.x0 - columnLeft > em * 0.7)) fresh = true;
      // A run-in heading at the start of a line, after a sentence ended —
      // a structured abstract's "Summary", in bold, its text going on in
      // roman — starts a paragraph however full the line before it is.
      else if (runInHeading(line) && /[.!?]["'”’)]?$/.test(previous.text) && !previous.allBold) fresh = true;
      // Justified text: only a paragraph's last line stops short — one of
      // body text, or a shorter one ending its sentence ("…on the values.").
      // Short of the paragraph's own edge: an abstract set across both
      // columns of a two-column paper is wider than a column.
      else if (
        measures.justified &&
        previous.x1 < Math.max(columnLeft + measures.columnWidth, ...current.lines.map((one) => one.x1)) - em * 0.6 &&
        line.x0 <= columnLeft + em * 0.3 &&
        (bodyLike(previous, measures) ||
          (Math.abs(previous.size - measures.bodySize) <= 0.6 && previous.mathShare < 0.3 && current.lines.length > 1 && /[\p{Ll}\d)\]][.!?]["'”’)]?$/u.test(previous.text) && /^[\p{Lu}“"(]/u.test(line.text)))
      )
        fresh = true;
    }
    if (fresh) {
      current = { lines: [line], page: line.page, columnLeft };
      out.push(current);
    } else {
      current!.lines.push(line);
    }
  }
  return out;
}

// ---------------------------------------------------------------- spans ---

/**
 * A run of lines as spans of text in their faces. A face the whole line is
 * set in is the paragraph's, and left unmarked — a bold abstract is not
 * bold words — unless `keepFace`, as in a table, where a bold cell is the
 * best result in its column.
 */
function spansOf(lines: Line[], heading = false, keepFace = false): Span[] {
  const spans: Span[] = [];
  // The paragraph's own face: every line of it bold, or every line italic.
  const allBold = lines.every((line) => line.allBold);
  const allItalic = lines.every((line) => line.allItalic);
  const push = (span: Span) => {
    const last = spans[spans.length - 1];
    if (last && !!last.bold === !!span.bold && !!last.italic === !!span.italic && !!last.mono === !!span.mono && !!last.sup === !!span.sup && !!last.sub === !!span.sub && last.href === span.href) {
      last.text += span.text;
    } else {
      spans.push(span);
    }
  };
  lines.forEach((line, index) => {
    const previous = lines[index - 1];
    if (previous) {
      const before = spans[spans.length - 1];
      const tail = before?.text ?? '';
      const sameBaseline = Math.abs(line.baseline - previous.baseline) < 0.5 * line.size && line.page === previous.page;
      const firstRun = line.runs.find((run) => run.str.trim());
      // An address broken at the line's end runs straight on: the same
      // link on both lines, or an address ending in "/" before the break.
      const address = (before?.href && firstRun?.href === before.href) || (!before?.href && !firstRun?.href && /https?:\/\/\S*[/_-]$/.test(tail) && /^[\w%~#?=&/.-]/.test(line.text));
      if (address && !sameBaseline) {
        // Nothing between the two halves.
      } else if (tail.endsWith('-') && !sameBaseline) {
        // A word broken at the line's end: mend it, unless the break is at a
        // hyphen the word keeps — "self-" / "Attention", or "quasi-" /
        // "linear" where the paper writes "quasi-linear" elsewhere.
        if (mendsBreak(tail, line.text)) before.text = tail.slice(0, -1);
      } else if (tail && !tail.endsWith(' ')) {
        push({ text: ' ' });
      }
    }
    let end = Number.NEGATIVE_INFINITY;
    for (const run of line.runs) {
      const piece = run.str;
      if (!piece.trim()) {
        end = run.x + run.width;
        continue;
      }
      const bare = !/[\p{L}\p{N}]/u.test(piece);
      if (end > Number.NEGATIVE_INFINITY && (run.x - end > 0.08 * line.size || (run.spaced && !CLOSING.test(piece)))) {
        const prior = spans[spans.length - 1];
        push(bare && prior ? { text: ' ', bold: prior.bold, italic: prior.italic } : { text: ' ' });
      }
      end = run.x + run.width;
      const small = run.size < line.size * 0.85;
      const raised = line.baseline - run.y > line.size * 0.15;
      const lowered = run.y - line.baseline > line.size * 0.1;
      // A stop or a "±" set in another font is in the face of the word
      // before it: a bold "54.7" is one bold number, and the stop in "3.7"
      // taken from a mathematics italic is not an italic stop.
      const prior = spans[spans.length - 1];
      push({
        text: piece.replace(/\s+/g, ' '),
        bold: (bare ? prior?.bold : !heading && run.bold && (keepFace || !allBold)) ? true : undefined,
        italic: (bare ? prior?.italic : run.italic && (keepFace || !allItalic)) ? true : undefined,
        mono: run.mono ? true : undefined,
        sup: small && raised ? true : undefined,
        sub: small && lowered ? true : undefined,
        href: run.href,
      });
    }
  });
  // Tidy the edges and collapse runs of spaces that the joins left behind.
  for (const span of spans) span.text = span.text.replace(/\s{2,}/g, ' ');
  if (spans.length) {
    spans[0].text = spans[0].text.replace(/^\s+/, '');
    spans[spans.length - 1].text = spans[spans.length - 1].text.replace(/\s+$/, '');
  }
  return spans.filter((span) => span.text.length);
}

/**
 * A listing's lines as spans, a line each, broken where the listing breaks
 * them and each set in as far as it is on the page — in characters of the
 * typewriter type it is set in.
 */
function codeSpans(lines: Line[]): Span[] {
  const widths = lines
    .flatMap((line) => line.runs)
    .filter((run) => run.mono && run.str.trim().length >= 3)
    .map((run) => run.width / run.str.length)
    .sort((a, b) => a - b);
  const advance = widths.length ? widths[Math.floor(widths.length / 2)] : 0.5 * lines[0].size;
  const left = Math.min(...lines.map((line) => line.x0));
  // A line parted by wide spaces — "Current performance:   [X] SPS…" — is
  // read as pieces on one baseline: one line of the listing again.
  const rows: Line[][] = [];
  for (const line of lines) {
    const row = rows.find((one) => one[0].page === line.page && Math.abs(one[0].baseline - line.baseline) < 0.5 * line.size);
    if (row) row.push(line);
    else rows.push([line]);
  }
  const spans: Span[] = [];
  rows.forEach((row, index) => {
    if (index) spans.push({ text: '\n' });
    let at = left;
    for (const [part, line] of row.sort((a, b) => a.x0 - b.x0).entries()) {
      const indent = Math.max(part ? 1 : 0, Math.round((line.x0 - at) / advance));
      if (indent) spans.push({ text: ' '.repeat(indent), mono: true });
      spans.push(...spansOf([line], false, true));
      at = line.x1;
    }
  });
  return spans;
}

export const plain = (spans: Span[]): string => norm(spans.map((span) => span.text).join(''));

/**
 * Hyphenated words the document writes as such — "quasi-linear",
 * "type-specialized" — found where the hyphen falls inside a line, so that
 * the same word broken at a line's end keeps its hyphen. Set for the
 * document being laid out.
 */
let compounds = new Set<string>();
/** Every word the document sets whole, for telling "high-" / "accuracy" from "develop-" / "ment". */
let words = new Set<string>();

function findCompounds(pages: Line[][]): Set<string> {
  const found = new Set<string>();
  words = new Set<string>();
  for (const lines of pages) {
    for (const line of lines) {
      for (const match of line.text.matchAll(/([a-z]+)-([a-z]+)/gi)) found.add(`${match[1]}-${match[2]}`.toLowerCase());
      // The last word of a line may be half of one broken at its end.
      const whole = line.text.replace(/\S*-$/, '').match(/\p{L}+/gu) || [];
      for (const word of whole) words.add(word.toLowerCase());
    }
  }
  return found;
}

/**
 * Whether a word broken at a line's end keeps its hyphen: it does where the
 * paper writes it hyphenated elsewhere, and where both halves are words of
 * their own — "high-" / "accuracy" — that the paper never writes run
 * together. "develop-" / "ment" is one word broken in two.
 */
function keepsHyphen(left: string, right: string): boolean {
  const l = left.toLowerCase();
  const r = right.toLowerCase();
  if (compounds.has(`${l}-${r}`)) return true;
  if (words.has(l + r)) return false;
  return l.length >= 3 && r.length >= 3 && words.has(l) && words.has(r);
}

/**
 * Whether a line ending in a hyphen is a word broken there, to be mended
 * with the line after it: "infor-" / "mation" is; so is a word set in small
 * capitals, "BOOKCOR-" / "PUS", whose halves are capitals too; and so is
 * "XL-" / "Net", where the paper writes "XLNet" whole. "self-" /
 * "Attention", a compound broken at its own hyphen, is not.
 */
function mendsBreak(tail: string, next: string): boolean {
  const left = /(\p{L}+)-$/u.exec(tail)?.[1];
  const right = /^(\p{L}+)/u.exec(next)?.[1];
  if (!left || !right) return false;
  if (/^\p{Ll}/u.test(right)) return /\p{L}\p{Ll}$/u.test(left) && !keepsHyphen(left, right);
  const capitals = (word: string) => /^\p{Lu}+$/u.test(word);
  if (capitals(left) && capitals(right) && left.length + right.length >= 5) return !keepsHyphen(left, right);
  return words.has((left + right).toLowerCase()) && !compounds.has(`${left}-${right}`.toLowerCase());
}

// ---------------------------------------------------------------- tables --

/**
 * A cell's text run on to its next line: a word broken at the line's end
 * mended — "Analy-" / "sis" — unless the hyphen is the word's own ("Non-" /
 * "Emb.", "self-" / "attention" where the paper writes it so); else a space.
 */
function cellTurnover(head: Span[], tail: Span[], lineBreak = false): Span[] {
  const out = head.map((span) => ({ ...span }));
  const last = out[out.length - 1];
  const next = plain(tail);
  if (last && mendsBreak(last.text, next)) last.text = last.text.slice(0, -1);
  else if (lineBreak) out.push({ text: '\n' });
  else if (last && !/[-\s]$/.test(last.text)) out.push({ text: ' ' });
  return [...out, ...tail.map((span) => ({ ...span }))];
}

/**
 * The rows and columns of a table, from where its cells sit. Cells in a
 * column overlap horizontally, so columns are the groups of runs that do,
 * built from the narrowest runs up — a heading that spans two columns
 * overlaps both and is given a colspan rather than merging them.
 */
/** A rule drawn across part of a table: under a heading, or between groups of rows. */
export interface TableRule {
  x0: number;
  x1: number;
  y: number;
}

/** A cell that is a figure: "73.3 ± 2.5", "19/45", "0.029". */
const FIGURE = /^[\d\s.,±%()+\-−–/×*]*\d[\d\s.,±%()+\-−–/×*]*$/;
/**
 * A cell that is a value, not words: a figure, or one with a unit or a
 * mark — "8B", "1.4T", ">15T", "12.27 → 2.34", "N/A", "–", "✓".
 */
const VALUE = (text: string): boolean =>
  FIGURE.test(text) ||
  /^[<>≈∼~≤≥]?\s?[\d.,]+\s?(?:[KMBTkmbx×%]|pp|ms|s)?\*?$/.test(text) ||
  /^\d[\d.,]*\s*[→←↑↓]\s*\d[\d.,]*$/.test(text) ||
  /^(?:[-–—]+|N\/?A|n\/a|[✓✗×✔✘]|\?)$/.test(text);

export function tableFromLines(lines: Line[], caption?: Line, rules: TableRule[] = []): TableCell[][] | null {
  const cells = lines.filter((line) => line !== caption && line.text.trim());
  if (cells.length < 4) return null;
  type Column = { x0: number; x1: number };
  const columns: Column[] = [];
  const placement = new Map<Line, Column[]>();
  for (const cell of cells.slice().sort((a, b) => a.x1 - a.x0 - (b.x1 - b.x0))) {
    const hits = columns.filter((column) => overlapX(column, cell) > 0.5);
    if (!hits.length) {
      const column = { x0: cell.x0, x1: cell.x1 };
      columns.push(column);
      placement.set(cell, [column]);
    } else if (hits.length === 1) {
      hits[0].x0 = Math.min(hits[0].x0, cell.x0);
      hits[0].x1 = Math.max(hits[0].x1, cell.x1);
      placement.set(cell, hits);
    } else {
      placement.set(cell, hits);
    }
  }
  columns.sort((a, b) => a.x0 - b.x0);
  if (columns.length < 2) return null;

  let rows: Line[][] = [];
  for (const cell of cells.slice().sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0)) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].baseline - cell.baseline) <= 0.5 * Math.max(row[0].size, cell.size)) row.push(cell);
    else rows.push([cell]);
  }
  if (rows.length < 2) return null;
  // A table of records whose cells run to several lines each — a category,
  // the datasets in it one a line, and its share — parted by rules drawn
  // across the table: each record between two rules is a row, its lines in
  // each column one cell.
  const spread = Math.max(...cells.map((cell) => cell.x1)) - Math.min(...cells.map((cell) => cell.x0));
  const dividers = rules.filter((rule) => rule.x1 - rule.x0 >= 0.6 * spread).map((rule) => rule.y);
  if (rows.filter((row) => row.length >= 2).length / rows.length < 0.5 && dividers.length >= 3) {
    const records = new Map<number, Line[]>();
    for (const row of rows) {
      const group = dividers.filter((y) => y < row[0].baseline).length;
      records.set(group, [...(records.get(group) ?? []), ...row]);
    }
    const grouped = Array.from(records.values());
    if (grouped.length >= 3 && grouped.filter((record) => new Set(record.flatMap((cell) => placement.get(cell)!)).size >= 2).length / grouped.length >= 0.5) rows = grouped;
  }

  // A header centred over its numbers, but wider or narrower than them,
  // makes a column of its own beside theirs: two columns side by side that
  // no row fills both of, and that all but touch, are one.
  const em = Math.max(...cells.map((cell) => cell.size));
  for (let at = 0; at + 1 < columns.length; ) {
    const [left, right] = [columns[at], columns[at + 1]];
    const both = rows.some((row) => row.some((cell) => placement.get(cell)!.includes(left)) && row.some((cell) => placement.get(cell)!.includes(right)));
    if (both || right.x0 - left.x1 > em) {
      at += 1;
      continue;
    }
    left.x0 = Math.min(left.x0, right.x0);
    left.x1 = Math.max(left.x1, right.x1);
    for (const [cell, spans] of placement) placement.set(cell, Array.from(new Set(spans.map((column) => (column === right ? left : column)))).sort((a, b) => a.x0 - b.x0));
    columns.splice(at + 1, 1);
  }
  if (columns.length < 2) return null;

  const filled = rows.filter((row) => row.length >= 2).length;
  if (filled / rows.length < 0.5) return null;

  // Each row as its cells, each cell with the columns it covers.
  /** A cell, the columns it covers, and the baseline of its last line. */
  type Entry = { first: number; last: number; spans: Span[]; line: Line; bottom: number; end?: Line };
  const grid: Entry[][] = rows.map((row) => {
    const out: Entry[] = [];
    // Across, then down: a record's lines in one column read in order.
    const leftmost = (cell: Line) => Math.min(...placement.get(cell)!.map((column) => column.x0));
    for (const cell of row.slice().sort((a, b) => leftmost(a) - leftmost(b) || a.baseline - b.baseline || a.x0 - b.x0)) {
      // The columns it covers, left to right: the list was made in the
      // order the columns were found, not their order across the page.
      const indexes = placement.get(cell)!.map((column) => columns.indexOf(column));
      let first = Math.min(...indexes);
      const last = Math.max(...indexes);
      const previous = out[out.length - 1];
      // Reaching back over the cell before it, as "ShortGPT" over the edge
      // of LaCo's column, but with a column of its own: it is that column's.
      if (previous && first <= previous.last && last > previous.last) first = previous.last + 1;
      if (previous && first <= previous.last) {
        // Two runs in one column on one row: the same cell, split by a gap.
        const end = previous.end ?? previous.line;
        // A line stopping well short of its column, the next an item of its
        // own — "MMC4 (Zhu et al., 2024)" over "Wikipedia EN& CN" — is a list
        // set a line an item, and keeps its lines; text run on wraps.
        const right = columns[previous.last].x1;
        const short = end.x1 < right - 0.2 * (right - columns[previous.first].x0);
        const closed = /[)\]]$/.test(end.text);
        const opens = /^[\p{Lu}\d(]/u.test(cell.text);
        const listed = !/[-,;:]$/.test(end.text) && ((short && (opens || closed)) || (closed && opens));
        previous.spans = end.baseline === cell.baseline ? [...previous.spans, { text: ' ' }, ...spansOf([cell], false, true)] : cellTurnover(previous.spans, spansOf([cell], false, true), listed);
        previous.bottom = Math.max(previous.bottom, cell.baseline);
        previous.end = cell;
        continue;
      }
      out.push({ first, last, spans: spansOf([cell], false, true), line: cell, bottom: cell.baseline });
    }
    return out;
  });
  // A cell set on two or three lines — "Non- / Emb. / Params" in a
  // heading, "Qwen2-1.5B- / Instruct" in the body — is one cell: a row set
  // tight under the one before, with words only under that row's cells.
  const words = (entry: Entry) => !VALUE(plain(entry.spans));
  // A table whose records are parted by space, and whose cells run on to
  // lines of their own set tight under them — a review's table of studies
  // — has two pitches: a line's, and a record's.
  const baselineOf = (row: Entry[]) => Math.min(...row.map((entry) => entry.line.baseline));
  // A label alone in the first column — "Malicious Developer", centred on
  // the rows of its group, so set between two of them — is no row to
  // measure the pitch by.
  const labelRow = (row: Entry[]) => row.length === 1 && row[0].first === 0 && row[0].last === 0 && columns.length > 2;
  const measured = grid.filter((row) => row.length && !labelRow(row));
  const pitches = measured.slice(1).map((row, index) => baselineOf(row) - Math.max(...measured[index].map((entry) => entry.bottom))).filter((pitch) => pitch > 0);
  const step = pitches.length ? Math.min(...pitches) : 0;
  const recordGapped = step > 0 && pitches.filter((pitch) => pitch > 1.25 * step).length >= 2 && pitches.filter((pitch) => pitch <= 1.1 * step).length >= 2;
  // The columns that are figures: those most of whose cells, the first row's apart, are values.
  const valueColumns = new Set<number>();
  columns.forEach((_, index) => {
    const own = grid.slice(1).flat().filter((entry) => entry.first === index && entry.last === index);
    if (own.length >= 2 && own.filter((entry) => !words(entry)).length >= 0.6 * own.length) valueColumns.add(index);
  });
  // A table of words has no figure to end its heading at: the rule drawn
  // across the whole table under the heading — booktabs' midrule — ends it.
  const across0 = Math.min(...columns.map((column) => column.x0));
  const across1 = Math.max(...columns.map((column) => column.x1));
  const midrule = rules.filter((rule) => rule.y > (grid[0][0]?.line.baseline ?? 0) && rule.x1 - rule.x0 >= 0.9 * (across1 - across0)).sort((a, b) => a.y - b.y)[0];
  const headRows = () => (midrule ? grid.filter((row) => row.length && Math.min(...row.map((entry) => entry.line.baseline)) < midrule.y).length : 0);
  // A cell left blank with a mark — "-", "N/A" — is no figure to end the heading at.
  const placeholder = (entry: Entry) => /^(?:[-–—]+|N\/?A|n\/a|\?)$/.test(plain(entry.spans).trim());
  const capped = (index: number) => {
    const rows = headRows();
    return index < 0 && rows >= 1 && rows < grid.length ? rows : index;
  };
  for (let at = 1; at < grid.length; at += 1) {
    const firstFigures = capped(grid.findIndex((row) => row.some((entry) => !words(entry) && !placeholder(entry))));
    const row = grid[at];
    const above = grid[at - 1];
    // Or the other way up: a heading set bottom-aligned — "Non- / Emb." over
    // the row with "Model", "Params" and "Total" — begins in rows of its
    // own over the row that ends it.
    if (firstFigures >= 0 && at <= firstFigures && above.length && above.length < row.length && above.every(words)) {
      const over = above.map((entry) => row.find((other) => other.first === entry.first && other.last === entry.last));
      if (over.every(Boolean) && above.every((entry, index) => over[index]!.line.baseline - entry.bottom <= 1.3 * entry.line.size)) {
        above.forEach((entry, index) => {
          const cell = over[index]!;
          cell.spans = cellTurnover(entry.spans, cell.spans);
        });
        grid.splice(at - 1, 1);
        at -= 1;
        continue;
      }
    }
    // Where no row holds a figure — "O(n² · d)" is not one — the heading ends
    // at the rule under it, or with its second line.
    const headRule = rules.map((rule) => rule.y).filter((y) => y > grid[0][0].line.baseline).sort((a, b) => a - b)[0];
    const heading = firstFigures >= 0 ? at <= firstFigures : headRule !== undefined ? row[0].line.baseline < headRule : at === 1;
    // In a table of records parted by space, a row set a line's pitch under
    // the one before, sparser than a record and mostly words, is its cells' turnovers.
    // (Not a row with a cell set across several of those above it: "AdamW(…)"
    // over three stages is a row of its own.)
    const spansAbove = row.some((entry) => above.filter((other) => other.first <= entry.last && other.last >= entry.first).length > 1);
    // A cell's turnover goes on from the cell over it: in lower case, or
    // after a cell that stopped without a stop. A cell starting with a
    // capital under one that ended its sentence — "Adds MCP support…"
    // under "Implements MCP through OpenCTX." — is the next row's.
    const overOf = (entry: Entry) => above.find((other) => other.first <= entry.last && other.last >= entry.first);
    const goesOn = (entry: Entry) => {
      const over = overOf(entry);
      if (!over) return false;
      const text = plain(entry.spans);
      return /^\p{Ll}/u.test(text) || !/[.!?]["'”’)]?$/.test(plain(over.spans));
    };
    const breaksOff = (entry: Entry) => {
      const over = overOf(entry);
      return Boolean(over) && /^\p{Lu}/u.test(plain(entry.spans)) && /[.!?]["'”’)]?$/.test(plain(over!.spans));
    };
    // A row with a figure in a column of figures — "5.1.2" under "5.1.1"
    // in a column of section numbers — is a record of its own, as is one
    // with a cell in every column but the labels': a cell's turnover
    // wraps a column or two, never the row.
    const figured = row.some((entry) => entry.first === entry.last && valueColumns.has(entry.first) && !words(entry));
    const whole = columns.length >= 3 && row.length >= columns.length - 1;
    const turnover =
      recordGapped &&
      !heading &&
      !spansAbove &&
      !figured &&
      !whole &&
      row.length > 0 &&
      above.length > 0 &&
      !labelRow(above) &&
      baselineOf(row) - Math.max(...above.map((entry) => entry.bottom)) <= 1.15 * step &&
      row.length <= Math.max(1, 0.8 * columns.length) &&
      row.filter(words).length >= Math.max(1, row.length / 2) &&
      row.some(goesOn) &&
      !row.some(breaksOff);
    if (turnover) {
      for (const entry of row) {
        const cell = above.find((other) => other.first <= entry.last && other.last >= entry.first);
        if (cell) {
          cell.spans = cellTurnover(cell.spans, entry.spans);
          cell.bottom = Math.max(cell.bottom, entry.line.baseline);
        } else {
          above.push({ ...entry });
          above.sort((a, b) => a.first - b.first);
        }
      }
      grid.splice(at, 1);
      at -= 1;
      continue;
    }
    if (!row.length || !above.length || !row.every(words)) continue;
    const under = row.map((entry) => above.find((other) => other.first === entry.first && other.last === entry.last));
    if (under.some((other) => !other)) continue;
    // Set tight under the last line of the cell above: a line's pitch, not a row's.
    if (row.some((entry, index) => entry.line.baseline - under[index]!.bottom > 1.3 * entry.line.size)) continue;
    const runsOn = row.every((entry, index) => /-$/.test(plain(under[index]!.spans)) || /^\p{Ll}/u.test(plain(entry.spans)));
    if (!heading && !(runsOn && row.length <= Math.max(1, columns.length / 2))) continue;
    row.forEach((entry, index) => {
      const cell = under[index]!;
      cell.spans = cellTurnover(cell.spans, entry.spans);
      cell.bottom = entry.line.baseline;
    });
    grid.splice(at, 1);
    at -= 1;
  }
  const tableLeft = Math.min(...columns.map((column) => column.x0));
  const tableRight = Math.max(...columns.map((column) => column.x1));
  const tableWidth = tableRight - tableLeft;
  const figure = (entry: Entry) => VALUE(plain(entry.spans));

  // The heading rows: those before the first with a figure in it — and the
  // first row always.
  let head = capped(grid.findIndex((row) => row.some((entry) => figure(entry) && !placeholder(entry))));
  head = head < 0 ? 1 : Math.max(1, head);
  // The rule drawn across the table under its heading ends the heading
  // whatever the rows under it hold: a label for a group of rows, "Single
  // models on dev", set in words before the first figure, is the body's.
  {
    const ruled = headRows();
    if (ruled >= 1 && ruled <= 3 && ruled < head) head = ruled;
  }
  // A row of figures set right over the rule drawn across the table under
  // its heading — the models' sizes, "7B 7B 70B 67B", under their names —
  // is the heading's last row, not the first of the body.
  {
    const lowest = (row: Entry[]) => Math.max(...row.map((entry) => entry.bottom));
    const highest = (row: Entry[]) => Math.min(...row.map((entry) => entry.line.baseline));
    const acrossAll = (from: number, to: number) => rules.some((rule) => rule.y > from && rule.y < to && rule.x1 - rule.x0 >= 0.9 * tableWidth);
    if (head + 1 < grid.length && grid[head].length && grid[head + 1].length && grid[head - 1].length && acrossAll(lowest(grid[head]), highest(grid[head + 1])) && !acrossAll(lowest(grid[head - 1]), highest(grid[head]))) head += 1;
  }
  // Where each column's own cells sit, below the headings: a heading
  // widens the column it lands in, and would then seem centred over it.
  const body = columns.map((column, index) => {
    const own = grid.slice(head).flat().filter((entry) => entry.first === index && entry.last === index);
    return own.length ? { x0: Math.min(...own.map((entry) => entry.line.x0)), x1: Math.max(...own.map((entry) => entry.line.x1)) } : column;
  });
  const middle = (first: number, last: number) => (body[first].x0 + body[last].x1) / 2;

  // A heading over several columns — "Candidate selection" over CAD, R30
  // and R̄30 — covers the columns the rule drawn under it spans, as
  // booktabs draws one; where there is none, the blank columns beside it
  // that it is set centred over.
  grid.slice(0, head).forEach((row, rowIndex) => {
    const taken = (column: number, self: Entry) => row.some((other) => other !== self && column >= other.first && column <= other.last);
    // The lowest heading row has a heading a column: none of its is spread
    // by where it is set, only by a rule drawn under it.
    const lowest = rowIndex === head - 1 && head > 1;
    for (const entry of row) {
      const line = entry.line;
      const under = rules.find(
        // One not drawn under every column: a rule across the whole table is
        // the table's own, not a heading's.
        (rule) =>
          rule.y > line.baseline &&
          rule.y < line.baseline + 1.4 * line.size &&
          (rule.x0 > tableLeft + 2 || rule.x1 < tableRight - 2) &&
          rule.x0 <= (line.x0 + line.x1) / 2 &&
          rule.x1 >= (line.x0 + line.x1) / 2,
      );
      let [first, last] = [entry.first, entry.last];
      if (under && !lowest) {
        const covered = columns.map((column, index) => ({ index, share: overlapX(column, under) / Math.max(1, column.x1 - column.x0) })).filter((item) => item.share > 0.5).map((item) => item.index);
        if (covered.length) {
          first = Math.min(first, ...covered);
          last = Math.max(last, ...covered);
        }
      } else if (!lowest) {
        // Among the ranges of blank columns about it that it is centred on,
        // the narrowest as wide as its words; failing that, the one it is
        // most nearly centred on.
        const centre = (line.x0 + line.x1) / 2;
        const words = line.x1 - line.x0;
        const pitch = (index: number) => body[index].x1 - body[index].x0;
        let best = Math.abs(centre - middle(first, last));
        let fits = body[last].x1 - body[first].x0 >= words * 0.9;
        for (let a = first; a >= 0 && (a === first || !taken(a, entry)); a -= 1) {
          for (let b = last; b < columns.length && (b === last || !taken(b, entry)); b += 1) {
            if (a === entry.first && b === entry.last) continue;
            const off = Math.abs(centre - middle(a, b));
            const tolerance = 0.25 * Math.max(pitch(a), pitch(b), 8);
            const wide = body[b].x1 - body[a].x0 >= words * 0.9;
            const narrower = body[b].x1 - body[a].x0 < body[last].x1 - body[first].x0;
            if (wide && off <= tolerance && (!fits || narrower || best > tolerance)) {
              [first, last, best, fits] = [a, b, off, true];
            } else if (!fits && !wide && off < best - tolerance) {
              [first, last, best] = [a, b, off];
            }
          }
        }
      }
      while (first < entry.first && taken(first, entry)) first += 1;
      while (last > entry.last && taken(last, entry)) last -= 1;
      [entry.first, entry.last] = [first, last];
    }
  });

  // A heading set centred on its rows — "Params" level with the middle of
  // "Context / Length" beside it — is read as rows of halves: one row, each
  // column's pieces read down, under the headings spread over several
  // columns ("HumanEval" over Python and Multilingual), which keep theirs.
  {
    let top = 0;
    while (top < head && grid[top].some((entry) => entry.last > entry.first)) top += 1;
    let end = top;
    while (end < head && grid[end].every((entry) => entry.first === entry.last)) end += 1;
    // Only rows of halves, each leaving columns the others fill: a row with
    // a cell in every one — "Encoder | SigLIP | SigLIP+SAM | None" under the
    // models' names — is a row of the heading of its own, and ends them.
    const union = new Set(grid.slice(top, end).flatMap((row) => row.map((entry) => entry.first)));
    const complete = grid.slice(top, end).findIndex((row) => new Set(row.map((entry) => entry.first)).size === union.size);
    if (complete >= 0) end = top + complete;
    const rows = grid.slice(top, end);
    const filled = rows.map((row) => new Set(row.map((entry) => entry.first)));
    const all = new Set(filled.flatMap((set) => Array.from(set)));
    const halves = rows.length >= 2 && filled.some((set) => set.size < all.size);
    if (halves) {
      const merged: Entry[] = [];
      for (const column of Array.from(all).sort((x, y) => x - y)) {
        const parts = rows.flatMap((row) => row.filter((entry) => entry.first === column));
        merged.push({ ...parts[0], spans: parts.slice(1).reduce((spans, part) => cellTurnover(spans, part.spans), parts[0].spans), bottom: Math.max(...parts.map((part) => part.bottom)) });
      }
      grid.splice(top, end - top, merged);
      head -= end - top - 1;
    }
  }

  // A label naming a group of rows — "Complex" over Success and Abnormal
  // motion — covers them all, rather than leaving blank cells that read as
  // the next group's. The groups are what the rules drawn across the table
  // divide it into; where there are none, a label covers the blank cells
  // under it.
  // Only a rule drawn across the labels' own column divides their groups:
  // one starting past it divides a group within, as "# Parameters" from
  // "MMLU" under one "8 Billion".
  const across = rules.filter((rule) => rule.x1 - rule.x0 >= tableWidth * 0.6 && rule.x0 <= columns[0].x1 + 2).map((rule) => rule.y);
  const groupOf = (row: number) => across.filter((y) => y < grid[row][0]?.line.baseline).length;
  const rowspan = new Map<Entry, number>();
  /** How many of each row's first columns are the cells spanning down from rows above it. */
  const covered = new Map<number, number>();
  // A label on a line of its own between rows — centred on the rows it
  // names, or set sideways down them — is the label of the rows of its
  // group, as the rules divide them, that have none: it goes on the first
  // of them.
  if (across.length) {
    // A label set on two lines — "Malicious" over "Developer" — is one label.
    const labelOf = new Map<number, Entry>();
    for (let row = head; row < grid.length; row += 1) {
      const only = grid[row].length === 1 && grid[row][0].first === 0 && grid[row][0].last === 0 ? grid[row][0] : null;
      if (!only) continue;
      const group = groupOf(row);
      const placed = labelOf.get(group);
      if (placed) {
        placed.spans = cellTurnover(placed.spans, only.spans);
        grid.splice(row, 1);
        row -= 1;
        continue;
      }
      const members = grid.map((_, index) => index).filter((index) => index >= head && index !== row && grid[index].length && groupOf(index) === group);
      // (The label's own second line is no row of the group with a label of its own.)
      const alone = (index: number) => grid[index].length === 1 && grid[index][0].first === 0 && grid[index][0].last === 0;
      if (!members.length || members.some((index) => !alone(index) && grid[index].some((entry) => entry.first === 0))) continue;
      grid[members[0]].unshift(only);
      labelOf.set(group, only);
      grid.splice(row, 1);
      row -= 1;
    }
  }
  if (grid.length - head >= 2 && columns.length >= 2) {
    const labelled = (row: number) => grid[row].find((entry) => entry.first === 0);
    for (let row = head; row < grid.length; row += 1) {
      if (!labelled(row) || covered.has(row)) continue;
      let end = row + 1;
      while (end < grid.length && !labelled(end) && grid[end].length && (!across.length || groupOf(end) === groupOf(row))) end += 1;
      // With rules, the label may sit anywhere in its group: the group's
      // blank rows above it are its too.
      let start = row;
      while (across.length && start - 1 >= head && !labelled(start - 1) && !covered.has(start - 1) && grid[start - 1].length && groupOf(start - 1) === groupOf(row)) start -= 1;
      if (end - start < 2) continue;
      const label = labelled(row)!;
      if (start < row) {
        // Moved to the group's first row, which is where a row span starts.
        grid[row].splice(grid[row].indexOf(label), 1);
        grid[start].unshift(label);
      }
      rowspan.set(label, end - start);
      for (let r = start + 1; r < end; r += 1) covered.set(r, 1);
      // So do the cells beside it, column by column, blank under them in
      // every row of the group — a category's description by its name.
      for (let column = 1; column < columns.length - 1; column += 1) {
        const cell = grid[start].find((entry) => entry.first === column && entry.last === column);
        if (!cell) break;
        const blank = Array.from({ length: end - start - 1 }, (_, index) => start + 1 + index).every((r) => covered.get(r) === column && !grid[r].some((entry) => entry.first <= column));
        if (!blank) break;
        rowspan.set(cell, end - start);
        for (let r = start + 1; r < end; r += 1) covered.set(r, column + 1);
      }
    }
  }

  return grid.map((row, index) => {
    const out: TableCell[] = [];
    let at = covered.get(index) ?? 0;
    for (const entry of row) {
      while (at < entry.first) {
        out.push({ spans: [] });
        at += 1;
      }
      const span = rowspan.get(entry);
      out.push({
        spans: entry.spans,
        colspan: entry.last > entry.first ? entry.last - entry.first + 1 : undefined,
        ...(span ? { rowspan: span } : {}),
        ...(index < head ? { head: true } : {}),
      });
      at = entry.last + 1;
    }
    while (at < columns.length) {
      out.push({ spans: [] });
      at += 1;
    }
    return out;
  });
}

/**
 * A line of a table cut into its cells. Running text is cut into lines at a
 * gap of an em, but a table set small and tight puts its cells closer than
 * that — "Complex   Success ↑" — while the words of one cell are a space
 * apart, and pdf.js reports a space inside a run, not as a gap between two.
 */
function splitCells(line: Line, table: Line[] = []): Line[] {
  const runs = line.runs.filter((run) => run.str.trim());
  // Pieces parted by a gap wider than a space, a script kept with what it is set on.
  let parts: Run[][] = [];
  let end = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    const script = run.size < 0.85 * line.size;
    if (!parts.length || (!script && run.x - end > 0.6 * line.size)) parts.push([]);
    parts[parts.length - 1].push(run);
    end = Math.max(end, run.x + run.width);
  }
  if (!table.length) return parts.length < 2 ? [line] : parts.map((part) => cellOf(line, part));
  // A cell's text set justified, run on to its next line — "Commonsense
  // Rea-" over "soning" — is one cell from where that line starts to the
  // piece its word is broken at, however wide its spaces.
  const below = table.filter((next) => next.baseline > line.baseline && next.baseline - line.baseline < 1.6 * line.size && /^\p{Ll}/u.test(next.text));
  for (let at = 0; at < parts.length; at += 1) {
    if (!/\p{L}-$/u.test(joinRuns(parts[at], line.size))) continue;
    let from = -1;
    for (let index = at; index >= 0 && from < 0; index -= 1) if (below.some((next) => Math.abs(next.x0 - parts[index][0].x) < 0.5 * line.size)) from = index;
    if (from < 0 || from === at) continue;
    parts = [...parts.slice(0, from), parts.slice(from, at + 1).flat(), ...parts.slice(at + 1)];
    at = from;
  }
  // A gap between two cells runs down the table: the words of the lines
  // above and below it, that reach across it, stop short of it. A wide
  // space in a cell's text set justified — "Pointing   Description,   Position"
  // — has the words of that cell's other lines across it.
  const gutter = (from: number, to: number) => {
    const middle = (from + to) / 2;
    const across = table.filter((other) => other !== line && Math.abs(other.baseline - line.baseline) > 0.5 * line.size && other.x0 < middle && other.x1 > middle);
    if (across.length < 2) return true;
    const crossed = across.filter((other) => other.runs.some((run) => run.str.trim() && run.x < middle && run.x + run.width > middle));
    return crossed.length < 0.5 * across.length;
  };
  const merged: Run[][] = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (last && !gutter(Math.max(...last.map((run) => run.x + run.width)), part[0].x)) last.push(...part);
    else merged.push(part.slice());
  }
  parts = merged;
  if (parts.length < 2) return [line];
  return parts.map((part) => cellOf(line, part));
}

/** A piece of a line of a table, as a line of its own: one cell. */
function cellOf(line: Line, part: Run[]): Line {
  const worded = part.filter((run) => /[\p{L}\p{N}]/u.test(run.str));
  return {
    ...line,
    runs: part,
    x0: Math.min(...part.map((run) => run.x)),
    x1: Math.max(...part.map((run) => run.x + run.width)),
    text: joinRuns(part, line.size),
    allBold: worded.length > 0 && worded.every((run) => run.bold),
    allItalic: worded.length > 0 && worded.every((run) => run.italic),
  };
}

/**
 * The labels set sideways beside a table — "Knowledge, Logic" down the
 * rows it names, "8 Billion" — as lines of its leftmost column, each at
 * the height of its middle, where a label for the rows about it belongs.
 * The pieces pdf.js reports of one label, one over the next, are joined.
 */
function sidewaysBeside(region: Region, page: PageInput, measures: Measures): Line[] {
  const em = measures.bodySize;
  const near = (page.sideways ?? []).filter((run) => {
    const middle = (run.y0 + run.y1) / 2;
    return middle > region.y0 && middle < region.y1 && run.x0 >= region.x0 - 4 * em && run.x1 <= region.x1 && run.x1 - run.x0 < 3 * run.size;
  });
  const labels: SidewaysRun[] = [];
  for (const run of near) {
    const last = labels[labels.length - 1];
    // Pieces of one label, set on without a gap — not two labels one over the other.
    if (last && Math.abs(last.x0 - run.x0) < 1.5 && Math.abs(last.x1 - run.x1) < 1.5 && Math.min(Math.abs(run.y1 - last.y0), Math.abs(last.y1 - run.y0)) < 0.4 * run.size) {
      labels[labels.length - 1] = { str: last.str + run.str, x0: Math.min(last.x0, run.x0), y0: Math.min(last.y0, run.y0), x1: Math.max(last.x1, run.x1), y1: Math.max(last.y1, run.y1), size: last.size };
    } else labels.push({ ...run });
  }
  if (!labels.length) return [];
  const runs: TextRun[] = labels.map((label) => ({
    str: label.str.replace(/\s+/g, ' ').trim(),
    x: label.x0,
    y: (label.y0 + label.y1) / 2 + 0.3 * label.size,
    width: Math.max(1, label.x1 - label.x0),
    size: label.size,
    font: '',
  }));
  return buildLines({ index: page.index, width: page.width, height: page.height, runs, graphics: [] });
}

/** How many columns each row fills, counting those a label from a row above covers. */
export function columnsUsed(rows: TableCell[][]): number[] {
  let carried: number[] = [];
  return rows.map((row) => {
    const held = carried.filter((left) => left > 0).length;
    carried = carried.map((left) => left - 1).filter((left) => left > 0);
    for (const cell of row) if (cell.rowspan && cell.rowspan > 1) carried.push(cell.rowspan - 1);
    return held + row.reduce((sum, cell) => sum + (cell.colspan || 1), 0);
  });
}

/**
 * The grid a table's rows make, every cell a column's worth: a heading over
 * two columns in both, a label over three rows in all three. For setting a
 * table as text, where a cell cannot span.
 */
export function tableGrid(rows: TableCell[][]): string[][] {
  const grid: string[][] = rows.map(() => []);
  rows.forEach((row, index) => {
    let at = 0;
    for (const cell of row) {
      while (grid[index][at] !== undefined) at += 1;
      const text = plain(cell.spans);
      for (let r = 0; r < (cell.rowspan || 1) && index + r < rows.length; r += 1) {
        for (let c = 0; c < (cell.colspan || 1); c += 1) grid[index + r][at + c] = r === 0 && c === 0 ? text : '';
      }
      at += cell.colspan || 1;
    }
  });
  return grid.map((row) => Array.from(row, (cell) => cell ?? ''));
}

/**
 * A table read whole: split into its panels where it has them — "A.
 * Component contributions", then its rows, "B. …", then its own — each
 * with columns of its own, and a panel's title a row across the table;
 * and the note set under the table, after its last row, kept as a note.
 */
export function tableOf(lines: Line[], caption?: Line, rules: TableRule[] = []): { rows: TableCell[][]; notes?: Span[] } | null {
  const texts = lines.filter((line) => line !== caption && line.text.trim());
  const cells = texts.flatMap((line) => splitCells(line, texts));
  if (!cells.length) return null;
  const byRow: Line[][] = [];
  for (const cell of cells.slice().sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0)) {
    const row = byRow[byRow.length - 1];
    if (row && Math.abs(row[0].baseline - cell.baseline) <= 0.5 * Math.max(row[0].size, cell.size)) row.push(cell);
    else byRow.push([cell]);
  }
  // Notes: the lines alone on their rows after the last row of cells, the
  // first of them as wide as half the table or more — a paragraph set under it.
  let end = byRow.length;
  while (end > 0 && byRow[end - 1].length === 1) end -= 1;
  if (end > 0 && end < byRow.length) {
    const widths = byRow.slice(0, end).flat();
    const span = Math.max(...widths.map((line) => line.x1)) - Math.min(...widths.map((line) => line.x0));
    const first = byRow[end][0];
    if (first.x1 - first.x0 < span * 0.5) end = byRow.length;
  } else end = byRow.length;
  // What is set under the table's last rule is its note, however short.
  if (rules.length) {
    const lowest = Math.max(...rules.map((rule) => rule.y));
    const under = byRow.findIndex((row) => row.every((cell) => cell.top > lowest + 1));
    if (under > 0 && byRow.slice(under).every((row) => row.length === 1 && row[0].top > lowest + 1)) end = Math.min(end, under);
  }
  const notes = byRow.slice(end).flat();
  const body = byRow.slice(0, end);
  const left = Math.min(...body.flat().map((line) => line.x0));
  // A heading's rows are set closer than a row's pitch — "Model" level
  // with the gap between "SQuAD 1.1" and the "EM F1" under it — and a
  // panel's title stands on a row of its own.
  const stacked = (row: Line[]) => body.some((other) => other !== row && Math.abs(other[0].baseline - row[0].baseline) < 0.9 * row[0].size);
  // A panel's title: alone on its row at the table's left edge, bold or lettered "A.".
  const titled = (row: Line[]) =>
    row.length === 1 && row[0].x0 - left < row[0].size * 1.5 && (row[0].allBold || /^(\(?[A-Za-z]\)|[A-Z]\.)\s+\S/.test(row[0].text)) && /\p{L}{3}/u.test(row[0].text) && !stacked(row);
  const panels: { title?: Line; rows: Line[][] }[] = [];
  for (const row of body) {
    const current = panels[panels.length - 1];
    if (titled(row) && (!current || current.rows.length)) panels.push({ title: row[0], rows: [] });
    else if (!current) panels.push({ rows: [row] });
    else current.rows.push(row);
  }
  const read = panels.map((panel) => tableFromLines(panel.rows.flat(), undefined, rules));
  // No panels, and no columns to be found: not a table to set as one.
  if (panels.length === 1 && !panels[0].title && !read[0]) return null;
  if (!read.some(Boolean)) return null;
  // A panel too small to read as a table is its lines, one row each.
  const tables = panels.map((panel, index) => ({
    title: panel.title,
    rows: read[index] ?? panel.rows.map((row) => row.slice().sort((a, b) => a.x0 - b.x0).map((line): TableCell => ({ spans: spansOf([line], false, true) }))),
  }));
  // Each panel keeps its own columns — three in one, seven in the next —
  // and is set as a table of its own under its title.
  const rows: TableCell[][] = [];
  for (const table of tables) {
    const width = Math.max(1, ...columnsUsed(table.rows));
    if (table.title) rows.push([{ spans: spansOf([table.title]), colspan: width > 1 ? width : undefined, head: true, panel: true }]);
    const marked = table.rows.some((row) => row.some((cell) => cell.head));
    table.rows.forEach((row, index) => {
      const cellsOut = row.map((cell) => ({ ...cell }));
      if (!marked && index === 0) for (const cell of cellsOut) cell.head = true;
      rows.push(cellsOut);
    });
  }
  return { rows, notes: notes.length ? spansOf(notes) : undefined };
}

// --------------------------------------------------------------- headings --

/**
 * A line that is a heading by its shape, though set neither larger nor
 * bolder than the text — as IEEE sets them: "I. INTRODUCTION" in small
 * capitals, centred; "A. Residual latent dynamics" in italics at the
 * column's edge; "REFERENCES".
 */
function headingLine(line: Line, measures: Measures, columnLeft: number): boolean {
  if (line.caption || line.captionOf || line.mathShare > 0.2) return false;
  if (line.subheading) return true;
  if (Math.abs(line.size - measures.bodySize) > 1.2) return false;
  const text = line.text;
  if (text.length > 90 || /[.,;:]$/.test(text)) return false;
  const words = text.split(' ');
  if (words.length > 12) return false;
  const letters = text.replace(/[^\p{L}]/gu, '');
  // Capitals only: a numbered section, or one of the unnumbered ones.
  if (letters.length >= 4 && letters === letters.toUpperCase() && line.x1 - line.x0 < measures.columnWidth * 0.9) {
    if (/^([IVXL]{1,5}|[A-Z]|\d{1,2}(\.\d{1,2})*)\.?\s+\p{Lu}/u.test(text)) return true;
    if (/^(abstract|references|bibliography|acknowledge?ments?|appendix|appendices|conclusions?)\b/i.test(text)) return true;
  }
  // An italic "A. Name" at the column's edge: a subsection.
  if (line.allItalic && /^[A-Z]\.\s+\p{Lu}/u.test(text) && words.length <= 10 && line.x0 - columnLeft < line.size * 0.5 && line.x1 - line.x0 < measures.columnWidth * 0.85) return true;
  return false;
}

/**
 * A line that opens with a heading run into its text: a few words in bold,
 * starting with a capital, and the line going on in another face —
 * "Recent findings While heritability…", "Summary Despite…".
 */
function runInHeading(line: Line): boolean {
  if (line.allBold || line.caption || line.captionOf) return false;
  const runs = line.runs.filter((run) => run.str.trim());
  let at = 0;
  while (at < runs.length && runs[at].bold && !runs[at].math) at += 1;
  const rest = runs[at];
  if (!at || !rest || !/\p{L}/u.test(rest.str)) return false;
  const label = norm(runs.slice(0, at).map((run) => run.str).join(' '));
  return /^\p{Lu}/u.test(label) && /\p{L}{3}/u.test(label) && label.split(' ').length <= 5;
}

/**
 * Headings set in the text's own type — neither larger nor bolder, as
 * Nature's journals set their subsections: "Early fusion", "Limitations".
 * A short line, starting with a capital and not ending a sentence, with
 * space over it, and a full line of text under it at its own left edge.
 */
function markSubheadings(ordered: Line[], columns: Map<Line, number>, measures: Measures): void {
  const em = measures.bodySize;
  for (const line of ordered) {
    if (line.caption || line.captionOf || line.taken || line.mathShare > 0.1 || Math.abs(line.size - em) > 0.6) continue;
    const text = line.text.trim();
    const words = text.split(/\s+/).length;
    if (!/^\p{Lu}/u.test(text) || /[.,;:!?)\]]$/.test(text) || words > 10 || line.x1 - line.x0 > 0.7 * measures.columnWidth) continue;
    // In the text's own type: not bold, not in capitals — those are headings of their own kind.
    const letters = text.replace(/[^\p{L}]/gu, '');
    if (line.allBold || (letters.length >= 3 && letters === letters.toUpperCase())) continue;
    const left = columns.get(line) ?? line.x0;
    if (line.x0 - left > 0.5 * em) continue;
    const beside = (other: Line) => other !== line && overlapX(other, line) > 0;
    const below = ordered.filter((other) => beside(other) && other.baseline > line.baseline + 0.5 * em).sort((a, b) => a.baseline - b.baseline)[0];
    const above = ordered.filter((other) => beside(other) && other.baseline < line.baseline - 0.5 * em).sort((a, b) => b.baseline - a.baseline)[0];
    if (!below || below.baseline - line.baseline > 1.8 * em || Math.abs(below.x0 - line.x0) > 0.5 * em || !bodyLike(below, measures)) continue;
    if (above && line.baseline - above.baseline < 2 * em) continue;
    // On a line of its own: not a run-in heading, its text going on beside it.
    if (ordered.some((other) => other !== line && Math.abs(other.baseline - line.baseline) < 0.3 * em && other.x0 >= line.x1 && other.x0 - line.x1 < 3 * em)) continue;
    line.subheading = true;
  }
}

function looksLikeHeading(paragraph: Paragraph, measures: Measures): boolean {
  const lines = paragraph.lines;
  if (lines.length > 3) return false;
  const text = plain(spansOf(lines));
  if (!text || text.length > 160) return false;
  if (paragraph.region || lines[0].caption) return false;
  // The bold end of a sentence ("… trillions of tokens of data.") or a line
  // broken mid-word is not a heading.
  if (/^\p{Ll}/u.test(text) || /\p{L}-$/u.test(text)) return false;
  if (lines.every((line) => headingLine(line, measures, paragraph.columnLeft))) return true;
  const size = lines[0].size;
  const larger = size >= measures.bodySize * 1.12;
  const bold = lines.every((line) => line.allBold);
  if (!larger && !bold) return false;
  const words = text.split(' ').length;
  // "Type specialization." — a short bold line ending in a full stop is a
  // run-in heading set on its own line; a long one is a sentence.
  if (/[.,;:]$/.test(text) && !(bold && words <= 8) && !/^\d+(\.\d+)*\.?\s+\S/.test(text) && !/^(abstract|references|bibliography|acknowledge?ments?|appendix)\b/i.test(text)) return false;
  // Run-in headings — "Theorem 1." then the statement — are not headings.
  if (lines.length === 1 && !lines[0].allBold && !larger) return false;
  if (words > 20) return false;
  return true;
}

/**
 * How deep a heading's number puts it: "3.2 Method" is 2 deep. IEEE's
 * "II. METHOD" is a section, "A. Losses" under it a subsection, and
 * "1) Inverse dynamics" under that.
 */
function headingDepth(text: string): number {
  const numbered = /^(\d+(?:\.\d+)*)\.?\s/.exec(text);
  if (numbered) return numbered[1].split('.').length;
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (/^[IVXL]{1,5}\.\s/.test(text) && letters === letters.toUpperCase()) return 1;
  if (/^[A-Z]\.\s/.test(text)) return 2;
  if (/^\d+\)\s/.test(text)) return 3;
  return 0;
}

// ---------------------------------------------------------------- layout --

export interface LayoutOptions {
  /** The paper's title, so the title on the page can be recognised and left to the reader's own heading. */
  title?: string;
}

const normalTitle = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function layoutPages(inputs: PageInput[], options: LayoutOptions = {}): Layout {
  const pages = inputs.map(buildLines);
  const measures = measure(pages);
  compounds = findCompounds(pages);
  for (const lines of pages) mendJustified(lines, measures);
  dropFurniture(pages, inputs, measures);
  dropContents(pages, inputs);

  const crops: Crop[] = [];
  // The drawings on each page no caption claimed: where a figure captioned
  // at the foot of the page before — Springer's "▶" — is set.
  const spare = new Map<number, { x0: number; y0: number; x1: number; y1: number; width: number; height: number }>();
  const crop = (region: Region, page: PageInput): Crop => {
    const pad = 3;
    const found: Crop = {
      id: crops.length,
      page: page.index,
      x0: Math.max(0, region.x0 - pad),
      y0: Math.max(0, region.y0 - pad),
      x1: Math.min(page.width, region.x1 + pad),
      y1: Math.min(page.height, region.y1 + pad),
      ...(page.turned ? { turned: page.turned } : {}),
    };
    crops.push(found);
    return found;
  };

  const blocks: Block[] = [];
  let characters = 0;
  let frontAuthors: string[] = [];
  let front: Span[][] = [];
  let byline: PaperByline | undefined;
  let inReferences = false;
  const headings: { block: Extract<Block, { kind: 'heading' }>; size: number; numbered: number; sub?: boolean }[] = [];
  let carry: Extract<Block, { kind: 'paragraph' }> | null = null;
  let carryLast: Line | null = null;
  // Where a list item's turnover lines start, from its column's left edge:
  // a list item runs on over a break only at that indent.
  let carryIndent: number | null = null;
  let carryColumn = 0;

  for (const [at, lines] of pages.entries()) {
    findCaptions(lines, measures);
    // Every caption's lines are known before any region is looked for: a
    // caption's second line, as wide as the column, is not running text.
    for (const line of lines) if (line.caption && !line.taken) for (const next of captionTail(line, lines, inputs[at].graphics)) next.captionOf = line;
  }
  const tableSide = tablesPlaced(pages, inputs, measures);

  for (const [at, page] of inputs.entries()) {
    const lines = pages[at];
    const clusters = clusterGraphics(page);

    // Figures and tables, by their captions; then the lines inside them —
    // axis labels, legend entries, the cells of a table — leave the flow.
    const regions = captionRegions(lines, clusters, measures, page, tableSide);
    // Mathematics in a footnote — "q · k = Σ qᵢkᵢ" — is the footnote's: an
    // equation all in small type at the foot of the page, under the body, is not one.
    const lowest = Math.max(0, ...lines.filter((line) => !line.taken && bodyLike(line, measures)).map((line) => line.baseline));
    for (const region of equationRegions(lines, clusters, measures, page)) {
      const small = region.lines.every((line) => line.size <= measures.bodySize - 0.8 && line.baseline > lowest && line.baseline > page.height * 0.6);
      if (small) {
        for (const line of region.lines) line.taken = false;
        continue;
      }
      regions.push(region);
    }
    // (A publisher's logo in the foot of the page, a rule under the running head: not drawings.)
    const unclaimed = clusters.filter((cluster) => (cluster.images || cluster.bodies) && cluster.x1 - cluster.x0 > 5 * measures.bodySize && cluster.y1 - cluster.y0 > 5 * measures.bodySize && !regions.some((region) => overlapX(region, cluster) > 0 && region.y0 < cluster.y1 && region.y1 > cluster.y0));
    if (unclaimed.length) {
      const box = {
        x0: Math.min(...unclaimed.map((cluster) => cluster.x0)),
        y0: Math.min(...unclaimed.map((cluster) => cluster.y0)),
        x1: Math.max(...unclaimed.map((cluster) => cluster.x1)),
        y1: Math.max(...unclaimed.map((cluster) => cluster.y1)),
      };
      if ((box.x1 - box.x0) * (box.y1 - box.y0) > 0.15 * page.width * page.height) spare.set(page.index, { ...box, width: page.width, height: page.height });
    }

    // Footnotes: small text at the foot of the page, below the body.
    const flow = lines.filter((line) => !line.taken);
    const feet = new Set<Line>();
    const bodyLines = flow.filter((line) => bodyLike(line, measures));
    // A bibliography is small type at the foot of the page too, and none of
    // it is a footnote: the lines read after its heading are left in the text.
    const read = readingOrder(flow.map((line) => ({ x0: line.x0, y0: line.top, x1: line.x1, y1: line.bottom, line }))).map((box) => box.line);
    const heading = read.findIndex((line) => REFERENCES_HEADING.test(line.text));
    // …until a heading of the section after it: "A. Appendix" on the page
    // the bibliography ends on, and the footnotes under it the page's own.
    const listing = inReferences ? read : heading >= 0 ? read.slice(heading) : [];
    const after = listing.findIndex((line) => !REFERENCES_HEADING.test(line.text) && line.allBold && line.size >= measures.bodySize * 1.1 && line.text.split(' ').length <= 12);
    const listed = new Set(after >= 0 ? listing.slice(0, after) : listing);
    // A listing set small at the foot of the page — a prompt in typewriter
    // type, line under line — is the text's, not a footnote.
    const inListing = (line: Line) => codeLine(line) && flow.some((other) => other !== line && codeLine(other) && overlapX(other, line) > 0 && Math.abs(other.baseline - line.baseline) < 2 * line.size && Math.abs(other.baseline - line.baseline) > 0.5 * line.size);
    for (const line of flow) {
      if (line.caption || line.captionOf || line.allBold || listed.has(line) || inListing(line)) continue;
      // Small type, or a note's mark leading it at the very foot of the
      // page: "*Authors are ordered alphabetically…", set as large as the text.
      if ((line.size > measures.bodySize - 1 && !(noteMark(line) && line.baseline > page.height * 0.8)) || line.baseline < page.height * 0.6) continue;
      // Below the last body text of its own column: the other column may
      // run lower.
      const column = bodyLines.filter((other) => overlapX(other, line) > 0 && other.baseline > line.baseline + measures.bodySize);
      if (!column.length) feet.add(line);
    }
    // Small type at the foot of a column that a heading follows, or that
    // follows a heading, is a section set small — Acknowledgments, "Compliance
    // with ethical standards" — not the page's footnotes.
    const headed = (line: Line) => !feet.has(line) && !line.caption && line.text.split(' ').length <= 12 && (line.size >= measures.bodySize * 1.1 || (line.allBold && line.size >= measures.bodySize - 0.6));
    for (const line of Array.from(feet)) {
      if (flow.some((other) => headed(other) && overlapX(other, line) > 0 && other.top > line.bottom)) feet.delete(line);
    }
    for (let changed = true; changed; ) {
      changed = false;
      for (const line of Array.from(feet)) {
        const above = flow
          .filter((other) => other !== line && overlapX(other, line) > 0 && other.bottom <= line.top + 1)
          .sort((a, b) => b.bottom - a.bottom)[0];
        if (above && !feet.has(above) && (headed(above) || above.size < measures.bodySize - 1) && line.top - above.bottom < (headed(above) ? 3 : 1.2) * line.size) {
          feet.delete(line);
          changed = true;
        }
      }
    }

    const ordered = readingOrder(
      flow.filter((line) => !feet.has(line)).map((line) => ({ x0: line.x0, y0: line.top, x1: line.x1, y1: line.bottom, line })),
    ).map((box) => box.line);

    // Which column each line is in: the left edge of the full lines of body
    // text that share its horizontal band. Only those: a title or an
    // author line set centred across the columns belongs to no column and
    // must not move the edge.
    const columns = new Map<Line, number>();
    const body = ordered.filter((line) => bodyLike(line, measures));
    for (const line of ordered) {
      const peers = body.filter((other) => overlapX(other, line) > 0 && Math.abs(other.x0 - line.x0) < measures.columnWidth * 0.6);
      columns.set(line, round(Math.min(line.x0, ...peers.map((other) => other.x0)), 2));
    }

    markSubheadings(ordered, columns, measures);
    let paras = paragraphs(ordered, measures, columns, inReferences);
    // A caption's lines are its own, wherever the reading order put them:
    // one set in a margin beside its table can be read after the table's
    // first row, and would start a paragraph of its own.
    paras = paras.filter((paragraph) => {
      const of = paragraph.lines[0].captionOf;
      if (!of || !paragraph.lines.every((line) => line.captionOf === of)) return true;
      const home = paras.find((other) => other !== paragraph && other.lines.includes(of));
      if (!home) return true;
      home.lines.push(...paragraph.lines);
      home.lines.sort((a, b) => a.baseline - b.baseline);
      return false;
    });
    for (const region of regions) {
      if (!region.caption) continue;
      const home = paras.find((paragraph) => paragraph.lines.includes(region.caption!));
      if (home) home.region = region;
    }
    // Equations take their place in the flow by position: after the last
    // paragraph above them in their column.
    const equationParas: Paragraph[] = regions
      .filter((region) => region.kind === 'equation')
      .map((region) => ({ lines: region.lines, page: page.index, columnLeft: region.x0, region }));

    // The first page's front matter — title, authors, addresses — is the
    // reader's own heading; the text starts at the abstract.
    if (at === 0) {
      let abstractAt = paras.findIndex((paragraph, index) => index < 40 && /^abstract\b/i.test(plain(spansOf(paragraph.lines))));
      // No "Abstract" over it, as Nature's journals set it: the abstract is
      // the first paragraph of some length under the authors' names.
      if (abstractAt < 0) {
        const named = authorsOnFront(ordered.filter((line) => line.baseline < page.height * 0.5), options.title);
        // (The names as the page sets them: ACM's in capitals, read as cased names.)
        const bylineAt = named.length
          ? paras.findIndex((paragraph, index) => index < 20 && named.some((name) => plain(spansOf(paragraph.lines)).toLowerCase().includes(name.toLowerCase())))
          : -1;
        if (bylineAt >= 0) abstractAt = paras.findIndex((paragraph, index) => index > bylineAt && !paragraph.region && paragraph.lines.length >= 3);
      }
      frontAuthors = authorsOnFront(
        ordered.filter((line) => line.baseline < (abstractAt > 0 ? paras[abstractAt].lines[0].top : page.height * 0.4)),
        options.title,
      );
      if (abstractAt > 0) {
        // A figure or a table at the head of a column is read before the
        // abstract under it, and is not front matter: it follows the
        // abstract, as a float would.
        // (A byline centred across both columns of a two-column paper is cut
        // at the gutter, and its right half read at the head of the right
        // column: what is set wholly above the abstract is front matter too.)
        const abstractTop = paras[abstractAt].lines[0].top;
        const overhead = paras.slice(abstractAt + 1).filter((paragraph) => !paragraph.region && !paragraph.lines[0].caption && paragraph.lines.every((line) => line.page === 0 && line.bottom < abstractTop - 1));
        const before = [...paras.slice(0, abstractAt), ...overhead];
        const floats = before.filter((paragraph) => paragraph.region || paragraph.lines[0].caption);
        ({ front, byline } = frontMatter(before.filter((paragraph) => !floats.includes(paragraph)).flatMap((paragraph) => paragraph.lines), measures, options.title));
        const after = paras.slice(abstractAt).filter((paragraph) => !overhead.includes(paragraph));
        // After the abstract's text, not between its heading and its text.
        const at = after.length > 1 && plain(spansOf(after[0].lines)).split(' ').length <= 2 ? 2 : 1;
        paras = [...after.slice(0, at), ...floats, ...after.slice(at)];
      } else if (options.title) {
        const wanted = normalTitle(options.title);
        paras = paras.filter((paragraph, index) => {
          if (index > 12) return true;
          const text = normalTitle(plain(spansOf(paragraph.lines)));
          return !(text && (wanted.includes(text) || text.includes(wanted)) && paragraph.lines[0].size >= measures.bodySize * 1.2);
        });
      }
    }

    const placed: Paragraph[] = [];
    const pending = equationParas.slice().sort((a, b) => a.region!.y0 - b.region!.y0);
    for (const paragraph of paras) {
      const first = paragraph.lines[0];
      for (const equation of pending.slice()) {
        const region = equation.region!;
        const sameColumn = overlapX(region, { x0: first.x0, x1: first.x1 }) > 0 || overlapX(region, { x0: paragraph.columnLeft, x1: paragraph.columnLeft + measures.columnWidth }) > 0;
        // Under it in its column, or anywhere in a column to its right: an
        // equation at the foot of a column comes before the next column.
        const nextColumn = paragraph.columnLeft >= region.x1 - 2 && first.page === region.page;
        if (nextColumn || (sameColumn && first.top >= region.y1 - 2 && (columns.get(first) ?? first.x0) <= region.x1)) {
          placed.push(equation);
          pending.splice(pending.indexOf(equation), 1);
        }
      }
      placed.push(paragraph);
    }
    placed.push(...pending);

    for (const paragraph of placed) {
      const region = paragraph.region;
      if (region?.kind === 'equation') {
        carry = null;
        blocks.push({ kind: 'equation', crop: crop(region, page), label: region.label, page: page.index });
        continue;
      }
      if (region && region.caption) {
        // A figure or table floats: a paragraph cut in two by one at the
        // top of a column is still one paragraph, and the float follows it.
        const caption = spansOf(paragraph.lines);
        characters += plain(caption).length;
        if (region.kind === 'table') {
          // The rules drawn in it: under a heading, between groups of rows.
          const rules: TableRule[] = page.graphics
            // A rule may reach past the text — over a column of labels set
            // sideways — so it need only lie mostly over the table.
            .filter((box) => box.y1 - box.y0 < 1.5 && box.x1 - box.x0 > 4 && box.y0 >= region.y0 - 4 && box.y1 <= region.y1 + 4 && overlapX(box, region) > 0.5 * Math.min(box.x1 - box.x0, region.x1 - region.x0))
            .map((box) => ({ x0: box.x0, x1: box.x1, y: (box.y0 + box.y1) / 2 }));
          // A region of lines each alone on its row, that no columns could be
          // found in, is a box of text: read as one, not painted.
          const alone = region.lines.every((line) => !region.lines.some((other) => other !== line && Math.abs(other.baseline - line.baseline) < 0.5 * line.size));
          const table = region.box ? { rows: boxRows(region.lines, rules) } : (tableOf([...region.lines, ...sidewaysBeside(region, page, measures)], region.caption, rules) ?? (alone && region.lines.length >= 2 ? { rows: boxRows(region.lines, rules) } : null));
          blocks.push({ kind: 'table', crop: crop(region, page), caption, label: region.label, rows: table?.rows ?? null, ...(table?.notes ? { notes: table.notes } : {}), page: page.index });
        } else {
          blocks.push({ kind: 'figure', crop: crop(region, page), caption, label: region.label, page: page.index });
        }
        continue;
      }
      // A listing keeps its lines, and is no paragraph for the text to run on into.
      if (isListing(paragraph.lines, paragraph.columnLeft, measures)) {
        const spans = codeSpans(paragraph.lines);
        characters += plain(spans).length;
        carry = null;
        // One carried over to the next page goes on there.
        const previous = blocks[blocks.length - 1];
        if (previous?.kind === 'paragraph' && previous.code && previous.page === page.index - 1 && paragraph === placed.find((one) => !one.region)) {
          previous.spans = [...previous.spans, { text: '\n' }, ...spans];
          continue;
        }
        blocks.push({ kind: 'paragraph', spans, page: page.index, code: true });
        continue;
      }
      const spans = spansOf(paragraph.lines, looksLikeHeading(paragraph, measures));
      const text = plain(spans);
      if (!text) continue;
      characters += text.length;
      if (looksLikeHeading(paragraph, measures)) {
        carry = null;
        const block: Extract<Block, { kind: 'heading' }> = { kind: 'heading', level: 2, spans, page: page.index };
        // A heading in the text's own type ranks under those set otherwise, capitals included.
        headings.push({ block, size: round(paragraph.lines[0].size), numbered: headingDepth(text), sub: paragraph.lines[0].subheading });
        blocks.push(block);
        inReferences = /^(\d+(\.\d+)*\.?\s+)?(references|bibliography)\b/i.test(text);
        continue;
      }
      const list = BULLET.test(text) ? 'bullet' : NUMBERED.test(text) && !inReferences ? 'number' : undefined;
      // A paragraph that ran on from the previous column or page.
      if (carry && carryLast && !list && !paragraph.lines[0].caption) {
        const last = plain(carry.spans);
        const hanging = paragraph.lines[0].x0 - paragraph.columnLeft;
        const broken = paragraph.lines[0].page !== carryLast.page || Math.abs(paragraph.columnLeft - carryColumn) > carryLast.size;
        // A sentence closed, and then a footnote's mark — "…training examples.¹⁰" — is closed.
        const closing = plain(carry.spans.filter((span, index) => !(span.sup && carry!.spans.slice(index).every((rest) => rest.sup || !rest.text.trim()))));
        // (A colon or a semicolon before a sentence going on in lower case —
        // "…as the timings show:" / "against a sheet its author had…" —
        // across a table set at the head of the page, is not the end of it.)
        const openEnded = !/[.!?:;"”’)\]]$/.test(closing) || /[a-z],$/.test(closing) || (/[:;]$/.test(closing) && /^\p{Ll}/u.test(text) && !inReferences);
        const continues = /^[a-z(]/.test(text) || last.endsWith('-');
        const indented = paragraph.lines[0].x0 - paragraph.columnLeft > paragraph.lines[0].size * 0.7;
        // In a bibliography, whose entries often end without a full stop —
        // "Science 194 282–7" — only an entry's indented turnover runs on:
        // an entry starting at the margin is the next one.
        // (Or one that starts in lower case: "of Clinical Neurology, 10(2)…" is no entry's head.)
        // A list item's own text, set at its turnover lines' indent, runs on
        // it; anything else after a list is the text's.
        const runsOn = carry.list
          ? broken && carryIndent !== null && Math.abs(hanging - carryIndent) < 0.5 * carryLast.size
          : inReferences
            ? indented || /^[a-z]/.test(text)
            : continues || !indented;
        // A paragraph led by a heading — a line in bold, "ACM Reference
        // format:", or a heading run into its text — is its own, however
        // the one before it ended.
        const headed = paragraph.lines[0].allBold || runInHeading(paragraph.lines[0]);
        if (openEnded && runsOn && !headed && Math.abs(paragraph.lines[0].size - carryLast.size) <= 0.6) {
          carry.spans = mergeSpans(carry.spans, spans, mendsBreak(last, text));
          carryLast = paragraph.lines[paragraph.lines.length - 1];
          carryColumn = paragraph.columnLeft;
          continue;
        }
      }
      const block: Extract<Block, { kind: 'paragraph' }> = { kind: 'paragraph', spans, page: page.index, list };
      blocks.push(block);
      carry = block;
      carryLast = paragraph.lines[paragraph.lines.length - 1];
      carryColumn = paragraph.columnLeft;
      const turnover = paragraph.lines.length > 1 ? carryLast.x0 - paragraph.columnLeft : null;
      carryIndent = list && turnover !== null && turnover > 0.5 * carryLast.size ? turnover : null;
    }

    if (feet.size) {
      // A note's number or mark hung out in the margin, apart from its text
      // on the same baseline — "1   Aphasia Research Laboratory, …" — is its
      // mark, raised as a mark is.
      for (const mark of Array.from(feet)) {
        if (!/^(?:\d{1,2}|[∗*†‡§¶✉])$/.test(mark.text.trim())) continue;
        const text = Array.from(feet).find(
          (other) => other !== mark && Math.abs(other.baseline - mark.baseline) < 0.6 * other.size && other.x0 > mark.x1 && other.x0 - mark.x1 < 4 * other.size,
        );
        if (!text) continue;
        text.runs = [...mark.runs.map((run) => ({ ...run, size: Math.min(run.size, 0.7 * text.size), y: Math.min(run.y, text.baseline - 0.3 * text.size) })), ...text.runs];
        text.x0 = mark.x0;
        text.text = `${mark.text.trim()} ${text.text}`;
        feet.delete(mark);
      }
      const footLines = readingOrder(Array.from(feet).map((line) => ({ x0: line.x0, y0: line.top, x1: line.x1, y1: line.bottom, line }))).map((box) => box.line);
      // A note's lines are measured from its column's left edge, not the
      // first line's, which is indented under its mark: "∗Equal contribution…"
      // runs on flush left under it.
      const footColumns = new Map(columns);
      for (const line of footLines) {
        if (columns.has(line)) continue;
        const beside = footLines.filter((other) => other.x0 < line.x1 && other.x1 > line.x0);
        footColumns.set(line, Math.min(...beside.map((other) => columns.get(other) ?? other.x0)));
      }
      // A line that opens with a mark — "∗", a raised "2" — starts a note of its own.
      const opensNote = (line: Line) => {
        const run = line.runs.find((item) => item.str.trim());
        return Boolean(run && (/^[∗*†‡§¶]/.test(run.str.trim()) || (run.size < line.size * 0.85 && line.baseline - run.y > line.size * 0.15)));
      };
      const split = paragraphs(footLines, measures, footColumns, false).flatMap((note) => {
        const out: Paragraph[] = [];
        for (const [index, line] of note.lines.entries()) {
          if (!out.length || (index > 0 && opensNote(line))) out.push({ ...note, lines: [line] });
          else out[out.length - 1].lines.push(line);
        }
        return out;
      });
      // A note's text hung from its mark — "1   Aphasia Research …, / Hearing
      // Sciences, …" — runs on at its text's edge, not the mark's.
      const notes: Paragraph[] = [];
      for (const note of split) {
        const previous = notes[notes.length - 1];
        const last = previous?.lines[previous.lines.length - 1];
        const head = previous?.lines[0];
        const words = head?.runs.find((run, index) => index > 0 && /[\p{L}\p{N}]/u.test(run.str) && run.x > head.x0 + 1);
        const first = note.lines[0];
        if (previous && last && words && opensNote(head) && !opensNote(first) && Math.abs(first.x0 - words.x) < 0.5 * first.size && first.baseline - last.baseline < 1.5 * first.size && first.baseline > last.baseline) {
          previous.lines.push(...note.lines);
          continue;
        }
        notes.push(note);
      }
      for (const [index, note] of notes.entries()) {
        const spans = spansOf(note.lines);
        const text = plain(spans);
        if (!text) continue;
        // A note broken off at the foot of one column and carried on at the
        // foot of the next, or of the next page: a note with no mark of its
        // own, going on in lower case where the one before it stopped
        // mid-sentence.
        const previous = blocks[blocks.length - 1];
        if (previous?.kind === 'footnote' && (index > 0 || previous.page === page.index - 1) && !opensNote(note.lines[0])) {
          const before = plain(previous.spans);
          if (!/[.!?:;"”’)\]]$/.test(before) && (/^\p{Ll}/u.test(text) || /[-,]$/.test(before))) {
            previous.spans = mergeSpans(previous.spans, spans, mendsBreak(before, text));
            continue;
          }
        }
        // The first page's footnote for a mark on the authors' names —
        // "∗Equal contribution." — is the byline's, and goes with it.
        if (at === 0 && byline && (bylineNote(byline, spans) || bylineFootnote(byline, spans))) continue;
        blocks.push({ kind: 'footnote', spans, page: page.index });
      }
      // The first page's footnotes are where some styles put the authors'
      // addresses — IEEE's \thanks — and they are the byline's too.
      if (at === 0 && byline) {
        const found = notes.flatMap((note) => emailsIn(plain(spansOf(note.lines))));
        if (found.some((email) => !byline!.emails.includes(email))) {
          byline.emails = Array.from(new Set([...byline.emails, ...found]));
          assignEmails(byline);
        }
        // A footnote of addresses and nothing else, each put to its author, has said all it had to.
        for (let index = blocks.length - 1; index >= 0; index -= 1) {
          const block = blocks[index];
          if (block.kind !== 'footnote' || block.page !== page.index) continue;
          const text = plain(block.spans);
          const emails = emailsIn(text);
          if (emails.length && !/\p{L}{3}/u.test(text.replace(ADDRESS_GROUP, ' ').replace(ADDRESS_ONE, ' ')) && emails.every((email) => byline!.authors.some((author) => author.emails.includes(email)))) blocks.splice(index, 1);
        }
      }
    }
  }

  // Heading levels: by the numbering's depth where there is one, else by
  // size — the largest headings are sections.
  // A heading set in the text's own type is one level under the section
  // heading before it, whatever size that one is set in.
  const sizes = Array.from(new Set(headings.filter((entry) => !entry.sub).map((entry) => entry.size))).sort((a, b) => b - a);
  let section: 2 | 3 | 4 = 2;
  let seen = false;
  // The level each size is set at, where headings numbered "3" or "3.2" show
  // it: "References", or an appendix lettered "A.", set as a section is, is one.
  const digits = (entry: (typeof headings)[number]) => /^\d/.test(plain(entry.block.spans));
  const levelOf = new Map<number, number>();
  for (const entry of headings) if (entry.numbered && digits(entry) && !levelOf.has(entry.size)) levelOf.set(entry.size, Math.min(4, entry.numbered + 1));
  for (const entry of headings) {
    if (entry.sub && !entry.numbered) {
      entry.block.level = (seen ? Math.min(4, section + 1) : 2) as 2 | 3 | 4;
      continue;
    }
    const rank = Math.max(0, sizes.indexOf(entry.size));
    const byNumber = entry.numbered && (digits(entry) || !levelOf.has(entry.size)) ? Math.min(4, entry.numbered + 1) : 0;
    const bySize = levelOf.get(entry.size) ?? Math.min(4, 2 + rank);
    entry.block.level = (byNumber || bySize) as 2 | 3 | 4;
    section = entry.block.level;
    seen = true;
  }

  if (byline) contributionsSection(byline, blocks);

  // A figure whose caption found next to nothing — a mark, a rule — at the
  // foot of a page, where the page after has a whole drawing no caption
  // claimed: the figure is set there, as Springer's "▶" by a caption says.
  for (const block of blocks) {
    if (block.kind !== 'figure') continue;
    const { crop: found } = block;
    const next = spare.get(found.page + 1);
    if (!next || (found.x1 - found.x0 > 4 * measures.bodySize && found.y1 - found.y0 > 4 * measures.bodySize)) continue;
    spare.delete(found.page + 1);
    Object.assign(found, { page: found.page + 1, x0: Math.max(0, next.x0 - 3), y0: Math.max(0, next.y0 - 3), x1: Math.min(next.width, next.x1 + 3), y1: Math.min(next.height, next.y1 + 3) });
  }

  return {
    blocks: splitReferences(blocks),
    crops,
    characters,
    readable: readable(blocks),
    bodySize: measures.bodySize,
    authors: frontAuthors.length ? frontAuthors : undefined,
    front: front.length ? front : undefined,
    byline,
  };
}

// ---------------------------------------------------------------- authors --
//
// The byline on the first page. Search results cut it short — Google Scholar
// keeps six names and initials — so the PDF's own list is the one to trust.
// Each line above the abstract is split into pieces at commas, "and", and the
// wide gaps of a byline set in a row, with the superscript marks that point
// at affiliations dropped; a line whose every piece reads as a person's name
// is a line of authors. Affiliations and addresses fail that test on their
// words ("University", "Department") or their shape (one word, digits, @).

const NAME_PARTICLES = new Set(['van', 'von', 'de', 'der', 'den', 'del', 'della', 'di', 'da', 'dos', 'das', 'du', 'la', 'le', 'bin', 'ibn', 'al', 'el', 'ten', 'ter', 'y']);
const NOT_A_NAME = new RegExp(
  '\\b(' +
    [
      'univ\\w*', 'universit\\w*', 'institut\\w*', 'college', 'school', 'department', 'dept', 'faculty', 'laborator\\w*', 'labs?',
      'cent(?:er|re)', 'research', 'inc', 'ltd', 'llc', 'corp\\w*', 'company', 'hospital', 'clinic', 'academy', 'foundation', 'group',
      'google', 'microsoft', 'meta', 'deepmind', 'openai', 'anthropic', 'amazon', 'apple', 'nvidia', 'ibm', 'adobe', 'intel', 'samsung',
      'tech\\w*', 'science\\w*', 'engineering', 'polytechnic', 'politecnico', 'hochschule', 'national', 'state', 'medical', 'medicine',
      'abstract', 'introduction', 'keywords', 'equal', 'contribution', 'corresponding', 'author\\w*', 'email', 'street', 'road', 'avenue',
      'usa', 'uk', 'china', 'india', 'germany', 'france', 'japan', 'canada', 'korea', 'italy', 'spain', 'switzerland', 'netherlands',
      'australia', 'singapore', 'israel', 'united', 'kingdom', 'states', 'republic', 'new york', 'san \\w+', 'los angeles',
      'conference', 'workshop', 'proceedings', 'journal', 'preprint', 'arxiv', 'submitted', 'accepted', 'published',
    ].join('|') +
    ')\\b',
  'i',
);

/** Whether a piece of a byline reads as one person's name: "Saurav Chennuri", "Emily J. Braun", "Ludwig van Beethoven". */
export function looksLikeName(piece: string): boolean {
  const words = piece.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  if (/[\d@{}()[\]:;/\\|]/.test(piece) || NOT_A_NAME.test(piece)) return false;
  let capitals = 0;
  for (const word of words) {
    if (NAME_PARTICLES.has(word.toLowerCase()) && word === word.toLowerCase()) continue;
    if (!/^\p{Lu}[\p{L}\p{M}'’.-]*$/u.test(word)) return false;
    capitals += 1;
  }
  // A shouted line — "ABSTRACT", a running head — is not a name.
  return capitals >= 2 && !/^[\p{Lu}\s.'-]{12,}$/u.test(piece);
}

/**
 * A line of names followed by where they are, as ACM sets a byline —
 * "XINYI HOU and YANJIE ZHAO, Huazhong University of Science and
 * Technology, Wuhan, China" — cut into the names and the place; null
 * where the line is not set so. The names may be in capitals, as ACM's
 * small capitals come out of a PDF.
 */
export function namesThenPlace(text: string): { names: string[]; place: string } | null {
  const pieces = bylinePieces(text.replace(/\d+/g, ' '));
  // Capitals read as a name once cased as one: "XINYI HOU" is Xinyi Hou.
  const cased = (piece: string) => piece.toLowerCase().replace(/(^|[\s.'’-])(\p{L})/gu, (match) => match.toUpperCase());
  const nameLike = (piece: string) => looksLikeName(piece) || (/^[\p{Lu}\s.'’-]+$/u.test(piece) && looksLikeName(cased(piece)));
  let lead = 0;
  while (lead < pieces.length && nameLike(pieces[lead])) lead += 1;
  if (!lead || lead === pieces.length) return null;
  // The place as the line writes it — "Science and Technology", not cut at its "and".
  const last = pieces[lead - 1];
  const at = text.indexOf(last);
  const place = (at >= 0 ? text.slice(at + last.length) : pieces.slice(lead).join(', ')).replace(/^[\s,;]+/, '').trim();
  if (!INSTITUTION.test(place) || AUTHOR_NOTE.test(place) || /@|\d{3}/.test(place)) return null;
  return { names: pieces.slice(0, lead).map((piece) => (/^[\p{Lu}\s.'’-]+$/u.test(piece) ? cased(piece) : piece)), place };
}

/** A byline's line cut into the pieces that could each be a name. */
export function bylinePieces(text: string): string[] {
  return text
    .replace(/\S+@\S+/g, ' , ')
    .replace(/[*∗†‡§¶⋆♯♮✉#]+/g, ' ')
    .split(/\s*(?:,|;|·|•|\||\s{3,}|\band\b|&)\s*/)
    .map((piece) => piece.replace(/\s+/g, ' ').replace(/^[\s.,-]+|[\s,-]+$/g, '').trim())
    .filter(Boolean);
}

/** A note about the authors rather than a place: "Equal contribution", "Work done at…". */
const AUTHOR_NOTE = /contribut|correspond|equal|intern|work (?:was )?done|project lead|advis|lead author|first author|supervis|while at|now at|e-?mail|on leave/i;
/** Words that make a line a place: a university, a lab, a company. */
const INSTITUTION = /univ|institut|college|school|department|\bdept\b|faculty|laborator|\blabs?\b|cent(?:er|re)\b|research|\binc\b|\bltd\b|\bcorp|company|hospital|academy|foundation|google|microsoft|\bmeta\b|deepmind|openai|anthropic|amazon|apple|nvidia|\bibm\b|adobe|intel|samsung|polytechn|politecnico|hochschule|\bETH\b|\bEPFL\b|\bMIT\b|\bCNRS\b|\bINRIA\b/i;
const MARK = /^[∗*†‡§¶♯♮⋆#✉]+$/;

/** A mark's characters, one mark each: "1∗" is 1 and ∗, "∗,†" is ∗ and †. */
const marksOf = (text: string): string[] => (text.replace(/\*/g, '∗').match(/\d+|[a-z](?![a-z])|[∗†‡§¶♯♮⋆#✉]/gi) || []).filter(Boolean);

/**
 * A line of names read as its authors and their marks — "Jiabin Qiu∗,
 * Zixuan Chen∗,†" — the marks being the raised runs after each name, or
 * the symbols and figures a PDF set in line with it.
 */
function namesWithMarks(spans: Span[]): { name: string; marks: string[] }[] {
  const out: { name: string; marks: string[] }[] = [];
  let current = { name: '', marks: [] as string[] };
  const finish = () => {
    let name = current.name.replace(/\s+/g, ' ').trim();
    // Marks set in line: "Jiabin Qiu*", "Ada Lindqvist1".
    const inline = /([\d∗*†‡§¶⋆#✉,\s]+)$/.exec(name);
    if (inline && /\p{L}/u.test(name.slice(0, inline.index))) {
      current.marks.push(...marksOf(inline[1]));
      name = name.slice(0, inline.index).trim();
    }
    // Marks with no name before them are the previous name's: kept for the caller to put there.
    if (name || current.marks.length) out.push({ name, marks: Array.from(new Set(current.marks)) });
    current = { name: '', marks: [] };
  };
  for (const span of spans) {
    if (span.sup) {
      current.marks.push(...marksOf(span.text));
      continue;
    }
    const pieces = span.text.split(/\s*(?:,|;|·|•|\band\b|&)\s*/);
    pieces.forEach((piece, index) => {
      if (index > 0) finish();
      current.name += piece;
    });
  }
  finish();
  return out;
}

/**
 * A line of notes cut at its marks: "∗Equal contribution. †Corresponding
 * authors." is ∗ and † with what each says; "1Nanjing University" is 1.
 */
function markedPieces(spans: Span[]): { marks: string[]; text: string }[] {
  const out: { marks: string[]; text: string }[] = [];
  let current: { marks: string[]; text: string } | null = null;
  for (const span of spans) {
    const text = span.text;
    if (span.sup || (MARK.test(text.trim()) && text.trim())) {
      if (!current || current.text.trim()) {
        current = { marks: [], text: '' };
        out.push(current);
      }
      current.marks.push(...marksOf(text));
      continue;
    }
    // Symbols set in line at the head of a piece: "*Equal contribution".
    const parts = text.split(/(?:^|\s)([∗*†‡§¶✉])(?=\S)/);
    parts.forEach((part, index) => {
      if (index % 2 === 1) {
        current = { marks: marksOf(part), text: '' };
        out.push(current);
        return;
      }
      if (!current) {
        current = { marks: [], text: '' };
        out.push(current);
      }
      current.text += part;
    });
  }
  return out
    .map((piece) => ({ marks: piece.marks, text: piece.text.replace(/\s+/g, ' ').replace(/^[\s,;.]+|[\s,;]+$/g, '').trim() }))
    .filter((piece) => piece.text);
}

const ADDRESS_ONE = /[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
/** Several people at one domain, as bylines set them: "{jqiu, zchen}@nju.edu.cn". */
const ADDRESS_GROUP = /[{[(]\s*([\w.+-]+(?:\s*[,|;]\s*[\w.+-]+)+)\s*[}\])]\s*@\s*([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi;

/** The addresses in a line, a group written once for its domain spelled out one by one. */
export function emailsIn(text: string): string[] {
  const out: string[] = [];
  for (const group of text.matchAll(ADDRESS_GROUP)) for (const local of group[1].split(/\s*[,|;]\s*/)) out.push(`${local}@${group[2]}`.toLowerCase());
  for (const one of text.replace(ADDRESS_GROUP, ' ').matchAll(ADDRESS_ONE)) out.push(one[0].replace(/\.$/, '').toLowerCase());
  return Array.from(new Set(out));
}

/**
 * Whether an address is plainly one person's, by its name: "gaoy@", "ygao@",
 * "yang.gao@", "jqiu@" for Yang Gao and Jiabin Qiu — the surname, and of the
 * rest no more than the given names or their initials.
 */
export function addressOf(name: string, email: string): boolean {
  const local = email.split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
  const words = foldName(name)
    .split(/[\s-]+/)
    .map((word) => word.replace(/[^a-z]/g, ''))
    .filter(Boolean);
  if (words.length < 2 || local.length < 3) return false;
  const surname = words[words.length - 1];
  const given = words.slice(0, -1);
  if (!local.includes(surname)) {
    if (given.join('') === local || (given[0].length >= 4 && local === given[0])) return true;
    // The first name and the initials of the rest: "sauravm", "sharatht".
    const rest = [...given.slice(1), surname].map((word) => word[0]).join('');
    return given[0].length >= 3 && local.startsWith(given[0]) && local.length > given[0].length && rest.startsWith(local.slice(given[0].length));
  }
  const restOf = local.replace(surname, '');
  if (!restOf) return true;
  const initials = given.map((word) => word[0]).join('');
  return [given.join(''), given[0], initials, initials[0]].some((part) => part && part === restOf);
}

/** Letters folded to plain Latin, as addresses and first names are compared: "Łukasz" is "lukasz". */
const foldName = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[Łł]/g, 'l')
    .replace(/[Øø]/g, 'o')
    .replace(/[Đđ]/g, 'd')
    .replace(/ß/g, 'ss')
    .toLowerCase();

/** A note cut into its sentences, not at an initial's stop: "Aidan N. Gomez" is one. */
const sentencesOf = (text: string): string[] =>
  text
    .split(/(?<=[\p{Ll}\p{N})\]]{2}[.!?])\s+(?=[\p{Lu}\p{N}])|(?<=\p{Lu}\.)\s+(?=\p{Lu}[\p{Ll}\s,-]{2,100}:)/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

/** The authors a sentence names, by their full name, their first name or their surname. */
function namedIn(sentence: string, authors: BylineAuthor[]): BylineAuthor[] {
  // Initials, as contributions statements write them: "S.-C.H.", "A.P.", "M.P.L.".
  const initials = new Set(Array.from(sentence.matchAll(/(?<![\p{L}.])((?:\p{Lu}\.[\s-]*){2,4})(?![\p{L}])/gu), (match) => match[1].replace(/[^\p{Lu}]/gu, '')));
  const initialsOf = (name: string) => name.split(/[\s-]+/).filter((part) => /^\p{Lu}/u.test(part)).map((part) => part[0]).join('');
  const byInitials = authors.filter((author) => initials.has(initialsOf(author.name)));
  const unique = byInitials.filter((author) => authors.filter((other) => initialsOf(other.name) === initialsOf(author.name)).length === 1);
  if (unique.length) return unique;
  const words = new Set(foldName(sentence).split(/[^a-z]+/).filter(Boolean));
  const flat = ` ${foldName(sentence).replace(/[^a-z]+/g, ' ')} `;
  return authors.filter((author) => {
    const parts = foldName(author.name).split(/[^a-z]+/).filter((part) => part.length > 1);
    if (parts.length < 2) return false;
    if (flat.includes(` ${parts.join(' ')} `)) return true;
    // A first or a last name alone, where no one else on the byline has it.
    return [parts[0], parts[parts.length - 1]].some(
      (part) => part.length > 2 && words.has(part) && !authors.some((other) => other !== author && foldName(other.name).split(/[^a-z]+/).includes(part)),
    );
  });
}

/** Each author's notes and contributions, from the notes on the marks they carry. */
function notesToAuthors(byline: PaperByline): void {
  for (const author of byline.authors) {
    // A note that the order means nothing — "Authors are ordered
    // alphabetically", its mark on the last name — speaks of every name.
    const mine = byline.notes.filter((note) => note.mark.split(',').some((mark) => author.marks.includes(mark)) || ORDER_MEANS_NOTHING.test(note.text));
    author.notes = mine.map((note) => note.text).filter(Boolean);
    const contributions = mine.flatMap((note) => (note.contributions ?? []).filter((sentence) => namedIn(sentence, byline.authors).includes(author)));
    if (contributions.length) author.contributions = contributions;
    else delete author.contributions;
  }
}

/**
 * A footnote of the first page read into the byline where it is one: each
 * piece of it under a mark that is on an author's name, and says something
 * of them. True where the whole footnote was that, and has no other place.
 * A long one — "∗Equal contribution. Listing order is random. Jakob
 * proposed…" — is a contributions statement: its sentences that name an
 * author are theirs, and the rest is what it says of them all.
 */
function bylineNote(byline: PaperByline, spans: Span[]): boolean {
  const pieces = markedPieces(spans);
  const carried = (mark: string) => byline.authors.some((author) => author.marks.includes(mark));
  let all = pieces.length > 0;
  for (const piece of pieces) {
    const mark = piece.marks.join(',');
    const text = piece.text.replace(/\.$/, '');
    const sentences = sentencesOf(text);
    const general = sentences.filter((sentence) => namedIn(sentence, byline.authors).length === 0);
    const named = sentences.filter((sentence) => !general.includes(sentence)).map((sentence) => (/[.!?]$/.test(sentence) ? sentence : `${sentence}.`));
    const said = general.join(' ').replace(/\.$/, '');
    const aboutThem = AUTHOR_NOTE.test(general[0] ?? '') || ORDER_MEANS_NOTHING.test(said) || named.length > 0;
    if (mark && !/^\d/.test(mark) && piece.marks.every(carried) && aboutThem && said.length < 200) {
      if (!byline.notes.some((note) => note.mark === mark)) {
        // "✉email: …" is the author to write to.
        const text = mark === '✉' ? said.replace(/^(?:e-?mail|correspondence)\s*:?\s*/i, 'Corresponding author: ') : said;
        byline.notes.push({ mark, text, ...(named.length ? { contributions: named } : {}) });
        if (sentences.length > 2) byline.statement = [byline.statement, `${mark}${piece.text}`].filter(Boolean).join('\n\n');
      }
    } else all = false;
  }
  notesToAuthors(byline);
  return all;
}

/** The addresses a byline set as a grid prints under each name: theirs, whatever they spell. */
const placed = new WeakMap<BylineAuthor, string[]>();

const CONTRIBUTIONS = /^(?:\d+(?:\.\d+)*\.?\s+|[A-Z]\.?\s+)?(?:authors?['’]?s?['’]?\s+)?contributions?(?:\s+statement)?\b/i;

/**
 * An "Author Contributions" section, or a paragraph that starts so, read
 * into the byline's statement; its sentences that name an author are
 * theirs, as a footnote's are.
 */
function contributionsSection(byline: PaperByline, blocks: Block[]): void {
  const found: string[] = [];
  for (const [at, block] of blocks.entries()) {
    if (!('spans' in block)) continue;
    const text = plain(block.spans);
    if (block.kind === 'heading' && CONTRIBUTIONS.test(text) && text.split(' ').length <= 5) {
      for (const next of blocks.slice(at + 1)) {
        if (next.kind === 'heading') break;
        if (next.kind === 'paragraph') found.push(plain(next.spans));
      }
    } else if (block.kind === 'paragraph' && CONTRIBUTIONS.test(text) && /^[^.:]{0,40}[.:]/.test(text)) {
      found.push(text);
    }
  }
  const text = found.join('\n\n').trim();
  if (!text) return;
  byline.statement = [byline.statement, text].filter(Boolean).join('\n\n').slice(0, 6000);
  for (const sentence of sentencesOf(text)) {
    for (const author of namedIn(sentence, byline.authors)) {
      author.contributions = Array.from(new Set([...(author.contributions ?? []), sentence]));
    }
  }
}

/**
 * A footnote of the first page that says where the authors are, as
 * Springer sets them: "1 Aphasia Research Laboratory, …, Boston University"
 * for those whose names carry a 1, "2 Present address: …" for those with a
 * 2, and "✉ Erin L. Meier" (with the address under it) for the author to
 * write to. True where the whole footnote was that.
 */
function bylineFootnote(byline: PaperByline, spans: Span[]): boolean {
  const text = plain(spans).trim();
  // "✉ Name", the envelope a star in some fonts, and perhaps the address: the corresponding author.
  // Where the envelope is drawn rather than set, the name and the address
  // are all there is of it.
  const corresponding = /^[✉*∗]\s*([^@]+?)(?:\s+[\w.+-]+@\S+)*$/.exec(text) || /^([^@✉*∗\d]+?)(?:\s+[\w.+-]+@\S+)+$/.exec(text);
  if (corresponding) {
    const author = byline.authors.find((one) => foldName(one.name) === foldName(corresponding[1].trim()));
    if (author) {
      if (!author.marks.includes('✉')) author.marks.push('✉');
      if (!byline.notes.some((note) => note.mark === '✉')) byline.notes.push({ mark: '✉', text: 'Corresponding author' });
      notesToAuthors(byline);
      return true;
    }
  }
  const pieces = markedPieces(spans);
  const carried = (mark: string) => byline.authors.some((author) => author.marks.includes(mark));
  if (!pieces.length || !pieces.every((piece) => piece.marks.length && piece.marks.every((mark) => (/^\d+$/.test(mark) || mark === '✉') && carried(mark)))) return false;
  for (const piece of pieces) {
    const mark = piece.marks.join(',');
    const said = piece.text.replace(/\.$/, '');
    // "✉email: mschuang@stanford.edu": the author to write to, and where.
    if (mark === '✉') {
      const found = emailsIn(said);
      if (!byline.notes.some((note) => note.mark === '✉')) byline.notes.push({ mark, text: found.length ? `Corresponding author: ${found.join(', ')}` : 'Corresponding author' });
      byline.emails = Array.from(new Set([...byline.emails, ...found]));
      continue;
    }
    if (/^(?:present|current|permanent|new) address\b/i.test(said) || AUTHOR_NOTE.test(said) && !INSTITUTION.test(said)) {
      if (!byline.notes.some((note) => note.mark === mark)) byline.notes.push({ mark, text: said });
    } else if (!byline.affiliations.some((place) => place.mark === mark)) {
      byline.affiliations.push({ mark, text: said });
    }
  }
  for (const author of byline.authors) {
    const own = byline.affiliations.filter((place) => place.mark && place.mark.split(',').some((mark) => author.marks.includes(mark))).map((place) => place.text);
    if (own.length) author.affiliations = own;
  }
  notesToAuthors(byline);
  assignEmails(byline);
  return true;
}

/**
 * The addresses on the first page put to the authors they belong to: by
 * the name in the address, or — where one address stands by a note, as in
 * "†Corresponding author: haddad@…" — to the one author that note's mark
 * is on.
 */
function assignEmails(byline: PaperByline): void {
  const placedAll = byline.authors.flatMap((author) => placed.get(author) ?? []);
  for (const author of byline.authors) {
    const own = placed.get(author) ?? [];
    author.emails = Array.from(new Set([...own, ...byline.emails.filter((email) => !placedAll.includes(email) && addressOf(author.name, email))]));
  }
  // An address of three initials — "lsz" for Luke Zettlemoyer, the middle
  // one the byline never gives — is the one author's whose first and last
  // it fits, where it fits no one else's.
  for (const email of byline.emails) {
    if (placedAll.includes(email) || byline.authors.some((author) => author.emails.includes(email))) continue;
    const local = email.split('@')[0].toLowerCase();
    if (!/^[a-z]{3}$/.test(local)) continue;
    const fits = byline.authors.filter((author) => {
      const words = foldName(author.name).split(/[\s-]+/).filter(Boolean);
      return words.length >= 2 && words[0][0] === local[0] && words[words.length - 1][0] === local[2];
    });
    if (fits.length === 1) fits[0].emails.push(email);
  }
  for (const note of byline.notes) {
    const found = emailsIn(note.text).filter((email) => !byline.authors.some((author) => author.emails.includes(email)));
    const marked = byline.authors.filter((author) => note.mark.split(',').some((mark) => author.marks.includes(mark)));
    if (found.length === 1 && marked.length === 1) marked[0].emails.push(found[0]);
  }
}

/**
 * A line of the byline as spans, a comma where names set in a row are
 * parted by a wide space rather than by one — NeurIPS's \\And, "Saurav
 * Muralidharan∗    Sharath Turuvekere Sreenivas∗".
 */
function bylineSpans(line: Line): Span[] {
  const parts = bylineParts(line);
  if (parts.length < 2) return spansOf([line]);
  return parts.flatMap((part, index) => [...(index ? [{ text: ', ' }] : []), ...part.spans]);
}

/** A line of the byline cut at its wide gaps, each piece with where it is set. */
function bylineParts(line: Line): { spans: Span[]; x0: number; x1: number }[] {
  const parts: Run[][] = [];
  let end = Number.NEGATIVE_INFINITY;
  for (const run of line.runs.filter((item) => item.str.trim())) {
    // A gap of most of an em — against a word space's quarter — parts two names.
    if (!parts.length || run.x - end > 0.6 * line.size) parts.push([]);
    parts[parts.length - 1].push(run);
    end = Math.max(end, run.x + run.width);
  }
  // A bullet set apart between two names, as Springer sets them, parts them and is no piece.
  // Marks set apart from their name — an ORCID badge between them, "Shih-Cheng
  // Huang [iD] 1,2,6 ✉" — are the name's, not a piece of their own.
  const markRun = (run: Run) => /^[\s\d,∗*†‡§¶⋆#✉]*$/.test(run.str);
  for (let at = parts.length - 1; at > 0; at -= 1) {
    let lead = 0;
    while (lead < parts[at].length && markRun(parts[at][lead])) lead += 1;
    if (!lead || !parts[at].slice(0, lead).some((run) => /[\d∗*†‡§¶⋆#✉]/.test(run.str))) continue;
    parts[at - 1].push(...parts[at].splice(0, lead));
    if (!parts[at].length) parts.splice(at, 1);
  }
  const pieces = parts.filter((part) => part.some((run) => /[\p{L}\p{N}@]/u.test(run.str)));
  if (pieces.length < 2) return [{ spans: spansOf([line]), x0: line.x0, x1: line.x1 }];
  return pieces.map((part) => {
    const x1 = Math.max(...part.map((run) => run.x + run.width));
    return { spans: spansOf([{ ...line, runs: part, x0: part[0].x, x1 }]), x0: part[0].x, x1 };
  });
}

/**
 * The first page's lines above the abstract, less the title: the byline
 * read whole where it can be — the names with their marks, what the marks
 * stand for, the institutions named — and whatever else is there (an
 * address, a date) kept to be shown as it is set. Where the byline cannot
 * be read, the lines are kept as they are, the names only where their
 * marks point at one of them.
 */
function frontMatter(lines: Line[], measures: Measures, title?: string): { front: Span[][]; byline?: PaperByline } {
  const wanted = title ? normalTitle(title) : '';
  type Entry = { spans: Span[]; names: boolean; marked: boolean; parts: { spans: Span[]; x0: number; x1: number }[]; size: number; baseline: number; placed?: { names: string[]; place: string } };
  const entries: Entry[] = [];
  // What is set over the title — a licence, a venue's notice — is no part of the byline.
  const over: Span[][] = [];
  const largest = Math.max(0, ...lines.map((line) => line.size));
  for (const line of lines) {
    const flat = normalTitle(line.text);
    if (!flat) continue;
    // The title: the paper's own, or the largest type on the page.
    const titled = (wanted && flat.length > 3 && wanted.includes(flat)) || (line.size >= measures.bodySize * 1.3 && line.size >= largest - 0.5);
    if (titled) {
      if (!over.length) over.push(...entries.map((entry) => entry.spans));
      if (over.length && entries.length) entries.length = 0;
      continue;
    }
    const parts = bylineParts(line);
    const spans = bylineSpans(line);
    const text = plain(spans);
    if (!text || /^arxiv:/i.test(text)) continue;
    const marked = spans.some((span) => span.sup) || /[∗*†‡§¶]/.test(text);
    const pieces = bylinePieces(text.replace(/\d+/g, ' '));
    // Names and then their institution on one line, as ACM sets them.
    const placed = pieces.every(looksLikeName) ? null : namesThenPlace(text);
    const names = pieces.length > 0 && (pieces.every(looksLikeName) || Boolean(placed));
    const previous = entries[entries.length - 1];
    // The institution's name run on to the next line — "…University of
    // Science and Technology," / "Wuhan, China" — is the same line's.
    if (previous?.placed && !marked && /,$/.test(previous.placed.place) && !emailsIn(text).length && text.split(' ').length <= 8 && !pieces.every(looksLikeName)) {
      previous.placed.place = `${previous.placed.place} ${text}`.replace(/,\s*$/, '');
      previous.spans = mergeSpans(previous.spans, spans, false);
      continue;
    }
    // A line running on from the one before — but not an address under an
    // institution, unless it closes a group the line before opened.
    const address = /^[{[(]?[\w.+-]+(?:\s*,\s*[\w.+-]+)*[}\])]?\s*@/.test(text) && !/[{[(][^}\])]*$/.test(plain(previous?.spans ?? []));
    // An institution's name run over two lines — "Paul G. Allen School of
    // Computer Science & Engineering," / "University of Washington" — goes
    // on after its comma, in capitals as the next line of it is.
    const after = previous && !previous.names && !names && !address && (/[\p{Ll},-]$/u.test(plain(previous.spans)) && /^\p{Ll}/u.test(text) || (/,$/.test(plain(previous.spans)) && !marked && !emailsIn(text).length && INSTITUTION.test(plain(previous.spans))));
    if (after) {
      previous.spans = mergeSpans(previous.spans, spans, /\p{Ll}-$/u.test(plain(previous.spans)));
      previous.parts = [];
      continue;
    }
    // "§Facebook AI": a line led by a mark, with the words after it, says
    // what the mark stands for — a name carries its marks after it.
    const led = spans.find((span) => span.text.trim());
    const leading = led?.sup ? marksOf(led.text) : MARK.test(text.split(/\s+/)[0] ?? '') ? marksOf(text.split(/\s+/)[0]) : [];
    const pointed = leading.length > 0 && entries.some((entry) => entry.names && entry.marked);
    entries.push({ spans, names: names && !pointed, marked, parts, size: line.size, baseline: line.baseline, ...(placed ? { placed } : {}) });
  }

  // The byline read whole.
  const authors: BylineAuthor[] = [];
  const notes: { mark: string; text: string }[] = [];
  const affiliations: { mark?: string; text: string }[] = [];
  const rest: Span[][] = [...over];
  // A byline set as a grid — each name over its institution and address,
  // in a column of its own — is read a column at a time.
  let row: { author: BylineAuthor; center: number; width: number }[] = [];
  const places = new Map<BylineAuthor, string[]>();
  const shared: string[] = [];
  // Lines on one baseline: a row of the grid, set a column at a time.
  const siblings = (entry: Entry) => entries.filter((other) => other !== entry && Math.abs(other.baseline - entry.baseline) < 1).length > 0;
  let previous: Entry | undefined;
  for (const entry of entries) {
    const after = previous;
    previous = entry;
    // What reads as a name under a name in the grid, with none of the marks
    // every name there carries — "Northfield Brain" — is where they are.
    if (entry.names && row.length && !entry.marked && row.every((cell) => cell.author.marks.length) && gridColumns(entry, row, siblings(entry))) entry.names = false;
    if (entry.names && entry.placed) {
      // The names on the line, each at the institution named after them.
      for (const name of entry.placed.names) {
        const author: BylineAuthor = { name, marks: [], affiliations: [], notes: [], emails: [] };
        authors.push(author);
        places.set(author, [entry.placed.place.replace(/[\s,;]+$/, '')]);
      }
      continue;
    }
    if (entry.names) {
      // Names set a column at a time are one row: each a line of its own.
      if (!after?.names) row = [];
        const each = entry.parts.map((part) => namesWithMarks(part.spans));
      const oneEach = entry.parts.length > 0 && each.every((names) => names.length === 1);
      for (const [index, names] of (entry.parts.length ? each : [namesWithMarks(entry.spans)]).entries()) {
        for (const { name, marks } of names) {
          // Marks with no name — set apart from theirs by a badge, on a line
          // of their own — are the marks of the name before them.
          const previous = authors[authors.length - 1];
          if (!/\p{L}{2}/u.test(name) && previous) {
            previous.marks = Array.from(new Set([...previous.marks, ...marks, ...marksOf(name)]));
            continue;
          }
          const author: BylineAuthor = { name, marks, affiliations: [], notes: [], emails: [] };
          authors.push(author);
          if (oneEach) row.push({ author, center: (entry.parts[index].x0 + entry.parts[index].x1) / 2, width: entry.parts[index].x1 - entry.parts[index].x0 });
        }
      }
      continue;
    }
    // A line whose pieces carry the names' marks — "¹DeepSeek-AI", centred
    // under the last line of names — says what the marks stand for; it is
    // no institution set under the one name over it.
    const marked = markedPieces(entry.spans).some((piece) => piece.marks.some((mark) => /^\d+$/.test(mark) && authors.some((author) => author.marks.includes(mark))));
    const column = marked ? null : gridColumns(entry, row, siblings(entry));
    if (column) {
      for (const { part, under } of column) {
        const text = plain(part.spans);
        const found = emailsIn(text);
        const words = text.replace(ADDRESS_GROUP, ' ').replace(ADDRESS_ONE, ' ').replace(/[∗*†‡§¶]/g, ' ').replace(/\s+/g, ' ').trim();
        for (const author of under) {
          // One address under one name is theirs; several, written once for a domain, are the byline's to share out.
          if (found.length === 1 && under.length === 1) placed.set(author, [...(placed.get(author) ?? []), ...found]);
          if (/\p{L}{2}/u.test(words)) places.set(author, [...(places.get(author) ?? []), words]);
        }
      }
      continue;
    }
    const pieces = markedPieces(entry.spans);
    let used = false;
    for (const piece of pieces) {
      const mark = piece.marks.join(',') || undefined;
      // Its words, less any addresses: "nvidia.com" is not an institution named.
      const words = piece.text.replace(ADDRESS_GROUP, ' ').replace(ADDRESS_ONE, ' ').replace(/\s+/g, ' ').trim();
      if (!/\p{L}{2}/u.test(words)) continue;
      // A short name under a mark the names carry — "∗DeepSeek-AI" — is an
      // institution, whatever words it is spelt in.
      const named = Boolean(mark) && piece.marks.every((one) => authors.some((author) => author.marks.includes(one))) && words.split(' ').length <= 6 && /^\p{Lu}/u.test(words) && !/[;:!?]|\.\s/.test(words);
      if ((AUTHOR_NOTE.test(piece.text) || ORDER_MEANS_NOTHING.test(piece.text)) && !(INSTITUTION.test(words) && /^\d/.test(mark || ''))) {
        if (mark) {
          notes.push({ mark, text: piece.text.replace(/\.$/, '') });
          used = true;
        }
      } else if (INSTITUTION.test(words) || (mark && /^\d/.test(mark)) || named) {
        affiliations.push({ mark, text: piece.text.replace(/\.$/, '') });
        used = true;
      }
    }
    // A line of addresses and nothing else — "{jqiu, zchen}@nju.edu.cn" — is the byline's.
    const text = plain(entry.spans);
    const emails = emailsIn(text);
    if (emails.length && !/\p{L}{3}/u.test(text.replace(ADDRESS_GROUP, ' ').replace(ADDRESS_ONE, ' ').replace(/e-?mails?|contact/gi, ' '))) used = true;
    if (!used) rest.push(entry.spans);
  }
  const emails = Array.from(new Set(entries.flatMap((entry) => emailsIn(plain(entry.spans)))));
  // The places set under names, each once, as the institutions named.
  for (const lines of places.values()) {
    const place = lines.join(', ');
    if (!shared.includes(place)) shared.push(place);
  }
  for (const place of shared) if (!affiliations.some((known) => known.text === place)) affiliations.push({ text: place });
  // Marks on the names and nothing above the abstract to say what they
  // are: Springer says it in the first page's footnotes (read later).
  if (authors.length && (notes.length || affiliations.length || emails.length || authors.some((author) => author.marks.length))) {
    const unmarked = affiliations.filter((place) => !place.mark && !shared.includes(place.text));
    for (const author of authors) {
      const own = affiliations.filter((place) => place.mark && place.mark.split(',').some((mark) => author.marks.includes(mark)));
      const under = places.get(author);
      // One institution named without a mark is everyone's.
      // …and so is the only one named, whoever its mark was set on.
      author.affiliations = own.length ? own.map((place) => place.text) : under ? [under.join(', ')] : unmarked.length === 1 ? [unmarked[0].text] : affiliations.length === 1 ? [affiliations[0].text] : [];
    }
    const byline: PaperByline = { authors, notes, affiliations, emails };
    notesToAuthors(byline);
    assignEmails(byline);
    return { front: rest, byline };
  }

  const kept = entries.filter((entry) => !entry.names);
  if (!kept.length) return { front: [] };
  const pointed = kept.some((entry) => entry.marked);
  return { front: entries.filter((entry) => !entry.names || (pointed && entry.marked)).map((entry) => entry.spans) };
}

/**
 * A line of a byline set as a grid, cut into the pieces under each name of
 * the row of names over it — "Google Brain", "Google Research", … — each
 * with the authors it is set under; null where the line is not set so: one
 * piece across a row of several names is everyone's, and read as that.
 */
function gridColumns(
  entry: { parts: { spans: Span[]; x0: number; x1: number }[]; size: number },
  row: { author: BylineAuthor; center: number; width: number }[],
  siblings = false,
): { part: { spans: Span[]; x0: number; x1: number }; under: BylineAuthor[] }[] | null {
  if (!row.length || !entry.parts.length) return null;
  // Dates, a licence, an address on the web are nobody's place.
  if (entry.parts.some((part) => /\b(?:published|received|accepted|revised|online|copyright|doi)\b|©|https?:/i.test(plain(part.spans)))) return null;
  // A grid sets its names wide apart, a column each; names set in a row,
  // "Erin L. Meier • Jeffrey P. Johnson", are no grid.
  const cells = row.slice().sort((a, b) => a.center - b.center);
  if (cells.some((cell, at) => at > 0 && cell.center - cell.width / 2 - (cells[at - 1].center + cells[at - 1].width / 2) < 2.5 * entry.size)) return null;
  const centers = row.map((cell) => cell.center).sort((a, b) => a - b);
  const gap = centers.length > 1 ? Math.min(...centers.slice(1).map((center, index) => center - centers[index])) : Number.POSITIVE_INFINITY;
  if (row.length > 1 && entry.parts.length < 2) {
    // One piece under a row of names is one column's only where it is set
    // square under that name, and not centred on them all, which would make
    // it everyone's — unless others share its baseline, as a grid's cells do.
    const part = entry.parts[0];
    const middle = (part.x0 + part.x1) / 2;
    const nearest = Math.min(...centers.map((center) => Math.abs(center - middle)));
    const whole = (centers[0] + centers[centers.length - 1]) / 2;
    if (nearest > 0.2 * gap || part.x1 - part.x0 > 1.2 * gap) return null;
    if (!siblings && Math.abs(middle - whole) < 0.2 * gap) return null;
  }
  const out: { part: { spans: Span[]; x0: number; x1: number }; under: BylineAuthor[] }[] = [];
  for (const part of entry.parts) {
    const middle = (part.x0 + part.x1) / 2;
    // A line far wider than the one name over it is not in its column: it is everyone's.
    if (row.length === 1 && (part.x1 - part.x0 > 2.5 * row[0].width + 2 * entry.size || Math.abs(middle - row[0].center) > 0.3 * Math.max(row[0].width, part.x1 - part.x0))) return null;
    // A piece set across two names' columns is both theirs.
    let under = row.filter((cell) => cell.center > part.x0 - entry.size && cell.center < part.x1 + entry.size).map((cell) => cell.author);
    if (under.length !== 1 || row.length === 1) {
      const nearest = row.reduce((best, cell) => (Math.abs(cell.center - middle) < Math.abs(best.center - middle) ? cell : best));
      const width = Math.max(part.x1 - part.x0, 4 * entry.size);
      if (under.length < 2) under = Math.abs(nearest.center - middle) < Math.min(0.45 * gap, width) ? [nearest.author] : [];
    }
    if (!under.length) return null;
    out.push({ part, under });
  }
  return out;
}

/** The names on the lines above a first page's abstract, in reading order. */
function authorsOnFront(lines: Line[], title?: string): string[] {
  const wanted = title ? normalTitle(title) : '';
  const names: string[] = [];
  for (const line of lines.slice(0, 40)) {
    const text = norm(line.text);
    const flat = normalTitle(text);
    if (!flat || (wanted && flat.length > 8 && wanted.includes(flat))) continue;
    // A line led by a mark — "§Facebook AI" — says what the mark stands
    // for: a name carries its marks after it.
    const first = line.runs.find((run) => run.str.trim());
    if (first && ((first.size < line.size * 0.85 && line.baseline - first.y > line.size * 0.15) || MARK.test(first.str.trim()))) continue;
    // Superscripts are affiliation marks; a wide gap between runs separates
    // names set in a row.
    let marked = '';
    let end = Number.NEGATIVE_INFINITY;
    for (const run of line.runs) {
      const raised = run.size < line.size * 0.85 && line.baseline - run.y > line.size * 0.15;
      if (end > Number.NEGATIVE_INFINITY && run.x - end > line.size * 1.5) marked += '   ';
      else if (end > Number.NEGATIVE_INFINITY && run.x - end > 0.08 * line.size) marked += ' ';
      end = run.x + run.width;
      marked += raised ? ' , ' : run.str;
    }
    // Lines of anything else are passed over rather than ending the byline:
    // one set as a grid has each row of names followed by their addresses.
    const pieces = bylinePieces(marked);
    const found = pieces.length && pieces.every(looksLikeName) ? pieces : namesThenPlace(marked)?.names ?? [];
    for (const name of found) if (!names.includes(name)) names.push(name);
  }
  // A collaboration's byline runs to scores of names, DeepSeek's to 86;
  // hundreds of "names" are something else read as names.
  return names.length <= 400 ? names : [];
}

// ------------------------------------------------------------ references --

const REFERENCES_HEADING = /^(\d+(\.\d+)*\.?\s+)?(references|bibliography|literature cited|works cited)\s*$/i;

/**
 * Where a numbered bibliography's entries start in its text: "[1]", "[2]",
 * … or "1.", "2.", … counted up one at a time from the first, so that a
 * "[3]" cited inside an entry, or a volume "12." in a journal's details,
 * is not taken for the start of one. Empty when the text is not a numbered
 * list, or is one entry already.
 */
export function entryStarts(text: string): number[] {
  const styles = [
    { pattern: /\[(\d{1,3})\]/g, group: 1 },
    { pattern: /(^|\s)(\d{1,3})\.\s+(?=[\p{Lu}\p{Lt}])/gu, group: 2 },
  ];
  for (const { pattern, group } of styles) {
    const found = Array.from(text.matchAll(pattern)).map((match) => ({
      at: match.index! + (group === 2 ? match[1].length : 0),
      n: Number(match[group]),
    }));
    // The list begins at the head of the text.
    if (!found.length || found[0].at > 3) continue;
    const starts = [found[0].at];
    let expected = found[0].n + 1;
    for (const marker of found.slice(1)) {
      if (marker.n !== expected) continue;
      // A marker glued to the word before it is not the head of an entry.
      if (marker.at > 0 && !/[\s.,;)\]]/.test(text[marker.at - 1])) continue;
      starts.push(marker.at);
      expected += 1;
    }
    if (starts.length >= 2) return starts;
  }
  return [];
}

/** Spans cut at offsets into their text, each piece trimmed; the offsets ascending. */
function cutSpans(spans: Span[], offsets: number[]): Span[][] {
  const pieces: Span[][] = [[]];
  const cuts = offsets.filter((offset) => offset > 0);
  let at = 0;
  for (const span of spans) {
    let text = span.text;
    let start = at;
    while (cuts.length && cuts[0] < start + text.length) {
      const cut = cuts.shift()! - start;
      if (cut > 0) pieces[pieces.length - 1].push({ ...span, text: text.slice(0, cut) });
      pieces.push([]);
      text = text.slice(cut);
      start += cut;
    }
    if (text) pieces[pieces.length - 1].push({ ...span, text });
    at += span.text.length;
  }
  return pieces
    .map((piece) => {
      const out = piece.map((span) => ({ ...span }));
      if (out.length) {
        out[0].text = out[0].text.replace(/^\s+/, '');
        out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, '');
      }
      return out.filter((span) => span.text.length);
    })
    .filter((piece) => piece.length);
}

/**
 * A numbered bibliography, one paragraph per entry. The lines of a list set
 * in small type, with hanging indents, across columns and pages, are cut
 * into paragraphs by guesswork that a list's own numbers make unnecessary:
 * every paragraph under the heading is run together and cut again where
 * each number starts an entry. A list without numbers is left as it was.
 */
function splitReferences(blocks: Block[]): Block[] {
  const heading = blocks.findIndex((block) => block.kind === 'heading' && REFERENCES_HEADING.test(plain(block.spans)));
  if (heading < 0) return blocks;
  let end = heading + 1;
  while (end < blocks.length && blocks[end].kind !== 'heading') end += 1;
  const section = blocks.slice(heading + 1, end);
  const entries = section.filter((block): block is Extract<Block, { kind: 'paragraph' }> => block.kind === 'paragraph');
  if (entries.length === 0) return blocks;

  let joined: Span[] = [];
  for (const entry of entries) {
    const mend = mendsBreak(plain(joined), plain(entry.spans));
    joined = joined.length ? mergeSpans(joined, entry.spans, mend) : entry.spans.map((span) => ({ ...span }));
  }
  const text = joined.map((span) => span.text).join('');
  const lead = text.length - text.trimStart().length;
  const starts = entryStarts(text.trimStart()).map((offset) => offset + lead);
  if (starts.length < 2) return blocks;

  const page = entries[0].page;
  const split: Block[] = cutSpans(joined, starts).map((spans) => ({ kind: 'paragraph', spans, page }));
  // Anything else under the heading — a footnote, a figure — follows the list.
  const others = section.filter((block) => block.kind !== 'paragraph');
  return [...blocks.slice(0, heading + 1), ...split, ...others, ...blocks.slice(end)];
}

function readable(blocks: Block[]): boolean {
  const text = blocks
    .map((block) => ('spans' in block ? plain(block.spans) : 'caption' in block ? plain(block.caption) : ''))
    .join(' ');
  const glyphs = text.replace(/\s/g, '');
  if (glyphs.length < 200) return false;
  const letters = (glyphs.match(/[\p{L}\p{N}.,;:()'’"“”\-–—%]/gu) || []).length;
  if (letters / glyphs.length < 0.85) return false;
  const words = text.split(/\s+/).filter(Boolean);
  const long = words.filter((word) => word.length > 18).length;
  return long / words.length < 0.08;
}

/** Two runs of spans made one, mending a word broken across them. */
function mergeSpans(head: Span[], tail: Span[], mendHyphen: boolean): Span[] {
  const out = head.map((span) => ({ ...span }));
  const last = out[out.length - 1];
  if (mendHyphen && last.text.endsWith('-')) last.text = last.text.slice(0, -1);
  // A hyphen the word keeps — "end-" / "task" — joins its halves with no space.
  else if (last && !last.text.endsWith(' ') && !(last.text.endsWith('-') && /^\p{Ll}/u.test(plain(tail)))) out.push({ text: ' ' });
  for (const span of tail) out.push({ ...span });
  return out;
}

// ------------------------------------------------------------------ html ---

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] as string);
}

/**
 * Addresses written out in the text — "https://…", "www.…", an email
 * address — made links, where the PDF itself did not make them one.
 */
const ADDRESS = /(https?:\/\/[^\s<>"“”]+|www\.[a-z0-9-]+\.[^\s<>"“”]+|[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi;

export function linkAddresses(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    if (span.href || !/https?:\/\/|www\.|@/i.test(span.text)) {
      out.push(span);
      continue;
    }
    let at = 0;
    for (const match of span.text.matchAll(ADDRESS)) {
      let address = match[0];
      // A sentence's full stop or a closing bracket is not the address's.
      while (/[.,;:!?'"’”]$/.test(address) || (/\)$/.test(address) && !address.includes('('))) address = address.slice(0, -1);
      if (!address) continue;
      const start = match.index!;
      if (start > at) out.push({ ...span, text: span.text.slice(at, start) });
      const href = address.includes('@') && !/^https?:|^www\./i.test(address) ? `mailto:${address}` : /^www\./i.test(address) ? `https://${address}` : address;
      out.push({ ...span, text: address, href });
      at = start + address.length;
    }
    if (at < span.text.length) out.push({ ...span, text: span.text.slice(at) });
  }
  return out;
}

export function spansToHtml(spans: Span[]): string {
  return linkAddresses(spans)
    .map((span) => {
      // A line broken where the paper breaks it — the items of a table's
      // cell, a line each — the break kept, and the character with it.
      let html = escapeHtml(span.text).replace(/\n/g, '\n<br>');
      if (span.mono) html = `<code>${html}</code>`;
      if (span.italic) html = `<em>${html}</em>`;
      if (span.bold) html = `<strong>${html}</strong>`;
      if (span.sup) html = `<sup>${html}</sup>`;
      if (span.sub) html = `<sub>${html}</sub>`;
      if (span.href && /^(https?:|mailto:)/i.test(span.href)) html = `<a href="${escapeHtml(span.href)}" target="_blank" rel="noreferrer noopener">${html}</a>`;
      return html;
    })
    .join('');
}

/**
 * The document as HTML. Crops are images whose sources the caller supplies,
 * once it has painted them; a crop it has no image for is left out, with
 * its caption kept. `scale` is how many pixels a point was painted at: an
 * image is sized as painted, which sets a figure's lettering about as large
 * as the text around it, and its box is kept while it loads.
 */
export function renderHtml(layout: Layout, imageFor: (crop: Crop) => string | null, scale = 1): string {
  const out: string[] = [];
  if (layout.front?.length) out.push(`<div class="pdf-front">${layout.front.map((entry) => `<p>${spansToHtml(entry)}</p>`).join('')}</div>`);
  let list: 'bullet' | 'number' | null = null;
  const closeList = () => {
    if (list) out.push(list === 'bullet' ? '</ul>' : '</ol>');
    list = null;
  };
  const image = (crop: Crop, alt: string, className: string) => {
    const src = imageFor(crop);
    if (!src) return '';
    const width = Math.round((crop.x1 - crop.x0) * scale);
    const height = Math.round((crop.y1 - crop.y0) * scale);
    return `<img class="${className}" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="${width}" height="${height}" loading="lazy" style="aspect-ratio: ${width} / ${height}">`;
  };
  for (const block of layout.blocks) {
    if (block.kind !== 'paragraph' || !block.list) closeList();
    switch (block.kind) {
      case 'heading':
        out.push(`<h${block.level}>${spansToHtml(block.spans)}</h${block.level}>`);
        break;
      case 'paragraph': {
        if (block.code) {
          out.push(`<pre class="pdf-code">${spansToHtml(block.spans).replace(/\n<br>/g, '\n')}</pre>`);
        } else if (block.list) {
          if (list !== block.list) {
            closeList();
            list = block.list;
            // A numbered list taken up again after a listing or a figure
            // between its items goes on from the number it is at.
            const number = list === 'number' ? /^\(?(\d{1,2})[.)]/.exec(plain(block.spans))?.[1] : undefined;
            out.push(list === 'bullet' ? '<ul>' : number && number !== '1' ? `<ol start="${number}">` : '<ol>');
          }
          // The bullet and the space after it go; a dash set against its item is the whole match.
          let spans = block.spans.map((span, index) => (index === 0 ? { ...span, text: span.text.replace(list === 'bullet' ? BULLET : NUMBERED, (match) => (match.length === 1 ? '' : match.slice(-1))) } : span));
          // A number set in a span of its own — "1." in bold before the
          // run-in heading after it — goes with the space after it.
          if (list === 'number' && spans.length > 1 && /^\s*\(?(?:\d{1,2}|[a-z]|[ivx]{1,4})[.)]\s*$/i.test(spans[0].text)) {
            spans = spans.slice(1);
            while (spans.length && !spans[0].text.trim()) spans = spans.slice(1);
            if (spans.length) spans[0] = { ...spans[0], text: spans[0].text.replace(/^\s+/, '') };
          }
          out.push(`<li>${spansToHtml(spans)}</li>`);
        } else {
          out.push(`<p>${spansToHtml(block.spans)}</p>`);
        }
        break;
      }
      case 'figure':
        out.push(`<figure class="pdf-figure">${image(block.crop, block.label, 'pdf-crop')}<figcaption>${spansToHtml(block.caption)}</figcaption></figure>`);
        break;
      case 'table': {
        if (block.rows) {
          // A table in panels is a table a panel: each with its own columns.
          const panels: TableCell[][][] = [];
          for (const row of block.rows) {
            if (!panels.length || row.some((cell) => cell.panel)) panels.push([]);
            panels[panels.length - 1].push(row);
          }
          const tables = panels.map((rows) => {
            const marked = rows.some((row) => row.some((cell) => cell.head));
            const body = rows
              .map((row, index) => {
                const title = row.some((cell) => cell.panel);
                return `<tr${title ? ' class="pdf-panel"' : ''}>${row
                  .map((cell) => {
                    const tag = (marked ? cell.head : index === 0) ? 'th' : 'td';
                    // A figure — "73.3 ± 2.5" — is kept on one line, and a wide table scrolls.
                    // So is a short label — "Res + Inv", "Fast-LeWM [22]" — where a sentence may wrap.
                    const text = plain(cell.spans);
                    const kind = FIGURE.test(text) ? 'num' : text.length <= 18 && !cell.panel ? 'short' : '';
                    return `<${tag}${cell.colspan ? ` colspan="${cell.colspan}"` : ''}${cell.rowspan ? ` rowspan="${cell.rowspan}"` : ''}${kind ? ` class="${kind}"` : ''}>${spansToHtml(cell.spans)}</${tag}>`;
                  })
                  .join('')}</tr>`;
              })
              .join('');
            return `<table>${body}</table>`;
          });
          const notes = block.notes?.length ? `<p class="pdf-table-notes">${spansToHtml(block.notes)}</p>` : '';
          out.push(`<figure class="pdf-table"><figcaption>${spansToHtml(block.caption)}</figcaption><div class="pdf-table-scroll">${tables.join('')}</div>${notes}</figure>`);
        } else {
          out.push(`<figure class="pdf-table"><figcaption>${spansToHtml(block.caption)}</figcaption>${image(block.crop, block.label, 'pdf-crop')}</figure>`);
        }
        break;
      }
      case 'equation':
        out.push(`<div class="pdf-equation">${image(block.crop, block.label, 'pdf-crop')}</div>`);
        break;
      case 'footnote':
        out.push(`<aside class="pdf-footnote">${spansToHtml(block.spans)}</aside>`);
        break;
    }
  }
  closeList();
  return out.join('\n');
}
