const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getVersion: () => ipcRenderer.invoke('version'),
  block: (ms) => ipcRenderer.invoke('block', ms),
})
