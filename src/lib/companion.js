// The Reader Companion, from the page's side: finding it on 127.0.0.1, pairing
// with the code it shows, and the commands that start it. The Companion itself
// is companion/ (a Python package); scripts/build-companion.mjs puts its wheel
// and the one-line installers into the site build. See docs/companion.md.
/** The Companion's version: the wheel the installers fetch. Kept equal to companion/pyproject.toml by scripts/companion.test.mjs. */
export const COMPANION_VERSION = '0.14.0';
/** Where the Companion listens unless told otherwise. */
export const COMPANION_PORT = 47321;
/** Its https address on this computer, for Safari, which won't call http://127.0.0.1 from an https page (companion/reader_companion/tls.py). */
export const COMPANION_TLS_PORT = 47331;
/** The Companion's direct address on this computer. */
export const directBase = (port = COMPANION_PORT) => `http://127.0.0.1:${port}/`;
/** Its https address on this computer: what Safari can reach, once the Mac trusts its certificate. */
export const secureBase = (port = COMPANION_TLS_PORT) => `https://127.0.0.1:${port}/`;
/** Where this browser can reach a Companion on this computer: https in Safari, http everywhere else. */
export const localBase = (safari = isSafari(), port = COMPANION_PORT, tlsPort = COMPANION_TLS_PORT) => (safari ? secureBase(tlsPort) : directBase(port));
/** A quick tunnel's address, and only that: a pairing link can't send the page to any other server. */
export function tunnelBase(url) {
    if (!url)
        return null;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && /^[a-z0-9-]+\.trycloudflare\.com$/.test(parsed.hostname) && !parsed.port ? `https://${parsed.hostname}/` : null;
    }
    catch {
        return null;
    }
}
/** The Companion at `base` (its direct address, or its tunnel's), or null when nothing answers (not running, another program on the port, or the browser won't let the page reach it). */
export async function findCompanion(base = localBase(), timeoutMs = 1500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`${base}companion/info`, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok)
            return null;
        const info = (await response.json());
        return info && info.app === 'reader-companion' && typeof info.name === 'string' ? info : null;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
