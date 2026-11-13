/**
 * The run document: raw measurements of one build, and the flat summary `check` and `compare` read.
 *
 * @module
 */

import { readFile } from 'node:fs/promises'

import { z } from 'zod'

import { MEMORY_METRICS, PHASES, PROCESS_TYPES, type Phase, type ProcessType } from './budget.js'

export const RUN_FORMAT = 'electron-stagewright-budget-run'
export const RUN_SCHEMA_VERSION = 1

const stallSchema = z.object({
  windowMs: z.number(),
  blockedMs: z.number(),
  blockedPercent: z.number(),
  maxStallMs: z.number(),
  stallsOver50Ms: z.number(),
  stallsOver100Ms: z.number(),
})

const latencySchema = z.object({
  count: z.number(),
  p50: z.number(),
  p95: z.number(),
  p99: z.number(),
  max: z.number(),
})

const processSchema = z.object({
  pid: z.number(),
  type: z.enum(PROCESS_TYPES),
  name: z.string().optional(),
  // In the run's `metric`; absent when the OS reader could not see this pid.
  mb: z.number().optional(),
  workingSetMb: z.number(),
})

const memorySchema = z.object({
  metric: z.enum(MEMORY_METRICS),
  processes: z.array(processSchema),
})

const measurementSchema = z.object({
  startup: z.object({ firstWindowMs: z.number() }).optional(),
  memory: memorySchema.optional(),
  mainThread: stallSchema.optional(),
  ipc: latencySchema.optional(),
  // Why a requested metric is missing, keyed by `startup` / `memory` / `mainThread` / `ipc`.
  unavailable: z.record(z.string(), z.string()).optional(),
})

const bundleEntrySchema = z.object({
  id: z.string(),
  path: z.string(),
  gzip: z.boolean(),
  files: z.number(),
  bytes: z.number(),
  unavailable: z.string().optional(),
})

export const runSchema = z.object({
  format: z.literal(RUN_FORMAT),
  schema_version: z.literal(RUN_SCHEMA_VERSION),
  created_at: z.string(),
  platform: z.string(),
  arch: z.string(),
  electron_version: z.string().optional(),
  label: z.string().optional(),
  rounds: z.array(
    z.object({ round: z.number(), phase: z.enum(PHASES), measurement: measurementSchema }),
  ),
  bundle: z.object({ entries: z.array(bundleEntrySchema) }).optional(),
})

export type StallSummary = z.infer<typeof stallSchema>
export type LatencySummary = z.infer<typeof latencySchema>
export type ProcessMemory = z.infer<typeof processSchema>
export type MemoryMeasurement = z.infer<typeof memorySchema>
export type Measurement = z.infer<typeof measurementSchema>
export type BundleEntryMeasurement = z.infer<typeof bundleEntrySchema>
export type BudgetRun = z.infer<typeof runSchema>

/** A run file that is missing or is not a run document. */
export class RunFileError extends Error {
  constructor(
    message: string,
    readonly runPath: string,
  ) {
    super(message)
    this.name = 'RunFileError'
  }
}

export async function loadRun(runPath: string): Promise<BudgetRun> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(runPath, 'utf8'))
  } catch (error) {
    throw new RunFileError(
      `Cannot read run file ${runPath}: ${error instanceof Error ? error.message : String(error)}`,
      runPath,
    )
  }
  const parsed = runSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new RunFileError(`${runPath} is not a ${RUN_FORMAT} document: ${issues}`, runPath)
  }
  return parsed.data
}

export function createRun(
  fields: Pick<BudgetRun, 'rounds'> &
    Partial<Pick<BudgetRun, 'bundle' | 'label'>> & {
      readonly electronVersion?: string
      readonly now?: Date
    },
): BudgetRun {
  return {
    format: RUN_FORMAT,
    schema_version: RUN_SCHEMA_VERSION,
    created_at: (fields.now ?? new Date()).toISOString(),
    platform: process.platform,
    arch: process.arch,
    ...(fields.electronVersion === undefined ? {} : { electron_version: fields.electronVersion }),
    ...(fields.label === undefined ? {} : { label: fields.label }),
    rounds: fields.rounds,
    ...(fields.bundle === undefined ? {} : { bundle: fields.bundle }),
  }
}

const round1 = (value: number): number => Math.round(value * 10) / 10

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle] ?? 0
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2
}

/** Nearest-rank percentiles; an empty set reports zeros with `count: 0`. */
export function summarizeLatencies(samples: readonly number[]): LatencySummary {
  const sorted = samples.filter(Number.isFinite).sort((a, b) => a - b)
  const at = (percentile: number): number =>
    round1(
      sorted[Math.min(sorted.length - 1, Math.ceil((percentile / 100) * sorted.length) - 1)] ?? 0,
    )
  return { count: sorted.length, p50: at(50), p95: at(95), p99: at(99), max: at(100) }
}

