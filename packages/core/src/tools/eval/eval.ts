/**
 * `electron_eval_main` / `electron_eval_renderer` — evaluate JavaScript in the
 * main process or the focused renderer. These are the escape hatch for flows no
 * granular tool covers, and they are dangerous, so they are DEFAULT-DENY:
 *
 * - `operationType: 'eval'` + `requiresEvalFlag: true` — the dispatcher only
 *   registers them when the eval policy permits their target; otherwise they
 *   never appear in `tools/list` and an attempt to call them is a gated-tool
 *   error, never reaching this handler.
 * - The dispatcher runs every eval payload through the keyword blocklist
 *   (`EVAL_BLOCKED_KEYWORD`) and structural AST pass (`EVAL_BLOCKED_CONSTRUCT`)
 *   before the handler — the `code` field is scanned/parsed.
 *
 * The structural AST pass is still defence-in-depth, not a sound sandbox; the
 * current implementation ships the safe default plus per-target authorization, a
 * stderr audit breadcrumb, AST preflight, and a result-size cap.
 *
 * @module
 */

import { z } from 'zod'

import { makeError, makeSuccess } from '../../errors/envelope.js'
import { fnv1a32 } from '../../hash.js'
import { assertCapability, type TransportCapabilities } from '../../transports/index.js'
import { sessionIdField } from '../schema.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { classifyEvalError } from './diagnose.js'

/** Cap on the serialised eval result (JSON characters); larger results are truncated. */
const MAX_EVAL_RESULT_CHARS = 10000

function serialisedResult(text: string): Record<string, unknown> {
  return { result: text, result_serialized: true, result_chars: text.length }
}

/**
 * Shape the success payload from an eval result, capping its serialised size so a
 * huge return value cannot blow the agent's token budget. When truncated, returns
 * the leading slice of the JSON plus `truncated: true`. Values that cannot be
 * preserved as JSON (`undefined`, `bigint`, functions, symbols) are returned as a
 * string with `result_serialized: true` so the MCP response stays serialisable.
 */
function capResult(result: unknown): Record<string, unknown> {
  let json: string
  try {
    const stringified = JSON.stringify(result)
    if (stringified === undefined) return serialisedResult(String(result))
    json = stringified
  } catch {
    return serialisedResult(String(result))
  }
  if (json.length > MAX_EVAL_RESULT_CHARS) {
    return {
      result: json.slice(0, MAX_EVAL_RESULT_CHARS),
      truncated: true,
      result_chars: json.length,
      result_serialized: true,
    }
  }
  return { result }
}

/** Static configuration for one eval tool (main vs renderer differ only here). */
interface EvalToolSpec {
  readonly name: string
  readonly title: string
  readonly target: 'main' | 'renderer'
  readonly capability: keyof TransportCapabilities
  readonly context: string
}

/** Build an eval tool. The two instances differ only by target context + capability. */
function makeEvalTool(spec: EvalToolSpec): AnyToolDefinition {
  return defineTool({
    name: spec.name,
    title: spec.title,
    description: [
      `Evaluate JavaScript in the ${spec.context} and return the returned/awaited value;`,
      'the code receives a JSON `arg`.',
      `Only available when the eval policy permits the ${spec.target} target (start the server with`,
      `--allow-eval, or --allow-eval=${spec.target}); otherwise this tool is not`,
      'registered. The code passes a keyword blocklist and a structural (AST) check before running,',
      'and large or non-JSON results are serialised/truncated. Returns: { ok, session_id, result,',
      'truncated?, result_serialized?, result_chars? }.',
      'Errors: EVAL_BLOCKED_KEYWORD / EVAL_BLOCKED_CONSTRUCT (blocked keyword or construct; not',
      'retryable), EVAL_SYNTAX_ERROR,',
      'EVAL_RUNTIME_ERROR, EVAL_TIMEOUT (retryable), TRANSPORT_UNSUPPORTED (transport cannot eval',
      'here), NOT_RUNNING, BAD_ARGUMENT (multiple sessions).',
    ].join(' '),
    inputSchema: z.object({
      code: z
        .string()
        .min(1)
        .describe(`JavaScript to evaluate in the ${spec.context}. Receives the JSON \`arg\`.`),
      arg: z.unknown().optional().describe('JSON value passed to the code as `arg`.'),
      sessionId: sessionIdField,
    }),
    operationType: 'eval',
    requiresEvalFlag: true,
    evalTarget: spec.target,
    handler: async (args, ctx) => {
      const managed = ctx.sessions.resolve(args.sessionId)
      const meta = { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id }
      assertCapability(managed.transport, spec.capability)
      // Audit breadcrumb on the security-sensitive surface. Stderr only (the MCP
      // channel is stdout) and the payload itself is never logged — only its length
      // and a content hash, so an operator can correlate repeated payloads (and a
      // blocked-eval rejection, which carries the same `code_hash`) without the code.
      ctx.logger.info('eval invoked', {
        tool: spec.name,
        target: spec.target,
        session_id: managed.id,
        code_length: args.code.length,
        code_hash: fnv1a32(args.code),
      })
      try {
        const result = await managed.session.evaluate(spec.target, args.code, args.arg)
        return makeSuccess({ session_id: managed.id, ...capResult(result) }, meta)
      } catch (err) {
        const code = classifyEvalError(err)
        const firstLine = (err instanceof Error ? err.message : String(err)).split('\n', 1)[0] ?? ''
        return makeError(code, { ...meta, message: firstLine.slice(0, 200) || 'Eval failed.' })
      }
    },
  })
}

/** `electron_eval_main` — evaluate in the main process (`electronApp.evaluate`). */
export const evalMainTool: AnyToolDefinition = makeEvalTool({
  name: 'electron_eval_main',
  title: 'Evaluate JS in the main process',
  target: 'main',
  capability: 'supportsMainEval',
  context: 'main process',
})

/** `electron_eval_renderer` — evaluate in the focused renderer (`page.evaluate`). */
export const evalRendererTool: AnyToolDefinition = makeEvalTool({
  name: 'electron_eval_renderer',
  title: 'Evaluate JS in the focused renderer',
  target: 'renderer',
  capability: 'supportsRendererEval',
  context: 'focused renderer',
})
