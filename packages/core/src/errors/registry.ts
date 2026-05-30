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

  // Waits
  WAIT_TIMEOUT: {
    http: 408,
    retryable: true,
    hint: 'The awaited condition did not hold within timeoutMs; raise timeoutMs or recheck the condition.',
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

/** Returns true when the given string is a registered error code. */
export function isErrorCode(value: string): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, value)
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
