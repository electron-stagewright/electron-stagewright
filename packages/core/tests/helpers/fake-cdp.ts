/**
 * In-memory fake CDP endpoint shared by the CDP-transport and Injector tests:
 * an injectable WebSocket factory whose sockets route frames to scripted
 * per-method responders, record everything sent, and can push protocol events
 * or drop connections per target URL.
 *
 * Not a test file — no `.test.` segment, so vitest's glob does not pick it up.
 */

import type {
  WebSocketEventType,
  WebSocketFactory,
  WebSocketLike,
  WebSocketLikeEvent,
} from '../../src/transports/cdp-connection.js'

export type Json = Record<string, unknown>

export class FakeSocket implements WebSocketLike {
  readonly #listeners = new Map<WebSocketEventType, ((event: WebSocketLikeEvent) => void)[]>()
  constructor(
    readonly url: string,
    private readonly server: FakeCdpServer,
  ) {}

  addEventListener(type: WebSocketEventType, listener: (event: WebSocketLikeEvent) => void): void {
    const list = this.#listeners.get(type) ?? []
    list.push(listener)
    this.#listeners.set(type, list)
  }

  fire(type: WebSocketEventType, event: WebSocketLikeEvent = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event)
  }

  send(data: string): void {
    this.server.handle(this, data)
  }

  close(): void {
    this.fire('close')
  }
}

/**
 * Scripted CDP endpoint: routes each sent frame to a per-method responder (or
 * swallows it for `neverReply` methods), records every frame, and can push
 * protocol events / close sockets per target URL. A responder that throws
 * produces a CDP error frame, mirroring the real protocol.
 */
export class FakeCdpServer {
  readonly sent: { readonly url: string; readonly method: string; readonly params?: Json }[] = []
  readonly sockets: FakeSocket[] = []
  readonly #responders = new Map<string, (params: Json | undefined, url: string) => unknown>()
  readonly #never = new Set<string>()

  readonly factory: WebSocketFactory = (url) => {
    const socket = new FakeSocket(url, this)
    this.sockets.push(socket)
    queueMicrotask(() => socket.fire('open'))
    return socket
  }

  respond(method: string, responder: (params: Json | undefined, url: string) => unknown): void {
    this.#responders.set(method, responder)
  }

  neverReply(method: string): void {
    this.#never.add(method)
  }

  /** Push a protocol event to every socket whose URL contains `urlPart`. */
  emit(urlPart: string, method: string, params: Json): void {
    for (const socket of this.sockets) {
      if (!socket.url.includes(urlPart)) continue
      socket.fire('message', { data: JSON.stringify({ method, params }) })
    }
  }

  closeSockets(urlPart: string): void {
    for (const socket of this.sockets) {
      if (socket.url.includes(urlPart)) socket.fire('close')
    }
  }

  sentTo(
    urlPart: string,
    method?: string,
  ): readonly { url: string; method: string; params?: Json }[] {
    return this.sent.filter(
      (f) => f.url.includes(urlPart) && (method === undefined || f.method === method),
    )
  }

  handle(socket: FakeSocket, raw: string): void {
    const frame = JSON.parse(raw) as { id: number; method: string; params?: Json }
    this.sent.push({
      url: socket.url,
      method: frame.method,
      ...(frame.params !== undefined ? { params: frame.params } : {}),
    })
    if (this.#never.has(frame.method)) return
    const responder = this.#responders.get(frame.method)
    queueMicrotask(() => {
      try {
        const result = responder === undefined ? {} : responder(frame.params, socket.url)
        socket.fire('message', { data: JSON.stringify({ id: frame.id, result }) })
      } catch (err) {
        socket.fire('message', {
          data: JSON.stringify({
            id: frame.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          }),
        })
      }
    })
  }
}
