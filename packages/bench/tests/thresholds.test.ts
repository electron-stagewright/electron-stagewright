/**
 * Unit tests for the benchmark regression-threshold checker. Pure — fed synthetic ScenarioResults,
 * no Electron and no MCP — so it runs as a fast gate in the normal `pnpm test` (CI), while
 * `pnpm bench --check` enforces the same thresholds against a real run. The in-band fixture uses
 * the observed baseline metrics the default spec was derived from.
 */

import { describe, expect, it } from 'vitest'

import type { ScenarioResult } from '../src/harness.js'
import {
  checkThresholds,
  deriveThresholds,
  DEFAULT_CONTRASTS,
  DEFAULT_THRESHOLDS,
} from '../src/thresholds.js'

/** Build a synthetic scenario result (latency/memory are irrelevant to the deterministic checker). */
function res(name: string, toolCalls: number, estimatedTokens: number, ok = true): ScenarioResult {
  return {
    name,
    description: '',
    toolCalls,
    estimatedTokens,
    measuredTokens: estimatedTokens,
    latencyMs: 0,
    memoryRssBytes: null,
    ok,
    ...(ok ? {} : { error: 'scenario failed' }),
  }
}

/** The observed baseline the default thresholds were derived from. */
function baselineResults(): ScenarioResult[] {
  return [
    res('verify-greeting-primitive', 7, 3380),
    res('verify-greeting-expect', 5, 3286),
    res('observe-change-rescan', 4, 6412),
    res('observe-change-diff', 4, 3843),
    res('multi-turn-rescan-30', 62, 180_000),
    res('multi-turn-diff-30', 62, 70_000),
    res('error-recovery', 6, 3395),
  ]
}

describe('checkThresholds', () => {
  it('passes the baseline run with zero violations', () => {
    expect(checkThresholds(baselineResults(), DEFAULT_CONTRASTS, DEFAULT_THRESHOLDS)).toEqual([])
  })

  it('flags a tool-call count drift', () => {
    const results = baselineResults().map((r) =>
      r.name === 'verify-greeting-primitive' ? res(r.name, 8, r.estimatedTokens) : r,
    )
    const violations = checkThresholds(results, DEFAULT_CONTRASTS, DEFAULT_THRESHOLDS)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ kind: 'tool_calls', target: 'verify-greeting-primitive' })
  })

  it('flags a collapsed token saving on the snapshot-diff contrast', () => {
    // Raise the diff scenario's tokens so it barely undercuts the rescan: saving drops below 30%.
    const results = baselineResults().map((r) =>
      r.name === 'observe-change-diff' ? res(r.name, r.toolCalls, 6000) : r,
    )
    const violations = checkThresholds(results, DEFAULT_CONTRASTS, DEFAULT_THRESHOLDS)
    expect(violations.map((v) => v.kind)).toContain('token_saving')
    expect(violations.find((v) => v.kind === 'token_saving')?.target).toContain('snapshot diff')
  })

  it('flags a collapsed tool-call saving on the verify contrast', () => {
    // expect_text regresses to the same call count as the primitive chain: it saves nothing.
    const results = baselineResults().map((r) =>
      r.name === 'verify-greeting-expect' ? res(r.name, 7, r.estimatedTokens) : r,
    )
    const violations = checkThresholds(results, DEFAULT_CONTRASTS, DEFAULT_THRESHOLDS)
    expect(violations.map((v) => v.kind)).toContain('tool_calls_saved')
  })

  it('reports a missing or failed scenario rather than silently passing', () => {
    const withoutError = baselineResults().filter((r) => r.name !== 'error-recovery')
    expect(
      checkThresholds(withoutError, DEFAULT_CONTRASTS, DEFAULT_THRESHOLDS).some(
        (v) => v.kind === 'missing' && v.target === 'error-recovery',
      ),
    ).toBe(true)

    const failed = baselineResults().map((r) =>
      r.name === 'observe-change-diff' ? res(r.name, r.toolCalls, r.estimatedTokens, false) : r,
    )
    const failedViolations = checkThresholds(failed, DEFAULT_CONTRASTS, DEFAULT_THRESHOLDS)
    expect(failedViolations.some((v) => v.kind === 'missing')).toBe(true)
    // A failed scenario also makes any contrast it belongs to unverifiable — pin the
    // contrast-level `missing` path (target is the contrast label), not just the scenario one.
    expect(
      failedViolations.some((v) => v.kind === 'missing' && v.target.includes('snapshot diff')),
    ).toBe(true)
  })
})

describe('deriveThresholds', () => {
  it('captures exact tool-call counts and a token floor a band below the observed saving', () => {
    const derived = deriveThresholds(baselineResults(), DEFAULT_CONTRASTS, 0.05)
    expect(derived.scenarios['verify-greeting-primitive']?.toolCalls).toBe(7)

    const diffContrast = DEFAULT_CONTRASTS[1]?.label ?? ''
    const floor = derived.contrasts[diffContrast]?.minTokenSavingRatio ?? 0
    // Observed saving is ~0.40; the derived floor sits a 0.05 band below it.
    expect(floor).toBeGreaterThan(0.3)
    expect(floor).toBeLessThan(0.4)

    // The regenerated spec must still pass the run it was derived from.
    expect(checkThresholds(baselineResults(), DEFAULT_CONTRASTS, derived)).toEqual([])
  })

  it('refuses to derive a spec from a failed run', () => {
    const failed = baselineResults().map((r) =>
      r.name === 'error-recovery' ? res(r.name, r.toolCalls, r.estimatedTokens, false) : r,
    )
    expect(() => deriveThresholds(failed, DEFAULT_CONTRASTS)).toThrow(
      /cannot derive thresholds from a failed benchmark run/,
    )
  })
})
