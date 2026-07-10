/**
 * Real-Electron comparison of the compatibility `full` profile against the
 * opt-in `essential` profile. Manifest cost is collected through the same MCP
 * host path as the budget runner; response metrics come from real task calls.
 *
 * @module
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { ToolProfile } from '@electron-stagewright/core'

import { collectManifestVariant, type ManifestMeasurement } from './manifest.js'
import {
  runAdapter,
  stagewrightAdapter,
  stagewrightProfileTarget,
  type ComparisonResult,
} from './harness.js'
import { PROFILE_SCENARIOS } from './profile-scenarios.js'

const COMPARED_PROFILES: readonly ToolProfile[] = ['full', 'essential']

interface ProfileTaskResult extends ComparisonResult {
  /** Initial manifest BPE plus task-response BPE. */
  readonly totalBpe: number
}

interface ProfileSummary {
  readonly profile: ToolProfile
  readonly manifest: ManifestMeasurement
  readonly successRate: number
  readonly results: readonly ProfileTaskResult[]
}

function log(message: string): void {
  process.stderr.write(`${message}\n`)
}

function parseJsonPath(argv: readonly string[]): string | undefined {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  if (args.length === 0) return undefined
  if (args.length !== 2 || args[0] !== '--json') throw new Error('Unknown profile benchmark option')
  const value = args[1]
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new Error('--json expects a path')
  }
  return value
}

async function runProfile(profile: ToolProfile): Promise<ProfileSummary> {
  const manifest = await collectManifestVariant({
    id: `profile-benchmark-${profile}`,
    toolProfile: profile,
    allowEval: false,
    plugins: [],
  })
  const target = stagewrightProfileTarget(profile)
  const results: ProfileTaskResult[] = []
  for (const scenario of PROFILE_SCENARIOS) {
    log(`• ${profile} / ${scenario.name}`)
    const result = await runAdapter(
      stagewrightAdapter(
        { name: scenario.name, description: scenario.description },
        scenario.run,
        target,
      ),
    )
    results.push({ ...result, totalBpe: manifest.bpe + result.measuredTokens })
  }
  return {
    profile,
    manifest,
    successRate:
      results.length === 0 ? 0 : results.filter((result) => result.ok).length / results.length,
    results,
  }
}

function printSummary(summary: ProfileSummary): void {
  log(
    `\n${summary.profile}: ${(summary.successRate * 100).toFixed(1)}% success · ${summary.manifest.toolCount} tools · ${summary.manifest.bpe} manifest BPE`,
  )
  log('  task'.padEnd(37) + 'calls  retries  response BPE  total BPE  result')
  for (const result of summary.results) {
    log(
      `  ${result.task.padEnd(35)} ${String(result.toolCalls).padStart(5)} ${String(result.retries).padStart(8)} ${String(result.measuredTokens).padStart(13)} ${String(result.totalBpe).padStart(10)}  ${result.ok ? 'ok' : `FAIL: ${result.error ?? ''}`}`,
    )
  }
}

async function main(): Promise<void> {
  const jsonPath = parseJsonPath(process.argv.slice(2))
  log(`Running ${PROFILE_SCENARIOS.length} profile tasks for ${COMPARED_PROFILES.join(' vs ')}...`)
  const profiles: ProfileSummary[] = []
  for (const profile of COMPARED_PROFILES) profiles.push(await runProfile(profile))
  for (const profile of profiles) printSummary(profile)

  const full = profiles.find((profile) => profile.profile === 'full')
  const essential = profiles.find((profile) => profile.profile === 'essential')
  if (full !== undefined && essential !== undefined) {
    log(
      `\nEssential vs full: ${(essential.successRate * 100).toFixed(1)}% vs ${(full.successRate * 100).toFixed(1)}% success; ${full.manifest.bpe - essential.manifest.bpe} manifest BPE saved.`,
    )
  }
  const report = { schemaVersion: 1, profiles }
  const json = JSON.stringify(report, null, 2)
  process.stdout.write(`${json}\n`)
  if (jsonPath !== undefined) {
    const output = path.resolve(jsonPath)
    await mkdir(path.dirname(output), { recursive: true })
    await writeFile(output, `${json}\n`, 'utf8')
    log(`Wrote ${output}`)
  }
  if (profiles.some((profile) => profile.results.some((result) => !result.ok))) process.exitCode = 1
}

main().catch((error: unknown) => {
  log(`Profile benchmark failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
