/**
 * Session registry — owns the live `TransportSession`s the server is driving and
 * maps each to the {@link ITransport} that produced it (so teardown calls the
 * right transport's `stop` / `forceKill`).
 *
 * ## Identity
 *
 * Sessions are keyed by the transport-assigned `session.id`, which is already a
 * stable, collision-free identifier (e.g. `pw-<uuid>`). The manager does NOT mint
 * a second competing id — a session's identity must survive across tool calls,
 * and re-deriving a positional number per call would break a handle the agent
 * reused (see the implementation invariants on stable identity).
 *
 * ## Resolution
 *
 * Most lifecycle/interaction tools accept an optional `sessionId`. {@link
 * SessionManager.resolve} centralises the "which session does this call mean"
 * rule so every tool behaves identically:
 *
 * | sessions live | sessionId given | result                                  |
 * |---------------|-----------------|-----------------------------------------|
 * | 0             | any             | throws `NOT_RUNNING`                     |
 * | 1             | omitted         | the only session                        |
 * | 1+            | given & present | that session                            |
 * | 1+            | given & absent  | throws `NOT_RUNNING` (that id is gone)   |
 * | 2+            | omitted         | throws `BAD_ARGUMENT` (ambiguous)        |
 *
 * Resolution failures throw a {@link StagewrightError}; the dispatcher maps it to
 * an error envelope, so tool handlers can simply call `resolve(...)` and let a
 * miss surface as a registered code.
 *
 * @module
 */

import { StagewrightError } from '../errors/registry.js'
import type { ITransport, SessionId, TransportSession } from '../transports/types.js'

/** A live session plus the transport that owns its lifecycle. */
export interface ManagedSession {
  readonly id: SessionId
  readonly transport: ITransport
  readonly session: TransportSession
}

/**
 * In-memory registry of active sessions. One instance is created per server and
 * threaded to every tool via the tool context.
 */
export class SessionManager {
  readonly #sessions = new Map<SessionId, ManagedSession>()

  /**
   * Record a freshly launched/attached/injected session. Returns the managed
   * entry. Throws `INTERNAL_ERROR` if the transport handed back an empty or
   * duplicate id (transport contract violations) so the bug surfaces loudly
   * rather than silently overwriting a live session.
   */
  register(transport: ITransport, session: TransportSession): ManagedSession {
    if (session.id === '') {
      throw new StagewrightError(
        'INTERNAL_ERROR',
        'Transport returned a session with an empty id.',
        { transport: transport.id },
      )
    }
    if (this.#sessions.has(session.id)) {
      throw new StagewrightError(
        'INTERNAL_ERROR',
        `Transport returned duplicate session id "${session.id}".`,
        { sessionId: session.id, transport: transport.id },
      )
    }
    const managed: ManagedSession = { id: session.id, transport, session }
    this.#sessions.set(session.id, managed)
    return managed
  }

  /** The managed session for `id`, or `undefined` if none. */
  get(id: SessionId): ManagedSession | undefined {
    return this.#sessions.get(id)
  }

  /** Whether a session with `id` is registered. */
  has(id: SessionId): boolean {
    return this.#sessions.has(id)
  }

  /** Number of live sessions. */
  get size(): number {
    return this.#sessions.size
  }

  /** Snapshot of all live sessions, in insertion order. */
  list(): readonly ManagedSession[] {
    return [...this.#sessions.values()]
  }

  /**
   * Resolve the session a tool call refers to. See the module table for the full
   * rule. Throws {@link StagewrightError} (`NOT_RUNNING` or `BAD_ARGUMENT`) on a
   * miss so the dispatcher can turn it into an error envelope.
   */
  resolve(sessionId?: string): ManagedSession {
    if (sessionId !== undefined) {
      const found = this.#sessions.get(sessionId)
      if (found === undefined) {
        throw new StagewrightError(
          'NOT_RUNNING',
          `No session with id "${sessionId}". It may have been stopped.`,
          { sessionId, available_sessions: this.#ids() },
        )
      }
      return found
    }
    if (this.#sessions.size === 0) {
      throw new StagewrightError('NOT_RUNNING', 'No Electron session is running. Launch one first.')
    }
    if (this.#sessions.size > 1) {
      throw new StagewrightError(
        'BAD_ARGUMENT',
        'Multiple sessions are running; pass sessionId to disambiguate.',
        { available_sessions: this.#ids() },
      )
    }
    // Exactly one session — return it. The iterator yields it; the size check
    // above guarantees it exists. If it somehow does not, the registry is
    // corrupt (an internal invariant violation), NOT a "no session" condition —
    // surface INTERNAL_ERROR so the agent does not mistakenly try to launch.
    const only = this.#sessions.values().next().value
    if (only === undefined) {
      throw new StagewrightError(
        'INTERNAL_ERROR',
        'Session registry reports size 1 but yielded no session.',
      )
    }
    return only
  }

  /**
   * Stop and forget the session `id`. Idempotent: a missing id is a no-op, and
   * the underlying `transport.stop` delegates to the session's idempotent
   * `dispose`. `force` routes to `transport.forceKill` (SIGKILL) instead of a
   * graceful stop.
   */
  async remove(id: SessionId, opts: { readonly force?: boolean } = {}): Promise<void> {
    const managed = this.#sessions.get(id)
    if (managed === undefined) return
    // Delete first so a concurrent remove/disposeAll cannot double-stop.
    this.#sessions.delete(id)
    if (opts.force === true) {
      await managed.transport.forceKill(managed.session)
    } else {
      await managed.transport.stop(managed.session)
    }
  }

  /**
   * Stop every live session. Safe to call multiple times (the second call finds
   * an empty registry and does nothing) and safe under partial failure — every
   * session is attempted even if one rejects, and the registry is cleared
   * regardless so a retry never double-stops.
   */
  async disposeAll(): Promise<void> {
    const all = [...this.#sessions.values()]
    this.#sessions.clear()
    await Promise.allSettled(all.map((m) => m.transport.stop(m.session)))
  }

  #ids(): readonly string[] {
    return [...this.#sessions.keys()]
  }
}
