/**
 * Orchestration shared by the wait tools. `runWait` resolves the session,
 * refuses a transport that cannot evaluate the renderer, runs the bounded poll
 * body, and maps the result: `{ satisfied: true }` → success, a malformed
 * selector → `BAD_ARGUMENT`, a missing event target → `SELECTOR_NO_MATCH`, and a
 * timeout → `WAIT_TIMEOUT` (carrying the last observed state in `details`).
 *
 * A ref-targeted wait holds the ref lock only to check freshness and read the renderer walk
 * generation, then polls unlocked pinned to it. If a walk rewrites the tags meanwhile, the poll
 * stops, and the wait re-checks freshness under the lock and resumes with the remaining budget.
 *
 * @module
 */

import { makeError, makeSuccess } from '../../errors/envelope.js'
import type { ErrorCode } from '../../errors/registry.js'
import { withElapsedProgress } from '../../server/progress.js'
import { untilAborted } from '../../server/snapshot-store.js'
import { type TransportSession, assertCapability } from '../../transports/index.js'
import {
  type FreshRefsOutcome,
  buildMissError,
  handleTargetFailure,
  refNameForActiveSurface,
  staleRefError,
  targetRef,
  withFreshRefs,
} from '../target.js'
import type { ToolContext, ToolResult } from '../types.js'
import { WALK_GENERATION_BODY } from './body.js'

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
  /** A ref poll stopped because a walk or retag rewrote the ref tags. */
  readonly generation_changed?: boolean
  readonly error?: string
  readonly [key: string]: unknown
}

/** Options for {@link runWait}. */
export interface RunWaitOptions {
  /** Clamped operation budget, used as the advisory progress total. */
  readonly timeoutMs: number
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
  /** Stable progress phase. Defaults by wait vs expectation semantics. */
  readonly progressMessage?: string
}

/** Default `details` builder: surface the last observed state, as the wait tools do. */
function defaultTimeoutDetails(raw: WaitRaw): Record<string, unknown> | undefined {
  return raw?.state !== undefined && raw.state !== null ? { last_state: raw.state } : undefined
}

/**
 * Poll a ref target without holding the ref lock for the whole wait. Each round reads the walk
 * generation under the lock (after the freshness check), then runs the whole remaining budget in
 * one renderer call pinned to it, so event listeners stay attached for the full wait; a poll
 * interrupted by a walk starts the next round.
 */
async function pollRef(
  ctx: ToolContext,
  session: TransportSession,
  sessionId: string,
  ref: number,
  call: RendererCall,
  timeoutMs: number,
): Promise<FreshRefsOutcome<WaitRaw>> {
  const startedAt = ctx.now()
  const arg = call.arg as Record<string, unknown>
  for (;;) {
    const pinned = await withFreshRefs(
      ctx,
      session,
      sessionId,
      [{ ref }],
      () => {
        ctx.signal?.throwIfAborted()
        return session.evaluate<unknown>('renderer', WALK_GENERATION_BODY, {})
      },
      { readOnly: true },
    )
    if ('staleRef' in pinned) return pinned
    const walkGeneration = typeof pinned.value === 'number' ? pinned.value : 0
    const remaining = Math.max(0, timeoutMs - (ctx.now() - startedAt))
    ctx.signal?.throwIfAborted()
    const raw = await untilAborted(
      session.evaluate<WaitRaw>('renderer', call.body, {
        ...arg,
        timeoutMs: remaining,
        walkGeneration,
      }),
      ctx.signal,
    )
    if (raw?.generation_changed !== true || remaining === 0) return { value: raw }
  }
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
    readonly selector?: string | undefined
  },
  call: RendererCall,
  mapSuccess: (raw: WaitRaw) => Record<string, unknown>,
  opts: RunWaitOptions,
): Promise<ToolResult> {
  const managed = ctx.sessions.resolve(args.sessionId)
  const meta = { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id }
  assertCapability(managed.transport, 'supportsRendererEval')

  try {
    const ref = targetRef(args)
    const run = await withElapsedProgress(
      {
        reporter: ctx.progress,
        totalMs: opts.timeoutMs,
        message:
          opts.progressMessage ??
          (opts.timeoutCode === 'EXPECTATION_FAILED'
            ? 'Checking expectation'
            : 'Waiting for condition'),
        now: ctx.now,
      },
      async (): Promise<FreshRefsOutcome<WaitRaw>> => {
        if (ref !== undefined) {
          return pollRef(ctx, managed.session, managed.id, ref, call, opts.timeoutMs)
        }
        // A renderer poll cannot be interrupted once sent, so never start one for a cancelled request.
        ctx.signal?.throwIfAborted()
        return { value: await managed.session.evaluate<WaitRaw>('renderer', call.body, call.arg) }
      },
    )
    if ('staleRef' in run) return staleRefError(ctx, managed.session, meta, run.staleRef)
    const raw = run.value
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
        nameHint: await refNameForActiveSurface(ctx, managed.session, managed.id, args.ref),
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
    if (ctx.signal?.aborted === true) throw err
    return handleTargetFailure(err, {
      ctx,
      session: managed.session,
      meta,
      nameHint: await refNameForActiveSurface(ctx, managed.session, managed.id, args.ref),
    })
  }
}
