/**
 * Unit tests for `electron_dialog_handler`. A `FakeSession` records every
 * `setDialogPolicy` call and returns a canned dialog buffer from `dialogEvents`,
 * so we can assert arming (policy forwarding + guards), inspect-only behaviour,
 * read filters, and buffer clearing without launching a real Electron app.
 */

import { describe, expect, it } from 'vitest'

import { type ErrorResponse, type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { OBSERVE_TOOLS } from '../src/tools/observe/index.js'
import type { DialogEvent, DialogPolicy } from '../src/transports/index.js'
import { FakeSession, FakeTransport, type FakeSessionOptions } from './helpers/fake-transport.js'

type DialogSuccess = SuccessResponse & {
  policy: DialogPolicy
  entries: readonly DialogEvent[]
  count: number
  overflowed: number
}

const SAMPLE: readonly DialogEvent[] = [
  { type: 'alert', message: 'a', action: 'dismiss', timestamp: 1 },
  { type: 'confirm', message: 'c', action: 'accept', timestamp: 2 },
  {
    type: 'prompt',
    message: 'p',
    action: 'accept',
    promptText: 'x',
    defaultValue: 'd',
    timestamp: 3,
  },
]

function setup(opts: FakeSessionOptions = {}) {
  const sessions = new SessionManager()
  const session = new FakeSession({ id: 'sess', ...opts })
  sessions.register(new FakeTransport(), session)
  const dispatcher = new Dispatcher({ sessions })
  dispatcher.registerAll(OBSERVE_TOOLS)
  return { dispatcher, session }
}

describe('electron_dialog_handler', () => {
  it('arms an accept policy and echoes the policy in effect', async () => {
    const { dispatcher, session } = setup({ dialogPolicy: { action: 'accept' } })
    const res = (await dispatcher.dispatch('electron_dialog_handler', {
      action: 'accept',
    })) as DialogSuccess
    expect(res.ok).toBe(true)
    expect(session.dialogPolicyCalls).toEqual([{ action: 'accept' }])
    expect(res.policy).toEqual({ action: 'accept' })
  })

  it('forwards promptText when prompts are accepted', async () => {
    const { dispatcher, session } = setup()
    const res = (await dispatcher.dispatch('electron_dialog_handler', {
      action: 'accept',
      promptText: 'LIC-9',
    })) as DialogSuccess
    expect(res.ok).toBe(true)
    expect(session.dialogPolicyCalls).toEqual([{ action: 'accept', promptText: 'LIC-9' }])
  })

  it('forwards a per-type policy with the safe dismiss default when action is omitted', async () => {
    const { dispatcher, session } = setup()
    const res = (await dispatcher.dispatch('electron_dialog_handler', {
      perType: { confirm: 'accept' },
    })) as DialogSuccess
    expect(res.ok).toBe(true)
    expect(session.dialogPolicyCalls).toEqual([
      { action: 'dismiss', perType: { confirm: 'accept' } },
    ])
  })

  it('allows promptText when perType accepts prompts even without a default action', async () => {
    const { dispatcher, session } = setup()
    const res = (await dispatcher.dispatch('electron_dialog_handler', {
      perType: { prompt: 'accept' },
      promptText: 'KEY',
    })) as DialogSuccess
    expect(res.ok).toBe(true)
    expect(session.dialogPolicyCalls[0]).toMatchObject({
      action: 'dismiss',
      perType: { prompt: 'accept' },
      promptText: 'KEY',
    })
  })

  it('forwards oneShot when arming', async () => {
    const { dispatcher, session } = setup()
    const res = (await dispatcher.dispatch('electron_dialog_handler', {
      action: 'accept',
      oneShot: true,
    })) as DialogSuccess
    expect(res.ok).toBe(true)
    expect(session.dialogPolicyCalls).toEqual([{ action: 'accept', oneShot: true }])
  })

  it('rejects promptText when prompts are not accepted, without touching the policy', async () => {
    const { dispatcher, session } = setup()
    const res = (await dispatcher.dispatch('electron_dialog_handler', {
      action: 'dismiss',
      promptText: 'oops',
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
    expect(session.dialogPolicyCalls).toHaveLength(0)
  })

  it('rejects promptText when a perType override dismisses prompts despite an accept default', async () => {
    // perType.prompt wins over the default action, so prompts are dismissed and
    // promptText is meaningless — guards against an inverted `??` regression.
    const { dispatcher, session } = setup()
    const res = (await dispatcher.dispatch('electron_dialog_handler', {
      action: 'accept',
      perType: { prompt: 'dismiss' },
      promptText: 'x',
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
    expect(session.dialogPolicyCalls).toHaveLength(0)
  })

  it('rejects oneShot without a policy to arm', async () => {
    const { dispatcher, session } = setup()
    const res = (await dispatcher.dispatch('electron_dialog_handler', {
      oneShot: true,
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
    expect(session.dialogPolicyCalls).toHaveLength(0)
  })

  it('is inspect-only with no arming args and returns the buffer', async () => {
    const { dispatcher, session } = setup({
      dialogEntries: SAMPLE,
      dialogOverflowed: 2,
      dialogPolicy: { action: 'accept' },
    })
    const res = (await dispatcher.dispatch('electron_dialog_handler', {})) as DialogSuccess
    expect(session.dialogPolicyCalls).toHaveLength(0)
    expect(res.count).toBe(3)
    expect(res.entries).toHaveLength(3)
    expect(res.overflowed).toBe(2)
    expect(res.policy).toEqual({ action: 'accept' })
  })

  it('filters returned events by type and since', async () => {
    const { dispatcher } = setup({ dialogEntries: SAMPLE })
    const byType = (await dispatcher.dispatch('electron_dialog_handler', {
      type: 'confirm',
    })) as DialogSuccess
    expect(byType.entries.map((e) => e.type)).toEqual(['confirm'])

    const since = (await dispatcher.dispatch('electron_dialog_handler', {
      since: 2,
    })) as DialogSuccess
    expect(since.entries.map((e) => e.type)).toEqual(['confirm', 'prompt'])
  })

  it('keeps the most recent events when limit is smaller than the match count', async () => {
    const { dispatcher } = setup({ dialogEntries: SAMPLE })
    const res = (await dispatcher.dispatch('electron_dialog_handler', {
      limit: 1,
    })) as DialogSuccess
    expect(res.entries.map((e) => e.type)).toEqual(['prompt'])
    expect(res.count).toBe(1)
  })

  it('forwards clear so the buffer is flushed after reading', async () => {
    const { dispatcher } = setup({ dialogEntries: SAMPLE })
    const first = (await dispatcher.dispatch('electron_dialog_handler', {
      clear: true,
    })) as DialogSuccess
    expect(first.count).toBe(3)
    const second = (await dispatcher.dispatch('electron_dialog_handler', {})) as DialogSuccess
    expect(second.count).toBe(0)
  })

  it('requires a running session', async () => {
    const dispatcher = new Dispatcher({ sessions: new SessionManager() })
    dispatcher.registerAll(OBSERVE_TOOLS)
    const res = (await dispatcher.dispatch('electron_dialog_handler', {})) as ErrorResponse
    expect(res.code).toBe('NOT_RUNNING')
  })
})
