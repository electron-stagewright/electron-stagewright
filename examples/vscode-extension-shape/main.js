// Electron main process for the VSCode-shaped example. Opens one visible window
// loading index.html and quits when it closes, so a stopped driving session leaves
// no orphan process. The app is deliberately a single renderer document — the
// webview-like panel is simulated in the same DOM (see README), because the point
// is the scripted agent session in scenario.ts, not a real editor.
import { BrowserWindow, app } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    show: true,
    webPreferences: { contextIsolation: true },
  })
  void win.loadFile(join(here, 'index.html'))
})

app.on('window-all-closed', () => {
  app.quit()
})
