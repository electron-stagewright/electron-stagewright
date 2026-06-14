/**
 * `@electron-stagewright/plugin-trace` — record a driving session to a portable artifact and
 * report where the token budget went (ADR-009, built on the ADR-004 plugin contract).
 *
 * The plugin subscribes to the dispatcher's dispatch-observer seam (via
 * `ToolContext.addDispatchObserver`) between `trace_start` and `trace_stop`, capturing each
 * tool call's input, output envelope, timing, and token estimate into a JSONL artifact. It is
 * the first session-observing plugin: it adds tools AND watches the whole run, without the core
 * depending on it.
 *
 * Tools (namespaced by the loader): `trace_start`, `trace_stop`, `trace_tokens`, `trace_status`,
 * `trace_budget`, `trace_replay`, and `trace_view` (render a trace to a self-contained HTML report).
 *
 * PRIVACY: a trace captures tool inputs/outputs, which may include typed text or eval payloads.
 * It is opt-in (only records between start/stop) and writes to an operator-chosen path — the
 * same trust model as screenshots and console logs. The `redact` config drops named arg fields.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  VERSION,
  defineTool,
  makePluginError,
  makeSuccess,
  type AnyToolDefinition,
  type StagewrightPlugin,
  type ToolResult,
} from '@electron-stagewright/core'
import { z } from 'zod'

import {
  Recorder,
  readTrace,
  summarizeTrace,
  budgetStatusOf,
  DEFAULT_WARN_THRESHOLD,
  type BudgetStatus,
  type ParsedTrace,
} from './recorder.js'
import { replayTrace } from './replay.js'
import { renderTraceHtml } from './viewer.js'

/**
 * The in-flight recording: its recorder plus the unsubscribe handles for the dispatch-observer
 * (always) and the budget-enforcement guard (only when started with `enforce` + a budget). Both
 * are released on `trace_stop` / teardown.
 */
interface ActiveRecording {
  readonly recorder: Recorder
  readonly unsubscribe: () => void
  readonly unguard?: () => void
}

/** Plugin namespace — must match {@link tracePlugin.name}; the loader prefixes its tools with it. */
const TRACE_NAMESPACE = 'trace'
/** Plugin package version advertised by `electron_plugins`; keep in sync with package.json. */
const TRACE_PLUGIN_VERSION = '0.0.0'

const configSchema = z.object({
  dir: z
    .string()
    .optional()
    .describe('Default directory for trace artifacts when trace_start gets no path/dir.'),
  maxRecords: z
    .number()
    .int()
    .positive()
    .default(10000)
    .describe('Max tool-call records buffered per trace; later calls are dropped (overflowed).'),
  redact: z
    .array(z.string())
    .default([])
    .describe('Argument property names to redact (replace with "[redacted]") before recording.'),
  budgetTokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Default estimated-token budget for a recording when trace_start gets no budgetTokens.',
    ),
  enforceBudget: z
    .boolean()
    .default(false)
    .describe(
      'When true, recordings with a budget block over-budget tool calls (trace.BUDGET_EXCEEDED).',
    ),
  warnThreshold: z
    .number()
    .gt(0)
    .lte(1)
    .default(DEFAULT_WARN_THRESHOLD)
    .describe(
      'Fraction of the budget (0 < warnThreshold <= 1) at which near_budget trips. Default 0.8.',
    ),
})

/** Resolved plugin configuration — the validated output of {@link configSchema}. */
type TraceConfig = z.infer<typeof configSchema>

/** Defaults used until `setup` runs (mirror the schema defaults). */
const DEFAULT_CONFIG: TraceConfig = {
  maxRecords: 10000,
  redact: [],
  enforceBudget: false,
  warnThreshold: DEFAULT_WARN_THRESHOLD,
}

// Module-level state: one recording per process at a time (a second server in the same process
// would share this — an accepted limitation for v1, as with other first-party plugins).
let config: TraceConfig = DEFAULT_CONFIG
let active: ActiveRecording | undefined

/** The envelope meta a plugin tool threads into `makeSuccess` / `makePluginError`. */
interface PluginMeta {
  readonly startedAt: number
  readonly now: () => number
}

/**
 * Read a trace artifact at `target`, or return the appropriate plugin-error envelope so a bad path
 * is classified identically wherever it is loaded: a missing file → `trace.ARTIFACT_NOT_FOUND`,
 * any other read/parse failure (e.g. malformed JSONL) → `trace.ARTIFACT_INVALID`. Shared by
 * `trace_tokens` and `trace_replay`.
 */
