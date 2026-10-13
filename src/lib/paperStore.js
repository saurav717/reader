// Where the Write tab keeps a paper's files, behind one interface: a folder on
// this computer, through its Companion (a clone of Overleaf's Git, a Dropbox
// folder), or the project's folder in Google Drive — nothing on the computer,
// compiled on Cloud Run, synced with Overleaf by Cloud Run too
// (worker/latex.js, cloudrun/latex/server.py). Paths are the paper's own,
// relative to its folder: main.tex, sections/intro.tex.
import { jupyterDelete, jupyterList, jupyterMkdir, jupyterRead, jupyterReadBase64, jupyterRename, jupyterWrite, jupyterWriteBase64 } from './colab';
import { driveFolderLink, driveHost, PAPERS_FOLDER } from './driveFiles';
import { unzip } from './zip';
const join = (folder, path) => [folder, path].filter(Boolean).join('/').replace(/\/+/g, '/');
const relative = (folder, path) => (folder && path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path);
/** The paper's folder on this computer, through its Companion's Jupyter server. */
export function companionStore(server, folder) {
    return {
        kind: 'companion',
        label: `~/Reader/${folder}`,
        async list(dir = '') {
            const listing = await jupyterList(server, join(folder, dir));
            return listing.entries.map((entry) => ({ name: entry.name, path: relative(folder, entry.path), type: entry.type === 'directory' ? 'directory' : 'file', size: entry.size, modified: entry.modified }));
        },
        readText: (path) => jupyterRead(server, join(folder, path)),
        readBase64: (path) => jupyterReadBase64(server, join(folder, path)),
        writeText: (path, text) => jupyterWrite(server, join(folder, path), text),
        writeBase64: (path, base64) => jupyterWriteBase64(server, join(folder, path), base64),
        remove: (path) => jupyterDelete(server, join(folder, path)),
        rename: (from, to) => jupyterRename(server, join(folder, from), join(folder, to)).then(() => undefined),
        mkdir: (path) => jupyterMkdir(server, join(folder, path)).then(() => undefined),
    };
}
/**
 * Where a project's LaTeX is kept in Drive: in the project's own folder,
 * Papers_collection/Projects/<project>-<id>/LaTeX, a folder for each document
 * in it. (Papers moved into Drive before were kept under Papers/<project>-<id>:
 * a folder name without a slash is one of those, and is read where it is.)
 */
export const paperDriveFolder = (name, id) => `Projects/${name.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'project'}-${id}/LaTeX`;
const under = (folder) => (folder.includes('/') ? '' : PAPERS_FOLDER);
const driveStores = new Map();
/** The project's paper in Google Drive: Papers_collection/Papers/<folder>/. Needs the signed-in account's Drive. */
export function driveStore(config, folder) {
    const known = driveStores.get(folder);
    if (known)
        return known;
    const host = driveHost(config, folder, under(folder));
    const store = {
        kind: 'drive',
        label: `Google Drive › ${[under(folder), ...folder.split('/')].filter(Boolean).join(' › ')}`,
        async list(dir = '') {
            return (await host.list(dir)).map((entry) => ({ name: entry.name, path: entry.path, type: entry.type === 'directory' ? 'directory' : 'file', size: entry.size, modified: entry.modified }));
        },
        async readText(path) {
            const text = await host.read(path);
            return text === null ? null : { text, modified: null };
        },
        async readBase64(path) {
            const base64 = await host.readBase64(path);
            if (base64 === null)
                throw new Error(`${path} isn’t in the paper’s Drive folder.`);
            return base64;
        },
        async writeText(path, text) {
            await host.write(path, text);
            return { modified: new Date().toISOString() };
        },
        writeBase64: (path, base64) => host.writeBase64(path, base64),
        remove: (path) => host.remove?.(path) ?? Promise.resolve(),
        rename: (from, to) => host.rename?.(from, to) ?? Promise.reject(new Error('Drive can’t rename this.')),
        mkdir: (path) => host.mkdir?.(path) ?? Promise.resolve(),
        link: async (dir = '') => {
            const now = config();
            if (!now)
                throw new Error('Sign in with Google, with Drive.');
            return driveFolderLink(now, [folder, dir].filter(Boolean).join('/'), under(folder));
        },
    };
    driveStores.set(folder, store);
    return store;
}
const subStores = new WeakMap();
/**
 * A folder inside a paper's, as a paper of its own: its paths relative to it.
 * A LaTeX project with an Overleaf project of its own syncs and compiles as
 * this. The same one each time for a folder, so what a sync has read is kept.
 */
