/**
 * Compare a run to a budget. Pure: no I/O, no Electron.
 *
 * @module
 */

import { PROCESS_TYPES, type Budget, type Phase } from './budget.js'
import { summarizeRun, type BudgetRun, type SummaryRow } from './run.js'

export type CheckStatus = 'pass' | 'fail' | 'unmeasured'

export interface CheckResult {
  readonly id: string
  readonly status: CheckStatus
  readonly unit: SummaryRow['unit']
  readonly limit: number
  /** `limit` plus the tolerance; the value that actually gates. */
  readonly allowed: number
  readonly actual?: number
  readonly phase?: Phase
  readonly metric?: string
  /** Why it is unmeasured. */
  readonly detail?: string
}

export interface CheckReport {
  /** False on any failure, and always false when nothing at all was measured. */
  readonly passed: boolean
  readonly reason?: 'NO_EXPECTATIONS' | 'NO_MEASUREMENTS' | 'UNMEASURED' | 'OVER_BUDGET'
  readonly summary: { readonly pass: number; readonly fail: number; readonly unmeasured: number }
  readonly results: readonly CheckResult[]
}

export interface CheckOptions {
  /** Ignore every `thresholdPercent`: the limit itself gates. */
  readonly strict?: boolean
  /** Treat a budgeted metric the run did not measure as a failure. */
  readonly requireMeasurement?: boolean
  /** Read every metric from this phase instead of the budget's own phases. */
  readonly phase?: Phase
}

interface Expectation {
  readonly id: string
  readonly section: 'startup' | 'memory' | 'mainThread' | 'ipc' | 'bundle'
  readonly unit: SummaryRow['unit']
  readonly limit: number
  readonly thresholdPercent: number
  /** Undefined: any phase the run has, preferring warm, then live, then cold. */
  readonly phase?: Phase
  readonly metric?: string
}

const ANY_PHASE_ORDER: readonly Phase[] = ['warm', 'live', 'cold']

function expectations(budget: Budget, platform: string, options: CheckOptions): Expectation[] {
  const list: Expectation[] = []
  const tolerance = (own: number | undefined): number =>
    options.strict === true ? 0 : (own ?? budget.thresholdPercent ?? 0)

  if (budget.startup !== undefined) {
    list.push({
      id: 'startup.firstWindowMs',
      section: 'startup',
      unit: 'ms',
      limit: budget.startup.maxFirstWindowMs,
      thresholdPercent: tolerance(budget.startup.thresholdPercent),
      phase: options.phase ?? budget.startup.phase ?? 'cold',
    })
  }

  const memory = budget.memory?.[platform as keyof NonNullable<Budget['memory']>]
  if (memory !== undefined) {
    const base = {
      section: 'memory',
      unit: 'MB',
      thresholdPercent: tolerance(memory.thresholdPercent),
      phase: options.phase ?? memory.phase ?? 'warm',
      metric: memory.metric,
    } as const
    for (const type of PROCESS_TYPES) {
      const max = memory.perTypeMb?.[type]
      if (max !== undefined) list.push({ ...base, id: `memory.${type}`, limit: max })
    }
    if (memory.totalWithoutGpuMb !== undefined) {
      list.push({ ...base, id: 'memory.totalWithoutGpu', limit: memory.totalWithoutGpuMb })
    }
    if (memory.totalMb !== undefined) {
      list.push({ ...base, id: 'memory.total', limit: memory.totalMb })
    }
  }

  const mainThread = budget.mainThread
  if (mainThread !== undefined) {
    const base = {
      section: 'mainThread',
      thresholdPercent: tolerance(mainThread.thresholdPercent),
      ...(options.phase === undefined ? {} : { phase: options.phase }),
    } as const
    if (mainThread.maxBlockedPercent !== undefined) {
      list.push({
        ...base,
        id: 'mainThread.blockedPercent',
        unit: '%',
        limit: mainThread.maxBlockedPercent,
      })
    }
    if (mainThread.maxStallMs !== undefined) {
      list.push({ ...base, id: 'mainThread.maxStallMs', unit: 'ms', limit: mainThread.maxStallMs })
    }
  }

  const ipc = budget.ipc
  if (ipc !== undefined) {
    const base = {
      section: 'ipc',
      unit: 'ms',
      thresholdPercent: tolerance(ipc.thresholdPercent),
      ...(options.phase === undefined ? {} : { phase: options.phase }),
    } as const
    if (ipc.maxP95Ms !== undefined) list.push({ ...base, id: 'ipc.p95Ms', limit: ipc.maxP95Ms })
    if (ipc.maxP99Ms !== undefined) list.push({ ...base, id: 'ipc.p99Ms', limit: ipc.maxP99Ms })
  }

  for (const entry of budget.bundle?.entries ?? []) {
    list.push({
      id: `bundle.${entry.name ?? entry.path}`,
      section: 'bundle',
      unit: 'KB',
      limit: entry.maxKb,
      thresholdPercent: tolerance(budget.bundle?.thresholdPercent),
    })
  }
  return list
}

