/**
 * Whether a PDF that came back from one of a paper's copies is the paper.
 *
 * "The first copy that returns PDF bytes" is not always the paper: a
 * conference's page links the poster that was shown at it, a repository
 * deposit is the talk's slides, a workshop copy is the two-page extended
 * abstract. All of them are PDFs, so the proxy passes them. Their shape
 * gives them away, though — a poster is one enormous page, slides are
 * landscape, an abstract is a page or two — and a copy that looks like one
 * of those is held back while the other copies are asked, and shown only
 * when none of them has anything better.
 *
 * `judgePdf` in `paperContent` is the same question asked of a file, with
 * pdf.js loaded to measure it; this is the part that decides.
 */

export interface PdfMeasure {
  pages: number;
  /** The first page, in points (1/72 in). */
  width: number;
  height: number;
}

/** A4's long side is 842 pt and US Letter's 792: anything much past that is not a page of a paper. */
const POSTER_SIDE = 1300;

/**
 * Why a PDF of these proportions is probably not the paper, or null when it
 * looks like one. Said the way the reader shows it: "looks like a poster".
 */
export function pdfShape(measure: PdfMeasure): string | null {
  const { pages, width, height } = measure;
  if (!pages || !width || !height) return null;
  const longest = Math.max(width, height);
  if (pages <= 2 && longest > POSTER_SIDE) {
    const inches = (points: number) => Math.round(points / 72);
    return `looks like a poster — ${pages === 1 ? 'one page' : 'two pages'} of ${inches(width)}×${inches(height)} in`;
  }
  // A 4:3 or 16:9 page on its side. A paper's landscape table page is not
  // the first page, so the first one is the one looked at.
  if (width / height >= 1.25 && pages > 2) return `looks like slides — ${pages} landscape pages`;
  if (pages <= 2) return `only ${pages === 1 ? 'one page' : 'two pages'} — an abstract, perhaps, rather than the paper`;
  return null;
}
