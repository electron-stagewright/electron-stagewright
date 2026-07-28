/** Real Electron proof for visual baseline capture, comparison, artifact preservation, and surface fidelity. */

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createServer, NOOP_LOGGER } from '@electron-stagewright/core'
import { waitForTestSurfaces } from '@electron-stagewright/testkit'
import { afterEach, describe, expect, it } from 'vitest'

import visualPlugin from '../src/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const FIXTURE_MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'visual-electron',
  'main.js',
)

const servers = new Set<Awaited<ReturnType<typeof createServer>>>()
const directories = new Set<string>()
afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close().catch(() => undefined)))
  servers.clear()
  await Promise.all(
    [...directories].map((directory) => rm(directory, { recursive: true, force: true })),
  )
  directories.clear()
})

describe('visual plugin (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'captures and matches a BrowserWindow, preserves mismatch artifacts, cleans its preparation, and rejects a frame surface',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'stagewright-visual-smoke-'))
      directories.add(root)
      const server = await createServer({
        plugins: [visualPlugin],
        pluginConfigs: {
          visual: {
            baselineDir: path.join(root, 'baselines'),
            artifactsDir: path.join(root, 'artifacts'),
            fontFingerprint: 'electron-fixture-fonts-v1',
          },
        },
        logger: NOOP_LOGGER,
      })
      servers.add(server)
      const launched = (await server.dispatcher.dispatch('electron_launch', {
        main: FIXTURE_MAIN,
      })) as { readonly session_id?: string; readonly _meta?: { readonly session_id?: string } }
      const sessionId = launched.session_id ?? launched._meta?.session_id
      if (typeof sessionId !== 'string') throw new Error('launch returned no session id')

      const listed = await waitForTestSurfaces(
        server.dispatcher,
        sessionId,
        (result) =>
          result.surfaces.some((surface) => surface.kind === 'window') &&
          result.surfaces.some((surface) => surface.kind === 'frame'),
      )
      const windowSurface = listed.surfaces.find((surface) => surface.kind === 'window')
      const frameSurface = listed.surfaces.find((surface) => surface.kind === 'frame')
      if (windowSurface === undefined || frameSurface === undefined)
        throw new Error('fixture surfaces were not discovered')
      await expect(
        server.dispatcher.dispatch('electron_switch_surface', {
          sessionId,
          surfaceId: windowSurface.id,
        }),
      ).resolves.toMatchObject({ ok: true, active_surface_id: windowSurface.id })

      await expect(
        server.dispatcher.dispatch('visual_update_baseline', {
          sessionId,
          name: 'checkout',
          confirm: true,
          masks: ['#child-frame'],
        }),
      ).resolves.toMatchObject({
        ok: true,
        surface_id: windowSurface.id,
        baseline: { replaced: true },
      })
      await expect(
        server.dispatcher.dispatch('visual_expect', {
          sessionId,
          name: 'checkout',
          masks: ['#child-frame'],
        }),
      ).resolves.toMatchObject({ ok: true, matched: true, diff_pixels: 0 })
      await expect(
        server.sessions
          .resolve(sessionId)
          .session.evaluate<number>(
            'renderer',
            "return globalThis[Symbol.for('electron-stagewright.visual.capture-preparation')]?.size ?? 0;",
          ),
      ).resolves.toBe(0)

      await server.sessions
        .resolve(sessionId)
        .session.evaluate('renderer', "document.querySelector('#status').textContent = 'Changed';")
      await expect(
        server.dispatcher.dispatch('visual_expect', {
          sessionId,
          name: 'checkout',
          masks: ['#child-frame'],
        }),
      ).resolves.toMatchObject({ ok: false, code: 'visual.MISMATCH' })
      const artifacts = await readdir(path.join(root, 'artifacts'))
      const mismatchDirectory = artifacts.find((entry) => entry.endsWith('.mismatch'))
      expect(mismatchDirectory).toBeDefined()
      await expect(
        readdir(path.join(root, 'artifacts', mismatchDirectory ?? 'missing')).then((files) =>
          files.sort(),
        ),
      ).resolves.toEqual(['actual.png', 'diff.png'])

      await expect(
        server.dispatcher.dispatch('electron_switch_surface', {
          sessionId,
          surfaceId: frameSurface.id,
        }),
      ).resolves.toMatchObject({ ok: true, active_surface_id: frameSurface.id })
      await expect(
        server.dispatcher.dispatch('visual_capture', { sessionId, name: 'checkout' }),
      ).resolves.toMatchObject({ ok: false, code: 'visual.SURFACE_UNSUPPORTED' })
    },
    90_000,
  )
})
