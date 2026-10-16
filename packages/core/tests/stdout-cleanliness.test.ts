/**
 * Stdout cleanliness gate (MCP protocol safety).
 *
 * The stdio transport reserves **stdout** for JSON-RPC protocol frames; anything else written
 * there — a stray `console.log`, a chatty dependency, a debug print left in a tool handler —
 * corrupts the stream and breaks the client, often silently. `logger.test.ts` proves the logger
 * routes to stderr in isolation; this gate proves the property END-TO-END: a full
 * `initialize` -> `tools/list` -> `tools/call` session over a real {@link StdioServerTransport}
 * emits only valid newline-delimited JSON-RPC on the server's stdout stream, and the server never
 * writes to the process's real `stdout`.
 *
 * It drives the wire directly (raw JSON-RPC over injected streams) rather than through the SDK
 * `Client`, so the assertion is about the exact bytes on the channel — which is the thing that
 * actually has to stay clean.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { inspectDefaultElectron } from '../src/runtime/default-electron.js'
import { createServer, type StagewrightServer } from '../src/server/server.js'
import { TransportRegistry } from '../src/server/transport-registry.js'
import {
  PlaywrightElectronTransport,
  loadPlaywrightElectron,
} from '../src/transports/playwright-electron.js'
import type { PWModule } from '../src/transports/playwright-electron-api.js'

/** Serialise a JSON-RPC message the way the stdio transport frames it: one JSON object per line. */
function frame(message: unknown): string {
  return `${JSON.stringify(message)}\n`
}

/** Connect a server over injected streams and collect every line it writes as a frame or a bad line. */
async function connectWire(server: StagewrightServer): Promise<{
  readonly serverIn: PassThrough
  readonly frames: Array<Record<string, unknown>>
  readonly badLines: string[]
  readonly waitForId: (id: number) => Promise<void>
}> {
  const serverIn = new PassThrough()
  const serverOut = new PassThrough()
  const frames: Array<Record<string, unknown>> = []
  const badLines: string[] = []
  let buf = ''
  serverOut.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim().length === 0) continue
      try {
        frames.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        badLines.push(line)
      }
    }
  })
  await server.mcp.connect(new StdioServerTransport(serverIn, serverOut))
  const waitForId = (id: number): Promise<void> =>
    vi.waitFor(() => expect(frames.some((f) => f['id'] === id)).toBe(true), {
      timeout: 5000,
      interval: 10,
    })
  serverIn.write(
    frame({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'stdout-gate', version: '0.0.0' },
      },
    }),
  )
  await waitForId(1)
  serverIn.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }))
  return { serverIn, frames, badLines, waitForId }
}

describe('stdout cleanliness (MCP protocol safety)', () => {
  let server: StagewrightServer | undefined
  afterEach(async () => {
    await server?.close().catch(() => undefined)
    server = undefined
    vi.restoreAllMocks()
  })

  it('emits only valid JSON-RPC frames over a full session and never writes to real stdout', async () => {
    // Capture (and swallow) any write to the process's real stdout. A clean server never touches
    // it — all protocol goes through the injected stream below — so a single call here means a
    // non-protocol write leaked onto the channel the client is parsing.
    const realStdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    // Swallow real stderr too (the default logger writes diagnostics there at debug level): keeps
    // CI output clean, and lets us assert the diagnostic channel IS stderr — the other half of the
    // invariant (diagnostics → stderr, protocol → stdout).
    const realStderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    server = await createServer({ logLevel: 'debug' })
    const { serverIn, frames, badLines, waitForId } = await connectWire(server)

    serverIn.write(frame({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
    await waitForId(2)

    // A real dispatch through the dispatcher + a tool handler (which logs to stderr at debug).
    serverIn.write(
      frame({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'electron_info', arguments: { sessionId: 'no-such-session' } },
      }),
    )
    await waitForId(3)

    // No frame failed to parse as JSON — the channel carried only protocol.
    expect(badLines).toEqual([])
    // Every frame is JSON-RPC 2.0.
    expect(frames.length).toBeGreaterThanOrEqual(3)
    for (const f of frames) expect(f['jsonrpc']).toBe('2.0')
    // tools/list returned the real (non-empty) core tool surface.
    const list = frames.find((f) => f['id'] === 2)
    const tools = (list?.['result'] as { tools?: unknown[] } | undefined)?.tools
    expect(Array.isArray(tools) && tools.length).toBeTruthy()
    // The load-bearing assertion: the server never wrote to the process's real stdout. A stray
    // console.log / process.stdout.write anywhere in the dispatch path would trip this.
    expect(realStdout).not.toHaveBeenCalled()
    // ...and the diagnostics it did emit (the logger runs at debug here) went to stderr, not the
    // protocol channel — confirming the split rather than just silence.
    expect(realStderr).toHaveBeenCalled()
  }, 15_000)

  it('refuses a launch whose Electron binary is missing instead of letting it write to stdout', async () => {
    const realStdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const fixture = await mkdtemp(join(tmpdir(), 'sw-stdout-electron-'))
    try {
      // An electron package as npx installs it from Electron 42 on: manifest only, no binary yet.
      await writeFile(
        join(fixture, 'package.json'),
        JSON.stringify({ name: 'electron', version: '42.11.10' }),
      )
      const main = join(fixture, 'main.js')
      await writeFile(main, '')
      // Stands in for Playwright loading Electron's entry, which downloads the binary and prints.
      const launch = vi.fn(() => {
        console.log('Downloading Electron binary...')
        return Promise.reject(new Error('download interrupted'))
      })
      const playwright: PWModule = { _electron: { launch } }
      const transport = new PlaywrightElectronTransport({
        loadElectron: () =>
          loadPlaywrightElectron({
            importPlaywright: async () => playwright,
            inspectElectron: () =>
              inspectDefaultElectron({
                env: {},
                resolveElectronPackageJson: () => join(fixture, 'package.json'),
              }),
          }),
      })
      server = await createServer({
        transports: new TransportRegistry({ transports: [transport] }),
      })
      const { serverIn, frames, badLines, waitForId } = await connectWire(server)

      serverIn.write(
        frame({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'electron_launch', arguments: { main } },
        }),
      )
      await waitForId(2)

      expect(badLines).toEqual([])
      expect(realStdout).not.toHaveBeenCalled()
      expect(launch).not.toHaveBeenCalled()
      const result = frames.find((f) => f['id'] === 2)?.['result'] as {
        content: Array<{ text: string }>
      }
      expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
        ok: false,
        code: 'ELECTRON_RUNTIME_MISSING',
        error: expect.stringContaining('install-electron'),
        details: { reason: 'binary_missing', electron_version: '42.11.10' },
      })
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  }, 15_000)
})