/** Trades the code the Companion printed for its server's address and token. */
export async function pairCompanion(code, base = localBase(), pass) {
    let response;
    try {
        // The page's pass, when signed in: a Companion connected to an account pairs only with a page signed in as it.
        response = await fetch(`${base}companion/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: normaliseCode(code), ...(pass ? { pass } : {}) }) });
    }
    catch {
        throw new Error('The Companion stopped answering. Is it still running in the terminal?');
    }
    const body = (await response.json().catch(() => ({})));
    if (!response.ok || typeof body.url !== 'string' || typeof body.token !== 'string')
        throw new Error(body.error || `The Companion said ${response.status}.`);
    return body;
}
/**
 * Asks the Companion to put its pairing code on its computer's screen, for a
 * browser that found it but has no code (it runs in the background, with no
 * terminal to read). False when that computer has nothing to show it with.
 */
export async function showCompanionCode(base = localBase()) {
    try {
        const response = await fetch(`${base}companion/show-code`, { method: 'POST' });
        if (response.status === 429)
            return true;
        const body = (await response.json().catch(() => ({})));
        return response.ok && body.shown === true;
    }
    catch {
        return false;
    }
}
/** "abc def", "ABCDEF" and "ABC-DEF" are the same code. */
export function normaliseCode(code) {
    const raw = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return raw.length === 6 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
}
/** `#pair=ABC-DEF&port=47321[&via=https://….trycloudflare.com]`, as the Companion opens the page with, or null. */
export function pairFragment(hash) {
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const code = params.get('pair');
    if (!code)
        return null;
    const valid = (value) => Number.isInteger(value) && value > 0 && value < 65536;
    const port = Number(params.get('port'));
    const tls = Number(params.get('tls'));
    return { code: normaliseCode(code), port: valid(port) ? port : COMPANION_PORT, tls: valid(tls) ? tls : null, via: tunnelBase(params.get('via')) };
}
/**
 * Where to look for a Companion, in order: its https address on this computer
 * when it has one (encrypted, and the only way in for Safari), its plain http
 * one (not for Safari; it never leaves this computer either), then its tunnel.
 */
export function companionRoutes(port, via, safari = isSafari(), tls = COMPANION_TLS_PORT) {
    const secure = tls ? [secureBase(tls)] : [];
    const local = safari ? secure : [...secure, directBase(port)];
    return [...local, ...(via ? [via] : [])];
}
/** The Companion on this computer, at its https address when this browser can reach it there, else at its http one (never for Safari). */
export async function findLocalCompanion(safari = isSafari(), timeoutMs = 1500) {
    for (const base of companionRoutes(COMPANION_PORT, null, safari)) {
        const info = await findCompanion(base, timeoutMs);
        if (info)
            return { base, info };
    }
    return null;
}
/** Whether a saved server is reached over https (or through its tunnel, which is https too): encrypted all the way. */
export const isSecure = (url) => url.startsWith('https://');
/**
 * The https address of a Companion this browser reaches over plain http on
 * this computer, once it answers there as the same Companion (its certificate
 * trusted by this computer); null when it doesn't, or the server is something else.
 */
export async function secureAddress(server, tlsPort = COMPANION_TLS_PORT) {
    if (isSecure(server.url) || !server.companionId || companionPort(server.url) === null)
        return null;
    const base = secureBase(tlsPort);
    const info = await findCompanion(base, 2500);
    return info?.id === server.companionId ? base : null;
}
/** A saved server that is a Companion on this computer: its port, or null. */
export function companionPort(url) {
    try {
        const parsed = new URL(url);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname === '127.0.0.1' && parsed.pathname === '/' && parsed.port ? Number(parsed.port) : null;
    }
    catch {
        return null;
    }
}
/** The commands that start the Companion, for a site served at `site` (its origin plus base path); with the tunnel, for Safari. */
export function companionCommands(site, { tunnel = false } = {}) {
    const base = site.replace(/\/?$/, '/');
    return {
        unix: `curl -LsSf ${base}companion.sh | sh${tunnel ? ' -s -- --tunnel' : ''}`,
        windows: `powershell -ExecutionPolicy ByPass -c "irm ${base}companion.ps1 | iex"`,
        uv: `uvx --python 3.12 --from ${base}companion/reader_companion-${COMPANION_VERSION}-py3-none-any.whl reader-companion --site ${base}${tunnel ? ' --tunnel' : ''}`,
    };
}
/** Which installer to offer first: this computer's system, from what the browser says. */
export function desktopSystem(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent) {
    if (/Windows|Win64|Win32/i.test(userAgent))
        return 'windows';
    if (/Macintosh|Mac OS X/i.test(userAgent))
        return 'mac';
    return 'linux';
}
/**
 * The installers to download and double-click (scripts/build-companion.mjs):
 * each installs the Companion for good, with the VS Code extension, starts it
 * at every login and opens the page to pair (`reader-companion setup`). Linux
 * has no file manager that runs a script on a double-click, so there it is a
 * line to paste, and the file for `sh` beside it.
 */
export function companionDownloads(site) {
    const base = site.replace(/\/?$/, '/');
    return {
        mac: { label: 'macOS', href: `${base}download/Reader-Companion-mac.zip`, file: 'Reader Companion.command', command: `curl -LsSf ${base}companion-setup.sh | sh` },
        windows: { label: 'Windows', href: `${base}download/Reader-Companion-Setup.cmd`, file: 'Reader-Companion-Setup.cmd', command: `powershell -ExecutionPolicy ByPass -c "irm ${base}companion-setup.ps1 | iex"` },
        linux: { label: 'Linux', href: `${base}download/reader-companion-setup.sh`, file: 'reader-companion-setup.sh', command: `curl -LsSf ${base}companion-setup.sh | sh` },
    };
}
/** The Reader extension for VS Code, as the site serves it (scripts/build-vscode.mjs): the .vsix and the line that installs it. */
export function vscodeInstall(site, windows = false) {
    const vsix = `${site.replace(/\/?$/, '/')}vscode/reader-playground.vsix`;
    return {
        vsix,
        command: windows
            ? `powershell -c "irm ${vsix} -OutFile $env:TEMP\\reader-playground.vsix; code --install-extension $env:TEMP\\reader-playground.vsix"`
            : `curl -LsSfo /tmp/reader-playground.vsix ${vsix} && code --install-extension /tmp/reader-playground.vsix`,
    };
}
/** Safari will not let an https page call http://127.0.0.1, so the Companion can't be reached from it. */
export function isSafari(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent) {
    return /Safari\//.test(userAgent) && !/(Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS)\//.test(userAgent);
}
/**
 * Asks a paired Companion about VS Code (`GET`), or to install the Reader
 * extension into it (`install`): the extension isn't on the Marketplace, and a
 * page can't run `code --install-extension`, but the Companion can.
 */
export async function companionVsCode(server, install = false) {
    let response;
    try {
        response = await fetch(`${server.url.replace(/\/?$/, '/')}companion/vscode`, { method: install ? 'POST' : 'GET', headers: { Authorization: `token ${server.token}` }, cache: 'no-store' });
    }
    catch {
        throw new Error('The Companion isn’t answering. Open the Reader app, or start it again.');
    }
    const body = (await response.json().catch(() => ({})));
    if (response.status === 404 && !body.error)
        throw new Error('This Companion is older than the VS Code button: run the installer again to update it.');
    if (!response.ok)
        throw new Error(body.error || `The Companion said ${response.status}.`);
    return { editors: Array.isArray(body.editors) ? body.editors : [] };
}
/** Where the Reader desktop app is published: the desktop app workflow's GitHub Releases (docs/desktop-app.md). */
export const APP_RELEASES = 'saurav717/reader';
/** Which installer an asset of a release is, by its name (desktop/app/electron-builder.config.cjs and the workflow name them). */
export function appAssetKind(name) {
    if (/^Reader(-[\d.]+)?-unsigned\.dmg$/.test(name))
        return { kind: 'mac', signed: false };
    if (/^Reader(-[\d.]+)?\.dmg$/.test(name))
        return { kind: 'mac', signed: true };
    if (/^Reader-Setup-[\d.]+(-unsigned)?\.exe$/.test(name))
        return { kind: 'windows', signed: !name.includes('-unsigned') };
    if (/^Reader-[\d.]+-x86_64\.AppImage$/.test(name))
        return { kind: 'appImage', signed: false };
    if (/^reader_[\d.]+_amd64\.deb$/.test(name))
        return { kind: 'deb', signed: false };
    if (/^reader-[\d.]+\.x86_64\.rpm$/.test(name))
        return { kind: 'rpm', signed: false };
    return null;
}
/**
 * The newest published installers of the Reader desktop app (the desktop app
 * workflow), each from the newest release that has one: a signed one before an
 * unsigned one in the same release. Empty while there are none: then the
 * downloads stay the installer scripts (companionDownloads).
 */
export async function latestDesktopApps(repo = APP_RELEASES) {
    try {
        const cached = sessionStorage.getItem('reader.desktopApps');
        if (cached !== null)
            return JSON.parse(cached);
    }
    catch {
        // no storage, or not ours: ask
    }
    const found = {};
    try {
        const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`, { headers: { Accept: 'application/vnd.github+json' } });
        if (!response.ok)
            return {};
        const releases = (await response.json());
        for (const release of releases) {
            if (release.draft || release.prerelease)
                continue;
            const here = {};
            for (const asset of release.assets ?? []) {
                const what = asset.name ? appAssetKind(asset.name) : null;
                if (!what || !asset.browser_download_url || found[what.kind])
                    continue;
                if (!here[what.kind] || (what.signed && !here[what.kind]?.signed))
                    here[what.kind] = { url: asset.browser_download_url, file: asset.name, signed: what.signed };
            }
            Object.assign(found, here);
        }
    }
    catch {
        return {};
    }
    const apps = {};
    if (found.mac)
        apps.mac = found.mac;
    if (found.windows)
        apps.windows = found.windows;
    if (found.appImage || found.deb || found.rpm)
        apps.linux = { appImage: found.appImage, deb: found.deb, rpm: found.rpm };
    try {
        sessionStorage.setItem('reader.desktopApps', JSON.stringify(apps));
    }
    catch {
        // fine
    }
    return apps;
}
/** Whether this page is in the Reader desktop app's window (desktop/app/preload-site.js says so). */
export function inDesktopApp() {
    return typeof window !== 'undefined' && Boolean(window.readerDesktop?.app);
}
/** Whether `version` is newer than `than` (dotted numbers: 0.10.0 is newer than 0.9.2). */
export function isNewer(version, than) {
    const parts = (value) => value.split('.').map((part) => Number.parseInt(part, 10) || 0);
    const a = parts(version);
    const b = parts(than);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        if ((a[i] ?? 0) !== (b[i] ?? 0))
            return (a[i] ?? 0) > (b[i] ?? 0);
    }
    return false;
}
/**
 * Asks a paired Companion to update itself to the newest version the site
 * serves (POST /companion/update): it installs it, refreshes the VS Code
 * extension where it is installed, and starts again. Resolves with the version
 * it is updating to, once it has installed it (it restarts after answering).
 */
export async function updateCompanion(server) {
    let response;
    try {
        response = await fetch(`${server.url.replace(/\/?$/, '/')}companion/update`, { method: 'POST', headers: { Authorization: `token ${server.token}` } });
    }
    catch {
        throw new Error('The Companion isn’t answering. Open the Reader app, or start it again.');
    }
    const body = (await response.json().catch(() => ({})));
    if (!response.ok || typeof body.version !== 'string')
        throw new Error(body.error || `The Companion said ${response.status}.`);
    return { version: body.version, updated: Boolean(body.updated) };
}
/** Waits for the Companion at `base` to answer as `version` (or newer) after it restarts. */
export async function waitForVersion(base, version, forMs = 120_000) {
    const until = Date.now() + forMs;
    while (Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const info = await findCompanion(base, 3000);
        if (info && !isNewer(version, info.version))
            return info;
    }
    return null;
}
/** The first Companion the page can shut down and start again (POST /companion/shutdown, and reader-companion:// links). */
export const STARTABLE = '0.6.0';
/** The first Companion a page that hasn't paired with it can shut down, from this computer (not through its tunnel). */
export const STOPPABLE_UNPAIRED = '0.7.0';
/** The first Companion that belongs to a Google account (POST /companion/claim). */
export const ACCOUNTS = '0.7.0';
/**
 * Shuts a Companion down (POST /companion/shutdown): its kernels, its Jupyter
 * server and the process. It stays off, at the next login too, until it is
 * started on purpose: startCompanion, the Reader app, or `reader-companion start`.
 * Without a token (a Companion found but not paired), only on this computer and
 * from STOPPABLE_UNPAIRED on.
 */
export async function shutdownCompanion(server) {
    let response;
    try {
        response = await fetch(`${server.url.replace(/\/?$/, '/')}companion/shutdown`, { method: 'POST', headers: server.token ? { Authorization: `token ${server.token}` } : {} });
    }
    catch {
        throw new Error('The Companion isn’t answering: it may be off already.');
    }
    if (response.status === 404)
        throw new Error(`This Companion is older than the Shut down button (${STARTABLE}): update it in Settings → Updates, then try again.`);
    const body = (await response.json().catch(() => ({})));
    if (response.status === 403 && !server.token)
        throw new Error(`This Companion turns off from here only once paired, or from ${STOPPABLE_UNPAIRED} on: connect it with its code first, or stop it with Ctrl-C in its terminal.`);
    if (!response.ok)
        throw new Error(body.error || `The Companion said ${response.status}.`);
}
/**
 * Connects a paired Companion to the Google account the page is signed in as
 * (POST /companion/claim, from 0.7.0): it goes on that account's list of
 * computers on the Worker at `api`, opens its HTTPS tunnel, and takes a new
 * token, which it answers with — the one the browser had stops working.
 */
export async function claimCompanion(server, pass, api) {
    let response;
    try {
        response = await fetch(`${server.url.replace(/\/?$/, '/')}companion/claim`, { method: 'POST', headers: { Authorization: `token ${server.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ pass, api }) });
    }
    catch {
        throw new Error('The Companion isn’t answering.');
    }
    if (response.status === 404)
        throw new Error('This Companion is older than accounts (0.7.0): update it in Settings → Updates to connect it to your Google account.');
    const body = (await response.json().catch(() => ({})));
    if (!response.ok || typeof body.token !== 'string' || typeof body.email !== 'string')
        throw new Error(body.error || `The Companion said ${response.status}.`);
    return { email: body.email, token: body.token, tunnel: body.tunnel || '', id: body.id || '' };
}
/** What the paired Companion's computer can run (GET /companion/tools, from 0.7.0): null when it can't say. */
export async function companionTools(server) {
    try {
        const response = await fetch(`${server.url.replace(/\/?$/, '/')}companion/tools`, { headers: { Authorization: `token ${server.token}` }, cache: 'no-store' });
        if (!response.ok)
            return null;
        const body = (await response.json());
        if (!body.tools || !Array.isArray(body.agents))
            return null;
        return { os: body.os === 'windows' ? 'windows' : body.os === 'linux' ? 'linux' : 'mac', tools: body.tools, agents: body.agents, vscode: Boolean(body.vscode) };
    }
    catch {
        return null;
    }
}
/**
 * VS Code for the browser on the Companion's computer (/companion/vscode-web,
 * from 0.7.0): `start` starts it (the first time downloads VS Code's server),
 * otherwise only says how it is. `folder` is the project's, under the Companion's.
 */
