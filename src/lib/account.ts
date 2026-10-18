// "Delete my account" (Settings → Account): what the site keeps about the
// account signed in, and deleting all of it. The server's part is the
// Worker's (worker/account.js: shared projects, invitations, the tally,
// computers, GitHub and Overleaf, this browser's session); this file asks for
// it, then does the page's own part — the app's files in Drive when asked
// (put in Drive's trash, which keeps them thirty days), this browser's copy of
// the library and everything the app kept in it — and signs out.

import { api, apiBase, apiHeaders, currentPass } from './api';
import { deleteLibraries } from './db';
import { driveFetch, ensureDriveToken, hasAppDataAccess, liveAccessToken, signOut, trashFile } from './google';

/** What GET /account says is kept on the server about the account signed in. */
export interface AccountSummary {
  email: string;
  /** Shared projects it owns: closed for everyone in them. */
  owned: { room: string; project: string }[];
  /** Shared projects it is a member of: it leaves them. */
  joined: { room: string; project: string }[];
  /** Invitations to projects it has not taken up. */
  invited: number;
  devices: number;
  usageDays: number;
  invitationsSent: number;
  github: boolean;
  overleaf: boolean;
}

/** The summary, or null when there is no server to ask (no proxy, or not signed in to it). */
export async function readAccount(): Promise<AccountSummary | null> {
  if (!apiBase() || !currentPass()) return null;
  const response = await fetch(api('/account'), { headers: apiHeaders(), cache: 'no-store' });
  if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error || `the server answered ${response.status}`);
  return (await response.json()) as AccountSummary;
}

/**
 * The app's own files in Drive, to the trash: with `drive.file` the listing is
 * only what the app made, wherever it was moved to. Of those, the ones at the
 * top of a tree are trashed, which takes the tree with them; one owned by
 * someone else (a folder shared into this Drive) is not this account's to
 * trash and is left. The hidden app-data copies (library.json,
 * playgrounds.json) can't be trashed, only deleted, and only with that scope.
 */
async function trashDrive(token: string): Promise<number> {
  type Seen = { id: string; parents?: string[]; ownedByMe?: boolean };
  const seen: Seen[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q: 'trashed = false', fields: 'nextPageToken,files(id,parents,ownedByMe)', spaces: 'drive', pageSize: '1000' });
    if (pageToken) params.set('pageToken', pageToken);
    const page = (await (await driveFetch(token, `https://www.googleapis.com/drive/v3/files?${params}`)).json()) as { files?: Seen[]; nextPageToken?: string };
    seen.push(...(page.files ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  const ids = new Set(seen.map((file) => file.id));
  const roots = seen.filter((file) => file.ownedByMe !== false && !(file.parents ?? []).some((parent) => ids.has(parent)));
  for (const file of roots) await trashFile(token, file.id);
  if (hasAppDataAccess()) {
    const params = new URLSearchParams({ q: 'trashed = false', fields: 'files(id)', spaces: 'appDataFolder', pageSize: '1000' });
    const hidden = ((await (await driveFetch(token, `https://www.googleapis.com/drive/v3/files?${params}`)).json()) as { files?: { id: string }[] }).files ?? [];
    for (const file of hidden) await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
  }
  return roots.length;
}

/** Every key this app keeps in the browser's storage: they all start `reader.`. */
function clearStorage(storage: Storage): void {
  for (const key of Object.keys(storage)) if (key.startsWith('reader.')) storage.removeItem(key);
}

/**
 * Deletes the account: Drive first when asked (it needs the Google token that
 * signing out revokes), then the server's part, then this browser's, then signs
 * out and starts the page again. Throws, having deleted nothing more, when a
 * step that comes before the others fails.
 */
export async function deleteAccount({ email, googleClientId, trashDriveFiles }: { email: string; googleClientId: string; trashDriveFiles: boolean }): Promise<void> {
  // Trashing needs the Drive scope on the token; proving the account to the server needs any live one.
  const token = trashDriveFiles ? await ensureDriveToken(googleClientId) : (liveAccessToken() ?? (await ensureDriveToken(googleClientId)));
  if (trashDriveFiles) await trashDrive(token);
  if (apiBase() && currentPass()) {
    const response = await fetch(api('/account'), { method: 'DELETE', headers: apiHeaders({ 'X-Google-Token': token }) });
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error || `the server answered ${response.status}`);
  }
  const claimedGuest = (localStorage.getItem('reader.guest.claimedBy') || '').toLowerCase() === email.toLowerCase();
  await deleteLibraries(email, claimedGuest);
  // Cleared now, and again as the page goes: whatever the app writes back in the moment before it unloads goes too.
  const clear = () => {
    clearStorage(localStorage);
    clearStorage(sessionStorage);
  };
  window.addEventListener('pagehide', clear);
  signOut();
  clear();
  window.location.replace(new URL(import.meta.env.BASE_URL || '/', window.location.origin).toString());
}
