/**
 * Compact server-status state.
 *
 * This is deliberately a small, server-owned projection rather than a log or
 * telemetry store. It remembers only the most recent stable error code for a
 * live session; the status tool resolves volatile renderer information directly
 * from the session when queried.
 *
 * @module
 */

import type { ResponseCode } from '../errors/envelope.js'
import type { ToolResult } from '../tools/types.js'

/** The last failed dispatch associated with one still-live session. */
export interface LastSessionError {
  /** Stable error code, safe for an agent to branch on. */
  readonly code: ResponseCode
  /** Epoch milliseconds when the dispatcher completed the failed call. */
  readonly at: number
}

/** Read-only status capability exposed to a tool handler. */
export interface ServerStatusReader {
  /** Milliseconds since this server instance was constructed. */
  uptimeMs(): number
  /** Most recent stable error for a live session, if any. */
  lastError(sessionId: string): LastSessionError | undefined
}

/** Server-owned bounded state used by `electron_status`. */
export class ServerStatus implements ServerStatusReader {
  readonly #startedAt: number
  readonly #now: () => number
  readonly #lastErrors = new Map<string, LastSessionError>()

  constructor(opts: { readonly now?: () => number } = {}) {
    this.#now = opts.now ?? Date.now
    this.#startedAt = this.#now()
  }

  /** Milliseconds since this server instance was constructed. */
  uptimeMs(): number {
    return Math.max(0, this.#now() - this.#startedAt)
  }

  /** Most recent stable error for a live session, if any. */
  lastError(sessionId: string): LastSessionError | undefined {
    return this.#lastErrors.get(sessionId)
  }

  /**
   * Observe a completed dispatch. Successful calls never erase the previous
   * failure: a status query should retain the last actionable problem until the
   * session ends, rather than flickering merely because a later read succeeded.
   */
  record(
    result: ToolResult,
    finishedAt: number,
    isLiveSession: (sessionId: string) => boolean,
  ): void {
    if (result.ok) return
    const sessionId = result._meta.session_id
    if (sessionId === undefined || !isLiveSession(sessionId)) return
    this.#lastErrors.set(sessionId, { code: result.code, at: finishedAt })
  }

  /** Forget terminal session state as soon as its owner releases the session. */
  clearSession(sessionId: string): void {
    this.#lastErrors.delete(sessionId)
  }
}
