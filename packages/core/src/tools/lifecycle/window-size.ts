/**
 * `electron_set_window_size` — resize a native window without eval and report the size it really
 * got, since an app's minimum or maximum size (or the screen) silently clamps the request.
 *
 * @module
 */

import { z } from 'zod'

import { makeError, makeSuccess } from '../../errors/envelope.js'
import type { WindowSize } from '../../transports/index.js'
import { sessionIdField } from '../schema.js'
import { type AnyToolDefinition, defineTool } from '../types.js'

const MAX_DIMENSION = 16_384

const dimension = (what: string) =>
  z.number().int().min(1).max(MAX_DIMENSION).describe(`${what} in device-independent pixels.`)

/** Why the window did not take the requested size. */
function clampedBy(
  requested: WindowSize,
  minimum: WindowSize | null,
  maximum: WindowSize | null,
): 'minimum_size' | 'maximum_size' | 'window_system' {
  if (minimum !== null && (requested.width < minimum.width || requested.height < minimum.height)) {
    return 'minimum_size'
  }
  const over = (value: number, limit: number) => limit > 0 && value > limit
  if (
    maximum !== null &&
    (over(requested.width, maximum.width) || over(requested.height, maximum.height))
  ) {
    return 'maximum_size'
  }
  return 'window_system'
}

/** `electron_set_window_size` — resize the active (or given) window and report the result. */
export const setWindowSizeTool: AnyToolDefinition = defineTool({
  name: 'electron_set_window_size',
  title: 'Set a window’s size',
  description: [
    'Resize the active window (or windowId) to width x height, of the whole window or, with',
    'area "content", of its web content, without eval. Waits for the size to settle and reports',
    'what the window really got: an app minimum/maximum size or the screen can clamp it.',
    'A maximized or fullscreen window is restored first. Returns: { ok, session_id, window_id,',
    'requested, actual, clamped, clamped_by?, window, content, min_size, max_size, restored_from?,',
    'method }; clamped_by is minimum_size, maximum_size or window_system; min_size/max_size are',
    'null when unset or unknown. CDP attach resizes from the page: it cannot read the limits, and',
    'content is the page viewport in CSS pixels (scaled by page zoom). Errors:',
    'REF_NOT_FOUND (no such window), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT.',
  ].join(' '),
  inputSchema: z.object({
    width: dimension('Width'),
    height: dimension('Height'),
    area: z
      .enum(['window', 'content'])
      .optional()
      .describe('Size the whole window (default) or only its web content area.'),
    windowId: z
      .string()
      .optional()
      .describe('Window to resize (from electron_windows_list). Default: active.'),
    sessionId: sessionIdField,
  }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const managed = ctx.sessions.resolve(args.sessionId)
    const meta = { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id }
    const windows = await managed.session.windowsList()
    const window =
      args.windowId !== undefined
        ? windows.find((candidate) => candidate.id === args.windowId)
        : (windows.find((candidate) => candidate.focused) ?? windows[0])
    if (window === undefined) {
      return makeError('REF_NOT_FOUND', {
        ...meta,
        message:
          args.windowId !== undefined
            ? `No window with id "${args.windowId}".`
            : 'No Electron window to resize.',
        next_actions: ['electron_windows_list()'],
      })
    }
    const area = args.area ?? 'window'
    const result = await managed.session.setWindowSize(
      { kind: 'id', id: window.id },
      { width: args.width, height: args.height, content: area === 'content' },
    )
    const actual = area === 'content' ? result.content : result.outer
    const clamped = actual.width !== args.width || actual.height !== args.height
    // Limits apply to the outer size, so a content request is compared with the frame added.
    const requestedOuter =
      area === 'content'
        ? {
            width: args.width + result.outer.width - result.content.width,
            height: args.height + result.outer.height - result.content.height,
          }
        : { width: args.width, height: args.height }
    return makeSuccess(
      {
        session_id: managed.id,
        window_id: window.id,
        requested: { width: args.width, height: args.height, area },
        actual,
        clamped,
        ...(clamped
          ? { clamped_by: clampedBy(requestedOuter, result.minimum, result.maximum) }
          : {}),
        window: result.outer,
        content: result.content,
        min_size: result.minimum,
        max_size: result.maximum,
        ...(result.restored_from !== undefined ? { restored_from: result.restored_from } : {}),
        method: result.method,
      },
      meta,
    )
  },
})
