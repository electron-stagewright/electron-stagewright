/**
 * Scripted agent session for the code-editor-shaped example — modeled on a real code
 * editor (Lingua): a keyboard-heavy editor buffer, a license activation flow with a
 * failure path, and a runtime sandbox whose status only settles asynchronously.
 *
 * Like the other examples, this talks to the server the way a real agent host (Claude
 * Desktop, Cursor, Codex) does: an MCP `Client` over `StdioClientTransport`, spawning
 * `node packages/core/dist/cli.js` and exchanging JSON-RPC frames over the child's
 * piped stdio. The transcript prints to stderr (the child's stdio carries the
 * protocol, never this process's stdout) and the script exits non-zero if any step
 * fails, so it doubles as a runnable smoke.
 *
 * What it proves beyond the earlier examples: per-keystroke typing into a code buffer
 * read back by `.value`; an assertion on a deliberate FAILURE (a rejected license)
 * before the success path; and `expect_*` polling until an asynchronous runtime status
 * settles — a read-once would race it.
 *
 * Run (after `pnpm install` + `pnpm build` at the repo root):
 *   pnpm --filter @electron-stagewright/example-code-editor-shape scenario
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

/** Print one transcript line to stderr (stdout stays clean for the child's JSON-RPC). */
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

/** One accessibility-tree entry as returned in a find result. */
interface FoundMatch {
  readonly ref?: number | null
  readonly name?: string
}

/** Call a tool over MCP, parse its envelope, and throw on a non-ok result. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Envelope> {
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
  sessionId: string,
  role: string,
  nameContains: string,
): Promise<number> {
  const found = await call(client, 'electron_find', {
    sessionId,
    role,
    name_contains: nameContains,
  })
  const match = (found['matches'] as ReadonlyArray<FoundMatch>)[0]
  if (match?.ref == null) {
    throw new Error(`Could not find ${role} matching "${nameContains}".`)
  }
  return match.ref
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({ command: 'node', args: [CLI_PATH] })
  const client = new Client({ name: 'code-editor-shape-scenario', version: '0.0.0' })
  await client.connect(transport)

  let sessionId: string | undefined
  try {
    const { tools } = await client.listTools()
    log(`Connected. The server offers ${tools.length} tools.`)

    const launched = await call(client, 'electron_launch', { main: APP_MAIN })
    sessionId = launched['session_id'] as string
    log(`Launched the editor (session ${sessionId}).`)

    await call(client, 'electron_snapshot', { sessionId })

    // 1. Editor buffer: type code as REAL per-character keystrokes (newlines included),
    //    then read it back by `.value` — the editor's state is a value, not text.
    await call(client, 'electron_keyboard_type', {
      sessionId,
      selector: '#editor',
      text: 'const greet = () => console.log("ready")\ngreet()',
    })
    await call(client, 'electron_expect_value', {
      sessionId,
      selector: '#editor',
      contains: 'console.log',
    })
    log('Typed code into the editor and confirmed the buffer by value.')

    // 2. License flow, FAILURE first: a malformed key must be rejected. Asserting the
    //    error path is as important as the happy path.
    const activateRef = await findRef(client, sessionId, 'button', 'Activate License')
    await call(client, 'electron_type', { sessionId, selector: '#license-key', text: 'not-a-key' })
    await call(client, 'electron_click', { sessionId, ref: activateRef })
    await call(client, 'electron_expect_text', {
      sessionId,
      selector: '#license-status',
      contains: 'invalid',
    })
    log('A malformed license key was rejected, as expected.')

    // 3. License success: a well-formed key activates. electron_type sets the value
    //    directly, overwriting the malformed attempt — no separate clear needed.
    await call(client, 'electron_type', {
      sessionId,
      selector: '#license-key',
      text: 'LINGUA-AB12',
    })
    await call(client, 'electron_click', { sessionId, ref: activateRef })
    await call(client, 'electron_expect_text', {
      sessionId,
      selector: '#license-status',
      contains: 'active',
    })
    log('A well-formed license key activated the license.')

    // 4. Runtime sandbox: starting it reports "running" only after an async delay
    //    (an IPC-like round-trip). expect_text polls until the delayed status settles —
    //    a single read here would race and see "starting...".
    const runtimeRef = await findRef(client, sessionId, 'button', 'Start Runtime')
    await call(client, 'electron_click', { sessionId, ref: runtimeRef })
    await call(client, 'electron_expect_text', {
      sessionId,
      selector: '#runtime-status',
      contains: 'running',
    })
    log('Started the runtime; expect_text waited out the async status until it ran.')

    // 5. One-shot pattern assertion on the settled runtime status.
    await call(client, 'electron_assert_pattern', {
      sessionId,
      selector: '#runtime-status',
      matches_regex: '^Runtime: running$',
    })
    log('Runtime status matches the expected pattern.')

    // 6. Capture a screenshot (no path -> a temp file) and read the console back.
    const shot = await call(client, 'electron_screenshot', { sessionId })
    log(`Screenshot written to ${shot['path'] as string} (${shot['bytes'] as number} bytes).`)
    const logs = await call(client, 'electron_console_logs', {
      sessionId,
      match: 'runtime running',
    })
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
