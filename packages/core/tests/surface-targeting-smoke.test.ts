/**
 * Real Electron proof for renderer-surface targeting. The fixture owns one
 * two BrowserWindows with nested same/cross-origin frames and a webview guest, plus
 * one main-process WebContentsView. It verifies classification, parent-first
 * ordering, explicit selection, frame interaction, per-surface refs, detach
 * recovery, and clean stop through real Playwright.
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
import { PlaywrightElectronTransport } from '../src/transports/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const FIXTURE_MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'surfaces-electron',
  'main.js',
)

const managers = new Set<SessionManager>()
afterEach(async () => {
  await Promise.all([...managers].map((sessions) => sessions.disposeAll()))
  managers.clear()
})

async function listUntil(
  dispatcher: Dispatcher,
  sessionId: string,
): Promise<
  SuccessResponse & {
    readonly surfaces: readonly {
      readonly id: string
      readonly kind: string
      readonly parentId?: string
      readonly originRelation?: string
      readonly url?: string
    }[]
  }
> {
  const deadline = Date.now() + 10_000
  let listed: SuccessResponse & {
    readonly surfaces: readonly {
      readonly id: string
      readonly kind: string
      readonly parentId?: string
      readonly originRelation?: string
      readonly url?: string
    }[]
  }
  do {
    listed = (await dispatcher.dispatch('electron_surfaces_list', { sessionId })) as typeof listed
    if (
      listed.surfaces.filter((surface) => surface.kind === 'window').length === 2 &&
      listed.surfaces.some((surface) => surface.kind === 'webcontents_view') &&
      listed.surfaces.some((surface) => surface.kind === 'webview') &&
      listed.surfaces.some((surface) => surface.url?.includes('/nested-same.html')) &&
      listed.surfaces.some((surface) => surface.url?.includes('/nested-cross.html'))
    ) {
      return listed
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  return listed
}

describe('renderer surface targeting (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'discovers nested renderer surfaces, scopes refs, and recovers from a detached frame',
    async () => {
      const sessions = new SessionManager()
      managers.add(sessions)
      const dispatcher = new Dispatcher({
        sessions,
        snapshots: new SnapshotStore(),
        transports: new TransportRegistry({ transports: [new PlaywrightElectronTransport()] }),
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
        main: FIXTURE_MAIN,
      })) as SuccessResponse & { readonly session_id: string }
      const sessionId = launched.session_id
      const listed = await listUntil(dispatcher, sessionId)
      expect(listed.ok).toBe(true)
      expect(listed.surfaces.filter((surface) => surface.kind === 'window')).toHaveLength(2)
      expect(listed.surfaces.some((surface) => surface.kind === 'webcontents_view')).toBe(true)
      expect(listed.surfaces.some((surface) => surface.kind === 'webview')).toBe(true)
      const frames = listed.surfaces.filter((surface) => surface.kind === 'frame')
      expect(frames.length).toBeGreaterThanOrEqual(4)
      expect(frames.some((surface) => surface.originRelation === 'same-origin')).toBe(true)
      expect(frames.some((surface) => surface.originRelation === 'cross-origin')).toBe(true)
      expect(
        frames.find((surface) => surface.url?.includes('/nested-same.html'))?.originRelation,
      ).toBe('same-origin')
      expect(
        frames.find((surface) => surface.url?.includes('/nested-cross.html'))?.originRelation,
      ).toBe('cross-origin')
      expect(
        listed.surfaces.every(
          (surface) =>
            surface.parentId === undefined ||
            listed.surfaces.some((candidate) => candidate.id === surface.parentId),
        ),
      ).toBe(true)
      const indexById = new Map(listed.surfaces.map((surface, index) => [surface.id, index]))
      for (const [index, surface] of listed.surfaces.entries()) {
        if (surface.parentId !== undefined) {
          expect(indexById.get(surface.parentId)).toBeLessThan(index)
        }
      }

      const crossFrame = frames.find((surface) => surface.originRelation === 'cross-origin')
      if (crossFrame === undefined) throw new Error('cross-origin frame was not discovered')
      await expect(
        dispatcher.dispatch('electron_switch_surface', { sessionId, surfaceId: crossFrame.id }),
      ).resolves.toMatchObject({ ok: true, active_surface_id: crossFrame.id })
      const crossSnapshot = (await dispatcher.dispatch('electron_snapshot', {
        sessionId,
      })) as SuccessResponse & {
        readonly surface_id: string
        readonly snapshot: { readonly entries: readonly { readonly name: string }[] }
      }
      expect(crossSnapshot.surface_id).toBe(crossFrame.id)
      expect(
        crossSnapshot.snapshot.entries.some((entry) => entry.name === 'Cross frame action'),
      ).toBe(true)
      await expect(
        dispatcher.dispatch('electron_click', { sessionId, selector: '#cross-action' }),
      ).resolves.toMatchObject({ ok: true })

      const guest = listed.surfaces.find((surface) => surface.kind === 'webview')
      if (guest === undefined) throw new Error('webview guest was not discovered')
      await dispatcher.dispatch('electron_switch_surface', { sessionId, surfaceId: guest.id })
      const guestSnapshot = (await dispatcher.dispatch('electron_snapshot', {
        sessionId,
      })) as SuccessResponse & {
        readonly surface_id: string
        readonly snapshot: { readonly entries: readonly { readonly name: string }[] }
      }
      expect(guestSnapshot.surface_id).toBe(guest.id)
      expect(guestSnapshot.snapshot.entries.some((entry) => entry.name === 'Guest action')).toBe(
        true,
      )

      const host = listed.surfaces.find(
        (surface) => surface.kind === 'window' && surface.url?.includes('/host.html'),
      )
      if (host === undefined) throw new Error('host BrowserWindow was not discovered')
      await dispatcher.dispatch('electron_switch_surface', { sessionId, surfaceId: host.id })
      await sessions
        .resolve(sessionId)
        .session.evaluate(
          'renderer',
          'document.querySelector("#cross-frame")?.remove(); return true;',
        )
      const detached = (await dispatcher.dispatch('electron_switch_surface', {
        sessionId,
        surfaceId: crossFrame.id,
      })) as ErrorResponse
      expect(detached).toMatchObject({ ok: false, code: 'SURFACE_CLOSED' })

      await expect(dispatcher.dispatch('electron_stop', { sessionId })).resolves.toMatchObject({
        ok: true,
        stopped: true,
      })
    },
    90_000,
  )
})
