/** Parameterizable capability guard for plugin transport seams. */

import type { TransportCapabilities } from '../transports/types.js'

/** A capability check result that preserves the plugin's own unsupported response. */
export type TransportCapabilityCheck<T> =
  { readonly supported: true } | { readonly supported: false; readonly fallback: T }

/**
 * Check one transport capability without prescribing an error code, hint, or envelope.
 *
 * Plugins own their error messages because two capabilities with the same shape can require
 * different operator remediation. The callback runs only for unsupported transports.
 */
export function requireTransportCapability<T>(
  capabilities: TransportCapabilities,
  capability: keyof TransportCapabilities,
  unsupported: () => T,
): TransportCapabilityCheck<T> {
  return capabilities[capability]
    ? { supported: true }
    : { supported: false, fallback: unsupported() }
}
