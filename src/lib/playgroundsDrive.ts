/**
 * The playgrounds — what each is called, where it runs and where its files
 * are, its sync rules, its console's history and its notebook's cells — kept
 * as one file in the signed-in account's own Drive, beside the library:
 * `Papers_collection/playgrounds.json`, with a spare copy in the app's hidden
 * folder. Whichever browser signs in with the account reads it, so a project
 * opens anywhere; the files themselves stay where they are (on the computer
 * with the Reader Companion, or in the browser they were made in).
 *
 * A computer is named by its Companion's id (`deviceId`), the same in every
 * browser, not by the id a browser gave its own list of servers.
 *
 * Two browsers may change the list between reads, so it is merged, not
 * overwritten: for each playground the newer record wins, and one deleted
 * (kept as its id and when, in `deleted`) stays deleted unless it changed
 * after. The browser's own copy (db.ts) is only so that the page opens at
 * once and works offline.
 */
import type { Playground } from './playground';
import { downloadText, ensureDriveToken, ensureFolder, findAppDataFile, findFile, findFolder, hasAppDataAccess, uploadFile } from './google';
import { ROOT_FOLDER } from './sidecar';

export const PLAYGROUNDS_FILE = 'playgrounds.json';

export interface PlaygroundSet {
  playgrounds: Playground[];
  /** Deleted playgrounds: id → when. */
  deleted: Record<string, number>;
}

interface PlaygroundsFile extends PlaygroundSet {
  generator: 'reader';
  version: 1;
  account?: string;
  updatedAt: string;
}

const rootName = (folderName: string | undefined) => folderName?.trim() || ROOT_FOLDER;

/** The set read back from a file: checked enough that a stray or hand-edited file can't break the list. */
export function parsePlaygrounds(text: string): PlaygroundSet | null {
  try {
    const parsed = JSON.parse(text) as Partial<PlaygroundsFile>;
    if (!parsed || !Array.isArray(parsed.playgrounds)) return null;
    const deleted: Record<string, number> = {};
    for (const [id, at] of Object.entries(parsed.deleted ?? {})) if (typeof at === 'number') deleted[id] = at;
    return { playgrounds: parsed.playgrounds.filter((p) => p && typeof p.id === 'string'), deleted };
  } catch {
    return null;
  }
}

/** Both sets as one: the newer record of each playground, deletions kept, and a playground deleted after its last change left out. */
export function mergePlaygrounds(a: PlaygroundSet, b: PlaygroundSet): PlaygroundSet {
  const deleted: Record<string, number> = { ...a.deleted };
  for (const [id, at] of Object.entries(b.deleted)) deleted[id] = Math.max(deleted[id] ?? 0, at);
  const byId = new Map<string, Playground>();
  for (const p of [...a.playgrounds, ...b.playgrounds]) {
    const held = byId.get(p.id);
    if (!held || (p.updated ?? 0) > (held.updated ?? 0)) byId.set(p.id, p);
  }
  const playgrounds = [...byId.values()].filter((p) => !(deleted[p.id] >= (p.updated ?? 0))).sort((x, y) => (y.updated ?? 0) - (x.updated ?? 0));
  return { playgrounds, deleted };
}

/** The set as it is written: the same text for the same set, so two can be compared. */
export const serialisePlaygrounds = (set: PlaygroundSet) =>
  JSON.stringify({
    playgrounds: set.playgrounds.slice().sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)),
    deleted: Object.fromEntries(Object.entries(set.deleted).sort(([x], [y]) => (x < y ? -1 : 1))),
  });

/** The account's playgrounds in Drive: the file, else the spare copy; null when it has neither. */
export async function readPlaygroundsFromDrive(clientId: string, folderName: string | undefined): Promise<PlaygroundSet | null> {
  const token = await ensureDriveToken(clientId);
  const rootId = await findFolder(token, rootName(folderName));
  const file = rootId ? await findFile(token, PLAYGROUNDS_FILE, rootId) : null;
  if (file) {
    const set = parsePlaygrounds(await downloadText(token, file.id));
    if (set) return set;
  }
  if (!hasAppDataAccess()) return null;
  const spare = await findAppDataFile(token, PLAYGROUNDS_FILE).catch(() => null);
  return spare ? parsePlaygrounds(await downloadText(token, spare.id).catch(() => '')) : null;
}

/** Writes the set to the file in the root folder, and to the spare copy. */
export async function writePlaygroundsToDrive(clientId: string, folderName: string | undefined, set: PlaygroundSet, account?: string): Promise<void> {
  const token = await ensureDriveToken(clientId);
  const rootId = await ensureFolder(token, rootName(folderName));
  const body: PlaygroundsFile = { generator: 'reader', version: 1, account, updatedAt: new Date().toISOString(), ...set };
  const text = JSON.stringify(body);
  const existing = await findFile(token, PLAYGROUNDS_FILE, rootId);
  await uploadFile(token, { name: PLAYGROUNDS_FILE, mimeType: 'application/json', parentId: rootId, body: text, fileId: existing?.id });
  if (hasAppDataAccess()) {
    const spare = await findAppDataFile(token, PLAYGROUNDS_FILE).catch(() => null);
    await uploadFile(token, { name: PLAYGROUNDS_FILE, mimeType: 'application/json', parentId: 'appDataFolder', body: text, fileId: spare?.id }).catch(() => undefined);
  }
}
