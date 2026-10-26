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
/** Version for a spec that declares parameters (ADR-026 amendment); v1 runners refuse it. */
export const REPLAY_SPEC_PARAMETERIZED_VERSION = 2 as const
const PARAM_KEY = '$param'
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
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

const parameterCommon = {
  description: z.string().max(500).optional(),
  sensitive: z.boolean().optional(),
}
const boundsSchema = { minimum: z.number().optional(), maximum: z.number().optional() }
export const replayParameterSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('string'),
      ...parameterCommon,
      default: z.string().optional(),
      enum: z.array(z.string()).min(1).optional(),
      pattern: z.string().min(1).max(MAX_REGEX_SOURCE_CHARS).optional(),
      minLength: z.number().int().min(0).optional(),
      maxLength: z.number().int().min(0).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('number'),
      ...parameterCommon,
      ...boundsSchema,
      default: z.number().optional(),
      enum: z.array(z.number()).min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('integer'),
      ...parameterCommon,
      ...boundsSchema,
      default: z.number().int().optional(),
      enum: z.array(z.number().int()).min(1).optional(),
    })
    .strict(),
  z
    .object({ type: z.literal('boolean'), ...parameterCommon, default: z.boolean().optional() })
    .strict(),
  z
    .object({ type: z.literal('path'), ...parameterCommon, default: z.string().optional() })
    .strict(),
])

const specBody = {
  format: z.literal(REPLAY_SPEC_FORMAT),
  app: z
    .object({ main: z.string().min(1) })
    .strict()
    .optional(),
  normalizers: z.array(normalizerSchema).default([]),
  redactions: z.array(z.string().min(1)).default([]),
  steps: z.array(stepSchema),
}
const replaySpecV1Schema = z
  .object({ ...specBody, version: z.literal(REPLAY_SPEC_VERSION) })
  .strict()
const replaySpecV2Schema = z
  .object({
    ...specBody,
    version: z.literal(REPLAY_SPEC_PARAMETERIZED_VERSION),
    parameters: z
      .record(
        z.string().regex(PARAM_NAME, 'parameter names are letters, digits and _'),
        replayParameterSchema,
      )
      .refine((value) => Object.keys(value).length > 0, {
        message: 'a version 2 spec declares at least one parameter',
      }),
  })
  .strict()

export type ReplayNormalizer = z.infer<typeof normalizerSchema>
export type ReplayMatcher = z.infer<typeof matcherSchema>
export type ReplayStep = z.infer<typeof stepSchema>
export type ReplayParameter = z.infer<typeof replayParameterSchema>
export type ReplaySpec = z.infer<typeof replaySpecV1Schema> | z.infer<typeof replaySpecV2Schema>

/**
 * A parameter problem found before the first dispatch: `spec` when the spec itself is wrong (an
 * undeclared or unused parameter, an invalid default), `value` when a supplied value is.
 */
export class ReplayParameterError extends Error {
  constructor(
    readonly kind: 'spec' | 'value',
    message: string,
  ) {
    super(message)
    this.name = 'ReplayParameterError'
  }
}

/** A spec with every placeholder replaced, plus the values used and which ones to redact. */
export interface PreparedReplaySpec {
  readonly spec: ReplaySpec
  readonly parameters: Readonly<Record<string, unknown>>
  /** The values safe to print: sensitive parameters are replaced by name, not by searching. */
  readonly reportedParameters: Readonly<Record<string, unknown>>
  readonly sensitiveValues: readonly (string | number)[]
}

export interface PromoteTraceOptions {
  readonly redactions?: readonly string[]
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
  /**
   * Turn recorded argument values into parameters: every argument exactly equal to `value` becomes
   * a placeholder, and the spec declares the parameter with `value` as its default (none when
   * sensitive). A parameter whose value matches no argument is an error.
   */
  readonly parameters?: Readonly<
    Record<
      string,
      { readonly definition: ReplayParameter; readonly value: string | number | boolean }
    >
  >
}

/** A promoted spec and how many argument values each parameter replaced. */
export interface PromotedReplaySpec {
  readonly spec: ReplaySpec
  readonly replaced: Readonly<Record<string, number>>
}

export interface ReplaySpecDeps {
  readonly dispatch: (tool: string, args: unknown) => Promise<ToolResult>
}

export interface ReplaySpecOptions {
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
  /** Values for a version 2 spec's parameters; strings are coerced to the declared type. */
  readonly parameters?: Readonly<Record<string, unknown>>
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
  /** The values a parameterized spec ran with; sensitive ones are redacted. */
  readonly parameters?: Readonly<Record<string, unknown>>
}

