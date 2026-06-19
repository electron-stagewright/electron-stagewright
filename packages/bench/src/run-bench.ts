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

import { stagewrightAdapters } from './adapters.js'
import { computeContrast, runComparison, type TaskContrast } from './comparison.js'
import {
  runScenario,
  STAGEWRIGHT_TARGET,
  type ComparisonResult,
  type ScenarioResult,
  type ServerTarget,
  type TaskAdapter,
} from './harness.js'
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
const COMPARISON_SCHEMA_VERSION = 1

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

/**
 * Parse `--compare-target name=command,arg,arg` overrides. Each overrides the SPAWN of a registered
 * adapter whose target name matches (e.g. point the `stagewright` adapter at a different build). It
 * cannot add a brand-new competitor — that needs an adapter (code); see the bench README.
 */
function parseCompareTargets(argv: readonly string[]): Map<string, ServerTarget> {
  const overrides = new Map<string, ServerTarget>()
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--compare-target') continue
    const spec = argv[i + 1]
    const eq = spec === undefined ? -1 : spec.indexOf('=')
    if (spec === undefined || eq <= 0) {
      log(`warning: --compare-target needs name=command,arg,arg; ignoring "${spec ?? ''}".`)
      continue
    }
    const name = spec.slice(0, eq)
    const parts = spec
      .slice(eq + 1)
      .split(',')
      .filter((s) => s.length > 0)
    const command = parts[0]
    if (command === undefined) {
      log(`warning: --compare-target "${spec}" has no command; ignoring.`)
      continue
    }
    overrides.set(name, { name, command, args: parts.slice(1) })
  }
  return overrides
}

/** Apply spawn overrides to the registered adapters, preserving each adapter's memory capability. */
function applyTargetOverrides(
  adapters: readonly TaskAdapter[],
  overrides: ReadonlyMap<string, ServerTarget>,
): TaskAdapter[] {
  return adapters.map((adapter) => {
    const override = overrides.get(adapter.target.name)
    if (override === undefined) return adapter
    return {
      ...adapter,
      target: {
        ...override,
        ...(adapter.target.supportsMemory !== undefined
          ? { supportsMemory: adapter.target.supportsMemory }
          : {}),
      },
    }
  })
}

/** Render the cross-server comparison: a per-row table, then each target's deltas vs the baseline. */
function printComparison(
  results: ReadonlyArray<ComparisonResult>,
  contrasts: ReadonlyArray<TaskContrast>,
): void {
  log(
    '\nCross-server comparison (real tok = BPE via gpt-tokenizer — the cross-server-comparable metric)',
  )
  log('─'.repeat(96))
  log(
    `  ${'task'.padEnd(18)} ${'target'.padEnd(16)} ${'calls'.padStart(5)} ${'real tok'.padStart(8)} ${'latency'.padStart(9)} ${'memory'.padStart(8)}  result`,
  )
  for (const r of results) {
    const verdict = r.ok ? 'ok' : `FAIL: ${r.error ?? ''}`
    log(
      `  ${r.task.padEnd(18)} ${r.target.padEnd(16)} ${String(r.toolCalls).padStart(5)} ${String(r.measuredTokens).padStart(8)} ${`${r.latencyMs.toFixed(0)}ms`.padStart(9)} ${mib(r.memoryRssBytes).padStart(8)}  ${verdict}`,
    )
  }
  const withDeltas = contrasts.filter((c) => c.deltas.length > 0)
  if (withDeltas.length === 0) return
  log(
    '\nDeltas vs the baseline (target − baseline; positive = the target spent MORE than the baseline)',
  )
  for (const c of withDeltas) {
    log(`  ${c.task} (vs ${c.baseline})`)
    for (const d of c.deltas) {
      const sign = (n: number): string => (n >= 0 ? `+${n}` : `${n}`)
      log(
        `    ${d.target}: ${sign(d.toolCallsVsBaseline)} calls, ${sign(d.measuredTokensVsBaseline)} BPE tokens`,
      )
    }
  }
}

/** The `--compare` machine report (its own shape; `comparison` block, independently versioned). */
interface ComparisonReport {
  readonly schema_version: number
  readonly generated_at: string
  readonly env: { readonly node: string; readonly platform: string; readonly arch: string }
  readonly comparison: {
    readonly baseline: string
    readonly results: ReadonlyArray<ComparisonResult>
    readonly contrasts: ReadonlyArray<TaskContrast>
  }
}

/**
 * `--compare` mode: drive every registered adapter (our baseline + any registered competitor, with
 * `--compare-target` spawn overrides applied), contrast the metrics vs our server, print the table, and
 * emit the comparison JSON. Distinct from the default scenario run.
 */
async function runCompareMode(argv: readonly string[]): Promise<void> {
  const overrides = parseCompareTargets(argv)
  const adapters = applyTargetOverrides(stagewrightAdapters(), overrides)
  const targets = new Set(adapters.map((a) => a.target.name))
  log(
    `Running the cross-server comparison (${adapters.length} task-runs across ${targets.size} target(s))...`,
  )
  const results = await runComparison(adapters)
  const contrasts = computeContrast(results, STAGEWRIGHT_TARGET.name)
  printComparison(results, contrasts)

  const report: ComparisonReport = {
    schema_version: COMPARISON_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    env: { node: process.versions.node, platform: process.platform, arch: process.arch },
    comparison: { baseline: STAGEWRIGHT_TARGET.name, results, contrasts },
  }
  const json = JSON.stringify(report, null, 2)
  process.stdout.write(`${json}\n`)
  const outPath = jsonOutPath(argv)
  if (outPath !== undefined) {
    await mkdir(path.dirname(path.resolve(outPath)), { recursive: true })
    await writeFile(outPath, `${json}\n`, 'utf8')
    log(`\nWrote machine-readable comparison report to ${outPath}`)
  }
  const failed = results.filter((r) => !r.ok)
  if (failed.length > 0) {
    log(`\n${failed.length} of ${results.length} comparison run(s) FAILED.`)
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
