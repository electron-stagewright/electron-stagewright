/**
 * Small orchestration shared by the `expect_*` tools. The poll/timeout machinery
 * itself is reused from `tools/wait/poll.ts` (`runWait`); this module only adds
 * the assertion-specific `BAD_ARGUMENT` helper so a predicate-validation failure
 * carries the session id in its envelope like every other error.
 *
 * @module
 */

import { makeError } from '../../errors/envelope.js'
import type { ToolContext, ToolResult } from '../types.js'

/**
 * Build a `BAD_ARGUMENT` envelope for an invalid predicate. Resolves the session
 * first (so the envelope carries `session_id`, and a missing session surfaces as
 * `NOT_RUNNING` exactly as the other tools do).
 */
export function expectBadArgument(
  ctx: ToolContext,
  sessionId: string | undefined,
  message: string,
): ToolResult {
  const managed = ctx.sessions.resolve(sessionId)
  return makeError('BAD_ARGUMENT', {
    startedAt: ctx.startedAt,
    now: ctx.now,
    session_id: managed.id,
    message,
  })
}
