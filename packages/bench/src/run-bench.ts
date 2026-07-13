/**
 * Benchmark runner. Runs every scenario over the real MCP protocol, prints a
 * human-readable table + a token-economy delta to stderr, and writes a machine-readable
 * JSON report to stdout (and to a file when `--json <path>` is given). Exits non-zero if
 * any scenario fails unexpectedly.
 *
 * Human output goes to stderr and the JSON report to stdout, so `pnpm bench > report.json`
 * captures the machine report while the table stays visible. (The MCP protocol travels on
 * the spawned server child's own stdio, never this process's stdout.)
 *
 * Run (after `pnpm install` + `pnpm build` at the repo root):
 *   pnpm bench               # or: pnpm --filter @electron-stagewright/bench bench
 *   pnpm bench --json out.json
 *
 * @module
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { comparisonAdapters } from './adapters.js'
import {
  computeContrast,
  runComparisonSeries,
  summarizeComparisonSeries,
  type ComparisonSummary,
  type TaskContrast,
} from './comparison.js'
import {
  runScenario,
  STAGEWRIGHT_TARGET,
  type ComparableTask,
  type ComparisonResult,
  type ScenarioResult,
} from './harness.js'
import { collectComparisonProvenance } from './provenance.js'
import { SCENARIOS } from './scenarios.js'
import {
  checkThresholds,
  deriveThresholds,
  DEFAULT_CONTRASTS,
  DEFAULT_THRESHOLDS,
  type Contrast,
  type ThresholdViolation,
} from './thresholds.js'

/** Schema version of the scenario JSON report; bump when the shape changes (for regression tooling). */
const REPORT_SCHEMA_VERSION = 3

/** Schema version of the `--compare` JSON report (its own shape, versioned independently). */
const COMPARISON_SCHEMA_VERSION = 2

/** The machine-readable report written to stdout / the --json file. */
interface BenchReport {
  readonly schema_version: number
  readonly generated_at: string
  readonly env: { readonly node: string; readonly platform: string; readonly arch: string }
  readonly results: ReadonlyArray<ScenarioResult>
  /** Regression-threshold outcome for the deterministic metrics (tool-call counts + savings). */
  readonly thresholds: {
    readonly passed: boolean
    readonly violations: ReadonlyArray<ThresholdViolation>
  }
}

/** Print one line to stderr (the human channel; stdout carries the JSON report). */
function log(line: string): void {
  process.stderr.write(`${line}\n`)
}

/** Resolve a `--json <path>` argument. Warns (and ignores) if the path is missing. */
function jsonOutPath(argv: readonly string[]): string | undefined {
  const i = argv.indexOf('--json')
  if (i < 0) return undefined
  const next = argv[i + 1]
  if (next === undefined || next.length === 0 || next.startsWith('--')) {
    log('warning: --json was given without a file path; the JSON report goes to stdout only.')
    return undefined
  }
  return next
}

