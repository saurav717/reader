// SyncTeX, read in the page: what takes a double-click on the compiled PDF to
// the line of LaTeX that made it, as Overleaf's does. TeX writes, beside the
// PDF (-synctex=1), every box and bit of glue it put on a page, each with the
// input file and line it came from; this reads that file (gzipped, as TeX
// leaves it) and finds what was under the click.
//
// The format: a preamble (Unit, Magnification, X/Y Offset), Input:<tag>:<path>
// lines (also between pages), then pages {n … }n of records, positions in
// scaled points from the page's top-left corner, y being the baseline:
//   [tag,line:x,y:W,H,D … ]   a vbox and what it holds
//   (tag,line:x,y:W,H,D … )   an hbox (a line of text, a figure)
//   vtag,line:x,y:W,H,D       an empty vbox; h the same, an empty hbox
//   xtag,line:x,y  ktag,line:x,y:W  gtag,line:x,y  $tag,line:x,y
//                             a current point, a kern, glue, math
// <form … > holds what a form (an XObject) is made of: not on a page, skipped.

/** A point SyncTeX recorded on a page, in PDF points (bp) from the top-left. */
interface SyncNode {
  tag: number;
  line: number;
  x: number;
  y: number;
}

/** A box: from x to x + w, and from y - h (above the baseline) to y + d. */
interface SyncBox extends SyncNode {
  w: number;
  h: number;
  d: number;
  /** An hbox (a line of text, a figure) rather than a vbox (a paragraph, the page). */
  horizontal: boolean;
  /** What it holds that SyncTeX recorded, nested boxes too. */
  kids: SyncNode[];
}

export interface SyncTex {
  /** Each input's tag and the path TeX opened it by. */
  inputs: Map<number, string>;
  /** Each page's boxes, by page number (from 1). */
  pages: Map<number, SyncBox[]>;
}

/** A place in the source: a file of the project (as the caller names it) and a line, from 1. */
export interface SyncPlace {
  file: string;
  line: number;
}

const SP_PER_BP = 65781.76;
const RECORD = /^([[(hvxkg$])(\d+),(-?\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/;

/** The text of a .synctex.gz, or of a .synctex already unzipped. */
export async function unzipSyncTex(bytes: Uint8Array): Promise<string> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** What TeX wrote in a .synctex, read into boxes by page. */
export function parseSyncTex(text: string): SyncTex {
  const inputs = new Map<number, string>();
  const pages = new Map<number, SyncBox[]>();
  let unit = 1;
  let magnification = 1000;
  let xOffset = 0;
  let yOffset = 0;
  let scale = 1 / SP_PER_BP;
  let content = false;
  let page: SyncBox[] | null = null;
  const open: SyncBox[] = [];
  let form = 0;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line) continue;
    const first = line[0];
    if (first === 'I' && line.startsWith('Input:')) {
      const at = line.indexOf(':', 6);
      if (at > 6) inputs.set(Number(line.slice(6, at)), line.slice(at + 1));
      continue;
    }
    if (!content) {
      const [key, value] = [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)];
      if (key === 'Unit') unit = Number(value) || 1;
      else if (key === 'Magnification') magnification = Number(value) || 1000;
      else if (key === 'X Offset') xOffset = Number(value) || 0;
      else if (key === 'Y Offset') yOffset = Number(value) || 0;
      else if (key === 'Content') {
        content = true;
        scale = (unit / SP_PER_BP) * (magnification / 1000);
      }
      continue;
    }
    if (first === 'P' && line.startsWith('Postamble')) break;
    if (first === '<') {
      form += 1;
      continue;
    }
    if (first === '>') {
      form = Math.max(0, form - 1);
      continue;
    }
    if (form) continue;
    if (first === '{') {
      const n = Number(line.slice(1));
      page = pages.get(n) ?? [];
      pages.set(n, page);
      open.length = 0;
      continue;
    }
    if (first === '}') {
      page = null;
      open.length = 0;
      continue;
    }
    if (!page) continue;
    if (first === ']' || first === ')') {
      open.pop();
      continue;
    }
    const match = RECORD.exec(line);
    if (!match) continue;
    const node: SyncNode = {
      tag: Number(match[2]),
      line: Number(match[3]),
      x: Number(match[4]) * scale + xOffset / SP_PER_BP,
      y: Number(match[5]) * scale + yOffset / SP_PER_BP,
    };
    open[open.length - 1]?.kids.push(node);
    if (first === '[' || first === '(' || first === 'h' || first === 'v') {
      const box: SyncBox = { ...node, w: Number(match[6] ?? 0) * scale, h: Number(match[7] ?? 0) * scale, d: Number(match[8] ?? 0) * scale, horizontal: first === '(' || first === 'h', kids: [] };
      page.push(box);
      if (first === '[' || first === '(') open.push(box);
    }
  }
  return { inputs, pages };
}