/** Validate an untrusted JSON value as a promoted replay specification. */
export function parseReplaySpec(value: unknown): ReplaySpec {
  // Validate against the declared version's schema so errors name the actual problem.
  const version =
    typeof value === 'object' && value !== null
      ? (value as { version?: unknown }).version
      : undefined
  const parsed = (
    version === REPLAY_SPEC_PARAMETERIZED_VERSION ? replaySpecV2Schema : replaySpecV1Schema
  ).safeParse(value)
  if (parsed.success) return parsed.data
  throw new Error(`Invalid replay spec: ${describeIssue(parsed.error.issues[0])}`)
}

/** The innermost message of a zod issue, prefixed with its path (record keys nest their issue). */
function describeIssue(issue: z.core.$ZodIssue | undefined): string {
  if (issue === undefined) return 'unknown error'
  const nested = 'issues' in issue && Array.isArray(issue.issues) ? issue.issues[0] : undefined
  const where = issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
  return `${where}${nested !== undefined ? describeIssue(nested as z.core.$ZodIssue) : issue.message}`
}

/** Promote raw calls into a reviewable spec with stable session placeholders and pre-write redaction. */
export function promoteTrace(
  calls: readonly TraceCallRecord[],
  options: PromoteTraceOptions = {},
): ReplaySpec {
  return promoteTraceWithParameters(calls, options).spec
}

/** {@link promoteTrace}, also reporting how many values each requested parameter replaced. */
export function promoteTraceWithParameters(
  calls: readonly TraceCallRecord[],
  options: PromoteTraceOptions = {},
): PromotedReplaySpec {
  const parameters = Object.entries(options.parameters ?? {})
  const replaced: Record<string, number> = {}
  for (const [name, { definition, value }] of parameters) {
    if (!PARAM_NAME.test(name)) {
      throw new ReplayParameterError(
        'spec',
        `Parameter name "${name}" must be letters, digits and _.`,
      )
    }
    const problem = checkParameterValue(definition, value)
    if (problem !== undefined) {
      throw new ReplayParameterError('spec', `Parameter "${name}" value ${problem}.`)
    }
    replaced[name] = 0
  }
  // A recorded session id becomes a session placeholder below; never a parameter.
  const sessionIds = new Set(calls.map((recorded) => sessionIdOf(recorded.result)))
  const redactedParameters = new Set<string>()
  const parameterize = (value: unknown): unknown => {
    if (typeof value === 'string' && sessionIds.has(value)) return value
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const match = parameters.find(([, parameter]) => parameter.value === value)
      if (match === undefined) return value
      replaced[match[0]] = (replaced[match[0]] ?? 0) + 1
      return { [PARAM_KEY]: match[0] }
    }
    if (Array.isArray(value)) return value.map(parameterize)
    if (!isObject(value)) return value
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, parameterize(child)]),
    )
  }
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
    const args = replaceSessionIds(
      redactScopedValue(
        parameters.length > 0 ? parameterize(call.args) : call.args,
        redactions,
        'args',
        (name) => redactedParameters.add(name),
      ),
      aliases,
    )
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

  for (const name of redactedParameters) {
    if (options.parameters?.[name]?.definition.sensitive !== true) {
      throw new ReplayParameterError(
        'spec',
        `Parameter "${name}" replaces a redacted argument; declare it sensitive so its value is not written as a default.`,
      )
    }
  }
  for (const [name, count] of Object.entries(replaced)) {
    if (count === 0) {
      throw new ReplayParameterError(
        'spec',
        `Parameter "${name}" matched no recorded argument value.`,
      )
    }
  }
  const launch = steps.find((step) => step.tool === 'electron_launch')
  const main = launch === undefined ? undefined : mainOf(launch.args)
  const body = {
    format: REPLAY_SPEC_FORMAT,
    ...(main !== undefined ? { app: { main } } : {}),
    normalizers: ['session_id', 'timestamps', 'absolute_paths'] as ReplayNormalizer[],
    redactions,
    steps,
  }
  if (parameters.length === 0) return { spec: { ...body, version: REPLAY_SPEC_VERSION }, replaced }
  return {
    spec: {
      ...body,
      version: REPLAY_SPEC_PARAMETERIZED_VERSION,
      parameters: Object.fromEntries(
        parameters.map(([name, { definition, value }]) => [
          name,
          definition.sensitive === true
            ? withoutDefault(definition)
            : { ...definition, default: value },
        ]),
      ) as Record<string, ReplayParameter>,
    },
    replaced,
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
  return runPreparedReplaySpec(
    prepareReplaySpec(parseReplaySpec(input), options.parameters ?? {}),
    deps,
    options,
  )
}

