// Electron main process for the benchmark app. Opens one window loading index.html and
// quits when it closes. The app is deliberately tiny — it exists only to give the bench
// scenarios stable elements to drive: a greeting form (for the token-economy contrast)
// and a deferred-load element (for the error-recovery path).
import { BrowserWindow, app } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 480,
    height: 360,
    show: true,
    webPreferences: { contextIsolation: true },
  })
  void win.loadFile(join(here, 'index.html'))
})

app.on('window-all-closed', () => {
  app.quit()
})
