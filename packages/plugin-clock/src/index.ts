/**
 * `@electron-stagewright/plugin-clock` — deterministic virtual-time control for testing time-dependent
 * UI (ADR-017, built on the ADR-004 plugin contract). Install a fake clock over the renderer's `Date` /
 * `setTimeout` / `setInterval`, freeze it at a chosen instant, and advance it by an exact amount to fire
 * the app's timers on demand — so a "session expires in 30s" banner, a countdown, a debounce, or a
 * midnight rollover can be driven deterministically instead of waiting real wall-clock seconds.
 *
 * Like the network plugin, the tools ride a dedicated TRANSPORT SEAM (install / set / advance / resume),
 * not eval, so this plugin is NOT `--allow-eval` gated. It IS gated on the transport's `canControlClock`
 * capability (`clock.UNSUPPORTED` otherwise). Tools (namespaced by the loader): `clock_install`,
 * `clock_set_time`, `clock_set_system_time`, `clock_advance`, `clock_run_for`, `clock_pause`,
 * `clock_resume`, `clock_status`.
 *
 * Clock control ALTERS app behaviour (it changes what time the app sees and fires its timers), so it is
 * bounded the same way as the other modify-capable plugins: the `canControlClock` capability and the
 * operator-loaded plugin. It is not a secret surface.
 *
 * @module
 */

import {
  defineTool,
  makePluginError,
  makeSuccess,
  type AnyToolDefinition,
  type ClockTime,
  type StagewrightPlugin,
  type ToolContext,
  type ToolResult,
  type TransportSession,
} from '@electron-stagewright/core'
import { z } from 'zod'

/** Plugin namespace — must match {@link clockPlugin.name}; the loader prefixes its tools with it. */
const CLOCK_NAMESPACE = 'clock'
/** Plugin package version advertised by `electron_plugins`; keep in sync with package.json. */
const CLOCK_PLUGIN_VERSION = '0.1.0'

function isParseableClockTime(value: string): boolean {
  return Number.isFinite(Date.parse(value))
}

/** A clock instant: epoch milliseconds (a number) or an ISO-8601 string. */
const timeSchema = z
  .union([
    z.number().int().nonnegative(),
    z.string().trim().min(1).refine(isParseableClockTime, {
      message: 'time must be epoch milliseconds or a parseable date-time string.',
    }),
  ])
  .describe(
    'An instant: epoch milliseconds (number) or an ISO-8601 string (e.g. 2026-01-01T00:00:00Z).',
  )

/** A forward duration in milliseconds. */
const msSchema = z.number().int().nonnegative().describe('A forward duration in milliseconds.')

/**
 * One session's clock state, tracked so the set/advance/resume tools can refuse before an install
 * (`clock.NOT_INSTALLED`) and `clock_status` can report it. Keyed by the (globally-unique) session id,
 * so concurrent app sessions control their clocks independently. The fake clock itself lives in the
 * transport session; this map only mirrors the plugin-visible state.
 */
interface ClockState {
  /** The last clock op applied, for `clock_status`. */
  readonly mode: 'installed' | 'fixed' | 'system' | 'paused' | 'running'
  /** The last instant set (install/setFixedTime/setSystemTime/pause), when one was given. */
  readonly time?: ClockTime
}

// Module-level state, keyed by the transport's globally-unique session id (like the other plugins). The
// map is process-global, so co-resident servers in the SAME process share it — run independent
// lifecycles in separate Node processes for full isolation.
const clocks = new Map<string, ClockState>()

/** The envelope meta a plugin tool threads into `makeSuccess` / `makePluginError`. */
interface PluginMeta {
  readonly startedAt: number
  readonly now: () => number
}

/**
 * Resolve the session + assert its transport can control the clock (`canControlClock`). Returns the
 * session, or the plugin-error envelope to return instead. Not eval-gated — clock control is a
 * transport seam, not arbitrary JS.
 */
