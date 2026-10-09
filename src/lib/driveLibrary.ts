/**
 * The library — papers, collections, highlights and what was removed — kept
 * as one file in the signed-in account's own Drive:
 * `Papers_collection/library.json`, beside the folder each paper already has
 * there. That file is the library. Whichever browser signs in with the
 * account reads it, and another account, which cannot see this app's files
 * in someone else's Drive, never does.
 *
 * The copy the browser keeps (db.ts, one database per account) is only so
 * that a reload opens at once and survives a moment offline; what Drive says
 * wins when the two disagree, unless the change here has not been written up
 * yet.
 */
import type { Collection, Highlight, HighlightColor, HighlightStyle, JunkEntry, Paper } from '../types';
import { COLLECTION_COLORS } from '../types';
import { downloadText, ensureDriveToken, ensureFolder, findFile, findFolder, queryFiles, uploadFile, type DriveFile } from './google';
import { driveFolderUrl, JUNK_FOLDER, ROOT_FOLDER } from './driveSync';
import type { Sidecar } from './sidecar';

export const LIBRARY_FILE = 'library.json';

export interface Library {
  papers: Paper[];
  collections: Collection[];
  highlights: Highlight[];
  junk: JunkEntry[];
}

export interface LibraryFile extends Library {
  generator: 'reader';
  version: 1;
  /** Whose library it is, as Google named them when it was written. */
  account?: string;
  updatedAt: string;
}

/** Where the file is in Drive and when Drive last saw it change. */
export interface RemoteMark {
  fileId: string;
  modifiedTime?: string;
}

export const emptyLibrary = (): Library => ({ papers: [], collections: [], highlights: [], junk: [] });

/** The library as it is written: the same object every time for the same library, so two can be compared as text. */
export function serialise(library: Library): string {
  const byId = <T extends { id: string }>(items: T[]) => items.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify({
    papers: byId(library.papers),
    collections: byId(library.collections),
    highlights: byId(library.highlights),
    junk: library.junk,
  });
}

/** A file read back from Drive, checked enough that a stray or older file cannot break the library. */
export function parseLibrary(text: string): Library | null {
  try {
    const parsed = JSON.parse(text) as Partial<LibraryFile>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.papers)) return null;
    const list = <T>(value: unknown, ok: (item: T) => boolean): T[] => (Array.isArray(value) ? (value as T[]).filter(ok) : []);
    return {
      papers: list<Paper>(parsed.papers, (paper) => typeof paper?.id === 'string' && typeof paper.title === 'string').map((paper) => ({
        ...paper,
        collectionIds: Array.isArray(paper.collectionIds) ? paper.collectionIds : [],
        tags: Array.isArray(paper.tags) ? paper.tags : [],
        authors: Array.isArray(paper.authors) ? paper.authors : [],
        categories: Array.isArray(paper.categories) ? paper.categories : [],
        progress: typeof paper.progress === 'number' ? paper.progress : 0,
      })),
      collections: list<Collection>(parsed.collections, (item) => typeof item?.id === 'string' && typeof item.name === 'string'),
      highlights: list<Highlight>(parsed.highlights, (item) => typeof item?.id === 'string' && typeof item.paperId === 'string'),
      junk: list<JunkEntry>(parsed.junk, (item) => typeof item?.paper?.id === 'string'),
    };
  } catch {
    return null;
  }
}

/**
 * Two libraries as one: everything in `base`, and whatever `extra` has that
 * `base` does not. Where both have the same paper, highlight or collection,
 * `base`'s is kept. A collection in `extra` with the name of one in `base` is
 * that one, and its papers are moved across to it.
 */
export function mergeLibraries(base: Library, extra: Library): Library {
  const collections = base.collections.slice();
  const rename = new Map<string, string>();
  for (const collection of extra.collections) {
    if (collections.some((item) => item.id === collection.id)) continue;
    const sameName = collections.find((item) => item.name.trim().toLowerCase() === collection.name.trim().toLowerCase());
    if (sameName) rename.set(collection.id, sameName.id);
    else collections.push(collection);
  }
  const known = new Set(base.papers.map((paper) => paper.id));
  const papers = [
    ...base.papers,
    ...extra.papers
      .filter((paper) => !known.has(paper.id))
      .map((paper) => ({ ...paper, collectionIds: Array.from(new Set(paper.collectionIds.map((id) => rename.get(id) ?? id))) })),
  ];
  const marks = new Set(base.highlights.map((highlight) => highlight.id));
  const highlights = [...base.highlights, ...extra.highlights.filter((highlight) => !marks.has(highlight.id))];
  const inLibrary = new Set(papers.map((paper) => paper.id));
  const junked = new Set(base.junk.map((entry) => entry.paper.id));
  const junk = [...base.junk, ...extra.junk.filter((entry) => !junked.has(entry.paper.id) && !inLibrary.has(entry.paper.id))];
  return { papers, collections, highlights, junk };
}

