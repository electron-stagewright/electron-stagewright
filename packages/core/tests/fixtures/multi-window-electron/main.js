import { BrowserWindow, app } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureDir = dirname(fileURLToPath(import.meta.url))

app.whenReady().then(async () => {
  const main = new BrowserWindow({
    width: 480,
    height: 320,
    show: true,
    webPreferences: { contextIsolation: true },
  })
  const preferences = new BrowserWindow({
    width: 440,
    height: 260,
    show: true,
    webPreferences: { contextIsolation: true },
  })
  await Promise.all([
    main.loadFile(join(fixtureDir, 'main.html')),
    preferences.loadFile(join(fixtureDir, 'preferences.html')),
  ])
})

app.on('window-all-closed', () => app.quit())
