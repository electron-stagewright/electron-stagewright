/** Compact orientation over the live server and its sessions. */

import { z } from 'zod'

import { makeSuccess } from '../../errors/envelope.js'
import type { ManagedSession } from '../../server/session-manager.js'
import type { DialogPolicy, SurfaceDescriptor } from '../../transports/index.js'
import { VERSION } from '../../version.js'
import { type AnyToolDefinition, type ToolContext, defineTool } from '../types.js'

/** Keep the response compact and never disclose a prompt value through status. */
function compactDialogPolicy(policy: DialogPolicy): Record<string, unknown> | undefined {
  const perType = policy.perType === undefined ? [] : Object.entries(policy.perType)
  const armed = policy.action !== 'dismiss' || perType.length > 0 || policy.oneShot === true
  if (!armed) return undefined
  return {
    armed: true,
    action: policy.action,
    ...(perType.length > 0 ? { per_type: Object.fromEntries(perType) } : {}),
    ...(policy.oneShot === true ? { one_shot: true } : {}),
  }
}

function compactSurface(surface: SurfaceDescriptor): Record<string, unknown> {
  return {
    id: surface.id,
    kind: surface.kind,
    ...(surface.title !== undefined && surface.title !== '' ? { title: surface.title } : {}),
  }
}

async function compactSession(
  managed: ManagedSession,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    session_id: managed.id,
    transport: managed.transport.id,
    renderer_ready: false,
  }
  const [surfaceResult, dialogResult] = await Promise.allSettled([
    managed.session.activeSurface(),
    managed.session.dialogEvents(),
  ])
  if (surfaceResult.status === 'fulfilled') {
    base['renderer_ready'] = true
    base['active_surface'] = compactSurface(surfaceResult.value)
  }
  if (dialogResult.status === 'fulfilled') {
    const dialog = compactDialogPolicy(dialogResult.value.policy)
    if (dialog !== undefined) base['dialog'] = dialog
  }
  const lastError = ctx.status.lastError(managed.id)
  if (lastError !== undefined) base['last_error'] = lastError
  return base
}

const DESCRIPTION = [
  'Return compact orientation for this server: version, start time, uptime, the last stable failure',
  "not tied to a live session, active-session count, and each live session's transport, renderer",
  'readiness, selected surface, last stable error code, and non-default dialog policy. It never',
  'returns arguments, paths, window arrays, logs, stack traces, dialog entries, prompt text, or',
  'plugin payloads. Use electron_windows_list, electron_surfaces_list, or the relevant plugin tool',
  'for detailed state. Returns: { ok, server: { version, started_at, uptime_ms, last_error? },',
  'active_sessions, sessions }. Errors: none.',
].join(' ')

/** `electron_status` — a bounded orientation response, not a telemetry dump. */
export const statusTool: AnyToolDefinition = defineTool({
  name: 'electron_status',
  title: 'Electron Stagewright status',
  description: DESCRIPTION,
  inputSchema: z.object({}),
  operationType: 'query',
  handler: async (_args, ctx) => {
    const sessions = await Promise.all(
      ctx.sessions.list().map((managed) => compactSession(managed, ctx)),
    )
    const uptimeMs = ctx.status.uptimeMs()
    const lastServerError = ctx.status.lastServerError?.()
    // Plugin API 1.3 status-reader mocks expose only uptime. Preserve source/runtime
    // compatibility while the server-owned reader supplies the exact start timestamp.
    const startedAt = ctx.status.startedAt?.() ?? Math.max(0, ctx.now() - uptimeMs)
    return makeSuccess(
      {
        server: {
          version: VERSION,
          started_at: startedAt,
          uptime_ms: uptimeMs,
          ...(lastServerError !== undefined ? { last_error: lastServerError } : {}),
        },
        active_sessions: sessions.length,
        sessions,
      },
      { startedAt: ctx.startedAt, now: ctx.now },
    )
  },
})
