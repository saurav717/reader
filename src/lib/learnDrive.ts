// ===========================================================================
//  Learn tracks in Drive.
//
//  A track — its map, its pages, where you are on it — is kept in this
//  browser (IndexedDB) and, with Drive connected, in your own Drive too:
//
//    Papers_collection/Learn/<topic> (<id>)/track.json
//    Papers_collection/Learn/<topic> (<id>)/01 Gaussian noise.md
//    Papers_collection/Learn/<topic> (<id>)/02 Markov chains.md
//    …
//
//  track.json is the whole track, what another browser (or this one after
//  its storage is cleared) reads back; the Markdown files are each page as
//  the model wrote it, with a few lines of front matter, so the course is
//  also a folder of documents you can open in Drive and read. Only track.json
//  is read back: the pages in it are the pages.
// ===========================================================================

import type { Settings } from '../types';
import { pageFile } from './learn';
import type { LearnDriveAdapter, LearnTrack } from './learn';
import { DriveRequestError, downloadText, ensureDriveToken, ensureFolder, findFile, findFolder, FOLDER_MIME, listFiles, trashFile, uploadFile } from './google';
import { ROOT_FOLDER } from './sidecar';

export const LEARN_FOLDER = 'Learn';
const TRACK_FILE = 'track.json';

const safe = (text: string) =>
  text
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The track's folder: its topic, and its id so a renamed or remapped track keeps its folder. */
export const trackFolderName = (track: Pick<LearnTrack, 'id' | 'topic'>) => `${safe(track.topic).slice(0, 60) || 'topic'} (${track.id})`;

/** The id in a folder's name, when it is one of ours. */
export const trackIdOf = (folderName: string): string | null => /\(([a-z0-9]+)\)\s*$/i.exec(folderName)?.[1] ?? null;

/** A page's file: its number and title, so the folder lists the course in order. */
export function pageFileName(track: LearnTrack, nodeId: string): string {
  const at = track.nodes.findIndex((node) => node.id === nodeId);
  const node = track.nodes[at];
  return `${String(at + 1).padStart(2, '0')} ${safe(node?.title ?? nodeId).slice(0, 80)}.md`;
}

/** What goes in track.json: the track without what is only this browser's. */
export function trackJson(track: LearnTrack): string {
  const { mapping: _m, error: _e, drive: _d, ...kept } = track;
  const pages = Object.fromEntries(
    Object.entries(kept.pages).map(([id, page]) => {
      const { streaming: _s, thinking: _t, pending: _p, ...rest } = page;
      return [id, rest];
    }),
  );
  return JSON.stringify({ generator: 'reader', v: 1, ...kept, pages }, null, 1);
}

/** A track read back from track.json; null when it is not one. */
export function fromTrackJson(text: string): LearnTrack | null {
  try {
    const raw = JSON.parse(text) as Partial<LearnTrack> & { generator?: string };
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.topic !== 'string' || !Array.isArray(raw.nodes)) return null;
    return {
      id: raw.id,
      topic: raw.topic,
      from: raw.from ?? '',
      to: raw.to ?? '',
      prefs: raw.prefs ?? { pictures: true, plainFirst: true, code: true, checks: true },
      model: raw.model ?? '',
      created: raw.created ?? Date.now(),
      updated: raw.updated ?? raw.created ?? Date.now(),
      opened: raw.opened,
      stages: Array.isArray(raw.stages) ? raw.stages : [],
      nodes: raw.nodes,
      pages: raw.pages ?? {},
      progress: raw.progress ?? {},
      glossary: Array.isArray(raw.glossary) ? raw.glossary : [],
      mapSrc: raw.mapSrc,
    };
  } catch {
    return null;
  }
}

/**
 * The adapter learn.ts calls. It only ever uses a token Drive has already
 * granted, so a read when Home opens never pops a Google window up.
 */
export function learnDrive(settings: Settings): LearnDriveAdapter {
  const token = () => ensureDriveToken(settings.googleClientId);
  const rootName = settings.driveFolderName || ROOT_FOLDER;
  /** The ids found, so a save is a few requests, not a search each. */
  const folders = new Map<string, string>();
  const files = new Map<string, string>();

  async function learnFolder(accessToken: string, create: boolean): Promise<string | null> {
    const known = folders.get('learn');
    if (known) return known;
    const root = create ? await ensureFolder(accessToken, rootName) : await findFolder(accessToken, rootName);
    if (!root) return null;
    const learn = create ? await ensureFolder(accessToken, LEARN_FOLDER, root) : await findFolder(accessToken, LEARN_FOLDER, root);
    if (learn) folders.set('learn', learn);
    return learn;
  }

  async function trackFolder(accessToken: string, track: LearnTrack): Promise<string> {
    const known = folders.get(track.id);
    if (known) return known;
    const learn = (await learnFolder(accessToken, true))!;
    // A folder made for this track before, under an earlier topic wording, is found by its id.
    const existing = (await listFiles(accessToken, learn, FOLDER_MIME)).find((folder) => trackIdOf(folder.name) === track.id);
    const id = existing?.id ?? (await ensureFolder(accessToken, trackFolderName(track), learn));
    folders.set(track.id, id);
    return id;
  }

  async function write(accessToken: string, parent: string, name: string, body: string, mimeType: string): Promise<void> {
    const key = `${parent}/${name}`;
    let fileId = files.get(key) ?? (await findFile(accessToken, name, parent))?.id;
    const file = { name, mimeType, parentId: parent, body };
    const saved = fileId
      ? await uploadFile(accessToken, { ...file, fileId }).catch((error: unknown) => {
          if (error instanceof DriveRequestError && error.status === 404) {
            fileId = undefined;
            return null;
          }
          throw error;
        })
      : null;
    files.set(key, (saved ?? (await uploadFile(accessToken, file))).id);
  }

  return {
    async load() {
      const accessToken = await token();
      const learn = await learnFolder(accessToken, false);
      if (!learn) return [];
      const found: LearnTrack[] = [];
      for (const folder of await listFiles(accessToken, learn, FOLDER_MIME)) {
        const id = trackIdOf(folder.name);
        if (!id) continue;
        const file = await findFile(accessToken, TRACK_FILE, folder.id);
        if (!file) continue;
        const track = fromTrackJson(await downloadText(accessToken, file.id));
        if (!track) continue;
        folders.set(track.id, folder.id);
        files.set(`${folder.id}/${TRACK_FILE}`, file.id);
        found.push({ ...track, drive: { folderId: folder.id, link: `https://drive.google.com/drive/folders/${folder.id}` } });
      }
      return found;
    },

    async save(track, written) {
      const accessToken = await token();
      const folder = await trackFolder(accessToken, track);
      await write(accessToken, folder, TRACK_FILE, trackJson(track), 'application/json');
      // Each page as a document, written when its content has changed since the last save.
      for (const page of Object.values(track.pages)) {
        if (!page.content || page.streaming || written[page.nodeId] === page.updated) continue;
        await write(accessToken, folder, pageFileName(track, page.nodeId), pageFile(track, page), 'text/markdown');
        written[page.nodeId] = page.updated;
      }
      return { folderId: folder, link: `https://drive.google.com/drive/folders/${folder}` };
    },

    async remove(track) {
      const accessToken = await token();
      const folder = folders.get(track.id) ?? track.drive?.folderId;
      if (folder) await trashFile(accessToken, folder);
      folders.delete(track.id);
    },
  };
}
