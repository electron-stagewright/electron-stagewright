/**
 * `electron_attach` and `electron_inject` — connect to an Electron app that is
 * already running.
 *
 * Both select a capability-appropriate transport from the registry and surface
 * bounded, registered errors from the underlying CDP / Injector implementations
 * instead of pretending to attach when a live app cannot be reached.
 *
 * @module
 */

import { z } from 'zod'

import { makeError, makeSuccess } from '../../errors/envelope.js'
import type { AttachOptions, InjectOptions } from '../../transports/index.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { registerWithWindows } from './session-init.js'

function isLoopbackCdpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'ws:' || url.protocol === 'wss:') &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
    )
  } catch {
    return false
  }
}

const attachInput = z.object({
  port: z
    .number()
    .int()
    .min(1)
    .max(65_535)
    .optional()
    .describe('CDP port; the endpoint is resolved from /json/version.'),
  host: z
    .enum(['127.0.0.1', 'localhost', '::1'])
    .optional()
    .describe('Loopback host for port-based attach. Defaults to localhost.'),
  cdpUrl: z
    .string()
    .refine(isLoopbackCdpUrl, 'CDP URL must be a ws:// or wss:// loopback URL.')
    .optional()
    .describe('Full CDP WebSocket URL on a loopback host.'),
  pid: z.number().int().positive().optional().describe('Process id of the running app.'),
  timeoutMs: z.number().int().positive().optional().describe('Max wait for the attach handshake.'),
})

/** `electron_attach` — attach to a running app exposing a CDP debug endpoint. */
export const attachTool: AnyToolDefinition = defineTool({
  name: 'electron_attach',
  title: 'Attach to running Electron app',
  description: [
    'Attach to an already-running Electron app exposing a CDP debug endpoint (use',
    'electron_discover_running to find one, or start the app with --remote-debugging-port).',
    'Provide port (+ optional loopback host) or a loopback cdpUrl; pid alone is not attachable over',
    'CDP but, when supplied alongside, lets stop escalate to SIGKILL. The CDP transport supports',
    'eval/read/observe and core interaction surfaces against the attached app.',
    'Returns: { ok, session_id, transport, windows }.',
    'Errors: TRANSPORT_UNSUPPORTED (no attach-capable transport), CDP_DISCONNECTED (endpoint',
    'unreachable or dropped; retryable), CDP_TIMEOUT (handshake/method timeout; retryable),',
    'BAD_ARGUMENT (missing target selector or non-loopback endpoint).',
  ].join(' '),
  inputSchema: attachInput,
  operationType: 'command',
  handler: async (args, ctx) => {
    if (args.port === undefined && args.cdpUrl === undefined) {
      return makeError('BAD_ARGUMENT', {
        message: 'Provide port or cdpUrl for electron_attach; pid alone requires electron_inject.',
        next_actions: [
          'electron_discover_running()',
          'Use electron_inject({ pid }) when the app was not started with a CDP endpoint.',
        ],
        startedAt: ctx.startedAt,
        now: ctx.now,
      })
    }
    const transport = ctx.transports.requireCapability('canAttach')
    const opts: AttachOptions = {
      ...(args.port !== undefined ? { port: args.port } : {}),
      ...(args.host !== undefined ? { host: args.host } : {}),
      ...(args.cdpUrl !== undefined ? { cdpUrl: args.cdpUrl } : {}),
      ...(args.pid !== undefined ? { pid: args.pid } : {}),
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    }
    const session = await transport.attach(opts)
    const { managed, windows } = await registerWithWindows(ctx, transport, session)
    return makeSuccess(
      { session_id: managed.id, transport: transport.id, windows },
      { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id },
    )
  },
})

const injectInput = z.object({
  pid: z.number().int().positive().describe('Process id of the running Electron app.'),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Max wait for the inspector handshake.'),
})

/** `electron_inject` — attach to a running app that did not start with a debug flag. */
export const injectTool: AnyToolDefinition = defineTool({
  name: 'electron_inject',
  title: 'Inject into running Electron app',
  description: [
    'Attach to a running Electron process that was NOT started with a debug flag, by injecting',
    'the Node inspector. Provide pid. Returns: { ok, session_id, transport, windows }.',
    'Errors: INJECT_FAILED (handshake failed or inspector belongs to another process; retryable —',
    'try electron_attach when the app already exposes a debug endpoint), TRANSPORT_UNSUPPORTED,',
    'BAD_ARGUMENT.',
  ].join(' '),
  inputSchema: injectInput,
  operationType: 'command',
  handler: async (args, ctx) => {
    const transport = ctx.transports.requireCapability('canInject')
    const opts: InjectOptions = {
      pid: args.pid,
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    }
    const session = await transport.inject(opts)
    const { managed, windows } = await registerWithWindows(ctx, transport, session)
    return makeSuccess(
      { session_id: managed.id, transport: transport.id, windows },
      { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id },
    )
  },
})
