import { describe, expect, it } from 'vitest'

import {
  checkManifestBaseline,
  createManifestBaseline,
  measureHostManifest,
} from '../src/manifest.js'

const TOOLS = [
  {
    name: 'electron_alpha',
    description: 'A short α description.',
    inputSchema: { type: 'object' },
  },
  {
    name: 'electron_beta',
    description: 'A longer β description.',
    inputSchema: { type: 'object' },
  },
]

describe('host-visible manifest measurement', () => {
  it('counts Unicode characters, UTF-8 bytes, BPE, and top tools from the host payload', () => {
    const measurement = measureHostManifest(TOOLS)
    expect(measurement.toolCount).toBe(2)
    expect(measurement.characters).toBeGreaterThan(0)
    expect(measurement.utf8Bytes).toBeGreaterThan(measurement.characters)
    expect(measurement.bpe).toBeGreaterThan(0)
    expect(measurement.toolNames).toEqual(['electron_alpha', 'electron_beta'])
    expect(measurement.topTools).toHaveLength(2)
  })

  it('fails loudly when a host manifest is not name-sorted', () => {
    expect(() => measureHostManifest([...TOOLS].reverse())).toThrow(/canonical name order/)
  })

  it('requires a reason and rejects BPE growth above the 3% budget', () => {
    const baselineMeasurement = measureHostManifest(TOOLS)
    expect(() => createManifestBaseline('', { core: baselineMeasurement })).toThrow(
      /non-empty --reason/,
    )

    const baseline = createManifestBaseline('Initial measured baseline.', {
      core: baselineMeasurement,
    })
    const grown = {
      ...baselineMeasurement,
      bpe: Math.ceil(baselineMeasurement.bpe * 1.04),
    }
    const violations = checkManifestBaseline({ core: grown }, baseline)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ variant: 'core' })
  })

  it('requires an explicit review when canonical tool names change', () => {
    const baselineMeasurement = measureHostManifest(TOOLS)
    const baseline = createManifestBaseline('Initial measured baseline.', {
      core: baselineMeasurement,
    })
    const changed = {
      ...baselineMeasurement,
      toolNames: ['electron_alpha', 'electron_gamma'],
    }
    expect(checkManifestBaseline({ core: changed }, baseline)[0]?.message).toContain('names/order')
  })
})
