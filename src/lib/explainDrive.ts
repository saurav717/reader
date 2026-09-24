// ===========================================================================
//  Explanations in Drive.
//
//  An explanation is paid for once. It is kept in this browser (IndexedDB),
//  and — when Drive is connected — as a Markdown file in the paper's own
//  folder, beside its PDF and sidecar:
//
//    Papers_collection/<paper>/<paper> — explained by Claude.md
//
//  so another browser, or this one after its storage is cleared, fetches it
//  instead of asking Claude to write it again. Markdown because it is also a
//  document you can open in Drive and read: a few lines of front matter say
//  which paper, which model, when, and what was asked of it since, then the
//  page exactly as Claude wrote it.
// ===========================================================================

import type { Paper, Settings } from '../types';
import type { DriveMark, Explanation, ExplainDriveAdapter } from './explain';
import { DriveRequestError, downloadText, ensureDriveToken, ensureFolder, findFile, findFolder, uploadFile } from './google';
import { baseName, ROOT_FOLDER } from './sidecar';

export const explanationFileName = (paper: Pick<Paper, 'id' | 'title' | 'arxivId'>) => `${baseName(paper)} — explained by Claude.md`;

const MIME = 'text/markdown';

/** The file as written to Drive: front matter, then the page. */
export function toMarkdownFile(paper: Pick<Paper, 'id' | 'title'>, explanation: Explanation): string {
  const line = (key: string, value: unknown) => `${key}: ${JSON.stringify(value)}`;
  const requests = explanation.requests ?? [];
  const head = [
    '---',
    line('generator', 'reader'),
    line('title', paper.title),
    line('paperId', paper.id),
    line('model', explanation.model),
    line('written', new Date(explanation.created).toISOString()),
    line('updated', new Date(explanation.updated ?? explanation.created).toISOString()),
    ...(requests.length ? ['requests:', ...requests.map((request) => `  - ${JSON.stringify(request)}`)] : []),
    '---',
  ];
  return `${head.join('\n')}\n\n${explanation.content.trim()}\n`;
}

/** A file read back from Drive; tolerant of one edited by hand, front matter or not. */
export function fromMarkdownFile(text: string, paperId: string): Explanation | null {
  const source = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  const fields: Record<string, unknown> = {};
  let content = source;
  const head = /^---\n([\s\S]*?)\n---\n?/.exec(source);
  if (head) {
    content = source.slice(head[0].length);
    let list: string | null = null;
    for (const raw of head[1].split('\n')) {
      const item = /^\s+-\s+(.*)$/.exec(raw);
      if (item && list) {
        (fields[list] as unknown[]).push(value(item[1]));
        continue;
      }
      const pair = /^(\w+):\s*(.*)$/.exec(raw);
      if (!pair) continue;
      if (pair[2] === '') {
        list = pair[1];
        fields[list] = [];
      } else {
        list = null;
        fields[pair[1]] = value(pair[2]);
      }
    }
  }
  content = content.trim();
  if (!content) return null;
  const time = (key: string) => {
    const parsed = Date.parse(String(fields[key] ?? ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const created = time('written') ?? Date.now();
  return {
    paperId,
    content,
    model: typeof fields.model === 'string' ? fields.model : 'unknown',
    created,
    updated: time('updated') ?? created,
    requests: Array.isArray(fields.requests) ? fields.requests.map(String) : [],
  };
}

function value(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw.trim();
  }
}

/**
 * The adapter explain.ts calls. It only ever uses a token Drive has already
 * granted (the store's `driveConnected`), so a check made when Explain opens
 * never pops a Google window up outside a click.
 */
export function explainDrive(paperFor: (paperId: string) => Paper | undefined, settings: Settings): ExplainDriveAdapter {
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
      const file = await findFile(accessToken, explanationFileName(paper), parent);
      if (!file) return null;
      // Unchanged since this browser last wrote or read it: nothing to download.
      if (known?.fileId === file.id && known.modifiedTime && known.modifiedTime === file.modifiedTime) return { file: mark(file) };
      const explanation = fromMarkdownFile(await downloadText(accessToken, file.id), paperId);
      return { file: mark(file), explanation: explanation ?? undefined };
    },

    async save(explanation) {
      const paper = paperFor(explanation.paperId);
      if (!paper) throw new Error('The paper is no longer in the library.');
      const accessToken = await token();
      const parent = await folder(accessToken, paper, true);
      if (!parent) throw new Error('Could not find or make the paper’s folder in Drive.');
      const file = { name: explanationFileName(paper), mimeType: MIME, parentId: parent, body: toMarkdownFile(paper, explanation) };
      let fileId = explanation.drive?.fileId ?? (await findFile(accessToken, file.name, parent))?.id;
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
