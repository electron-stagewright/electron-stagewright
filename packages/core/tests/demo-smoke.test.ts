/** Real Electron smoke for the optional packaged demo launched through the default-entry seam. */

import { afterEach, describe, expect, it } from 'vitest'

import { resolveDemoMain } from '../src/demo.js'
import type { SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { TransportRegistry } from '../src/server/transport-registry.js'
import { expectTextTool } from '../src/tools/expect/index.js'
import { clickTool, typeTool } from '../src/tools/interaction/index.js'
import {
  launchTool,
  stopTool,
  switchWindowTool,
  windowsListTool,
} from '../src/tools/lifecycle/index.js'
import { snapshotTool } from '../src/tools/snapshot/index.js'
import { PlaywrightElectronTransport } from '../src/transports/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const managers = new Set<SessionManager>()

afterEach(async () => {
  await Promise.all([...managers].map((sessions) => sessions.disposeAll()))
  managers.clear()
})

async function waitForInspector(
  dispatcher: Dispatcher,
  sessionId: string,
): Promise<{ readonly id: string; readonly title: string }> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const listed = (await dispatcher.dispatch('electron_windows_list', {
      sessionId,
    })) as SuccessResponse & {
      readonly windows: readonly { readonly id: string; readonly title: string }[]
    }
    const inspector = listed.windows.find((window) => window.title === 'Stagewright demo inspector')
    if (inspector !== undefined) return inspector
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('The demo inspector window did not appear within 1500 ms.')
}

describe('packaged demo smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'launches without a path, drives a modal/list flow by ref, and selects the inspector window',
    async () => {
      const sessions = new SessionManager()
      managers.add(sessions)
      const dispatcher = new Dispatcher({
        sessions,
        launchDefaultMain: await resolveDemoMain(),
        transports: new TransportRegistry({ transports: [new PlaywrightElectronTransport()] }),
      })
      dispatcher.registerAll([
        launchTool,
        windowsListTool,
        switchWindowTool,
        snapshotTool,
        clickTool,
        typeTool,
        expectTextTool,
        stopTool,
      ])

      const launched = (await dispatcher.dispatch('electron_launch', {})) as SuccessResponse & {
        readonly session_id: string
      }
      expect(launched).toMatchObject({ ok: true, renderer_ready: true })
      const sessionId = launched.session_id

      const initialSnapshot = (await dispatcher.dispatch('electron_snapshot', {
        sessionId,
      })) as SuccessResponse & {
        readonly snapshot: {
          readonly entries: readonly { readonly name: string; readonly ref?: number }[]
        }
      }
      const addTask = initialSnapshot.snapshot.entries.find((entry) => entry.name === 'Add a task')
      if (addTask?.ref === undefined)
        throw new Error('The demo snapshot omitted the Add a task ref.')
      await expect(
        dispatcher.dispatch('electron_click', { sessionId, ref: addTask.ref }),
      ).resolves.toMatchObject({ ok: true })
      await expect(
        dispatcher.dispatch('electron_type', {
          sessionId,
          selector: '#task-title',
          text: 'Verify packaged demo',
        }),
      ).resolves.toMatchObject({ ok: true })
      await expect(
        dispatcher.dispatch('electron_click', { sessionId, selector: '#save-task' }),
      ).resolves.toMatchObject({ ok: true })
      await expect(
        dispatcher.dispatch('electron_expect_text', {
          sessionId,
          selector: '#task-summary',
          equals: '1 task · Verify packaged demo',
        }),
      ).resolves.toMatchObject({ ok: true })

      await expect(
        dispatcher.dispatch('electron_click', { sessionId, selector: '#open-inspector' }),
      ).resolves.toMatchObject({ ok: true })
      const inspector = await waitForInspector(dispatcher, sessionId)
      await expect(
        dispatcher.dispatch('electron_switch_window', { sessionId, targetId: inspector.id }),
      ).resolves.toMatchObject({ ok: true, active_window_id: inspector.id })
      await expect(
        dispatcher.dispatch('electron_expect_text', {
          sessionId,
          selector: '#inspector-status',
          equals: '1 task in the board',
        }),
      ).resolves.toMatchObject({ ok: true })

      await expect(dispatcher.dispatch('electron_stop', { sessionId })).resolves.toMatchObject({
        ok: true,
      })
    },
    30_000,
  )
})
