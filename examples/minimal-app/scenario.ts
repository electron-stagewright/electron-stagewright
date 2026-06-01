/**
 * Scripted agent session for the minimal example — the "hello world" of driving an
 * Electron app with Electron Stagewright.
 *
 * Unlike the in-process gated smokes in `packages/core`, this talks to the server
 * the way a real agent host (Claude Desktop, Cursor, Codex) does: an MCP `Client`
 * over `StdioClientTransport`, spawning `node packages/core/dist/cli.js` and
 * exchanging JSON-RPC frames over the child's piped stdio. The transcript below is
 * printed to stderr (the child's stdio carries the protocol, never this process's
 * stdout) and the script exits non-zero if any step fails, so it doubles as a
 * runnable smoke.
 *
 * Run (after `pnpm install` + `pnpm build` at the repo root):
 *   pnpm --filter @electron-stagewright/example-minimal-app scenario
 *
 * @module
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// Resolve the built server entry from the core package via ESM resolution (its
// "." export only declares the `import` condition, so CJS require.resolve fails).
// The "." export is dist/index.js; cli.js sits next to it.
const CORE_ENTRY = fileURLToPath(import.meta.resolve('@electron-stagewright/core'))
const CLI_PATH = path.join(path.dirname(CORE_ENTRY), 'cli.js')
const APP_MAIN = path.join(HERE, 'main.js')

/** Print one transcript line to stderr (stdout is reserved for nothing here, but stderr keeps it clean). */
function log(line: string): void {
  process.stderr.write(`${line}\n`)
}

/** The success/error envelope every tool returns (parsed out of the MCP text content). */
interface Envelope {
  readonly ok: boolean
  readonly code?: string
  readonly error?: string
  readonly message?: string
  readonly [key: string]: unknown
}

let roundTrips = 0

/** Call a tool over MCP, parse its envelope, and throw on a non-ok result. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Envelope> {
  roundTrips += 1
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

async function main(): Promise<void> {
  const transport = new StdioClientTransport({ command: 'node', args: [CLI_PATH] })
  const client = new Client({ name: 'minimal-app-scenario', version: '0.0.0' })
  await client.connect(transport)

  let sessionId: string | undefined
  try {
    const { tools } = await client.listTools()
    log(`Connected. The server offers ${tools.length} tools.`)

    const launched = await call(client, 'electron_launch', { main: APP_MAIN })
    sessionId = launched['session_id'] as string
    log(`Launched the app (session ${sessionId}).`)

    // 1. See what is on screen. Snapshot returns a tree of numbered refs the agent
    //    reuses (the entries live under the `snapshot` envelope field).
    const snap = await call(client, 'electron_snapshot', { sessionId })
    const tree = snap['snapshot'] as
      | { entries?: ReadonlyArray<{ role?: string; name?: string }> }
      | undefined
    const entries = tree?.entries ?? []
    log(`Snapshot: ${entries.length} elements (roles: ${entries.map((e) => e.role).join(', ')}).`)

    // 2. Fill the form by selector (the writes), exercising type / check / select.
    await call(client, 'electron_type', { sessionId, selector: '#name', text: 'Ada Lovelace' })
    await call(client, 'electron_check', { sessionId, selector: '#subscribe' })
    await call(client, 'electron_select_option', { sessionId, selector: '#plan', values: ['pro'] })
    log('Filled name, ticked subscribe, chose the pro plan.')

    // 3. Find the button by role + name (no CSS), then click it by ref — the
    //    agent-native way to reference an element.
    const found = await call(client, 'electron_find', {
      sessionId,
      role: 'button',
      name_contains: 'Greet',
    })
    const match = (found['matches'] as ReadonlyArray<{ ref?: number | null; name?: string }>)[0]
    if (match?.ref == null) throw new Error('Could not find the Greet button by role/name.')
    log(`Found "${match.name}" as ref ${match.ref}; clicking it.`)
    await call(client, 'electron_click', { sessionId, ref: match.ref })

    // 4. Token economy (ADR-007 Principle 8): verifying the greeting the primitive
    //    way is read -> (compare) -> wait -> re-read, several round-trips. The
    //    expect_* primitive folds it into one server-side poll.
    const chainStart = roundTrips
    await call(client, 'electron_get_text', { sessionId, selector: '#status' })
    await call(client, 'electron_wait_for_state', {
      sessionId,
      selector: '#status',
      state: { visible: true },
    })
    await call(client, 'electron_get_text', { sessionId, selector: '#status' })
    const chainCalls = roundTrips - chainStart

    const expectStart = roundTrips
    await call(client, 'electron_expect_text', {
      sessionId,
      selector: '#status',
      contains: 'Hello, Ada Lovelace',
    })
    const expectCalls = roundTrips - expectStart
    log(
      `Verifying the greeting: the primitive chain took ${chainCalls} MCP round-trips; ` +
        `electron_expect_text did it in ${expectCalls}.`,
    )

    // 5. One-shot pattern assertion + a composite state check on the checkbox.
    await call(client, 'electron_assert_pattern', {
      sessionId,
      selector: '#status',
      matches_regex: '^Hello, .+! Plan: .+\\.$',
    })
    await call(client, 'electron_expect_state', {
      sessionId,
      selector: '#subscribe',
      state: { checked: true },
    })
    log('Status text matches the expected pattern and the checkbox reads back checked.')

    // 6. Capture a screenshot (no path -> a temp file) and read the console back.
    const shot = await call(client, 'electron_screenshot', { sessionId })
    log(`Screenshot written to ${shot['path'] as string} (${shot['bytes'] as number} bytes).`)
    const logs = await call(client, 'electron_console_logs', { sessionId, match: 'greeted' })
    log(`Captured ${logs['count'] as number} matching console message(s).`)

    log('Scenario passed.')
  } finally {
    if (sessionId !== undefined) {
      await call(client, 'electron_stop', { sessionId }).catch(() => undefined)
    }
    // Guarded so a teardown error can't mask the real failure that reached finally.
    await client.close().catch(() => undefined)
  }
}

main().catch((err: unknown) => {
  log(`Scenario FAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
