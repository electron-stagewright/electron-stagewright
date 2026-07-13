/**
 * Benchmark harness. Drives agent-task scenarios over the REAL MCP protocol — an
 * `Client` over `StdioClientTransport` spawning `node packages/core/dist/cli.js` (the
 * same path a real agent host uses) against the tiny bench app — and records, per
 * scenario: tool-call count, summed estimated tokens (read off each envelope's `_meta`),
 * wall-clock latency, and main-process memory.
 *
 * The point is to quantify the token-economy thesis (ADR-007): the same agent task done
 * with the primitive chain vs the `expect_*` family should differ measurably in
 * round-trips and tokens. Tool-call count and estimated tokens are deterministic; latency
 * and memory are environment-dependent and reported as observed.
 *
 * The server is started with `--allow-eval` so memory can be sampled via
 * `electron_eval_main` (a bench-only instrumentation call, excluded from scenario metrics).
 *
 * @module
 */

import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { countRealTokens } from './tokenizer.js'
import type { ToolProfile } from '@electron-stagewright/core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// Resolve the built server entry from the core package via ESM resolution (its "."
// export only declares the `import` condition, so CJS require.resolve fails). cli.js
// sits next to dist/index.js.
const CORE_ENTRY = fileURLToPath(import.meta.resolve('@electron-stagewright/core'))
const CLI_PATH = path.join(path.dirname(CORE_ENTRY), 'cli.js')
/** Absolute entry of the small, deterministic Electron fixture used by every comparison target. */
export const BENCH_APP_MAIN = path.join(HERE, '..', 'app', 'main.js')

/**
 * The MCP SDK deliberately starts stdio children with a small safe environment rather than inheriting
 * all of the host process. Electron needs these display/sandbox values when the harness runs under
 * Linux/Xvfb, so forward only this explicit allowlist. The JSON report records names, never values.
 */
export const BENCHMARK_CHILD_ENVIRONMENT_VARIABLES = [
  'ELECTRON_DISABLE_SANDBOX',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
] as const

/** Keep only the Electron display values a stdio MCP child needs; never forward arbitrary host secrets. */
export function benchmarkChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const selected: Record<string, string> = {}
  for (const name of BENCHMARK_CHILD_ENVIRONMENT_VARIABLES) {
    const value = environment[name]
    // Match the MCP SDK's defense against exported shell functions and omit empty values that provide
    // no usable display configuration.
    if (value !== undefined && value.length > 0 && !value.startsWith('()')) selected[name] = value
  }
  return selected
}

/** Environment knob used by diagnostics to bound every externally observable benchmark phase. */
export const BENCHMARK_PHASE_TIMEOUT_ENV = 'STAGEWRIGHT_BENCH_PHASE_TIMEOUT_MS'

/** A local default leaves room for a cold Electron start while preventing an indefinitely stuck run. */
export const DEFAULT_BENCHMARK_PHASE_TIMEOUT_MS = 60_000

