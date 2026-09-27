/**
 * What pdf.js finds on a page, as the plain numbers `pdfLayout` reads: every
 * run of glyphs with its font, the box of every drawing, and where the
 * page's links point. Kept apart from `pdfReflow`, which starts pdf.js's
 * worker, so that the same reading runs under Node in the tests.
 */
import { AnnotationMode, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { GraphicBox, PageInput, PageLink, SidewaysRun, TextRun } from './pdfLayout';

type Matrix = [number, number, number, number, number, number];

/** `m1 × m2`: the transform that applies `m2` first, then `m1`. */
function multiply(m1: ArrayLike<number>, m2: ArrayLike<number>): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

const apply = (m: Matrix, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

/** The four corners of a box under a transform, boxed again. */
function transformed(matrix: Matrix, x0: number, y0: number, x1: number, y1: number): GraphicBox | null {
  const corners = [apply(matrix, x0, y0), apply(matrix, x1, y0), apply(matrix, x0, y1), apply(matrix, x1, y1)];
  const xs = corners.map((point) => point[0]);
  const ys = corners.map((point) => point[1]);
  const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), kind: 'path' as const };
  return Number.isFinite(box.x0) && Number.isFinite(box.y0) && Number.isFinite(box.x1) && Number.isFinite(box.y1) ? box : null;
}

/**
 * Where everything is drawn on a page, in points from the top-left corner.
 * The operator list is replayed with only the transformation stack kept,
 * which is enough to know where each image and path lands.
 */
