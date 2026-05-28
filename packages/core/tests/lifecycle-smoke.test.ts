/**
 * Real-Electron lifecycle smoke test — the first time the lifecycle tools drive
 * an actual Electron app through the real PlaywrightElectronTransport.
 *
 * Opt-in: this test only runs when `STAGEWRIGHT_E2E=1` is set (and `electron` +
 * `playwright` are installed with their binaries). It is skipped by default — in
 * CI without a display and in environments without Electron — so the regular
 * `pnpm test` stays fast and green. Run it locally with:
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
import { PlaywrightElectronTransport } from '../src/transports/index.js'
import { infoTool, launchTool, stopTool, windowsListTool } from '../src/tools/lifecycle/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const FIXTURE_MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'minimal-electron',
  'main.js',
)

const sessions = new SessionManager()

afterAll(async () => {
  // Safety net: never leave a launched Electron process orphaned.
  await sessions.disposeAll()
})

describe('lifecycle smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'launches the fixture, reports info, lists windows, and stops',
    async () => {
      const transports = new TransportRegistry({ transports: [new PlaywrightElectronTransport()] })
      const dispatcher = new Dispatcher({ sessions, transports })
      dispatcher.registerAll([launchTool, infoTool, windowsListTool, stopTool])

      const launched = await dispatcher.dispatch('electron_launch', { main: FIXTURE_MAIN })
      expect(launched.ok).toBe(true)
      const sessionId = (launched as SuccessResponse & { session_id: string }).session_id

      const info = await dispatcher.dispatch('electron_info', { sessionId })
      expect(info.ok).toBe(true)
      expect(
        (info as SuccessResponse & { versions: { electron: string | null } }).versions.electron,
      ).toBeTruthy()

      const windows = await dispatcher.dispatch('electron_windows_list', { sessionId })
      expect((windows as SuccessResponse & { count: number }).count).toBeGreaterThanOrEqual(1)

      const stopped = await dispatcher.dispatch('electron_stop', { sessionId })
      expect(stopped.ok).toBe(true)
      expect(sessions.size).toBe(0)
    },
    60_000,
  )
})
