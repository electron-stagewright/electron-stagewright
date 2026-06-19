// Minimal Electron main process for the gated clock smoke. Loads a page that reads the clock on
// demand and arms a deferred timer, so the smoke can freeze time, read the frozen instant, and fire
// the timer by advancing the clock. Quits when the window closes.
import { BrowserWindow, app } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureDir = dirname(fileURLToPath(import.meta.url))

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
