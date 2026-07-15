/**
 * Unit-test the published npx smoke's assertion contract.
 *
 * The smoke previously had no executable coverage and only ran on a published release, so its first
 * real run was against a live release. These tests pin what it owns: exactly one valid doctor JSON
 * document on stdout, the checks that do not depend on a downloaded Electron binary, and a
 * diagnosable failure message.
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const SMOKE = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'published-npx-smoke.mjs')).href

const { assertDoctorReport } = (await import(SMOKE)) as {
  assertDoctorReport: (outcome: { stdout: string; stderr: string; code: number }) => {
    readonly ok: boolean
    readonly checks: readonly { readonly id: string; readonly status: string }[]
  }
}

function report(overrides: readonly { id: string; status: string }[] = []): string {
  const checks = [
    { id: 'node', status: 'pass', message: 'node' },
    { id: 'playwright', status: 'pass', message: 'playwright' },
    { id: 'electron', status: 'pass', message: 'electron' },
    { id: 'eval_policy', status: 'pass', message: 'eval' },
  ].map((check) => overrides.find((override) => override.id === check.id) ?? check)
  return JSON.stringify({ ok: checks.every((c) => c.status !== 'fail'), checks })
}

function outcome(
  stdout: string,
  code = 0,
  stderr = '',
): { stdout: string; stderr: string; code: number } {
  return { stdout, stderr, code }
}

describe('published npx smoke assertions', () => {
  it('accepts a clean report', () => {
    expect(assertDoctorReport(outcome(report())).ok).toBe(true)
  })

  it('rejects a published package that reports no usable Electron runtime', () => {
    // This is the regression the smoke exists to catch: core 0.4.0 required Electron's optional
    // path.txt and so reported a launchable install as broken.
    const stdout = report([{ id: 'electron', status: 'fail' }])

    expect(() => assertDoctorReport(outcome(stdout, 1))).toThrow(/did not pass the electron check/)
  })

  it('still reads a report from a non-zero exit, since a failing check is a report not a crash', () => {
    const parsed = assertDoctorReport(outcome(report([{ id: 'app_root', status: 'skip' }]), 1))

    expect(parsed.checks.some((check) => check.id === 'electron')).toBe(true)
  })

  it('rejects stdout polluted by an installer, which would break an MCP host', () => {
    const polluted = `Downloading electron@42.3.0: 42%\n${report()}`

    expect(() => assertDoctorReport(outcome(polluted))).toThrow(
      /did not emit a single doctor JSON document/,
    )
  })

  it('rejects a report whose own dependency checks failed', () => {
    const stdout = report([{ id: 'playwright', status: 'fail' }])

    expect(() => assertDoctorReport(outcome(stdout, 1))).toThrow(
      /did not pass the playwright check/,
    )
  })

  it('surfaces stdout and stderr so a failure is diagnosable', () => {
    expect(() => assertDoctorReport(outcome('', 1, 'npm error code E404'))).toThrow(/E404|stderr/)
  })

  it('rejects output that parses but carries no checks', () => {
    expect(() => assertDoctorReport(outcome(JSON.stringify({ ok: true })))).toThrow(
      /not a report with checks/,
    )
  })
})
