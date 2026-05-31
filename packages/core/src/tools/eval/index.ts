/**
 * Eval tools — the default-deny escape hatch for flows no granular tool covers.
 * Both are `operationType: 'eval'` with `requiresEvalFlag: true`, so the
 * dispatcher only registers them when the server was started with `--allow-eval`,
 * and every payload passes the keyword blocklist before running.
 *
 * @module
 */

import type { AnyToolDefinition } from '../types.js'
import { evalMainTool, evalRendererTool } from './eval.js'

export { evalMainTool, evalRendererTool } from './eval.js'
export { classifyEvalError } from './diagnose.js'

/**
 * The eval tools registered with the dispatcher by default. They are part of
 * `DEFAULT_TOOLS`, but the dispatcher hides them unless `--allow-eval` was set —
 * being in this list does not make them reachable, the flag does.
 */
export const EVAL_TOOLS: readonly AnyToolDefinition[] = [evalMainTool, evalRendererTool]
