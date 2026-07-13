import { createServer } from 'node:http'

import { BrowserWindow, WebContentsView, app } from 'electron'

let fixtureServer
const retainedViews = []
const retainedWindows = []

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function closeServer() {
  if (fixtureServer === undefined) return
  const server = fixtureServer
  fixtureServer = undefined
  server.close()
}

app.whenReady().then(async () => {
  fixtureServer = createServer((request, response) => {
    const port = fixtureServer.address().port
    const host = request.headers.host ?? `127.0.0.1:${port}`
    const path = new URL(request.url ?? '/', `http://${host}`).pathname
    const pages = {
      '/host.html': `<!doctype html><title>Surface host</title><button id="host-action">Host action</button><iframe id="same-frame" src="/same-frame.html"></iframe><iframe id="cross-frame" src="http://localhost:${port}/cross-frame.html"></iframe><webview id="guest" src="/guest.html"></webview>`,
      '/same-frame.html':
        '<!doctype html><title>Same-origin frame</title><button id="same-action">Same frame action</button><iframe id="nested-same" src="/nested-same.html"></iframe>',
      '/cross-frame.html': `<!doctype html><title>Cross-origin frame</title><button id="cross-action">Cross frame action</button><iframe id="nested-cross" src="http://127.0.0.1:${port}/nested-cross.html"></iframe>`,
      '/nested-same.html':
        '<!doctype html><title>Nested same-origin frame</title><button>Nested same action</button>',
      '/nested-cross.html':
        '<!doctype html><title>Nested cross-origin frame</title><button>Nested cross action</button>',
      '/guest.html':
        '<!doctype html><title>Webview guest</title><button id="guest-action">Guest action</button>',
      '/view.html':
        '<!doctype html><title>Contents view</title><button id="view-action">View action</button>',
      '/secondary.html':
        '<!doctype html><title>Secondary window</title><button id="secondary-action">Secondary action</button>',
    }
    const page = pages[path]
    response.writeHead(page === undefined ? 404 : 200, {
      'content-type': 'text/html; charset=utf-8',
    })
    response.end(page ?? 'missing')
  })
  await listen(fixtureServer)
  const port = fixtureServer.address().port
  const main = new BrowserWindow({
    width: 640,
    height: 480,
    show: true,
    webPreferences: { contextIsolation: true, webviewTag: true },
  })
  retainedWindows.push(main)
  await main.loadURL(`http://127.0.0.1:${port}/host.html`)

  const view = new WebContentsView()
  retainedViews.push(view)
  main.contentView.addChildView(view)
  view.setBounds({ x: 420, y: 260, width: 180, height: 140 })
  await view.webContents.loadURL(`http://127.0.0.1:${port}/view.html`)

  const secondary = new BrowserWindow({ width: 360, height: 240, show: true })
  retainedWindows.push(secondary)
  await secondary.loadURL(`http://127.0.0.1:${port}/secondary.html`)
})

app.on('window-all-closed', () => {
  closeServer()
  app.quit()
})
