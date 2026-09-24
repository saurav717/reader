/**
 * Google sign-in and Drive, entirely in the browser via Google Identity
 * Services. There is no backend, so nothing here can hold a refresh token:
 * the access token Google hands out lasts about an hour, and is re-requested
 * on the grant already given when it expires.
 *
 * For that hour it is kept in `localStorage`, beside who it belongs to, so a
 * reload or a reopened tab is still signed in rather than starting over at
 * the connect screen. It goes when it expires, when Drive refuses it, and on
 * sign-out — which also revokes it.
 *
 * Sign-in asks only for identity. Drive is a second, incremental consent for
 * `drive.file` — the app can only ever see files it created itself.
 *
 * Everything a click reaches is synchronous once the GIS script is in the page:
 * a browser only opens a popup for a window that still has the user's gesture,
 * and awaiting a script download in between spends it. So the script is
 * fetched ahead of time (see `prepare`) and the request itself never awaits.
 */
import type { GoogleUser } from '../types';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const IDENTITY_SCOPES = 'openid email profile';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  requestAccessToken: (overrides?: { prompt?: string }) => void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            prompt?: string;
            callback: (response: TokenResponse) => void;
            error_callback?: (error: { type?: string; message?: string }) => void;
          }) => TokenClient;
          revoke: (token: string, done?: () => void) => void;
        };
      };
    };
  }
}

let scriptPromise: Promise<void> | null = null;

/** True once `window.google.accounts.oauth2` is there to be called. */
export function googleReady(): boolean {
  return Boolean(window.google?.accounts?.oauth2);
}

export function loadGoogleScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    if (googleReady()) return resolve();
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => {
      // A script element runs once; a failed one would never load again, so it
      // goes, and with the cached promise cleared the next click can retry.
      script.remove();
      scriptPromise = null;
      reject(new Error('Could not load Google Identity Services — check the network, or an ad blocker.'));
    });
    if (!existing) {
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });
  return scriptPromise;
}

/**
 * Warm the script up before anyone clicks. Failure is not reported: the click
 * loads it again and says so then, when there is somewhere to say it.
 */
export function prepare(): void {
  void loadGoogleScript().catch(() => undefined);
}

interface StoredToken {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
  /** Whose it is, once the profile has been read; kept so a reload need not ask again. */
  user?: GoogleUser;
}

const SESSION_KEY = 'reader.google.session';

/**
 * The session the last page load left behind, if it is still live. Anything
 * malformed or expired is cleared rather than trusted. Storage may be missing
 * or refused (a private window, a test), and then there is simply nothing.
 */
function readSession(): StoredToken | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredToken>;
    const live =
      typeof parsed.accessToken === 'string' &&
      typeof parsed.expiresAt === 'number' &&
      Array.isArray(parsed.scopes) &&
      parsed.expiresAt > Date.now();
    if (!live) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return parsed as StoredToken;
  } catch {
    return null;
  }
}

function writeSession(next: StoredToken | null): void {
  try {
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing to do: the session then lasts the page load, as it used to.
  }
}

let token: StoredToken | null = readSession();

function setToken(next: StoredToken | null): void {
  token = next;
  writeSession(next);
}

/** Drop a token Google or Drive no longer honours, so the next need asks afresh. */
function forgetToken(): void {
  setToken(null);
}

/** The person the restored session belongs to, for a page that has just loaded. */
export function restoredUser(): GoogleUser | null {
  return token && token.expiresAt > Date.now() ? (token.user ?? null) : null;
}

/**
 * The one thing to do about a consent screen that is still in Testing. It is
 * said twice because Google refuses such an account in two different ways: with
 * an `access_denied` it hands back, and with a page in the popup it hands back
 * nothing for — the block page is the end of that window, so all the app ever
 * learns is that the window closed.
 */
const TESTING_ADVICE =
  'add this Google account under Test users on the OAuth consent screen of the Cloud project the client ID belongs to — or publish that app, which a drive.file-only app can do without review.';

/** What Google's own wording means, said in terms of this app. */
function describe(type: string | undefined, message: string | undefined, description?: string): string {
  switch (type) {
    case 'popup_failed_to_open':
      return 'The browser blocked the Google sign-in window. Allow pop-ups for this site and try again.';
    case 'popup_closed':
      return `The Google window was closed before sign-in finished. If it said the app has not completed verification, ${TESTING_ADVICE}`;
    default:
      break;
  }
  if (message === 'access_denied' || description === 'access_denied') {
    return `Google refused the sign-in. If it said the app has not completed verification, ${TESTING_ADVICE}`;
  }
  return description || message || 'Authorisation was cancelled';
}

