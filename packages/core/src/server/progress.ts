/**
 * Request-scoped MCP progress reporting.
 *
 * The reporter validates and bounds updates before handing them to the SDK's
 * request-related `sendNotification` seam. Notification delivery is deliberately
 * best-effort: a closed transport or host that ignores progress must never turn a
 * successful tool call into an error or delay its final envelope indefinitely.
 *
 * @module
 */

import type { ProgressNotification, ProgressToken } from '@modelcontextprotocol/sdk/types.js'

import type { ProgressReporter, ProgressUpdate } from '../tools/types.js'
import type { Logger } from './logger.js'

/** Internal close subscriptions keep heartbeat timers out of the public reporter contract. */
const CLOSE_LISTENERS = new WeakMap<ProgressReporter, Set<() => void>>()

/** Hard per-request notification budget shared by top-level and re-dispatched tools. */
export const MAX_PROGRESS_NOTIFICATIONS = 12

/** Do not emit heartbeat noise for operations that finish inside this window. */
export const MIN_PROGRESS_INTERVAL_MS = 250

/** SDK request-related notification sender. */
export type ProgressNotificationSender = (notification: ProgressNotification) => Promise<void>

/** Reporter implementation owned by the MCP request handler. */
export interface ManagedProgressReporter extends ProgressReporter {
  /** Stop accepting updates and detach request-abort observation. Idempotent. */
  close(): void
}

/** Construction options for {@link createProgressReporter}. */
export interface ProgressReporterOptions {
  readonly progressToken?: ProgressToken
  readonly sendNotification?: ProgressNotificationSender
  readonly signal?: AbortSignal
  readonly logger: Logger
}

/** Disabled reporter used by direct dispatch and MCP calls without a progress token. */
export const NOOP_PROGRESS_REPORTER: ManagedProgressReporter = Object.freeze({
  enabled: false,
  report: () => false,
  close() {},
})

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Progress diagnostics are advisory too: a caller-supplied logger must not make reporting throw. */
function debugDeliveryFailure(logger: Logger, error: unknown): void {
  try {
    logger.debug('Progress notification failed; ignored', {
      error: describeError(error),
    })
  } catch {
    // Best-effort all the way down. The final tool envelope must remain unaffected.
  }
}

/**
 * Create a bounded reporter for one MCP request. Missing token/sender or an
 * already-aborted request yields a no-op. The opaque token is echoed unchanged,
 * including numeric `0`.
 */
export function createProgressReporter(options: ProgressReporterOptions): ManagedProgressReporter {
  const { progressToken, sendNotification, signal, logger } = options
  if (progressToken === undefined || sendNotification === undefined || signal?.aborted === true) {
    return NOOP_PROGRESS_REPORTER
  }

  let closed = false
  let accepted = 0
  let lastProgress = -1
  const closeListeners = new Set<() => void>()

  const close = (): void => {
    if (closed) return
    closed = true
    signal?.removeEventListener('abort', close)
    for (const listener of closeListeners) {
      try {
        listener()
      } catch {
        // Closing progress remains best-effort and must not affect the tool result.
      }
    }
    closeListeners.clear()
  }
  signal?.addEventListener('abort', close, { once: true })

  const reporter: ManagedProgressReporter = {
    get enabled(): boolean {
      return !closed && accepted < MAX_PROGRESS_NOTIFICATIONS
    },
    report(update: ProgressUpdate): boolean {
      if (closed || accepted >= MAX_PROGRESS_NOTIFICATIONS) return false
      const { progress, total, message } = update
      if (!Number.isFinite(progress) || progress < 0 || progress <= lastProgress) return false
      if (total !== undefined && (!Number.isFinite(total) || total <= 0 || progress > total)) {
        return false
      }

      lastProgress = progress
      accepted += 1
      const notification: ProgressNotification = {
        method: 'notifications/progress',
        params: {
          progressToken,
          progress,
          ...(total !== undefined ? { total } : {}),
          ...(message !== undefined ? { message } : {}),
        },
      }

      // Attach rejection handling synchronously. Neither a synchronous sender
      // throw nor a later rejected promise may escape the advisory progress path.
      try {
        void Promise.resolve(sendNotification(notification)).catch((error: unknown) => {
          debugDeliveryFailure(logger, error)
        })
      } catch (error) {
        debugDeliveryFailure(logger, error)
      }
      return true
    },
    close,
  }
  CLOSE_LISTENERS.set(reporter, closeListeners)
  return reporter
}

/** Options for {@link withElapsedProgress}. */
export interface ElapsedProgressOptions {
  readonly reporter: ProgressReporter
  /** Known bounded operation budget in milliseconds. */
  readonly totalMs: number
  /** Stable phase text; do not include app or caller payloads. */
  readonly message: string
  /** Clock injection, normally the dispatcher's `ToolContext.now`. */
  readonly now?: () => number
}

/**
 * Run work while emitting bounded elapsed-time heartbeats. The cadence adapts
 * to the total so a full-budget operation cannot exceed the global cap. There is
 * no synthetic completion notification: the final tool envelope is the only
 * authoritative completion signal.
 */
export async function withElapsedProgress<T>(
  options: ElapsedProgressOptions,
  run: () => Promise<T>,
): Promise<T> {
  const { reporter, totalMs, message } = options
  if (!reporter.enabled || !Number.isFinite(totalMs) || totalMs <= 0) return run()

  const now = options.now ?? Date.now
  const startedAt = now()
  const intervalMs = Math.max(
    MIN_PROGRESS_INTERVAL_MS,
    Math.ceil(totalMs / MAX_PROGRESS_NOTIFICATIONS),
  )
  const timer = setInterval(() => {
    if (!reporter.enabled) {
      stop()
      return
    }
    const elapsed = Math.min(totalMs, Math.max(0, now() - startedAt))
    if (elapsed > 0) {
      reporter.report({ progress: elapsed, total: totalMs, message })
      if (elapsed >= totalMs) stop()
    }
  }, intervalMs)
  timer.unref?.()
  const closeListeners = CLOSE_LISTENERS.get(reporter)
  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    closeListeners?.delete(stop)
  }
  closeListeners?.add(stop)

  try {
    return await run()
  } finally {
    stop()
  }
}
