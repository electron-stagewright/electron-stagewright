/**
 * Unit tests for `electron_snapshot`, driven through the dispatcher against a
 * fake session whose `evaluate` returns a real walker-produced `Snapshot`
 * (the injected bundle is stubbed). Covers full vs since:'last' diff, hot-reload
 * fallback, interactiveOnly, the entry cap, the no-session error, and
 * wire-serialisability.
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { type ErrorResponse, type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { type Snapshot, walkAccessibilityTree } from '../src/snapshot/index.js'
import { stopTool } from '../src/tools/lifecycle/index.js'
import { makeSnapshotTool } from '../src/tools/snapshot/snapshot.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'

/** Produce a real Snapshot from HTML via the walker, with a fixed navigation timestamp. */
function snap(html: string, navMs = 1000): Snapshot {
  const base = walkAccessibilityTree(new JSDOM(html).window.document, {})
  return { ...base, meta: { ...base.meta, navigation_started_at_ms: navMs } }
}

/** Wire a dispatcher whose session's evaluate returns the queued snapshots in order. */
function setup(queue: readonly Snapshot[]) {
  const sessions = new SessionManager()
  const snapshots = new SnapshotStore()
  const transport = new FakeTransport()
  let i = 0
  const calls: { readonly body: string; readonly arg: unknown }[] = []
  const session = new FakeSession({
    id: 'sess',
    evaluate: async (_target, body, arg) => {
      calls.push({ body, arg })
      if (body.includes('const assignments = Array.isArray(arg)')) return 0
      return queue[Math.min(i++, queue.length - 1)]
    },
  })
  sessions.register(transport, session)
  const dispatcher = new Dispatcher({ sessions, snapshots })
  dispatcher.register(makeSnapshotTool({ loadBundle: () => '' }))
  return { dispatcher, snapshots, calls }
}

describe('electron_snapshot', () => {
  it('returns a full snapshot on the first call', async () => {
    const { dispatcher } = setup([snap('<button>One</button>')])
    const res = await dispatcher.dispatch('electron_snapshot', {})
    expect(res).toMatchObject({
      ok: true,
      kind: 'full',
      renderer_reloaded: false,
      truncated: false,
    })
    expect(
      (res as SuccessResponse & { snapshot: Snapshot }).snapshot.entries.length,
    ).toBeGreaterThan(0)
  })

  it('returns a diff with since:"last" against the stored snapshot', async () => {
    const { dispatcher } = setup([
      snap('<button>One</button>'),
      snap('<button>One</button><button>Two</button>'),
    ])
    await dispatcher.dispatch('electron_snapshot', {}) // stores the first
    const res = await dispatcher.dispatch('electron_snapshot', { since: 'last' })
    expect(res).toMatchObject({ ok: true, kind: 'diff' })
    const diff = (res as SuccessResponse & { diff: { added: unknown[] } }).diff
    expect(diff.added.length).toBe(1)
  })

  it('falls back to a full snapshot (renderer_reloaded) when the document reloaded', async () => {
    const { dispatcher } = setup([
      snap('<button>One</button>', 1000),
      snap('<button>One</button>', 2000), // different navigation start → reload
    ])
    await dispatcher.dispatch('electron_snapshot', {})
    const res = await dispatcher.dispatch('electron_snapshot', { since: 'last' })
    expect(res).toMatchObject({ ok: true, kind: 'full', renderer_reloaded: true })
  })

  it('drops non-interactive entries with interactiveOnly', async () => {
    const { dispatcher } = setup([snap('<main><button>Go</button></main>')])
    const res = await dispatcher.dispatch('electron_snapshot', { interactiveOnly: true })
    const snapshot = (res as SuccessResponse & { snapshot: Snapshot }).snapshot
    expect(snapshot.entries.every((e) => e.interactive)).toBe(true)
  })

  it('caps entries and flags truncation', async () => {
    const { dispatcher } = setup([snap('<button>A</button><button>B</button><button>C</button>')])
    const res = await dispatcher.dispatch('electron_snapshot', { maxEntries: 1 })
    expect((res as SuccessResponse & { truncated: boolean }).truncated).toBe(true)
    expect((res as SuccessResponse & { snapshot: Snapshot }).snapshot.entries.length).toBe(1)
  })

  it('returns NOT_RUNNING when no session is live', async () => {
    const dispatcher = new Dispatcher({ sessions: new SessionManager() })
    dispatcher.register(makeSnapshotTool({ loadBundle: () => '' }))
    const res = await dispatcher.dispatch('electron_snapshot', {})
    expect((res as ErrorResponse).code).toBe('NOT_RUNNING')
  })

  it('produces a wire-serialisable response', async () => {
    const { dispatcher } = setup([snap('<button>One</button>')])
    const res = await dispatcher.dispatch('electron_snapshot', {})
    expect(JSON.parse(JSON.stringify(res))).toEqual(res)
  })

  it('stores an unfiltered baseline so a filtered call does not corrupt the next diff', async () => {
    // Identical DOM both times; the landmark <main> is non-interactive.
    const html = '<main><button>Go</button></main>'
    const { dispatcher } = setup([snap(html), snap(html)])
    // First call drops the landmark from the RETURNED snapshot via interactiveOnly...
    await dispatcher.dispatch('electron_snapshot', { interactiveOnly: true })
    // ...but the stored baseline must still include it, so an unfiltered diff sees
    // no change (no spurious "added" for the landmark that was only filtered out).
    const res = await dispatcher.dispatch('electron_snapshot', { since: 'last' })
    const diff = (res as SuccessResponse & { diff: { added: unknown[]; removed: unknown[] } }).diff
    expect(diff.added.length).toBe(0)
    expect(diff.removed.length).toBe(0)
  })

  it('reuses stable refs and retags the DOM when document order changes', async () => {
    const { dispatcher, calls } = setup([
      snap('<button>Save</button>'),
      snap('<button>New</button><button>Save</button>'),
    ])
    const first = (await dispatcher.dispatch('electron_snapshot', {})) as SuccessResponse & {
      snapshot: Snapshot
    }
    const originalSaveRef = first.snapshot.entries.find((entry) => entry.name === 'Save')?.ref

    const second = (await dispatcher.dispatch('electron_snapshot', {})) as SuccessResponse & {
      snapshot: Snapshot
    }
    const newEntry = second.snapshot.entries.find((entry) => entry.name === 'New')
    const saveEntry = second.snapshot.entries.find((entry) => entry.name === 'Save')

    expect(saveEntry?.ref).toBe(originalSaveRef)
    expect(newEntry?.ref).not.toBe(originalSaveRef)
    expect(calls.find((call) => Array.isArray(call.arg))?.arg).toEqual([
      { from: 1, to: 2 },
      { from: 2, to: 1 },
    ])
  })

  it('clears the stored baseline when the session is stopped', async () => {
    const { dispatcher, snapshots } = setup([snap('<button>One</button>')])
    dispatcher.register(stopTool)

    await dispatcher.dispatch('electron_snapshot', {})
    expect(snapshots.get('sess')).toBeDefined()

    const stopped = await dispatcher.dispatch('electron_stop', {})
    expect(stopped.ok).toBe(true)
    expect(snapshots.get('sess')).toBeUndefined()
  })
})

