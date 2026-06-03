/**
 * Agent-UX response envelope — every tool call returns one of these two shapes.
 *
 * The envelope is intentionally MCP-SDK-agnostic: it is the value the dispatcher
 * computes BEFORE handing off to the MCP transport. The transport layer is responsible
 * for serialising the envelope into the protocol-specific tool result.
 *
 * Design contract:
 * - Every response (success AND error) carries `_meta.estimated_tokens` so agents budget in real time.
 * - Error responses carry `code`, `retryable`, and `hint` machine-readably — no prose parsing.
 * - The envelope shape is stable; new fields are additive, never breaking.
 *
 * @module
 */

import {
  ERROR_CODES,
  type ErrorCode,
  type ErrorCodeDefinition,
  lookupErrorCodeDefinition,
} from './registry.js'
import { currentSessionId } from './session-context.js'

/**
 * The `code` carried by an error envelope: either a core {@link ErrorCode} or a
 * namespaced plugin code (`<plugin>.CODE`, e.g. `production.NOTARIZATION_FAILED`).
 * The `(string & {})` member keeps editor autocomplete for the core union while
 * still accepting the open set of plugin codes registered at load time.
 */
export type ResponseCode = ErrorCode | (string & {})

/** Metadata block attached to every response — success or error. */
export interface ResponseMeta {
  /**
   * Estimated token cost of the response payload, computed via {@link estimateTokens}.
   * Char/4 heuristic for v1. Replace with a model-accurate tokenizer when
   * benchmark coverage can prove the trade-off.
   */
  readonly estimated_tokens: number
  /** Wall-clock duration of the tool dispatch, in milliseconds. */
  readonly elapsed_ms: number
  /** Optional session correlation id filled by the dispatcher. */
  readonly session_id?: string
}

/** Similar-element reference returned with REF_NOT_FOUND or SELECTOR_NO_MATCH errors. */
export interface SimilarRef {
  readonly ref: number
  readonly role: string
  readonly name: string
}

/** Error envelope — discriminated by `ok: false`. */
export interface ErrorResponse {
  readonly ok: false
  /** Human-readable error message. May change between releases; agents should branch on `code`. */
  readonly error: string
  /** Stable machine-readable error code — a core {@link ERROR_CODES} key or a namespaced plugin code. */
  readonly code: ResponseCode
  /** Default hint from the registry, optionally overridden per-call. */
  readonly hint: string
  /** Concrete tool calls the agent might try next to recover. */
  readonly next_actions?: readonly string[]
  /** When the failure is REF_NOT_FOUND or SELECTOR_NO_MATCH, candidates the agent might mean. */
  readonly similar_refs?: readonly SimilarRef[]
  /** Optional structured diagnostics intended for machine readers. */
  readonly details?: Record<string, unknown>
  /** Whether the agent should retry the same call automatically — mirrored from the registry. */
  readonly retryable: boolean
  /** HTTP-equivalent status — mirrored from the registry. */
  readonly http: number
  readonly _meta: ResponseMeta
}

/** Success envelope — discriminated by `ok: true`, generic over the tool-specific payload `T`. */
export type SuccessResponse<T extends object = Record<string, never>> = T & {
  readonly ok: true
  readonly _meta: ResponseMeta
}

/** Discriminated union returned from every tool dispatch. */
export type ToolResponse<T extends object = Record<string, never>> =
  | ErrorResponse
  | SuccessResponse<T>

/**
 * Char/4 token estimate. The heuristic is within ~10-20% on English prose for
 * GPT-class and Claude-class tokenizers. Floor at 1 so tiny payloads never report
 * a 0-token cost (which would be misleading for budget tracking).
 *
 * @returns Estimated token count, minimum 1 for non-empty payloads, 0 for null/undefined.
 */
