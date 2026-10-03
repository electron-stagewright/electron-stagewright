import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { makeSuccess } from '../src/errors/envelope.js'
import { ArtifactStore, type ArtifactPublication } from '../src/resources/artifacts.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { createServer, type StagewrightServer } from '../src/server/server.js'
import { TransportRegistry } from '../src/server/transport-registry.js'
import { screenshotTool } from '../src/tools/observe/screenshot.js'
import { artifactOutputFields } from '../src/tools/output-schema.js'
import { defineTool } from '../src/tools/types.js'
import { NOOP_LOGGER } from '../src/server/logger.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'

const stores: ArtifactStore[] = []
const servers: StagewrightServer[] = []
const clients: Client[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const client of clients.splice(0)) await client.close()
  for (const server of servers.splice(0)) await server.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

function store() {
  const result = new ArtifactStore()
  stores.push(result)
  return result
}
function descriptor(result: ArtifactPublication) {
  if (!('artifact' in result)) throw new Error(`Unexpected ${result.artifact_unavailable}`)
  return result.artifact
}

describe('generated artifact store', () => {
  it('owns immutable copies, validates MIME and cannot read another server or a filesystem path', () => {
    const a = store()
    const b = store()
    const bytes = Buffer.from('original')
    const item = descriptor(a.publish(bytes, 'image/png', 'capture.png'))
    bytes.fill(0)
    expect(a.read(item.uri)?.bytes.toString()).toBe('original')
    a.read(item.uri)?.bytes.fill(1)
    expect(a.read(item.uri)?.bytes.toString()).toBe('original')
    expect(b.read(item.uri)).toBeUndefined()
    expect(a.read('file:///etc/passwd')).toBeUndefined()
    expect(a.read('stagewright://artifacts/../../etc/passwd')).toBeUndefined()
    expect(item).toMatchObject({ mimeType: 'image/png', size: 8, name: 'capture.png' })
    // Runtime plugin input still meets an allowlist, even when TypeScript is bypassed.
    expect(a.publish(bytes, 'text/plain' as 'image/png', 'bad')).toEqual({
      artifact_unavailable: 'unsupported_type',
    })
  })

  it('enforces per-artifact and total byte budgets without evicting live links', () => {
    const a = store()
    expect(a.publish(Buffer.alloc(a.maxArtifactBytes + 1), 'image/png', 'huge')).toEqual({
      artifact_unavailable: 'too_large',
    })
    const items = Array.from({ length: 4 }, () =>
      descriptor(a.publish(Buffer.alloc(a.maxArtifactBytes), 'image/png', 'full')),
    )
    expect(a.publish(Buffer.from('extra'), 'image/png', 'extra')).toEqual({
      artifact_unavailable: 'capacity',
    })
    expect(items.every((item) => a.describe(item.uri) !== undefined)).toBe(true)
  })

  it('bounds entry count and releases expired snapshots and timers without deleting local files', async () => {
    vi.useFakeTimers()
    const a = store()
    const items = Array.from({ length: 32 }, () =>
      descriptor(a.publish(Buffer.from('x'), 'application/json', 'item.json')),
    )
    expect(a.publish(Buffer.alloc(0), 'image/png', 'extra')).toEqual({
      artifact_unavailable: 'capacity',
    })
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(items.every((item) => a.read(item.uri) === undefined)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(a.publish(Buffer.from('{}'), 'application/json', 'again')).toHaveProperty('artifact')
    a.close()
    a.close()
    expect(a.publish(Buffer.from('{}'), 'application/json', 'closed')).toEqual({
      artifact_unavailable: 'closed',
    })
    expect(vi.getTimerCount()).toBe(0)
  })
})

async function connect(bytes: Buffer, legacy = false) {
  const transport = new FakeTransport({ session: new FakeSession({ screenshotResult: bytes }) })
  const server = await createServer({
    tools: [screenshotTool],
    transports: new TransportRegistry({ transports: [transport] }),
  })
  server.sessions.register(transport, transport.session)
  servers.push(server)
  const client = new Client({ name: 'artifact-client', version: '1.0.0' })
  clients.push(client)
  const [c, s] = InMemoryTransport.createLinkedPair()
  if (legacy) {
    const send = c.send.bind(c)
    c.send = (message, options) => {
      if ('method' in message && message.method === 'initialize') {
        return send(
          { ...message, params: { ...message.params, protocolVersion: '2024-11-05' } },
          options,
        )
      }
      return send(message, options)
    }
  }
  await Promise.all([server.mcp.connect(s), client.connect(c)])
  return { client, server }
}

describe('portable screenshot over MCP', () => {
  it('does not write or publish a capture that resolves after request cancellation', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'stagewright-artifacts-'))
    dirs.push(dir)
    const file = path.join(dir, 'cancelled.png')
    let enter!: () => void
    let release!: (bytes: Buffer) => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const gate = new Promise<Buffer>((resolve) => {
      release = resolve
    })
    const transport = new FakeTransport()
    vi.spyOn(transport.session, 'screenshot').mockImplementation(() => {
      enter()
      return gate
    })
    const artifacts = store()
    const publish = vi.spyOn(artifacts, 'publish')
    const sessions = new SessionManager()
    sessions.register(transport, transport.session)
    const dispatcher = new Dispatcher({ sessions, artifacts })
    dispatcher.register(screenshotTool)
    const controller = new AbortController()
    const pending = dispatcher.dispatch(
      'electron_screenshot',
      { path: file, windowIndex: 0 },
      { signal: controller.signal },
    )
    await entered
    controller.abort()
    expect(await pending).toMatchObject({ code: 'OPERATION_CANCELLED' })
    release(Buffer.from('late screenshot'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(publish).not.toHaveBeenCalled()
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(transport.stopCount).toBe(0)
  })

  it('revokes evidence if cancellation wins just after publication', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'stagewright-artifacts-'))
    dirs.push(dir)
    const artifacts = store()
    const controller = new AbortController()
    let uri = ''
    const publish = artifacts.publish.bind(artifacts)
    vi.spyOn(artifacts, 'publish').mockImplementation((...args) => {
      const result = publish(...args)
      uri = descriptor(result).uri
      queueMicrotask(() => controller.abort())
      return result
    })
    const transport = new FakeTransport()
    const sessions = new SessionManager()
    sessions.register(transport, transport.session)
    const dispatcher = new Dispatcher({ sessions, artifacts })
    dispatcher.register(screenshotTool)
    expect(
      await dispatcher.dispatch(
        'electron_screenshot',
        { path: path.join(dir, 'race.png'), windowIndex: 0 },
        { signal: controller.signal },
      ),
    ).toMatchObject({ code: 'OPERATION_CANCELLED' })
    expect(uri).not.toBe('')
    expect(artifacts.read(uri)).toBeUndefined()
  })

  it('logs an output-schema violation and revokes the evidence the agent never receives', async () => {
    const artifacts = store()
    const warn = vi.fn()
    let uri: string | undefined
    const tool = defineTool({
      name: 'test_bad_evidence',
      description: 'Publishes evidence, then returns an invalid payload.',
      inputSchema: z.object({}),
      outputSchema: z.object({ path: z.string(), ...artifactOutputFields }),
      operationType: 'command',
      handler: async (_args, ctx) => {
        const publication = ctx.artifacts?.publish(Buffer.from('{}'), 'application/json', 'x.json')
        if (publication !== undefined && 'artifact' in publication) uri = publication.artifact.uri
        return makeSuccess({ path: 42, ...publication })
      },
    })
    const dispatcher = new Dispatcher({
      sessions: new SessionManager(),
      artifacts,
      logger: { ...NOOP_LOGGER, warn },
    })
    dispatcher.registerAll([tool])

    expect(await dispatcher.dispatch('test_bad_evidence', {})).toMatchObject({
      ok: false,
      code: 'INTERNAL_ERROR',
    })
    expect(uri).toBeDefined()
    expect(artifacts.describe(uri ?? '')).toBeUndefined()
    expect(warn).toHaveBeenCalledWith('Tool result did not match its declared output schema', {
      tool: 'test_bad_evidence',
      issues: [expect.stringMatching(/^path: /)],
    })
  })

  it('preserves the legacy JSON/path and serves original bytes after the output file is replaced', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'stagewright-artifacts-'))
    dirs.push(dir)
    const bytes = Buffer.from('generated screenshot bytes')
    const { client } = await connect(bytes)
    const listed = await client.listTools()
    expect(listed.tools[0]?.outputSchema).toMatchObject({ type: 'object' })
    const file = path.join(dir, 'capture.png')
    const result = (await client.callTool({
      name: 'electron_screenshot',
      arguments: { path: file, windowIndex: 0 },
    })) as CallToolResult
    const text = result.content[0]
    if (text?.type !== 'text') throw new Error('Expected legacy JSON text first')
    expect(JSON.parse(text.text)).toEqual(result.structuredContent)
    expect(result.structuredContent).toMatchObject({
      ok: true,
      path: file,
      bytes: bytes.length,
      format: 'png',
    })
    expect(await readFile(file)).toEqual(bytes)
    const link = result.content.find((item) => item.type === 'resource_link')
    if (link?.type !== 'resource_link') throw new Error('Expected portable link')
    expect(link).toMatchObject({
      name: 'screenshot.png',
      mimeType: 'image/png',
      size: bytes.length,
    })
    const privateFile = path.join(dir, 'private.txt')
    await writeFile(privateFile, 'private replacement content')
    if (process.platform === 'win32') await writeFile(file, 'private replacement content')
    else {
      await rm(file)
      await symlink(privateFile, file)
    }
    const response = await client.readResource({ uri: link.uri })
    const content = response.contents[0]
    if (content === undefined || !('blob' in content) || typeof content.blob !== 'string')
      throw new Error('Expected image bytes')
    expect(Buffer.from(content.blob, 'base64')).toEqual(bytes)
    const other = await connect(bytes)
    await expect(other.client.readResource({ uri: link.uri })).rejects.toThrow(
      /unavailable|expired/i,
    )
    await expect(client.readResource({ uri: `file://${file}` })).rejects.toThrow()
    await expect(
      client.readResource({ uri: 'stagewright://artifacts/..%2F..%2Fsecret' }),
    ).rejects.toThrow()
  })

  it('keeps legacy protocol content text-only while exposing a readable artifact URI in JSON', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'stagewright-artifacts-'))
    dirs.push(dir)
    const { client } = await connect(Buffer.from('legacy capture'), true)
    const result = (await client.callTool({
      name: 'electron_screenshot',
      arguments: { path: path.join(dir, 'legacy.png'), windowIndex: 0 },
    })) as CallToolResult
    expect(result.content.map((content) => content.type)).toEqual(['text'])
    const text = result.content[0]
    if (text?.type !== 'text') throw new Error('Expected text')
    const envelope = JSON.parse(text.text) as { artifact: { uri: string } }
    expect((await client.readResource({ uri: envelope.artifact.uri })).contents).toHaveLength(1)
  })

  it('keeps local capture usable when portable content is too large', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'stagewright-artifacts-'))
    dirs.push(dir)
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 1)
    const { client } = await connect(bytes)
    const result = (await client.callTool({
      name: 'electron_screenshot',
      arguments: { path: path.join(dir, 'large.png'), windowIndex: 0 },
    })) as CallToolResult
    expect(result.structuredContent).toMatchObject({
      ok: true,
      artifact_unavailable: 'too_large',
      bytes: bytes.length,
    })
    expect(result.content.some((item) => item.type === 'resource_link')).toBe(false)
  })
})
