import { api, apiFetch, clientId, hasProxy } from './api';
import { scholarPaperUrl } from './locations';
/**
 * What the proxy answered with, when it would not: the status, and — when
 * Cloudflare would not start a browser — how many seconds until it said it
 * would, for the pane to count down and try again on its own.
 */
export class BrowseError extends Error {
    status;
    retryAfter;
    browsers;
    /** True when it is the day's browser time that is spent: no wait short of tomorrow cures it. */
    daily;
    constructor(message, status, retryAfter = null, browsers = null, daily = false) {
        super(message);
        this.name = 'BrowseError';
        this.status = status;
        this.retryAfter = retryAfter;
        this.browsers = browsers;
        this.daily = daily;
    }
    /** Whether this is Cloudflare rationing browsers, which a wait will cure, rather than something wrong. */
    get rateLimited() {
        return this.status === 429;
    }
}
/** The error a refusal makes, with the wait when the proxy named one. */
function refused(status, payload) {
    const seconds = Number(payload.retryAfter);
    const retryAfter = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
    const browsers = payload.browsers && typeof payload.browsers === 'object' ? payload.browsers : null;
    return new BrowseError(payload.error || `The proxy answered ${status}.`, status, retryAfter, browsers, payload.daily === true);
}
const UNAVAILABLE = {
    available: false,
    open: false,
    seq: 0,
    pdf: null,
    reason: 'There is no proxy configured, so there is no browser to open.',
};
/** The open session's id, where the proxy hands one out; the Node proxy has one session and no id. */
let session = null;
/** A route's path with the session id on it, when there is one. */
function withSession(path) {
    if (!session)
        return path;
    return `${path}${path.includes('?') ? '&' : '?'}session=${encodeURIComponent(session)}`;
}
async function ask(path, init) {
    const response = await apiFetch(withSession(path), { ...init, headers: { Accept: 'application/json', ...(init?.headers || {}) } });
    const payload = (await response.json().catch(() => ({})));
    if (!response.ok)
        throw refused(response.status, payload);
    return payload;
}
/** Whether the proxy can open a browser, and what it has open. */
export async function browseStatus() {
    if (!hasProxy())
        return UNAVAILABLE;
    try {
        return { ...UNAVAILABLE, ...(await ask('/browse/status')) };
    }
    catch {
        return { ...UNAVAILABLE, reason: 'This proxy does not know how to open a browser. Update it and restart.' };
    }
}
/**
 * How long an open is waited for. The Worker gives up on its own before
 * this — every step of opening has a deadline there — so this is for a
 * proxy that never answers at all: the spinner ends with a sentence.
 */
export const OPEN_TIMEOUT_MS = 120_000;
/** Open the browser at a site. */
export async function openBrowser(url) {
    session = null;
    let answer;
    try {
        answer = await ask(`/browse/open?url=${encodeURIComponent(url)}`, { method: 'POST', signal: AbortSignal.timeout(OPEN_TIMEOUT_MS) });
    }
    catch (error) {
        if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
            throw new BrowseError(`The proxy did not answer within ${Math.round(OPEN_TIMEOUT_MS / 1000)} seconds. Its /browse/status says what it is doing; try again in a moment, and if it keeps happening, redeploy the Worker from the current app repository.`, 504);
        }
        throw error;
    }
    const opened = { ...UNAVAILABLE, ...answer };
    session = opened.session || null;
    return opened;
}
/**
 * The next frame after `after`, or the status as it stands once the proxy
 * has waited its turn. Rejects the way an aborted fetch does on abort.
 */
