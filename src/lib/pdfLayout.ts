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
}

// --------------------------------------------------------------- outputs ---

/** A region of a page to be painted and shown as an image. */
export interface Crop {
  id: number;
  page: number;
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
}

export interface TableCell {
  spans: Span[];
  colspan?: number;
}

export type Block =
  | { kind: 'heading'; level: 2 | 3 | 4; spans: Span[]; page: number }
  | { kind: 'paragraph'; spans: Span[]; page: number; list?: 'bullet' | 'number' }
  | { kind: 'figure'; crop: Crop; caption: Span[]; label: string; page: number }
  | { kind: 'table'; crop: Crop; caption: Span[]; label: string; rows: TableCell[][] | null; page: number }
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
}

// ------------------------------------------------------------------ fonts --

const BOLD = /bold|black|heavy|semibold|demibold|extrab|ultrab|-medi|medium(?!ital)|cmbx|cmb\d|ptmb|ntxb|txb|sfbx|,bold|-bd\b|\bbd\b|\.b$|-b$/i;
const ITALIC = /italic|oblique|ital\b|-it\b|cmti|cmmi|cmsl|slanted|,italic|\.i$|-i$|\bit$/i;
const MONO = /mono|cmtt|courier|typewriter|consolas|menlo|inconsolata|nimbusmono|luximono|lmtt|beramono|dejavusansmono|sourcecodepro|firamono/i;
/** Fonts that only ever set mathematics. */
const MATH = /cmmi|cmsy|cmex|cmmib|cmbsy|msam|msbm|rsfs|eufm|eufb|eurm|eusm|txsy|txmi|txex|pxsy|pxmi|pxex|stixmath|cambriamath|mathematica|symbol\b|standardsym|esint|wasy|stmary|mtsy|mtmi|mtex|lmmi|lmsy|lmex|xits-?math|latinmodernmath/i;

/** The face a run is set in, from its font's name. Subset prefixes ("ABCDEF+") are ignored. */
export function faceOf(font: string): { bold: boolean; italic: boolean; mono: boolean; math: boolean } {
  const name = font.replace(/^[A-Z]{6}\+/, '');
  return { bold: BOLD.test(name), italic: ITALIC.test(name), mono: MONO.test(name), math: MATH.test(name) };
}

// ------------------------------------------------------------------ lines --

interface Run extends TextRun {
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

/** Runs on one baseline, left to right, with the spaces between them restored. */
function joinRuns(runs: Run[], size: number): string {
  let text = '';
  let end = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    const piece = run.str;
    if (!piece) continue;
    if (text && run.x - end > 0.08 * size && !text.endsWith(' ') && !piece.startsWith(' ')) text += ' ';
    text += piece;
    end = run.x + run.width;
  }
  return norm(text);
}

/**
 * Runs into lines: one baseline, read left to right, with a gap of more than
 * a line's own em between two runs starting a new line — which is what keeps
 * the two columns of a page apart when both have a line on the same
 * baseline, and what separates the cells of a table row. A run that sits a
 * little above or below the baseline — a superscript, a subscript — still
 * belongs to the line, so the baselines are gathered first and each one is
 * cut at its gaps afterwards, once every run on it is known.
 */
