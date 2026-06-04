/**
 * Trace replay engine (ADR-009): re-run the tool calls a trace artifact recorded and report
 * which steps reproduce. It is the active counterpart to the recorder — where the recorder
 * observes dispatches into a JSONL artifact, the replay engine reads that artifact back and
 * re-dispatches each call through the same dispatcher (via the `ctx.dispatch` seam).
 *
 * ## Session-id remapping (the heart of "deterministic replay")
 *
 * A recorded trace's session ids belong to the run that produced it: the first `electron_launch`
 * returned some session id S1, and every later call carried `args.sessionId = S1`. Replaying
 * `electron_launch` against a fresh server creates a NEW session S2, so re-dispatching the next
 * call verbatim (with `sessionId: S1`) would fail `NOT_RUNNING`. The engine therefore keeps a
 * `recorded session id -> new session id` map: it rewrites each call's `sessionId` arg through the
 * map before dispatch, and after each call learns a new pair by comparing the recorded result's
 * `session_id` to the replayed one. Multiple sessions in one trace are handled per-pair.
 *
 * ## What "diverged" means
 *
 * Replay compares the STABLE outcome — `ok` and the error `code` — not the full envelope, because
 * legitimate payloads vary across runs (timestamps, generated ids, dynamic content). A diverged
 * call is one whose `ok` or `code` differs from the recording. For each diverged call the engine
 * also attaches a bounded field-level diff of the two result envelopes (volatile `_meta`/session
 * fields excluded) so the operator can see WHAT changed without drowning in noise.
 *
 * ## Honesty / limitations
 *
 * - A trace recorded with `redact` cannot be faithfully replayed: a `[redacted]` value re-validated
 *   against the tool schema diverges (recorded ok -> replayed BAD_ARGUMENT). That is reported, not
 *   hidden — you cannot reproduce what was scrubbed.
 * - `dryRun` re-validates each call against the CURRENT tool schema WITHOUT launching anything, so
 *   it detects a tool whose signature changed since the trace was recorded (schema drift).
 *
 * @module
 */

import type { ErrorResponse, ToolResult } from '@electron-stagewright/core'

import type { TraceCallRecord } from './recorder.js'

/** Default cap on field-level diffs reported per diverged call. */
const DEFAULT_DIFF_LIMIT = 8

/** Envelope keys whose values vary run-to-run and so are excluded from the divergence diff. */
const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  '_meta',
  'session_id',
  'estimated_tokens',
  'elapsed_ms',
])

/** Options controlling a {@link replayTrace} run. All optional; sensible defaults applied. */
export interface ReplayOptions {
  /** Halt after the first diverging call; remaining calls are reported skipped (`stopped_on_error`). */
  readonly stopOnError?: boolean
  /** Re-validate each call against the current schema WITHOUT dispatching (schema-drift check). */
  readonly dryRun?: boolean
  /** When set, only replay calls whose tool is in this list (others reported skipped). */
  readonly include?: readonly string[]
  /** Calls whose tool is in this list are reported skipped (not replayed). */
  readonly exclude?: readonly string[]
  /** Replay at most this many calls; the remainder are reported skipped (`max_calls`). */
  readonly maxCalls?: number
  /** Max field-level diffs attached per diverged call (default {@link DEFAULT_DIFF_LIMIT}). */
  readonly diffLimit?: number
  /**
   * Predicate marking a tool as the replaying plugin's own (skipped to avoid self-recursion). The
   * recorder already excludes these at record time; this is a backstop for hand-made/foreign
   * artifacts. The trace plugin passes `(t) => t.startsWith('trace_')`.
   */
  readonly skipTool?: (tool: string) => boolean
}

/** The collaborators the engine drives, injected so it is testable without a real dispatcher. */
export interface ReplayDeps {
  /** Re-dispatch a tool by name and resolve to its envelope (the `ctx.dispatch` seam). */
  readonly dispatch: (tool: string, args: unknown) => Promise<ToolResult>
  /** Validate a call against the current schema without running it (the `ctx.validate` seam). */
  readonly validate: (tool: string, args: unknown) => ErrorResponse | null
}

/** A single field-level difference between a recorded and replayed result envelope. */
export interface ResultDiff {
  /** Dotted path to the differing field within the result payload (`(root)` for a top-level leaf). */
  readonly path: string
  /** The value the recording had at this path. */
  readonly recorded: unknown
  /** The value the replay produced at this path. */
  readonly replayed: unknown
}

