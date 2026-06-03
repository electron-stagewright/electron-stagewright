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

const HERE = path.dirname(fileURLToPath(import.meta.url))
// Resolve the built server entry from the core package via ESM resolution (its "."
// export only declares the `import` condition, so CJS require.resolve fails). cli.js
// sits next to dist/index.js.
const CORE_ENTRY = fileURLToPath(import.meta.resolve('@electron-stagewright/core'))
const CLI_PATH = path.join(path.dirname(CORE_ENTRY), 'cli.js')
const APP_MAIN = path.join(HERE, '..', 'app', 'main.js')

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
  /** Sum of `_meta.estimated_tokens` across those calls. */
  estimatedTokens: number
  /** Sum of client-side wall-clock latency (ms) across those calls. */
  latencyMs: number
}

/** The outcome of one scenario: its metrics plus a memory sample and pass/fail. */
export interface ScenarioResult extends ScenarioMetrics {
  readonly name: string
  readonly description: string
  /** Main-process RSS (bytes) sampled after the scenario, or null if unavailable. */
  readonly memoryRssBytes: number | null
  readonly ok: boolean
  readonly error?: string
}

/** A live driver bound to one server + session, threading the metric accumulator. */
export interface Driver {
  readonly client: Client
  readonly sessionId: string
  readonly metrics: ScenarioMetrics
}

/** One benchmark scenario: a named agent task expressed as a sequence of `call`s. */
export interface Scenario {
  readonly name: string
  readonly description: string
  readonly run: (driver: Driver) => Promise<void>
}

/** Parse a tool result's `content` (the SDK's content-block array) first text block. */
function parseEnvelope(name: string, content: unknown): Envelope {
  const blocks = content as ReadonlyArray<{ readonly type: string; readonly text?: string }>
  const first = blocks[0]
  if (first === undefined || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`${name}: expected a text content block from the MCP response`)
  }
  return JSON.parse(first.text) as Envelope
}

/** A tool call that does NOT touch scenario metrics — used for launch/stop/memory instrumentation. */
async function rawCall(
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
): Promise<Envelope> {
  const start = performance.now()
  const result = await driver.client.callTool({
    name,
    arguments: { sessionId: driver.sessionId, ...args },
  })
  const elapsed = performance.now() - start
  const env = parseEnvelope(name, result.content)
  driver.metrics.toolCalls += 1
  driver.metrics.latencyMs += elapsed
  driver.metrics.estimatedTokens += env._meta?.estimated_tokens ?? 0
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
export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const metrics: ScenarioMetrics = { toolCalls: 0, estimatedTokens: 0, latencyMs: 0 }
  const transport = new StdioClientTransport({ command: 'node', args: [CLI_PATH, '--allow-eval'] })
  const client = new Client({ name: `bench-${scenario.name}`, version: '0.0.0' })
  await client.connect(transport)

  let sessionId: string | undefined
  let memoryRssBytes: number | null = null
  try {
    const launched = await rawCall(client, 'electron_launch', { main: APP_MAIN })
    if (!launched.ok) throw new Error(`launch failed: ${launched.code ?? 'UNKNOWN'}`)
    sessionId = launched['session_id'] as string
    await scenario.run({ client, sessionId, metrics })
    memoryRssBytes = await sampleMemory(client, sessionId)
    return {
      name: scenario.name,
      description: scenario.description,
      ...metrics,
      memoryRssBytes,
      ok: true,
    }
  } catch (err) {
    return {
      name: scenario.name,
      description: scenario.description,
      ...metrics,
      memoryRssBytes,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    if (sessionId !== undefined) {
      await rawCall(client, 'electron_stop', { sessionId }).catch(() => undefined)
    }
    // Guarded so a teardown error can't mask the real failure that reached finally.
    await client.close().catch(() => undefined)
  }
}
