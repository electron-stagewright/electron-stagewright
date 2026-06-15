/**
 * `@electron-stagewright/plugin-ipc` — capture, invoke, and stub Electron IPC for agent-driven
 * testing (ADR-010, built on the ADR-004 plugin contract). The agent's other tools see the DOM;
 * this one sees the renderer↔main IPC traffic the DOM hides.
 *
 * It instruments the main process through the session transport's `evaluate('main', …)` seam (see
 * `instrument.ts`), wrapping `ipcMain.handle`, opt-in `ipcMain.on`, and opt-in `webContents.send` /
 * `sendToFrame` for the channels in an explicit allowlist. Tools (namespaced by the loader):
 * `ipc_capture_start`, `ipc_captured`, `ipc_capture_stop`, `ipc_invoke`, `ipc_stub`.
 *
 * SECURITY: capture / invoke / stub all run JS in the main process, so all three require the
 * main eval opt-in (`--allow-eval=main`, or bare `--allow-eval`) — the same main-process grant as
 * `electron_eval_main`. Capture and stub are additionally bounded to an explicit channel allowlist
 * (`ipc_capture_start` requires one; only those channels are wrapped/recorded/stubbable).
 * `ipc_invoke` is unrestricted by default and names its channel per call (the agent's explicit
 * choice), but operators can bound it with the `invokeAllow` config for defense-in-depth. Captured
 * payloads can include IPC arguments; the `redact` config drops named fields before they reach the
 * agent.
 *
 * @module
 */

import {
  defineTool,
  makePluginError,
  makeSuccess,
  type AnyToolDefinition,
  type StagewrightPlugin,
  type ToolContext,
  type ToolResult,
  type TransportSession,
} from '@electron-stagewright/core'
import { z } from 'zod'

import { INSTRUMENT_BODY, filterEvents, redactEvents, type IpcEvent } from './instrument.js'

/** Plugin namespace — must match {@link ipcPlugin.name}; the loader prefixes its tools with it. */
const IPC_NAMESPACE = 'ipc'
/** Plugin package version advertised by `electron_plugins`; keep in sync with package.json. */
const IPC_PLUGIN_VERSION = '0.4.0'

const configSchema = z.object({
  redact: z
    .array(z.string())
    .default([])
    .describe(
      'Argument property names to redact (replace with "[redacted]") from captured events.',
    ),
  maxEvents: z
    .number()
    .int()
    .positive()
    .default(1000)
    .describe('Max captured IPC events buffered per session; later calls are dropped.'),
  invokeAllow: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Optional allowlist of channels ipc_invoke may target. Omit for unrestricted invoke (the ' +
        'default); set to [] to block all invoke; set to a list to bound it. Independent of the ' +
        'capture/stub allowlist.',
    ),
})

/** Resolved plugin configuration — the validated output of {@link configSchema}. */
type IpcConfig = z.infer<typeof configSchema>

/** Defaults used until `setup` runs (mirror the schema defaults). */
const DEFAULT_CONFIG: IpcConfig = { redact: [], maxEvents: 1000 }

/**
 * One session's in-flight IPC capture — the allowlist {@link captureStartTool} installed for it.
 * Stored in {@link captures} keyed by the session id, so each running app session captures
 * independently; the channels are retained to authorise {@link stubTool}.
 */
interface SessionCapture {
  readonly channels: readonly string[]
}

// Module-level state. `captures` holds one entry per instrumented session, keyed by the transport's
// globally-unique session id (e.g. `pw-<uuid>`), so concurrent app sessions capture independently —
// starting or stopping one never disturbs another. The map/config are module-level, so co-resident
// servers in the SAME process still share plugin lifecycle/config (an accepted limitation, as with
// the trace plugin). Keying by the unique session id prevents live calls from confusing one session
// with another; fully independent plugin lifecycles should run in separate Node processes. The
// realistic one-server deployment drives many sessions through this single map. The main-process
// `__swIpc` state is per app process; this map only tracks which sessions the plugin instrumented.
let config: IpcConfig = DEFAULT_CONFIG
const captures = new Map<string, SessionCapture>()

/** The envelope meta a plugin tool threads into `makeSuccess` / `makePluginError`. */
interface PluginMeta {
  readonly startedAt: number
  readonly now: () => number
}

/**
 * Resolve the session + assert main-process eval is available and the server allowed eval. Returns
 * the session, or the plugin-error envelope to return instead. Centralises the three guards every
 * main-process IPC op shares: eval opt-in, session existence, and transport capability.
 */
