// Minimal Electron app for the budget smoke: one window, one trivial IPC channel for the latency
// probe, and one channel that blocks the main thread on demand.
import { BrowserWindow, app, ipcMain } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureDir = dirname(fileURLToPath(import.meta.url))

ipcMain.handle('version', () => app.getVersion())
ipcMain.handle('block', (_event, ms) => {
  const until = Date.now() + Number(ms)
  while (Date.now() < until);
  return true
})

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 400,
    height: 300,
    show: true,
    webPreferences: {
      contextIsolation: true,
      preload: join(fixtureDir, 'preload.cjs'),
      backgroundThrottling: false,
    },
  })
  void win.loadFile(join(fixtureDir, 'index.html'))
})

app.on('window-all-closed', () => {
  app.quit()
})
