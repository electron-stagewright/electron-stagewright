/**
 * Real-Electron interaction smoke — drives the interaction tools against an
 * actual Electron renderer through the real PlaywrightElectronTransport, proving
 * end-to-end that `[data-sw-ref]` resolution + Playwright actionability work
 * against a live app (not just the fake transport).
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
import { PlaywrightElectronTransport } from '../src/transports/index.js'
import { checkTool, clickTool, selectOptionTool, typeTool } from '../src/tools/interaction/index.js'
import { launchTool, stopTool } from '../src/tools/lifecycle/index.js'
import { snapshotTool } from '../src/tools/snapshot/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const FIXTURE_MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'minimal-electron',
  'main.js',
)

interface SnapshotEntryShape {
  readonly ref: number | null
  readonly name: string
  readonly state: { readonly checked: boolean | null }
}

const sessions = new SessionManager()

afterAll(async () => {
  await sessions.disposeAll()
})

describe('interaction smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'clicks, types, checks, and selects against a live renderer',
    async () => {
      const snapshots = new SnapshotStore()
      const transports = new TransportRegistry({ transports: [new PlaywrightElectronTransport()] })
      const dispatcher = new Dispatcher({ sessions, snapshots, transports })
      dispatcher.registerAll([
        launchTool,
        snapshotTool,
        clickTool,
        typeTool,
        checkTool,
        selectOptionTool,
        stopTool,
      ])

      const launched = await dispatcher.dispatch('electron_launch', { main: FIXTURE_MAIN })
      const sessionId = (launched as SuccessResponse & { session_id: string }).session_id

      // Seed the per-session snapshot baseline so the ref-freshness guard has a view.
      await dispatcher.dispatch('electron_snapshot', { sessionId })

      const clicked = await dispatcher.dispatch('electron_click', { sessionId, selector: '#ping' })
      expect(clicked.ok).toBe(true)

      const typed = await dispatcher.dispatch('electron_type', {
        sessionId,
        selector: '#name',
        text: 'Ada',
      })
      expect(typed.ok).toBe(true)

      const selected = (await dispatcher.dispatch('electron_select_option', {
        sessionId,
        selector: '#fruit',
        values: ['pear'],
      })) as SuccessResponse & { selected: readonly string[] }
      expect(selected.selected).toEqual(['pear'])

      const checked = await dispatcher.dispatch('electron_check', { sessionId, selector: '#agree' })
      expect(checked.ok).toBe(true)

      // Re-snapshot: the checkbox's live checked state must reflect the real click.
      const after = (await dispatcher.dispatch('electron_snapshot', {
        sessionId,
      })) as SuccessResponse & { snapshot: { entries: readonly SnapshotEntryShape[] } }
      const agree = after.snapshot.entries.find((entry) => entry.state.checked === true)
      expect(agree).toBeDefined()

      const stopped = await dispatcher.dispatch('electron_stop', { sessionId })
      expect(stopped.ok).toBe(true)
      expect(sessions.size).toBe(0)
    },
    60_000,
  )
})
