/** Budget parsing, run summary, and the pure check. */

import { describe, expect, it } from 'vitest'

import { BudgetFileError, parseBudget, type Budget } from '../src/budget.js'
import { checkRun } from '../src/check.js'
import { compareRuns, renderCheckReport, renderComparison } from '../src/render.js'
import { median, summarizeLatencies, summarizeRun } from '../src/run.js'

import { measurement, run } from './helpers.js'

const budget: Budget = {
  thresholdPercent: 10,
  startup: { maxFirstWindowMs: 1000 },
  memory: {
    darwin: {
      metric: 'footprint',
      perTypeMb: { main: 100, renderer: 90 },
      totalWithoutGpuMb: 200,
    },
  },
  mainThread: { maxBlockedPercent: 5, maxStallMs: 100 },
  ipc: { probe: 'window.api.ping()', maxP99Ms: 15 },
}

describe('parseBudget', () => {
  it('accepts comments and rejects unknown keys', () => {
    expect(parseBudget({ $comment: 'x', startup: { maxFirstWindowMs: 5 } }).startup).toEqual({
      maxFirstWindowMs: 5,
    })
    expect(() => parseBudget({ startup: { maxFirstWindowMs: 5, typo: 1 } })).toThrow(
      BudgetFileError,
    )
    expect(() => parseBudget({ memory: { darwin: { metric: 'rss' } } })).toThrow(/memory\.darwin/)
  })

  it('rejects two bundle entries that share an id', () => {
    const entries = [
      { path: 'dist', extensions: ['.js'], maxKb: 500 },
      { path: 'dist', extensions: ['.css'], maxKb: 10 },
    ]
    expect(() => parseBudget({ bundle: { entries } })).toThrow(/duplicate bundle entry "dist"/)
  })
})

describe('summaries', () => {
  it('takes medians and nearest-rank percentiles', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 2])).toBe(3)
    expect(summarizeLatencies([])).toEqual({ count: 0, p50: 0, p95: 0, p99: 0, max: 0 })
    const latency = summarizeLatencies(Array.from({ length: 100 }, (_, i) => i + 1))
    expect(latency).toMatchObject({ count: 100, p50: 50, p99: 99, max: 100 })
  })

  it('sums processes per type and takes the median across rounds of a phase', () => {
    const rows = summarizeRun(
      run([
        ['cold', measurement(150)],
        ['warm', measurement(80)],
        ['warm', measurement(90)],
        ['warm', measurement(120)],
      ]),
    )
    const row = (id: string, phase: string) => rows.find((r) => r.id === id && r.phase === phase)
    expect(row('memory.main', 'warm')).toMatchObject({ value: 90, metric: 'footprint', samples: 3 })
    expect(row('memory.main', 'cold')?.value).toBe(150)
    expect(row('memory.renderer', 'warm')?.value).toBe(80)
    expect(row('memory.totalWithoutGpu', 'warm')?.value).toBe(170)
    expect(row('memory.total', 'warm')?.value).toBe(570)
  })

  it('never undercounts a type or a total when a pid was not readable', () => {
    const partial = measurement(80, {
      memory: {
        metric: 'footprint',
        processes: [
          { pid: 1, type: 'main', workingSetMb: 500 },
          { pid: 2, type: 'renderer', mb: 60, workingSetMb: 80 },
          { pid: 3, type: 'gpu', mb: 50, workingSetMb: 50 },
        ],
      },
    })
    const rows = summarizeRun(run([['warm', partial]]))
    const ids = rows.filter((row) => row.metric === 'footprint').map((row) => row.id)
    expect(ids).toContain('memory.renderer')
    expect(ids).not.toContain('memory.main')
    expect(ids).not.toContain('memory.totalWithoutGpu')
    expect(ids).not.toContain('memory.total')
    // Every pid has a working set, so that metric still totals.
    const workingSet = rows.filter((row) => row.metric === 'workingSet')
    expect(workingSet.find((row) => row.id === 'memory.total')?.value).toBe(630)
  })
})

describe('summarizeRun memory metric', () => {
  it('summarises the metric most rounds of a phase measured', () => {
    const fallback = measurement(90, {
      memory: { metric: 'workingSet', processes: [{ pid: 1, type: 'main', workingSetMb: 400 }] },
    })
    const rows = summarizeRun(
      run([
        ['warm', fallback],
        ['warm', measurement(90)],
        ['warm', measurement(110)],
      ]),
    )
    expect(
      rows.find((row) => row.id === 'memory.main' && row.metric === 'footprint'),
    ).toMatchObject({ value: 100, samples: 2 })
  })
})

