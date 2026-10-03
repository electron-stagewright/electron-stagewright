/**
 * Initialize a session before publishing its handle. Failed launches stop their
 * owned process; failed attach/inject calls only release their connection to an
 * existing app. Cleanup must preserve the original initialization error.
 */

import type { ManagedSession } from '../../server/session-manager.js'
import type { ITransport, TransportSession, WindowDescriptor } from '../../transports/index.js'
import type { ToolContext } from '../types.js'

/** Fetch initial windows and register only a session the caller can successfully address. */
export async function registerWithWindows(
  ctx: Pick<ToolContext, 'sessions'>,
  transport: ITransport,
  session: TransportSession,
  failureCleanup: 'stop' | 'detach',
): Promise<{ readonly managed: ManagedSession; readonly windows: readonly WindowDescriptor[] }> {
  try {
    const windows = await session.windowsList()
    const managed = ctx.sessions.register(transport, session)
    return { managed, windows }
  } catch (err) {
    try {
      if (failureCleanup === 'detach') await session.detach()
      else await transport.stop(session)
    } catch {
      // A cleanup error must neither mask initialization failure nor stop an attached app.
    }
    throw err
  }
}
