/**
 * Real-Electron eval smoke — proves the gated eval tools round-trip through the
 * real main-process and renderer evaluate channels when the server is started
 * with `--allow-eval` (modelled here by a dispatcher built with allowEval: true).
 *
 * Opt-in: runs only when `STAGEWRIGHT_E2E=1` (and `electron` + `playwright` are
 * installed with their binaries). Skipped by default. Run it locally with:
 *
 *   pnpm -F @electron-stagewright/core add -D electron playwright
 *   STAGEWRIGHT_E2E=1 pnpm test
 *
 * @module
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { TransportRegistry } from '../src/server/transport-registry.js'
import { EVAL_TOOLS } from '../src/tools/eval/index.js'
import { launchTool, stopTool } from '../src/tools/lifecycle/index.js'
import { PlaywrightElectronTransport } from '../src/transports/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const FIXTURE_MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'minimal-electron',
  'main.js',
)

const sessions = new SessionManager()

afterAll(async () => {
  await sessions.disposeAll()
})

describe('eval smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'evaluates in the main process and the renderer with --allow-eval',
    async () => {
      const transports = new TransportRegistry({ transports: [new PlaywrightElectronTransport()] })
      // allowEval: true models a server started with --allow-eval.
      const dispatcher = new Dispatcher({ sessions, transports, allowEval: true })
      dispatcher.registerAll([launchTool, stopTool, ...EVAL_TOOLS])

      const launched = await dispatcher.dispatch('electron_launch', { main: FIXTURE_MAIN })
      const sessionId = (launched as SuccessResponse & { session_id: string }).session_id

      const main = (await dispatcher.dispatch('electron_eval_main', {
        sessionId,
        code: 'return electronApp.app.getVersion()',
      })) as SuccessResponse & { result: unknown }
      expect(typeof main.result).toBe('string')
      expect((main.result as string).length).toBeGreaterThan(0)

      const renderer = (await dispatcher.dispatch('electron_eval_renderer', {
        sessionId,
        code: 'return document.title',
      })) as SuccessResponse & { result: unknown }
      expect(typeof renderer.result).toBe('string')

      const stopped = await dispatcher.dispatch('electron_stop', { sessionId })
      expect(stopped.ok).toBe(true)
      expect(sessions.size).toBe(0)
    },
    60_000,
  )
})
