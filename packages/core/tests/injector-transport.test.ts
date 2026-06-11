/**
 * Unit tests for the Injector transport — driven over the fake CDP endpoint
 * with every process-touching dependency injected: the `_debugProcess`
 * trigger, inspector discovery, liveness probes, and SIGKILL. Covers the
 * inject flow (trigger → poll → pid verification), the Windows fallback
 * (trigger fails but a listening inspector still attaches), main-process
 * evaluation with the command-line API, the window list through the Electron
 * API, console capture, detach-on-dispose, and quit-with-escalation stop.
 */

import { describe, expect, it } from 'vitest'

import { InjectorTransport } from '../src/transports/injector.js'
import type { FetchJson } from '../src/transports/cdp.js'
import { FakeCdpServer } from './helpers/fake-cdp.js'

const NODE_WS = 'ws://127.0.0.1:9229/node/abc'
const FOREIGN_NODE_WS = 'ws://127.0.0.1:9229/node/foreign'

interface SetupOptions {
  /** Targets served by /json/list; default: one inspector owned by pid 4242. */
  readonly targets?: readonly { title: string; webSocketDebuggerUrl: string }[]
  /** How many /json/list probes fail before targets appear (inspector startup). */
  readonly listFailuresBeforeUp?: number
  /** Throw from the _debugProcess trigger (the Windows-unreliability case). */
  readonly triggerThrows?: boolean
  /** Liveness sequence for processAlive; the last value repeats. */
  readonly aliveSequence?: readonly boolean[]
}

function setup(opts: SetupOptions = {}) {
  const server = new FakeCdpServer()
  const targets = opts.targets ?? [{ title: 'electron[4242]', webSocketDebuggerUrl: NODE_WS }]
  let listCalls = 0
  const fetchCalls: string[] = []
  const fetchJson: FetchJson = async (url) => {
    fetchCalls.push(url)
    if (!url.endsWith('/json/list')) throw new Error(`unexpected url ${url}`)
    listCalls += 1
    if (listCalls <= (opts.listFailuresBeforeUp ?? 0)) throw new Error('ECONNREFUSED')
    return targets
  }
  const triggered: number[] = []
  const killed: number[] = []
  let aliveIndex = 0
  const aliveSequence = opts.aliveSequence ?? [false]
  const transport = new InjectorTransport({
    wsFactory: server.factory,
    fetchJson,
    debugProcess: (pid) => {
      triggered.push(pid)
      if (opts.triggerThrows === true) throw new Error('access denied (Windows)')
    },
    killProcess: (pid) => killed.push(pid),
    processAlive: () => {
      const value = aliveSequence[Math.min(aliveIndex, aliveSequence.length - 1)] ?? false
      aliveIndex += 1
      return value
    },
    pollIntervalMs: 5,
  })
  return { server, transport, triggered, killed, fetchCalls }
}

describe('InjectorTransport.inject', () => {
  it('triggers the inspector and attaches to the pid-owned target', async () => {
    const { server, transport, triggered } = setup({ listFailuresBeforeUp: 2 })
    const session = await transport.inject({ pid: 4242 })

    expect(triggered).toEqual([4242])
    expect(session.transport).toBe('injector')
    expect(server.sockets.map((s) => s.url)).toEqual([NODE_WS])
  })

  it('still attaches when the trigger throws but an inspector is already listening (Windows fallback)', async () => {
    const { transport } = setup({ triggerThrows: true })
    const session = await transport.inject({ pid: 4242 })
    expect(session.transport).toBe('injector')
  })

  it('refuses an inspector owned by ANOTHER process with INJECT_FAILED', async () => {
    const { transport } = setup({
      targets: [{ title: 'electron[9999]', webSocketDebuggerUrl: NODE_WS }],
    })
    const failure = await transport.inject({ pid: 4242, timeoutMs: 50 }).catch((e: unknown) => e)
    expect(failure).toMatchObject({ code: 'INJECT_FAILED' })
    expect(String((failure as Error).message)).toContain('another process')
  })

  it('fails with INJECT_FAILED when no inspector appears within the budget', async () => {
    const { transport } = setup({ listFailuresBeforeUp: 1000, triggerThrows: true })
    const failure = await transport.inject({ pid: 4242, timeoutMs: 60 }).catch((e: unknown) => e)
    expect(failure).toMatchObject({ code: 'INJECT_FAILED' })
    // The Windows remediation hint surfaces when the trigger also failed.
    expect(String((failure as Error).message)).toContain('--inspect')
  })

  it('rejects a non-positive pid with BAD_ARGUMENT before touching the network', async () => {
    const { transport, triggered } = setup()
    await expect(transport.inject({ pid: 0 })).rejects.toMatchObject({ code: 'BAD_ARGUMENT' })
    expect(triggered).toEqual([])
  })
})

