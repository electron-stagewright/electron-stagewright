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

import { runScenario, type ScenarioResult } from './harness.js'
import { SCENARIOS } from './scenarios.js'
import {
  checkThresholds,
  deriveThresholds,
  DEFAULT_CONTRASTS,
  DEFAULT_THRESHOLDS,
  type Contrast,
  type ThresholdViolation,
} from './thresholds.js'

/** Schema version of the JSON report; bump when the shape changes (for regression tooling). */
const REPORT_SCHEMA_VERSION = 2

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

/** Render the results as a fixed-width table to stderr. */
function printTable(results: ReadonlyArray<ScenarioResult>): void {
  log('\nBenchmark results')
  log('─'.repeat(86))
  log(
    `  ${'scenario'.padEnd(28)} ${'calls'.padStart(5)} ${'tokens'.padStart(7)} ${'latency'.padStart(9)} ${'memory'.padStart(8)}  result`,
  )
  for (const r of results) {
    const verdict = r.ok ? 'ok' : `FAIL: ${r.error ?? ''}`
    log(
      `  ${r.name.padEnd(28)} ${String(r.toolCalls).padStart(5)} ${String(r.estimatedTokens).padStart(7)} ${`${r.latencyMs.toFixed(0)}ms`.padStart(9)} ${mib(r.memoryRssBytes).padStart(8)}  ${verdict}`,
    )
  }
}

/** The same-task contrasts the runner reports + thresholds-checks (shared with the pure checker). */
const CONTRASTS: ReadonlyArray<Contrast> = DEFAULT_CONTRASTS

/** Print each same-task contrast's saving in tool calls and estimated tokens. */
function printDeltas(results: ReadonlyArray<ScenarioResult>): void {
  log('\nToken-economy deltas (same task, agent-native primitive vs the naive path)')
  for (const c of CONTRASTS) {
    const base = results.find((r) => r.name === c.baseline)
    const opt = results.find((r) => r.name === c.optimized)
    if (!base?.ok || !opt?.ok) continue
    const calls = base.toolCalls - opt.toolCalls
    const tokens = base.estimatedTokens - opt.estimatedTokens
    const pct = base.estimatedTokens > 0 ? Math.round((tokens / base.estimatedTokens) * 100) : 0
    log(`  ${c.label}`)
    log(`    saved ${calls} tool call(s) and ${tokens} estimated tokens (${pct}% fewer).`)
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
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
