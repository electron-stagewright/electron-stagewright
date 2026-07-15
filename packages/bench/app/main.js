// Electron main process for the benchmark app. Opens one window at a loopback HTTP origin and
// quits when it closes. The app is deliberately tiny — it exists only to give the bench scenarios
// stable elements to drive, including real localStorage captured by storageState().
import { BrowserWindow, app } from 'electron'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startBenchAppServer } from './server.js'

const here = dirname(fileURLToPath(import.meta.url))
let fixture

app
  .whenReady()
  .then(async () => {
    fixture = await startBenchAppServer(await readFile(join(here, 'index.html'), 'utf8'))
    const win = new BrowserWindow({
      width: 480,
      height: 360,
      show: true,
      webPreferences: { contextIsolation: true },
    })
    await win.loadURL(`${fixture.origin}/`)
  })
  .catch((error) => {
    console.error('Could not start the benchmark fixture:', error)
    app.exit(1)
  })

app.on('window-all-closed', () => {
  void (fixture?.close() ?? Promise.resolve()).finally(() => app.quit())
})
