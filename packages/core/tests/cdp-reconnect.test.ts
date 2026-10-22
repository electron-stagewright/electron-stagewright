/**
 * Disconnect recovery for the CDP transport: an attached session reconnects on the next
 * app-touching call (bounded, re-selecting its window), while a session that owns its launched
 * process reports the drop as unrecoverable.
 */

import { type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import { ERROR_CODES } from '../src/errors/registry.js'
import { CDPTransport, type FetchJson } from '../src/transports/cdp.js'
import { FakeCdpServer, type Json } from './helpers/fake-cdp.js'

const BROWSER_WS = 'ws://127.0.0.1:9222/devtools/browser/b1'

function page(id: string, title: string, url = `app://${title.toLowerCase()}.html`): Json {
  return {
    id,
    type: 'page',
    title,
    url,
    webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}`,
  }
}

function setup(initialTargets: readonly Json[] = [page('T1', 'Main'), page('T2', 'Settings')]) {
  const server = new FakeCdpServer()
  let targets = initialTargets
  let down = false
  const fetchJson: FetchJson = async (url) => {
    if (down) throw new Error('ECONNREFUSED')
    if (url.endsWith('/json/version')) return { webSocketDebuggerUrl: BROWSER_WS }
    if (url.endsWith('/json/list')) return targets
    throw new Error(`unexpected discovery url ${url}`)
  }
  const transport = new CDPTransport({
    wsFactory: server.factory,
    fetchJson,
    killProcess: () => {},
    defaultMethodTimeoutMs: 250,
  })
  // Echo the target a renderer eval ran against, so a test can see which window was selected.
  server.respond('Runtime.evaluate', (_params, url) => ({ result: { value: url } }))
  return {
    server,
    transport,
    setTargets: (next: readonly Json[]) => {
      targets = next
    },
    setDown: (next: boolean) => {
      down = next
      server.refuseConnections = next
    },
    browserSockets: () => server.sockets.filter((socket) => socket.url === BROWSER_WS).length,
  }
}

describe('CDP attach reconnect', () => {
  it('reconnects on the next call, restores the selected window, and notifies observers', async () => {
    const { server, transport, browserSockets } = setup()
    const session = await transport.attach({ port: 9222 })
    let reconnects = 0
    session.onReconnect?.(() => {
      reconnects += 1
    })
    await session.activateWindow({ kind: 'id', id: 'T2' })

    server.closeSockets('browser')

    await expect(session.evaluate('renderer', 'return 1;')).resolves.toContain('page/T2')
    expect(browserSockets()).toBe(2)
    expect(reconnects).toBe(1)
    // Capture is re-armed on every target of the new connection.
    expect(server.sentTo('page/T1', 'Runtime.enable')).toHaveLength(2)
    await expect(session.evaluate('renderer', 'return 1;')).resolves.toContain('page/T2')
    expect(reconnects).toBe(1)
  })

  it('re-arms active network capture on the reconnected page sockets', async () => {
    const { server, transport } = setup()
    const session = await transport.attach({ port: 9222 })
    await session.startNetworkCapture({ urls: ['/api/'] })
    const enabledBefore = server.sentTo('page/T1', 'Network.enable').length

    server.closeSockets('browser')
    await session.evaluate('renderer', 'return 1;')

    expect(server.sentTo('page/T1', 'Network.enable').length).toBeGreaterThan(enabledBefore)
  })

  it('re-selects the window by url and title when the app restarted with new target ids', async () => {
    const { server, transport, setTargets } = setup()
    const session = await transport.attach({ port: 9222 })
    await session.activateWindow({ kind: 'id', id: 'T2' })
    await session.windowsList()

    server.closeSockets('browser')
    setTargets([page('T5', 'Main'), page('T6', 'Settings')])

    await expect(session.evaluate('renderer', 'return 1;')).resolves.toContain('page/T6')
  })

  it('shares one reconnect between concurrent calls', async () => {
    const { server, transport, browserSockets } = setup()
    const session = await transport.attach({ port: 9222 })

    server.closeSockets('browser')

    await Promise.all([
      session.evaluate('renderer', 'return 1;'),
      session.windowsList(),
      session.surfacesList(),
    ])
    expect(browserSockets()).toBe(2)
  })

  it('gives up after bounded attempts with a retryable CDP_DISCONNECTED, then recovers', async () => {
    const { server, transport, setDown } = setup()
    const session = await transport.attach({ port: 9222 })

    setDown(true)
    server.closeSockets('browser')

    const failure = await session.evaluate('renderer', 'return 1;').catch((err: unknown) => err)
    expect(failure).toMatchObject({ code: 'CDP_DISCONNECTED', details: { attempts: 3 } })
    expect(ERROR_CODES.CDP_DISCONNECTED.retryable).toBe(true)
    // Buffered diagnostics never wait on a reconnect.
    await expect(session.consoleLogs()).resolves.toMatchObject({ entries: [] })

    setDown(false)
    await expect(session.evaluate('renderer', 'return 1;')).resolves.toContain('page/T1')
  })

  it('does not reconnect a session that was disposed', async () => {
    const { server, transport, browserSockets } = setup()
    const session = await transport.attach({ port: 9222 })

    server.closeSockets('browser')
    await session.dispose()

    await expect(session.evaluate('renderer', 'return 1;')).rejects.toMatchObject({
      code: 'NOT_RUNNING',
    })
    expect(browserSockets()).toBe(1)
  })
})

class FakeChildProcess extends EventEmitter {
  readonly pid = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signalCode = signal
    this.emit('exit', null, signal)
    return true
  }

  exit(code = 0): void {
    this.exitCode = code
    this.emit('exit', code, null)
  }
}

describe('CDP launched-session drop', () => {
  it('reports a non-retryable SESSION_DISCONNECTED instead of reconnecting', async () => {
    const server = new FakeCdpServer()
    const child = new FakeChildProcess()
    const fetchJson: FetchJson = async (url) => {
      if (url.endsWith('/json/version')) return { webSocketDebuggerUrl: BROWSER_WS }
      if (url.endsWith('/json/list')) return [page('T1', 'Packaged')]
      throw new Error(`unexpected discovery url ${url}`)
    }
    const transport = new CDPTransport({
      wsFactory: server.factory,
      fetchJson,
      platform: 'darwin',
      reserveLoopbackPort: async () => 9222,
      spawnProcess: () => child as unknown as ChildProcess,
      killProcess: () => {},
      defaultMethodTimeoutMs: 250,
    })
    const session = await transport.launch({ executablePath: '/opt/App/app' })

    child.exit(1)
    server.closeSockets('browser')

    await expect(session.evaluate('renderer', 'return 1;')).rejects.toMatchObject({
      code: 'SESSION_DISCONNECTED',
    })
    await expect(session.windowsList()).rejects.toMatchObject({ code: 'SESSION_DISCONNECTED' })
    expect(ERROR_CODES.SESSION_DISCONNECTED.retryable).toBe(false)
    expect(server.sockets.filter((socket) => socket.url === BROWSER_WS)).toHaveLength(1)
    await expect(transport.stop(session, { timeoutMs: 100 })).resolves.toEqual({
      escalated: false,
    })
  })
})
