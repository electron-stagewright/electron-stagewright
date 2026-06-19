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
 * negative value means it spent less. Tokens are reported on both the server estimate and the
 * client-side BPE count, but only the BPE count (`measuredTokens`) is comparable across servers.
 */
export interface TargetDelta {
  readonly target: string
  readonly toolCallsVsBaseline: number
  readonly estimatedTokensVsBaseline: number
  readonly measuredTokensVsBaseline: number
}

/** The comparison for one shared task: every target's row, plus each non-baseline target's deltas. */
export interface TaskContrast {
  readonly task: string
  readonly baseline: string
  readonly rows: readonly ComparisonResult[]
  readonly deltas: readonly TargetDelta[]
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
          measuredTokensVsBaseline: row.measuredTokens - base.measuredTokens,
        })
      }
    }
    contrasts.push({ task, baseline, rows, deltas })
  }
  return contrasts
}
