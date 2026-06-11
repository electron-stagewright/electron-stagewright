/**
 * Real-Electron drop-file smoke — proves the renderer-side DataTransfer path
 * (File construction from base64, DragEvent dispatch, handler engagement)
 * against a live Chromium renderer, which jsdom cannot model.
 *
 * Opt-in: runs only when `STAGEWRIGHT_E2E=1`. Skipped by default.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { TransportRegistry } from '../src/server/transport-registry.js'
import { PlaywrightElectronTransport } from '../src/transports/index.js'
import { dropFileTool } from '../src/tools/interaction/index.js'
import { launchTool, stopTool } from '../src/tools/lifecycle/index.js'
import { getTextTool } from '../src/tools/read/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const FIXTURE_MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'dropzone-electron',
  'main.js',
)

const sessions = new SessionManager()

afterAll(async () => {
  await sessions.disposeAll()
})

describe('drop-file smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'drops a real file onto a web drop handler and the app receives it',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'sw-drop-smoke-'))
      const filePath = path.join(dir, 'invoice.txt')
      await writeFile(filePath, 'drop payload')
      try {
        const dispatcher = new Dispatcher({
          sessions,
          snapshots: new SnapshotStore(),
          transports: new TransportRegistry({
            transports: [new PlaywrightElectronTransport()],
          }),
        })
        dispatcher.registerAll([launchTool, dropFileTool, getTextTool, stopTool])

        const launched = (await dispatcher.dispatch('electron_launch', {
          main: FIXTURE_MAIN,
        })) as SuccessResponse & { session_id: string }
        expect(launched.ok).toBe(true)
        const sessionId = launched.session_id

        const dropped = (await dispatcher.dispatch('electron_drop_file', {
          sessionId,
          selector: '#dropzone',
          paths: [filePath],
        })) as SuccessResponse & { default_prevented: boolean }
        expect(dropped.ok).toBe(true)
        // The fixture's drop handler calls preventDefault — engagement is observable.
        expect(dropped.default_prevented).toBe(true)

        const read = (await dispatcher.dispatch('electron_get_text', {
          sessionId,
          selector: '#result',
        })) as SuccessResponse & { text: string }
        expect(read.ok).toBe(true)
        expect(read.text).toBe(`invoice.txt:${'drop payload'.length}:text/plain`)

        const stopped = await dispatcher.dispatch('electron_stop', { sessionId })
        expect(stopped).toMatchObject({ ok: true, stopped: true })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    120_000,
  )
})
