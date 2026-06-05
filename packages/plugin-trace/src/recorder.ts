/**
 * Trace artifact recorder + reader (ADR-009).
 *
 * The artifact is JSONL: a single `meta` header record followed by one `call` record per tool
 * dispatch. Records are buffered in memory while recording and written once on `stop()` — this
 * keeps the dispatch-path observer a cheap array push (it must not block tool calls; durability
 * is traded for that, a crash before stop loses the buffer — streaming is a forthcoming
 * improvement). The buffer is bounded by `maxRecords`; on overflow further calls are dropped
 * and `overflowed` is set so the summary can disclose the truncation.
 *
 * Everything written is JSON-serialisable (records are built from the agent-facing envelope),
 * so the artifact round-trips through `JSON.parse` without data loss.
 *
 * @module
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { DispatchRecord } from '@electron-stagewright/core'

/** Schema version of the trace artifact format. Bumped when the record shape changes. */
export const TRACE_FORMAT_VERSION = 1 as const

/** The first line of a trace artifact: format version + when/what produced it. */
export interface TraceMetaRecord {
  readonly v: typeof TRACE_FORMAT_VERSION
  readonly kind: 'meta'
  readonly started_at: number
  readonly core_version: string
  /** Whether the trace hit its call-record cap and dropped later calls. */
  readonly overflowed: boolean
  /**
   * Token budget the recording was started with, if any. Persisted so an offline `trace_tokens`
   * can report budget status. Absent when the recording had no budget. (Additive optional field —
   * a `v: 1` reader ignores it; no format-version bump needed.)
   */
  readonly budget?: number
  /** Warn-threshold fraction (`0 < warnThreshold <= 1`) used to derive `near_budget`. */
  readonly warn_threshold?: number
  /**
   * Exact estimated tokens spent across ALL observed calls — including calls dropped after the
   * record cap (`overflowed`), which the buffered `call` records undercount. Present only with
   * `budget`, so an offline budget report stays exact under overflow.
   */
  readonly spent?: number
}

/** One recorded tool dispatch. `args`/`result` are the agent-facing values (redaction applied). */
export interface TraceCallRecord {
  readonly kind: 'call'
  readonly tool: string
  readonly ok: boolean
  /** Error code when `ok` is false; absent on success. */
  readonly code?: string
  readonly started_at: number
  readonly finished_at: number
  readonly elapsed_ms: number
  readonly estimated_tokens: number
  readonly args: unknown
  readonly result: unknown
}

/** A line of a trace artifact. */
export type TraceRecord = TraceMetaRecord | TraceCallRecord

/** Default warn-threshold fraction: `near_budget` trips once spent reaches 80% of the budget. */
export const DEFAULT_WARN_THRESHOLD = 0.8

/**
 * Token-budget status, surfaced (nested under `budget`) on `trace_status` / `trace_tokens` /
 * `trace_stop` / `trace_budget` whenever a recording or artifact carries a budget. All counts are
 * estimated tokens (char/4, per ADR-006), so the budget inherits that approximation.
 */
export interface BudgetStatus {
  /** The configured budget ceiling, in estimated tokens. */
  readonly budget_tokens: number
  /** Estimated tokens spent so far — exact across overflow-dropped calls. */
  readonly spent: number
  /** Budget remaining, floored at 0. */
  readonly remaining: number
  /** True once `spent` exceeds `budget_tokens`. Sticky (spent never decreases). */
  readonly over_budget: boolean
  /** True once `spent` reaches `warn_threshold * budget_tokens` but is not yet over budget. */
  readonly near_budget: boolean
  /** The warn-threshold fraction (`0 < warnThreshold <= 1`) used to derive `near_budget`. */
  readonly warn_threshold: number
}

/** Derive a {@link BudgetStatus} from a budget ceiling, tokens spent, and a warn threshold. */
export function budgetStatusOf(
  budgetTokens: number,
  spent: number,
  warnThreshold: number,
): BudgetStatus {
  const overBudget = spent > budgetTokens
  return {
    budget_tokens: budgetTokens,
    spent,
    remaining: Math.max(0, budgetTokens - spent),
    over_budget: overBudget,
    near_budget: !overBudget && spent >= budgetTokens * warnThreshold,
    warn_threshold: warnThreshold,
  }
}

/** Summary returned by `Recorder.stop()` (and `trace_stop`). */
export interface TraceSummary {
  readonly path: string
  readonly records: number
  readonly total_estimated_tokens: number
  /** True when the record cap was hit and later calls were dropped. */
  readonly overflowed: boolean
  /** Token-budget status — present only when the recording was started with a budget. */
  readonly budget?: BudgetStatus
}

