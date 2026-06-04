/**
 * Integration tests for the trace plugin (ADR-009) loaded into a real server. The in-process
 * block drives the plugin through `createServer(...).dispatcher` (start -> tool calls -> stop ->
 * read artifact, plus tokens/status and the error paths); the MCP block loads it over a real
 * Client<->Server pair (InMemoryTransport) and confirms a tools/call session is captured.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createServer, defineTool, makeSuccess } from '@electron-stagewright/core'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import tracePlugin, { readTrace } from '../src/index.js'

const demoTool = defineTool({
  name: 'demo_echo',
  description: 'Echo for trace tests.',
  inputSchema: z.object({ value: z.string() }),
  operationType: 'query',
  handler: async (args, ctx) =>
    makeSuccess({ echo: args.value }, { startedAt: ctx.startedAt, now: ctx.now }),
})

const created: string[] = []
afterEach(async () => {
  await Promise.all(created.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sw-trace-plugin-'))
  created.push(dir)
  return path.join(dir, 'trace.jsonl')
}

function envelopeOf(result: CallToolResult): Record<string, unknown> {
  const blocks = result.content as ReadonlyArray<{ type: string; text?: string }>
  const first = blocks[0]
  if (first?.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('expected a text content block')
  }
  return JSON.parse(first.text) as Record<string, unknown>
}

describe('trace plugin (in-process)', () => {
  it('records non-trace tool calls between start and stop, and reports tokens', async () => {
    const file = await tmpFile()
    const server = await createServer({ plugins: [tracePlugin], tools: [demoTool] })
    try {
      expect(await server.dispatcher.dispatch('trace_start', { path: file })).toMatchObject({
        ok: true,
        recording: true,
        path: file,
      })
      await server.dispatcher.dispatch('demo_echo', { value: 'a' })
      await server.dispatcher.dispatch('demo_echo', { value: 'b' })
      // Live token report (artifact is not written until stop). trace_* calls are not counted.
      expect(await server.dispatcher.dispatch('trace_tokens', {})).toMatchObject({
        ok: true,
        calls: 2,
      })

      expect(await server.dispatcher.dispatch('trace_stop', {})).toMatchObject({
        ok: true,
        records: 2,
        overflowed: false,
      })

      const { calls } = await readTrace(file)
      expect(calls).toHaveLength(2)
      expect(calls.every((c) => c.tool === 'demo_echo')).toBe(true)

      expect(await server.dispatcher.dispatch('trace_tokens', { path: file })).toMatchObject({
        ok: true,
        calls: 2,
      })
    } finally {
      await server.close().catch(() => undefined)
    }
  })

  it('rejects a second start, a stop with no trace, and tokens for a missing artifact', async () => {
    const server = await createServer({ plugins: [tracePlugin], tools: [demoTool] })
    try {
      expect(await server.dispatcher.dispatch('trace_stop', {})).toMatchObject({
        ok: false,
        code: 'trace.NOT_RECORDING',
      })
      await server.dispatcher.dispatch('trace_start', { path: await tmpFile() })
      expect(await server.dispatcher.dispatch('trace_start', {})).toMatchObject({
        ok: false,
        code: 'trace.ALREADY_RECORDING',
      })
      expect(
        await server.dispatcher.dispatch('trace_tokens', { path: '/no/such/trace-xyz.jsonl' }),
      ).toMatchObject({ ok: false, code: 'trace.ARTIFACT_NOT_FOUND' })
      const invalid = await tmpFile()
      await writeFile(invalid, '{"kind":"meta"}\nnot-json\n', 'utf8')
      expect(await server.dispatcher.dispatch('trace_tokens', { path: invalid })).toMatchObject({
        ok: false,
        code: 'trace.ARTIFACT_INVALID',
      })
    } finally {
      await server.close().catch(() => undefined)
    }
  })

  it('reports recording status', async () => {
    const server = await createServer({ plugins: [tracePlugin], tools: [demoTool] })
    try {
      expect(await server.dispatcher.dispatch('trace_status', {})).toMatchObject({
        ok: true,
        recording: false,
      })
      const file = await tmpFile()
      await server.dispatcher.dispatch('trace_start', { path: file })
      expect(await server.dispatcher.dispatch('trace_status', {})).toMatchObject({
        ok: true,
        recording: true,
        path: file,
      })
    } finally {
      await server.close().catch(() => undefined)
    }
  })

  it('preserves overflow disclosure when reading tokens from a written artifact', async () => {
    const file = await tmpFile()
    const server = await createServer({
      plugins: [tracePlugin],
      pluginConfigs: { trace: { maxRecords: 1 } },
      tools: [demoTool],
    })
    try {
      await server.dispatcher.dispatch('trace_start', { path: file })
      await server.dispatcher.dispatch('demo_echo', { value: 'a' })
      await server.dispatcher.dispatch('demo_echo', { value: 'b' })
      expect(await server.dispatcher.dispatch('trace_stop', {})).toMatchObject({
        ok: true,
        records: 1,
        overflowed: true,
      })
      expect(await server.dispatcher.dispatch('trace_tokens', { path: file })).toMatchObject({
        ok: true,
        calls: 1,
        overflowed: true,
      })
    } finally {
      await server.close().catch(() => undefined)
    }
  })

  it('keeps the active recording retryable when stop fails to write', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sw-trace-stop-fails-'))
    created.push(dir)
    const server = await createServer({ plugins: [tracePlugin], tools: [demoTool] })
    try {
      await server.dispatcher.dispatch('trace_start', { path: dir })
      await server.dispatcher.dispatch('demo_echo', { value: 'a' })
      expect(await server.dispatcher.dispatch('trace_stop', {})).toMatchObject({
        ok: false,
        code: 'trace.ARTIFACT_WRITE_FAILED',
        retryable: true,
      })
      expect(await server.dispatcher.dispatch('trace_status', {})).toMatchObject({
        ok: true,
        recording: true,
        records: 1,
      })
      await server.dispatcher.dispatch('demo_echo', { value: 'b' })
      expect(await server.dispatcher.dispatch('trace_status', {})).toMatchObject({
        ok: true,
        records: 2,
      })
    } finally {
      await server.close().catch(() => undefined)
    }
  })
})

describe('trace plugin replay (in-process)', () => {
  it('replays a recorded session and reports all calls matched', async () => {
    const file = await tmpFile()
    const server = await createServer({ plugins: [tracePlugin], tools: [demoTool] })
    try {
      await server.dispatcher.dispatch('trace_start', { path: file })
      await server.dispatcher.dispatch('demo_echo', { value: 'a' })
      await server.dispatcher.dispatch('demo_echo', { value: 'b' })
      await server.dispatcher.dispatch('trace_stop', {})

      expect(await server.dispatcher.dispatch('trace_replay', { path: file })).toMatchObject({
        ok: true,
        replayed: 2,
        matched: 2,
        diverged: 0,
        skipped: 0,
        dry_run: false,
      })
    } finally {
      await server.close().catch(() => undefined)
    }
  })

  it('dry-run re-validates without dispatching', async () => {
    const file = await tmpFile()
    const server = await createServer({ plugins: [tracePlugin], tools: [demoTool] })
    try {
      await server.dispatcher.dispatch('trace_start', { path: file })
      await server.dispatcher.dispatch('demo_echo', { value: 'a' })
      await server.dispatcher.dispatch('trace_stop', {})
      expect(
        await server.dispatcher.dispatch('trace_replay', { path: file, dryRun: true }),
      ).toMatchObject({ ok: true, replayed: 1, matched: 1, dry_run: true })
    } finally {
      await server.close().catch(() => undefined)
    }
  })

  it('rejects replay of a missing or invalid artifact', async () => {
    const server = await createServer({ plugins: [tracePlugin], tools: [demoTool] })
    try {
      expect(
        await server.dispatcher.dispatch('trace_replay', { path: '/no/such/trace-xyz.jsonl' }),
      ).toMatchObject({ ok: false, code: 'trace.ARTIFACT_NOT_FOUND' })
      const invalid = await tmpFile()
      await writeFile(invalid, 'not-json\n', 'utf8')
      expect(await server.dispatcher.dispatch('trace_replay', { path: invalid })).toMatchObject({
        ok: false,
        code: 'trace.ARTIFACT_INVALID',
      })
    } finally {
      await server.close().catch(() => undefined)
    }
  })

  it('detects schema drift in dry-run (a recorded tool no longer registered)', async () => {
    // Record a demo_echo call, then dry-run replay against a server WHERE demo_echo is absent: the
    // call no longer validates (unknown tool), so it diverges — without any dispatch.
    const file = await tmpFile()
    const recordServer = await createServer({ plugins: [tracePlugin], tools: [demoTool] })
    try {
      await recordServer.dispatcher.dispatch('trace_start', { path: file })
      await recordServer.dispatcher.dispatch('demo_echo', { value: 'a' })
      await recordServer.dispatcher.dispatch('trace_stop', {})
    } finally {
      await recordServer.close().catch(() => undefined)
    }
    const replayServer = await createServer({ plugins: [tracePlugin] })
    try {
      expect(
        await replayServer.dispatcher.dispatch('trace_replay', { path: file, dryRun: true }),
      ).toMatchObject({ ok: true, replayed: 1, diverged: 1, dry_run: true })
    } finally {
      await replayServer.close().catch(() => undefined)
    }
  })
})

describe('trace plugin (over the MCP protocol)', () => {
  it('loads via the plugin model and captures a tools/call session', async () => {
    const file = await tmpFile()
    const server = await createServer({ plugins: [tracePlugin], tools: [demoTool] })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'trace-test', version: '0.0.0' })
    try {
      await Promise.all([server.mcp.connect(serverTransport), client.connect(clientTransport)])

      const tools = (await client.listTools()).tools.map((t) => t.name)
      expect(tools).toEqual(expect.arrayContaining(['trace_start', 'trace_stop', 'trace_tokens']))

      await client.callTool({ name: 'trace_start', arguments: { path: file } })
      await client.callTool({ name: 'demo_echo', arguments: { value: 'x' } })
      const stop = (await client.callTool({ name: 'trace_stop', arguments: {} })) as CallToolResult
      expect(envelopeOf(stop)).toMatchObject({ ok: true, records: 1 })

      const { calls } = await readTrace(file)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.tool).toBe('demo_echo')
    } finally {
      await client.close().catch(() => undefined)
      await server.close().catch(() => undefined)
    }
  })
})
