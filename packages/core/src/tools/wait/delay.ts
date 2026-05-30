/**
 * `electron_wait` — pause for a fixed duration. The blunt escape hatch; the
 * description steers agents toward the predicate waits (`wait_for_state`,
 * `wait_for_selector`) which are faster and less brittle.
 *
 * @module
 */

import { z } from 'zod'

import { makeSuccess } from '../../errors/envelope.js'
import { sessionIdField } from '../schema.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { MAX_WAIT_TIMEOUT_MS, clampWaitTimeout } from './poll.js'

/** `electron_wait` — sleep `ms` milliseconds (clamped), then resolve. */
export const waitTool: AnyToolDefinition = defineTool({
  name: 'electron_wait',
  title: 'Wait a fixed duration',
  description: [
    `Pause for ms milliseconds (clamped to ${MAX_WAIT_TIMEOUT_MS}). Prefer electron_wait_for_state or`,
    'electron_wait_for_selector — a fixed wait is slower and more brittle than waiting on a condition.',
    'Returns: { ok, session_id, waited_ms }. Errors: NOT_RUNNING (no session), BAD_ARGUMENT (multiple sessions).',
  ].join(' '),
  inputSchema: z.object({
    ms: z.number().int().nonnegative().describe('Milliseconds to wait (clamped to the max).'),
    sessionId: sessionIdField,
  }),
  operationType: 'query',
  handler: async (args, ctx) => {
    const managed = ctx.sessions.resolve(args.sessionId)
    const meta = { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id }
    const ms = clampWaitTimeout(args.ms)
    await new Promise((resolve) => setTimeout(resolve, ms))
    return makeSuccess({ session_id: managed.id, waited_ms: ms }, meta)
  },
})