export async function nextFrame(after, signal) {
    const response = await apiFetch(withSession(`/browse/frame?after=${after}`), { headers: { Accept: 'application/json' }, signal });
    const payload = (await response.json().catch(() => ({})));
    if (!response.ok)
        throw refused(response.status, payload);
    return { ...UNAVAILABLE, ...payload };
}
/** Something done to the page. Several at once arrive in order. */
export async function sendInput(events) {
    if (!events.length)
        return;
    await ask('/browse/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
    });
}
/** The stream's address for the open session — the proxy's, over ws or wss — or null without a proxy or a session. */
export function streamUrl() {
    if (!hasProxy() || !session)
        return null;
    let url;
    try {
        // A WebSocket carries no headers of its own, so the client id goes on
        // the address; the session id, which only this browser was handed, is
        // what admits it.
        url = new URL(api(withSession(`/browse/stream?client=${encodeURIComponent(clientId())}`)), typeof location === 'undefined' ? 'http://localhost/' : location.href);
    }
    catch {
        return null;
    }
    if (url.protocol === 'https:')
        url.protocol = 'wss:';
    else if (url.protocol === 'http:')
        url.protocol = 'ws:';
    else
        return null;
    return url.toString();
}
/**
 * The frames over one WebSocket rather than a poll a frame: the Worker's
 * session object pushes each status the moment something is newer, and
 * takes input off the same socket, so a scroll or a keystroke never waits
 * behind a frame. A proxy without one — the Node proxy, the dev server —
 * refuses the upgrade, `onEnd` says so having never opened, and the pane
 * polls as before. Null where there is nothing to open a stream to.
 */
export function openStream(handlers) {
    const url = streamUrl();
    if (!url || typeof WebSocket === 'undefined')
        return null;
    let socket;
    try {
        socket = new WebSocket(url);
    }
    catch {
        return null;
    }
    let opened = false;
    let ended = false;
    const end = () => {
        if (ended)
            return;
        ended = true;
        handlers.onEnd(opened);
    };
    socket.onopen = () => {
        opened = true;
    };
    socket.onmessage = (event) => {
        let payload;
        try {
            payload = JSON.parse(String(event.data));
        }
        catch {
            return;
        }
        handlers.onStatus({ ...UNAVAILABLE, ...payload });
    };
    socket.onclose = end;
    socket.onerror = end;
    return {
        send: (events) => {
            if (socket.readyState !== WebSocket.OPEN)
                return false;
            try {
                socket.send(JSON.stringify({ events }));
                return true;
            }
            catch {
                return false;
            }
        },
        close: () => {
            ended = true;
            try {
                socket.close();
            }
            catch {
                // Never opened, or closed already.
            }
        },
    };
}
async function pdfFrom(path, init) {
    const response = await apiFetch(withSession(path), init);
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({})));
        throw refused(response.status, payload);
    }
    const blob = await response.blob();
    return blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
}
/**
 * The paper an OpenReview page is about, as the URL of its file on
 * openreview.net — for the forum, the file, an attachment, or the check
 * OpenReview puts in front of any of them (`/challenge?redirect=…`) — or
 * null for any other page. The proxy asks OpenReview's API for such a URL
 * rather than the site (server/openreview.js), signed in with an account
 * where it has one, which skips the check — so the file comes without
 * anyone ticking a box the Worker's browser could never pass.
 */
