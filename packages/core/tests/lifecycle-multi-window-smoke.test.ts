import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { TransportRegistry } from '../src/server/transport-registry.js'
import { clickTool } from '../src/tools/interaction/index.js'
import {
  launchTool,
  stopTool,
  switchWindowTool,
  windowsListTool,
} from '../src/tools/lifecycle/index.js'
import { expectTextTool } from '../src/tools/expect/index.js'
import { snapshotTool } from '../src/tools/snapshot/index.js'
import { PlaywrightElectronTransport } from '../src/transports/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const FIXTURE_MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'multi-window-electron',
  'main.js',
)

const managers = new Set<SessionManager>()

afterEach(async () => {
  await Promise.all([...managers].map((sessions) => sessions.disposeAll()))
  managers.clear()
})

describe('multi-window lifecycle smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'switches the implicit renderer target, then recovers after it closes',
    async () => {
      const sessions = new SessionManager()
      managers.add(sessions)
      const dispatcher = new Dispatcher({
        sessions,
        transports: new TransportRegistry({ transports: [new PlaywrightElectronTransport()] }),
      })
      dispatcher.registerAll([
        launchTool,
        windowsListTool,
        switchWindowTool,
        snapshotTool,
        clickTool,
        expectTextTool,
        stopTool,
      ])

      const launched = (await dispatcher.dispatch('electron_launch', {
        main: FIXTURE_MAIN,
      })) as SuccessResponse & { readonly session_id: string }
      expect(launched.ok).toBe(true)
      const sessionId = launched.session_id

      const listed = (await dispatcher.dispatch('electron_windows_list', {
        sessionId,
      })) as SuccessResponse & {
        readonly windows: readonly { readonly id: string; readonly title: string }[]
      }
      const preferences = listed.windows.find((window) => window.title === 'Preferences window')
      if (preferences === undefined) throw new Error('fixture preferences window was not listed')

      await expect(
        dispatcher.dispatch('electron_switch_window', { sessionId, targetId: preferences.id }),
      ).resolves.toMatchObject({ ok: true, active_window_id: preferences.id })
      const preferencesSnapshot = (await dispatcher.dispatch('electron_snapshot', {
        sessionId,
      })) as SuccessResponse & {
        readonly snapshot: { readonly entries: readonly { name: string }[] }
      }
      expect(
        preferencesSnapshot.snapshot.entries.some((entry) => entry.name === 'Preferences action'),
      ).toBe(true)

      await expect(
        dispatcher.dispatch('electron_click', { sessionId, selector: '#reload-preferences' }),
      ).resolves.toMatchObject({ ok: true })
      await expect(
        dispatcher.dispatch('electron_expect_text', {
          sessionId,
          selector: '#reload-count',
          equals: 'Reload 2',
        }),
      ).resolves.toMatchObject({ ok: true })
      const reloadedSnapshot = (await dispatcher.dispatch('electron_snapshot', {
        sessionId,
      })) as SuccessResponse & {
        readonly renderer_reloaded: boolean
        readonly snapshot: { readonly entries: readonly { name: string }[] }
      }
      expect(reloadedSnapshot.renderer_reloaded).toBe(true)
      expect(
        reloadedSnapshot.snapshot.entries.some((entry) => entry.name === 'Preferences action'),
      ).toBe(true)

      await expect(
        dispatcher.dispatch('electron_click', { sessionId, selector: '#preferences-action' }),
      ).resolves.toMatchObject({ ok: true })
      await expect(
        dispatcher.dispatch('electron_expect_text', {
          sessionId,
          selector: '#preferences-status',
          equals: 'Preferences clicked',
        }),
      ).resolves.toMatchObject({ ok: true })

      await dispatcher.dispatch('electron_click', { sessionId, selector: '#close-preferences' })
      await new Promise((resolve) => setTimeout(resolve, 200))
      const recovered = (await dispatcher.dispatch('electron_windows_list', {
        sessionId,
      })) as SuccessResponse & {
        readonly count: number
        readonly active_window_id: string
        readonly windows: readonly { readonly id: string; readonly title: string }[]
      }
      expect(recovered.count).toBe(1)
      expect(recovered.windows[0]?.title).toBe('Main window')
      expect(recovered.active_window_id).toBe(recovered.windows[0]?.id)
      const mainSnapshot = (await dispatcher.dispatch('electron_snapshot', {
        sessionId,
      })) as SuccessResponse & {
        readonly snapshot: { readonly entries: readonly { name: string }[] }
      }
      expect(mainSnapshot.snapshot.entries.some((entry) => entry.name === 'Main action')).toBe(true)

      await expect(dispatcher.dispatch('electron_stop', { sessionId })).resolves.toMatchObject({
        ok: true,
        stopped: true,
      })
    },
    90_000,
  )
})
