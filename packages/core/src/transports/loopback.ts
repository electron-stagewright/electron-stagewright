/**
 * Loopback endpoint validation for the attach surfaces.
 *
 * The `electron_attach` tool schema already restricts `host` / `cdpUrl` to loopback, but
 * the transports must not rely on one tool's schema for that invariant: a future caller
 * (another tool, a plugin, an embedder using the transport API directly) could otherwise
 * hand `CDPTransport.attach` an arbitrary endpoint and turn the discovery probe into an
 * outbound request to attacker-chosen infrastructure. The check is re-asserted here, at
 * the transport boundary, so every path in is covered (defence-in-depth).
 *
 * @module
 */

import { StagewrightError } from '../errors/registry.js'

/** Hostnames accepted as loopback. WHATWG URL keeps brackets on IPv6, hence both forms. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Whether `host` names the local loopback interface. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTNAMES.has(host)
}

/** Whether `value` is a `ws://` / `wss://` URL on a loopback host. */
export function isLoopbackCdpUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (url.protocol === 'ws:' || url.protocol === 'wss:') && isLoopbackHost(url.hostname)
}

/**
 * Throw `BAD_ARGUMENT` unless the attach target (`cdpUrl` and/or `host`) is loopback.
 * A no-op for absent fields — the transports validate presence themselves.
 */
export function assertLoopbackAttachTarget(
  transport: string,
  opts: { readonly cdpUrl?: string; readonly host?: string },
): void {
  if (opts.cdpUrl !== undefined && !isLoopbackCdpUrl(opts.cdpUrl)) {
    throw new StagewrightError(
      'BAD_ARGUMENT',
      `cdpUrl must be a ws:// or wss:// URL on a loopback host (127.0.0.1, localhost, ::1); got "${opts.cdpUrl}".`,
      { transport, cdp_url: opts.cdpUrl },
    )
  }
  if (opts.host !== undefined && !isLoopbackHost(opts.host)) {
    throw new StagewrightError(
      'BAD_ARGUMENT',
      `host must be loopback (127.0.0.1, localhost, ::1); got "${opts.host}".`,
      { transport, host: opts.host },
    )
  }
}
