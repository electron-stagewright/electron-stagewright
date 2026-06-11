/**
 * Unit tests for the CDP transport's connection pool — driven over an
 * in-memory fake CDP endpoint (an injected WebSocket factory + discovery
 * fetcher), so the protocol semantics are exercised without a real app:
 * pending-map resolution, per-method timeouts, the enabled-domain cache,
 * `awaitPromise` evaluation, console/dialog capture per target, screenshots,
 * graceful stop with SIGKILL escalation, and disconnect cleanup.
 *
 * The real-protocol behaviour against a live Electron app is covered by the
 * `STAGEWRIGHT_E2E`-gated `cdp-attach-smoke.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest'

import { CDPTransport, type FetchJson } from '../src/transports/cdp.js'
import type { ConsoleEntry } from '../src/transports/index.js'
import { FakeCdpServer, type Json } from './helpers/fake-cdp.js'

const BROWSER_WS = 'ws://127.0.0.1:9222/devtools/browser/b1'
const PAGE_T1_WS = 'ws://127.0.0.1:9222/devtools/page/T1'

interface SetupOptions {
  readonly targets?: readonly Json[]
  readonly methodTimeoutMs?: number
}

function setup(opts: SetupOptions = {}) {
  const server = new FakeCdpServer()
  let targets: readonly Json[] = opts.targets ?? [
    {
      id: 'T1',
      type: 'page',
      title: 'Main',
      url: 'app://index.html',
      webSocketDebuggerUrl: PAGE_T1_WS,
    },
    // Non-page targets (service workers, devtools) must be filtered out.
    { id: 'SW', type: 'service_worker', title: 'sw', url: '', webSocketDebuggerUrl: 'ws://x/sw' },
  ]
  const fetchCalls: string[] = []
  const fetchJson: FetchJson = async (url) => {
    fetchCalls.push(url)
    if (url.endsWith('/json/version')) return { webSocketDebuggerUrl: BROWSER_WS }
    if (url.endsWith('/json/list')) return targets
    throw new Error(`unexpected discovery url ${url}`)
  }
  const killed: number[] = []
  const transport = new CDPTransport({
    wsFactory: server.factory,
    fetchJson,
    killProcess: (pid) => killed.push(pid),
    defaultMethodTimeoutMs: opts.methodTimeoutMs ?? 250,
  })
  return {
    server,
    transport,
    killed,
    fetchCalls,
    setTargets: (next: readonly Json[]) => {
      targets = next
    },
  }
}

describe('CDPTransport.attach', () => {
  it('resolves the browser endpoint from /json/version and pools the page targets', async () => {
    const { server, transport } = setup()
    const session = await transport.attach({ port: 9222 })

    expect(session.transport).toBe('cdp')
    // One socket per target: the browser endpoint + the page target.
    expect(server.sockets.map((s) => s.url)).toEqual([BROWSER_WS, PAGE_T1_WS])
    // Capture enabled the Runtime + Page domains on the page target.
    expect(server.sentTo('page/T1', 'Runtime.enable')).toHaveLength(1)
    expect(server.sentTo('page/T1', 'Page.enable')).toHaveLength(1)

    const windows = await session.windowsList()
    expect(windows).toEqual([
      {
        id: 'T1',
        index: 0,
        title: 'Main',
        url: 'app://index.html',
        visible: true,
        focused: true,
      },
    ])
  })

  it('formats IPv6 loopback hosts correctly for port-based discovery', async () => {
    const { transport, fetchCalls } = setup()
    await transport.attach({ port: 9222, host: '::1' })
    expect(fetchCalls[0]).toBe('http://[::1]:9222/json/version')
  })

  it('uses a given cdpUrl directly as the browser endpoint (no /json/version probe)', async () => {
    const { server, transport, fetchCalls } = setup()
    await transport.attach({ cdpUrl: BROWSER_WS })
    expect(server.sockets[0]?.url).toBe(BROWSER_WS)
    expect(fetchCalls).toContain('http://127.0.0.1:9222/json/list')
    expect(fetchCalls.some((u) => u.endsWith('/json/version'))).toBe(false)
  })

  it('derives HTTPS discovery from a secure CDP websocket URL', async () => {
    const { server, transport, fetchCalls } = setup()
    const secureWs = 'wss://localhost:9222/devtools/browser/b1'
    await transport.attach({ cdpUrl: secureWs })
    expect(server.sockets[0]?.url).toBe(secureWs)
    expect(fetchCalls).toContain('https://localhost:9222/json/list')
    expect(fetchCalls.some((u) => u.endsWith('/json/version'))).toBe(false)
  })

  it('rejects with CDP_DISCONNECTED when the discovery endpoint is unreachable', async () => {
    const { transport } = setup()
    const failing = new CDPTransport({
      wsFactory: setup().server.factory,
      fetchJson: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    await expect(failing.attach({ port: 1 })).rejects.toMatchObject({ code: 'CDP_DISCONNECTED' })
    void transport
  })
})

describe('CDP evaluation (pending map + awaitPromise + domain cache)', () => {
  it('evaluates in the renderer via Runtime.evaluate with awaitPromise + returnByValue', async () => {
    const { server, transport } = setup()
    server.respond('Runtime.evaluate', (params) => {
      expect(params).toMatchObject({ awaitPromise: true, returnByValue: true })
      expect(String(params?.['expression'])).toContain('return 40 + arg.delta;')
      expect(String(params?.['expression'])).toContain('{"delta":2}')
      return { result: { value: 42 } }
    })
    const session = await transport.attach({ port: 9222 })

    await expect(
      session.evaluate('renderer', 'return 40 + arg.delta;', { delta: 2 }),
    ).resolves.toBe(42)
    // The eval went to the PAGE socket, not the browser endpoint.
    expect(server.sentTo('page/T1', 'Runtime.evaluate')).toHaveLength(1)
    expect(server.sentTo('browser/b1', 'Runtime.evaluate')).toHaveLength(0)
  })

  it('evaluates main against the browser endpoint', async () => {
    const { server, transport } = setup()
    server.respond('Runtime.evaluate', () => ({ result: { value: 'main-ok' } }))
    const session = await transport.attach({ port: 9222 })

    await expect(session.evaluate('main', 'return "main-ok";')).resolves.toBe('main-ok')
    expect(server.sentTo('browser/b1', 'Runtime.evaluate')).toHaveLength(1)
  })

  it('sends each domain enable exactly once per connection (enabled-domain cache)', async () => {
    const { server, transport } = setup()
    server.respond('Runtime.evaluate', () => ({ result: { value: 1 } }))
    const session = await transport.attach({ port: 9222 })

    await session.evaluate('renderer', 'return 1;')
    await session.evaluate('renderer', 'return 1;')
    await session.evaluate('renderer', 'return 1;')

    expect(server.sentTo('page/T1', 'Runtime.enable')).toHaveLength(1)
  })

  it('maps exceptionDetails to EVAL_RUNTIME_ERROR', async () => {
    const { server, transport } = setup()
    server.respond('Runtime.evaluate', () => ({
      exceptionDetails: { exception: { description: 'ReferenceError: nope is not defined' } },
    }))
    const session = await transport.attach({ port: 9222 })

    await expect(session.evaluate('renderer', 'return nope;')).rejects.toMatchObject({
      code: 'EVAL_RUNTIME_ERROR',
    })
  })

  it('maps a CDP protocol error frame to INTERNAL_ERROR naming the method', async () => {
    const { server, transport } = setup()
    server.respond('Runtime.evaluate', () => {
      throw new Error('Invalid expression')
    })
    const session = await transport.attach({ port: 9222 })

    const failure = await session.evaluate('renderer', 'return 1;').catch((e: unknown) => e)
    expect(failure).toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(String((failure as Error).message)).toContain('Runtime.evaluate')
  })

  it('rejects with CDP_TIMEOUT when a method never responds (per-method timeout)', async () => {
    const { server, transport } = setup({ methodTimeoutMs: 60 })
    server.neverReply('Runtime.evaluate')
    const session = await transport.attach({ port: 9222 })

    await expect(session.evaluate('renderer', 'return 1;')).rejects.toMatchObject({
      code: 'CDP_TIMEOUT',
    })
  })

  it('rejects pending calls with CDP_DISCONNECTED when the socket closes mid-call', async () => {
    const { server, transport } = setup({ methodTimeoutMs: 5000 })
    server.neverReply('Runtime.evaluate')
    const session = await transport.attach({ port: 9222 })

    const pending = session.evaluate('renderer', 'return 1;')
    // Let the send park in the pending map before dropping the socket.
    await new Promise((resolve) => setTimeout(resolve, 10))
    server.closeSockets('page/T1')

    await expect(pending).rejects.toMatchObject({ code: 'CDP_DISCONNECTED' })
  })
})

describe('CDP console + dialog capture', () => {
  it('buffers consoleAPICalled events attributed to their target id', async () => {
    const { server, transport } = setup()
    const session = await transport.attach({ port: 9222 })

    server.emit('page/T1', 'Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ value: 'hello' }, { value: 42 }, { description: 'DOMObject' }],
    })

    const { entries, overflowed } = await session.consoleLogs()
    expect(overflowed).toBe(0)
    expect(
      entries.map((e: ConsoleEntry) => ({ type: e.type, text: e.text, windowId: e.windowId })),
    ).toEqual([{ type: 'log', text: 'hello 42 DOMObject', windowId: 'T1' }])
  })

  it('auto-responds to javascriptDialogOpening per the policy and records the event', async () => {
    const { server, transport } = setup()
    const handled: Json[] = []
    server.respond('Page.handleJavaScriptDialog', (params) => {
      handled.push(params ?? {})
      return {}
    })
    const session = await transport.attach({ port: 9222 })

    // Default policy dismisses so the renderer can never hang.
    server.emit('page/T1', 'Page.javascriptDialogOpening', { type: 'confirm', message: 'sure?' })
    await new Promise((resolve) => setTimeout(resolve, 10))

    await session.setDialogPolicy({ action: 'accept', promptText: 'LIC-1' })
    server.emit('page/T1', 'Page.javascriptDialogOpening', {
      type: 'prompt',
      message: 'key?',
      defaultPrompt: 'x',
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(handled).toEqual([{ accept: false }, { accept: true, promptText: 'LIC-1' }])
    const { entries } = await session.dialogEvents()
    expect(entries[0]).toMatchObject({ type: 'confirm', action: 'dismiss', windowId: 'T1' })
    expect(entries[1]).toMatchObject({
      type: 'prompt',
      action: 'accept',
      promptText: 'LIC-1',
      defaultValue: 'x',
    })
  })
})

describe('CDP screenshot', () => {
  it('captures via Page.captureScreenshot and decodes the base64 payload', async () => {
    const { server, transport } = setup()
    const pngBytes = Buffer.from('fake-png-bytes')
    server.respond('Page.captureScreenshot', (params) => {
      expect(params).toMatchObject({ format: 'png' })
      return { data: pngBytes.toString('base64') }
    })
    const session = await transport.attach({ port: 9222 })

    const shot = await session.screenshot({ kind: 'index', index: 0 })
    expect(Buffer.compare(shot, pngBytes)).toBe(0)
  })

  it('rejects with REF_NOT_FOUND for an out-of-range window index', async () => {
    const { transport } = setup()
    const session = await transport.attach({ port: 9222 })
    await expect(session.screenshot({ kind: 'index', index: 7 })).rejects.toMatchObject({
      code: 'REF_NOT_FOUND',
    })
  })
})

describe('CDP stop / dispose lifecycle', () => {
  it('stops gracefully via Browser.close and releases the session', async () => {
    const { server, transport } = setup()
    server.respond('Browser.close', () => ({}))
    const session = await transport.attach({ port: 9222 })

    await expect(transport.stop(session)).resolves.toEqual({ escalated: false })
    expect(server.sentTo('browser/b1', 'Browser.close')).toHaveLength(1)
    await expect(session.consoleLogs()).rejects.toMatchObject({ code: 'NOT_RUNNING' })
    // Idempotent: a second stop is a no-op.
    await expect(transport.stop(session)).resolves.toEqual({ escalated: false })
  })

  it('escalates to SIGKILL when Browser.close times out and a pid is known', async () => {
    const { server, transport, killed } = setup()
    server.neverReply('Browser.close')
    const session = await transport.attach({ port: 9222, pid: 4242 })

    await expect(transport.stop(session, { timeoutMs: 50 })).resolves.toEqual({ escalated: true })
    expect(killed).toEqual([4242])
  })

  it('cannot escalate without a pid — still releases the session', async () => {
    const { server, transport, killed } = setup()
    server.neverReply('Browser.close')
    const session = await transport.attach({ port: 9222 })

    await expect(transport.stop(session, { timeoutMs: 50 })).resolves.toEqual({ escalated: false })
    expect(killed).toEqual([])
    await expect(session.consoleLogs()).rejects.toMatchObject({ code: 'NOT_RUNNING' })
  })

  it('dispose is idempotent and releases every pooled connection', async () => {
    const { transport } = setup()
    const session = await transport.attach({ port: 9222 })
    await session.dispose()
    await session.dispose()
    await expect(session.windowsList()).rejects.toMatchObject({ code: 'NOT_RUNNING' })
  })

  it('closes a pooled connection that finishes opening after dispose (no leaked socket)', async () => {
    const server = new FakeCdpServer()
    const fetchJson: FetchJson = async (url) => {
      if (url.endsWith('/json/version')) return { webSocketDebuggerUrl: BROWSER_WS }
      if (url.endsWith('/json/list')) {
        return [
          {
            id: 'T1',
            type: 'page',
            title: 'Main',
            url: 'app://x',
            webSocketDebuggerUrl: PAGE_T1_WS,
          },
        ]
      }
      throw new Error(`unexpected url ${url}`)
    }
    // The first page connection (attach's pre-open) proceeds normally; the
    // SECOND one's `open` event is held so the session can be disposed while
    // that open is still in flight.
    let pageOpens = 0
    let heldOpen: (() => void) | undefined
    const transport = new CDPTransport({
      wsFactory: (url) => {
        const socket = server.factory(url)
        if (!url.includes('page/T1')) return socket
        pageOpens += 1
        if (pageOpens === 1) return socket
        const held: typeof socket = {
          send: (data: string) => socket.send(data),
          close: () => socket.close(),
          addEventListener: (type, listener) => {
            if (type === 'open') {
              heldOpen = () => listener({})
              return
            }
            socket.addEventListener(type, listener)
          },
        }
        return held
      },
      fetchJson,
      killProcess: () => {},
      defaultMethodTimeoutMs: 250,
    })

    const session = await transport.attach({ port: 9222 })
    // Drop the pooled page connection so the next renderer call re-opens it.
    server.closeSockets('page/T1')
    const evaluating = session.evaluate('renderer', 'return 1;')
    await vi.waitFor(() => {
      if (heldOpen === undefined) throw new Error('second page open not yet requested')
    })

    let closed = false
    const lateSocket = server.sockets.filter((s) => s.url.includes('page/T1')).at(-1)
    lateSocket?.addEventListener('close', () => {
      closed = true
    })

    // Release the open only AFTER dispose — the late connection must be swept,
    // not silently re-inserted into the cleared pool.
    await session.dispose()
    heldOpen?.()

    await expect(evaluating).rejects.toMatchObject({ code: 'NOT_RUNNING' })
    expect(closed).toBe(true)
  })
})
