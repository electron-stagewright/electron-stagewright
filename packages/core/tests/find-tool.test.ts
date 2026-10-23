/**
 * Unit tests for `electron_find`, driven through the dispatcher against a fake
 * session that returns a real walker-produced snapshot.
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { type ErrorResponse, type SuccessResponse } from '../src/errors/envelope.js'
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

/** Walk `html` for the snapshot and run every other renderer body against the same DOM. */
function setupLive(
  html: string,
  opts: { failText?: boolean; prepare?: (document: Document) => void } = {},
) {
  const { window } = new JSDOM(html)
  opts.prepare?.(window.document)
  const snapshot = walkAccessibilityTree(window.document, {})
  const css = { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) }
  const bodies: string[] = []
  const sessions = new SessionManager()
  sessions.register(
    new FakeTransport(),
    new FakeSession({
      id: 'sess',
      evaluate: async (_target, body, arg) => {
        if (!body.includes('const q = arg.query')) return snapshot
        bodies.push(body)
        if (opts.failText === true) throw new Error('renderer gone')
        return new Function('arg', 'document', 'CSS', body)(arg, window.document, css) as unknown
      },
    }),
  )
  const dispatcher = new Dispatcher({ sessions, snapshots: new SnapshotStore() })
  dispatcher.register(makeFindTool({ loadBundle: () => '' }))
  return { dispatcher, bodies, document: window.document }
}

interface Hinted {
  readonly hints?: {
    readonly similar_names?: readonly { readonly name: string }[]
    readonly without_state_filters?: { readonly count: number }
    readonly text_matches?: {
      readonly count: number
      readonly samples: readonly {
        readonly tag: string
        readonly text: string
        readonly selector: string | null
      }[]
    }
    readonly next_actions?: readonly string[]
  }
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

  it('filters by enabled state', async () => {
    const { dispatcher } = setup('<button>Save</button><button disabled>Reset</button>')
    const res = (await dispatcher.dispatch('electron_find', {
      role: 'button',
      enabled: false,
    })) as SuccessResponse & FindResult
    expect(res.count).toBe(1)
    expect(res.matches[0]?.name).toBe('Reset')
  })

  it('caps matches with limit while count reports the true total', async () => {
    const many = Array.from({ length: 10 }, (_, i) => `<button>Item ${i}</button>`).join('')
    const { dispatcher } = setup(many)
    const res = (await dispatcher.dispatch('electron_find', {
      role: 'button',
      limit: 3,
    })) as SuccessResponse & FindResult & { truncated: number }
    expect(res.matches).toHaveLength(3)
    expect(res.count).toBe(10)
    expect(res.truncated).toBe(7)
    // Document order preserved: the cap keeps the FIRST matches.
    expect(res.matches[0]?.name).toBe('Item 0')
  })

  it('rejects ambiguous name filters', async () => {
    const { dispatcher } = setup('<button>Save</button>')
    const res = (await dispatcher.dispatch('electron_find', {
      name_contains: 'Save',
      name_exact: 'Save',
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
    // The dispatcher now names the offending field as `field` (was `path`) and adds
    // next_actions, so the BAD_ARGUMENT envelope is agent-actionable (ADR-006/ADR-007).
    expect(res.details?.['issues']).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'name_exact' })]),
    )
    expect(res.next_actions?.length ?? 0).toBeGreaterThan(0)
  })

  it('returns an empty match set when nothing matches', async () => {
    const { dispatcher } = setup('<button>Save</button>')
    const res = (await dispatcher.dispatch('electron_find', {
      role: 'checkbox',
    })) as SuccessResponse & FindResult
    expect(res).toMatchObject({ ok: true, count: 0 })
    expect(JSON.parse(JSON.stringify(res))).toEqual(res)
  })

  it('explains a zero-match query with hints and next actions', async () => {
    const { dispatcher } = setupLive(
      '<button style="display:none">Save</button><button>Save changes</button>',
    )
    const res = (await dispatcher.dispatch('electron_find', {
      role: 'button',
      name_exact: 'Save',
      visible: true,
    })) as SuccessResponse & FindResult & Hinted
    expect(res.count).toBe(0)
    expect(res.hints?.similar_names?.map((entry) => entry.name)).toContain('Save changes')
    expect(res.hints?.without_state_filters?.count).toBe(1)
    expect(res.hints?.next_actions?.[0]).toMatch(/^electron_find\(/)
  })

  it('finds the query in text content that is no accessible name, with a working selector', async () => {
    const { dispatcher, document } = setupLive(
      '<main><section><div class="row"><span>Total</span><span>Grand total: 42</span></div></section>' +
        '<p id="note">The <b>grand</b> total is final</p><script>/* grand total */</script></main>',
    )
    const res = (await dispatcher.dispatch('electron_find', {
      name_contains: 'grand total',
    })) as SuccessResponse & FindResult & Hinted
    const text = res.hints?.text_matches
    expect(text?.count).toBe(2)
    expect(text?.samples[0]).toMatchObject({ tag: 'span', text: 'Grand total: 42' })
    const selector = text?.samples[0]?.selector ?? ''
    expect(document.querySelector(selector)?.textContent).toBe('Grand total: 42')
    expect(res.hints?.next_actions).toContain(
      `electron_get_text({ selector: ${JSON.stringify(selector)} })`,
    )

    // Text split across inline elements matches on the innermost element holding all of it.
    const split = (await dispatcher.dispatch('electron_find', {
      name_contains: 'grand total is',
    })) as SuccessResponse & FindResult & Hinted
    expect(split.hints?.text_matches?.samples[0]).toMatchObject({ tag: 'p', selector: '#note' })
  })

  it('searches open shadow roots and gives no selector inside them', async () => {
    const { dispatcher } = setupLive('<div id="host"></div>', {
      prepare: (document) => {
        const root = document.getElementById('host')?.attachShadow({ mode: 'open' })
        if (root !== undefined) root.innerHTML = '<section><span>Shadow total</span></section>'
      },
    })
    const res = (await dispatcher.dispatch('electron_find', {
      name_contains: 'shadow total',
    })) as SuccessResponse & FindResult & Hinted
    expect(res.hints?.text_matches?.samples).toEqual([
      expect.objectContaining({ tag: 'span', selector: null }),
    ])
  })

  it('skips the text search when there are matches or no name, and survives its failure', async () => {
    const found = setupLive('<button>Save</button>')
    const hit = (await found.dispatcher.dispatch('electron_find', {
      name_exact: 'Save',
    })) as SuccessResponse & FindResult & Hinted
    expect(hit.hints).toBeUndefined()
    await found.dispatcher.dispatch('electron_find', { role: 'checkbox' })
    expect(found.bodies).toEqual([])

    const failing = setupLive('<div>Save</div>', { failText: true })
    await expect(
      failing.dispatcher.dispatch('electron_find', { name_exact: 'Save' }),
    ).resolves.toMatchObject({ ok: true, count: 0 })
    expect(failing.bodies).toHaveLength(1)
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
