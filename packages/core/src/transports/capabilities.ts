/**
 * Capability-matrix helpers. Every tool that depends on a transport feature calls
 * {@link assertCapability} once before invoking the transport method, so the
 * dispatcher returns a clean `TRANSPORT_UNSUPPORTED` error instead of crashing
 * partway through the underlying SDK.
 *
 * @module
 */

import { StagewrightError } from '../errors/registry.js'
import type { ITransport, TransportCapabilities } from './types.js'

/**
 * Throws `StagewrightError('TRANSPORT_UNSUPPORTED', ...)` when `transport` does
 * not declare `capability`. Returns void on success — there is no `false` path
 * for callers to forget to handle.
 *
 * Use this at the top of any tool handler that needs a specific transport
 * feature; it keeps the refused-when-unsupported path one line instead of five.
 */
export function assertCapability(
  transport: ITransport,
  capability: keyof TransportCapabilities,
): void {
  if (!transport.capabilities[capability]) {
    throw new StagewrightError(
      'TRANSPORT_UNSUPPORTED',
      `Transport "${transport.id}" does not support capability "${capability}".`,
      { transport: transport.id, capability },
    )
  }
}
