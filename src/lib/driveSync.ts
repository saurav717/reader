import type { Collection, Highlight, Paper, Settings } from '../types';
import { hasProxy } from './api';
import { fetchPdf, resolvePdfUrl } from './pdf';
import { ensureDriveToken, ensureFolder, findFile, uploadFile } from './google';
import { baseName, sidecar } from './sidecar';

export const UNSORTED_FOLDER = 'Unsorted';

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
    if (!pdfFileId) {
      const existing = await findFile(accessToken, `${stem}.pdf`, folderId);
      pdfFileId = existing?.id;
    }
    if (!pdfFileId && !hasProxy) {
      // Every PDF has to be fetched cross-origin, which the browser blocks.
      // Without a server of our own there is nothing to do but say so.
      notice = 'This deployment has no server to fetch PDFs through; saved the metadata only.';
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
        } catch (error) {
          notice = `${error instanceof Error ? error.message : String(error)} Saved the metadata only.`;
        }
      }
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
