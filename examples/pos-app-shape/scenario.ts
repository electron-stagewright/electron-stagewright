/**
 * Scripted agent session for the point-of-sale-shaped example — modeled on a real POS
 * app (Puntovivo): a tenant login gate, a dense line-item form, and a sales table the
 * agent fills and scans.
 *
 * Like the other examples, this talks to the server the way a real agent host (Claude
 * Desktop, Cursor, Codex) does: an MCP `Client` over `StdioClientTransport`, spawning
 * `node packages/core/dist/cli.js` and exchanging JSON-RPC frames over the child's
 * piped stdio. The transcript prints to stderr (the child's stdio carries the
 * protocol, never this process's stdout) and the script exits non-zero if any step
 * fails, so it doubles as a runnable smoke.
 *
 * What it proves beyond the earlier examples: an auth gate driven through its FAILURE
 * and success paths; multi-tenant context carried from a login select into the
 * dashboard; a dense form submitted repeatedly to grow a table; and table scanning via
 * `expect_count` (selector mode) plus a derived-total assertion.
 *
 * Run (after `pnpm install` + `pnpm build` at the repo root):
 *   pnpm --filter @electron-stagewright/example-pos-app-shape scenario
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

/** A single line item entered into the POS form. */
interface LineItem {
  readonly name: string
  readonly qty: string
  readonly price: string
  readonly category: string
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

/** Fill the dense line-item form and click Add, growing the sales table by one row. */
async function addItem(
  client: Client,
  sessionId: string,
  addRef: number,
  item: LineItem,
): Promise<void> {
  await call(client, 'electron_type', { sessionId, selector: '#item-name', text: item.name })
  await call(client, 'electron_type', { sessionId, selector: '#item-qty', text: item.qty })
  await call(client, 'electron_type', { sessionId, selector: '#item-price', text: item.price })
  await call(client, 'electron_select_option', {
    sessionId,
    selector: '#item-category',
    values: [item.category],
  })
  await call(client, 'electron_click', { sessionId, ref: addRef })
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({ command: 'node', args: [CLI_PATH] })
  const client = new Client({ name: 'pos-app-shape-scenario', version: '0.0.0' })
  await client.connect(transport)

  let sessionId: string | undefined
  try {
    const { tools } = await client.listTools()
    log(`Connected. The server offers ${tools.length} tools.`)

    const launched = await call(client, 'electron_launch', { main: APP_MAIN })
    sessionId = launched['session_id'] as string
    log(`Launched the POS app (session ${sessionId}).`)

    await call(client, 'electron_snapshot', { sessionId })

    // 1. Auth gate, FAILURE first: wrong credentials must be rejected. Pick the
    //    Airport Kiosk tenant now so we can confirm it carries through after sign-in.
    const signInRef = await findRef(client, sessionId, 'button', 'Sign in')
    await call(client, 'electron_type', { sessionId, selector: '#username', text: 'cashier' })
    await call(client, 'electron_type', { sessionId, selector: '#password', text: 'wrong-pass' })
    await call(client, 'electron_select_option', {
      sessionId,
      selector: '#tenant',
      values: ['airport'],
    })
    await call(client, 'electron_click', { sessionId, ref: signInRef })
    await call(client, 'electron_expect_text', {
      sessionId,
      selector: '#login-error',
      contains: 'Invalid',
    })
    log('Wrong credentials were rejected at the login gate.')

    // 2. Auth success: the correct password signs in. electron_type overwrites the bad
    //    password, and expect_visible waits for the dashboard to be revealed.
    await call(client, 'electron_type', { sessionId, selector: '#password', text: 'pos1234' })
    await call(client, 'electron_click', { sessionId, ref: signInRef })
    await call(client, 'electron_expect_visible', { sessionId, selector: '#dashboard' })
    log('Signed in; the dashboard is visible.')

    // 3. Multi-tenant context: the dashboard banner must reflect the tenant chosen at
    //    login, proving the context carried through.
    await call(client, 'electron_expect_text', {
      sessionId,
      selector: '#tenant-banner',
      contains: 'Airport Kiosk',
    })
    log('Tenant context carried through: the banner shows the Airport Kiosk store.')

    // 4. Dense form: add two line items to the sales table.
    const addRef = await findRef(client, sessionId, 'button', 'Add item')
    await addItem(client, sessionId, addRef, {
      name: 'Espresso',
      qty: '2',
      price: '3.50',
      category: 'drink',
    })
    await addItem(client, sessionId, addRef, {
      name: 'Sandwich',
      qty: '1',
      price: '6.00',
      category: 'food',
    })
    log('Entered two line items through the dense form.')

    // 5. Table scanning: count the rows by SELECTOR (contrast with the role-mode count
    //    in the VSCode-shaped example), and read a specific cell back.
    await call(client, 'electron_expect_count', {
      sessionId,
      selector: '#sales-body tr',
      equals: 2,
    })
    await call(client, 'electron_expect_text', {
      sessionId,
      selector: '#sales-body tr:first-child td:first-child',
      contains: 'Espresso',
    })
    log('Sales table has exactly 2 rows; the first line item reads back as Espresso.')

    // 6. Derived total: 2 x 3.50 + 1 x 6.00 = 13.00. Assert the concrete value and the
    //    money format.
    await call(client, 'electron_expect_text', {
      sessionId,
      selector: '#total',
      contains: 'Total: $13.00',
    })
    await call(client, 'electron_assert_pattern', {
      sessionId,
      selector: '#total',
      matches_regex: '^Total: \\$\\d+\\.\\d{2}$',
    })
    log('Running total is $13.00 and matches the expected money format.')

    // 7. Capture a screenshot (no path -> a temp file) and read the console back.
    const shot = await call(client, 'electron_screenshot', { sessionId })
    log(`Screenshot written to ${shot['path'] as string} (${shot['bytes'] as number} bytes).`)
    const logs = await call(client, 'electron_console_logs', { sessionId, match: 'item added' })
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
