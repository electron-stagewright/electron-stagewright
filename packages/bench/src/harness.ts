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
  /** Sum of `_meta.estimated_tokens` across those calls (the server's char/4 heuristic). */
  estimatedTokens: number
  /**
   * Sum of REAL BPE tokens across those calls, counted client-side over each raw
   * response text with `gpt-tokenizer` (see `tokenizer.ts` for the proxy caveat).
   */
  measuredTokens: number
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
  /** Extra environment variables for the spawned server, merged over the inherited env. */
  readonly env?: Readonly<Record<string, string>>
  /** Whether this server can sample memory (gates the per-target memory column). */
  readonly supportsMemory?: boolean
}

/** Our own server as a benchmark target: the built cli.js, started with `--allow-eval` for memory. */
export const STAGEWRIGHT_TARGET: ServerTarget = {
  name: 'stagewright',
  command: 'node',
  args: [CLI_PATH, '--allow-eval'],
  supportsMemory: true,
}

/**
 * One fair agent task, described abstractly so the SAME task can be expressed against different
 * servers' tool vocabularies (each via a {@link TaskAdapter}). The task itself carries no tool names —
 * only an identity and a human description — so the comparison contrasts *how each server does it*.
 */
export interface ComparableTask {
  readonly name: string
  readonly description: string
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
  const text = firstTextBlock(name, result.content)
  const env = JSON.parse(text) as Envelope
  driver.metrics.toolCalls += 1
  driver.metrics.latencyMs += elapsed
  driver.metrics.estimatedTokens += env._meta?.estimated_tokens ?? 0
  driver.metrics.measuredTokens += countRealTokens(text)
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
    measuredTokens: 0,
    latencyMs: 0,
  }
  const transport = new StdioClientTransport({
    command: target.command,
    args: [...target.args],
    ...(target.env !== undefined ? { env: target.env } : {}),
  })
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
    measuredTokens: 0,
    latencyMs: 0,
  }
  // `connect` (the stdio spawn) is INSIDE the try so a spawn failure becomes an ok:false row, not a
  // thrown exception — runAdapter never throws, so one unlaunchable target can't sink the comparison.
  let client: Client | undefined
  let sessionId: string | undefined
  let memoryRssBytes: number | null = null
  try {
    client = await connect(adapter.target)
    sessionId = await adapter.launch(client)
    await adapter.run({ client, sessionId, metrics })
    if (adapter.sampleMemory !== undefined) {
      memoryRssBytes = await adapter.sampleMemory(client, sessionId)
    }
    return {
      target: adapter.target.name,
      task: adapter.task.name,
      ...metrics,
      memoryRssBytes,
      ok: true,
    }
  } catch (err) {
    return {
      target: adapter.target.name,
      task: adapter.task.name,
      ...metrics,
      memoryRssBytes,
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
): TaskAdapter {
  return {
    target: STAGEWRIGHT_TARGET,
    task,
    launch: async (client) => {
      const env = await rawCall(client, 'electron_launch', { main: APP_MAIN })
      if (!env.ok) throw new Error(`launch failed: ${env.code ?? 'UNKNOWN'}`)
      return env['session_id'] as string
    },
    run,
    stop: async (client, sessionId) => {
      await rawCall(client, 'electron_stop', { sessionId }).catch(() => undefined)
    },
    sampleMemory: (client, sessionId) => sampleMemory(client, sessionId),
  }
}
