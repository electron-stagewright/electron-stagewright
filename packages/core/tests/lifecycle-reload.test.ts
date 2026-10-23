/**
 * Unit tests for `electron_reload`: it reloads the active (or given) window, waits for the new
 * document before checking readiness, optionally waits for a selector, and reports failures with
 * the existing codes.
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { walkAccessibilityTree } from '../src/snapshot/index.js'
import { reloadTool } from '../src/tools/lifecycle/reload.js'
import type { TransportCapabilities, WindowDescriptor } from '../src/transports/index.js'
import { fullCapabilities } from '../../testkit/src/capabilities.js'
import { FakeSession, FakeTransport, type FakeEvaluate } from './helpers/fake-transport.js'

const MAIN: WindowDescriptor = { id: 'w1', index: 0, title: 'Main', visible: true, focused: true }
const SETTINGS: WindowDescriptor = {
  id: 'w2',
  index: 1,
  title: 'Settings',
  visible: true,
  focused: false,
}

interface Renderer {
  /** Throw a navigation error on the first mark attempt. */
  navigatingMark?: boolean
  /** How many same-document checks still see the old document. */
  oldDocumentChecks?: number
  /** Throw a navigation error on the first same-document check. */
  navigatingFirst?: boolean
  ready?: boolean
  /** Throw a navigation error on the first readiness check. */
  navigatingReady?: boolean
  selector?: unknown
}

/** A fake renderer that answers each reload step by the body it receives. */
function renderer(state: Renderer = {}): { evaluate: FakeEvaluate; bodies: string[] } {
  const bodies: string[] = []
  let oldChecks = state.oldDocumentChecks ?? 1
  let navigating = state.navigatingFirst === true
  let navigatingReady = state.navigatingReady === true
  let navigatingMark = state.navigatingMark === true
  const evaluate: FakeEvaluate = async (_target, body) => {
    if (body.includes('__stagewrightReloadMark = arg.mark')) {
      bodies.push('mark')
      if (navigatingMark) {
        navigatingMark = false
        throw new Error('CDP Runtime.evaluate failed: Inspected target navigated or closed')
      }
      return true
    }
    if (body.includes('__stagewrightReloadMark === arg.mark')) {
      bodies.push('same-document')
      if (navigating) {
        navigating = false
        throw new Error(
          'page.evaluate: Execution context was destroyed, most likely because of a navigation.',
        )
      }
      if (oldChecks > 0) {
        oldChecks -= 1
        return true
      }
      return false
    }
    if (body.includes('hasMeaningfulText')) {
      bodies.push('ready')
      if (navigatingReady) {
        navigatingReady = false
        throw new Error('CDP Runtime.evaluate failed: Inspected target navigated or closed')
      }
      return { ready: state.ready ?? true }
    }
    if (body.includes('location.href')) {
      bodies.push('url')
      return 'app://main/index.html'
    }
    bodies.push('selector')
    return state.selector ?? { satisfied: true }
  }
  return { evaluate, bodies }
}

function setup(evaluate: FakeEvaluate, capabilities?: TransportCapabilities) {
  const sessions = new SessionManager()
  const snapshots = new SnapshotStore()
  const session = new FakeSession({ id: 'sess', evaluate, windows: [MAIN, SETTINGS] })
  sessions.register(new FakeTransport(capabilities !== undefined ? { capabilities } : {}), session)
  const dispatcher = new Dispatcher({ sessions, snapshots })
  dispatcher.register(reloadTool)
  return { dispatcher, session, snapshots }
}

