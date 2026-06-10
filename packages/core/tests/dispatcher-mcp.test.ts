/**
 * Integration tests for the dispatcher's MCP binding over a real Client<->Server pair
 * (InMemoryTransport). These pin the behaviour the dogfooding surfaced: the dispatcher must
 * own tools/list + tools/call so a bad argument comes back as the agent-UX BAD_ARGUMENT
 * envelope (ADR-006/ADR-007) — NOT the MCP SDK's raw `-32602 Input validation error` text
 * it would emit if we registered the Zod schema with registerTool — while tools/list still
 * advertises each tool's JSON Schema for discovery.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { makeSuccess } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { type AnyToolDefinition, defineTool } from '../src/tools/types.js'

const echoTool = defineTool({
  name: 'test_echo',
  description: 'Echo the value back.',
  inputSchema: z.object({ value: z.string().describe('A string to echo.') }),
  operationType: 'query',
  handler: async (args, ctx) =>
    makeSuccess({ echo: args.value }, { startedAt: ctx.startedAt, now: ctx.now }),
})

const dangerTool = defineTool({
  name: 'test_danger',
  description: 'A mutating, destructive tool. Errors: none.',
  inputSchema: z.object({}),
  operationType: 'command',
  annotations: { destructiveHint: true },
  handler: async (_args, ctx) => makeSuccess({}, { startedAt: ctx.startedAt, now: ctx.now }),
})

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (closers.length > 0)
    await closers
      .pop()?.()
      .catch(() => undefined)
})

/** Wire a dispatcher to an McpServer and connect a real Client over an in-memory pair. */
async function connectClient(tools: readonly AnyToolDefinition[]): Promise<Client> {
  const dispatcher = new Dispatcher({ sessions: new SessionManager() })
  dispatcher.registerAll(tools)
  const server = new McpServer(
    { name: 'test-server', version: '0.0.0' },
    { capabilities: { tools: { listChanged: false } } },
  )
  dispatcher.bindToMcpServer(server)

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  closers.push(async () => {
    await client.close().catch(() => undefined)
    await server.close().catch(() => undefined)
  })
  return client
}

/** Parse the JSON envelope out of a tools/call result's first text block. */
function envelopeOf(result: CallToolResult): Record<string, unknown> {
  const blocks = result.content as ReadonlyArray<{ type: string; text?: string }>
  const first = blocks[0]
  if (first?.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('expected a text content block')
  }
  return JSON.parse(first.text) as Record<string, unknown>
}

describe('dispatcher MCP binding', () => {
  it('advertises each tool input schema in tools/list', async () => {
    const client = await connectClient([echoTool])
    const { tools } = await client.listTools()
    const echo = tools.find((t) => t.name === 'test_echo')
    expect(echo).toBeDefined()
    expect(echo?.inputSchema?.type).toBe('object')
    expect(echo?.inputSchema?.properties).toHaveProperty('value')
  })

  it('routes a valid call through the dispatcher success envelope', async () => {
    const client = await connectClient([echoTool])
    const result = (await client.callTool({
      name: 'test_echo',
      arguments: { value: 'hi' },
    })) as CallToolResult
    expect(result.isError).toBeFalsy()
    expect(envelopeOf(result)).toMatchObject({ ok: true, echo: 'hi' })
  })

  it('surfaces MCP tool annotations derived from the operation type (readOnly / destructive)', async () => {
    const client = await connectClient([echoTool, dangerTool])
    const { tools } = await client.listTools()
    const echo = tools.find((t) => t.name === 'test_echo')
    const danger = tools.find((t) => t.name === 'test_danger')
    // A query tool is read-only and closed-world.
    expect(echo?.annotations?.readOnlyHint).toBe(true)
    expect(echo?.annotations?.openWorldHint).toBe(false)
    // A command tool is not read-only; its destructive override is surfaced.
    expect(danger?.annotations?.readOnlyHint).toBe(false)
    expect(danger?.annotations?.destructiveHint).toBe(true)
  })

  it('returns the envelope as structuredContent as well as a text block', async () => {
    const client = await connectClient([echoTool])
    const result = (await client.callTool({
      name: 'test_echo',
      arguments: { value: 'hi' },
    })) as CallToolResult
    expect(result.structuredContent).toMatchObject({ ok: true, echo: 'hi' })
    // The text block is still present (backwards compatibility / non-structured clients).
    expect(envelopeOf(result)).toMatchObject({ ok: true, echo: 'hi' })
  })

  it('rejects a tools/list cursor with an Invalid params protocol error (not silent re-listing)', async () => {
    const client = await connectClient([echoTool])
    await expect(client.listTools({ cursor: 'not-a-real-cursor' })).rejects.toThrow()
  })

  it('returns a BAD_ARGUMENT envelope (not a raw -32602) for invalid arguments', async () => {
    const client = await connectClient([echoTool])
    // value must be a string; passing a number would make the SDK reject with a raw
    // -32602 if we registered the Zod schema with it. Our handler must instead return
    // the structured envelope as isError content.
    const result = (await client.callTool({
      name: 'test_echo',
      arguments: { value: 123 },
    })) as CallToolResult
    expect(result.isError).toBe(true)
    const env = envelopeOf(result)
    expect(env).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    const issues = (env['details'] as { issues?: ReadonlyArray<{ field?: string }> }).issues
    expect(issues?.[0]?.field).toBe('value')
    expect((env['next_actions'] as readonly string[]).length).toBeGreaterThan(0)
  })
})
