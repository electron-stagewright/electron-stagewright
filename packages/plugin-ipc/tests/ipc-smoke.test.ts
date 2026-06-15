/**
 * Real-Electron IPC smoke (ADR-010) — runs the actual INSTRUMENT_BODY shim against a live main
 * process via the real transport's `evaluate('main', …)`. Launches a fixture that registers
 * `ipcMain.handle('ping')` BEFORE capture starts, so this exercises re-wrapping an already-
 * registered handler, invoking it from main, and reading the captured event back.
 *
 * Opt-in: runs only when `STAGEWRIGHT_E2E=1` (with `electron` + `playwright` installed). Skipped by
 * default so `pnpm test` stays fast and headless-CI-safe. The server permits main eval because IPC
 * instrumentation runs main-process JS.
 *
 * @module
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createServer } from '@electron-stagewright/core'
import { afterAll, describe, expect, it } from 'vitest'

import ipcPlugin from '../src/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const FIXTURE_MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'ipc-app',
  'main.js',
)

const closers: Array<() => Promise<void>> = []
afterAll(async () => {
  await Promise.all(closers.splice(0).map((c) => c().catch(() => undefined)))
})

describe('ipc plugin smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'captures and invokes a real ipcMain.handle channel, then restores on stop',
    async () => {
      const server = await createServer({
        plugins: [ipcPlugin],
        allowEval: { main: true, renderer: false },
      })
      closers.push(() => server.close())

      const launched = (await server.dispatcher.dispatch('electron_launch', {
        main: FIXTURE_MAIN,
      })) as { ok: boolean; session_id?: string; _meta?: { session_id?: string } }
      expect(launched.ok).toBe(true)
      const sessionId = launched.session_id ?? launched._meta?.session_id
      if (typeof sessionId !== 'string') throw new Error('launch returned no session id')

      expect(
        await server.dispatcher.dispatch('ipc_capture_start', { sessionId, channels: ['ping'] }),
      ).toMatchObject({ ok: true, capturing: true })

      // Invoke the registered handle channel from main and confirm its real result.
      expect(
        await server.dispatcher.dispatch('ipc_invoke', {
          sessionId,
          channel: 'ping',
          args: [{ x: 1 }],
        }),
      ).toMatchObject({ ok: true, result: { pong: { x: 1 } } })

      // The invoke went through the wrapped (re-wrapped existing) handler, so it was captured.
      const captured = (await server.dispatcher.dispatch('ipc_captured', {
        sessionId,
        channel: 'ping',
      })) as unknown as { ok: boolean; count: number }
      expect(captured.ok).toBe(true)
      expect(captured.count).toBeGreaterThanOrEqual(1)

      expect(await server.dispatcher.dispatch('ipc_capture_stop', { sessionId })).toMatchObject({
        ok: true,
        stopped: true,
      })
      expect((await server.dispatcher.dispatch('electron_stop', { sessionId })).ok).toBe(true)
    },
    60_000,
  )
})
