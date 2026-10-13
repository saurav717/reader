import { COLLECTION_COLORS } from '../types';
import { downloadText, ensureDriveToken, ensureFolder, findAppDataFile, findFile, findFolder, findTrashed, hasAppDataAccess, queryFiles, untrash, uploadFile, } from './google';
import { driveFolderUrl, JUNK_FOLDER, ROOT_FOLDER } from './driveSync';
export const LIBRARY_FILE = 'library.json';
export const emptyLibrary = () => ({ papers: [], collections: [], highlights: [], junk: [] });
/** The library as it is written: the same object every time for the same library, so two can be compared as text. */
export function serialise(library) {
    const byId = (items) => items.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
export function parseLibraryFile(text) {
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.papers))
            return null;
        const list = (value, ok) => (Array.isArray(value) ? value.filter(ok) : []);
        const library = {
            papers: list(parsed.papers, (paper) => typeof paper?.id === 'string' && typeof paper.title === 'string').map((paper) => ({
                ...paper,
                collectionIds: Array.isArray(paper.collectionIds) ? paper.collectionIds : [],
                tags: Array.isArray(paper.tags) ? paper.tags : [],
                authors: Array.isArray(paper.authors) ? paper.authors : [],
                categories: Array.isArray(paper.categories) ? paper.categories : [],
                progress: typeof paper.progress === 'number' ? paper.progress : 0,
            })),
            collections: list(parsed.collections, (item) => typeof item?.id === 'string' && typeof item.name === 'string'),
            highlights: list(parsed.highlights, (item) => typeof item?.id === 'string' && typeof item.paperId === 'string'),
            junk: list(parsed.junk, (item) => typeof item?.paper?.id === 'string'),
        };
        const account = typeof parsed.account === 'string' && parsed.account.trim() ? parsed.account.trim() : undefined;
        return account ? { library, account } : { library };
    }
    catch {
        return null;
    }
}
/** The library in a file read back from Drive, or null when the text is not one. */
export const parseLibrary = (text) => parseLibraryFile(text)?.library ?? null;
/**
 * A project as `base` has it, with where its paper is from `extra` too: the
 * paper's Drive folder, and each computer's folder for it. Kept whichever
 * side has them, so a copy of the project that is older on one device never
 * takes from every device where its paper is.
 */
