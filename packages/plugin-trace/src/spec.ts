/**
 * Promoted replay specifications (ADR-009).
 *
 * A raw trace is diagnostic evidence. This module promotes its calls into a compact, reviewable
 * specification and evaluates explicit checkpoints. The promoted file deliberately keeps only
 * tool args and declared expectations: it never copies arbitrary recorded result payloads.
 *
 * @module
 */

import type { ToolResult } from '@electron-stagewright/core'
import { z } from 'zod'

import type { TraceCallRecord } from './recorder.js'

export const REPLAY_SPEC_FORMAT = 'stagewright-replay' as const
export const REPLAY_SPEC_VERSION = 1 as const
const SESSION_TOKEN_PREFIX = '$stagewright.session.'
const REDACTED = '[redacted]'
const MAX_REPORT_VALUE_CHARS = 1000
const MAX_REGEX_SOURCE_CHARS = 512
const DEFAULT_PROMOTION_REDACTIONS = [
  'args.password',
  'args.token',
  'args.authorization',
  'args.headers.authorization',
  'args.headers.cookie',
] as const

const normalizerSchema = z.enum(['session_id', 'timestamps', 'absolute_paths'])
const matcherSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('ignore') }).strict(),
  z
    .object({
      mode: z.literal('exact'),
      value: z.unknown(),
      numericTolerance: z.number().min(0).optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('subset'),
      value: z.unknown(),
      numericTolerance: z.number().min(0).optional(),
    })
    .strict(),
  z.object({ mode: z.literal('regex'), value: z.string().max(512) }).strict(),
])

const stepSchema = z
  .object({
    tool: z.string().min(1),
    args: z.unknown(),
    captureSession: z
      .string()
      .regex(/^\$stagewright\.session\.[1-9]\d*$/)
      .optional(),
    expect: z
      .object({ ok: z.boolean().optional(), result: matcherSchema.optional() })
      .strict()
      .refine((value) => value.ok !== undefined || value.result !== undefined, {
        message: 'expect must declare ok or result',
      }),
  })
  .strict()

const replaySpecSchema = z
  .object({
    format: z.literal(REPLAY_SPEC_FORMAT),
    version: z.literal(REPLAY_SPEC_VERSION),
    app: z
      .object({ main: z.string().min(1) })
      .strict()
      .optional(),
    normalizers: z.array(normalizerSchema).default([]),
    redactions: z.array(z.string().min(1)).default([]),
    steps: z.array(stepSchema),
  })
  .strict()

export type ReplayNormalizer = z.infer<typeof normalizerSchema>
export type ReplayMatcher = z.infer<typeof matcherSchema>
export type ReplayStep = z.infer<typeof stepSchema>
export type ReplaySpec = z.infer<typeof replaySpecSchema>

export interface PromoteTraceOptions {
  readonly redactions?: readonly string[]
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
}

export interface ReplaySpecDeps {
  readonly dispatch: (tool: string, args: unknown) => Promise<ToolResult>
}

export interface ReplaySpecOptions {
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
}

export interface ReplaySpecOutcome {
  readonly step: number
  readonly tool: string
  readonly matched: boolean
  readonly matcher: 'ok' | ReplayMatcher['mode']
  readonly expected: unknown
  readonly actual: unknown
  readonly message?: string
}

export interface ReplaySpecReport {
  readonly passed: boolean
  readonly matched: number
  readonly mismatched: number
  readonly skipped: number
  readonly steps: readonly ReplaySpecOutcome[]
}

/** Validate an untrusted JSON value as a promoted replay specification. */
export function parseReplaySpec(value: unknown): ReplaySpec {
  const parsed = replaySpecSchema.safeParse(value)
  if (parsed.success) return parsed.data
  throw new Error(`Invalid replay spec: ${parsed.error.issues[0]?.message ?? 'unknown error'}`)
}

