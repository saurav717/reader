// A project's folder in the signed-in account's Google Drive, as the
// Playground's editor, explorer and agent read and write files: under the
// reader's own folder, `Papers_collection/Playgrounds/<name>-<id>/`, with
// sub-folders as Drive folders. The app's `drive.file` access sees only what
// it made, which is exactly this folder. Ids are looked up by name once and
// remembered for the session, so a save is one request.

import type { RuntimeEntry } from './colab';
import { driveFetch, ensureDriveToken, ensureFolder, escapeQuery, FOLDER_MIME, trashFile, uploadFile } from './google';
import type { FileHost } from './playground';
import { ROOT_FOLDER } from './sidecar';

export const PLAYGROUNDS_FOLDER = 'Playgrounds';

export interface DriveConfig {
  clientId: string;
  folderName?: string;
}

interface Child {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
}

const MIME: [RegExp, string][] = [
  [/\.py$/i, 'text/x-python'],
  [/\.(md|markdown)$/i, 'text/markdown'],
  [/\.jsonl?$/i, 'application/json'],
  [/\.ya?ml$/i, 'application/x-yaml'],
  [/\.csv$/i, 'text/csv'],
  [/\.(sh|bash)$/i, 'application/x-sh'],
  [/\.ipynb$/i, 'application/x-ipynb+json'],
];
const mimeOf = (path: string) => MIME.find(([test]) => test.test(path))?.[1] ?? 'text/plain';

/** The folder's name in Drive: the project's name and its id, so two of one name don't share a folder. */
export const driveFolderName = (title: string, id: string) => `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'project'}-${id}`;

/** A folder's children, every page of them. */
async function children(token: string, parentId: string): Promise<Child[]> {
  const found: Child[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q: `'${escapeQuery(parentId)}' in parents and trashed = false`, fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime)', spaces: 'drive', pageSize: '1000' });
    if (pageToken) params.set('pageToken', pageToken);
    const payload = (await (await driveFetch(token, `https://www.googleapis.com/drive/v3/files?${params}`)).json()) as { files?: Child[]; nextPageToken?: string };
    found.push(...(payload.files ?? []));
    pageToken = payload.nextPageToken;
  } while (pageToken);
  return found;
}

/**
 * The project's folder in Drive as a file host. `config` is read at each use:
 * null when the account is signed out or Drive isn't connected, and then each
 * call says so rather than keep anything elsewhere.
 */
export function driveHost(config: () => DriveConfig | null, folder: string): FileHost {
  const ids = new Map<string, string>();
  let rootId: Promise<string> | null = null;
  const token = async () => {
    const now = config();
    if (!now) throw new Error('This project’s files are in your Google Drive: sign in with Google, with Drive, to open them.');
    return ensureDriveToken(now.clientId);
  };
  const root = (t: string) => {
    if (!rootId) {
      const now = config();
      rootId = (async () => {
        const top = await ensureFolder(t, now?.folderName?.trim() || ROOT_FOLDER);
        const all = await ensureFolder(t, PLAYGROUNDS_FOLDER, top);
        return ensureFolder(t, folder, all);
      })();
      rootId.catch(() => (rootId = null));
    }
    return rootId;
  };
  /** The id of the folder at `path` ('' the project's own), made on the way when `make`. */
  const folderId = async (t: string, path: string, make: boolean): Promise<string | null> => {
    let at = await root(t);
    let walked = '';
    for (const part of path.split('/').filter(Boolean)) {
      walked = walked ? `${walked}/${part}` : part;
      const known = ids.get(`d:${walked}`);
      if (known) {
        at = known;
        continue;
      }
      const hit = (await children(t, at)).find((child) => child.name === part && child.mimeType === FOLDER_MIME);
      const next = hit?.id ?? (make ? await ensureFolder(t, part, at) : null);
      if (!next) return null;
      ids.set(`d:${walked}`, next);
      at = next;
    }
    return at;
  };
  /** A path and everything under it, no longer remembered: it moved or went. */
  const forget = (path: string) => {
    for (const key of [...ids.keys()]) if (key.slice(2) === path || key.slice(2).startsWith(`${path}/`)) ids.delete(key);
  };
  const split = (path: string) => {
    const parts = path.split('/').filter(Boolean);
    return { dir: parts.slice(0, -1).join('/'), name: parts[parts.length - 1] ?? '' };
  };
  const fileId = async (t: string, path: string): Promise<string | null> => {
    const known = ids.get(`f:${path}`);
    if (known) return known;
    const { dir, name } = split(path);
    const parent = await folderId(t, dir, false);
    if (!parent) return null;
    const hit = (await children(t, parent)).find((child) => child.name === name && child.mimeType !== FOLDER_MIME);
    if (hit) ids.set(`f:${path}`, hit.id);
    return hit?.id ?? null;
  };
  return {
    label: 'Google Drive',
    async list(path = '') {
      const t = await token();
      const parent = await folderId(t, path, false);
      if (!parent) return [];
      const entries: RuntimeEntry[] = (await children(t, parent)).map((child) => {
        const full = path ? `${path.replace(/\/+$/, '')}/${child.name}` : child.name;
        const dir = child.mimeType === FOLDER_MIME;
        ids.set(`${dir ? 'd' : 'f'}:${full}`, child.id);
        return { name: child.name, path: full, type: dir ? 'directory' : 'file', size: dir ? null : Number(child.size ?? 0), modified: child.modifiedTime ?? null } as RuntimeEntry;
      });
      return entries.sort((a, b) => ((a.type === 'directory') === (b.type === 'directory') ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
    },
    async read(path) {
      const t = await token();
      const id = await fileId(t, path);
      if (!id) return null;
      const response = await driveFetch(t, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
      return response.text();
    },
    async write(path, text) {
      const t = await token();
      const { dir, name } = split(path);
      if (!name) throw new Error('A file needs a name.');
      const parent = await folderId(t, dir, true);
      if (!parent) throw new Error(`Could not make the folder ${dir} in Drive.`);
      const existing = await fileId(t, path);
      const saved = await uploadFile(t, { name, mimeType: mimeOf(name), parentId: parent, body: text, fileId: existing ?? undefined });
      ids.set(`f:${path}`, saved.id);
    },
    /** Into Drive's trash, where it can be restored for thirty days. */
    async remove(path) {
      const t = await token();
      const id = (await fileId(t, path)) ?? (await folderId(t, path, false));
      if (!id) return;
      await trashFile(t, id);
      forget(path);
    },
    async rename(from, to) {
      const t = await token();
      const id = (await fileId(t, from)) ?? (await folderId(t, from, false));
      if (!id) throw new Error(`${from} isn’t in the folder.`);
      const { dir: oldDir } = split(from);
      const { dir, name } = split(to);
      const params = new URLSearchParams({ fields: 'id' });
      if (dir !== oldDir) {
        const [now, next] = await Promise.all([folderId(t, oldDir, false), folderId(t, dir, true)]);
        if (next) params.set('addParents', next);
        if (now) params.set('removeParents', now);
      }
      await driveFetch(t, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?${params}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      forget(from);
    },
    async mkdir(path) {
      await folderId(await token(), path, true);
    },
  };
}

/** The address of the project's folder in Drive, for "Open in Drive". */
export async function driveFolderLink(config: DriveConfig, folder: string): Promise<string> {
  const t = await ensureDriveToken(config.clientId);
  const top = await ensureFolder(t, config.folderName?.trim() || ROOT_FOLDER);
  const all = await ensureFolder(t, PLAYGROUNDS_FOLDER, top);
  return `https://drive.google.com/drive/folders/${await ensureFolder(t, folder, all)}`;
}
