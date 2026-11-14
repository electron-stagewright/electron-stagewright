import { describe, expect, it } from 'vitest'

import { startSampler } from '../src/measure.js'
import type { MemoryMeasurement } from '../src/run.js'
import { heavierMemory, type EvaluatingSession } from '../src/session.js'

const sample = (mainMb: number | undefined, workingSetMb: number): MemoryMeasurement => ({
  metric: 'footprint',
  processes: [
    { pid: 1, type: 'main', workingSetMb, ...(mainMb === undefined ? {} : { mb: mainMb }) },
  ],
})

const failing: EvaluatingSession = {
  evaluate: () => Promise.reject(new Error('the app is gone')),
}

describe('peak sampling', () => {
  it('prefers a complete sample over a heavier one that fell back to working set', () => {
    expect(heavierMemory(sample(100, 150), sample(undefined, 400))).toBe(true)
    expect(heavierMemory(sample(undefined, 400), sample(100, 150))).toBe(false)
    expect(heavierMemory(sample(120, 150), sample(100, 400))).toBe(true)
  })

  it('stops without waiting out the interval, and reports no peak when every sample failed', async () => {
    const sampler = startSampler(failing, { allowRenderer: true }, 60_000)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const started = Date.now()
    await sampler.stop()
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(sampler.peak(sample(100, 150))).toBeUndefined()
  })
})
