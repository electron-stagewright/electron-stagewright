/**
 * Messages between the supervisor and the host. Plain data only: every message survives structured
 * clone, and both sides validate what they receive.
 */

/** Bumped when a message changes shape; a host that speaks another version refuses to start. */
export const PROTOCOL_VERSION = 1

/** An error as it crosses the boundary: no stack, no object graph. */
export interface SerializedError {
  readonly name: string
  readonly message: string
  readonly code?: string
}

export type SupervisorMessage =
  | { readonly type: 'start'; readonly version: number; readonly payload: unknown }
  | {
      readonly type: 'call'
      readonly id: number
      readonly op: string
      readonly args: readonly unknown[]
      readonly stream?: true
    }
  | { readonly type: 'next'; readonly id: number }
  | { readonly type: 'cancel'; readonly id: number }
  | { readonly type: 'stop' }

/** Process figures in MB, except event-loop utilization (0 to 1). */
export interface HostStats {
  readonly rssMb: number
  readonly heapUsedMb: number
  /** A worker's old-generation cap; V8's heap limit in a process. */
  readonly heapLimitMb: number
  readonly externalMb: number
  readonly eventLoopUtilization: number
}

export type HostMessage =
  | { readonly type: 'started' }
  | { readonly type: 'start-failed'; readonly error: SerializedError }
  | { readonly type: 'result'; readonly id: number; readonly ok: true; readonly value: unknown }
  | {
      readonly type: 'result'
      readonly id: number
      readonly ok: false
      readonly error: SerializedError
    }
  | { readonly type: 'item'; readonly id: number; readonly done: boolean; readonly value?: unknown }
  | { readonly type: 'stopped'; readonly error?: SerializedError }
  | { readonly type: 'crashed'; readonly error: SerializedError }
  | { readonly type: 'stats'; readonly stats: HostStats }

/** The only shape a code may take to cross the boundary. */
export const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,80}$/

/** Keeps the message and a well-formed code (own or from `cause`), and drops everything else. */
export function serializeError(error: unknown): SerializedError {
  const candidate = error as {
    name?: unknown
    message?: unknown
    code?: unknown
    cause?: { code?: unknown; errorCode?: unknown }
  } | null
  const code = [candidate?.code, candidate?.cause?.code, candidate?.cause?.errorCode].find(
    (value): value is string => typeof value === 'string' && CODE_PATTERN.test(value),
  )
  const message =
    typeof candidate?.message === 'string'
      ? candidate.message
      : candidate === null || typeof candidate !== 'object'
        ? String(error)
        : 'Error'
  return {
    name: typeof candidate?.name === 'string' ? candidate.name : 'Error',
    message,
    ...(code ? { code } : {}),
  }
}

/** Rebuilds an Error on the receiving side. */
export function deserializeError(serialized: SerializedError): Error {
  const error = new Error(serialized.message)
  error.name = serialized.name
  if (serialized.code) Object.assign(error, { code: serialized.code })
  return error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function isSerializedError(value: unknown): value is SerializedError {
  return (
    isRecord(value) &&
    typeof value['name'] === 'string' &&
    typeof value['message'] === 'string' &&
    (value['code'] === undefined || typeof value['code'] === 'string')
  )
}

/** Narrows a message from the supervisor, or returns null for anything else. */
export function parseSupervisorMessage(value: unknown): SupervisorMessage | null {
  if (!isRecord(value)) return null
  switch (value['type']) {
    case 'start':
      return typeof value['version'] === 'number' ? (value as SupervisorMessage) : null
    case 'call':
      return isId(value['id']) && typeof value['op'] === 'string' && Array.isArray(value['args'])
        ? (value as SupervisorMessage)
        : null
    case 'next':
    case 'cancel':
      return isId(value['id']) ? (value as SupervisorMessage) : null
    case 'stop':
      return value as SupervisorMessage
    default:
      return null
  }
}

/** Narrows a message from the host, or returns null for anything else. */
export function parseHostMessage(value: unknown): HostMessage | null {
  if (!isRecord(value)) return null
  switch (value['type']) {
    case 'started':
      return value as HostMessage
    case 'start-failed':
    case 'crashed':
      return isSerializedError(value['error']) ? (value as HostMessage) : null
    case 'stopped':
      return value['error'] === undefined || isSerializedError(value['error'])
        ? (value as HostMessage)
        : null
    case 'result':
      if (!isId(value['id'])) return null
      if (value['ok'] === true) return value as HostMessage
      return value['ok'] === false && isSerializedError(value['error'])
        ? (value as HostMessage)
        : null
    case 'item':
      return isId(value['id']) && typeof value['done'] === 'boolean' ? (value as HostMessage) : null
    case 'stats':
      return isRecord(value['stats']) ? (value as HostMessage) : null
    default:
      return null
  }
}
