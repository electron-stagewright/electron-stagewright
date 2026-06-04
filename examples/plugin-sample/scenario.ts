/**
 * Scripted session that loads the sample plugin over the REAL MCP protocol via the CLI's
 * `--plugin` flag — the same path a real agent host uses to extend the server. It spawns
 * `node packages/core/dist/cli.js --plugin <this plugin> --plugin-config sample=…`, then:
 * lists tools (the namespaced `sample_greet` and the introspection `electron_plugins`
 * appear), calls `electron_plugins` (the sample plugin is reported), calls `sample_greet`
 * (the configured greeting word is applied), and exercises the namespaced error path.
 *
 * No Electron is launched — plugin tools and tools/list need no app — so this is a fast,
 * deterministic check of the plugin-loading contract end to end.
 *
 * Run (after `pnpm install` + `pnpm build` at the repo root):
 *   pnpm --filter @electron-stagewright/example-plugin-sample scenario
 *
 * @module
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE_ENTRY = fileURLToPath(import.meta.resolve('@electron-stagewright/core'))
const CLI_PATH = path.join(path.dirname(CORE_ENTRY), 'cli.js')
const PLUGIN_PATH = path.join(HERE, 'plugin.js')

/** The success/error envelope every tool returns (parsed out of the MCP text content). */
interface Envelope {
  readonly ok: boolean
  readonly code?: string
  readonly error?: string
  readonly message?: string
  readonly [key: string]: unknown
}

function log(line: string): void {
  process.stderr.write(`${line}\n`)
}

/** Call a tool over MCP, returning the parsed envelope WITHOUT throwing on `ok:false`. */
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
  return JSON.parse(first.text) as Envelope
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI_PATH, '--plugin', PLUGIN_PATH, '--plugin-config', 'sample={"greeting":"Hola"}'],
  })
  const client = new Client({ name: 'plugin-sample-scenario', version: '0.0.0' })
  await client.connect(transport)

  try {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    log(`Connected. The server offers ${tools.length} tools.`)
    if (!names.includes('sample_greet'))
      throw new Error('expected the namespaced sample_greet tool')
    if (!names.includes('electron_plugins')) throw new Error('expected the electron_plugins tool')
    log('Plugin tool sample_greet and the electron_plugins introspection tool are registered.')

    const listed = await call(client, 'electron_plugins', {})
    const plugins = listed['plugins'] as ReadonlyArray<{ name?: string; version?: string }>
    if (!plugins.some((p) => p.name === 'sample'))
      throw new Error('electron_plugins omitted "sample"')
    log(`electron_plugins reports: ${plugins.map((p) => `${p.name}@${p.version}`).join(', ')}.`)

    const greeted = await call(client, 'sample_greet', { name: 'Ada' })
    if (!greeted.ok || greeted['message'] !== 'Hola, Ada!') {
      throw new Error(
        `sample_greet did not apply the configured greeting: ${JSON.stringify(greeted)}`,
      )
    }
    log(`sample_greet applied the configured greeting: "${greeted['message'] as string}".`)

    const refused = await call(client, 'sample_greet', { name: '   ' })
    if (refused.ok || refused.code !== 'sample.NAME_REFUSED') {
      throw new Error(
        `expected sample.NAME_REFUSED for an empty name, got ${JSON.stringify(refused)}`,
      )
    }
    log('An empty name was refused with the namespaced code sample.NAME_REFUSED.')

    log('Scenario passed.')
  } finally {
    await client.close().catch(() => undefined)
  }
}

main().catch((err: unknown) => {
  log(`Scenario FAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
