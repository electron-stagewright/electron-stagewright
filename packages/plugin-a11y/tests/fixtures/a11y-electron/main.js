import { createServer } from 'node:http'

import { BrowserWindow, app } from 'electron'

let fixtureServer

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

app.whenReady().then(async () => {
  fixtureServer = createServer((request, response) => {
    const port = fixtureServer.address().port
    const host = request.headers.host ?? `127.0.0.1:${port}`
    const pathname = new URL(request.url ?? '/', `http://${host}`).pathname
    const pages = {
      '/host.html': `<!doctype html><head><title>Accessibility host</title></head><body><main id="audit-root"><h1>Settings</h1><img id="missing-alt" src="missing.png"><button id="blank-button"></button><div id="shadow-host"></div></main><section id="hidden-panel" hidden><img src="hidden.png"></section><iframe id="child-frame" src="/child.html"></iframe><script>window.axe={appOwned:true};const root=document.querySelector('#shadow-host').attachShadow({mode:'open'});root.innerHTML='<img id="shadow-image" src="shadow.png">';</script></body>`,
      '/child.html':
        '<!doctype html><head><title>Accessibility child</title></head><body><img id="child-missing-alt" src="child.png"></body>',
    }
    const page = pages[pathname]
    response.writeHead(page === undefined ? 404 : 200, {
      'content-type': 'text/html; charset=utf-8',
    })
    response.end(page ?? 'missing')
  })
  await listen(fixtureServer)
  const port = fixtureServer.address().port
  const window = new BrowserWindow({ width: 640, height: 480, show: true })
  await window.loadURL(`http://127.0.0.1:${port}/host.html`)
})

app.on('window-all-closed', () => {
  fixtureServer?.close()
  app.quit()
})
