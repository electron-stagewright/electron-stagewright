/**
 * CDPTransport — raw Chrome DevTools Protocol transport. STUB IN THIS SLICE.
 *
 * The ADR documents the intended connection-pool design (multiplexed WebSocket
 * per target, pending-message map keyed by request ID, per-method timeouts,
 * `enabledDomains: Set<string>` to skip redundant `Runtime.enable` /
 * `Page.enable`, `awaitPromise: true` option for evaluation tools that need
 * Promise resolution). None of that ships here; this file only declares the
 * capability matrix and forces every method to throw a registered
 * `NOT_IMPLEMENTED` (or `TRANSPORT_UNSUPPORTED` when the capability matrix
 * already refuses) so the dispatcher's failure mode is uniform across slices.
 *
 * Capability matrix:
 *
 * - `canLaunch: false` — CDP requires an existing process to connect to.
 * - `canAttach: true` — attach is the primary purpose; future implementation
 *   wires this body against `chrome-remote-interface` or a hand-rolled client.
 * - `canInject: false` — InjectorTransport handles the no-pre-flag case.
 * - `canIntercept: true` — CDP `Fetch.enable` will land with the network plugin.
 * - `canControlClock: true` — CDP `Emulation.setVirtualTimePolicy` will land
 *   with the clock plugin.
 * - `supportsMainEval: true` — CDP `Runtime.evaluate` against the main target.
 * - `supportsRendererEval: true` — CDP `Runtime.evaluate` against a renderer
 *   target.
 *
 * @module
 */

import { StagewrightError } from '../errors/registry.js'
import type {
  AttachOptions,
  InjectOptions,
  ITransport,
  LaunchOptions,
  StopOptions,
  TransportCapabilities,
  TransportId,
  TransportSession,
} from './types.js'

const TRANSPORT_ID: TransportId = 'cdp'

function notImplemented(method: string): StagewrightError {
  return new StagewrightError(
    'NOT_IMPLEMENTED',
    `CDPTransport.${method} is not implemented yet; the contract is declared but the body lands in a later slice.`,
    { transport: TRANSPORT_ID, method },
  )
}

function unsupported(method: string, capability: keyof TransportCapabilities): StagewrightError {
  return new StagewrightError('TRANSPORT_UNSUPPORTED', `CDPTransport does not support ${method}.`, {
    transport: TRANSPORT_ID,
    method,
    capability,
  })
}

export class CDPTransport implements ITransport {
  public readonly id: TransportId = TRANSPORT_ID
  public readonly capabilities: TransportCapabilities = {
    canLaunch: false,
    canAttach: true,
    canInject: false,
    canIntercept: true,
    canControlClock: true,
    supportsMainEval: true,
    supportsRendererEval: true,
  }

  launch(_opts: LaunchOptions): Promise<TransportSession> {
    return Promise.reject(unsupported('launch', 'canLaunch'))
  }

  attach(_opts: AttachOptions): Promise<TransportSession> {
    return Promise.reject(notImplemented('attach'))
  }

  inject(_opts: InjectOptions): Promise<TransportSession> {
    return Promise.reject(unsupported('inject', 'canInject'))
  }

  stop(_session: TransportSession, _opts?: StopOptions): Promise<void> {
    return Promise.reject(notImplemented('stop'))
  }

  forceKill(_session: TransportSession): Promise<void> {
    return Promise.reject(notImplemented('forceKill'))
  }
}
