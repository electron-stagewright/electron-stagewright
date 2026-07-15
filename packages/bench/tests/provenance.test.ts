import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { collectComparisonProvenance } from '../src/provenance.js'
import type { ServerTarget } from '../src/harness.js'

function target(
  name: string,
  args: readonly string[],
  environment: Record<string, string> = {},
): ServerTarget {
  return {
    name,
    command: 'node',
    args,
    env: environment,
    supportsMemory: false,
    provenance: {
      source: 'workspace',
      package: { name: '@electron-stagewright/core', version: '0.2.0' },
    },
  }
}

describe('comparison provenance', () => {
  it('records reproducible facts without retaining child environment values', async () => {
    const provenance = await collectComparisonProvenance([
      target('workspace', [path.resolve('packages/bench/src/harness.ts')], {
        DISPLAY: ':99',
        PRIVATE_TOKEN: 'do-not-record',
      }),
      target('missing-entry', [path.resolve('missing-entry.mjs')]),
    ])

    expect(provenance.environment).toMatchObject({
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    })
    expect(provenance.fixture).toHaveLength(9)
    expect(provenance.fixture.every((file) => !path.isAbsolute(file.path))).toBe(true)
    expect(provenance.fixture.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true)
    expect(provenance.targets).toEqual([
      expect.objectContaining({
        name: 'workspace',
        childEnvironment: ['DISPLAY', 'PRIVATE_TOKEN'],
        entrySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({ name: 'missing-entry', entrySha256: null }),
    ])
    expect(JSON.stringify(provenance)).not.toContain('do-not-record')
  })
})
