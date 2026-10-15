import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

import type { SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { type Snapshot, walkAccessibilityTree } from '../src/snapshot/index.js'
import { makeExpectCountTool } from '../src/tools/expect/count.js'
import { clickTool } from '../src/tools/interaction/pointer.js'
import { getTextTool } from '../src/tools/read/value.js'
import { makeFindTool } from '../src/tools/snapshot/find.js'
import { makeSnapshotTool } from '../src/tools/snapshot/snapshot.js'
import { waitForSelectorTool } from '../src/tools/wait/selector.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'

const RETAG_MARKER = 'const assignments = Array.isArray(arg)'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

function snap(html: string): Snapshot {
  const base = walkAccessibilityTree(new JSDOM(html).window.document, {})
  return { ...base, meta: { ...base.meta, navigation_started_at_ms: 1000 } }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * A renderer whose buttons render as [B, A]: a walk renumbers their DOM tags in document
 * order as soon as it runs, while each walk's reply is held until its gate opens. A read
 * resolves its selector against the current tags once `readGate` opens.
 */
function fakeRenderer(
  gates: readonly Promise<void>[],
  readGate: Promise<void> = Promise.resolve(),
) {
  const order = ['B', 'A'] as const
  const tags = new Map<string, number>([
    ['A', 1],
    ['B', 2],
  ])
  const walkEntered = deferred()
  const readEntered = deferred()
  let walks = 0
  const tagged = (selector: string): string | undefined => {
    const ref = Number(/data-sw-ref="(\d+)"/.exec(selector)?.[1])
    return [...tags].find(([, tag]) => tag === ref)?.[0]
  }
  const evaluate = async (_target: unknown, body: string, arg: unknown): Promise<unknown> => {
    if (body.includes(RETAG_MARKER)) {
      const assignments = arg as readonly { from: number; to: number }[]
      const resolved = assignments.flatMap(({ from, to }) => {
        const name = [...tags].find(([, tag]) => tag === from)?.[0]
        return name === undefined ? [] : [{ name, to }]
      })
      for (const { name, to } of resolved) tags.set(name, to)
      return resolved.length
    }
    if (typeof arg === 'object' && arg !== null && 'selector' in arg) {
      readEntered.resolve()
      await readGate
      const name = tagged(String(arg.selector))
      return name === undefined ? { found: false } : { found: true, text: name }
    }
    const gate = gates[walks++]
    order.forEach((name, index) => tags.set(name, index + 1))
    walkEntered.resolve()
    await gate
    return snap('<button>B</button><button>A</button>')
  }
  return {
    tags,
    tagged,
    evaluate,
    walkEntered: walkEntered.promise,
    readEntered: readEntered.promise,
  }
}

async function setup(renderer: ReturnType<typeof fakeRenderer>) {
  const sessions = new SessionManager()
  const snapshots = new SnapshotStore()
  const session = new FakeSession({ id: 'sess', evaluate: renderer.evaluate })
  const clicked: (string | undefined)[] = []
  session.click = async (selector) => {
    clicked.push(selector.startsWith('[data-sw-ref') ? renderer.tagged(selector) : selector)
  }
  sessions.register(new FakeTransport(), session)
  const dispatcher = new Dispatcher({ sessions, snapshots, operationTimeoutMs: 0 })
  dispatcher.register(makeExpectCountTool({ loadBundle: () => '' }))
  dispatcher.register(makeSnapshotTool({ loadBundle: () => '' }))
  dispatcher.register(clickTool)
  dispatcher.register(getTextTool)
  const surface = await session.activeSurface()
  // The agent's baseline: A=1, B=2, matching the renderer's current tags.
  snapshots.set('sess', snap('<button>A</button><button>B</button>'), surface.id)
  return { dispatcher, clicked }
}

/** Cancel a role-mode count mid-walk, leaving its walk to retag after the dispatcher answers. */
async function orphanRoleCount(
  dispatcher: Dispatcher,
  renderer: ReturnType<typeof fakeRenderer>,
): Promise<void> {
  const controller = new AbortController()
  const counting = dispatcher.dispatch(
    'electron_expect_count',
    { role: 'button', equals: 2, timeoutMs: 1000 },
    { signal: controller.signal },
  )
  await renderer.walkEntered
  controller.abort()
  expect(await counting).toMatchObject({ ok: false, code: 'OPERATION_CANCELLED' })
}

describe('ref walk serialization', () => {
  it('keeps DOM tags aligned when an orphaned role count retags after a later snapshot walks', async () => {
    const orphanWalk = deferred()
    const snapshotWalk = deferred()
    const renderer = fakeRenderer([orphanWalk.promise, snapshotWalk.promise])
    const { dispatcher } = await setup(renderer)
    await orphanRoleCount(dispatcher, renderer)

    const snapshotting = dispatcher.dispatch('electron_snapshot', {})
    await flush()
    orphanWalk.resolve()
    await flush()
    snapshotWalk.resolve()
    const res = (await snapshotting) as SuccessResponse & { snapshot: Snapshot }

    expect(res).toMatchObject({ ok: true, kind: 'full' })
    const returned = new Map(res.snapshot.entries.map((entry) => [entry.name, entry.ref]))
    expect(returned).toEqual(
      new Map([
        ['B', 2],
        ['A', 1],
      ]),
    )
    expect(renderer.tags).toEqual(returned)
  })

  it('resolves a ref click after an orphaned walk restores the stable tags', async () => {
    const orphanWalk = deferred()
    const renderer = fakeRenderer([orphanWalk.promise])
    const { dispatcher, clicked } = await setup(renderer)
    await orphanRoleCount(dispatcher, renderer)

    // The walk has retagged in document order (B=1), so acting now would click B.
    const clicking = dispatcher.dispatch('electron_click', { ref: 1 })
    await flush()
    expect(clicked).toEqual([])
    orphanWalk.resolve()

    expect(await clicking).toMatchObject({ ok: true })
    expect(clicked).toEqual(['A'])
    expect(renderer.tags.get('A')).toBe(1)
  })

  it('reads a ref after an orphaned walk restores the stable tags', async () => {
    const orphanWalk = deferred()
    const renderer = fakeRenderer([orphanWalk.promise])
    const { dispatcher } = await setup(renderer)
    await orphanRoleCount(dispatcher, renderer)

    const reading = dispatcher.dispatch('electron_get_text', { ref: 1 })
    await flush()
    orphanWalk.resolve()

    expect(await reading).toMatchObject({ ok: true, text: 'A' })
  })

  it('does not hold selector targets behind an in-flight walk', async () => {
    const orphanWalk = deferred()
    const renderer = fakeRenderer([orphanWalk.promise])
    const { dispatcher, clicked } = await setup(renderer)
    await orphanRoleCount(dispatcher, renderer)

    expect(await dispatcher.dispatch('electron_click', { selector: '#save' })).toMatchObject({
      ok: true,
    })
    expect(clicked).toEqual(['#save'])
    orphanWalk.resolve()
  })

  it('releases the ref lock when a ref read is cancelled mid-flight', async () => {
    const readGate = deferred()
    const renderer = fakeRenderer([], readGate.promise)
    const { dispatcher } = await setup(renderer)

    const controller = new AbortController()
    const reading = dispatcher.dispatch(
      'electron_get_text',
      { ref: 1 },
      { signal: controller.signal },
    )
    await renderer.readEntered
    controller.abort()
    expect(await reading).toMatchObject({ ok: false, code: 'OPERATION_CANCELLED' })

    expect(await dispatcher.dispatch('electron_snapshot', {})).toMatchObject({ ok: true })
    readGate.resolve()
  })

  it('skips a queued walk whose request is cancelled before it acquires the lock', async () => {
    const store = new SnapshotStore()
    const holder = deferred()
    const ran: string[] = []
    const first = store.withRefLock('sess', async () => {
      ran.push('first')
      await holder.promise
    })
    const controller = new AbortController()
    const queued = store.withRefLock(
      'sess',
      async () => {
        ran.push('cancelled')
      },
      controller.signal,
    )
    const third = store.withRefLock('sess', async () => {
      ran.push('third')
    })
    controller.abort(new Error('cancelled'))
    await expect(queued).rejects.toThrow('cancelled')
    await flush()
    expect(ran).toEqual(['first'])
    holder.resolve()
    await Promise.all([first, third])
    expect(ran).toEqual(['first', 'third'])
  })

  it.each([
    ['electron_find', { role: 'button' }],
    ['electron_get_text', { selector: '#missing' }],
  ])('%s waits for a walk already holding the session ref lock', async (tool, args) => {
    const sessions = new SessionManager()
    const snapshots = new SnapshotStore()
    let walks = 0
    const session = new FakeSession({
      id: 'sess',
      evaluate: async (_target, body) => {
        if (!body.includes('__stagewrightWalk')) return { found: false }
        walks++
        return snap('<button>A</button>')
      },
    })
    sessions.register(new FakeTransport(), session)
    const dispatcher = new Dispatcher({ sessions, snapshots, operationTimeoutMs: 0 })
    dispatcher.register(makeFindTool({ loadBundle: () => '' }))
    dispatcher.register(getTextTool)
    const holder = deferred()
    const held = snapshots.withRefLock('sess', () => holder.promise)

    const pending = dispatcher.dispatch(tool, args)
    for (let i = 0; i < 4; i++) await flush()
    expect(walks).toBe(0)
    holder.resolve()
    await held
    await pending
    expect(walks).toBe(1)
  })

  it('diagnoses a stale ref after releasing the ref lock instead of deadlocking', async () => {
    const sessions = new SessionManager()
    const snapshots = new SnapshotStore()
    const session = new FakeSession({
      id: 'sess',
      evaluate: async () => snap('<button>A</button>'),
    })
    sessions.register(new FakeTransport(), session)
    const dispatcher = new Dispatcher({ sessions, snapshots, operationTimeoutMs: 0 })
    dispatcher.register(clickTool)
    const surface = await session.activeSurface()
    snapshots.set('sess', snap('<button>A</button>'), surface.id)
    const click = vi.spyOn(session, 'click')

    expect(await dispatcher.dispatch('electron_click', { ref: 99 })).toMatchObject({
      ok: false,
      code: 'REF_NOT_FOUND',
    })
    expect(click).not.toHaveBeenCalled()
  })

  it('holds a ref wait until a walk already holding the ref lock settles', async () => {
    const sessions = new SessionManager()
    const snapshots = new SnapshotStore()
    let polls = 0
    const session = new FakeSession({
      id: 'sess',
      evaluate: async () => {
        polls++
        return { satisfied: true }
      },
    })
    sessions.register(new FakeTransport(), session)
    const dispatcher = new Dispatcher({ sessions, snapshots, operationTimeoutMs: 0 })
    dispatcher.register(waitForSelectorTool)
    const surface = await session.activeSurface()
    snapshots.set('sess', snap('<button>A</button>'), surface.id)
    const holder = deferred()
    const held = snapshots.withRefLock('sess', () => holder.promise)

    const waiting = dispatcher.dispatch('electron_wait_for_selector', { ref: 1, state: 'attached' })
    for (let i = 0; i < 4; i++) await flush()
    expect(polls).toBe(0)
    holder.resolve()
    await held
    expect(await waiting).toMatchObject({ ok: true })
    expect(polls).toBe(1)
  })
})
