/**
 * Real-Electron coverage for an app-root-owned Electron binary.
 *
 * This is intentionally opt-in with the rest of the Electron suite because it
 * launches the fixture through a real Playwright transport.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { TransportRegistry } from '../src/server/transport-registry.js'
import { doctorTool, launchTool, stopTool } from '../src/tools/lifecycle/index.js'
import { snapshotTool } from '../src/tools/snapshot/index.js'
import { PlaywrightElectronTransport } from '../src/transports/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(TEST_DIRECTORY, '../../..')
const FIXTURE_MAIN = path.join(TEST_DIRECTORY, 'fixtures', 'minimal-electron', 'main.js')
const managers = new Set<SessionManager>()

afterEach(async () => {
  await Promise.all([...managers].map((sessions) => sessions.disposeAll()))
  managers.clear()
})

describe('project Electron runtime smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'diagnoses and launches an app with its app-root Electron binary',
    async () => {
      const sessions = new SessionManager()
      managers.add(sessions)
      const dispatcher = new Dispatcher({
        sessions,
        appRoot: REPOSITORY_ROOT,
        transports: new TransportRegistry({ transports: [new PlaywrightElectronTransport()] }),
      })
      dispatcher.registerAll([doctorTool, launchTool, snapshotTool, stopTool])

      const doctor = (await dispatcher.dispatch('electron_doctor', {})) as SuccessResponse & {
        readonly doctor_ok: boolean
        readonly checks: readonly { readonly id: string; readonly status: string }[]
        readonly runtime: {
          readonly project?: {
            readonly installedElectron?: string
            readonly target?: { readonly nodeModuleVersion?: string }
          }
        }
      }
      expect(doctor.doctor_ok).toBe(true)
      expect(doctor.checks.find((check) => check.id === 'project_runtime')?.status).toBe('pass')
      expect(doctor.runtime.project?.installedElectron).toBeTruthy()
      expect(doctor.runtime.project?.target?.nodeModuleVersion).toBeTruthy()

      const launched = (await dispatcher.dispatch('electron_launch', {
        main: FIXTURE_MAIN,
        runtime: 'project',
      })) as SuccessResponse & { readonly runtime_source: string; readonly session_id: string }
      expect(launched.ok).toBe(true)
      expect(launched.runtime_source).toBe('project')

      const snapshot = (await dispatcher.dispatch('electron_snapshot', {
        sessionId: launched.session_id,
      })) as SuccessResponse & { readonly snapshot: { readonly entries: readonly unknown[] } }
      expect(snapshot.ok).toBe(true)
      expect(snapshot.snapshot.entries.length).toBeGreaterThan(0)

      await expect(
        dispatcher.dispatch('electron_stop', { sessionId: launched.session_id }),
      ).resolves.toMatchObject({ ok: true, stopped: true })
    },
    90_000,
  )
})
