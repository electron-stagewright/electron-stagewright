/**
 * Shared comparison helpers for the `expect_*` assertion family: the agent-facing
 * predicate schemas, server-side validation (so an invalid regex is rejected with
 * `BAD_ARGUMENT` before any renderer round-trip), the human-readable "expected"
 * descriptions surfaced in `EXPECTATION_FAILED` details, and the renderer-side
 * matcher snippets the poll bodies embed.
 *
 * @module
 */

import { z } from 'zod'

import { MAX_USER_REGEX_LENGTH, describeRegexSafety } from '../regex-safety.js'

/** A validated string-comparison predicate — exactly one variant is populated. */
export type StringMatch =
  | { readonly kind: 'equals'; readonly value: string }
  | { readonly kind: 'contains'; readonly value: string }
  | { readonly kind: 'regex'; readonly value: string }
  | { readonly kind: 'not_equals'; readonly value: string }
  | { readonly kind: 'not_contains'; readonly value: string }

/** Agent-facing string predicate fields; the tool requires exactly one to be set. */
export const stringPredicateFields = {
  equals: z.string().optional().describe('The text must equal this exactly.'),
  contains: z.string().optional().describe('The text must contain this substring.'),
  regex: z
    .string()
    .max(MAX_USER_REGEX_LENGTH)
    .optional()
    .describe('The text must match this JavaScript regular expression.'),
  not_equals: z.string().optional().describe('The text must NOT equal this.'),
  not_contains: z.string().optional().describe('The text must NOT contain this substring.'),
}

/** The five string-predicate keys, in precedence order for the "exactly one" check. */
const STRING_KEYS = ['equals', 'contains', 'regex', 'not_equals', 'not_contains'] as const

/** Optional-with-undefined values, matching what Zod infers for the predicate fields. */
type StringPredicateArgs = {
  readonly [K in (typeof STRING_KEYS)[number]]?: string | undefined
}

/** Outcome of {@link resolveStringMatch}: a validated predicate or a `BAD_ARGUMENT` reason. */
export type StringMatchResult =
  | { readonly ok: true; readonly match: StringMatch }
  | { readonly ok: false; readonly reason: string }

/**
 * Validate that exactly one string predicate is set and (for `regex`) that it
 * compiles. Returns the resolved {@link StringMatch} or a reason for `BAD_ARGUMENT`.
 */
