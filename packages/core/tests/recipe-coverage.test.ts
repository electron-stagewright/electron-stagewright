/** The verify-recipe coverage note added to the server instructions and the recipe resource. */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'

import { NOOP_LOGGER } from '../src/server/logger.js'
import {
  recipeCoverageNote,
  recipeToolNames,
  VERIFY_RECIPE_URI,
} from '../src/server/recipe-coverage.js'
import { createServer, type StagewrightServer } from '../src/server/server.js'
import { DEFAULT_TOOLS } from '../src/tools/index.js'

const opened: { client: Client; server: StagewrightServer }[] = []

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(async ({ client, server }) => {
      await client.close().catch(() => undefined)
      await server.close().catch(() => undefined)
    }),
  )
})

async function connect(toolProfile: 'essential' | 'full'): Promise<Client> {
  const server = await createServer({ logger: NOOP_LOGGER, toolProfile })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'recipe-probe', version: '1.0.0' })
  await Promise.all([server.mcp.connect(serverTransport), client.connect(clientTransport)])
  opened.push({ client, server })
  return client
}

async function recipeText(client: Client): Promise<string> {
  const first = (await client.readResource({ uri: VERIFY_RECIPE_URI })).contents[0]
  return first !== undefined && 'text' in first ? first.text : ''
}

describe('verify recipe coverage', () => {
  it('reads every core and first-party plugin tool the recipe calls', () => {
    const names = recipeToolNames()
    expect(names).toEqual(
      expect.arrayContaining([
        'electron_reload',
        'electron_console_logs',
        'native_file_dialog_arm',
        'storage_local_set',
      ]),
    )
    const core = new Set(DEFAULT_TOOLS.map((tool) => tool.name))
    for (const name of names.filter((n) => n.startsWith('electron_'))) {
      expect(core.has(name), name).toBe(true)
    }
  })

  it('stays silent when every recipe tool is registered', () => {
    expect(recipeCoverageNote(() => true, 'full', DEFAULT_TOOLS)).toBeUndefined()
  })

  it('names the smallest covering profile and the missing plugins', () => {
    const note = recipeCoverageNote(
      (name) => name !== 'electron_reload' && !name.startsWith('storage_'),
      'essential',
      DEFAULT_TOOLS,
    )
    expect(note).toContain('(storage_local_set, electron_reload)')
    expect(note).toContain('--tool-profile testing --plugin storage;')
    expect(note).not.toContain('native-ui')
  })

  it('leaves the profile out for a caller-supplied tool set', () => {
    const note = recipeCoverageNote((name) => name !== 'electron_reload', 'custom', DEFAULT_TOOLS)
    expect(note).toContain('(electron_reload)')
    expect(note).toContain('Skip those steps.')
  })

  it('tells an essential server without plugins how to run the recipe', async () => {
    const client = await connect('essential')
    const flags = '--tool-profile full --plugin storage --plugin native-ui'
    expect(client.getInstructions()).toContain(flags)
    expect(await recipeText(client)).toContain(
      `> This server lacks tools the verify-desktop-change recipe uses`,
    )
  })

  it('only asks a full server for the plugins', async () => {
    const client = await connect('full')
    expect(client.getInstructions()).toContain(
      'restart it with --plugin storage --plugin native-ui;',
    )
    expect(client.getInstructions()).not.toContain('--tool-profile')
  })
})
