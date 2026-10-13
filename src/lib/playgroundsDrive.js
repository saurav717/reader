import { downloadText, ensureDriveToken, ensureFolder, findAppDataFile, hasAppDataAccess, queryFiles, uploadFile } from './google';
import { ROOT_FOLDER } from './sidecar';
export const PLAYGROUNDS_FILE = 'playgrounds.json';
const rootName = (folderName) => folderName?.trim() || ROOT_FOLDER;
/** The set read back from a file: checked enough that a stray or hand-edited file can't break the list. */
export function parsePlaygrounds(text) {
    try {
        const parsed = JSON.parse(text);
        if (!parsed || !Array.isArray(parsed.playgrounds))
            return null;
        const deleted = {};
        for (const [id, at] of Object.entries(parsed.deleted ?? {}))
            if (typeof at === 'number')
                deleted[id] = at;
        return { playgrounds: parsed.playgrounds.filter((p) => p && typeof p.id === 'string'), deleted };
    }
    catch {
        return null;
    }
}
/** Both sets as one: the newer record of each playground, deletions kept, and a playground deleted after its last change left out. */
export function mergePlaygrounds(a, b) {
    const deleted = { ...a.deleted };
    for (const [id, at] of Object.entries(b.deleted))
        deleted[id] = Math.max(deleted[id] ?? 0, at);
    const byId = new Map();
    for (const p of [...a.playgrounds, ...b.playgrounds]) {
        const held = byId.get(p.id);
        if (!held || (p.updated ?? 0) > (held.updated ?? 0))
            byId.set(p.id, p);
    }
    const playgrounds = [...byId.values()].filter((p) => !(deleted[p.id] >= (p.updated ?? 0))).sort((x, y) => (y.updated ?? 0) - (x.updated ?? 0));
    return { playgrounds, deleted };
}
/** The set as it is written: the same text for the same set, so two can be compared. */
export const serialisePlaygrounds = (set) => JSON.stringify({
    playgrounds: set.playgrounds.slice().sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)),
    deleted: Object.fromEntries(Object.entries(set.deleted).sort(([x], [y]) => (x < y ? -1 : 1))),
});
/**
 * Several copies of the file, as text, read as one: merged, with whether
 * they said the same. Null when none of them is a playgrounds file.
 */
export function mergeCopies(texts) {
    const sets = texts.map(parsePlaygrounds).filter((set) => Boolean(set));
    if (!sets.length)
        return null;
    const merged = sets.reduce((all, set) => mergePlaygrounds(all, set));
    const text = serialisePlaygrounds(merged);
    return { ...merged, copiesAgree: sets.every((set) => serialisePlaygrounds(set) === text) };
}
/** Every playgrounds.json the app can see in the account's Drive, wherever it is. */
const copiesInDrive = (token) => queryFiles(token, `name = '${PLAYGROUNDS_FILE}'`);
/**
 * The account's playgrounds in Drive: every copy of the file merged, and the
 * spare copy; null when there is none. Not only the first one found — two
 * browsers that wrote first at the same moment can each have made a reader
 * folder or a file of their own, and a browser that read only "the first"
 * could keep reading a different one from another, each sure it was synced.
 */
export async function readPlaygroundsFromDrive(clientId, _folderName) {
    const token = await ensureDriveToken(clientId);
    const copies = await copiesInDrive(token);
    const texts = await Promise.all(copies.map((file) => downloadText(token, file.id).catch(() => '')));
    if (hasAppDataAccess()) {
        const spare = await findAppDataFile(token, PLAYGROUNDS_FILE).catch(() => null);
        if (spare)
            texts.push(await downloadText(token, spare.id).catch(() => ''));
    }
    return mergeCopies(texts);
}
/** Writes the set to every copy of the file (a new one in the root folder when there is none), and to the spare copy. */
export async function writePlaygroundsToDrive(clientId, folderName, set, account) {
    const token = await ensureDriveToken(clientId);
    const body = { generator: 'reader', version: 1, account, updatedAt: new Date().toISOString(), playgrounds: set.playgrounds, deleted: set.deleted };
    const text = JSON.stringify(body);
    const copies = await copiesInDrive(token);
    if (copies.length) {
        await Promise.all(copies.map((file) => uploadFile(token, { name: PLAYGROUNDS_FILE, mimeType: 'application/json', parentId: file.parents?.[0] ?? '', body: text, fileId: file.id })));
    }
    else {
        const rootId = await ensureFolder(token, rootName(folderName));
        await uploadFile(token, { name: PLAYGROUNDS_FILE, mimeType: 'application/json', parentId: rootId, body: text });
    }
    if (hasAppDataAccess()) {
        const spare = await findAppDataFile(token, PLAYGROUNDS_FILE).catch(() => null);
        await uploadFile(token, { name: PLAYGROUNDS_FILE, mimeType: 'application/json', parentId: 'appDataFolder', body: text, fileId: spare?.id }).catch(() => undefined);
    }
}
