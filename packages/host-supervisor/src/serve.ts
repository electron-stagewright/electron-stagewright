/**
 * Host side: answers the supervisor from a worker thread or a utility process. Never imports
 * Electron, so the same entry runs under Node.
 */

import { performance } from 'node:perf_hooks'
import { getHeapStatistics } from 'node:v8'
import { parentPort } from 'node:worker_threads'

import type { CallContext, CallOperation, Contract, Handlers, StreamOperation } from './contract.js'
import {
  PROTOCOL_VERSION,
  parseSupervisorMessage,
  serializeError,
  type HostMessage,
  type SerializedError,
} from './protocol.js'

/** The host's end of the channel. */
export interface HostPort {
  post(message: HostMessage): void
  onMessage(listener: (message: unknown) => void): void
  /** Lets the thread or process end once the host has stopped. */
  close(): void
}

export interface ServeOptions<Ops extends Contract<Ops>, Payload = undefined> {
  readonly operations: readonly CallOperation<Ops>[]
  readonly streams?: readonly StreamOperation<Ops>[]
  /** Opens whatever the host serves; called once, with the supervisor's start payload. */
  readonly start: (payload: Payload) => Handlers<Ops> | Promise<Handlers<Ops>>
  /** Runs after every accepted call has answered. */
  readonly stop?: () => void | Promise<void>
  /** Defaults to the utility process's parent port, else the worker thread's. */
  readonly port?: HostPort
  /** Sends process memory and event-loop figures this often, from the start. */
  readonly statsIntervalMs?: number
  /** Tells the supervisor the cause of an uncaught exception before the host ends. Default true. */
  readonly reportCrashes?: boolean
}

interface ElectronParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
}

/** The port this host was started with, or null outside a worker or utility process. */
export function defaultHostPort(): HostPort | null {
  const electronPort = (process as { parentPort?: ElectronParentPort }).parentPort
  if (electronPort) {
    return {
      post: (message) => electronPort.postMessage(message),
      onMessage: (listener) => void electronPort.on('message', (event) => listener(event.data)),
      // A utility process stays alive while its parent port listens.
      close: () => setImmediate(() => process.exit(0)),
    }
  }
  const port = parentPort
  if (port) {
    return {
      post: (message) => port.postMessage(message),
      onMessage: (listener) => void port.on('message', listener),
      close: () => port.close(),
    }
  }
  return null
}

const toMb = (bytes: number) => Math.round((bytes / 1_048_576) * 10) / 10

function rejected(message: string, code: string): SerializedError {
  return { name: 'HostError', message, code }
}

interface OpenStream {
  readonly iterator: AsyncIterator<unknown> | Iterator<unknown>
  readonly controller: AbortController
}

