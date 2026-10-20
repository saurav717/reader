// ===========================================================================
//  A project's data place: where its datasets, checkpoints and run outputs
//  are kept — Google Drive by default — while its code runs on Colab, a
//  server or a computer of yours, whose disk is only a cache.
//
//  The compute reaches the place through koios_data.py (companion/
//  reader_companion/koios_data.py), written to the helper path beside the
//  other Koios modules, and told where the place is twice over: KOIOS_DATA in
//  every command's environment, and koios_data.json beside the module for
//  anything started another way (an agent's shell, `koios run`). For Drive
//  the place is Koios/Data/<project>/ and the way in is a *data link*: a
//  long-lived record on the Worker (a move with the plan `data`, worker/
//  moves.js) that holds the account's Google token for the machine, renewed
//  by the page every twenty minutes while the project is open — the same
//  arrangement a move to or from Drive uses, so nothing is mounted and no
//  token is written into the folder. The link is remembered in this browser
//  and made again after six days (the Worker keeps a move for seven).
// ===========================================================================

import { apiFetch, apiBase } from './api';

/** A call to the Worker as the moves make them: JSON in, JSON out, the error line thrown. */
async function call<T>(path: string, body: unknown): Promise<T> {
  const response = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const answer = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(answer.error || `The proxy answered ${response.status}.`);
  return answer;
}
import { driveFolderName, driveHost } from './driveFiles';
import { ensureDriveToken, ensureFolder } from './google';
import { KOIOS_PYLIB } from './koiosHelper';
import { workerAddress } from './moves';
import { driveConfigNow, driveConnected, serverById, serverHost, type FileHost, type Playground } from './playground';
import { ROOT_FOLDER } from './sidecar';
import KOIOS_DATA_PY_TEXT from '../../companion/reader_companion/koios_data.py?raw';

export const KOIOS_DATA_PY = KOIOS_DATA_PY_TEXT as string;
export const DATA_MODULE_FILE = 'koios_data.py';
export const DATA_CONFIG_FILE = 'koios_data.json';
/** The folder under the Koios root that holds every project's data: Koios/Data/<project>/. */
export const DATA_FOLDER = 'Data';

/** Where a project keeps its data: Drive (the default, when Drive is connected), a computer of yours (a Koios Companion), or the machine's own disk. */
export type DataPlace = { kind: 'drive' } | { kind: 'machine' } | { kind: 'server'; serverId: string };

/** A computer with at least this much free is offered as the data place when a project opens on Drive's default. */
export const OFFER_FREE_BYTES = 20 * 1024 ** 3;

export const dataPlaceOf = (playground: Pick<Playground, 'data'>, driveOn: boolean): DataPlace => playground.data ?? (driveOn ? { kind: 'drive' } : { kind: 'machine' });

/** The project's folder under Koios/Data: its title and id, as its Playgrounds folder is named. */
export const dataFolderNameOf = (playground: Pick<Playground, 'id' | 'title'>) => driveFolderName(playground.title, playground.id);

export interface DataLink {
  id: string;
  key: string;
  api: string;
  folder: string;
  made: number;
}

const LINK_KEY = (playgroundId: string) => `reader.dataLink.${playgroundId}`;
/** A link is made again after this: the Worker keeps a move for seven days. */
const LINK_LIFE_MS = 6 * 86_400_000;
const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

function readLink(playgroundId: string): DataLink | null {
  try {
    const raw = localStorage.getItem(LINK_KEY(playgroundId));
    const link = raw ? (JSON.parse(raw) as DataLink) : null;
    return link && typeof link.id === 'string' && typeof link.key === 'string' && Date.now() - link.made < LINK_LIFE_MS ? link : null;
  } catch {
    return null;
  }
}

function writeLink(playgroundId: string, link: DataLink | null): void {
  try {
    if (link) localStorage.setItem(LINK_KEY(playgroundId), JSON.stringify(link));
    else localStorage.removeItem(LINK_KEY(playgroundId));
  } catch {
    // Nowhere to remember it: a new link each time, which the Worker takes.
  }
}

/** The id of Koios/Data/<project> in the account's Drive, made on the way. */
export async function dataFolderId(playground: Pick<Playground, 'id' | 'title'>): Promise<string> {
  const config = driveConfigNow();
  if (!config) throw new Error('Google Drive isn’t connected: sign in with Drive, or keep the data on the machine.');
  const token = await ensureDriveToken(config.clientId);
  let at = await ensureFolder(token, config.folderName?.trim() || ROOT_FOLDER);
  for (const part of [DATA_FOLDER, dataFolderNameOf(playground)]) at = await ensureFolder(token, part, at);
  return at;
}

export const dataFolderLink = (folderId: string) => `https://drive.google.com/drive/folders/${folderId}`;

const dataHosts = new Map<string, FileHost>();
/**
 * The project's data place as the page reads it: Koios/Data/<project> in Drive, or koios-data/<project> on a computer
 * of yours; null when the data is on the machine's own disk. Where koios_telemetry pushes each run's folder (runs/…).
 */
