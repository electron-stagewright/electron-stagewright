/** The verify-recipe coverage note added to the server instructions and the recipe resource. */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'

import { NOOP_LOGGER } from '../src/server/logger.js'
import nativeUiPlugin from '../../plugin-native-ui/src/index.js'
import storagePlugin from '../../plugin-storage/src/index.js'
import type { ErrorResponse } from '../src/errors/envelope.js'
import { VERIFY_RECIPE_URI } from '../src/resources/index.js'
import { recipeCoverageNote, recipeToolNames } from '../src/server/recipe-coverage.js'
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

async function connect(toolProfile: 'essential' | 'full', withPlugins = false): Promise<Client> {
  const server = await createServer({
    logger: NOOP_LOGGER,
    toolProfile,
    ...(withPlugins ? { plugins: [nativeUiPlugin, storagePlugin] } : {}),
  })
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

  it('ignores snake_case words whose prefix is only an inherited object key', () => {
    expect(recipeToolNames('`constructor_options` and `storage_local_set`')).toEqual([
      'storage_local_set',
    ])
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

  it('adds nothing to a full server with the recipe plugins loaded', async () => {
    const client = await connect('full', true)
    expect(client.getInstructions()).not.toContain('lacks tools')
    expect(await recipeText(client)).not.toContain('lacks tools')
  })

  it('points a direct call to an unloaded first-party plugin tool at its flag', async () => {
    const server = await createServer({ logger: NOOP_LOGGER })
    try {
      const res = (await server.dispatcher.dispatch('native_file_dialog_arm', {})) as ErrorResponse
      expect(res).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
      expect(res.next_actions).toEqual([
        'Ask the operator to restart the server with --plugin native to enable native_file_dialog_arm.',
      ])
    } finally {
      await server.close()
    }
  })

  it('keeps a typo in a loaded plugin namespace a plain unknown tool', async () => {
    const server = await createServer({ logger: NOOP_LOGGER, plugins: [storagePlugin] })
    try {
      const res = (await server.dispatcher.dispatch('storage_not_a_tool', {})) as ErrorResponse
      expect(res.error).toBe('Unknown tool: storage_not_a_tool')
    } finally {
      await server.close()
    }
  })
})
