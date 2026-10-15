import { describe, expect, it, vi } from 'vitest'

import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { getTextTool } from '../src/tools/read/value.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

const walked = { schemaVersion: 1, entries: [], meta: {} }

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

function setup(evaluate: (call: number) => Promise<unknown>) {
  let calls = 0
  const sessions = new SessionManager()
  const session = new FakeSession({ evaluate: () => evaluate(++calls) })
  sessions.register(new FakeTransport(), session)
  const snapshots = new SnapshotStore()
  const stored = vi.spyOn(snapshots, 'set')
  const dispatcher = new Dispatcher({ sessions, snapshots, operationTimeoutMs: 0 })
  dispatcher.register(getTextTool)
  return { dispatcher, stored, evaluateCalls: () => calls }
}

describe('miss diagnosis after cancellation', () => {
  it('stores the re-walked snapshot for an uncancelled miss', async () => {
    const { dispatcher, stored } = setup(async (call) => (call === 1 ? { found: false } : walked))
    const result = await dispatcher.dispatch('electron_get_text', { selector: '#missing' })
    expect(result).toMatchObject({ ok: false, code: 'SELECTOR_NO_MATCH' })
    expect(stored).toHaveBeenCalled()
  })

  it('does not re-walk the DOM when the read misses after cancellation', async () => {
    const gate = deferred()
    const entered = deferred()
    const { dispatcher, stored, evaluateCalls } = setup(async (call) => {
      if (call > 1) return walked
      entered.resolve()
      await gate.promise
      return { found: false }
    })
    const controller = new AbortController()
    const pending = dispatcher.dispatch(
      'electron_get_text',
      { selector: '#missing' },
      { signal: controller.signal },
    )
    await entered.promise
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, code: 'OPERATION_CANCELLED' })
    gate.resolve()
    await settle()
    expect(evaluateCalls()).toBe(1)
    expect(stored).not.toHaveBeenCalled()
  })

  it('does not store a walk that outlived the cancellation', async () => {
    const gate = deferred()
    const entered = deferred()
    const { dispatcher, stored } = setup(async (call) => {
      if (call === 1) return { found: false }
      entered.resolve()
      await gate.promise
      return walked
    })
    const controller = new AbortController()
    const pending = dispatcher.dispatch(
      'electron_get_text',
      { selector: '#missing' },
      { signal: controller.signal },
    )
    await entered.promise
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, code: 'OPERATION_CANCELLED' })
    gate.resolve()
    await settle()
    expect(stored).not.toHaveBeenCalled()
  })
})