/** The outcome of replaying (or skipping) one recorded call. */
export interface ReplayCallOutcome {
  /** Zero-based position of the call within the trace. */
  readonly index: number
  /** The recorded tool name (the dispatched name, e.g. `electron_click`). */
  readonly tool: string
  /** Whether the recorded call succeeded. */
  readonly recorded_ok: boolean
  /** Whether the replayed (or, in dry-run, re-validated) call succeeded. `false` when skipped. */
  readonly replayed_ok: boolean
  /** The recorded error code, when the recorded call failed. */
  readonly recorded_code?: string
  /** The replayed error code, when the replayed call failed. */
  readonly replayed_code?: string
  /** True when `ok`/`code` differ from the recording. Always false for a skipped call. */
  readonly diverged: boolean
  /** True when the call was not replayed (filtered, self-tool, max-calls, or halted). */
  readonly skipped?: boolean
  /** Why the call was skipped (`excluded` / `not_included` / `self_tool` / `max_calls` / `stopped_on_error`). */
  readonly skip_reason?: string
  /** Bounded field-level diffs for a diverged call (omitted when none / not diverged / dry-run). */
  readonly diff?: readonly ResultDiff[]
}

/** The full result of a {@link replayTrace} run. JSON-serialisable (no Map/Set leaks). */
export interface ReplayReport {
  /** Number of calls actually replayed (or re-validated in dry-run); excludes skipped. */
  readonly replayed: number
  /** Replayed calls whose `ok`/`code` matched the recording. */
  readonly matched: number
  /** Replayed calls whose `ok`/`code` diverged from the recording. */
  readonly diverged: number
  /** Calls not replayed (filtered, self-tool, max-calls, or halted after a divergence). */
  readonly skipped: number
  /** Whether this was a no-dispatch dry-run (schema re-validation only). */
  readonly dry_run: boolean
  /** Per-call outcomes, in trace order. */
  readonly calls: readonly ReplayCallOutcome[]
}

/** Whether `value` is a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The `ok` flag of a result envelope (false for anything malformed). */
function okOf(result: unknown): boolean {
  return isPlainObject(result) && result['ok'] === true
}

/** The error `code` of a result envelope, when present. */
function codeOf(result: unknown): string | undefined {
  if (!isPlainObject(result)) return undefined
  return typeof result['code'] === 'string' ? (result['code'] as string) : undefined
}

/** The `session_id` carried by a result envelope (in `_meta`, with a top-level fallback). */
function sessionIdOf(result: unknown): string | undefined {
  if (!isPlainObject(result)) return undefined
  const meta = result['_meta']
  if (isPlainObject(meta) && typeof meta['session_id'] === 'string') {
    return meta['session_id'] as string
  }
  return typeof result['session_id'] === 'string' ? (result['session_id'] as string) : undefined
}

/**
 * Rewrite a call's top-level `sessionId` argument through the recorded->new session map, so a
 * replayed call addresses the freshly-created session rather than the recording's defunct one.
 * Returns the args unchanged when there is no mapped `sessionId` to rewrite.
 */
function remapSessionId(args: unknown, map: ReadonlyMap<string, string>): unknown {
  if (!isPlainObject(args)) return args
  const sid = args['sessionId']
  if (typeof sid === 'string' && map.has(sid)) {
    return { ...args, sessionId: map.get(sid) }
  }
  return args
}

/** Longest JSON a single diff value carries; larger leaves (e.g. a full snapshot blob) are truncated. */
const MAX_DIFF_VALUE_CHARS = 300

/**
 * Cap a diff value's size so one diverged call cannot drag a megabyte payload (a full DOM snapshot,
 * a long log) into the report and spike its token estimate. {@link collectDiffs} bounds the NUMBER
 * of diffs; this bounds each diff's value.
 */
function truncateForDiff(value: unknown): unknown {
  const json = JSON.stringify(value)
  if (json === undefined || json.length <= MAX_DIFF_VALUE_CHARS) return value
  return `${json.slice(0, MAX_DIFF_VALUE_CHARS)}…[truncated ${json.length} chars]`
}

/** Collect up to `limit` leaf-level differences between two result envelopes (volatile keys skipped). */
function collectDiffs(
  recorded: unknown,
  replayed: unknown,
  pathPrefix: string,
  out: ResultDiff[],
  limit: number,
): void {
  if (out.length >= limit) return
  if (isPlainObject(recorded) && isPlainObject(replayed)) {
    const keys = new Set([...Object.keys(recorded), ...Object.keys(replayed)])
    for (const key of keys) {
      if (out.length >= limit) return
      if (VOLATILE_KEYS.has(key)) continue
      const childPath = pathPrefix.length > 0 ? `${pathPrefix}.${key}` : key
      collectDiffs(recorded[key], replayed[key], childPath, out, limit)
    }
    return
  }
  // Arrays and leaves are compared whole by structural (JSON) equality; the values stored in the
  // diff are size-capped so a large payload cannot bloat the report.
  if (JSON.stringify(recorded) !== JSON.stringify(replayed)) {
    out.push({
      path: pathPrefix.length > 0 ? pathPrefix : '(root)',
      recorded: truncateForDiff(recorded),
      replayed: truncateForDiff(replayed),
    })
  }
}

