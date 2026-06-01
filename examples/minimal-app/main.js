// Minimal Electron main process for the Electron Stagewright "hello world" example.
// Opens one visible window loading index.html and quits when it closes, so a
// stopped driving session leaves no orphan process. Kept deliberately tiny — the
// point is the scripted agent session in scenario.ts, not the app.
import { BrowserWindow, app } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 520,
    height: 400,
    show: true,
    webPreferences: { contextIsolation: true },
  })
  void win.loadFile(join(here, 'index.html'))
})

app.on('window-all-closed', () => {
  app.quit()
})
