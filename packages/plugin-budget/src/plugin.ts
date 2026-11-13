/**
 * The MCP face of the budget: `budget_start`, `budget_measure`, `budget_check`.
 *
 * Runtime metrics run fixed bodies in the app's main process, so they need the main eval grant;
 * the IPC probe and startup timing also need the renderer. Bundle size needs neither, nor a session.
 *
 * @module
 */

import path from 'node:path'

import {
  defineTool,
  fnv1a32,
  makeError,
  makePluginError,
  makeSuccess,
  readPackageVersion,
  type AnyToolDefinition,
  type StagewrightPlugin,
  type ToolContext,
  type ToolResult,
  type TransportSession,
} from '@electron-stagewright/core'
import {
  createPluginConfigState,
  createSessionCleanup,
  sessionIdField,
} from '@electron-stagewright/core/plugin-sdk'
import { z } from 'zod'

import { BudgetFileError, loadBudget, type Budget } from './budget.js'
import { measureBundle } from './bundle.js'
import { checkRun } from './check.js'
import { DEFAULT_WINDOW_MS } from './probe.js'
import { createRun, summarizeRun, type BudgetRun, type Measurement } from './run.js'
import {
  MAIN_EVAL_OFF,
  RENDERER_EVAL_OFF,
  measureSession,
  startWindow,
  type IpcProbe,
} from './session.js'

const BUDGET_NAMESPACE = 'budget'
const BUDGET_PLUGIN_VERSION = readPackageVersion(import.meta.url)
const BUDGET_INTROSPECTION = {
  requirements: {
    evalTargets: ['main', 'renderer'],
    transportCapabilities: ['supportsMainEval', 'supportsRendererEval'],
  },
  config: { safeFields: ['budgetFile', 'root', 'windowMs'] },
} as const

const windowMsSchema = z.number().int().min(250).max(120_000)

const configSchema = z.object({
  budgetFile: z
    .string()
    .optional()
    .describe('Absolute path of the budget file budget_check reads when budgetPath is omitted.'),
  root: z
    .string()
    .optional()
    .describe('Directory bundle entries resolve from. Defaults to the budget file directory.'),
  windowMs: windowMsSchema
    .default(DEFAULT_WINDOW_MS)
    .describe('Length (ms) of the measurement window when budget_start did not open one.'),
})
type BudgetConfig = z.infer<typeof configSchema>
const DEFAULT_CONFIG: BudgetConfig = { windowMs: DEFAULT_WINDOW_MS }

interface Meta {
  readonly startedAt: number
  readonly now: () => number
}

interface RuntimeTarget {
  readonly session: TransportSession
  readonly id: string
  readonly renderer: { readonly allowRenderer: boolean; readonly rendererOff?: string }
}

type OpenWindow = { readonly ipc: boolean; readonly ipcUnavailable?: string }

const budgetPathField = {
  budgetPath: z
    .string()
    .min(1)
    .optional()
    .describe('Absolute path of the budget JSON file. Defaults to the configured budgetFile.'),
} as const

