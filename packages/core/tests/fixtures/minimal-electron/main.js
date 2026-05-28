// Minimal Electron main process for the real-Electron lifecycle smoke test.
// Loaded by Playwright's _electron.launch with this file as the entry; opens one
// visible window so the lifecycle tools have something to inspect, and quits when
// the window closes so a stopped session leaves no orphan process.
import { BrowserWindow, app } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureDir = dirname(fileURLToPath(import.meta.url))

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 480,
    height: 320,
    show: true,
    webPreferences: { contextIsolation: true },
  })
  void win.loadFile(join(fixtureDir, 'index.html'))
})

app.on('window-all-closed', () => {
  app.quit()
})
