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

async function makeBundle(
  options: { info?: boolean; executable?: boolean; parentDirName?: string } = {},
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'stagewright-production-api-'))
  created.push(root)
  const appPath = path.join(
    root,
    ...(options.parentDirName === undefined ? [] : [options.parentDirName]),
    'Demo.app',
  )
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
      artifact_type: 'macos-app',
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

  it('surfaces electron-builder unpacked output context in the public report', async () => {
    const appPath = await makeBundle({ parentDirName: 'mac-universal' })
    const report = await validateProductionApp(appPath, { checks: ['updater-feed'] })

    expect(report).toMatchObject({
      app_path: appPath,
      artifact_type: 'macos-app',
      passed: true,
      summary: { pass: 0, fail: 0, unknown: 1 },
      checks: [
        {
          id: 'updater-feed',
          status: 'unknown',
          evidence: 'electron-builder output=mac-universal',
        },
      ],
    })
    expect(report.checks[0]?.detail).toContain('release DMG or ZIP')
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

    const unsupported = path.join(root, 'Demo.zip')
    await writeFile(unsupported, 'not a supported artifact')
    await expect(validateProductionApp(unsupported)).rejects.toMatchObject({
      code: 'UNSUPPORTED_ARTIFACT',
    })

    const unsupportedDirectory = path.join(root, 'unpacked-output')
    await mkdir(unsupportedDirectory)
    await expect(validateProductionApp(unsupportedDirectory)).rejects.toMatchObject({
      code: 'UNSUPPORTED_ARTIFACT',
    })
  })

  it('selects Windows Authenticode by default for .exe and .msi artifacts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stagewright-production-api-'))
    created.push(root)

    for (const name of ['Demo.exe', 'Demo.msi']) {
      const artifactPath = path.join(root, name)
      await writeFile(artifactPath, 'windows artifact')
      const report = await validateProductionApp(artifactPath, {
        runCommand: async () => ({
          ok: true,
          code: 0,
          stdout:
            '{"status":"Valid","status_message":"Signature verified.","signer_subject":"CN=Acme","thumbprint":"ABC123"}',
          stderr: '',
        }),
      })

      expect(report).toMatchObject({
        app_path: artifactPath,
        artifact_type: 'windows-artifact',
        passed: true,
        summary: { pass: 1, fail: 0, unknown: 0 },
        checks: [{ id: 'windows-authenticode', status: 'pass' }],
      })
    }
  })

  it('selects embedded-signature validation by default for AppImage artifacts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stagewright-production-api-'))
    created.push(root)
    const artifactPath = path.join(root, 'Demo.AppImage')
    await writeFile(artifactPath, 'linux artifact')

    const report = await validateProductionApp(artifactPath, {
      runCommand: async () => ({
        ok: true,
        code: 0,
        stdout: '',
        stderr: 'gpg: Good signature from "Acme Releases"',
      }),
    })

    expect(report).toMatchObject({
      app_path: artifactPath,
      artifact_type: 'linux-appimage',
      passed: true,
      summary: { pass: 1, fail: 0, unknown: 0 },
      checks: [{ id: 'appimage-signature', status: 'pass' }],
    })
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
