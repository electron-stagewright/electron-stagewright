/**
 * Discovery of already-running, debuggable Electron apps.
 *
 * ## Approach (and why not `ps`/`lsof`)
 *
 * Instead of parsing `ps`/`tasklist` output and mapping a port to a PID with
 * `lsof`/`netstat` (brittle, per-platform, and slow), discovery probes the
 * conventional Chrome DevTools Protocol debug ports with a bounded HTTP GET to
 * `/json/version`. A port that answers with valid CDP JSON is a debuggable
 * target; anything else is ignored. This is genuinely cross-platform, requires
 * no child processes, and cannot hang — every probe carries a hard deadline.
 *
 * PID resolution needs OS-level port→pid mapping; this helper leaves `pid` as
 * `null` so the descriptor shape stays stable for callers.
 *
 * Every probe is injectable so tests are deterministic and never open a socket.
 *
 * @module
 */

import { get as httpGet } from 'node:http'

import { z } from 'zod'

import { makeSuccess } from '../../errors/envelope.js'
import { StagewrightError } from '../../errors/registry.js'
import { type AnyToolDefinition, defineTool } from '../types.js'

/** A discovered debuggable target. `pid` is `null` when port→pid mapping is unavailable. */
export interface DiscoveredTarget {
  /** Stable identifier — the CDP `webSocketDebuggerUrl`. */
  readonly targetId: string
  /** The debug port the target answered on. */
  readonly port: number
  /** Identifying string from CDP `/json/version` (`Browser`), or `null`. */
  readonly appName: string | null
  /** Process id, or `null` (resolution deferred). */
  readonly pid: number | null
}

/** A single-port probe: resolves a target when the port hosts a CDP endpoint, else `null`. */
export type PortProbe = (
  host: string,
  port: number,
  timeoutMs: number,
) => Promise<DiscoveredTarget | null>

/** Default CDP debug port range scanned when none is supplied. */
export const DEFAULT_DISCOVERY_PORTS: readonly number[] = [9222, 9223, 9224, 9225]
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_TIMEOUT_MS = 300
const MAX_SCAN_PORTS = 64
const MAX_TIMEOUT_MS = 5_000

/** Options for {@link discoverRunning}. */
export interface DiscoverOptions {
  /** Ports to scan. Defaults to {@link DEFAULT_DISCOVERY_PORTS}. */
  readonly ports?: readonly number[]
  /** Loopback host to scan. Defaults to `127.0.0.1`. */
  readonly host?: string
  /** Per-port hard deadline in ms. Defaults to 300. Bounds the whole scan. */
  readonly timeoutMs?: number
  /** Probe injection for tests. Defaults to a real bounded HTTP probe. */
  readonly probe?: PortProbe
  /** Clock injection for the elapsed summary. */
  readonly now?: () => number
}

/** Result of {@link discoverRunning}: the targets plus a summary of what was scanned. */
export interface DiscoverResult {
  readonly targets: readonly DiscoveredTarget[]
  /**
   * What the scan covered, so an empty `targets` is unambiguous (nothing found
   * vs. too narrow a scan). `elapsed_ms` is wall-clock for the whole probe set.
   */
  readonly scanned: {
    readonly host: string
    readonly ports: readonly number[]
    readonly elapsed_ms: number
  }
}

/** A real CDP `/json/version` response is well under 1 KB; cap the body so a
 * non-CDP service streaming unboundedly on a probed port cannot exhaust memory
 * (the socket `timeout` only fires on inactivity, not on total size). */
const MAX_PROBE_BODY_BYTES = 4096

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function validateDiscoverOptions(host: string, ports: readonly number[], timeoutMs: number): void {
  if (!isLoopbackHost(host)) {
    throw new StagewrightError('BAD_ARGUMENT', 'Discovery only scans loopback hosts.', { host })
  }
  if (ports.length === 0 || ports.length > MAX_SCAN_PORTS) {
    throw new StagewrightError(
      'BAD_ARGUMENT',
      `Discovery scans between 1 and ${MAX_SCAN_PORTS} ports.`,
      {
        count: ports.length,
        max: MAX_SCAN_PORTS,
      },
    )
  }
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new StagewrightError('BAD_ARGUMENT', `Invalid discovery port: ${port}`, { port })
    }
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new StagewrightError(
      'BAD_ARGUMENT',
      `Discovery timeout must be between 1 and ${MAX_TIMEOUT_MS} ms.`,
      { timeoutMs, max: MAX_TIMEOUT_MS },
    )
  }
}

