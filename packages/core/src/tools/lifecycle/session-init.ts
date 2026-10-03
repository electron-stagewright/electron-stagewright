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
  ctx: Pick<ToolContext, 'sessions' | 'signal' | 'onCancel'>,
  transport: ITransport,
  session: TransportSession,
  failureCleanup: 'stop' | 'detach',
  prepare?: () => Promise<void>,
): Promise<{ readonly managed: ManagedSession; readonly windows: readonly WindowDescriptor[] }> {
  let managed: ManagedSession | undefined
  let cleanupPromise: Promise<unknown> | undefined
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      if (managed !== undefined && ctx.sessions.get(managed.id) === managed) {
        await ctx.sessions.remove(managed.id, { detach: failureCleanup === 'detach' })
      } else if (managed === undefined) {
        if (failureCleanup === 'detach') await session.detach()
        else await transport.stop(session)
      }
    })()
    return cleanupPromise.then(() => undefined)
  }
  // Keep rollback armed until the dispatcher completes, covering cancellation just after register.
  const unregister = ctx.onCancel?.(cleanup)
  try {
    ctx.signal?.throwIfAborted()
    const windows = await session.windowsList()
    ctx.signal?.throwIfAborted()
    await prepare?.()
    ctx.signal?.throwIfAborted()
    managed = ctx.sessions.register(transport, session)
    return { managed, windows }
  } catch (err) {
    unregister?.()
    try {
      await cleanup()
    } catch {
      // A cleanup error must neither mask initialization failure nor stop an attached app.
    }
    throw err
  }
}
