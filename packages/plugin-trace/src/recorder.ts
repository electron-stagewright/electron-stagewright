/**
 * Trace artifact recorder + reader (ADR-009).
 *
 * Version 2 streams one JSONL record at a time to `<path>.partial`. A clean stop appends a
 * footer and atomically renames that file to the requested path; a crashed process leaves a
 * readable partial artifact whose missing footer reports `complete: false`. The observer path
 * never awaits disk I/O: it only builds a redacted record and adds it to a bounded write queue.
 *
 * Version 1 artifacts remain readable. They were buffered then written at stop, so their `meta`
 * header has no partial-file or completion semantics.
 *
 * @module
 */

import { appendFile, mkdir, open, readFile, rename, stat } from 'node:fs/promises'
import path from 'node:path'

import type { DispatchRecord } from '@electron-stagewright/core'

/** Schema version emitted by new trace artifacts. */
export const TRACE_FORMAT_VERSION = 2 as const
/** Legacy JSONL schema version, retained exclusively for the v1 reader. */
export const LEGACY_TRACE_FORMAT_VERSION = 1 as const

/** The first line of a legacy v1 artifact. */
export interface TraceMetaRecord {
  readonly v: typeof LEGACY_TRACE_FORMAT_VERSION
  readonly kind: 'meta'
  readonly started_at: number
  readonly core_version: string
  readonly overflowed: boolean
  readonly budget?: number
  readonly warn_threshold?: number
  readonly spent?: number
}

/** The first line of a streaming v2 artifact. */
export interface TraceHeaderRecord {
  readonly kind: 'header'
  readonly format: 'stagewright-trace'
  readonly version: typeof TRACE_FORMAT_VERSION
  readonly started_at: number
  readonly core_version: string
  readonly budget?: number
  readonly warn_threshold?: number
}

/** The terminal record of a cleanly closed v2 artifact. */
export interface TraceFooterRecord {
  readonly kind: 'footer'
  readonly complete: true
  readonly calls: number
  readonly overflowed: boolean
  readonly spent?: number
}

/** One recorded tool dispatch. `args`/`result` are the agent-facing values (redaction applied). */
export interface TraceCallRecord {
  readonly kind: 'call'
  /** Monotonic in v2 artifacts; absent in legacy v1 artifacts. */
  readonly seq?: number
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

/** A line of a v1 or v2 trace artifact. */
export type TraceRecord = TraceMetaRecord | TraceHeaderRecord | TraceCallRecord | TraceFooterRecord

/** Default warn-threshold fraction: `near_budget` trips once spent reaches 80% of the budget. */
export const DEFAULT_WARN_THRESHOLD = 0.8

/**
 * Token-budget status, surfaced (nested under `budget`) on `trace_status` / `trace_tokens` /
 * `trace_stop` / `trace_budget` whenever a recording or artifact carries a budget. All counts are
 * estimated tokens (char/4, per ADR-006), so the budget inherits that approximation.
 */
export interface BudgetStatus {
  readonly budget_tokens: number
  readonly spent: number
  readonly remaining: number
  readonly over_budget: boolean
  readonly near_budget: boolean
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
  readonly overflowed: boolean
  readonly budget?: BudgetStatus
}

/** Replace any property whose key is in `keys` with `'[redacted]'`, recursively. */
function redactValue(value: unknown, keys: ReadonlySet<string>): unknown {
  if (keys.size === 0) return value
  if (Array.isArray(value)) return value.map((item) => redactValue(item, keys))
  if (value !== null && typeof value === 'object') {
    // Null prototype makes a literal `__proto__` an own property instead of triggering the
    // Object.prototype setter and silently dropping the evidence.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const [key, val] of Object.entries(value)) {
      out[key] = keys.has(key) ? '[redacted]' : redactValue(val, keys)
    }
    return out
  }
  return value
}

/** Options for {@link Recorder}. */
export interface RecorderOptions {
  /** Absolute final output path for the JSONL artifact. */
  readonly path: string
  /** Maximum persisted call records; later calls are dropped and `overflowed` is set. */
  readonly maxRecords: number
  /** Argument property names to redact before recording. */
  readonly redact: readonly string[]
  /** Core version stamped into the header. */
  readonly coreVersion: string
  /** Epoch-ms the recording started. */
  readonly startedAt: number
  /** Token budget for this recording, if any. */
  readonly budget?: number
  /** Warn-threshold fraction (`0 < warnThreshold <= 1`). */
  readonly warnThreshold?: number
  /** Sync the partial artifact before its final atomic rename. Off by default for throughput. */
  readonly fsync?: boolean
}

