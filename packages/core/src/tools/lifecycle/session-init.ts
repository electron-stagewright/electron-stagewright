/**
 * Shared session-initialisation step for the tools that create a session
 * (`launch`, `attach`, `inject`).
 *
 * Registering a session and then fetching its initial window list has a subtle
 * failure mode: if the window-list call throws *after* the session is
 * registered, the agent receives an error with no `session_id` and the session
 * is orphaned in the manager — unreachable, never stopped. This helper closes
 * that gap by deregistering (best-effort) before re-throwing, so a failed
 * initialisation never leaks a session.
 *
 * @module
 */

import type { ManagedSession } from '../../server/session-manager.js'
import type { ITransport, TransportSession, WindowDescriptor } from '../../transports/index.js'
import type { ToolContext } from '../types.js'

/**
 * Register `session` with the context's session manager and fetch its window
 * list. If the window-list call fails, the just-registered session is removed
 * (best-effort) and the original error re-thrown, so the manager never retains a
 * session the agent cannot address.
 */
export async function registerWithWindows(
  ctx: Pick<ToolContext, 'sessions'>,
  transport: ITransport,
  session: TransportSession,
): Promise<{ readonly managed: ManagedSession; readonly windows: readonly WindowDescriptor[] }> {
  const managed = ctx.sessions.register(transport, session)
  try {
    const windows = await managed.session.windowsList()
    return { managed, windows }
  } catch (err) {
    await ctx.sessions.remove(managed.id).catch(() => undefined)
    throw err
  }
}
