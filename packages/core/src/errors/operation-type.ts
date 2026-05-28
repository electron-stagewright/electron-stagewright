/**
 * Operation type discriminator — INTERNAL metadata that classifies each tool by
 * the kind of work it performs (state-changing, state-reading, eval, etc.). The
 * discriminator is declared on each tool's ToolDefinition in the dispatcher's
 * manifest, never on the agent-facing input schema. The dispatcher reads the
 * tool's declared type from the manifest and routes the payload through the
 * appropriate validator — agents do not see, declare, or pass this field.
 *
 * ## Why not surface the discriminator to the agent
 *
 * ADR-007 (agent-native UX principles) commits to granular per-action tools
 * (`electron_click`, `electron_eval_main`, etc.) over a single macro tool with
 * an internal action selector — the m13v measurement showed selection error
 * dropping from ~20% to <3% with that split. With granular tools, the
 * dispatcher ALREADY knows the operation type from the tool name; asking the
 * agent to mirror it in every payload would (a) add a class of avoidable
 * errors (typo, hallucination), (b) burn tokens for redundant metadata, and
 * (c) make the fail-closed property theatrical — a confused agent could send
 * `'command'` for an eval tool and bypass the blocklist.
 *
 * The contract still fails closed, but at BOOT TIME rather than runtime: every
 * tool registered with the dispatcher must declare its operationType in the
 * manifest. A tool whose manifest lacks the field cannot register, so the
 * routing seam is exhaustive by construction.
 *
 * ## Security note — this module does NOT call `eval()`
 *
 * Despite the name, this file never invokes the JavaScript `eval()` function and
 * never executes any payload locally. The word "eval" refers to a CLASSIFICATION
 * LABEL for tool calls (the planned `eval_main` and `eval_renderer` tools) whose
 * payloads will eventually be sent to a REMOTE Electron process to be executed
 * there — over the CDP `Runtime.evaluate` channel or the Playwright
 * `electronApp.evaluate(...)` API, never in this server process.
 *
 * The validators in this file are the FIRST line of defence: they inspect the
 * payload string and reject obvious foot-guns (keyword blocklist) BEFORE the
 * dispatcher hands the payload off to the transport. That mitigation is the
 * point of the file; it is not the vulnerability.
 *
 * Full secure-by-default eval policy (AST inspection, `--allow-eval` opt-in flag,
 * authorisation check) is documented in the forthcoming threat-model ADR.
 *
 * ## Implementation status
 *
 * The validator bodies in this file are intentionally MINIMAL stubs. Real validation
 * logic lands with the forthcoming lifecycle and interaction tool ADRs, where the
 * tools themselves know which inputs require which checks. What ships here is the
 * ROUTING CONTRACT: the seams are in place, callers cannot accidentally bypass them,
 * and downstream slices can fill in the bodies without re-litigating the security shape.
 *
 * @module
 */

import { z } from 'zod'
import { StagewrightError } from './registry.js'

/**
 * The closed enum of operation types — declared internally per tool in the
 * dispatcher's manifest, never on the agent input.
 *
 * - `command`: state-changing (click, type, key, drag, scroll).
 * - `query`: state-reading non-eval (get_text, get_value, get_attribute, exists).
 * - `eval`: arbitrary JS evaluation (eval_main, eval_renderer). Routed through stricter validation.
 * - `screenshot`: image capture, generally allowed without keyword checks.
 * - `logs`: console / network / IPC log retrieval.
 * - `window_info`: structural inspection (windows_list, focused_element, get_bbox).
 *
 * Kept as a Zod schema for boot-time manifest validation: the dispatcher uses
 * `OperationTypeSchema.parse(toolDef.operationType)` when registering each
 * tool, which means a tool whose manifest declares an invalid (or missing)
 * operationType fails server startup with a clear error — the agent never
 * encounters a tool with mis-declared metadata.
 */
export const OperationTypeSchema = z.enum([
  'command',
  'query',
  'eval',
  'screenshot',
  'logs',
  'window_info',
])

export type OperationType = z.infer<typeof OperationTypeSchema>

/**
 * Minimal blocklist for eval payloads — the obvious foot-guns that any agent should
 * be required to opt into via `allowDangerous`. The full safety story lives in the
 * forthcoming threat-model ADR and the dispatcher's `--allow-eval` opt-in flag.
 */
const DANGEROUS_EVAL_KEYWORDS = [
  'process.exit',
  'require(',
  'eval(',
  'Function(',
  '__proto__',
  'child_process',
] as const

/**
 * Stub validator for non-eval operations. Accepts every input today; the forthcoming
 * lifecycle and interaction tool ADRs will fill in tool-specific shape validation here
 * (input-arity checks, ref-vs-selector exclusivity, file-path absoluteness, etc.) once
 * tools land.
 *
 * The function exists primarily to pin the routing contract: the dispatcher invokes
 * one of validateCommandContent OR validateEvalContent for every call, never both,
 * never neither. The first lifecycle-tool commit will fill the body without changing
 * the signature.
 */
export function validateCommandContent(_input: unknown): void {
  // Intentional no-op stub. Real validation lands with the forthcoming lifecycle tools.
  // The mere existence of this function pins the dispatcher's routing contract.
}

/** Options for {@link validateEvalContent}. */
export interface ValidateEvalOptions {
  /** Bypass the keyword blocklist. Default false. The dispatcher only sets this true when the operator started the server with the planned --allow-eval flag (forthcoming threat-model ADR). */
  readonly allowDangerous?: boolean
}

/**
 * Stub validator for eval operations. v1 enforces a minimal keyword blocklist; the
 * full secure-by-default eval policy ships with the forthcoming threat-model ADR —
 * at which point this body grows to include AST inspection, timeout enforcement
 * coordination, and the --allow-eval opt-in flag check.
 *
 * @throws {@link StagewrightError} with code `EVAL_BLOCKED_KEYWORD` when a dangerous
 * keyword is detected and `allowDangerous` is not set.
 */
export function validateEvalContent(input: unknown, opts: ValidateEvalOptions = {}): void {
  if (typeof input !== 'string') {
    // Non-string eval bodies are a dispatcher contract violation, not a content issue.
    // The dispatcher will surface this as BAD_ARGUMENT before reaching this validator.
    return
  }
  if (opts.allowDangerous === true) {
    return
  }
  for (const keyword of DANGEROUS_EVAL_KEYWORDS) {
    if (input.includes(keyword)) {
      throw new StagewrightError(
        'EVAL_BLOCKED_KEYWORD',
        `Eval payload contains blocked keyword: ${keyword}`,
        { keyword },
      )
    }
  }
}

/**
 * Single routing entry point — invoked by the dispatcher for every tool call,
 * using the operationType declared on the tool's manifest entry. The signature
 * accepts a fully-typed {@link OperationType} (not `unknown`) because the
 * dispatcher only constructs valid values from validated manifest metadata.
 * Compile-time exhaustiveness substitutes for the runtime guards we used to
 * keep — the fails-closed property is now enforced when tools are registered,
 * not on every call.
 */
export function routeByOperationType(
  operationType: OperationType,
  input: unknown,
  opts: ValidateEvalOptions = {},
): void {
  if (operationType === 'eval') {
    validateEvalContent(input, opts)
    return
  }
  validateCommandContent(input)
}

/** Re-exported for testing — assertion fixture in errors.test.ts uses this set. */
export const DANGEROUS_EVAL_KEYWORDS_FOR_TESTS: readonly string[] = DANGEROUS_EVAL_KEYWORDS
