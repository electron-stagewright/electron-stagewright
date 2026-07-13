import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { type ErrorResponse, type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { walkAccessibilityTree } from '../src/snapshot/index.js'
import { clickTool } from '../src/tools/interaction/index.js'
import { surfacesListTool, switchSurfaceTool } from '../src/tools/lifecycle/index.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'
import { fullCapabilities } from '../../testkit/src/capabilities.js'

const ROOT = {
  id: 'root',
  kind: 'window' as const,
  active: true,
  capabilities: { snapshot: true, interaction: true, rendererEval: true },
}
const FRAME = {
  id: 'frame',
  kind: 'frame' as const,
  parentId: 'root',
  active: false,
  capabilities: { snapshot: true, interaction: true, rendererEval: true },
  originRelation: 'same-origin' as const,
}

function setup(supportsSurfaceTargeting = true) {
  const sessions = new SessionManager()
  const snapshots = new SnapshotStore()
  const session = new FakeSession({ id: 'sess', surfaces: [ROOT, FRAME] })
  sessions.register(
    new FakeTransport({ capabilities: fullCapabilities({ supportsSurfaceTargeting }) }),
    session,
  )
  const dispatcher = new Dispatcher({ sessions, snapshots })
  dispatcher.registerAll([surfacesListTool, switchSurfaceTool, clickTool])
  return { dispatcher, session, snapshots }
}

describe('renderer surface tools', () => {
  it('lists parent-first surfaces and switches the active target by opaque id', async () => {
    const { dispatcher, session } = setup()
    const listed = (await dispatcher.dispatch('electron_surfaces_list', {
      sessionId: 'sess',
    })) as SuccessResponse & {
      readonly surfaces: readonly { readonly id: string; readonly active: boolean }[]
      readonly active_surface_id: string
    }
    expect(listed.ok).toBe(true)
    expect(listed.surfaces.map((surface) => surface.id)).toEqual(['root', 'frame'])
    expect(listed.active_surface_id).toBe('root')

    await expect(
      dispatcher.dispatch('electron_switch_surface', { sessionId: 'sess', surfaceId: 'frame' }),
    ).resolves.toMatchObject({ ok: true, active_surface_id: 'frame' })
    expect(session.activateSurfaceCalls).toEqual(['frame'])
  })

  it('keeps refs isolated by active surface', async () => {
    const { dispatcher, snapshots } = setup()
    const rootSnapshot = walkAccessibilityTree(
      new JSDOM('<button>Root action</button>').window.document,
    )
    const frameSnapshot = walkAccessibilityTree(
      new JSDOM('<main>Frame has no action</main>').window.document,
    )
    snapshots.set('sess', rootSnapshot, 'root')
    snapshots.set('sess', frameSnapshot, 'frame')

    await dispatcher.dispatch('electron_switch_surface', { sessionId: 'sess', surfaceId: 'frame' })
    const miss = (await dispatcher.dispatch('electron_click', {
      sessionId: 'sess',
      ref: 1,
    })) as ErrorResponse
    expect(miss).toMatchObject({ ok: false, code: 'REF_NOT_FOUND' })

    await dispatcher.dispatch('electron_switch_surface', { sessionId: 'sess', surfaceId: 'root' })
    await expect(
      dispatcher.dispatch('electron_click', { sessionId: 'sess', ref: 1 }),
    ).resolves.toMatchObject({ ok: true })
  })

  it('refuses the new tools when a transport has not implemented surface targeting', async () => {
    const { dispatcher } = setup(false)
    const result = (await dispatcher.dispatch('electron_surfaces_list', {
      sessionId: 'sess',
    })) as ErrorResponse
    expect(result).toMatchObject({ ok: false, code: 'TRANSPORT_UNSUPPORTED' })
  })

  it('returns the registered not-found code for an opaque id outside this session', async () => {
    const { dispatcher } = setup()
    const result = (await dispatcher.dispatch('electron_switch_surface', {
      sessionId: 'sess',
      surfaceId: 'never-observed',
    })) as ErrorResponse
    expect(result).toMatchObject({ ok: false, code: 'SURFACE_NOT_FOUND' })
  })
})
