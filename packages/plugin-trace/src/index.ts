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
 * Tools (namespaced by the loader): `trace_start`, `trace_stop`, `trace_tokens`, `trace_status`.
 * `trace_replay` (re-dispatch) and a visual viewer are forthcoming.
 *
 * PRIVACY: a trace captures tool inputs/outputs, which may include typed text or eval payloads.
 * It is opt-in (only records between start/stop) and writes to an operator-chosen path — the
 * same trust model as screenshots and console logs. The `redact` config drops named arg fields.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  VERSION,
  defineTool,
  makePluginError,
  makeSuccess,
  type AnyToolDefinition,
  type StagewrightPlugin,
} from '@electron-stagewright/core'
import { z } from 'zod'

import { Recorder, readTrace, summarizeTrace } from './recorder.js'

/** The in-flight recording: its recorder plus the dispatch-observer unsubscribe handle. */
interface ActiveRecording {
  readonly recorder: Recorder
  readonly unsubscribe: () => void
}

/** Plugin namespace — must match {@link tracePlugin.name}; the loader prefixes its tools with it. */
const TRACE_NAMESPACE = 'trace'

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
})

/** Resolved plugin configuration — the validated output of {@link configSchema}. */
type TraceConfig = z.infer<typeof configSchema>

/** Defaults used until `setup` runs (mirror the schema defaults). */
const DEFAULT_CONFIG: TraceConfig = { maxRecords: 10000, redact: [] }

// Module-level state: one recording per process at a time (a second server in the same process
// would share this — an accepted limitation for v1, as with other first-party plugins).
let config: TraceConfig = DEFAULT_CONFIG
let active: ActiveRecording | undefined

const startTool: AnyToolDefinition = defineTool({
  name: 'start',
  title: 'Start a trace recording',
  description: [
    'Begin recording every subsequent tool call (input, output, timing, token estimate) to a',
    'JSONL artifact until trace_stop. Optional path (exact file) or dir (generated filename);',
    'defaults to the configured dir or the OS temp dir. The trace plugin’s own tools are not',
    'recorded. Returns: { ok, recording, path }. Errors: trace.ALREADY_RECORDING (a trace is',
    'already active; call trace_stop first; not retryable).',
  ].join(' '),
  inputSchema: z.object({
    path: z.string().optional().describe('Exact output file path (takes precedence over dir).'),
    dir: z.string().optional().describe('Output directory; the filename is generated.'),
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
    const recorder = new Recorder({
      path: outPath,
      maxRecords: config.maxRecords,
      redact: config.redact,
      coreVersion: VERSION,
      startedAt: ctx.now(),
    })
    const unsubscribe = ctx.addDispatchObserver((rec) => {
      // Skip the trace plugin's own tools (it observes its own trace_start/stop calls too) so
      // the artifact records the app session, not itself.
      if (rec.tool.startsWith(`${TRACE_NAMESPACE}_`)) return
      recorder.record(rec)
    })
    active = { recorder, unsubscribe }
    return makeSuccess({ recording: true, path: outPath }, meta)
  },
})

const stopTool: AnyToolDefinition = defineTool({
  name: 'stop',
  title: 'Stop the trace recording',
  description: [
    'Stop the active recording, flush the JSONL artifact to disk, and return a summary.',
    'Returns: { ok, path, records, total_estimated_tokens, overflowed }. Errors:',
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
    'calls, overflowed, by_tool, largest }. Errors: trace.NOT_RECORDING (no path and no active trace),',
    'trace.ARTIFACT_NOT_FOUND (no artifact at path), trace.ARTIFACT_INVALID (bad JSONL).',
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
          ...summarizeTrace(active.recorder.calls, 10, active.recorder.overflowed),
        },
        meta,
      )
    }
    const target = path.resolve(args.path)
    let parsed
    try {
      parsed = await readTrace(target)
    } catch (err) {
      const missing =
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { readonly code?: unknown }).code === 'ENOENT'
      if (missing) {
        return makePluginError('trace.ARTIFACT_NOT_FOUND', {
          ...meta,
          message: `No trace artifact at ${target}.`,
          details: { path: target },
        })
      }
      return makePluginError('trace.ARTIFACT_INVALID', {
        ...meta,
        message: `Trace artifact at ${target} is not valid JSONL.`,
        details: { path: target },
      })
    }
    return makeSuccess(
      { path: target, ...summarizeTrace(parsed.calls, 10, parsed.meta?.overflowed ?? false) },
      meta,
    )
  },
})

const statusTool: AnyToolDefinition = defineTool({
  name: 'status',
  title: 'Report trace recording status',
  description: [
    'Report whether a trace is currently recording and, if so, its path + buffered record count.',
    'Needs no app. Returns: { ok, recording, path?, records?, overflowed? }. Errors: none.',
  ].join(' '),
  inputSchema: z.object({}),
  operationType: 'query',
  handler: async (_args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    if (active === undefined) return makeSuccess({ recording: false }, meta)
    return makeSuccess(
      {
        recording: true,
        path: active.recorder.path,
        records: active.recorder.count,
        overflowed: active.recorder.overflowed,
      },
      meta,
    )
  },
})

/**
 * The trace plugin. Load with `--plugin @electron-stagewright/plugin-trace` or
 * `createServer({ plugins: [tracePlugin] })`. Configure via `pluginConfigs.trace`
 * (`{ dir?, maxRecords?, redact? }`).
 */
export const tracePlugin: StagewrightPlugin = {
  name: TRACE_NAMESPACE,
  version: VERSION,
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
  },
  tools: [startTool, stopTool, tokensTool, statusTool],
  setup: (raw) => {
    config = raw as TraceConfig
  },
  teardown: async () => {
    if (active !== undefined) {
      const current = active
      active = undefined
      current.unsubscribe()
      await current.recorder.stop().catch(() => undefined)
    }
    // Reset config so a later load in the same process never inherits a prior run's config.
    config = DEFAULT_CONFIG
  },
}

export default tracePlugin

export { Recorder, readTrace, summarizeTrace } from './recorder.js'
export type {
  TraceRecord,
  TraceMetaRecord,
  TraceCallRecord,
  TraceSummary,
  TokensReport,
  ParsedTrace,
} from './recorder.js'