describe('InjectorTransport.attach', () => {
  it('attaches to a pre-enabled inspector by port', async () => {
    const { transport } = setup()
    const session = await transport.attach({ port: 9229 })
    expect(session.transport).toBe('injector')
  })

  it('uses the pid-owned pre-enabled inspector when a pid is supplied by port', async () => {
    const { server, transport } = setup({
      targets: [
        { title: 'electron[9999]', webSocketDebuggerUrl: FOREIGN_NODE_WS },
        { title: 'electron[4242]', webSocketDebuggerUrl: NODE_WS },
      ],
    })
    const session = await transport.attach({ port: 9229, pid: 4242 })

    expect(session.transport).toBe('injector')
    expect(server.sockets.map((s) => s.url)).toEqual([NODE_WS])
  })

  it('refuses a port attach when the supplied pid does not own the inspector', async () => {
    const { transport } = setup({
      targets: [{ title: 'electron[9999]', webSocketDebuggerUrl: FOREIGN_NODE_WS }],
    })
    const failure = await transport.attach({ port: 9229, pid: 4242 }).catch((e: unknown) => e)
    expect(failure).toMatchObject({ code: 'INJECT_FAILED' })
    expect(String((failure as Error).message)).toContain('another process')
  })

  it('verifies pid ownership for direct cdpUrl attaches before returning a session', async () => {
    const { server, transport } = setup()
    server.respond('Runtime.evaluate', (params) => {
      expect(params).toMatchObject({ includeCommandLineAPI: true, awaitPromise: true })
      return { result: { value: 9999 } }
    })

    const failure = await transport.attach({ cdpUrl: NODE_WS, pid: 4242 }).catch((e: unknown) => e)
    expect(failure).toMatchObject({ code: 'INJECT_FAILED' })
    expect(String((failure as Error).message)).toContain('does not match requested pid')
  })

  it('formats IPv6 loopback hosts correctly for port-based inspector discovery', async () => {
    const { transport, fetchCalls } = setup()
    await transport.attach({ port: 9229, host: '::1' })
    expect(fetchCalls[0]).toBe('http://[::1]:9229/json/list')
  })

  it('requires an explicit port or cdpUrl (no implicit probing)', async () => {
    const { transport } = setup()
    await expect(transport.attach({})).rejects.toMatchObject({ code: 'BAD_ARGUMENT' })
  })
})

describe('InjectorSession surface', () => {
  it('evaluates in the MAIN process with the command-line API exposed', async () => {
    const { server, transport } = setup()
    server.respond('Runtime.evaluate', (params) => {
      expect(params).toMatchObject({ includeCommandLineAPI: true, awaitPromise: true })
      return { result: { value: 42 } }
    })
    const session = await transport.inject({ pid: 4242 })

    await expect(session.evaluate('main', 'return 40 + 2;')).resolves.toBe(42)
  })

  it('refuses renderer evaluation with TRANSPORT_UNSUPPORTED', async () => {
    const { transport } = setup()
    const session = await transport.inject({ pid: 4242 })
    await expect(session.evaluate('renderer', 'return 1;')).rejects.toMatchObject({
      code: 'TRANSPORT_UNSUPPORTED',
    })
  })

  it('lists windows through the Electron API in the main process', async () => {
    const { server, transport } = setup()
    server.respond('Runtime.evaluate', (params) => {
      const expr = String(params?.['expression'] ?? '')
      if (expr.includes('getAllWindows')) {
        return {
          result: {
            value: [{ id: '1', index: 0, title: 'Main', visible: true, focused: true }],
          },
        }
      }
      return { result: { value: null } }
    })
    const session = await transport.inject({ pid: 4242 })

    await expect(session.windowsList()).resolves.toEqual([
      { id: '1', index: 0, title: 'Main', visible: true, focused: true },
    ])
  })

  it('buffers main-process console output', async () => {
    const { server, transport } = setup()
    const session = await transport.inject({ pid: 4242 })

    server.emit('node/abc', 'Runtime.consoleAPICalled', {
      type: 'warning',
      args: [{ value: 'main says hi' }],
    })

    const { entries } = await session.consoleLogs()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ type: 'warning', text: 'main says hi' })
  })

  it('interaction and screenshot reject with NOT_IMPLEMENTED (main process only)', async () => {
    const { transport } = setup()
    const session = await transport.inject({ pid: 4242 })
    await expect(session.click('#x')).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
    await expect(session.screenshot({ kind: 'index', index: 0 })).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    })
  })

  it('dispose DETACHES without killing the app; methods reject afterwards', async () => {
    const { transport, killed } = setup({ aliveSequence: [true] })
    const session = await transport.inject({ pid: 4242 })

    await session.dispose()
    await session.dispose()

    expect(killed).toEqual([])
    await expect(session.consoleLogs()).rejects.toMatchObject({ code: 'NOT_RUNNING' })
  })
})

describe('InjectorSession stop', () => {
  it('quits gracefully via the Electron API when the process exits in budget', async () => {
    const { server, transport, killed } = setup({ aliveSequence: [false] })
    const quits: string[] = []
    server.respond('Runtime.evaluate', (params) => {
      const expr = String(params?.['expression'] ?? '')
      if (expr.includes('app.quit()')) quits.push(expr)
      return { result: { value: true } }
    })
    const session = await transport.inject({ pid: 4242 })

    await expect(transport.stop(session)).resolves.toEqual({ escalated: false })
    expect(quits).toHaveLength(1)
    expect(killed).toEqual([])
  })

  it('escalates to SIGKILL when the process survives the budget', async () => {
    const { transport, killed } = setup({ aliveSequence: [true, true, true, false] })
    const session = await transport.inject({ pid: 4242 })

    await expect(transport.stop(session, { timeoutMs: 30 })).resolves.toEqual({
      escalated: true,
    })
    expect(killed).toEqual([4242])
  })
})
