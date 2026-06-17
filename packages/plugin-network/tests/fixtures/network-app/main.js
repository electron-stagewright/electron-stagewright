// Minimal Electron main process for the gated network smoke. Loads a page that periodically fetches
// an allowlisted URL, so the smoke can arm capture AFTER launch and still observe a request. Quits
// when the window closes.
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
