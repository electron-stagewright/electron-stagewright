/**
 * Unit tests for `electron_find`, driven through the dispatcher against a fake
 * session that returns a real walker-produced snapshot.
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { type Snapshot, walkAccessibilityTree } from '../src/snapshot/index.js'
import { makeFindTool } from '../src/tools/snapshot/find.js'
import { makeSnapshotTool } from '../src/tools/snapshot/snapshot.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'

function setup(html: string) {
  const snapshot: Snapshot = walkAccessibilityTree(new JSDOM(html).window.document, {})
  const sessions = new SessionManager()
  const snapshots = new SnapshotStore()
  const transport = new FakeTransport()
  sessions.register(transport, new FakeSession({ id: 'sess', evaluate: async () => snapshot }))
  const dispatcher = new Dispatcher({ sessions, snapshots })
  dispatcher.register(makeFindTool({ loadBundle: () => '' }))
  return { dispatcher }
}

function setupQueue(queue: readonly Snapshot[]) {
  const sessions = new SessionManager()
  const snapshots = new SnapshotStore()
  const transport = new FakeTransport()
  let i = 0
  const calls: { readonly body: string; readonly arg: unknown }[] = []
  sessions.register(
    transport,
    new FakeSession({
      id: 'sess',
      evaluate: async (_target, body, arg) => {
        calls.push({ body, arg })
        if (body.includes('const assignments = Array.isArray(arg)')) return 0
        return queue[Math.min(i++, queue.length - 1)]
      },
    }),
  )
  const dispatcher = new Dispatcher({ sessions, snapshots })
  dispatcher.register(makeSnapshotTool({ loadBundle: () => '' }))
  dispatcher.register(makeFindTool({ loadBundle: () => '' }))
  return { dispatcher, snapshots, calls }
}

function snap(html: string): Snapshot {
  const base = walkAccessibilityTree(new JSDOM(html).window.document, {})
  return { ...base, meta: { ...base.meta, navigation_started_at_ms: 1000 } }
}

interface FindResult {
  readonly matches: readonly {
    readonly ref: number | null
    readonly role: string
    readonly name: string
  }[]
  readonly count: number
}

describe('electron_find', () => {
  it('finds elements by role', async () => {
    const { dispatcher } = setup('<button>Save</button><a href="#">Home</a><button>Cancel</button>')
    const res = (await dispatcher.dispatch('electron_find', {
      role: 'button',
    })) as SuccessResponse & FindResult
    expect(res.ok).toBe(true)
    expect(res.count).toBe(2)
    expect(res.matches.every((m) => m.role === 'button')).toBe(true)
  })

  it('filters by name_contains', async () => {
    const { dispatcher } = setup('<button>Save draft</button><button>Discard</button>')
    const res = (await dispatcher.dispatch('electron_find', {
      name_contains: 'Save',
    })) as SuccessResponse & FindResult
    expect(res.count).toBe(1)
    expect(res.matches[0]?.name).toContain('Save')
  })

  it('returns an empty match set when nothing matches', async () => {
    const { dispatcher } = setup('<button>Save</button>')
    const res = (await dispatcher.dispatch('electron_find', {
      role: 'checkbox',
    })) as SuccessResponse & FindResult
    expect(res).toMatchObject({ ok: true, count: 0 })
    expect(JSON.parse(JSON.stringify(res))).toEqual(res)
  })

  it('preserves stable snapshot refs when find walks and retags the renderer', async () => {
    const { dispatcher, snapshots, calls } = setupQueue([
      snap('<button>Save</button>'),
      snap('<button>New</button><button>Save</button>'),
    ])

    await dispatcher.dispatch('electron_snapshot', {})
    const res = (await dispatcher.dispatch('electron_find', {
      role: 'button',
    })) as SuccessResponse & FindResult

    expect(res.matches.find((entry) => entry.name === 'Save')?.ref).toBe(1)
    expect(res.matches.find((entry) => entry.name === 'New')?.ref).toBe(2)
    expect(snapshots.get('sess')?.entries.find((entry) => entry.name === 'Save')?.ref).toBe(1)
    expect(calls.find((call) => Array.isArray(call.arg))?.arg).toEqual([
      { from: 1, to: 2 },
      { from: 2, to: 1 },
    ])
  })
})