/** Run a spec {@link prepareReplaySpec} already validated and substituted. */
export async function runPreparedReplaySpec(
  prepared: PreparedReplaySpec,
  deps: ReplaySpecDeps,
  options: Omit<ReplaySpecOptions, 'parameters'> = {},
): Promise<ReplaySpecReport> {
  const spec = prepared.spec
  const hide = (value: unknown) => redactValues(value, prepared.sensitiveValues)
  const include = options.include === undefined ? undefined : new Set(options.include)
  const exclude = options.exclude === undefined ? undefined : new Set(options.exclude)
  const executableSteps = selectStepsWithSessionProducers(spec.steps, include, exclude)
  const sessions = new Map<string, string>()
  const outcomes: ReplaySpecOutcome[] = []
  let matched = 0
  let mismatched = 0
  let skipped = 0

  for (let index = 0; index < spec.steps.length; index += 1) {
    const step = spec.steps[index]
    if (step === undefined) continue
    if (!executableSteps.has(index)) {
      skipped += 1
      continue
    }
    const result = await deps.dispatch(step.tool, resolveSessionTokens(step.args, sessions))
    const normalized = normalizeValue(result, new Set(spec.normalizers))
    if (step.captureSession !== undefined) {
      const session = sessionIdOf(result)
      if (session !== undefined) sessions.set(step.captureSession, session)
    }
    const evaluated = evaluateStep(step, normalized, spec.redactions, index)
    const outcome = {
      ...evaluated,
      expected: capValue(hide(evaluated.expected)),
      actual: capValue(hide(evaluated.actual)),
    }
    outcomes.push(outcome)
    if (outcome.matched) matched += 1
    else mismatched += 1
  }
  return {
    passed: mismatched === 0,
    matched,
    mismatched,
    skipped,
    steps: outcomes,
    ...(spec.version === REPLAY_SPEC_PARAMETERIZED_VERSION
      ? { parameters: prepared.reportedParameters }
      : {}),
  }
}

/**
 * Validate a spec's parameters and the supplied values, then replace every placeholder. Throws
 * {@link ReplayParameterError} before anything runs: an undeclared, unused or malformed
 * placeholder, an invalid default, or an unknown, missing or invalid supplied value.
 */
export function prepareReplaySpec(
  spec: ReplaySpec,
  supplied: Readonly<Record<string, unknown>>,
): PreparedReplaySpec {
  const declared: Readonly<Record<string, ReplayParameter>> =
    spec.version === REPLAY_SPEC_PARAMETERIZED_VERSION ? spec.parameters : {}
  const used = new Set<string>()
  for (const [index, step] of spec.steps.entries()) {
    const where = `step ${index + 1} (${step.tool})`
    for (const name of placeholdersIn(step.args, `${where} args`)) used.add(name)
    const matcher = step.expect.result
    if (matcher?.mode === 'exact' || matcher?.mode === 'subset') {
      for (const name of placeholdersIn(matcher.value, `${where} expect`)) used.add(name)
    }
  }
  if (spec.version === REPLAY_SPEC_VERSION && used.size > 0) {
    throw new ReplayParameterError(
      'spec',
      'Placeholders need a version 2 spec that declares parameters.',
    )
  }
  for (const name of used) {
    if (!Object.hasOwn(declared, name)) {
      throw new ReplayParameterError('spec', `Placeholder "${name}" has no declared parameter.`)
    }
  }
  for (const [name, definition] of Object.entries(declared)) {
    if (!used.has(name)) {
      throw new ReplayParameterError('spec', `Parameter "${name}" is declared but no step uses it.`)
    }
    if (
      definition.type === 'string' &&
      definition.pattern !== undefined &&
      !isSafeRegex(definition.pattern)
    ) {
      throw new ReplayParameterError('spec', `Parameter "${name}" has an unsafe pattern.`)
    }
    if (definition.default !== undefined) {
      const problem = checkParameterValue(definition, definition.default)
      if (problem !== undefined) {
        throw new ReplayParameterError('spec', `Parameter "${name}" default ${problem}.`)
      }
    }
  }

  for (const name of Object.keys(supplied)) {
    if (!Object.hasOwn(declared, name)) {
      throw new ReplayParameterError(
        'value',
        `Unknown parameter "${name}"; the spec declares ${
          Object.keys(declared).join(', ') || 'none'
        }.`,
      )
    }
  }
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const reportedParameters: Record<string, unknown> = {}
  const sensitiveValues: (string | number)[] = []
  for (const [name, definition] of Object.entries(declared)) {
    const raw = Object.hasOwn(supplied, name) ? supplied[name] : definition.default
    if (raw === undefined) {
      throw new ReplayParameterError('value', `Missing a value for parameter "${name}".`)
    }
    const value = coerceParameterValue(definition, raw)
    const problem = checkParameterValue(definition, value)
    if (problem !== undefined) {
      throw new ReplayParameterError('value', `Parameter "${name}" ${problem}.`)
    }
    values[name] = value
    reportedParameters[name] = definition.sensitive === true ? REDACTED : value
    if (definition.sensitive === true && (typeof value === 'string' || typeof value === 'number')) {
      sensitiveValues.push(value)
    }
  }

  const substitute = (value: unknown): unknown => substitutePlaceholders(value, values)
  return {
    spec: {
      ...spec,
      steps: spec.steps.map((step) => ({
        ...step,
        args: substitute(step.args),
        expect: substituteExpect(step.expect, substitute),
      })),
    },
    parameters: { ...values },
    reportedParameters,
    sensitiveValues: sensitiveValues.filter((value) => value !== ''),
  }
}

