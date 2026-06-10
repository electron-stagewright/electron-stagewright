/**
 * Unit tests for the `expect_*` assertion family, dispatched against a canned
 * `FakeSession`. The renderer poll loop lives inside the (string) body and is not
 * executed here; the fake's `evaluate` supplies the `{ satisfied, actual }` (or a
 * Snapshot, for role-mode count) so these tests exercise the orchestration:
 * success → `{ matched }`, a never-met expectation → `EXPECTATION_FAILED` with
 * `details.expected` + `details.actual`, and predicate validation → `BAD_ARGUMENT`.
 * The renderer-bundle loader is mocked so the bundle-backed tools stay unit-fast.
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

import { type ErrorResponse, type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { type Snapshot, walkAccessibilityTree } from '../src/snapshot/index.js'
import { EXPECT_TOOLS } from '../src/tools/expect/index.js'
import { READ_TOOLS } from '../src/tools/read/index.js'
import { WAIT_TOOLS } from '../src/tools/wait/index.js'
import type { TransportCapabilities } from '../src/transports/index.js'
import { FakeSession, FakeTransport, type FakeEvaluate } from './helpers/fake-transport.js'

vi.mock('../src/tools/snapshot/inject.js', () => ({
  buildProbeBody: () => 'PROBE',
  buildWalkBody: () => 'WALK',
  buildRetagBody: () => 'RETAG',
  loadInjectedWalker: () => 'BUNDLE',
}))

function snap(html: string): Snapshot {
  return walkAccessibilityTree(new JSDOM(html).window.document, {})
}

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

function setup(
  opts: { readonly evaluate?: FakeEvaluate; readonly capabilities?: TransportCapabilities } = {},
) {
  const sessions = new SessionManager()
  const session = new FakeSession({
    id: 'sess',
    ...(opts.evaluate ? { evaluate: opts.evaluate } : {}),
  })
  const snapshots = new SnapshotStore()
  sessions.register(
    new FakeTransport(opts.capabilities ? { capabilities: opts.capabilities } : {}),
    session,
  )
  const dispatcher = new Dispatcher({ sessions, snapshots })
  dispatcher.registerAll([...READ_TOOLS, ...WAIT_TOOLS, ...EXPECT_TOOLS])
  return { dispatcher, session, snapshots }
}

/** An evaluate that always returns the same canned poll result. */
const canned =
  (raw: unknown): FakeEvaluate =>
  async () =>
    raw

