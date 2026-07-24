/**
 * Observational published-startup runner.
 *
 * The protocol retains failures and raw samples, writes JSON to stdout, and keeps human output on
 * stderr. Latency is evidence only: this command has no pass/fail threshold.
 *
 * @module
 */

import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'

import { collectStartupProvenance, type StartupProvenance } from './provenance.js'
import {
  publishedNpxServerArguments,
  publishedPackageSpecs,
  runStartupSeries,
  setupFailureSample,
  summarizeStartupSamples,
  type StartupSample,
  type StartupSummary,
  type StartupTarget,
} from './startup.js'
import { execPackageCommand, packageCommandInvocation } from '../../../scripts/package-command.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(HERE, '../../..')
const CORE_PACKAGE_PATH = path.join(REPOSITORY_ROOT, 'packages', 'core', 'package.json')
const REPORT_SCHEMA_VERSION = 1
const COLD_INITIALIZE_TIMEOUT_MS = 8 * 60_000
const WARM_INITIALIZE_TIMEOUT_MS = 2 * 60_000
const DIRECT_INITIALIZE_TIMEOUT_MS = 30_000
const TOOLS_LIST_TIMEOUT_MS = 30_000
const INSTALL_TIMEOUT_MS = 10 * 60_000
const MAX_COLD_RUNS = 2
const MAX_RETAINED_RUNS = 5
const COMMAND_EVIDENCE_LIMIT = 2_000
const FORWARDED_NETWORK_ENVIRONMENT = [
  'ALL_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NPM_CONFIG_REGISTRY',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'npm_config_registry',
] as const

type StartupCommand = 'benchmark' | 'help'

export interface ParsedStartupArguments {
  readonly command: StartupCommand
  readonly coldRuns: number
  readonly warmRuns: number
  readonly directRuns: number
  readonly jsonPath?: string
}

interface SeriesReport {
  readonly samples: readonly StartupSample[]
  readonly summary: StartupSummary
}

interface StartupReport {
  readonly schema_version: number
  readonly generated_at: string
  readonly evidence_tier: 'exploratory'
  readonly protocol: {
    readonly execution: 'sequential'
    readonly server_ready: 'mcp-initialize-complete'
    readonly tools_list: 'separate-after-initialize'
    readonly app_root: 'benchmark-owned-empty-directory'
    readonly cold_runs: number
    readonly warm_runs: number
    readonly direct_runs_per_profile: number
    readonly direct_warmups_per_profile: 1
    readonly direct_retained_order: 'alternating-after-profile-warmups'
    readonly warm_cache_source: 'first-cold-run'
    readonly timeout_ms: {
      readonly cold_initialize: number
      readonly warm_initialize: number
      readonly direct_initialize: number
      readonly tools_list: number
      readonly direct_install: number
    }
    readonly latency_gate: false
  }
  readonly provenance: StartupProvenance
  readonly published_npx: {
    readonly cold: SeriesReport
    readonly warm: SeriesReport
  }
  readonly direct_installed: {
    readonly materialization: { readonly ok: boolean; readonly error?: string }
    readonly warmups: {
      readonly essential: StartupSample
      readonly full: StartupSample
    }
    readonly retained_order: ReadonlyArray<{
      readonly profile: 'essential' | 'full'
      readonly iteration: number
    }>
    readonly essential: SeriesReport
    readonly full: SeriesReport
  }
}

interface StartupProgressJournal {
  append(event: Readonly<Record<string, unknown>>): Promise<void>
}

/** Render help without touching the package registry or creating scratch state. */
export function formatStartupHelp(): string {
  return [
    'Usage: pnpm bench:startup [options]',
    '',
    'Measures published startup as separate MCP initialize and tools/list phases.',
    'All latency is observational; raw failures stay in the JSON report and never become zeroes.',
    '',
    'Options:',
    '  --cold-runs <count>     Empty-cache npx runs (default: 1, max: 2).',
    '  --warm-runs <count>     Same-cache npx runs after cold bootstrap (default: 3, max: 5).',
    '  --direct-runs <count>   Installed CLI runs per essential/full profile (default: 3, max: 5).',
    '  --json <path>           Also write the report relative to the repository root.',
    '  --help, -h              Print this help without installing or spawning anything.',
  ].join('\n')
}

