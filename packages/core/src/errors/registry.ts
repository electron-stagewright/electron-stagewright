/**
 * Central error code registry — every error response from any tool MUST reference a code
 * from this table.
 *
 * Registry shape constraints:
 * - Codes are SCREAMING_SNAKE_CASE — easy to grep, stable across versions.
 * - Every code carries `http` (forward-looking REST gateway), `retryable` (so agents can
 *   build automatic retry policy without parsing prose), and `hint` (consistent
 *   human-readable suggestion across every tool that surfaces the same error).
 * - The `errors-mirror.test.ts` walks `packages/core/src/**` and asserts every `code:`
 *   literal expression matches a key here. Adding a code without registering it fails CI.
 *
 * @module
 */

export interface ErrorCodeDefinition {
  /** HTTP-equivalent status — forward-looking for the eventual REST gateway. */
  readonly http: number
  /**
   * Whether an agent should retry the same call automatically.
   * Time-sensitive (timeouts, transport drops) → true.
   * State-sensitive (element disabled, missing ref) → false; the agent must change state first.
   */
  readonly retryable: boolean
  /** Default human-readable suggestion. Tools may override via the message argument of makeError. */
  readonly hint: string
}

export const ERROR_CODES = {
  // Lifecycle
  NOT_RUNNING: {
    http: 409,
    retryable: false,
    hint: 'Call launch first.',
  },
  ALREADY_RUNNING: {
    http: 409,
    retryable: false,
    hint: 'Stop the active app before launching another one.',
  },
  LAUNCH_TIMEOUT: {
    http: 408,
    retryable: true,
    hint: 'Check main process startup time.',
  },
  SINGLE_INSTANCE_LOCK: {
    http: 409,
    retryable: false,
    hint: 'Another instance of the app is running.',
  },

  // Arguments
  BAD_ARGUMENT: {
    http: 400,
    retryable: false,
    hint: 'Check the input schema for this tool.',
  },
  FILE_NOT_FOUND: {
    http: 404,
    retryable: false,
    hint: 'Verify the path exists and is readable.',
  },
  ABSOLUTE_PATH_REQUIRED: {
    http: 400,
    retryable: false,
    hint: 'Use an absolute path.',
  },

  // Selectors / refs
  REF_NOT_FOUND: {
    http: 404,
    retryable: false,
    hint: 'Call snapshot first.',
  },
  SELECTOR_NO_MATCH: {
    http: 404,
    retryable: false,
    hint: 'Element is not in the DOM.',
  },
  ELEMENT_NOT_VISIBLE: {
    http: 409,
    retryable: true,
    hint: 'Wait for the element to become visible.',
  },
  ELEMENT_DISABLED: {
    http: 409,
    retryable: false,
    hint: 'Element is disabled; address the disabled state via app-level interaction.',
  },
  TYPE_NO_EFFECT: {
    http: 422,
    retryable: false,
    hint: "Typing changed nothing — the target ignored the input (e.g. a code editor's hidden textarea). Use electron_type_into_editor on the editor's content area.",
  },

  // Waits
  WAIT_TIMEOUT: {
    http: 408,
    retryable: true,
    hint: 'The awaited condition did not hold within timeoutMs; raise timeoutMs or recheck the condition.',
  },

  // Assertions (expect_* / assert_pattern)
  EXPECTATION_FAILED: {
    http: 417,
    retryable: true,
    hint: 'The expectation did not hold; details carry expected vs actual. Re-check state or raise timeoutMs.',
  },

  // Transports
  TRANSPORT_UNSUPPORTED: {
    http: 501,
    retryable: false,
    hint: 'Active transport lacks this capability.',
  },
  CDP_DISCONNECTED: {
    http: 503,
    retryable: true,
    hint: 'The CDP connection dropped; the dispatcher will attempt reconnection.',
  },
  INJECT_FAILED: {
    http: 500,
    retryable: true,
    hint: 'Inspector handshake failed; retry with attach instead.',
  },

  // Plugins
  PLUGIN_LOAD_FAILED: {
    http: 500,
    retryable: false,
    hint: 'Plugin package could not be imported.',
  },
  PLUGIN_VERSION_MISMATCH: {
    http: 409,
    retryable: false,
    hint: 'Plugin requires a different core version.',
  },
  PLUGIN_MANIFEST_INVALID: {
    http: 500,
    retryable: false,
    hint: 'Plugin default export does not match the PluginManifest schema.',
  },
  PLUGIN_CONFIG_INVALID: {
    http: 400,
    retryable: false,
    hint: 'Plugin config did not match the plugin configSchema.',
  },

  // Evaluation
  EVAL_SYNTAX_ERROR: {
    http: 400,
    retryable: false,
    hint: 'Check the JavaScript syntax of the eval body.',
  },
  EVAL_RUNTIME_ERROR: {
    http: 500,
    retryable: false,
    hint: 'The evaluated code threw.',
  },
  EVAL_TIMEOUT: {
    http: 408,
    retryable: true,
    hint: 'Evaluation exceeded the budget.',
  },
  EVAL_BLOCKED_KEYWORD: {
    http: 400,
    retryable: false,
    hint: 'Remove the blocked keyword, or use an explicit trusted-eval opt-in for this session.',
  },

  // Catch-all
  NOT_IMPLEMENTED: {
    http: 501,
    retryable: false,
    hint: 'This transport or plugin does not implement the tool yet.',
  },
  INTERNAL_ERROR: {
    http: 500,
    retryable: false,
    hint: 'Bug in Electron Stagewright — please file an issue.',
  },
} as const satisfies Record<string, ErrorCodeDefinition>

