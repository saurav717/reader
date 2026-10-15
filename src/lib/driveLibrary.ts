/**
 * The library — papers, collections, highlights and what was removed — kept
 * as one file in the signed-in account's own Drive:
 * `Papers_collection/library.json`, beside the folder each paper already has
 * there. That file is the library. Whichever browser signs in with the
 * account reads it, and another account, which cannot see this app's files
 * in someone else's Drive, never does.
 *
 * Deleting that file by hand does not lose the library. Every write also
 * goes to a second copy in the app's hidden folder in the same Drive
 * (`appDataFolder`, which no folder-tidying in My Drive can reach); a file
 * in Drive's trash is taken back out of it; and a library with neither is
 * rebuilt from the sidecar in each paper's folder, which carries enough —
 * progress, tags, collection colours — to lose little.
 *
 * The copy the browser keeps (db.ts, one database per account) is only so
 * that a reload opens at once and survives a moment offline; what Drive says
 * wins when the two disagree, unless the change here has not been written up
 * yet.
 */
import type { Collection, Highlight, HighlightColor, HighlightStyle, JunkEntry, Paper } from '../types';
import { COLLECTION_COLORS } from '../types';
import {
  downloadText,
  driveFetch,
  DriveRequestError,
  ensureDriveToken,
  ensureFolder,
  findAppDataFile,
  findFile,
  findFolder,
  findTrashed,
  hasAppDataAccess,
  queryFiles,
  untrash,
  uploadFile,
  type DriveFile,
} from './google';
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

/**
 * A file read back from Drive, checked enough that a stray or older file
 * cannot break the library — with whose it says it is, where it says: the
 * page compares that with the account it is showing before it takes the
 * library in or writes over it.
 */
export function parseLibraryFile(text: string): { library: Library; account?: string } | null {
  try {
    const parsed = JSON.parse(text) as Partial<LibraryFile>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.papers)) return null;
    const list = <T>(value: unknown, ok: (item: T) => boolean): T[] => (Array.isArray(value) ? (value as T[]).filter(ok) : []);
    const library: Library = {
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
    const account = typeof parsed.account === 'string' && parsed.account.trim() ? parsed.account.trim() : undefined;
    return account ? { library, account } : { library };
  } catch {
    return null;
  }
}

/** The library in a file read back from Drive, or null when the text is not one. */
export const parseLibrary = (text: string): Library | null => parseLibraryFile(text)?.library ?? null;

/**
 * A project as `base` has it, with where its paper is from `extra` too: the
 * paper's Drive folder, and each computer's folder for it. Kept whichever
 * side has them, so a copy of the project that is older on one device never
 * takes from every device where its paper is.
 */
