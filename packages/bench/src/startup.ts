/**
 * Published-server startup measurement primitives.
 *
 * Server-ready means the MCP initialize handshake completed. `tools/list` is deliberately timed as
 * a second phase so package bootstrap, server construction, and manifest serialization do not
 * collapse into one misleading "cold start" number.
 *
 * @module
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { summarizeDistribution } from './comparison.js'

const ERROR_LIMIT = 2_000

export type StartupMode = 'published-npx-cold' | 'published-npx-warm' | 'direct-installed'
export type StartupProfile = 'essential' | 'full'
export type StartupCacheState = 'empty' | 'reused' | 'installed'
export type StartupFailurePhase = 'setup' | 'initialize' | 'tools/list'

/** One executable/profile/cache combination measured by the startup protocol. */
export interface StartupTarget {
  readonly mode: StartupMode
  readonly profile: StartupProfile
  readonly cacheState: StartupCacheState
  readonly iteration: number
  readonly command: string
  readonly args: readonly string[]
  readonly initializeTimeoutMs: number
  readonly toolsListTimeoutMs: number
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  /** Local scratch paths replaced in raw failure evidence before it enters the artifact. */
  readonly redactPaths?: readonly string[]
}

/** One raw retained startup observation. Failures remain rows rather than aborting the series. */
export interface StartupSample {
  readonly mode: StartupMode
  readonly profile: StartupProfile
  readonly cache_state: StartupCacheState
  readonly iteration: number
  readonly ok: boolean
  readonly server_ready_ms: number | null
  readonly tools_list_ms: number | null
  readonly tool_count: number | null
  readonly failure_phase?: StartupFailurePhase
  readonly error?: string
}

/** Successful distributions plus explicit failed-run counts for one homogeneous sample series. */
export interface StartupMetricDistribution {
  readonly samples: number
  readonly min: number
  readonly median: number
  readonly max: number
}

/** Successful distributions plus explicit failed-run counts for one homogeneous sample series. */
export interface StartupSummary {
  readonly retained_runs: number
  readonly successful_runs: number
  readonly failed_runs: number
  readonly server_ready_ms: StartupMetricDistribution | null
  readonly tools_list_ms: StartupMetricDistribution | null
  readonly tool_count: StartupMetricDistribution | null
}

/** Minimal lifecycle seam: tests inject deterministic probes without spawning npm or an MCP server. */
export interface StartupProbe {
  connect(): Promise<void>
  listTools(): Promise<number>
  close(): Promise<void>
  diagnostics(): string
  pid?(): number | null
}

export interface StartupMeasurementDependencies {
  readonly createProbe?: (target: StartupTarget) => StartupProbe
  readonly now?: () => number
}

export interface StartupSeriesDependencies extends StartupMeasurementDependencies {
  readonly onSample?: (sample: StartupSample) => void | Promise<void>
}

interface CorePackageManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly devDependencies?: Readonly<Record<string, unknown>>
}

/** Accept the repository's exact or caret-exact release pins, rejecting ranges and prereleases. */
export function exactReleaseVersion(value: unknown, packageName: string): string {
  if (typeof value !== 'string' || !/^\^?\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`Expected an exact release version for ${packageName}.`)
  }
  return value.replace(/^\^/, '')
}

/** Resolve the published core plus its launch peers from the core package's canonical pins. */
export function publishedPackageSpecs(manifest: unknown): readonly string[] {
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('name' in manifest) ||
    !('version' in manifest)
  ) {
    throw new Error('Expected an @electron-stagewright/core package manifest object.')
  }
  const packageManifest = manifest as CorePackageManifest
  if (packageManifest.name !== '@electron-stagewright/core') {
    throw new Error('Expected the @electron-stagewright/core package manifest.')
  }
  return [
    `${packageManifest.name}@${exactReleaseVersion(packageManifest.version, 'core')}`,
    `playwright@${exactReleaseVersion(
      packageManifest.devDependencies?.['playwright'],
      'playwright',
    )}`,
    `electron@${exactReleaseVersion(packageManifest.devDependencies?.['electron'], 'electron')}`,
  ]
}

/** Build the same pinned npx package stack used by the published onboarding path. */
export function publishedNpxServerArguments(
  packages: readonly string[],
  serverArgs: readonly string[],
): readonly string[] {
  if (packages.length === 0) throw new Error('At least one published package is required.')
  return [
    '-y',
    ...packages.flatMap((packageName) => ['--package', packageName]),
    'electron-stagewright',
    ...serverArgs,
  ]
}

function boundedFailure(
  error: unknown,
  diagnostics: string,
  redactPaths: readonly string[],
): string {
  const message = error instanceof Error ? error.message : String(error)
  const combined =
    diagnostics.trim() === '' ? message : `${message}\nstderr:\n${diagnostics.trim()}`
  const redacted = redactPaths
    .filter((candidate) => candidate.length > 0)
    .reduce((text, candidate) => text.replaceAll(candidate, '<scratch>'), combined)
  return redacted.length > ERROR_LIMIT ? `${redacted.slice(0, ERROR_LIMIT)}…` : redacted
}

/**
 * The SDK may start closing a transport after an initialize timeout without awaiting that close.
 * Memoizing the first close promise makes our explicit teardown join the same lifecycle operation
 * instead of returning early after StdioClientTransport has already cleared its private process ref.
 */
