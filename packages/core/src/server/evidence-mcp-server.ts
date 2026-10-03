import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

/** Observe the SDK's negotiated version without replacing its initialization handler. */
export class EvidenceMcpServer extends McpServer {
  #protocolVersion: string | undefined

  get supportsResourceLinks(): boolean {
    return this.#protocolVersion !== undefined && this.#protocolVersion >= '2025-06-18'
  }

  override connect(transport: Transport): Promise<void> {
    this.#protocolVersion = undefined
    const send: Transport['send'] = (message, options) => {
      if ('result' in message && typeof message.result['protocolVersion'] === 'string') {
        this.#protocolVersion = message.result['protocolVersion']
      }
      return transport.send(message, options)
    }
    // Forward callbacks and properties to the original transport. Bind methods to preserve
    // transports with private fields; only outgoing initialize-result observation is added.
    const observed = new Proxy(transport, {
      get(target, property) {
        if (property === 'send') return send
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
      set: (target, property, value: unknown) => Reflect.set(target, property, value, target),
    })
    return super.connect(observed)
  }
}
