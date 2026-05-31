/**
 * Real-Electron observe smoke — proves `electron_screenshot` writes a real PNG,
 * `electron_console_logs` captures a real renderer console message, and
 * `electron_dialog_handler` auto-responds to real native dialogs end to end (none
 * of which is reproducible under JSDOM, which has no renderer or layout).
 *
 * Opt-in: runs only when `STAGEWRIGHT_E2E=1` (and `electron` + `playwright` are
 * installed with their binaries). Skipped by default. Run it locally with:
 *
 *   pnpm -F @electron-stagewright/core add -D electron playwright
 *   STAGEWRIGHT_E2E=1 pnpm test
 *
 * The captured PNG is written under output/review/observe-smoke/ (gitignored) so
 * the operator can open it during review.
 *
 * @module
 */

import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { TransportRegistry } from '../src/server/transport-registry.js'
import { clickTool } from '../src/tools/interaction/index.js'
import { launchTool, stopTool } from '../src/tools/lifecycle/index.js'
import { OBSERVE_TOOLS } from '../src/tools/observe/index.js'
import { PlaywrightElectronTransport } from '../src/transports/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_MAIN = path.join(HERE, 'fixtures', 'minimal-electron', 'main.js')
const ARTIFACT_DIR = path.join(HERE, '..', '..', '..', 'output', 'review', 'observe-smoke')

const sessions = new SessionManager()

afterAll(async () => {
  await sessions.disposeAll()
})

describe('observe smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'writes a PNG screenshot and captures a console log from a live renderer',
    async () => {
      await mkdir(ARTIFACT_DIR, { recursive: true })
      const transports = new TransportRegistry({ transports: [new PlaywrightElectronTransport()] })
      const dispatcher = new Dispatcher({ sessions, transports })
      dispatcher.registerAll([launchTool, stopTool, clickTool, ...OBSERVE_TOOLS])

      const launched = await dispatcher.dispatch('electron_launch', { main: FIXTURE_MAIN })
      const sessionId = (launched as SuccessResponse & { session_id: string }).session_id

      const shot = (await dispatcher.dispatch('electron_screenshot', {
        sessionId,
        path: path.join(ARTIFACT_DIR, 'fixture.png'),
        fullPage: true,
      })) as SuccessResponse & { path: string; bytes: number }
      expect(shot.bytes).toBeGreaterThan(0)
      expect((await stat(shot.path)).size).toBe(shot.bytes)

      // Click logs to the console; then read it back through the capture buffer.
      await dispatcher.dispatch('electron_click', { sessionId, selector: '#log' })
      const logs = (await dispatcher.dispatch('electron_console_logs', {
        sessionId,
        match: 'stagewright-console-probe',
      })) as SuccessResponse & { count: number }
      expect(logs.count).toBeGreaterThanOrEqual(1)

      // Arm accept, trigger a real confirm() and alert(), then read the captured
      // dialog events back. The clicks only resolve because the session's dialog
      // listener auto-responds. (Electron has no window.prompt(), so prompt-text
      // handling is exercised in the unit tests, not here.)
      await dispatcher.dispatch('electron_dialog_handler', { sessionId, action: 'accept' })
      await dispatcher.dispatch('electron_click', { sessionId, selector: '#confirm' })
      await dispatcher.dispatch('electron_click', { sessionId, selector: '#alert' })
      const dialogs = (await dispatcher.dispatch('electron_dialog_handler', {
        sessionId,
      })) as SuccessResponse & {
        count: number
        entries: { type: string; action: string }[]
      }
      expect(dialogs.count).toBeGreaterThanOrEqual(2)
      expect(dialogs.entries.map((e) => e.type)).toEqual(
        expect.arrayContaining(['confirm', 'alert']),
      )
      const confirmed = dialogs.entries.find((e) => e.type === 'confirm')
      expect(confirmed?.action).toBe('accept')

      const stopped = await dispatcher.dispatch('electron_stop', { sessionId })
      expect(stopped.ok).toBe(true)
      expect(sessions.size).toBe(0)
    },
    60_000,
  )
})
