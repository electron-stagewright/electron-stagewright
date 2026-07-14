import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  inventoryNativeAddons,
  probeElectronRuntime,
  readDeclaredElectronVersion,
  resolveProjectElectron,
} from '../src/runtime/project-electron.js'

const temporaryRoots: string[] = []

async function temporaryProject(): Promise<{ readonly root: string; readonly executable: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'stagewright-project-electron-'))
  temporaryRoots.push(root)
  const electronDir = path.join(root, 'node_modules', 'electron')
  const executable = path.join(electronDir, 'dist', 'electron')
  await mkdir(path.dirname(executable), { recursive: true })
  await Promise.all([
    writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ devDependencies: { electron: '42.3.0' } }),
    ),
    writeFile(
      path.join(electronDir, 'package.json'),
      JSON.stringify({ version: '42.3.0', main: 'index.cjs' }),
    ),
    writeFile(
      path.join(electronDir, 'index.cjs'),
      "throw new Error('Electron package entry must not run during runtime resolution');\n",
    ),
    writeFile(path.join(electronDir, 'path.txt'), 'electron\n'),
    writeFile(executable, ''),
  ])
  return { root, executable: await realpath(executable) }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  )
})

describe('project Electron resolution', () => {
  it('resolves only the Electron package owned by the configured app root', async () => {
    const { root, executable } = await temporaryProject()
    const canonicalRoot = await realpath(root)

    await expect(resolveProjectElectron(root)).resolves.toMatchObject({
      ok: true,
      rootPath: canonicalRoot,
      electron: { executablePath: executable, version: '42.3.0' },
    })
    await expect(readDeclaredElectronVersion(root)).resolves.toBe('42.3.0')
  })

  it('refuses an Electron package whose executable escapes the app root', async () => {
    const { root } = await temporaryProject()
    const executable = path.join(root, 'node_modules', 'electron', 'dist', 'electron')
    await rm(executable)
    await symlink(process.execPath, executable)

    await expect(resolveProjectElectron(root)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('outside'),
    })
  })

  it('refuses an Electron path.txt that attempts to escape the package distribution', async () => {
    const { root } = await temporaryProject()
    await writeFile(
      path.join(root, 'node_modules', 'electron', 'path.txt'),
      '../outside-electron\n',
    )

    await expect(resolveProjectElectron(root)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('dist directory'),
    })
  })

  it('returns a bounded native-addon inventory without following symlinks', async () => {
    const { root } = await temporaryProject()
    const addon = path.join(root, 'build', 'Release', 'native.node')
    await mkdir(path.dirname(addon), { recursive: true })
    await writeFile(addon, '')
    await symlink(path.dirname(addon), path.join(root, 'linked-build'))

    await expect(inventoryNativeAddons(root)).resolves.toEqual({
      paths: [path.join('build', 'Release', 'native.node')],
      truncated: false,
    })
  })

  it('probes target versions with a fixed expression and a sanitized environment', async () => {
    const calls: Array<{ readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv }> = []
    const result = await probeElectronRuntime('/project/electron', {
      env: { PATH: '/bin', NODE_OPTIONS: '--require unsafe.js', LD_PRELOAD: 'unsafe.dylib' },
      execFile: async (_executable, args, options) => {
        calls.push({ args, env: options.env })
        return {
          stdout: JSON.stringify({
            electron: '42.3.0',
            node: '24.18.0',
            v8: '14.8.0-electron.0',
            nodeModuleVersion: '146',
          }),
        }
      },
    })

    expect(result).toEqual({
      electron: '42.3.0',
      node: '24.18.0',
      v8: '14.8.0-electron.0',
      nodeModuleVersion: '146',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual(['-p', expect.stringContaining('process.versions.electron')])
    expect(calls[0]?.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', PATH: '/bin' })
    expect(calls[0]?.env['NODE_OPTIONS']).toBeUndefined()
    expect(calls[0]?.env['LD_PRELOAD']).toBeUndefined()
  })
})
