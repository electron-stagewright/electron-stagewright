/**
 * `electron_snapshot({ root })` — subtree-scoped snapshots and diffs over a live
 * JSDOM renderer. The walk, stored baseline and refs stay global; only the
 * returned entries are scoped.
 */

import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'

import type { ErrorResponse, SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { walkForSnapshot } from '../src/snapshot/renderer-entry.js'
import {
  type Snapshot,
  type SnapshotDiffCompact,
  diffSnapshots,
  scopeDiff,
  walkAccessibilityTree,
} from '../src/snapshot/index.js'
import { buildRetagBody } from '../src/tools/snapshot/inject.js'
import { makeSnapshotTool } from '../src/tools/snapshot/snapshot.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'

const RETAG_MARKER = 'const assignments = Array.isArray(arg)'

const PAGE = `
  <nav><button>Home</button><button>Settings</button></nav>
  <main>
    <section id="panel" aria-label="Panel"><button>Save</button><input aria-label="Title"></section>
    <button>Outside</button>
  </main>`

type FullResponse = SuccessResponse & { snapshot: Snapshot; truncated: boolean }
type DiffResponse = SuccessResponse & { diff: SnapshotDiffCompact }

const doms: JSDOM[] = []
afterEach(() => {
  for (const dom of doms.splice(0)) dom.window.close()
})

/** A renderer backed by one live JSDOM document: walks tag refs, retags apply to the DOM. */
function setup(html: string = PAGE) {
  const dom = new JSDOM(`<body>${html}</body>`)
  doms.push(dom)
  const document = dom.window.document
  const walkArgs: unknown[] = []
  const retag = new Function('document', 'arg', buildRetagBody()) as (
    document: Document,
    arg: unknown,
  ) => number
  const session = new FakeSession({
    id: 'sess',
    evaluate: async (_target, body, arg) => {
      if (body.includes(RETAG_MARKER)) return retag(document, arg)
      walkArgs.push(arg)
      const result = walkForSnapshot(document, arg as Parameters<typeof walkForSnapshot>[1])
      if ('scope_miss' in result) return result
      return { ...result, meta: { ...result.meta, navigation_started_at_ms: 1000 } }
    },
  })
  const sessions = new SessionManager()
  const snapshots = new SnapshotStore()
  sessions.register(new FakeTransport(), session)
  const dispatcher = new Dispatcher({ sessions, snapshots })
  dispatcher.register(makeSnapshotTool({ loadBundle: () => '' }))
  return { dispatcher, document, snapshots, session, walkArgs }
}

function names(snapshot: Snapshot): string[] {
  return snapshot.entries.map((entry) => entry.name)
}

describe('walker scope reporting', () => {
  it('reports the root subtree (itself included, open shadow content too) without changing refs', () => {
    const dom = new JSDOM(`<body>${PAGE}</body>`)
    doms.push(dom)
    const document = dom.window.document
    const panel = document.querySelector('#panel')
    if (panel === null) throw new Error('Missing panel fixture')
    const host = document.createElement('div')
    panel.append(host)
    host.attachShadow({ mode: 'open' }).innerHTML = '<button>Shadow</button>'

    const full = walkAccessibilityTree(document)
    const scoped = walkAccessibilityTree(document, { scopeRoot: panel })
    expect(scoped.entries).toEqual(full.entries)
    const inScope = scoped.scope?.indices.map((index) => scoped.entries[index]?.name)
    expect(inScope).toEqual(['Panel', 'Save', 'Title', 'Shadow'])
    expect(scoped.scope?.start).toBe(scoped.scope?.indices[0])
  })

  it('reports an empty scope at the root position when the subtree has no entries', () => {
    const dom = new JSDOM('<body><button>A</button><div id="empty"></div><button>B</button></body>')
    doms.push(dom)
    const root = dom.window.document.querySelector('#empty')
    if (root === null) throw new Error('Missing fixture')
    const scoped = walkAccessibilityTree(dom.window.document, { scopeRoot: root })
    expect(scoped.scope).toEqual({ start: 1, indices: [] })
  })
})

describe('electron_snapshot root', () => {
  it('returns only the selector subtree while storing the full baseline', async () => {
    const { dispatcher, snapshots, session, walkArgs } = setup()
    const res = (await dispatcher.dispatch('electron_snapshot', {
      root: { selector: '#panel' },
    })) as FullResponse
    expect(res.ok).toBe(true)
    expect(walkArgs.at(-1)).toEqual({ scope: '#panel' })
    expect(names(res.snapshot)).toEqual(['Panel', 'Save', 'Title'])
    const stored = snapshots.get('sess', (await session.activeSurface()).id)
    expect(stored?.entries.map((entry) => entry.name)).toContain('Outside')
    expect(res.snapshot).not.toHaveProperty('scope')
  })

  it('keeps refs global: a scoped entry carries the same ref as in a full snapshot', async () => {
    const { dispatcher } = setup()
    const full = (await dispatcher.dispatch('electron_snapshot', {})) as FullResponse
    const scoped = (await dispatcher.dispatch('electron_snapshot', {
      root: { selector: '#panel' },
    })) as FullResponse
    const saveRef = full.snapshot.entries.find((entry) => entry.name === 'Save')?.ref
    expect(scoped.snapshot.entries.find((entry) => entry.name === 'Save')?.ref).toBe(saveRef)
  })

  it('resolves a ref root to the element tagged by the previous snapshot', async () => {
    const { dispatcher, walkArgs } = setup(
      '<button>Before</button><div role="listbox" aria-label="Fruit"><div role="option">Apple</div><div role="option">Pear</div></div><button>After</button>',
    )
    const full = (await dispatcher.dispatch('electron_snapshot', {})) as FullResponse
    const listRef = full.snapshot.entries.find((entry) => entry.role === 'listbox')?.ref
    expect(listRef).toBeTypeOf('number')

    const scoped = (await dispatcher.dispatch('electron_snapshot', {
      root: { ref: listRef },
    })) as FullResponse
    expect(walkArgs.at(-1)).toEqual({ scope: `[data-sw-ref="${listRef}"]` })
    expect(names(scoped.snapshot)).toEqual(['Fruit', 'Apple', 'Pear'])
  })

  it('applies interactiveOnly and maxEntries after scoping', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_snapshot', {
      root: { selector: '#panel' },
      interactiveOnly: true,
      maxEntries: 1,
    })) as FullResponse
    expect(names(res.snapshot)).toEqual(['Save'])
    expect(res.truncated).toBe(true)
  })

  it('scopes text output', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_snapshot', {
      root: { selector: '#panel' },
      format: 'text',
    })) as SuccessResponse & { snapshot_text: string; entry_count: number }
    expect(res.entry_count).toBe(3)
    expect(res.snapshot_text).toContain('"Save"')
    expect(res.snapshot_text).not.toContain('"Outside"')
  })

  it('scopes since:"last" diffs and keeps the next unscoped diff complete', async () => {
    const { dispatcher, document } = setup()
    await dispatcher.dispatch('electron_snapshot', {})

    const panel = document.querySelector('#panel')
    const save = panel?.querySelector('button')
    const nav = document.querySelector('nav')
    if (panel === null || panel === undefined || save == null || nav === null) {
      throw new Error('Missing fixture')
    }
    const added = document.createElement('button')
    added.textContent = 'Publish'
    panel.append(added)
    save.remove()
    const navAdded = document.createElement('button')
    navAdded.textContent = 'Help'
    nav.append(navAdded)
    document.querySelector('main > button')?.setAttribute('disabled', '')

    const scoped = (await dispatcher.dispatch('electron_snapshot', {
      since: 'last',
      root: { selector: '#panel' },
    })) as DiffResponse
    expect(scoped).toMatchObject({ ok: true, kind: 'diff' })
    expect(scoped.diff.added.map((entry) => entry.name)).toEqual(['Publish'])
    expect(scoped.diff.removed.map((entry) => entry.name)).toEqual(['Save'])
    expect(scoped.diff.changed).toEqual([])
    expect(scoped.diff._meta).toMatchObject({ entries_added: 1, entries_removed: 1 })

    // The scoped call stored the full walk, so an unscoped diff of the same DOM is empty...
    const unchanged = (await dispatcher.dispatch('electron_snapshot', {
      since: 'last',
    })) as DiffResponse
    expect(unchanged.diff._meta).toMatchObject({
      entries_added: 0,
      entries_removed: 0,
      entries_changed: 0,
    })
    // ...and a later out-of-scope change is still seen by an unscoped diff.
    navAdded.remove()
    const later = (await dispatcher.dispatch('electron_snapshot', {
      since: 'last',
    })) as DiffResponse
    expect(later.diff.removed.map((entry) => entry.name)).toEqual(['Help'])
  })

  it('returns REF_NOT_FOUND for a stale root ref without walking', async () => {
    const { dispatcher, walkArgs } = setup()
    await dispatcher.dispatch('electron_snapshot', {})
    const walksBefore = walkArgs.length

    const res = (await dispatcher.dispatch('electron_snapshot', {
      root: { ref: 999 },
    })) as ErrorResponse
    expect(res).toMatchObject({ ok: false, code: 'REF_NOT_FOUND' })
    expect(walkArgs.slice(walksBefore)).not.toContainEqual({ scope: '[data-sw-ref="999"]' })
  })

  it('returns REF_NOT_FOUND when a stored ref no longer resolves in the DOM', async () => {
    const { dispatcher, document } = setup()
    const full = (await dispatcher.dispatch('electron_snapshot', {})) as FullResponse
    const saveRef = full.snapshot.entries.find((entry) => entry.name === 'Save')?.ref
    document.querySelector(`[data-sw-ref="${saveRef}"]`)?.remove()

    const res = await dispatcher.dispatch('electron_snapshot', { root: { ref: saveRef } })
    expect(res).toMatchObject({ ok: false, code: 'REF_NOT_FOUND' })
  })

  it('returns SELECTOR_NO_MATCH with candidates for a root selector that matches nothing', async () => {
    const { dispatcher } = setup()
    await dispatcher.dispatch('electron_snapshot', {})
    const res = (await dispatcher.dispatch('electron_snapshot', {
      root: { selector: '#missing' },
    })) as ErrorResponse
    expect(res).toMatchObject({ ok: false, code: 'SELECTOR_NO_MATCH' })
    expect(res.similar_refs?.length).toBeGreaterThan(0)
  })

  it('rejects a malformed root selector and an ambiguous root with BAD_ARGUMENT', async () => {
    const { dispatcher } = setup()
    expect(
      await dispatcher.dispatch('electron_snapshot', { root: { selector: '[[' } }),
    ).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(
      await dispatcher.dispatch('electron_snapshot', { root: { ref: 1, selector: 'main' } }),
    ).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(await dispatcher.dispatch('electron_snapshot', { root: {} })).toMatchObject({
      ok: false,
      code: 'BAD_ARGUMENT',
    })
  })

  it.each([{ selector: '#panel' }, { ref: 1 }])(
    'waits for the session ref lock before a scoped walk (%o)',
    async (root) => {
      const { dispatcher, snapshots, walkArgs } = setup()
      await dispatcher.dispatch('electron_snapshot', {})
      const walksBefore = walkArgs.length

      let release!: () => void
      const held = snapshots.withRefLock(
        'sess',
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          }),
      )
      const pending = dispatcher.dispatch('electron_snapshot', { root })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(walkArgs.length).toBe(walksBefore)

      release()
      await held
      expect(await pending).toMatchObject({ ok: true, kind: 'full' })
      expect(walkArgs.length).toBe(walksBefore + 1)
    },
  )
})