function requestToken(clientId: string, scope: string, prompt: string): Promise<StoredToken> {
  return new Promise((resolve, reject) => {
    if (!googleReady()) {
      reject(new Error('Google Identity Services is not available'));
      return;
    }
    const client = window.google?.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope,
      prompt,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(describe(undefined, response.error, response.error_description)));
          return;
        }
        const next: StoredToken = {
          accessToken: response.access_token,
          expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000 - 60_000,
          scopes: (response.scope || scope).split(' '),
          // A renewal is for the same person; a first sign-in learns who below.
          user: token?.user,
        };
        setToken(next);
        resolve(next);
      },
      error_callback: (error) => reject(new Error(describe(error.type, error.message))),
    });
    if (!client) {
      reject(new Error('Google Identity Services is not available'));
      return;
    }
    client.requestAccessToken();
  });
}

/**
 * Ask for a token, loading the script first only if it is not there yet. The
 * fast path runs inside the click that started it, which is what keeps the
 * popup from being blocked.
 */
function tokenFor(clientId: string, scope: string, prompt: string): Promise<StoredToken> {
  if (googleReady()) return requestToken(clientId, scope, prompt);
  return loadGoogleScript().then(() => requestToken(clientId, scope, prompt));
}

export function currentScopes(): string[] {
  return token && token.expiresAt > Date.now() ? token.scopes : [];
}

export function hasDriveAccess(): boolean {
  return currentScopes().includes(DRIVE_SCOPE);
}

async function fetchProfile(accessToken: string): Promise<GoogleUser> {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Could not read your Google profile (${response.status})`);
  const payload = (await response.json()) as { name?: string; email?: string; picture?: string };
  const user: GoogleUser = {
    name: payload.name || payload.email || 'Signed in',
    email: payload.email || '',
    picture: payload.picture,
  };
  // The token this profile was read with is the one to remember it against; a
  // token that changed underneath (a sign-out mid-request) is left alone.
  if (token && token.accessToken === accessToken) setToken({ ...token, user });
  return user;
}

export function signIn(clientId: string): Promise<GoogleUser> {
  return tokenFor(clientId, IDENTITY_SCOPES, '').then((granted) => fetchProfile(granted.accessToken));
}

/**
 * Incremental consent: keeps identity, adds Drive.
 *
 * `quiet` is for the visitor who has granted this before. No refresh token can
 * be kept in a page with no backend, so every visit reconnects; an empty prompt
 * lets Google honour the existing grant and close its window again without
 * asking the same question weekly. It still opens that window — a grant is only
 * reusable while the browser has a Google session — so it, too, has to happen
 * inside a click.
 */
export function connectDrive(clientId: string, quiet = false): Promise<GoogleUser> {
  return tokenFor(clientId, `${IDENTITY_SCOPES} ${DRIVE_SCOPE}`, quiet ? '' : 'consent').then((granted) => {
    if (!granted.scopes.includes(DRIVE_SCOPE)) throw new Error('Drive access was not granted');
    return fetchProfile(granted.accessToken);
  });
}

export async function ensureDriveToken(clientId: string): Promise<string> {
  if (token && token.expiresAt > Date.now() && token.scopes.includes(DRIVE_SCOPE)) return token.accessToken;
  // An empty prompt reuses the existing grant without showing the dialog again.
  const granted = await tokenFor(clientId, `${IDENTITY_SCOPES} ${DRIVE_SCOPE}`, '');
  if (!granted.scopes.includes(DRIVE_SCOPE)) throw new Error('Drive access was not granted');
  return granted.accessToken;
}

export function signOut(): void {
  const active = token?.accessToken;
  forgetToken();
  if (active) window.google?.accounts.oauth2.revoke(active);
}

// ------------------------------------------------------------------ Drive ---

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * A refusal from Drive, with the status kept where a caller can read it: a
 * 404 on a file the app remembers means someone deleted it in Drive by hand,
 * which is not the same thing as Drive being unreachable.
 */
export class DriveRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DriveRequestError';
  }
}

async function driveFetch(accessToken: string, url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers || {}) },
  });
  if (!response.ok) {
    // A token Drive no longer accepts is not worth keeping: forgotten, the
    // next call asks Google for another on the grant that still stands.
    if (response.status === 401 && token?.accessToken === accessToken) forgetToken();
    const detail = await response.text().catch(() => '');
    throw new DriveRequestError(
      response.status,
      `Drive request failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    );
  }
  return response;
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * The id of a folder by name under a parent (the top of Drive when none is
 * given), or null when there is no such folder. A look and nothing more: the
 * reader asks this before opening a paper, to see whether Drive already holds
 * it, and a look must not leave folders behind for papers that were never
 * saved.
 */
export async function findFolder(accessToken: string, name: string, parentId?: string): Promise<string | null> {
  const clauses = [
    `name = '${escapeQuery(name)}'`,
    `mimeType = '${FOLDER_MIME}'`,
    'trashed = false',
    parentId ? `'${escapeQuery(parentId)}' in parents` : "'root' in parents",
  ];
  const params = new URLSearchParams({ q: clauses.join(' and '), fields: 'files(id,name)', spaces: 'drive', pageSize: '1' });
  const found = (await (await driveFetch(accessToken, `https://www.googleapis.com/drive/v3/files?${params}`)).json()) as {
    files: { id: string }[];
  };
  return found.files?.[0]?.id ?? null;
}