const COLOURS: HighlightColor[] = ['yellow', 'green', 'blue', 'pink'];

/**
 * A paper's sidecar read back into the library: the paper, its highlights,
 * and the names of the collections it was in. The sidecar keeps neither
 * reading progress nor collection colours, so those start afresh.
 */
export function fromSidecar(
  sidecar: Partial<Sidecar>,
  where: { folderId: string; metaFileId: string; folderName?: string },
): { paper: Paper; highlights: Highlight[]; collectionNames: string[] } | null {
  const said = (sidecar?.paper ?? {}) as Record<string, unknown>;
  const id = typeof said.id === 'string' ? said.id : '';
  const title = typeof said.title === 'string' ? said.title : '';
  if (!id || !title) return null;
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const paper: Paper = {
    id,
    source: (text(said.source) as Paper['source']) ?? (id.startsWith('arxiv:') ? 'arxiv' : 'openalex'),
    title,
    authors: strings(said.authors),
    abstract: text(said.abstract) ?? '',
    published: text(said.published) ?? '',
    categories: strings(said.categories),
    arxivId: text(said.arxivId),
    doi: text(said.doi),
    venue: text(said.venue),
    landingUrl: text(said.landingUrl),
    pdfUrl: text(said.pdfUrl),
    addedAt: text(said.addedAt) ?? new Date().toISOString(),
    collectionIds: [],
    tags: strings(said.tags),
    progress: 0,
    drive: {
      folderId: where.folderId,
      folderName: where.folderName,
      folderLink: driveFolderUrl(where.folderId),
      metaFileId: where.metaFileId,
    },
  };
  const highlights: Highlight[] = [];
  for (const raw of Array.isArray(sidecar.annotations) ? sidecar.annotations : []) {
    const note = raw as Record<string, unknown>;
    const target = (note.target ?? {}) as { selector?: Record<string, unknown>[] };
    const selectors = Array.isArray(target.selector) ? target.selector : [];
    const quote = selectors.find((item) => item?.type === 'TextQuoteSelector') ?? {};
    const position = selectors.find((item) => item?.type === 'TextPositionSelector') ?? {};
    const exact = text(quote.exact);
    if (!exact || typeof note.id !== 'string') continue;
    const colour = COLOURS.includes(note.colour as HighlightColor) ? (note.colour as HighlightColor) : 'yellow';
    highlights.push({
      id: note.id,
      paperId: id,
      color: colour,
      style: note.style === 'underline' ? 'underline' : ('highlight' as HighlightStyle),
      exact,
      prefix: text(quote.prefix) ?? '',
      suffix: text(quote.suffix) ?? '',
      hint: typeof position.start === 'number' ? position.start : 0,
      section: text(note.section),
      note: text(note.bodyValue),
      tags: strings(note.tags),
      createdAt: text(note.created) ?? paper.addedAt,
    });
  }
  return { paper, highlights, collectionNames: strings(said.collections) };
}

/** Sidecars read back as a library, collections made from the names they carry. */
export function libraryFromSidecars(
  read: { paper: Paper; highlights: Highlight[]; collectionNames: string[] }[],
  newId: () => string,
): Library {
  const collections: Collection[] = [];
  const idFor = (name: string) => {
    let found = collections.find((item) => item.name === name);
    if (!found) {
      found = { id: newId(), name, color: COLLECTION_COLORS[collections.length % COLLECTION_COLORS.length], createdAt: new Date().toISOString() };
      collections.push(found);
    }
    return found.id;
  };
  const papers = read.map(({ paper, collectionNames }) => ({ ...paper, collectionIds: collectionNames.map(idFor) }));
  return { papers, collections, highlights: read.flatMap((item) => item.highlights), junk: [] };
}

const rootName = (folderName: string | undefined) => folderName?.trim() || ROOT_FOLDER;

