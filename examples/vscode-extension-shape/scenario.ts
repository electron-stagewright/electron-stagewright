/**
 * Scripted agent session for the VSCode-shaped example — driving a structured,
 * multi-region desktop UI (activity bar, sidebar, a webview-like content panel, and
 * a command palette) instead of a flat form.
 *
 * Like the minimal example, this talks to the server the way a real agent host
 * (Claude Desktop, Cursor, Codex) does: an MCP `Client` over `StdioClientTransport`,
 * spawning `node packages/core/dist/cli.js` and exchanging JSON-RPC frames over the
 * child's piped stdio. The transcript prints to stderr (the child's stdio carries the
 * protocol, never this process's stdout) and the script exits non-zero if any step
 * fails, so it doubles as a runnable smoke.
 *
 * What it proves beyond the minimal app: semantic find + ref interaction reach the
 * shell chrome (activity bar) AND nested content (the webview-like panel); the
 * keyboard primitives drive a command palette; and `expect_count` asserts a list size
 * by accessibility role rather than a brittle selector.
 *
 * Run (after `pnpm install` + `pnpm build` at the repo root):
 *   pnpm --filter @electron-stagewright/example-vscode-extension-shape scenario
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

/** One accessibility-tree entry as returned in a snapshot/find result. */
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
  const client = new Client({ name: 'vscode-extension-shape-scenario', version: '0.0.0' })
  await client.connect(transport)

  let sessionId: string | undefined
  try {
    const { tools } = await client.listTools()
    log(`Connected. The server offers ${tools.length} tools.`)

    const launched = await call(client, 'electron_launch', { main: APP_MAIN })
    sessionId = launched['session_id'] as string
    log(`Launched the shell (session ${sessionId}).`)

    // 1. See the whole shell at once. Snapshot returns numbered refs across every
    //    region — activity bar, sidebar, editor, status bar — in one read.
    const snap = await call(client, 'electron_snapshot', { sessionId })
    const tree = snap['snapshot'] as { entries?: ReadonlyArray<{ role?: string }> } | undefined
    const entries = tree?.entries ?? []
    log(`Snapshot: ${entries.length} elements across the shell.`)

    // 2. Assert the explorer file list size by accessibility ROLE, not a CSS selector
    //    — expect_count walks the tree for buttons whose name contains ".md".
    await call(client, 'electron_expect_count', {
      sessionId,
      role: 'button',
      name_contains: '.md',
      equals: 3,
    })
    log('Explorer lists exactly 3 markdown files (counted by role).')

    // 3. Drive the shell chrome by ref: find the "Extensions" activity-bar button by
    //    role + name, click it, and verify the sidebar navigated.
    const extensionsRef = await findRef(client, sessionId, 'button', 'Extensions')
    log(`Found the Extensions activity button as ref ${extensionsRef}; clicking it.`)
    await call(client, 'electron_click', { sessionId, ref: extensionsRef })
    await call(client, 'electron_expect_text', {
      sessionId,
      selector: '#sidebar-title',
      contains: 'Extensions',
    })
    log('Sidebar navigated to the Extensions panel.')

    // 4. Reach NESTED content: find the activate button inside the webview-like panel
    //    by role + name and click it by ref, then confirm the panel reacted.
    const activateRef = await findRef(client, sessionId, 'button', 'Activate Extension')
    log(`Found the webview's Activate button as ref ${activateRef}; clicking it.`)
    await call(client, 'electron_click', { sessionId, ref: activateRef })
    await call(client, 'electron_expect_text', {
      sessionId,
      selector: '#webview-status',
      contains: 'active',
    })
    log('Webview-like panel reports the extension is active.')

    // 5. Drive the command palette with real keystrokes: Ctrl+Shift+P opens it, then
    //    per-character typing fills it, then Enter runs the command.
    await call(client, 'electron_press_sequence', { sessionId, keys: ['Control+Shift+P'] })
    await call(client, 'electron_keyboard_type', { sessionId, text: 'Run Greeting' })
    await call(client, 'electron_key', { sessionId, key: 'Enter' })
    await call(client, 'electron_expect_text', {
      sessionId,
      selector: '#statusbar',
      contains: 'Ran: Run Greeting',
    })
    log('Command palette ran "Run Greeting" via the keyboard; status bar updated.')

    // 6. One-shot pattern assertion on the status bar.
    await call(client, 'electron_assert_pattern', {
      sessionId,
      selector: '#statusbar',
      matches_regex: '^Ran: .+$',
    })
    log('Status bar matches the expected command pattern.')

    // 7. Capture a screenshot (no path -> a temp file) and read the console back.
    const shot = await call(client, 'electron_screenshot', { sessionId })
    log(`Screenshot written to ${shot['path'] as string} (${shot['bytes'] as number} bytes).`)
    const logs = await call(client, 'electron_console_logs', {
      sessionId,
      match: 'command executed',
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
