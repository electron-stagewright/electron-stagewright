/**
 * Per-session last-snapshot store.
 *
 * `electron_snapshot({ since: 'last' })` returns only what changed since the
 * previous snapshot, which means the server has to remember the previous one per
 * session. That state lives here — keyed by `sessionId` — so a tool can diff the
 * fresh walk against it and detect renderer reloads. Keeping it out of the pure
 * snapshot module (which is stateless by design) preserves that module's
 * testability.
 *
 * @module
 */

import type { Snapshot } from '../snapshot/index.js'

/** In-memory map of `sessionId → last snapshot`. One instance per server. */
export class SnapshotStore {
  readonly #last = new Map<string, Snapshot>()

  /** The last stored snapshot for `sessionId`, or `undefined` if none. */
  get(sessionId: string): Snapshot | undefined {
    return this.#last.get(sessionId)
  }

  /** Record `snapshot` as the latest for `sessionId`. */
  set(sessionId: string, snapshot: Snapshot): void {
    this.#last.set(sessionId, snapshot)
  }

  /** Forget the stored snapshot for `sessionId` (e.g. on session teardown). */
  clear(sessionId: string): void {
    this.#last.delete(sessionId)
  }

  /** Forget everything (e.g. on server shutdown). */
  clearAll(): void {
    this.#last.clear()
  }
}
