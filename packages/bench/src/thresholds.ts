/**
 * Regression thresholds for the benchmark's DETERMINISTIC metrics. The harness records four
 * metrics per scenario, but only two are reproducible regardless of machine: the tool-call count
 * (exact) and the estimated-token total (deterministic given a fixed app + responses). Latency and
 * memory are environment-dependent and are NEVER thresholded here.
 *
 * The point is to lock in the token-economy wins this project sells — the `expect_*` family saving
 * round-trips, and the snapshot diff saving tokens — so a future change cannot silently erode them.
 * `checkThresholds` is a pure function (no Electron, no MCP), so it runs as a fast unit test in CI;
 * `pnpm bench --check` enforces the same thresholds against a real run.
 *
 * Token savings are expressed as FLOORS (a minimum the optimized path must keep), not exact
 * targets: a better run never trips a threshold, and the floor sits a margin below the observed
 * baseline so a legitimate small app change does not false-trip while a real regression (the saving
 * collapsing) does.
 *
 * @module
 */

import type { ScenarioResult } from './harness.js'

/**
 * A same-task contrast: two scenarios doing the SAME task where `optimized` uses an agent-native
 * primitive the `baseline` lacks. The metric difference is the saving. (Mirrors the runner's
 * display contrasts; defined here so the pure checker does not import the runner.)
 */
export interface Contrast {
  /** Human label for the lever this contrast isolates (also the thresholds key). */
  readonly label: string
  /** Scenario name of the naive path. */
  readonly baseline: string
  /** Scenario name of the agent-native path. */
  readonly optimized: string
}

/** Deterministic expectation for one scenario. */
export interface ScenarioThreshold {
  /** Exact expected tool-call count (deterministic — a drift is a regression or a scenario change). */
  readonly toolCalls: number
}

/**
 * Minimum savings the optimized path must keep over its baseline. Floors, not exact: a larger
 * saving passes; only a saving that shrinks below the floor fails.
 */
export interface ContrastThreshold {
  /** Fewest tool calls the optimized path must save vs baseline (`baseline - optimized >= this`). */
  readonly minToolCallsSaved: number
  /** Smallest fraction (0..1) of baseline tokens the optimized path must save. */
  readonly minTokenSavingRatio: number
}

/**
 * The same-task contrasts the suite reports + thresholds. Shared data (not in the runner) so both
 * `pnpm bench` and the pure checker test reference the same labels. Each `label` is a key in
 * {@link DEFAULT_THRESHOLDS.contrasts}.
 */
export const DEFAULT_CONTRASTS: ReadonlyArray<Contrast> = [
  {
    label: 'verify a result — primitive chain vs expect_text (saves round-trips)',
    baseline: 'verify-greeting-primitive',
    optimized: 'verify-greeting-expect',
  },
  {
    label: 'see what changed — full re-scan vs snapshot diff (saves tokens)',
    baseline: 'observe-change-rescan',
    optimized: 'observe-change-diff',
  },
]

/** The full regression spec: per-scenario tool-call counts + per-contrast saving floors. */
export interface BenchThresholds {
  /** Keyed by scenario name. */
  readonly scenarios: Readonly<Record<string, ScenarioThreshold>>
  /** Keyed by {@link Contrast.label}. */
  readonly contrasts: Readonly<Record<string, ContrastThreshold>>
}

/** What kind of regression a {@link ThresholdViolation} reports. */
export type ThresholdViolationKind = 'tool_calls' | 'tool_calls_saved' | 'token_saving' | 'missing'

/** One failed threshold: the metric that drifted, the target it applies to, and a human message. */
export interface ThresholdViolation {
  readonly kind: ThresholdViolationKind
  /** The scenario name or contrast label the violation is about. */
  readonly target: string
  /** Human-readable explanation including the expected and actual values. */
  readonly message: string
}

/**
 * Default thresholds, derived from an observed baseline run (5 scenarios). Tool-call counts are the
 * exact observed values; the token-saving floor for the snapshot-diff contrast sits below the
 * observed ~40% so the gate guards against a collapse, not normal jitter. The verify contrast's
 * lever is round-trips (≈2 calls), not tokens, so its token floor is 0.
 */
export const DEFAULT_THRESHOLDS: BenchThresholds = {
  scenarios: {
    'verify-greeting-primitive': { toolCalls: 7 },
    'verify-greeting-expect': { toolCalls: 5 },
    'observe-change-rescan': { toolCalls: 4 },
    'observe-change-diff': { toolCalls: 4 },
    'error-recovery': { toolCalls: 6 },
  },
  contrasts: {
    'verify a result — primitive chain vs expect_text (saves round-trips)': {
      minToolCallsSaved: 2,
      minTokenSavingRatio: 0,
    },
    'see what changed — full re-scan vs snapshot diff (saves tokens)': {
      minToolCallsSaved: 0,
      minTokenSavingRatio: 0.3,
    },
  },
}

