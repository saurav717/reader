/**
 * A folder on one of your computers, attached on another as a disk of its own
 * (companion/reader_companion/attach.py, mount.share_folder; Companion 0.20.0).
 *
 * The page asks the computer with the folder to share it (companion/share): it
 * answers the address of its mount socket, through its Cloudflare tunnel, and a
 * key that opens that folder and nothing else. The page hands both to the other
 * computer's Companion (companion/attach), which mounts it: FUSE where a driver
 * is installed (FUSE-T, WinFsp, libfuse), else the system's own network-drive
 * client over WebDAV on 127.0.0.1. The files never pass through the page.
 */

/** The first Companion that shares folders and attaches them. */
export const ATTACH_VERSION = '0.20.0';

export type AttachCache = 'used' | 'all' | 'none';

export interface Shared {
  root: string;
  name: string;
  at?: number;
  /** How many computers have it attached now. */
  attached: number;
  there: boolean;
}

export interface MadeShare {
  url: string;
  key: string;
  name: string;
  root: string;
  computer: string;
  /** The same, as one word for `reader-companion attach`. */
  code: string;
}

export interface Attachment {
  id: string;
  label?: string;
  name?: string;
  from?: string;
  cache?: AttachCache;
  backend?: 'fuse' | 'webdav';
  where?: string;
  running: boolean;
  mounted: boolean;
  connected?: boolean;
  error?: string | null;
  cachedFiles?: number;
  waitingToWrite?: number;
}

export interface Backends {
  os: 'mac' | 'windows' | 'linux';
  fuse: { ok: boolean; why: string; driver: string };
  webdav: { ok: boolean; why: string };
}

type Server = { url: string; token: string };

async function call<T>(server: Server, route: 'share' | 'attach', body?: object): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${server.url.replace(/\/?$/, '/')}companion/${route}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `token ${server.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new Error('That computer’s Companion didn’t answer. Is it on?');
  }
  const answer = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (response.status === 404) throw new Error(`That computer’s Companion is older than ${ATTACH_VERSION}: update it in Settings → Updates.`);
  if (!response.ok) throw new Error(answer.error || `The Companion answered ${response.status}.`);
  return answer;
}

export const listShares = (server: Server) => call<{ shares: Shared[]; computer: string }>(server, 'share');
export const shareFolder = (server: Server, path: string, name = '') => call<MadeShare>(server, 'share', { path, name });
export const stopSharing = (server: Server, path: string) => call<{ stopped: boolean; shares: Shared[] }>(server, 'share', { path, action: 'stop' });

export const listAttached = (server: Server) => call<{ attached: Attachment[]; backends: Backends; computer: string }>(server, 'attach');
export const attachShare = (server: Server, share: Pick<MadeShare, 'url' | 'key' | 'name' | 'computer'>, cache: AttachCache = 'used') =>
  call<Attachment>(server, 'attach', { url: share.url, key: share.key, name: share.name, from: share.computer, cache });
export const detach = (server: Server, id: string) => call<{ stopped: boolean; attached: Attachment[] }>(server, 'attach', { action: 'detach', id });
export const installDriver = (server: Server) => call<{ opened: boolean; path?: string; how?: string; name: string }>(server, 'attach', { action: 'install-driver' });

/** One folder of `from`, attached on `to`: shared there (or its share reused), then mounted here. */
export async function attachFolder(from: Server, to: Server, path: string, cache: AttachCache = 'used', name = ''): Promise<Attachment> {
  const share = await shareFolder(from, path, name);
  return attachShare(to, share, cache);
}

/** Where it is, in words: "~/Koios Drives/Thesis on Laptop" → as the system shows it. */
export function attachedWords(item: Attachment): string {
  const state = item.mounted ? (item.connected === false ? 'attached, the other computer away' : 'attached') : item.running ? 'starting' : 'stopped';
  return `${state}${item.where ? ` at ${item.where}` : ''}${item.backend ? ` (${item.backend === 'fuse' ? 'driver' : 'network drive'})` : ''}`;
}
