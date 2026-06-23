/**
 * Version-advertisement guard. The version core reports to an MCP client (the `initialize`
 * `serverInfo.version`) and the exported `VERSION` must both equal the published `package.json`
 * version. Core previously hardcoded the version as a literal with no guard, so a release bump
 * updated the manifest while the server kept advertising the old version — a clean `npx` install
 * served `serverInfo.version: 0.0.0` from a 0.1.0 package. This pins the wiring: `version.ts` reads
 * the manifest, and the server hands that value to the MCP `serverInfo`.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'

import { VERSION } from '../src/version.js'
import { NOOP_LOGGER } from '../src/server/logger.js'
import { createServer } from '../src/server/server.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')) as { version: string }
).version

describe('core version advertisement', () => {
  it('exports VERSION equal to the package.json version (no drift)', () => {
    expect(VERSION).toBe(PACKAGE_VERSION)
  })

  it('advertises the package.json version as the MCP serverInfo version', async () => {
    const server = await createServer({ logger: NOOP_LOGGER })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'version-probe', version: '0.0.0' })
    try {
      await Promise.all([server.mcp.connect(serverTransport), client.connect(clientTransport)])
      const serverInfo = client.getServerVersion()
      expect(serverInfo?.name).toBe('@electron-stagewright/core')
      expect(serverInfo?.version).toBe(PACKAGE_VERSION)
    } finally {
      await client.close().catch(() => undefined)
      await server.close().catch(() => undefined)
    }
  })
})
