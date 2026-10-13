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
/** Reader's server can't keep the token (no Worker, or one without SECRETS_KEY): said, so the page can offer what is left. */
export class NoTokenServer extends Error {
}
async function answer(response) {
    const body = (await response.json().catch(() => ({})));
    if (response.status === 404 || response.status === 501)
        throw new NoTokenServer(body.error || 'Reader’s server can’t keep a GitHub token.');
    if (!response.ok)
        throw new Error(body.error || `Reader’s server answered ${response.status}.`);
    return body;
}
export async function githubStatus() {
    return answer(await apiFetch('/github/token', { cache: 'no-store' }));
}
/** The token to Reader's server: checked with GitHub there, then kept sealed. */
export async function keepGitHubToken(token) {
    let response;
    try {
        response = await apiFetch('/github/token', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    }
    catch {
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
export function signInWithGitHub(via) {
    const width = 600;
    const height = 760;
    const left = Math.max(0, (window.screenX ?? 0) + ((window.outerWidth ?? width) - width) / 2);
    const top = Math.max(0, (window.screenY ?? 0) + ((window.outerHeight ?? height) - height) / 2);
    const popup = window.open('about:blank', 'reader-github', `popup,width=${width},height=${height},left=${left},top=${top}`);
    return new Promise((resolve, reject) => {
        let done = false;
        const server = new URL(api('/'), window.location.href).origin;
        const finish = (outcome) => {
            if (done)
                return;
            done = true;
            window.removeEventListener('message', heard);
            window.clearInterval(watch);
            outcome().then(resolve, reject);
        };
        // Only Reader's server's page may say how it went.
        const heard = (event) => {
            if (event.origin !== server || event.data?.type !== 'reader-github')
                return;
            const said = event.data;
            finish(() => (said.ok ? githubStatus() : Promise.reject(new Error(said.error || 'GitHub sign-in didn’t finish.'))));
        };
        window.addEventListener('message', heard);
        // Closed without a word (the person closed it, or a browser kept the message from coming): asked once more.
        const watch = window.setInterval(() => {
            if (popup && !popup.closed)
                return;
            finish(() => githubStatus().then((status) => (status.connected ? status : Promise.reject(new Error('The GitHub window was closed before the sign-in finished.')))));
        }, 800);
        apiFetch('/github/oauth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ via }) })
            .then(async (response) => {
            const body = (await response.json().catch(() => ({})));
            if (!response.ok || !body.url)
                throw new Error(body.error || `Reader’s server answered ${response.status}.`);
            if (!popup)
                throw new Error('The browser blocked the GitHub window: allow pop-ups for this site, then try again.');
            popup.location.href = body.url;
        })
            .catch((error) => {
            popup?.close();
            finish(() => Promise.reject(error instanceof Error ? error : new Error(String(error))));
        });
    });
}
export async function forgetGitHubToken() {
    await apiFetch('/github/token', { method: 'DELETE' }).catch(() => undefined);
}
/**
 * A GitHub API call: through Reader's server with the token it keeps, or —
 * for a token still in this browser — straight to GitHub with it.
 */
export function githubFetch(token, path, init = {}) {
    const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
    };
    // Through Reader's server: it puts GitHub's own headers on the call. Only Content-Type goes from here — any
    // other header makes the browser ask the server first (CORS), and one it doesn't allow blocks the call outright.
    if (token === ON_SERVER)
        return apiFetch(`/github/api${path}`, { ...init, headers: init.body ? { 'Content-Type': 'application/json' } : {} });
    return fetch(`${GITHUB}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...headers } });
}
