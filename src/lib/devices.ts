/**
 * Your computers, by Google account.
 *
 * A Reader Companion paired by a page signed in with Google is claimed for
 * that account (companion/reader_companion/account.py): it changes its token,
 * opens its HTTPS tunnel, and keeps the account's list on the Worker current
 * (worker/devices.js) — its address and its token, never its files, which stay
 * on that computer. Every browser signed in as the account reads the list and
 * shows those computers under Your compute, on this computer through its own
 * 127.0.0.1 and on any other through the tunnel. A browser signed in as
 * someone else doesn't get them, and the Companion won't pair with it.
 */

import type { JupyterServer } from './colab';
import { api, apiBase, apiHeaders, currentAccount, currentPass } from './api';
import { ACCOUNTS, claimCompanion, companionPort, findCompanion, findLocalCompanion, isNewer, isSafari, pairCompanion } from './companion';
import { allServers, saveCompanion, saveServer, removeServer } from './playground';

export interface Device {
  id: string;
  name: string;
  hardware?: string;
  version?: string;
  root?: string;
  /** Its tunnel: how another computer reaches it. */
  url?: string;
  /** Its address on its own computer. */
  local?: string;
  token?: string;
  seen?: number;
  off?: boolean;
  online?: boolean;
}

/** The Worker's address, absolute, for the Companion to call (it can't use the page's relative /api). */
const absoluteApi = () => {
  const base = apiBase();
  return base ? new URL(base, window.location.href).href.replace(/\/$/, '') : null;
};

/** The signed-in account's computers, or null when there is no list to read (signed out, or a Worker without DEVICES). */
export async function listDevices(): Promise<Device[] | null> {
  if (!currentPass() || !apiBase()) return null;
  try {
    const response = await fetch(api('/devices'), { headers: apiHeaders(), cache: 'no-store' });
    if (!response.ok) return null;
    const body = (await response.json()) as { devices?: Device[] };
    return Array.isArray(body.devices) ? body.devices : null;
  } catch {
    return null;
  }
}

/** Takes a computer off the account's list (its Companion puts it back when it next says where it is, until released). */
export async function forgetDevice(id: string): Promise<void> {
  await fetch(api('/devices/forget'), { method: 'POST', headers: apiHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ id }) }).catch(() => undefined);
}

/**
 * Connects a just-paired Companion to the signed-in account, and keeps the new
 * token it answers with. Signed out, or with a Companion from before accounts,
 * the pairing stays this browser's alone: the reason comes back, for a note.
 */
export async function claimForAccount(server: JupyterServer): Promise<{ server: JupyterServer; problem?: string }> {
  const pass = currentPass();
  const apiAt = absoluteApi();
  if (!pass) return { server, problem: 'Sign in with Google to have this computer under your account in every browser you sign in to.' };
  if (!apiAt) return { server, problem: 'This site has no Worker to keep your computers on.' };
  // An older Companion has no /companion/claim, and its answer to the browser's check before the request
  // carries no CORS headers, so the request fails as if nothing answered: ask its version first.
  const info = await findCompanion(server.url, 4000);
  if (!info) return { server, problem: 'The Companion isn’t answering. Open the Reader app on that computer, or start it again.' };
  if (isNewer(ACCOUNTS, info.version)) return { server, problem: `This Companion is ${info.version}; connecting it to your account needs ${ACCOUNTS}. Update it in Settings → Updates (or open the newest Reader app), then try again.` };
  try {
    const claimed = await claimCompanion(server, pass, apiAt);
    return { server: saveServer({ ...server, token: claimed.token, account: claimed.email }) };
  } catch (error) {
    return { server, problem: error instanceof Error ? error.message : String(error) };
  }
}

/** Pairs with the Companion at `base` with its code (as the signed-in account, when there is one), then claims it for that account. */
export async function pairForAccount(code: string, base: string): Promise<{ server: JupyterServer; problem?: string }> {
  const saved = saveCompanion(await pairCompanion(code, base, currentPass()), base);
  return claimForAccount(saved);
}

let syncing: Promise<void> | null = null;

/**
 * Brings the signed-in account's computers into this browser's list: the one
 * this page runs on at its 127.0.0.1, the others at their tunnels. One taken
 * off the account's list goes from here too. Nothing when signed out.
 */
export function syncDevices(): Promise<void> {
  syncing ??= (async () => {
    const account = currentAccount();
    const devices = account ? await listDevices() : null;
    if (!account || !devices) return;
    const here = await findLocalCompanion(undefined, 1200);
    for (const device of devices) {
      if (!device.token) continue;
      const same = allServers().find((server) => server.companionId === device.id && (!server.account || server.account === account));
      // This computer's own Companion keeps its 127.0.0.1 address, also while it is off.
      // (Not a plain-http one in Safari, which never reaches http://127.0.0.1 from this https page: the tunnel then.)
      const keep = same?.where === 'pc' && companionPort(same.url) !== null && (!isSafari() || same.url.startsWith('https:'));
      const local = here?.info.id === device.id ? here.base : keep && same ? same.url : null;
      const url = local ?? device.url ?? device.local;
      if (!url) continue;
      saveServer({ id: same?.id ?? `device-${device.id}`, name: device.name, where: local ? 'pc' : 'remote', url, token: device.token, companionId: device.id, root: device.root || same?.root, account, seen: device.seen });
    }
    const listed = new Set(devices.map((device) => device.id));
    for (const server of allServers()) if (server.account === account && server.companionId && !listed.has(server.companionId)) removeServer(server.id);
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}