/** Promote raw calls into a reviewable spec with stable session placeholders and pre-write redaction. */
export function promoteTrace(
  calls: readonly TraceCallRecord[],
  options: PromoteTraceOptions = {},
): ReplaySpec {
  const include = options.include === undefined ? undefined : new Set(options.include)
  const exclude = options.exclude === undefined ? undefined : new Set(options.exclude)
  const redactions = [...new Set([...DEFAULT_PROMOTION_REDACTIONS, ...(options.redactions ?? [])])]
  const aliases = new Map<string, string>()
  let nextAlias = 1
  const steps: ReplayStep[] = []

  // A filtered spec must still launch/attach every session its selected calls address. Keep the
  // original producer in order rather than leaving a recorded session id that a fresh run cannot
  // resolve. This also closes dependencies for a producer that itself uses another session.
  const selectedCalls = selectCallsWithSessionProducers(calls, include, exclude)
  for (const call of selectedCalls) {
    const args = replaceSessionIds(redactScopedValue(call.args, redactions, 'args'), aliases)
    const recordedSession = sessionIdOf(call.result)
    let captureSession: string | undefined
    if (recordedSession !== undefined && !aliases.has(recordedSession)) {
      captureSession = `${SESSION_TOKEN_PREFIX}${nextAlias}`
      aliases.set(recordedSession, captureSession)
      nextAlias += 1
    }
    steps.push({
      tool: call.tool,
      args,
      expect: { ok: call.ok },
      ...(captureSession !== undefined ? { captureSession } : {}),
    })
  }

  const launch = selectedCalls.find((call) => call.tool === 'electron_launch')
  const main = launch === undefined ? undefined : mainOf(launch.args)
  return {
    format: REPLAY_SPEC_FORMAT,
    version: REPLAY_SPEC_VERSION,
    ...(main !== undefined ? { app: { main } } : {}),
    normalizers: ['session_id', 'timestamps', 'absolute_paths'],
    redactions,
    steps,
  }
}

/** Select requested calls and close over any earlier call that produced a session they address. */
function selectCallsWithSessionProducers(
  calls: readonly TraceCallRecord[],
  include: ReadonlySet<string> | undefined,
  exclude: ReadonlySet<string> | undefined,
): readonly TraceCallRecord[] {
  const producerIndexes = new Map<string, number>()
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]
    if (call === undefined) continue
    const session = sessionIdOf(call.result)
    if (session !== undefined && !producerIndexes.has(session)) producerIndexes.set(session, index)
  }

  const selected = new Set<number>()
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]
    if (call === undefined) continue
    if ((include === undefined || include.has(call.tool)) && exclude?.has(call.tool) !== true) {
      selected.add(index)
    }
  }

  let addedProducer = true
  while (addedProducer) {
    addedProducer = false
    for (const index of selected) {
      const call = calls[index]
      if (call === undefined) continue
      for (const session of sessionReferences(call.args, producerIndexes)) {
        const producer = producerIndexes.get(session)
        if (producer !== undefined && !selected.has(producer)) {
          selected.add(producer)
          addedProducer = true
        }
      }
    }
  }
  return calls.filter((_, index) => selected.has(index))
}

/** Return only values known to have been produced as session ids in this trace. */
function sessionReferences(
  value: unknown,
  knownSessions: ReadonlyMap<string, number>,
): readonly string[] {
  if (typeof value === 'string') return knownSessions.has(value) ? [value] : []
  if (Array.isArray(value)) return value.flatMap((item) => sessionReferences(item, knownSessions))
  if (!isObject(value)) return []
  return Object.values(value).flatMap((child) => sessionReferences(child, knownSessions))
}

/** Render a promoted spec as canonical, review-friendly JSON. */
export function serializeReplaySpec(spec: ReplaySpec): string {
  return `${JSON.stringify(parseReplaySpec(spec), null, 2)}\n`
}

