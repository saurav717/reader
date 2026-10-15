// Reader as a desktop app: the reader in a window of its own, with no browser
// needed or looked for. Electron carries its own engine, so the page runs the
// same here on every system, Google sign-in included, and reaches the Companion
// on 127.0.0.1 as it does in Chrome.
//
// The first time it opens (and after an update that brings a newer Companion)
// it sets the Reader Companion up from what is inside the app (resources/companion:
// uv and the Companion's wheel, see scripts/prepare-companion.mjs) and runs
// `reader-companion setup --no-app --print-url`: the Jupyter server at every
// login, the VS Code extension, and the page paired. Every time after it runs
// `reader-companion open --print-url`: the Companion started if it isn't running.
// Either way the address it prints opens in this window.
//
// Uninstall Reader… (the Reader menu on macOS, Help elsewhere, `reader --uninstall`,
// or the system's own uninstaller on Windows, build/installer.nsh) takes it all away again.

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, session } = require('electron');
const { setUpNotes, stopNotes } = require('./notes');
const { setUpUpdates, checkForUpdates, installOnQuit, cancelUpdates, RELEASES } = require('./updates');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomBytes } = require('node:crypto');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const HOME = os.homedir();
const RESOURCES = app.isPackaged ? path.join(process.resourcesPath, 'companion') : path.join(__dirname, 'companion');
const INFO = readJson(path.join(RESOURCES, 'info.json')) ?? {};
const SITE = INFO.site || 'https://saurav717.github.io/reader/';
const SITE_ORIGIN = new URL(SITE).origin;
const COMPANION_HOME = process.env.READER_COMPANION_HOME || path.join(HOME, '.reader-companion');
const UV_EXE = IS_WIN ? 'uv.exe' : 'uv';
const COMPANION_EXE = IS_WIN ? 'reader-companion.exe' : 'reader-companion';

app.setName('Reader');
// Google turns sign-in down in what it takes for an embedded browser; the page is the
// same one Chrome shows, so it gets Chrome's name for itself, without Electron's word.
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|reader)\/\S+/gi, '');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ where things are ----

/** What the Companion records as the app, and watches: deleted, the Companion stops starting at login. */
function appLocation() {
  if (IS_MAC) return path.resolve(process.execPath, '..', '..', '..'); // …/Reader.app
  if (process.env.APPIMAGE) return process.env.APPIMAGE; // the file, not where it is mounted for this run
  return process.execPath;
}

/** `reader-companion`, where `uv tool install` put it (remembered after setup), else where it usually does. */
function companionPath() {
  const remembered = readJson(statePath())?.companion;
  if (remembered && fs.existsSync(remembered)) return remembered;
  return path.join(HOME, '.local', 'bin', COMPANION_EXE);
}

const statePath = () => path.join(app.getPath('userData'), 'state.json');

function remember(values) {
  const next = { ...(readJson(statePath()) ?? {}), ...values };
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(next, null, 2));
}

