/**
 * Unit tests for discovery: most cases inject a deterministic probe, plus one
 * local HTTP regression test for the real probe's hard timeout.
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { describe, expect, it } from 'vitest'

import { type ErrorResponse, type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import {
  type DiscoveredTarget,
  type PortProbe,
  discoverRunning,
  makeDiscoverTool,
  parseCdpVersionResponse,
} from '../src/tools/lifecycle/discover.js'

/** A probe that reports a target only on the given port. */
function probeOnlyPort(port: number): PortProbe {
  return async (host, candidate) =>
    candidate === port
      ? {
          targetId: `ws://${host}:${candidate}`,
          port: candidate,
          appName: 'Electron/32',
          pid: null,
        }
      : null
}

describe('discoverRunning', () => {
  it('parses only CDP /json/version payloads with a websocket debugger URL', () => {
    expect(parseCdpVersionResponse('{"ok":true}', 9222)).toBeNull()
    expect(
      parseCdpVersionResponse(
        '{"Browser":"Electron/32","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/abc"}',
        9222,
      ),
    ).toEqual({
      targetId: 'ws://127.0.0.1:9222/devtools/browser/abc',
      port: 9222,
      appName: 'Electron/32',
      pid: null,
    })
  })

  it('returns targets on open ports and a scan summary', async () => {
    const result = await discoverRunning({
      ports: [9222, 9223, 9224],
      probe: probeOnlyPort(9223),
      now: () => 0,
    })
    expect(result.targets).toHaveLength(1)
    expect(result.targets[0]?.port).toBe(9223)
    expect(result.scanned).toEqual({ host: '127.0.0.1', ports: [9222, 9223, 9224], elapsed_ms: 0 })
  })

  it('finds a target on a non-default port', async () => {
    const result = await discoverRunning({ ports: [9333], probe: probeOnlyPort(9333) })
    expect(result.targets[0]?.port).toBe(9333)
  })

  it('returns an empty target list when nothing answers', async () => {
    const result = await discoverRunning({ probe: async () => null })
    expect(result.targets).toEqual([])
    expect(result.scanned.ports).toEqual([9222, 9223, 9224, 9225])
  })

  it('treats a throwing probe as "no target" (never rejects)', async () => {
    const result = await discoverRunning({
      ports: [9222],
      probe: async () => {
        throw new Error('socket blew up')
      },
    })
    expect(result.targets).toEqual([])
  })

  it('hard-bounds the real HTTP probe even when a local service trickles data', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      const timer = setInterval(() => {
        res.write(' ')
      }, 5)
      res.on('close', () => {
        clearInterval(timer)
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        resolve()
      })
    })
    const address = server.address() as AddressInfo
    const started = Date.now()
    try {
      const result = await discoverRunning({ ports: [address.port], timeoutMs: 30 })
      expect(result.targets).toEqual([])
      expect(Date.now() - started).toBeLessThan(500)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
  })

  it('refuses non-loopback discovery hosts', async () => {
    await expect(
      discoverRunning({ host: 'example.com', probe: async () => null }),
    ).rejects.toMatchObject({
      code: 'BAD_ARGUMENT',
    })
  })
})

describe('electron_discover_running', () => {
  it('returns targets, count, and the scan summary', async () => {
    const target: DiscoveredTarget = {
      targetId: 'ws://127.0.0.1:9222',
      port: 9222,
      appName: 'Electron/32',
      pid: null,
    }
    const dispatcher = new Dispatcher({ sessions: new SessionManager() })
    dispatcher.register(
      makeDiscoverTool({
        discover: async () => ({
          targets: [target],
          scanned: { host: '127.0.0.1', ports: [9222], elapsed_ms: 5 },
        }),
      }),
    )

    const res = await dispatcher.dispatch('electron_discover_running', {})
    expect(res).toMatchObject({ ok: true, count: 1, targets: [target] })
    expect((res as SuccessResponse & { scanned: unknown }).scanned).toMatchObject({
      host: '127.0.0.1',
    })
    expect(JSON.parse(JSON.stringify(res))).toEqual(res)
  })

  it('rejects non-loopback hosts at input validation', async () => {
    const dispatcher = new Dispatcher({ sessions: new SessionManager() })
    dispatcher.register(
      makeDiscoverTool({
        discover: async () => ({ targets: [], scanned: { host: '', ports: [], elapsed_ms: 0 } }),
      }),
    )

    const res = await dispatcher.dispatch('electron_discover_running', { host: 'example.com' })
    expect((res as ErrorResponse).code).toBe('BAD_ARGUMENT')
  })

  it('rejects overly broad port scans at input validation', async () => {
    const dispatcher = new Dispatcher({ sessions: new SessionManager() })
    dispatcher.register(
      makeDiscoverTool({
        discover: async () => ({ targets: [], scanned: { host: '', ports: [], elapsed_ms: 0 } }),
      }),
    )

    const res = await dispatcher.dispatch('electron_discover_running', {
      ports: Array.from({ length: 65 }, (_, i) => 9_000 + i),
    })
    expect((res as ErrorResponse).code).toBe('BAD_ARGUMENT')
  })
})
