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

import { writeFile } from 'node:fs/promises'

import { runScenario, type ScenarioResult } from './harness.js'
import { SCENARIOS } from './scenarios.js'

/** Schema version of the JSON report; bump when the shape changes (for regression tooling). */
const REPORT_SCHEMA_VERSION = 1

/** The machine-readable report written to stdout / the --json file. */
interface BenchReport {
  readonly schema_version: number
  readonly generated_at: string
  readonly env: { readonly node: string; readonly platform: string; readonly arch: string }
  readonly results: ReadonlyArray<ScenarioResult>
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

/**
 * A token-economy contrast: two scenarios that do the SAME task, where `optimized` uses
 * an agent-native primitive the `baseline` lacks. The printed delta is the saving.
 */
interface Contrast {
  readonly label: string
  readonly baseline: string
  readonly optimized: string
}

/** The same-task contrasts the runner reports (each isolates one token-economy lever). */
const CONTRASTS: ReadonlyArray<Contrast> = [
  {
    label: 'verify a result — primitive chain vs expect_text (saves round-trips)',
    baseline: 'verify-greeting-primitive',
    optimized: 'verify-greeting-expect',
  },
  {
    label: 'see what changed — full re-scan vs snapshot diff (saves tokens)',
    baseline: 'observe-change-rescan',
    optimized: 'observe-change-diff',
  },
]

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

async function main(): Promise<void> {
  log(`Running the benchmark (${SCENARIOS.length} scenarios)...`)
  const results: ScenarioResult[] = []
  for (const scenario of SCENARIOS) {
    log(`\n• ${scenario.name} — ${scenario.description}`)
    results.push(await runScenario(scenario))
  }

  printTable(results)
  printDeltas(results)

  const report: BenchReport = {
    schema_version: REPORT_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    env: { node: process.versions.node, platform: process.platform, arch: process.arch },
    results,
  }
  const json = JSON.stringify(report, null, 2)
  process.stdout.write(`${json}\n`)

  const outPath = jsonOutPath(process.argv.slice(2))
  if (outPath !== undefined) {
    await writeFile(outPath, `${json}\n`, 'utf8')
    log(`\nWrote machine-readable report to ${outPath}`)
  }

  const failed = results.filter((r) => !r.ok)
  if (failed.length > 0) {
    log(`\n${failed.length} of ${results.length} scenarios FAILED.`)
    process.exitCode = 1
  } else {
    log(`\nAll ${results.length} scenarios completed.`)
  }
}

main().catch((err: unknown) => {
  log(`Benchmark runner crashed: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
