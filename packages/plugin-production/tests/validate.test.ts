/** Public library API tests for production validation outside MCP. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CheckId } from '../src/checks.js'
import { validateProductionApp } from '../src/validate.js'
import type { ProductionValidationError } from '../src/validate.js'

const created: string[] = []
afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
})

async function makeBundle(options: { info?: boolean; executable?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'stagewright-production-api-'))
  created.push(root)
  const appPath = path.join(root, 'Demo.app')
  await mkdir(path.join(appPath, 'Contents', 'MacOS'), { recursive: true })
  if (options.info ?? true) {
    await writeFile(path.join(appPath, 'Contents', 'Info.plist'), '<plist/>\n')
  }
  if (options.executable ?? true) {
    await writeFile(path.join(appPath, 'Contents', 'MacOS', 'Demo'), '#!/bin/sh\n')
  }
  return appPath
}

describe('validateProductionApp', () => {
  it('returns the transport-neutral report and canonical selected checks', async () => {
    const appPath = await makeBundle()
    const onCheckStart = vi.fn()

    const report = await validateProductionApp(appPath, {
      checks: ['bundle-structure', 'updater-feed'],
      onCheckStart,
    })

    expect(report).toMatchObject({
      app_path: appPath,
      passed: true,
      summary: { pass: 1, fail: 0, unknown: 1 },
    })
    expect(report.checks.map((check) => check.id)).toEqual(['bundle-structure', 'updater-feed'])
    expect(onCheckStart).toHaveBeenCalledTimes(2)
  })

  it('returns check failures as data instead of throwing', async () => {
    const report = await validateProductionApp(await makeBundle({ info: false }), {
      checks: ['bundle-structure'],
    })

    expect(report).toMatchObject({
      passed: false,
      summary: { pass: 0, fail: 1, unknown: 0 },
      checks: [{ id: 'bundle-structure', status: 'fail' }],
    })
  })

  it('throws stable caller errors before validation starts', async () => {
    await expect(validateProductionApp('relative/Demo.app')).rejects.toMatchObject({
      code: 'ABSOLUTE_PATH_REQUIRED',
    })
    await expect(
      validateProductionApp(path.join(tmpdir(), 'stagewright-production-missing.app')),
    ).rejects.toMatchObject({ code: 'APP_NOT_FOUND' })

    const root = await mkdtemp(path.join(tmpdir(), 'stagewright-production-api-'))
    created.push(root)
    const file = path.join(root, 'Demo.app')
    await writeFile(file, 'not a bundle')
    await expect(validateProductionApp(file)).rejects.toMatchObject({ code: 'NOT_A_BUNDLE' })
  })

  it('rejects invalid direct-JavaScript options without a false green report', async () => {
    const appPath = await makeBundle()
    await expect(validateProductionApp(appPath, { checks: [] })).rejects.toEqual(
      expect.objectContaining<Partial<ProductionValidationError>>({
        code: 'INVALID_OPTIONS',
      }),
    )
    await expect(
      validateProductionApp(appPath, { checks: ['not-a-check' as CheckId] }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' })
    await expect(validateProductionApp(appPath, { commandTimeoutMs: 0 })).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    })
  })
})