export function subStore(store, dir) {
    const clean = dir.split('/').filter((part) => part && part !== '.' && part !== '..').join('/');
    if (!clean)
        return store;
    const known = subStores.get(store) ?? new Map();
    subStores.set(store, known);
    const kept = known.get(clean);
    if (kept)
        return kept;
    const at = (path) => join(clean, path);
    const sub = {
        kind: store.kind,
        label: `${store.label} › ${clean.split('/').join(' › ')}`,
        list: async (path = '') => (await store.list(at(path))).map((entry) => ({ ...entry, path: relative(clean, entry.path) })),
        readText: (path) => store.readText(at(path)),
        readBase64: (path) => store.readBase64(at(path)),
        writeText: (path, text) => store.writeText(at(path), text),
        writeBase64: (path, base64) => store.writeBase64(at(path), base64),
        remove: (path) => store.remove(at(path)),
        rename: (from, to) => store.rename(at(from), at(to)),
        mkdir: (path) => store.mkdir(at(path)),
        ...(store.link ? { link: (inside = '') => store.link(at(inside)) } : {}),
    };
    known.set(clean, sub);
    return sub;
}
const within = (dir, path) => (dir ? `${dir}/${path}` : path);
const toBase64 = (bytes) => {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
        text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
};
/** The main document among a kit's files: main.tex if it has \documentclass, else the first that does. */
export function kitMain(files) {
    const decoder = new TextDecoder();
    const documents = files.filter((file) => /\.tex$/i.test(file.path) && /^[^%\n]*\\documentclass/m.test(decoder.decode(file.bytes)));
    return (documents.find((file) => /(^|\/)main\.tex$/i.test(file.path)) ?? documents.sort((a, b) => a.path.split('/').length - b.path.split('/').length)[0])?.path ?? '';
}
/** A kit's files written into the paper under `dir`; its main document's path back. */
export async function unpackKit(store, zipBase64, dir) {
    const files = await unzip(Uint8Array.from(atob(zipBase64), (char) => char.charCodeAt(0)));
    if (!files.length)
        throw new Error('The .zip has no files in it.');
    for (const file of files)
        await store.writeBase64(within(dir, file.path), toBase64(file.bytes));
    return within(dir, kitMain(files) || 'main.tex');
}
/** Templates in Drive, as the .zip each came as: Papers_collection/Projects/LaTeX templates/<name>.zip. */
export function driveShelf(config, store) {
    const shelf = driveHost(config, 'Projects/LaTeX templates', '');
    const describe = async (name) => {
        const base64 = await shelf.readBase64(name);
        const files = base64 ? await unzip(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))) : [];
        return { slug: name, name: name.replace(/\.zip$/i, ''), files: files.length, main: kitMain(files) };
    };
    return {
        async list() {
            const zips = (await shelf.list()).filter((entry) => entry.type === 'file' && /\.zip$/i.test(entry.name));
            return Promise.all(zips.map((entry) => describe(entry.name)));
        },
        async save(name, zipBase64) {
            const file = `${name.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'template'}.zip`;
            await shelf.writeBase64(file, zipBase64);
            return describe(file);
        },
        async apply(slug, dir) {
            const base64 = await shelf.readBase64(slug);
            if (!base64)
                throw new Error(`There is no template ${slug} in Drive.`);
            return unpackKit(store, base64, dir);
        },
    };
}
// ------------------------------------------------------- the Drive in use --
let paperDrive = null;
/** The signed-in account's Drive, as the page has it now: set by whatever renders with the store. */
export const setPaperDrive = (config) => void (paperDrive = config);
export const paperDriveNow = () => paperDrive;