/** The fraction of baseline tokens the optimized path saved (0 when baseline has no tokens). */
function tokenSavingRatio(baseline: ScenarioResult, optimized: ScenarioResult): number {
  if (baseline.estimatedTokens <= 0) return 0
  return (baseline.estimatedTokens - optimized.estimatedTokens) / baseline.estimatedTokens
}

/**
 * Compare a benchmark run's deterministic metrics against `thresholds` and return every violation
 * (empty array = within bounds). Pure: feed it synthetic results in a unit test, or a real run's
 * results in `pnpm bench --check`. A scenario in the spec that is missing or failed, or a contrast
 * whose baseline/optimized result is absent, is reported as a `missing` violation rather than
 * silently passing.
 */
export function checkThresholds(
  results: ReadonlyArray<ScenarioResult>,
  contrasts: ReadonlyArray<Contrast>,
  thresholds: BenchThresholds,
): ThresholdViolation[] {
  const violations: ThresholdViolation[] = []
  const byName = new Map(results.map((r) => [r.name, r]))

  for (const [name, spec] of Object.entries(thresholds.scenarios)) {
    const result = byName.get(name)
    if (result === undefined || !result.ok) {
      violations.push({
        kind: 'missing',
        target: name,
        message: `scenario "${name}" is missing or failed; cannot verify its thresholds`,
      })
      continue
    }
    if (result.toolCalls !== spec.toolCalls) {
      violations.push({
        kind: 'tool_calls',
        target: name,
        message: `tool calls for "${name}": expected ${spec.toolCalls}, got ${result.toolCalls}`,
      })
    }
  }

  for (const contrast of contrasts) {
    const spec = thresholds.contrasts[contrast.label]
    if (spec === undefined) continue
    const baseline = byName.get(contrast.baseline)
    const optimized = byName.get(contrast.optimized)
    if (baseline === undefined || optimized === undefined || !baseline.ok || !optimized.ok) {
      violations.push({
        kind: 'missing',
        target: contrast.label,
        message: `contrast "${contrast.label}" is missing a baseline or optimized result`,
      })
      continue
    }
    const callsSaved = baseline.toolCalls - optimized.toolCalls
    if (callsSaved < spec.minToolCallsSaved) {
      violations.push({
        kind: 'tool_calls_saved',
        target: contrast.label,
        message: `tool-call saving for "${contrast.label}": expected >= ${spec.minToolCallsSaved}, got ${callsSaved}`,
      })
    }
    const ratio = tokenSavingRatio(baseline, optimized)
    if (ratio < spec.minTokenSavingRatio) {
      violations.push({
        kind: 'token_saving',
        target: contrast.label,
        message: `token saving for "${contrast.label}": expected >= ${Math.round(spec.minTokenSavingRatio * 100)}%, got ${(ratio * 100).toFixed(1)}%`,
      })
    }
  }

  return violations
}

/**
 * Derive a fresh {@link BenchThresholds} from a run, for re-baselining (`--update-thresholds`):
 * tool-call counts are the observed exact values; saving floors are the observed savings minus
 * `tokenBand` (default 0.05) so the regenerated spec keeps a tolerance band rather than pinning the
 * exact observed ratio. The runner prints the returned spec for the human to paste into the spec.
 *
 * Throws if any scenario in `results` failed — a broken run must not become a baseline. (The runner
 * also refuses earlier, before calling this; the throw is the library-level guarantee.)
 */
export function deriveThresholds(
  results: ReadonlyArray<ScenarioResult>,
  contrasts: ReadonlyArray<Contrast>,
  tokenBand = 0.05,
): BenchThresholds {
  const failed = results.filter((r) => !r.ok)
  if (failed.length > 0) {
    throw new Error(
      `cannot derive thresholds from a failed benchmark run: ${failed.map((r) => r.name).join(', ')}`,
    )
  }
  const byName = new Map(results.map((r) => [r.name, r]))
  const scenarios: Record<string, ScenarioThreshold> = {}
  for (const result of results) {
    if (result.ok) scenarios[result.name] = { toolCalls: result.toolCalls }
  }
  const contrastSpec: Record<string, ContrastThreshold> = {}
  for (const contrast of contrasts) {
    const baseline = byName.get(contrast.baseline)
    const optimized = byName.get(contrast.optimized)
    if (baseline === undefined || optimized === undefined || !baseline.ok || !optimized.ok) continue
    const callsSaved = baseline.toolCalls - optimized.toolCalls
    const ratio = tokenSavingRatio(baseline, optimized)
    contrastSpec[contrast.label] = {
      minToolCallsSaved: Math.max(0, callsSaved),
      minTokenSavingRatio: Math.max(0, Math.round((ratio - tokenBand) * 100) / 100),
    }
  }
  return { scenarios, contrasts: contrastSpec }
}