async function loadTrace(
  target: string,
  meta: PluginMeta,
): Promise<{ readonly parsed: ParsedTrace } | { readonly error: ToolResult }> {
  try {
    return { parsed: await readTrace(target) }
  } catch (err) {
    const missing =
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { readonly code?: unknown }).code === 'ENOENT'
    if (missing) {
      return {
        error: makePluginError('trace.ARTIFACT_NOT_FOUND', {
          ...meta,
          message: `No trace artifact at ${target}.`,
          details: { path: target },
        }),
      }
    }
    return {
      error: makePluginError('trace.ARTIFACT_INVALID', {
        ...meta,
        message: `Trace artifact at ${target} is not valid JSONL.`,
        details: { path: target },
      }),
    }
  }
}

/**
 * Derive budget status from a written artifact's meta header, or `undefined` when it carries no
 * budget. Uses the persisted exact `spent` (which counts overflow-dropped calls); falls back to
 * summing the buffered calls only if an older artifact lacks it.
 */
function artifactBudgetStatus(parsed: ParsedTrace): BudgetStatus | undefined {
  const m = parsed.meta
  if (m?.budget === undefined) return undefined
  const spent = m.spent ?? parsed.calls.reduce((sum, c) => sum + c.estimated_tokens, 0)
  return budgetStatusOf(m.budget, spent, m.warn_threshold ?? DEFAULT_WARN_THRESHOLD)
}

const startTool: AnyToolDefinition = defineTool({
  name: 'start',
  title: 'Start a trace recording',
  description: [
    'Begin recording every subsequent tool call (input, output, timing, token estimate) to a',
    'JSONL artifact until trace_stop. Optional path (exact file) or dir (generated filename);',
    'defaults to the configured dir or the OS temp dir. The trace plugin’s own tools are not',
    'recorded. Set budgetTokens to track an estimated-token budget (reported by trace_status /',
    'trace_tokens / trace_budget); set enforce:true to additionally BLOCK over-budget tool calls',
    'with trace.BUDGET_EXCEEDED. Returns: { ok, recording, path, budget? }. Errors:',
    'trace.ALREADY_RECORDING (a trace is already active; call trace_stop first; not retryable).',
  ].join(' '),
  inputSchema: z.object({
    path: z.string().optional().describe('Exact output file path (takes precedence over dir).'),
    dir: z.string().optional().describe('Output directory; the filename is generated.'),
    budgetTokens: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Estimated-token budget for this recording. Overrides the configured default.'),
    enforce: z
      .boolean()
      .optional()
      .describe('Block over-budget calls with trace.BUDGET_EXCEEDED (requires budgetTokens).'),
    warnThreshold: z
      .number()
      .gt(0)
      .lte(1)
      .optional()
      .describe(
        'Fraction of the budget (0 < warnThreshold <= 1) at which near_budget trips. Default 0.8.',
      ),
  }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    if (active !== undefined) {
      return makePluginError('trace.ALREADY_RECORDING', {
        ...meta,
        message: `Already recording to ${active.recorder.path}; call trace_stop first.`,
      })
    }
    const baseDir = args.dir ?? config.dir ?? tmpdir()
    const outPath = path.resolve(args.path ?? path.join(baseDir, `trace-${randomUUID()}.jsonl`))
    const budget = args.budgetTokens ?? config.budgetTokens
    const warnThreshold = args.warnThreshold ?? config.warnThreshold
    const recorder = new Recorder({
      path: outPath,
      maxRecords: config.maxRecords,
      redact: config.redact,
      coreVersion: VERSION,
      startedAt: ctx.now(),
      ...(budget !== undefined ? { budget, warnThreshold } : {}),
    })
    const unsubscribe = ctx.addDispatchObserver((rec) => {
      // Skip the trace plugin's own tools (it observes its own trace_start/stop calls too) so
      // the artifact records the app session, not itself.
      if (rec.tool.startsWith(`${TRACE_NAMESPACE}_`)) return
      recorder.record(rec)
    })
    // Enforcement (opt-in): once over budget, veto further non-trace dispatches. Skipping trace_*
    // is essential — otherwise an over-budget agent could never call trace_stop to recover.
    const enforce = (args.enforce ?? config.enforceBudget) && budget !== undefined
    const unguard = enforce
      ? ctx.addDispatchGuard((call) => {
          if (call.tool.startsWith(`${TRACE_NAMESPACE}_`)) return null
          const status = recorder.budgetStatus()
          if (status === undefined || !status.over_budget) return null
          return makePluginError('trace.BUDGET_EXCEEDED', {
            startedAt: call.startedAt,
            now: call.now,
            message: `Token budget exceeded: spent ${status.spent} of ${status.budget_tokens}. Stop the trace or narrow the remaining work.`,
            details: { ...status },
            next_actions: [
              'trace_stop() to end the recording',
              'reduce the remaining work, or start the next trace with a higher budgetTokens',
            ],
          })
        })
      : undefined
    active = { recorder, unsubscribe, ...(unguard !== undefined ? { unguard } : {}) }
    const budgetStatus = recorder.budgetStatus()
    return makeSuccess(
      {
        recording: true,
        path: outPath,
        ...(budgetStatus !== undefined ? { budget: budgetStatus } : {}),
      },
      meta,
    )
  },
})

