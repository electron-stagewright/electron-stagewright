/**
 * Orchestration shared by the wait tools. `runWait` resolves the session,
 * refuses a transport that cannot evaluate the renderer, runs the bounded poll
 * body, and maps the result: `{ satisfied: true }` → success, a malformed
 * selector → `BAD_ARGUMENT`, a missing event target → `SELECTOR_NO_MATCH`, and a
 * timeout → `WAIT_TIMEOUT` (carrying the last observed state in `details`).
 *
 * @module
 */

import { makeError, makeSuccess } from '../../errors/envelope.js'
import type { ErrorCode } from '../../errors/registry.js'
import { assertCapability } from '../../transports/index.js'
import { buildMissError, handleTargetFailure, refFreshnessError, refName } from '../target.js'
import type { ToolContext, ToolResult } from '../types.js'

/** Default wait budget when the caller omits `timeoutMs`. */
export const DEFAULT_WAIT_TIMEOUT_MS = 5000
/** Hard cap on a wait budget — waits legitimately run longer than an actionability budget. */
export const MAX_WAIT_TIMEOUT_MS = 60000

/** Clamp a requested wait timeout into `[0, MAX_WAIT_TIMEOUT_MS]`, defaulting when omitted. */
export function clampWaitTimeout(timeoutMs?: number): number {
  const requested = timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  return Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(0, requested))
}

/** A renderer-eval body plus the `arg` the transport wrapper passes to it. */
export interface RendererCall {
  readonly body: string
  readonly arg: unknown
}

/** The shape every wait poll body resolves to. */
export interface WaitRaw {
  readonly satisfied?: boolean
  /** Last observed state (wait_for_state) or the requested selector state. */
  readonly state?: unknown
  readonly invalid_selector?: boolean
  readonly missing_target?: boolean
  readonly error?: string
  readonly [key: string]: unknown
}

/** Options for {@link runWait}. */
export interface RunWaitOptions {
  /** Message used for the timeout envelope (the tool interpolates the budget). */
  readonly timeoutMessage: string
  /**
   * Error code emitted when the poll never satisfies. Defaults to `WAIT_TIMEOUT`
   * (synchronisation). The `expect_*` assertions pass `EXPECTATION_FAILED` so a
   * never-met expectation reads as an assertion failure, not a sync timeout.
   */
  readonly timeoutCode?: ErrorCode
  /**
   * Build the `details` object attached to the timeout error from the final poll
   * result. Defaults to `{ last_state }` when the body reported a `state`. The
   * `expect_*` tools override this to surface `{ expected, actual }`.
   */
  readonly buildTimeoutDetails?: (raw: WaitRaw) => Record<string, unknown> | undefined
}

/** Default `details` builder: surface the last observed state, as the wait tools do. */
function defaultTimeoutDetails(raw: WaitRaw): Record<string, unknown> | undefined {
  return raw?.state !== undefined && raw.state !== null ? { last_state: raw.state } : undefined
}

/**
 * Run a bounded renderer wait. `mapSuccess` shapes the success payload from a
 * satisfied result; a never-satisfied poll becomes `opts.timeoutCode`
 * (`WAIT_TIMEOUT` by default) carrying `opts.buildTimeoutDetails(raw)` under
 * `details` (the last observed state by default).
 */
export async function runWait(
  ctx: ToolContext,
  args: {
    readonly sessionId?: string | undefined
    readonly ref?: number | undefined
  },
  call: RendererCall,
  mapSuccess: (raw: WaitRaw) => Record<string, unknown>,
  opts: RunWaitOptions,
): Promise<ToolResult> {
  const managed = ctx.sessions.resolve(args.sessionId)
  const meta = { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id }
  assertCapability(managed.transport, 'supportsRendererEval')

  const stale = await refFreshnessError(ctx, managed.session, meta, args.ref)
  if (stale !== undefined) return stale

  try {
    const raw = await managed.session.evaluate<WaitRaw>('renderer', call.body, call.arg)
    if (raw?.invalid_selector === true) {
      const reason = typeof raw.error === 'string' ? `: ${raw.error}` : '.'
      return makeError('BAD_ARGUMENT', { ...meta, message: `Invalid CSS selector${reason}` })
    }
    if (raw?.missing_target === true) {
      return buildMissError('SELECTOR_NO_MATCH', {
        ctx,
        session: managed.session,
        meta,
        message: 'No element matched the wait target.',
        nameHint: refName(ctx.snapshots.get(managed.id), args.ref),
      })
    }
    if (raw?.satisfied === true) {
      return makeSuccess({ session_id: managed.id, ...mapSuccess(raw) }, meta)
    }
    const details = (opts.buildTimeoutDetails ?? defaultTimeoutDetails)(raw)
    return makeError(opts.timeoutCode ?? 'WAIT_TIMEOUT', {
      ...meta,
      message: opts.timeoutMessage,
      next_actions: ['electron_snapshot()'],
      ...(details !== undefined ? { details } : {}),
    })
  } catch (err) {
    return handleTargetFailure(err, {
      ctx,
      session: managed.session,
      meta,
      nameHint: refName(ctx.snapshots.get(managed.id), args.ref),
    })
  }
}
