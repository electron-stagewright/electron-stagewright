/** Shared run fixtures for the budget tests. */

import type { Measurement, BudgetRun } from '../src/run.js'
import { RUN_FORMAT, RUN_SCHEMA_VERSION } from '../src/run.js'
import type { Phase } from '../src/budget.js'

export function measurement(mainMb: number, overrides: Partial<Measurement> = {}): Measurement {
  return {
    startup: { firstWindowMs: 900 },
    memory: {
      metric: 'footprint',
      processes: [
        { pid: 1, type: 'main', mb: mainMb, workingSetMb: mainMb + 30 },
        { pid: 2, type: 'renderer', mb: 60, workingSetMb: 80 },
        { pid: 3, type: 'renderer', mb: 20, workingSetMb: 30 },
        { pid: 4, type: 'gpu', mb: 400, workingSetMb: 120 },
      ],
    },
    mainThread: {
      windowMs: 5000,
      blockedMs: 50,
      blockedPercent: 1,
      maxStallMs: 40,
      stallsOver50Ms: 0,
      stallsOver100Ms: 0,
    },
    ipc: { count: 100, p50: 1, p95: 3, p99: 6, max: 9 },
    ...overrides,
  }
}

export function run(
  rounds: readonly (readonly [Phase, Measurement])[],
  extra: Partial<BudgetRun> = {},
): BudgetRun {
  return {
    format: RUN_FORMAT,
    schema_version: RUN_SCHEMA_VERSION,
    created_at: '2026-01-01T00:00:00.000Z',
    platform: 'darwin',
    arch: 'arm64',
    rounds: rounds.map(([phase, m], index) => ({ round: index + 1, phase, measurement: m })),
    ...extra,
  }
}
