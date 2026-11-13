// Minimal, explicit bridge. The page gets no Node access.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('unifyDesktop', {
  platform: process.platform,
  openFolder: () => ipcRenderer.invoke('unify:open-folder'),
  useDemo: () => ipcRenderer.invoke('unify:use-demo'),
});