describe('scopeDiff', () => {
  function walk(html: string, scopeSelector: string) {
    const dom = new JSDOM(`<body>${html}</body>`)
    doms.push(dom)
    const root = dom.window.document.querySelector(scopeSelector)
    if (root === null) throw new Error(`Missing ${scopeSelector}`)
    return walkAccessibilityTree(dom.window.document, { scopeRoot: root })
  }

  it('attributes removals to an emptied subtree by its position', () => {
    const prev = walk(
      '<button>Before</button><div id="list"><button>One</button><button>Two</button></div><button>After</button>',
      '#list',
    )
    const curr = walk('<button>Before</button><div id="list"></div><button>After</button>', '#list')
    if (curr.scope === undefined) throw new Error('Missing scope')
    const diff = scopeDiff(diffSnapshots(prev, curr), prev, curr, curr.scope)
    expect(diff.removed.map((entry) => entry.name)).toEqual(['One', 'Two'])
    expect(diff.added).toEqual([])
  })

  it('drops out-of-scope removals that sit beyond a surviving neighbour', () => {
    const prev = walk(
      '<button>Gone</button><button>Before</button><div id="list"><button>One</button></div>',
      '#list',
    )
    const curr = walk('<button>Before</button><div id="list"><button>One</button></div>', '#list')
    if (curr.scope === undefined) throw new Error('Missing scope')
    const diff = scopeDiff(diffSnapshots(prev, curr), prev, curr, curr.scope)
    expect(diff.removed).toEqual([])
    expect(diff._meta.entries_removed).toBe(0)
  })
})
