import { describe, expect, it } from 'vitest'

import type { Budget } from '../src/budget.js'
import { checkRun } from '../src/check.js'
import { summarizeRun } from '../src/run.js'
import { measureSession, type EvaluatingSession } from '../src/session.js'
import { measurement, run } from './helpers.js'

const NO_MAIN = 'main eval is unavailable (fused build)'

function cdpOnly(metrics: unknown): EvaluatingSession & { bodies: string[] } {
  const bodies: string[] = []
  return {
    bodies,
    evaluate: async <T>(target: 'main' | 'renderer', body: string): Promise<T> => {
      if (target === 'main') throw new Error('evaluate(main) is not supported over CDP')
      bodies.push(body)
      if (body.includes('window.api.metrics()')) {
        return {
          userAgent: 'Mozilla/5.0 Chrome/140 Electron/45.1.0 Safari/537.36',
          processes: metrics,
        } as T
      }
      throw new Error(`unexpected renderer body`)
    },
  }
}

const METRICS = [
  { pid: 101, type: 'Browser', name: null, workingSetKb: 102_400, privateKb: 81_920 },
  { pid: 102, type: 'Tab', name: null, workingSetKb: 51_200, privateKb: 40_960 },
  { pid: 103, type: 'GPU', name: null, workingSetKb: 204_800, privateKb: 163_840 },
]

describe('measuring without main eval', () => {
  it('reads memory through the memory probe and reports what needs main', async () => {
    const session = cdpOnly(METRICS)
    const result = await measureSession(session, {
      allowRenderer: true,
      open: { ipc: false },
      windowMs: 0,
      mainUnavailable: NO_MAIN,
      memoryProbe: 'window.api.metrics()',
      memoryReader: async (pids) => new Map(pids.map((pid) => [pid, pid * 1024 * 1024])),
    })
    expect(result.electronVersion).toBe('45.1.0')
    expect(result.measurement.unavailable).toMatchObject({ mainThread: NO_MAIN, startup: NO_MAIN })
    expect(result.measurement.memory?.processes.map((entry) => entry.type)).toEqual([
      'main',
      'renderer',
      'gpu',
    ])
    expect(result.measurement.memory?.processes[0]?.workingSetMb).toBe(100)
  })

  it('says to name a memoryProbe when there is none', async () => {
    const result = await measureSession(cdpOnly(METRICS), {
      allowRenderer: true,
      open: { ipc: false },
      windowMs: 0,
      mainUnavailable: NO_MAIN,
    })
    expect(result.measurement.memory).toBeUndefined()
    expect(result.measurement.unavailable?.['memory']).toMatch(/memoryProbe/)
  })

  it('refuses a memory probe the eval blocklist rejects', async () => {
    const result = await measureSession(cdpOnly(METRICS), {
      allowRenderer: true,
      open: { ipc: false },
      windowMs: 0,
      mainUnavailable: NO_MAIN,
      memoryProbe: "require('child_process')",
    })
    expect(result.measurement.unavailable?.['memory']).toMatch(/refused/)
  })
})

describe('peak memory', () => {
  const budget = (aggregate: 'end' | 'peak'): Budget => ({
    memory: { darwin: { metric: 'footprint', aggregate, perTypeMb: { main: 150 } } },
  })

  it('gates the peak sample when the budget asks for it', () => {
    const end = measurement(100)
    const peak = measurement(200)
    const measured = run([['cold', { ...end, memoryPeak: peak.memory }]])
    expect(summarizeRun(measured).find((row) => row.id === 'memoryPeak.main')?.value).toBe(200)
    expect(checkRun(measured, budget('end')).passed).toBe(true)
    const report = checkRun(measured, budget('peak'))
    expect(report.results[0]).toMatchObject({ id: 'memoryPeak.main', actual: 200, status: 'fail' })
  })

  it('explains a run that sampled no peak', () => {
    const result = checkRun(run([['cold', measurement(100)]]), budget('peak')).results[0]
    expect(result).toMatchObject({ status: 'unmeasured' })
    expect(result?.detail).toMatch(/--memory-sample-ms/)
  })
})
