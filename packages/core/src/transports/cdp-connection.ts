/**
 * Minimal Chrome DevTools Protocol client used by `CDPTransport` (ADR-003).
 *
 * One {@link CdpConnection} wraps ONE WebSocket to ONE CDP target (the browser
 * endpoint or a page target) — the "one WebSocket per target" pool shape:
 *
 * - **Pending map by request id** — every `send` allocates an incrementing id
 *   and parks a resolver until the matching response frame arrives.
 * - **Per-method timeouts** — each `send` is bounded; a target that never
 *   responds rejects with `CDP_TIMEOUT` instead of wedging the dispatch.
 * - **Enabled-domain cache** — `enable('Runtime')` sends `Runtime.enable` once
 *   per connection and caches the in-flight/settled promise, so repeated calls
 *   are free and never race a duplicate enable.
 * - **Event listeners** — protocol events (`Runtime.consoleAPICalled`,
 *   `Page.javascriptDialogOpening`, …) fan out to registered handlers.
 *
 * The WebSocket is created through an injectable {@link WebSocketFactory} so
 * unit tests drive the protocol over an in-memory fake. The default factory
 * uses the global `WebSocket` (built into Node since v22) — no runtime
 * dependency.
 *
 * @module
 */

import { StagewrightError } from '../errors/registry.js'

/** The single event payload field this client reads (message frames carry `data`). */
export interface WebSocketLikeEvent {
  readonly data?: unknown
}

/** Event types the client subscribes to on a socket. */
export type WebSocketEventType = 'open' | 'message' | 'close' | 'error'

/**
 * Structural slice of the WHATWG WebSocket surface the CDP client drives. The
 * global `WebSocket` satisfies it; tests substitute an in-memory fake.
 */
export interface WebSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: WebSocketEventType, listener: (event: WebSocketLikeEvent) => void): void
}

/** Creates the socket for a target URL. Injectable seam for tests. */
export type WebSocketFactory = (url: string) => WebSocketLike

/** Default per-method response budget. */
const DEFAULT_METHOD_TIMEOUT_MS = 15_000
/** Default budget for the WebSocket open handshake. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

/** The default factory: the global WebSocket (Node >= 22 ships one). */
function defaultWebSocketFactory(url: string): WebSocketLike {
  const ctor = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket
  if (ctor === undefined) {
    throw new StagewrightError(
      'TRANSPORT_UNSUPPORTED',
      'No global WebSocket implementation is available; the CDP transport requires Node 22+.',
    )
  }
  return new ctor(url) as WebSocketLike
}

