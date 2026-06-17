/**
 * `@electron-stagewright/plugin-network` — capture an Electron app's renderer request/response
 * traffic by URL for agent-driven testing (ADR-016, built on the ADR-004 plugin contract). The
 * agent's other tools see the DOM; this one sees the network calls the app makes underneath — which
 * endpoints, what status, how long — so a flow can be debugged or a call asserted.
 *
 * Unlike the IPC plugin, capture rides a dedicated TRANSPORT SEAM (`startNetworkCapture` /
 * `networkEvents` / `stopNetworkCapture`), NOT main-process eval: protocol-level network is invisible
 * to eval, and capture is not arbitrary JS, so this plugin is NOT `--allow-eval` gated. It IS gated on
 * the transport's `canIntercept` capability (`network.UNSUPPORTED` otherwise) and bounded to an
 * explicit URL allowlist — there is no capture-everything. Tools (namespaced by the loader):
 * `network_capture_start`, `network_captured`, `network_capture_stop`.
 *
 * SECURITY: captured headers can carry secrets (auth, cookies, tokens). Capture is opt-in (an
 * explicit allowlist), bodies are NOT captured (headers + metadata only), and the `redactSecureDefaults`
 * config redacts `authorization` / `cookie` / `set-cookie` by default before any event reaches the
 * agent; `redactHeaders` adds more.
 *
 * @module
 */

import {
  defineTool,
  makePluginError,
  makeSuccess,
  type AnyToolDefinition,
  type NetworkEvent,
  type StagewrightPlugin,
  type ToolContext,
  type ToolResult,
  type TransportSession,
} from '@electron-stagewright/core'
import { z } from 'zod'

/** Plugin namespace — must match {@link networkPlugin.name}; the loader prefixes its tools with it. */
const NETWORK_NAMESPACE = 'network'
/** Plugin package version advertised by `electron_plugins`; keep in sync with package.json. */
const NETWORK_PLUGIN_VERSION = '0.1.0'

/** Header names redacted by default when `redactSecureDefaults` is on (lower-cased). */
const SECURE_DEFAULT_REDACT = ['authorization', 'cookie', 'set-cookie'] as const

const configSchema = z.object({
  redactHeaders: z
    .array(z.string())
    .default([])
    .describe(
      'Extra request/response header names to redact (case-insensitive), beyond the secure defaults.',
    ),
  redactSecureDefaults: z
    .boolean()
    .default(true)
    .describe(
      'Redact authorization, cookie, and set-cookie headers by default; set false to capture them verbatim.',
    ),
})

/** Resolved plugin configuration — the validated output of {@link configSchema}. */
type NetworkConfig = z.infer<typeof configSchema>

/** Defaults used until `setup` runs (mirror the schema defaults). */
const DEFAULT_CONFIG: NetworkConfig = { redactHeaders: [], redactSecureDefaults: true }

/**
 * One session's in-flight capture — the allowlist {@link captureStartTool} armed for it. Stored in
 * {@link captures} keyed by the session id, so each running app session captures independently; today
 * only the KEY (presence) gates the tools, but the armed filter is retained because the forthcoming
 * stub/modify fold needs it (mirroring the IPC plugin's per-capture record).
 */
interface SessionCapture {
  readonly urls: readonly string[]
  readonly methods?: readonly string[]
}

// Module-level state. `captures` holds one entry per capturing session, keyed by the transport's
// globally-unique session id, so concurrent app sessions capture independently — starting or stopping
// one never disturbs another. The map/config are module-level, so co-resident servers in the SAME
// process share plugin lifecycle/config (an accepted limitation, as with the IPC and trace plugins);
// fully independent lifecycles run in separate Node processes. The actual per-session ring buffer
// lives in the transport session; this map only tracks which sessions the plugin armed.
let config: NetworkConfig = DEFAULT_CONFIG
const captures = new Map<string, SessionCapture>()

/** The envelope meta a plugin tool threads into `makeSuccess` / `makePluginError`. */
interface PluginMeta {
  readonly startedAt: number
  readonly now: () => number
}

/** The set of header names (lower-cased) to redact, given the active config. */
function redactNameSet(): ReadonlySet<string> {
  const names = config.redactHeaders.map((name) => name.toLowerCase())
  if (config.redactSecureDefaults) names.push(...SECURE_DEFAULT_REDACT)
  return new Set(names)
}

