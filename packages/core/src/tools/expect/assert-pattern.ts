/**
 * `electron_assert_pattern` — a one-shot (no-retry) validation that an element's
 * text or a named attribute matches a pattern (ADR-007 Principle 8, the
 * non-polling sibling of `expect_text`). Replaces the `eval_renderer` snippet an
 * agent would otherwise write to read-and-regex an attribute.
 *
 * @module
 */

import { z } from 'zod'

import { MAX_USER_REGEX_LENGTH, describeRegexSafety } from '../regex-safety.js'
import { refField, selectorField, sessionIdField } from '../schema.js'
import { resolveTarget } from '../target.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { type WaitRaw, runWait } from '../wait/poll.js'
import { buildExpectTextBody } from './body.js'
import {
  type StringMatch,
  describeRegexFlags,
  describeStringMatch,
  regexFlagsField,
} from './match.js'
import { expectBadArgument } from './run.js'

/** Resolve the single string predicate (`equals` | `contains` | `matches_regex`) or a reason. */
function resolvePatternMatch(args: {
  readonly equals?: string | undefined
  readonly contains?: string | undefined
  readonly matches_regex?: string | undefined
  readonly flags?: string | undefined
}):
  | { readonly ok: true; readonly match: StringMatch }
  | { readonly ok: false; readonly reason: string } {
  const present = [
    args.equals !== undefined ? 'equals' : null,
    args.contains !== undefined ? 'contains' : null,
    args.matches_regex !== undefined ? 'matches_regex' : null,
  ].filter((v): v is string => v !== null)
  if (present.length !== 1) {
    return { ok: false, reason: 'Provide exactly one of equals, contains, matches_regex.' }
  }
  // flags only refines a regex; reject it on equals/contains rather than silently ignoring it.
  if (args.matches_regex === undefined && args.flags !== undefined) {
    return { ok: false, reason: 'flags is only valid with matches_regex.' }
  }
  if (args.equals !== undefined) return { ok: true, match: { kind: 'equals', value: args.equals } }
  if (args.contains !== undefined)
    return { ok: true, match: { kind: 'contains', value: args.contains } }
  const pattern = args.matches_regex as string
  if (args.flags !== undefined) {
    const badFlag = describeRegexFlags(args.flags)
    if (badFlag !== null) {
      return { ok: false, reason: `Invalid regex flags: ${badFlag}.` }
    }
  }
  const unsafe = describeRegexSafety(pattern)
  if (unsafe !== null) {
    return { ok: false, reason: `Unsafe regular expression: ${unsafe}` }
  }
  try {
    new RegExp(pattern, args.flags)
  } catch (err) {
    return {
      ok: false,
      reason: `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  return {
    ok: true,
    match: {
      kind: 'regex',
      value: pattern,
      ...(args.flags !== undefined ? { flags: args.flags } : {}),
    },
  }
}

/** `electron_assert_pattern` — validate text or an attribute against a pattern, once. */
export const assertPatternTool: AnyToolDefinition = defineTool({
  name: 'electron_assert_pattern',
  title: 'Assert a text or attribute pattern',
  description: [
    "Validate, in a single check (no polling), that an element's text or a named attribute matches a",
    'pattern. Target by ref or selector. With `attribute` set, reads that attribute; otherwise reads the',
    "element's trimmed text. Provide exactly one of: equals, contains, matches_regex.",
    'Optional flags (any of i, m, s, u) apply to matches_regex; g and y are rejected as stateful.',
    'Returns: { ok, session_id, matched, actual }. Errors: EXPECTATION_FAILED (element found but its value',
    'did not match the pattern — details carry expected + actual; a missing attribute reads as actual: null),',
    'SELECTOR_NO_MATCH (no element matched — this is one-shot, so a missing element is a precondition failure,',
    'not a retry; carries similar_refs), REF_NOT_FOUND (stale ref), TRANSPORT_UNSUPPORTED, NOT_RUNNING,',
    'BAD_ARGUMENT (no/multiple predicates, invalid regex or flags, or ref+selector both/neither).',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    attribute: z
      .string()
      .min(1)
      .optional()
      .describe('Attribute name to read (e.g. "value", "aria-label"). Omit to read text.'),
    equals: z.string().optional().describe('The value must equal this exactly.'),
    contains: z.string().optional().describe('The value must contain this substring.'),
    matches_regex: z
      .string()
      .max(MAX_USER_REGEX_LENGTH)
      .optional()
      .describe('The value must match this JavaScript regular expression.'),
    flags: regexFlagsField,
    sessionId: sessionIdField,
  }),
  operationType: 'query',
  handler: async (args, ctx) => {
    const resolved = resolvePatternMatch(args)
    if (!resolved.ok) return expectBadArgument(ctx, args.sessionId, resolved.reason)
    const selector = resolveTarget(args)
    const subject =
      args.attribute !== undefined ? `attribute ${JSON.stringify(args.attribute)}` : 'text'
    // One-shot: timeoutMs 0 makes the poll body check exactly once.
    return runWait(
      ctx,
      args,
      {
        body: buildExpectTextBody(),
        arg: {
          selector,
          source: args.attribute !== undefined ? 'attribute' : 'text',
          ...(args.attribute !== undefined ? { attribute: args.attribute } : {}),
          match: resolved.match,
          timeoutMs: 0,
          // One-shot: a missing element is a precondition failure (SELECTOR_NO_MATCH),
          // not a retryable value mismatch.
          missAsError: true,
        },
      },
      (raw: WaitRaw) => ({ matched: true, actual: raw['actual'] ?? null }),
      {
        timeoutMessage: `The ${subject} did not match the pattern.`,
        timeoutCode: 'EXPECTATION_FAILED',
        buildTimeoutDetails: (raw: WaitRaw) => ({
          expected: describeStringMatch(resolved.match, subject),
          actual: raw['actual'] ?? null,
        }),
      },
    )
  },
})