function parseRunCount(
  raw: string | undefined,
  flag: string,
  defaultValue: number,
  maximum = MAX_RETAINED_RUNS,
): number {
  if (raw === undefined) return defaultValue
  if (!/^\d+$/.test(raw)) throw new Error(`${flag} expects a positive integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${flag} must be between 1 and ${maximum}`)
  }
  return value
}

/** Reject unknown, duplicate, missing, and unbounded options before any startup side effect. */
export function parseStartupArguments(argv: readonly string[]): ParsedStartupArguments {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { command: 'help', coldRuns: 1, warmRuns: 3, directRuns: 3 }
  }

  const values = new Map<string, string>()
  const valueFlags = new Set(['--cold-runs', '--warm-runs', '--direct-runs', '--json'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) continue
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`)
    if (!valueFlags.has(argument)) throw new Error(`Unknown option: ${argument}`)
    if (values.has(argument)) throw new Error(`${argument} may be specified only once`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${argument} expects a value`)
    }
    if (argument === '--json' && value.trim() === '') {
      throw new Error('--json expects a non-empty path')
    }
    values.set(argument, value)
    index += 1
  }

  const jsonPath = values.get('--json')
  return {
    command: 'benchmark',
    coldRuns: parseRunCount(values.get('--cold-runs'), '--cold-runs', 1, MAX_COLD_RUNS),
    warmRuns: parseRunCount(values.get('--warm-runs'), '--warm-runs', 3),
    directRuns: parseRunCount(values.get('--direct-runs'), '--direct-runs', 3),
    ...(jsonPath === undefined ? {} : { jsonPath }),
  }
}

/** Resolve report paths consistently regardless of the package script's current directory. */
export function resolveStartupOutputPath(outputPath: string): string {
  return path.resolve(REPOSITORY_ROOT, outputPath)
}

/** Keep an incremental sibling journal available when a run is interrupted before final JSON. */
export function resolveStartupProgressPath(outputPath: string): string {
  const output = path.parse(resolveStartupOutputPath(outputPath))
  return path.join(output.dir, `${output.name}-progress.ndjson`)
}

/** Alternate which warmed profile runs first so retained comparisons do not encode one fixed order. */
export function directRetainedProfileOrder(
  runsPerProfile: number,
): ReadonlyArray<'essential' | 'full'> {
  const order: Array<'essential' | 'full'> = []
  for (let iteration = 1; iteration <= runsPerProfile; iteration += 1) {
    order.push(
      ...(iteration % 2 === 1
        ? (['full', 'essential'] as const)
        : (['essential', 'full'] as const)),
    )
  }
  return order
}

function cacheEnvironment(root: string): Record<string, string> {
  const home = path.join(root, 'home')
  const npmCache = path.join(root, 'npm-cache')
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
    ELECTRON_CACHE: path.join(root, 'electron-cache'),
    NPM_CONFIG_CACHE: npmCache,
    npm_config_cache: npmCache,
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NO_COLOR: '1',
  }
}

/** Forward network routing/certificate settings required for public package resolution, not secrets. */
export function forwardedNetworkEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    FORWARDED_NETWORK_ENVIRONMENT.flatMap((name) => {
      const value = environment[name]
      return value === undefined ? [] : [[name, value]]
    }),
  )
}

function packageEnvironmentOverrides(root: string): Record<string, string> {
  return {
    ...forwardedNetworkEnvironment(process.env),
    ...cacheEnvironment(root),
  }
}

function packageExecutionEnvironment(root: string): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    ...packageEnvironmentOverrides(root),
  }
}

function serverArguments(profile: 'essential' | 'full', appRoot: string): readonly string[] {
  return ['--tool-profile', profile, '--app-root', appRoot]
}

