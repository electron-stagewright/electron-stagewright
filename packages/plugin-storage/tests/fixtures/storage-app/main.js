// Minimal Electron main process for the gated storage smoke. Serves the page over a loopback HTTP
// server (on an ephemeral port) instead of file://, so cookies and localStorage behave like a real
// web origin — cookies set for the origin are visible to document.cookie, and the origin's
// localStorage is captured by the storage snapshot. The page reports its own location.origin so the
// smoke can target it when seeding a cookie. Quits when the window closes.
import { BrowserWindow, app } from 'electron'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureDir = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(fixtureDir, 'index.html'), 'utf8')

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
})

app.whenReady().then(() => {
  httpServer.listen(0, '127.0.0.1', () => {
    const address = httpServer.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const win = new BrowserWindow({
      width: 400,
      height: 300,
      show: true,
      webPreferences: { contextIsolation: true },
    })
    void win.loadURL(`http://127.0.0.1:${port}/`)
  })
})

app.on('window-all-closed', () => {
  httpServer.close()
  app.quit()
})
