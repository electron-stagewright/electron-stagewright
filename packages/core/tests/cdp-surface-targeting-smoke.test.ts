/**
 * Real Electron proof for CDP renderer-surface targeting (ADR-029). Launches the ADR-022 surface
 * fixture as an executable-only app over CDP and verifies parent-first discovery, honest kinds,
 * ref-based clicks inside an in-process nested frame, an OOPIF nested in another OOPIF and a
 * webview guest, ref isolation between surfaces, detach recovery and clean stop.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { type ErrorResponse, type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { TransportRegistry } from '../src/server/transport-registry.js'
import { clickTool } from '../src/tools/interaction/index.js'
import {
  launchTool,
  stopTool,
  surfacesListTool,
  switchSurfaceTool,
} from '../src/tools/lifecycle/index.js'
import { snapshotTool } from '../src/tools/snapshot/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const FIXTURE_MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'surfaces-electron',
  'main.js',
)

interface Surface {
  readonly id: string
  readonly kind: string
  readonly parentId?: string
  readonly originRelation?: string
  readonly url?: string
}

type Listed = SuccessResponse & { readonly surfaces: readonly Surface[] }
type Snapshotted = SuccessResponse & {
  readonly surface_id: string
  readonly snapshot: {
    readonly entries: readonly { readonly ref: number; readonly name: string }[]
  }
}

const managers = new Set<SessionManager>()
afterEach(async () => {
  await Promise.all([...managers].map((sessions) => sessions.disposeAll()))
  managers.clear()
})

async function listUntil(dispatcher: Dispatcher, sessionId: string): Promise<Listed> {
  const deadline = Date.now() + 15_000
  let listed: Listed
  do {
    listed = (await dispatcher.dispatch('electron_surfaces_list', { sessionId })) as Listed
    const urls = listed.surfaces.map((surface) => surface.url ?? '')
    if (
      listed.surfaces.filter((surface) => surface.kind === 'other').length === 3 &&
      listed.surfaces.some((surface) => surface.kind === 'webview') &&
      urls.some((url) => url.includes('/nested-same.html')) &&
      urls.some((url) => url.includes('/nested-cross.html'))
    ) {
      return listed
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  return listed
}

function byUrl(listed: Listed, part: string): Surface {
  const found = listed.surfaces.find((surface) => surface.url?.includes(part))
  if (found === undefined) throw new Error(`no surface for ${part}`)
  return found
}

describe('CDP renderer surface targeting (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'discovers, snapshots and clicks nested frames and a webview over CDP',
    async () => {
      const electronPath = (await import('electron')).default as unknown as string
      const sessions = new SessionManager()
      managers.add(sessions)
      const dispatcher = new Dispatcher({
        sessions,
        snapshots: new SnapshotStore(),
        transports: new TransportRegistry(),
      })
      dispatcher.registerAll([
        launchTool,
        surfacesListTool,
        switchSurfaceTool,
        snapshotTool,
        clickTool,
        stopTool,
      ])

      const launched = (await dispatcher.dispatch('electron_launch', {
        executablePath: electronPath,
        args: [FIXTURE_MAIN],
        timeoutMs: 30_000,
      })) as SuccessResponse & {
        readonly session_id: string
        readonly transport: string
        readonly capabilities: { readonly supportsSurfaceTargeting: boolean }
      }
      expect(launched).toMatchObject({
        ok: true,
        transport: 'cdp',
        capabilities: { supportsSurfaceTargeting: true },
      })
      const sessionId = launched.session_id
      const session = sessions.resolve(sessionId).session

      const listed = await listUntil(dispatcher, sessionId)
      // CDP cannot tell a BrowserWindow from a WebContentsView, so all three page roots are `other`.
      expect(listed.surfaces.filter((surface) => surface.kind === 'other')).toHaveLength(3)
      const host = byUrl(listed, '/host.html')
      const guest = byUrl(listed, '/guest.html')
      expect(guest).toMatchObject({ kind: 'webview', parentId: host.id })
      const sameFrame = byUrl(listed, '/same-frame.html')
      const nestedSame = byUrl(listed, '/nested-same.html')
      const crossFrame = byUrl(listed, '/cross-frame.html')
      const nestedCross = byUrl(listed, '/nested-cross.html')
      expect(sameFrame).toMatchObject({
        kind: 'frame',
        parentId: host.id,
        originRelation: 'same-origin',
      })
      expect(nestedSame).toMatchObject({ parentId: sameFrame.id, originRelation: 'same-origin' })
      expect(crossFrame).toMatchObject({ parentId: host.id, originRelation: 'cross-origin' })
      expect(nestedCross).toMatchObject({
        parentId: crossFrame.id,
        originRelation: 'cross-origin',
      })
      const indexById = new Map(listed.surfaces.map((surface, index) => [surface.id, index]))
      for (const [index, surface] of listed.surfaces.entries()) {
        if (surface.parentId !== undefined) {
          expect(indexById.get(surface.parentId)).toBeLessThan(index)
        }
      }

      const clickByRef = async (surface: Surface, name: string): Promise<number> => {
        await expect(
          dispatcher.dispatch('electron_switch_surface', { sessionId, surfaceId: surface.id }),
        ).resolves.toMatchObject({ ok: true, active_surface_id: surface.id })
        await session.evaluate(
          'renderer',
          `document.querySelector('button').addEventListener('click', () => {
            document.title = 'clicked ' + location.pathname
          }); return true;`,
        )
        const snapshot = (await dispatcher.dispatch('electron_snapshot', {
          sessionId,
        })) as Snapshotted
        expect(snapshot.surface_id).toBe(surface.id)
        const entry = snapshot.snapshot.entries.find((candidate) => candidate.name === name)
        if (entry === undefined) throw new Error(`"${name}" missing from ${surface.url}`)
        await expect(
          dispatcher.dispatch('electron_click', { sessionId, ref: entry.ref }),
        ).resolves.toMatchObject({ ok: true })
        await expect
          .poll(() => session.evaluate('renderer', 'return document.title'))
          .toBe(`clicked ${new URL(surface.url ?? '').pathname}`)
        return entry.ref
      }

      const nestedSameRef = await clickByRef(nestedSame, 'Nested same action')
      await clickByRef(nestedCross, 'Nested cross action')
      await clickByRef(guest, 'Guest action')

      // A ref from another surface must never act on this one.
      await dispatcher.dispatch('electron_switch_surface', { sessionId, surfaceId: host.id })
      const crossSurface = (await dispatcher.dispatch('electron_click', {
        sessionId,
        ref: nestedSameRef,
      })) as ErrorResponse
      expect(crossSurface.ok).toBe(false)

      await session.evaluate(
        'renderer',
        'document.querySelector("#cross-frame")?.remove(); return true;',
      )
      await expect
        .poll(
          async () =>
            (await dispatcher.dispatch('electron_switch_surface', {
              sessionId,
              surfaceId: crossFrame.id,
            })) as ErrorResponse,
        )
        .toMatchObject({ ok: false, code: 'SURFACE_CLOSED' })

      await expect(dispatcher.dispatch('electron_stop', { sessionId })).resolves.toMatchObject({
        ok: true,
        stopped: true,
      })
    },
    120_000,
  )
})
