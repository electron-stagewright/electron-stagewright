/**
 * Multi-window tools: `electron_windows_list` and `electron_switch_window`.
 *
 * windows_list enumerates the app's windows. switch_window resolves a target by
 * the documented precedence and, for the default (already-active) window, is a
 * no-op success; switching to a *different* window needs an active-window
 * concept the transport contract does not yet expose, so it honestly returns
 * `TRANSPORT_UNSUPPORTED` (and `REF_NOT_FOUND` when the target does not exist).
 *
 * @module
 */

import { z } from 'zod'

import { makeError, makeSuccess } from '../../errors/envelope.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { resolveWindow } from './window-ref.js'

/** `electron_windows_list` — enumerate the app's windows. */
export const windowsListTool: AnyToolDefinition = defineTool({
  name: 'electron_windows_list',
  title: 'List Electron windows',
  description: [
    'List the app windows with their id, index, title, url, and visibility. Pass sessionId to',
    'target a specific session. Returns: { ok, session_id, windows, count }.',
    'Errors: NOT_RUNNING (no such session; not retryable), BAD_ARGUMENT (multiple sessions — pass sessionId).',
  ].join(' '),
  inputSchema: z.object({
    sessionId: z
      .string()
      .optional()
      .describe('Target session id. Omit when a single session is running.'),
  }),
  operationType: 'window_info',
  handler: async (args, ctx) => {
    const managed = ctx.sessions.resolve(args.sessionId)
    const windows = await managed.session.windowsList()
    return makeSuccess(
      { session_id: managed.id, windows, count: windows.length },
      { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id },
    )
  },
})

/**
 * `electron_switch_window` — choose the active window by
 * `targetId > windowTitle > index > default` precedence. Switching to the
 * already-active (default) window succeeds as a no-op; switching to another
 * window is not yet supported by the transport contract.
 */
export const switchWindowTool: AnyToolDefinition = defineTool({
  name: 'electron_switch_window',
  title: 'Switch active Electron window',
  description: [
    'Select the active window by precedence targetId > windowTitle > index > default.',
    'Selecting the already-active window is a no-op success; switching to a different window is',
    'not yet supported by any transport. Returns: { ok, session_id, active } on success.',
    'Errors: REF_NOT_FOUND (no window matched; not retryable), TRANSPORT_UNSUPPORTED (cannot switch',
    'to a non-default window yet; not retryable), NOT_RUNNING, BAD_ARGUMENT (multiple sessions).',
  ].join(' '),
  inputSchema: z.object({
    targetId: z.string().optional().describe('Transport window id (highest precedence).'),
    windowTitle: z.string().optional().describe('Exact window title (second precedence).'),
    index: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('0-based window index (third precedence).'),
    sessionId: z
      .string()
      .optional()
      .describe('Target session id. Omit when a single session is running.'),
  }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const managed = ctx.sessions.resolve(args.sessionId)
    const meta = { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id }
    const windows = await managed.session.windowsList()
    const target = resolveWindow(windows, {
      ...(args.targetId !== undefined ? { targetId: args.targetId } : {}),
      ...(args.windowTitle !== undefined ? { windowTitle: args.windowTitle } : {}),
      ...(args.index !== undefined ? { index: args.index } : {}),
    })
    if (target === undefined) {
      return makeError('REF_NOT_FOUND', {
        ...meta,
        message: 'No window matched the selector.',
        details: { window_count: windows.length },
        next_actions: ['electron_windows_list()'],
      })
    }
    if (target === windows[0]) {
      // Already the default/active window — a no-op success.
      return makeSuccess({ session_id: managed.id, active: target }, meta)
    }
    return makeError('TRANSPORT_UNSUPPORTED', {
      ...meta,
      message: 'Switching to a non-default window is not yet supported by any transport.',
      details: { target_window: target, capability: 'switchWindow' },
    })
  },
})
