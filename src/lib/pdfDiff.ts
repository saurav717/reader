// Two PDFs compared page by page, the changed regions of each found: from
// saurav717/diff-checker (js/pdf-visual.js and the PDF part of js/parsers.js),
// ported to this app's pdf.js and its own sequence diff (textDiff.ts).
//
// Two ways of comparing, chosen for each page:
//
// 1. Words — when both pages have a text layer worth trusting: their words in
//    reading order are diffed, and what was removed (A) or added (B) is boxed.
//    Copes with text that reflowed.
// 2. Pixels — when a page's text layer is missing or unreliable: the rendered
//    pages are compared, aligned band by band so a shift isn't a change, and
//    the regions of ink not explained by the other side are boxed.

import { Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { openPdf } from './pdfReflow';
import { diffSequences } from './textDiff';

export interface PdfWord {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A page rendered, with its words where they are on it (in its pixels). */
export interface PdfPageImage {
  url: string;
  vw: number;
  vh: number;
  words: PdfWord[];
}

export interface PdfBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The whole page: it has no counterpart on the other side. */
  whole?: boolean;
}

export interface PdfDiffPage {
  a: { url: string; vw: number; vh: number; boxes: PdfBox[] } | null;
  b: { url: string; vw: number; vh: number; boxes: PdfBox[] } | null;
  changed: boolean;
}

export interface PdfDiff {
  pages: PdfDiffPage[];
  stats: { add: number; del: number };
  usedPixel: boolean;
}

const RENDER_SCALE = 1.5;

/** Each page of a PDF rendered and its words placed, as the compare needs them. */
export async function pdfPages(blob: Blob, scale = RENDER_SCALE): Promise<PdfPageImage[]> {
  const { doc, close } = await openPdf(blob);
  const pages: PdfPageImage[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp, canvas } as Parameters<typeof page.render>[0]).promise;
      const text = await page.getTextContent();
      const words: PdfWord[] = [];
      for (const item of text.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const tx = Util.transform(vp.transform, item.transform);
        const fontH = Math.hypot(tx[2], tx[3]);
        const totalW = item.width * vp.scale;
        const charW = totalW / Math.max(1, item.str.length);
        for (const match of item.str.matchAll(/\S+/g)) words.push({ str: match[0], x: tx[4] + (match.index ?? 0) * charW, y: tx[5] - fontH, w: match[0].length * charW, h: fontH });
      }
      pages.push({ url: canvas.toDataURL('image/png'), vw: canvas.width, vh: canvas.height, words });
      canvas.width = canvas.height = 0;
      page.cleanup();
    }
  } finally {
    close();
  }
  return pages;
}

// ------------------------------------------------------------- words --

/** pdf.js gives text in the order it was drawn, not read: put into reading order, so the same text gives the same words. */
function readingOrder(words: PdfWord[]): PdfWord[] {
  const sorted = [...words].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: { cy: number; h: number; items: PdfWord[] }[] = [];
  let line: (typeof lines)[number] | null = null;
  for (const word of sorted) {
    if (line && Math.abs(word.y + word.h / 2 - line.cy) <= Math.max(word.h, line.h) * 0.6) {
      line.items.push(word);
      line.cy = (line.cy * (line.items.length - 1) + (word.y + word.h / 2)) / line.items.length;
      line.h = Math.max(line.h, word.h);
    } else {
      line = { cy: word.y + word.h / 2, h: word.h, items: [word] };
      lines.push(line);
    }
  }
  return lines.flatMap((one) => one.items.sort((a, b) => a.x - b.x));
}

/** Words side by side on a line, as one box. */
function mergeBoxes(words: PdfWord[]): PdfBox[] {
  const sorted = [...words].sort((p, q) => p.y - q.y || p.x - q.x);
  const boxes: PdfBox[] = [];
  let box: PdfBox | null = null;
  for (const word of sorted) {
    if (box && Math.abs(word.y - box.y) <= box.h * 0.6 && word.x <= box.x + box.w + box.h * 0.9) {
      const right = Math.max(box.x + box.w, word.x + word.w);
      box.x = Math.min(box.x, word.x);
      box.w = right - box.x;
      box.y = Math.min(box.y, word.y);
      box.h = Math.max(box.h, word.h);
    } else {
      box = { x: word.x, y: word.y, w: word.w, h: word.h };
      boxes.push(box);
    }
  }
  return boxes;
}

interface PageDiff {
  hlA: PdfBox[];
  hlB: PdfBox[];
  del: number;
  add: number;
}

function wordDiffPage(A: PdfPageImage | null, B: PdfPageImage | null): PageDiff {
  const aw = A ? readingOrder(A.words) : [];
  const bw = B ? readingOrder(B.words) : [];
  const removed: PdfWord[] = [];
  const added: PdfWord[] = [];
  for (const part of diffSequences(aw, bw, (x, y) => x.str === y.str)) {
    if (part.kind === 'removed') removed.push(...part.items);
    else if (part.kind === 'added') added.push(...part.items);
  }
  return { hlA: mergeBoxes(removed), hlB: mergeBoxes(added), del: removed.length, add: added.length };
}