function requireClock(
  ctx: ToolContext,
  sessionId: string | undefined,
  meta: PluginMeta,
): { session: TransportSession; sessionId: string } | { error: ToolResult } {
  // resolve throws a core StagewrightError (NOT_RUNNING / BAD_ARGUMENT) the dispatcher maps to an
  // envelope, so an unknown/absent/ambiguous session needs no handling here.
  const managed = ctx.sessions.resolve(sessionId)
  if (!managed.transport.capabilities.canControlClock) {
    return {
      error: makePluginError('clock.UNSUPPORTED', {
        ...meta,
        message:
          'This session’s transport cannot control the clock; use the default Playwright launch transport.',
      }),
    }
  }
  return { session: managed.session, sessionId: managed.id }
}

/** The NOT_INSTALLED envelope for a set/advance/resume call before a clock was installed. */
function notInstalled(sessionId: string, meta: PluginMeta): ToolResult {
  return makePluginError('clock.NOT_INSTALLED', {
    ...meta,
    message: `No fake clock is installed on session ${sessionId}; call clock_install first.`,
    details: { sessionId },
  })
}

/** Resolve the session, assert the capability, AND assert a clock is installed (for the post-install ops). */
function requireInstalled(
  ctx: ToolContext,
  sessionId: string | undefined,
  meta: PluginMeta,
): { session: TransportSession; sessionId: string } | { error: ToolResult } {
  const guard = requireClock(ctx, sessionId, meta)
  if ('error' in guard) return guard
  if (!clocks.has(guard.sessionId)) return { error: notInstalled(guard.sessionId, meta) }
  return guard
}

const sessionField = {
  sessionId: z.string().optional().describe('Target session; defaults to the only session.'),
}

const installTool: AnyToolDefinition = defineTool({
  name: 'install',
  title: 'Install a fake clock',
  description: [
    'Install a fake clock over the renderer’s Date / setTimeout / setInterval, optionally starting at',
    '`time` (epoch ms or ISO-8601). Required before any other clock tool. Re-installing replaces the',
    'fake clock. Returns: { ok, installed, time? }. Errors: clock.UNSUPPORTED (transport cannot control',
    'the clock), NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({
    time: timeSchema
      .optional()
      .describe('Optional start instant; omit to install at the current time.'),
    ...sessionField,
  }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireClock(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    await guard.session.installClock(args.time !== undefined ? { time: args.time } : {})
    clocks.set(
      guard.sessionId,
      args.time !== undefined ? { mode: 'installed', time: args.time } : { mode: 'installed' },
    )
    return makeSuccess(
      { installed: true, ...(args.time !== undefined ? { time: args.time } : {}) },
      meta,
    )
  },
})

const setTimeTool: AnyToolDefinition = defineTool({
  name: 'set_time',
  title: 'Freeze the clock at a fixed time',
  description: [
    'Pin the clock to `time` (a frozen instant): Date.now() returns it and timers do NOT auto-fire — use',
    'clock_advance to fire them. Returns: { ok, fixed }. Errors: clock.NOT_INSTALLED (call clock_install',
    'first), clock.UNSUPPORTED, NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({ time: timeSchema, ...sessionField }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireInstalled(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    await guard.session.setFixedTime(args.time)
    clocks.set(guard.sessionId, { mode: 'fixed', time: args.time })
    return makeSuccess({ fixed: args.time }, meta)
  },
})

const setSystemTimeTool: AnyToolDefinition = defineTool({
  name: 'set_system_time',
  title: 'Set the clock and let it keep running',
  description: [
    'Set the clock to `time` and let it keep running from there (timers fire as wall-clock time advances',
    'them), unlike the frozen clock_set_time. Returns: { ok, systemTime }. Errors: clock.NOT_INSTALLED,',
    'clock.UNSUPPORTED, NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({ time: timeSchema, ...sessionField }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireInstalled(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    await guard.session.setSystemTime(args.time)
    clocks.set(guard.sessionId, { mode: 'system', time: args.time })
    return makeSuccess({ systemTime: args.time }, meta)
  },
})