/** Discriminated union of every registered error code. */
export type ErrorCode = keyof typeof ERROR_CODES

/** Compile-time exhaustiveness guard for switch statements over ErrorCode. */
export function assertNever(value: never): never {
  throw new Error(`Unhandled ErrorCode at runtime: ${JSON.stringify(value)}`)
}

/** Returns true when the given string is a registered CORE error code. */
export function isErrorCode(value: string): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, value)
}

/**
 * Runtime registry of plugin-contributed error codes, keyed by the full
 * `<namespace>.CODE` string (e.g. `production.NOTARIZATION_FAILED`).
 *
 * Core codes live in the closed compile-time {@link ERROR_CODES} union; plugin codes
 * cannot extend that union (it is `keyof typeof ERROR_CODES`), so they live here in a
 * parallel runtime map. Registrations are reference-counted because the map is
 * process-global while tests or embedders can create more than one server with the same
 * plugin loaded. The error-envelope builder resolves a code's metadata from either
 * source. See ADR-004 (Plugin model) and ADR-006 (Error code registry).
 */
interface PluginErrorCodeRegistration {
  readonly definition: ErrorCodeDefinition
  count: number
}

const pluginErrorCodes = new Map<string, PluginErrorCodeRegistration>()

/**
 * A plugin error-code KEY (the un-namespaced part) must be SCREAMING_SNAKE_CASE:
 * uppercase-alnum words joined by single underscores, no leading/trailing/double `_`.
 */
const PLUGIN_ERROR_CODE_KEY = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/

/**
 * Resolve an error code's definition from the core registry first, then the plugin
 * registry. Returns `undefined` for an unknown code. This is the single lookup the
 * envelope builder uses so core and plugin codes share one resolution path.
 */
export function lookupErrorCodeDefinition(code: string): ErrorCodeDefinition | undefined {
  if (Object.prototype.hasOwnProperty.call(ERROR_CODES, code)) {
    return (ERROR_CODES as Record<string, ErrorCodeDefinition>)[code]
  }
  return pluginErrorCodes.get(code)?.definition
}

/** True when `code` is a registered code — core OR plugin. */
export function isKnownErrorCode(code: string): boolean {
  return lookupErrorCodeDefinition(code) !== undefined
}

/**
 * Register a plugin's error codes under its namespace. Each entry's key is namespaced
 * to `<namespace>.<key>` and stored in the runtime plugin registry. Throws on a
 * malformed key or a conflicting already-registered code (core or plugin) so a
 * misconfigured plugin fails closed at load time rather than shadowing a code silently.
 * Registration is atomic: validation and collision checks finish before the registry is
 * mutated, so a later invalid key cannot leak earlier keys.
 *
 * @returns the full namespaced codes registered (e.g. `['production.NOTARIZATION_FAILED']`).
 */
export function registerPluginErrorCodes(
  namespace: string,
  codes: Readonly<Record<string, ErrorCodeDefinition>>,
): readonly string[] {
  const entries: Array<readonly [string, ErrorCodeDefinition]> = []
  for (const [key, definition] of Object.entries(codes)) {
    if (!PLUGIN_ERROR_CODE_KEY.test(key)) {
      throw new Error(`Plugin "${namespace}" error code "${key}" must be SCREAMING_SNAKE_CASE.`)
    }
    const full = `${namespace}.${key}`
    const existing = pluginErrorCodes.get(full)
    if (existing !== undefined && !samePluginErrorCodeDefinition(existing.definition, definition)) {
      throw new Error(`Duplicate error code registration for "${full}".`)
    }
    entries.push([full, definition])
  }

  for (const [full, definition] of entries) {
    const existing = pluginErrorCodes.get(full)
    if (existing === undefined) {
      pluginErrorCodes.set(full, { definition, count: 1 })
    } else {
      existing.count += 1
    }
  }
  return entries.map(([full]) => full)
}

/**
 * Remove a specific set of namespaced plugin codes (the value returned by
 * {@link registerPluginErrorCodes}). Used by a plugin's teardown so it removes exactly
 * the codes it registered, leaving any other server's codes in the process-global
 * registry intact. Unknown codes are ignored. Idempotent.
 */
export function unregisterPluginErrorCodes(codes: Iterable<string>): void {
  for (const code of codes) {
    const existing = pluginErrorCodes.get(code)
    if (existing === undefined) continue
    existing.count -= 1
    if (existing.count <= 0) pluginErrorCodes.delete(code)
  }
}

/**
 * Remove ALL registered plugin error codes. Coarse reset for test isolation; production
 * teardown uses {@link unregisterPluginErrorCodes} to scope removal to one plugin set.
 * Idempotent.
 */
export function clearPluginErrorCodes(): void {
  pluginErrorCodes.clear()
}

function samePluginErrorCodeDefinition(
  left: ErrorCodeDefinition,
  right: ErrorCodeDefinition,
): boolean {
  return left.http === right.http && left.retryable === right.retryable && left.hint === right.hint
}

/** Typed error class — carry a registered code plus optional structured details. */
export class StagewrightError extends Error {
  public override readonly name = 'StagewrightError'
  public readonly code: ErrorCode
  public readonly details?: Record<string, unknown>

  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? ERROR_CODES[code].hint)
    this.code = code
    if (details !== undefined) {
      this.details = details
    }
  }
}
