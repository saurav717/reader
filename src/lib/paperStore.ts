// Where the Write tab keeps a paper's files, behind one interface: a folder on
// this computer, through its Companion (a clone of Overleaf's Git, a Dropbox
// folder), or the project's folder in Google Drive — nothing on the computer,
// compiled on Cloud Run, synced with Overleaf by Cloud Run too
// (worker/latex.js, cloudrun/latex/server.py). Paths are the paper's own,
// relative to its folder: main.tex, sections/intro.tex.

import { jupyterDelete, jupyterList, jupyterMkdir, jupyterRead, jupyterReadBase64, jupyterRename, jupyterWrite, jupyterWriteBase64 } from './colab';
import { driveFolderLink, driveHost, PAPERS_FOLDER, type DriveConfig } from './driveFiles';
import { unzip } from './zip';

export interface PaperEntry {
  name: string;
  /** Relative to the paper's folder. */
  path: string;
  type: 'file' | 'directory';
  size: number | null;
  modified: string | null;
}

export interface PaperStore {
  kind: 'companion' | 'drive';
  /** Where it is, as the page says it: ~/Reader/papers/x, Drive › Papers › x. */
  label: string;
  list(dir?: string): Promise<PaperEntry[]>;
  readText(path: string): Promise<{ text: string; modified: string | null } | null>;
  readBase64(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<{ modified: string | null }>;
  writeBase64(path: string, base64: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** An address to open the folder at, where there is one (Drive). */
  link?(): Promise<string>;
}

const join = (folder: string, path: string) => [folder, path].filter(Boolean).join('/').replace(/\/+/g, '/');
const relative = (folder: string, path: string) => (folder && path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path);

/** The paper's folder on this computer, through its Companion's Jupyter server. */
export function companionStore(server: { url: string; token: string }, folder: string): PaperStore {
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

/** A Drive folder's name for a project's paper: its name and its id, as the Playground's. */
export const paperDriveFolder = (name: string, id: string) => `${name.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'paper'}-${id}`;

const driveStores = new Map<string, PaperStore>();

/** The project's paper in Google Drive: Papers_collection/Papers/<folder>/. Needs the signed-in account's Drive. */
export function driveStore(config: () => DriveConfig | null, folder: string): PaperStore {
  const known = driveStores.get(folder);
  if (known) return known;
  const host = driveHost(config, folder, PAPERS_FOLDER);
  const store: PaperStore = {
    kind: 'drive',
    label: `Google Drive › ${PAPERS_FOLDER} › ${folder}`,
    async list(dir = '') {
      return (await host.list(dir)).map((entry) => ({ name: entry.name, path: entry.path, type: entry.type === 'directory' ? 'directory' : 'file', size: entry.size, modified: entry.modified }));
    },
    async readText(path) {
      const text = await host.read(path);
      return text === null ? null : { text, modified: null };
    },
    async readBase64(path) {
      const base64 = await host.readBase64(path);
      if (base64 === null) throw new Error(`${path} isn’t in the paper’s Drive folder.`);
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
    link: async () => {
      const now = config();
      if (!now) throw new Error('Sign in with Google, with Drive.');
      return driveFolderLink(now, folder, PAPERS_FOLDER);
    },
  };
  driveStores.set(folder, store);
  return store;
}

// ------------------------------------------------------------ templates --


/** A conference's kit, kept to start papers from. */
export interface ShelfTemplate {
  slug: string;
  name: string;
  files: number;
  main: string;
}

/** Where templates are kept and how one goes into a paper: the Companion's, or Drive's. */
export interface TemplateShelf {
  list(): Promise<ShelfTemplate[]>;
  /** A .zip (as base64) kept as a template. */
  save(name: string, zipBase64: string): Promise<ShelfTemplate>;
  /** The template's files written into the paper under `dir`; the main document's path back. */
  apply(slug: string, dir: string): Promise<string>;
}

const within = (dir: string, path: string) => (dir ? `${dir}/${path}` : path);
const toBase64 = (bytes: Uint8Array) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};

/** The main document among a kit's files: main.tex if it has \documentclass, else the first that does. */
export function kitMain(files: { path: string; bytes: Uint8Array }[]): string {
  const decoder = new TextDecoder();
  const documents = files.filter((file) => /\.tex$/i.test(file.path) && /^[^%\n]*\\documentclass/m.test(decoder.decode(file.bytes)));
  return (documents.find((file) => /(^|\/)main\.tex$/i.test(file.path)) ?? documents.sort((a, b) => a.path.split('/').length - b.path.split('/').length)[0])?.path ?? '';
}

/** A kit's files written into the paper under `dir`; its main document's path back. */
export async function unpackKit(store: PaperStore, zipBase64: string, dir: string): Promise<string> {
  const files = await unzip(Uint8Array.from(atob(zipBase64), (char) => char.charCodeAt(0)));
  if (!files.length) throw new Error('The .zip has no files in it.');
  for (const file of files) await store.writeBase64(within(dir, file.path), toBase64(file.bytes));
  return within(dir, kitMain(files) || 'main.tex');
}

/** Templates in Drive, as the .zip each came as: Papers_collection/Papers/_templates/<name>.zip. */
export function driveShelf(config: () => DriveConfig | null, store: PaperStore): TemplateShelf {
  const shelf = driveHost(config, '_templates', PAPERS_FOLDER);
  const describe = async (name: string): Promise<ShelfTemplate> => {
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
      if (!base64) throw new Error(`There is no template ${slug} in Drive.`);
      return unpackKit(store, base64, dir);
    },
  };
}
