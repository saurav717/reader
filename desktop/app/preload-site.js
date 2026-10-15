// The site's pages in the app: they may know they are in the Reader app (to offer no download of it,
// say), and — on macOS and Windows — use the meeting recorder (notes.js): find a meeting, record it,
// stop — and sign in to Google in the browser, since Google won't inside the app (main.js). Nothing else: no
// Node, no other messages to the app.
const { contextBridge, ipcRenderer } = require('electron');

const recorder = process.platform === 'darwin' || process.platform === 'win32';

contextBridge.exposeInMainWorld('readerDesktop', {
  app: true,
  platform: process.platform,
  google: {
    token: (request) => ipcRenderer.invoke('google:token', request),
  },
  companion: {
    release: (id) => ipcRenderer.invoke('companion:release', String(id)),
  },
  ...(recorder
    ? {
        notes: {
          enable: (apiUrl) => ipcRenderer.invoke('notes:enable', String(apiUrl)),
          start: (windowId, uploadToken) => ipcRenderer.invoke('notes:start', String(windowId), String(uploadToken)),
          stop: (windowId) => ipcRenderer.invoke('notes:stop', String(windowId)),
          prepareAudio: () => ipcRenderer.invoke('notes:prepare-audio'),
          requestPermission: (permission) => ipcRenderer.invoke('notes:permission', String(permission)),
          onEvent: (listener) => {
            const hear = (_event, message) => listener(message);
            ipcRenderer.on('notes:event', hear);
            return () => ipcRenderer.removeListener('notes:event', hear);
          },
        },
      }
    : {}),
});
