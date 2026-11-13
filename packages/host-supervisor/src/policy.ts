import type { ExitDecision, HostExit } from './host.js'
import type { HostStats } from './protocol.js'

export interface RestartPolicyOptions {
  /** Restarts allowed inside `windowMs`; one more is fatal. */
  readonly maxRestarts?: number
  readonly windowMs?: number
  /** Delay before the 1st, 2nd, ... restart in the window; the last value repeats. */
  readonly backoffMs?: readonly number[]
  /** Exits that must never be retried, such as a corrupt database or a key that no longer opens it. */
  readonly isFatal?: (exit: HostExit) => boolean
  readonly now?: () => number
}

export const DEFAULT_RESTART_POLICY = {
  maxRestarts: 3,
  windowMs: 10 * 60_000,
  backoffMs: [500, 2_000, 8_000],
} as const

/**
 * Bounded restart: up to `maxRestarts` in a sliding window, with backoff. A restart whose start
 * fails counts as an attempt.
 */
export function restartPolicy(
  options: RestartPolicyOptions = {},
): (exit: HostExit) => ExitDecision {
  const maxRestarts = options.maxRestarts ?? DEFAULT_RESTART_POLICY.maxRestarts
  const windowMs = options.windowMs ?? DEFAULT_RESTART_POLICY.windowMs
  const backoffMs = options.backoffMs ?? DEFAULT_RESTART_POLICY.backoffMs
  const now = options.now ?? Date.now
  let restarts: number[] = []
  return (exit) => {
    if (options.isFatal?.(exit)) return 'fatal'
    const at = now()
    restarts = restarts.filter((time) => at - time < windowMs)
    if (restarts.length >= maxRestarts) return 'fatal'
    restarts.push(at)
    const delayMs = backoffMs[Math.min(restarts.length, backoffMs.length) - 1] ?? 0
    return { action: 'restart', delayMs }
  }
}

export interface MemoryWatchOptions {
  readonly rssMb: number
  /** Samples over the limit in a row before the alert. Default 2. */
  readonly consecutive?: number
  readonly onAlert: (stats: HostStats) => void
}

/**
 * Alerts once when RSS stays over a limit, and again only after it has come back under. Native
 * memory sits outside any V8 heap cap, so RSS is what shows it.
 */
export function memoryWatch(options: MemoryWatchOptions): (stats: HostStats) => void {
  const needed = options.consecutive ?? 2
  let over = 0
  let alerted = false
  return (stats) => {
    over = stats.rssMb > options.rssMb ? over + 1 : 0
    if (over === 0) alerted = false
    if (over >= needed && !alerted) {
      alerted = true
      options.onAlert(stats)
    }
  }
}
