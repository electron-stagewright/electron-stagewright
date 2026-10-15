/**
 * MCP Registry gate for the root `server.json`. The registry rejects a publish whose metadata
 * breaks its schema limits or disagrees with the npm package, and that only surfaces after npm
 * has already shipped, so these checks run in `pnpm test` instead.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')

// Enforced by the registry's validator for body.description.
const MAX_DESCRIPTION_LENGTH = 100

async function readJson(relPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(REPO_ROOT, relPath), 'utf8')) as Record<
    string,
    unknown
  >
}

describe('server.json', () => {
  it('keeps the description within the registry limit', async () => {
    const server = await readJson('server.json')
    expect(typeof server['description']).toBe('string')
    expect((server['description'] as string).length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
  })

  it('matches the core package name, mcpName and version', async () => {
    const server = await readJson('server.json')
    const core = await readJson('packages/core/package.json')
    const packages = server['packages'] as readonly Record<string, unknown>[]

    expect(server['name']).toBe(core['mcpName'])
    expect(server['version']).toBe(core['version'])
    expect(packages).toEqual([
      expect.objectContaining({
        registryType: 'npm',
        identifier: core['name'],
        version: core['version'],
      }),
    ])
  })
})