function withLinks(base: Collection, extra: Collection): Collection {
  const mine = base.project?.overleaf;
  const theirs = extra.project?.overleaf;
  if (!base.project || !theirs || (!theirs.drive && !theirs.folders && !theirs.keep)) return base;
  const folders = { ...(theirs.folders ?? {}), ...(mine?.folders ?? {}) };
  const drive = mine?.drive ?? theirs.drive;
  // Where it is kept: the choice made last, on whichever device.
  const keep = (theirs.keep?.at ?? '') > (mine?.keep?.at ?? '') ? theirs.keep : (mine?.keep ?? theirs.keep);
  const overleaf = { ...(mine ?? theirs), ...(Object.keys(folders).length ? { folders } : {}), ...(drive ? { drive } : {}), ...(keep ? { keep } : {}) };
  return { ...base, project: { ...base.project, overleaf } };
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
    const same = collections.findIndex((item) => item.id === collection.id);
    if (same >= 0) {
      collections[same] = withLinks(collections[same], collection);
      continue;
    }
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
): { paper: Paper; highlights: Highlight[]; collectionNames: string[]; colours: Record<string, string> } | null {
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
    progress: typeof said.progress === 'number' && said.progress >= 0 && said.progress <= 1 ? said.progress : 0,
    lastOpenedAt: text(said.lastOpenedAt),
    pdfChoice: text(said.pdfChoice),
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
  const colours: Record<string, string> = {};
  const saidColours = said.collectionColours;
  if (saidColours && typeof saidColours === 'object') {
    for (const [name, colour] of Object.entries(saidColours as Record<string, unknown>)) {
      if (typeof colour === 'string' && /^#[0-9a-f]{3,8}$/i.test(colour)) colours[name] = colour;
    }
  }
  return { paper, highlights, collectionNames: strings(said.collections), colours };
}

/** Sidecars read back as a library, collections made from the names they carry. */
export function libraryFromSidecars(
  read: { paper: Paper; highlights: Highlight[]; collectionNames: string[]; colours?: Record<string, string> }[],
  newId: () => string,
): Library {
  const collections: Collection[] = [];
  const colours = Object.assign({}, ...read.map((item) => item.colours ?? {})) as Record<string, string>;
  const idFor = (name: string) => {
    let found = collections.find((item) => item.name === name);
    if (!found) {
      const color = colours[name] ?? COLLECTION_COLORS[collections.length % COLLECTION_COLORS.length];
      found = { id: newId(), name, color, createdAt: new Date().toISOString() };
      collections.push(found);
    }
    return found.id;
  };
  const papers = read.map(({ paper, collectionNames }) => ({ ...paper, collectionIds: collectionNames.map(idFor) }));
  return { papers, collections, highlights: read.flatMap((item) => item.highlights), junk: [] };
}

const rootName = (folderName: string | undefined) => folderName?.trim() || ROOT_FOLDER;

/**
 * Where a library read from Drive came from: its file; its file, brought back
 * out of Drive's trash; or the spare copy in the app's hidden folder, the
 * file itself being gone — in which case it has no mark, and is written
 * again in its place.
 */
export type LibrarySource = 'file' | 'trash' | 'backup' | 'copy';

/** One library.json the app can see, with where it is and when Drive last saw it change. */
export interface LibraryCopy {
  library: Library;
  /** Whose the file says it is, when it says. */
  account?: string;
  modifiedTime?: string;
  /** The folder it is in, by name, for the notice. */
  where: string;
}

/**
 * Several copies of the file as one library. There should only ever be one,
 * but Drive can hold two: a second `Papers_collection` made at the top level
 * (a first write from two places at once — `findFolder` reads back only one
 * of them, and which is Drive's to pick), or the folder named in Settings
 * changed on one device, so that device writes somewhere else from then on.
 * Each device then opens whichever copy it finds, and the two drift apart.
 *
 * So the copies are put together: the newest is the base, every older one
 * adds what the base lacks (`mergeLibraries`), and the caller writes the
 * result back where this device reads. A copy stamped as another account's
 * (the mix-up an earlier version could cause) is not taken in. `notice`
 * says what was done, when the result is more than `main` alone was.
 */
export function combineCopies(main: Omit<LibraryCopy, 'where'>, others: LibraryCopy[], owner?: string): { library: Library; notice?: string } {
  const taken = others.filter((copy) => !owner || !copy.account || copy.account.trim().toLowerCase() === owner.trim().toLowerCase());
  if (!taken.length) return { library: main.library };
  const all: (Omit<LibraryCopy, 'where'> & { where?: string })[] = [main, ...taken];
  all.sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''));
  const [base, ...rest] = all;
  const library = rest.reduce((sum, copy) => mergeLibraries(sum, copy.library), base.library);
  if (serialise(library) === serialise(main.library)) return { library };
  const places = Array.from(new Set(taken.map((copy) => copy.where)));
  const list = places.map((place) => `"${place}"`).join(', ');
  return {
    library,
    notice: `${taken.length === 1 ? 'A second copy' : `${taken.length} more copies`} of ${LIBRARY_FILE} ${taken.length === 1 ? 'was' : 'were'} found in Drive (in ${list}) and ${taken.length === 1 ? 'has' : 'have'} been put together with this one.`,
  };
}

