/**
 * Multi-window tools: `electron_windows_list` and `electron_switch_window`.
 *
 * windows_list enumerates the app's windows. switch_window resolves a target by
 * the documented precedence and makes it the transport session's active target
 * for following window-implicit operations.
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
    'target a specific session. Returns: { ok, session_id, windows, active_window_id, count }.',
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
    const active = windows.find((window) => window.focused)
    return makeSuccess(
      {
        session_id: managed.id,
        windows,
        ...(active !== undefined ? { active_window_id: active.id } : {}),
        count: windows.length,
      },
      { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id },
    )
  },
})

/**
 * `electron_switch_window` — choose the active window by
 * `targetId > windowTitle > index > default` precedence. Switching to the
 * selected target becomes the session's active renderer for subsequent
 * window-implicit operations.
 */
export const switchWindowTool: AnyToolDefinition = defineTool({
  name: 'electron_switch_window',
  title: 'Switch active Electron window',
  description: [
    'Select the active window by precedence targetId > windowTitle > index > default.',
    "The selection changes Stagewright's renderer target; it does not promise native OS foreground focus.",
    'Returns: { ok, session_id, active, active_window_id } on success.',
    'Errors: REF_NOT_FOUND (no window matched; not retryable), TRANSPORT_UNSUPPORTED (transport has no',
    'renderer window target; not retryable), NOT_RUNNING, BAD_ARGUMENT (multiple sessions).',
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
    const active = await managed.session.activateWindow({ kind: 'id', id: target.id })
    return makeSuccess({ session_id: managed.id, active, active_window_id: active.id }, meta)
  },
})
