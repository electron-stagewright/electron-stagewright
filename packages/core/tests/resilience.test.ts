/**
 * Resilience / chaos tests (security + robustness review).
 *
 * The server already degrades gracefully under several failure modes — a selector that matches
 * nothing, a session that is gone, a transport whose call rejects — but nothing asserted it. This
 * suite turns that graceful degradation into a contract: under each chaos condition the dispatcher
 * RESOLVES with an `ok:false` envelope carrying a REGISTERED error code (and the expected
 * `retryable` semantics), it never lets a failure escape as a thrown rejection, and it stays usable
 * for the next call (no wedged/corrupted state). The error model is the one the dispatcher already
 * implements: a `StagewrightError` surfaces its `code`; any other thrown value maps to
 * `INTERNAL_ERROR` (`dispatcher.#mapThrown`), and interaction failures are pattern-classified
 * (`classifyTargetError`). Codes come from the ADR-006 registry; dispatch is ADR-008.
 *
 * HUNG APP (now covered): a genuinely hung app — a transport call that never settles, e.g. a frozen
 * renderer whose `evaluate` never returns — is bounded by the dispatch-level operation-timeout
 * backstop (ADR-011). When a handler exceeds the configured budget the dispatch resolves with a
 * retryable `OPERATION_TIMEOUT` instead of hanging; the asserted case below drives a never-settling
 * `evaluate` against a short budget so a REAL timer fires. The backstop cannot cancel the underlying
 * op (a Playwright `evaluate` is not cancellable) — it ABANDONS the pending promise and unblocks the
 * agent — which is the trade-off ADR-011 records. (Per-tool timeouts still apply first: the wait
 * family self-bounds in the renderer and an eval/interaction transport timeout surfaces as its own
 * clean retryable code, asserted below; the backstop is the last-resort bound above all of them.)
 */

import { describe, expect, it } from 'vitest'

import { ERROR_CODES, type ErrorCode } from '../src/errors/registry.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { EVAL_TOOLS } from '../src/tools/eval/index.js'
import { INTERACTION_TOOLS } from '../src/tools/interaction/index.js'
import { makeFindTool } from '../src/tools/snapshot/find.js'
import type { AnyToolDefinition } from '../src/tools/types.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'

// A find tool with an injected trivial bundle loader so the test never depends on the built
// renderer artifact (dist). The failure we exercise comes from the transport's `evaluate`, which
// runs AFTER the bundle string is loaded, so the loader only has to not throw.
const findTool = makeFindTool({ loadBundle: () => 'return { children: [] }' })

/** Shape of the agent-facing error envelope fields this suite inspects. */
interface ErrorEnvelope {
  readonly ok: boolean
  readonly code?: string
  readonly retryable?: boolean
  readonly message?: string
}

/**
 * Expected outcome for a chaos case. `code` pins the error code; `retryable` pins the expected
 * retryable semantics as a LITERAL — so a drift of that flag in the registry fails the suite,
 * unlike the registry-mirror check inside {@link expectCleanError}, which only proves the envelope
 * reflects the registry.
 */
interface ExpectedError {
  readonly code?: ErrorCode
  readonly retryable?: boolean
}

/** Build a dispatcher with one registered session (unless `register:false`), configured per case. */
function chaosSetup(
  opts: {
    readonly session?: FakeSession
    readonly tools?: readonly AnyToolDefinition[]
    readonly allowEval?: boolean
    readonly register?: boolean
    readonly operationTimeoutMs?: number
  } = {},
): { dispatcher: Dispatcher; session: FakeSession } {
  const sessions = new SessionManager()
  const snapshots = new SnapshotStore()
  const session = opts.session ?? new FakeSession({ id: 'sess' })
  const transport = new FakeTransport()
  if (opts.register !== false) sessions.register(transport, session)
  const dispatcher = new Dispatcher({
    sessions,
    snapshots,
    ...(opts.allowEval !== undefined ? { allowEval: opts.allowEval } : {}),
    ...(opts.operationTimeoutMs !== undefined
      ? { operationTimeoutMs: opts.operationTimeoutMs }
      : {}),
  })
  dispatcher.registerAll(opts.tools ?? [...INTERACTION_TOOLS, findTool])
  return { dispatcher, session }
}

/**
 * Assert a dispatch degraded gracefully: it RESOLVED (a failure that escapes the dispatcher as a
 * thrown rejection is itself the bug `await` would surface), returned `ok:false` with a REGISTERED
 * error code, and the envelope's `retryable` flag is the expected literal.
 */
async function expectCleanError(
  dispatcher: Dispatcher,
  tool: string,
  args: unknown,
  expected: ExpectedError = {},
): Promise<ErrorEnvelope> {
  const result = (await dispatcher.dispatch(tool, args)) as ErrorEnvelope
  expect(result.ok).toBe(false)
  expect(typeof result.code).toBe('string')
  const code = result.code as string
  // The code is in the registry (no ad-hoc strings escaping to the agent)...
  expect(Object.prototype.hasOwnProperty.call(ERROR_CODES, code)).toBe(true)
  // ...and the envelope mirrors the registry's retryable flag (the makeError contract). NB: this
  // mirror is tautological for the registry VALUE — both sides read ERROR_CODES — so the per-case
  // `expected.retryable` literal below is what actually pins the semantics and catches a drift.
  expect(result.retryable).toBe(ERROR_CODES[code as ErrorCode].retryable)
  if (expected.code !== undefined) expect(code).toBe(expected.code)
  if (expected.retryable !== undefined) expect(result.retryable).toBe(expected.retryable)
  return result
}

