import { BrowserWindow, app } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url))

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 640, height: 480, show: true })
  await window.loadFile(path.join(fixtureDirectory, 'host.html'))
})

app.on('window-all-closed', () => app.quit())
