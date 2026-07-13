import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import type { StagewrightServer } from '@electron-stagewright/core'

/** A connected in-memory MCP client plus its idempotent cleanup hook. */
export interface McpTestClient {
  readonly client: Client
  close(): Promise<void>
}

/** Connect a Stagewright server to an MCP client without inheriting process stdio in a test worker. */
export async function connectMcpTestClient(server: StagewrightServer): Promise<McpTestClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'stagewright-testkit', version: '1.0.0' })
  await Promise.all([server.mcp.connect(serverTransport), client.connect(clientTransport)])

  let closed = false
  return {
    client,
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await client.close().catch(() => undefined)
    },
  }
}
