/**
 * Shared real-MCP harness for the cross-framework robustness matrix.
 *
 * Every framework fixture (vanilla, React, ...) renders the SAME UI contract — a
 * "Your name" text input, a button named "Greet", and a `#status` line that becomes
 * "Hello, <name>!" after the click, logging `greeted <name>` to the console. This
 * harness drives that contract over the real MCP protocol (an `Client` over
 * `StdioClientTransport`, spawning `node packages/core/dist/cli.js`), so the identical
 * sequence of tool calls runs against any framework. If a button rendered by React is
 * found and clicked exactly like a vanilla one, the walker and tool layer are
 * framework-agnostic — which is the whole point of the matrix.
 *
 * The runner (`run-matrix.ts`) calls `runFixture` once per framework and aggregates the
 * results. All transcript output goes to stderr; the child's stdio carries the JSON-RPC.
 *
 * @module
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// Resolve the built server entry from the core package via ESM resolution (its "."
// export only declares the `import` condition, so CJS require.resolve fails). The "."
// export is dist/index.js; cli.js sits next to it.
const CORE_ENTRY = fileURLToPath(import.meta.resolve('@electron-stagewright/core'))
const CLI_PATH = path.join(path.dirname(CORE_ENTRY), 'cli.js')

/** The success/error envelope every tool returns (parsed out of the MCP text content). */
export interface Envelope {
  readonly ok: boolean
  readonly code?: string
  readonly error?: string
  readonly message?: string
  readonly [key: string]: unknown
}

/**
 * One framework fixture in the matrix. `main` is the absolute path to its Electron
 * main-process entry; `notes` is the framework-specific quirk it exercises (shown in
 * the runner summary and the README).
 */
export interface FrameworkFixture {
  readonly name: string
  readonly main: string
  readonly notes: string
}

/**
 * The outcome of running the shared scenario against one fixture. `roundTrips` is the
 * number of MCP tool calls made (the launch plus the scenario steps, excluding the
 * teardown stop); `error` is the first failing step's message (only when `ok` is false).
 */
export interface ScenarioResult {
  readonly name: string
  readonly ok: boolean
  readonly roundTrips: number
  readonly error?: string
}

/** A mutable round-trip counter threaded through a single fixture run. */
interface RoundTrips {
  n: number
}

/** Print one transcript line to stderr (stdout stays clean for the child's JSON-RPC). */
function log(line: string): void {
  process.stderr.write(`${line}\n`)
}

/** Call a tool over MCP, count the round-trip, parse its envelope, throw on non-ok. */
async function call(
  client: Client,
  rt: RoundTrips,
  name: string,
  args: Record<string, unknown>,
): Promise<Envelope> {
  rt.n += 1
  const result = await client.callTool({ name, arguments: args })
  const blocks = result.content as ReadonlyArray<{ readonly type: string; readonly text?: string }>
  const first = blocks[0]
  if (first === undefined || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`${name}: expected a text content block from the MCP response`)
  }
  const env = JSON.parse(first.text) as Envelope
  if (!env.ok) {
    throw new Error(`${name} failed: ${env.code ?? 'UNKNOWN'} — ${env.error ?? env.message ?? ''}`)
  }
  return env
}

/** Find one element by role + accessible-name substring, returning its ref. */
async function findRef(
  client: Client,
  rt: RoundTrips,
  sessionId: string,
  role: string,
  nameContains: string,
): Promise<number> {
  const found = await call(client, rt, 'electron_find', {
    sessionId,
    role,
    name_contains: nameContains,
  })
  const matches = found['matches'] as ReadonlyArray<{ ref?: number | null; name?: string }>
  const ref = matches[0]?.ref
  if (ref == null) throw new Error(`Could not find ${role} matching "${nameContains}".`)
  return ref
}

/**
 * The one scenario every fixture runs. It waits for the app to mount (so async-mounting
 * frameworks don't race the first read), then drives the shared UI contract with the
 * same agent-native tools regardless of framework: snapshot, role-count, real keystrokes
 * into the input, semantic find + ref click, a text expectation, screenshot, and a
 * console-log read-back.
 *
 * Keystrokes (not a value-set fill) are used deliberately: they fire per-character
 * events that a controlled component in any framework reacts to, so the harness drives
 * the app the way a user would rather than depending on framework-specific value plumbing.
 */
async function greetingScenario(client: Client, rt: RoundTrips, sessionId: string): Promise<void> {
  // Wait for the app to mount before the first read (frameworks mount asynchronously).
  await call(client, rt, 'electron_expect_visible', { sessionId, selector: '#status' })
  await call(client, rt, 'electron_snapshot', { sessionId })
  // Exactly one "Greet" button exists in the contract — assert it by accessibility role.
  await call(client, rt, 'electron_expect_count', {
    sessionId,
    role: 'button',
    name_contains: 'Greet',
    equals: 1,
  })
  // Real keystrokes into the name field, then find + click the button by ref.
  await call(client, rt, 'electron_keyboard_type', {
    sessionId,
    selector: '#name',
    text: 'Ada Lovelace',
  })
  const greetRef = await findRef(client, rt, sessionId, 'button', 'Greet')
  await call(client, rt, 'electron_click', { sessionId, ref: greetRef })
  await call(client, rt, 'electron_expect_text', {
    sessionId,
    selector: '#status',
    contains: 'Hello, Ada Lovelace',
  })
  await call(client, rt, 'electron_screenshot', { sessionId })
  await call(client, rt, 'electron_console_logs', { sessionId, match: 'greeted' })
}

/**
 * Run the shared scenario against one fixture: connect a fresh MCP client over stdio,
 * launch the fixture's app, drive the contract, and tear the session down. Never throws
 * — a failure is captured in the returned {@link ScenarioResult} so one broken framework
 * does not hide the others.
 */
export async function runFixture(fixture: FrameworkFixture): Promise<ScenarioResult> {
  const rt: RoundTrips = { n: 0 }
  const transport = new StdioClientTransport({ command: 'node', args: [CLI_PATH] })
  const client = new Client({ name: `framework-matrix-${fixture.name}`, version: '0.0.0' })
  await client.connect(transport)

  let sessionId: string | undefined
  try {
    const launched = await call(client, rt, 'electron_launch', { main: fixture.main })
    sessionId = launched['session_id'] as string
    log(`  [${fixture.name}] launched (session ${sessionId})`)
    await greetingScenario(client, rt, sessionId)
    return { name: fixture.name, ok: true, roundTrips: rt.n }
  } catch (err) {
    return {
      name: fixture.name,
      ok: false,
      roundTrips: rt.n,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    if (sessionId !== undefined) {
      await call(client, rt, 'electron_stop', { sessionId }).catch(() => undefined)
    }
    // Guarded so a teardown error can't mask the real failure that reached finally.
    await client.close().catch(() => undefined)
  }
}