/** Serves one host until the supervisor sends `stop`. */
export function serveHost<Ops extends Contract<Ops>, Payload = undefined>(
  options: ServeOptions<Ops, Payload>,
): void {
  const found = options.port ?? defaultHostPort()
  if (!found) throw new Error('serveHost must run in a worker thread or a utility process')
  const port: HostPort = found
  const callOps: ReadonlySet<string> = new Set(options.operations)
  const streamOps: ReadonlySet<string> = new Set(options.streams ?? [])

  let handlers: Record<string, (...args: unknown[]) => unknown> | null = null
  let starting: Promise<void> | null = null
  let accepting = true
  let statsTimer: ReturnType<typeof setInterval> | null = null
  const inflight = new Set<Promise<void>>()
  const controllers = new Map<number, AbortController>()
  const streams = new Map<number, OpenStream>()

  const post = (message: HostMessage) => port.post(message)

  function track(work: Promise<void>): void {
    inflight.add(work)
    void work.finally(() => inflight.delete(work))
  }

  /** A value that cannot be cloned still answers its call. */
  function answer(id: number, message: HostMessage): void {
    try {
      post(message)
    } catch (error) {
      post({ type: 'result', id, ok: false, error: serializeError(error) })
    }
  }

  let lastElu = performance.eventLoopUtilization()
  const heapLimitMb = toMb(getHeapStatistics().heap_size_limit)
  function postStats(): void {
    const memory = process.memoryUsage()
    const elu = performance.eventLoopUtilization(lastElu)
    lastElu = performance.eventLoopUtilization()
    post({
      type: 'stats',
      stats: {
        rssMb: toMb(memory.rss),
        heapUsedMb: toMb(memory.heapUsed),
        heapLimitMb,
        externalMb: toMb(memory.external + memory.arrayBuffers),
        eventLoopUtilization: Math.round(elu.utilization * 1000) / 1000,
      },
    })
  }

  async function start(version: number, payload: unknown): Promise<void> {
    try {
      if (version !== PROTOCOL_VERSION) {
        throw new Error(`The host speaks protocol ${PROTOCOL_VERSION}, not ${version}`)
      }
      const served = (await options.start(payload as Payload)) as unknown as Record<string, unknown>
      for (const op of [...callOps, ...streamOps]) {
        if (typeof served[op] !== 'function') throw new Error(`No handler for ${op}`)
      }
      handlers = served as Record<string, (...args: unknown[]) => unknown>
      post({ type: 'started' })
      if (options.statsIntervalMs !== undefined) {
        postStats()
        statsTimer = setInterval(postStats, options.statsIntervalMs)
        statsTimer.unref()
      }
    } catch (error) {
      post({ type: 'start-failed', error: serializeError(error) })
    }
  }

  function call(id: number, op: string, args: readonly unknown[], stream: boolean): void {
    const served = handlers
    if (!served || !accepting) {
      post({
        type: 'result',
        id,
        ok: false,
        error: rejected('The host is not serving', 'HOST_STOPPED'),
      })
      return
    }
    if (!(stream ? streamOps : callOps).has(op)) {
      post({
        type: 'result',
        id,
        ok: false,
        error: rejected(`${op} is not an operation of this host`, 'HOST_OPERATION_REJECTED'),
      })
      return
    }
    const controller = new AbortController()
    const context: CallContext = { signal: controller.signal }
    const handler = served[op] as (...args: unknown[]) => unknown
    if (stream) {
      try {
        const iterable = handler.apply(served, [...args, context]) as
          AsyncIterable<unknown> | Iterable<unknown>
        const iterator =
          Symbol.asyncIterator in iterable
            ? iterable[Symbol.asyncIterator]()
            : (iterable as Iterable<unknown>)[Symbol.iterator]()
        streams.set(id, { iterator, controller })
      } catch (error) {
        post({ type: 'result', id, ok: false, error: serializeError(error) })
      }
      return
    }
    controllers.set(id, controller)
    track(
      Promise.resolve()
        .then(() => handler.apply(served, [...args, context]))
        .then(
          (value) => answer(id, { type: 'result', id, ok: true, value }),
          (error: unknown) => post({ type: 'result', id, ok: false, error: serializeError(error) }),
        )
        .finally(() => controllers.delete(id)),
    )
  }

  function next(id: number): void {
    const open = streams.get(id)
    if (!open) {
      post({
        type: 'result',
        id,
        ok: false,
        error: rejected('The stream is not open', 'HOST_STOPPED'),
      })
      return
    }
    track(
      Promise.resolve()
        .then(() => open.iterator.next())
        .then(
          (result) => {
            if (result.done) {
              streams.delete(id)
              post({ type: 'item', id, done: true })
            } else {
              answer(id, { type: 'item', id, done: false, value: result.value })
            }
          },
          (error: unknown) => {
            streams.delete(id)
            post({ type: 'result', id, ok: false, error: serializeError(error) })
          },
        ),
    )
  }

  function cancel(id: number): void {
    controllers.get(id)?.abort()
    const open = streams.get(id)
    if (!open) return
    streams.delete(id)
    open.controller.abort()
    track(
      Promise.resolve()
        .then(() => open.iterator.return?.())
        .then(
          () => undefined,
          () => undefined,
        ),
    )
  }

  async function stop(): Promise<void> {
    // Close admission before yielding, so a later message cannot reach a closing resource.
    accepting = false
    let failure: unknown = null
    try {
      await starting
      for (const id of [...streams.keys()]) cancel(id)
      while (inflight.size > 0) await Promise.allSettled([...inflight])
      await options.stop?.()
    } catch (error) {
      failure = error
    }
    handlers = null
    if (statsTimer) clearInterval(statsTimer)
    post(failure ? { type: 'stopped', error: serializeError(failure) } : { type: 'stopped' })
    port.close()
  }

  if (options.reportCrashes !== false) {
    process.on('uncaughtExceptionMonitor', (error) => {
      try {
        post({ type: 'crashed', error: serializeError(error) })
      } catch {
        // The host is ending either way.
      }
    })
  }

  let stopped = false
  port.onMessage((raw) => {
    const message = parseSupervisorMessage(raw)
    if (!message) return
    switch (message.type) {
      case 'start':
        starting ??= start(message.version, message.payload)
        return
      case 'call':
        call(message.id, message.op, message.args, message.stream === true)
        return
      case 'next':
        next(message.id)
        return
      case 'cancel':
        cancel(message.id)
        return
      case 'stop':
        if (stopped) return
        stopped = true
        void stop()
        return
    }
  })
}
