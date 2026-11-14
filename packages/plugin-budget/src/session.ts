/**
 * Measure one live app session through the transport's `evaluate` seam.
 *
 * @module
 */

import { validateEvalContent } from '@electron-stagewright/core'

import {
  measureMemory,
  osMemoryReader,
  hostStartTimeReader,
  type HostStartTimeReader,
  type OsMemoryReader,
} from './memory.js'
import {
  DEFAULT_IPC_INTERVAL_MS,
  IPC_READ_BODY,
  MAIN_BODY,
  buildIpcStartBody,
  buildMemoryProbeBody,
  type FirstWindowStartup,
  type IpcReadResult,
  type MainFacts,
  type MainReadResult,
  type RendererMetrics,
} from './probe.js'
import {
  memoryByType,
  memoryTotal,
  summarizeLatencies,
  type Measurement,
  type MemoryMeasurement,
} from './run.js'

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
  options: {
    readonly ipc?: IpcProbe
    readonly allowRenderer: boolean
    /** Why the renderer is off, when it is not the eval grant. */
    readonly rendererOff?: string
    /** Set when main eval is unavailable: only the IPC probe starts. */
    readonly mainUnavailable?: string
  },
): Promise<{ ipc: boolean; ipcUnavailable?: string }> {
  if (options.mainUnavailable === undefined) {
    await session.evaluate('main', MAIN_BODY, { op: 'start' })
  }
  if (options.ipc === undefined) return { ipc: false }
  if (!options.allowRenderer) {
    return { ipc: false, ipcUnavailable: options.rendererOff ?? RENDERER_EVAL_OFF }
  }
  try {
    // The probe is caller-supplied JavaScript: hold it to the same blocklist as the eval tools.
    validateEvalContent(options.ipc.probe, { target: 'renderer' })
  } catch (error) {
    return { ipc: false, ipcUnavailable: `the IPC probe was refused: ${message(error)}` }
  }
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
  readonly rendererOff?: string
  /** Set when {@link startWindow} already opened a window; otherwise one is run for `windowMs`. */
  readonly open?: { readonly ipc: boolean; readonly ipcUnavailable?: string }
  readonly windowMs: number
  readonly ipc?: IpcProbe
  readonly sleep?: (ms: number) => Promise<void>
  readonly memoryReader?: OsMemoryReader
  readonly hostStartTime?: HostStartTimeReader
  /** The renderer grant alone; defaults to `allowRenderer`. */
  readonly allowStartup?: boolean
  /**
   * Why main eval is unavailable (a build with the EnableNodeCliInspectArguments fuse off). Memory
   * then comes from `memoryProbe` through the renderer; blocking and startup are unmeasured.
   */
  readonly mainUnavailable?: string
  readonly memoryProbe?: string
}

/** How a sampler reads memory: from main, or through the app's renderer memory probe. */
export interface MemorySource {
  readonly mainUnavailable?: string
  readonly memoryProbe?: string
  readonly allowRenderer: boolean
  readonly memoryReader?: OsMemoryReader
}

/** Read the renderer memory probe; throws with the reason it cannot. */
async function probeMetrics(
  session: EvaluatingSession,
  source: MemorySource,
): Promise<RendererMetrics> {
  const reason = source.mainUnavailable ?? 'main eval is unavailable'
  if (source.memoryProbe === undefined) {
    throw new Error(`${reason}; name a memoryProbe in the budget to measure memory`)
  }
  if (!source.allowRenderer) throw new Error(`${reason}, and ${RENDERER_EVAL_OFF}`)
  try {
    validateEvalContent(source.memoryProbe, { target: 'renderer' })
  } catch (error) {
    throw new Error(`the memory probe was refused: ${message(error)}`)
  }
  try {
    return await session.evaluate<RendererMetrics>(
      'renderer',
      buildMemoryProbeBody(source.memoryProbe),
    )
  } catch (error) {
    throw new Error(`the memory probe failed: ${message(error)}`)
  }
}

/**
 * One memory sample of the app, for a sampler that runs during the window. Only used on an app
 * this host launched, so the pid-namespace check of {@link measureSession} is skipped.
 */
export async function sampleMemory(
  session: EvaluatingSession,
  source: MemorySource,
): Promise<MemoryMeasurement | undefined> {
  try {
    const processes =
      source.mainUnavailable === undefined
        ? (await session.evaluate<MainFacts>('main', MAIN_BODY, { op: 'facts' })).processes
        : (await probeMetrics(session, source)).processes
    const { memory } = await measureMemory(
      processes.filter((entry) => isPid(entry.pid)),
      process.platform,
      source.memoryReader ?? osMemoryReader(process.platform),
    )
    return memory
  } catch {
    return undefined
  }
}

/** The pids the app reports, or none when they cannot be read. */
export async function appProcessIds(
  session: EvaluatingSession,
  source: MemorySource,
): Promise<number[]> {
  try {
    const processes =
      source.mainUnavailable === undefined
        ? (await session.evaluate<MainFacts>('main', MAIN_BODY, { op: 'facts' })).processes
        : (await probeMetrics(session, source)).processes
    return processes.map((entry) => entry.pid).filter(isPid)
  } catch {
    return []
  }
}

/** Memory outside the GPU in the sample's metric, else in working set. */
export function memoryWeight(memory: MemoryMeasurement): number {
  const total = memoryTotal(memory, true)
  if (total !== undefined) return total
  const byType = memoryByType({ ...memory, metric: 'workingSet' })
  return Object.entries(byType).reduce((sum, [type, mb]) => (type === 'gpu' ? sum : sum + mb), 0)
}

