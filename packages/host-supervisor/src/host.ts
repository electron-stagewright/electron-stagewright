/**
 * Supervisor side: starts the host on demand, matches answers to calls, and decides what happens
 * when the host exits on its own.
 */

import type {
  ArgsOf,
  CallOperation,
  ChannelExit,
  Contract,
  HostChannel,
  HostTransport,
  StreamOperation,
} from './contract.js'
import { HOST_ERROR_CODES, HostError, type HostErrorCode } from './errors.js'
import {
  PROTOCOL_VERSION,
  deserializeError,
  parseHostMessage,
  type HostStats,
  type SerializedError,
} from './protocol.js'

export const DEFAULT_STOP_GRACE_MS = 10_000
export const DEFAULT_RETIRE_WAIT_MS = 5_000

export type HostState =
  'idle' | 'starting' | 'running' | 'restarting' | 'stopping' | 'paused' | 'fatal' | 'closed'

/**
 * Why a host ended:
 * - `out-of-memory`: the runtime ended it at its heap limit (worker threads only).
 * - `uncaught`: the host reported an uncaught exception, which is `error`.
 * - `runtime-fatal`: the runtime hit an error it cannot continue from (utility process).
 * - `exit`: it ended without reporting a cause: `process.exit`, a native crash, a signal.
 * - `start-failed`: a restart whose start failed.
 */
export type HostExitReason =
  'out-of-memory' | 'uncaught' | 'runtime-fatal' | 'exit' | 'start-failed'

/** What the supervisor knows about a host that exited without being asked to. */
export interface HostExit {
  /** `start-failed` is a restart whose start failed; the first start rejects its callers instead. */
  readonly kind: 'crash' | 'out-of-memory' | 'start-failed'
  readonly reason: HostExitReason
  /** Always an `Error`: the host's own when it reported one, else one describing the exit. */
  readonly error: Error
  readonly code: number | null
  /** Milliseconds between `started` and the exit; null when the host never started. */
  readonly uptimeMs: number | null
  /** Calls the exit rejected with `HOST_EXITED`. */
  readonly pendingCalls: number
  readonly lastStats: HostStats | null
}

/**
 * - `fatal`: refuse every call from now on.
 * - `on-demand`: start a new host on the next call.
 * - `restart`: start a new host now, after `delayMs`.
 */
export type ExitDecision =
  'fatal' | 'on-demand' | 'restart' | { readonly action: 'restart'; readonly delayMs: number }

export interface CallOptions {
  readonly signal?: AbortSignal
  /** Overrides `limits.callTimeoutMs`; for a stream it bounds each item. */
  readonly timeoutMs?: number
  /** Overrides `limits.abortGraceMs`. */
  readonly abortGraceMs?: number
}

export interface PauseOptions {
  /** What a call does while paused: wait for `resume()` (default) or fail with `HOST_PAUSED`. */
  readonly calls?: 'wait' | 'reject'
}

/** A host answered `start`. */
export interface HostStartedEvent<Info = undefined> {
  readonly info: Info | undefined
  /** Hosts started so far by this supervisor, this one included. */
  readonly launches: number
  /** Set when this host replaces one that exited on its own. */
  readonly restart: {
    /** The exit that started the recovery. */
    readonly exit: HostExit
    /** 1 for the first try after that exit, 2 after one failed restart, and so on. */
    readonly attempt: number
  } | null
}

export interface HostOptions<Ops extends Contract<Ops>, Payload = undefined, Info = undefined> {
  /** The closed list of operations that answer once. */
  readonly operations: readonly CallOperation<Ops>[]
  /** The closed list of operations that answer with a stream. */
  readonly streams?: readonly StreamOperation<Ops>[]
  readonly transport: HostTransport
  readonly start?: {
    /** Sent with `start` on every launch. Keeps secrets out of env and argv. */
    readonly payload?: () => Payload | Promise<Payload>
    readonly timeoutMs?: number
  }
  readonly stop?: {
    /** How long `stop()` lets the host drain and close before terminating it. */
    readonly graceMs?: number
    /** How long a terminated host may take to exit before the next one starts anyway. */
    readonly retireWaitMs?: number
  }
  readonly limits?: {
    /** Calls and open streams allowed at once; one more fails with `HOST_QUEUE_FULL`. */
    readonly maxPending?: number
    readonly callTimeoutMs?: number
    /**
     * After an abort, wait this long for the host to settle the call: it settles with the host's
     * own answer, or fails with `HOST_ABORT_UNSETTLED`. Unset, an abort fails the call at once.
     */
    readonly abortGraceMs?: number
  }
  /** Decides what follows an exit nobody asked for. Defaults to `fatal`. */
  readonly onExit?: (exit: HostExit) => ExitDecision | Promise<ExitDecision>
  readonly onStats?: (stats: HostStats) => void
  /** Every successful start, restarts included. A throw or rejection becomes a process warning. */
  readonly onStarted?: (event: HostStartedEvent<Info>) => void | Promise<void>
  readonly errors?: {
    /** Rebuilds an application error, such as the app's own class; `undefined` keeps the default. */
    readonly revive?: (serialized: SerializedError) => Error | undefined
  }
  readonly now?: () => number
}

