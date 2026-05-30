/**
 * Unit tests for the wait tools, dispatched against a canned / capturing
 * `FakeSession`. The renderer-bundle loader is mocked so wait_for_state stays
 * unit-fast. Each poll body's `{ satisfied, … }` result is supplied via the
 * fake's `evaluate`; the captured `arg` lets us assert ref→selector resolution.
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

import { type ErrorResponse, type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { type Snapshot, walkAccessibilityTree } from '../src/snapshot/index.js'
import {
  clampWaitTimeout,
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_WAIT_TIMEOUT_MS,
} from '../src/tools/wait/index.js'
import { WAIT_TOOLS } from '../src/tools/wait/index.js'
import type { TransportCapabilities } from '../src/transports/index.js'
import { FakeSession, FakeTransport, type FakeEvaluate } from './helpers/fake-transport.js'

vi.mock('../src/tools/snapshot/inject.js', () => ({
  buildProbeBody: () => 'PROBE',
  buildWalkBody: () => 'WALK',
  buildRetagBody: () => 'RETAG',
  loadInjectedWalker: () => 'BUNDLE',
}))

const NO_RENDERER_EVAL_CAPS: TransportCapabilities = {
  canLaunch: true,
  canAttach: true,
  canInject: true,
  canIntercept: true,
  canControlClock: true,
  supportsMainEval: true,
  supportsRendererEval: false,
  supportsInteraction: true,
}

function snap(html: string): Snapshot {
  return walkAccessibilityTree(new JSDOM(html).window.document, {})
}

/** A fake evaluate that records each call's body+arg and resolves to `result`. */
function capturing(result: unknown): {
  readonly evaluate: FakeEvaluate
  readonly calls: { body: string; arg: unknown }[]
} {
  const calls: { body: string; arg: unknown }[] = []
  const evaluate: FakeEvaluate = async (_target, body, arg) => {
    calls.push({ body, arg })
    return result
  }
  return { evaluate, calls }
}

function setup(
  opts: { readonly evaluate?: FakeEvaluate; readonly capabilities?: TransportCapabilities } = {},
) {
  const sessions = new SessionManager()
  const snapshots = new SnapshotStore()
  const session = new FakeSession({
    id: 'sess',
    ...(opts.evaluate !== undefined ? { evaluate: opts.evaluate } : {}),
  })
  const transport =
    opts.capabilities !== undefined
      ? new FakeTransport({ capabilities: opts.capabilities })
      : new FakeTransport()
  sessions.register(transport, session)
  const dispatcher = new Dispatcher({ sessions, snapshots })
  dispatcher.registerAll(WAIT_TOOLS)
  return { dispatcher, session, snapshots }
}

describe('clampWaitTimeout', () => {
  it('defaults when omitted, clamps oversize, floors negative', () => {
    expect(clampWaitTimeout(undefined)).toBe(DEFAULT_WAIT_TIMEOUT_MS)
    expect(clampWaitTimeout(10_000_000)).toBe(MAX_WAIT_TIMEOUT_MS)
    expect(clampWaitTimeout(-5)).toBe(0)
  })
})

describe('electron_wait', () => {
  it('waits the (clamped) duration and reports it', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_wait', { ms: 1 })) as SuccessResponse & {
      waited_ms: number
    }
    expect(res).toMatchObject({ ok: true, waited_ms: 1 })
  })
})