function buildLines(page: PageInput): Line[] {
  const runs: Run[] = page.runs
    .filter((run) => run.str.trim().length && run.size > 0)
    .map((run) => ({ ...run, str: composeAccents(run.str), ...faceOf(run.font) }))
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const baselines: { runs: Run[]; baseline: number; size: number }[] = [];
  for (const run of runs) {
    let home: (typeof baselines)[number] | undefined;
    for (let at = baselines.length - 1; at >= 0; at -= 1) {
      const candidate = baselines[at];
      if (run.y - candidate.baseline > 2 * Math.max(candidate.size, run.size)) break;
      if (Math.abs(run.y - candidate.baseline) > 0.55 * Math.max(candidate.size, run.size)) continue;
      // Not a run set over or under one already there: that is the next
      // line of its column, drawn into this baseline by a line of larger
      // type in the column beside it, which sits between the two.
      const stacked = candidate.runs.some(
        (other) => Math.abs(other.y - run.y) > 0.3 * Math.min(other.size, run.size) && Math.min(other.x + other.width, run.x + run.width) - Math.max(other.x, run.x) > 1,
      );
      if (stacked) continue;
      home = candidate;
      break;
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
    // The line's size is the size most of its glyphs are set in, and its
    // baseline that of those glyphs — a line that is mostly a superscript
    // is a footnote mark, not a paragraph.
    const weight = new Map<number, number>();
    for (const run of line.runs) weight.set(run.size, (weight.get(run.size) || 0) + run.str.length);
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
    // caption with a "3%" set in a mathematics font is still bold.
    const lettered = line.runs.filter((run) => /\w/.test(run.str));
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

  return { bodySize, columnWidth, justified };
}

// -------------------------------------------------------- headers, feet --

/**
 * Running heads, page numbers and the arXiv stamp: lines in the top or
 * bottom margin that are short, numeric, or the same on page after page.
 */
function dropFurniture(pages: Line[][], inputs: PageInput[], measures: Measures): void {
  const seen = new Map<string, Set<number>>();
  const marginal = (line: Line, page: PageInput) => line.baseline < page.height * 0.1 || line.baseline > page.height * 0.9;
  for (const [at, lines] of pages.entries()) {
    const page = inputs[at];
    for (const line of lines) {
      if (!marginal(line, page)) continue;
      const key = norm(line.text.replace(/\d+/g, '#')).toLowerCase();
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key)!.add(at);
    }
  }
  const pageCount = pages.length;
  for (const [at, lines] of pages.entries()) {
    const page = inputs[at];
    for (const line of lines) {
      if (!marginal(line, page)) continue;
      const text = line.text;
      const key = norm(text.replace(/\d+/g, '#')).toLowerCase();
      const repeats = seen.get(key)?.size || 0;
      const short = line.x1 - line.x0 < measures.columnWidth * 0.6;
      if (
        /^\d+$/.test(text) ||
        /^(page\s+)?\d+\s*(of|\/)\s*\d+$/i.test(text) ||
        (repeats >= Math.min(3, Math.max(2, pageCount - 1)) && pageCount > 1) ||
        (short && line.size < measures.bodySize - 0.4 && line.baseline > page.height * 0.92) ||
        (short && line.baseline < page.height * 0.06)
      ) {
        line.taken = true;
      }
    }
  }
}

// -------------------------------------------------------------- captions --

const CAPTION = /^(fig(?:ure)?s?|tables?|tab|algorithm|listing|scheme|chart|plate)\.?\s*(s?\d+[a-z]?(?:\.\d+)?)\s*([.:|—–-]|$)/i;

function findCaptions(lines: Line[], measures: Measures): void {
  for (const line of lines) {
    if (line.taken) continue;
    const match = CAPTION.exec(line.text);
    if (!match) continue;
    const first = line.runs.find((run) => /\w/.test(run.str));
    const styled = Boolean(first && (first.bold || first.italic || Math.abs(first.size - measures.bodySize) > 0.4));
    const punctuated = Boolean(match[3]);
    if (!styled && !punctuated) continue;
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
    if (box.kind === 'image') cluster.images += 1;
    else if (rule) cluster.rules += 1;
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
function regionFor(caption: Line, lines: Line[], clusters: Cluster[], measures: Measures, page: PageInput): Region | null {
  const kind = caption.caption!.kind;
  const sides: ('above' | 'below')[] = kind === 'table' ? ['below', 'above'] : ['above', 'below'];
  const free = lines.filter((line) => line !== caption && !line.taken);
  const em = measures.bodySize;

  for (const side of sides) {
    let span = { x0: caption.x0, x1: caption.x1 };
    const inSpan = (box: { x0: number; x1: number }) => overlapX(box, span) > 0;
    const body = free.filter((line) => bodyLike(line, measures) && inSpan(line));
    const columnLeft = body.length ? Math.min(...body.map((line) => line.x0)) : caption.x0;
    // A line of running text: a full one, or a paragraph's short last
    // line, which is body-sized, starts at the column's edge and sits a
    // line under a full one.
    const wall = (line: Line) => {
      if (line.caption || bodyLike(line, measures)) return true;
      if (Math.abs(line.size - measures.bodySize) > 0.6 || line.x0 > columnLeft + em * 0.3) return false;
      return body.some((other) => other.bottom <= line.top + 1 && line.top - other.bottom < line.size * 1.2);
    };
    let far: number;
    if (side === 'above') {
      far = Math.max(0, ...free.filter((line) => inSpan(line) && line.bottom <= caption.top + 1 && wall(line)).map((line) => line.bottom));
    } else {
      far = Math.min(page.height, ...free.filter((line) => inSpan(line) && line.top >= caption.bottom - 1 && wall(line)).map((line) => line.top));
    }
    const band = side === 'above' ? { y0: far, y1: caption.top } : { y0: caption.bottom, y1: far };
    if (band.y1 - band.y0 < em * 0.5) continue;
    const within = (box: { y0: number; y1: number }) => box.y0 >= band.y0 - 2 && box.y1 <= band.y1 + 2;

    // What the band holds, letting a drawing wider than the caption widen
    // the band once so that its labels are found too.
    let members: Cluster[] = [];
    let held: Line[] = [];
    for (let pass = 0; pass < 6; pass += 1) {
      members = clusters.filter((cluster) => inSpan(cluster) && within(cluster));
      // A cell on the same row as one already held is held too, however
      // far right the column is.
      const reach = { x0: columnLeft - em, x1: Math.max(columnLeft + measures.columnWidth, span.x1) + em };
      const onRow = (line: Line) =>
        line.x0 >= reach.x0 && line.x1 <= reach.x1 && held.some((other) => Math.abs(other.baseline - line.baseline) < 0.5 * line.size);
      held = free.filter((line) => !line.caption && !wall(line) && (inSpan(line) || onRow(line)) && within({ y0: line.top, y1: line.bottom }));
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
    return {
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
  }
  return null;
}

/**
 * Display mathematics is set apart: a line numbered "(3)" at the column's
 * right edge, or a line mostly in a mathematics font, and the lines set
 * tight above and below it that a fraction or a sum spreads over.
 */
function equationRegions(lines: Line[], clusters: Cluster[], measures: Measures, page: PageInput): Region[] {
  const regions: Region[] = [];
  const free = () => lines.filter((line) => !line.taken && !line.caption);
  const isNumber = (line: Line) => /^\(\s*[A-Z]?\d+[a-z]?\s*\)$/.test(line.text) || /^\(\s*\d+\.\d+\s*\)$/.test(line.text);
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
      const same = free().filter((line) => line !== seed && Math.abs(line.baseline - seed.baseline) <= seed.size && line.x1 <= seed.x0 + 2 && seed.x0 - line.x1 < measures.columnWidth);
      if (!same.length) continue;
      if (same.some((line) => bodyLike(line, measures))) continue;
      for (const line of same) box = { x0: Math.min(box.x0, line.x0), y0: Math.min(box.y0, line.top), x1: Math.max(box.x1, line.x1), y1: Math.max(box.y1, line.bottom) };
    }
    const columnLeft = box.x0 - measures.columnWidth;
    const columnRight = box.x1 + measures.columnWidth;
    const members = new Set<Line>([seed]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const line of free()) {
        if (members.has(line) || line.caption) continue;
        if (line.x1 < columnLeft || line.x0 > columnRight) continue;
        if (bodyLike(line, measures)) continue;
        if (overlapX(line, { x0: box.x0 - 30, x1: box.x1 + 30 }) <= 0) continue;
        const gap = line.top > box.y1 ? line.top - box.y1 : line.bottom < box.y0 ? box.y0 - line.bottom : 0;
        if (gap > seed.size * 0.9) continue;
        // A line that is words rather than symbols, sitting just under the
        // formula, is the paragraph carrying on ("where x is ...").
        if (line.mathShare < 0.2 && /^[A-Za-z][a-z]+\s+[a-z]/.test(line.text) && line.x1 - line.x0 > measures.columnWidth * 0.5) continue;
        members.add(line);
        box = { x0: Math.min(box.x0, line.x0), y0: Math.min(box.y0, line.top), x1: Math.max(box.x1, line.x1), y1: Math.max(box.y1, line.bottom) };
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
  // read in strips from the top and a title never ends up after the text.
  const topmost = horizontal.reduce((best, gap) => (gap.at < best.at ? gap : best));
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

const BULLET = /^[•◦▪■●○◆◇►▸‣⁃–—-]\s+\S/;
const NUMBERED = /^(\(?\d{1,2}[.)]|\(?[a-z][.)]|\(?[ivx]{1,4}[.)])\s+\S/i;

/**
 * Lines into paragraphs. A new paragraph begins at a change of size or
 * face, at a gap wider than a line, at an indented first line, and — in
 * justified text — after a line that stopped short of the column's edge.
 */
const REFERENCES = /^(\d+(\.\d+)*\.?\s+)?(references|bibliography|literature cited)\s*$/i;

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
      if (current.columnLeft !== columnLeft) fresh = true;
      else if (Math.abs(line.baseline - previous.baseline) < em * 0.5 && line.page === previous.page) fresh = false; // Same baseline: one line split by a gap.
      else if (pitch < 0 || pitch > em * 1.9) fresh = true;
      else if (line.caption || previous.caption) fresh = Boolean(line.caption);
      else if (Math.abs(line.size - previous.size) > 0.6) fresh = true;
      else if (line.allBold !== previous.allBold && /\w{3}/.test(line.text) && /\w{3}/.test(previous.text)) fresh = true;
      else if (listItem) fresh = BULLET.test(line.text) || NUMBERED.test(line.text) || line.x0 - columnLeft < em * 0.3;
      else if (references) {
        // Hanging indents: an entry starts at the left, its turnover lines
        // are indented; or entries are numbered "[12]".
        const indented = line.x0 - columnLeft > em * 0.5;
        const previousIndented = previous.x0 - columnLeft > em * 0.5;
        if (/^\[\d+\]/.test(line.text)) fresh = true;
        else if (!indented && previousIndented) fresh = true;
        else if (indented && !previousIndented && current.lines.length > 1) fresh = false;
      } else if (BULLET.test(line.text) || (NUMBERED.test(line.text) && line.x0 - columnLeft > em * 0.3)) fresh = true;
      else if (line.x0 - Math.min(columnLeft, current.lines[0].x0) > em * 0.7 && !(previous.x0 - columnLeft > em * 0.7)) fresh = true;
      else if (measures.justified && previous.x1 < columnLeft + measures.columnWidth - em * 0.6 && line.x0 <= columnLeft + em * 0.3 && bodyLike(previous, measures)) fresh = true;
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

function spansOf(lines: Line[], heading = false): Span[] {
  const spans: Span[] = [];
  const push = (span: Span) => {
    const last = spans[spans.length - 1];
    if (last && !!last.bold === !!span.bold && !!last.italic === !!span.italic && !!last.mono === !!span.mono && !!last.sup === !!span.sup && !!last.sub === !!span.sub) {
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
      if (tail.endsWith('-') && !sameBaseline) {
        // A word broken at the line's end: mend it, unless the break is at a
        // hyphen the word keeps — "self-" / "Attention", or "quasi-" /
        // "linear" where the paper writes "quasi-linear" elsewhere.
        const left = /([a-z]+)-$/i.exec(tail)?.[1];
        const right = /^([a-z]+)/i.exec(line.text)?.[1];
        const kept = left && right && keepsHyphen(left, right);
        if (/^[a-z]/.test(line.text) && /[a-z]{2}-$/.test(tail) && !kept) before.text = tail.slice(0, -1);
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
      if (end > Number.NEGATIVE_INFINITY && run.x - end > 0.08 * line.size) push({ text: ' ' });
      end = run.x + run.width;
      const small = run.size < line.size * 0.85;
      const raised = line.baseline - run.y > line.size * 0.15;
      const lowered = run.y - line.baseline > line.size * 0.1;
      push({
        text: piece.replace(/\s+/g, ' '),
        bold: !heading && run.bold && !line.allBold ? true : undefined,
        italic: run.italic && !line.allItalic ? true : undefined,
        mono: run.mono ? true : undefined,
        sup: small && raised ? true : undefined,
        sub: small && lowered ? true : undefined,
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

// ---------------------------------------------------------------- tables --

/**
 * The rows and columns of a table, from where its cells sit. Cells in a
 * column overlap horizontally, so columns are the groups of runs that do,
 * built from the narrowest runs up — a heading that spans two columns
 * overlaps both and is given a colspan rather than merging them.
 */
export function tableFromLines(lines: Line[], caption?: Line): TableCell[][] | null {
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

  const rows: Line[][] = [];
  for (const cell of cells.slice().sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0)) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].baseline - cell.baseline) <= 0.5 * Math.max(row[0].size, cell.size)) row.push(cell);
    else rows.push([cell]);
  }
  if (rows.length < 2) return null;
  const filled = rows.filter((row) => row.length >= 2).length;
  if (filled / rows.length < 0.5) return null;

  return rows.map((row) => {
    const out: TableCell[] = [];
    let at = 0;
    const sorted = row.slice().sort((a, b) => a.x0 - b.x0);
    for (const cell of sorted) {
      const span = placement.get(cell)!;
      const first = columns.indexOf(span[0]);
      const last = columns.indexOf(span[span.length - 1]);
      while (at < first) {
        out.push({ spans: [] });
        at += 1;
      }
      if (at > first) {
        // Two runs in one column on one row: the same cell, split by a gap.
        const previous = out[out.length - 1];
        if (previous) previous.spans = [...previous.spans, { text: ' ' }, ...spansOf([cell])];
        continue;
      }
      out.push({ spans: spansOf([cell]), colspan: last > first ? last - first + 1 : undefined });
      at = last + 1;
    }
    while (at < columns.length) {
      out.push({ spans: [] });
      at += 1;
    }
    return out;
  });
}

// --------------------------------------------------------------- headings --

function looksLikeHeading(paragraph: Paragraph, measures: Measures): boolean {
  const lines = paragraph.lines;
  if (lines.length > 3) return false;
  const text = plain(spansOf(lines));
  if (!text || text.length > 160) return false;
  if (paragraph.region || lines[0].caption) return false;
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
  dropFurniture(pages, inputs, measures);

  const crops: Crop[] = [];
  const crop = (region: Region, page: PageInput): Crop => {
    const pad = 3;
    const found: Crop = {
      id: crops.length,
      page: page.index,
      x0: Math.max(0, region.x0 - pad),
      y0: Math.max(0, region.y0 - pad),
      x1: Math.min(page.width, region.x1 + pad),
      y1: Math.min(page.height, region.y1 + pad),
    };
    crops.push(found);
    return found;
  };

  const blocks: Block[] = [];
  let characters = 0;
  let frontAuthors: string[] = [];
  let inReferences = false;
  const headings: { block: Extract<Block, { kind: 'heading' }>; size: number; numbered: number }[] = [];
  let carry: Extract<Block, { kind: 'paragraph' }> | null = null;
  let carryLast: Line | null = null;

  for (const [at, page] of inputs.entries()) {
    const lines = pages[at];
    findCaptions(lines, measures);
    const clusters = clusterGraphics(page);

    // Figures and tables, by their captions; then the lines inside them —
    // axis labels, legend entries, the cells of a table — leave the flow.
    const regions: Region[] = [];
    for (const line of lines) {
      if (!line.caption || line.taken) continue;
      const region = regionFor(line, lines, clusters, measures, page);
      if (!region) continue;
      regions.push(region);
      for (const held of region.lines) held.taken = true;
    }
    regions.push(...equationRegions(lines, clusters, measures, page));

    // Footnotes: small text at the foot of the page, below the body.
    const flow = lines.filter((line) => !line.taken);
    const feet = new Set<Line>();
    const bodyLines = flow.filter((line) => bodyLike(line, measures));
    // A bibliography is small type at the foot of the page too, and none of
    // it is a footnote: the lines read after its heading are left in the text.
    const read = readingOrder(flow.map((line) => ({ x0: line.x0, y0: line.top, x1: line.x1, y1: line.bottom, line }))).map((box) => box.line);
    const heading = read.findIndex((line) => REFERENCES_HEADING.test(line.text));
    const listed = new Set(inReferences ? read : heading >= 0 ? read.slice(heading) : []);
    for (const line of flow) {
      if (line.caption || line.allBold || listed.has(line)) continue;
      if (line.size > measures.bodySize - 1 || line.baseline < page.height * 0.6) continue;
      // Below the last body text of its own column: the other column may
      // run lower.
      const column = bodyLines.filter((other) => overlapX(other, line) > 0 && other.baseline > line.baseline + measures.bodySize);
      if (!column.length) feet.add(line);
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

    let paras = paragraphs(ordered, measures, columns, inReferences);
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
      const abstractAt = paras.findIndex((paragraph, index) => index < 40 && /^abstract\b/i.test(plain(spansOf(paragraph.lines))));
      frontAuthors = authorsOnFront(
        ordered.filter((line) => line.baseline < (abstractAt > 0 ? paras[abstractAt].lines[0].top : page.height * 0.4)),
        options.title,
      );
      if (abstractAt > 0) {
        paras = paras.slice(abstractAt);
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
        if (sameColumn && first.top >= region.y1 - 2 && (columns.get(first) ?? first.x0) <= region.x1) {
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
          const rows = tableFromLines(region.lines, region.caption);
          blocks.push({ kind: 'table', crop: crop(region, page), caption, label: region.label, rows, page: page.index });
        } else {
          blocks.push({ kind: 'figure', crop: crop(region, page), caption, label: region.label, page: page.index });
        }
        continue;
      }
      const spans = spansOf(paragraph.lines, looksLikeHeading(paragraph, measures));
      const text = plain(spans);
      if (!text) continue;
      characters += text.length;
      if (looksLikeHeading(paragraph, measures)) {
        carry = null;
        const numbered = /^(\d+(?:\.\d+)*)\.?\s/.exec(text);
        const block: Extract<Block, { kind: 'heading' }> = { kind: 'heading', level: 2, spans, page: page.index };
        headings.push({ block, size: round(paragraph.lines[0].size), numbered: numbered ? numbered[1].split('.').length : 0 });
        blocks.push(block);
        inReferences = /^(\d+(\.\d+)*\.?\s+)?(references|bibliography)\b/i.test(text);
        continue;
      }
      const list = BULLET.test(text) ? 'bullet' : NUMBERED.test(text) && !inReferences ? 'number' : undefined;
      // A paragraph that ran on from the previous column or page.
      if (carry && carryLast && !list && !paragraph.lines[0].caption) {
        const last = plain(carry.spans);
        const openEnded = !/[.!?:;"”’)\]]$/.test(last) || /[a-z],$/.test(last);
        const continues = /^[a-z(]/.test(text) || last.endsWith('-');
        const indented = paragraph.lines[0].x0 - paragraph.columnLeft > paragraph.lines[0].size * 0.7;
        // In a bibliography, whose entries often end without a full stop —
        // "Science 194 282–7" — only an entry's indented turnover runs on:
        // an entry starting at the margin is the next one.
        const runsOn = inReferences ? indented : continues || !indented;
        if (openEnded && runsOn && Math.abs(paragraph.lines[0].size - carryLast.size) <= 0.6) {
          carry.spans = mergeSpans(carry.spans, spans, last.endsWith('-') && /^[a-z]/.test(text));
          carryLast = paragraph.lines[paragraph.lines.length - 1];
          continue;
        }
      }
      const block: Extract<Block, { kind: 'paragraph' }> = { kind: 'paragraph', spans, page: page.index, list };
      blocks.push(block);
      carry = list ? null : block;
      carryLast = paragraph.lines[paragraph.lines.length - 1];
    }

    if (feet.size) {
      const footLines = readingOrder(Array.from(feet).map((line) => ({ x0: line.x0, y0: line.top, x1: line.x1, y1: line.bottom, line }))).map((box) => box.line);
      const notes = paragraphs(footLines, measures, columns, false);
      for (const note of notes) {
        const spans = spansOf(note.lines);
        if (plain(spans)) blocks.push({ kind: 'footnote', spans, page: page.index });
      }
    }
  }

  // Heading levels: by the numbering's depth where there is one, else by
  // size — the largest headings are sections.
  const sizes = Array.from(new Set(headings.map((entry) => entry.size))).sort((a, b) => b - a);
  for (const entry of headings) {
    const rank = sizes.indexOf(entry.size);
    const byNumber = entry.numbered ? Math.min(4, entry.numbered + 1) : 0;
    const bySize = Math.min(4, 2 + rank);
    entry.block.level = (byNumber || bySize) as 2 | 3 | 4;
  }

  return {
    blocks: splitReferences(blocks),
    crops,
    characters,
    readable: readable(blocks),
    bodySize: measures.bodySize,
    authors: frontAuthors.length ? frontAuthors : undefined,
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

/** A byline's line cut into the pieces that could each be a name. */
export function bylinePieces(text: string): string[] {
  return text
    .replace(/\S+@\S+/g, ' , ')
    .replace(/[*∗†‡§¶⋆♯♮✉#]+/g, ' ')
    .split(/\s*(?:,|;|·|•|\||\s{3,}|\band\b|&)\s*/)
    .map((piece) => piece.replace(/\s+/g, ' ').replace(/^[\s.,-]+|[\s,-]+$/g, '').trim())
    .filter(Boolean);
}

/** The names on the lines above a first page's abstract, in reading order. */
function authorsOnFront(lines: Line[], title?: string): string[] {
  const wanted = title ? normalTitle(title) : '';
  const names: string[] = [];
  for (const line of lines.slice(0, 40)) {
    const text = norm(line.text);
    const flat = normalTitle(text);
    if (!flat || (wanted && flat.length > 8 && wanted.includes(flat))) continue;
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
    if (pieces.length && pieces.every(looksLikeName)) {
      for (const name of pieces) if (!names.includes(name)) names.push(name);
    }
  }
  return names.length <= 60 ? names : [];
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
    const left = /([a-z]{2,})-$/i.exec(plain(joined))?.[1];
    const right = /^([a-z]+)/.exec(plain(entry.spans))?.[1];
    const mend = Boolean(left && right && !keepsHyphen(left, right));
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
  else if (last && !last.text.endsWith(' ')) out.push({ text: ' ' });
  for (const span of tail) out.push({ ...span });
  return out;
}

// ------------------------------------------------------------------ html ---

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] as string);
}

export function spansToHtml(spans: Span[]): string {
  return spans
    .map((span) => {
      let html = escapeHtml(span.text);
      if (span.mono) html = `<code>${html}</code>`;
      if (span.italic) html = `<em>${html}</em>`;
      if (span.bold) html = `<strong>${html}</strong>`;
      if (span.sup) html = `<sup>${html}</sup>`;
      if (span.sub) html = `<sub>${html}</sub>`;
      return html;
    })
    .join('');
}

/**
 * The document as HTML. Crops are images whose sources the caller supplies,
 * once it has painted them; a crop it has no image for is left out, with
 * its caption kept.
 */
export function renderHtml(layout: Layout, imageFor: (crop: Crop) => string | null): string {
  const out: string[] = [];
  let list: 'bullet' | 'number' | null = null;
  const closeList = () => {
    if (list) out.push(list === 'bullet' ? '</ul>' : '</ol>');
    list = null;
  };
  const image = (crop: Crop, alt: string, className: string) => {
    const src = imageFor(crop);
    if (!src) return '';
    const width = Math.round(crop.x1 - crop.x0);
    const height = Math.round(crop.y1 - crop.y0);
    return `<img class="${className}" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="${width}" height="${height}" loading="lazy" style="aspect-ratio: ${width} / ${height}">`;
  };
  for (const block of layout.blocks) {
    if (block.kind !== 'paragraph' || !block.list) closeList();
    switch (block.kind) {
      case 'heading':
        out.push(`<h${block.level}>${spansToHtml(block.spans)}</h${block.level}>`);
        break;
      case 'paragraph': {
        if (block.list) {
          if (list !== block.list) {
            closeList();
            list = block.list;
            out.push(list === 'bullet' ? '<ul>' : '<ol>');
          }
          const spans = block.spans.map((span, index) => (index === 0 ? { ...span, text: span.text.replace(list === 'bullet' ? BULLET : NUMBERED, (match) => match.slice(-1)) } : span));
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
          const body = block.rows
            .map((row, index) => {
              const tag = index === 0 ? 'th' : 'td';
              return `<tr>${row.map((cell) => `<${tag}${cell.colspan ? ` colspan="${cell.colspan}"` : ''}>${spansToHtml(cell.spans)}</${tag}>`).join('')}</tr>`;
            })
            .join('');
          out.push(`<figure class="pdf-table"><figcaption>${spansToHtml(block.caption)}</figcaption><table>${body}</table></figure>`);
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
