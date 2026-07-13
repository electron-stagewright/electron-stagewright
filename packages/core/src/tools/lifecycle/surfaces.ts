/**
 * Explicit renderer-surface discovery and selection.
 *
 * Window tools stay available for compatibility; these tools are the deliberate
 * route for an iframe, webview guest, or WebContentsView renderer.
 *
 * @module
 */

import { z } from 'zod'

import { makeSuccess } from '../../errors/envelope.js'
import { assertCapability } from '../../transports/index.js'
import { type AnyToolDefinition, defineTool } from '../types.js'

/** `electron_surfaces_list` — enumerate renderer targets in parent-first order. */
export const surfacesListTool: AnyToolDefinition = defineTool({
  name: 'electron_surfaces_list',
  title: 'List Electron renderer surfaces',
  description: [
    'List the session renderer surfaces in parent-first order: BrowserWindow roots, WebContentsViews,',
    'webview guests, and iframe children. Each opaque id is stable only while its surface stays live;',
    'select it with electron_switch_surface before snapshot/find/renderer interactions. Returns:',
    '{ ok, session_id, surfaces, active_surface_id, count }. Existing window tools remain compatible',
    'for window-only flows. Errors: TRANSPORT_UNSUPPORTED (surface targeting is unavailable on this',
    'transport; not retryable), NOT_RUNNING, BAD_ARGUMENT (multiple sessions).',
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
    assertCapability(managed.transport, 'supportsSurfaceTargeting')
    const surfaces = await managed.session.surfacesList()
    const active = surfaces.find((surface) => surface.active)
    return makeSuccess(
      {
        session_id: managed.id,
        surfaces,
        ...(active !== undefined ? { active_surface_id: active.id } : {}),
        count: surfaces.length,
      },
      { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id },
    )
  },
})

/** `electron_switch_surface` — make a specific renderer the implicit target. */
export const switchSurfaceTool: AnyToolDefinition = defineTool({
  name: 'electron_switch_surface',
  title: 'Switch active renderer surface',
  description: [
    'Select a live renderer surface by the opaque id returned by electron_surfaces_list. Following',
    'snapshot, find, renderer reads/eval, waits, expectations, and interactions target that surface;',
    'a ref from a different surface is rejected rather than reused. Returns:',
    '{ ok, session_id, active, active_surface_id }. Errors: SURFACE_NOT_FOUND (the id was never',
    'observed in this session), SURFACE_CLOSED (it detached or closed), SURFACE_UNSUPPORTED (the live',
    'surface cannot be driven), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT.',
  ].join(' '),
  inputSchema: z.object({
    surfaceId: z.string().min(1).describe('Opaque id returned by electron_surfaces_list.'),
    sessionId: z
      .string()
      .optional()
      .describe('Target session id. Omit when a single session is running.'),
  }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const managed = ctx.sessions.resolve(args.sessionId)
    assertCapability(managed.transport, 'supportsSurfaceTargeting')
    const active = await managed.session.activateSurface(args.surfaceId)
    return makeSuccess(
      { session_id: managed.id, active, active_surface_id: active.id },
      { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id },
    )
  },
})