/** Parse a CDP `/json/version` body. Non-CDP JSON is ignored, not reported as a target. */
export function parseCdpVersionResponse(body: string, port: number): DiscoveredTarget | null {
  try {
    const json = JSON.parse(body) as { webSocketDebuggerUrl?: unknown; Browser?: unknown }
    if (
      typeof json.webSocketDebuggerUrl !== 'string' ||
      !/^wss?:\/\//u.test(json.webSocketDebuggerUrl)
    ) {
      return null
    }
    const appName = typeof json.Browser === 'string' ? json.Browser : null
    return { targetId: json.webSocketDebuggerUrl, port, appName, pid: null }
  } catch {
    return null
  }
}

/** Real probe: bounded HTTP GET to `/json/version`; any failure resolves `null`. */
const defaultProbe: PortProbe = (host, port, timeoutMs) =>
  new Promise<DiscoveredTarget | null>((resolve) => {
    let settled = false
    let req: ReturnType<typeof httpGet> | undefined
    const finish = (target: DiscoveredTarget | null) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve(target)
    }
    const abort = () => {
      req?.destroy()
      finish(null)
    }
    const deadline = setTimeout(abort, timeoutMs)

    req = httpGet({ host, port, path: '/json/version', timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        finish(null)
        return
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
        if (body.length > MAX_PROBE_BODY_BYTES) {
          req?.destroy()
          finish(null)
        }
      })
      res.on('end', () => {
        finish(parseCdpVersionResponse(body, port))
      })
    })
    req.on('timeout', () => {
      abort()
    })
    req.on('error', () => {
      finish(null)
    })
  })

/**
 * Scan the debug ports and return the debuggable targets plus a scan summary.
 * Probe failures on individual ports resolve to "no target there"; invalid scan
 * options still throw `BAD_ARGUMENT`. The scan is bounded by `timeoutMs` per port
 * and runs all ports concurrently.
 */
export async function discoverRunning(opts: DiscoverOptions = {}): Promise<DiscoverResult> {
  const host = opts.host ?? DEFAULT_HOST
  const ports = opts.ports ?? DEFAULT_DISCOVERY_PORTS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const probe = opts.probe ?? defaultProbe
  const now = opts.now ?? Date.now
  validateDiscoverOptions(host, ports, timeoutMs)

  const started = now()
  const results = await Promise.all(
    ports.map((port) => probe(host, port, timeoutMs).catch(() => null)),
  )
  const targets = results.filter((target): target is DiscoveredTarget => target !== null)
  return { targets, scanned: { host, ports, elapsed_ms: now() - started } }
}

/** Dependency seams for {@link makeDiscoverTool} — injected by tests. */
export interface DiscoverToolDeps {
  /** Discovery implementation. Defaults to {@link discoverRunning}. */
  readonly discover?: (opts: DiscoverOptions) => Promise<DiscoverResult>
}

/**
 * Build the `electron_discover_running` tool. Exposed as a factory so tests
 * inject a deterministic discovery implementation instead of opening sockets.
 */
export function makeDiscoverTool(deps: DiscoverToolDeps = {}): AnyToolDefinition {
  const discover = deps.discover ?? discoverRunning
  return defineTool({
    name: 'electron_discover_running',
    title: 'Discover running Electron apps',
    description: [
      'Scan the conventional CDP debug ports (9222-9225 by default) for already-running,',
      'debuggable Electron apps on loopback only. No session required. Returns: { ok, targets, count, scanned }',
      'where each target is { targetId, port, appName, pid } and scanned reports { host, ports,',
      'elapsed_ms } so an empty result is unambiguous. Errors: BAD_ARGUMENT (non-loopback host,',
      'invalid port list, or timeout outside bounds). A failed probe is simply "no target on that port".',
    ].join(' '),
    inputSchema: z.object({
      ports: z
        .array(z.number().int().min(1).max(65_535))
        .min(1)
        .max(MAX_SCAN_PORTS)
        .optional()
        .describe(`Ports to scan. Defaults to 9222-9225. Max ${MAX_SCAN_PORTS}.`),
      host: z
        .enum(['127.0.0.1', 'localhost', '::1'])
        .optional()
        .describe('Loopback host to scan. Defaults to 127.0.0.1.'),
      timeoutMs: z
        .number()
        .int()
        .min(1)
        .max(MAX_TIMEOUT_MS)
        .optional()
        .describe(`Per-port timeout in ms. Defaults to 300. Max ${MAX_TIMEOUT_MS}.`),
    }),
    operationType: 'query',
    handler: async (args, ctx) => {
      const result = await discover({
        ...(args.ports !== undefined ? { ports: args.ports } : {}),
        ...(args.host !== undefined ? { host: args.host } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        now: ctx.now,
      })
      return makeSuccess(
        { targets: result.targets, count: result.targets.length, scanned: result.scanned },
        { startedAt: ctx.startedAt, now: ctx.now },
      )
    },
  })
}

/** The default `electron_discover_running` tool registered by the server. */
export const discoverTool: AnyToolDefinition = makeDiscoverTool()
