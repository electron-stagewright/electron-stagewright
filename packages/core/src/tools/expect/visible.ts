/**
 * `electron_expect_visible` — assert an element becomes visible within a budget,
 * retrying until it holds or timing out (ADR-007 Principle 8). Thin assertion sugar
 * over the same visibility poll `wait_for_selector` uses, returning `{ matched }`
 * and failing as `EXPECTATION_FAILED` rather than a sync `WAIT_TIMEOUT`.
 *
 * @module
 */

import { z } from 'zod'

import { refField, selectorField, sessionIdField } from '../schema.js'
import { resolveTarget } from '../target.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { buildWaitForSelectorBody } from '../wait/body.js'
import { type WaitRaw, clampWaitTimeout, runWait } from '../wait/poll.js'
import { expectTimeoutField } from './match.js'

/** `electron_expect_visible` — assert an element is (or becomes) visible. */
export const expectVisibleTool: AnyToolDefinition = defineTool({
  name: 'electron_expect_visible',
  title: 'Expect an element visible',
  description: [
    'Assert the element identified by ref or selector is visible, polling until it is or timeoutMs',
    'elapses. Visible means attached, laid out, and not visibility:hidden. Returns: { ok, session_id, matched }.',
    'Errors: EXPECTATION_FAILED (not visible within timeoutMs; retryable), REF_NOT_FOUND (stale ref;',
    'carries similar_refs), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (invalid selector, or',
    'ref+selector both/neither).',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    timeoutMs: expectTimeoutField,
    sessionId: sessionIdField,
  }),
  operationType: 'query',
  handler: (args, ctx) => {
    const selector = resolveTarget(args)
    const timeoutMs = clampWaitTimeout(args.timeoutMs)
    return runWait(
      ctx,
      args,
      { body: buildWaitForSelectorBody(), arg: { selector, state: 'visible', timeoutMs } },
      (_raw: WaitRaw) => ({ matched: true }),
      {
        timeoutMessage: `Element did not become visible within ${timeoutMs}ms.`,
        timeoutCode: 'EXPECTATION_FAILED',
        buildTimeoutDetails: () => ({ expected: 'visible', actual: 'not visible' }),
      },
    )
  },
})
