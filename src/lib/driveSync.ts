import type { Collection, Highlight, Paper, Settings } from '../types';
import { hasProxy } from './api';
import { fetchPdf, resolvePdfUrl } from './pdf';
import { ensureDriveToken, ensureFolder, findFile, moveFile, uploadFile } from './google';
import { baseName, sidecar } from './sidecar';

/** The folder at the top level of Drive that every paper folder sits in. */
export const ROOT_FOLDER = 'Papers_collection';

/**
 * Drive's own URL for a folder. It is derivable from the id, so knowing where
 * a paper lives costs no extra request — the link is there as soon as the
 * folder is.
 */
export function driveFolderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`;
}

export interface SyncResult {
  folderId: string;
  /** What the paper's folder is called in Drive. */
  folderName: string;
  /** Where that folder opens. */
  folderLink: string;
  pdfFileId?: string;
  pdfLink?: string;
  metaFileId: string;
  syncedAt: string;
  notice?: string;
}

/**
 * `pdf` is a copy of the file the reader has already fetched. Handing it over
 * is what makes opening a paper and saving it one download rather than two:
 * the viewer pulls the PDF through the proxy, and the same bytes go to Drive.
 */
export async function syncPaperToDrive(
  paper: Paper,
  context: { collections: Collection[]; highlights: Highlight[]; settings: Settings; pdf?: Blob },
): Promise<SyncResult> {
  const { settings } = context;
  if (!settings.googleClientId) throw new Error('No Google client ID is configured');

  const accessToken = await ensureDriveToken(settings.googleClientId);
  const rootId = await ensureFolder(accessToken, settings.driveFolderName || ROOT_FOLDER);

  // Papers_collection/<paper>/ — a folder of its own for every paper, holding
  // the PDF and the sidecar. Which collections a paper belongs to is recorded
  // in the sidecar rather than in the path, because a paper can be in several
  // at once and the path can only say one thing.
  const stem = baseName(paper);
  const folderId = await ensureFolder(accessToken, stem, rootId);
  const folderLink = driveFolderUrl(folderId);

  const collectionNames = paper.collectionIds
    .map((id) => context.collections.find((collection) => collection.id === id)?.name)
    .filter((name): name is string => Boolean(name));

  const highlights = context.highlights.filter((highlight) => highlight.paperId === paper.id);

  let notice: string | undefined;
  let pdfFileId = paper.drive?.pdfFileId;
  let pdfLink = paper.drive?.pdfLink;
  let metaFileId = paper.drive?.metaFileId;

  // A library synced before papers had folders of their own has its files in a
  // folder named after a collection. Move them across rather than uploading a
  // second copy; a file that has since been deleted by hand simply fails, and
  // the code below puts a fresh one in the right place.
  if (paper.drive?.folderId && paper.drive.folderId !== folderId) {
    if (pdfFileId) {
      const moved = await moveFile(accessToken, pdfFileId, folderId).catch(() => null);
      pdfFileId = moved?.id;
      pdfLink = moved ? (moved.webViewLink ?? pdfLink) : undefined;
    }
    if (metaFileId) {
      metaFileId = (await moveFile(accessToken, metaFileId, folderId).catch(() => null))?.id;
    }
  }

  if (settings.savePdf) {
    if (!pdfFileId) {
      const existing = await findFile(accessToken, `${stem}.pdf`, folderId);
      pdfFileId = existing?.id;
      pdfLink = existing?.webViewLink ?? pdfLink;
    }
    if (!pdfFileId && context.pdf) {
      // The reader already has the file open. Upload that, rather than asking
      // the publisher for the same bytes a second time.
      try {
        const uploaded = await uploadFile(accessToken, {
          name: `${stem}.pdf`,
          mimeType: 'application/pdf',
          parentId: folderId,
          body: context.pdf,
        });
        pdfFileId = uploaded.id;
        pdfLink = uploaded.webViewLink;
      } catch (error) {
        notice = `${error instanceof Error ? error.message : String(error)} Saved the metadata only.`;
      }
    } else if (!pdfFileId && !hasProxy()) {
      // Every PDF has to be fetched cross-origin, which the browser blocks.
      // Without a server of our own there is nothing to do but say so.
      notice =
        'There is no proxy configured, so the PDF could not be fetched; saved the metadata only. ' +
        'Settings → Paper proxy.';
    } else if (!pdfFileId) {
      // arXiv, or whichever repository OpenAlex and Semantic Scholar know of.
      const source = await resolvePdfUrl(paper).catch(() => undefined);
      if (!source) {
        notice = 'No open-access PDF could be found for this paper; saved the metadata only.';
      } else {
        try {
          const uploaded = await uploadFile(accessToken, {
            name: `${stem}.pdf`,
            mimeType: 'application/pdf',
            parentId: folderId,
            body: await fetchPdf({ ...paper, pdfUrl: source }),
          });
          pdfFileId = uploaded.id;
          pdfLink = uploaded.webViewLink;
        } catch (error) {
          notice = `${error instanceof Error ? error.message : String(error)} Saved the metadata only.`;
        }
      }
    }
  }

  const metaName = `${stem}.json`;
  if (!metaFileId) metaFileId = (await findFile(accessToken, metaName, folderId))?.id;
  const meta = await uploadFile(accessToken, {
    name: metaName,
    mimeType: 'application/json',
    parentId: folderId,
    body: JSON.stringify(sidecar(paper, highlights, collectionNames), null, 2),
    fileId: metaFileId,
  });

  return {
    folderId,
    folderName: stem,
    folderLink,
    pdfFileId,
    pdfLink,
    metaFileId: meta.id,
    syncedAt: new Date().toISOString(),
    notice,
  };
}