describe('electron_snapshot diff encoding + budget', () => {
  it('encodes diffs compactly by default (changed fields only) and reports diff_format', async () => {
    const { dispatcher } = setup([
      snap('<button>One</button>'),
      snap('<button>One</button><button>Two</button>'),
    ])
    await dispatcher.dispatch('electron_snapshot', {})
    const res = (await dispatcher.dispatch('electron_snapshot', {
      since: 'last',
    })) as SuccessResponse & {
      diff_format: string
      diff: { added: unknown[]; removed: readonly Record<string, unknown>[] }
    }
    expect(res).toMatchObject({ ok: true, kind: 'diff', diff_format: 'compact' })
    expect(res.diff.added).toHaveLength(1)
  })

  it('returns identity-only removed entries in the compact encoding', async () => {
    const { dispatcher } = setup([
      snap('<button>One</button><button>Two</button>'),
      snap('<button>One</button>'),
    ])
    await dispatcher.dispatch('electron_snapshot', {})
    const res = (await dispatcher.dispatch('electron_snapshot', {
      since: 'last',
    })) as SuccessResponse & {
      diff: { removed: readonly Record<string, unknown>[] }
    }
    expect(res.diff.removed).toHaveLength(1)
    const removed = res.diff.removed[0] ?? {}
    expect(Object.keys(removed).sort()).toEqual(['fingerprint', 'name', 'ref', 'role'])
  })

  it('restores the full prev/curr encoding with diffFormat:"full"', async () => {
    const { dispatcher } = setup([
      snap('<button>One</button><button>Two</button>'),
      snap('<button>One</button>'),
    ])
    await dispatcher.dispatch('electron_snapshot', {})
    const res = (await dispatcher.dispatch('electron_snapshot', {
      since: 'last',
      diffFormat: 'full',
    })) as SuccessResponse & { diff_format: string; diff: { removed: readonly { tag?: string }[] } }
    expect(res.diff_format).toBe('full')
    // Full encoding keeps complete entries (tag present only there).
    expect(res.diff.removed[0]?.tag).toBe('button')
  })

  it('truncates the diff payload under budgetTokens and flags it', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `<button>Item ${i}</button>`).join('')
    const { dispatcher } = setup([snap(`<main>${many}</main>`), snap('<main></main>')])
    await dispatcher.dispatch('electron_snapshot', {})
    const res = (await dispatcher.dispatch('electron_snapshot', {
      since: 'last',
      budgetTokens: 120,
    })) as SuccessResponse & {
      truncated: boolean
      diff: {
        removed: readonly unknown[]
        _meta: { truncated_entries?: number; entries_removed: number }
      }
    }
    expect(res.ok).toBe(true)
    expect(res.truncated).toBe(true)
    expect(res.diff._meta.truncated_entries).toBeGreaterThan(0)
    // The real delta count is preserved even though the payload shrank.
    expect(res.diff._meta.entries_removed).toBeGreaterThan(res.diff.removed.length)
  })
})