const stopTool: AnyToolDefinition = defineTool({
  name: 'stop',
  title: 'Stop the trace recording',
  description: [
    'Stop the active recording, flush the JSONL artifact to disk, and return a summary.',
    'Returns: { ok, path, records, total_estimated_tokens, overflowed, budget? }. Errors:',
    'trace.NOT_RECORDING (no active trace; call trace_start first; not retryable),',
    'trace.ARTIFACT_WRITE_FAILED (artifact could not be written; fix path/permissions and retry).',
  ].join(' '),
  inputSchema: z.object({}),
  operationType: 'command',
  handler: async (_args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    if (active === undefined) {
      return makePluginError('trace.NOT_RECORDING', {
        ...meta,
        message: 'No active trace; call trace_start first.',
      })
    }
    const current = active
    let summary
    try {
      summary = await current.recorder.stop()
    } catch (err) {
      return makePluginError('trace.ARTIFACT_WRITE_FAILED', {
        ...meta,
        message: `Could not write trace artifact at ${current.recorder.path}.`,
        details: {
          path: current.recorder.path,
          cause: err instanceof Error ? err.message : String(err),
        },
      })
    }
    active = undefined
    current.unsubscribe()
    current.unguard?.()
    return makeSuccess({ ...summary }, meta)
  },
})

const tokensTool: AnyToolDefinition = defineTool({
  name: 'tokens',
  title: 'Report trace token usage',
  description: [
    'Summarise estimated token usage from a trace: total, per-tool totals, and the largest',
    'individual responses. With no path it reports the live recording (if one is active);',
    'otherwise pass path to a written artifact. Returns: { ok, path, total_estimated_tokens,',
    'calls, overflowed, by_tool, largest, budget? }. Errors: trace.NOT_RECORDING (no path and no',
    'active trace), trace.ARTIFACT_NOT_FOUND (no artifact at path), trace.ARTIFACT_INVALID (bad JSONL).',
  ].join(' '),
  inputSchema: z.object({
    path: z
      .string()
      .optional()
      .describe('Path to a written trace artifact. Omit to use the live recording.'),
  }),
  operationType: 'query',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    // No explicit path: summarise the live in-memory buffer (the artifact is not written until
    // trace_stop), so an agent can check the budget mid-session.
    if (args.path === undefined) {
      if (active === undefined) {
        return makePluginError('trace.NOT_RECORDING', {
          ...meta,
          message: 'No active trace and no path given; start a trace or pass an artifact path.',
        })
      }
      return makeSuccess(
        {
          path: active.recorder.path,
          ...summarizeTrace(
            active.recorder.calls,
            10,
            active.recorder.overflowed,
            active.recorder.budgetStatus(),
          ),
        },
        meta,
      )
    }
    const target = path.resolve(args.path)
    const loaded = await loadTrace(target, meta)
    if ('error' in loaded) return loaded.error
    return makeSuccess(
      {
        path: target,
        ...summarizeTrace(
          loaded.parsed.calls,
          10,
          loaded.parsed.meta?.overflowed ?? false,
          artifactBudgetStatus(loaded.parsed),
        ),
      },
      meta,
    )
  },
})

const statusTool: AnyToolDefinition = defineTool({
  name: 'status',
  title: 'Report trace recording status',
  description: [
    'Report whether a trace is currently recording and, if so, its path + buffered record count',
    '(and budget status when the recording has a token budget).',
    'Needs no app. Returns: { ok, recording, path?, records?, overflowed?, budget? }. Errors: none.',
  ].join(' '),
  inputSchema: z.object({}),
  operationType: 'query',
  handler: async (_args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    if (active === undefined) return makeSuccess({ recording: false }, meta)
    const budget = active.recorder.budgetStatus()
    return makeSuccess(
      {
        recording: true,
        path: active.recorder.path,
        records: active.recorder.count,
        overflowed: active.recorder.overflowed,
        ...(budget !== undefined ? { budget } : {}),
      },
      meta,
    )
  },
})