function npxTarget(input: {
  readonly root: string
  readonly appRoot: string
  readonly packages: readonly string[]
  readonly mode: 'published-npx-cold' | 'published-npx-warm'
  readonly cacheState: 'empty' | 'reused'
  readonly iteration: number
  readonly scratch: string
}): StartupTarget {
  const invocation = packageCommandInvocation(
    'npx',
    publishedNpxServerArguments(input.packages, serverArguments('full', input.appRoot)),
  )
  return {
    mode: input.mode,
    profile: 'full',
    cacheState: input.cacheState,
    iteration: input.iteration,
    command: invocation.file,
    args: invocation.args,
    cwd: input.root,
    env: packageEnvironmentOverrides(input.root),
    initializeTimeoutMs:
      input.mode === 'published-npx-cold' ? COLD_INITIALIZE_TIMEOUT_MS : WARM_INITIALIZE_TIMEOUT_MS,
    toolsListTimeoutMs: TOOLS_LIST_TIMEOUT_MS,
    redactPaths: [input.scratch],
  }
}

function directTarget(input: {
  readonly installRoot: string
  readonly appRoot: string
  readonly profile: 'essential' | 'full'
  readonly iteration: number
  readonly scratch: string
}): StartupTarget {
  const bin = path.join(input.installRoot, 'node_modules', '.bin', 'electron-stagewright')
  const invocation = packageCommandInvocation(bin, serverArguments(input.profile, input.appRoot))
  return {
    mode: 'direct-installed',
    profile: input.profile,
    cacheState: 'installed',
    iteration: input.iteration,
    command: invocation.file,
    args: invocation.args,
    cwd: input.installRoot,
    env: { NO_COLOR: '1' },
    initializeTimeoutMs: DIRECT_INITIALIZE_TIMEOUT_MS,
    toolsListTimeoutMs: TOOLS_LIST_TIMEOUT_MS,
    redactPaths: [input.scratch],
  }
}

function series(samples: readonly StartupSample[]): SeriesReport {
  return { samples, summary: summarizeStartupSamples(samples) }
}

function commandFailure(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error))
  const record = error as Error & { stdout?: unknown; stderr?: unknown }
  const output = [record.stdout, record.stderr]
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .join('\n')
  if (output === '') return error
  const clipped =
    output.length > COMMAND_EVIDENCE_LIMIT ? `${output.slice(0, COMMAND_EVIDENCE_LIMIT)}…` : output
  return new Error(`${error.message}\n${clipped}`)
}