/** The project file TeX opened by `opened` (an absolute path on the compiler, say): the longest of `files` it ends with. */
export function projectFile(opened: string, files: string[]): string | null {
  const path = opened.replace(/\\/g, '/').replace(/\/(\.\/)+/g, '/').replace(/^(\.\/)+/, '');
  let best: string | null = null;
  for (const file of files) {
    if ((path === file || path.endsWith(`/${file}`)) && (!best || file.length > best.length)) best = file;
  }
  return best;
}

/**
 * The source line under a point of a page: x and y in PDF points from the page's
 * top-left corner. The smallest hbox about the point (a line of text, a figure),
 * or the nearest when none is, and in it the first thing recorded at or after
 * the point, so a click lands on the line of the word clicked; null when nothing on
 * the page came from one of `files`.
 */
export function sourceAt(sync: SyncTex, page: number, x: number, y: number, files: string[]): SyncPlace | null {
  const boxes = sync.pages.get(page);
  if (!boxes?.length) return null;
  const named = new Map<number, string | null>();
  const fileOf = (tag: number) => {
    if (!named.has(tag)) named.set(tag, projectFile(sync.inputs.get(tag) ?? '', files));
    return named.get(tag) ?? null;
  };
  const ours = (node: SyncNode) => node.line > 0 && fileOf(node.tag) !== null;
  const distance = (box: SyncBox) => {
    const dx = x < box.x ? box.x - x : x > box.x + box.w ? x - box.x - box.w : 0;
    const dy = y < box.y - box.h ? box.y - box.h - y : y > box.y + box.d ? y - box.y - box.d : 0;
    return Math.hypot(dx, dy);
  };
  let best: SyncBox | null = null;
  let bestDistance = Infinity;
  let bestArea = Infinity;
  for (const box of boxes) {
    if (!box.horizontal || !(ours(box) || box.kids.some(ours))) continue;
    const away = distance(box);
    const area = Math.max(box.w, 0.01) * Math.max(box.h + box.d, 0.01);
    if (away < bestDistance - 0.01 || (Math.abs(away - bestDistance) <= 0.01 && area < bestArea)) {
      best = box;
      bestDistance = away;
      bestArea = area;
    }
  }
  if (!best) {
    // No hbox from the project here: the nearest vbox's line, then.
    for (const box of boxes) {
      if (!ours(box)) continue;
      const away = distance(box);
      if (away < bestDistance) {
        best = box;
        bestDistance = away;
      }
    }
  }
  if (!best) return null;
  // TeX records a word where it ends: the first record at or after the point is the word's.
  const kids = best.kids.filter(ours);
  const after = kids.filter((kid) => kid.x >= x - 0.5);
  const node = after.length ? after.reduce((a, b) => (b.x < a.x ? b : a)) : kids.length ? kids.reduce((a, b) => (b.x >= a.x ? b : a)) : best;
  const place = ours(node) ? node : best;
  const file = fileOf(place.tag);
  return file ? { file, line: place.line } : null;
}