/** Replace any property whose key is in `keys` with `'[redacted]'`, recursively. */
function redactValue(value: unknown, keys: ReadonlySet<string>): unknown {
  if (keys.size === 0) return value
  if (Array.isArray(value)) return value.map((item) => redactValue(item, keys))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      out[key] = keys.has(key) ? '[redacted]' : redactValue(val, keys)
    }
    return out
  }
  return value
}

/** Options for {@link Recorder}. */
export interface RecorderOptions {
  /** Absolute output file path for the JSONL artifact. */
  readonly path: string
  /** Max `call` records buffered; further calls are dropped and `overflowed` set. */
  readonly maxRecords: number
  /** Argument property names to redact (replaced with `'[redacted]'`) before recording. */
  readonly redact: readonly string[]
  /** Core version stamped into the meta header. */
  readonly coreVersion: string
  /** Epoch-ms the recording started (meta header). */
  readonly startedAt: number
  /** Token budget for this recording, if any. Enables budget status on the reports. */
  readonly budget?: number
  /** Warn-threshold fraction (`0 < warnThreshold <= 1`); defaults to {@link DEFAULT_WARN_THRESHOLD}. */
  readonly warnThreshold?: number
}

/**
 * Buffers tool-dispatch records and writes them to a JSONL artifact on stop. A single
 * recorder backs one active `trace_start`/`trace_stop` cycle. `stop()` is idempotent.
 */
export class Recorder {
  readonly path: string
  readonly #maxRecords: number
  readonly #redact: ReadonlySet<string>
  readonly #coreVersion: string
  readonly #startedAt: number
  readonly #calls: TraceCallRecord[] = []
  readonly #budget?: number
  readonly #warnThreshold: number
  #spent = 0
  #overflowed = false
  #closed = false

  constructor(opts: RecorderOptions) {
    this.path = opts.path
    this.#maxRecords = opts.maxRecords
    this.#redact = new Set(opts.redact)
    this.#coreVersion = opts.coreVersion
    this.#startedAt = opts.startedAt
    if (opts.budget !== undefined) this.#budget = opts.budget
    this.#warnThreshold = opts.warnThreshold ?? DEFAULT_WARN_THRESHOLD
  }

  /** Number of `call` records buffered so far. */
  get count(): number {
    return this.#calls.length
  }

  /** Whether the record cap has been hit. */
  get overflowed(): boolean {
    return this.#overflowed
  }

  /** The buffered call records (for summarising a live recording before it is written). */
  get calls(): readonly TraceCallRecord[] {
    return this.#calls
  }

  /** Exact estimated tokens spent across ALL observed calls (includes overflow-dropped calls). */
  get spent(): number {
    return this.#spent
  }

  /** The configured budget ceiling, or `undefined` when the recording has no budget. */
  get budget(): number | undefined {
    return this.#budget
  }

