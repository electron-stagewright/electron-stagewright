/**
 * Classify a thrown eval failure onto a registered `EVAL_*` error code, mirroring
 * `diagnoseLaunchError`. `EVAL_BLOCKED_KEYWORD` is NOT produced here — the
 * dispatcher's keyword blocklist raises it before the handler runs; this maps the
 * failures that surface from actually evaluating the payload.
 *
 * @module
 */

import { type ErrorCode, StagewrightError } from '../../errors/registry.js'

/**
 * Map an error thrown while evaluating an eval payload to a registered code:
 * a SyntaxError → `EVAL_SYNTAX_ERROR`, a timeout → `EVAL_TIMEOUT`, an already
 * classified non-internal `StagewrightError` (e.g. `NOT_RUNNING`) passes through,
 * and everything else → `EVAL_RUNTIME_ERROR` (a value the body threw at runtime).
 */
export function classifyEvalError(err: unknown): ErrorCode {
  if (err instanceof StagewrightError && err.code !== 'INTERNAL_ERROR') return err.code
  if (err instanceof Error && err.name === 'SyntaxError') return 'EVAL_SYNTAX_ERROR'
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  if (
    /syntaxerror|unexpected token|unexpected identifier|unexpected end of (input|script)|missing \) after/.test(
      msg,
    )
  ) {
    return 'EVAL_SYNTAX_ERROR'
  }
  if (/timeout|timed out|exceeded/.test(msg)) return 'EVAL_TIMEOUT'
  return 'EVAL_RUNTIME_ERROR'
}