function findRow(rows: readonly SummaryRow[], expectation: Expectation): SummaryRow | undefined {
  const candidates = rows.filter(
    (row) =>
      row.id === expectation.id &&
      (expectation.metric === undefined || row.metric === expectation.metric),
  )
  if (expectation.section === 'bundle') return candidates[0]
  if (expectation.phase !== undefined) {
    return candidates.find((row) => row.phase === expectation.phase)
  }
  for (const phase of ANY_PHASE_ORDER) {
    const row = candidates.find((candidate) => candidate.phase === phase)
    if (row !== undefined) return row
  }
  return undefined
}

function unmeasuredDetail(run: BudgetRun, expectation: Expectation): string {
  if (expectation.section === 'bundle') {
    const id = expectation.id.slice('bundle.'.length)
    const entry = run.bundle?.entries.find((candidate) => candidate.id === id)
    return entry?.unavailable ?? 'the run has no measurement for this bundle entry'
  }
  const rounds = run.rounds.filter(
    (round) => expectation.phase === undefined || round.phase === expectation.phase,
  )
  if (rounds.length === 0) {
    return expectation.phase === undefined
      ? 'the run has no rounds'
      : `the run has no ${expectation.phase} round`
  }
  if (expectation.section === 'memory') {
    const measured = rounds.map((round) => round.measurement.memory?.metric).find(Boolean)
    // Megabytes in another metric are a different quantity, never a comparable one.
    if (measured !== undefined && measured !== expectation.metric) {
      return `the run measured ${measured}, the budget names ${expectation.metric}`
    }
  }
  if (expectation.section === 'ipc' && rounds.some((r) => r.measurement.ipc?.count === 0)) {
    return 'the IPC probe completed no round trip'
  }
  const reason = rounds
    .map((round) => round.measurement.unavailable?.[expectation.section])
    .find((value) => value !== undefined)
  return reason ?? `the run did not measure ${expectation.id}`
}

/** Compare `run` to `budget` for the platform the run was measured on. */
export function checkRun(run: BudgetRun, budget: Budget, options: CheckOptions = {}): CheckReport {
  const rows = summarizeRun(run)
  const results = expectations(budget, run.platform, options).map((expectation): CheckResult => {
    // Divide last: 200 * (1 + 15 / 100) is 229.99999999999997, which would fail a 230.
    const exactAllowed = (expectation.limit * (100 + expectation.thresholdPercent)) / 100
    const allowed = Math.round(exactAllowed * 10) / 10
    const base = {
      id: expectation.id,
      unit: expectation.unit,
      limit: expectation.limit,
      allowed,
      ...(expectation.phase === undefined ? {} : { phase: expectation.phase }),
      ...(expectation.metric === undefined ? {} : { metric: expectation.metric }),
    }
    const row = findRow(rows, expectation)
    if (row === undefined) {
      return { ...base, status: 'unmeasured', detail: unmeasuredDetail(run, expectation) }
    }
    return {
      ...base,
      ...(row.phase === undefined ? {} : { phase: row.phase }),
      status: row.exact <= exactAllowed ? 'pass' : 'fail',
      actual: row.value,
    }
  })

  const count = (status: CheckStatus): number =>
    results.filter((result) => result.status === status).length
  const summary = { pass: count('pass'), fail: count('fail'), unmeasured: count('unmeasured') }
  const reason =
    results.length === 0
      ? 'NO_EXPECTATIONS'
      : summary.fail > 0
        ? 'OVER_BUDGET'
        : summary.pass === 0
          ? 'NO_MEASUREMENTS'
          : options.requireMeasurement === true && summary.unmeasured > 0
            ? 'UNMEASURED'
            : undefined
  return {
    passed: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
    summary,
    results,
  }
}