function withLinks(base, extra) {
    const mine = base.project?.overleaf;
    const theirs = extra.project?.overleaf;
    if (!base.project || !theirs || (!theirs.drive && !theirs.folders && !theirs.keep))
        return base;
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
export function mergeLibraries(base, extra) {
    const collections = base.collections.slice();
    const rename = new Map();
    for (const collection of extra.collections) {
        const same = collections.findIndex((item) => item.id === collection.id);
        if (same >= 0) {
            collections[same] = withLinks(collections[same], collection);
            continue;
        }
        const sameName = collections.find((item) => item.name.trim().toLowerCase() === collection.name.trim().toLowerCase());
        if (sameName)
            rename.set(collection.id, sameName.id);
        else
            collections.push(collection);
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
const COLOURS = ['yellow', 'green', 'blue', 'pink'];
/**
 * A paper's sidecar read back into the library: the paper, its highlights,
 * and the names of the collections it was in. The sidecar keeps neither
 * reading progress nor collection colours, so those start afresh.
 */
export function fromSidecar(sidecar, where) {
    const said = (sidecar?.paper ?? {});
    const id = typeof said.id === 'string' ? said.id : '';
    const title = typeof said.title === 'string' ? said.title : '';
    if (!id || !title)
        return null;
    const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
    const text = (value) => (typeof value === 'string' && value ? value : undefined);
    const paper = {
        id,
        source: text(said.source) ?? (id.startsWith('arxiv:') ? 'arxiv' : 'openalex'),
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
    const highlights = [];
    for (const raw of Array.isArray(sidecar.annotations) ? sidecar.annotations : []) {
        const note = raw;
        const target = (note.target ?? {});
        const selectors = Array.isArray(target.selector) ? target.selector : [];
        const quote = selectors.find((item) => item?.type === 'TextQuoteSelector') ?? {};
        const position = selectors.find((item) => item?.type === 'TextPositionSelector') ?? {};
        const exact = text(quote.exact);
        if (!exact || typeof note.id !== 'string')
            continue;
        const colour = COLOURS.includes(note.colour) ? note.colour : 'yellow';
        highlights.push({
            id: note.id,
            paperId: id,
            color: colour,
            style: note.style === 'underline' ? 'underline' : 'highlight',
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
    const colours = {};
    const saidColours = said.collectionColours;
    if (saidColours && typeof saidColours === 'object') {
        for (const [name, colour] of Object.entries(saidColours)) {
            if (typeof colour === 'string' && /^#[0-9a-f]{3,8}$/i.test(colour))
                colours[name] = colour;
        }
    }
    return { paper, highlights, collectionNames: strings(said.collections), colours };
}
/** Sidecars read back as a library, collections made from the names they carry. */
export function libraryFromSidecars(read, newId) {
    const collections = [];
    const colours = Object.assign({}, ...read.map((item) => item.colours ?? {}));
    const idFor = (name) => {
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
const rootName = (folderName) => folderName?.trim() || ROOT_FOLDER;
/** The spare copy in the app's hidden folder, or null when there is none or it cannot be reached. */
async function readBackup(token) {
    if (!hasAppDataAccess())
        return null;
    const file = await findAppDataFile(token, LIBRARY_FILE).catch(() => null);
    if (!file)
        return null;
    return parseLibraryFile(await downloadText(token, file.id).catch(() => ''));
}
/** The root folder, taken back out of the trash if that is where it went. */
async function findRoot(token, name) {
    const found = await findFolder(token, name);
    if (found)
        return found;
    const trashed = await findTrashed(token, name);
    return trashed ? (await untrash(token, trashed.id)).id : null;
}
/**
 * The library in this account's Drive, or null when it has none at all. The
 * file in the root folder first — out of the trash, folder and all, if it
 * was put there — and the spare copy when the file is gone. `account` is
 * whose the file says it is, when it says.
 */
export async function readLibraryFromDrive(clientId, folderName) {
    const token = await ensureDriveToken(clientId);
    const rootId = await findRoot(token, rootName(folderName));
    let file = rootId ? await findFile(token, LIBRARY_FILE, rootId) : null;
    let source = 'file';
    if (!file && rootId) {
        const trashed = await findTrashed(token, LIBRARY_FILE, rootId);
        if (trashed) {
            file = await untrash(token, trashed.id);
            source = 'trash';
        }
    }
    if (file) {
        const read = parseLibraryFile(await downloadText(token, file.id));
        if (read)
            return { ...read, mark: { fileId: file.id, modifiedTime: file.modifiedTime }, source };
        // A file that will not parse — edited by hand — is not trusted over the spare copy.
        const backup = await readBackup(token);
        if (backup)
            return { ...backup, mark: null, source: 'backup' };
        throw new Error(`${rootName(folderName)}/${LIBRARY_FILE} in Drive could not be read.`);
    }
    const backup = await readBackup(token);
    return backup ? { ...backup, mark: null, source: 'backup' } : null;
}
/** When Drive last saw the library file change, without reading it. */
export async function libraryMark(clientId, folderName) {
    const token = await ensureDriveToken(clientId);
    const rootId = await findFolder(token, rootName(folderName));
    if (!rootId)
        return null;
    const file = await findFile(token, LIBRARY_FILE, rootId);
    return file ? { fileId: file.id, modifiedTime: file.modifiedTime } : null;
}
export async function writeLibraryToDrive(clientId, folderName, library, options) {
    const token = await ensureDriveToken(clientId);
    const rootId = await ensureFolder(token, rootName(folderName));
    const body = { generator: 'reader', version: 1, account: options.account, updatedAt: new Date().toISOString(), ...library };
    const write = (fileId) => uploadFile(token, { name: LIBRARY_FILE, mimeType: 'application/json', parentId: rootId, body: JSON.stringify(body), fileId });
    let file;
    try {
        file = await write(options.fileId ?? (await findFile(token, LIBRARY_FILE, rootId))?.id);
    }
    catch (error) {
        // Deleted in Drive by hand since: written afresh.
        if (!options.fileId || error.status !== 404)
            throw error;
        file = await write(undefined);
    }
    await writeBackup(token, JSON.stringify(body)).catch(() => undefined);
    return { fileId: file.id, modifiedTime: file.modifiedTime };
}
let backupId = null;
/**
 * The same library, to the spare copy in the app's hidden folder. A failure
 * here is not the write failing — the file in the root folder is the record —
 * so it is left to the next write to try again.
 */
async function writeBackup(token, body) {
    if (!hasAppDataAccess())
        return;
    const file = { name: LIBRARY_FILE, mimeType: 'application/json', parentId: 'appDataFolder', body };
    backupId ??= (await findAppDataFile(token, LIBRARY_FILE))?.id ?? null;
    try {
        backupId = (await uploadFile(token, { ...file, fileId: backupId ?? undefined })).id;
    }
    catch (error) {
        if (!backupId || error.status !== 404)
            throw error;
        backupId = (await uploadFile(token, file)).id;
    }
}
/**
 * The library as the paper folders in this account's Drive describe it, for
 * an account that saved papers before the library had a file of its own. One
 * request finds every folder, one every sidecar, and then each sidecar is
 * read; what is in Junk is left there.
 */
export async function rebuildFromSidecars(clientId, folderName, newId) {
    const token = await ensureDriveToken(clientId);
    const rootId = await findFolder(token, rootName(folderName));
    if (!rootId)
        return emptyLibrary();
    const folders = await queryFiles(token, `'${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder'`);
    const paperFolders = new Map(folders.filter((folder) => folder.name !== JUNK_FOLDER).map((folder) => [folder.id, folder.name]));
    if (!paperFolders.size)
        return emptyLibrary();
    const sidecars = (await queryFiles(token, "mimeType = 'application/json'")).filter((file) => file.name !== LIBRARY_FILE && file.parents?.some((parent) => paperFolders.has(parent)));
    const read = [];
    for (const file of sidecars) {
        const folderId = file.parents?.find((parent) => paperFolders.has(parent));
        try {
            const parsed = fromSidecar(JSON.parse(await downloadText(token, file.id)), {
                folderId,
                metaFileId: file.id,
                folderName: paperFolders.get(folderId),
            });
            if (parsed && !read.some((item) => item.paper.id === parsed.paper.id))
                read.push(parsed);
        }
        catch {
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
export async function visibleInDrive(clientId, ids) {
    if (!ids.length)
        return new Set();
    const token = await ensureDriveToken(clientId);
    const seen = new Set();
    for (const id of ids) {
        const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,trashed`, {
            headers: { Authorization: `Bearer ${token}` },
        }).catch(() => null);
        if (response?.ok)
            seen.add(id);
    }
    return seen;
}
