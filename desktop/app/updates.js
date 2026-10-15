// The app keeps itself up to date: a while after it opens, and every few hours after, it asks the
// newest GitHub Release of the app (the desktop app workflow publishes one for every version, with
// the update files electron-builder writes beside the installers: latest-mac.yml, latest.yml,
// latest-linux.yml) whether there is a newer version, downloads it in the background, and offers to
// restart into it. Not restarted then, it is put in place as the app quits.
//
//   Windows, Linux  electron-updater: the setup .exe run again silently, the AppImage replaced, or
//                   the .deb/.rpm installed (it asks for the password)
//   macOS           our own: electron-updater's way on a Mac (Squirrel) needs an app signed with a
//                   Developer ID, which an unsigned build is not. The new Reader.app comes as a .zip,
//                   is checked against its SHA-512 in latest-mac.yml, and, once the app has quit,
//                   takes the old one's place, the old one kept until the new one is in. An app
//                   where it can't be replaced (on the disk image, or where this user can't write)
//                   gets the release's page instead.
//
// Every version stays published as its own release (app-v<version>), for each system: an older
// one can always be downloaded again from the releases page.

const { app, BrowserWindow, dialog, ipcMain, net, shell } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO = 'saurav717/reader';
/** The newest release's files: GitHub sends latest/download/<name> to the newest release that is not a draft or a prerelease. */
const FEED = process.env.READER_UPDATE_FEED || `https://github.com/${REPO}/releases/latest/download`;
const RELEASES = `https://github.com/${REPO}/releases`;
const FIRST_CHECK = 20_000;
const EVERY = 6 * 60 * 60_000;

/** Where the updater is: idle, checking, downloading (percent), ready (version), current, or failed (error). */
let state = { status: 'idle', version: app.getVersion() };
let siteOrigin = '';
let updater = null;
/** macOS: the new Reader.app, unpacked and checked, waiting for the app to quit. */
let pendingMac = null;
/** A check someone asked for (the menu, Settings), as opposed to the one in the background: it says when there is nothing new. */
let asked = false;
let busy = null;
let stopped = false;

const notUpdatable = () => ({ status: 'unsupported', error: app.isPackaged ? 'This copy of Reader can’t update itself: download the newest from the releases page.' : 'Run from source: nothing to update.' });

/** Whether this copy can update itself at all: an installed app, not one run from source or a .zip unpacked by hand. */
function updatable() {
  if (!app.isPackaged) return false;
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  // On Linux: an AppImage, or the .deb/.rpm (electron-builder leaves resources/package-type in those).
  return Boolean(process.env.APPIMAGE) || fs.existsSync(path.join(process.resourcesPath, 'package-type'));
}

function setState(next) {
  state = { ...next, version: app.getVersion() };
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (new URL(win.webContents.getURL()).origin === siteOrigin) win.webContents.send('updates:event', state);
    } catch {
      // a window between pages
    }
  }
}

// -------------------------------------------------------------- versions ----

/** a.b.c against x.y.z: positive when a is newer. Anything after a "-" (a prerelease) counts as older than without. */
function compareVersions(a, b) {
  const parse = (version) => {
    const [core, pre] = String(version).trim().replace(/^v/, '').split('-', 2);
    return { parts: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre: pre ?? '' };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * What latest-mac.yml says: the version, and each file's name, size and SHA-512 (base64). Only the
 * shape electron-builder writes is read:
 *   version: 0.14.312
 *   files:
 *     - url: Reader-0.14.312-mac.zip
 *       sha512: …
 *       size: 123
 */
function parseUpdateInfo(text) {
  const info = { version: '', files: [] };
  let file = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    const item = /^\s+-\s+(\w+):\s*(.*)$/.exec(line);
    const field = /^\s+(\w+):\s*(.*)$/.exec(line);
    const top = /^(\w+):\s*(.*)$/.exec(line);
    const value = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (item) {
      file = {};
      info.files.push(file);
      file[item[1]] = value(item[2]);
    } else if (field && file) {
      file[field[1]] = value(field[2]);
    } else if (top) {
      file = null;
      if (top[1] === 'version') info.version = value(top[2]);
    }
  }
  info.files = info.files.filter((f) => f.url && f.sha512).map((f) => ({ url: f.url, sha512: f.sha512, size: Number(f.size) || 0 }));
  return info;
}

// ----------------------------------------------------------------- macOS ----

/** …/Reader.app, the bundle this is running from. */
const macBundle = () => path.resolve(process.execPath, '..', '..', '..');

/** Why the app can't replace itself where it is; null when it can. */
function macReplaceBlocked() {
  const bundle = macBundle();
  if (!bundle.endsWith('.app')) return 'This copy of Reader is not an app bundle.';
  if (bundle.startsWith('/Volumes/')) return 'Reader is running from its disk image: drag it to Applications first.';
  if (bundle.includes('/AppTranslocation/')) return 'macOS is running Reader from a hidden copy: move it to Applications (and open it from there) first.';
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    fs.accessSync(bundle, fs.constants.W_OK);
  } catch {
    return `This user can’t change ${path.dirname(bundle)}.`;
  }
  return null;
}