const budgetTool: AnyToolDefinition = defineTool({
  name: 'budget',
  title: 'Report the trace token budget',
  description: [
    'Report the live recording’s token budget without the full token breakdown — a cheap poll for',
    'an agent to self-limit mid-session. Needs no app. Returns: { ok, recording, path?, budget? }',
    'where budget is { budget_tokens, spent, remaining, over_budget, near_budget, warn_threshold }.',
    'budget is absent when the recording has no budget; recording is false when none is active.',
    'Errors: none.',
  ].join(' '),
  inputSchema: z.object({}),
  operationType: 'query',
  handler: async (_args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    if (active === undefined) return makeSuccess({ recording: false }, meta)
    const budget = active.recorder.budgetStatus()
    return makeSuccess(
      { recording: true, path: active.recorder.path, ...(budget !== undefined ? { budget } : {}) },
      meta,
    )
  },
})

const replayTool: AnyToolDefinition = defineTool({
  name: 'replay',
  title: 'Replay a recorded trace',
  description: [
    'Re-run the tool calls a written trace artifact recorded, in order, against the current server,',
    'and report which steps reproduce. Session ids are remapped automatically (the replayed launch',
    'creates a fresh session; later calls are rewritten to it). A call "diverged" when its ok/code',
    'differs from the recording; diverged calls carry a bounded field-level diff. Options: dryRun',
    '(re-validate against current schemas WITHOUT launching — detects a tool whose signature',
    'changed), stopOnError, include/exclude (tool-name filters), maxCalls. Note: a trace recorded',
    'with redaction cannot be faithfully replayed — redacted arg values diverge (recorded ok →',
    'replayed BAD_ARGUMENT); re-record without redaction to replay. Returns: { ok, path, replayed,',
    'matched, diverged, skipped, dry_run, calls }. Errors: trace.ARTIFACT_NOT_FOUND (no artifact at',
    'path), trace.ARTIFACT_INVALID (bad JSONL).',
  ].join(' '),
  inputSchema: z.object({
    path: z.string().describe('Path to a written trace artifact (JSONL) to replay.'),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        'Re-validate each call against current schemas without dispatching (schema drift).',
      ),
    stopOnError: z
      .boolean()
      .optional()
      .describe('Halt after the first diverging call; remaining calls are reported skipped.'),
    include: z
      .array(z.string())
      .optional()
      .describe('Only replay calls whose tool is in this list.'),
    exclude: z.array(z.string()).optional().describe('Skip calls whose tool is in this list.'),
    maxCalls: z.number().int().positive().optional().describe('Replay at most this many calls.'),
  }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const target = path.resolve(args.path)
    const loaded = await loadTrace(target, meta)
    if ('error' in loaded) return loaded.error
    const report = await replayTrace(
      loaded.parsed.calls,
      { dispatch: ctx.dispatch, validate: ctx.validate },
      {
        ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}),
        ...(args.stopOnError !== undefined ? { stopOnError: args.stopOnError } : {}),
        ...(args.include !== undefined ? { include: args.include } : {}),
        ...(args.exclude !== undefined ? { exclude: args.exclude } : {}),
        ...(args.maxCalls !== undefined ? { maxCalls: args.maxCalls } : {}),
        // Never re-dispatch the trace plugin's own tools (defensive: the recorder already excludes
        // them, so a well-formed artifact has none — this guards hand-made / foreign artifacts).
        skipTool: (tool) => tool.startsWith(`${TRACE_NAMESPACE}_`),
      },
    )
    return makeSuccess({ path: target, ...report }, meta)
  },
})

