/**
 * Real-Electron CDP lifecycle smoke — launches an executable-only fixture through
 * the transport-owned endpoint and also spawns the fixture with
 * `--remote-debugging-port=0` for attach coverage. Drives the REAL CDP transport
 * end to end through the dispatcher, including default-surface snapshot/find,
 * renderer eval, console/network capture, detach ownership, and process reaping.
 *
 * Opt-in: runs only when `STAGEWRIGHT_E2E=1` (and the `electron` devDep binary
 * is installed). Skipped by default so `pnpm test` stays fast and headless-CI-safe.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { TransportRegistry } from '../src/server/transport-registry.js'
import { attachTool } from '../src/tools/lifecycle/attach.js'
import { detachTool, launchTool, stopTool } from '../src/tools/lifecycle/index.js'
import { findTool, snapshotTool } from '../src/tools/snapshot/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const FIXTURE_MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'minimal-electron',
  'main.js',
)

let child: ChildProcess | undefined

afterAll(() => {
  if (child !== undefined && child.exitCode === null) child.kill('SIGKILL')
})

/** Spawn the fixture with a random debugging port and resolve the advertised ws URL. */
async function spawnWithCdp(): Promise<{ readonly cdpUrl: string; readonly proc: ChildProcess }> {
  const electronPath = (await import('electron')).default as unknown as string
  const proc = spawn(electronPath, [FIXTURE_MAIN, '--remote-debugging-port=0'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child = proc
  const cdpUrl = await new Promise<string>((resolve, reject) => {
    let stderr = ''
    const timer = setTimeout(
      () => reject(new Error(`DevTools endpoint never appeared on stderr:\n${stderr}`)),
      20_000,
    )
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr)
      if (match?.[1] !== undefined) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Electron exited (${code}) before advertising DevTools:\n${stderr}`))
    })
  })
  return { cdpUrl, proc }
}

describe('CDP attach smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'launches an executable-only app over CDP, snapshots/finds its default page, and reaps it',
    async () => {
      const electronPath = (await import('electron')).default as unknown as string
      const sessions = new SessionManager()
      const dispatcher = new Dispatcher({
        sessions,
        snapshots: new SnapshotStore(),
        transports: new TransportRegistry(),
      })
      dispatcher.registerAll([launchTool, snapshotTool, findTool, detachTool, stopTool])

      let sessionId: string | undefined
      try {
        const launched = (await dispatcher.dispatch('electron_launch', {
          executablePath: electronPath,
          // A packaged binary embeds its app. Passing the fixture as an argument lets the stock
          // Electron dev dependency exercise the same executable-only CDP lifecycle in CI.
          args: [FIXTURE_MAIN],
          timeoutMs: 30_000,
          readyTimeoutMs: 10_000,
        })) as SuccessResponse & {
          readonly session_id: string
          readonly transport: string
          readonly launch_mode: string
          readonly renderer_ready: boolean
          readonly capabilities: { readonly canLaunch: boolean }
        }
        sessionId = launched.session_id
        expect(launched).toMatchObject({
          ok: true,
          transport: 'cdp',
          launch_mode: 'packaged',
          renderer_ready: true,
          capabilities: { canLaunch: true },
        })

        const snapshot = (await dispatcher.dispatch('electron_snapshot', {
          sessionId,
        })) as SuccessResponse & {
          readonly surface_id: string
          readonly snapshot: { readonly entries: readonly { readonly name: string }[] }
        }
        expect(snapshot.ok).toBe(true)
        expect(snapshot.surface_id).toBeTruthy()
        expect(
          snapshot.snapshot.entries.some((entry) =>
            entry.name.includes('Stagewright minimal fixture'),
          ),
        ).toBe(true)

        const found = await dispatcher.dispatch('electron_find', {
          sessionId,
          role: 'button',
          name_exact: 'Ping',
        })
        expect(found).toMatchObject({ ok: true, count: 1, surface_id: snapshot.surface_id })

        const detached = await dispatcher.dispatch('electron_detach', { sessionId })
        expect(detached).toMatchObject({ ok: false, code: 'TRANSPORT_UNSUPPORTED' })
        expect(sessions.has(sessionId)).toBe(true)

        const stopped = await dispatcher.dispatch('electron_stop', { sessionId })
        expect(stopped).toMatchObject({ ok: true, stopped: true, escalated: false })
        expect(sessions.size).toBe(0)
        sessionId = undefined
      } finally {
        if (sessionId !== undefined && sessions.has(sessionId)) {
          await sessions.remove(sessionId, { force: true })
        }
      }
    },
    120_000,
  )

  it.skipIf(!RUN_E2E)(
    'detaches without terminating the attached Electron process',
    async () => {
      const { cdpUrl, proc } = await spawnWithCdp()
      try {
        const sessions = new SessionManager()
        const dispatcher = new Dispatcher({
          sessions,
          snapshots: new SnapshotStore(),
          transports: new TransportRegistry(),
        })
        dispatcher.registerAll([attachTool, detachTool])
        const attached = (await dispatcher.dispatch('electron_attach', {
          cdpUrl,
        })) as SuccessResponse & { readonly session_id: string }
        expect(attached.ok).toBe(true)

        await expect(
          dispatcher.dispatch('electron_detach', { sessionId: attached.session_id }),
        ).resolves.toMatchObject({ ok: true, detached: true })
        expect(sessions.size).toBe(0)
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(proc.exitCode).toBeNull()
      } finally {
        if (proc.exitCode === null) proc.kill('SIGKILL')
      }
    },
    60_000,
  )

  it.skipIf(!RUN_E2E)(
    'attaches over CDP, lists windows, evaluates, captures console, and stops',
    async () => {
      const { cdpUrl, proc } = await spawnWithCdp()

      const sessions = new SessionManager()
      const dispatcher = new Dispatcher({
        sessions,
        snapshots: new SnapshotStore(),
        transports: new TransportRegistry(),
      })
      dispatcher.registerAll([attachTool, stopTool])

      // electron_attach routes through requireCapability('canAttach') → the CDP transport.
      const attached = (await dispatcher.dispatch('electron_attach', {
        cdpUrl,
      })) as SuccessResponse & {
        session_id: string
        transport: string
        windows: readonly { readonly title: string }[]
      }
      expect(attached.ok).toBe(true)
      expect(attached.transport).toBe('cdp')
      expect(attached.windows.length).toBeGreaterThan(0)

      // Renderer evaluation over the pooled page connection (awaitPromise path).
      const session = sessions.get(attached.session_id)?.session
      expect(session).toBeDefined()
      await expect(
        session?.evaluate('renderer', 'return 40 + arg.delta;', { delta: 2 }),
      ).resolves.toBe(42)

      // Console capture: log in the renderer, then read the aggregated buffer.
      await session?.evaluate('renderer', 'console.log("cdp-smoke-marker"); return true;')
      // The consoleAPICalled event is asynchronous; give it a short settle.
      await new Promise((resolve) => setTimeout(resolve, 500))
      const logs = await session?.consoleLogs()
      expect(logs?.entries.some((e) => e.text.includes('cdp-smoke-marker'))).toBe(true)

      // Stop must actually end the process (Browser.close), not just drop the socket.
      const stopped = await dispatcher.dispatch('electron_stop', {
        sessionId: attached.session_id,
      })
      expect(stopped).toMatchObject({ ok: true, stopped: true })
      await new Promise<void>((resolve) => {
        if (proc.exitCode !== null) {
          resolve()
          return
        }
        const timer = setTimeout(() => {
          proc.kill('SIGKILL')
          resolve()
        }, 10_000)
        proc.on('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      expect(proc.exitCode).not.toBeNull()
    },
    120_000,
  )

  it.skipIf(!RUN_E2E)(
    'captures a stubbed renderer request over the CDP Network + Fetch domains',
    async () => {
      const { cdpUrl, proc } = await spawnWithCdp()
      const sessions = new SessionManager()
      const dispatcher = new Dispatcher({
        sessions,
        snapshots: new SnapshotStore(),
        transports: new TransportRegistry(),
      })
      dispatcher.registerAll([attachTool, stopTool])
      const attached = (await dispatcher.dispatch('electron_attach', {
        cdpUrl,
      })) as SuccessResponse & {
        session_id: string
      }
      const session = sessions.get(attached.session_id)?.session
      if (session === undefined) throw new Error('attach returned no session')

      // Arm capture (with bodies), stub an unresolvable URL so the renderer fetch only succeeds via the
      // Fetch domain — a captured 200 proves the stub fired AND that a stubbed request is still captured
      // over CDP (capture and stubbing compose, as on Playwright).
      await session.startNetworkCapture({ urls: ['/api/'], captureBodies: true })
      await session.stubNetwork({
        urls: ['/api/probe'],
        fulfill: { status: 200, contentType: 'application/json', body: '{"cdp":true}' },
      })
      await session.evaluate(
        'renderer',
        'void fetch("https://stagewright.invalid/api/probe").then((r) => r.text()).catch(() => {}); return true;',
      )

      const deadline = Date.now() + 10_000
      let probe:
        | { readonly url: string; readonly status?: number; readonly responseBody?: string }
        | undefined
      while (Date.now() < deadline) {
        const { events } = await session.networkEvents()
        probe = events.find((e) => e.url.includes('/api/probe'))
        if (probe?.status === 200) break
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      expect(probe, 'a stubbed /api/probe request should have been captured').toBeDefined()
      expect(probe?.status).toBe(200)
      expect(probe?.responseBody).toContain('"cdp":true')

      await session.clearNetworkStubs()
      await session.stopNetworkCapture()
      await dispatcher.dispatch('electron_stop', { sessionId: attached.session_id })
      await new Promise<void>((resolve) => {
        if (proc.exitCode !== null) {
          resolve()
          return
        }
        const timer = setTimeout(() => {
          proc.kill('SIGKILL')
          resolve()
        }, 10_000)
        proc.on('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
    120_000,
  )
})
