/**
 * `electron_wait_for_event` — wait for a named DOM event to fire on a target
 * element (by `ref`/`selector`) or on `document` when no target is given. The
 * arbitrary-JS-predicate flavour of event waiting is intentionally NOT here — it
 * is an eval surface that belongs behind the eval opt-in flag.
 *
 * @module
 */

import { z } from 'zod'

import { refField, selectorField, sessionIdField } from '../schema.js'
import { resolveOptionalTarget } from '../target.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { buildWaitForEventBody } from './body.js'
import { type WaitRaw, clampWaitTimeout, runWait } from './poll.js'

const timeoutField = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe('Max wait in ms (default 5000, clamped to 60000).')

/** `electron_wait_for_event` — resolve when `eventName` fires on the target (or document). */
export const waitForEventTool: AnyToolDefinition = defineTool({
  name: 'electron_wait_for_event',
  title: 'Wait for a DOM event',
  description: [
    'Wait until a named DOM event (e.g. "transitionend", "load", a custom event) fires on the element',
    'identified by ref or selector — or on document when neither is given. Returns:',
    '{ ok, session_id, fired, event }. Errors: WAIT_TIMEOUT (event did not fire within timeoutMs;',
    'retryable), SELECTOR_NO_MATCH (target element not present), REF_NOT_FOUND (stale ref;',
    'carries similar_refs), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (invalid selector, or',
    'ref+selector both).',
  ].join(' '),
  inputSchema: z.object({
    eventName: z.string().min(1).describe('DOM event name to wait for, e.g. "transitionend".'),
    ref: refField,
    selector: selectorField,
    timeoutMs: timeoutField,
    sessionId: sessionIdField,
  }),
  operationType: 'query',
  handler: (args, ctx) => {
    const selector = resolveOptionalTarget(args)
    const timeoutMs = clampWaitTimeout(args.timeoutMs)
    return runWait(
      ctx,
      args,
      {
        body: buildWaitForEventBody(),
        arg: {
          eventName: args.eventName,
          ...(selector !== undefined ? { selector } : {}),
          timeoutMs,
        },
      },
      (_raw: WaitRaw) => ({ fired: true, event: args.eventName }),
      { timeoutMessage: `Event "${args.eventName}" did not fire within ${timeoutMs}ms.` },
    )
  },
})
