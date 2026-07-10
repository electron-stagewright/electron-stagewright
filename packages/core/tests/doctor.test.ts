import { describe, expect, it } from 'vitest'

import { runDoctorChecks } from '../src/doctor.js'

const READY_DEPS = {
  nodeVersion: 'v24.5.0',
  platform: 'darwin' as const,
  env: {},
  resolvePackage: async () => {},
  inspectDirectory: async () => 'accessible' as const,
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
    ])
    expect(report.checks.find((check) => check.id === 'display')?.status).toBe('skip')
    expect(report.checks.find((check) => check.id === 'app_root')?.status).toBe('skip')
    expect(report.checks.find((check) => check.id === 'eval_policy')?.message).toContain('renderer')
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
})