export function dataHost(playground: Pick<Playground, 'id' | 'title' | 'data'>): FileHost | null {
  const place = dataPlaceOf(playground, driveConnected());
  const name = dataFolderNameOf(playground);
  if (place.kind === 'drive') {
    const key = `drive|${name}`;
    if (!dataHosts.has(key)) dataHosts.set(key, { ...driveHost(driveConfigNow, name, DATA_FOLDER), label: 'Google Drive' });
    return dataHosts.get(key)!;
  }
  if (place.kind === 'server') {
    const server = serverById(place.serverId);
    return server ? serverHost(server, `koios-data/${name}`) : null;
  }
  return null;
}

const starting = new Map<string, Promise<DataLink>>();

/**
 * The data link for a project kept on Drive: the one remembered, else a new one started on the Worker with the
 * account's token. One at a time per project.
 */
export function ensureDataLink(playground: Pick<Playground, 'id' | 'title'>): Promise<DataLink> {
  const kept = readLink(playground.id);
  if (kept) return Promise.resolve(kept);
  let pending = starting.get(playground.id);
  if (!pending) {
    pending = (async () => {
      const config = driveConfigNow();
      if (!config) throw new Error('Google Drive isn’t connected.');
      const folder = await dataFolderId(playground);
      const token = await ensureDriveToken(config.clientId);
      const id = newId();
      const started = await call<{ key: string; api: string }>('/moves/start', { id, project: playground.id, title: playground.title, plan: 'data', from: { kind: 'machine', label: 'the compute' }, to: { kind: 'drive', label: 'Google Drive', folder: dataFolderNameOf(playground) }, token });
      const link: DataLink = { id, key: started.key, api: workerAddress(started.api || apiBase()), folder, made: Date.now() };
      writeLink(playground.id, link);
      return link;
    })().finally(() => starting.delete(playground.id));
    starting.set(playground.id, pending);
  }
  return pending;
}

/** The link let go of (the project's data place changed, or the link refused): the next ask makes a new one. */
export const forgetDataLink = (playgroundId: string) => writeLink(playgroundId, null);

/** The account's token handed on again: the machine's koios_data carries on past the hour. */
export async function renewDataLink(playground: Pick<Playground, 'id' | 'title'>): Promise<void> {
  const link = readLink(playground.id);
  if (!link) return;
  const config = driveConfigNow();
  if (!config) return;
  const token = await ensureDriveToken(config.clientId);
  await call('/moves/drive-token', { id: link.id, token }).catch(() => forgetDataLink(playground.id));
}

/** What the compute is told, as the environment and as the file beside the module. */
export interface DataSetup {
  env: Record<string, string>;
  config: Record<string, string>;
  /** In words, for the person and the briefings. */
  label: string;
  link?: string;
}

/**
 * The data place as koios_data reads it. `folder` is the project's folder on the machine; the cache and a local
 * place go under its .reader/, which the sync and the pulls leave alone.
 */
export function dataSetup(place: DataPlace, folder: string, machineName: string, link?: DataLink, server?: { url: string; token: string; name: string; root?: string; project: string } | null): DataSetup {
  const cache = `${folder.replace(/\/$/, '')}/.reader/data-cache`;
  if (place.kind === 'server' && server) {
    // A folder of the Companion's root (~/Reader): koios-data/<project>, beside its playgrounds.
    const root = `koios-data/${server.project}`;
    const config = { kind: 'server', url: server.url.replace(/\/$/, ''), token: server.token, root, label: server.name };
    return { env: { KOIOS_DATA: ['server', config.url, server.token, root, server.name].join('|'), KOIOS_DATA_CACHE: cache }, config, label: `${server.name} · ${server.root ? `${server.root.replace(/\/$/, '')}/` : '~/Reader/'}${root}` };
  }
  if (place.kind === 'drive' && link) {
    const label = 'Google Drive';
    const config = { kind: 'drive', api: link.api, id: link.id, key: link.key, folder: link.folder, label };
    return { env: { KOIOS_DATA: ['drive', link.api, link.id, link.key, link.folder, label].join('|'), KOIOS_DATA_CACHE: cache }, config, label: `Google Drive · Koios/${DATA_FOLDER}/…`, link: dataFolderLink(link.folder) };
  }
  const dir = `${folder.replace(/\/$/, '')}/.reader/data`;
  return { env: { KOIOS_DATA: ['local', dir, machineName].join('|'), KOIOS_DATA_CACHE: cache }, config: { kind: 'local', dir, label: machineName }, label: `${machineName}’s disk · ${dir}` };
}

/** The line every briefing says about the data place. */
export const DATA_NOTE = (label: string) =>
  `Data, checkpoints and run outputs live in the project's data place — ${label} — not on this machine's disk, which is only a cache: \`import koios_data\`; \`koios_data.path("datasets/<name>")\` gives a local path (fetched from the place if it is there); \`koios_data.save(path)\` puts a file or folder there (\`evict=True\` frees the disk after); \`runs/\` is pushed there by koios_telemetry as a run goes, and koios.checkpoint puts every checkpoint there, so a runtime that ends loses minutes, not the run. Download datasets into \`koios_data.path(...)\`, never into the project folder. \`python koios_data.py where|ls\` says what is there.`;

/** Where the helper path's koios_data.json goes, from the project's folder. */
export const dataConfigPath = `${KOIOS_PYLIB}/${DATA_CONFIG_FILE}`;
export const dataModulePath = `${KOIOS_PYLIB}/${DATA_MODULE_FILE}`;