/** Replace the values of redacted headers with `[redacted]`, leaving the rest intact. */
function redactHeaderMap(
  headers: Record<string, string>,
  names: ReadonlySet<string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key] = names.has(key.toLowerCase()) ? '[redacted]' : value
  }
  return out
}

/** Redact request/response headers on every event before it reaches the agent. */
export function redactEvents(
  events: readonly NetworkEvent[],
  names: ReadonlySet<string>,
): NetworkEvent[] {
  if (names.size === 0) return [...events]
  return events.map((event) => {
    const { requestHeaders, responseHeaders } = event
    return {
      ...event,
      ...(requestHeaders !== undefined
        ? { requestHeaders: redactHeaderMap(requestHeaders, names) }
        : {}),
      ...(responseHeaders !== undefined
        ? { responseHeaders: redactHeaderMap(responseHeaders, names) }
        : {}),
    }
  })
}

/**
 * Resolve the session + assert its transport can capture network traffic. Returns the session, or the
 * plugin-error envelope to return instead. Unlike the IPC plugin, there is no eval gate — network
 * capture is protocol observation, not arbitrary JS.
 */
function requireCapture(
  ctx: ToolContext,
  sessionId: string | undefined,
  meta: PluginMeta,
): { session: TransportSession; sessionId: string } | { error: ToolResult } {
  // resolve throws a core StagewrightError (NOT_RUNNING / BAD_ARGUMENT) the dispatcher maps to an
  // envelope, so an unknown/absent/ambiguous session needs no handling here.
  const managed = ctx.sessions.resolve(sessionId)
  if (!managed.transport.capabilities.canIntercept) {
    return {
      error: makePluginError('network.UNSUPPORTED', {
        ...meta,
        message:
          'This session’s transport cannot capture network traffic; the default Playwright transport can.',
      }),
    }
  }
  return { session: managed.session, sessionId: managed.id }
}

/**
 * The ids of THIS server's sessions that currently have a capture, surfaced in error details so the
 * agent can retarget. Scoped to the caller's session manager: the `captures` registry is
 * process-global, so a co-resident second server's captures must not leak into this server's payloads.
 */
function capturingIds(sessions: ToolContext['sessions']): string[] {
  return [...captures.keys()].filter((id) => sessions.has(id))
}

/**
 * The NOT_CAPTURING envelope for a request whose resolved session has no active capture. `details.capturing`
 * lists this server's capturing sessions so the agent can retarget; `hint` tails the message.
 */
function notCapturing(
  sessionId: string,
  sessions: ToolContext['sessions'],
  meta: PluginMeta,
  hint: string,
): ToolResult {
  return makePluginError('network.NOT_CAPTURING', {
    ...meta,
    message: `No active network capture on session ${sessionId}; ${hint}`,
    details: { sessionId, capturing: capturingIds(sessions) },
  })
}

