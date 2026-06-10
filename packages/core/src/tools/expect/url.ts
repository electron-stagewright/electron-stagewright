/**
 * `electron_expect_url` — assert the renderer's `location.href` satisfies a
 * predicate, polling until it does or the budget elapses (ADR-007 Principle 8).
 * The one-call way to verify navigation instead of reading + comparing the URL.
 *
 * @module
 */

import { z } from 'zod'

import { MAX_USER_REGEX_LENGTH, describeRegexSafety } from '../regex-safety.js'
import { sessionIdField } from '../schema.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { type WaitRaw, clampWaitTimeout, runWait } from '../wait/poll.js'
import { buildExpectUrlBody } from './body.js'
import { type StringMatch, describeStringMatch, expectTimeoutField } from './match.js'
import { expectBadArgument } from './run.js'

/** `electron_expect_url` — assert the active window URL contains / matches a value. */
export const expectUrlTool: AnyToolDefinition = defineTool({
  name: 'electron_expect_url',
  title: 'Expect the window URL',
  description: [
    "Assert the active window's URL (location.href) satisfies a predicate, polling until it does or",
    'timeoutMs elapses. Provide exactly one of: contains (substring) or matches (JavaScript regex).',
    'Returns: { ok, session_id, matched, actual }. Errors: EXPECTATION_FAILED (URL did not match within',
    'timeoutMs — details carry expected + actual; retryable), TRANSPORT_UNSUPPORTED, NOT_RUNNING,',
    'BAD_ARGUMENT (no/both predicates, or invalid regex).',
  ].join(' '),
  inputSchema: z.object({
    contains: z.string().optional().describe('The URL must contain this substring.'),
    matches: z
      .string()
      .max(MAX_USER_REGEX_LENGTH)
      .optional()
      .describe('The URL must match this JavaScript regular expression.'),
    timeoutMs: expectTimeoutField,
    sessionId: sessionIdField,
  }),
  operationType: 'query',
  handler: async (args, ctx) => {
    if ((args.contains === undefined) === (args.matches === undefined)) {
      return expectBadArgument(ctx, args.sessionId, 'Provide exactly one of contains or matches.')
    }
    let match: StringMatch
    if (args.contains !== undefined) {
      match = { kind: 'contains', value: args.contains }
    } else {
      const pattern = args.matches as string
      const unsafe = describeRegexSafety(pattern)
      if (unsafe !== null) {
        return expectBadArgument(ctx, args.sessionId, `Unsafe regular expression: ${unsafe}`)
      }
      try {
        new RegExp(pattern)
      } catch (err) {
        return expectBadArgument(
          ctx,
          args.sessionId,
          `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      match = { kind: 'regex', value: pattern }
    }
    const timeoutMs = clampWaitTimeout(args.timeoutMs)
    return runWait(
      ctx,
      { sessionId: args.sessionId },
      { body: buildExpectUrlBody(), arg: { match, timeoutMs } },
      (raw: WaitRaw) => ({ matched: true, actual: raw['actual'] ?? null }),
      {
        timeoutMessage: `The URL did not match within ${timeoutMs}ms.`,
        timeoutCode: 'EXPECTATION_FAILED',
        buildTimeoutDetails: (raw: WaitRaw) => ({
          expected: describeStringMatch(match, 'url'),
          actual: raw['actual'] ?? null,
        }),
      },
    )
  },
})