  /** Live token-budget status, or `undefined` when the recording has no budget. */
  budgetStatus(): BudgetStatus | undefined {
    if (this.#budget === undefined) return undefined
    return budgetStatusOf(this.#budget, this.#spent, this.#warnThreshold)
  }

  /**
   * Buffer one completed dispatch. Best-effort and cheap (an array push). The trace plugin's
   * OWN tools are filtered out by the caller, not here. No-op once stopped or once the cap is
   * reached (sets `overflowed`).
   */
  record(rec: DispatchRecord): void {
    if (this.#closed) return
    // `_meta.estimated_tokens` is always present on a ToolResult, but guard defensively so a
    // future result shape can't silently poison the total with NaN.
    const tokens = rec.result._meta?.estimated_tokens ?? 0
    // Count spent BEFORE the cap check so the budget reflects EVERY observed call, including ones
    // dropped after overflow — otherwise an over-budget run could look in-budget once truncated.
    this.#spent += tokens
    if (this.#calls.length >= this.#maxRecords) {
      this.#overflowed = true
      return
    }
    const elapsed = Math.max(0, rec.finishedAt - rec.startedAt)
    this.#calls.push({
      kind: 'call',
      tool: rec.tool,
      ok: rec.result.ok,
      ...(rec.result.ok ? {} : { code: rec.result.code }),
      started_at: rec.startedAt,
      finished_at: rec.finishedAt,
      elapsed_ms: elapsed,
      estimated_tokens: tokens,
      args: redactValue(rec.args, this.#redact),
      result: rec.result,
    })
  }

  /** Flush the buffer to the JSONL artifact and return a summary. Idempotent. */
  async stop(): Promise<TraceSummary> {
    if (!this.#closed) {
      this.#closed = true
      try {
        const meta: TraceMetaRecord = {
          v: TRACE_FORMAT_VERSION,
          kind: 'meta',
          started_at: this.#startedAt,
          core_version: this.#coreVersion,
          overflowed: this.#overflowed,
          // Persist the budget (and the exact spent, which the buffered calls undercount under
          // overflow) so an offline trace_tokens can report budget status accurately.
          ...(this.#budget !== undefined
            ? { budget: this.#budget, warn_threshold: this.#warnThreshold, spent: this.#spent }
            : {}),
        }
        const lines = [meta, ...this.#calls].map((r) => JSON.stringify(r)).join('\n')
        await mkdir(path.dirname(this.path), { recursive: true })
        await writeFile(this.path, `${lines}\n`, 'utf8')
      } catch (err) {
        this.#closed = false
        throw err
      }
    }
    return this.#summary()
  }

  #summary(): TraceSummary {
    const budget = this.budgetStatus()
    return {
      path: this.path,
      records: this.#calls.length,
      total_estimated_tokens: this.#calls.reduce((sum, c) => sum + c.estimated_tokens, 0),
      overflowed: this.#overflowed,
      ...(budget !== undefined ? { budget } : {}),
    }
  }
}

/** Aggregated token usage over a trace's call records (backs `trace_tokens`). */
export interface TokensReport {
  readonly total_estimated_tokens: number
  readonly calls: number
  /** True when the trace hit its call-record cap and later calls were dropped. */
  readonly overflowed: boolean
  /** Per-tool totals, descending by estimated tokens. */
  readonly by_tool: ReadonlyArray<{ tool: string; calls: number; estimated_tokens: number }>
  /** The single most expensive responses, descending by estimated tokens. */
  readonly largest: ReadonlyArray<{
    tool: string
    estimated_tokens: number
    started_at: number
    ok: boolean
  }>
  /** Token-budget status — present only when the trace carries a budget. */
  readonly budget?: BudgetStatus
}

/**
 * Aggregate token usage from a trace's `call` records. `budget`, when supplied (derived by the
 * caller from the live recorder or the artifact's meta), is attached to the report.
 */
export function summarizeTrace(
  records: readonly TraceCallRecord[],
  topN = 10,
  overflowed = false,
  budget?: BudgetStatus,
): TokensReport {
  const byTool = new Map<string, { calls: number; estimated_tokens: number }>()
  let total = 0
  for (const call of records) {
    total += call.estimated_tokens
    const agg = byTool.get(call.tool) ?? { calls: 0, estimated_tokens: 0 }
    agg.calls += 1
    agg.estimated_tokens += call.estimated_tokens
    byTool.set(call.tool, agg)
  }
  const by_tool = [...byTool.entries()]
    .map(([tool, agg]) => ({ tool, calls: agg.calls, estimated_tokens: agg.estimated_tokens }))
    .sort((a, b) => b.estimated_tokens - a.estimated_tokens)
  const largest = [...records]
    .sort((a, b) => b.estimated_tokens - a.estimated_tokens)
    .slice(0, topN)
    .map((c) => ({
      tool: c.tool,
      estimated_tokens: c.estimated_tokens,
      started_at: c.started_at,
      ok: c.ok,
    }))
  return {
    total_estimated_tokens: total,
    calls: records.length,
    overflowed,
    by_tool,
    largest,
    ...(budget !== undefined ? { budget } : {}),
  }
}

/** Parsed contents of a trace artifact. */
export interface ParsedTrace {
  readonly meta?: TraceMetaRecord
  readonly calls: readonly TraceCallRecord[]
}

/** Read + parse a JSONL trace artifact. Throws (ENOENT) when the file does not exist. */
export async function readTrace(filePath: string): Promise<ParsedTrace> {
  const text = await readFile(filePath, 'utf8')
  const calls: TraceCallRecord[] = []
  let meta: TraceMetaRecord | undefined
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const rec = JSON.parse(trimmed) as unknown
    if (rec === null || typeof rec !== 'object' || !('kind' in rec)) {
      throw new Error('Invalid trace record: missing kind')
    }
    if (rec.kind === 'meta') meta = rec as TraceMetaRecord
    else if (rec.kind === 'call') calls.push(rec as TraceCallRecord)
    else throw new Error(`Invalid trace record kind: ${String(rec.kind)}`)
  }
  return meta !== undefined ? { meta, calls } : { calls }
}
