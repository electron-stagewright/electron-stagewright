// Electron main process for the code-editor-shaped example. Opens one visible window
// loading index.html and quits when it closes, so a stopped driving session leaves no
// orphan process. The app is a single renderer document — license validation is a
// regex stub and the runtime sandbox is a simulated async (see README), because the
// point is the scripted agent session in scenario.ts, not a real editor or sandbox.
import { BrowserWindow, app } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 820,
    height: 600,
    show: true,
    webPreferences: { contextIsolation: true },
  })
  void win.loadFile(join(here, 'index.html'))
})

app.on('window-all-closed', () => {
  app.quit()
})