function substituteExpect(
  expect: ReplayStep['expect'],
  substitute: (value: unknown) => unknown,
): ReplayStep['expect'] {
  const matcher = expect.result
  if (matcher === undefined || (matcher.mode !== 'exact' && matcher.mode !== 'subset'))
    return expect
  return { ...expect, result: { ...matcher, value: substitute(matcher.value) } }
}

/** Argument property names that receive a sensitive parameter, for a trace's `redact` list. */
export function sensitiveArgumentKeys(spec: ReplaySpec): readonly string[] {
  if (spec.version !== REPLAY_SPEC_PARAMETERIZED_VERSION) return []
  const sensitive = new Set(
    Object.entries(spec.parameters)
      .filter(([, definition]) => definition.sensitive === true)
      .map(([name]) => name),
  )
  const keys = new Set<string>()
  const visit = (value: unknown, key: string | undefined): void => {
    const name = placeholderName(value)
    if (name !== undefined) {
      if (sensitive.has(name) && key !== undefined) keys.add(key)
      return
    }
    if (Array.isArray(value)) value.forEach((item) => visit(item, key))
    else if (isObject(value)) for (const [child, item] of Object.entries(value)) visit(item, child)
  }
  for (const step of spec.steps) visit(step.args, undefined)
  return [...keys]
}

/** The parameter a `{ "$param": name }` value refers to, or undefined for any other value. */
function placeholderName(value: unknown): string | undefined {
  if (!isObject(value) || !(PARAM_KEY in value)) return undefined
  const name = value[PARAM_KEY]
  return Object.keys(value).length === 1 && typeof name === 'string' ? name : undefined
}

function placeholdersIn(value: unknown, where: string): string[] {
  if (isObject(value) && PARAM_KEY in value) {
    const name = placeholderName(value)
    if (name === undefined) {
      throw new ReplayParameterError(
        'spec',
        `${where}: a placeholder is exactly { "${PARAM_KEY}": "<name>" }, with no other keys.`,
      )
    }
    return [name]
  }
  if (Array.isArray(value)) return value.flatMap((item) => placeholdersIn(item, where))
  if (!isObject(value)) return []
  return Object.values(value).flatMap((item) => placeholdersIn(item, where))
}

function substitutePlaceholders(
  value: unknown,
  values: Readonly<Record<string, unknown>>,
): unknown {
  const name = placeholderName(value)
  if (name !== undefined) return Object.hasOwn(values, name) ? values[name] : undefined
  if (Array.isArray(value)) return value.map((item) => substitutePlaceholders(item, values))
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, substitutePlaceholders(child, values)]),
  )
}

/** Accept the string form a CLI flag carries for numbers and booleans. */
function coerceParameterValue(definition: ReplayParameter, raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  if (definition.type === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : raw
  if (definition.type === 'number' || definition.type === 'integer') {
    const trimmed = raw.trim()
    return /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed) ? Number(trimmed) : raw
  }
  return raw
}

