/** In-band MCP resources generated from the public documentation source of truth. */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ACTIVE_PROFILE_RESOURCE_URI,
  GENERATED_AGENT_RESOURCE_DOCUMENTS,
} from '../src/resources/index.js'
import { NOOP_LOGGER } from '../src/server/logger.js'
import { createServer, type StagewrightServer } from '../src/server/server.js'
import { VERSION } from '../src/version.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const START_MARKER = '<!-- stagewright-resource:begin -->'
const END_MARKER = '<!-- stagewright-resource:end -->'

interface ConnectedServer {
  readonly client: Client
  readonly server: StagewrightServer
}

const connected: ConnectedServer[] = []

afterEach(async () => {
  await Promise.all(
    connected.splice(0).map(async ({ client, server }) => {
      await client.close().catch(() => undefined)
      await server.close().catch(() => undefined)
    }),
  )
})

async function connect(profile: 'essential' | 'full' = 'full'): Promise<ConnectedServer> {
  const server = await createServer({ logger: NOOP_LOGGER, toolProfile: profile })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'resource-probe', version: '1.0.0' })
  await Promise.all([server.mcp.connect(serverTransport), client.connect(clientTransport)])
  const pair = { client, server }
  connected.push(pair)
  return pair
}

function section(markdown: string): string {
  const start = markdown.indexOf(START_MARKER)
  const end = markdown.indexOf(END_MARKER)
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Expected one well-formed generated-resource section.')
  }
  return `${markdown.slice(start + START_MARKER.length, end).trim()}\n`
}

function firstText(contents: readonly unknown[]): string {
  const first = contents[0]
  if (
    typeof first !== 'object' ||
    first === null ||
    !('text' in first) ||
    typeof first.text !== 'string'
  ) {
    throw new Error('Expected the resource to return text content.')
  }
  return first.text
}

describe('in-band MCP resources', () => {
  it('lists and reads compact generated guides through the standard MCP resource protocol', async () => {
    const { client } = await connect()
    expect(client.getServerCapabilities()?.resources).toMatchObject({ listChanged: true })

    const listed = await client.listResources()
    expect(listed.resources.map((resource) => resource.uri)).toEqual([
      ...GENERATED_AGENT_RESOURCE_DOCUMENTS.map((document) => document.uri),
      ACTIVE_PROFILE_RESOURCE_URI,
    ])
    expect(listed.resources.every((resource) => resource.mimeType === 'text/markdown')).toBe(true)

    for (const document of GENERATED_AGENT_RESOURCE_DOCUMENTS) {
      expect(document.text.length).toBeLessThanOrEqual(2_000)
      const read = await client.readResource({ uri: document.uri })
      const text = firstText(read.contents)
      expect(text).toContain(`server version ${VERSION}`)
      expect(text).toContain(`canonical source: ${document.source}`)
      expect(text).toContain(document.text)
    }
  })

  it('derives every bundled guide from its marked public source section', async () => {
    for (const document of GENERATED_AGENT_RESOURCE_DOCUMENTS) {
      const source = (await readFile(path.join(REPO_ROOT, document.source), 'utf8')).replace(
        /\r\n/g,
        '\n',
      )
      expect(document.text).toBe(section(source))
    }
  })

  it('describes the actual visible profile without duplicating the tool manifest', async () => {
    const { client, server } = await connect('essential')
    const read = await client.readResource({ uri: ACTIVE_PROFILE_RESOURCE_URI })
    const text = firstText(read.contents)

    expect(text).toContain('Selected core profile: `essential`')
    expect(text).toContain(`Visible core tools: ${server.dispatcher.list().length}`)
    expect(text).toContain('Additional visible tools: 0')
    expect(text).toContain('Read `tools/list`')
    expect(text).not.toContain('electron_click')
  })
})
