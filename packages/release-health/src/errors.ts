export const UNAVAILABLE_REASONS = [
  'missing_credential',
  'permission_denied',
  'rate_limited',
  'timeout',
  'http_error',
  'invalid_response',
  'incomplete_data',
  'governance_history_incomplete',
  'source_error',
] as const

export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number]

/** A bounded source failure that is safe to map into a report without retaining upstream data. */
export class SourceUnavailableError extends Error {
  readonly reason: UnavailableReason

  constructor(reason: UnavailableReason) {
    super(`Release-health source unavailable: ${reason}`)
    this.name = 'SourceUnavailableError'
    this.reason = reason
  }
}

export function unavailableReason(error: unknown): UnavailableReason {
  return error instanceof SourceUnavailableError ? error.reason : 'source_error'
}
