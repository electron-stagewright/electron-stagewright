/**
 * The cross-server comparison runner + its PURE contrast computation. `runComparison` drives each
 * {@link TaskAdapter} (spawning its server over stdio) and collects per-row metrics; `computeContrast`
 * (pure, no I/O) turns those rows into per-task deltas vs a baseline target. Splitting the I/O from the
 * arithmetic keeps the contrast logic unit-testable without spawning anything — the orchestration is
 * exercised by `pnpm bench --compare` (and, in tests, by an injected fake client).
 *
 * @module
 */

import { runAdapter, type ComparisonResult, type ConnectFn, type TaskAdapter } from './harness.js'

/**
 * One target's delta vs the baseline on a single task. Sign convention: `vsBaseline = target − baseline`,
 * so a POSITIVE value means the target spent MORE than the baseline (the baseline is leaner) and a
 * negative value means it spent less. The artifact distinguishes request-argument and response BPE;
 * only client-side BPE counts are comparable across servers (not a server's private token estimate).
 */
export interface TargetDelta {
  readonly target: string
  readonly toolCallsVsBaseline: number
  readonly estimatedTokensVsBaseline: number
  /** Client-side BPE delta for the JSON `{ name, arguments }` payloads. */
  readonly requestTokensVsBaseline: number
  readonly measuredTokensVsBaseline: number
  /** Host-visible `tools/list` BPE delta when both targets supplied a manifest. */
  readonly manifestBpeVsBaseline?: number
}

/** The comparison for one shared task: every target's row, plus each non-baseline target's deltas. */
export interface TaskContrast {
  readonly task: string
  readonly baseline: string
  readonly rows: readonly ComparisonResult[]
  readonly deltas: readonly TargetDelta[]
}

/** Explicit configuration for repeated cold-process comparison measurements. */
export interface ComparisonSeriesOptions {
  /** Full runs discarded before collection, to warm filesystem and executable caches. */
  readonly warmupRuns: number
  /** Full cold-process runs retained in the artifact. Ten is the minimum reviewable sample size. */
  readonly iterations: number
}

/** The raw warmups and retained samples of a reproducible comparison. */
export interface ComparisonSeries {
  readonly warmups: ReadonlyArray<ReadonlyArray<ComparisonResult>>
  readonly samples: ReadonlyArray<ReadonlyArray<ComparisonResult>>
}

/** A numeric distribution rendered in the artifact instead of a single potentially noisy observation. */
export interface MetricDistribution {
  readonly samples: number
  readonly min: number
  readonly median: number
  /** Nearest-rank p95; deterministic and meaningful even at the minimum sample size of ten. */
  readonly p95: number
  readonly max: number
}

/** Per-target, per-task summary across successful retained samples. */
export interface ComparisonSummary {
  readonly target: string
  readonly task: string
  readonly retainedRuns: number
  readonly successfulRuns: number
  readonly failedRuns: number
  readonly metrics: {
    readonly toolCalls: MetricDistribution
    readonly estimatedTokens: MetricDistribution
    readonly retries: MetricDistribution
    readonly failedCalls: MetricDistribution
    readonly requestBpe: MetricDistribution
    readonly responseBpe: MetricDistribution
    readonly requestCharacters: MetricDistribution
    readonly responseCharacters: MetricDistribution
    readonly latencyMs: MetricDistribution
  } | null
  readonly manifest: {
    readonly characters: MetricDistribution
    readonly bpe: MetricDistribution
    readonly coldStartMs: MetricDistribution
  } | null
  readonly memoryRssBytes: MetricDistribution | null
}

/**
 * Run every adapter (each spawns its target server) and collect the per-row results. SEQUENTIAL — each
 * spawned server drives a real Electron app, so we never run two at once. `connect` is injectable for
 * tests (a fake client); production spawns over stdio. Never throws: a failed run is an `ok:false` row.
 */
export async function runComparison(
  adapters: readonly TaskAdapter[],
  connect?: ConnectFn,
): Promise<ComparisonResult[]> {
  const results: ComparisonResult[] = []
  for (const adapter of adapters) {
    results.push(
      connect === undefined ? await runAdapter(adapter) : await runAdapter(adapter, connect),
    )
  }
  return results
}

/**
 * Run full adapter sets sequentially for warmups and retained iterations. Every adapter creates a fresh
 * MCP server and Electron process, so a retained row is a cold-process observation. The serial order
 * avoids overlapping Electron processes and makes the raw artifact easy to audit.
 */
export async function runComparisonSeries(
  adapters: readonly TaskAdapter[],
  options: ComparisonSeriesOptions,
  connect?: ConnectFn,
): Promise<ComparisonSeries> {
  if (!Number.isInteger(options.warmupRuns) || options.warmupRuns < 0) {
    throw new Error('warmupRuns must be a non-negative integer')
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error('iterations must be a positive integer')
  }
  const oneRun = async (): Promise<ComparisonResult[]> =>
    connect === undefined ? runComparison(adapters) : runComparison(adapters, connect)
  const warmups: ComparisonResult[][] = []
  for (let run = 0; run < options.warmupRuns; run += 1) warmups.push(await oneRun())
  const samples: ComparisonResult[][] = []
  for (let run = 0; run < options.iterations; run += 1) samples.push(await oneRun())
  return { warmups, samples }
}