// ------------------------------------------------------------ pixels --

function imageData(url: string, width: number, height: number): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        const data = ctx.getImageData(0, 0, width, height);
        canvas.width = canvas.height = 0;
        resolve(data);
      } catch (error) {
        reject(error);
      }
    };
    img.onerror = reject;
    img.src = url;
  });
}

/** A mask of cells grown, so strokes and words near each other join into one region. */
function dilate(src: Uint8Array, cols: number, rows: number, rx: number, ry: number): Uint8Array {
  const out = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y += 1)
    for (let x = 0; x < cols; x += 1) {
      let on = 0;
      for (let dy = -ry; dy <= ry && !on; dy += 1)
        for (let dx = -rx; dx <= rx; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          if (src[ny * cols + nx]) {
            on = 1;
            break;
          }
        }
      out[y * cols + x] = on;
    }
  return out;
}

/** The mask's connected regions (8 neighbours), each with its bounds and cells. */
function labelRegions(mask: Uint8Array, cols: number, rows: number) {
  const seen = new Uint8Array(cols * rows);
  const regions: { x0: number; y0: number; x1: number; y1: number; cells: number[] }[] = [];
  const stack: number[] = [];
  for (let s = 0; s < cols * rows; s += 1) {
    if (!mask[s] || seen[s]) continue;
    stack.length = 0;
    stack.push(s);
    seen[s] = 1;
    let x0 = cols;
    let y0 = rows;
    let x1 = 0;
    let y1 = 0;
    const cells: number[] = [];
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % cols;
      const cy = (c / cols) | 0;
      cells.push(c);
      x0 = Math.min(x0, cx);
      x1 = Math.max(x1, cx);
      y0 = Math.min(y0, cy);
      y1 = Math.max(y1, cy);
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const ni = ny * cols + nx;
          if (mask[ni] && !seen[ni]) {
            seen[ni] = 1;
            stack.push(ni);
          }
        }
    }
    regions.push({ x0, y0, x1, y1, cells });
  }
  return regions;
}

/**
 * How far B is shifted from A, band by band down the page: the offset that
 * matches the most ink, so added or removed content doesn't pull it off.
 */
function bandOffsets(gA: Float32Array, gB: Float32Array, W: number, H: number) {
  const BH = 32;
  const ALIGN_T = 45;
  const nb = Math.ceil(H / BH);
  const offs: { gx: number; gy: number; has: boolean }[] = new Array(nb);
  for (let b = 0; b < nb; b += 1) {
    const y0 = b * BH;
    const y1 = Math.min(H, y0 + BH);
    let best = -1;
    let by = 0;
    let bx = 0;
    for (let oy = -8; oy <= 8; oy += 1)
      for (let ox = -4; ox <= 4; ox += 1) {
        let match = 0;
        for (let y = y0; y < y1; y += 3) {
          const ay = y + oy;
          if (ay < 0 || ay >= H) continue;
          for (let x = 0; x < W; x += 3) {
            const ax = x + ox;
            if (ax < 0 || ax >= W) continue;
            const vb = gB[y * W + x];
            const va = gA[ay * W + ax];
            if ((vb < 235 || va < 235) && Math.abs(vb - va) < ALIGN_T) match += 1;
          }
        }
        if (match > best) (best = match), (by = oy), (bx = ox);
      }
    offs[b] = { gx: bx, gy: by, has: best > 12 };
  }
  // Bands mostly blank take the nearest aligned band's offset.
  let last: (typeof offs)[number] | null = null;
  for (let b = 0; b < nb; b += 1) {
    if (offs[b].has) last = offs[b];
    else if (last) offs[b] = { gx: last.gx, gy: last.gy, has: false };
  }
  last = null;
  for (let b = nb - 1; b >= 0; b -= 1) {
    if (offs[b].has) last = offs[b];
    else if (last) offs[b] = { gx: last.gx, gy: last.gy, has: false };
  }
  return { offs, BH, nb };
}

const CELL = 8;
const INK = 205;
const MATCH_T = 55;
const MIN_PX = 5;

