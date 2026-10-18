// "Delete my account" (Settings → Account): what the site keeps about the
// account signed in, and deleting all of it. The server's part is the
// Worker's (worker/account.js: shared projects, invitations, the tally,
// computers, GitHub and Overleaf, this browser's session); this file asks for
// it, then does the page's own part — the app's files in Drive when asked
// (put in Drive's trash, which keeps them thirty days), this browser's copy of
// the library and everything the app kept in it — and signs out.

import { api, apiBase, apiHeaders, currentPass } from './api';
import { deleteLibraries } from './db';
import { driveFetch, ensureDriveToken, liveAccessToken, queryFiles, signOut, trashFile } from './google';

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

/** The app's own files in Drive: with `drive.file` and `drive.appdata` these queries see only what the app made. */
async function trashDrive(token: string): Promise<number> {
  const top = await queryFiles(token, "'root' in parents");
  for (const file of top) await trashFile(token, file.id);
  // The hidden app-data copies (library.json, playgrounds.json) can't be trashed, only deleted.
  const params = new URLSearchParams({ q: 'trashed = false', fields: 'files(id)', spaces: 'appDataFolder', pageSize: '1000' });
  const hidden = ((await (await driveFetch(token, `https://www.googleapis.com/drive/v3/files?${params}`)).json()) as { files?: { id: string }[] }).files ?? [];
  for (const file of hidden) await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
  return top.length;
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
  const token = liveAccessToken() ?? (await ensureDriveToken(googleClientId));
  if (trashDriveFiles) await trashDrive(token);
  if (apiBase() && currentPass()) {
    const response = await fetch(api('/account'), { method: 'DELETE', headers: apiHeaders({ 'X-Google-Token': token }) });
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error || `the server answered ${response.status}`);
  }
  const claimedGuest = (localStorage.getItem('reader.guest.claimedBy') || '').toLowerCase() === email.toLowerCase();
  await deleteLibraries(email, claimedGuest);
  signOut();
  clearStorage(localStorage);
  clearStorage(sessionStorage);
  window.location.replace(new URL(import.meta.env.BASE_URL || '/', window.location.origin).toString());
}