describe('electron_wait_for_selector', () => {
  it('resolves matched when the body reports satisfied', async () => {
    const { dispatcher } = setup({
      evaluate: capturing({ satisfied: true, state: 'visible' }).evaluate,
    })
    const res = (await dispatcher.dispatch('electron_wait_for_selector', {
      selector: '#go',
    })) as SuccessResponse & { matched: boolean; state: string }
    expect(res).toMatchObject({ ok: true, matched: true, state: 'visible' })
  })

  it('resolves a ref to the data-sw-ref selector in the poll arg', async () => {
    const cap = capturing({ satisfied: true, state: 'visible' })
    const { dispatcher } = setup({ evaluate: cap.evaluate })
    await dispatcher.dispatch('electron_wait_for_selector', { ref: 2, state: 'attached' })
    expect((cap.calls[0]?.arg as { selector: string }).selector).toBe('[data-sw-ref="2"]')
    expect((cap.calls[0]?.arg as { state: string }).state).toBe('attached')
  })

  it('returns WAIT_TIMEOUT (retryable) when never satisfied', async () => {
    const { dispatcher } = setup({
      evaluate: capturing({ satisfied: false, state: 'visible' }).evaluate,
    })
    const res = (await dispatcher.dispatch('electron_wait_for_selector', {
      selector: '#never',
    })) as ErrorResponse
    expect(res).toMatchObject({ ok: false, code: 'WAIT_TIMEOUT', retryable: true })
    expect(res.next_actions).toEqual(['electron_snapshot()'])
  })

  it('maps a malformed selector to BAD_ARGUMENT', async () => {
    const { dispatcher } = setup({
      evaluate: capturing({ satisfied: false, invalid_selector: true, error: 'bad' }).evaluate,
    })
    const res = (await dispatcher.dispatch('electron_wait_for_selector', {
      selector: ':::',
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })

  it('rejects ref and selector together with BAD_ARGUMENT', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_wait_for_selector', {
      ref: 1,
      selector: '#go',
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })

  it('guards stale refs before absence can satisfy hidden/detached waits', async () => {
    const cap = capturing({ satisfied: true, state: 'hidden' })
    const { dispatcher, snapshots } = setup({ evaluate: cap.evaluate })
    snapshots.set('sess', snap('<button>Save</button>'))
    const res = (await dispatcher.dispatch('electron_wait_for_selector', {
      ref: 99,
      state: 'hidden',
    })) as ErrorResponse
    expect(res.code).toBe('REF_NOT_FOUND')
    expect(cap.calls).toEqual([{ body: 'WALK', arg: {} }])
  })
})

describe('electron_wait_for_state', () => {
  it('resolves matched with the observed state', async () => {
    const state = { visible: true, disabled: false }
    const { dispatcher } = setup({ evaluate: capturing({ satisfied: true, state }).evaluate })
    const res = (await dispatcher.dispatch('electron_wait_for_state', {
      selector: '#b',
      state: { disabled: false },
    })) as SuccessResponse & { matched: boolean; state: unknown }
    expect(res).toMatchObject({ ok: true, matched: true })
    expect(res.state).toEqual(state)
  })

  it('forwards the desired state object as the poll predicate', async () => {
    const cap = capturing({ satisfied: true, state: {} })
    const { dispatcher } = setup({ evaluate: cap.evaluate })
    await dispatcher.dispatch('electron_wait_for_state', {
      selector: '#b',
      state: { checked: true },
    })
    expect((cap.calls[0]?.arg as { want: unknown }).want).toEqual({ checked: true })
  })

  it('accepts enabled as a composable state predicate', async () => {
    const cap = capturing({ satisfied: true, state: { enabled: true, disabled: false } })
    const { dispatcher } = setup({ evaluate: cap.evaluate })
    const res = (await dispatcher.dispatch('electron_wait_for_state', {
      selector: '#b',
      state: { enabled: true },
    })) as SuccessResponse & { state: unknown }
    expect(res.ok).toBe(true)
    expect(res.state).toEqual({ enabled: true, disabled: false })
    expect((cap.calls[0]?.arg as { want: unknown }).want).toEqual({ enabled: true })
  })

  it('returns WAIT_TIMEOUT carrying the last observed state in details', async () => {
    const { dispatcher } = setup({
      evaluate: capturing({ satisfied: false, state: { enabled: false } }).evaluate,
    })
    const res = (await dispatcher.dispatch('electron_wait_for_state', {
      selector: '#b',
      state: { disabled: false },
    })) as ErrorResponse
    expect(res.code).toBe('WAIT_TIMEOUT')
    expect(res.details).toEqual({ last_state: { enabled: false } })
  })

  it('requires at least one state flag', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_wait_for_state', {
      selector: '#b',
      state: {},
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })
})

describe('electron_wait_for_event', () => {
  it('resolves fired when the event fires', async () => {
    const { dispatcher } = setup({
      evaluate: capturing({ satisfied: true, event: 'load' }).evaluate,
    })
    const res = (await dispatcher.dispatch('electron_wait_for_event', {
      eventName: 'load',
    })) as SuccessResponse & { fired: boolean; event: string }
    expect(res).toMatchObject({ ok: true, fired: true, event: 'load' })
  })

  it('returns WAIT_TIMEOUT when the event never fires', async () => {
    const { dispatcher } = setup({ evaluate: capturing({ satisfied: false, event: 'x' }).evaluate })
    const res = (await dispatcher.dispatch('electron_wait_for_event', {
      eventName: 'x',
    })) as ErrorResponse
    expect(res.code).toBe('WAIT_TIMEOUT')
  })

  it('maps a missing target element to SELECTOR_NO_MATCH', async () => {
    const cap = capturing({ satisfied: false, missing_target: true })
    const { dispatcher, snapshots } = setup({ evaluate: cap.evaluate })
    snapshots.set('sess', snap('<button>Save</button><button>Cancel</button>'))
    const res = (await dispatcher.dispatch('electron_wait_for_event', {
      eventName: 'click',
      selector: '#gone',
    })) as ErrorResponse
    expect(res.code).toBe('SELECTOR_NO_MATCH')
    expect(res.similar_refs?.map((ref) => ref.name)).toContain('Save')
    expect(cap.calls.map((call) => call.body)).toEqual(expect.arrayContaining(['WALK']))
  })

  it('guards a stale optional ref before listening for the event', async () => {
    const cap = capturing({ satisfied: true, event: 'click' })
    const { dispatcher, snapshots } = setup({ evaluate: cap.evaluate })
    snapshots.set('sess', snap('<button>Save</button>'))
    const res = (await dispatcher.dispatch('electron_wait_for_event', {
      eventName: 'click',
      ref: 99,
    })) as ErrorResponse
    expect(res.code).toBe('REF_NOT_FOUND')
    expect(cap.calls).toEqual([{ body: 'WALK', arg: {} }])
  })
})

describe('wait-tool capability contract', () => {
  it('documents stale-ref errors for targeted waits', () => {
    for (const tool of WAIT_TOOLS.filter((candidate) => candidate.name !== 'electron_wait')) {
      expect(tool.description).toContain('REF_NOT_FOUND')
    }
  })

  it('renderer-poll waits refuse a transport without supportsRendererEval', async () => {
    const { dispatcher } = setup({ capabilities: NO_RENDERER_EVAL_CAPS })
    const res = (await dispatcher.dispatch('electron_wait_for_selector', {
      selector: '#go',
    })) as ErrorResponse
    expect(res.code).toBe('TRANSPORT_UNSUPPORTED')
  })
})