async function measureWithoutMain(
  session: EvaluatingSession,
  options: MeasureOptions & { readonly mainUnavailable: string },
  open: { readonly ipc: boolean; readonly ipcUnavailable?: string },
): Promise<SessionMeasurement> {
  const unavailable: Record<string, string> = {
    mainThread: options.mainUnavailable,
    startup: options.mainUnavailable,
  }
  const ipc = await readIpc(session, open, unavailable)
  let memory: MemoryMeasurement | undefined
  let electronVersion: string | undefined
  try {
    const metrics = await probeMetrics(session, options)
    electronVersion = /Electron\/(\S+)/.exec(metrics.userAgent)?.[1]
    const measured = await measureMemory(
      metrics.processes.filter((entry) => isPid(entry.pid)),
      process.platform,
      options.memoryReader ?? osMemoryReader(process.platform),
    )
    memory = measured.memory
    if (measured.error !== undefined) unavailable['memory'] = measured.error
  } catch (error) {
    unavailable['memory'] = message(error)
  }
  return {
    measurement: {
      ...(memory === undefined ? {} : { memory }),
      ...(ipc === undefined ? {} : { ipc }),
      unavailable,
    },
    ...(electronVersion === undefined ? {} : { electronVersion }),
    platform: process.platform,
  }
}

async function readIpc(
  session: EvaluatingSession,
  open: { readonly ipc: boolean; readonly ipcUnavailable?: string },
  unavailable: Record<string, string>,
): Promise<Measurement['ipc']> {
  if (open.ipcUnavailable !== undefined) unavailable['ipc'] = open.ipcUnavailable
  if (!open.ipc) return undefined
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
      return summarizeLatencies(read.samples)
    }
  } catch (error) {
    unavailable['ipc'] = `could not read the IPC probe: ${message(error)}`
  }
  return undefined
}

/** `ps` start times have whole-second resolution. */
const START_TIME_TOLERANCE_MS = 2_000

/**
 * Pids come from the app, but the OS reader runs on this host. Refuse to read them when the
 * host's process with the main pid did not start when the app's main process did.
 */
async function hostMismatch(
  facts: MainFacts,
  reader: HostStartTimeReader | undefined,
): Promise<string | undefined> {
  if (!isPid(facts.pid)) return 'the app reported an invalid main pid'
  if (facts.creationTime === null || reader === undefined) return undefined
  const started = await reader(facts.pid)
  if (started === undefined) return undefined
  if (started !== 'missing' && Math.abs(started - facts.creationTime) <= START_TIME_TOLERANCE_MS) {
    return undefined
  }
  return `pid ${facts.pid} on this host is not the app's main process (another pid namespace?)`
}

/** App-reported pids reach host commands and /proc paths, so only plain pids pass. */
const isPid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

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
      ...(options.rendererOff === undefined ? {} : { rendererOff: options.rendererOff }),
      ...(options.ipc === undefined ? {} : { ipc: options.ipc }),
      ...(options.mainUnavailable === undefined
        ? {}
        : { mainUnavailable: options.mainUnavailable }),
    })
    await sleep(options.windowMs)
  }
  if (options.mainUnavailable !== undefined) {
    return measureWithoutMain(
      session,
      { ...options, mainUnavailable: options.mainUnavailable },
      open,
    )
  }

  const stall = await session.evaluate<MainReadResult>('main', MAIN_BODY, {
    op: 'read',
    stop: true,
  })
  // The app restarted its main process mid-window, or the window outlived MAX_WINDOW_MS.
  if (stall === null) unavailable['mainThread'] = 'the measurement window was lost or expired'

  const ipc = await readIpc(session, open, unavailable)

  const facts = await session.evaluate<MainFacts>('main', MAIN_BODY, { op: 'facts' })
  let reader = options.memoryReader ?? osMemoryReader(facts.platform)
  const mismatch =
    reader === undefined
      ? undefined
      : await hostMismatch(facts, options.hostStartTime ?? hostStartTimeReader(facts.platform))
  if (mismatch !== undefined) {
    reader = () => Promise.reject(new Error(mismatch))
  }
  const { memory, error: memoryError } = await measureMemory(
    facts.processes.filter((entry) => isPid(entry.pid)),
    facts.platform,
    reader,
  )
  if (memoryError !== undefined) unavailable['memory'] = memoryError

  let startup: Measurement['startup']
  if (options.allowStartup === false) {
    unavailable['startup'] = RENDERER_EVAL_OFF
  } else if (options.allowStartup === undefined && !options.allowRenderer) {
    unavailable['startup'] = options.rendererOff ?? RENDERER_EVAL_OFF
  } else if (facts.creationTime === null) {
    unavailable['startup'] = 'this Electron does not report the process creation time'
  } else {
    try {
      // Read from main so the first window counts, not whichever renderer is selected.
      const timing = await session.evaluate<FirstWindowStartup>('main', MAIN_BODY, {
        op: 'startup',
      })
      if ('error' in timing) throw new Error(timing.error)
      const firstWindowMs = timing.timeOrigin + timing.loadEventEnd - facts.creationTime
      // A later document means the first one was left; pushState keeps the document.
      const navigated =
        timing.firstUrl !== null ? timing.url !== timing.firstUrl : (timing.historyLength ?? 1) > 1
      if (timing.type !== 'navigate' || navigated) {
        unavailable['startup'] = 'the first window was reloaded or navigated since launch'
      } else if (
        !(timing.loadEventEnd > 0) ||
        !(firstWindowMs > 0) ||
        !Number.isFinite(firstWindowMs)
      ) {
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