export function resolveStringMatch(args: StringPredicateArgs): StringMatchResult {
  const present = STRING_KEYS.filter((k) => args[k] !== undefined)
  if (present.length === 0) {
    return {
      ok: false,
      reason: 'Provide one of equals, contains, regex, not_equals, not_contains.',
    }
  }
  if (present.length > 1) {
    return {
      ok: false,
      reason: `Provide exactly one predicate, not ${present.length} (${present.join(', ')}).`,
    }
  }
  const kind = present[0] as StringMatch['kind']
  const value = args[kind] as string
  if (kind === 'regex') {
    // Refuse a structurally-unsafe pattern (catastrophic backtracking) before it is sent to the
    // renderer matcher, where a single synchronous `.test()` cannot be time-bounded by the poll.
    const unsafe = describeRegexSafety(value)
    if (unsafe !== null) {
      return { ok: false, reason: `Unsafe regular expression: ${unsafe}` }
    }
    try {
      // Compile once here so a malformed pattern is BAD_ARGUMENT, not a silent
      // renderer-side non-match.
      new RegExp(value)
    } catch (err) {
      return {
        ok: false,
        reason: `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
  return { ok: true, match: { kind, value } }
}

/** Short human-readable description of a string predicate for `details.expected`. */
export function describeStringMatch(match: StringMatch, subject = 'text'): string {
  const verb: Record<StringMatch['kind'], string> = {
    equals: 'equals',
    contains: 'contains',
    regex: 'matches regex',
    not_equals: 'does not equal',
    not_contains: 'does not contain',
  }
  return `${subject} ${verb[match.kind]} ${JSON.stringify(match.value)}`
}

/**
 * Renderer matcher for a {@link StringMatch}. Defines `__swMatchString(actual, m)`
 * where `m` is `{ kind, value }`; returns a boolean. A malformed regex resolves to
 * `false` (the server already validated it, so this is defence-in-depth).
 */
export const STRING_MATCH_FN = `
function __swMatchString(actual, m) {
  const s = actual == null ? '' : String(actual);
  switch (m.kind) {
    case 'equals': return s === m.value;
    case 'not_equals': return s !== m.value;
    case 'contains': return s.indexOf(m.value) !== -1;
    case 'not_contains': return s.indexOf(m.value) === -1;
    case 'regex': try { return new RegExp(m.value).test(s); } catch (e) { return false; }
    default: return false;
  }
}`

/** A validated numeric-count predicate — at least one bound is populated. */
export interface CountMatch {
  readonly min?: number
  readonly max?: number
  readonly equals?: number
}

/** Agent-facing count predicate fields; the tool requires at least one. */
export const countPredicateFields = {
  equals: z.number().int().nonnegative().optional().describe('The match count must equal this.'),
  min: z.number().int().nonnegative().optional().describe('The match count must be >= this.'),
  max: z.number().int().nonnegative().optional().describe('The match count must be <= this.'),
}

/** Build a {@link CountMatch} from args, or a `BAD_ARGUMENT` reason when none is set. */
export function resolveCountMatch(args: {
  readonly equals?: number | undefined
  readonly min?: number | undefined
  readonly max?: number | undefined
}):
  | { readonly ok: true; readonly match: CountMatch }
  | { readonly ok: false; readonly reason: string } {
  if (args.equals === undefined && args.min === undefined && args.max === undefined) {
    return { ok: false, reason: 'Provide at least one of equals, min, max.' }
  }
  if (args.min !== undefined && args.max !== undefined && args.min > args.max) {
    return { ok: false, reason: 'min must be less than or equal to max.' }
  }
  if (args.equals !== undefined && args.min !== undefined && args.equals < args.min) {
    return { ok: false, reason: 'equals must be greater than or equal to min.' }
  }
  if (args.equals !== undefined && args.max !== undefined && args.equals > args.max) {
    return { ok: false, reason: 'equals must be less than or equal to max.' }
  }
  return {
    ok: true,
    match: {
      ...(args.equals !== undefined ? { equals: args.equals } : {}),
      ...(args.min !== undefined ? { min: args.min } : {}),
      ...(args.max !== undefined ? { max: args.max } : {}),
    },
  }
}

/** True when `count` satisfies every populated bound of `match`. */
export function countSatisfied(count: number, match: CountMatch): boolean {
  return (
    (match.equals === undefined || count === match.equals) &&
    (match.min === undefined || count >= match.min) &&
    (match.max === undefined || count <= match.max)
  )
}

/** Short description of a count predicate for `details.expected`. */
export function describeCount(match: CountMatch): string {
  const parts: string[] = []
  if (match.equals !== undefined) parts.push(`== ${match.equals}`)
  if (match.min !== undefined) parts.push(`>= ${match.min}`)
  if (match.max !== undefined) parts.push(`<= ${match.max}`)
  return `count ${parts.join(' and ')}`
}

/** Renderer matcher for a {@link CountMatch}. Defines `__swCountOk(count, m)`. */
export const COUNT_MATCH_FN = `
function __swCountOk(count, m) {
  return (m.equals === undefined || count === m.equals)
    && (m.min === undefined || count >= m.min)
    && (m.max === undefined || count <= m.max);
}`

/** Shared `timeoutMs` field for the assertion tools (poll budget). */
export const expectTimeoutField = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe(
    'Max poll time in ms before EXPECTATION_FAILED (default 5000, clamped to 60000). 0 = check once.',
  )