/** Why `value` does not fit `definition`, or undefined when it does. */
function checkParameterValue(definition: ReplayParameter, value: unknown): string | undefined {
  switch (definition.type) {
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'must be true or false'
    case 'path':
      return typeof value === 'string' && isFixedAbsolutePath(value)
        ? undefined
        : 'must be an absolute path (on Windows, with a drive letter or a UNC share)'
    case 'string': {
      if (typeof value !== 'string') return 'must be a string'
      if (definition.enum !== undefined && !definition.enum.includes(value)) {
        return `must be one of ${definition.enum.join(', ')}`
      }
      if (definition.minLength !== undefined && value.length < definition.minLength) {
        return `must be at least ${definition.minLength} characters`
      }
      if (definition.maxLength !== undefined && value.length > definition.maxLength) {
        return `must be at most ${definition.maxLength} characters`
      }
      if (definition.pattern !== undefined) {
        try {
          if (!new RegExp(definition.pattern, 'u').test(value))
            return `must match ${definition.pattern}`
        } catch {
          return `has an invalid pattern ${definition.pattern}`
        }
      }
      return undefined
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number'
      if (definition.type === 'integer' && !Number.isInteger(value)) return 'must be an integer'
      if (definition.enum !== undefined && !definition.enum.includes(value)) {
        return `must be one of ${definition.enum.join(', ')}`
      }
      if (definition.minimum !== undefined && value < definition.minimum) {
        return `must be at least ${definition.minimum}`
      }
      if (definition.maximum !== undefined && value > definition.maximum) {
        return `must be at most ${definition.maximum}`
      }
      return undefined
    }
  }
}

function isFixedAbsolutePath(value: string): boolean {
  return (
    /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value) ||
    (process.platform !== 'win32' && value.startsWith('/'))
  )
}

/** Shorter secrets are only redacted as whole values; inside text they would match everywhere. */
const MIN_SUBSTRING_SECRET = 4

/** Replace sensitive values: equal leaves, and occurrences of longer secrets (any type) inside text. */
function redactValues(value: unknown, secrets: readonly (string | number)[]): unknown {
  if (secrets.length === 0) return value
  const equalsSecret = (leaf: string | number) =>
    secrets.some((secret) => String(secret) === String(leaf))
  if (typeof value === 'number') return equalsSecret(value) ? REDACTED : value
  if (typeof value === 'string') {
    if (equalsSecret(value)) return REDACTED
    return secrets.reduce<string>((text, secret) => {
      const needle = String(secret)
      return needle.length >= MIN_SUBSTRING_SECRET ? text.split(needle).join(REDACTED) : text
    }, value)
  }
  if (Array.isArray(value)) return value.map((item) => redactValues(item, secrets))
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, redactValues(child, secrets)]),
  )
}

/** Keep captured session creators when a replay filter chooses one of their dependent steps. */
function selectStepsWithSessionProducers(
  steps: readonly ReplayStep[],
  include: ReadonlySet<string> | undefined,
  exclude: ReadonlySet<string> | undefined,
): ReadonlySet<number> {
  const producerIndexes = new Map<string, number>()
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (step?.captureSession !== undefined && !producerIndexes.has(step.captureSession)) {
      producerIndexes.set(step.captureSession, index)
    }
  }

  const selected = new Set<number>()
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (step === undefined) continue
    if ((include === undefined || include.has(step.tool)) && exclude?.has(step.tool) !== true) {
      selected.add(index)
    }
  }

  let addedProducer = true
  while (addedProducer) {
    addedProducer = false
    for (const index of selected) {
      const step = steps[index]
      if (step === undefined) continue
      for (const session of sessionReferences(step.args, producerIndexes)) {
        const producer = producerIndexes.get(session)
        if (producer !== undefined && !selected.has(producer)) {
          selected.add(producer)
          addedProducer = true
        }
      }
    }
  }
  return selected
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
      actual: redact(result),
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
    expected,
    actual,
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

function withoutDefault(definition: ReplayParameter): ReplayParameter {
  const copy: Record<string, unknown> = { ...definition }
  delete copy['default']
  return copy as ReplayParameter
}

/** Redact `scope.*` rule paths; a placeholder on such a path is kept and reported to `onPlaceholder`. */
function redactScopedValue(
  value: unknown,
  rules: readonly string[],
  scope: 'args' | 'result',
  onPlaceholder?: (name: string) => void,
): unknown {
  let current = clone(value)
  for (const rule of rules) {
    const parts = rule.split('.').filter((part) => part.length > 0)
    if (parts[0] !== scope) continue
    current = redactPath(current, parts.slice(1), onPlaceholder)
  }
  return current
}

function redactPath(
  value: unknown,
  parts: readonly string[],
  onPlaceholder?: (name: string) => void,
): unknown {
  if (parts.length === 0) {
    const name = placeholderName(value)
    if (name === undefined) return REDACTED
    onPlaceholder?.(name)
    return value
  }
  if (!isObject(value)) return value
  const [head, ...tail] = parts
  if (head === undefined || !(head in value)) return value
  return { ...value, [head]: redactPath(value[head], tail, onPlaceholder) }
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
