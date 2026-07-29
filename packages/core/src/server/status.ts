/**
 * Compact server-status state.
 *
 * This is deliberately a small, server-owned projection rather than a log or
 * telemetry store. It remembers only the most recent stable error code for each
 * live session plus the most recent failure that cannot be attributed to a live
 * session; the status tool resolves volatile renderer information directly from
 * the session when queried.
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

/** The last failed dispatch that could not be attributed to one live session. */
export interface LastServerError extends LastSessionError {
  /**
   * Registered tool that failed. Omitted for unknown tool names so agent-controlled
   * input is never reflected through a later status response.
   */
  readonly tool?: string
}

/** Read-only status capability exposed to a tool handler. */
export interface ServerStatusReader {
  /** Milliseconds since this server instance was constructed. */
  uptimeMs(): number
  /** Most recent stable error for a live session, if any. */
  lastError(sessionId: string): LastSessionError | undefined
  /**
   * Epoch milliseconds when this server instance was constructed.
   *
   * Optional so status readers authored against plugin API 1.3 remain
   * structurally compatible. Core's server-owned reader always supplies it.
   */
  startedAt?(): number
  /**
   * Most recent stable error not attributable to a currently live session, if any.
   *
   * Optional so status readers authored against plugin API 1.3 remain
   * structurally compatible. Core's server-owned reader always supplies it.
   */
  lastServerError?(): LastServerError | undefined
}

/** Server-owned bounded state used by `electron_status`. */
export class ServerStatus implements ServerStatusReader {
  readonly #startedAt: number
  readonly #now: () => number
  readonly #lastErrors = new Map<string, LastSessionError>()
  #lastServerError: LastServerError | undefined

  constructor(opts: { readonly now?: () => number } = {}) {
    this.#now = opts.now ?? Date.now
    this.#startedAt = this.#now()
  }

  /** Epoch milliseconds when this server instance was constructed. */
  startedAt(): number {
    return this.#startedAt
  }

  /** Milliseconds since this server instance was constructed. */
  uptimeMs(): number {
    return Math.max(0, this.#now() - this.#startedAt)
  }

  /** Most recent stable error not attributable to a currently live session, if any. */
  lastServerError(): LastServerError | undefined {
    return this.#lastServerError
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
    tool: string | undefined,
    result: ToolResult,
    finishedAt: number,
    isLiveSession: (sessionId: string) => boolean,
  ): void {
    if (result.ok) return
    const sessionId = result._meta.session_id
    if (sessionId !== undefined && isLiveSession(sessionId)) {
      this.#lastErrors.set(sessionId, { code: result.code, at: finishedAt })
      return
    }
    this.#lastServerError = {
      code: result.code,
      at: finishedAt,
      ...(tool !== undefined ? { tool } : {}),
    }
  }

  /**
   * Forget terminal session state as soon as its owner releases the session, but keep that
   * session's last stable failure reachable at the server level.
   *
   * A session that ends because the app died would otherwise erase the very failure an agent
   * needs to orient, and whether it survived at all would depend on whether the session-end
   * event beat the failing dispatch to this store. Promotion keeps only the stable code and
   * completion time — never the session identifier — and never displaces a newer server-level
   * failure.
   */
  clearSession(sessionId: string): void {
    const ended = this.#lastErrors.get(sessionId)
    this.#lastErrors.delete(sessionId)
    if (ended === undefined) return
    if (this.#lastServerError !== undefined && this.#lastServerError.at >= ended.at) return
    this.#lastServerError = { code: ended.code, at: ended.at }
  }
}