export function openReviewPdfUrl(pageUrl) {
    let url;
    try {
        url = new URL(pageUrl || '');
    }
    catch {
        return null;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!['openreview.net', 'api.openreview.net', 'api2.openreview.net'].includes(host))
        return null;
    if (/^\/challenge\/?$/i.test(url.pathname)) {
        const redirect = url.searchParams.get('redirect');
        return redirect?.startsWith('/') && !redirect.startsWith('//') ? openReviewPdfUrl(new URL(redirect, 'https://openreview.net/').href) : null;
    }
    const route = url.pathname.replace(/\/+$/, '').toLowerCase();
    const id = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]{5,40}$/.test(id))
        return null;
    if (route === '/pdf' || route === '/forum')
        return `https://openreview.net/pdf?id=${encodeURIComponent(id)}`;
    const name = url.searchParams.get('name') || '';
    if (route === '/attachment' && /^[A-Za-z0-9_-]{1,40}$/.test(name)) {
        return `https://openreview.net/attachment?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`;
    }
    return null;
}
/** A PDF fetched by the proxy's own `/pdf` route, as a blob. */
export async function proxyPdf(url, name, signal) {
    let response;
    try {
        response = await apiFetch(`/pdf?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`, { signal });
    }
    catch (error) {
        if (signal?.aborted)
            throw error;
        throw new Error(`the proxy could not be reached (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({})));
        throw new Error(payload.error || `the proxy answered ${response.status}`);
    }
    let blob;
    try {
        blob = await response.blob();
    }
    catch (error) {
        if (signal?.aborted)
            throw error;
        throw new Error(`the connection to the proxy broke before the whole file arrived (${error instanceof Error ? error.message : String(error)})`);
    }
    return blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
}
/** The PDF from the page the browser is on, found and fetched by the proxy with the browser's sign-in. */
export function grabPdf(name) {
    return pdfFrom(`/browse/grab?name=${encodeURIComponent(name)}`, { method: 'POST' });
}
/** The PDF the browser has met, as a blob. */
export function collectPdf(name) {
    return pdfFrom(`/browse/pdf?name=${encodeURIComponent(name)}`);
}
/** Close the page. The sign-in it made stays on the proxy, where the proxy can keep one. */
export async function closeBrowser() {
    const open = session;
    session = null;
    if (open) {
        await apiFetch(`/browse/close?session=${encodeURIComponent(open)}`, { method: 'POST', headers: { Accept: 'application/json' } }).catch(() => undefined);
        return;
    }
    await ask('/browse/close', { method: 'POST' }).catch(() => undefined);
}
const bareHost = (host) => host.replace(/^www\./, '');
/**
 * Where to offer to go: every host the paper is published on, one entry
 * each, the one that wanted a sign-in first, then publishers — where the
 * institutional sign-in link is — then the rest; each at its landing page
 * where there is one, since a landing page is where the sign-in link lives,
 * else at the file. Google Scholar's page for the paper last, as the way to
 * a copy none of the indexes listed.
 */
export function browseSites(paper, locations, signIn) {
    const walledHost = signIn ? bareHost(signIn.host) : null;
    const groups = new Map();
    for (const location of locations || []) {
        if (!/^https:\/\//i.test(location.url))
            continue;
        const host = bareHost(location.host);
        groups.set(host, [...(groups.get(host) || []), location]);
    }
    if (walledHost && signIn && /^https:\/\//i.test(signIn.url) && !groups.has(walledHost)) {
        groups.set(walledHost, [{ url: signIn.url, host: walledHost, label: signIn.host, kind: 'publisher', isPdf: false, via: 'paper' }]);
    }
    const rankOf = (kind) => (kind === 'publisher' ? 1 : kind === 'unknown' ? 2 : kind === 'repository' ? 3 : 4);
    const sites = [];
    for (const [host, group] of groups) {
        const walled = host === walledHost;
        // A landing page beats a file as the place to sign in from; the offer's
        // own page, where there is one, is that landing page.
        const page = group.find((location) => !location.isPdf);
        const chosen = walled && signIn && /^https:\/\//i.test(signIn.url) ? { ...(page || group[0]), url: signIn.url, isPdf: false } : page || group[0];
        const kind = group.map((location) => location.kind).sort((a, b) => rankOf(a) - rankOf(b))[0];
        const label = group.find((location) => location.label && location.label !== location.host)?.label || chosen.label || host;
        const note = walled
            ? 'asked for a sign-in — go there and sign in through your institution'
            : chosen.isPdf
                ? kind === 'preprint'
                    ? 'the preprint, as a file'
                    : kind === 'repository'
                        ? 'a repository copy, as a file'
                        : 'a copy, as a file'
                : kind === 'publisher'
                    ? "the publisher's page for the paper"
                    : 'a page about the paper';
        sites.push({ url: chosen.url, host, label, note, walled, rank: walled ? 0 : rankOf(kind) });
    }
    sites.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
    sites.push({
        url: scholarPaperUrl(paper),
        host: 'scholar.google.com',
        label: 'Google Scholar',
        note: 'every version Scholar knows of, including copies no index lists',
        rank: 9,
    });
    return sites.map(({ rank: _rank, ...site }) => site);
}
/**
 * What to tell the person when the page the browser is on is a site's check
 * for a person — Cloudflare's "Just a moment…" and its kin — rather than the
 * site itself, or null when it is not. The check is the site's, and it
 * either shows a box to tick or lets the browser through on its own; what
 * the person needs to know is which page they are looking at, whether the
 * box is worth ticking, and what to do instead when it is not.
 *
 * Two things decide that. The proxy says, from the response itself, whether
 * the page is Cloudflare's check and whether it has come back after the
 * person answered it (`status.check`); the title and the URL are the fallback
 * for a proxy that does not. And the proxy says whose browser it is
 * (`status.where`): when the check is Cloudflare's and the browser is
 * Cloudflare's own — the Worker's, through Browser Rendering — the check
 * will not pass, by Cloudflare's own design: it identifies every request its
 * rendering browsers make as a bot to every site it protects, and no number
 * of ticks changes that. Saying so is the kindest thing the pane can do,
 * since the box otherwise comes back for as long as anyone keeps ticking it.
 * Unless the Worker has a browser elsewhere to hand the session to
 * (`status.fallback`): then the check is a moment's wait, and the page
 * comes again from that browser, whose box is the person's to tick.
 */
export function botCheck(status) {
    if (!status?.url)
        return null;
    let host = '';
    try {
        host = new URL(status.url).hostname.replace(/^www\./, '');
    }
    catch {
        return null;
    }
    const title = status.title || '';
    const seen = status.check && status.check.host === host ? status.check : null;
    const cloudflareTitled = /[?&]__cf_chl(?:_rt)?_tk=/.test(status.url) || /^just a moment|attention required!?\s*\|\s*cloudflare/i.test(title);
    const generic = /verify you are human|security verification|(?:checking|verifying) your browser|are you a robot|one more step/i.test(title);
    // OpenReview's check is a page of its own with Cloudflare's box inside.
    const openReview = /^\/challenge\/?$/i.test(new URL(status.url).pathname) && host === 'openreview.net';
    if (!seen && !cloudflareTitled && !generic && !openReview)
        return null;
    // The header the proxy saw is Cloudflare's own mark; the title is the guess.
    const cloudflares = Boolean(seen) || cloudflareTitled || openReview;
    const where = status.where ?? (status.session ? 'cloudflare' : 'proxy');
    const answered = (seen?.answered ?? 0) > 0;
    const own = 'Open the file in a tab of your own and drop it on the paper instead';
    if (openReview && openReviewPdfUrl(status.url)) {
        return `${host} is checking that a person is here, with Cloudflare's box, which the proxy's browser may never pass — so there is no need to tick it: the file is being asked for from OpenReview's API instead, signed in with the proxy's OpenReview account where it has one, which skips the check. If that does not bring it, ${own.charAt(0).toLowerCase()}${own.slice(1)}.`;
    }
    if (cloudflares && where === 'cloudflare') {
        if (status.fallback === 'browserless') {
            if (status.fallbackError) {
                return `${host} is checking that a person is here, and the check is Cloudflare's, which Cloudflare's own browser never passes. It was to be handed to a browser at Browserless, but Browserless gave none — ${status.fallbackError.replace(/[.\s]+$/, '')} — so it stays here, where the box will not pass. ${own}, or check the token and the plan at Browserless and open this site again.`;
            }
            return `${host} is checking that a person is here, and the check is Cloudflare's, which Cloudflare's own browser never passes — so this session is being handed to a browser at Browserless, on an address of its own. A moment: the page opens again there, and a box that appears then is yours to tick.`;
        }
        const why = "the check is Cloudflare's and so is this browser, and Cloudflare tells every site it protects that its rendering browsers are bots";
        return answered
            ? `${host}'s check has come back after you answered it, and it will keep coming back: ${why}, so from here the check does not pass however many times the box is ticked. ${own}, or run the proxy on your own machine (Settings → Paper proxy), whose browser is its own.`
            : `${host} is checking that a person is here before it shows the page. It is not expected to pass from here — ${why} — and if the box comes back after you tick it, that is why. ${own}, or run the proxy on your own machine (Settings → Paper proxy), whose browser is its own.`;
    }
    if (answered) {
        return `${host}'s check has come back after you answered it: the site is refusing this browser, and ticking the box again rarely changes its mind. ${own}.`;
    }
    return `${host} is checking that a person is here before it shows the page. If a box to tick appears, tick it; when the check passes the page follows on its own. If it does not pass, open the file in a tab of your own and drop it on the paper instead.`;
}
/** How many times running OpenReview's check may come before the pane calls it a loop, from a browser it could pass in. */
export const CHECK_LOOP_TIMES = 3;
/**
 * Whether the page is OpenReview's check going round with no way out —
 * "Verifying your browser", the box says *Success!*, and the page sends
 * the browser back to the check. From Cloudflare's own browser (the
 * Worker's, with no browser elsewhere to hand it to) that is certain from
 * the first time, since OpenReview's box never passes there; from any
 * other it is the check having come back `CHECK_LOOP_TIMES` times running.
 * Left alone it goes round for as long as the pane is open, spending the
 * day's browser time, so the pane closes the browser and says so instead.
 */
export function endlessCheck(status) {
    if (!status?.url)
        return false;
    let url;
    try {
        url = new URL(status.url);
    }
    catch {
        return false;
    }
    if (url.hostname.toLowerCase().replace(/^www\./, '') !== 'openreview.net' || !/^\/challenge\/?$/i.test(url.pathname))
        return false;
    const where = status.where ?? (status.session ? 'cloudflare' : 'proxy');
    const handedOn = status.fallback === 'browserless' && !status.fallbackError;
    if (where === 'cloudflare' && !handedOn)
        return true;
    const times = status.check?.host === 'openreview.net' ? status.check.times : 0;
    return times >= CHECK_LOOP_TIMES;
}
/** A site typed by hand, made into something the proxy will open, or null. */
export function siteFromInput(value) {
    const trimmed = value.trim();
    if (!trimmed)
        return null;
    const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
        const url = new URL(withScheme);
        if (url.protocol !== 'https:')
            return null;
        if (!url.hostname.includes('.'))
            return null;
        return url.toString();
    }
    catch {
        return null;
    }
}
// ------------------------------------------------------------------ input ----
/**
 * The DOM's name for a key, as Playwright wants it — which is the same name
 * for nearly everything. A dead key or an IME composition has no name the
 * proxy can press, and is left out.
 */
