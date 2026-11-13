/**
 * Markdown tables for a check report and for a before/after comparison.
 *
 * @module
 */

import type { CheckReport } from './check.js'
import { summarizeRun, type BudgetRun, type SummaryRow } from './run.js'

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n')
}

const label = (id: string, phase: string | undefined, metric: string | undefined): string =>
  [id, phase === undefined ? '' : `(${phase})`, metric === undefined ? '' : `[${metric}]`]
    .filter((part) => part.length > 0)
    .join(' ')

export function renderCheckReport(report: CheckReport): string {
  const verdict = report.passed ? 'PASS' : `FAIL (${report.reason ?? 'OVER_BUDGET'})`
  const { pass, fail, unmeasured } = report.summary
  const rows = report.results.map((result) => [
    label(result.id, result.phase, result.metric),
    result.actual === undefined ? '-' : `${result.actual} ${result.unit}`,
    `${result.limit} ${result.unit}`,
    `${result.allowed} ${result.unit}`,
    result.status + (result.detail === undefined ? '' : `: ${result.detail}`),
  ])
  return [
    `Budget check: ${verdict} - ${pass} pass, ${fail} fail, ${unmeasured} unmeasured`,
    '',
    table(['metric', 'actual', 'budget', 'allowed', 'status'], rows),
  ].join('\n')
}

export interface ComparisonRow {
  readonly id: string
  readonly phase?: SummaryRow['phase']
  readonly unit: SummaryRow['unit']
  readonly metric?: string
  readonly before?: number
  readonly after?: number
  readonly deltaPercent?: number
}

/** Pair the rows of two runs. A memory row measured with different metrics is left unpaired. */
export function compareRuns(before: BudgetRun, after: BudgetRun): ComparisonRow[] {
  const key = (row: SummaryRow): string => `${row.id}@${row.phase ?? ''}@${row.metric ?? ''}`
  const beforeRows = new Map(summarizeRun(before).map((row) => [key(row), row]))
  const afterRows = new Map(summarizeRun(after).map((row) => [key(row), row]))
  return [...new Set([...beforeRows.keys(), ...afterRows.keys()])].map((rowKey): ComparisonRow => {
    const a = beforeRows.get(rowKey)
    const b = afterRows.get(rowKey)
    const row = (a ?? b) as SummaryRow
    return {
      id: row.id,
      unit: row.unit,
      ...(row.phase === undefined ? {} : { phase: row.phase }),
      ...(row.metric === undefined ? {} : { metric: row.metric }),
      ...(a === undefined ? {} : { before: a.value }),
      ...(b === undefined ? {} : { after: b.value }),
      ...(a === undefined || b === undefined || a.value === 0
        ? {}
        : { deltaPercent: Math.round(((b.value - a.value) / a.value) * 1000) / 10 }),
    }
  })
}

export function renderComparison(rows: readonly ComparisonRow[]): string {
  const value = (amount: number | undefined, unit: string): string =>
    amount === undefined ? '-' : `${amount} ${unit}`
  return table(
    ['metric', 'before', 'after', 'delta'],
    rows.map((row) => [
      label(row.id, row.phase, row.metric),
      value(row.before, row.unit),
      value(row.after, row.unit),
      row.deltaPercent === undefined
        ? '-'
        : `${row.deltaPercent > 0 ? '+' : ''}${row.deltaPercent}%`,
    ]),
  )
}
