/**
 * Real-Electron wait smoke — proves the renderer poll bodies resolve against a
 * live renderer: a selector that is already visible, and a state transition
 * (check a box, then wait for its checked state) that JSDOM cannot simulate with
 * real layout.
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
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { TransportRegistry } from '../src/server/transport-registry.js'
import { checkTool } from '../src/tools/interaction/index.js'
import { launchTool, stopTool } from '../src/tools/lifecycle/index.js'
import { snapshotTool } from '../src/tools/snapshot/index.js'
import { WAIT_TOOLS } from '../src/tools/wait/index.js'
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

describe('wait smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'waits for a visible selector and for a real checked-state transition',
    async () => {
      const snapshots = new SnapshotStore()
      const transports = new TransportRegistry({ transports: [new PlaywrightElectronTransport()] })
      const dispatcher = new Dispatcher({ sessions, snapshots, transports })
      dispatcher.registerAll([launchTool, snapshotTool, checkTool, stopTool, ...WAIT_TOOLS])

      const launched = await dispatcher.dispatch('electron_launch', { main: FIXTURE_MAIN })
      const sessionId = (launched as SuccessResponse & { session_id: string }).session_id

      const visible = (await dispatcher.dispatch('electron_wait_for_selector', {
        sessionId,
        selector: '#ping',
        state: 'visible',
      })) as SuccessResponse & { matched: boolean }
      expect(visible.matched).toBe(true)

      // Flip a real state, then wait for it atomically.
      await dispatcher.dispatch('electron_check', { sessionId, selector: '#agree' })
      const checked = (await dispatcher.dispatch('electron_wait_for_state', {
        sessionId,
        selector: '#agree',
        state: { checked: true, enabled: true },
      })) as SuccessResponse & { matched: boolean }
      expect(checked.matched).toBe(true)

      const stopped = await dispatcher.dispatch('electron_stop', { sessionId })
      expect(stopped.ok).toBe(true)
      expect(sessions.size).toBe(0)
    },
    60_000,
  )
})