describe('resilience: bad selectors and unactionable elements', () => {
  it('maps a no-match selector to SELECTOR_NO_MATCH, not a crash', async () => {
    const { dispatcher } = chaosSetup({
      session: new FakeSession({
        id: 'sess',
        interactionError: new Error('locator.click: no element matches selector "#ghost"'),
      }),
    })
    await expectCleanError(
      dispatcher,
      'electron_click',
      { selector: '#ghost' },
      { code: 'SELECTOR_NO_MATCH', retryable: false },
    )
  })

  it('maps a disabled element to ELEMENT_DISABLED', async () => {
    const { dispatcher } = chaosSetup({
      session: new FakeSession({ id: 'sess', interactionError: new Error('element is disabled') }),
    })
    await expectCleanError(
      dispatcher,
      'electron_click',
      { selector: '#x' },
      { code: 'ELEMENT_DISABLED', retryable: false },
    )
  })

  it('maps an actionability timeout to a retryable visibility failure (not a hang)', async () => {
    const { dispatcher } = chaosSetup({
      session: new FakeSession({
        id: 'sess',
        interactionError: new Error('locator.click: Timeout 5000ms exceeded'),
      }),
    })
    await expectCleanError(
      dispatcher,
      'electron_click',
      { selector: '#x' },
      { code: 'ELEMENT_NOT_VISIBLE', retryable: true },
    )
  })
})

describe('resilience: dead or closed session', () => {
  it('returns NOT_RUNNING when no session is running', async () => {
    const { dispatcher } = chaosSetup({ register: false })
    await expectCleanError(
      dispatcher,
      'electron_click',
      { selector: '#x' },
      { code: 'NOT_RUNNING', retryable: false },
    )
  })

  it('returns NOT_RUNNING for a stale/closed session id', async () => {
    const { dispatcher } = chaosSetup() // one session registered as 'sess'
    await expectCleanError(
      dispatcher,
      'electron_click',
      { sessionId: 'closed-window', selector: '#x' },
      { code: 'NOT_RUNNING', retryable: false },
    )
  })
})

describe('resilience: transport loss', () => {
  it('maps a rejecting transport call to a clean INTERNAL_ERROR envelope', async () => {
    const { dispatcher } = chaosSetup({
      session: new FakeSession({
        id: 'sess',
        evaluate: async () => {
          throw new Error('renderer bridge closed')
        },
      }),
    })
    await expectCleanError(
      dispatcher,
      'electron_find',
      { role: 'button' },
      { code: 'INTERNAL_ERROR', retryable: false },
    )
  })

  it('does not wedge the dispatcher: a healthy call succeeds after a transport failure', async () => {
    // The session's evaluate rejects (snapshot/find path is broken) but interactions still work —
    // proving a failed dispatch leaves no corrupted session/dispatcher state behind it.
    const session = new FakeSession({
      id: 'sess',
      evaluate: async () => {
        throw new Error('renderer bridge closed')
      },
    })
    const { dispatcher } = chaosSetup({ session })
    await expectCleanError(
      dispatcher,
      'electron_find',
      { role: 'button' },
      { code: 'INTERNAL_ERROR', retryable: false },
    )
    // Same dispatcher, same (still-registered) session — a non-evaluate op recovers cleanly.
    expect(await dispatcher.dispatch('electron_click', { selector: '#still-works' })).toMatchObject(
      {
        ok: true,
      },
    )
  })
})

describe('resilience: a transport timeout surfaces as a clean retryable code', () => {
  it('maps an eval timeout to the retryable EVAL_TIMEOUT, not INTERNAL_ERROR or a hang', async () => {
    const { dispatcher } = chaosSetup({
      session: new FakeSession({
        id: 'sess',
        evaluate: async () => {
          throw new Error('Execution context evaluation timed out after 1000ms')
        },
      }),
      tools: EVAL_TOOLS,
      allowEval: true,
    })
    await expectCleanError(
      dispatcher,
      'electron_eval_renderer',
      { code: 'document.title' },
      { code: 'EVAL_TIMEOUT', retryable: true },
    )
  })
})

describe('resilience: a hung app is bounded by the operation-timeout backstop (ADR-011)', () => {
  it('maps a never-settling transport call to a retryable OPERATION_TIMEOUT, not an infinite hang', async () => {
    // A frozen renderer: evaluate never resolves. With a short backstop budget a REAL timer fires
    // and the dispatch resolves instead of hanging — the gap the rest of this suite documented.
    const { dispatcher } = chaosSetup({
      session: new FakeSession({ id: 'sess', evaluate: () => new Promise<never>(() => undefined) }),
      operationTimeoutMs: 30,
    })
    await expectCleanError(
      dispatcher,
      'electron_find',
      { role: 'button' },
      { code: 'OPERATION_TIMEOUT', retryable: true },
    )
  })
})