/** The name of a folder in Drive, or a stand-in when it cannot be read. */
async function folderNameOf(token: string, id: string): Promise<string> {
  try {
    const body = (await (await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=name`)).json()) as { name?: string };
    return body.name || 'another folder';
  } catch {
    return 'another folder';
  }
}

/**
 * Every other library.json the app can see in Drive — in any folder, since
 * `drive.file` shows it only its own files — read and parsed, with the name
 * of the folder each is in. One that will not parse is left out.
 */
async function otherCopies(token: string, except: string | null): Promise<LibraryCopy[]> {
  const files = (await queryFiles(token, `name = '${LIBRARY_FILE}'`).catch(() => [])).filter((file) => file.id !== except);
  const copies: LibraryCopy[] = [];
  const names = new Map<string, Promise<string>>();
  for (const file of files) {
    const read = parseLibraryFile(await downloadText(token, file.id).catch(() => ''));
    if (!read) continue;
    const parent = file.parents?.[0];
    if (parent && !names.has(parent)) names.set(parent, folderNameOf(token, parent));
    copies.push({ ...read, modifiedTime: file.modifiedTime, where: parent ? await names.get(parent)! : 'the top level of Drive' });
  }
  return copies;
}

/** The spare copy in the app's hidden folder, or null when there is none or it cannot be reached. */
async function readBackup(token: string): Promise<{ library: Library; account?: string } | null> {
  if (!hasAppDataAccess()) return null;
  const file = await findAppDataFile(token, LIBRARY_FILE).catch(() => null);
  if (!file) return null;
  return parseLibraryFile(await downloadText(token, file.id).catch(() => ''));
}

/** The root folder, taken back out of the trash if that is where it went. */
async function findRoot(token: string, name: string): Promise<string | null> {
  const found = await findFolder(token, name);
  if (found) return found;
  const trashed = await findTrashed(token, name);
  return trashed ? (await untrash(token, trashed.id)).id : null;
}

/**
 * The library in this account's Drive, or null when it has none at all. The
 * file in the root folder first — out of the trash, folder and all, if it
 * was put there — and the spare copy when the file is gone. `account` is
 * whose the file says it is, when it says.
 *
 * Any other copy of the file the app can see (`combineCopies`) is put
 * together with it, and `notice` says so: the caller writes the result back
 * here, so this is the one copy from then on. With no file here at all, the
 * other copies are the library — the folder was renamed in Settings, say —
 * rather than a library rebuilt from the sidecars with no projects in it.
 * `owner` is who is signed in: a copy stamped as someone else's is left out.
 */
export async function readLibraryFromDrive(
  clientId: string,
  folderName: string | undefined,
  owner?: string,
): Promise<{ library: Library; mark: RemoteMark | null; source: LibrarySource; account?: string; notice?: string } | null> {
  const token = await ensureDriveToken(clientId);
  const rootId = await findRoot(token, rootName(folderName));
  let file = rootId ? await findFile(token, LIBRARY_FILE, rootId) : null;
  let source: LibrarySource = 'file';
  if (!file && rootId) {
    const trashed = await findTrashed(token, LIBRARY_FILE, rootId);
    if (trashed) {
      file = await untrash(token, trashed.id);
      source = 'trash';
    }
  }
  if (file) {
    const read = parseLibraryFile(await downloadText(token, file.id));
    if (read) {
      const combined = combineCopies({ ...read, modifiedTime: file.modifiedTime }, await otherCopies(token, file.id), owner);
      return { ...read, ...combined, mark: { fileId: file.id, modifiedTime: file.modifiedTime }, source };
    }
    // A file that will not parse — edited by hand — is not trusted over the spare copy.
    const backup = await readBackup(token);
    if (backup) return { ...backup, mark: null, source: 'backup' };
    throw new Error(`${rootName(folderName)}/${LIBRARY_FILE} in Drive could not be read.`);
  }
  const copies = await otherCopies(token, null);
  const backup = await readBackup(token);
  if (copies.length) {
    // Newest first: the base is the one written last, the rest add to it.
    copies.sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''));
    const [first, ...rest] = copies;
    const combined = combineCopies(first, [...rest, ...(backup ? [{ ...backup, where: 'the hidden app folder' }] : [])], owner);
    const places = Array.from(new Set(copies.map((copy) => copy.where))).map((place) => `"${place}"`).join(', ');
    return {
      library: combined.library,
      account: first.account,
      mark: null,
      source: 'copy',
      notice: `${rootName(folderName)}/${LIBRARY_FILE} was not in Drive; the library has been taken from the copy in ${places} and written here.`,
    };
  }
  return backup ? { ...backup, mark: null, source: 'backup' } : null;
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
  await writeBackup(token, JSON.stringify(body)).catch(() => undefined);
  return { fileId: file.id, modifiedTime: file.modifiedTime };
}

let backupId: string | null = null;

/**
 * The same library, to the spare copy in the app's hidden folder. A failure
 * here is not the write failing — the file in the root folder is the record —
 * so it is left to the next write to try again.
 */
async function writeBackup(token: string, body: string): Promise<void> {
  if (!hasAppDataAccess()) return;
  const file = { name: LIBRARY_FILE, mimeType: 'application/json', parentId: 'appDataFolder', body };
  backupId ??= (await findAppDataFile(token, LIBRARY_FILE))?.id ?? null;
  try {
    backupId = (await uploadFile(token, { ...file, fileId: backupId ?? undefined })).id;
  } catch (error) {
    if (!backupId || (error as { status?: number }).status !== 404) throw error;
    backupId = (await uploadFile(token, file)).id;
  }
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
  const read: NonNullable<ReturnType<typeof fromSidecar>>[] = [];
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
 * Which of `papers` this account's Drive provably does not hold: every Drive
 * id the paper records (its folder, its sidecar, its PDF) answers 404 here.
 * With `drive.file` that is what another account's files look like — they
 * are there, in that account's Drive, and invisible to this one. A paper with
 * no Drive record at all cannot be told either way, and is not named. Any
 * answer but a plain yes or a 404 (the network, a limit) throws: a guess here
 * would put someone's papers in Junk.
 */
export async function provablyNotHere(clientId: string, papers: Paper[]): Promise<Set<string>> {
  const token = await ensureDriveToken(clientId);
  const theirs = new Set<string>();
  for (const paper of papers) {
    const ids = [paper.drive?.folderId, paper.drive?.metaFileId, paper.drive?.pdfFileId].filter((id): id is string => Boolean(id));
    if (!ids.length) continue;
    let seen = false;
    for (const id of ids) {
      try {
        await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id`);
        seen = true;
        break;
      } catch (error) {
        if (!(error instanceof DriveRequestError) || error.status !== 404) throw error;
      }
    }
    if (!seen) theirs.add(paper.id);
  }
  return theirs;
}

/**
 * The library with the papers in `ids` moved to Junk, their highlights with
 * them, as removing them by hand would — nothing is lost, and Junk's Restore
 * brings one back (and saves it to this account's Drive, since its folder is
 * not here). For a library file another account's library was mixed into.
 */
export function disown(library: Library, ids: Set<string>, removedAt: string): Library {
  if (!ids.size) return library;
  const leaving = library.papers.filter((paper) => ids.has(paper.id));
  const entries: JunkEntry[] = leaving.map((paper) => ({
    paper,
    highlights: library.highlights.filter((highlight) => highlight.paperId === paper.id),
    removedAt,
    drive: 'not-in-drive',
  }));
  return {
    papers: library.papers.filter((paper) => !ids.has(paper.id)),
    collections: library.collections,
    highlights: library.highlights.filter((highlight) => !ids.has(highlight.paperId)),
    junk: [...entries, ...library.junk.filter((entry) => !ids.has(entry.paper.id))],
  };
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