/** Execute explicit checkpoints in a replay specification through an injected dispatcher. */
export async function replaySpec(
  input: ReplaySpec,
  deps: ReplaySpecDeps,
  options: ReplaySpecOptions = {},
): Promise<ReplaySpecReport> {
  const spec = parseReplaySpec(input)
  const include = options.include === undefined ? undefined : new Set(options.include)
  const exclude = options.exclude === undefined ? undefined : new Set(options.exclude)
  const sessions = new Map<string, string>()
  const outcomes: ReplaySpecOutcome[] = []
  let matched = 0
  let mismatched = 0
  let skipped = 0

  for (let index = 0; index < spec.steps.length; index += 1) {
    const step = spec.steps[index]
    if (step === undefined) continue
    if ((include !== undefined && !include.has(step.tool)) || exclude?.has(step.tool) === true) {
      skipped += 1
      continue
    }
    const result = await deps.dispatch(step.tool, resolveSessionTokens(step.args, sessions))
    const normalized = normalizeValue(result, new Set(spec.normalizers))
    if (step.captureSession !== undefined) {
      const session = sessionIdOf(result)
      if (session !== undefined) sessions.set(step.captureSession, session)
    }
    const outcome = evaluateStep(step, normalized, spec.redactions, index)
    outcomes.push(outcome)
    if (outcome.matched) matched += 1
    else mismatched += 1
  }
  return { passed: mismatched === 0, matched, mismatched, skipped, steps: outcomes }
}

function evaluateStep(
  step: ReplayStep,
  result: unknown,
  redactions: readonly string[],
  index: number,
): ReplaySpecOutcome {
  const redact = (value: unknown) => redactScopedValue(value, redactions, 'result')
  if (step.expect.ok !== undefined && okOf(result) !== step.expect.ok) {
    return {
      step: index,
      tool: step.tool,
      matched: false,
      matcher: 'ok',
      expected: step.expect.ok,
      actual: capValue(redact(result)),
      message: `expected ok=${String(step.expect.ok)}`,
    }
  }
  const matcher = step.expect.result
  if (matcher === undefined || matcher.mode === 'ignore') {
    return {
      step: index,
      tool: step.tool,
      matched: true,
      matcher: matcher?.mode ?? 'ok',
      expected: matcher?.mode === 'ignore' ? 'ignored' : step.expect.ok,
      actual: matcher?.mode === 'ignore' ? 'ignored' : okOf(result),
    }
  }
  const actual = redact(result)
  const expected = redact(matcher.value)
  const matched = matches(actual, expected, matcher)
  return {
    step: index,
    tool: step.tool,
    matched,
    matcher: matcher.mode,
    expected: capValue(expected),
    actual: capValue(actual),
    ...(matched ? {} : { message: `${matcher.mode} matcher did not match` }),
  }
}

function matches(actual: unknown, expected: unknown, matcher: ReplayMatcher): boolean {
  if (matcher.mode === 'regex') {
    const text = typeof actual === 'string' ? actual : JSON.stringify(actual)
    if (text === undefined || !isSafeRegex(matcher.value)) return false
    try {
      return new RegExp(matcher.value, 'u').test(text.slice(0, MAX_REPORT_VALUE_CHARS))
    } catch {
      return false
    }
  }
  if (matcher.mode === 'subset') return matchesSubset(actual, expected, matcher.numericTolerance)
  if (matcher.mode === 'exact') return matchesExact(actual, expected, matcher.numericTolerance)
  return false
}

function matchesExact(actual: unknown, expected: unknown, tolerance: number | undefined): boolean {
  if (typeof actual === 'number' && typeof expected === 'number') {
    return tolerance === undefined
      ? Object.is(actual, expected)
      : Math.abs(actual - expected) <= tolerance
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return (
      actual.length === expected.length &&
      actual.every((value, index) => matchesExact(value, expected[index], tolerance))
    )
  }
  if (isObject(actual) && isObject(expected)) {
    const actualKeys = Object.keys(actual)
    const expectedKeys = Object.keys(expected)
    return (
      actualKeys.length === expectedKeys.length &&
      expectedKeys.every((key) => matchesExact(actual[key], expected[key], tolerance))
    )
  }
  return Object.is(actual, expected)
}