async function materializeDirectInstall(
  installRoot: string,
  packages: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(installRoot, { recursive: true })
  await writeFile(
    path.join(installRoot, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
  )
  await execPackageCommand(
    'pnpm',
    ['add', '--save-exact', '--store-dir', path.join(installRoot, '.pnpm-store'), ...packages],
    {
      cwd: installRoot,
      env: { ...environment },
      encoding: 'utf8',
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    },
  )
}

function formatMilliseconds(
  summary: StartupSummary,
  key: 'server_ready_ms' | 'tools_list_ms',
): string {
  const distribution = summary[key]
  return distribution === null
    ? 'n/a'
    : `${distribution.median.toFixed(0)}ms median / ${distribution.min.toFixed(0)}–${distribution.max.toFixed(0)}ms range`
}

function printSeries(label: string, report: SeriesReport): void {
  process.stderr.write(
    `  ${label}: ${report.summary.successful_runs}/${report.summary.retained_runs} succeeded; ` +
      `initialize ${formatMilliseconds(report.summary, 'server_ready_ms')}; ` +
      `tools/list ${formatMilliseconds(report.summary, 'tools_list_ms')}\n`,
  )
}

function startupProtocol(options: ParsedStartupArguments): StartupReport['protocol'] {
  return {
    execution: 'sequential',
    server_ready: 'mcp-initialize-complete',
    tools_list: 'separate-after-initialize',
    app_root: 'benchmark-owned-empty-directory',
    cold_runs: options.coldRuns,
    warm_runs: options.warmRuns,
    direct_runs_per_profile: options.directRuns,
    direct_warmups_per_profile: 1,
    direct_retained_order: 'alternating-after-profile-warmups',
    warm_cache_source: 'first-cold-run',
    timeout_ms: {
      cold_initialize: COLD_INITIALIZE_TIMEOUT_MS,
      warm_initialize: WARM_INITIALIZE_TIMEOUT_MS,
      direct_initialize: DIRECT_INITIALIZE_TIMEOUT_MS,
      tools_list: TOOLS_LIST_TIMEOUT_MS,
      direct_install: INSTALL_TIMEOUT_MS,
    },
    latency_gate: false,
  }
}

async function createProgressJournal(
  options: ParsedStartupArguments,
  packages: readonly string[],
): Promise<StartupProgressJournal> {
  if (options.jsonPath === undefined) {
    return { append: async () => undefined }
  }
  const journalPath = resolveStartupProgressPath(options.jsonPath)
  await mkdir(path.dirname(journalPath), { recursive: true })
  await writeFile(
    journalPath,
    `${JSON.stringify({
      journal_schema_version: 1,
      type: 'start',
      generated_at: new Date().toISOString(),
      evidence_tier: 'exploratory',
      protocol: startupProtocol(options),
      published_packages: packages,
    })}\n`,
  )
  return {
    async append(event) {
      await appendFile(journalPath, `${JSON.stringify(event)}\n`)
    },
  }
}

async function writeReport(report: StartupReport, outputPath: string | undefined): Promise<void> {
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (outputPath !== undefined) {
    const absolute = resolveStartupOutputPath(outputPath)
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, json)
  }
  process.stdout.write(json)
}