function requireMainEval(
  ctx: ToolContext,
  sessionId: string | undefined,
  meta: PluginMeta,
): { session: TransportSession; sessionId: string } | { error: ToolResult } {
  if (!ctx.allowEval) {
    return {
      error: makePluginError('ipc.EVAL_REQUIRED', {
        ...meta,
        message:
          'IPC instrumentation runs main-process JS; start the server with --allow-eval=main (or bare --allow-eval) to enable it.',
      }),
    }
  }
  // resolve throws a core StagewrightError (NOT_RUNNING / BAD_ARGUMENT) the dispatcher maps to an
  // envelope, so an unknown/absent session needs no handling here. `transport` carries the
  // capability flag; `session` carries `evaluate`.
  const managed = ctx.sessions.resolve(sessionId)
  if (!managed.transport.capabilities.supportsMainEval) {
    return {
      error: makePluginError('ipc.MAIN_EVAL_UNSUPPORTED', {
        ...meta,
        message: 'This session’s transport cannot evaluate in the main process; IPC needs that.',
      }),
    }
  }
  return { session: managed.session, sessionId: managed.id }
}

/**
 * The ids of THIS server's sessions that currently have a capture, surfaced in error details so the
 * agent can retarget. Scoped to the caller's session manager: the `captures` registry is
 * process-global, so a co-resident second server's captures must not leak into this server's error
 * payloads (and the agent can only act on its own server's sessions anyway).
 */
function capturingIds(sessions: ToolContext['sessions']): string[] {
  return [...captures.keys()].filter((id) => sessions.has(id))
}

/**
 * The NOT_CAPTURING envelope for a request whose resolved session has no active capture — either one
 * was never started for it, or it was already stopped. `details.capturing` lists this server's
 * sessions that DO have a capture so the agent can retarget instead of guessing; `hint` tails the
 * message with the tool-specific next step.
 */
function notCapturing(
  sessionId: string,
  sessions: ToolContext['sessions'],
  meta: PluginMeta,
  hint: string,
): ToolResult {
  return makePluginError('ipc.NOT_CAPTURING', {
    ...meta,
    message: `No active IPC capture on session ${sessionId}; ${hint}`,
    details: { sessionId, capturing: capturingIds(sessions) },
  })
}

const captureStartTool: AnyToolDefinition = defineTool({
  name: 'capture_start',
  title: 'Start capturing IPC calls',
  description: [
    'Begin recording calls to the ipcMain channels in `channels` (an explicit allowlist — only',
    'these are captured). Instruments the main process, so the server must permit main eval',
    '(--allow-eval=main, or bare --allow-eval).',
    'captureSend also records fire-and-forget on/send messages (default invoke/handle only);',
    'captureSendToRenderer also records main->renderer webContents.send/sendToFrame pushes.',
    'Returns: { ok, capturing, channels }. Errors: ipc.EVAL_REQUIRED (main eval not permitted),',
    'ipc.MAIN_EVAL_UNSUPPORTED (transport lacks main eval), ipc.ALREADY_CAPTURING (call',
    'ipc_capture_stop first), NOT_RUNNING (no session), BAD_ARGUMENT (empty channels).',
  ].join(' '),
  inputSchema: z.object({
    channels: z
      .array(z.string().min(1))
      .min(1)
      .describe('Allowlist of ipcMain channel names to capture (required, at least one).'),
    captureSend: z
      .boolean()
      .optional()
      .describe('Also capture fire-and-forget on/send messages, not just invoke/handle.'),
    captureSendToRenderer: z
      .boolean()
      .optional()
      .describe(
        'Also capture main->renderer webContents.send/sendToFrame pushes (needs an open window at start).',
      ),
    sessionId: z.string().optional().describe('Target session; defaults to the only session.'),
  }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    // Resolve the session first (this also enforces the main eval gate), so ALREADY_CAPTURING is
    // judged per the resolved session rather than against a single global flag.
    const guard = requireMainEval(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    if (captures.has(guard.sessionId)) {
      return makePluginError('ipc.ALREADY_CAPTURING', {
        ...meta,
        message: `Already capturing on session ${guard.sessionId}; call ipc_capture_stop first.`,
        details: { sessionId: guard.sessionId, capturing: capturingIds(ctx.sessions) },
      })
    }
    await guard.session.evaluate('main', INSTRUMENT_BODY, {
      op: 'install',
      allow: args.channels,
      captureSend: args.captureSend === true,
      captureSendToRenderer: args.captureSendToRenderer === true,
      maxEvents: config.maxEvents,
    })
    captures.set(guard.sessionId, { channels: args.channels })
    return makeSuccess({ capturing: true, channels: args.channels }, meta)
  },
})

const capturedTool: AnyToolDefinition = defineTool({
  name: 'captured',
  title: 'Read captured IPC calls',
  description: [
    'Return the IPC calls captured since ipc_capture_start, optionally filtered to one channel.',
    'Each event is { channel, type (invoke|send|send-to-renderer), args, ok, ms, ts, error?,',
    'webContentsId? }; configured redact fields are stripped from args. Returns: { ok, count,',
    'events }. Errors: ipc.NOT_CAPTURING',
    '(call ipc_capture_start first), ipc.EVAL_REQUIRED, ipc.MAIN_EVAL_UNSUPPORTED, NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({
    channel: z.string().optional().describe('Only return events on this channel.'),
    sessionId: z.string().optional().describe('Target session; defaults to the only session.'),
  }),
  operationType: 'query',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireMainEval(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    if (!captures.has(guard.sessionId)) {
      return notCapturing(guard.sessionId, ctx.sessions, meta, 'call ipc_capture_start first.')
    }
    const read = await guard.session.evaluate<{ events: IpcEvent[] }>('main', INSTRUMENT_BODY, {
      op: 'read',
    })
    const events = redactEvents(filterEvents(read.events, args.channel), config.redact)
    return makeSuccess({ count: events.length, events }, meta)
  },
})

