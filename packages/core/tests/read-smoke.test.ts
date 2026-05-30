/**
 * Real-Electron read smoke — drives the read tools against an actual Electron
 * renderer through the real PlaywrightElectronTransport, proving the inline read
 * bodies and the `__stagewrightProbe` bundle resolve real layout / visibility /
 * value (which JSDOM cannot) end-to-end.
 *
 * Opt-in: runs only when `STAGEWRIGHT_E2E=1` (and `electron` + `playwright` are
 * installed with their binaries). Skipped by default so `pnpm test` stays fast
 * and headless-CI-safe. Run it locally with:
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
import { READ_TOOLS } from '../src/tools/read/index.js'
import { launchTool, stopTool } from '../src/tools/lifecycle/index.js'
import { snapshotTool } from '../src/tools/snapshot/index.js'
import { typeTool } from '../src/tools/interaction/index.js'
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

describe('read smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'reads text, value, state, existence, focus, and selector matches from a live renderer',
    async () => {
      const snapshots = new SnapshotStore()
      const transports = new TransportRegistry({ transports: [new PlaywrightElectronTransport()] })
      const dispatcher = new Dispatcher({ sessions, snapshots, transports })
      dispatcher.registerAll([launchTool, snapshotTool, typeTool, stopTool, ...READ_TOOLS])

      const launched = await dispatcher.dispatch('electron_launch', { main: FIXTURE_MAIN })
      const sessionId = (launched as SuccessResponse & { session_id: string }).session_id

      const text = (await dispatcher.dispatch('electron_get_text', {
        sessionId,
        selector: 'h1',
      })) as SuccessResponse & { text: string }
      expect(text.text).toContain('Stagewright')

      const state = (await dispatcher.dispatch('electron_get_state', {
        sessionId,
        selector: '#ping',
      })) as SuccessResponse & { role: string; state: { visible: boolean; disabled: boolean } }
      expect(state.role).toBe('button')
      expect(state.state.visible).toBe(true)
      expect(state.state.disabled).toBe(false)

      await dispatcher.dispatch('electron_type', { sessionId, selector: '#name', text: 'Ada' })
      const value = (await dispatcher.dispatch('electron_get_value', {
        sessionId,
        selector: '#name',
      })) as SuccessResponse & { value: string }
      expect(value.value).toBe('Ada')

      const present = (await dispatcher.dispatch('electron_exists', {
        sessionId,
        selector: '#ping',
      })) as SuccessResponse & { exists: boolean }
      expect(present.exists).toBe(true)
      const absent = (await dispatcher.dispatch('electron_exists', {
        sessionId,
        selector: '#does-not-exist',
      })) as SuccessResponse & { exists: boolean }
      expect(absent.exists).toBe(false)

      const list = (await dispatcher.dispatch('electron_elements_list', {
        sessionId,
        selector: 'button',
      })) as SuccessResponse & { count: number }
      expect(list.count).toBeGreaterThanOrEqual(1)

      const focused = (await dispatcher.dispatch('electron_focused_element', {
        sessionId,
      })) as SuccessResponse & { focused: { role: string } | null }
      // After typing, the text input holds focus.
      expect(focused.focused?.role).toBe('textbox')

      const stopped = await dispatcher.dispatch('electron_stop', { sessionId })
      expect(stopped.ok).toBe(true)
      expect(sessions.size).toBe(0)
    },
    60_000,
  )
})
