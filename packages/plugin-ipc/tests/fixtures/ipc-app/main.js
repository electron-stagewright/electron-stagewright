// Minimal Electron main process for the gated IPC smoke. Registers a single ipcMain.handle
// channel BEFORE the plugin instruments — so the smoke exercises re-wrapping an already-registered
// handler (the trickiest path) plus invoke + capture. Quits when the window closes.
import { BrowserWindow, app, ipcMain } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureDir = dirname(fileURLToPath(import.meta.url))

// Request-response channel the smoke captures + invokes.
ipcMain.handle('ping', async (_event, payload) => ({ pong: payload ?? null }))

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 400,
    height: 300,
    show: true,
    webPreferences: { contextIsolation: true },
  })
  void win.loadFile(join(fixtureDir, 'index.html'))
})

app.on('window-all-closed', () => {
  app.quit()
})
