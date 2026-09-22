import type { Collection, Highlight, Paper, Settings } from '../types';
import { ensureDriveToken, ensureFolder, findFile, uploadFile } from './google';

export const UNSORTED_FOLDER = 'Unsorted';

function slug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim();
}

function baseName(paper: Paper): string {
  const stem = slug(paper.title) || paper.id.replace(/[^\w.-]/g, '-');
  return paper.arxivId ? `${stem} (arXiv ${paper.arxivId})` : stem;
}

/**
 * The sidecar written next to the PDF. Shaped after the W3C Web Annotation
 * model so the export is the storage format rather than a lossy copy of it.
 */
function sidecar(paper: Paper, highlights: Highlight[], collectionNames: string[]) {
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

export interface SyncResult {
  folderId: string;
  pdfFileId?: string;
  metaFileId: string;
  syncedAt: string;
  notice?: string;
}

export async function syncPaperToDrive(
  paper: Paper,
  context: { collections: Collection[]; highlights: Highlight[]; settings: Settings },
): Promise<SyncResult> {
  const { settings } = context;
  if (!settings.googleClientId) throw new Error('No Google client ID is configured');

  const accessToken = await ensureDriveToken(settings.googleClientId);
  const rootId = await ensureFolder(accessToken, settings.driveFolderName || 'Paper Reader');

  const collectionNames = paper.collectionIds
    .map((id) => context.collections.find((collection) => collection.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  const folderName = collectionNames[0] || UNSORTED_FOLDER;
  const folderId = await ensureFolder(accessToken, folderName, rootId);

  const stem = baseName(paper);
  const highlights = context.highlights.filter((highlight) => highlight.paperId === paper.id);

  let notice: string | undefined;
  let pdfFileId = paper.drive?.pdfFileId;

  if (settings.savePdf) {
    if (paper.arxivId) {
      if (!pdfFileId) {
        const existing = await findFile(accessToken, `${stem}.pdf`, folderId);
        pdfFileId = existing?.id;
      }
      if (!pdfFileId) {
        const response = await fetch(`/api/arxiv/pdf?id=${encodeURIComponent(paper.arxivId)}`);
        if (response.ok) {
          const uploaded = await uploadFile(accessToken, {
            name: `${stem}.pdf`,
            mimeType: 'application/pdf',
            parentId: folderId,
            body: await response.blob(),
          });
          pdfFileId = uploaded.id;
        } else {
          notice = 'The PDF could not be downloaded; saved the metadata only.';
        }
      }
    } else {
      notice = 'Only arXiv PDFs can be fetched from the browser; saved the metadata only.';
    }
  }

  const metaName = `${stem}.json`;
  let metaFileId = paper.drive?.metaFileId;
  if (!metaFileId) metaFileId = (await findFile(accessToken, metaName, folderId))?.id;
  const meta = await uploadFile(accessToken, {
    name: metaName,
    mimeType: 'application/json',
    parentId: folderId,
    body: JSON.stringify(sidecar(paper, highlights, collectionNames), null, 2),
    fileId: metaFileId,
  });

  return { folderId, pdfFileId, metaFileId: meta.id, syncedAt: new Date().toISOString(), notice };
}
