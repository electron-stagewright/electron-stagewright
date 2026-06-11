/**
 * Session-teardown tools: `electron_stop` (graceful), `electron_force_kill`
 * (SIGKILL), and `electron_detach`.
 *
 * stop/force_kill resolve the target session and route through the session
 * manager's idempotent removal. detach — disconnecting from an app without
 * stopping it — needs a transport capability that no current transport provides
 * (the Playwright transport owns the process it launched, so closing the
 * connection closes the app), so it honestly returns `TRANSPORT_UNSUPPORTED`
 * until a transport-level detach lands.
 *
 * @module
 */

import { z } from 'zod'

import { makeError, makeSuccess } from '../../errors/envelope.js'
import { type AnyToolDefinition, defineTool } from '../types.js'

const sessionOnly = z.object({
  sessionId: z
    .string()
    .optional()
    .describe('Target session id. Omit when a single session is running.'),
})

const stopInput = z.object({
  sessionId: z
    .string()
    .optional()
    .describe('Target session id. Omit when a single session is running.'),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Graceful-close budget in ms before escalating to SIGKILL. Defaults to 10000.'),
})

/** `electron_stop` — graceful shutdown of a session, escalating to SIGKILL on timeout. */
export const stopTool: AnyToolDefinition = defineTool({
  name: 'electron_stop',
  title: 'Stop Electron app',
  description: [
    'Gracefully stop a session and release it. If the app ignores the close within timeoutMs',
    '(default 10s) the stop auto-escalates to SIGKILL, so the process is always reaped and never',
    'left orphaned; the response reports escalated: true when that happened.',
    'Pass sessionId to target a specific session.',
    'Returns: { ok, session_id, stopped: true, escalated }.',
    'Errors: NOT_RUNNING (no such session; not retryable), BAD_ARGUMENT (multiple sessions live — pass sessionId).',
  ].join(' '),
  inputSchema: stopInput,
  operationType: 'command',
  // Ends the session and closes the app — a destructive, non-undoable action.
  annotations: { destructiveHint: true },
  handler: async (args, ctx) => {
    const managed = ctx.sessions.resolve(args.sessionId)
    let escalated = false
    try {
      const result = await ctx.sessions.remove(managed.id, {
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      })
      escalated = result.escalated
    } finally {
      ctx.snapshots.clear(managed.id)
    }
    return makeSuccess(
      { session_id: managed.id, stopped: true, escalated },
      { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id },
    )
  },
})

/** `electron_force_kill` — SIGKILL escape hatch. */
export const forceKillTool: AnyToolDefinition = defineTool({
  name: 'electron_force_kill',
  title: 'Force-kill Electron app',
  description: [
    'Forcefully kill a session (SIGKILL) and release it — the escape hatch when stop hangs.',
    'Pass sessionId to target a specific session. Returns: { ok, session_id, killed: true }.',
    'Errors: NOT_RUNNING (no such session; not retryable), BAD_ARGUMENT (multiple sessions live — pass sessionId).',
  ].join(' '),
  inputSchema: sessionOnly,
  operationType: 'command',
  // SIGKILLs the app and releases the session — destructive and non-undoable.
  annotations: { destructiveHint: true },
  handler: async (args, ctx) => {
    const managed = ctx.sessions.resolve(args.sessionId)
    try {
      await ctx.sessions.remove(managed.id, { force: true })
    } finally {
      ctx.snapshots.clear(managed.id)
    }
    return makeSuccess(
      { session_id: managed.id, killed: true },
      { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id },
    )
  },
})

/**
 * `electron_detach` — disconnect without stopping. Not yet supported by any
 * transport (a launched app is owned by its session, so disconnecting closes
 * it). Resolves the session to give a precise error, then returns
 * `TRANSPORT_UNSUPPORTED` with a pointer to `electron_stop`.
 */
export const detachTool: AnyToolDefinition = defineTool({
  name: 'electron_detach',
  title: 'Detach from Electron app',
  description: [
    'Disconnect from an app without stopping it. Not yet supported by any transport',
    '(detaching from a launched app is indistinguishable from stopping it today).',
    'Returns TRANSPORT_UNSUPPORTED; use electron_stop to end the session.',
    'Errors: TRANSPORT_UNSUPPORTED (not retryable), NOT_RUNNING (no such session), BAD_ARGUMENT (multiple sessions).',
  ].join(' '),
  inputSchema: sessionOnly,
  operationType: 'command',
  handler: async (args, ctx) => {
    const managed = ctx.sessions.resolve(args.sessionId)
    return makeError('TRANSPORT_UNSUPPORTED', {
      message: `Transport "${managed.transport.id}" cannot detach without stopping the app.`,
      details: { transport: managed.transport.id, capability: 'detach' },
      next_actions: ['electron_stop()'],
      startedAt: ctx.startedAt,
      now: ctx.now,
      session_id: managed.id,
    })
  },
})
