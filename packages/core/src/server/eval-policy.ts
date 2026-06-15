/**
 * Eval authorization policy — per-target least privilege for the eval escape hatch
 * (ADR-014). The two eval targets have very different blast radii: main-process eval
 * is full Node/Electron (`fs`, `child_process`, `process`, app control), while
 * renderer eval is the web page context. An operator should be able to grant only
 * the target a flow needs, so a renderer-only automation never exposes the
 * main-process surface.
 *
 * The policy supersedes the original binary `--allow-eval` gate WITHOUT breaking it:
 * a bare `boolean` still works everywhere (`true` → both targets, `false` → neither),
 * and the dispatcher normalises whatever it is given to an {@link EvalPolicy} before
 * applying the per-target registration gate.
 *
 * @module
 */

/**
 * Which eval targets the operator has authorized. Each flag gates whether the
 * corresponding eval tool registers at all (default-deny-by-absence, matching the
 * original `--allow-eval` model). The keys mirror the `EvalTarget` union used by
 * tool definitions; a missing tool is unreachable rather than visible-but-rejecting.
 */
export interface EvalPolicy {
  /** Main-process eval (`electron_eval_main`, and plugins that instrument the main process). */
  readonly main: boolean
  /** Renderer eval (`electron_eval_renderer`). */
  readonly renderer: boolean
}

/** The deny-everything policy — the safe default when eval was never opted into. */
const DENY_ALL: EvalPolicy = { main: false, renderer: false }

/**
 * Coerce the public `allowEval` option (a back-compat `boolean` or an explicit
 * {@link EvalPolicy}) into a canonical policy. `undefined`/`false` → deny both;
 * `true` → allow both; an explicit policy is passed through (copied so callers
 * cannot mutate the dispatcher's state).
 */
export function normalizeEvalPolicy(value: boolean | EvalPolicy | undefined): EvalPolicy {
  if (value === undefined || value === false) return { ...DENY_ALL }
  if (value === true) return { main: true, renderer: true }
  return { main: value.main, renderer: value.renderer }
}

/** Whether the policy permits at least one eval target. */
export function anyEvalAllowed(policy: EvalPolicy): boolean {
  return policy.main || policy.renderer
}