const captureStartTool: AnyToolDefinition = defineTool({
  name: 'capture_start',
  title: 'Start capturing network requests',
  description: [
    'Begin recording the renderer requests whose URL contains any entry in `urls` (an explicit',
    'allowlist — only matching requests are captured; there is no capture-everything). Optionally',
    'restrict to `methods` (e.g. ["GET","POST"], case-insensitive). Captures metadata + headers only',
    '(no bodies). Returns: { ok, capturing, urls, methods? }. Errors: network.UNSUPPORTED (transport',
    'cannot capture), network.ALREADY_CAPTURING (call network_capture_stop first), NOT_RUNNING (no',
    'session), BAD_ARGUMENT (empty urls).',
  ].join(' '),
  inputSchema: z.object({
    urls: z
      .array(z.string().min(1))
      .min(1)
      .describe('Allowlist of URL substrings to capture (required, at least one).'),
    methods: z
      .array(z.string().min(1))
      .optional()
      .describe('Optional HTTP-method allowlist (case-insensitive); omit to capture every method.'),
    sessionId: z.string().optional().describe('Target session; defaults to the only session.'),
  }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    // Resolve the session first (this also enforces the capability gate), so ALREADY_CAPTURING is
    // judged per the resolved session rather than against a single global flag.
    const guard = requireCapture(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    if (captures.has(guard.sessionId)) {
      return makePluginError('network.ALREADY_CAPTURING', {
        ...meta,
        message: `Already capturing on session ${guard.sessionId}; call network_capture_stop first.`,
        details: { sessionId: guard.sessionId, capturing: capturingIds(ctx.sessions) },
      })
    }
    const filter = {
      urls: args.urls,
      ...(args.methods !== undefined ? { methods: args.methods } : {}),
    }
    await guard.session.startNetworkCapture(filter)
    captures.set(guard.sessionId, filter)
    return makeSuccess({ capturing: true, ...filter }, meta)
  },
})

const capturedTool: AnyToolDefinition = defineTool({
  name: 'captured',
  title: 'Read captured network requests',
  description: [
    'Return the network events captured since network_capture_start. Each event is { method, url,',
    'resourceType?, status?, ok?, requestHeaders?, responseHeaders?, failure?, durationMs?,',
    'timestamp, windowId? }; configured redact headers are stripped. Pass clear:true to flush the',
    'buffer after reading. Returns: { ok, count, events, overflowed }. Errors: network.NOT_CAPTURING (call',
    'network_capture_start first), network.UNSUPPORTED, NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({
    clear: z.boolean().optional().describe('Flush the captured buffer after reading it.'),
    sessionId: z.string().optional().describe('Target session; defaults to the only session.'),
  }),
  operationType: 'query',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireCapture(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    if (!captures.has(guard.sessionId)) {
      return notCapturing(guard.sessionId, ctx.sessions, meta, 'call network_capture_start first.')
    }
    const read = await guard.session.networkEvents(args.clear === true ? { clear: true } : {})
    const events = redactEvents(read.events, redactNameSet())
    return makeSuccess({ count: events.length, events, overflowed: read.overflowed }, meta)
  },
})

const captureStopTool: AnyToolDefinition = defineTool({
  name: 'capture_stop',
  title: 'Stop capturing network requests',
  description: [
    'Stop the active network capture and clear its buffer. Returns: { ok, stopped, events } (events =',
    'how many were retained when it stopped). Errors: network.NOT_CAPTURING (nothing to stop),',
    'network.UNSUPPORTED, NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({
    sessionId: z.string().optional().describe('Target session; defaults to the only session.'),
  }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireCapture(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    if (!captures.has(guard.sessionId)) {
      return notCapturing(guard.sessionId, ctx.sessions, meta, 'nothing to stop.')
    }
    // Read the retained count before stopping (stop clears the buffer).
    const read = await guard.session.networkEvents()
    await guard.session.stopNetworkCapture()
    captures.delete(guard.sessionId)
    return makeSuccess({ stopped: true, events: read.events.length }, meta)
  },
})

/**
 * The network plugin. Load with `--plugin @electron-stagewright/plugin-network` (NO eval flag — it
 * does not run app JS) or `createServer({ plugins: [networkPlugin] })`. Configure via
 * `pluginConfigs.network` (`{ redactHeaders?, redactSecureDefaults? }`).
 */
export const networkPlugin: StagewrightPlugin = {
  name: NETWORK_NAMESPACE,
  version: NETWORK_PLUGIN_VERSION,
  coreVersionRange: '*',
  configSchema,
  errorCodes: {
    UNSUPPORTED: {
      http: 409,
      retryable: false,
      hint: 'This transport cannot capture network traffic; use the default Playwright transport.',
    },
    ALREADY_CAPTURING: {
      http: 409,
      retryable: false,
      hint: 'A network capture is already active on this session; call network_capture_stop first.',
    },
    NOT_CAPTURING: {
      http: 409,
      retryable: false,
      hint: 'No active network capture on this session; call network_capture_start first.',
    },
  },
  tools: [captureStartTool, capturedTool, captureStopTool],
  setup: (raw) => {
    config = raw as NetworkConfig
  },
  teardown: async () => {
    // Forget every session's capture flag. The per-session ring buffer lives in the transport session,
    // which the server stops as part of close — so there is nothing else to restore here.
    captures.clear()
    config = DEFAULT_CONFIG
  },
}

export default networkPlugin
