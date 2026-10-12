// The site's pages in the app: they may know they are in the Reader app (to offer no download of it,
// say), and nothing else. No Node, no messages to the app.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('readerDesktop', { app: true, platform: process.platform });
