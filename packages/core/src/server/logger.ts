/**
 * Structured logger for the MCP server.
 *
 * ## Why this is stderr-only
 *
 * The default MCP transport is stdio: the server speaks JSON-RPC frames to the
 * client over **stdout**. Anything written to stdout that is not a protocol
 * frame corrupts that stream and breaks the client — often silently, with the
 * client simply seeing a malformed message and dropping the connection. So
 * every diagnostic this logger emits goes to **stderr**, which the client
 * ignores for protocol purposes. Tool handlers and the dispatcher MUST use this
 * logger (or `console.error`) and never `console.log` / `process.stdout.write`.
 *
 * The sink is injectable so tests can capture lines without touching the real
 * file descriptors (and assert that stdout stays untouched).
 *
 * @module
 */

/** Severity levels, ordered least-to-most severe. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Numeric rank per level, used for threshold filtering. */
const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

/** Structured fields attached to a log line. Values must be JSON-serialisable. */
export type LogFields = Readonly<Record<string, unknown>>

/**
 * Logging surface handed to tool handlers via the tool context. Intentionally
 * minimal — four severities, each taking a message and optional structured
 * fields.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
}

/**
 * Elapsed-time threshold (ms) above which a tool dispatch is considered slow and
 * the dispatcher emits a `warn`. Surfacing slow ops helps operators spot a
 * hung Electron app or a pathological selector without a profiler.
 */
export const SLOW_OP_THRESHOLD_MS = 1000

/** Max retained characters before a value is treated as oversized and truncated. */
const MAX_FIELD_STRING_LENGTH = 256
/** How many leading characters to keep when truncating an oversized value. */
const TRUNCATED_PREFIX_LENGTH = 50
const TRUNCATION_MARKER = '…[base64 truncated]'

/** Matches a string that is plausibly base64 (charset only); used to spot image payloads. */
const BASE64_LIKE = /^[A-Za-z0-9+/=\r\n]+$/

/**
 * Truncate a single value when it is an oversized string that looks like base64
 * image data (or a `data:` URL). Such values — screenshots, encoded files —
 * would otherwise flood the log. Non-string and short values pass through
 * unchanged. Exported for unit tests.
 */
export function truncateForLog(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const isDataUrl = value.startsWith('data:')
  const isLongBase64 = value.length > MAX_FIELD_STRING_LENGTH && BASE64_LIKE.test(value)
  if (!isDataUrl && !isLongBase64) return value
  return `${value.slice(0, TRUNCATED_PREFIX_LENGTH)}${TRUNCATION_MARKER}`
}

/** Apply {@link truncateForLog} to each top-level field value. */
function sanitizeFields(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = truncateForLog(value)
  }
  return out
}

/** Options for {@link StderrLogger}. */
export interface StderrLoggerOptions {
  /** Minimum level to emit. Lines below this rank are dropped. Defaults to `info`. */
  readonly level?: LogLevel
  /**
   * Where formatted lines go. Defaults to writing to `process.stderr`. Tests
   * inject a capturing sink. The sink receives one fully-formatted line WITHOUT
   * a trailing newline.
   */
  readonly sink?: (line: string) => void
  /** Clock injection for deterministic timestamps in tests. */
  readonly now?: () => Date
}

/**
 * Default {@link Logger} implementation. Formats each line as
 * `<ISO timestamp> <LEVEL> <message> <json-fields?>` and writes it to stderr (or
 * the injected sink). Filters by configured level.
 */
export class StderrLogger implements Logger {
  readonly #level: number
  readonly #sink: (line: string) => void
  readonly #now: () => Date

  constructor(opts: StderrLoggerOptions = {}) {
    this.#level = LEVEL_RANK[opts.level ?? 'info']
    this.#sink = opts.sink ?? ((line) => void process.stderr.write(`${line}\n`))
    this.#now = opts.now ?? (() => new Date())
  }

  debug(message: string, fields?: LogFields): void {
    this.#emit('debug', message, fields)
  }

  info(message: string, fields?: LogFields): void {
    this.#emit('info', message, fields)
  }

  warn(message: string, fields?: LogFields): void {
    this.#emit('warn', message, fields)
  }

  error(message: string, fields?: LogFields): void {
    this.#emit('error', message, fields)
  }

  #emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < this.#level) return
    const ts = this.#now().toISOString()
    const head = `${ts} ${level.toUpperCase()} ${message}`
    if (fields === undefined || Object.keys(fields).length === 0) {
      this.#sink(head)
      return
    }
    let serialized: string
    try {
      serialized = JSON.stringify(sanitizeFields(fields))
    } catch {
      // Never let a logging call throw (e.g. a circular field). Fall back to a marker.
      serialized = '{"_log_error":"fields not serialisable"}'
    }
    this.#sink(`${head} ${serialized}`)
  }
}

/** A {@link Logger} that discards everything. Useful as a default in tests. */
export const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}