describe('electron_reload', () => {
  it('reloads the active window and returns once the new page is ready', async () => {
    const page = renderer({ oldDocumentChecks: 2 })
    const { dispatcher, session } = setup(page.evaluate)
    const res = await dispatcher.dispatch('electron_reload', { ignoreCache: true })
    expect(res).toMatchObject({ ok: true, renderer_ready: true, url: 'app://main/index.html' })
    expect(session.reloadCalls).toEqual([
      { target: { kind: 'id', id: 'w1' }, opts: { ignoreCache: true } },
    ])
    // Readiness is checked only after the old document is gone.
    expect(page.bodies).toEqual([
      'mark',
      'same-document',
      'same-document',
      'same-document',
      'ready',
      'url',
    ])
  })

  it('keeps waiting through the navigation itself', async () => {
    const page = renderer({ navigatingFirst: true, oldDocumentChecks: 0 })
    const { dispatcher } = setup(page.evaluate)
    await expect(dispatcher.dispatch('electron_reload', {})).resolves.toMatchObject({
      ok: true,
      renderer_ready: true,
    })
  })

  it('checks readiness again when the new page is still navigating', async () => {
    const page = renderer({ navigatingReady: true, oldDocumentChecks: 0 })
    const { dispatcher } = setup(page.evaluate)
    await expect(dispatcher.dispatch('electron_reload', {})).resolves.toMatchObject({
      renderer_ready: true,
    })
    expect(page.bodies.filter((body) => body === 'ready')).toHaveLength(2)
  })

  it('reports renderer_ready false when the new page never arrives in the budget', async () => {
    const page = renderer({ oldDocumentChecks: 1_000_000 })
    const { dispatcher } = setup(page.evaluate)
    await expect(
      dispatcher.dispatch('electron_reload', { readyTimeoutMs: 60 }),
    ).resolves.toMatchObject({ ok: true, renderer_ready: false })
    expect(page.bodies).not.toContain('ready')
  })

  it('waits for waitForSelector and times out with WAIT_TIMEOUT when it never shows', async () => {
    const shown = renderer()
    await expect(
      setup(shown.evaluate).dispatcher.dispatch('electron_reload', { waitForSelector: '#app' }),
    ).resolves.toMatchObject({ ok: true })
    expect(shown.bodies).toContain('selector')

    const missing = renderer({ selector: { satisfied: false, state: 'visible' } })
    await expect(
      setup(missing.evaluate).dispatcher.dispatch('electron_reload', {
        waitForSelector: '#app',
        readyTimeoutMs: 100,
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'WAIT_TIMEOUT',
      details: { renderer_ready: true },
    })
  })

  it('rejects an invalid waitForSelector with BAD_ARGUMENT', async () => {
    const page = renderer({ selector: { satisfied: false, invalid_selector: true, error: 'bad' } })
    await expect(
      setup(page.evaluate).dispatcher.dispatch('electron_reload', { waitForSelector: '[[' }),
    ).resolves.toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
  })

  it('selects and reloads the given window', async () => {
    const { dispatcher, session } = setup(renderer().evaluate)
    await expect(dispatcher.dispatch('electron_reload', { windowId: 'w2' })).resolves.toMatchObject(
      { ok: true },
    )
    expect(session.activateWindowCalls).toEqual([{ kind: 'id', id: 'w2' }])
    expect(session.reloadCalls[0]?.target).toEqual({ kind: 'id', id: 'w2' })
  })

  it('reloads from the window root when an iframe surface is selected', async () => {
    const { dispatcher, session } = setup(renderer().evaluate)
    await expect(dispatcher.dispatch('electron_reload', {})).resolves.toMatchObject({ ok: true })
    // Selecting the window resets the surface to its root before the document is tagged.
    expect(session.activateWindowCalls).toEqual([{ kind: 'id', id: 'w1' }])
  })

  it('forgets the stored snapshot, whose refs belong to the old page', async () => {
    const { dispatcher, snapshots } = setup(renderer().evaluate)
    snapshots.set(
      'sess',
      walkAccessibilityTree(new JSDOM('<button>Go</button>').window.document, {}),
    )
    await dispatcher.dispatch('electron_reload', {})
    expect(snapshots.get('sess')).toBeUndefined()
  })

  it('tags the document again when it was already navigating', async () => {
    const page = renderer({ navigatingMark: true, oldDocumentChecks: 0 })
    const { dispatcher, session } = setup(page.evaluate)
    await expect(dispatcher.dispatch('electron_reload', {})).resolves.toMatchObject({
      ok: true,
      renderer_ready: true,
    })
    expect(page.bodies.slice(0, 2)).toEqual(['mark', 'mark'])
    expect(session.reloadCalls).toHaveLength(1)
  })

  it('refuses a transport without renderer evaluation', async () => {
    const { dispatcher, session } = setup(renderer().evaluate, {
      ...fullCapabilities(),
      supportsRendererEval: false,
    })
    await expect(dispatcher.dispatch('electron_reload', {})).resolves.toMatchObject({
      ok: false,
      code: 'TRANSPORT_UNSUPPORTED',
    })
    expect(session.reloadCalls).toEqual([])
  })
})