/** Why a call would be skipped before replay, or `undefined` to replay it. */
function filterReason(
  tool: string,
  include: ReadonlySet<string> | undefined,
  exclude: ReadonlySet<string> | undefined,
  skipTool: ((tool: string) => boolean) | undefined,
): string | undefined {
  if (skipTool?.(tool) === true) return 'self_tool'
  if (exclude?.has(tool) === true) return 'excluded'
  if (include !== undefined && !include.has(tool)) return 'not_included'
  return undefined
}

/**
 * Replay a recorded trace's calls and report which reproduce. Re-dispatches each `call` in order
 * (or, in `dryRun`, re-validates it) through {@link ReplayDeps}, remapping session ids so the
 * replayed session addresses the freshly-created one. A call that fails is captured as that call's
 * (diverged) outcome rather than aborting the run — including a dispatch that returns an error
 * envelope. `deps.dispatch` / `deps.validate` are expected to resolve to an envelope (the
 * dispatcher's own contract — it maps every thrown handler error to an envelope), so this resolves
 * to a full report rather than rejecting.
 */
export async function replayTrace(
  calls: readonly TraceCallRecord[],
  deps: ReplayDeps,
  opts: ReplayOptions = {},
): Promise<ReplayReport> {
  const dryRun = opts.dryRun ?? false
  const stopOnError = opts.stopOnError ?? false
  const diffLimit = Math.max(0, opts.diffLimit ?? DEFAULT_DIFF_LIMIT)
  const include = opts.include !== undefined ? new Set(opts.include) : undefined
  const exclude = opts.exclude !== undefined ? new Set(opts.exclude) : undefined
  const maxCalls = opts.maxCalls

  const sessionMap = new Map<string, string>()
  const outcomes: ReplayCallOutcome[] = []
  let replayed = 0
  let matched = 0
  let diverged = 0
  let skipped = 0
  let processed = 0
  let haltReason: string | undefined

  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]
    if (call === undefined) continue

    const skipReason =
      haltReason ??
      filterReason(call.tool, include, exclude, opts.skipTool) ??
      (maxCalls !== undefined && processed >= maxCalls ? 'max_calls' : undefined)
    if (skipReason !== undefined) {
      outcomes.push({
        index,
        tool: call.tool,
        recorded_ok: call.ok,
        replayed_ok: false,
        ...(call.code !== undefined ? { recorded_code: call.code } : {}),
        diverged: false,
        skipped: true,
        skip_reason: skipReason,
      })
      skipped += 1
      continue
    }
    processed += 1

    let replayedOk: boolean
    let replayedCode: string | undefined
    let diffs: ResultDiff[] = []

    if (dryRun) {
      // Schema re-validation only: no dispatch, no session remap (a recorded sessionId is still a
      // valid string for schema purposes). A recorded-ok call that no longer validates is drift.
      const error = deps.validate(call.tool, call.args)
      replayedOk = error === null
      replayedCode = error !== null ? codeOf(error) : undefined
    } else {
      const args = remapSessionId(call.args, sessionMap)
      const result = await deps.dispatch(call.tool, args)
      replayedOk = okOf(result)
      replayedCode = codeOf(result)
      // Learn this call's session remapping (e.g. launch/attach returns a new session id). This
      // assumes a result's session id identifies the SAME logical session the call addressed — true
      // for every current tool (they either echo their input session id or, like launch, create
      // one). A future session-migrating tool that returned a DIFFERENT session than its input
      // would need explicit handling here (the recorded key would be the pre-migration id, not the
      // live one). No such tool exists today.
      const recordedId = sessionIdOf(call.result)
      const newId = sessionIdOf(result)
      if (recordedId !== undefined && newId !== undefined && recordedId !== newId) {
        sessionMap.set(recordedId, newId)
      }
      if (diffLimit > 0) collectDiffs(call.result, result, '', diffs, diffLimit)
    }

    const callDiverged = replayedOk !== call.ok || replayedCode !== call.code
    replayed += 1
    if (callDiverged) diverged += 1
    else matched += 1

    // Diffs only illuminate a real divergence; drop them otherwise to keep the report lean.
    if (!callDiverged) diffs = []

    outcomes.push({
      index,
      tool: call.tool,
      recorded_ok: call.ok,
      replayed_ok: replayedOk,
      ...(call.code !== undefined ? { recorded_code: call.code } : {}),
      ...(replayedCode !== undefined ? { replayed_code: replayedCode } : {}),
      diverged: callDiverged,
      ...(diffs.length > 0 ? { diff: diffs } : {}),
    })

    if (callDiverged && stopOnError) haltReason = 'stopped_on_error'
  }

  return { replayed, matched, diverged, skipped, dry_run: dryRun, calls: outcomes }
}
