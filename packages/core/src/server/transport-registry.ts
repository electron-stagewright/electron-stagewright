/**
 * Transport registry — the set of transports a server can dispatch through, with
 * capability-based selection.
 *
 * Lifecycle tools that create a session (`launch`, `attach`, `inject`) need a
 * transport that can perform the operation. Rather than hard-wiring a specific
 * implementation into each tool, they ask the registry for a transport that
 * declares the required capability (`canLaunch` / `canAttach` / `canInject`).
 * This keeps the capability matrix (ADR-003) the single source of truth for
 * "which transport can do what", and means a tool refuses cleanly with
 * `TRANSPORT_UNSUPPORTED` when no registered transport qualifies — instead of
 * crashing inside an SDK.
 *
 * @module
 */

import { StagewrightError } from '../errors/registry.js'
import {
  CDPTransport,
  InjectorTransport,
  type ITransport,
  PlaywrightElectronTransport,
  type TransportCapabilities,
  type TransportId,
} from '../transports/index.js'

/** Options for {@link TransportRegistry}. */
export interface TransportRegistryOptions {
  /**
   * Transports to register, in preference order (the first declaring a needed
   * capability wins). Defaults to the three built-ins: Playwright (launch), CDP
   * (attach), Injector (inject).
   */
  readonly transports?: readonly ITransport[]
}

/** The default transport set, in selection-preference order. */
function defaultTransports(): readonly ITransport[] {
  return [new PlaywrightElectronTransport(), new CDPTransport(), new InjectorTransport()]
}

/**
 * Holds the active transports and selects among them by capability or id. One
 * instance per server, threaded to session-creating tools via the tool context.
 */
export class TransportRegistry {
  readonly #transports: readonly ITransport[]

  constructor(opts: TransportRegistryOptions = {}) {
    this.#transports = opts.transports ?? defaultTransports()
  }

  /** All registered transports, in preference order. */
  all(): readonly ITransport[] {
    return this.#transports
  }

  /**
   * The first registered transport that declares `capability`. Throws
   * `TRANSPORT_UNSUPPORTED` when none qualifies, so a tool needing a capability
   * no transport provides fails with a registered code rather than a crash.
   */
  requireCapability(capability: keyof TransportCapabilities): ITransport {
    const found = this.#transports.find((transport) => transport.capabilities[capability])
    if (found === undefined) {
      throw new StagewrightError(
        'TRANSPORT_UNSUPPORTED',
        `No registered transport supports "${capability}".`,
        { capability },
      )
    }
    return found
  }

  /** The transport with the given id, or `undefined`. */
  byId(id: TransportId): ITransport | undefined {
    return this.#transports.find((transport) => transport.id === id)
  }
}