export interface Host<Ops extends Contract<Ops>, Info = undefined> {
  /** One method per operation, with the contract's own signature. */
  readonly ops: Ops
  call<K extends CallOperation<Ops>>(
    op: K,
    args: ArgsOf<Ops[K]>,
    options?: CallOptions,
  ): ReturnType<Ops[K]>
  stream<K extends StreamOperation<Ops>>(
    op: K,
    args: ArgsOf<Ops[K]>,
    options?: CallOptions,
  ): ReturnType<Ops[K]>
  /** Starts the host now instead of on the first call, and resolves with its `info`. */
  start(): Promise<Info | undefined>
  /** Drains and stops the host. The next call starts a new one. */
  stop(): Promise<void>
  /** Terminates the host without draining, and waits (bounded) for it to exit. Never throws. */
  kill(): Promise<void>
  /** Stops the host and refuses every later call. */
  close(): Promise<void>
  /**
   * Stops the host like `stop()` and starts none until `resume()`, so its files can be swapped.
   * Rejects as `stop()` does, but stays paused either way.
   */
  pause(options?: PauseOptions): Promise<void>
  /** Lets hosts start again; calls that waited start one. */
  resume(): void
  readonly state: HostState
  /** What the running host passed to `setInfo`; `undefined` while no host is running. */
  readonly info: Info | undefined
}

interface Life {
  readonly channel: HostChannel
  started: boolean
  startedAt: number
  exited: boolean
  exit: ChannelExit | null
  readonly exitPromise: Promise<void>
  crashError: Error | null
  stoppedReceived: boolean
  readonly stoppedPromise: Promise<void>
  resolveStopped: () => void
  stopError: Error | null
  lastStats: HostStats | null
  info: unknown
  onStartReply: ((error: Error | null) => void) | null
}

interface Waiter {
  resolve(value: unknown): void
  reject(error: Error): void
}

interface Entry {
  readonly id: number
  readonly stream: boolean
  readonly timeoutMs: number | undefined
  readonly graceMs: number | undefined
  life: Life | null
  done: boolean
  /** Kept for a stream that failed between items, so the next pull reports it. */
  error: Error | null
  waiter: Waiter | null
  timer: ReturnType<typeof setTimeout> | null
  detachAbort: (() => void) | null
}

/** Rejection that sends a waiting call back to `ensureStarted`. */
const RETRY = Symbol('retry')

function unref(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  ;(timer as { unref?: () => void }).unref?.()
  return timer
}

function raceTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = unref(setTimeout(() => resolve(false), ms))
    }),
  ]).finally(() => clearTimeout(timer))
}

const HOST_CODES: ReadonlySet<string> = new Set(HOST_ERROR_CODES)

function supervisorError(serialized: SerializedError): HostError | null {
  if (serialized.name === 'HostError' && serialized.code && HOST_CODES.has(serialized.code)) {
    return new HostError(serialized.code as HostErrorCode, serialized.message)
  }
  return null
}

function warn(error: unknown): void {
  process.emitWarning(error instanceof Error ? error : new Error(String(error)))
}

/** Runs a listener outside the transport's callback, so a throw cannot escape as uncaught. */
function notify<T>(listener: ((value: T) => unknown) | undefined, value: T): void {
  if (!listener) return
  Promise.resolve()
    .then(() => listener(value))
    .catch(warn)
}