/** The environment the Companion runs with: the login shell's PATH (an app starts with a short one), uv's own Python, and this app. */
let environment;
function companionEnv() {
  if (environment) return environment;
  const env = { ...process.env };
  if (!IS_WIN) {
    const shellPath = spawnSync(process.env.SHELL || (IS_MAC ? '/bin/zsh' : '/bin/sh'), ['-lc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5000 });
    if (shellPath.status === 0 && shellPath.stdout.trim()) env.PATH = shellPath.stdout.trim();
    env.PATH = `${path.join(HOME, '.local', 'bin')}:${env.PATH}`;
  }
  // uv's own Python, never the system's: on a Mac without Xcode's tools /usr/bin/python3 asks to install them.
  env.UV_PYTHON_PREFERENCE = 'only-managed';
  // …kept with the Companion's own things rather than in uv's shared folder, so Uninstall can take it away.
  // (~/Reader/.venv is made from it: it goes only with your files.)
  env.UV_PYTHON_INSTALL_DIR = path.join(COMPANION_HOME, 'python');
  env.UV = path.join(COMPANION_HOME, 'bin', UV_EXE);
  // …installed from the copy inside the app (scripts/prepare-companion.mjs), not downloaded from GitHub.
  if (INFO.python) env.UV_PYTHON_INSTALL_MIRROR = pathToFileURL(path.join(RESOURCES, INFO.python)).href;
  // The Companion's packages still come from PyPI: uv gives up on a download that goes quiet for 30 seconds,
  // too soon on a slow or busy connection.
  env.UV_HTTP_TIMEOUT ||= '300';
  env.READER_APP = appLocation();
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUNBUFFERED = '1';
  delete env.ELECTRON_RUN_AS_NODE;
  environment = env;
  return env;
}

/** Runs a program, handing each line it prints to `onLine`. Resolves with its exit code (or -1 when it couldn't start). */
function run(command, args, onLine = () => {}, { timeout = 15 * 60_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd: HOME, env: companionEnv(), windowsHide: true });
    } catch (error) {
      onLine(`${command}: ${error.message}`);
      resolve(-1);
      return;
    }
    const timer = setTimeout(() => child.kill(), timeout);
    let rest = '';
    const take = (chunk) => {
      const lines = (rest + chunk.toString('utf8')).split(/\r?\n/);
      rest = lines.pop();
      // eslint-disable-next-line no-control-regex
      for (const line of lines) onLine(line.replace(/\u001b\[[0-9;]*m/g, ''));
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (error) => {
      onLine(`${command}: ${error.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (rest) onLine(rest);
      resolve(code ?? -1);
    });
  });
}

function isOlder(version, than) {
  const parts = (value) => String(value).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(version);
  const b = parts(than);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/** The installed Companion's version, from `reader-companion --version`; null when there is none. */
function installedVersion() {
  const exe = companionPath();
  if (!fs.existsSync(exe)) return null;
  const result = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (result.status !== 0) return null;
  return (result.stdout || '').trim().split(/\s+/).pop() || null;
}

// ---------------------------------------------------------- the Companion ----

/**
 * The address to show: from `open --print-url`, or from `setup` when the Companion isn't installed
 * here or this app brings a newer one. One the site updated (Settings → This computer → Update) can be
 * newer than the app's: that one is kept. `say` gets the status and each line printed.
 */
async function companionAddress(say) {
  const installed = installedVersion();
  if (installed && !isOlder(installed, INFO.version || '0')) {
    say({ status: 'Starting Reader…' });
    let url = null;
    const code = await run(companionPath(), ['open', '--print-url'], (line) => {
      if (line.startsWith('READER_URL=')) url = line.slice('READER_URL='.length).trim();
      else say({ line });
    });
    if (code === 0 && url) return url;
    throw new Error('The Reader Companion didn’t start.');
  }
  return setUp(say);
}

/** Installs the Companion from the wheel inside the app, with the uv inside the app, then runs `setup`. */
async function setUp(say) {
  say({ status: INFO.version ? `Setting up Reader (Companion ${INFO.version})…` : 'Setting up Reader…', setup: true });
  say({ line: 'Reader runs your code on this computer: a Jupyter server in the background, your files in ~/Reader.' });
  say({ line: 'The first time takes a minute or two: it installs its own Python and the Companion’s packages.\n' });
  // Our own copy of uv, outside the app: it stays put when the app is moved or updated, and on a Mac
  // it doesn't carry the "downloaded from the internet" mark, which would stop it on its own.
  const uv = path.join(COMPANION_HOME, 'bin', UV_EXE);
  fs.mkdirSync(path.dirname(uv), { recursive: true });
  fs.copyFileSync(path.join(RESOURCES, UV_EXE), uv);
  if (!IS_WIN) fs.chmodSync(uv, 0o755);
  if (IS_MAC) spawnSync('xattr', ['-c', uv]);

  // Python, from inside the app; then the Companion, whose packages come from PyPI: tried again when a download drops.
  // 3.12: a brand-new Python may not have every wheel the Companion needs yet (pywinpty, on Windows).
  const wheel = path.join(RESOURCES, INFO.wheel || '');
  const steps = [
    ['Installing Python…', ['python', 'install', '3.12'], 'Installing Python didn’t finish.'],
    ['Installing the Reader Companion…', ['tool', 'install', '--force', '--python', '3.12', '--from', wheel, 'reader-companion'], 'Installing the Reader Companion didn’t finish.'],
  ];
  for (const [line, args, failed] of steps) {
    say({ line });
    for (let attempt = 1; ; attempt += 1) {
      if ((await run(uv, args, (text) => say({ line: text }))) === 0) break;
      if (attempt === 3) throw new Error(`${failed} Check your connection (a VPN, proxy or firewall can stop it), then try again.`);
      say({ line: '\nThat didn’t finish. Trying again…' });
    }
  }
  const bin = spawnSync(uv, ['tool', 'dir', '--bin'], { encoding: 'utf8', env: companionEnv(), windowsHide: true }).stdout?.trim();
  const exe = bin ? path.join(bin, COMPANION_EXE) : companionPath();
  remember({ companion: exe });

  let url = null;
  const code = await run(exe, ['setup', '--site', SITE, '--no-app', '--print-url'], (line) => {
    if (line.startsWith('READER_URL=')) url = line.slice('READER_URL='.length).trim();
    else say({ line });
  });
  if (code !== 0 || !url) throw new Error('Setting up didn’t finish.');
  say({ status: 'Reader is set up.', line: '\nDone. From now on, open Reader like any app: it starts the Companion each time.' });
  return url;
}

// --------------------------------------------------------------- windows ----

/** Pages of the site, the Companion's own (Jupyter, VS Code) and Google's sign-in stay in the app; anything else opens in the browser. */
function staysInApp(url) {
  try {
    const { origin, hostname, protocol } = new URL(url);
    if (origin === SITE_ORIGIN) return true;
    if ((protocol === 'http:' || protocol === 'https:') && (hostname === '127.0.0.1' || hostname === 'localhost')) return true;
    return hostname === 'accounts.google.com';
  } catch {
    return false;
  }
}

const isLocal = (url) => url.startsWith('file:');

const windowBoundsPath = () => path.join(app.getPath('userData'), 'window.json');

function windowOptions(extra = {}) {
  const saved = readJson(windowBoundsPath()) ?? {};
  return {
    width: saved.width || 1280,
    height: saved.height || 840,
    ...(Number.isFinite(saved.x) && Number.isFinite(saved.y) ? { x: saved.x, y: saved.y } : {}),
    minWidth: 720,
    minHeight: 480,
    title: 'Reader',
    backgroundColor: '#fbfaf6',
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    ...extra,
  };
}

/** What a window may open and go to. A popup (Google's sign-in) may go anywhere on https: sign-in passes through Google's other addresses. */
function guard(win, { popup = false } = {}) {
  const contents = win.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('blob:') || url === 'about:blank' || staysInApp(url)) {
      // Google's sign-in popup answers its opener: it has to be a window of this app.
      return { action: 'allow', overrideBrowserWindowOptions: { backgroundColor: '#ffffff', autoHideMenuBar: true, icon: path.join(__dirname, 'build', 'icon.png') } };
    }
    if (/^(https?|mailto):/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (isLocal(contents.getURL()) || staysInApp(url) || (popup && url.startsWith('https:'))) return;
    event.preventDefault();
    if (/^(https?|mailto):/.test(url)) void shell.openExternal(url);
  });
  contents.on('did-create-window', (child) => guard(child, { popup: true }));
  // No connection: a page that says so, with Try again, rather than an empty window.
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (popup || !isMainFrame || code === -3 || !/^https?:/.test(url)) return; // -3: a load that was replaced by another
    void win.loadFile(path.join(__dirname, 'ui', 'offline.html'), { query: { url, error: description } });
  });
}

let main = null;

function sitePreload() {
  return { preload: path.join(__dirname, 'preload-site.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true };
}

/** Remembers where the window was, for next time, and forgets it as the main window once it closes. */
function keep(win) {
  win.on('close', () => {
    if (win.isMaximized() || win.isFullScreen()) return;
    try {
      fs.writeFileSync(windowBoundsPath(), JSON.stringify(win.getBounds()));
    } catch {
      // not worth stopping for
    }
  });
  win.on('closed', () => {
    if (main === win) main = null;
  });
}

/** The start page's window: it alone has preload-ui.js, which the site's pages never get. */
function createMainWindow() {
  const win = new BrowserWindow(windowOptions({ webPreferences: { ...sitePreload(), preload: path.join(__dirname, 'preload-ui.js') } }));
  guard(win);
  keep(win);
  win.once('ready-to-show', () => win.show());
  return win;
}

/** The window: the start page while the Companion sets up or starts, then the site. */
async function openReader() {
  main = createMainWindow();
  const win = main;
  await win.loadFile(path.join(__dirname, 'ui', 'start.html'));
  const say = (message) => {
    if (!win.isDestroyed()) win.webContents.send('start:progress', message);
  };
  let url;
  try {
    url = await companionAddress(say);
  } catch (error) {
    say({ failed: error.message || String(error) });
    return;
  }
  if (!win.isDestroyed()) await showSite(win, url);
}

/** The site, in a window of its own in the start page's place: its pages get only preload-site.js (that this is the app), no Node and no start-page messages. */
async function showSite(win, url) {
  const site = new BrowserWindow(windowOptions({ ...win.getBounds(), show: false, webPreferences: sitePreload() }));
  guard(site);
  keep(site);
  await site.loadURL(url).catch(() => undefined);
  if (win.isMaximized()) site.maximize();
  site.show();
  main = site;
  win.destroy();
}

// ------------------------------------------------------- Google sign-in ----

// Google turns sign-in down inside an app's own window ("This browser or app may not be secure"), whatever it
// is called. So the site's sign-in (src/lib/google.ts) asks here, and the browser signs in: the site's
// app-sign-in page there, Google's usual popup, then a reader-app://google-token link back with the token
// and the `state` it was opened with. One sign-in waits at a time; a newer one is the one answered.
const PROTOCOL = 'reader-app';
let signingIn = null; // { state, resolve, timer }

function endSignIn(answer) {
  if (!signingIn) return;
  clearTimeout(signingIn.timer);
  signingIn.resolve(answer);
  signingIn = null;
}

ipcMain.handle('google:token', (event, request) => {
  const from = event.senderFrame?.url || '';
  if (!from.startsWith(SITE_ORIGIN + '/')) return { error: 'access_denied', error_description: 'Not the Reader site.' };
  const { clientId = '', scope = '', prompt = '', hint = '' } = request ?? {};
  endSignIn({ error: 'popup_closed' });
  const state = randomBytes(24).toString('base64url');
  const page = new URL('app-sign-in/', SITE);
  for (const [key, value] of Object.entries({ state, client_id: String(clientId), scope: String(scope), prompt: String(prompt), hint: String(hint) })) {
    if (value) page.searchParams.set(key, value);
  }
  return new Promise((resolve) => {
    signingIn = { state, resolve, timer: setTimeout(() => endSignIn({ error: 'popup_closed' }), 10 * 60_000) };
    void shell.openExternal(page.href);
  });
});

// A Companion connected to another Google account pairs only with a page signed in as it: the account
// that first paired it on this computer, maybe long ago, through the site. The person at this computer can
// hand it to the account they are signed in as, as `reader-companion release` in a terminal would: so can the
// site's pages in this app, for this computer's own Companion only (its id), when the person says so.
ipcMain.handle('companion:release', async (event, id) => {
  const from = event.senderFrame?.url || '';
  if (!from.startsWith(SITE_ORIGIN + '/')) return { ok: false, error: 'Not the Reader site.' };
  const mine = readJson(path.join(COMPANION_HOME, 'config.json'))?.id;
  if (!mine || mine !== id) return { ok: false, error: 'That Companion isn’t this computer’s.' };
  const said = [];
  const code = await run(companionPath(), ['release'], (line) => said.push(line), { timeout: 60_000 });
  return code === 0 ? { ok: true } : { ok: false, error: said.filter(Boolean).pop() || 'The Companion didn’t let go of the account.' };
});

/** A reader-app:// link the browser opened: the sign-in's answer, when its state is the one waiting. */
function openedLink(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return;
  }
  if (url.protocol !== `${PROTOCOL}:` || url.hostname !== 'google-token' || !signingIn) return;
  const values = url.searchParams;
  if (values.get('state') !== signingIn.state) return;
  const expires = Number.parseInt(values.get('expires_in') || '', 10);
  endSignIn(
    values.get('access_token')
      ? { access_token: values.get('access_token'), expires_in: Number.isFinite(expires) ? expires : 3600, scope: values.get('scope') || '' }
      : { error: values.get('error') || 'access_denied', error_description: values.get('error_description') || '' },
  );
  const win = main ?? BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

// macOS hands the link to the running app; Windows and Linux start a second one with it (second-instance below).
app.on('open-url', (event, link) => {
  event.preventDefault();
  openedLink(link);
});

ipcMain.on('start:retry', () => {
  const old = main;
  // openReader makes its window before it waits for anything: there is always one open.
  void openReader();
  old?.destroy();
});

ipcMain.on('start:without', async () => {
  // Reader works without the Companion; only running code on this computer needs it.
  if (main) await showSite(main, `${SITE}#app=1`);
});

ipcMain.on('start:log', () => {
  void shell.openPath(path.join(COMPANION_HOME, 'companion.log'));
});

function newWindow() {
  const win = new BrowserWindow(windowOptions({ x: undefined, y: undefined, webPreferences: sitePreload() }));
  guard(win);
  win.once('ready-to-show', () => win.show());
  void win.loadURL(SITE);
}

// -------------------------------------------------------------- uninstall ----

/** Where the Companion keeps your files: its settings say, else ~/Reader. */
function filesFolder() {
  const root = readJson(path.join(COMPANION_HOME, 'config.json'))?.root || '~/Reader';
  return path.resolve(root.replace(/^~(?=$|[\\/])/, HOME));
}

let uninstallWindow = null;

function openUninstall() {
  if (uninstallWindow) return uninstallWindow.focus();
  uninstallWindow = new BrowserWindow({
    width: 480,
    height: 540,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Uninstall Reader',
    backgroundColor: '#fbfaf6',
    icon: path.join(__dirname, 'build', 'icon.png'),
    parent: main ?? undefined,
    modal: Boolean(main) && !IS_WIN,
    show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload-ui.js'), contextIsolation: true, sandbox: true },
  });
  uninstallWindow.once('ready-to-show', () => uninstallWindow.show());
  uninstallWindow.on('closed', () => {
    uninstallWindow = null;
    if (!main) app.quit();
  });
  void uninstallWindow.loadFile(path.join(__dirname, 'ui', 'uninstall.html'));
}

ipcMain.handle('uninstall:details', () => ({
  files: filesFolder(),
  settings: COMPANION_HOME,
  platform: process.platform,
  packaged: app.isPackaged,
}));

ipcMain.on('uninstall:cancel', () => uninstallWindow?.close());

/** How this copy was installed on Linux: an AppImage, a .deb, an .rpm, or by hand. */
function linuxPackage() {
  if (process.env.APPIMAGE) return 'appimage';
  if (fs.existsSync('/var/lib/dpkg/info/reader.list')) return 'deb';
  if (spawnSync('rpm', ['-q', 'reader'], { stdio: 'ignore' }).status === 0) return 'rpm';
  return null;
}

ipcMain.handle('uninstall:run', async (_event, { vscode = true, deleteFiles = false } = {}) => {
  cancelUpdates(); // a new version downloaded is not put back as the app quits
  const lines = [];
  const say = (line) => {
    lines.push(line);
    uninstallWindow?.webContents.send('uninstall:progress', line);
  };
  // 1. The Companion: stopped, no longer started at login, its links gone (and the extension, the files, if asked).
  const exe = companionPath();
  if (fs.existsSync(exe)) {
    await run(exe, ['uninstall', ...(vscode ? ['--vscode'] : []), ...(deleteFiles ? ['--delete-files'] : [])], say, { timeout: 120_000 });
  }
  // 2. The Companion program itself, with the uv inside the app.
  const uv = path.join(RESOURCES, UV_EXE);
  if (fs.existsSync(uv)) await run(uv, ['tool', 'uninstall', 'reader-companion'], say, { timeout: 120_000 });
  // 3. Our copy of uv, and with the files everything the Companion and this app kept here.
  fs.rmSync(path.join(COMPANION_HOME, 'bin'), { recursive: true, force: true });
  let afterExit = [];
  if (deleteFiles) {
    fs.rmSync(COMPANION_HOME, { recursive: true, force: true });
    // What Reader keeps in this app: cleared now, and its folder deleted once the app has quit (Electron
    // writes to it until the very end).
    await session.defaultSession.clearStorageData().catch(() => undefined);
    afterExit = [app.getPath('userData'), ...(fs.existsSync(COMPANION_HOME) ? [COMPANION_HOME] : [])];
    say('What Reader keeps in this app (a library not in Google Drive, sign-ins) is deleted as it closes.');
  }
  removeLinuxEntries();
  // 4. The app.
  if (!app.isPackaged) {
    say('Not installed (run from source): the app itself stays.');
    return { done: true, lines, quit: true };
  }
  if (IS_MAC) {
    try {
      await shell.trashItem(appLocation());
      say('Moved Reader to the Bin.');
    } catch (error) {
      say(`Couldn’t move Reader to the Bin (${error.message}): drag it there from Applications.`);
    }
  } else if (IS_WIN) {
    // The system's uninstaller, silently: it removes the files, the shortcuts and the entry in
    // Settings → Apps (and does steps 1–3 again, which find nothing left). It waits for this app to quit.
    // (ping is the wait: timeout won't run without a console.)
    const uninstaller = path.join(path.dirname(process.execPath), 'Uninstall Reader.exe');
    const steps = ['ping -n 4 127.0.0.1 >nul', `"${uninstaller}" /S`, ...afterExit.map((dir) => `rmdir /s /q "${dir}"`)];
    spawn('cmd.exe', ['/d', '/s', '/c', `"${steps.join(' & ')}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
    say('Removing the app…');
    return { done: true, lines, quit: true, soon: true };
  } else {
    const kind = linuxPackage();
    if (kind === 'appimage') {
      fs.rmSync(process.env.APPIMAGE, { force: true });
      say(`Deleted ${process.env.APPIMAGE}.`);
    } else if (kind === 'deb' || kind === 'rpm') {
      const command = kind === 'deb' ? ['apt-get', 'remove', '-y', 'reader'] : ['rpm', '-e', 'reader'];
      say(`Removing the package (it asks for your password): sudo ${command.join(' ')}`);
      const code = await run('pkexec', command, say, { timeout: 300_000 });
      if (code !== 0) say(`It wasn’t removed. In a terminal: sudo ${command.join(' ')}`);
    } else {
      say(`Delete the folder Reader is in to finish: ${path.dirname(process.execPath)}`);
    }
  }
  if (afterExit.length) {
    spawn('/bin/sh', ['-c', 'sleep 3; rm -rf "$@"', 'sh', ...afterExit], { detached: true, stdio: 'ignore' }).unref();
  }
  return { done: true, lines, quit: true };
});

ipcMain.on('uninstall:quit', () => app.quit());

// --------------------------------------------------------------- Linux ----

const applications = () => path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'applications');
const AppImageEntry = 'reader-app.desktop';

/** An AppImage puts itself in the applications menu (packages have their own entry): Reader, and Uninstall Reader beside it. */
function integrateAppImage() {
  if (process.platform !== 'linux' || !process.env.APPIMAGE) return;
  try {
    const icons = path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'icons', 'hicolor', '512x512', 'apps');
    fs.mkdirSync(icons, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'build', 'icon.png'), path.join(icons, 'reader-app.png'));
    const exec = `"${process.env.APPIMAGE.replace(/"/g, '\\"')}"`;
    fs.mkdirSync(applications(), { recursive: true });
    fs.writeFileSync(
      path.join(applications(), AppImageEntry),
      `[Desktop Entry]\nType=Application\nName=Reader\nComment=Read research papers, keep notes and run code on this computer\nExec=${exec} %U\nIcon=reader-app\nTerminal=false\nCategories=Education;Science;\nStartupWMClass=reader\nMimeType=x-scheme-handler/reader-app;\nActions=Uninstall;\n\n[Desktop Action Uninstall]\nName=Uninstall Reader\nExec=${exec} --uninstall\n`,
    );
    fs.writeFileSync(
      path.join(applications(), 'reader-app-uninstall.desktop'),
      `[Desktop Entry]\nType=Application\nName=Uninstall Reader\nExec=${exec} --uninstall\nIcon=reader-app\nTerminal=false\nCategories=Education;\n`,
    );
  } catch {
    // the menu entry is a convenience
  }
}

function removeLinuxEntries() {
  if (process.platform !== 'linux') return;
  for (const name of [AppImageEntry, 'reader-app-uninstall.desktop']) fs.rmSync(path.join(applications(), name), { force: true });
  fs.rmSync(path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'icons', 'hicolor', '512x512', 'apps', 'reader-app.png'), { force: true });
}

// ------------------------------------------------------------------ menu ----

function focused() {
  return BrowserWindow.getFocusedWindow() ?? main;
}

function buildMenu() {
  const uninstall = { label: 'Uninstall Reader…', click: openUninstall };
  const update = { label: 'Check for Updates…', click: () => void checkForUpdates({ manual: true }) };
  const template = [
    ...(IS_MAC
      ? [
          {
            label: 'Reader',
            submenu: [{ role: 'about', label: 'About Reader' }, update, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, uninstall, { type: 'separator' }, { role: 'quit' }],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [{ label: 'New Window', accelerator: 'CmdOrCtrl+N', click: newWindow }, { type: 'separator' }, IS_MAC ? { role: 'close' } : { role: 'quit' }],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    {
      label: 'Go',
      submenu: [
        { label: 'Back', accelerator: IS_MAC ? 'Cmd+[' : 'Alt+Left', click: () => focused()?.webContents.navigationHistory.goBack() },
        { label: 'Forward', accelerator: IS_MAC ? 'Cmd+]' : 'Alt+Right', click: () => focused()?.webContents.navigationHistory.goForward() },
        { label: 'Home', accelerator: 'CmdOrCtrl+Shift+H', click: () => focused()?.loadURL(SITE) },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Reader on the Web', click: () => shell.openExternal(SITE) },
        { label: 'Show the Companion’s Log', click: () => shell.openPath(path.join(COMPANION_HOME, 'companion.log')) },
        { label: 'Every Version of Reader', click: () => shell.openExternal(RELEASES) },
        ...(IS_MAC ? [] : [{ type: 'separator' }, update, uninstall, { type: 'separator' }, { role: 'about', label: 'About Reader' }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------------ start ----

const uninstallOnly = process.argv.includes('--uninstall');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--uninstall')) return openUninstall();
    const link = argv.find((arg) => arg.startsWith(`${PROTOCOL}:`));
    if (link) return openedLink(link);
    const win = main ?? BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    } else void openReader();
  });

  // reader-app:// links open this app (from a development checkout, with its own script to run).
  if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
  else if (process.argv[1]) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);

  app.whenReady().then(() => {
    app.setAboutPanelOptions({ applicationName: 'Reader', applicationVersion: app.getVersion(), copyright: 'saurav717', website: SITE, iconPath: path.join(__dirname, 'build', 'icon.png') });
    // The site and the Companion get what they ask for (the clipboard, notifications, the
    // computer's own network for 127.0.0.1); nothing else is asked for, and nothing else gets it.
    const trusted = (url) => Boolean(url) && staysInApp(url);
    session.defaultSession.setPermissionRequestHandler((contents, _permission, callback, details) => callback(trusted(details.requestingUrl || contents.getURL())));
    session.defaultSession.setPermissionCheckHandler((_contents, _permission, origin) => trusted(origin));
    buildMenu();
    integrateAppImage();
    // Meeting notes on this computer (notes.js): for the site's pages only.
    setUpNotes({ siteOrigin: SITE_ORIGIN });
    // Updates (updates.js): checked a while after opening and every few hours; not when only uninstalling.
    if (!uninstallOnly) setUpUpdates({ site: SITE_ORIGIN });
    if (uninstallOnly) openUninstall();
    else void openReader();
  });

  app.on('activate', () => {
    if (!uninstallWindow && BrowserWindow.getAllWindows().length === 0) void openReader();
  });

  // A recording on is stopped, so it is uploaded whole, and the recorder's own process ends with the app.
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void stopNotes().finally(() => app.quit());
  });

  // A new version downloaded and not restarted into goes in as the app quits (macOS; electron-updater does it elsewhere).
  app.on('will-quit', () => {
    if (!uninstallOnly) installOnQuit();
  });

  app.on('window-all-closed', () => {
    if (!IS_MAC || uninstallOnly) app.quit();
  });
}
