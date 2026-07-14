import { describe, expect, it } from 'vitest'

import { runDoctorChecks } from '../src/doctor.js'

const READY_DEPS = {
  nodeVersion: 'v24.5.0',
  platform: 'darwin' as const,
  env: {},
  resolvePackage: async () => {},
  inspectDirectory: async () => 'accessible' as const,
  serverRuntime: async () => ({
    core: '0.3.0',
    node: 'v24.5.0',
    v8: '13.6.0',
    nodeModuleVersion: '137',
    playwright: '1.61.1',
    electron: '42.6.2',
    electronRuntime: {
      electron: '42.6.2',
      node: '24.18.0',
      v8: '14.8.0-electron.0',
      nodeModuleVersion: '146',
    },
  }),
}

describe('runDoctorChecks', () => {
  it('reports a stable, passing preflight with skip statuses for unconfigured paths', async () => {
    const report = await runDoctorChecks(
      { allowEvalMain: false, allowEvalRenderer: true },
      READY_DEPS,
    )

    expect(report.ok).toBe(true)
    expect(report.checks.map((check) => check.id)).toEqual([
      'node',
      'playwright',
      'electron',
      'display',
      'app_root',
      'screenshot_dir',
      'eval_policy',
      'project_runtime',
    ])
    expect(report.checks.find((check) => check.id === 'display')?.status).toBe('skip')
    expect(report.checks.find((check) => check.id === 'app_root')?.status).toBe('skip')
    expect(report.checks.find((check) => check.id === 'eval_policy')?.message).toContain('renderer')
    expect(report.checks.find((check) => check.id === 'project_runtime')?.status).toBe('skip')
    expect(report.runtime.server).toMatchObject({ core: '0.3.0', electron: '42.6.2' })
  })

  it.each(['darwin', 'win32'] as const)(
    'skips the Linux display preflight on %s',
    async (platform) => {
      const report = await runDoctorChecks(
        { allowEvalMain: false, allowEvalRenderer: false },
        { ...READY_DEPS, platform },
      )

      expect(report.ok).toBe(true)
      expect(report.checks.find((check) => check.id === 'display')?.status).toBe('skip')
    },
  )

  it('fails independently for an old Node, missing Electron, Linux display, and bad paths', async () => {
    const report = await runDoctorChecks(
      {
        appRoot: '/missing-root',
        screenshotDir: '/not-a-directory',
        allowEvalMain: false,
        allowEvalRenderer: false,
      },
      {
        nodeVersion: 'v22.14.0',
        platform: 'linux',
        env: {},
        resolvePackage: async (name) => {
          if (name === 'electron') throw new Error('Cannot find package electron')
        },
        inspectDirectory: async (path) => (path === '/missing-root' ? 'missing' : 'not_directory'),
      },
    )

    expect(report.ok).toBe(false)
    expect(
      report.checks.filter((check) => check.status === 'fail').map((check) => check.id),
    ).toEqual(['node', 'electron', 'display', 'app_root', 'screenshot_dir'])
    expect(report.checks.find((check) => check.id === 'electron')?.hint).toContain(
      '--package electron',
    )
  })

  it('checks optional peers through package metadata without importing their entry points', async () => {
    const report = await runDoctorChecks(
      { allowEvalMain: false, allowEvalRenderer: false },
      {
        ...READY_DEPS,
        resolvePackage: async (name) => {
          expect(name).toBe('playwright')
        },
      },
    )

    expect(report.checks.find((check) => check.id === 'playwright')?.status).toBe('pass')
  })

  it('requires only readable app roots but writable screenshot directories', async () => {
    const writableRequirements: boolean[] = []
    const report = await runDoctorChecks(
      {
        appRoot: '/read-only-app',
        screenshotDir: '/captures',
        allowEvalMain: false,
        allowEvalRenderer: false,
      },
      {
        ...READY_DEPS,
        inspectDirectory: async (_path, requireWritable) => {
          writableRequirements.push(requireWritable)
          return 'accessible'
        },
      },
    )

    expect(report.ok).toBe(true)
    expect(writableRequirements).toEqual([false, true])
  })

  it('warns about a target Electron ABI mismatch only when native addons are present', async () => {
    const report = await runDoctorChecks(
      {
        appRoot: '/app',
        allowEvalMain: false,
        allowEvalRenderer: false,
      },
      {
        ...READY_DEPS,
        resolveProjectElectron: async () => ({
          ok: true as const,
          electron: {
            executablePath: '/app/node_modules/electron/dist/electron',
            packageJsonPath: '/app/node_modules/electron/package.json',
            version: '42.3.0',
          },
        }),
        readDeclaredElectronVersion: async () => '42.3.0',
        probeElectronRuntime: async () => ({
          electron: '42.3.0',
          node: '24.18.0',
          v8: '14.8.0-electron.0',
          nodeModuleVersion: '137',
        }),
        inventoryNativeAddons: async () => ({
          paths: ['node_modules/native-addon/build/Release/addon.node'],
          truncated: false,
        }),
      },
    )

    expect(report.ok).toBe(true)
    expect(report.checks.find((check) => check.id === 'project_runtime')).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('NODE_MODULE_VERSION'),
      hint: expect.stringContaining('runtime:"project"'),
    })
    expect(report.runtime.project).toMatchObject({
      declaredElectron: '42.3.0',
      installedElectron: '42.3.0',
      target: { nodeModuleVersion: '137' },
      nativeAddons: { paths: ['node_modules/native-addon/build/Release/addon.node'] },
    })
  })

  it('keeps doctor diagnostic-only when the app-root Electron resolution fails', async () => {
    const report = await runDoctorChecks(
      {
        appRoot: '/app',
        allowEvalMain: false,
        allowEvalRenderer: false,
      },
      {
        ...READY_DEPS,
        resolveProjectElectron: async () => ({
          ok: false as const,
          message: 'Electron is missing',
        }),
        inventoryNativeAddons: async () => ({ paths: [], truncated: false }),
      },
    )

    expect(report.ok).toBe(true)
    expect(report.checks.find((check) => check.id === 'project_runtime')).toMatchObject({
      status: 'warn',
      message: 'Electron is missing',
    })
    expect(report.runtime.project).toEqual({ nativeAddons: { paths: [], truncated: false } })
  })

  it('keeps doctor diagnostic-only when target inspection dependencies throw', async () => {
    const report = await runDoctorChecks(
      {
        appRoot: '/app',
        allowEvalMain: false,
        allowEvalRenderer: false,
      },
      {
        ...READY_DEPS,
        resolveProjectElectron: async () => {
          throw new Error('resolver failure')
        },
        inventoryNativeAddons: async () => {
          throw new Error('inventory failure')
        },
      },
    )

    expect(report.ok).toBe(true)
    expect(report.checks.find((check) => check.id === 'project_runtime')).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('resolver failure'),
    })
    expect(report.runtime.project).toMatchObject({
      nativeAddons: { paths: [], truncated: true },
      nativeAddonInventoryError: 'inventory failure',
    })
  })

  it('warns when a resolved target Electron cannot be probed', async () => {
    const report = await runDoctorChecks(
      {
        appRoot: '/app',
        allowEvalMain: false,
        allowEvalRenderer: false,
      },
      {
        ...READY_DEPS,
        resolveProjectElectron: async () => ({
          ok: true as const,
          electron: {
            executablePath: '/app/node_modules/electron/dist/electron',
            packageJsonPath: '/app/node_modules/electron/package.json',
          },
        }),
        probeElectronRuntime: async () => {
          throw new Error('not executable')
        },
        inventoryNativeAddons: async () => ({ paths: [], truncated: false }),
      },
    )

    expect(report.ok).toBe(true)
    expect(report.checks.find((check) => check.id === 'project_runtime')).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('fixed runtime probe failed: not executable'),
    })
  })
})