export async function vscodeWeb(server, folder, start = false) {
    const base = `${server.url.replace(/\/?$/, '/')}companion/vscode-web`;
    let response;
    try {
        response = start
            ? await fetch(base, { method: 'POST', headers: { Authorization: `token ${server.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) })
            : await fetch(`${base}?folder=${encodeURIComponent(folder)}`, { headers: { Authorization: `token ${server.token}` }, cache: 'no-store' });
    }
    catch {
        throw new Error('The Companion isn’t answering.');
    }
    if (response.status === 404)
        throw new Error('This Companion is older than VS Code in the page (0.7.0): update it in Settings → Updates.');
    const body = (await response.json().catch(() => ({})));
    if (!response.ok)
        throw new Error(body.error || `The Companion said ${response.status}.`);
    return { state: body.state ?? 'off', error: body.error ?? '', path: body.path ?? '', folder: body.folder ?? '', log: Array.isArray(body.log) ? body.log.filter((line) => typeof line === 'string') : [] };
}
/**
 * A folder as VS Code's address takes it: a path from the root, with forward
 * slashes — /Users/me/Reader/x, and on Windows /C:/Users/me/Reader/x (as
 * C:\Users\… it isn't a path VS Code's address can hold, and it opens with
 * no folder).
 */
export function vscodeFolder(path) {
    const forward = path.replace(/\\/g, '/');
    return forward.startsWith('/') ? forward : `/${forward}`;
}
/** The link that starts the Companion on this computer: `reader-companion setup` hands the scheme to `reader-companion start`. */
export const START_LINK = 'reader-companion://start';
/**
 * Asks this computer to start its Companion, by opening START_LINK (the
 * browser asks once whether to open it), then waits for it to answer at
 * `base`. Null when it doesn't within `forMs`: nothing here takes the link (a
 * Companion from before STARTABLE, or not installed for good), or it didn't start.
 */
export async function startCompanion(base, forMs = 90_000) {
    if (typeof window !== 'undefined')
        window.location.href = START_LINK;
    const until = Date.now() + forMs;
    while (Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const info = await findCompanion(base, 3000);
        if (info)
            return info;
    }
    return null;
}
/** Whether the Companion shuts down with the Reader app's window (true) or keeps running once it is closed. */
export async function setStopWithApp(server, on) {
    const response = await fetch(`${server.url.replace(/\/?$/, '/')}companion/app`, {
        method: 'POST',
        headers: { Authorization: `token ${server.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'setting', stopWithApp: on }),
    });
    const body = (await response.json().catch(() => ({})));
    if (!response.ok || typeof body.stopWithApp !== 'boolean')
        throw new Error(body.error || `The Companion said ${response.status}: update it in Settings → Updates.`);
    return body.stopWithApp;
}
// ------------------------------------------------- folders anywhere (0.8.0) --
/** The first Companion that lists folders anywhere on its computer and links one in (/companion/folders). */
export const FOLDERS_VERSION = '0.8.0';
const foldersUrl = (server) => `${server.url.replace(/\/?$/, '/')}companion/folders`;
async function foldersCall(server, init, query = '') {
    const response = await fetch(`${foldersUrl(server)}${query}`, { ...init, headers: { Authorization: `token ${server.token}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) }, cache: 'no-store' });
    const body = (await response.json().catch(() => ({})));
    if (!response.ok)
        throw new Error(body.error || (response.status === 404 ? 'This Companion can’t list folders: update it.' : `The Companion answered ${response.status}.`));
    return body;
}
/** A folder anywhere on the Companion's computer, listed: '' is its home folder. */
export const listFolder = (server, path = '', hidden = false) => foldersCall(server, undefined, `?path=${encodeURIComponent(path)}${hidden ? '&hidden=1' : ''}`);
/** A folder on the Companion's computer linked into its own folder: the root a project then uses, relative to it. */
export const linkFolder = (server, path) => foldersCall(server, { method: 'POST', body: JSON.stringify({ action: 'link', path }) });
/** That computer's own folder chooser, on its screen: the folder picked, or null when cancelled. */
export const chooseFolder = (server) => foldersCall(server, { method: 'POST', body: JSON.stringify({ action: 'choose' }) });
// ------------------------------------------- browsers on this computer (0.9.0) --
/** The first Companion that lists this computer's browsers and their profiles, and opens a link in one (/companion/browsers). */
export const BROWSERS_VERSION = '0.9.0';
const browsersUrl = (server) => `${server.url.replace(/\/?$/, '/')}companion/browsers`;
async function browsersCall(server, init) {
    let response;
    try {
        response = await fetch(browsersUrl(server), { ...init, headers: { Authorization: `token ${server.token}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) }, cache: 'no-store' });
    }
    catch {
        throw new Error('The Companion on this computer didn’t answer. Is it running?');
    }
    const body = (await response.json().catch(() => ({})));
    if (response.status === 404)
        throw new Error(`This computer’s Companion is older than ${BROWSERS_VERSION}: update it to open links in another browser.`);
    if (!response.ok)
        throw new Error(body.error || `The Companion said ${response.status}.`);
    return body;
}
/** The browsers on the Companion's computer, each with its profiles. */
export const listBrowsers = (server) => browsersCall(server).then((body) => body.browsers);
/** Opens an https link in that browser and profile on the Companion's computer ('default' for its default browser). */
export const openInBrowser = (server, url, browser, profile) => browsersCall(server, { method: 'POST', body: JSON.stringify({ url, browser, ...(profile ? { profile } : {}) }) });
// ------------------------------------------- a project's paper here (0.10.0) --
/** The first Companion that compiles a paper and syncs it with Overleaf's Git (/companion/paper). */
export const PAPER_VERSION = '0.10.0';
/** The first Companion that compiles as Overleaf does (its build kept out of the paper), keeps templates and an account's token. */
export const PAPER_TEMPLATES_VERSION = '0.11.0';
/** The Companion's own TeX Live, installed into its folder without a password (from 0.12.0). */
export const TEXLIVE_VERSION = '0.12.0';
export const TEX_COMPILERS = [
    { id: 'pdflatex', label: 'pdfLaTeX' },
    { id: 'xelatex', label: 'XeLaTeX' },
    { id: 'lualatex', label: 'LuaLaTeX' },
    { id: 'latex', label: 'LaTeX' },
];
async function paperCall(server, init) {
    let response;
    try {
        response = await fetch(`${server.url.replace(/\/?$/, '/')}companion/paper`, {
            method: init ? 'POST' : 'GET',
            headers: { Authorization: `token ${server.token}`, ...(init ? { 'Content-Type': 'application/json' } : {}) },
            ...(init ? { body: JSON.stringify(init) } : {}),
            cache: 'no-store',
        });
    }
    catch {
        throw new Error('This computer’s Companion didn’t answer. Is it running?');
    }
    const body = (await response.json().catch(() => ({})));
    if (response.status === 404)
        throw new Error(`This computer’s Companion is older than ${PAPER_VERSION}: update it to compile and sync the paper here.`);
    if (!response.ok)
        throw new Error(body.error || `The Companion said ${response.status}.`);
    return body;
}
/** What compiles a paper on the Companion's computer, and whether git is there. */
export const paperEngines = (server) => paperCall(server);
/** Compiles the paper in `folder` (relative to the Companion's folder). */
export const compilePaper = (server, folder, engine, how = {}) => paperCall(server, { action: 'compile', folder, engine, ...(how.main ? { main: how.main } : {}), compiler: how.compiler ?? 'pdflatex', halt: Boolean(how.halt) });
/** Fetches Tectonic onto the Companion's computer. */
export const installTectonic = (server) => paperCall(server, { action: 'install-tectonic' });
export const texLiveStatus = (server) => paperCall(server, { action: 'texlive' });
export const installTexLive = (server, scheme) => paperCall(server, { action: 'install-texlive', scheme });
export const cancelTexLive = (server) => paperCall(server, { action: 'cancel-texlive' });
export const removeTexLive = (server) => paperCall(server, { action: 'remove-texlive' });
export const installPackages = (server, names) => paperCall(server, { action: 'install-packages', names });
/** Clones Overleaf's Git (or a GitHub repository) into `folder`; the token is kept by the Companion for that remote. */
export const clonePaper = (server, folder, url, token) => paperCall(server, { action: 'clone', folder, url, token });
/** Commits what changed here, takes in what changed in Overleaf, and pushes. */
export const syncPaper = (server, folder, message, token) => paperCall(server, { action: 'sync', folder, message, ...(token ? { token } : {}) });
/** Where the folder syncs to, and whether the Companion has a token for it. */
export const paperRemote = (server, folder) => paperCall(server, { action: 'remote', folder });
/** The first Companion that opens a paper's folder in the computer's file manager. */
export const REVEAL_VERSION = '0.13.0';
/** A paper's folder, or one inside it, opened in Finder, Explorer or the desktop's file manager (from 0.13.0). */
export const revealPaper = (server, folder) => paperCall(server, { action: 'reveal', folder });
/** The templates kept on the Companion's computer (from 0.11.0). */
export const listTemplates = (server) => paperCall(server, { action: 'templates' }).then((body) => body.templates);
/** A conference's kit, a .zip as base64, kept as a template. */
export const saveTemplate = (server, name, zip) => paperCall(server, { action: 'save-template', name, zip });
/** A template's files copied into a paper's folder, which may be an empty Overleaf project's clone. */
export const applyTemplate = (server, template, folder, replace = false) => paperCall(server, { action: 'apply-template', template, folder, replace });
export const deleteTemplate = (server, template) => paperCall(server, { action: 'delete-template', template });
/** Whether the Companion has a token for this remote, or its Overleaf account. */
export const tokenKnown = (server, url) => paperCall(server, { action: 'token', url }).then((body) => body.known);
/** Every Overleaf token on the Companion's computer, forgotten. */
export const forgetOverleafToken = (server) => paperCall(server, { action: 'forget-token', host: 'https://git.overleaf.com' });
