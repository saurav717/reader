// Meeting notes taken on this computer, with no bot in the call: Recall.ai's
// Desktop Recording SDK, run by the app. The SDK finds a Zoom, Meet, Teams or
// Slack meeting open on the computer and records its sound (the computer's and
// the microphone), sending what is said back as it is said. This file is the
// app's side: it starts the SDK, records and stops when the site's page asks,
// and passes the SDK's events to the page — which matches the meeting to its
// calendar event, writes the notes up and files them in the project
// (src/lib/notetaker.ts). Nothing of the meeting is kept by the app.
//
// Only the site's own pages may ask (their origin is checked on every call),
// and only on macOS and Windows, the SDK's systems; elsewhere the page is
// told the recorder is not here. Every recording needs an upload token, which
// the page gets from the Worker (worker/meetings.js) with the site's Recall key:
// the key is never in the app.

const { BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');

const SUPPORTED = process.platform === 'darwin' || process.platform === 'win32';
/** The SDK's API address: one of Recall's regions, on https, nothing else. */
const RECALL_URL = /^https:\/\/[\w.-]+\.recall\.ai$/;
/** The SDK's ids for meetings and audio sources, as they come back from it. */
const WINDOW_ID = /^[\w.:-]{1,200}$/;
const PERMISSIONS = new Set(['accessibility', 'screen-capture', 'microphone', 'system-audio', 'full-disk-access']);
/** Where each permission's switch is in System Settings → Privacy & Security, on macOS. */
const SETTINGS_PANES = {
  microphone: 'Privacy_Microphone',
  'screen-capture': 'Privacy_ScreenCapture',
  'system-audio': 'Privacy_ScreenCapture',
  accessibility: 'Privacy_Accessibility',
  'full-disk-access': 'Privacy_AllFiles',
};

/** System Settings → Privacy & Security, at one of its pages (SETTINGS_PANES); `open` when Electron can't. */
function openSettings(pane) {
  const url = `x-apple.systempreferences:com.apple.preference.security?${pane}`;
  shell.openExternal(url).catch(() => {
    try {
      spawn('/usr/bin/open', [url], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      // nowhere else to turn
    }
  });
}

let sdk = null;
let enabled = null;
/** Meetings found and not yet closed: a page opened after they were found is told of them too. */
const meetings = new Map();
const recording = new Set();

/**
 * Wires the recorder to the app: `siteOrigin` is the only origin whose pages
 * may use it.
 */
function setUpNotes({ siteOrigin }) {
  const fromSite = (event) => {
    try {
      return new URL(event.senderFrame?.url || event.sender.getURL()).origin === siteOrigin;
    } catch {
      return false;
    }
  };
  /** An event to every window showing the site. */
  const tell = (message) => {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (new URL(win.webContents.getURL()).origin === siteOrigin) win.webContents.send('notes:event', message);
      } catch {
        // a window between pages
      }
    }
  };
  const handle = (channel, run) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (!fromSite(event)) return { ok: false, error: 'not from the site' };
      if (!SUPPORTED) return { ok: false, error: 'Recording meetings needs macOS or Windows.' };
      try {
        return await run(...args);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

  const windowOf = (window) => ({ id: String(window?.id ?? ''), ...(window?.title ? { title: String(window.title) } : {}), ...(window?.url ? { url: String(window.url) } : {}), ...(window?.platform ? { platform: String(window.platform) } : {}) });

  function listen() {
    sdk.addEventListener('meeting-detected', ({ window }) => {
      meetings.set(window.id, windowOf(window));
      tell({ type: 'meeting-detected', window: windowOf(window) });
    });
    sdk.addEventListener('meeting-updated', ({ window }) => {
      meetings.set(window.id, windowOf(window));
      tell({ type: 'meeting-updated', window: windowOf(window) });
    });
    sdk.addEventListener('meeting-closed', ({ window }) => {
      meetings.delete(window.id);
      tell({ type: 'meeting-closed', window: windowOf(window) });
    });
    sdk.addEventListener('recording-started', ({ window }) => {
      recording.add(window.id);
      tell({ type: 'recording-started', window: windowOf(window) });
    });
    sdk.addEventListener('recording-ended', ({ window }) => {
      recording.delete(window.id);
      tell({ type: 'recording-ended', window: windowOf(window) });
    });
    sdk.addEventListener('realtime-event', ({ window, event, data }) => {
      // What is said, a stretch at a time (`transcript.data`): the words and who said them, nothing else.
      if (event !== 'transcript.data' || !data?.data) return;
      const { words, participant } = data.data;
      tell({
        type: 'transcript',
        window: windowOf(window),
        data: {
          words: Array.isArray(words) ? words.map((word) => ({ text: String(word?.text ?? ''), start_timestamp: { relative: Number(word?.start_timestamp?.relative) || 0 } })) : [],
          participant: participant ? { id: participant.id, name: participant.name ?? null, is_host: Boolean(participant.is_host) } : undefined,
        },
      });
    });
    sdk.addEventListener('permission-status', ({ permission, granted, status }) => tell({ type: 'permission', permission, granted, status }));
    sdk.addEventListener('error', ({ window, type, message }) => tell({ type: 'error', ...(window ? { window: windowOf(window) } : {}), message: `${message || type}` }));
    sdk.addEventListener('shutdown', ({ code }) => {
      // The SDK restarts itself; a recording that was on has ended.
      for (const id of recording) tell({ type: 'recording-ended', window: meetings.get(id) ?? { id } });
      recording.clear();
      if (code) tell({ type: 'error', message: `The recorder stopped (${code}); it starts again by itself.` });
    });
  }

  handle('notes:enable', async (apiUrl) => {
    if (typeof apiUrl !== 'string' || !RECALL_URL.test(apiUrl)) return { ok: false, error: 'not a Recall.ai region' };
    if (!enabled) {
      enabled = (async () => {
        // Loaded only here, on a system the SDK runs on: its native recorder is in the app beside it (asarUnpack).
        sdk = require('@recallai/desktop-sdk');
        listen();
        await sdk.init({ apiUrl, acquirePermissionsOnStartup: ['accessibility', 'screen-capture', 'microphone'] });
      })().catch((error) => {
        enabled = null;
        sdk = null;
        throw error;
      });
    }
    await enabled;
    // A page that opens mid-meeting hears of the recording on first — so it takes it up rather than starting another —
    // then of the meetings open.
    for (const id of recording) tell({ type: 'recording-started', window: meetings.get(id) ?? { id } });
    for (const window of meetings.values()) if (!recording.has(window.id)) tell({ type: 'meeting-detected', window });
    return { ok: true };
  });

  handle('notes:start', async (windowId, uploadToken) => {
    if (!sdk) return { ok: false, error: 'The recorder is not started.' };
    if (typeof windowId !== 'string' || !WINDOW_ID.test(windowId) || typeof uploadToken !== 'string' || !uploadToken || uploadToken.length > 4000) return { ok: false, error: 'which meeting?' };
    await sdk.startRecording({ windowId, uploadToken });
    return { ok: true };
  });

  handle('notes:stop', async (windowId) => {
    if (!sdk) return { ok: false, error: 'The recorder is not started.' };
    if (typeof windowId !== 'string' || !WINDOW_ID.test(windowId)) return { ok: false, error: 'which meeting?' };
    await sdk.stopRecording({ windowId });
    return { ok: true };
  });

  handle('notes:prepare-audio', async () => {
    if (!sdk) return { ok: false, error: 'The recorder is not started.' };
    const windowId = await sdk.prepareDesktopAudioRecording();
    meetings.set(windowId, { id: windowId });
    return { ok: true, windowId };
  });

  handle('notes:permission', async (permission) => {
    if (!PERMISSIONS.has(permission)) return { ok: false, error: 'which permission?' };
    // macOS asks an app once; after that — granted or turned down — asking again shows nothing at all. So the page
    // with the switch opens too, a moment later so a first-time prompt is not hidden behind it. The SDK's answer is
    // not waited for: it comes only once its own process has dealt with the prompt, which can be a long time or never.
    const pane = SETTINGS_PANES[permission];
    if (process.platform === 'darwin' && pane) setTimeout(() => openSettings(pane), 1000);
    if (sdk) sdk.requestPermission(permission).catch(() => undefined);
    return { ok: true };
  });
}

/** Before the app quits: any recording stopped (so it is uploaded whole) and the SDK's process ended. */
async function stopNotes() {
  if (!sdk) return;
  for (const windowId of recording) await sdk.stopRecording({ windowId }).catch(() => undefined);
  await sdk.shutdown().catch(() => undefined);
  sdk = null;
  enabled = null;
}

module.exports = { setUpNotes, stopNotes, SUPPORTED };
