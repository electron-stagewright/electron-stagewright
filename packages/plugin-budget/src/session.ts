/**
 * Measure one live app session through the transport's `evaluate` seam.
 *
 * @module
 */

import { measureMemory, type OsMemoryReader } from './memory.js'
import {
  DEFAULT_IPC_INTERVAL_MS,
  IPC_READ_BODY,
  MAIN_BODY,
  STARTUP_BODY,
  buildIpcStartBody,
  type IpcReadResult,
  type MainFacts,
  type MainReadResult,
  type RendererStartup,
} from './probe.js'
import { summarizeLatencies, type Measurement } from './run.js'

/** The slice of a transport session the budget needs. */
export interface EvaluatingSession {
  evaluate<T = unknown>(target: 'main' | 'renderer', body: string, arg?: unknown): Promise<T>
}

export interface IpcProbe {
  readonly probe: string
  readonly intervalMs?: number
}

export const MAIN_EVAL_OFF =
  'main eval is off; start the server with --allow-eval=main (or bare --allow-eval)'
export const RENDERER_EVAL_OFF =
  'renderer eval is off; start the server with bare --allow-eval to measure it'

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Open a measurement window: arm the main-thread sampler and, when a probe is given and renderer
 * eval is allowed, the IPC probe loop. Returns why the IPC probe did not start, if it did not.
 */
export async function startWindow(
  session: EvaluatingSession,
  options: { readonly ipc?: IpcProbe; readonly allowRenderer: boolean },
): Promise<{ ipc: boolean; ipcUnavailable?: string }> {
  await session.evaluate('main', MAIN_BODY, { op: 'start' })
  if (options.ipc === undefined) return { ipc: false }
  if (!options.allowRenderer) return { ipc: false, ipcUnavailable: RENDERER_EVAL_OFF }
  try {
    await session.evaluate('renderer', buildIpcStartBody(options.ipc.probe), {
      intervalMs: options.ipc.intervalMs ?? DEFAULT_IPC_INTERVAL_MS,
    })
    return { ipc: true }
  } catch (error) {
    return { ipc: false, ipcUnavailable: `the IPC probe did not start: ${message(error)}` }
  }
}

export interface MeasureOptions {
  readonly allowRenderer: boolean
  /** Set when {@link startWindow} already opened a window; otherwise one is run for `windowMs`. */
  readonly open?: { readonly ipc: boolean; readonly ipcUnavailable?: string }
  readonly windowMs: number
  readonly ipc?: IpcProbe
  readonly sleep?: (ms: number) => Promise<void>
  readonly memoryReader?: OsMemoryReader
}

export interface SessionMeasurement {
  readonly measurement: Measurement
  readonly electronVersion?: string
  readonly platform: string
}

/** Close the window (running one first when none is open) and sample memory and startup. */
export async function measureSession(
  session: EvaluatingSession,
  options: MeasureOptions,
): Promise<SessionMeasurement> {
  const unavailable: Record<string, string> = {}
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  let open = options.open
  if (open === undefined) {
    open = await startWindow(session, {
      allowRenderer: options.allowRenderer,
      ...(options.ipc === undefined ? {} : { ipc: options.ipc }),
    })
    await sleep(options.windowMs)
  }

  const stall = await session.evaluate<MainReadResult>('main', MAIN_BODY, {
    op: 'read',
    stop: true,
  })
  // The app restarted its main process mid-window, so the sampler is gone.
  if (stall === null) unavailable['mainThread'] = 'the measurement window was lost'

  let ipc: Measurement['ipc']
  if (open.ipcUnavailable !== undefined) unavailable['ipc'] = open.ipcUnavailable
  if (open.ipc) {
    try {
      const read = await session.evaluate<IpcReadResult | null>('renderer', IPC_READ_BODY, {
        stop: true,
      })
      if (read === null) {
        unavailable['ipc'] = 'the IPC probe was lost; the window navigated during the measurement'
      } else if (read.samples.length === 0) {
        unavailable['ipc'] =
          read.lastError === null
            ? 'the IPC probe completed no round trip'
            : `the IPC probe failed: ${read.lastError}`
      } else {
        ipc = summarizeLatencies(read.samples)
      }
    } catch (error) {
      unavailable['ipc'] = `could not read the IPC probe: ${message(error)}`
    }
  }

  const facts = await session.evaluate<MainFacts>('main', MAIN_BODY, { op: 'facts' })
  const { memory, error: memoryError } = await measureMemory(
    facts.processes,
    facts.platform,
    options.memoryReader,
  )
  if (memoryError !== undefined) unavailable['memory'] = memoryError

  let startup: Measurement['startup']
  if (!options.allowRenderer) {
    unavailable['startup'] = RENDERER_EVAL_OFF
  } else if (facts.creationTime === null) {
    unavailable['startup'] = 'this Electron does not report the process creation time'
  } else {
    try {
      const timing = await session.evaluate<RendererStartup>('renderer', STARTUP_BODY)
      const firstWindowMs = timing.timeOrigin + timing.loadEventEnd - facts.creationTime
      if (timing.type !== 'navigate') {
        unavailable['startup'] = 'the window was reloaded or navigated since launch'
      } else if (timing.loadEventEnd <= 0 || firstWindowMs <= 0) {
        unavailable['startup'] = 'the window has not finished loading'
      } else {
        startup = { firstWindowMs: Math.round(firstWindowMs) }
      }
    } catch (error) {
      unavailable['startup'] = `could not read navigation timing: ${message(error)}`
    }
  }

  return {
    measurement: {
      ...(startup === undefined ? {} : { startup }),
      memory,
      ...(stall === null ? {} : { mainThread: stall }),
      ...(ipc === undefined ? {} : { ipc }),
      ...(Object.keys(unavailable).length === 0 ? {} : { unavailable }),
    },
    ...(facts.electron === null ? {} : { electronVersion: facts.electron }),
    platform: facts.platform,
  }
}
