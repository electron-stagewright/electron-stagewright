/**
 * Per-session last-snapshot store.
 *
 * `electron_snapshot({ since: 'last' })` returns only what changed since the
 * previous snapshot, which means the server has to remember the previous one per
 * surface. That state lives here — keyed by `(sessionId, surfaceId)` — so a tool can diff the
 * fresh walk against it and detect renderer reloads without letting a ref from one
 * frame/page act in another. Keeping it out of the pure
 * snapshot module (which is stateless by design) preserves that module's
 * testability.
 *
 * @module
 */

import type { Snapshot } from '../snapshot/index.js'

/** Legacy/default key for direct test consumers that do not model surfaces. */
const DEFAULT_SURFACE_ID = '__default__'

/** In-memory map of `sessionId → surfaceId → last snapshot`. One instance per server. */
export class SnapshotStore {
  readonly #last = new Map<string, Map<string, Snapshot>>()
  readonly #refLocks = new Map<string, Promise<void>>()

  /**
   * Run `task` while holding `sessionId`'s ref lock. A walk renumbers every DOM ref tag and
   * only the following reconcile + retag + store restores them, so those steps must not
   * interleave with another walk on the same session. A caller whose `signal` aborts while
   * queued rejects with its reason without running `task`.
   */
  async withRefLock<T>(
    sessionId: string,
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const previous = this.#refLocks.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => held)
    this.#refLocks.set(sessionId, tail)
    void tail.then(() => {
      if (this.#refLocks.get(sessionId) === tail) this.#refLocks.delete(sessionId)
    })
    try {
      await untilAborted(previous, signal)
      return await task()
    } finally {
      release()
    }
  }

  /** The last stored snapshot for `(sessionId, surfaceId)`, or `undefined` if none. */
  get(sessionId: string, surfaceId: string = DEFAULT_SURFACE_ID): Snapshot | undefined {
    return this.#last.get(sessionId)?.get(surfaceId)
  }

  /** Record `snapshot` as the latest for `(sessionId, surfaceId)`. */
  set(sessionId: string, snapshot: Snapshot, surfaceId: string = DEFAULT_SURFACE_ID): void {
    let bySurface = this.#last.get(sessionId)
    if (bySurface === undefined) {
      bySurface = new Map()
      this.#last.set(sessionId, bySurface)
    }
    bySurface.set(surfaceId, snapshot)
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

/** Settle with `promise`, or reject with `signal`'s reason as soon as it aborts. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const cancel = (): void => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', cancel)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', cancel)
        reject(err)
      },
    )
  })
}
