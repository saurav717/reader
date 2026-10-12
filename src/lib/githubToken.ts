// The GitHub token, kept by Reader's server (worker/github.js) rather than in
// this browser: sealed there for this person alone, never sent back to the
// page. Settings carry only ON_SERVER in its place, and every GitHub call
// Reader makes goes through the server, which puts the token on it.
//
// A token typed before this, kept in the browser's settings, is moved to the
// server once it can take it (useMoveGitHubToken), and removed from here.

import { apiFetch } from './api';

/** What Settings → githubToken holds once the token is on the server. */
export const ON_SERVER = 'server';

const GITHUB = 'https://api.github.com';

export interface GitHubStatus {
  connected: boolean;
  login?: string;
  /** fine-grained (github_pat_…), classic (ghp_…), or an app's. */
  kind?: 'fine-grained' | 'classic' | 'app';
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
  if (token === ON_SERVER) return apiFetch(`/github/api${path}`, { ...init, headers });
  return fetch(`${GITHUB}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...headers } });
}
