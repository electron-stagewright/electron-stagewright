/**
 * Per-call session correlation, carried through async work with
 * `AsyncLocalStorage`.
 *
 * The response envelope wants to stamp `_meta.session_id` on every tool result,
 * but the value is only known at dispatch time — deep inside the call stack, far
 * from where {@link import('./envelope.js').makeSuccess} runs. Threading it
 * through every function signature would be invasive and easy to forget. Instead
 * the dispatcher runs each handler inside {@link runWithSessionContext}, and the
 * envelope helpers read the ambient id via {@link currentSessionId} without any
 * explicit plumbing.
 *
 * Outside a dispatched call (e.g. constructing an error before a session
 * exists), the store is absent and {@link currentSessionId} returns `undefined`,
 * which causes the envelope to omit `session_id` — the same behaviour as before
 * this wiring existed.
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The ambient context for one tool dispatch. `sessionId` is `undefined` for
 * tools that run without a resolved session (e.g. `discover_running`) — the
 * field is always present so callers never trip `exactOptionalPropertyTypes`.
 */
export interface SessionContextStore {
  readonly sessionId: string | undefined
}

const storage = new AsyncLocalStorage<SessionContextStore>()

/**
 * Run `fn` with the given session id available to {@link currentSessionId} for
 * the entire (sync and async) duration of the call. Returns whatever `fn`
 * returns.
 */
export function runWithSessionContext<T>(sessionId: string | undefined, fn: () => T): T {
  return storage.run({ sessionId }, fn)
}

/** The session id for the in-flight dispatch, or `undefined` when outside one. */
export function currentSessionId(): string | undefined {
  return storage.getStore()?.sessionId
}
