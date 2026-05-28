/**
 * Launch-error diagnosis — map whatever a transport throws from `launch` onto a
 * registered error code so the agent gets an actionable, retryable-aware result
 * instead of an opaque stack trace.
 *
 * A transport that already classified the failure (threw a non-`INTERNAL_ERROR`
 * `StagewrightError`) is passed through unchanged — it knows more than a message
 * regex can infer. Raw errors, and generic `INTERNAL_ERROR` wrappers from SDK
 * boundaries, are pattern-matched here.
 *
 * @module
 */

import { StagewrightError } from '../../errors/registry.js'

/** Regex patterns that map a raw launch error message onto a registered code. */
const PATTERNS: readonly {
  readonly test: RegExp
  readonly code: 'SINGLE_INSTANCE_LOCK' | 'LAUNCH_TIMEOUT' | 'FILE_NOT_FOUND'
}[] = [
  {
    test: /single.?instance|already running|requestsingleinstancelock|the lock/i,
    code: 'SINGLE_INSTANCE_LOCK',
  },
  { test: /timed?\s?out|timeout/i, code: 'LAUNCH_TIMEOUT' },
  { test: /enoent|no such file|cannot find|not found|does not exist/i, code: 'FILE_NOT_FOUND' },
]

/**
 * Convert an error thrown by `ITransport.launch` into a {@link StagewrightError}
 * with a registered code. Classified `StagewrightError`s pass through; raw
 * errors and generic internal wrappers are classified by message, defaulting to
 * `INTERNAL_ERROR`.
 */
export function diagnoseLaunchError(err: unknown): StagewrightError {
  if (err instanceof StagewrightError && err.code !== 'INTERNAL_ERROR') return err
  const message = err instanceof Error ? err.message : String(err)
  const details = err instanceof StagewrightError ? err.details : undefined
  for (const { test, code } of PATTERNS) {
    if (test.test(message)) {
      return new StagewrightError(code, `Launch failed: ${message}`, details)
    }
  }
  if (err instanceof StagewrightError) return err
  return new StagewrightError('INTERNAL_ERROR', `Launch failed: ${message}`)
}