/**
 * Megabytes per process type for one memory sample, in the sample's metric. A type with a pid the
 * OS reader could not see is left out rather than undercounted.
 */
export function memoryByType(memory: MemoryMeasurement): Partial<Record<ProcessType, number>> {
  const totals: Partial<Record<ProcessType, number>> = {}
  const partial = new Set<ProcessType>()
  for (const entry of memory.processes) {
    const mb = memory.metric === 'workingSet' ? entry.workingSetMb : entry.mb
    if (mb === undefined) partial.add(entry.type)
    else totals[entry.type] = (totals[entry.type] ?? 0) + mb
  }
  for (const type of partial) delete totals[type]
  return totals
}

/** Sum of every type the sample holds, or undefined when one of them is unmeasured or none exist. */
function memoryTotal(memory: MemoryMeasurement, skipGpu: boolean): number | undefined {
  const types = new Set(memory.processes.map((entry) => entry.type))
  if (skipGpu) types.delete('gpu')
  if (types.size === 0) return undefined
  const totals = memoryByType(memory)
  let sum = 0
  for (const type of types) {
    const mb = totals[type]
    if (mb === undefined) return undefined
    sum += mb
  }
  return sum
}

/** One summarised value: the median over the rounds of one phase. */
export interface SummaryRow {
  readonly id: string
  readonly phase?: Phase
  readonly value: number
  /** The unrounded median, which a check compares; `value` is for display. */
  readonly exact: number
  readonly unit: 'ms' | 'MB' | '%' | 'KB'
  /** The memory metric, so a table never shows megabytes without naming what they count. */
  readonly metric?: string
  readonly samples: number
}

/** Flatten a run into comparable rows (`memory.main`, `ipc.p99Ms`, `bundle.<id>`, ...). */
export function summarizeRun(run: BudgetRun): SummaryRow[] {
  const rows: SummaryRow[] = []
  for (const phase of PHASES) {
    const measurements = run.rounds.filter((r) => r.phase === phase).map((r) => r.measurement)
    const push = (
      id: string,
      unit: SummaryRow['unit'],
      values: readonly (number | undefined)[],
      metric?: string,
    ): void => {
      const present = values.filter((value): value is number => value !== undefined)
      if (present.length === 0) return
      const exact = median(present)
      rows.push({
        id,
        phase,
        value: round1(exact),
        exact,
        unit,
        ...(metric === undefined ? {} : { metric }),
        samples: present.length,
      })
    }

    push(
      'startup.firstWindowMs',
      'ms',
      measurements.map((m) => m.startup?.firstWindowMs),
    )

    const memories = measurements.flatMap((m) => (m.memory === undefined ? [] : [m.memory]))
    // Rounds whose OS reader failed fall back to another metric; the majority one is summarised.
    const counts = new Map<string, number>()
    for (const memory of memories) counts.set(memory.metric, (counts.get(memory.metric) ?? 0) + 1)
    let primary: MemoryMeasurement['metric'] | undefined
    for (const { metric } of memories) {
      if (primary === undefined || (counts.get(metric) ?? 0) > (counts.get(primary) ?? 0)) {
        primary = metric
      }
    }
    // Working set is always recorded, so a budget may name it on any platform.
    for (const metric of new Set([primary, 'workingSet'] as const)) {
      if (metric === undefined) continue
      const sameMetric = memories
        .filter((memory) => memory.metric === primary)
        .map((memory) => ({ ...memory, metric }))
      const byType = sameMetric.map(memoryByType)
      for (const type of PROCESS_TYPES) {
        push(
          `memory.${type}`,
          'MB',
          byType.map((totals) => totals[type]),
          metric,
        )
      }
      push(
        'memory.totalWithoutGpu',
        'MB',
        sameMetric.map((memory) => memoryTotal(memory, true)),
        metric,
      )
      push(
        'memory.total',
        'MB',
        sameMetric.map((memory) => memoryTotal(memory, false)),
        metric,
      )
    }

    push(
      'mainThread.blockedPercent',
      '%',
      measurements.map((m) => m.mainThread?.blockedPercent),
    )
    push(
      'mainThread.maxStallMs',
      'ms',
      measurements.map((m) => m.mainThread?.maxStallMs),
    )
    const ipc = measurements.flatMap((m) => (m.ipc !== undefined && m.ipc.count > 0 ? [m.ipc] : []))
    push(
      'ipc.p95Ms',
      'ms',
      ipc.map((latency) => latency.p95),
    )
    push(
      'ipc.p99Ms',
      'ms',
      ipc.map((latency) => latency.p99),
    )
  }
  for (const entry of run.bundle?.entries ?? []) {
    if (entry.unavailable !== undefined) continue
    rows.push({
      id: `bundle.${entry.id}`,
      value: round1(entry.bytes / 1024),
      exact: entry.bytes / 1024,
      unit: 'KB',
      ...(entry.gzip ? { metric: 'gzip' } : {}),
      samples: 1,
    })
  }
  return rows
}
