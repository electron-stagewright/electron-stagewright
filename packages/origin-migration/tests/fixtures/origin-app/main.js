// Fixture for the origin-migration smoke. ORIGIN_SMOKE_MODE=legacy loads the page from file://,
// as builds before the scheme did; any other mode migrates, then loads it from app://fixture.
import { app, BrowserWindow, protocol, session } from 'electron'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { blankDocumentResponse, migrateOrigin } from '@electron-stagewright/origin-migration'

const fixtureDir = dirname(fileURLToPath(import.meta.url))
const legacy = process.env.ORIGIN_SMOKE_MODE === 'legacy'
const BLANK_URL = 'app://fixture/.origin-migration/blank.html'

if (process.env.ORIGIN_SMOKE_PROFILE) app.setPath('userData', process.env.ORIGIN_SMOKE_PROFILE)

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

globalThis.originSmoke = { status: 'pending' }

app
  .whenReady()
  .then(async () => {
    protocol.handle('app', async (request) => {
      if (request.url === BLANK_URL) return blankDocumentResponse()
      if (new URL(request.url).pathname === '/index.html') {
        const html = await readFile(join(fixtureDir, 'index.html'))
        return new Response(html, { headers: { 'content-type': 'text/html' } })
      }
      return new Response(null, { status: 404 })
    })
    const win = new BrowserWindow({ width: 400, height: 300, show: false })
    if (legacy) {
      globalThis.originSmoke = { status: 'legacy' }
      await win.loadFile(join(fixtureDir, 'index.html'))
    } else {
      globalThis.originSmoke = await migrateOrigin({
        userDataDir: app.getPath('userData'),
        BrowserWindow,
        session: session.defaultSession,
        targetUrl: BLANK_URL,
      })
      await win.loadURL('app://fixture/index.html')
    }
    win.show()
  })
  .catch((error) => {
    // The smoke waits on this status; without it a startup failure only shows up as a timeout.
    globalThis.originSmoke = { status: 'error', error: String(error?.stack ?? error) }
  })

app.on('window-all-closed', () => {
  app.quit()
})