const LIVE_LARGEST_LIMIT = 10

/**
 * Streams redacted dispatches to a bounded JSONL queue. Call {@link start} before registering its
 * observer, then {@link stop} to append the completion footer and atomically publish the artifact.
 */
export class Recorder {
  readonly path: string
  readonly partialPath: string
  readonly #maxRecords: number
  readonly #redact: ReadonlySet<string>
  readonly #coreVersion: string
  readonly #startedAt: number
  readonly #budget?: number
  readonly #warnThreshold: number
  readonly #fsync: boolean
  readonly #pending: string[] = []
  readonly #byTool = new Map<string, { calls: number; estimated_tokens: number }>()
  readonly #largest: TraceCallRecord[] = []
  #pendingIndex = 0
  #drain: Promise<void> | undefined
  #writeError: unknown
  #records = 0
  #totalTokens = 0
  #spent = 0
  #overflowed = false
  #state: 'new' | 'recording' | 'finalizing' | 'stopped' = 'new'
  #stopPromise: Promise<TraceSummary> | undefined
  #summary: TraceSummary | undefined
  #footer: TraceFooterRecord | undefined

  constructor(opts: RecorderOptions) {
    this.path = opts.path
    this.partialPath = `${opts.path}.partial`
    this.#maxRecords = opts.maxRecords
    this.#redact = new Set(opts.redact)
    this.#coreVersion = opts.coreVersion
    this.#startedAt = opts.startedAt
    if (opts.budget !== undefined) this.#budget = opts.budget
    this.#warnThreshold = opts.warnThreshold ?? DEFAULT_WARN_THRESHOLD
    this.#fsync = opts.fsync ?? false
  }

  /** Number of persisted `call` records accepted so far. */
  get count(): number {
    return this.#records
  }

  /** Whether the record cap has been hit. */
  get overflowed(): boolean {
    return this.#overflowed
  }

  /** Exact estimated tokens across all observed calls, including overflow-dropped calls. */
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

