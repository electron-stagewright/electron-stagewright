import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  collectComparisonProvenance,
  collectStartupProvenance,
  normalizeRepositoryPath,
} from '../src/provenance.js'
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
  it('normalizes serialized repository labels independently of the host platform', () => {
    expect(normalizeRepositoryPath('packages\\bench\\package.json')).toBe(
      'packages/bench/package.json',
    )
    expect(normalizeRepositoryPath('packages/bench/package.json')).toBe(
      'packages/bench/package.json',
    )
  })

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
    expect(provenance.fixture.every((file) => !file.path.includes('\\'))).toBe(true)
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

  it('fingerprints startup harness inputs without retaining child environment values', async () => {
    const provenance = await collectStartupProvenance(
      {
        publishedPackages: [
          '@electron-stagewright/core@0.4.1',
          'playwright@1.61.1',
          'electron@42.3.0',
        ],
        profiles: ['essential', 'full'],
        cacheModes: ['empty', 'reused', 'installed'],
        childEnvironment: {
          publishedNpx: {
            inherited: ['PATH', 'HOME', 'PATH'],
            overrides: ['PRIVATE_TOKEN', 'HOME', 'PRIVATE_TOKEN'],
          },
          directMaterialization: {
            inherited: ['PATH', 'HOME'],
            overrides: ['HTTPS_PROXY', 'HOME'],
          },
          directCli: {
            inherited: ['PATH', 'HOME'],
            overrides: ['NO_COLOR'],
          },
        },
      },
      {
        packageCommandVersion: (command) => (command === 'npm' ? '11.16.0' : '11.3.0'),
      },
    )

    expect(provenance.environment).toMatchObject({
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    })
    expect(provenance.harness).toHaveLength(8)
    expect(provenance.harness.every((file) => !path.isAbsolute(file.path))).toBe(true)
    expect(provenance.harness.every((file) => !file.path.includes('\\'))).toBe(true)
    expect(provenance.harness.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true)
    expect(provenance.harness.map((file) => file.path)).toEqual(
      expect.arrayContaining(['pnpm-lock.yaml', 'packages/bench/package.json']),
    )
    expect(provenance.environment).toMatchObject({ npm: '11.16.0', pnpm: '11.3.0' })
    expect(provenance.childEnvironment).toEqual({
      publishedNpx: {
        inherited: ['HOME', 'PATH'],
        overrides: ['HOME', 'PRIVATE_TOKEN'],
      },
      directMaterialization: {
        inherited: ['HOME', 'PATH'],
        overrides: ['HOME', 'HTTPS_PROXY'],
      },
      directCli: {
        inherited: ['HOME', 'PATH'],
        overrides: ['NO_COLOR'],
      },
    })
    expect(JSON.stringify(provenance)).not.toContain('do-not-record')
  })
})
