/**
 * Real-Electron expect smoke — proves the `expect_*` assertion family resolves
 * against a live renderer end to end: text / visibility / element state, plus both
 * count modes (CSS selector and accessibility role, the latter exercising the real
 * walker + findEntries path) and the one-shot assert_pattern. None of this is
 * reproducible under JSDOM, which has no renderer or layout.
 *
 * Opt-in: runs only when `STAGEWRIGHT_E2E=1` (and `electron` + `playwright` are
 * installed with their binaries). Skipped by default. Run it locally with:
 *
 *   STAGEWRIGHT_E2E=1 pnpm test expect-smoke
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
import { EXPECT_TOOLS } from '../src/tools/expect/index.js'
import { launchTool, stopTool } from '../src/tools/lifecycle/index.js'
import { PlaywrightElectronTransport } from '../src/transports/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_MAIN = path.join(HERE, 'fixtures', 'minimal-electron', 'main.js')

const sessions = new SessionManager()

afterAll(async () => {
  await sessions.disposeAll()
})

describe('expect smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'resolves text / visible / state / count / assert_pattern against a live renderer',
    async () => {
      const transports = new TransportRegistry({ transports: [new PlaywrightElectronTransport()] })
      const dispatcher = new Dispatcher({ sessions, transports })
      dispatcher.registerAll([launchTool, stopTool, ...EXPECT_TOOLS])

      const launched = await dispatcher.dispatch('electron_launch', { main: FIXTURE_MAIN })
      const sessionId = (launched as SuccessResponse & { session_id: string }).session_id

      const text = await dispatcher.dispatch('electron_expect_text', {
        sessionId,
        selector: 'h1',
        contains: 'Stagewright',
      })
      expect(text.ok).toBe(true)

      const visible = await dispatcher.dispatch('electron_expect_visible', {
        sessionId,
        selector: '#ping',
      })
      expect(visible.ok).toBe(true)

      const state = await dispatcher.dispatch('electron_expect_state', {
        sessionId,
        selector: '#agree',
        state: { checked: false },
      })
      expect(state.ok).toBe(true)

      // Selector mode: the fixture has several buttons.
      const countSelector = (await dispatcher.dispatch('electron_expect_count', {
        sessionId,
        selector: 'button',
        min: 3,
      })) as SuccessResponse & { actual: number }
      expect(countSelector.ok).toBe(true)
      expect(countSelector.actual).toBeGreaterThanOrEqual(3)

      // Role mode: counts via the real walker + findEntries.
      const countRole = await dispatcher.dispatch('electron_expect_count', {
        sessionId,
        role: 'button',
        min: 3,
      })
      expect(countRole.ok).toBe(true)

      const pattern = await dispatcher.dispatch('electron_assert_pattern', {
        sessionId,
        selector: 'h1',
        contains: 'fixture',
      })
      expect(pattern.ok).toBe(true)

      const stopped = await dispatcher.dispatch('electron_stop', { sessionId })
      expect(stopped.ok).toBe(true)
      expect(sessions.size).toBe(0)
    },
    60_000,
  )
})
