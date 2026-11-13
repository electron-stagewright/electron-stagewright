/** The supervisor's own failures. Application errors keep their own code when it is well formed. */
export const HOST_ERROR_CODES = [
  /** `close()` was called, or the call was still waiting when the host stopped. */
  'HOST_STOPPED',
  /** The host exited while the call was in flight. Calls are never resent. */
  'HOST_EXITED',
  /** The host failed to start, or answered `start` with a failure. */
  'HOST_START_FAILED',
  /** `onExit` chose `fatal`; the host never starts again. */
  'HOST_FATAL',
  'HOST_CALL_TIMEOUT',
  'HOST_CALL_ABORTED',
  /** More than `maxPending` calls were waiting. */
  'HOST_QUEUE_FULL',
  /** The host refused an operation outside its closed list. */
  'HOST_OPERATION_REJECTED',
  /** The host did not finish closing within the grace period and was terminated. */
  'HOST_STOP_TIMEOUT',
  /** The host exited during `stop` without confirming that its cleanup finished. */
  'HOST_STOP_INCOMPLETE',
] as const

export type HostErrorCode = (typeof HOST_ERROR_CODES)[number]

export class HostError extends Error {
  readonly code: HostErrorCode

  constructor(code: HostErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'HostError'
    this.code = code
  }
}

export function isHostError(error: unknown, code?: HostErrorCode): error is HostError {
  return error instanceof HostError && (code === undefined || error.code === code)
}