const captureStopTool: AnyToolDefinition = defineTool({
  name: 'capture_stop',
  title: 'Stop capturing IPC calls',
  description: [
    'Stop the active capture and restore the app’s original ipcMain handlers/listeners and',
    'WebContents send methods. Returns: { ok, stopped, events } (events = how many were captured).',
    'Errors: ipc.NOT_CAPTURING (nothing to stop), ipc.EVAL_REQUIRED, ipc.MAIN_EVAL_UNSUPPORTED,',
    'NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({
    sessionId: z.string().optional().describe('Target session; defaults to the only session.'),
  }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireMainEval(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    if (!captures.has(guard.sessionId)) {
      return notCapturing(guard.sessionId, ctx.sessions, meta, 'nothing to stop.')
    }
    const result = await guard.session.evaluate<{ stopped: boolean; events: number }>(
      'main',
      INSTRUMENT_BODY,
      { op: 'stop' },
    )
    captures.delete(guard.sessionId)
    return makeSuccess({ stopped: result.stopped, events: result.events }, meta)
  },
})

const invokeTool: AnyToolDefinition = defineTool({
  name: 'invoke',
  title: 'Invoke an ipcMain handle channel',
  description: [
    'Call a registered ipcMain.handle channel from the main process (driving the request the',
    'renderer would normally send) and return its result. timeoutMs bounds a hung handler.',
    'If the invokeAllow plugin config is set, the channel must be in it.',
    'Returns: { ok, result }. Errors: ipc.EVAL_REQUIRED, ipc.MAIN_EVAL_UNSUPPORTED, ipc.INVOKE_FAILED',
    '(no handler / handler threw / timed out), ipc.CHANNEL_NOT_ALLOWED (channel not in invokeAllow),',
    'NOT_RUNNING, BAD_ARGUMENT.',
  ].join(' '),
  inputSchema: z.object({
    channel: z.string().min(1).describe('The ipcMain.handle channel to invoke.'),
    args: z
      .array(z.unknown())
      .optional()
      .describe('Arguments passed after the IpcMainInvokeEvent.'),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Reject if the handler runs longer.'),
    sessionId: z.string().optional().describe('Target session; defaults to the only session.'),
  }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireMainEval(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    // Optional invoke allowlist (defense-in-depth): when invokeAllow is configured, refuse a channel
    // outside it before the main-process round-trip. Undefined = unrestricted; [] = block all.
    if (config.invokeAllow !== undefined && !config.invokeAllow.includes(args.channel)) {
      return makePluginError('ipc.CHANNEL_NOT_ALLOWED', {
        ...meta,
        message: `Channel "${args.channel}" is not in the ipc_invoke allowlist.`,
        details: { channel: args.channel, allowed: config.invokeAllow },
      })
    }
    const result = await guard.session.evaluate<{
      ok: boolean
      result?: unknown
      error?: string
    }>('main', INSTRUMENT_BODY, {
      op: 'invoke',
      channel: args.channel,
      args: args.args ?? [],
      timeoutMs: args.timeoutMs ?? 0,
    })
    if (!result.ok) {
      return makePluginError('ipc.INVOKE_FAILED', {
        ...meta,
        message: `ipc_invoke("${args.channel}") failed: ${result.error ?? 'unknown error'}`,
        details: { channel: args.channel },
      })
    }
    return makeSuccess({ channel: args.channel, result: result.result ?? null }, meta)
  },
})

const stubTool: AnyToolDefinition = defineTool({
  name: 'stub',
  title: 'Stub an ipcMain handle channel',
  description: [
    'Make a captured channel’s ipcMain.handle return `response` instead of running the app’s',
    'handler, for the duration of the capture. The channel MUST be in the active capture allowlist.',
    'Cleared when ipc_capture_stop restores the originals. Returns: { ok, stubbed }. Errors:',
    'ipc.NOT_CAPTURING (start a capture first), ipc.CHANNEL_NOT_ALLOWED (channel not in the',
    'allowlist), ipc.EVAL_REQUIRED, ipc.MAIN_EVAL_UNSUPPORTED, NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({
    channel: z.string().min(1).describe('The captured channel to stub.'),
    response: z.unknown().describe('The value the stubbed handler resolves to.'),
    sessionId: z.string().optional().describe('Target session; defaults to the only session.'),
  }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireMainEval(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    const capture = captures.get(guard.sessionId)
    if (capture === undefined) {
      return notCapturing(guard.sessionId, ctx.sessions, meta, 'start a capture before stubbing.')
    }
    if (!capture.channels.includes(args.channel)) {
      return makePluginError('ipc.CHANNEL_NOT_ALLOWED', {
        ...meta,
        message: `Channel "${args.channel}" is not in the capture allowlist.`,
        details: { channel: args.channel, allowed: capture.channels },
      })
    }
    await guard.session.evaluate('main', INSTRUMENT_BODY, {
      op: 'stub',
      channel: args.channel,
      response: args.response,
    })
    return makeSuccess({ stubbed: args.channel }, meta)
  },
})

/**
 * The IPC plugin. Load with `--plugin @electron-stagewright/plugin-ipc --allow-eval=main` or
 * `createServer({ plugins: [ipcPlugin], allowEval: { main: true, renderer: false } })`.
 * Configure via `pluginConfigs.ipc` (`{ redact?, maxEvents?, invokeAllow? }`).
 */
export const ipcPlugin: StagewrightPlugin = {
  name: IPC_NAMESPACE,
  version: IPC_PLUGIN_VERSION,
  coreVersionRange: '*',
  configSchema,
  errorCodes: {
    EVAL_REQUIRED: {
      http: 403,
      retryable: false,
      hint: 'Start the server with --allow-eval=main (or bare --allow-eval); IPC instrumentation runs main-process JS.',
    },
    MAIN_EVAL_UNSUPPORTED: {
      http: 409,
      retryable: false,
      hint: 'This transport cannot evaluate in the main process; IPC capture/invoke needs that.',
    },
    ALREADY_CAPTURING: {
      http: 409,
      retryable: false,
      hint: 'An IPC capture is already active; call ipc_capture_stop first.',
    },
    NOT_CAPTURING: {
      http: 409,
      retryable: false,
      hint: 'No active IPC capture; call ipc_capture_start first.',
    },
    CHANNEL_NOT_ALLOWED: {
      http: 403,
      retryable: false,
      hint: 'The channel is not in the relevant allowlist; for capture/stub add it to ipc_capture_start channels, for ipc_invoke add it to the invokeAllow config.',
    },
    INVOKE_FAILED: {
      http: 422,
      retryable: false,
      hint: 'The channel had no handler, the handler threw, or it timed out.',
    },
  },
  tools: [captureStartTool, capturedTool, captureStopTool, invokeTool, stubTool],
  setup: (raw) => {
    config = raw as IpcConfig
  },
  teardown: async () => {
    // Forget every session's capture flag. The main-process __swIpc state lives in each app process,
    // which the server stops as part of close — so there is no separate handler to restore here (and
    // no session handle at teardown to evaluate against). ipc_capture_stop is the in-session restore.
    captures.clear()
    config = DEFAULT_CONFIG
  },
}

export default ipcPlugin

export { INSTRUMENT_BODY, filterEvents, redactEvents } from './instrument.js'
export type { IpcEvent, IpcOp } from './instrument.js'
