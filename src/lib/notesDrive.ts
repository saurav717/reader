// ===========================================================================
//  Notes in Drive.
//
//  A paper's notes — what you wrote about it and what you kept from it — are
//  kept in this browser (IndexedDB), and, when Drive is connected, as a JSON
//  file in the paper's own folder, beside its PDF, its sidecar and its
//  explanation:
//
//    Papers_collection/<paper>/<paper> — notes.json
//
//  so another browser, or this one after its storage is cleared, reads them
//  back instead of losing them. JSON, not Markdown, because a kept piece is a
//  copy of the page as it was drawn — its maths typeset, a figure's picture
//  held in it — and only the record keeps all of that; the Markdown export in
//  the notes board is the one to read in Drive. A few fields at the top say
//  which paper and when, then the pieces exactly as they are here.
// ===========================================================================

import type { Paper, Settings } from '../types';
import type { DriveMark } from './explain';
import type { Kept, NoteBlock, NotesDriveAdapter } from './notes';
import { DriveRequestError, downloadText, ensureDriveToken, ensureFolder, findFile, findFolder, uploadFile } from './google';
import { baseName, ROOT_FOLDER } from './sidecar';

export const notesFileName = (paper: Pick<Paper, 'id' | 'title' | 'arxivId'>) => `${baseName(paper)} — notes.json`;

const MIME = 'application/json';

/** The file as written to Drive. */
export function toNotesFile(paper: Pick<Paper, 'id' | 'title'>, kept: Kept): string {
  const { drive: _drive, ...rest } = kept;
  return `${JSON.stringify({ generator: 'reader', kind: 'notes', paperId: paper.id, title: paper.title, updated: rest.updated ?? new Date().toISOString(), blocks: rest.blocks }, null, 2)}\n`;
}

const isBlock = (block: unknown): block is NoteBlock =>
  typeof block === 'object' &&
  block !== null &&
  typeof (block as { id?: unknown }).id === 'string' &&
  ((block as { kind?: unknown }).kind === 'text' ? typeof (block as { md?: unknown }).md === 'string' : (block as { kind?: unknown }).kind === 'clip' && typeof (block as { html?: unknown }).html === 'string');

/**
 * A file read back from Drive: null when it is not a notes file, or names
 * another paper. One with no pieces is still read — the notes were emptied
 * elsewhere, and that is news too.
 */
export function fromNotesFile(text: string, paperId: string): Kept | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as { paperId?: unknown; updated?: unknown; blocks?: unknown };
  if (typeof record.paperId === 'string' && record.paperId !== paperId) return null;
  if (!Array.isArray(record.blocks)) return null;
  const updated = typeof record.updated === 'string' && Number.isFinite(Date.parse(record.updated)) ? record.updated : undefined;
  return { blocks: record.blocks.filter(isBlock), updated };
}

/**
 * The adapter notes.ts calls. Like Explain's, it only ever uses a token Drive
 * has already granted (the store's `driveConnected`), so a check made when a
 * paper's notes are first read never pops a Google window up outside a click.
 */
export function notesDrive(paperFor: (paperId: string) => Paper | undefined, settings: Settings): NotesDriveAdapter {
  const token = () => ensureDriveToken(settings.googleClientId);
  const rootName = settings.driveFolderName || ROOT_FOLDER;

  /** The paper's folder: the one it was saved to, or found by name; made only when writing. */
  async function folder(accessToken: string, paper: Paper, create: boolean): Promise<string | null> {
    if (paper.drive?.folderId) return paper.drive.folderId;
    const root = create ? await ensureFolder(accessToken, rootName) : await findFolder(accessToken, rootName);
    if (!root) return null;
    return create ? ensureFolder(accessToken, baseName(paper), root) : findFolder(accessToken, baseName(paper), root);
  }

  const mark = (file: { id: string; webViewLink?: string; modifiedTime?: string }): DriveMark => ({
    fileId: file.id,
    link: file.webViewLink,
    modifiedTime: file.modifiedTime,
  });

  return {
    async load(paperId, known) {
      const paper = paperFor(paperId);
      if (!paper) return null;
      const accessToken = await token();
      const parent = await folder(accessToken, paper, false);
      if (!parent) return null;
      const file = await findFile(accessToken, notesFileName(paper), parent);
      if (!file) return null;
      // Unchanged since this browser last wrote or read it: nothing to download.
      if (known?.fileId === file.id && known.modifiedTime && known.modifiedTime === file.modifiedTime) return { file: mark(file) };
      const kept = fromNotesFile(await downloadText(accessToken, file.id), paperId);
      return { file: mark(file), kept: kept ?? undefined };
    },

    async save(paperId, kept, known) {
      const paper = paperFor(paperId);
      if (!paper) throw new Error('The paper is no longer in the library.');
      const accessToken = await token();
      const parent = await folder(accessToken, paper, true);
      if (!parent) throw new Error('Could not find or make the paper’s folder in Drive.');
      const file = { name: notesFileName(paper), mimeType: MIME, parentId: parent, body: toNotesFile(paper, kept) };
      let fileId = known?.fileId ?? (await findFile(accessToken, file.name, parent))?.id;
      // Written over in place, keeping its link; put back fresh if it was deleted by hand.
      const saved = fileId
        ? await uploadFile(accessToken, { ...file, fileId }).catch((error: unknown) => {
            if (error instanceof DriveRequestError && error.status === 404) {
              fileId = undefined;
              return null;
            }
            throw error;
          })
        : null;
      return mark(saved ?? (await uploadFile(accessToken, file)));
    },
  };
}
