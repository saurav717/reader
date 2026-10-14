// Invitations that need no link in hand (docs/live-collaboration.md): a
// personal link with your name and a note, `?invite=<token>`, what it says
// to whoever opens it, the projects waiting for you, and the message for
// your own mail app. The ledger is worker/invites.js.

import { apiFetch, currentPass, onProxyChange } from './api';
import { ownerFetch } from './owner';
import type { Role } from './presence';

export interface InviteLink {
  token: string;
  url: string;
  expiresAt: number;
}

/** What a link says to whoever opens it. */
export interface Greeting {
  byName: string;
  note: string;
  expired: boolean;
}

/** A project waiting for you: invited, not yet joined. */
export interface Waiting {
  id: string;
  room: string;
  project: string;
  role: Role;
  by: string;
  byName: string;
  at: number;
}

export interface InviteTally {
  email: string;
  name: string;
  sent: { project: number; mail: number; link: number };
  converted: { project: number; mail: number; link: number };
  people: { email: string; name: string; how: 'project' | 'mail' | 'link'; project?: string; note?: string; at: number }[];
  last: number;
}

export interface InvitesReport {
  at: number;
  people: InviteTally[];
  totals: { sent: number; converted: number };
}

async function answer<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Reader’s server answered ${response.status}.`);
  return body;
}

const post = (path: string, body: unknown) => apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** A personal link to the site, with your name and note on the welcome page for whoever opens it. */
export const createInviteLink = (site: string, name: string | undefined, note: string) => post('/invites/link', { link: site, name, note }).then((response) => answer<InviteLink>(response));

/** What a link says; `open` counts the opening. No sign-in needed. */
export const linkGreeting = (token: string, open = true) => apiFetch(`/invites/link/${encodeURIComponent(token)}?open=${open ? 1 : 0}`).then((response) => answer<Greeting>(response));

/** Signed in from a link: the inviter's tally hears of it. */
export const claimInviteLink = (token: string, name: string | undefined) => post(`/invites/link/${encodeURIComponent(token)}/joined`, { name }).then((response) => answer<{ ok: true; own?: boolean }>(response));

export const waitingInvitations = () => apiFetch('/invites/inbox').then((response) => answer<{ invitations: Waiting[] }>(response)).then((body) => body.invitations);

/** The owner's tally, asked as the Usage page asks its own routes (lib/owner.ts). */
export const invitesReport = () => ownerFetch('/usage/invites').then((response) => answer<InvitesReport>(response));

/** The tag a project's invitation link carries for an address (server/mail.js, `addressTag`): the same twelve hex digits here. */
export async function addressTag(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(`reader-invite:${email.trim().toLowerCase()}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- the link this visit came from, kept until the sign-in it leads to

const INVITE_KEY = 'reader.invite';
const TOKEN = /^[a-z0-9]{6,20}$/;

/** The `?invite=` on the address as the page opened, kept for the sign-in; read again by `pendingInvite`. */
export function rememberInviteFromAddress(search = typeof window === 'undefined' ? '' : window.location.search): string | null {
  const token = new URLSearchParams(search).get('invite');
  if (!token || !TOKEN.test(token)) return pendingInvite();
  try {
    sessionStorage.setItem(INVITE_KEY, token);
  } catch {
    // kept for this page only
  }
  return token;
}

export function pendingInvite(): string | null {
  try {
    const token = sessionStorage.getItem(INVITE_KEY);
    return token && TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}

export function forgetInvite(): void {
  try {
    sessionStorage.removeItem(INVITE_KEY);
  } catch {
    // nothing kept
  }
}

/**
 * Installed once as the app starts: the `?invite=` on the address is kept, and taken up — the inviter's tally
 * told — as soon as the sign-in's pass is here (api.ts, `onProxyChange`), with the name signed in as.
 */
export function installInviteClaim(nameOf: () => string | undefined): void {
  rememberInviteFromAddress();
  const claim = () => {
    const token = pendingInvite();
    if (!token || !currentPass()) return;
    forgetInvite();
    void claimInviteLink(token, nameOf()).catch(() => undefined);
  };
  onProxyChange(claim);
  claim();
}

// ---- the message, for your own mail app

/** The invitation as plain text, for `mailto:`: what Reader is, your note, the address. The site's own mail says the same (server/mail.js). */
export function tryItText(name: string, note: string, link: string): { subject: string; body: string } {
  const said = note.trim();
  const body = [
    'Hi,',
    '',
    `I'd like to show you Reader — a reading room for research papers. Search arXiv, OpenAlex, Semantic Scholar and Crossref in one go; read with highlights and notes that stay in your own Google Drive; keep a project's papers, its code and the paper you're writing in one place; and work on it with other people.`,
    ...(said ? ['', said] : []),
    '',
    `Try it: ${link}`,
    '',
    'Sign in with Google and your library is yours, in your own Drive — nothing to install, nothing to create.',
    '',
    name ? `— ${name}` : '',
  ].join('\n');
  return { subject: `${name ? `${name} thinks you'd like` : 'Try'} Reader`, body };
}

/** A `mailto:` address that opens the mail app with the message filled in. */
export function mailtoFor(to: string, subject: string, body: string): string {
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
