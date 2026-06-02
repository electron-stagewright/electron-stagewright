// Electron main process for the Angular matrix fixture. Opens one window loading
// index.html, which loads the esbuild-bundled Angular app (dist/renderer.js, built by
// build-fixtures.mjs). Implements the same UI contract as the other fixtures, with a
// standalone component and zone.js-driven change detection.
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