/** Execute the bounded observational protocol and always remove its package/cache scratch tree. */
async function runStartupBenchmark(options: ParsedStartupArguments): Promise<void> {
  const manifest = JSON.parse(await readFile(CORE_PACKAGE_PATH, 'utf8')) as unknown
  const packages = publishedPackageSpecs(manifest)
  const journal = await createProgressJournal(options, packages)
  const observeSample = async (sample: StartupSample): Promise<void> => {
    await journal.append({ type: 'sample', sample })
  }
  const scratch = await mkdtemp(path.join(tmpdir(), 'stagewright-startup-bench-'))
  const appRoot = path.join(scratch, 'target-app')
  const coldRoots = Array.from({ length: options.coldRuns }, (_, index) =>
    path.join(scratch, `cold-${index + 1}`),
  )
  const warmRoot = coldRoots[0]
  if (warmRoot === undefined) throw new Error('The startup protocol requires one cold cache.')
  const installRoot = path.join(scratch, 'direct-install')

  try {
    await Promise.all([mkdir(appRoot), ...coldRoots.map((root) => mkdir(root))])
    process.stderr.write(
      `Measuring published startup (${options.coldRuns} cold, ${options.warmRuns} warm, ` +
        `${options.directRuns} direct run(s) per profile)...\n`,
    )

    const coldSamples = await runStartupSeries(
      coldRoots.map((root, index) =>
        npxTarget({
          root,
          appRoot,
          packages,
          mode: 'published-npx-cold',
          cacheState: 'empty',
          iteration: index + 1,
          scratch,
        }),
      ),
      { onSample: observeSample },
    )
    const warmSamples = await runStartupSeries(
      Array.from({ length: options.warmRuns }, (_, index) =>
        npxTarget({
          root: warmRoot,
          appRoot,
          packages,
          mode: 'published-npx-warm',
          cacheState: 'reused',
          iteration: index + 1,
          scratch,
        }),
      ),
      { onSample: observeSample },
    )

    const directWarmupTargets = (['essential', 'full'] as const).map((profile) =>
      directTarget({ installRoot, appRoot, profile, iteration: 0, scratch }),
    )
    const directFailureTarget = directWarmupTargets[0]
    if (directFailureTarget === undefined) {
      throw new Error('The direct startup protocol requires a profile warmup target.')
    }
    const directIterations = new Map<'essential' | 'full', number>([
      ['essential', 0],
      ['full', 0],
    ])
    const directTargets = directRetainedProfileOrder(options.directRuns).map((profile) => {
      const iteration = (directIterations.get(profile) ?? 0) + 1
      directIterations.set(profile, iteration)
      return directTarget({ installRoot, appRoot, profile, iteration, scratch })
    })
    let installError: Error | undefined
    try {
      await materializeDirectInstall(installRoot, packages, packageExecutionEnvironment(warmRoot))
    } catch (error) {
      installError = commandFailure(error)
    }
    await journal.append({
      type: 'direct_materialization',
      ok: installError === undefined,
      ...(installError === undefined
        ? {}
        : {
            error: setupFailureSample(directFailureTarget, installError).error,
          }),
    })
    const directWarmups =
      installError === undefined
        ? await runStartupSeries(directWarmupTargets, { onSample: observeSample })
        : directWarmupTargets.map((target) => setupFailureSample(target, installError))
    const directSamples =
      installError === undefined
        ? await runStartupSeries(directTargets, { onSample: observeSample })
        : directTargets.map((target) => setupFailureSample(target, installError))
    if (installError !== undefined) {
      for (const sample of [...directWarmups, ...directSamples]) await observeSample(sample)
    }
    const essentialSamples = directSamples.filter((sample) => sample.profile === 'essential')
    const fullSamples = directSamples.filter((sample) => sample.profile === 'full')
    const essentialWarmup = directWarmups.find((sample) => sample.profile === 'essential')
    const fullWarmup = directWarmups.find((sample) => sample.profile === 'full')
    if (essentialWarmup === undefined || fullWarmup === undefined) {
      throw new Error('The direct startup protocol did not produce both profile warmups.')
    }

    const inheritedEnvironment = Object.keys(getDefaultEnvironment())
    const packageOverrides = Object.keys(packageEnvironmentOverrides(warmRoot))
    const report: StartupReport = {
      schema_version: REPORT_SCHEMA_VERSION,
      generated_at: new Date().toISOString(),
      evidence_tier: 'exploratory',
      protocol: startupProtocol(options),
      provenance: await collectStartupProvenance({
        publishedPackages: packages,
        profiles: ['essential', 'full'],
        cacheModes: ['empty', 'reused', 'installed'],
        childEnvironment: {
          publishedNpx: {
            inherited: inheritedEnvironment,
            overrides: packageOverrides,
          },
          directMaterialization: {
            inherited: inheritedEnvironment,
            overrides: packageOverrides,
          },
          directCli: {
            inherited: inheritedEnvironment,
            overrides: ['NO_COLOR'],
          },
        },
      }),
      published_npx: {
        cold: series(coldSamples),
        warm: series(warmSamples),
      },
      direct_installed: {
        materialization:
          installError === undefined
            ? { ok: true }
            : {
                ok: false,
                error:
                  essentialWarmup.error ??
                  'Published package materialization failed without diagnostics.',
              },
        warmups: {
          essential: essentialWarmup,
          full: fullWarmup,
        },
        retained_order: directSamples.map((sample) => ({
          profile: sample.profile,
          iteration: sample.iteration,
        })),
        essential: series(essentialSamples),
        full: series(fullSamples),
      },
    }

    process.stderr.write('Startup observations (latency is non-gating):\n')
    printSeries('published npx cold', report.published_npx.cold)
    printSeries('published npx warm', report.published_npx.warm)
    printSeries('direct essential', report.direct_installed.essential)
    printSeries('direct full', report.direct_installed.full)
    await writeReport(report, options.jsonPath)
    await journal.append({ type: 'complete', generated_at: new Date().toISOString() })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const options = parseStartupArguments(process.argv.slice(2))
  if (options.command === 'help') {
    process.stdout.write(`${formatStartupHelp()}\n`)
    return
  }
  await runStartupBenchmark(options)
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(
      `startup benchmark failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
    process.exitCode = 1
  })
}
