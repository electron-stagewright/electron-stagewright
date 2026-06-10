/**
 * `electron_expect_text` and `electron_expect_value` — assert the displayed text
 * (`textContent`) or the form-control value (`.value`) of an element matches a
 * predicate, retrying until it holds or the budget elapses (ADR-007 Principle 8).
 * One call replaces the get → compare → wait → re-get chain an agent runs today.
 *
 * @module
 */

import { z } from 'zod'

import { refField, selectorField, sessionIdField } from '../schema.js'
import { resolveTarget } from '../target.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { type WaitRaw, clampWaitTimeout, runWait } from '../wait/poll.js'
import { buildExpectTextBody } from './body.js'
import {
  describeStringMatch,
  expectTimeoutField,
  resolveStringMatch,
  stringPredicateFields,
} from './match.js'
import { expectBadArgument } from './run.js'

interface StringContentSpec {
  readonly name: string
  readonly title: string
  /** Which element property the body reads. */
  readonly source: 'text' | 'value'
  /** Subject word used in the description and the `expected` detail. */
  readonly subject: string
}

/** Build an `expect_text`-shaped tool over either `textContent` or `.value`. */
function makeStringContentExpect(spec: StringContentSpec): AnyToolDefinition {
  return defineTool({
    name: spec.name,
    title: spec.title,
    description: [
      `Assert the ${spec.subject} of the element identified by ref or selector matches a predicate,`,
      'polling until it holds or timeoutMs elapses. Provide exactly one of: equals, contains, regex,',
      'not_equals, not_contains. Optional flags (any of i, m, s, u) apply to regex; g and y are rejected',
      'as stateful. Returns: { ok, session_id, matched, actual }.',
      'Errors: EXPECTATION_FAILED (predicate not met within timeoutMs — details carry expected + actual;',
      'retryable), REF_NOT_FOUND (stale ref; carries similar_refs), TRANSPORT_UNSUPPORTED, NOT_RUNNING,',
      'BAD_ARGUMENT (no/multiple predicates, invalid regex or flags, or ref+selector both/neither).',
    ].join(' '),
    inputSchema: z.object({
      ref: refField,
      selector: selectorField,
      ...stringPredicateFields,
      timeoutMs: expectTimeoutField,
      sessionId: sessionIdField,
    }),
    operationType: 'query',
    handler: async (args, ctx) => {
      const resolved = resolveStringMatch(args)
      if (!resolved.ok) return expectBadArgument(ctx, args.sessionId, resolved.reason)
      const selector = resolveTarget(args)
      const timeoutMs = clampWaitTimeout(args.timeoutMs)
      return runWait(
        ctx,
        args,
        {
          body: buildExpectTextBody(),
          arg: { selector, source: spec.source, match: resolved.match, timeoutMs },
        },
        (raw: WaitRaw) => ({ matched: true, actual: raw['actual'] ?? null }),
        {
          timeoutMessage: `The ${spec.subject} did not match within ${timeoutMs}ms.`,
          timeoutCode: 'EXPECTATION_FAILED',
          buildTimeoutDetails: (raw: WaitRaw) => ({
            expected: describeStringMatch(resolved.match, spec.subject),
            actual: raw['actual'] ?? null,
          }),
        },
      )
    },
  })
}

/** `electron_expect_text` — assert an element's displayed text. */
export const expectTextTool: AnyToolDefinition = makeStringContentExpect({
  name: 'electron_expect_text',
  title: 'Expect element text',
  source: 'text',
  subject: 'text',
})

/** `electron_expect_value` — assert a form control's `.value`. */
export const expectValueTool: AnyToolDefinition = makeStringContentExpect({
  name: 'electron_expect_value',
  title: 'Expect form control value',
  source: 'value',
  subject: 'value',
})