async function pixelDiffPage(A: PdfPageImage | null, B: PdfPageImage | null): Promise<PageDiff> {
  if (A && !B) return { hlA: [{ x: 0, y: 0, w: A.vw, h: A.vh, whole: true }], hlB: [], del: 1, add: 0 };
  if (B && !A) return { hlA: [], hlB: [{ x: 0, y: 0, w: B.vw, h: B.vh, whole: true }], del: 0, add: 1 };
  if (!A || !B) return { hlA: [], hlB: [], del: 0, add: 0 };
  const W = A.vw;
  const H = A.vh;
  const da = (await imageData(A.url, W, H)).data;
  const db = (await imageData(B.url, W, H)).data;
  const gA = new Float32Array(W * H);
  const gB = new Float32Array(W * H);
  for (let p = 0, i = 0; p < W * H; p += 1, i += 4) {
    gA[p] = 0.299 * da[i] + 0.587 * da[i + 1] + 0.114 * da[i + 2];
    gB[p] = 0.299 * db[i] + 0.587 * db[i + 1] + 0.114 * db[i + 2];
  }
  const cols = Math.ceil(W / CELL);
  const rows = Math.ceil(H / CELL);
  const chgA = new Uint16Array(cols * rows);
  const chgB = new Uint16Array(cols * rows);
  const { offs, BH, nb } = bandOffsets(gA, gB, W, H);
  const RX = 2;
  const RY = 4;
  // Ink counts as changed only when nothing near it, aligned, on the other side looks like it.
  const unmatched = (value: number, other: Float32Array, cy: number, cx: number) => {
    let m = Infinity;
    for (let dy = -RY; dy <= RY && m > MATCH_T; dy += 1) {
      const y = cy + dy;
      if (y < 0 || y >= H) continue;
      for (let dx = -RX; dx <= RX; dx += 1) {
        const x = cx + dx;
        if (x < 0 || x >= W) continue;
        m = Math.min(m, Math.abs(value - other[y * W + x]));
        if (m <= MATCH_T) break;
      }
    }
    return m > MATCH_T;
  };
  for (let y = 0; y < H; y += 1) {
    const cellRow = ((y / CELL) | 0) * cols;
    const band = offs[Math.min(nb - 1, (y / BH) | 0)];
    for (let x = 0; x < W; x += 1) {
      const p = y * W + x;
      const lb = gB[p];
      const la = gA[p];
      if (lb >= INK && la >= INK) continue;
      const ci = cellRow + ((x / CELL) | 0);
      if (lb < INK && unmatched(lb, gA, y + band.gy, x + band.gx)) chgB[ci] += 1;
      if (la < INK && unmatched(la, gB, y - band.gy, x - band.gx)) chgA[ci] += 1;
    }
  }
  const changed = new Uint8Array(cols * rows);
  for (let c = 0; c < cols * rows; c += 1) if (chgA[c] >= MIN_PX || chgB[c] >= MIN_PX) changed[c] = 1;
  const hlA: PdfBox[] = [];
  const hlB: PdfBox[] = [];
  let add = 0;
  let del = 0;
  for (const region of labelRegions(dilate(changed, cols, rows, 3, 1), cols, rows)) {
    if (region.cells.length < 4) continue;
    let ca = 0;
    let cb = 0;
    for (const ci of region.cells) (ca += chgA[ci]), (cb += chgB[ci]);
    const box = { x: region.x0 * CELL, y: region.y0 * CELL, w: (region.x1 - region.x0 + 1) * CELL, h: (region.y1 - region.y0 + 1) * CELL };
    const lo = Math.min(ca, cb);
    const hi = Math.max(ca, cb) || 1;
    // Much the same ink changed on both sides: replaced in place, shown on both.
    if (lo / hi >= 0.45) hlA.push({ ...box }), hlB.push({ ...box }), (del += 1), (add += 1);
    else if (cb > ca) hlB.push(box), (add += 1);
    else hlA.push(box), (del += 1);
  }
  return { hlA, hlB, add, del };
}

/** Both pages with enough text, and about as much: worth comparing by words. */
function textLayerReliable(A: PdfPageImage, B: PdfPageImage): boolean {
  const na = A.words.length;
  const nb = B.words.length;
  const lo = Math.min(na, nb);
  return lo >= 20 && lo / Math.max(na, nb) >= 0.6;
}

/** Two PDFs' pages compared, A the one before (removed), B the one after (added). */
export async function diffPdfPages(pa: PdfPageImage[], pb: PdfPageImage[]): Promise<PdfDiff> {
  const pages: PdfDiffPage[] = [];
  let add = 0;
  let del = 0;
  let usedPixel = false;
  for (let p = 0; p < Math.max(pa.length, pb.length); p += 1) {
    const A = pa[p] ?? null;
    const B = pb[p] ?? null;
    let d: PageDiff;
    if (A && B && textLayerReliable(A, B)) d = wordDiffPage(A, B);
    else {
      usedPixel = true;
      try {
        d = await pixelDiffPage(A, B);
      } catch {
        d = wordDiffPage(A, B);
      }
    }
    add += d.add;
    del += d.del;
    pages.push({ a: A ? { url: A.url, vw: A.vw, vh: A.vh, boxes: d.hlA } : null, b: B ? { url: B.url, vw: B.vw, vh: B.vh, boxes: d.hlB } : null, changed: d.add + d.del > 0 });
  }
  return { pages, stats: { add, del }, usedPixel };
}

/** Two PDFs compared. */
export async function diffPdfs(a: Blob, b: Blob): Promise<PdfDiff> {
  return diffPdfPages(await pdfPages(a), await pdfPages(b));
}