/** A parked `send` awaiting its response frame. */
interface PendingEntry {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (err: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** Shape of a CDP response/event frame after JSON parsing. */
interface CdpFrame {
  readonly id?: number
  readonly result?: unknown
  readonly error?: { readonly code?: number; readonly message?: string }
  readonly method?: string
  readonly params?: unknown
}

/** Options accepted by {@link CdpConnection.open}. */
export interface CdpConnectionOptions {
  /** Socket factory override (tests). Defaults to the global WebSocket. */
  readonly factory?: WebSocketFactory
  /** Default per-method response budget. Defaults to 15s. */
  readonly defaultTimeoutMs?: number
  /** Budget for the open handshake. Defaults to 10s. */
  readonly connectTimeoutMs?: number
}

/** Per-call options accepted by {@link CdpConnection.send}. */
export interface CdpSendOptions {
  /** Override the connection's default per-method timeout. */
  readonly timeoutMs?: number
}

/**
 * One live CDP WebSocket. Construct via {@link CdpConnection.open}; dispose via
 * {@link CdpConnection.close} (idempotent — pending calls reject with
 * `CDP_DISCONNECTED`, never hang).
 */
export class CdpConnection {
  readonly url: string
  readonly #socket: WebSocketLike
  readonly #defaultTimeoutMs: number
  #nextId = 1
  #closed = false
  readonly #pending = new Map<number, PendingEntry>()
  /** Enabled-domain cache: domain → the (in-flight or settled) enable promise. */
  readonly #enabling = new Map<string, Promise<void>>()
  readonly #eventHandlers = new Map<string, Set<(params: unknown) => void>>()
  readonly #closeHandlers = new Set<() => void>()

  private constructor(url: string, socket: WebSocketLike, defaultTimeoutMs: number) {
    this.url = url
    this.#socket = socket
    this.#defaultTimeoutMs = defaultTimeoutMs
  }

  /** Open a connection to `url`, bounded by the connect timeout. */
  static open(url: string, opts: CdpConnectionOptions = {}): Promise<CdpConnection> {
    const factory = opts.factory ?? defaultWebSocketFactory
    const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    const socket = factory(url)
    const connection = new CdpConnection(
      url,
      socket,
      opts.defaultTimeoutMs ?? DEFAULT_METHOD_TIMEOUT_MS,
    )

    return new Promise<CdpConnection>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        connection.close()
        reject(
          new StagewrightError('CDP_TIMEOUT', `CDP connect to ${url} timed out.`, {
            url,
            timeoutMs: connectTimeoutMs,
          }),
        )
      }, connectTimeoutMs)
      timer.unref?.()

      socket.addEventListener('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(connection)
      })
      socket.addEventListener('message', (event) => {
        connection.#onMessage(event)
      })
      socket.addEventListener('close', () => {
        connection.#onClosed()
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(
          new StagewrightError('CDP_DISCONNECTED', `CDP socket to ${url} closed during connect.`, {
            url,
          }),
        )
      })
      socket.addEventListener('error', () => {
        // The close event follows an error; treat error itself as fatal only
        // when the handshake has not completed (some sockets emit error+close).
        if (settled) return
        settled = true
        clearTimeout(timer)
        connection.close()
        reject(
          new StagewrightError('CDP_DISCONNECTED', `CDP socket to ${url} failed to connect.`, {
            url,
          }),
        )
      })
    })
  }

  /** Whether this connection has been closed (locally or by the peer). */
  get closed(): boolean {
    return this.#closed
  }

  /**
   * Send one CDP method call and await its response. Rejects with `CDP_TIMEOUT`
   * when the response does not arrive within the budget, `CDP_DISCONNECTED`
   * when the socket is (or becomes) closed, and `INTERNAL_ERROR` when the
   * target answers with a protocol error frame.
   */
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    opts: CdpSendOptions = {},
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(
        new StagewrightError('CDP_DISCONNECTED', `CDP connection to ${this.url} is closed.`, {
          url: this.url,
          method,
        }),
      )
    }
    const id = this.#nextId++
    const timeoutMs = opts.timeoutMs ?? this.#defaultTimeoutMs
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(
          new StagewrightError('CDP_TIMEOUT', `CDP ${method} did not respond in ${timeoutMs}ms.`, {
            url: this.url,
            method,
            timeoutMs,
          }),
        )
      }, timeoutMs)
      timer.unref?.()
      this.#pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })
      try {
        this.#socket.send(
          JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }),
        )
      } catch (cause) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(
          new StagewrightError('CDP_DISCONNECTED', `CDP send of ${method} failed.`, {
            url: this.url,
            method,
            cause: cause instanceof Error ? cause.message : String(cause),
          }),
        )
      }
    })
  }

  /**
   * Enable a CDP domain exactly once per connection. Concurrent and repeated
   * calls share one in-flight promise (the enabled-domain cache); a FAILED
   * enable is evicted so a later call can retry.
   */
  enable(domain: string, opts: CdpSendOptions = {}): Promise<void> {
    const existing = this.#enabling.get(domain)
    if (existing !== undefined) return existing
    const enabling = this.send(`${domain}.enable`, undefined, opts).then(() => undefined)
    this.#enabling.set(domain, enabling)
    enabling.catch(() => {
      this.#enabling.delete(domain)
    })
    return enabling
  }

  /** Subscribe to a protocol event. Returns the unsubscribe function. */
  on(event: string, handler: (params: unknown) => void): () => void {
    let handlers = this.#eventHandlers.get(event)
    if (handlers === undefined) {
      handlers = new Set()
      this.#eventHandlers.set(event, handlers)
    }
    handlers.add(handler)
    return () => {
      handlers.delete(handler)
    }
  }

  /** Run `handler` when the connection closes (peer-initiated or local). */
  onClose(handler: () => void): void {
    this.#closeHandlers.add(handler)
  }

  /**
   * Close the connection. Idempotent. Every pending call rejects with
   * `CDP_DISCONNECTED` so no caller is left hanging.
   */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const [id, entry] of this.#pending) {
      clearTimeout(entry.timer)
      this.#pending.delete(id)
      entry.reject(
        new StagewrightError(
          'CDP_DISCONNECTED',
          `CDP connection to ${this.url} closed while ${entry.method} was pending.`,
          { url: this.url, method: entry.method },
        ),
      )
    }
    try {
      this.#socket.close()
    } catch {
      // Closing an already-dead socket is benign.
    }
    for (const handler of this.#closeHandlers) {
      try {
        handler()
      } catch {
        // A close observer must never break the close path.
      }
    }
  }

  /** Peer closed the socket — same cleanup as a local close. */
  #onClosed(): void {
    this.close()
  }

  #onMessage(event: WebSocketLikeEvent): void {
    if (typeof event.data !== 'string') return
    let frame: CdpFrame
    try {
      frame = JSON.parse(event.data) as CdpFrame
    } catch {
      // A malformed frame is dropped; the per-method timeout backstops the caller.
      return
    }
    if (typeof frame.id === 'number') {
      const entry = this.#pending.get(frame.id)
      // A response for an id we no longer track (timed out, or never ours) is
      // ignored — late responses must not crash the client.
      if (entry === undefined) return
      this.#pending.delete(frame.id)
      clearTimeout(entry.timer)
      if (frame.error !== undefined) {
        entry.reject(
          new StagewrightError(
            'INTERNAL_ERROR',
            `CDP ${entry.method} failed: ${frame.error.message ?? 'unknown CDP error'}`,
            { url: this.url, method: entry.method, cdpCode: frame.error.code ?? null },
          ),
        )
        return
      }
      entry.resolve(frame.result)
      return
    }
    if (typeof frame.method === 'string') {
      const handlers = this.#eventHandlers.get(frame.method)
      if (handlers === undefined) return
      for (const handler of handlers) {
        try {
          handler(frame.params)
        } catch {
          // One throwing listener must not break event fan-out.
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared Runtime.evaluate helpers — used by CDPTransport (page/browser targets)
// and InjectorTransport (the Node inspector speaks the same Runtime domain).
// ---------------------------------------------------------------------------

/** Shape of `Runtime.evaluate`'s response (the slice the transports read). */
export interface RuntimeEvaluateResult {
  readonly result?: { readonly value?: unknown; readonly description?: string }
  readonly exceptionDetails?: {
    readonly text?: string
    readonly exception?: { readonly description?: string }
  }
}

/**
 * Wrap a function-body string (the transport-wide eval contract) into a CDP
 * `Runtime.evaluate` expression. The argument is embedded as a JSON literal —
 * JSON is a JS literal subset except U+2028/U+2029, which are escaped.
 */
export function buildEvalExpression(body: string, arg: unknown): string {
  const serialised = JSON.stringify(arg === undefined ? null : arg) ?? 'null'
  const safe = serialised.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  return `(async (arg) => { ${body} })(${safe})`
}

/** Render one console-argument RemoteObject to text. */
export function remoteObjectToText(obj: {
  readonly value?: unknown
  readonly description?: string
}): string {
  if (obj.value !== undefined) {
    if (typeof obj.value === 'string') return obj.value
    try {
      return JSON.stringify(obj.value) ?? String(obj.value)
    } catch {
      return String(obj.value)
    }
  }
  return obj.description ?? ''
}

/** Options accepted by {@link evaluateExpression}. */
export interface EvaluateExpressionOptions {
  /**
   * Expose the inspector's command-line API (`require`, …) to the expression.
   * Needed for Node-inspector targets (the Injector transport) where `require`
   * is not a global in the evaluated context.
   */
  readonly includeCommandLineAPI?: boolean
  /** Per-call timeout override. */
  readonly timeoutMs?: number
}

/**
 * Evaluate a function-body string against a connection via `Runtime.evaluate`
 * with `awaitPromise` (the eval contract is an async body) and `returnByValue`.
 * Throws `EVAL_RUNTIME_ERROR` when the evaluated code threw.
 */
export async function evaluateExpression<T = unknown>(
  conn: CdpConnection,
  body: string,
  arg?: unknown,
  opts: EvaluateExpressionOptions = {},
): Promise<T> {
  try {
    await conn.enable('Runtime')
  } catch {
    // Some targets evaluate fine without an explicit Runtime.enable.
  }
  const result = await conn.send<RuntimeEvaluateResult>(
    'Runtime.evaluate',
    {
      expression: buildEvalExpression(body, arg),
      awaitPromise: true,
      returnByValue: true,
      ...(opts.includeCommandLineAPI === true ? { includeCommandLineAPI: true } : {}),
    },
    opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {},
  )
  if (result.exceptionDetails !== undefined) {
    const detail =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      'evaluation threw'
    throw new StagewrightError('EVAL_RUNTIME_ERROR', `CDP evaluation threw: ${detail}`, {
      url: conn.url,
    })
  }
  return result.result?.value as T
}
