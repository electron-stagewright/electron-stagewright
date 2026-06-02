// Electron main process for the vanilla matrix fixture. Opens one window loading
// index.html and quits when it closes. Kept tiny — the fixture's job is to implement
// the shared UI contract (a name input, a "Greet" button, a #status line) with plain
// DOM, as the framework-agnostic baseline the matrix compares the others against.
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
