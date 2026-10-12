// The GitHub token, kept by Reader's server (worker/github.js) rather than in
// this browser: sealed there for this person alone, never sent back to the
// page. Settings carry only ON_SERVER in its place, and every GitHub call
// Reader makes goes through the server, which puts the token on it.
//
// A token typed before this, kept in the browser's settings, is moved to the
// server once it can take it (useMoveGitHubToken), and removed from here.

import { api, apiFetch } from './api';

/** What Settings → githubToken holds once the token is on the server. */
export const ON_SERVER = 'server';

const GITHUB = 'https://api.github.com';

/** How the person connected: GitHub's sign-in for an OAuth App, Reader's GitHub App, or a pasted token. */
export type GitHubVia = 'oauth' | 'app' | 'token';

/** The sign-ins Reader's server offers (an OAuth App, a GitHub App); a pasted token always works. */
export interface GitHubMethods {
  oauth: boolean;
  app: boolean;
  /** The GitHub App's name in its address (github.com/apps/<slug>): where its repositories are chosen. */
  appSlug: string | null;
}

export interface GitHubStatus {
  connected: boolean;
  login?: string;
  via?: GitHubVia;
  /** fine-grained (github_pat_…), classic (ghp_…), an OAuth App's, or a GitHub App's. */
  kind?: 'fine-grained' | 'classic' | 'oauth' | 'app';
  /** Renewed by the server (a GitHub App's eight-hour token): expiresAt is when renewing stops. */
  renews?: boolean;
  methods?: GitHubMethods;
  /** A classic token's scopes, as GitHub says them ("repo, workflow"). */
  scopes?: string | null;
  /** When GitHub says it expires; null: never. */
  expiresAt?: string | null;
  addedAt?: string;
  lastUsedAt?: string | null;
  /** Forgotten by the server just now: expired, or unused half a year. */
  forgotten?: 'expired' | 'unused';
}

/** Reader's server can't keep the token (no Worker, or one without SECRETS_KEY): said, so the page can offer what is left. */
export class NoTokenServer extends Error {}

async function answer(response: Response): Promise<GitHubStatus> {
  const body = (await response.json().catch(() => ({}))) as GitHubStatus & { error?: string };
  if (response.status === 404 || response.status === 501) throw new NoTokenServer(body.error || 'Reader’s server can’t keep a GitHub token.');
  if (!response.ok) throw new Error(body.error || `Reader’s server answered ${response.status}.`);
  return body;
}

export async function githubStatus(): Promise<GitHubStatus> {
  return answer(await apiFetch('/github/token', { cache: 'no-store' }));
}

/** The token to Reader's server: checked with GitHub there, then kept sealed. */
export async function keepGitHubToken(token: string): Promise<GitHubStatus> {
  let response: Response;
  try {
    response = await apiFetch('/github/token', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  } catch {
    throw new NoTokenServer('Reader’s server couldn’t be reached.');
  }
  return answer(response);
}

/**
 * Sign in with GitHub (`oauth`) or through Reader's GitHub App (`app`), in a
 * window of its own, as VS Code does: GitHub asks the person, sends them back
 * to Reader's server, which keeps the token and tells this page. The window
 * is opened in the click (a browser allows one only then) and pointed at
 * GitHub once the server says where. Resolves with the account's status.
 */
export function signInWithGitHub(via: 'oauth' | 'app'): Promise<GitHubStatus> {
  const width = 600;
  const height = 760;
  const left = Math.max(0, (window.screenX ?? 0) + ((window.outerWidth ?? width) - width) / 2);
  const top = Math.max(0, (window.screenY ?? 0) + ((window.outerHeight ?? height) - height) / 2);
  const popup = window.open('about:blank', 'reader-github', `popup,width=${width},height=${height},left=${left},top=${top}`);
  return new Promise<GitHubStatus>((resolve, reject) => {
    let done = false;
    const server = new URL(api('/'), window.location.href).origin;
    const finish = (outcome: () => Promise<GitHubStatus>) => {
      if (done) return;
      done = true;
      window.removeEventListener('message', heard);
      window.clearInterval(watch);
      outcome().then(resolve, reject);
    };
    // Only Reader's server's page may say how it went.
    const heard = (event: MessageEvent) => {
      if (event.origin !== server || (event.data as { type?: string } | null)?.type !== 'reader-github') return;
      const said = event.data as { ok: boolean; error?: string };
      finish(() => (said.ok ? githubStatus() : Promise.reject(new Error(said.error || 'GitHub sign-in didn’t finish.'))));
    };
    window.addEventListener('message', heard);
    // Closed without a word (the person closed it, or a browser kept the message from coming): asked once more.
    const watch = window.setInterval(() => {
      if (popup && !popup.closed) return;
      finish(() => githubStatus().then((status) => (status.connected ? status : Promise.reject(new Error('The GitHub window was closed before the sign-in finished.')))));
    }, 800);
    apiFetch('/github/oauth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ via }) })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
        if (!response.ok || !body.url) throw new Error(body.error || `Reader’s server answered ${response.status}.`);
        if (!popup) throw new Error('The browser blocked the GitHub window: allow pop-ups for this site, then try again.');
        popup.location.href = body.url;
      })
      .catch((error: unknown) => {
        popup?.close();
        finish(() => Promise.reject(error instanceof Error ? error : new Error(String(error))));
      });
  });
}

export async function forgetGitHubToken(): Promise<void> {
  await apiFetch('/github/token', { method: 'DELETE' }).catch(() => undefined);
}

/**
 * A GitHub API call: through Reader's server with the token it keeps, or —
 * for a token still in this browser — straight to GitHub with it.
 */
export function githubFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  // Through Reader's server: it puts GitHub's own headers on the call. Only Content-Type goes from here — any
  // other header makes the browser ask the server first (CORS), and one it doesn't allow blocks the call outright.
  if (token === ON_SERVER) return apiFetch(`/github/api${path}`, { ...init, headers: init.body ? { 'Content-Type': 'application/json' } : {} });
  return fetch(`${GITHUB}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...headers } });
}
