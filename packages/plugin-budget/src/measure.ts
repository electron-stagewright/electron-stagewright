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
import { createRun, type BudgetRun } from './run.js'
import { measureSession, startWindow, type IpcProbe } from './session.js'

export type LaunchPhase = 'cold' | 'warm'

/** What a workload script receives: the tool dispatcher of the server driving the app. */
export interface WorkloadContext {
  readonly sessionId: string
  readonly phase: LaunchPhase
  dispatch(tool: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>
}

export type Workload = (context: WorkloadContext) => Promise<void>

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
  readonly label?: string
  readonly onProgress?: (message: string) => void
}

export const DEFAULT_ROUNDS = 3
export const DEFAULT_SETTLE_MS = 3_000
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

/** Launch once on `profile` and, when `measure` is set, take one measurement. */
async function launchOnce(
  options: MeasureAppOptions,
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
      args: [...(options.launch.args ?? []), `--user-data-dir=${profile}`],
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
      const open = await startWindow(session, {
        allowRenderer: true,
        ...(ipc === undefined ? {} : { ipc }),
      })
      const windowMs = options.windowMs ?? options.budget?.mainThread?.windowMs ?? DEFAULT_WINDOW_MS
      if (options.workload === undefined) await sleep(windowMs)
      else await options.workload({ sessionId: managed.id, phase, dispatch })

      const measured = await measureSession(session, { allowRenderer: true, open, windowMs })
      return {
        measurement: measured.measurement,
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
  for (let round = 1; round <= (options.rounds ?? DEFAULT_ROUNDS); round += 1) {
    const profile = await mkdtemp(path.join(tmpdir(), 'sw-budget-profile-'))
    try {
      for (const phase of ['cold', 'warm'] as const) {
        const measure = phases.includes(phase)
        if (!measure && !(phase === 'cold' && phases.includes('warm'))) continue
        options.onProgress?.(`round ${round}: ${phase}${measure ? '' : ' (priming, unmeasured)'}`)
        const result = await launchOnce(options, profile, phase, measure)
        electronVersion ??= result.electronVersion
        if (result.measurement !== undefined) {
          rounds.push({ round, phase, measurement: result.measurement })
        }
      }
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
  return createRun({
    rounds,
    ...(electronVersion === undefined ? {} : { electronVersion }),
    ...(options.label === undefined ? {} : { label: options.label }),
  })
}
