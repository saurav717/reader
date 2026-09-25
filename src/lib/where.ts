// Where the reader is in the paper right now — the page of the PDF in view,
// and the section heading last scrolled past — read off the page itself, for
// a note written now to remember where it was written.

export interface Whereabouts {
  page?: number;
  section?: string;
}

const HEADINGS = '.paper-body h1, .paper-body h2, .paper-body h3, .paper-body h4';

export function whereNow(): Whereabouts {
  const where: Whereabouts = {};
  // The PDF as a book: the first page of the spread in view.
  const page = document.querySelector<HTMLElement>('.main .pdf-book-page[data-page]');
  if (page) where.page = Number(page.dataset.page) || undefined;
  // The reflowed paper: the last heading above a third of the way down the screen.
  const line = window.innerHeight / 3;
  let section: string | undefined;
  for (const heading of Array.from(document.querySelectorAll<HTMLElement>(HEADINGS))) {
    const rect = heading.getBoundingClientRect();
    if (!rect.height) continue;
    if (rect.top > line) break;
    section = heading.textContent?.replace(/\s+/g, ' ').trim() || section;
  }
  // Nothing scrolled past yet: the first heading on the screen.
  if (!section) {
    const first = Array.from(document.querySelectorAll<HTMLElement>(HEADINGS)).find((heading) => {
      const rect = heading.getBoundingClientRect();
      return rect.height && rect.top >= 0 && rect.top < window.innerHeight;
    });
    section = first?.textContent?.replace(/\s+/g, ' ').trim();
  }
  if (section) where.section = section.slice(0, 80);
  return where;
}