export function createBudgetPlugin(): StagewrightPlugin {
  const config = createPluginConfigState(DEFAULT_CONFIG)
  const windows = new Map<string, OpenWindow>()
  const sessionCleanup = createSessionCleanup(
    (sessionId) => windows.delete(sessionId),
    () => {
      windows.clear()
      config.reset()
    },
  )

  function escapes(root: string, target: string, meta: Meta): ToolResult | undefined {
    const relative = path.relative(root, path.resolve(target))
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return undefined
    }
    return makeError('BAD_ARGUMENT', {
      ...meta,
      message: `Path must resolve within ${root}; "${target}" is outside it.`,
      details: { root, path: target },
    })
  }

  /** With `--app-root` set, files the tools read must sit inside it. */
  function outsideAppRoot(ctx: ToolContext, target: string, meta: Meta): ToolResult | undefined {
    return ctx.appRoot === undefined ? undefined : escapes(ctx.appRoot, target, meta)
  }

  /** The IPC probe is caller-supplied renderer code: leave the same audit trail as an eval tool. */
  function auditProbe(
    ctx: ToolContext,
    tool: string,
    sessionId: string,
    ipc: IpcProbe | undefined,
  ) {
    if (ipc === undefined || !ctx.allowEvalRenderer) return
    ctx.logger.info('eval invoked', {
      tool,
      target: 'renderer',
      session_id: sessionId,
      code_length: ipc.probe.length,
      code_hash: fnv1a32(ipc.probe),
    })
  }

  /** Load the named or configured budget, or return the error envelope. */
  async function resolveBudget(
    ctx: ToolContext,
    budgetPath: string | undefined,
    meta: Meta,
    required: boolean,
  ): Promise<{ budget?: Budget; budgetPath?: string } | { error: ToolResult }> {
    const target = budgetPath ?? config.current.budgetFile
    if (target === undefined) {
      if (!required) return {}
      return {
        error: makePluginError('budget.NO_BUDGET', {
          ...meta,
          message: 'No budget file: pass budgetPath or configure pluginConfigs.budget.budgetFile.',
        }),
      }
    }
    if (!path.isAbsolute(target)) {
      return {
        error: makeError('ABSOLUTE_PATH_REQUIRED', {
          ...meta,
          message: `budgetPath must be absolute, got ${target}`,
          details: { budget_path: target },
        }),
      }
    }
    const outside = outsideAppRoot(ctx, target, meta)
    if (outside !== undefined) return { error: outside }
    try {
      return { budget: await loadBudget(target), budgetPath: target }
    } catch (error) {
      if (!(error instanceof BudgetFileError)) throw error
      return {
        error: makePluginError(`budget.${error.code}`, {
          ...meta,
          message: error.message,
          details: { budget_path: target },
        }),
      }
    }
  }

  /** The session to measure, or the reason runtime metrics are unavailable. */
  function runtimeSession(
    ctx: ToolContext,
    sessionId: string | undefined,
  ):
    | RuntimeTarget
    | { unavailable: string; code: 'budget.EVAL_REQUIRED' | 'budget.MAIN_EVAL_UNSUPPORTED' } {
    if (!ctx.allowEval) return { unavailable: MAIN_EVAL_OFF, code: 'budget.EVAL_REQUIRED' }
    const managed = ctx.sessions.resolve(sessionId)
    const capabilities = managed.transport.capabilities
    if (!capabilities.supportsMainEval) {
      return {
        unavailable: 'this session’s transport cannot evaluate in the main process',
        code: 'budget.MAIN_EVAL_UNSUPPORTED',
      }
    }
    const rendererOff = !ctx.allowEvalRenderer
      ? RENDERER_EVAL_OFF
      : capabilities.supportsRendererEval
        ? undefined
        : 'this session’s transport cannot evaluate in the renderer'
    return {
      session: managed.session,
      id: managed.id,
      renderer: {
        allowRenderer: rendererOff === undefined,
        ...(rendererOff === undefined ? {} : { rendererOff }),
      },
    }
  }

  function ipcProbe(
    args: { ipcProbe?: string | undefined; ipcIntervalMs?: number | undefined },
    budget: Budget | undefined,
  ): IpcProbe | undefined {
    const probe = args.ipcProbe ?? budget?.ipc?.probe
    const intervalMs = args.ipcIntervalMs ?? budget?.ipc?.intervalMs
    if (probe === undefined) return undefined
    return { probe, ...(intervalMs === undefined ? {} : { intervalMs }) }
  }

  async function measureLive(
    ctx: ToolContext,
    target: RuntimeTarget,
    options: { windowMs?: number | undefined; ipc?: IpcProbe | undefined; budget?: Budget },
  ): Promise<{ run: BudgetRun; measurement: Measurement }> {
    const open = windows.get(target.id)
    windows.delete(target.id)
    if (open === undefined) auditProbe(ctx, 'budget_measure', target.id, options.ipc)
    const measured = await measureSession(target.session, {
      ...target.renderer,
      windowMs: options.windowMs ?? options.budget?.mainThread?.windowMs ?? config.current.windowMs,
      ...(open === undefined ? {} : { open }),
      ...(options.ipc === undefined ? {} : { ipc: options.ipc }),
    })
    const run = createRun({
      rounds: [{ round: 1, phase: 'live', measurement: measured.measurement }],
      ...(measured.electronVersion === undefined
        ? {}
        : { electronVersion: measured.electronVersion }),
    })
    // The app may run on another OS than this server only in theory; trust what it reports.
    return { run: { ...run, platform: measured.platform }, measurement: measured.measurement }
  }

  const runtimeError = (
    meta: Meta,
    target: { unavailable: string; code: 'budget.EVAL_REQUIRED' | 'budget.MAIN_EVAL_UNSUPPORTED' },
  ): ToolResult => makePluginError(target.code, { ...meta, message: target.unavailable })

  const startTool: AnyToolDefinition = defineTool({
    name: 'start',
    title: 'Open a performance measurement window',
    description: [
      'Start sampling main-thread blocking (and IPC round trips, when a probe is known) on the',
      'running app, then drive the app with other tools and call budget_measure or budget_check to',
      'close the window and read it. Without budget_start those tools measure an idle window.',
      'The IPC probe is the renderer expression in ipcProbe, else the budget file ipc.probe; it',
      'needs renderer eval. Starting again replaces the open window.',
      'Returns: { ok, started, ipc_probe, ipc_unavailable? }. Errors: budget.EVAL_REQUIRED (main',
      'eval is off), budget.MAIN_EVAL_UNSUPPORTED (transport lacks it), NOT_RUNNING (no session), budget.BUDGET_NOT_FOUND,',
      'budget.BUDGET_INVALID, ABSOLUTE_PATH_REQUIRED.',
    ].join(' '),
    inputSchema: z.object({
      ...sessionIdField,
      ...budgetPathField,
      ipcProbe: z
        .string()
        .min(1)
        .optional()
        .describe('Renderer expression doing one IPC round trip, e.g. window.api.getVersion().'),
      ipcIntervalMs: z.number().int().min(1).max(1000).optional().describe('Probe spacing in ms.'),
    }),
    operationType: 'command',
    requiresEvalFlag: true,
    evalTarget: 'main',
    handler: async (args, ctx) => {
      const meta = { startedAt: ctx.startedAt, now: ctx.now }
      const target = runtimeSession(ctx, args.sessionId)
      if ('unavailable' in target) return runtimeError(meta, target)
      const loaded = await resolveBudget(ctx, args.budgetPath, meta, false)
      if ('error' in loaded) return loaded.error
      const ipc = ipcProbe(args, loaded.budget)
      auditProbe(ctx, 'budget_start', target.id, ipc)
      const open = await startWindow(target.session, {
        ...target.renderer,
        ...(ipc === undefined ? {} : { ipc }),
      })
      windows.set(target.id, open)
      return makeSuccess(
        {
          started: true,
          ipc_probe: open.ipc,
          ...(open.ipcUnavailable === undefined ? {} : { ipc_unavailable: open.ipcUnavailable }),
        },
        meta,
      )
    },
  })

  const measureTool: AnyToolDefinition = defineTool({
    name: 'measure',
    title: 'Measure the running app',
    description: [
      'Measure the running app without judging it: startup to first window, memory summed per',
      'process type in the platform metric (footprint on macOS, pss on Linux, privateBytes on',
      'Windows) plus workingSet, main-thread blocking, and IPC latency when a probe is known.',
      'Closes the window budget_start opened, or measures an idle window of windowMs.',
      'Returns: { ok, electron_version?, platform, measured: [{ id, value, unit, metric? }],',
      'unavailable?: { <metric>: reason } }. Errors: budget.EVAL_REQUIRED,',
      'budget.MAIN_EVAL_UNSUPPORTED, NOT_RUNNING,',
      'budget.BUDGET_NOT_FOUND, budget.BUDGET_INVALID, ABSOLUTE_PATH_REQUIRED.',
    ].join(' '),
    inputSchema: z.object({
      ...sessionIdField,
      ...budgetPathField,
      windowMs: windowMsSchema.optional().describe('Idle window length in ms (default 2000).'),
      ipcProbe: z.string().min(1).optional().describe('Renderer expression for the IPC probe.'),
    }),
    operationType: 'query',
    requiresEvalFlag: true,
    evalTarget: 'main',
    handler: async (args, ctx) => {
      const meta = { startedAt: ctx.startedAt, now: ctx.now }
      const target = runtimeSession(ctx, args.sessionId)
      if ('unavailable' in target) return runtimeError(meta, target)
      const loaded = await resolveBudget(ctx, args.budgetPath, meta, false)
      if ('error' in loaded) return loaded.error
      const { run, measurement } = await measureLive(ctx, target, {
        windowMs: args.windowMs,
        ipc: ipcProbe(args, loaded.budget),
        ...(loaded.budget === undefined ? {} : { budget: loaded.budget }),
      })
      return makeSuccess(
        {
          ...(run.electron_version === undefined ? {} : { electron_version: run.electron_version }),
          platform: run.platform,
          measured: summarizeRun(run).map(({ id, value, unit, metric }) => ({
            id,
            value,
            unit,
            ...(metric === undefined ? {} : { metric }),
          })),
          ...(measurement.unavailable === undefined
            ? {}
            : { unavailable: measurement.unavailable }),
        },
        meta,
      )
    },
  })

  const checkTool: AnyToolDefinition = defineTool({
    name: 'check',
    title: 'Check the app against its performance budget',
    description: [
      'Answer "did my change break a performance budget?": measure the running app and the bundle',
      'entries, then compare them to the budget file. passed is false when any limit is exceeded',
      'and when nothing could be measured. Each result is pass, fail, or unmeasured (with the',
      'reason); requireMeasurement turns unmeasured into a failure, strict removes the tolerance.',
      'Runtime metrics need a session and main eval; without them only bundle size is checked.',
      'Returns: { ok, passed, reason?, budget_path, summary: { pass, fail, unmeasured },',
      'results: [{ id, status, actual?, limit, allowed, unit, metric?, detail? }] }.',
      'Errors: budget.NO_BUDGET, budget.BUDGET_NOT_FOUND, budget.BUDGET_INVALID,',
      'ABSOLUTE_PATH_REQUIRED, BAD_ARGUMENT (unknown sessionId, or a path outside --app-root).',
    ].join(' '),
    inputSchema: z.object({
      ...sessionIdField,
      ...budgetPathField,
      windowMs: windowMsSchema.optional().describe('Idle window length in ms.'),
      strict: z.boolean().optional().describe('Ignore thresholdPercent.'),
      requireMeasurement: z.boolean().optional().describe('Fail budgeted metrics left unmeasured.'),
    }),
    operationType: 'query',
    handler: async (args, ctx) => {
      const meta = { startedAt: ctx.startedAt, now: ctx.now }
      const loaded = await resolveBudget(ctx, args.budgetPath, meta, true)
      if ('error' in loaded) return loaded.error
      const budget = loaded.budget as Budget
      const budgetPath = loaded.budgetPath as string

      const noSession = args.sessionId === undefined && ctx.sessions.size === 0
      const target = noSession
        ? { unavailable: 'no app session is running; launch or attach first' as string }
        : runtimeSession(ctx, args.sessionId)
      let run: BudgetRun
      if ('unavailable' in target) {
        const reason = target.unavailable
        const unavailable = { startup: reason, memory: reason, mainThread: reason, ipc: reason }
        run = createRun({ rounds: [{ round: 1, phase: 'live', measurement: { unavailable } }] })
      } else {
        run = (
          await measureLive(ctx, target, {
            windowMs: args.windowMs,
            ipc: ipcProbe({}, budget),
            budget,
          })
        ).run
      }
      if (budget.bundle !== undefined) {
        const root = config.current.root ?? path.dirname(budgetPath)
        for (const entry of budget.bundle.entries) {
          // An agent can name the budget file, so its entries may not climb out of the root.
          const target = path.resolve(root, entry.path)
          const outside =
            escapes(root, target, meta) ?? (ctx.appRoot && escapes(ctx.appRoot, target, meta))
          if (outside) return outside
        }
        run = { ...run, bundle: await measureBundle(root, budget.bundle.entries) }
      }
      const report = checkRun(run, budget, {
        phase: 'live',
        strict: args.strict === true,
        requireMeasurement: args.requireMeasurement === true,
      })
      return makeSuccess(
        {
          passed: report.passed,
          ...(report.reason === undefined ? {} : { reason: report.reason }),
          budget_path: budgetPath,
          summary: report.summary,
          results: report.results.map(({ phase: _phase, ...result }) => result),
        },
        meta,
      )
    },
  })

  return {
    name: BUDGET_NAMESPACE,
    version: BUDGET_PLUGIN_VERSION,
    coreVersionRange: '*',
    configSchema,
    introspection: BUDGET_INTROSPECTION,
    errorCodes: {
      EVAL_REQUIRED: {
        http: 403,
        retryable: false,
        hint: 'Runtime budget metrics run in the main process; start the server with --allow-eval=main (or bare --allow-eval to include the IPC probe and startup timing).',
      },
      MAIN_EVAL_UNSUPPORTED: {
        http: 409,
        retryable: false,
        hint: 'This transport has no main-process eval (CDP attach, or a packaged launch); launch with a main entry or inject to measure runtime metrics.',
      },
      NO_BUDGET: {
        http: 400,
        retryable: false,
        hint: 'Pass budgetPath, or set pluginConfigs.budget.budgetFile to the absolute path of the budget JSON.',
      },
      BUDGET_NOT_FOUND: {
        http: 404,
        retryable: false,
        hint: 'No readable file at budgetPath; pass the absolute path of the budget JSON.',
      },
      BUDGET_INVALID: {
        http: 400,
        retryable: false,
        hint: 'The budget file is not valid JSON or has an unknown or mistyped key; the message names it.',
      },
    },
    tools: [startTool, measureTool, checkTool],
    setup: (raw, context) => {
      config.set(raw as BudgetConfig)
      sessionCleanup.setup(context)
    },
    teardown: async () => {
      sessionCleanup.teardown()
    },
  }
}

/** Load with `--plugin budget` or `createServer({ plugins: [budgetPlugin] })`. */
export const budgetPlugin: StagewrightPlugin = {
  name: BUDGET_NAMESPACE,
  version: BUDGET_PLUGIN_VERSION,
  coreVersionRange: '*',
  get tools() {
    return createBudgetPlugin().tools ?? []
  },
  get errorCodes() {
    return createBudgetPlugin().errorCodes ?? {}
  },
  get configSchema() {
    return configSchema
  },
  introspection: BUDGET_INTROSPECTION,
  createInstance: createBudgetPlugin,
}