/** Summarize a non-empty numeric series with a nearest-rank p95. */
export function summarizeDistribution(values: readonly number[]): MetricDistribution | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0)
  const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
  return {
    samples: sorted.length,
    min: sorted[0] ?? 0,
    median,
    p95,
    max: sorted.at(-1) ?? 0,
  }
}

/**
 * Group retained rows by target/task and summarize only successful samples. Failures remain visible via
 * `failedRuns`; silently treating them as zeros would make an unreliable target look artificially fast.
 */
export function summarizeComparisonSeries(series: ComparisonSeries): ComparisonSummary[] {
  const groups = new Map<string, ComparisonResult[]>()
  for (const run of series.samples) {
    for (const row of run) {
      const key = `${row.target}\u0000${row.task}`
      const group = groups.get(key) ?? []
      group.push(row)
      groups.set(key, group)
    }
  }
  return [...groups.values()].map((rows) => {
    const first = rows[0]
    if (first === undefined) throw new Error('comparison group unexpectedly empty')
    const successful = rows.filter((row) => row.ok)
    const metric = (selector: (row: ComparisonResult) => number): MetricDistribution | null =>
      summarizeDistribution(successful.map(selector))
    const required = <T>(value: T | null, label: string): T => {
      if (value === null) throw new Error(`missing ${label} despite a successful comparison row`)
      return value
    }
    const manifests = successful.flatMap((row) => (row.manifest === null ? [] : [row.manifest]))
    const manifest =
      manifests.length === 0
        ? null
        : {
            characters: required(
              summarizeDistribution(manifests.map((item) => item.characters)),
              'manifest characters',
            ),
            bpe: required(summarizeDistribution(manifests.map((item) => item.bpe)), 'manifest BPE'),
            coldStartMs: required(
              summarizeDistribution(manifests.map((item) => item.coldStartMs)),
              'manifest cold-start time',
            ),
          }
    const memoryValues = successful.flatMap((row) =>
      row.memoryRssBytes === null ? [] : [row.memoryRssBytes],
    )
    const toolCalls = metric((row) => row.toolCalls)
    return {
      target: first.target,
      task: first.task,
      retainedRuns: rows.length,
      successfulRuns: successful.length,
      failedRuns: rows.length - successful.length,
      metrics:
        toolCalls === null
          ? null
          : {
              toolCalls,
              estimatedTokens: required(
                metric((row) => row.estimatedTokens),
                'estimated tokens',
              ),
              retries: required(
                metric((row) => row.retries),
                'retries',
              ),
              failedCalls: required(
                metric((row) => row.failedCalls),
                'failed calls',
              ),
              requestBpe: required(
                metric((row) => row.requestTokens),
                'request BPE',
              ),
              responseBpe: required(
                metric((row) => row.measuredTokens),
                'response BPE',
              ),
              requestCharacters: required(
                metric((row) => row.requestCharacters),
                'request characters',
              ),
              responseCharacters: required(
                metric((row) => row.responseCharacters),
                'response characters',
              ),
              latencyMs: required(
                metric((row) => row.latencyMs),
                'latency',
              ),
            },
      manifest,
      memoryRssBytes: summarizeDistribution(memoryValues),
    }
  })
}

/**
 * Pure: group the comparison rows by task and, within each task, compute every non-baseline target's
 * deltas vs the baseline target. A task with no successful baseline row yields an empty `deltas` (its
 * rows are still reported); a failed non-baseline row is reported but contributes no delta.
 */
export function computeContrast(
  results: readonly ComparisonResult[],
  baseline: string,
): TaskContrast[] {
  const byTask = new Map<string, ComparisonResult[]>()
  for (const row of results) {
    const list = byTask.get(row.task) ?? []
    list.push(row)
    byTask.set(row.task, list)
  }
  const contrasts: TaskContrast[] = []
  for (const [task, rows] of byTask) {
    const base = rows.find((r) => r.target === baseline && r.ok)
    const deltas: TargetDelta[] = []
    if (base !== undefined) {
      for (const row of rows) {
        if (row.target === baseline || !row.ok) continue
        deltas.push({
          target: row.target,
          toolCallsVsBaseline: row.toolCalls - base.toolCalls,
          estimatedTokensVsBaseline: row.estimatedTokens - base.estimatedTokens,
          requestTokensVsBaseline: row.requestTokens - base.requestTokens,
          measuredTokensVsBaseline: row.measuredTokens - base.measuredTokens,
          ...(base.manifest !== null && row.manifest !== null
            ? { manifestBpeVsBaseline: row.manifest.bpe - base.manifest.bpe }
            : {}),
        })
      }
    }
    contrasts.push({ task, baseline, rows, deltas })
  }
  return contrasts
}
