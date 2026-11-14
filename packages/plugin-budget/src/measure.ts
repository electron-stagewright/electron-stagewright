/**
 * Launch an app and measure it over cold and warm rounds on a throwaway profile.
 *
 * @module
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { NOOP_LOGGER, createServer, type StagewrightServer } from '@electron-stagewright/core'

import type { Budget } from './budget.js'
import { DEFAULT_WINDOW_MS } from './probe.js'
import { createRun, type BudgetRun, type MemoryMeasurement } from './run.js'
import {
  measureSession,
  heavierMemory,
  sampleMemory,
  startWindow,
  type IpcProbe,
  type MemorySource,
} from './session.js'

export type LaunchPhase = 'cold' | 'warm'

/** What a workload script receives: the tool dispatcher of the server driving the app. */
export interface WorkloadContext {
  readonly sessionId: string
  readonly phase: LaunchPhase
  dispatch(tool: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>
}

export type Workload = (context: WorkloadContext) => Promise<void>

/** What `beforeRound` may add to the launches of one round. */
export interface RoundSetup {
  readonly env?: Readonly<Record<string, string>>
  readonly args?: readonly string[]
}

/**
 * Runs before each round's first launch, to hand it fresh state (a database copy, a seeded
 * fixture). `profile` is the round's empty user-data directory.
 */
export type BeforeRound = (context: {
  readonly round: number
  readonly profile: string
}) => RoundSetup | void | Promise<RoundSetup | void>

export interface MeasureAppOptions {
  /** `electron_launch` arguments: `main` and/or `executablePath`, plus `args`, `env`, `cwd`. */
  readonly launch: {
    readonly main?: string
    readonly executablePath?: string
    readonly args?: readonly string[]
    readonly env?: Readonly<Record<string, string>>
    readonly cwd?: string
  }
  readonly rounds?: number
  readonly phases?: readonly LaunchPhase[]
  /** Wait after the window loads before the measurement window opens. */
  readonly settleMs?: number
  readonly windowMs?: number
  /** Supplies the IPC probe and the default window length. */
  readonly budget?: Budget
  /** Runs inside the measurement window instead of idling for `windowMs`. */
  readonly workload?: Workload
  /** A workload still running after this fails the measurement. */
  readonly workloadTimeoutMs?: number
  readonly label?: string
  readonly onProgress?: (message: string) => void
  readonly beforeRound?: BeforeRound
  /**
   * Sample memory this often during the window and record the highest sample outside the GPU as
   * `memoryPeak`. Defaults to 1000 when the budget's memory block for this platform reads `peak`.
   */
  readonly memorySampleMs?: number
  /**
   * `skip` reports a round whose launch or measurement failed and goes on to the next one; pair
   * it with `checkRun`'s `minSamples`. Default `throw`.
   */
  readonly failedRounds?: 'throw' | 'skip'
}

export const DEFAULT_ROUNDS = 3
export const DEFAULT_SETTLE_MS = 3_000
export const DEFAULT_WORKLOAD_TIMEOUT_MS = 120_000
export const DEFAULT_MEMORY_SAMPLE_MS = 1_000
const LOAD_TIMEOUT_MS = 30_000

// loadEventEnd is only set once the load event has finished.
const LOADED_BODY = `
await new Promise((resolve) => {
  if (document.readyState === 'complete') resolve();
  else addEventListener('load', resolve, { once: true });
});
await new Promise((resolve) => setTimeout(resolve, 0));
return true;
`

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Why main eval is unavailable on this session, or undefined when it works. */
async function mainEvalUnavailable(session: {
  evaluate(target: 'main', body: string): Promise<unknown>
}): Promise<string | undefined> {
  try {
    await session.evaluate('main', 'return true')
    return undefined
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return `main eval is unavailable (${reason})`
  }
}

function memorySampleMs(options: MeasureAppOptions): number | undefined {
  if (options.memorySampleMs !== undefined) return options.memorySampleMs
  const platform = process.platform as keyof NonNullable<Budget['memory']>
  return options.budget?.memory?.[platform]?.aggregate === 'peak'
    ? DEFAULT_MEMORY_SAMPLE_MS
    : undefined
}

/** Bounds the wait for a sample still running when the window closes. */
const SAMPLER_STOP_MS = 5_000

/**
 * Samples memory until stopped; `peak` keeps the heaviest sample outside the GPU, or returns
 * undefined when no sample during the window succeeded.
 */
export function startSampler(
  session: Parameters<typeof sampleMemory>[0],
  source: MemorySource,
  intervalMs: number | undefined,
): {
  stop(): Promise<void>
  peak(end: MemoryMeasurement | undefined): MemoryMeasurement | undefined
} {
  if (intervalMs === undefined) {
    return { stop: () => Promise.resolve(), peak: () => undefined }
  }
  let best: MemoryMeasurement | undefined
  let sampled = false
  let running = true
  let wake = (): void => undefined
  const keep = (sample: MemoryMeasurement | undefined): void => {
    if (sample !== undefined && (best === undefined || heavierMemory(sample, best))) best = sample
  }
  const loop = (async () => {
    while (running) {
      const sample = await sampleMemory(session, source)
      if (!running) break
      sampled ||= sample !== undefined
      keep(sample)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
  })()
  return {
    stop: async () => {
      running = false
      wake()
      await withTimeout(loop, SAMPLER_STOP_MS, 'memory sampler').catch(() => undefined)
    },
    peak: (end) => {
      if (!sampled) return undefined
      keep(end)
      return best
    },
  }
}

function checkSetup(setup: RoundSetup | void): RoundSetup {
  if (setup === undefined) return {}
  const strings = (value: unknown): boolean =>
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  const env = (setup as { env?: unknown }).env
  if (
    typeof setup !== 'object' ||
    (setup.args !== undefined && !strings(setup.args)) ||
    (env !== undefined && (typeof env !== 'object' || env === null || !strings(Object.values(env))))
  ) {
    throw new TypeError('beforeRound must return { env?: Record<string, string>, args?: string[] }')
  }
  return setup
}

/** Launch once on `profile` and, when `measure` is set, take one measurement. */
async function launchOnce(
  options: MeasureAppOptions,
  setup: RoundSetup,
  profile: string,
  phase: LaunchPhase,
  measure: boolean,
): Promise<{ measurement?: BudgetRun['rounds'][number]['measurement']; electronVersion?: string }> {
  const server: StagewrightServer = await createServer({ allowEval: true, logger: NOOP_LOGGER })
  const dispatch = (tool: string, args: Record<string, unknown> = {}) =>
    server.dispatcher.dispatch(tool, args) as unknown as Promise<Record<string, unknown>>
  try {
    const launched = await dispatch('electron_launch', {
      ...options.launch,
      ...(options.launch.env === undefined && setup.env === undefined
        ? {}
        : { env: { ...options.launch.env, ...setup.env } }),
      args: [...(options.launch.args ?? []), ...(setup.args ?? []), `--user-data-dir=${profile}`],
    })
    if (launched['ok'] !== true) {
      throw new Error(`could not launch the app: ${String(launched['error'] ?? launched['code'])}`)
    }
    const managed = server.sessions.resolve()
    try {
      const session = managed.session
      await withTimeout(session.evaluate('renderer', LOADED_BODY), LOAD_TIMEOUT_MS, 'window load')
      await sleep(options.settleMs ?? DEFAULT_SETTLE_MS)
      // A priming launch still loads and settles, so it leaves the profile a measured cold one would.
      if (!measure) return {}

      const probe = options.budget?.ipc
      const ipc: IpcProbe | undefined =
        probe === undefined
          ? undefined
          : {
              probe: probe.probe,
              ...(probe.intervalMs === undefined ? {} : { intervalMs: probe.intervalMs }),
            }
      // A build with the EnableNodeCliInspectArguments fuse off launches over CDP alone.
      const mainUnavailable = await mainEvalUnavailable(session)
      const open = await startWindow(session, {
        allowRenderer: true,
        ...(ipc === undefined ? {} : { ipc }),
        ...(mainUnavailable === undefined ? {} : { mainUnavailable }),
      })
      const memoryProbe = options.budget?.memoryProbe
      const source: MemorySource = {
        allowRenderer: true,
        ...(mainUnavailable === undefined ? {} : { mainUnavailable }),
        ...(memoryProbe === undefined ? {} : { memoryProbe }),
      }
      const sampler = startSampler(session, source, memorySampleMs(options))
      const windowMs = options.windowMs ?? options.budget?.mainThread?.windowMs ?? DEFAULT_WINDOW_MS
      try {
        if (options.workload === undefined) await sleep(windowMs)
        else {
          // A timed-out workload keeps running; once the window closes its dispatch rejects, so a
          // polling loop ends instead of keeping the process alive.
          let ended = false
          const workloadDispatch: WorkloadContext['dispatch'] = (tool, args) =>
            ended
              ? Promise.reject(new Error('the measurement window has closed'))
              : dispatch(tool, args)
          try {
            await withTimeout(
              options.workload({ sessionId: managed.id, phase, dispatch: workloadDispatch }),
              options.workloadTimeoutMs ?? DEFAULT_WORKLOAD_TIMEOUT_MS,
              'workload',
            )
          } finally {
            ended = true
          }
        }
      } finally {
        await sampler.stop()
      }

      const measured = await measureSession(session, {
        allowRenderer: true,
        open,
        windowMs,
        ...(mainUnavailable === undefined ? {} : { mainUnavailable }),
        ...(memoryProbe === undefined ? {} : { memoryProbe }),
      })
      const sampleMs = memorySampleMs(options)
      const peak = sampler.peak(measured.measurement.memory)
      const unavailable =
        sampleMs !== undefined && peak === undefined
          ? {
              unavailable: {
                ...measured.measurement.unavailable,
                memoryPeak: 'no memory sample succeeded during the window',
              },
            }
          : {}
      return {
        measurement: {
          ...measured.measurement,
          ...unavailable,
          ...(peak === undefined ? {} : { memoryPeak: peak }),
        },
        ...(measured.electronVersion === undefined
          ? {}
          : { electronVersion: measured.electronVersion }),
      }
    } finally {
      await dispatch('electron_stop', { sessionId: managed.id }).catch(() => undefined)
    }
  } finally {
    await server.close().catch(() => undefined)
  }
}

/**
 * Measure `rounds` rounds. Each round gets an empty profile: the first launch on it is `cold`,
 * the relaunch `warm`. Asking only for `warm` still does the cold launch, unmeasured.
 */
export async function measureApp(options: MeasureAppOptions): Promise<BudgetRun> {
  const phases = options.phases ?? ['cold', 'warm']
  const rounds: BudgetRun['rounds'][number][] = []
  let electronVersion: string | undefined
  let firstFailure: unknown
  for (let round = 1; round <= (options.rounds ?? DEFAULT_ROUNDS); round += 1) {
    const profile = await mkdtemp(path.join(tmpdir(), 'sw-budget-profile-'))
    try {
      const setup = checkSetup(await options.beforeRound?.({ round, profile }))
      for (const phase of ['cold', 'warm'] as const) {
        const measure = phases.includes(phase)
        if (!measure && !(phase === 'cold' && phases.includes('warm'))) continue
        options.onProgress?.(`round ${round}: ${phase}${measure ? '' : ' (priming, unmeasured)'}`)
        const result = await launchOnce(options, setup, profile, phase, measure)
        electronVersion ??= result.electronVersion
        if (result.measurement !== undefined) {
          rounds.push({ round, phase, measurement: result.measurement })
        }
      }
    } catch (error) {
      if (options.failedRounds !== 'skip') throw error
      firstFailure ??= error
      // A warm launch shares the cold one's state, so the rest of the round is dropped too.
      options.onProgress?.(
        `round ${round} failed and was skipped: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      // A process that outlives the app can hold the profile; that must not discard the rounds.
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        (error: unknown) =>
          options.onProgress?.(
            `could not remove ${profile}: ${error instanceof Error ? error.message : String(error)}`,
          ),
      )
    }
  }
  // Every round failing is a setup problem (a wrong path, a broken script), not a budget verdict.
  if (rounds.length === 0 && firstFailure !== undefined) throw firstFailure
  return createRun({
    rounds,
    ...(electronVersion === undefined ? {} : { electronVersion }),
    ...(options.label === undefined ? {} : { label: options.label }),
  })
}
