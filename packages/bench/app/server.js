// Loopback-only HTTP fixture for the benchmark Electron app. A real web origin is required for
// Playwright's storageState() to include localStorage, so the storage benchmark must not use file://.
// The server intentionally serves one in-memory document and exposes no filesystem or network proxy.
import { createServer } from 'node:http'

const HTML_CONTENT_TYPE = 'text/html; charset=utf-8'

/** Create a static server that serves only the benchmark document at / and /index.html. */
export function createBenchAppServer(html) {
  return createServer((request, response) => {
    const method = request.method ?? 'GET'
    const pathname = new URL(request.url ?? '/', 'http://bench.invalid').pathname
    const isDocument = pathname === '/' || pathname === '/index.html'
    const isReadableMethod = method === 'GET' || method === 'HEAD'
    if (!isDocument || !isReadableMethod) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }
    response.writeHead(200, { 'content-type': HTML_CONTENT_TYPE })
    response.end(method === 'HEAD' ? undefined : html)
  })
}

/** Close a listening fixture server and retain close failures for the Electron lifecycle caller. */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

/** Start the loopback-only fixture on an ephemeral port and expose its origin plus deterministic close. */
export async function startBenchAppServer(html) {
  const server = createBenchAppServer(html)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await closeServer(server)
    throw new Error('Benchmark fixture server did not expose a TCP address')
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  }
}
