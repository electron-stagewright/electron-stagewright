/**
 * Interaction failure recovery that needs a live renderer re-walk. This file
 * mocks the injected bundle loader so the test stays unit-fast and does not
 * depend on a pre-existing `dist/snapshot/injected-walker.js` build artifact.
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

import { type ErrorResponse } from '../src/errors/envelope.js'
import { StagewrightError } from '../src/errors/registry.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { type Snapshot, walkAccessibilityTree } from '../src/snapshot/index.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'

vi.mock('../src/tools/snapshot/inject.js', () => ({
  buildRetagBody: () => 'RETAG',
  buildWalkBody: () => 'WALK',
  loadInjectedWalker: () => 'BUNDLE',
}))

function snap(html: string): Snapshot {
  const snapshot = walkAccessibilityTree(new JSDOM(html).window.document, {})
  return { ...snapshot, meta: { ...snapshot.meta, navigation_started_at_ms: 1000 } }
}

describe('interaction live re-walk recovery', () => {
  it('reconciles refs, retags the renderer, and stores the live snapshot for similar_refs', async () => {
    const { INTERACTION_TOOLS } = await import('../src/tools/interaction/index.js')
    const snapshots = new SnapshotStore()
    const sessions = new SessionManager()
    const live = snap('<button>New</button><button>Save</button>')
    const retags: unknown[] = []
    const session = new FakeSession({
      id: 'sess',
      interactionError: new StagewrightError('SELECTOR_NO_MATCH', 'no element'),
      evaluate: async (_target, body, arg) => {
        if (body === 'WALK') return live
        if (body === 'RETAG') {
          retags.push(arg)
          return 2
        }
        return undefined
      },
    })
    sessions.register(new FakeTransport(), session)
    snapshots.set('sess', snap('<button>Save</button>'))
    const dispatcher = new Dispatcher({ sessions, snapshots })
    dispatcher.registerAll(INTERACTION_TOOLS)

    const res = (await dispatcher.dispatch('electron_click', {
      selector: '#missing',
    })) as ErrorResponse

    expect(res.code).toBe('SELECTOR_NO_MATCH')
    expect(res.similar_refs?.map((entry) => entry.name)).toEqual(['New', 'Save'])
    expect(snapshots.get('sess')?.entries.find((entry) => entry.name === 'Save')?.ref).toBe(1)
    expect(snapshots.get('sess')?.entries.find((entry) => entry.name === 'New')?.ref).toBe(2)
    expect(retags).toEqual([
      [
        { from: 1, to: 2 },
        { from: 2, to: 1 },
      ],
    ])
  })
})
