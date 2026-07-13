/**
 * Manifest-budget runner. Emits machine JSON to stdout and human status to
 * stderr, so it is safe for CI and review artifacts.
 *
 * @module
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  checkManifestBaseline,
  collectManifestMeasurements,
  createManifestBaseline,
  type ManifestBaseline,
} from './manifest.js'

const BASELINE_PATH = fileURLToPath(new URL('../fixtures/manifest-baseline.json', import.meta.url))

interface RunnerOptions {
  readonly check: boolean
  readonly update: boolean
  readonly reason?: string
  readonly jsonPath?: string
}

function log(message: string): void {
  process.stderr.write(`${message}\n`)
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new Error(`${flag} expects a value`)
  }
  return value
}

function parseArgs(argv: readonly string[]): RunnerOptions {
  let check = false
  let update = false
  let reason: string | undefined
  let jsonPath: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--check') {
      check = true
      continue
    }
    if (arg === '--update-manifest-baseline') {
      update = true
      continue
    }
    if (arg === '--reason') {
      if (reason !== undefined) throw new Error('--reason may be specified only once')
      reason = requireValue(argv, index, arg)
      index += 1
      continue
    }
    if (arg === '--json') {
      if (jsonPath !== undefined) throw new Error('--json may be specified only once')
      jsonPath = requireValue(argv, index, arg)
      index += 1
      continue
    }
    throw new Error(`Unknown option: ${arg}`)
  }
  if (check && update) throw new Error('--check and --update-manifest-baseline cannot be combined')
  if (update && (reason === undefined || reason.trim().length === 0)) {
    throw new Error('--update-manifest-baseline requires a non-empty --reason')
  }
  if (!update && reason !== undefined) {
    throw new Error('--reason is only valid with --update-manifest-baseline')
  }
  return {
    check,
    update,
    ...(reason !== undefined ? { reason } : {}),
    ...(jsonPath !== undefined ? { jsonPath } : {}),
  }
}

async function readBaseline(): Promise<ManifestBaseline> {
  return JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as ManifestBaseline
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  log('Collecting host-visible MCP manifest variants...')
  const variants = await collectManifestMeasurements()

  let baseline: ManifestBaseline | undefined
  let violations: ReturnType<typeof checkManifestBaseline> = []
  if (options.update) {
    baseline = createManifestBaseline(options.reason ?? '', variants)
    await mkdir(path.dirname(BASELINE_PATH), { recursive: true })
    await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
    log(`Updated ${BASELINE_PATH}`)
  } else {
    baseline = await readBaseline()
    violations = checkManifestBaseline(variants, baseline)
    for (const violation of violations)
      log(`MANIFEST REGRESSION [${violation.variant}] ${violation.message}`)
  }

  const report = {
    schemaVersion: 1,
    variants,
    baseline: { path: BASELINE_PATH, reason: baseline.reason },
    check: { passed: violations.length === 0, violations },
  }
  const json = JSON.stringify(report, null, 2)
  process.stdout.write(`${json}\n`)
  if (options.jsonPath !== undefined) {
    const output = path.resolve(options.jsonPath)
    await mkdir(path.dirname(output), { recursive: true })
    await writeFile(output, `${json}\n`, 'utf8')
    log(`Wrote ${output}`)
  }
  if (options.check && violations.length > 0) process.exitCode = 1
}

main().catch((error: unknown) => {
  log(`Manifest runner failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