export function keyName(key) {
    if (!key || key === 'Dead' || key === 'Unidentified' || key === 'Process')
        return null;
    if (key.length === 1)
        return key;
    return /^(?:F[1-9]|F1[0-2]|[A-Z][A-Za-z0-9]{1,20})$/.test(key) ? key : null;
}
/**
 * A point on the picture, as a point on the page: the picture is the page
 * scaled to fit, so the scale is the ratio of the two widths.
 */
export function toPagePoint(client, box, page) {
    if (!box.width || !box.height)
        return { x: 0, y: 0 };
    const x = ((client.x - box.left) / box.width) * page.width;
    const y = ((client.y - box.top) / box.height) * page.height;
    return {
        x: Math.round(Math.max(0, Math.min(page.width, x))),
        y: Math.round(Math.max(0, Math.min(page.height, y))),
    };
}
/**
 * Input, sent in order: over the stream while one is open (`via`), which
 * keeps order on its own, else one request at a time. Mouse movement is
 * the one thing that arrives faster than it can be sent, and only the
 * latest position matters, so a move waiting to go is replaced rather
 * than queued; a scroll waiting to go takes the next scroll's distance
 * onto its own, since a page scrolled twice is a page scrolled the sum.
 */
export class InputQueue {
    pending = [];
    sending = false;
    failed;
    /** A way to send that keeps order on its own — the stream — tried before a request; set while one is open. */
    via = null;
    constructor(onError) {
        this.failed = onError ?? null;
    }
    push(event) {
        const last = this.pending[this.pending.length - 1];
        if (event.type === 'move' && last?.type === 'move') {
            this.pending[this.pending.length - 1] = event;
            void this.flush();
            return;
        }
        if (event.type === 'wheel' && last?.type === 'wheel') {
            this.pending[this.pending.length - 1] = { ...event, dx: last.dx + event.dx, dy: last.dy + event.dy };
            void this.flush();
            return;
        }
        this.pending.push(event);
        void this.flush();
    }
    async flush() {
        if (this.sending || !this.pending.length)
            return;
        this.sending = true;
        const batch = this.pending.splice(0, this.pending.length);
        try {
            if (this.via?.(batch))
                return;
            await sendInput(batch);
        }
        catch (error) {
            this.failed?.(error instanceof Error ? error : new Error(String(error)));
        }
        finally {
            this.sending = false;
            if (this.pending.length)
                void this.flush();
        }
    }
}