describe('electron_expect_text', () => {
  it('returns matched with the observed value when the predicate holds', async () => {
    const { dispatcher } = setup({ evaluate: canned({ satisfied: true, actual: 'Welcome back' }) })
    const res = (await dispatcher.dispatch('electron_expect_text', {
      selector: '#h',
      contains: 'Welcome',
    })) as SuccessResponse & { matched: boolean; actual: string }
    expect(res).toMatchObject({ ok: true, matched: true, actual: 'Welcome back' })
  })

  it('fails with EXPECTATION_FAILED carrying expected + actual on mismatch', async () => {
    const { dispatcher } = setup({ evaluate: canned({ satisfied: false, actual: 'Welcome' }) })
    const res = (await dispatcher.dispatch('electron_expect_text', {
      selector: '#h',
      equals: 'Welcome back',
      timeoutMs: 0,
    })) as ErrorResponse & { details?: { expected?: string; actual?: unknown } }
    expect(res.code).toBe('EXPECTATION_FAILED')
    expect(res.details?.expected).toContain('Welcome back')
    expect(res.details?.actual).toBe('Welcome')
  })

  it('rejects when no predicate is given', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_expect_text', {
      selector: '#h',
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })

  it('rejects when more than one predicate is given', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_expect_text', {
      selector: '#h',
      equals: 'a',
      contains: 'b',
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })

  it('rejects an invalid regex before any renderer round-trip', async () => {
    let calls = 0
    const { dispatcher } = setup({
      evaluate: async () => {
        calls += 1
        return { satisfied: true, actual: '' }
      },
    })
    const res = (await dispatcher.dispatch('electron_expect_text', {
      selector: '#h',
      regex: '(',
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
    expect(calls).toBe(0)
  })

  it('rejects an unsafe (catastrophic-backtracking) regex before any renderer round-trip', async () => {
    let calls = 0
    const { dispatcher } = setup({
      evaluate: async () => {
        calls += 1
        return { satisfied: true, actual: '' }
      },
    })
    const res = (await dispatcher.dispatch('electron_expect_text', {
      selector: '#h',
      regex: '(a+)+$',
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
    expect(res.error).toContain('Unsafe')
    expect(calls).toBe(0)
  })

  it('supports negation predicates', async () => {
    const { dispatcher } = setup({ evaluate: canned({ satisfied: true, actual: 'Ready' }) })
    const res = (await dispatcher.dispatch('electron_expect_text', {
      selector: '#h',
      not_contains: 'Error',
    })) as SuccessResponse & { matched: boolean }
    expect(res.matched).toBe(true)
  })
})

describe('electron_expect_value', () => {
  it('matches a form control value', async () => {
    const { dispatcher } = setup({ evaluate: canned({ satisfied: true, actual: 'hello' }) })
    const res = (await dispatcher.dispatch('electron_expect_value', {
      selector: '#in',
      equals: 'hello',
    })) as SuccessResponse & { matched: boolean; actual: string }
    expect(res).toMatchObject({ matched: true, actual: 'hello' })
  })
})

describe('electron_expect_visible', () => {
  it('matches when the element is visible', async () => {
    const { dispatcher } = setup({ evaluate: canned({ satisfied: true, state: 'visible' }) })
    const res = (await dispatcher.dispatch('electron_expect_visible', {
      selector: '#btn',
    })) as SuccessResponse & { matched: boolean }
    expect(res.matched).toBe(true)
  })

  it('fails with EXPECTATION_FAILED when never visible', async () => {
    const { dispatcher } = setup({ evaluate: canned({ satisfied: false, state: 'visible' }) })
    const res = (await dispatcher.dispatch('electron_expect_visible', {
      selector: '#btn',
      timeoutMs: 0,
    })) as ErrorResponse & { details?: { expected?: string } }
    expect(res.code).toBe('EXPECTATION_FAILED')
    expect(res.details?.expected).toBe('visible')
  })
})

describe('electron_expect_state', () => {
  it('matches a composite state and echoes the observed state', async () => {
    const state = { visible: true, enabled: true, disabled: false }
    const { dispatcher } = setup({ evaluate: canned({ satisfied: true, state }) })
    const res = (await dispatcher.dispatch('electron_expect_state', {
      selector: '#btn',
      state: { enabled: true },
    })) as SuccessResponse & { matched: boolean; state: unknown }
    expect(res.matched).toBe(true)
    expect(res.state).toEqual(state)
  })

  it('fails with the expected predicate and last observed state', async () => {
    const last = { enabled: false, disabled: true }
    const { dispatcher } = setup({ evaluate: canned({ satisfied: false, state: last }) })
    const res = (await dispatcher.dispatch('electron_expect_state', {
      selector: '#btn',
      state: { enabled: true },
      timeoutMs: 0,
    })) as ErrorResponse & { details?: { expected?: unknown; actual?: unknown } }
    expect(res.code).toBe('EXPECTATION_FAILED')
    expect(res.details?.expected).toEqual({ enabled: true })
    expect(res.details?.actual).toEqual(last)
  })
})

describe('electron_expect_count (selector mode)', () => {
  it('matches when the count satisfies the predicate', async () => {
    const { dispatcher } = setup({ evaluate: canned({ satisfied: true, actual: 3 }) })
    const res = (await dispatcher.dispatch('electron_expect_count', {
      selector: 'li',
      equals: 3,
    })) as SuccessResponse & { matched: boolean; actual: number }
    expect(res).toMatchObject({ matched: true, actual: 3 })
  })

  it('fails with EXPECTATION_FAILED carrying the count predicate', async () => {
    const { dispatcher } = setup({ evaluate: canned({ satisfied: false, actual: 1 }) })
    const res = (await dispatcher.dispatch('electron_expect_count', {
      selector: 'li',
      min: 3,
      timeoutMs: 0,
    })) as ErrorResponse & { details?: { expected?: string; actual?: number } }
    expect(res.code).toBe('EXPECTATION_FAILED')
    expect(res.details?.expected).toContain('>= 3')
    expect(res.details?.actual).toBe(1)
  })

  it('rejects when no count predicate is given', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_expect_count', {
      selector: 'li',
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })

  it('rejects impossible count predicates before any renderer round-trip', async () => {
    let calls = 0
    const { dispatcher } = setup({
      evaluate: async () => {
        calls += 1
        return { satisfied: false, actual: 0 }
      },
    })
    const res = (await dispatcher.dispatch('electron_expect_count', {
      selector: 'li',
      equals: 2,
      min: 3,
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
    expect(calls).toBe(0)
  })

  it('rejects mixing selector with role filters', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_expect_count', {
      selector: 'li',
      role: 'button',
      min: 1,
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })

  it('honors visible:false by counting hidden selector matches only', async () => {
    const dom = new JSDOM(
      '<button id="shown">Shown</button><button id="hidden" style="visibility: hidden">Hidden</button>',
    )
    const globals = globalThis as typeof globalThis & {
      document?: Document
      getComputedStyle?: typeof globalThis.getComputedStyle
    }
    const previousDocument = globals.document
    const previousGetComputedStyle = globals.getComputedStyle
    const shown = dom.window.document.getElementById('shown')
    if (shown === null) throw new Error('fixture missing shown button')
    Object.defineProperty(shown, 'getClientRects', {
      value: () => ({ length: 1 }) as DOMRectList,
    })
    globals.document = dom.window.document
    globals.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
    try {
      const { dispatcher } = setup({
        evaluate: async (_target, body, arg) =>
          Function('arg', `"use strict"; return (async () => { ${body} })()`)(arg),
      })
      const res = (await dispatcher.dispatch('electron_expect_count', {
        selector: 'button',
        visible: false,
        equals: 1,
        timeoutMs: 0,
      })) as SuccessResponse & { actual: number }
      expect(res.ok).toBe(true)
      expect(res.actual).toBe(1)
    } finally {
      if (previousDocument === undefined) {
        delete globals.document
      } else {
        globals.document = previousDocument
      }
      if (previousGetComputedStyle === undefined) {
        delete globals.getComputedStyle
      } else {
        globals.getComputedStyle = previousGetComputedStyle
      }
    }
  })
})

describe('electron_expect_count (role mode)', () => {
  const TWO_BUTTONS = '<button>A</button><button>B</button>'

  it('counts accessibility-role matches via findEntries', async () => {
    const { dispatcher } = setup({ evaluate: canned(snap(TWO_BUTTONS)) })
    const res = (await dispatcher.dispatch('electron_expect_count', {
      role: 'button',
      equals: 2,
    })) as SuccessResponse & { matched: boolean; actual: number }
    expect(res).toMatchObject({ matched: true, actual: 2 })
  })

  it('fails when the role count does not satisfy the predicate', async () => {
    const { dispatcher } = setup({ evaluate: canned(snap(TWO_BUTTONS)) })
    const res = (await dispatcher.dispatch('electron_expect_count', {
      role: 'button',
      min: 5,
      timeoutMs: 0,
    })) as ErrorResponse & { details?: { actual?: number } }
    expect(res.code).toBe('EXPECTATION_FAILED')
    expect(res.details?.actual).toBe(2)
  })

  it('rejects role mode with no selector and no target filter', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_expect_count', { equals: 1 })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })

  it('rejects role mode with both name predicates', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_expect_count', {
      role: 'button',
      name_contains: 'Save',
      name_exact: 'Save',
      min: 1,
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })
})

describe('electron_expect_url', () => {
  it('matches when the URL contains the substring', async () => {
    const { dispatcher } = setup({
      evaluate: canned({ satisfied: true, actual: 'app://x/settings' }),
    })
    const res = (await dispatcher.dispatch('electron_expect_url', {
      contains: '/settings',
    })) as SuccessResponse & { matched: boolean; actual: string }
    expect(res).toMatchObject({ matched: true, actual: 'app://x/settings' })
  })

  it('rejects when neither contains nor matches is given', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_expect_url', {})) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })

  it('rejects when both predicates are given', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_expect_url', {
      contains: 'a',
      matches: 'b',
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })
})

describe('electron_assert_pattern', () => {
  it('validates element text in one shot', async () => {
    const { dispatcher } = setup({ evaluate: canned({ satisfied: true, actual: 'OK' }) })
    const res = (await dispatcher.dispatch('electron_assert_pattern', {
      selector: '#status',
      contains: 'OK',
    })) as SuccessResponse & { matched: boolean; actual: string }
    expect(res).toMatchObject({ matched: true, actual: 'OK' })
  })

  it('validates an attribute against a regex', async () => {
    const { dispatcher } = setup({ evaluate: canned({ satisfied: true, actual: '1234' }) })
    const res = (await dispatcher.dispatch('electron_assert_pattern', {
      selector: '#code',
      attribute: 'value',
      matches_regex: '^\\d{4}$',
    })) as SuccessResponse & { matched: boolean }
    expect(res.matched).toBe(true)
  })

  it('fails with EXPECTATION_FAILED when the element is present but the value mismatches', async () => {
    const { dispatcher } = setup({ evaluate: canned({ satisfied: false, actual: 'nope' }) })
    const res = (await dispatcher.dispatch('electron_assert_pattern', {
      selector: '#status',
      equals: 'OK',
    })) as ErrorResponse
    expect(res.code).toBe('EXPECTATION_FAILED')
  })

  it('reports SELECTOR_NO_MATCH (one-shot precondition) when the element is absent', async () => {
    let seenArg: { missAsError?: unknown; timeoutMs?: unknown } | undefined
    const { dispatcher } = setup({
      // The assert body carries the string matcher; the similar_refs walk (mocked
      // WALK body) does not — route so only the assert arg is captured and the
      // walk gets a benign snapshot.
      evaluate: async (_target, body, arg) => {
        if (typeof body === 'string' && body.includes('__swMatchString')) {
          seenArg = arg as { missAsError?: unknown; timeoutMs?: unknown }
          return { satisfied: false, missing_target: true }
        }
        return { entries: [] }
      },
    })
    const res = (await dispatcher.dispatch('electron_assert_pattern', {
      selector: '#missing',
      contains: 'x',
    })) as ErrorResponse
    expect(res.code).toBe('SELECTOR_NO_MATCH')
    // assert_pattern is one-shot and flags a missing element as a precondition failure.
    expect(seenArg?.missAsError).toBe(true)
    expect(seenArg?.timeoutMs).toBe(0)
  })

  it('rejects an invalid regex', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_assert_pattern', {
      selector: '#x',
      matches_regex: '(',
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })
})

describe('expect_* common contracts', () => {
  it('reports REF_NOT_FOUND for a stale ref before running the assertion poll', async () => {
    let pollCalls = 0
    const { dispatcher, snapshots } = setup({
      // The freshness guard walks the renderer; count only the assertion poll body
      // (it embeds the string matcher) so we prove it never ran.
      evaluate: async (_target, body) => {
        if (body.includes('__swMatchString')) pollCalls += 1
        return { satisfied: true, actual: '' }
      },
    })
    snapshots.set('sess', snap('<button>Save</button>'))
    const res = (await dispatcher.dispatch('electron_expect_text', {
      ref: 99,
      equals: 'x',
    })) as ErrorResponse
    expect(res.code).toBe('REF_NOT_FOUND')
    expect(pollCalls).toBe(0)
  })

  it('refuses a transport that cannot evaluate the renderer', async () => {
    const { dispatcher } = setup({ capabilities: NO_RENDERER_EVAL_CAPS })
    const res = (await dispatcher.dispatch('electron_expect_text', {
      selector: '#h',
      equals: 'x',
    })) as ErrorResponse
    expect(res.code).toBe('TRANSPORT_UNSUPPORTED')
  })

  it('requires a running session', async () => {
    const dispatcher = new Dispatcher({ sessions: new SessionManager() })
    dispatcher.registerAll(EXPECT_TOOLS)
    const res = (await dispatcher.dispatch('electron_expect_text', {
      selector: '#h',
      equals: 'x',
    })) as ErrorResponse
    expect(res.code).toBe('NOT_RUNNING')
  })
})

describe('token economy (ADR-007 Principle 8)', () => {
  it('settles an assertion in one renderer round-trip vs the get/wait/get chain', async () => {
    let calls = 0
    // Route by body: get_text reads textContent; the poll bodies do not.
    const evaluate: FakeEvaluate = async (_target, body) => {
      calls += 1
      return body.includes('textContent')
        ? { found: true, text: 'Welcome' }
        : { satisfied: true, actual: 'Welcome', state: {} }
    }
    const { dispatcher } = setup({ evaluate })

    // The low-level primitive equivalent: read, (compare in the agent), wait, re-read.
    await dispatcher.dispatch('electron_get_text', { selector: '#h' })
    await dispatcher.dispatch('electron_wait_for_state', {
      selector: '#h',
      state: { visible: true },
    })
    await dispatcher.dispatch('electron_get_text', { selector: '#h' })
    const chainCalls = calls

    calls = 0
    const res = (await dispatcher.dispatch('electron_expect_text', {
      selector: '#h',
      contains: 'Welcome',
    })) as SuccessResponse
    const expectCalls = calls

    expect(chainCalls).toBe(3)
    expect(expectCalls).toBe(1)
    expect(expectCalls).toBeLessThan(chainCalls)
    // Budget signal is present so an agent can weigh expect_* vs the chain.
    expect(typeof res._meta.estimated_tokens).toBe('number')
  })
})
