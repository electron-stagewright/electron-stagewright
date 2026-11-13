import type { SupervisorMessage } from './protocol.js'

/** What a handler receives after the caller's arguments. */
export interface CallContext {
  /** Aborted when the caller aborts, the call times out, or the stream is closed early. */
  readonly signal: AbortSignal
}

type FixedArity<A extends readonly unknown[]> = number extends A['length']
  ? false
  : A extends Required<A>
    ? true
    : false

/**
 * Every member is an operation that returns a promise or an async iterable. Parameters are fixed:
 * the handler's context follows the caller's arguments, so optional and rest parameters would
 * shift it. Declare an optional value as `T | undefined` instead.
 */
export type Contract<Ops> = {
  [K in keyof Ops]: Ops[K] extends (...args: infer A) => infer R
    ? FixedArity<A> extends true
      ? R extends Promise<unknown> | AsyncIterable<unknown>
        ? Ops[K]
        : (...args: never[]) => Promise<unknown> | AsyncIterable<unknown>
      : (...args: never[]) => 'optional and rest parameters are not supported'
    : never
}

export type ArgsOf<F> = F extends (...args: infer A) => unknown ? A : never

/** Operations that answer once. */
export type CallOperation<Ops> = {
  [K in keyof Ops]: Ops[K] extends (...args: never[]) => Promise<unknown> ? K : never
}[keyof Ops] &
  string

/** Operations that answer with a stream, pulled one item at a time. */
export type StreamOperation<Ops> = {
  [K in keyof Ops]: Ops[K] extends (...args: never[]) => AsyncIterable<unknown> ? K : never
}[keyof Ops] &
  string

/** The host-side implementation of a contract: same arguments, plus the call context. */
export type Handlers<Ops> = {
  [K in keyof Ops]: Ops[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: [...A, CallContext]) => R | Promise<R>
    : Ops[K] extends (...args: infer A) => AsyncIterable<infer T>
      ? (...args: [...A, CallContext]) => AsyncIterable<T> | Iterable<T>
      : never
}

/** How a channel ended, as the transport saw it. */
export interface ChannelExit {
  readonly code: number | null
  readonly error?: Error
  /** The runtime ended the host for exceeding its memory limit. */
  readonly outOfMemory?: boolean
}

/** One running host, as seen from the supervisor. */
export interface HostChannel {
  send(message: SupervisorMessage): void
  onMessage(listener: (message: unknown) => void): void
  /** Called once, when the thread or process has exited. */
  onExit(listener: (exit: ChannelExit) => void): void
  /** Ends the host without waiting for it; `onExit` still fires. */
  kill(): void
}

/** Starts hosts. A worker thread, a utility process, or anything that speaks the protocol. */
export interface HostTransport {
  launch(): HostChannel
}