const viewTool: AnyToolDefinition = defineTool({
  name: 'view',
  title: 'Render a trace to an HTML report',
  description: [
    'Render a written trace artifact to a single self-contained HTML report (inline CSS/JS, no',
    'external assets) that opens in any browser offline. Shows a summary (calls, ok/error counts,',
    'total estimated tokens, a budget bar when the trace carries a budget), the largest-response and',
    'per-tool token tables, and an expandable timeline of every call with its args and result. With',
    'no out path the report is written next to the trace with a .html extension. Returns: { ok,',
    'path, source, calls, bytes } where path is the written HTML file. Errors: trace.ARTIFACT_NOT_FOUND',
    '(no artifact at path), trace.ARTIFACT_INVALID (bad JSONL), trace.ARTIFACT_WRITE_FAILED (the report',
    'could not be written).',
  ].join(' '),
  inputSchema: z.object({
    path: z.string().describe('Path to a written trace artifact (JSONL) to render.'),
    out: z
      .string()
      .optional()
      .describe(
        'Output path for the HTML report. Defaults to the trace path with a .html extension.',
      ),
  }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const target = path.resolve(args.path)
    const loaded = await loadTrace(target, meta)
    if ('error' in loaded) return loaded.error
    // Default the report path next to the trace: swap a trailing `.jsonl` (the canonical artifact
    // extension) for `.html`, otherwise just append `.html`. Done by suffix rather than
    // path.parse so a multi-dot name (e.g. trace.2026.tar) is not silently mis-stripped.
    const out =
      args.out !== undefined
        ? path.resolve(args.out)
        : target.endsWith('.jsonl')
          ? `${target.slice(0, -'.jsonl'.length)}.html`
          : `${target}.html`
    const html = renderTraceHtml(loaded.parsed, { generatedAt: ctx.now() })
    try {
      await mkdir(path.dirname(out), { recursive: true })
      await writeFile(out, html, 'utf8')
    } catch (err) {
      return makePluginError('trace.ARTIFACT_WRITE_FAILED', {
        ...meta,
        message: `Could not write the HTML report to ${out}: ${err instanceof Error ? err.message : String(err)}.`,
        details: { path: out },
      })
    }
    return makeSuccess(
      {
        path: out,
        source: target,
        calls: loaded.parsed.calls.length,
        bytes: Buffer.byteLength(html, 'utf8'),
      },
      meta,
    )
  },
})

/**
 * The trace plugin. Load with `--plugin @electron-stagewright/plugin-trace` or
 * `createServer({ plugins: [tracePlugin] })`. Configure via `pluginConfigs.trace`
 * (`{ dir?, maxRecords?, redact?, budgetTokens?, enforceBudget?, warnThreshold? }`).
 */
export const tracePlugin: StagewrightPlugin = {
  name: TRACE_NAMESPACE,
  version: TRACE_PLUGIN_VERSION,
  coreVersionRange: '*',
  configSchema,
  errorCodes: {
    ALREADY_RECORDING: {
      http: 409,
      retryable: false,
      hint: 'A trace is already recording; call trace_stop first.',
    },
    NOT_RECORDING: {
      http: 409,
      retryable: false,
      hint: 'No active trace; call trace_start first.',
    },
    ARTIFACT_NOT_FOUND: {
      http: 404,
      retryable: false,
      hint: 'No trace artifact at the given path.',
    },
    ARTIFACT_INVALID: {
      http: 400,
      retryable: false,
      hint: 'The trace artifact is not valid JSONL.',
    },
    ARTIFACT_WRITE_FAILED: {
      http: 500,
      retryable: true,
      hint: 'The trace artifact could not be written; check the path and permissions, then retry trace_stop.',
    },
    BUDGET_EXCEEDED: {
      http: 429,
      retryable: false,
      hint: 'The recording’s token budget is exhausted; call trace_stop or start a new trace with a higher budgetTokens.',
    },
  },
  tools: [startTool, stopTool, tokensTool, statusTool, budgetTool, replayTool, viewTool],
  setup: (raw) => {
    config = raw as TraceConfig
  },
  teardown: async () => {
    if (active !== undefined) {
      const current = active
      active = undefined
      current.unsubscribe()
      current.unguard?.()
      await current.recorder.stop().catch(() => undefined)
    }
    // Reset config so a later load in the same process never inherits a prior run's config.
    config = DEFAULT_CONFIG
  },
}

export default tracePlugin

export {
  Recorder,
  readTrace,
  summarizeTrace,
  budgetStatusOf,
  DEFAULT_WARN_THRESHOLD,
} from './recorder.js'
export type {
  TraceRecord,
  TraceMetaRecord,
  TraceCallRecord,
  TraceSummary,
  TokensReport,
  ParsedTrace,
  BudgetStatus,
} from './recorder.js'
export { replayTrace } from './replay.js'
export type {
  ReplayOptions,
  ReplayDeps,
  ReplayReport,
  ReplayCallOutcome,
  ResultDiff,
} from './replay.js'
export { renderTraceHtml, escapeHtml } from './viewer.js'
export type { RenderOptions } from './viewer.js'
