/**
 * `electron_attach` and `electron_inject` — connect to an Electron app that is
 * already running.
 *
 * Both select a capability-appropriate transport from the registry and drive it
 * optimistically: when the CDP / Injector transports are fully implemented these
 * handlers work unchanged. Today those transports are honest stubs, so the calls
 * surface `NOT_IMPLEMENTED` / `TRANSPORT_UNSUPPORTED` via the capability matrix
 * rather than pretending to succeed.
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
    'electron_discover_running to find one). Provide port (+ optional loopback host), loopback cdpUrl, or pid.',
    'Returns: { ok, session_id, transport, windows }.',
    'Errors: NOT_IMPLEMENTED (CDP transport not yet built; not retryable), TRANSPORT_UNSUPPORTED',
    '(no attach-capable transport), CDP_DISCONNECTED (connection dropped; retryable), BAD_ARGUMENT',
    '(missing target selector or non-loopback endpoint).',
  ].join(' '),
  inputSchema: attachInput,
  operationType: 'command',
  handler: async (args, ctx) => {
    if (args.port === undefined && args.cdpUrl === undefined && args.pid === undefined) {
      return makeError('BAD_ARGUMENT', {
        message: 'Provide port, cdpUrl, or pid for electron_attach.',
        next_actions: ['electron_discover_running()'],
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
    'Errors: NOT_IMPLEMENTED (Injector transport not yet built; not retryable), INJECT_FAILED',
    '(handshake failed; retryable — try electron_attach), TRANSPORT_UNSUPPORTED.',
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