  /** Create the partial artifact and durably publish its v2 header before calls can be observed. */
  async start(): Promise<void> {
    if (this.#state !== 'new') {
      throw new Error('Trace recorder has already been started')
    }
    await mkdir(path.dirname(this.path), { recursive: true })
    try {
      const output = await stat(this.path)
      if (!output.isFile()) throw new Error('Trace output path is not a regular file')
    } catch (err) {
      if (isNodeError(err, 'ENOENT')) {
        // The normal case: the final artifact does not exist yet.
      } else {
        throw err
      }
    }
    const handle = await open(this.partialPath, 'wx')
    try {
      const header: TraceHeaderRecord = {
        kind: 'header',
        format: 'stagewright-trace',
        version: TRACE_FORMAT_VERSION,
        started_at: this.#startedAt,
        core_version: this.#coreVersion,
        ...(this.#budget !== undefined
          ? { budget: this.#budget, warn_threshold: this.#warnThreshold }
          : {}),
      }
      await handle.writeFile(`${JSON.stringify(header)}\n`, 'utf8')
      if (this.#fsync) await handle.sync()
      this.#state = 'recording'
    } finally {
      await handle.close()
    }
  }

  /**
   * Observe one completed dispatch. This intentionally does not await I/O; the queue is bounded by
   * `maxRecords`, preserves append order, and a terminal write error is reported by `stop()`.
   */
  record(rec: DispatchRecord): void {
    if (this.#state !== 'recording') return
    const tokens = rec.result._meta?.estimated_tokens ?? 0
    this.#spent += tokens
    if (this.#records >= this.#maxRecords) {
      this.#overflowed = true
      return
    }
    const call: TraceCallRecord = {
      kind: 'call',
      seq: this.#records + 1,
      tool: rec.tool,
      ok: rec.result.ok,
      ...(rec.result.ok ? {} : { code: rec.result.code }),
      started_at: rec.startedAt,
      finished_at: rec.finishedAt,
      elapsed_ms: Math.max(0, rec.finishedAt - rec.startedAt),
      estimated_tokens: tokens,
      args: redactValue(rec.args, this.#redact),
      result: rec.result,
    }
    this.#records += 1
    this.#totalTokens += tokens
    const aggregate = this.#byTool.get(call.tool) ?? { calls: 0, estimated_tokens: 0 }
    aggregate.calls += 1
    aggregate.estimated_tokens += tokens
    this.#byTool.set(call.tool, aggregate)
    this.#rememberLargest(call)
    if (this.#writeError === undefined) {
      this.#pending.push(`${JSON.stringify(call)}\n`)
      this.#ensureDrain()
    }
  }

  /** Aggregate the live trace without retaining every call record in memory. */
  tokenReport(topN = LIVE_LARGEST_LIMIT): TokensReport {
    const by_tool = [...this.#byTool.entries()]
      .map(([tool, aggregate]) => ({ tool, ...aggregate }))
      .sort((a, b) => b.estimated_tokens - a.estimated_tokens)
    const largest = this.#largest.slice(0, topN).map((call) => ({
      tool: call.tool,
      estimated_tokens: call.estimated_tokens,
      started_at: call.started_at,
      ok: call.ok,
    }))
    const budget = this.budgetStatus()
    return {
      total_estimated_tokens: this.#totalTokens,
      calls: this.#records,
      overflowed: this.#overflowed,
      by_tool,
      largest,
      ...(budget !== undefined ? { budget } : {}),
    }
  }

  /** Flush queued calls, append the footer, then atomically publish the complete artifact. */
  async stop(): Promise<TraceSummary> {
    if (this.#summary !== undefined) return this.#summary
    if (this.#state === 'new') throw new Error('Trace recorder has not been started')
    if (this.#stopPromise !== undefined) return this.#stopPromise
    this.#state = 'finalizing'
    this.#stopPromise = this.#finish()
    try {
      const summary = await this.#stopPromise
      this.#summary = summary
      this.#state = 'stopped'
      return summary
    } catch (err) {
      // Do not claim a successful final artifact. The partial remains available for recovery.
      // Once a footer exists, the artifact is immutable: accepting another call would put it
      // after the terminal record. A retry can still fsync/rename that same footer.
      this.#state = this.#footer === undefined ? 'recording' : 'finalizing'
      this.#stopPromise = undefined
      throw err
    }
  }

  async #finish(): Promise<TraceSummary> {
    await this.#flush()
    if (this.#footer === undefined) {
      const footer: TraceFooterRecord = {
        kind: 'footer',
        complete: true,
        calls: this.#records,
        overflowed: this.#overflowed,
        ...(this.#budget !== undefined ? { spent: this.#spent } : {}),
      }
      await appendFile(this.partialPath, `${JSON.stringify(footer)}\n`, 'utf8')
      this.#footer = footer
    }
    if (this.#fsync) {
      // Windows rejects fsync on a read-only handle (EPERM); the recorder owns this partial file,
      // so a writable handle is both valid and required for the durability barrier on every OS.
      const handle = await open(this.partialPath, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    await rename(this.partialPath, this.path)
    return this.#buildSummary()
  }

  async #flush(): Promise<void> {
    while (this.#pendingIndex < this.#pending.length || this.#drain !== undefined) {
      const draining = this.#drain
      if (draining === undefined) {
        this.#ensureDrain()
        continue
      }
      await draining
      if (this.#writeError !== undefined) throw this.#writeError
    }
    if (this.#writeError !== undefined) throw this.#writeError
  }

  #ensureDrain(): void {
    if (this.#drain !== undefined || this.#writeError !== undefined) return
    this.#drain = this.#drainPending()
      .catch((err: unknown) => {
        this.#writeError = err
      })
      .finally(() => {
        this.#drain = undefined
      })
  }

  async #drainPending(): Promise<void> {
    while (this.#pendingIndex < this.#pending.length) {
      const nextIndex = this.#pending.length
      const batch = this.#pending.slice(this.#pendingIndex, nextIndex).join('')
      await appendFile(this.partialPath, batch, 'utf8')
      this.#pendingIndex = nextIndex
      // Avoid a long-lived backing array after a large trace while preserving O(1) queue progress.
      if (this.#pendingIndex === this.#pending.length) {
        this.#pending.length = 0
        this.#pendingIndex = 0
      }
    }
  }

  #rememberLargest(call: TraceCallRecord): void {
    const smallest = this.#largest.at(-1)
    if (
      this.#largest.length === LIVE_LARGEST_LIMIT &&
      smallest !== undefined &&
      call.estimated_tokens <= smallest.estimated_tokens
    ) {
      return
    }
    this.#largest.push(call)
    this.#largest.sort((a, b) => b.estimated_tokens - a.estimated_tokens)
    if (this.#largest.length > LIVE_LARGEST_LIMIT) this.#largest.length = LIVE_LARGEST_LIMIT
  }

  #buildSummary(): TraceSummary {
    const budget = this.budgetStatus()
    return {
      path: this.path,
      records: this.#records,
      total_estimated_tokens: this.#totalTokens,
      overflowed: this.#overflowed,
      ...(budget !== undefined ? { budget } : {}),
    }
  }
}

/** Aggregated token usage over a trace's call records (backs `trace_tokens`). */
export interface TokensReport {
  readonly total_estimated_tokens: number
  readonly calls: number
  readonly overflowed: boolean
  readonly by_tool: ReadonlyArray<{ tool: string; calls: number; estimated_tokens: number }>
  readonly largest: ReadonlyArray<{
    tool: string
    estimated_tokens: number
    started_at: number
    ok: boolean
  }>
  readonly budget?: BudgetStatus
}

/** Aggregate token usage from trace calls. */
export function summarizeTrace(
  records: readonly TraceCallRecord[],
  topN = LIVE_LARGEST_LIMIT,
  overflowed = false,
  budget?: BudgetStatus,
): TokensReport {
  const byTool = new Map<string, { calls: number; estimated_tokens: number }>()
  let total = 0
  for (const call of records) {
    total += call.estimated_tokens
    const aggregate = byTool.get(call.tool) ?? { calls: 0, estimated_tokens: 0 }
    aggregate.calls += 1
    aggregate.estimated_tokens += call.estimated_tokens
    byTool.set(call.tool, aggregate)
  }
  const by_tool = [...byTool.entries()]
    .map(([tool, aggregate]) => ({ tool, ...aggregate }))
    .sort((a, b) => b.estimated_tokens - a.estimated_tokens)
  const largest = [...records]
    .sort((a, b) => b.estimated_tokens - a.estimated_tokens)
    .slice(0, topN)
    .map((call) => ({
      tool: call.tool,
      estimated_tokens: call.estimated_tokens,
      started_at: call.started_at,
      ok: call.ok,
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
  readonly formatVersion: 1 | 2
  /** False only for a readable v2 partial artifact lacking its terminal footer. */
  readonly complete: boolean
  readonly meta?: TraceMetaRecord
  readonly header?: TraceHeaderRecord
  readonly footer?: TraceFooterRecord
  readonly calls: readonly TraceCallRecord[]
}

/** Whether the parsed artifact reports a record-cap overflow. */
export function traceOverflowed(parsed: ParsedTrace): boolean {
  return parsed.meta?.overflowed ?? parsed.footer?.overflowed ?? false
}

/** Derive budget status from either supported artifact format. */
export function traceBudgetStatus(parsed: ParsedTrace): BudgetStatus | undefined {
  const header = parsed.meta ?? parsed.header
  if (header?.budget === undefined) return undefined
  const spent =
    parsed.meta?.spent ??
    parsed.footer?.spent ??
    parsed.calls.reduce((sum, call) => sum + call.estimated_tokens, 0)
  return budgetStatusOf(header.budget, spent, header.warn_threshold ?? DEFAULT_WARN_THRESHOLD)
}

/**
 * Max trace-artifact size (bytes) `readTrace` will load. The path comes from an untrusted client,
 * so size and regular-file checks occur before bytes enter memory.
 */
const MAX_TRACE_FILE_BYTES = 64 * 1024 * 1024

/** Read and parse a v1 record sequence (including legacy headerless call-only artifacts). */
export function readTraceV1(records: readonly unknown[]): ParsedTrace {
  const calls: TraceCallRecord[] = []
  let meta: TraceMetaRecord | undefined
  for (const [index, raw] of records.entries()) {
    const record = asRecord(raw)
    if (record['kind'] === 'meta') {
      if (index !== 0 || meta !== undefined || record['v'] !== LEGACY_TRACE_FORMAT_VERSION) {
        throw new Error('Invalid v1 trace meta record')
      }
      meta = record as unknown as TraceMetaRecord
      continue
    }
    if (record['kind'] !== 'call') {
      throw new Error(`Invalid v1 trace record kind: ${String(record['kind'])}`)
    }
    calls.push(validateCall(record))
  }
  return {
    formatVersion: LEGACY_TRACE_FORMAT_VERSION,
    complete: true,
    ...(meta ? { meta } : {}),
    calls,
  }
}

/** Read and parse a v2 record sequence, accepting a missing footer as a crash-recoverable partial. */
export function readTraceV2(records: readonly unknown[]): ParsedTrace {
  const first = asRecord(records[0])
  if (
    first['kind'] !== 'header' ||
    first['format'] !== 'stagewright-trace' ||
    first['version'] !== TRACE_FORMAT_VERSION
  ) {
    throw new Error('Invalid v2 trace header')
  }
  const header = first as unknown as TraceHeaderRecord
  const calls: TraceCallRecord[] = []
  let footer: TraceFooterRecord | undefined
  for (let index = 1; index < records.length; index += 1) {
    const record = asRecord(records[index])
    if (record['kind'] === 'call') {
      if (footer !== undefined) throw new Error('Invalid v2 trace: call after footer')
      const call = validateCall(record)
      if (!Number.isInteger(call.seq) || call.seq !== calls.length + 1) {
        throw new Error('Invalid v2 trace call sequence')
      }
      calls.push(call)
      continue
    }
    if (record['kind'] !== 'footer' || footer !== undefined || index !== records.length - 1) {
      throw new Error(`Invalid v2 trace record kind: ${String(record['kind'])}`)
    }
    if (
      record['complete'] !== true ||
      !Number.isInteger(record['calls']) ||
      record['calls'] !== calls.length
    ) {
      throw new Error('Invalid v2 trace footer')
    }
    footer = record as unknown as TraceFooterRecord
  }
  return {
    formatVersion: TRACE_FORMAT_VERSION,
    complete: footer !== undefined,
    header,
    ...(footer !== undefined ? { footer } : {}),
    calls,
  }
}

/** Read + parse a v1 or v2 JSONL trace artifact. */
export async function readTrace(filePath: string): Promise<ParsedTrace> {
  const info = await stat(filePath)
  if (!info.isFile()) throw new Error('Trace path is not a regular file')
  if (info.size > MAX_TRACE_FILE_BYTES) {
    throw new Error(`Trace file is too large (${info.size} > ${MAX_TRACE_FILE_BYTES} bytes)`)
  }
  const text = await readFile(filePath, 'utf8')
  const { records, trailingPartial } = parseJsonLines(text)
  if (records.length === 0) throw new Error('Trace artifact is empty')
  const first = asRecord(records[0])
  if (trailingPartial && first['kind'] !== 'header') {
    throw new Error('Legacy trace artifact has an incomplete final record')
  }
  if (first['kind'] === 'header') return readTraceV2(records)
  return readTraceV1(records)
}

function parseJsonLines(text: string): { records: unknown[]; trailingPartial: boolean } {
  const lines = text.split('\n')
  const records: unknown[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]?.trim() ?? ''
    if (trimmed === '') continue
    try {
      records.push(JSON.parse(trimmed) as unknown)
    } catch (err) {
      // A process can die mid-append. Preserve all prior v2 records rather than treating the
      // incomplete trailing bytes as corruption; malformed complete lines still fail closed.
      if (index === lines.length - 1 && !text.endsWith('\n')) {
        return { records, trailingPartial: true }
      }
      throw err
    }
  }
  return { records, trailingPartial: false }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !('kind' in value)) {
    throw new Error('Invalid trace record: missing kind')
  }
  return value as Record<string, unknown>
}

function validateCall(record: Record<string, unknown>): TraceCallRecord {
  if (typeof record['tool'] !== 'string' || record['tool'] === '') {
    throw new Error('Invalid trace call record: missing tool name')
  }
  return record as unknown as TraceCallRecord
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}
