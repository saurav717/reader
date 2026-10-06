// ===========================================================================
//  Pictures in an answer: a figure or table of the paper, or a page of the
//  PDF, that the answer names as ![caption](figure:3), (table:2) or (page:4).
//  The Markdown draws each as an <img> with no source; once the answer is
//  on screen the picture is looked up — on the page first, where the paper's
//  figures are the images the Reflow column or the Explain page shows and a
//  PDF's page is its canvas, then among the pictures that went with the
//  question, which are the pages and figures that were in view when it was
//  asked — and drawn in place, sized by the window's styles to fit.
// ===========================================================================

/** The longest side of a page drawn into an answer. */
const PAGE_PIXELS = 1200;

/** Whether a caption names this figure or table: "Figure 3", "Fig. 3", "Table 2", at its start or anywhere in it. */
export function names(caption: string, kind: string, ref: string): boolean {
  const number = ref.replace(/[^\w.]/g, '');
  if (!number) return false;
  const word = kind === 'table' ? '(?:table|tab\\.?)' : '(?:figure|fig\\.?)';
  return new RegExp(`(?:^|[^\\w])${word}\\s*${number.replace(/\./g, '\\.')}(?!\\w|\\.\\d|\\s*\\d)`, 'i').test(caption);
}

/** The figure's picture as the page shows it: the image inside the figure whose caption names it. */
function onPage(kind: string, ref: string): string | null {
  const places = document.querySelectorAll<HTMLElement>('.paper-body figure, .paper-body .ltx_float, .explain-figure');
  for (const figure of Array.from(places)) {
    const caption = figure.querySelector('figcaption, .ltx_caption');
    const text = (caption?.textContent ?? '').replace(/\s+/g, ' ');
    const image = figure.querySelector<HTMLImageElement>('img');
    if (!image?.complete || !image.naturalWidth) continue;
    if (names(text, kind, ref) || names(image.alt, kind, ref)) return image.currentSrc || image.src;
  }
  // A figure that is only an image with its caption in its alt text.
  for (const image of Array.from(document.querySelectorAll<HTMLImageElement>('.paper-body img'))) {
    if (image.complete && image.naturalWidth && names(image.alt, kind, ref)) return image.currentSrc || image.src;
  }
  return null;
}

/** A page of the PDF as the reader has drawn it, as a JPEG data URL — when that page is drawn. */
function pageOnScreen(ref: string): string | null {
  const canvas = document.querySelector<HTMLCanvasElement>(`.pdf-book-page[data-page="${Number(ref)}"]:not(.drawing) canvas`);
  if (!canvas?.width || !canvas.height) return null;
  try {
    const scale = Math.min(1, PAGE_PIXELS / Math.max(canvas.width, canvas.height));
    const copy = document.createElement('canvas');
    copy.width = Math.round(canvas.width * scale);
    copy.height = Math.round(canvas.height * scale);
    const context = copy.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, copy.width, copy.height);
    context.drawImage(canvas, 0, 0, copy.width, copy.height);
    return copy.toDataURL('image/jpeg', 0.85);
  } catch {
    return null;
  }
}

export interface SentPicture {
  label: string;
  data: string;
}

/** Among the pictures that went with the question, the one this names. */
function amongSent(sent: SentPicture[], kind: string, ref: string): string | null {
  const match = sent.find((picture) => (kind === 'page' ? new RegExp(`^Page ${Number(ref)} of the PDF\\b`).test(picture.label) : names(picture.label, kind, ref)));
  return match ? `data:image/jpeg;base64,${match.data}` : null;
}

const label = (kind: string, ref: string) => `${kind === 'page' ? 'Page' : kind === 'table' ? 'Table' : 'Figure'} ${ref}`;

/**
 * Draws every picture the answer names and has not been drawn yet: from the
 * page when it is there, else from what went with the question; one that is
 * in neither place says so in its stead.
 */
export function placeFigures(container: HTMLElement, sent: SentPicture[] = []) {
  for (const image of Array.from(container.querySelectorAll<HTMLImageElement>('img.chat-figure[data-figure]:not([data-placed])'))) {
    image.dataset.placed = '1';
    const at = (image.dataset.figure ?? '').indexOf(':');
    const kind = at > 0 ? image.dataset.figure!.slice(0, at) : 'figure';
    const ref = at > 0 ? image.dataset.figure!.slice(at + 1).trim() : '';
    const src = kind === 'page' ? pageOnScreen(ref) ?? amongSent(sent, kind, ref) : onPage(kind, ref) ?? amongSent(sent, kind, ref);
    if (src) {
      image.src = src;
      continue;
    }
    const note = document.createElement('span');
    note.className = 'chat-picture-missing';
    note.textContent = `${label(kind, ref)} is not on the page right now${kind === 'page' ? ' — turn to it and ask again' : ''}.`;
    image.replaceWith(note);
  }
}