function mib(bytes: number | null): string {
  return bytes == null ? '   n/a' : `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

/** Render an observed millisecond measure without inventing a value for absent data. */
function milliseconds(value: number | undefined): string {
  return value === undefined ? 'n/a' : `${value.toFixed(0)}ms`
}

/** Render the results as a fixed-width table to stderr. */
function printTable(results: ReadonlyArray<ScenarioResult>): void {
  log('\nBenchmark results (est = char/4 heuristic, real = BPE via gpt-tokenizer)')
  log('─'.repeat(96))
  log(
    `  ${'scenario'.padEnd(28)} ${'calls'.padStart(5)} ${'est tok'.padStart(8)} ${'real tok'.padStart(8)} ${'latency'.padStart(9)} ${'memory'.padStart(8)}  result`,
  )
  for (const r of results) {
    const verdict = r.ok ? 'ok' : `FAIL: ${r.error ?? ''}`
    log(
      `  ${r.name.padEnd(28)} ${String(r.toolCalls).padStart(5)} ${String(r.estimatedTokens).padStart(8)} ${String(r.measuredTokens).padStart(8)} ${`${r.latencyMs.toFixed(0)}ms`.padStart(9)} ${mib(r.memoryRssBytes).padStart(8)}  ${verdict}`,
    )
  }
}

/** The same-task contrasts the runner reports + thresholds-checks (shared with the pure checker). */
const CONTRASTS: ReadonlyArray<Contrast> = DEFAULT_CONTRASTS

/** Print each same-task contrast's saving in tool calls and tokens (estimated + real). */
function printDeltas(results: ReadonlyArray<ScenarioResult>): void {
  log('\nToken-economy deltas (same task, agent-native primitive vs the naive path)')
  for (const c of CONTRASTS) {
    const base = results.find((r) => r.name === c.baseline)
    const opt = results.find((r) => r.name === c.optimized)
    if (!base?.ok || !opt?.ok) continue
    const calls = base.toolCalls - opt.toolCalls
    const tokens = base.estimatedTokens - opt.estimatedTokens
    const pct = base.estimatedTokens > 0 ? Math.round((tokens / base.estimatedTokens) * 100) : 0
    const real = base.measuredTokens - opt.measuredTokens
    const realPct = base.measuredTokens > 0 ? Math.round((real / base.measuredTokens) * 100) : 0
    log(`  ${c.label}`)
    log(`    saved ${calls} tool call(s) and ${tokens} estimated tokens (${pct}% fewer).`)
    log(`    real tokenizer: saved ${real} BPE tokens (${realPct}% fewer).`)
  }
}

/** Print each regression-threshold violation to stderr. */
function printViolations(violations: ReadonlyArray<ThresholdViolation>): void {
  log('\nRegression thresholds')
  if (violations.length === 0) {
    log('  all deterministic metrics within thresholds.')
    return
  }
  for (const v of violations) log(`  REGRESSION [${v.kind}] ${v.message}`)
}

/** Read one non-negative integer CLI option without silently accepting a malformed artifact protocol. */
function parseNonNegativeInteger(
  argv: readonly string[],
  flag: string,
  defaultValue: number,
): number {
  const index = argv.indexOf(flag)
  if (index < 0) return defaultValue
  const raw = argv[index + 1]
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new Error(`${flag} expects a non-negative integer`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error(`${flag} is outside the safe integer range`)
  return value
}

/** Keep the one-run smoke useful, but mark it clearly as insufficient evidence for a comparison claim. */
function comparisonEvidenceTier(
  iterations: number,
  warmupRuns: number,
  summaries: readonly ComparisonSummary[],
): 'exploratory' | 'reviewable' {
  const allSucceeded =
    summaries.length > 0 && summaries.every((summary) => summary.failedRuns === 0)
  return iterations >= 10 && warmupRuns >= 1 && allSucceeded ? 'reviewable' : 'exploratory'
}

/** Convert per-target medians into the existing contrast shape for concise human reporting. */
function medianRows(summaries: readonly ComparisonSummary[]): ComparisonResult[] {
  return summaries.flatMap((summary) => {
    if (summary.metrics === null) return []
    return [
      {
        target: summary.target,
        task: summary.task,
        toolCalls: summary.metrics.toolCalls.median,
        estimatedTokens: summary.metrics.estimatedTokens.median,
        requestTokens: summary.metrics.requestBpe.median,
        measuredTokens: summary.metrics.responseBpe.median,
        requestCharacters: summary.metrics.requestCharacters.median,
        responseCharacters: summary.metrics.responseCharacters.median,
        failedCalls: summary.metrics.failedCalls.median,
        retries: summary.metrics.retries.median,
        latencyMs: summary.metrics.latencyMs.median,
        memoryRssBytes: summary.memoryRssBytes?.median ?? null,
        manifest:
          summary.manifest === null
            ? null
            : {
                characters: summary.manifest.characters.median,
                bpe: summary.manifest.bpe.median,
                coldStartMs: summary.manifest.coldStartMs.median,
              },
        ok: summary.failedRuns === 0,
        ...(summary.failedRuns > 0
          ? { error: `${summary.failedRuns} retained run(s) failed` }
          : {}),
      },
    ]
  })
}

/** Render median/p95 retained measurements, then each target's delta of medians vs the baseline. */
function printComparison(
  summaries: ReadonlyArray<ComparisonSummary>,
  contrasts: ReadonlyArray<TaskContrast>,
): void {
  log('\nCross-server comparison (retained medians; real tok = BPE via gpt-tokenizer)')
  log('─'.repeat(126))
  log(
    `  ${'task'.padEnd(18)} ${'target'.padEnd(16)} ${'runs'.padStart(7)} ${'calls'.padStart(7)} ${'req BPE'.padStart(8)} ${'resp BPE'.padStart(9)} ${'cold p50'.padStart(10)} ${'lat p95'.padStart(9)}  result`,
  )
  for (const summary of summaries) {
    const metrics = summary.metrics
    const verdict = summary.failedRuns === 0 ? 'ok' : `FAIL: ${summary.failedRuns} run(s)`
    log(
      `  ${summary.task.padEnd(18)} ${summary.target.padEnd(16)} ${`${summary.successfulRuns}/${summary.retainedRuns}`.padStart(7)} ${String(metrics?.toolCalls.median ?? 'n/a').padStart(7)} ${String(metrics?.requestBpe.median ?? 'n/a').padStart(8)} ${String(metrics?.responseBpe.median ?? 'n/a').padStart(9)} ${milliseconds(summary.manifest?.coldStartMs.median).padStart(10)} ${milliseconds(metrics?.latencyMs.p95).padStart(9)}  ${verdict}`,
    )
  }
  const withDeltas = contrasts.filter((c) => c.deltas.length > 0)
  if (withDeltas.length === 0) return
  log(
    '\nDeltas of per-target medians vs the baseline (target − baseline; positive = target spent MORE)',
  )
  for (const c of withDeltas) {
    log(`  ${c.task} (vs ${c.baseline})`)
    for (const d of c.deltas) {
      const sign = (n: number): string => (n >= 0 ? `+${n}` : `${n}`)
      log(
        `    ${d.target}: ${sign(d.toolCallsVsBaseline)} calls, ${sign(d.requestTokensVsBaseline)} request BPE, ${sign(d.measuredTokensVsBaseline)} response BPE, ${d.manifestBpeVsBaseline === undefined ? 'n/a' : `${sign(d.manifestBpeVsBaseline)} manifest BPE`}`,
      )
    }
  }
}

/** The `--compare` machine report (its own shape; `comparison` block, independently versioned). */
interface ComparisonReport {
  readonly schema_version: number
  readonly generated_at: string
  readonly comparison: {
    readonly baseline: string
    /** `reviewable` needs at least ten successful retained runs after a warmup; it is not a public claim. */
    readonly evidence_tier: 'exploratory' | 'reviewable'
    readonly protocol: {
      readonly execution: 'sequential-fresh-processes'
      readonly warmup_runs: number
      readonly retained_iterations: number
    }
    readonly provenance: Awaited<ReturnType<typeof collectComparisonProvenance>>
    readonly tasks: ReadonlyArray<
      Omit<ComparableTask, 'oracle'> & { readonly oracle: NonNullable<ComparableTask['oracle']> }
    >
    /** Warmups are retained for audit but excluded from distributions. */
    readonly warmups: ReadonlyArray<ReadonlyArray<ComparisonResult>>
    /** Every retained per-process observation; summaries never hide an individual failure. */
    readonly samples: ReadonlyArray<ReadonlyArray<ComparisonResult>>
    readonly summaries: ReadonlyArray<ComparisonSummary>
    readonly contrasts: ReadonlyArray<TaskContrast>
  }
}

/**
 * `--compare` mode: drive the pinned baseline and competitor adapters through repeated fresh processes,
 * contrast their retained medians, print the table, and emit a reproducible JSON artifact. Distinct
 * from the default scenario run.
 */
async function runCompareMode(argv: readonly string[]): Promise<void> {
  const warmupRuns = parseNonNegativeInteger(argv, '--compare-warmup', 2)
  const iterations = parseNonNegativeInteger(argv, '--compare-iterations', 10)
  if (iterations < 1) throw new Error('--compare-iterations must be at least 1')
  const adapters = comparisonAdapters()
  const targets = new Set(adapters.map((a) => a.target.name))
  log(
    `Running the cross-server comparison (${warmupRuns} warmup + ${iterations} retained full run(s); ${adapters.length} task-runs across ${targets.size} target(s))...`,
  )
  const series = await runComparisonSeries(adapters, { warmupRuns, iterations })
  const summaries = summarizeComparisonSeries(series)
  const contrasts = computeContrast(medianRows(summaries), STAGEWRIGHT_TARGET.name)
  const evidenceTier = comparisonEvidenceTier(iterations, warmupRuns, summaries)
  printComparison(summaries, contrasts)
  log(
    `\nEvidence tier: ${evidenceTier}${evidenceTier === 'reviewable' ? ' (local artifact is ready for human review, not a published claim).' : ' (insufficient retained runs, warmup, or success for a comparison claim).'}`,
  )

  const report: ComparisonReport = {
    schema_version: COMPARISON_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    comparison: {
      baseline: STAGEWRIGHT_TARGET.name,
      evidence_tier: evidenceTier,
      protocol: {
        execution: 'sequential-fresh-processes',
        warmup_runs: warmupRuns,
        retained_iterations: iterations,
      },
      provenance: await collectComparisonProvenance(adapters.map((adapter) => adapter.target)),
      tasks: [
        ...new Map(adapters.map((adapter) => [adapter.task.name, adapter.task])).values(),
      ].map((task) => {
        if (task.oracle === undefined)
          throw new Error(`${task.name} is missing a comparison oracle`)
        return { name: task.name, description: task.description, oracle: task.oracle }
      }),
      warmups: series.warmups,
      samples: series.samples,
      summaries,
      contrasts,
    },
  }
  const json = JSON.stringify(report, null, 2)
  process.stdout.write(`${json}\n`)
  const outPath = jsonOutPath(argv)
  if (outPath !== undefined) {
    await mkdir(path.dirname(path.resolve(outPath)), { recursive: true })
    await writeFile(outPath, `${json}\n`, 'utf8')
    log(`\nWrote machine-readable comparison report to ${outPath}`)
  }
  const failed = series.samples.flat().filter((row) => !row.ok)
  const retainedRows = series.samples.flat().length
  if (failed.length > 0) {
    log(`\n${failed.length} of ${retainedRows} retained comparison row(s) FAILED.`)
    process.exitCode = 1
  } else {
    log(`\nComparison complete across ${targets.size} target(s).`)
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--compare')) {
    await runCompareMode(argv)
    return
  }
  const check = argv.includes('--check')
  const updateThresholds = argv.includes('--update-thresholds')

  log(`Running the benchmark (${SCENARIOS.length} scenarios)...`)
  const results: ScenarioResult[] = []
  for (const scenario of SCENARIOS) {
    log(`\n• ${scenario.name} — ${scenario.description}`)
    results.push(await runScenario(scenario))
  }

  printTable(results)
  printDeltas(results)
  const failed = results.filter((r) => !r.ok)

  // Re-baseline mode: print a fresh spec derived from this run for the human to paste into
  // thresholds.ts (DEFAULT_THRESHOLDS), then stop — never enforce against the spec it would replace.
  if (updateThresholds) {
    if (failed.length > 0) {
      log(
        `\n${failed.length} of ${results.length} scenarios FAILED; refusing to derive thresholds.`,
      )
      process.exitCode = 1
      return
    }
    log('\nDerived thresholds (paste into DEFAULT_THRESHOLDS in src/thresholds.ts):')
    log(JSON.stringify(deriveThresholds(results, CONTRASTS), null, 2))
    return
  }

  const violations = checkThresholds(results, CONTRASTS, DEFAULT_THRESHOLDS)
  printViolations(violations)

  const report: BenchReport = {
    schema_version: REPORT_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    env: { node: process.versions.node, platform: process.platform, arch: process.arch },
    results,
    thresholds: { passed: violations.length === 0, violations },
  }
  const json = JSON.stringify(report, null, 2)
  process.stdout.write(`${json}\n`)

  const outPath = jsonOutPath(argv)
  if (outPath !== undefined) {
    // Create the parent directory so `--json some/new/dir/report.json` does not ENOENT.
    await mkdir(path.dirname(path.resolve(outPath)), { recursive: true })
    await writeFile(outPath, `${json}\n`, 'utf8')
    log(`\nWrote machine-readable report to ${outPath}`)
  }

  // One exit code unifies both failure modes: a scenario that errored unexpectedly, and (only under
  // --check) a deterministic-metric regression. Without --check, thresholds are reported, not enforced.
  const enforced = check && violations.length > 0
  if (failed.length > 0 || enforced) {
    if (failed.length > 0) log(`\n${failed.length} of ${results.length} scenarios FAILED.`)
    if (enforced) log(`${violations.length} regression threshold(s) violated (--check).`)
    process.exitCode = 1
  } else {
    log(`\nAll ${results.length} scenarios completed.`)
  }
}

main().catch((err: unknown) => {
  log(`Benchmark runner crashed: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
