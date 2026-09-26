/**
 * What pdf.js finds on a page, as the plain numbers `pdfLayout` reads: every
 * run of glyphs with its font, the box of every drawing, and where the
 * page's links point. Kept apart from `pdfReflow`, which starts pdf.js's
 * worker, so that the same reading runs under Node in the tests.
 */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { GraphicBox, PageInput, PageLink, TextRun } from './pdfLayout';

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
function graphicsOf(page: PDFPageProxy, fnArray: number[], argsArray: unknown[], base: Matrix): GraphicBox[] {
  const boxes: GraphicBox[] = [];
  let ctm: Matrix = base;
  const stack: Matrix[] = [];
  const PAINT_OPS = new Set([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  for (let at = 0; at < fnArray.length; at += 1) {
    const fn = fnArray[at];
    const args = argsArray[at] as unknown[] | null;
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? base;
        break;
      case OPS.transform:
        if (args && args.length >= 6) ctm = multiply(ctm, args as ArrayLike<number>);
        break;
      case OPS.paintFormXObjectBegin: {
        stack.push(ctm);
        const matrix = args?.[0] as Matrix | null | undefined;
        if (matrix && matrix.length >= 6) ctm = multiply(ctm, matrix);
        break;
      }
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? base;
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject: {
        const box = transformed(ctm, 0, 0, 1, 1);
        if (box) boxes.push({ ...box, kind: 'image' });
        break;
      }
      case OPS.constructPath: {
        const op = args?.[0] as number | undefined;
        const minMax = args?.[2] as ArrayLike<number> | null | undefined;
        if (op === undefined || !PAINT_OPS.has(op) || !minMax || minMax.length < 4) break;
        const box = transformed(ctm, minMax[0], minMax[1], minMax[2], minMax[3]);
        if (box) boxes.push(box);
        break;
      }
      default:
        break;
    }
  }
  void page;
  return boxes;
}

/** Everything on one page that the layout needs. */
export async function extractPage(page: PDFPageProxy): Promise<PageInput> {
  const viewport = page.getViewport({ scale: 1 });
  const base = viewport.transform as Matrix;
  // The operator list first: it is what loads the fonts, and their names
  // — bold, italic, mathematics — are what the text is read by.
  const operators = await page.getOperatorList();
  const graphics = graphicsOf(page, operators.fnArray, operators.argsArray, base);
  const content = await page.getTextContent();
  const fontNames = new Map<string, string>();
  const runs: TextRun[] = [];
  for (const item of content.items) {
    if (!('str' in item) || !item.str) continue;
    const matrix = multiply(base, item.transform as ArrayLike<number>);
    const [a, b, c, d, e, f] = matrix;
    // Text set sideways — the arXiv stamp down the margin — is not read.
    if (Math.abs(b) > 0.05 * Math.abs(a) || Math.abs(c) > 0.05 * Math.abs(d)) continue;
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
  return { index: page.pageNumber - 1, width: viewport.width, height: viewport.height, runs, graphics, links: await linksOf(page, base) };
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
