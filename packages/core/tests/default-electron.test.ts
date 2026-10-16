import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { inspectDefaultElectron } from '../src/runtime/default-electron.js'

const EXECUTABLE = 'Electron.app/Contents/MacOS/Electron'

describe('inspectDefaultElectron', () => {
  let root: string
  const inspect = (env: NodeJS.ProcessEnv = {}) =>
    inspectDefaultElectron({ env, resolveElectronPackageJson: () => join(root, 'package.json') })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sw-default-electron-'))
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '42.11.10' }))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function installBinary(recordedPath = EXECUTABLE): Promise<void> {
    await writeFile(join(root, 'path.txt'), recordedPath)
    await mkdir(join(root, 'dist', 'Electron.app', 'Contents', 'MacOS'), { recursive: true })
    await writeFile(join(root, 'dist', EXECUTABLE), '')
  }

  it('reports a package whose binary was never downloaded', async () => {
    await expect(inspect()).resolves.toMatchObject({
      ok: false,
      reason: 'binary_missing',
      version: '42.11.10',
    })
  })

  it('treats a binary without path.txt as missing, because Electron would download again', async () => {
    await installBinary()
    await rm(join(root, 'path.txt'))

    await expect(inspect()).resolves.toMatchObject({ ok: false, reason: 'binary_missing' })
  })

  it('reads path.txt verbatim, as Electron does', async () => {
    await installBinary(`${EXECUTABLE}\n`)

    await expect(inspect()).resolves.toMatchObject({ ok: false, reason: 'binary_missing' })
  })

  it('accepts a downloaded binary', async () => {
    await installBinary()

    await expect(inspect()).resolves.toEqual({ ok: true, version: '42.11.10' })
  })

  it('accepts ELECTRON_OVERRIDE_DIST_PATH, which Electron never downloads for', async () => {
    await expect(inspect({ ELECTRON_OVERRIDE_DIST_PATH: '/opt/electron' })).resolves.toMatchObject({
      ok: true,
    })
  })

  it('reports an unresolvable package', async () => {
    const result = await inspectDefaultElectron({
      env: {},
      resolveElectronPackageJson: () => {
        throw new Error("Cannot find module 'electron/package.json'")
      },
    })

    expect(result).toMatchObject({ ok: false, reason: 'package_missing' })
  })
})