/** The library file in this account's Drive, or null when it has none yet. */
export async function readLibraryFromDrive(
  clientId: string,
  folderName: string | undefined,
): Promise<{ library: Library; mark: RemoteMark } | null> {
  const token = await ensureDriveToken(clientId);
  const rootId = await findFolder(token, rootName(folderName));
  if (!rootId) return null;
  const file = await findFile(token, LIBRARY_FILE, rootId);
  if (!file) return null;
  const library = parseLibrary(await downloadText(token, file.id));
  if (!library) throw new Error(`${rootName(folderName)}/${LIBRARY_FILE} in Drive could not be read.`);
  return { library, mark: { fileId: file.id, modifiedTime: file.modifiedTime } };
}

/** When Drive last saw the library file change, without reading it. */
export async function libraryMark(clientId: string, folderName: string | undefined): Promise<RemoteMark | null> {
  const token = await ensureDriveToken(clientId);
  const rootId = await findFolder(token, rootName(folderName));
  if (!rootId) return null;
  const file = await findFile(token, LIBRARY_FILE, rootId);
  return file ? { fileId: file.id, modifiedTime: file.modifiedTime } : null;
}

export async function writeLibraryToDrive(
  clientId: string,
  folderName: string | undefined,
  library: Library,
  options: { account?: string; fileId?: string },
): Promise<RemoteMark> {
  const token = await ensureDriveToken(clientId);
  const rootId = await ensureFolder(token, rootName(folderName));
  const body: LibraryFile = { generator: 'reader', version: 1, account: options.account, updatedAt: new Date().toISOString(), ...library };
  const write = (fileId?: string): Promise<DriveFile> =>
    uploadFile(token, { name: LIBRARY_FILE, mimeType: 'application/json', parentId: rootId, body: JSON.stringify(body), fileId });
  let file: DriveFile;
  try {
    file = await write(options.fileId ?? (await findFile(token, LIBRARY_FILE, rootId))?.id);
  } catch (error) {
    // Deleted in Drive by hand since: written afresh.
    if (!options.fileId || (error as { status?: number }).status !== 404) throw error;
    file = await write(undefined);
  }
  return { fileId: file.id, modifiedTime: file.modifiedTime };
}

/**
 * The library as the paper folders in this account's Drive describe it, for
 * an account that saved papers before the library had a file of its own. One
 * request finds every folder, one every sidecar, and then each sidecar is
 * read; what is in Junk is left there.
 */
export async function rebuildFromSidecars(clientId: string, folderName: string | undefined, newId: () => string): Promise<Library> {
  const token = await ensureDriveToken(clientId);
  const rootId = await findFolder(token, rootName(folderName));
  if (!rootId) return emptyLibrary();
  const folders = await queryFiles(token, `'${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder'`);
  const paperFolders = new Map(folders.filter((folder) => folder.name !== JUNK_FOLDER).map((folder) => [folder.id, folder.name]));
  if (!paperFolders.size) return emptyLibrary();
  const sidecars = (await queryFiles(token, "mimeType = 'application/json'")).filter(
    (file) => file.name !== LIBRARY_FILE && file.parents?.some((parent) => paperFolders.has(parent)),
  );
  const read: { paper: Paper; highlights: Highlight[]; collectionNames: string[] }[] = [];
  for (const file of sidecars) {
    const folderId = file.parents?.find((parent) => paperFolders.has(parent)) as string;
    try {
      const parsed = fromSidecar(JSON.parse(await downloadText(token, file.id)) as Partial<Sidecar>, {
        folderId,
        metaFileId: file.id,
        folderName: paperFolders.get(folderId),
      });
      if (parsed && !read.some((item) => item.paper.id === parsed.paper.id)) read.push(parsed);
    } catch {
      // A sidecar that will not parse is somebody's hand edit; the rest still come back.
    }
  }
  return libraryFromSidecars(read, newId);
}

/**
 * Which of `ids` — Drive file or folder ids the browser remembers — this
 * account's Drive can open. With `drive.file` an app sees only the files it
 * made with the account's own grant, so a folder another account saved is a
 * 404 here: that is what proves a paper left in this browser is this
 * account's to take.
 */
export async function visibleInDrive(clientId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const token = await ensureDriveToken(clientId);
  const seen = new Set<string>();
  for (const id of ids) {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,trashed`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (response?.ok) seen.add(id);
  }
  return seen;
}