function matchesSubset(actual: unknown, expected: unknown, tolerance: number | undefined): boolean {
  if (!isObject(actual) || !isObject(expected)) return matchesExact(actual, expected, tolerance)
  return Object.keys(expected).every(
    (key) => key in actual && matchesSubset(actual[key], expected[key], tolerance),
  )
}

function normalizeValue(value: unknown, normalizers: ReadonlySet<ReplayNormalizer>): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, normalizers))
  if (!isObject(value)) return value
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, child] of Object.entries(value)) {
    if (normalizers.has('session_id') && (key === 'session_id' || key === 'sessionId')) continue
    if (normalizers.has('timestamps') && /(?:^|_)(?:at|time|timestamp|ms)$/.test(key)) continue
    if (
      normalizers.has('absolute_paths') &&
      /(?:path|file|main)$/i.test(key) &&
      isAbsolutePath(child)
    ) {
      out[key] = '<absolute-path>'
      continue
    }
    out[key] = normalizeValue(child, normalizers)
  }
  return out
}

function redactScopedValue(
  value: unknown,
  rules: readonly string[],
  scope: 'args' | 'result',
): unknown {
  let current = clone(value)
  for (const rule of rules) {
    const parts = rule.split('.').filter((part) => part.length > 0)
    if (parts[0] !== scope) continue
    current = redactPath(current, parts.slice(1))
  }
  return current
}

function redactPath(value: unknown, parts: readonly string[]): unknown {
  if (parts.length === 0) return REDACTED
  if (!isObject(value)) return value
  const [head, ...tail] = parts
  if (head === undefined || !(head in value)) return value
  return { ...value, [head]: redactPath(value[head], tail) }
}

function replaceSessionIds(value: unknown, aliases: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return aliases.get(value) ?? value
  if (Array.isArray(value)) return value.map((item) => replaceSessionIds(item, aliases))
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, replaceSessionIds(child, aliases)]),
  )
}

function resolveSessionTokens(value: unknown, sessions: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return sessions.get(value) ?? value
  if (Array.isArray(value)) return value.map((item) => resolveSessionTokens(item, sessions))
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, resolveSessionTokens(child, sessions)]),
  )
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone)
  if (!isObject(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]))
}

function capValue(value: unknown): unknown {
  const json = JSON.stringify(value)
  if (json === undefined || json.length <= MAX_REPORT_VALUE_CHARS) return value
  return `${json.slice(0, MAX_REPORT_VALUE_CHARS)}…[truncated ${json.length} chars]`
}

function sessionIdOf(value: unknown): string | undefined {
  if (!isObject(value)) return undefined
  const meta = value['_meta']
  if (isObject(meta) && typeof meta['session_id'] === 'string') return meta['session_id']
  return typeof value['session_id'] === 'string' ? value['session_id'] : undefined
}

function mainOf(value: unknown): string | undefined {
  return isObject(value) && typeof value['main'] === 'string' ? value['main'] : undefined
}

function okOf(value: unknown): boolean {
  return isObject(value) && value['ok'] === true
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isAbsolutePath(value: unknown): boolean {
  return typeof value === 'string' && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value))
}

/** Conservative replay-spec regex guard: reject oversized and nested-quantifier patterns. */
function isSafeRegex(source: string): boolean {
  if (source.length > MAX_REGEX_SOURCE_CHARS) return false
  // The standard catastrophic shape is a quantified group whose body already repeats, such as
  // `(a+)+` or `([a-z]*){2,}`. Rejecting it keeps a committed spec from freezing a headless run.
  return !/\((?:\\.|[^()])*[*+](?:\\.|[^()])*\)[*+{]/u.test(source)
}