class AwaitableCloseStdioClientTransport extends StdioClientTransport {
  private closePromise: Promise<void> | undefined

  override close(): Promise<void> {
    this.closePromise ??= super.close()
    return this.closePromise
  }
}

/** Production stdio probe with bounded initialize/list timeouts and stderr-only diagnostics. */
export function createStdioStartupProbe(target: StartupTarget): StartupProbe {
  const transport = new AwaitableCloseStdioClientTransport({
    command: target.command,
    args: [...target.args],
    stderr: 'pipe',
    ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
    ...(target.env === undefined ? {} : { env: { ...target.env } }),
  })
  const client = new Client({
    name: `startup-bench-${target.mode}-${target.profile}`,
    version: '0.0.0',
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    if (stderr.length >= ERROR_LIMIT) return
    stderr += chunk.toString()
  })

  return {
    async connect() {
      await client.connect(transport, {
        timeout: target.initializeTimeoutMs,
        maxTotalTimeout: target.initializeTimeoutMs,
      })
    },
    async listTools() {
      const { tools } = await client.listTools(undefined, {
        timeout: target.toolsListTimeoutMs,
        maxTotalTimeout: target.toolsListTimeoutMs,
      })
      return tools.length
    },
    async close() {
      await client.close().catch(() => undefined)
      await transport.close().catch(() => undefined)
    },
    diagnostics() {
      return stderr
    },
    pid() {
      return transport.pid
    },
  }
}

/** Measure initialize and tools/list separately, preserving partial timing when the latter fails. */
export async function measureStartupTarget(
  target: StartupTarget,
  dependencies: StartupMeasurementDependencies = {},
): Promise<StartupSample> {
  const now = dependencies.now ?? performance.now.bind(performance)
  let probe: StartupProbe
  try {
    probe = (dependencies.createProbe ?? createStdioStartupProbe)(target)
  } catch (error) {
    return setupFailureSample(target, error)
  }
  let serverReadyMs: number | null = null
  let failurePhase: StartupFailurePhase = 'initialize'
  try {
    const initializeStarted = now()
    await probe.connect()
    serverReadyMs = Math.max(0, now() - initializeStarted)

    failurePhase = 'tools/list'
    const toolsListStarted = now()
    const toolCount = await probe.listTools()
    const toolsListMs = Math.max(0, now() - toolsListStarted)
    return {
      mode: target.mode,
      profile: target.profile,
      cache_state: target.cacheState,
      iteration: target.iteration,
      ok: true,
      server_ready_ms: serverReadyMs,
      tools_list_ms: toolsListMs,
      tool_count: toolCount,
    }
  } catch (error) {
    return {
      mode: target.mode,
      profile: target.profile,
      cache_state: target.cacheState,
      iteration: target.iteration,
      ok: false,
      server_ready_ms: serverReadyMs,
      tools_list_ms: null,
      tool_count: null,
      failure_phase: failurePhase,
      error: boundedFailure(error, probe.diagnostics(), target.redactPaths ?? []),
    }
  } finally {
    await probe.close().catch(() => undefined)
  }
}

/** Represent a setup failure for every direct-profile iteration without inventing timing data. */
export function setupFailureSample(target: StartupTarget, error: unknown): StartupSample {
  return {
    mode: target.mode,
    profile: target.profile,
    cache_state: target.cacheState,
    iteration: target.iteration,
    ok: false,
    server_ready_ms: null,
    tools_list_ms: null,
    tool_count: null,
    failure_phase: 'setup',
    error: boundedFailure(error, '', target.redactPaths ?? []),
  }
}

/** Run one homogeneous series sequentially so package-manager and process work never overlaps. */
export async function runStartupSeries(
  targets: readonly StartupTarget[],
  dependencies: StartupSeriesDependencies = {},
): Promise<StartupSample[]> {
  const samples: StartupSample[] = []
  for (const target of targets) {
    const sample = await measureStartupTarget(target, dependencies)
    samples.push(sample)
    await dependencies.onSample?.(sample)
  }
  return samples
}

function summarizeStartupDistribution(values: readonly number[]): StartupMetricDistribution | null {
  const distribution = summarizeDistribution(values)
  if (distribution === null) return null
  return {
    samples: distribution.samples,
    min: distribution.min,
    median: distribution.median,
    max: distribution.max,
  }
}

/** Summarize available timing only; failed rows stay explicit and never become synthetic zeroes. */
export function summarizeStartupSamples(samples: readonly StartupSample[]): StartupSummary {
  const successful = samples.filter((sample) => sample.ok)
  const serverReady = samples.flatMap((sample) =>
    sample.server_ready_ms === null ? [] : [sample.server_ready_ms],
  )
  const toolsList = successful.flatMap((sample) =>
    sample.tools_list_ms === null ? [] : [sample.tools_list_ms],
  )
  const toolCount = successful.flatMap((sample) =>
    sample.tool_count === null ? [] : [sample.tool_count],
  )
  return {
    retained_runs: samples.length,
    successful_runs: successful.length,
    failed_runs: samples.length - successful.length,
    server_ready_ms: summarizeStartupDistribution(serverReady),
    tools_list_ms: summarizeStartupDistribution(toolsList),
    tool_count: summarizeStartupDistribution(toolCount),
  }
}