describe('checkRun', () => {
  const rounds = [
    ['cold', measurement(150)],
    ['warm', measurement(90)],
  ] as const

  it('passes within budget and reports GPU without gating it', () => {
    const report = checkRun(run(rounds), budget)
    expect(report.passed).toBe(true)
    expect(report.summary).toEqual({ pass: 7, fail: 0, unmeasured: 0 })
    expect(report.results.map((r) => r.id)).not.toContain('memory.gpu')
    expect(report.results.find((r) => r.id === 'memory.main')).toMatchObject({
      actual: 90,
      limit: 100,
      allowed: 110,
      phase: 'warm',
      metric: 'footprint',
    })
  })

  it('applies the tolerance, and --strict removes it', () => {
    const over = run([
      ['cold', measurement(150)],
      ['warm', measurement(105)],
    ])
    expect(checkRun(over, budget).passed).toBe(true)
    const strict = checkRun(over, budget, { strict: true })
    expect(strict).toMatchObject({ passed: false, reason: 'OVER_BUDGET' })
    expect(strict.results.find((r) => r.id === 'memory.main')?.status).toBe('fail')
  })

  it('compares the unrounded value, not the displayed one', () => {
    const justOver = run([['cold', measurement(90, { startup: { firstWindowMs: 1000.04 } })]])
    const result = checkRun(justOver, budget, { strict: true }).results.find(
      (r) => r.id === 'startup.firstWindowMs',
    )
    expect(result).toMatchObject({ actual: 1000, status: 'fail' })
  })

  it('never compares megabytes of a different metric', () => {
    const workingSet = measurement(90)
    const other = run([
      ['cold', workingSet],
      ['warm', { ...workingSet, memory: { metric: 'workingSet', processes: [] } }],
    ])
    const result = checkRun(other, budget).results.find((r) => r.id === 'memory.main')
    expect(result?.status).toBe('unmeasured')
  })

  it('reports an unmeasured metric and fails it only under requireMeasurement', () => {
    const without = { ipc: undefined, unavailable: { ipc: 'renderer eval is off' } }
    const noIpc = run([
      ['cold', measurement(150, without)],
      ['warm', measurement(90, without)],
    ])
    const lenient = checkRun(noIpc, budget)
    expect(lenient.passed).toBe(true)
    expect(lenient.results.find((r) => r.id === 'ipc.p99Ms')).toMatchObject({
      status: 'unmeasured',
      detail: 'renderer eval is off',
    })
    expect(checkRun(noIpc, budget, { requireMeasurement: true })).toMatchObject({
      passed: false,
      reason: 'UNMEASURED',
    })
  })

  it('fails when nothing was measured or nothing was budgeted', () => {
    expect(checkRun(run([]), budget)).toMatchObject({ passed: false, reason: 'NO_MEASUREMENTS' })
    expect(checkRun(run(rounds), {})).toMatchObject({ passed: false, reason: 'NO_EXPECTATIONS' })
    // A linux run has no memory block in this budget, so memory is simply not checked.
    const linux = checkRun(run(rounds, { platform: 'linux' }), budget)
    expect(linux.results.some((r) => r.id.startsWith('memory.'))).toBe(false)
  })

  it('reads every metric from one phase when asked', () => {
    const live = checkRun(run([['live', measurement(90)]]), budget, { phase: 'live' })
    expect(live.passed).toBe(true)
    expect(live.results.every((r) => r.phase === 'live')).toBe(true)
  })

  it('renders the report and a comparison with the metric named', () => {
    const text = renderCheckReport(checkRun(run(rounds), budget, { strict: true }))
    expect(text).toContain('Budget check: PASS')
    expect(text).toContain('| memory.main (warm) [footprint] | 90 MB | 100 MB | 100 MB | pass |')

    const rows = compareRuns(run([['warm', measurement(100)]]), run([['warm', measurement(80)]]))
    expect(rows.find((r) => r.id === 'memory.main')).toMatchObject({
      before: 100,
      after: 80,
      deltaPercent: -20,
    })
    expect(renderComparison(rows)).toContain(
      '| memory.main (warm) [footprint] | 100 MB | 80 MB | -20% |',
    )
  })
})
