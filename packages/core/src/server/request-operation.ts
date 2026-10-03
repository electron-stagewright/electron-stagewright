import { StagewrightError } from '../errors/registry.js'
import type { Logger } from './logger.js'

/** Cooperative lifetime of one dispatch. Never waits for an uninterruptible transport call. */
export class RequestOperation {
  readonly #controller = new AbortController()
  readonly #cleanups = new Set<() => void | Promise<void>>()
  readonly #parent: AbortSignal | undefined
  readonly #logger: Logger
  #timer: ReturnType<typeof setTimeout> | undefined
  #closed = false

  constructor(parent: AbortSignal | undefined, budget: number, logger: Logger) {
    this.#parent = parent
    this.#logger = logger
    if (parent?.aborted === true) this.#cancel()
    else parent?.addEventListener('abort', this.#cancel, { once: true })
    if (budget > 0 && !this.signal.aborted) {
      this.#timer = setTimeout(
        () =>
          this.#abort(
            new StagewrightError(
              'OPERATION_TIMEOUT',
              `Operation exceeded the ${budget}ms dispatch timeout; the app may be hung.`,
              { timeout_ms: budget },
            ),
          ),
        budget,
      )
      this.#timer.unref?.()
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  // A parent's timeout stays a timeout for nested calls; arbitrary client reasons are not exposed.
  readonly #cancel = (): void => {
    const reason: unknown = this.#parent?.reason
    this.#abort(
      reason instanceof StagewrightError && reason.code === 'OPERATION_TIMEOUT'
        ? reason
        : new StagewrightError('OPERATION_CANCELLED', 'The request was cancelled.'),
    )
  }

  #abort(reason: StagewrightError): void {
    if (this.signal.aborted) return
    this.#controller.abort(reason)
    for (const cleanup of this.#cleanups) this.#cleanup(cleanup)
    this.#cleanups.clear()
  }

  #cleanup(cleanup: () => void | Promise<void>): void {
    try {
      void Promise.resolve(cleanup()).catch(() => this.#warnCleanup())
    } catch {
      this.#warnCleanup()
    }
  }

  #warnCleanup(): void {
    try {
      this.#logger.warn('Cancelled request cleanup failed; transport resources may remain.')
    } catch {
      /* Cleanup diagnostics must not throw from an abort listener. */
    }
  }

  /** Cleanup is cancellation-only; successful completion releases the callback without calling it. */
  readonly onCancel = (cleanup: () => void | Promise<void>): (() => void) => {
    if (this.signal.aborted) this.#cleanup(cleanup)
    else if (!this.#closed) this.#cleanups.add(cleanup)
    return () => {
      this.#cleanups.delete(cleanup)
    }
  }

  async run<T>(run: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted()
    let rejectAbort!: (reason: unknown) => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject
    })
    const onAbort = (): void => rejectAbort(this.signal.reason)
    this.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          this.signal.throwIfAborted()
          return run()
        }),
        cancelled,
      ])
      // A handler resolving in the same turn as cancellation must not publish a late success.
      this.signal.throwIfAborted()
      return result
    } finally {
      this.signal.removeEventListener('abort', onAbort)
    }
  }

  /** Idempotently release timers, parent observation and cancellation-only callbacks. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#parent?.removeEventListener('abort', this.#cancel)
    this.#cleanups.clear()
  }
}
