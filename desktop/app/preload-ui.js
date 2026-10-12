// The app's own pages (ui/start.html, ui/uninstall.html), and only those: what they ask the app for.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('readerApp', {
  platform: process.platform,
  start: {
    onProgress: (handler) => ipcRenderer.on('start:progress', (_event, message) => handler(message)),
    retry: () => ipcRenderer.send('start:retry'),
    without: () => ipcRenderer.send('start:without'),
    log: () => ipcRenderer.send('start:log'),
  },
  uninstall: {
    details: () => ipcRenderer.invoke('uninstall:details'),
    run: (choices) => ipcRenderer.invoke('uninstall:run', choices),
    onProgress: (handler) => ipcRenderer.on('uninstall:progress', (_event, line) => handler(line)),
    cancel: () => ipcRenderer.send('uninstall:cancel'),
    quit: () => ipcRenderer.send('uninstall:quit'),
  },
});