const advanceTool: AnyToolDefinition = defineTool({
  name: 'advance',
  title: 'Jump the clock forward',
  description: [
    'Jump the clock forward by `ms`, firing every timer due in that window in order, then stopping at the',
    'destination. The deterministic way to trigger time-based UI without real waiting. Returns:',
    '{ ok, advancedMs }. Errors: clock.NOT_INSTALLED, clock.UNSUPPORTED, NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({ ms: msSchema, ...sessionField }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireInstalled(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    await guard.session.advanceClock(args.ms)
    return makeSuccess({ advancedMs: args.ms }, meta)
  },
})

const runForTool: AnyToolDefinition = defineTool({
  name: 'run_for',
  title: 'Tick the clock forward',
  description: [
    'Tick the clock forward by `ms`, firing timers at each interval as they come due and simulating the',
    'passage of time between them — unlike clock_advance, which fires the due timers and jumps straight',
    'to the destination. Use for tight timer loops that re-schedule. Returns: { ok, ranForMs }. Errors:',
    'clock.NOT_INSTALLED, clock.UNSUPPORTED, NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({ ms: msSchema, ...sessionField }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireInstalled(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    await guard.session.runClockFor(args.ms)
    return makeSuccess({ ranForMs: args.ms }, meta)
  },
})

const pauseTool: AnyToolDefinition = defineTool({
  name: 'pause',
  title: 'Fast-forward to a time and hold',
  description: [
    'Fast-forward to `time` firing the timers due up to it, then HOLD there (a frozen pause at a future',
    'instant). Returns: { ok, pausedAt }. Errors: clock.NOT_INSTALLED, clock.UNSUPPORTED, NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({ time: timeSchema, ...sessionField }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireInstalled(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    await guard.session.pauseClockAt(args.time)
    clocks.set(guard.sessionId, { mode: 'paused', time: args.time })
    return makeSuccess({ pausedAt: args.time }, meta)
  },
})

const resumeTool: AnyToolDefinition = defineTool({
  name: 'resume',
  title: 'Resume the real clock',
  description: [
    'Resume the real clock (timers advance with real wall-clock time again). Returns: { ok, resumed }.',
    'Errors: clock.NOT_INSTALLED, clock.UNSUPPORTED, NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({ ...sessionField }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireInstalled(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    await guard.session.resumeClock()
    clocks.set(guard.sessionId, { mode: 'running' })
    return makeSuccess({ resumed: true }, meta)
  },
})

const statusTool: AnyToolDefinition = defineTool({
  name: 'status',
  title: 'Report the clock state',
  description: [
    'Report whether a fake clock is installed on the session and its last applied mode/time, so an agent',
    'can branch. Returns: { ok, installed, mode?, time? }. Errors: clock.UNSUPPORTED, NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({ ...sessionField }),
  operationType: 'query',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireClock(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    const state = clocks.get(guard.sessionId)
    if (state === undefined) return makeSuccess({ installed: false }, meta)
    return makeSuccess(
      {
        installed: true,
        mode: state.mode,
        ...(state.time !== undefined ? { time: state.time } : {}),
      },
      meta,
    )
  },
})

/**
 * The clock plugin. Load with `--plugin @electron-stagewright/plugin-clock` (NO eval flag — it does not
 * run app JS) or `createServer({ plugins: [clockPlugin] })`. No configuration.
 */
export const clockPlugin: StagewrightPlugin = {
  name: CLOCK_NAMESPACE,
  version: CLOCK_PLUGIN_VERSION,
  coreVersionRange: '*',
  errorCodes: {
    UNSUPPORTED: {
      http: 409,
      retryable: false,
      hint: 'This transport cannot control the clock; use the default Playwright launch transport.',
    },
    NOT_INSTALLED: {
      http: 409,
      retryable: false,
      hint: 'No fake clock is installed on this session; call clock_install first.',
    },
  },
  tools: [
    installTool,
    setTimeTool,
    setSystemTimeTool,
    advanceTool,
    runForTool,
    pauseTool,
    resumeTool,
    statusTool,
  ],
  teardown: async () => {
    // Forget every session's clock state. The fake clock lives in the transport session, which the
    // server stops before plugin teardown.
    clocks.clear()
  },
}

export default clockPlugin