function graphicsOf(page: PDFPageProxy, fnArray: number[], argsArray: unknown[], base: Matrix): { boxes: GraphicBox[]; hidden: [number, number][] } {
  const boxes: GraphicBox[] = [];
  // Where text is set outside its clip — a plot's title left over the top
  // of the box it was cut to — and so never seen.
  const hidden: [number, number][] = [];
  let line: Matrix = [1, 0, 0, 1, 0, 0];
  let text: Matrix = line;
  // The transform, and the region drawing is clipped to: what is drawn
  // outside it is not seen — a figure's white background as big as the
  // slide it was made on, cut down to the figure — and is not the figure.
  type State = { ctm: Matrix; clip: GraphicBox | null };
  let state: State = { ctm: base, clip: null };
  const stack: State[] = [];
  let clipping = false;
  const narrow = (box: GraphicBox): GraphicBox | null => {
    const clip = state.clip;
    if (!clip) return box;
    const cut = { x0: Math.max(box.x0, clip.x0), y0: Math.max(box.y0, clip.y0), x1: Math.min(box.x1, clip.x1), y1: Math.min(box.y1, clip.y1), kind: box.kind };
    return cut.x1 >= cut.x0 && cut.y1 >= cut.y0 ? cut : null;
  };
  const PAINT_OPS = new Set([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  for (let at = 0; at < fnArray.length; at += 1) {
    const fn = fnArray[at];
    const args = argsArray[at] as unknown[] | null;
    switch (fn) {
      case OPS.save:
        stack.push(state);
        break;
      case OPS.restore:
        state = stack.pop() ?? { ctm: base, clip: null };
        break;
      case OPS.transform:
        if (args && args.length >= 6) state = { ...state, ctm: multiply(state.ctm, args as ArrayLike<number>) };
        break;
      case OPS.paintFormXObjectBegin: {
        stack.push(state);
        const matrix = args?.[0] as Matrix | null | undefined;
        if (matrix && matrix.length >= 6) state = { ...state, ctm: multiply(state.ctm, matrix) };
        // A form draws only inside its box.
        const bbox = args?.[1] as ArrayLike<number> | null | undefined;
        const box = bbox && bbox.length >= 4 ? transformed(state.ctm, bbox[0], bbox[1], bbox[2], bbox[3]) : null;
        if (box) state = { ...state, clip: narrow(box) ?? { ...box, x1: box.x0, y1: box.y0 } };
        break;
      }
      case OPS.paintFormXObjectEnd:
        state = stack.pop() ?? { ctm: base, clip: null };
        break;
      case OPS.beginText:
        line = text = [1, 0, 0, 1, 0, 0];
        break;
      case OPS.setTextMatrix:
        if (args && args.length >= 6) line = text = Array.from(args as ArrayLike<number>).slice(0, 6) as unknown as Matrix;
        else if (args?.[0] && (args[0] as ArrayLike<number>).length >= 6) line = text = Array.from(args[0] as ArrayLike<number>).slice(0, 6) as unknown as Matrix;
        break;
      case OPS.moveText:
      case OPS.setLeadingMoveText:
        if (args && args.length >= 2) line = text = multiply(line, [1, 0, 0, 1, Number(args[0]), Number(args[1])]);
        break;
      case OPS.showText:
      case OPS.showSpacedText:
      case OPS.nextLineShowText:
      case OPS.nextLineSetSpacingShowText: {
        const clip = state.clip;
        if (!clip) break;
        const [, , , , x, y] = multiply(state.ctm, text);
        if (x < clip.x0 - 1 || x > clip.x1 + 1 || y < clip.y0 - 1 || y > clip.y1 + 1) hidden.push([x, y]);
        break;
      }
      case OPS.clip:
      case OPS.eoClip:
        // The path that follows is the clip.
        clipping = true;
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject: {
        const box = transformed(state.ctm, 0, 0, 1, 1);
        const seen = box && narrow({ ...box, kind: 'image' });
        if (seen) boxes.push(seen);
        break;
      }
      case OPS.constructPath: {
        const op = args?.[0] as number | undefined;
        const minMax = args?.[2] as ArrayLike<number> | null | undefined;
        const box = minMax && minMax.length >= 4 ? transformed(state.ctm, minMax[0], minMax[1], minMax[2], minMax[3]) : null;
        if (clipping) {
          clipping = false;
          if (box) state = { ...state, clip: narrow(box) ?? { ...box, x1: box.x0, y1: box.y0 } };
        }
        if (op === undefined || !PAINT_OPS.has(op) || !box) break;
        const seen = narrow(box);
        if (seen) boxes.push(seen);
        break;
      }
      default:
        break;
    }
  }
  void page;
  return { boxes, hidden };
}

/** Everything on one page that the layout needs. */
export async function extractPage(page: PDFPageProxy): Promise<PageInput> {
  const viewport = page.getViewport({ scale: 1 });
  const base = viewport.transform as Matrix;
  // The operator list first: it is what loads the fonts, and their names
  // — bold, italic, mathematics — are what the text is read by.
  // Without the annotations' own drawings: the boxes a PDF draws round its
  // links, one on each line with a citation, would chain into one frame
  // over a paragraph and make it part of the figure under it.
  const operators = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
  const { boxes: graphics, hidden } = graphicsOf(page, operators.fnArray, operators.argsArray, base);
  const content = await page.getTextContent();
  const fontNames = new Map<string, string>();
  const runs: TextRun[] = [];
  const sideways: SidewaysRun[] = [];
  for (const item of content.items) {
    if (!('str' in item) || !item.str) continue;
    const matrix = multiply(base, item.transform as ArrayLike<number>);
    const [a, b, c, d, e, f] = matrix;
    // Text drawn outside its clip is not on the page to read.
    if (hidden.some(([x, y]) => Math.abs(x - e) < 1.5 && Math.abs(y - f) < 1.5)) continue;
    // Text set sideways — the arXiv stamp down the margin, a table's label
    // for a group of rows — is not read with the text, but kept aside by
    // its box, for a table to take the labels beside it.
    if (Math.abs(b) > 0.05 * Math.abs(a) || Math.abs(c) > 0.05 * Math.abs(d)) {
      const size = Math.hypot(a, b);
      const along = item.width * viewport.scale;
      if (!(size > 0) || !item.str.trim()) continue;
      const [ux, uy] = [a / size, b / size];
      const corners = [
        [e, f],
        [e + ux * along, f + uy * along],
        [e + c, f + d],
        [e + ux * along + c, f + uy * along + d],
      ];
      const xs = corners.map((point) => point[0]);
      const ys = corners.map((point) => point[1]);
      sideways.push({ str: item.str, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), size });
      continue;
    }
    if (a <= 0) continue;
    const size = Math.hypot(c, d);
    if (!(size > 0)) continue;
    let font = fontNames.get(item.fontName);
    if (font === undefined) {
      font = '';
      try {
        const loaded = page.commonObjs.has(item.fontName) ? (page.commonObjs.get(item.fontName) as { name?: string } | null) : null;
        font = loaded?.name || content.styles[item.fontName]?.fontFamily || '';
      } catch {
        font = content.styles[item.fontName]?.fontFamily || '';
      }
      fontNames.set(item.fontName, font);
    }
    runs.push({ str: item.str, x: e, y: f, width: item.width * viewport.scale, size, font });
  }
  return { index: page.pageNumber - 1, width: viewport.width, height: viewport.height, runs, graphics, links: await linksOf(page, base), sideways };
}

/**
 * The page's links out — a URL, an email address — as boxes on the page.
 * Links within the document (a citation to its entry, "Figure 3" to the
 * figure) are left to the reader, which marks citations its own way.
 */
async function linksOf(page: PDFPageProxy, base: Matrix): Promise<PageLink[]> {
  let annotations: unknown[];
  try {
    annotations = await page.getAnnotations({ intent: 'display' });
  } catch {
    return [];
  }
  const links: PageLink[] = [];
  for (const entry of annotations) {
    const annotation = entry as { subtype?: string; url?: string; unsafeUrl?: string; rect?: number[] };
    if (annotation.subtype !== 'Link' || !annotation.rect || annotation.rect.length < 4) continue;
    // pdf.js leaves `url` unset for a scheme it will not open itself; the
    // raw one is only taken when it is plainly a web or mail address.
    const raw = annotation.url || annotation.unsafeUrl || '';
    const url = /^(https?:\/\/|mailto:)/i.test(raw) ? raw : /^www\./i.test(raw) ? `https://${raw}` : '';
    if (!url) continue;
    const [x0, y0, x1, y1] = annotation.rect;
    const box = transformed(base, x0, y0, x1, y1);
    if (box) links.push({ x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1, url });
  }
  return links;
}
