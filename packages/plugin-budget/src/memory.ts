/**
 * Per-process memory in the platform's own metric, read from the host by pid.
 *
 * `app.getAppMetrics()` supplies the pids, their types, and working set; the OS supplies the
 * number a user sees: footprint on macOS, Pss on Linux, private bytes on Windows.
 *
 * @module
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { MemoryMetric, ProcessType } from './budget.js'
import type { MemoryMeasurement } from './run.js'

/** One entry of `app.getAppMetrics()`, reduced to what the budget reads. */
export interface AppProcessMetric {
  readonly pid: number
  readonly type: string
  readonly name?: string | null
  readonly workingSetKb: number
  /** Windows only. */
  readonly privateKb?: number | null
}

const MB = 1024 * 1024
const round1 = (value: number): number => Math.round(value * 10) / 10

/** Map Electron's process type (`Browser`, `Tab`, `GPU`, `Utility`, ...) to a budget bucket. */
export function classifyProcess(type: string): ProcessType {
  switch (type) {
    case 'Browser':
      return 'main'
    case 'Tab':
      return 'renderer'
    case 'GPU':
      return 'gpu'
    case 'Utility':
      return 'utility'
    default:
      return 'other'
  }
}

export function platformMetric(platform: string): MemoryMetric {
  if (platform === 'darwin') return 'footprint'
  if (platform === 'linux') return 'pss'
  if (platform === 'win32') return 'privateBytes'
  return 'workingSet'
}

/** Bytes per pid from `footprint -j` output. Pids that already exited are simply absent. */
export function parseFootprintJson(text: string): Map<number, number> {
  const parsed = JSON.parse(text) as {
    'bytes per unit'?: number
    processes?: readonly { pid?: number; footprint?: number }[]
  }
  const unit = parsed['bytes per unit'] ?? 1
  const bytes = new Map<number, number>()
  for (const entry of parsed.processes ?? []) {
    if (typeof entry.pid === 'number' && typeof entry.footprint === 'number') {
      bytes.set(entry.pid, entry.footprint * unit)
    }
  }
  return bytes
}

/** Pss in bytes from `/proc/<pid>/smaps_rollup`, or undefined when the line is missing. */
export function parseSmapsRollup(text: string): number | undefined {
  const match = /^Pss:\s+(\d+)\s+kB/m.exec(text)
  return match?.[1] === undefined ? undefined : Number(match[1]) * 1024
}

/** Reads the OS metric for a set of pids. Injected so tests never touch the host. */
export type OsMemoryReader = (pids: readonly number[]) => Promise<Map<number, number>>

const FOOTPRINT_TIMEOUT_MS = 15_000

async function readFootprint(pids: readonly number[]): Promise<Map<number, number>> {
  // footprint only writes JSON to a regular file.
  const dir = await mkdtemp(path.join(tmpdir(), 'sw-budget-fp-'))
  const file = path.join(dir, 'footprint.json')
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        '/usr/bin/footprint',
        ['-j', file, ...pids.map(String)],
        { timeout: FOOTPRINT_TIMEOUT_MS, maxBuffer: 16 * MB },
        (error) => (error === null ? resolve() : reject(error)),
      )
    })
    return parseFootprintJson(await readFile(file, 'utf8'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function readPss(pids: readonly number[]): Promise<Map<number, number>> {
  const bytes = new Map<number, number>()
  for (const pid of pids) {
    const text = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8').catch(() => undefined)
    const pss = text === undefined ? undefined : parseSmapsRollup(text)
    if (pss !== undefined) bytes.set(pid, pss)
  }
  return bytes
}

export function osMemoryReader(platform: string): OsMemoryReader | undefined {
  if (platform === 'darwin') return readFootprint
  if (platform === 'linux') return readPss
  return undefined
}

/**
 * Build the memory sample for one moment. `error` explains an OS reader that failed; the sample
 * then still carries working set, and its `metric` values are absent rather than guessed.
 */
export async function measureMemory(
  processes: readonly AppProcessMetric[],
  platform: string,
  reader: OsMemoryReader | undefined = osMemoryReader(platform),
): Promise<{ memory: MemoryMeasurement; error?: string }> {
  const metric = platformMetric(platform)
  let osBytes = new Map<number, number>()
  let error: string | undefined
  if (reader !== undefined) {
    try {
      osBytes = await reader(processes.map((entry) => entry.pid))
    } catch (cause) {
      error = `could not read ${metric}: ${cause instanceof Error ? cause.message : String(cause)}`
    }
  }
  const memory: MemoryMeasurement = {
    metric,
    processes: processes.map((entry) => {
      const bytes =
        metric === 'privateBytes'
          ? typeof entry.privateKb === 'number'
            ? entry.privateKb * 1024
            : undefined
          : osBytes.get(entry.pid)
      return {
        pid: entry.pid,
        type: classifyProcess(entry.type),
        ...(typeof entry.name === 'string' && entry.name.length > 0 ? { name: entry.name } : {}),
        ...(bytes === undefined ? {} : { mb: round1(bytes / MB) }),
        workingSetMb: round1(entry.workingSetKb / 1024),
      }
    }),
  }
  return { memory, ...(error === undefined ? {} : { error }) }
}