export function estimateTokens(payload: unknown): number {
  if (payload === null || payload === undefined) {
    return 0
  }
  let text: string
  try {
    if (typeof payload === 'string') {
      text = payload
    } else {
      // JSON.stringify returns `undefined` (not a throw) for Symbol, functions, and
      // some other unrepresentable values — fall back to String() in that case so
      // the heuristic still produces a sensible non-zero result.
      const stringified = JSON.stringify(payload)
      text = stringified ?? String(payload)
    }
  } catch {
    // Circular references and BigInt throw; fall back to String() for those too.
    text = String(payload)
  }
  if (text.length === 0) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

/**
 * Resolve the session id for the in-flight tool dispatch. The dispatcher runs
 * each handler inside an `AsyncLocalStorage` context (see
 * `errors/session-context.ts`), so this reads the ambient id without it being
 * threaded through call signatures. Outside a dispatched call — or for a tool
 * that runs without a resolved session — it returns `undefined`, and the
 * envelope omits `_meta.session_id`.
 */
export function getSessionId(): string | undefined {
  return currentSessionId()
}

/** Options accepted by {@link makeError}. */
export interface MakeErrorOptions {
  /** Override the default registry hint message. */
  readonly message?: string
  /** Tool-specific structured details. Must be JSON-serialisable. */
  readonly details?: Record<string, unknown>
  /** Concrete tool calls the agent might try next. */
  readonly next_actions?: readonly string[]
  /** Candidate refs when the error is REF_NOT_FOUND / SELECTOR_NO_MATCH. */
  readonly similar_refs?: readonly SimilarRef[]
  /** Optional session id override (rarely needed — defaults to {@link getSessionId}). */
  readonly session_id?: string
  /** Injection seam for deterministic tests. */
  readonly now?: () => number
  /** Optional dispatch start timestamp. When provided, elapsed_ms is now() - startedAt. */
  readonly startedAt?: number
}

/**
 * Build an {@link ErrorResponse} from a code and its resolved definition. Shared by
 * {@link makeError} (core codes) and {@link makePluginError} (namespaced plugin codes)
 * so both produce an identically-shaped envelope from one code path.
 *
 * @throws if `details` contains values that {@link JSON.stringify} cannot serialise.
 */
function buildErrorEnvelope(
  code: string,
  def: ErrorCodeDefinition,
  opts: MakeErrorOptions,
): ErrorResponse {
  const now = opts.now ?? Date.now
  const startedAt = opts.startedAt ?? now()
  const elapsed_ms = Math.max(0, now() - startedAt)

  // Guard against JSON-unsafe details (bigint, Symbol, circular refs).
  if (opts.details !== undefined) {
    try {
      JSON.stringify(opts.details)
    } catch (cause) {
      throw new Error(
        `makeError: details payload is not JSON-serialisable (${cause instanceof Error ? cause.message : String(cause)})`,
        { cause },
      )
    }
  }

  const message = opts.message ?? def.hint
  const sessionId = opts.session_id ?? getSessionId()

  // Build the response body so we can measure its own estimated_tokens. We compute
  // tokens on the payload-shaped object (without the _meta field) so the meta does
  // not chase itself.
  const payloadForTokens: Record<string, unknown> = {
    ok: false,
    error: message,
    code,
    hint: def.hint,
    retryable: def.retryable,
    http: def.http,
  }
  if (opts.next_actions !== undefined) payloadForTokens['next_actions'] = opts.next_actions
  if (opts.similar_refs !== undefined) payloadForTokens['similar_refs'] = opts.similar_refs
  if (opts.details !== undefined) payloadForTokens['details'] = opts.details

  const meta: ResponseMeta =
    sessionId !== undefined
      ? { estimated_tokens: estimateTokens(payloadForTokens), elapsed_ms, session_id: sessionId }
      : { estimated_tokens: estimateTokens(payloadForTokens), elapsed_ms }

  const base = {
    ok: false as const,
    error: message,
    code,
    hint: def.hint,
    retryable: def.retryable,
    http: def.http,
    _meta: meta,
  }

  // exactOptionalPropertyTypes forbids assigning `undefined` to optional fields,
  // so we conditionally extend the object rather than always including the keys.
  return {
    ...base,
    ...(opts.next_actions !== undefined ? { next_actions: opts.next_actions } : {}),
    ...(opts.similar_refs !== undefined ? { similar_refs: opts.similar_refs } : {}),
    ...(opts.details !== undefined ? { details: opts.details } : {}),
  } satisfies ErrorResponse
}

/**
 * Build an {@link ErrorResponse} from a registered CORE error code. Pulls `http`,
 * `retryable`, and the default `hint` from {@link ERROR_CODES}; allows per-call
 * overrides for message and agent-recovery hints.
 *
 * @throws if `details` contains values that {@link JSON.stringify} cannot serialise.
 */
export function makeError(code: ErrorCode, opts: MakeErrorOptions = {}): ErrorResponse {
  return buildErrorEnvelope(code, ERROR_CODES[code], opts)
}

/**
 * Build an {@link ErrorResponse} from a namespaced plugin code (`<plugin>.CODE`). The
 * code's definition is resolved from the runtime plugin registry (populated by the
 * plugin loader via `registerPluginErrorCodes`). Plugin tool handlers use this instead
 * of {@link makeError}, whose argument is the closed core {@link ErrorCode} union.
 *
 * Plugin handlers must RETURN this envelope, not throw it: `StagewrightError` (the only
 * throw the dispatcher maps to a specific code) accepts core {@link ErrorCode}s only, so
 * a thrown plugin code would fall through to `INTERNAL_ERROR`. Returning matches how every
 * core tool surfaces failures.
 *
 * @throws if the code is not registered (a plugin bug — surfaced as INTERNAL_ERROR by
 * the dispatcher backstop) or if `details` is not JSON-serialisable.
 */
export function makePluginError(code: string, opts: MakeErrorOptions = {}): ErrorResponse {
  const def = lookupErrorCodeDefinition(code)
  if (def === undefined) {
    throw new Error(
      `makePluginError: error code "${code}" is not registered. Declare it in the plugin's errorCodes.`,
    )
  }
  return buildErrorEnvelope(code, def, opts)
}

/** Options accepted by {@link makeSuccess}. */
export interface MakeSuccessOptions {
  readonly session_id?: string
  readonly now?: () => number
  readonly startedAt?: number
}

/**
 * Build a {@link SuccessResponse} from a tool-specific data payload. The payload is
 * spread at the top level of the envelope (matching the README example for snapshot/click).
 */
export function makeSuccess<T extends object>(
  data: T,
  opts: MakeSuccessOptions = {},
): SuccessResponse<T> {
  const now = opts.now ?? Date.now
  const startedAt = opts.startedAt ?? now()
  const elapsed_ms = Math.max(0, now() - startedAt)
  const sessionId = opts.session_id ?? getSessionId()

  const payloadForTokens = { ...data, ok: true }
  const meta: ResponseMeta =
    sessionId !== undefined
      ? { estimated_tokens: estimateTokens(payloadForTokens), elapsed_ms, session_id: sessionId }
      : { estimated_tokens: estimateTokens(payloadForTokens), elapsed_ms }

  return {
    ...data,
    ok: true as const,
    _meta: meta,
  } as SuccessResponse<T>
}
