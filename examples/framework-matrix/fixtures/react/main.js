// Electron main process for the React matrix fixture. Opens one window loading
// index.html, which loads the esbuild-bundled React app (dist/renderer.js, built by
// build-fixtures.mjs). Implements the same UI contract as the vanilla fixture, but with
// a controlled input and React's synthetic event system — the framework quirk this
// fixture exists to prove the tools handle.
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
