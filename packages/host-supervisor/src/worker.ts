/**
 * `worker_threads` transport. Cheap to start and close to the caller, but the host shares the
 * process: a native crash in it ends the whole app.
 */

import { Worker, type ResourceLimits, type WorkerOptions } from 'node:worker_threads'

import type { ChannelExit, HostChannel, HostTransport } from './contract.js'

/** The part of `Worker` the transport relies on. */
export interface WorkerLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<number>
}

export interface WorkerThreadTransportOptions {
  /** The host entry: a file that calls `serveHost`. */
  readonly entry: string | URL
  /**
   * V8 heap caps; past them Node usually ends only the worker, reported as `out-of-memory`. One
   * allocation far past the cap can still abort the whole process.
   */
  readonly resourceLimits?: ResourceLimits
  readonly env?: WorkerOptions['env']
  readonly execArgv?: readonly string[]
  readonly argv?: readonly unknown[]
  readonly name?: string
  /** Replaces `new Worker`, for tests. */
  readonly createWorker?: (entry: string | URL, options: WorkerOptions) => WorkerLike
}

const createNodeWorker = (entry: string | URL, options: WorkerOptions): WorkerLike =>
  new Worker(entry, options)

export function workerThreadTransport(options: WorkerThreadTransportOptions): HostTransport {
  const create = options.createWorker ?? createNodeWorker
  return {
    launch(): HostChannel {
      const worker = create(options.entry, {
        ...(options.resourceLimits ? { resourceLimits: options.resourceLimits } : {}),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.execArgv ? { execArgv: [...options.execArgv] } : {}),
        ...(options.argv ? { argv: [...options.argv] } : {}),
        ...(options.name ? { name: options.name } : {}),
      })
      let error: Error | null = null
      // Node emits its own heap-limit error in the same tick as 'exit'; an uncaught error that
      // merely carries that code (from an inner worker, say) arrives earlier.
      let errorThisTick = false
      // A worker can throw any value, falsy ones included.
      worker.on('error', (cause: unknown) => {
        error =
          cause instanceof Error
            ? cause
            : new Error(`The host threw a non-error value: ${String(cause)}`)
        errorThisTick = true
        queueMicrotask(() => (errorThisTick = false))
      })
      return {
        send: (message) => worker.postMessage(message),
        onMessage: (listener) => void worker.on('message', listener),
        onExit: (listener) =>
          void worker.on('exit', (code) => {
            const exit: ChannelExit = error
              ? {
                  code,
                  error,
                  outOfMemory:
                    errorThisTick &&
                    (error as { code?: unknown }).code === 'ERR_WORKER_OUT_OF_MEMORY',
                }
              : { code }
            listener(exit)
          }),
        kill: () => void worker.terminate().catch(() => undefined),
      }
    },
  }
}
