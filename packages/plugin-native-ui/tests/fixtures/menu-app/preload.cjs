// Exposes the fixture's file-dialog actions to the page; the dialogs themselves run in main.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('fixtureFiles', {
  open: () => ipcRenderer.invoke('fixture:open-file'),
  save: (content) => ipcRenderer.invoke('fixture:save-file', content),
})
