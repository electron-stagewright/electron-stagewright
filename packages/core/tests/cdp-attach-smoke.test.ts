/**
 * Real-Electron CDP attach smoke — spawns the minimal fixture app with
 * `--remote-debugging-port=0`, parses the DevTools endpoint from stderr, and
 * drives the REAL CDP transport end to end through the dispatcher:
 * `electron_attach` → windows list → renderer eval → console capture →
 * `electron_stop` (which must actually reap the process).
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
import { stopTool } from '../src/tools/lifecycle/index.js'

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
})
