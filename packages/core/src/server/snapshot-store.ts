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

import { StagewrightError } from '../errors/registry.js'
import type { Snapshot } from '../snapshot/index.js'

/** Legacy/default key for direct test consumers that do not model surfaces. */
const DEFAULT_SURFACE_ID = '__default__'

/** How long one holder may keep a ref lock before queued callers fail; mirrors the max wait clamp. */
export const DEFAULT_REF_LOCK_BUDGET_MS = 60_000

/** Options for {@link SnapshotStore}. */
export interface SnapshotStoreOptions {
  /** Hold time after which queued ref-lock callers fail with `RENDERER_BUSY`. */
  readonly refLockBudgetMs?: number
}

interface RefLockState {
  tail: Promise<void>
  stalled: boolean
  readonly waiters: Set<(err: StagewrightError) => void>
}

/** In-memory map of `sessionId → surfaceId → last snapshot`. One instance per server. */
export class SnapshotStore {
  readonly #last = new Map<string, Map<string, Snapshot>>()
  readonly #refLocks = new Map<string, RefLockState>()
  readonly #refLockBudgetMs: number

  constructor(opts: SnapshotStoreOptions = {}) {
    this.#refLockBudgetMs = opts.refLockBudgetMs ?? DEFAULT_REF_LOCK_BUDGET_MS
  }

  /**
   * Run `task` while holding the ref lock of `(sessionId, surfaceId)`. A walk renumbers every
   * DOM ref tag of its surface and only the following reconcile + retag + store restores them,
   * so those steps must not interleave with another walk on the same surface. A caller whose
   * `signal` aborts while queued rejects with its reason without running `task`. Once a holder
   * keeps the lock past the budget, queued and new callers reject with `RENDERER_BUSY`; the
   * holder itself keeps the lock until its task settles.
   */
  async withRefLock<T>(
    sessionId: string,
    surfaceId: string,
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const key = `${sessionId}\u0000${surfaceId}`
    let state = this.#refLocks.get(key)
    if (state === undefined) {
      state = { tail: Promise.resolve(), stalled: false, waiters: new Set() }
      this.#refLocks.set(key, state)
    }
    const lock = state
    if (lock.stalled) throw rendererBusy(this.#refLockBudgetMs)
    const previous = lock.tail
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => held)
    lock.tail = tail
    void tail.then(() => {
      if (this.#refLocks.get(key) === lock && lock.tail === tail) this.#refLocks.delete(key)
    })
    try {
      await this.#awaitTurn(lock, previous, signal)
      const stall = setTimeout(() => {
        lock.stalled = true
        const busy = rendererBusy(this.#refLockBudgetMs)
        for (const reject of lock.waiters) reject(busy)
      }, this.#refLockBudgetMs)
      stall.unref?.()
      try {
        return await task()
      } finally {
        clearTimeout(stall)
        lock.stalled = false
      }
    } finally {
      release()
    }
  }

  /** Wait for `previous` to release, unless `signal` aborts or the holder stalls first. */
  async #awaitTurn(
    lock: RefLockState,
    previous: Promise<void>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    let reject!: (err: StagewrightError) => void
    const stalled = new Promise<never>((_resolve, fail) => {
      reject = fail
    })
    lock.waiters.add(reject)
    try {
      await untilAborted(Promise.race([previous, stalled]), signal)
    } finally {
      lock.waiters.delete(reject)
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

function rendererBusy(budgetMs: number): StagewrightError {
  return new StagewrightError(
    'RENDERER_BUSY',
    `The renderer is still busy with a previous walk or ref-targeted operation after ${budgetMs}ms.`,
    { budget_ms: budgetMs },
  )
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
