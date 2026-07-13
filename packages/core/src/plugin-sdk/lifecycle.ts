/** Per-server lifecycle helpers for plugin-owned session state. */

import type { PluginServerContext } from '../plugins/types.js'

/** A cleanup binding that is attached during setup and released during plugin teardown. */
export interface PluginSessionCleanup {
  /** Subscribe to future session releases for this server. Safe to call again before teardown. */
  setup(context: PluginServerContext | undefined): void
  /** Unsubscribe and run the final per-server cleanup exactly once. */
  teardown(): void
}

/**
 * Bind plugin-owned state to the server session lifecycle.
 *
 * `onSessionEnd` releases state for each individual session. `onTeardown` is the final backstop
 * for server-scoped state and is deliberately separate so a plugin can retain server-scoped work
 * (such as a trace) until it explicitly stops it.
 */
export function createSessionCleanup(
  onSessionEnd: (sessionId: string) => void,
  onTeardown: () => void,
): PluginSessionCleanup {
  let unsubscribe: (() => void) | undefined
  let toreDown = false

  return {
    setup(context: PluginServerContext | undefined): void {
      if (toreDown) return
      unsubscribe?.()
      unsubscribe = context?.onSessionEnd(({ sessionId }) => {
        onSessionEnd(sessionId)
      })
    },
    teardown(): void {
      if (toreDown) return
      toreDown = true
      unsubscribe?.()
      unsubscribe = undefined
      onTeardown()
    },
  }
}
