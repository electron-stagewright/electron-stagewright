/**
 * Unit coverage for the bounded, secret-safe diagnostic contract used by the real Electron
 * benchmark job. These tests never spawn Electron or an MCP server.
 */

import { describe, expect, it } from 'vitest'

import {
  BENCHMARK_CHILD_ENVIRONMENT_VARIABLES,
  BENCHMARK_PHASE_TIMEOUT_ENV,
  DEFAULT_BENCHMARK_PHASE_TIMEOUT_MS,
  benchmarkChildEnvironment,
  createBenchmarkDiagnostics,
  measureBenchmarkPhase,
  resolveBenchmarkPhaseTimeout,
} from '../src/harness.js'

describe('benchmark child environment', () => {
  it('forwards only the display and sandbox allowlist without host secrets', () => {
    const environment = {
      DISPLAY: ':99',
      ELECTRON_DISABLE_SANDBOX: '1',
      XDG_RUNTIME_DIR: '/run/user/1001',
      SECRET_TOKEN: 'must-not-leak',
      EMPTY_VALUE: '',
    }

    expect(benchmarkChildEnvironment(environment)).toEqual({
      DISPLAY: ':99',
      ELECTRON_DISABLE_SANDBOX: '1',
      XDG_RUNTIME_DIR: '/run/user/1001',
    })
    expect(BENCHMARK_CHILD_ENVIRONMENT_VARIABLES).toContain('DISPLAY')
  })

  it('rejects exported shell functions and empty values just like the MCP SDK safe default', () => {
    expect(
      benchmarkChildEnvironment({ DISPLAY: '()', XAUTHORITY: '', WAYLAND_DISPLAY: 'wayland-0' }),
    ).toEqual({ WAYLAND_DISPLAY: 'wayland-0' })
  })
})

describe('benchmark phase timeout', () => {
  it('uses a stable default and accepts a positive millisecond override', () => {
    expect(resolveBenchmarkPhaseTimeout({})).toBe(DEFAULT_BENCHMARK_PHASE_TIMEOUT_MS)
    expect(resolveBenchmarkPhaseTimeout({ [BENCHMARK_PHASE_TIMEOUT_ENV]: '45000' })).toBe(45_000)
  })

  it.each(['0', '-1', '45 seconds', '1.5'])('rejects invalid overrides: %s', (raw) => {
    expect(() => resolveBenchmarkPhaseTimeout({ [BENCHMARK_PHASE_TIMEOUT_ENV]: raw })).toThrow(
      `${BENCHMARK_PHASE_TIMEOUT_ENV} must be a positive integer in milliseconds`,
    )
  })

  it('records successful phases without recording environment values', async () => {
    const diagnostics = createBenchmarkDiagnostics(
      50,
      benchmarkChildEnvironment({ DISPLAY: ':99', SECRET_TOKEN: 'private' }),
    )

    await expect(
      measureBenchmarkPhase(diagnostics, 'connect', async () => 'connected'),
    ).resolves.toBe('connected')

    expect(diagnostics).toMatchObject({
      phaseTimeoutMs: 50,
      childEnvironment: ['DISPLAY'],
      phases: [{ phase: 'connect', outcome: 'ok' }],
    })
    expect(JSON.stringify(diagnostics)).not.toContain('private')
    expect(JSON.stringify(diagnostics)).not.toContain('SECRET_TOKEN')
  })

  it('turns a stalled phase into an explicit timeout diagnostic', async () => {
    const diagnostics = createBenchmarkDiagnostics(20, {})

    await expect(
      measureBenchmarkPhase(
        diagnostics,
        'launch',
        async () => await new Promise<never>(() => undefined),
      ),
    ).rejects.toThrow('launch timed out after 20ms')

    expect(diagnostics.phases).toHaveLength(1)
    expect(diagnostics.phases[0]).toMatchObject({
      phase: 'launch',
      outcome: 'timeout',
      timeoutMs: 20,
      error: 'launch timed out after 20ms',
    })
  })

  it('keeps a completed-but-unsuccessful phase distinct from a timeout', async () => {
    const diagnostics = createBenchmarkDiagnostics(50, {})

    await expect(
      measureBenchmarkPhase(diagnostics, 'launch', async () => {
        throw new Error('launch failed: ELECTRON_NOT_FOUND')
      }),
    ).rejects.toThrow('launch failed: ELECTRON_NOT_FOUND')

    expect(diagnostics.phases).toEqual([
      expect.objectContaining({
        phase: 'launch',
        outcome: 'error',
        error: 'launch failed: ELECTRON_NOT_FOUND',
      }),
    ])
  })
})