/** Parse the phase timeout once per scenario and reject unsafe CI configuration instead of silently hanging. */
export function resolveBenchmarkPhaseTimeout(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment[BENCHMARK_PHASE_TIMEOUT_ENV]
  if (raw === undefined || raw.length === 0) return DEFAULT_BENCHMARK_PHASE_TIMEOUT_MS
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${BENCHMARK_PHASE_TIMEOUT_ENV} must be a positive integer in milliseconds`)
  }
  const timeoutMs = Number(raw)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`${BENCHMARK_PHASE_TIMEOUT_ENV} must be a positive integer in milliseconds`)
  }
  return timeoutMs
}

/** Named portions of a real run, retained in the JSON artifact to localize a CI failure. */
export type BenchmarkPhase = 'connect' | 'launch' | 'scenario' | 'memory' | 'stop'

/** One bounded phase's outcome. Error values are diagnostic text, never child environment values. */
export interface BenchmarkPhaseDiagnostic {
  readonly phase: BenchmarkPhase
  readonly outcome: 'ok' | 'error' | 'timeout'
  readonly elapsedMs: number
  readonly timeoutMs?: number
  readonly error?: string
}

/** Per-scenario execution evidence that turns a failed CI run into an actionable artifact. */
export interface BenchmarkDiagnostics {
  readonly phaseTimeoutMs: number
  /** Names only, so the artifact proves the child setup without exposing runtime values. */
  readonly childEnvironment: readonly string[]
  readonly phases: ReadonlyArray<BenchmarkPhaseDiagnostic>
}

/** Mutable recorder used only while a benchmark run is in flight. */
export interface BenchmarkDiagnosticsRecorder extends BenchmarkDiagnostics {
  readonly phases: BenchmarkPhaseDiagnostic[]
}

/** Create a phase recorder whose completed result is exposed as read-only diagnostics. */
export function createBenchmarkDiagnostics(
  phaseTimeoutMs: number,
  environment: Readonly<Record<string, string>> | undefined,
): BenchmarkDiagnosticsRecorder {
  return {
    phaseTimeoutMs,
    childEnvironment: Object.keys(environment ?? {}).sort(),
    phases: [],
  }
}

class BenchmarkPhaseTimeoutError extends Error {
  readonly phase: BenchmarkPhase
  readonly timeoutMs: number

  constructor(phase: BenchmarkPhase, timeoutMs: number) {
    super(`${phase} timed out after ${timeoutMs}ms`)
    this.name = 'BenchmarkPhaseTimeoutError'
    this.phase = phase
    this.timeoutMs = timeoutMs
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Measure and bound one observable phase without changing the task-level benchmark metrics. */
export async function measureBenchmarkPhase<T>(
  diagnostics: BenchmarkDiagnosticsRecorder,
  phase: BenchmarkPhase,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new BenchmarkPhaseTimeoutError(phase, diagnostics.phaseTimeoutMs)),
          diagnostics.phaseTimeoutMs,
        )
      }),
    ])
    diagnostics.phases.push({
      phase,
      outcome: 'ok',
      elapsedMs: performance.now() - startedAt,
    })
    return result
  } catch (error) {
    const timeout = error instanceof BenchmarkPhaseTimeoutError
    diagnostics.phases.push({
      phase,
      outcome: timeout ? 'timeout' : 'error',
      elapsedMs: performance.now() - startedAt,
      ...(timeout ? { timeoutMs: diagnostics.phaseTimeoutMs } : {}),
      error: errorMessage(error),
    })
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const STAGEWRIGHT_CHILD_ENVIRONMENT = benchmarkChildEnvironment()

/** The success/error envelope every tool returns, including the `_meta` cost block. */
export interface Envelope {
  readonly ok: boolean
  readonly code?: string
  readonly error?: string
  readonly message?: string
  readonly _meta?: { readonly estimated_tokens?: number; readonly elapsed_ms?: number }
  readonly [key: string]: unknown
}

/** The metrics accumulated while a scenario runs (scenario steps only, not instrumentation). */
export interface ScenarioMetrics {
  /** Number of MCP tool calls the scenario made (its agent-task steps). */
  toolCalls: number
  /** Sum of `_meta.estimated_tokens` across those calls (the server's char/4 heuristic). */
  estimatedTokens: number
  /** REAL BPE tokens in the JSON `{ name, arguments }` payloads the agent sent. */
  requestTokens: number
  /**
   * Sum of REAL BPE tokens across those calls, counted client-side over each raw
   * response text with `gpt-tokenizer` (see `tokenizer.ts` for the proxy caveat).
   */
  measuredTokens: number
  /** Unicode code points in the JSON `{ name, arguments }` payloads the agent sent. */
  requestCharacters: number
  /** Unicode code points across raw tool-response text blocks. */
  responseCharacters: number
  /** Tool calls whose envelope was `ok: false`, including deliberate recovery probes. */
  failedCalls: number
  /** Calls explicitly marked by a scenario as an attempt after a prior recovery step. */
  retries: number
  /** Sum of client-side wall-clock latency (ms) across those calls. */
  latencyMs: number
}

/** The outcome of one scenario: its metrics plus a memory sample and pass/fail. */
export interface ScenarioResult extends ScenarioMetrics {
  readonly name: string
  readonly description: string
  /** Main-process RSS (bytes) sampled after the scenario, or null if unavailable. */
  readonly memoryRssBytes: number | null
  /** Phase-by-phase execution evidence when this result came from the real harness. */
  readonly diagnostics?: BenchmarkDiagnostics
  readonly ok: boolean
  readonly error?: string
}

/** A live driver bound to one server + session, threading the metric accumulator. */
export interface Driver {
  readonly client: Client
  readonly sessionId: string
  /** Target-specific session fields injected into every scenario call (empty for sessionless rivals). */
  readonly sessionArgs: Readonly<Record<string, unknown>>
  readonly metrics: ScenarioMetrics
}

/** Optional metadata for one scenario call. */
export interface CallOptions {
  /** Marks this call as an explicit retry after the scenario recovered context or state. */
  readonly retry?: boolean
}

/** One benchmark scenario: a named agent task expressed as a sequence of `call`s. */
export interface Scenario {
  readonly name: string
  readonly description: string
  readonly run: (driver: Driver) => Promise<void>
}

/** Reproducibility identity for a benchmark target. */
export interface TargetProvenance {
  /** Whether this target is run from this checkout or from an installed npm package. */
  readonly source: 'workspace' | 'npm'
  /** Package name and exact version behind the executable. */
  readonly package: { readonly name: string; readonly version: string }
  /** Immutable source revision when the registry published it from a Git commit. */
  readonly sourceCommit?: string
  /** Version the target announces during MCP initialization when it differs from its package version. */
  readonly reportedServerVersion?: string
  /** Registry location and content hashes for a pinned npm target. */
  readonly dist?: {
    readonly tarball: string
    readonly sha256: string
    readonly integrity: string
  }
}

/**
 * The spawn configuration for one MCP server under benchmark — ours or a competitor's. The harness
 * spawns it over stdio exactly like a real agent host would, so any server speaking MCP can be
 * compared by supplying its launch command. `supportsMemory` flags whether the server can report
 * main-process memory (ours does via `electron_eval_main`; a competitor that cannot simply omits it).
 */
export interface ServerTarget {
  /** Short label shown in the comparison table and the JSON report. */
  readonly name: string
  /** Executable to spawn (e.g. `node`, `npx`). */
  readonly command: string
  /** Arguments to the executable (the server entry + its flags). */
  readonly args: readonly string[]
  /** Extra values explicitly forwarded to the MCP SDK's otherwise restricted child environment. */
  readonly env?: Readonly<Record<string, string>>
  /** Whether this server can sample memory (gates the per-target memory column). */
  readonly supportsMemory?: boolean
  /** Pinned source identity written to a comparison artifact. */
  readonly provenance: TargetProvenance
}

/** Our own server as a benchmark target: the built cli.js, started with `--allow-eval` for memory. */
export const STAGEWRIGHT_TARGET: ServerTarget = {
  name: 'stagewright',
  command: 'node',
  args: [CLI_PATH, '--allow-eval'],
  env: STAGEWRIGHT_CHILD_ENVIRONMENT,
  supportsMemory: true,
  provenance: {
    source: 'workspace',
    package: { name: '@electron-stagewright/core', version: '0.2.0' },
  },
}

/**
 * Fair cross-server target: no eval capability and no memory instrumentation. A comparison must not
 * grant Stagewright a tool or process privilege that the competing server cannot use.
 */
export const STAGEWRIGHT_COMPARISON_TARGET: ServerTarget = {
  name: STAGEWRIGHT_TARGET.name,
  command: STAGEWRIGHT_TARGET.command,
  args: [CLI_PATH],
  env: STAGEWRIGHT_CHILD_ENVIRONMENT,
  provenance: STAGEWRIGHT_TARGET.provenance,
}

/** Build a Stagewright target whose core tools are limited by one explicit profile. */
export function stagewrightProfileTarget(profile: ToolProfile): ServerTarget {
  return {
    name: `stagewright-${profile}`,
    command: 'node',
    args: [CLI_PATH, '--tool-profile', profile],
    env: STAGEWRIGHT_CHILD_ENVIRONMENT,
    provenance: STAGEWRIGHT_TARGET.provenance,
  }
}

/**
 * One fair agent task, described abstractly so the SAME task can be expressed against different
 * servers' tool vocabularies (each via a {@link TaskAdapter}). The task itself carries no tool names —
 * only an identity and a human description — so the comparison contrasts *how each server does it*.
 */
export interface ComparableTask {
  readonly name: string
  readonly description: string
  /** Exact visible-text condition every cross-server target must prove after performing the task. */
  readonly oracle?: {
    readonly selector: string
    readonly expectedText: string
  }
}

/**
 * Binds one {@link ComparableTask} to one {@link ServerTarget}: it knows how to launch the app, run
 * the task's steps through THAT server's tools (threading the metric accumulator via {@link call}), and
 * stop the session. Adding a competitor to the comparison means writing one adapter — see the bench
 * README. `sampleMemory` is optional: provide it only for a server that can report memory.
 */
export interface TaskAdapter {
  readonly target: ServerTarget
  readonly task: ComparableTask
  /** Launch the app under this server and return the session id used by later calls. */
  launch(client: Client): Promise<string>
  /**
   * Fields added to every task call after launch. Stagewright uses `{ sessionId }`; servers that keep
   * process state internally return `{}` so their wire payload is not distorted by our harness.
   */
  sessionArgs?(sessionId: string): Readonly<Record<string, unknown>>
  /** Run the task's steps via this server's tools, counting them into the driver's metrics. */
  run(driver: Driver): Promise<void>
  /** End the session (best-effort; the runner also closes the client). */
  stop(client: Client, sessionId: string): Promise<void>
  /** Optionally sample main-process memory after the task (omit when unsupported). */
  sampleMemory?(client: Client, sessionId: string): Promise<number | null>
}

/** The outcome of running one task against one target — the comparison's per-row record. */
export interface ComparisonResult extends ScenarioMetrics {
  /** The server target this row measured (the {@link ServerTarget.name}). */
  readonly target: string
  /** The shared task this row measured (the {@link ComparableTask.name}). */
  readonly task: string
  /** Main-process RSS (bytes) when the target supports it, else null. */
  readonly memoryRssBytes: number | null
  /** The parsed `{ tools }` value the spawned MCP host received before the task, or null on connect failure. */
  readonly manifest: {
    readonly characters: number
    readonly bpe: number
    /** Cold spawn + initialize + `tools/list` wall-clock time, observed locally. */
    readonly coldStartMs: number
  } | null
  readonly ok: boolean
  readonly error?: string
}

/** Extract a tool result's first text block (the raw wire text of the envelope). */
function firstTextBlock(name: string, content: unknown): string {
  const blocks = content as ReadonlyArray<{ readonly type: string; readonly text?: string }>
  const first = blocks[0]
  if (first === undefined || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`${name}: expected a text content block from the MCP response`)
  }
  return first.text
}

/** Parse a tool result's `content` (the SDK's content-block array) first text block. */
function parseEnvelope(name: string, content: unknown): Envelope {
  return JSON.parse(firstTextBlock(name, content)) as Envelope
}

/** A tool call that does NOT touch scenario metrics — used for launch/stop/memory instrumentation. */
export async function rawCall(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Envelope> {
  const result = await client.callTool({ name, arguments: args })
  return parseEnvelope(name, result.content)
}

/**
 * Make a tool call as part of a scenario: time it, count it, and add its estimated tokens
 * to the driver's metrics. Returns the envelope WITHOUT throwing on `ok:false`, so a
 * scenario can deliberately observe an error (the error-recovery path) and continue.
 * `sessionId` is injected automatically.
 */
export async function call(
  driver: Driver,
  name: string,
  args: Record<string, unknown> = {},
  options: CallOptions = {},
): Promise<Envelope> {
  const callArgs = { ...driver.sessionArgs, ...args }
  const requestText = JSON.stringify({ name, arguments: callArgs })
  const start = performance.now()
  const result = await driver.client.callTool({
    name,
    arguments: callArgs,
  })
  const elapsed = performance.now() - start
  const text = firstTextBlock(name, result.content)
  const env = JSON.parse(text) as Envelope
  driver.metrics.toolCalls += 1
  driver.metrics.latencyMs += elapsed
  driver.metrics.estimatedTokens += env._meta?.estimated_tokens ?? 0
  driver.metrics.requestTokens += countRealTokens(requestText)
  driver.metrics.measuredTokens += countRealTokens(text)
  driver.metrics.requestCharacters += Array.from(requestText).length
  driver.metrics.responseCharacters += Array.from(text).length
  if (!env.ok) driver.metrics.failedCalls += 1
  if (options.retry === true) driver.metrics.retries += 1
  return env
}

/** Find one element by role + accessible-name substring; throws if absent (scenario fails). */
export async function findRef(driver: Driver, role: string, nameContains: string): Promise<number> {
  const found = await call(driver, 'electron_find', { role, name_contains: nameContains })
  const matches = found['matches'] as ReadonlyArray<{ ref?: number | null }>
  const ref = matches[0]?.ref
  if (ref == null) throw new Error(`could not find ${role} matching "${nameContains}"`)
  return ref
}

/** Sample the Electron main-process RSS via eval (bench instrumentation; not counted). */
async function sampleMemory(client: Client, sessionId: string): Promise<number | null> {
  // The eval body runs inside `(async () => { <code> })()`, so it must `return` its value.
  const env = await rawCall(client, 'electron_eval_main', {
    sessionId,
    code: 'return process.memoryUsage().rss',
  })
  return env.ok && typeof env['result'] === 'number' ? (env['result'] as number) : null
}

/**
 * Run one scenario end to end: connect a fresh MCP client (server started with
 * `--allow-eval`), launch the bench app, run the scenario, sample memory, and tear down.
 * Never throws — a failure is captured in the returned {@link ScenarioResult}.
 */
export async function runScenario(
  scenario: Scenario,
  target: ServerTarget = STAGEWRIGHT_TARGET,
): Promise<ScenarioResult> {
  const metrics: ScenarioMetrics = {
    toolCalls: 0,
    estimatedTokens: 0,
    requestTokens: 0,
    measuredTokens: 0,
    requestCharacters: 0,
    responseCharacters: 0,
    failedCalls: 0,
    retries: 0,
    latencyMs: 0,
  }
  const diagnostics = createBenchmarkDiagnostics(resolveBenchmarkPhaseTimeout(), target.env)
  const transport = new StdioClientTransport({
    command: target.command,
    args: [...target.args],
    ...(target.env !== undefined ? { env: target.env } : {}),
  })
  const client = new Client({ name: `bench-${scenario.name}`, version: '0.0.0' })

  let activeSessionId: string | undefined
  let memoryRssBytes: number | null = null
  try {
    await measureBenchmarkPhase(diagnostics, 'connect', () => client.connect(transport))
    const launched = await measureBenchmarkPhase(diagnostics, 'launch', async () => {
      const envelope = await rawCall(client, 'electron_launch', { main: BENCH_APP_MAIN })
      if (!envelope.ok) throw new Error(`launch failed: ${envelope.code ?? 'UNKNOWN'}`)
      return envelope
    })
    const launchedSessionId = launched['session_id']
    if (typeof launchedSessionId !== 'string' || launchedSessionId.length === 0) {
      throw new Error('launch succeeded without a session_id')
    }
    const sessionId = launchedSessionId
    activeSessionId = sessionId
    await measureBenchmarkPhase(diagnostics, 'scenario', () =>
      scenario.run({ client, sessionId, sessionArgs: { sessionId }, metrics }),
    )
    memoryRssBytes = await measureBenchmarkPhase(diagnostics, 'memory', () =>
      sampleMemory(client, sessionId),
    )
    return {
      name: scenario.name,
      description: scenario.description,
      ...metrics,
      memoryRssBytes,
      diagnostics,
      ok: true,
    }
  } catch (err) {
    return {
      name: scenario.name,
      description: scenario.description,
      ...metrics,
      memoryRssBytes,
      diagnostics,
      ok: false,
      error: errorMessage(err),
    }
  } finally {
    const sessionId = activeSessionId
    if (sessionId !== undefined) {
      await measureBenchmarkPhase(diagnostics, 'stop', () =>
        rawCall(client, 'electron_stop', { sessionId }),
      ).catch(() => undefined)
    }
    // Guarded so a teardown error can't mask the real failure that reached finally.
    await client.close().catch(() => undefined)
    // `client.close()` normally delegates here, but closing explicitly also terminates a server that
    // timed out during initialization before the client considered itself connected.
    await transport.close().catch(() => undefined)
  }
}

/** How {@link runAdapter} obtains a connected MCP client for a target — injectable for tests. */
export type ConnectFn = (target: ServerTarget) => Promise<Client>

/** Default connect: spawn the target server over stdio and connect a client (the production path). */
const defaultConnect: ConnectFn = async (target) => {
  const transport = new StdioClientTransport({
    command: target.command,
    args: [...target.args],
    ...(target.env !== undefined ? { env: target.env } : {}),
  })
  const client = new Client({ name: `bench-${target.name}`, version: '0.0.0' })
  await client.connect(transport)
  return client
}

/**
 * Run one {@link TaskAdapter} end to end against its target: connect, launch, run the task, sample
 * memory (when the adapter supports it), and tear down. Never throws — a failure is captured in the
 * returned {@link ComparisonResult}. Pass `connect` to inject a fake client (tests); production spawns
 * the target server over stdio.
 */
export async function runAdapter(
  adapter: TaskAdapter,
  connect: ConnectFn = defaultConnect,
): Promise<ComparisonResult> {
  const metrics: ScenarioMetrics = {
    toolCalls: 0,
    estimatedTokens: 0,
    requestTokens: 0,
    measuredTokens: 0,
    requestCharacters: 0,
    responseCharacters: 0,
    failedCalls: 0,
    retries: 0,
    latencyMs: 0,
  }
  // `connect` (the stdio spawn) is INSIDE the try so a spawn failure becomes an ok:false row, not a
  // thrown exception — runAdapter never throws, so one unlaunchable target can't sink the comparison.
  let client: Client | undefined
  let sessionId: string | undefined
  let memoryRssBytes: number | null = null
  let manifest: ComparisonResult['manifest'] = null
  try {
    const coldStart = performance.now()
    client = await connect(adapter.target)
    const { tools } = await client.listTools()
    const manifestPayload = JSON.stringify({ tools })
    manifest = {
      characters: Array.from(manifestPayload).length,
      bpe: countRealTokens(manifestPayload),
      coldStartMs: performance.now() - coldStart,
    }
    sessionId = await adapter.launch(client)
    await adapter.run({
      client,
      sessionId,
      sessionArgs: adapter.sessionArgs?.(sessionId) ?? { sessionId },
      metrics,
    })
    if (adapter.sampleMemory !== undefined) {
      memoryRssBytes = await adapter.sampleMemory(client, sessionId)
    }
    return {
      target: adapter.target.name,
      task: adapter.task.name,
      ...metrics,
      memoryRssBytes,
      manifest,
      ok: true,
    }
  } catch (err) {
    return {
      target: adapter.target.name,
      task: adapter.task.name,
      ...metrics,
      memoryRssBytes,
      manifest,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    if (client !== undefined && sessionId !== undefined) {
      await adapter.stop(client, sessionId).catch(() => undefined)
    }
    await client?.close().catch(() => undefined)
  }
}

/**
 * Build a {@link TaskAdapter} for OUR server: launch the bench app via `electron_launch`, run the
 * supplied task steps via our tools, stop via `electron_stop`, and sample memory via eval. The step
 * sequence is supplied by the caller (see `adapters.ts`) so this one factory serves every shared task.
 */
export function stagewrightAdapter(
  task: ComparableTask,
  run: (driver: Driver) => Promise<void>,
  target: ServerTarget = STAGEWRIGHT_TARGET,
): TaskAdapter {
  return {
    target,
    task,
    launch: async (client) => {
      const env = await rawCall(client, 'electron_launch', { main: BENCH_APP_MAIN })
      if (!env.ok) throw new Error(`launch failed: ${env.code ?? 'UNKNOWN'}`)
      return env['session_id'] as string
    },
    sessionArgs: (sessionId) => ({ sessionId }),
    run,
    stop: async (client, sessionId) => {
      await rawCall(client, 'electron_stop', { sessionId }).catch(() => undefined)
    },
    ...(target.supportsMemory === true
      ? { sampleMemory: (client: Client, sessionId: string) => sampleMemory(client, sessionId) }
      : {}),
  }
}