function normalizeDecision(decision: ExitDecision): {
  action: 'fatal' | 'on-demand' | 'restart'
  delayMs: number
} {
  if (decision === 'fatal' || decision === 'on-demand' || decision === 'restart') {
    return { action: decision, delayMs: 0 }
  }
  if (typeof decision === 'object' && decision !== null && decision.action === 'restart') {
    const delayMs = Number.isFinite(decision.delayMs) ? Math.max(0, decision.delayMs) : 0
    return { action: 'restart', delayMs }
  }
  // Anything else is a policy bug; refusing to restart is the safe reading.
  return { action: 'fatal', delayMs: 0 }
}

const MAX_TIMER_MS = 2_147_483_647

function checkGraceMs(value: number | undefined): number | undefined {
  if (value === undefined || (Number.isFinite(value) && value >= 0 && value <= MAX_TIMER_MS)) {
    return value
  }
  throw new RangeError(`abortGraceMs must be between 0 and ${MAX_TIMER_MS} ms, not ${value}`)
}

export function createHost<Ops extends Contract<Ops>, Payload = undefined, Info = undefined>(
  options: HostOptions<Ops, Payload, Info>,
): Host<Ops, Info> {
  const callOps: ReadonlySet<string> = new Set(options.operations)
  const streamOps: ReadonlySet<string> = new Set(options.streams ?? [])
  const graceMs = options.stop?.graceMs ?? DEFAULT_STOP_GRACE_MS
  const retireWaitMs = options.stop?.retireWaitMs ?? DEFAULT_RETIRE_WAIT_MS
  const maxPending = options.limits?.maxPending ?? Number.POSITIVE_INFINITY
  const defaultTimeoutMs = options.limits?.callTimeoutMs
  const defaultGraceMs = checkGraceMs(options.limits?.abortGraceMs)
  const onExit = options.onExit ?? (() => 'fatal' as const)
  const now = options.now ?? Date.now

  let state: HostState = 'idle'
  let current: Life | null = null
  let starting: Promise<Life> | null = null
  /** The host waiting for its `started` reply, so stop and kill can fail a start that hangs. */
  let booting: Life | null = null
  let retiring: Promise<void> | null = null
  let stopping: Promise<void> | null = null
  let fatalCause: Error | null = null
  let closeRequested = false
  let wakeDelay: (() => void) | null = null
  let nextId = 1
  let launches = 0
  /** The exit an `on-demand` decision left unanswered, reported with the next start. */
  let pendingRestart: HostStartedEvent['restart'] = null
  /** A restart a pause interrupted, launched again by `resume()`. */
  let restartHeld = false
  let paused: Required<PauseOptions> | null = null
  let resumeGate: { promise: Promise<void>; resolve: () => void } | null = null
  const pending = new Map<number, Entry>()

  /** Calls wait for `resume()` from a pause until the hosts it held may start again. */
  const holding = () => !closeRequested && resumeGate !== null && paused?.calls !== 'reject'

  function pausedError(): HostError {
    return new HostError('HOST_PAUSED', 'The host is paused')
  }

  function started(life: Life, restart: HostStartedEvent['restart']): void {
    launches++
    notify(options.onStarted, { info: life.info as Info | undefined, launches, restart })
  }

  function remoteError(serialized: SerializedError): Error {
    const own = supervisorError(serialized)
    if (own) return own
    let revived: Error | undefined
    try {
      revived = options.errors?.revive?.(serialized)
    } catch {
      // A reviver that throws falls back to the plain rebuild.
    }
    return revived instanceof Error ? revived : deserializeError(serialized)
  }

  function unavailable(): HostError {
    if (state === 'fatal') {
      return new HostError('HOST_FATAL', 'The host exited and will not be restarted', {
        cause: fatalCause,
      })
    }
    return new HostError('HOST_STOPPED', 'The host is stopped')
  }

  /** A restart backoff that stop and kill can cut short. */
  function restartDelay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        wakeDelay = null
        resolve()
      }
      const timer = unref(setTimeout(done, ms))
      wakeDelay = done
    })
  }

  // ---- calls ----

  function finish(entry: Entry, error: Error | null, cancel: boolean): void {
    if (entry.done) return
    entry.done = true
    pending.delete(entry.id)
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    entry.detachAbort?.()
    entry.detachAbort = null
    const life = entry.life
    if (cancel && life && !life.exited) {
      try {
        life.channel.send({ type: 'cancel', id: entry.id })
      } catch {
        // The host is going away; its exit settles the rest.
      }
    }
    const waiter = entry.waiter
    entry.waiter = null
    if (!error) {
      // Only a stream reaches here with a waiter: closed early while a pull was pending.
      waiter?.resolve({ done: true, value: undefined })
      return
    }
    if (waiter) waiter.reject(error)
    else entry.error = error
  }

  /** Forwards the abort and keeps the call open for the host's own answer, within the grace. */
  function settleAfterAbort(entry: Entry, life: Life, graceMs: number, reason: unknown): void {
    entry.detachAbort?.()
    entry.detachAbort = null
    if (entry.timer) clearTimeout(entry.timer)
    try {
      life.channel.send({ type: 'cancel', id: entry.id })
    } catch {
      // The host is going away; its exit settles the call.
    }
    entry.timer = unref(
      setTimeout(() => {
        finish(
          entry,
          new HostError(
            'HOST_ABORT_UNSETTLED',
            `The host did not settle the aborted call within ${graceMs} ms`,
            { cause: reason },
          ),
          false,
        )
      }, graceMs),
    )
  }

  function armTimer(entry: Entry): void {
    if (entry.timeoutMs === undefined || entry.timer) return
    entry.timer = unref(
      setTimeout(() => {
        finish(
          entry,
          new HostError('HOST_CALL_TIMEOUT', `The host did not answer in ${entry.timeoutMs} ms`),
          true,
        )
      }, entry.timeoutMs),
    )
  }

  function admit(stream: boolean, callOptions: CallOptions | undefined): Entry {
    if (state === 'fatal' || state === 'closed') throw unavailable()
    if (paused?.calls === 'reject') throw pausedError()
    if (state === 'stopping' && !holding()) throw unavailable()
    if (pending.size >= maxPending) {
      throw new HostError('HOST_QUEUE_FULL', `More than ${maxPending} calls are pending`)
    }
    const signal = callOptions?.signal
    if (signal?.aborted) {
      throw new HostError('HOST_CALL_ABORTED', 'The call was aborted', { cause: signal.reason })
    }
    const entry: Entry = {
      id: nextId++,
      stream,
      timeoutMs: callOptions?.timeoutMs ?? defaultTimeoutMs,
      graceMs: checkGraceMs(callOptions?.abortGraceMs ?? defaultGraceMs),
      life: null,
      done: false,
      error: null,
      waiter: null,
      timer: null,
      detachAbort: null,
    }
    if (signal) {
      const onAbort = () => {
        const life = entry.life
        if (entry.stream || entry.graceMs === undefined || !life || life.exited) {
          finish(
            entry,
            new HostError('HOST_CALL_ABORTED', 'The call was aborted', { cause: signal.reason }),
            true,
          )
          return
        }
        settleAfterAbort(entry, life, entry.graceMs, signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      entry.detachAbort = () => signal.removeEventListener('abort', onAbort)
    }
    pending.set(entry.id, entry)
    return entry
  }

  /** Sends the call once a host is running, starting one if needed. */
  function dispatch(entry: Entry, message: { op: string; args: readonly unknown[] }): void {
    let ready: Promise<Life>
    try {
      ready = ensureStarted()
    } catch (error) {
      finish(entry, error as Error, false)
      return
    }
    ready.then(
      (life) => {
        if (entry.done) return
        if (life.exited || life !== current || resumeGate) return dispatch(entry, message)
        entry.life = life
        try {
          life.channel.send({
            type: 'call',
            id: entry.id,
            op: message.op,
            args: message.args,
            ...(entry.stream ? { stream: true as const } : {}),
          })
          if (entry.stream) pull(entry)
        } catch (error) {
          finish(entry, error as Error, false)
        }
      },
      (error: unknown) => {
        if (entry.done) return
        // While paused a call waits for `resume()`, whatever ended the start it was waiting on.
        if (error === RETRY || holding()) return dispatch(entry, message)
        finish(entry, error as Error, false)
      },
    )
  }

  function pull(entry: Entry): void {
    const life = entry.life
    if (!life || entry.done || !entry.waiter) return
    armTimer(entry)
    try {
      life.channel.send({ type: 'next', id: entry.id })
    } catch (error) {
      finish(entry, error as Error, false)
    }
  }

  function call(op: string, args: readonly unknown[], callOptions?: CallOptions): Promise<unknown> {
    if (!callOps.has(op)) {
      return Promise.reject(
        new HostError('HOST_OPERATION_REJECTED', `${op} is not a call operation of this host`),
      )
    }
    let entry: Entry
    try {
      entry = admit(false, callOptions)
    } catch (error) {
      return Promise.reject(error)
    }
    return new Promise((resolve, reject) => {
      entry.waiter = { resolve, reject }
      armTimer(entry)
      dispatch(entry, { op, args })
    })
  }

  function stream(
    op: string,
    args: readonly unknown[],
    callOptions?: CallOptions,
  ): AsyncIterableIterator<unknown> {
    let entry: Entry | null = null
    let ended = false
    let busy = false
    const done = (): IteratorResult<unknown> => ({ done: true, value: undefined })
    const iterator: AsyncIterableIterator<unknown> = {
      [Symbol.asyncIterator]: () => iterator,
      next() {
        if (ended) return Promise.resolve(done())
        if (busy) {
          return Promise.reject(new Error('Wait for the previous item before asking for the next'))
        }
        if (!streamOps.has(op)) {
          ended = true
          return Promise.reject(
            new HostError(
              'HOST_OPERATION_REJECTED',
              `${op} is not a stream operation of this host`,
            ),
          )
        }
        busy = true
        return new Promise<IteratorResult<unknown>>((resolve, reject) => {
          const waiter: Waiter = {
            resolve: (value) => {
              busy = false
              const result = value as IteratorResult<unknown>
              if (result.done) ended = true
              resolve(result)
            },
            reject: (error) => {
              busy = false
              ended = true
              reject(error)
            },
          }
          if (entry === null) {
            try {
              entry = admit(true, callOptions)
            } catch (error) {
              waiter.reject(error as Error)
              return
            }
            entry.waiter = waiter
            // The first item's timeout also bounds the wait for a host to start.
            armTimer(entry)
            dispatch(entry, { op, args })
            return
          }
          if (entry.done) {
            if (entry.error) waiter.reject(entry.error)
            else waiter.resolve(done())
            return
          }
          entry.waiter = waiter
          pull(entry)
        })
      },
      return() {
        ended = true
        if (entry && !entry.done) finish(entry, null, true)
        return Promise.resolve(done())
      },
    }
    return iterator
  }

  // ---- host lifecycle ----

  function onHostMessage(life: Life, raw: unknown): void {
    const message = parseHostMessage(raw)
    if (!message) return
    // A host that keeps talking survived the exception it reported.
    if (message.type !== 'crashed') life.crashError = null
    switch (message.type) {
      case 'started':
        life.info = message.info
        life.started = true
        life.startedAt = now()
        life.onStartReply?.(null)
        return
      case 'start-failed':
        life.onStartReply?.(remoteError(message.error))
        return
      case 'crashed':
        life.crashError = remoteError(message.error)
        return
      case 'stats':
        life.lastStats = message.stats
        notify(options.onStats, message.stats)
        return
      case 'stopped':
        life.stoppedReceived = true
        if (message.error) life.stopError = remoteError(message.error)
        life.resolveStopped()
        return
      case 'result': {
        const entry = pending.get(message.id)
        if (!entry || entry.life !== life) return
        if (!message.ok) {
          finish(entry, remoteError(message.error), false)
          return
        }
        if (entry.stream) return
        const waiter = entry.waiter
        entry.waiter = null
        finish(entry, null, false)
        waiter?.resolve(message.value)
        return
      }
      case 'item': {
        const entry = pending.get(message.id)
        if (!entry || entry.life !== life || !entry.stream || !entry.waiter) return
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = null
        const waiter = entry.waiter
        entry.waiter = null
        if (message.done) finish(entry, null, false)
        waiter.resolve({ done: message.done, value: message.done ? undefined : message.value })
        return
      }
    }
  }

  function exitError(life: Life): Error {
    return (
      life.crashError ??
      life.exit?.error ??
      new Error(`The host exited with code ${String(life.exit?.code ?? null)}`)
    )
  }

  function onHostExit(life: Life, exit: ChannelExit): void {
    life.exited = true
    life.exit = exit
    life.onStartReply?.(exitError(life))
    const stoppingNow = state === 'stopping' || state === 'closed'
    const cause = exitError(life)
    let rejected = 0
    for (const entry of [...pending.values()]) {
      if (entry.life !== life) continue
      rejected++
      finish(
        entry,
        stoppingNow
          ? new HostError('HOST_STOPPED', 'The host stopped before answering')
          : new HostError('HOST_EXITED', 'The host exited before answering', { cause }),
        false,
      )
    }
    if (life !== current || state !== 'running') return
    current = null
    state = 'restarting'
    const recovery = recover({
      kind: exit.outOfMemory ? 'out-of-memory' : 'crash',
      reason: exitReason(life, exit),
      error: cause,
      code: exit.code,
      uptimeMs: Math.max(0, now() - life.startedAt),
      pendingCalls: rejected,
      lastStats: life.lastStats,
    })
    starting = recovery
    // Registered before any waiter, so a call sent back by RETRY never sees a stale promise.
    recovery.then(
      () => undefined,
      () => {
        if (starting === recovery) starting = null
      },
    )
  }

  function exitReason(life: Life, exit: ChannelExit): HostExitReason {
    if (exit.outOfMemory) return 'out-of-memory'
    if (life.crashError) return 'uncaught'
    if (exit.runtimeFatal) return 'runtime-fatal'
    // The worker transport passes the thread's uncaught error as `exit.error`.
    return exit.error ? 'uncaught' : 'exit'
  }

  async function launch(): Promise<Life> {
    if (retiring) await retiring
    let payload: Payload | undefined
    try {
      payload = await options.start?.payload?.()
    } catch (error) {
      throw new HostError('HOST_START_FAILED', 'The start payload could not be built', {
        cause: error,
      })
    }
    let channel: HostChannel
    try {
      channel = options.transport.launch()
    } catch (error) {
      throw new HostError('HOST_START_FAILED', 'The host could not be launched', { cause: error })
    }
    let resolveExit!: () => void
    let resolveStopped!: () => void
    const life: Life = {
      channel,
      started: false,
      startedAt: now(),
      exited: false,
      exit: null,
      exitPromise: new Promise<void>((resolve) => (resolveExit = resolve)),
      crashError: null,
      stoppedReceived: false,
      stoppedPromise: new Promise<void>((resolve) => (resolveStopped = resolve)),
      resolveStopped: () => resolveStopped(),
      stopError: null,
      lastStats: null,
      info: undefined,
      onStartReply: null,
    }
    channel.onMessage((message) => onHostMessage(life, message))
    channel.onExit((exit) => {
      if (life.exited) return
      onHostExit(life, exit)
      resolveExit()
    })
    const reply = new Promise<void>((resolve, reject) => {
      life.onStartReply = (error) => (error ? reject(error) : resolve())
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const startTimeoutMs = options.start?.timeoutMs
    booting = life
    try {
      channel.send({ type: 'start', version: PROTOCOL_VERSION, payload })
      await (startTimeoutMs === undefined
        ? reply
        : Promise.race([
            reply,
            new Promise<never>((_, reject) => {
              timer = unref(
                setTimeout(
                  () => reject(new Error(`The host did not start in ${startTimeoutMs} ms`)),
                  startTimeoutMs,
                ),
              )
            }),
          ]))
      if (life.exited) throw exitError(life)
    } catch (error) {
      await retire(life)
      throw new HostError('HOST_START_FAILED', 'The host failed to start', { cause: error })
    } finally {
      clearTimeout(timer)
      life.onStartReply = null
      if (booting === life) booting = null
    }
    return life
  }

  function abortStart(): void {
    booting?.onStartReply?.(new HostError('HOST_STOPPED', 'The host was stopped while starting'))
  }

  /** Terminates a host and remembers its exit, so the next launch waits for it (bounded). */
  function retire(life: Life): Promise<void> {
    if (life.exited) return Promise.resolve()
    try {
      life.channel.kill()
    } catch {
      // Already gone; the exit event follows.
    }
    const waiting = Promise.all([retiring, raceTimeout(life.exitPromise, retireWaitMs)]).then(
      () => {
        if (retiring === waiting) retiring = null
      },
    )
    retiring = waiting
    return waiting
  }

  function ensureStarted(): Promise<Life> {
    if (state === 'fatal' || state === 'closed') throw unavailable()
    if (paused?.calls === 'reject') throw pausedError()
    if (resumeGate) {
      return resumeGate.promise.then(() => {
        throw RETRY
      })
    }
    if (state === 'stopping') throw unavailable()
    if (starting) return starting
    if (current && !current.exited) return Promise.resolve(current)
    state = 'starting'
    const launching = launch()
      .then((life) => {
        if (life.exited) {
          throw new HostError('HOST_START_FAILED', 'The host exited right after starting', {
            cause: exitError(life),
          })
        }
        return life
      })
      .then(
        (life) => {
          current = life
          if (starting === launching) starting = null
          if (state === 'starting') state = 'running'
          const restart = pendingRestart
          pendingRestart = null
          started(life, restart)
          return life
        },
        (error: unknown) => {
          if (starting === launching) starting = null
          if (state === 'starting') state = 'idle'
          if (pendingRestart) {
            pendingRestart = { exit: pendingRestart.exit, attempt: pendingRestart.attempt + 1 }
          }
          throw error
        },
      )
    starting = launching
    return launching
  }

  async function recover(exit: HostExit, origin: HostExit = exit, attempt = 1): Promise<Life> {
    let decision: ReturnType<typeof normalizeDecision>
    try {
      decision = normalizeDecision(await onExit(exit))
    } catch {
      decision = { action: 'fatal', delayMs: 0 }
    }
    if (state !== 'restarting') {
      if (decision.action === 'fatal') throw unavailable()
      throw interrupted(origin, attempt, decision.action === 'restart')
    }
    if (decision.action === 'fatal') {
      state = 'fatal'
      fatalCause = exit.error
      starting = null
      throw unavailable()
    }
    if (decision.action === 'on-demand') {
      state = 'idle'
      starting = null
      pendingRestart = { exit: origin, attempt }
      throw RETRY
    }
    if (decision.delayMs > 0) await restartDelay(decision.delayMs)
    if (state !== 'restarting') throw interrupted(origin, attempt, true)
    let life: Life
    try {
      life = await launch()
      if (life.exited) throw new Error('The host exited right after starting')
    } catch (error) {
      if (state !== 'restarting') throw interrupted(origin, attempt + 1, true)
      const cause = (error as { cause?: unknown }).cause
      return recover(
        {
          kind: 'start-failed',
          reason: 'start-failed',
          error: cause instanceof Error ? cause : (error as Error),
          code: null,
          uptimeMs: null,
          pendingCalls: 0,
          lastStats: null,
        },
        origin,
        attempt + 1,
      )
    }
    if (state !== 'restarting') {
      launches++
      // A stop drains the host it finds; a kill expects none left running.
      if (state === 'stopping') current = life
      else await retire(life)
      throw unavailable()
    }
    current = life
    state = 'running'
    starting = null
    started(life, { exit: origin, attempt })
    return life
  }

  /** A pause keeps the recovery it interrupted for `resume()`; a stop or kill drops it. */
  function interrupted(origin: HostExit, attempt: number, relaunch: boolean): HostError {
    if (paused) {
      pendingRestart = { exit: origin, attempt }
      restartHeld ||= relaunch
    }
    return unavailable()
  }

  async function stopHost(): Promise<void> {
    const before = state
    state = 'stopping'
    wakeDelay?.()
    for (const entry of [...pending.values()]) {
      if (!entry.life && holding()) continue
      // Waiting for a start, or a stream between items: nothing in flight to drain.
      if (!entry.life || (entry.stream && !entry.waiter)) {
        finish(entry, new HostError('HOST_STOPPED', 'The host is stopping'), entry.life !== null)
      }
    }
    let failure: Error | null = null
    if (starting) {
      const started = starting.then(
        () => undefined,
        () => undefined,
      )
      if (!(await raceTimeout(started, graceMs))) {
        abortStart()
        await started
        failure = new HostError(
          'HOST_STOP_TIMEOUT',
          `The host did not start within ${graceMs} ms and was terminated`,
        )
      }
      starting = null
    }
    const life = current
    if (life && !life.exited) {
      try {
        life.channel.send({ type: 'stop' })
      } catch {
        // Treated as a host that never confirmed its stop.
      }
      const answered = Promise.race([life.exitPromise, life.stoppedPromise])
      if (!(await raceTimeout(answered, graceMs))) {
        await retire(life)
        failure = new HostError(
          'HOST_STOP_TIMEOUT',
          `The host did not stop within ${graceMs} ms and was terminated`,
        )
      } else {
        // A host that confirmed its stop but lingers (a handle left open) is retired quietly.
        if (!(await raceTimeout(life.exitPromise, retireWaitMs))) await retire(life)
        if (!life.stoppedReceived) {
          failure = new HostError(
            'HOST_STOP_INCOMPLETE',
            'The host exited before finishing its stop',
          )
        } else if (life.stopError) {
          failure = new HostError('HOST_STOP_INCOMPLETE', 'The host failed while stopping', {
            cause: life.stopError,
          })
        }
      }
    }
    for (const entry of [...pending.values()]) {
      if (!entry.life && holding()) continue
      finish(entry, new HostError('HOST_STOPPED', 'The host stopped before answering'), false)
    }
    current = null
    state = closeRequested ? 'closed' : before === 'fatal' ? 'fatal' : paused ? 'paused' : 'idle'
    if (failure) throw failure
  }

  function shared(final: boolean): Promise<void> {
    if (final) closeRequested = true
    if (!paused || final) forgetRestart()
    if (state === 'closed') return Promise.resolve()
    if (stopping) {
      // A close joining a pause's stop still fails the calls waiting for `resume()`.
      if (final) failWaiting()
      return stopping
    }
    const run = stopHost().finally(() => {
      stopping = null
    })
    stopping = run
    if (final) failWaiting()
    return run
  }

  function failWaiting(): void {
    paused = null
    for (const entry of [...pending.values()]) {
      if (!entry.life) finish(entry, unavailable(), false)
    }
    releaseGate()
  }

  function forgetRestart(): void {
    pendingRestart = null
    restartHeld = false
  }

  function releaseGate(): void {
    const gate = resumeGate
    resumeGate = null
    gate?.resolve()
  }

  function pause(pauseOptions: PauseOptions = {}): Promise<void> {
    if (state === 'closed' || closeRequested) return stopping ?? Promise.resolve()
    paused = { calls: pauseOptions.calls ?? 'wait' }
    if (paused.calls === 'reject') {
      for (const entry of [...pending.values()]) {
        if (!entry.life) finish(entry, pausedError(), false)
      }
      // A start() waiting on the gate retries and meets HOST_PAUSED.
      releaseGate()
    }
    if (!resumeGate) {
      let resolve!: () => void
      const promise = new Promise<void>((done) => (resolve = done))
      resumeGate = { promise, resolve }
    }
    return shared(false)
  }

  function resume(): void {
    if (!paused) return
    paused = null
    // Calls waiting for a pause's stop start a host once that stop has finished.
    const ready = stopping ?? Promise.resolve()
    void ready.then(release, release)
    function release(): void {
      if (paused) return
      if (state === 'paused') state = 'idle'
      releaseGate()
      if (restartHeld) {
        restartHeld = false
        // A failed launch leaves the restart to the next call.
        Promise.resolve()
          .then(ensureStarted)
          .catch(() => undefined)
      }
    }
  }

  async function kill(): Promise<void> {
    if (state === 'closed') return
    forgetRestart()
    wakeDelay?.()
    abortStart()
    if (state === 'restarting') {
      // The pending restart sees the new state and gives up.
      state = 'idle'
      await starting?.catch(() => undefined)
      return
    }
    if (state === 'stopping') {
      // Cuts a stop's grace period short; the stop reports how it ended.
      if (current) await retire(current)
      await stopping?.catch(() => undefined)
      return
    }
    if (starting) await starting.catch(() => undefined)
    const life = current
    if (!life) return
    current = null
    if (state === 'running') state = 'idle'
    for (const entry of [...pending.values()]) {
      if (entry.life === life) {
        finish(entry, new HostError('HOST_STOPPED', 'The host was terminated'), false)
      }
    }
    // Calls made from here on wait for this exit before a new host starts.
    await retire(life)
  }

  const ops = new Proxy({} as Ops, {
    get(_target, property) {
      if (typeof property !== 'string') return undefined
      if (streamOps.has(property)) {
        return (...args: unknown[]) => stream(property, args)
      }
      if (callOps.has(property)) {
        return (...args: unknown[]) => call(property, args)
      }
      return undefined
    },
  })

  return {
    ops,
    call: ((op: string, args: readonly unknown[], callOptions?: CallOptions) =>
      call(op, args, callOptions)) as unknown as Host<Ops, Info>['call'],
    stream: ((op: string, args: readonly unknown[], callOptions?: CallOptions) =>
      stream(op, args, callOptions)) as unknown as Host<Ops, Info>['stream'],
    async start() {
      for (;;) {
        try {
          return (await ensureStarted()).info as Info | undefined
        } catch (error) {
          // An `on-demand` exit decision hands the start back to us.
          if (error !== RETRY) throw error
        }
      }
    },
    stop: () => shared(false),
    kill,
    close: () => shared(true),
    pause,
    resume,
    get state() {
      return state
    },
    get info() {
      return current && !current.exited ? (current.info as Info | undefined) : undefined
    },
  }
}
