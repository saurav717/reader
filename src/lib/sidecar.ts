import type { Highlight, Paper } from '../types';

/**
 * The annotation format both mirrors write, kept in one place so that the copy
 * in Drive and the copy in a Git repository are the same document rather than
 * two things that drift apart.
 */

export function slug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim();
}

/** The folder at the top level of Drive that every paper folder sits in. */
export const ROOT_FOLDER = 'Papers_collection';

export function baseName(paper: Pick<Paper, 'id' | 'title' | 'arxivId'>): string {
  const stem = slug(paper.title) || paper.id.replace(/[^\w.-]/g, '-');
  return paper.arxivId ? `${stem} (arXiv ${paper.arxivId})` : stem;
}

/** The same stem, safe for a path in a Git repository. */
export function pathName(paper: Paper): string {
  const stem = (slug(paper.title) || paper.id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  const tail = paper.arxivId ? `-arxiv-${paper.arxivId.replace(/[^\w.]/g, '-')}` : '';
  return `${stem || 'paper'}${tail}`;
}

export interface Sidecar {
  '@context': string;
  generator: string;
  savedAt: string;
  paper: Record<string, unknown>;
  annotations: Record<string, unknown>[];
}

/**
 * The sidecar written next to the PDF. Shaped after the W3C Web Annotation
 * model so the export is the storage format rather than a lossy copy of it.
 */
export function sidecar(paper: Paper, highlights: Highlight[], collectionNames: string[]): Sidecar {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    generator: 'reader',
    savedAt: new Date().toISOString(),
    paper: {
      id: paper.id,
      title: paper.title,
      authors: paper.authors,
      abstract: paper.abstract,
      published: paper.published,
      categories: paper.categories,
      arxivId: paper.arxivId,
      doi: paper.doi,
      venue: paper.venue,
      landingUrl: paper.landingUrl,
      pdfUrl: paper.pdfUrl,
      addedAt: paper.addedAt,
      tags: paper.tags,
      collections: collectionNames,
    },
    annotations: highlights.map((highlight) => ({
      id: highlight.id,
      type: 'Annotation',
      created: highlight.createdAt,
      motivation: highlight.note ? 'commenting' : 'highlighting',
      bodyValue: highlight.note ?? undefined,
      tags: highlight.tags,
      colour: highlight.color,
      section: highlight.section,
      target: {
        source: paper.landingUrl || paper.id,
        selector: [
          {
            type: 'TextQuoteSelector',
            exact: highlight.exact,
            prefix: highlight.prefix,
            suffix: highlight.suffix,
          },
          { type: 'TextPositionSelector', start: highlight.hint },
        ],
      },
    })),
  };
}