export async function ensureFolder(accessToken: string, name: string, parentId?: string): Promise<string> {
  const existing = await findFolder(accessToken, name, parentId);
  if (existing) return existing;

  const created = (await (
    await driveFetch(accessToken, 'https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: parentId ? [parentId] : undefined }),
    })
  ).json()) as { id: string };
  return created.id;
}

export interface DriveFile {
  id: string;
  name: string;
  webViewLink?: string;
  /** When Drive last saw the file change (RFC 3339), where it was asked for. */
  modifiedTime?: string;
}

export async function findFile(accessToken: string, name: string, parentId: string): Promise<DriveFile | null> {
  const params = new URLSearchParams({
    q: `name = '${escapeQuery(name)}' and '${escapeQuery(parentId)}' in parents and trashed = false`,
    fields: 'files(id,name,webViewLink,modifiedTime)',
    spaces: 'drive',
    pageSize: '1',
  });
  const payload = (await (await driveFetch(accessToken, `https://www.googleapis.com/drive/v3/files?${params}`)).json()) as {
    files: DriveFile[];
  };
  return payload.files?.[0] ?? null;
}

/**
 * Every file of one type directly inside a folder — the app's own only, since
 * `drive.file` shows it nothing else. Used when a paper's PDF is replaced, to
 * find any earlier copy that is still sitting beside the new one.
 */
export async function listFiles(accessToken: string, parentId: string, mimeType: string): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q: `'${escapeQuery(parentId)}' in parents and mimeType = '${escapeQuery(mimeType)}' and trashed = false`,
    fields: 'files(id,name,webViewLink)',
    spaces: 'drive',
    pageSize: '100',
  });
  const payload = (await (await driveFetch(accessToken, `https://www.googleapis.com/drive/v3/files?${params}`)).json()) as {
    files: DriveFile[];
  };
  return payload.files ?? [];
}

/**
 * Puts a file the app owns in Drive's trash — not deleted: Drive keeps it
 * there for thirty days, and it can be restored from the trash in that time.
 */
export async function trashFile(accessToken: string, fileId: string): Promise<void> {
  await driveFetch(accessToken, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}

/**
 * Re-parents a file the app owns — or a folder, which to Drive is a file with
 * a folder's MIME type, so moving a paper's whole folder is this one request.
 * Used when the layout in Drive changes under a library that is already
 * synced, and when a paper is removed: the file is moved rather than
 * downloaded and uploaded again, so nothing crosses the network but the
 * request itself.
 */
export async function moveFile(accessToken: string, fileId: string, parentId: string): Promise<DriveFile> {
  const id = encodeURIComponent(fileId);
  const current = (await (
    await driveFetch(accessToken, `https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,webViewLink,parents`)
  ).json()) as DriveFile & { parents?: string[] };

  const parents = current.parents ?? [];
  if (parents.length === 1 && parents[0] === parentId) return current;

  const params = new URLSearchParams({ addParents: parentId, fields: 'id,name,webViewLink' });
  const stale = parents.filter((parent) => parent !== parentId);
  if (stale.length) params.set('removeParents', stale.join(','));
  const moved = await driveFetch(accessToken, `https://www.googleapis.com/drive/v3/files/${id}?${params}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return (await moved.json()) as DriveFile;
}

/**
 * The bytes of a file the app put in Drive. Google's API sends CORS headers, so
 * unlike the sites the papers come from this one the browser can read directly
 * — which is the whole point: a paper already in Drive needs no proxy.
 */
/** A text file the app put in Drive, as text. */
export async function downloadText(accessToken: string, fileId: string, signal?: AbortSignal): Promise<string> {
  const response = await driveFetch(accessToken, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { signal });
  return response.text();
}

export async function downloadFile(accessToken: string, fileId: string, signal?: AbortSignal): Promise<Blob> {
  const response = await driveFetch(
    accessToken,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    { signal },
  );
  const blob = await response.blob();
  // Drive reports what it was given; the viewer only renders a blob that says PDF.
  return blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
}

export async function uploadFile(
  accessToken: string,
  options: { name: string; mimeType: string; parentId: string; body: Blob | string; fileId?: string },
): Promise<DriveFile> {
  const metadata: Record<string, unknown> = { name: options.name, mimeType: options.mimeType };
  if (!options.fileId) metadata.parents = [options.parentId];
  // A file rewritten in place may have been put in the trash by hand since;
  // writing to it there would leave the new bytes where nobody looks.
  else metadata.trashed = false;

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', typeof options.body === 'string' ? new Blob([options.body], { type: options.mimeType }) : options.body);

  const url = options.fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${options.fileId}?uploadType=multipart&fields=id,name,webViewLink,modifiedTime`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,modifiedTime';

  const response = await driveFetch(accessToken, url, { method: options.fileId ? 'PATCH' : 'POST', body: form });
  return (await response.json()) as DriveFile;
}