/** A file from the newest release, to `to`, with its SHA-512 checked; `onProgress` gets the percent. */
async function download(name, sha512, size, to, onProgress) {
  const response = await net.fetch(`${FEED}/${encodeURIComponent(name)}`, { cache: 'no-store' });
  if (!response.ok || !response.body) throw new Error(`Downloading ${name}: ${response.status}`);
  const total = size || Number(response.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha512');
  const out = fs.createWriteStream(to);
  let got = 0;
  let shown = -1;
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      const percent = total ? Math.floor((got / total) * 100) : 0;
      if (percent !== shown) onProgress((shown = percent));
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
  if (hash.digest('base64') !== sha512) {
    fs.rmSync(to, { force: true });
    throw new Error(`${name} isn’t what the release says it is (its SHA-512 differs). Nothing was changed.`);
  }
}

async function checkMac() {
  const response = await net.fetch(`${FEED}/latest-mac.yml`, { cache: 'no-store' });
  if (response.status === 404) return { status: 'current' }; // a release with no update files yet: nothing to update to
  if (!response.ok) throw new Error(`Asking for the newest version: ${response.status}`);
  const info = parseUpdateInfo(await response.text());
  if (!info.version || compareVersions(info.version, app.getVersion()) <= 0) return { status: 'current' };
  if (pendingMac?.version === info.version) return { status: 'ready', available: info.version };
  const zip = info.files.find((file) => file.url.endsWith('.zip'));
  if (!zip) throw new Error(`Reader ${info.version} has no .zip for macOS to update from.`);
  const blocked = macReplaceBlocked();
  if (blocked) return { status: 'manual', available: info.version, error: blocked };

  if (pendingMac) fs.rmSync(pendingMac.dir, { recursive: true, force: true }); // an older one downloaded and not yet put in place
  pendingMac = null;
  const dir = path.join(app.getPath('temp'), `reader-update-${info.version}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'Reader.zip');
  setState({ status: 'downloading', available: info.version, percent: 0 });
  await download(zip.url, zip.sha512, zip.size, file, (percent) => setState({ status: 'downloading', available: info.version, percent }));
  // ditto keeps what a .app needs that unzip may not: its symlinks, permissions and signature.
  const unpacked = path.join(dir, 'app');
  const result = spawnSync('/usr/bin/ditto', ['-x', '-k', file, unpacked], { encoding: 'utf8' });
  const next = path.join(unpacked, 'Reader.app');
  if (result.status !== 0 || !fs.existsSync(path.join(next, 'Contents', 'MacOS', 'Reader'))) throw new Error(`Unpacking Reader ${info.version}: ${result.stderr || 'no Reader.app inside'}`);
  fs.rmSync(file, { force: true });
  if (stopped) return { status: 'idle' };
  pendingMac = { version: info.version, app: next, dir };
  return { status: 'ready', available: info.version };
}

/**
 * Once this app has quit: the new Reader.app in the old one's place (the old one moved aside until the
 * new one is in, and put back if it can't be), then opened when `relaunch`.
 */
function replaceMacOnExit(relaunch) {
  if (!pendingMac) return;
  const script = [
    'while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done',
    'rm -rf "$APP.old"',
    'if mv "$APP" "$APP.old"; then',
    '  if /usr/bin/ditto "$NEW" "$APP"; then rm -rf "$APP.old"; else rm -rf "$APP"; mv "$APP.old" "$APP"; fi',
    'fi',
    // Downloaded by the app, not a browser: there is no quarantine to lift, but a copy carried over is lifted too.
    '/usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null',
    'rm -rf "$DIR"',
    '[ "$RELAUNCH" = 1 ] && /usr/bin/open "$APP"',
    'exit 0',
  ].join('\n');
  spawn('/bin/sh', ['-c', script], {
    detached: true,
    stdio: 'ignore',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', PID: String(process.pid), APP: macBundle(), NEW: pendingMac.app, DIR: pendingMac.dir, RELAUNCH: relaunch ? '1' : '0' },
  }).unref();
  pendingMac = null;
}

// ------------------------------------------------------- Windows, Linux ----

function loadUpdater() {
  if (updater) return updater;
  ({ autoUpdater: updater } = require('electron-updater'));
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowDowngrade = false;
  updater.logger = null;
  updater.on('download-progress', (progress) => setState({ status: 'downloading', available: state.available, percent: Math.floor(progress.percent || 0) }));
  return updater;
}

async function checkOthers() {
  const up = loadUpdater();
  const result = await up.checkForUpdates();
  const available = result?.updateInfo?.version;
  if (!result || !available || compareVersions(available, app.getVersion()) <= 0) return { status: 'current' };
  setState({ status: 'downloading', available, percent: 0 });
  await (result.downloadPromise ?? Promise.resolve());
  return { status: 'ready', available };
}

// ------------------------------------------------------------- together ----

/** Asks for the newest version, downloads it, and, when it is ready, offers to restart into it. */
function checkForUpdates({ manual = false } = {}) {
  if (stopped) return Promise.resolve(state);
  if (manual) asked = true;
  if (!updatable()) {
    setState(notUpdatable());
    if (manual) void tellNothing();
    return Promise.resolve(state);
  }
  if (state.status === 'ready') {
    if (manual) void offerRestart(state.available);
    return Promise.resolve(state);
  }
  if (busy) return busy;
  setState({ status: 'checking' });
  busy = (process.platform === 'darwin' ? checkMac() : checkOthers())
    .then((found) => {
      setState(found);
      if (found.status === 'ready') void offerRestart(found.available);
      else if (asked) void tellNothing();
    })
    .catch((error) => {
      setState({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
      if (asked) void tellNothing();
    })
    .finally(() => {
      busy = null;
      asked = false;
    })
    .then(() => state);
  return busy;
}

/** What a check someone asked for found, when it was not a new version ready to go. */
async function tellNothing() {
  if (state.status === 'current') {
    await ask({ type: 'info', message: 'Reader is up to date', detail: `This is the newest version, ${app.getVersion()}.`, buttons: ['OK'] });
    return;
  }
  const { response } = await ask({
    type: state.status === 'failed' ? 'warning' : 'info',
    message: state.status === 'manual' ? `Reader ${state.available} is out` : state.status === 'failed' ? 'Couldn’t check for a new version' : 'Reader can’t update itself here',
    detail: `${state.error ?? ''}\n\nEvery version, for every system, is on the releases page.`.trim(),
    buttons: ['Open the releases page', 'OK'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) void shell.openExternal(state.status === 'manual' ? `${RELEASES}/latest` : RELEASES);
}

/** A message box over the window in front, if there is one. */
function ask(options) {
  const parent = BrowserWindow.getFocusedWindow();
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

let offering = false;
async function offerRestart(version) {
  if (offering) return;
  offering = true;
  try {
    const { response } = await ask({
      type: 'info',
      message: `Reader ${version} is ready`,
      detail: `You have ${app.getVersion()}. Restart now to use the new version, or it is put in place the next time you quit Reader.${process.platform === 'darwin' ? '\n\nIf meeting notes stop recording afterwards, switch Reader off and on again in System Settings → Privacy & Security (an unsigned app is new to macOS each time).' : ''}`,
      buttons: ['Restart Now', 'Later', 'What’s New'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) installNow();
    if (response === 2) void shell.openExternal(`${RELEASES}/tag/app-v${version}`);
  } finally {
    offering = false;
  }
}

/** Quits into the new version. */
function installNow() {
  if (state.status !== 'ready') return;
  if (process.platform === 'darwin') {
    replaceMacOnExit(true);
    app.quit();
  } else {
    // isSilent, isForceRunAfter: the setup .exe runs with no wizard and opens Reader when it is done.
    setImmediate(() => loadUpdater().quitAndInstall(true, true));
  }
}

/** As the app quits: a downloaded version put in place (electron-updater does this itself elsewhere). */
function installOnQuit() {
  if (process.platform === 'darwin' && pendingMac) replaceMacOnExit(false);
}

/** Nothing put in place as the app quits, and no more checks: Reader is being uninstalled. */
function cancelUpdates() {
  stopped = true;
  if (pendingMac) fs.rmSync(pendingMac.dir, { recursive: true, force: true });
  pendingMac = null;
  if (updater) updater.autoInstallOnAppQuit = false;
}

/** Checks a while after the app opens and every few hours; the page asks with `updates:*`, from `site` only. */
function setUpUpdates({ site }) {
  siteOrigin = site;
  const fromSite = (event) => {
    try {
      return new URL(event.senderFrame?.url || event.sender.getURL()).origin === siteOrigin;
    } catch {
      return false;
    }
  };
  ipcMain.handle('updates:state', (event) => (fromSite(event) ? state : null));
  ipcMain.handle('updates:check', (event) => (fromSite(event) ? checkForUpdates({ manual: true }) : null));
  ipcMain.handle('updates:install', (event) => {
    if (fromSite(event)) installNow();
    return null;
  });
  if (!updatable()) return setState(notUpdatable());
  setTimeout(() => void checkForUpdates(), FIRST_CHECK);
  setInterval(() => void checkForUpdates(), EVERY).unref?.();
}

module.exports = { setUpUpdates, checkForUpdates, installOnQuit, cancelUpdates, compareVersions, parseUpdateInfo, download, RELEASES };
