/**
 * Google sign-in and Drive, entirely in the browser via Google Identity
 * Services. There is no backend, so nothing here can hold a refresh token:
 * access tokens live in memory for the session and are re-requested silently
 * when they expire.
 *
 * Sign-in asks only for identity. Drive is a second, incremental consent for
 * `drive.file` — the app can only ever see files it created itself.
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

export function loadGoogleScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    const script = existing ?? document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => reject(new Error('Could not load Google Identity Services')));
    if (!existing) document.head.appendChild(script);
  });
  return scriptPromise;
}

interface StoredToken {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
}

let token: StoredToken | null = null;

function requestToken(clientId: string, scope: string, prompt: string): Promise<StoredToken> {
  return new Promise((resolve, reject) => {
    const client = window.google?.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope,
      prompt,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error_description || response.error || 'Authorisation was cancelled'));
          return;
        }
        const next: StoredToken = {
          accessToken: response.access_token,
          expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000 - 60_000,
          scopes: (response.scope || scope).split(' '),
        };
        token = next;
        resolve(next);
      },
      error_callback: (error) => reject(new Error(error.message || 'Authorisation was cancelled')),
    });
    if (!client) {
      reject(new Error('Google Identity Services is not available'));
      return;
    }
    client.requestAccessToken();
  });
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
  return { name: payload.name || payload.email || 'Signed in', email: payload.email || '', picture: payload.picture };
}

export async function signIn(clientId: string): Promise<GoogleUser> {
  await loadGoogleScript();
  const granted = await requestToken(clientId, IDENTITY_SCOPES, '');
  return fetchProfile(granted.accessToken);
}

/** Incremental consent: keeps identity, adds Drive. */
export async function connectDrive(clientId: string): Promise<GoogleUser> {
  await loadGoogleScript();
  const granted = await requestToken(clientId, `${IDENTITY_SCOPES} ${DRIVE_SCOPE}`, 'consent');
  return fetchProfile(granted.accessToken);
}

export async function ensureDriveToken(clientId: string): Promise<string> {
  if (token && token.expiresAt > Date.now() && token.scopes.includes(DRIVE_SCOPE)) return token.accessToken;
  await loadGoogleScript();
  // An empty prompt reuses the existing grant without showing the dialog again.
  const granted = await requestToken(clientId, `${IDENTITY_SCOPES} ${DRIVE_SCOPE}`, '');
  if (!granted.scopes.includes(DRIVE_SCOPE)) throw new Error('Drive access was not granted');
  return granted.accessToken;
}

export function signOut(): void {
  const active = token?.accessToken;
  token = null;
  if (active) window.google?.accounts.oauth2.revoke(active);
}

// ------------------------------------------------------------------ Drive ---

const FOLDER_MIME = 'application/vnd.google-apps.folder';

async function driveFetch(accessToken: string, url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers || {}) },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Drive request failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  return response;
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function ensureFolder(accessToken: string, name: string, parentId?: string): Promise<string> {
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
  if (found.files?.length) return found.files[0].id;

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
}

export async function findFile(accessToken: string, name: string, parentId: string): Promise<DriveFile | null> {
  const params = new URLSearchParams({
    q: `name = '${escapeQuery(name)}' and '${escapeQuery(parentId)}' in parents and trashed = false`,
    fields: 'files(id,name,webViewLink)',
    spaces: 'drive',
    pageSize: '1',
  });
  const payload = (await (await driveFetch(accessToken, `https://www.googleapis.com/drive/v3/files?${params}`)).json()) as {
    files: DriveFile[];
  };
  return payload.files?.[0] ?? null;
}

export async function uploadFile(
  accessToken: string,
  options: { name: string; mimeType: string; parentId: string; body: Blob | string; fileId?: string },
): Promise<DriveFile> {
  const metadata: Record<string, unknown> = { name: options.name, mimeType: options.mimeType };
  if (!options.fileId) metadata.parents = [options.parentId];

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', typeof options.body === 'string' ? new Blob([options.body], { type: options.mimeType }) : options.body);

  const url = options.fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${options.fileId}?uploadType=multipart&fields=id,name,webViewLink`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink';

  const response = await driveFetch(accessToken, url, { method: options.fileId ? 'PATCH' : 'POST', body: form });
  return (await response.json()) as DriveFile;
}
