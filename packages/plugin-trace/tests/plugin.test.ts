/**
 * Integration tests for the trace plugin (ADR-009) loaded into a real server. The in-process
 * block drives the plugin through `createServer(...).dispatcher` (start -> tool calls -> stop ->
 * read artifact, plus tokens/status and the error paths); the MCP block loads it over a real
 * Client<->Server pair (InMemoryTransport) and confirms a tools/call session is captured.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

describe('trace plugin budget (in-process)', () => {
  it('reports budget status live (status/tokens/budget) and persists it to the artifact', async () => {
    const file = await tmpFile()
    const server = await createServer({ plugins: [tracePlugin], tools: [demoTool] })
    try {
      await server.dispatcher.dispatch('trace_start', { path: file, budgetTokens: 1 })
      await server.dispatcher.dispatch('demo_echo', { value: 'hello world' })
      expect(await server.dispatcher.dispatch('trace_status', {})).toMatchObject({
        ok: true,
        budget: { budget_tokens: 1, over_budget: true },
      })
      expect(await server.dispatcher.dispatch('trace_budget', {})).toMatchObject({
        ok: true,
        recording: true,
        budget: { over_budget: true },
      })
      expect(await server.dispatcher.dispatch('trace_tokens', {})).toMatchObject({
        ok: true,
        budget: { over_budget: true },
      })
      await server.dispatcher.dispatch('trace_stop', {})
      // The artifact carries the budget so an offline token report stays budget-aware.
      expect(await server.dispatcher.dispatch('trace_tokens', { path: file })).toMatchObject({
        ok: true,
        budget: { budget_tokens: 1, over_budget: true },
      })
    } finally {
      await server.close().catch(() => undefined)
    }
  })

  it('advisory budget (no enforce) does not block calls', async () => {
    const file = await tmpFile()
    const server = await createServer({ plugins: [tracePlugin], tools: [demoTool] })
    try {
      await server.dispatcher.dispatch('trace_start', { path: file, budgetTokens: 1 })
      await server.dispatcher.dispatch('demo_echo', { value: 'over budget now' })
      expect(await server.dispatcher.dispatch('demo_echo', { value: 'again' })).toMatchObject({
        ok: true,
      })
    } finally {
      await server.close().catch(() => undefined)
    }
  })

  it('enforce blocks over-budget calls with trace.BUDGET_EXCEEDED but never the trace tools', async () => {
    const file = await tmpFile()
    const server = await createServer({ plugins: [tracePlugin], tools: [demoTool] })
    try {
      await server.dispatcher.dispatch('trace_start', {
        path: file,
        budgetTokens: 1,
        enforce: true,
      })
      // The first call tips the budget over (its cost is unknown until it runs), so it is allowed.
      expect(await server.dispatcher.dispatch('demo_echo', { value: 'first' })).toMatchObject({
        ok: true,
      })
      // The next non-trace call is now vetoed before its handler runs.
      const blocked = await server.dispatcher.dispatch('demo_echo', { value: 'second' })
      expect(blocked).toMatchObject({ ok: false, code: 'trace.BUDGET_EXCEEDED', retryable: false })
      // The trace plugin's own tools are never blocked, so the agent can still stop/inspect.
      expect(await server.dispatcher.dispatch('trace_status', {})).toMatchObject({
        ok: true,
        recording: true,
      })
      expect(await server.dispatcher.dispatch('trace_stop', {})).toMatchObject({ ok: true })
      // The guard is released on stop — calls run again.
      expect(await server.dispatcher.dispatch('demo_echo', { value: 'after' })).toMatchObject({
        ok: true,
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

  it('rejects a trace whose call record has no tool name (ARTIFACT_INVALID, never a crash)', async () => {
    const server = await createServer({ plugins: [tracePlugin], tools: [demoTool] })
    try {
      const file = await tmpFile()
      // A JSON-parseable record of kind "call" but with no `tool` would otherwise reach replay and
      // TypeError on skipTool(tool); it must fail as a classified artifact error.
      await writeFile(file, '{"kind":"call","ok":true,"args":{},"result":{}}\n', 'utf8')
      expect(await server.dispatcher.dispatch('trace_replay', { path: file })).toMatchObject({
        ok: false,
        code: 'trace.ARTIFACT_INVALID',
      })
    } finally {
      await server.close().catch(() => undefined)
    }
  })

  it('never dispatches a hidden eval tool when replaying a crafted trace (allowEval off)', async () => {
    // The full core surface is registered but eval is hidden (no --allow-eval). A hand-crafted
    // trace naming electron_eval_main must NOT reach the eval handler on replay: re-dispatch funnels
    // through the same dispatch() whose tool map omits the hidden tool, so it returns unknown-tool.
    // This pins the central reason --allow-eval exists, on the re-dispatch path.
    const file = await tmpFile()
    await writeFile(
      file,
      `${JSON.stringify({
        kind: 'call',
        tool: 'electron_eval_main',
        ok: true,
        args: { code: 'return 1', sessionId: 's1' },
        result: { ok: true, _meta: { session_id: 's1' } },
      })}\n`,
      'utf8',
    )
    const server = await createServer({ plugins: [tracePlugin], allowEval: false })
    try {
      const report = (await server.dispatcher.dispatch('trace_replay', {
        path: file,
      })) as unknown as {
        ok: boolean
        calls: ReadonlyArray<{
          tool: string
          replayed_ok: boolean
          replayed_code?: string
          diverged: boolean
        }>
      }
      expect(report.ok).toBe(true)
      const evalCall = report.calls.find((c) => c.tool === 'electron_eval_main')
      expect(evalCall?.replayed_ok).toBe(false)
      expect(evalCall?.replayed_code).toBe('BAD_ARGUMENT') // unknown tool — the gate held
      expect(evalCall?.diverged).toBe(true)
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

describe('trace plugin view (in-process)', () => {
  it('renders a recorded trace to a self-contained HTML report next to the artifact', async () => {
    const file = await tmpFile()
    const server = await createServer({ plugins: [tracePlugin], tools: [demoTool] })
    try {
      await server.dispatcher.dispatch('trace_start', { path: file })
      await server.dispatcher.dispatch('demo_echo', { value: 'a' })
      await server.dispatcher.dispatch('demo_echo', { value: 'b' })
      await server.dispatcher.dispatch('trace_stop', {})

      const out = file.replace(/\.jsonl$/, '.html')
      const view = await server.dispatcher.dispatch('trace_view', { path: file })
      expect(view).toMatchObject({ ok: true, path: out, source: file, calls: 2 })

      const html = await readFile(out, 'utf8')
      expect(html.startsWith('<!doctype html>')).toBe(true)
      expect(html).toContain('demo_echo')
    } finally {
      await server.close().catch(() => undefined)
    }
  })

  it('honours an explicit out path', async () => {
    const file = await tmpFile()
    const out = path.join(path.dirname(file), 'report.html')
    const server = await createServer({ plugins: [tracePlugin], tools: [demoTool] })
    try {
      await server.dispatcher.dispatch('trace_start', { path: file })
      await server.dispatcher.dispatch('demo_echo', { value: 'a' })
      await server.dispatcher.dispatch('trace_stop', {})
      expect(await server.dispatcher.dispatch('trace_view', { path: file, out })).toMatchObject({
        ok: true,
        path: out,
      })
      expect((await readFile(out, 'utf8')).length).toBeGreaterThan(0)
    } finally {
      await server.close().catch(() => undefined)
    }
  })

  it('rejects rendering a missing artifact', async () => {
    const server = await createServer({ plugins: [tracePlugin], tools: [demoTool] })
    try {
      expect(
        await server.dispatcher.dispatch('trace_view', { path: '/no/such/trace-xyz.jsonl' }),
      ).toMatchObject({ ok: false, code: 'trace.ARTIFACT_NOT_FOUND' })
    } finally {
      await server.close().catch(() => undefined)
    }
  })

  it('reports a write failure when the out path cannot be written', async () => {
    const file = await tmpFile()
    const server = await createServer({ plugins: [tracePlugin], tools: [demoTool] })
    try {
      await server.dispatcher.dispatch('trace_start', { path: file })
      await server.dispatcher.dispatch('demo_echo', { value: 'a' })
      await server.dispatcher.dispatch('trace_stop', {})
      // `out` is an existing directory (the trace's parent), so writeFile fails with EISDIR.
      expect(
        await server.dispatcher.dispatch('trace_view', { path: file, out: path.dirname(file) }),
      ).toMatchObject({ ok: false, code: 'trace.ARTIFACT_WRITE_FAILED' })
    } finally {
      await server.close().catch(() => undefined)
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
