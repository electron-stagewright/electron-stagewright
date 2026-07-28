/** Standalone production CLI parser, report, and exit-contract tests. */

import { describe, expect, it, vi } from 'vitest'

import {
  PRODUCTION_EXIT_CODES,
  parseProductionCliArgs,
  runProductionCli,
  runProductionCliCommand,
  type ProductionCliDependencies,
  type ProductionCliIo,
} from '../src/cli.js'
import { ProductionValidationError, type ProductionValidationReport } from '../src/validate.js'

function captureIo(): {
  readonly io: ProductionCliIo
  readonly stdout: string[]
  readonly stderr: string[]
} {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout,
    stderr,
  }
}

function dependencies(report: ProductionValidationReport): ProductionCliDependencies {
  return { validateProductionApp: vi.fn(async () => report) }
}

const passingReport: ProductionValidationReport = {
  app_path: '/tmp/Demo.app',
  artifact_type: 'macos-app',
  passed: true,
  summary: { pass: 1, fail: 0, unknown: 0 },
  checks: [
    {
      id: 'bundle-structure',
      title: 'macOS app bundle structure',
      status: 'pass',
      detail: 'The bundle is structurally complete.',
    },
  ],
}

describe('parseProductionCliArgs', () => {
  it('strictly parses validation, subsets, timeout, and JSON output', () => {
    expect(
      parseProductionCliArgs([
        'validate',
        '--app',
        '/tmp/Demo.app',
        '--checks',
        'appimage-signature,bundle-structure,appimage-signature',
        '--command-timeout-ms',
        '15000',
        '--json',
      ]),
    ).toEqual({
      command: 'validate',
      appPath: '/tmp/Demo.app',
      checks: ['appimage-signature', 'bundle-structure'],
      commandTimeoutMs: 15_000,
      json: true,
    })
  })

  it('fails closed on missing values, unknown checks, and unexpected arguments', () => {
    expect(() => parseProductionCliArgs(['validate'])).toThrow('requires --app')
    expect(() => parseProductionCliArgs(['validate', '--app', '--json'])).toThrow(
      '--app expects a value',
    )
    expect(() =>
      parseProductionCliArgs(['validate', '--app', '/tmp/Demo.app', '--checks', 'not-real']),
    ).toThrow('unknown id')
    expect(() => parseProductionCliArgs(['validate', '--app', '/tmp/Demo.app', 'extra'])).toThrow(
      'Unexpected argument',
    )
  })
})

describe('runProductionCli', () => {
  it('writes one pure JSON report and exits zero when no check failed', async () => {
    const { io, stdout, stderr } = captureIo()
    const result = await runProductionCli(
      { command: 'validate', appPath: '/tmp/Demo.app', json: true },
      io,
      dependencies(passingReport),
    )

    expect(result.exitCode).toBe(PRODUCTION_EXIT_CODES.SUCCESS)
    expect(stderr).toEqual([])
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0] ?? '')).toMatchObject({
      format: 'electron-stagewright-production-validation',
      version: 1,
      artifact_type: 'macos-app',
      passed: true,
      exit_code: 0,
    })
  })

  it('uses exit one when validation ran and at least one check failed', async () => {
    const { io, stdout } = captureIo()
    const result = await runProductionCli(
      { command: 'validate', appPath: '/tmp/Demo.app', json: false },
      io,
      dependencies({
        ...passingReport,
        passed: false,
        summary: { pass: 0, fail: 1, unknown: 0 },
        checks: [
          {
            id: 'bundle-structure',
            title: 'macOS app bundle structure',
            status: 'fail',
            detail: 'The bundle is structurally incomplete.',
          },
        ],
      }),
    )

    expect(result.exitCode).toBe(PRODUCTION_EXIT_CODES.VALIDATION_FAILED)
    expect(stdout.join('')).toContain('FAIL /tmp/Demo.app')
    expect(stdout.join('')).toContain('[FAIL] bundle-structure')
  })

  it('writes non-JSON input errors only to stderr', async () => {
    const { io, stdout, stderr } = captureIo()
    const result = await runProductionCli(
      { command: 'validate', appPath: 'Demo.app', json: false },
      io,
      {
        validateProductionApp: vi.fn(async () => {
          throw new ProductionValidationError(
            'ABSOLUTE_PATH_REQUIRED',
            'appPath must be absolute',
            'Demo.app',
          )
        }),
      },
    )

    expect(result.exitCode).toBe(PRODUCTION_EXIT_CODES.USAGE)
    expect(stdout).toEqual([])
    expect(stderr.join('')).toBe('ERROR [ABSOLUTE_PATH_REQUIRED] appPath must be absolute\n')
  })

  it('keeps JSON usage errors parseable and diagnostics out of stderr', async () => {
    const { io, stdout, stderr } = captureIo()
    const exitCode = await runProductionCliCommand(['validate', '--json'], io)

    expect(exitCode).toBe(PRODUCTION_EXIT_CODES.USAGE)
    expect(stderr).toEqual([])
    expect(JSON.parse(stdout[0] ?? '')).toMatchObject({
      passed: false,
      exit_code: 2,
      error: { code: 'USAGE' },
    })
  })

  it('writes non-JSON usage diagnostics only to stderr', async () => {
    const { io, stdout, stderr } = captureIo()
    const exitCode = await runProductionCliCommand([], io)

    expect(exitCode).toBe(PRODUCTION_EXIT_CODES.USAGE)
    expect(stdout).toEqual([])
    expect(stderr.join('')).toContain('usage:')
  })
})
