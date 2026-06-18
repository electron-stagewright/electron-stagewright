/**
 * Integration tests for the network plugin (ADR-016) loaded into a real server. The session
 * transport is a FakeTransport whose `emitNetwork` SIMULATES the renderer firing a request while
 * capturing (applying the same record-time filter the real Playwright transport does), so the
 * plugin's orchestration — allowlist, method filter, the canIntercept gate, per-session state,
 * redaction, overflow, error envelopes — is exercised without launching Electron. The real
 * `page.on('request'|…)` path is covered by the gated real-Electron smoke.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  createServer,
  NOOP_LOGGER,
  TransportRegistry,
  type NetworkEvent,
  type TransportCapabilities,
  type TransportSession,
} from '@electron-stagewright/core'
import { afterEach, describe, expect, it } from 'vitest'

import { FakeSession, FakeTransport } from '../../core/tests/helpers/fake-transport.js'
import packageJson from '../package.json' with { type: 'json' }
import networkPlugin from '../src/index.js'

const created: string[] = []

/** electron_launch validates the main path exists on disk, so back it with a real temp file. */
async function fixtureMain(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sw-network-'))
  created.push(dir)
  const main = path.join(dir, 'main.js')
  await writeFile(main, '// fake main entry\n', 'utf8')
  return main
}

/** A NetworkEvent with sensible defaults; override the fields a test cares about. */
function event(partial: Partial<NetworkEvent> & { url: string; method: string }): NetworkEvent {
  return { timestamp: 0, ...partial }
}

const FULL_CAPS: TransportCapabilities = {
  canLaunch: true,
  canAttach: true,
  canInject: true,
  canIntercept: true,
  canControlClock: true,
  supportsMainEval: true,
  supportsRendererEval: true,
  supportsInteraction: true,
}

const servers: Array<Awaited<ReturnType<typeof createServer>>> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => undefined)))
  await Promise.all(created.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

/** A single-session server over `session`, optionally with `network` plugin config / caps override. */
async function open(
  session: FakeSession,
  opts: { networkConfig?: Record<string, unknown>; capabilities?: TransportCapabilities } = {},
): Promise<Awaited<ReturnType<typeof createServer>>> {
  const transport = new FakeTransport({
    session,
    capabilities: opts.capabilities ?? FULL_CAPS,
  })
  const server = await createServer({
    plugins: [networkPlugin],
    logger: NOOP_LOGGER,
    transports: new TransportRegistry({ transports: [transport] }),
    ...(opts.networkConfig !== undefined ? { pluginConfigs: { network: opts.networkConfig } } : {}),
  })
  servers.push(server)
  return server
}

async function launch(
  server: Awaited<ReturnType<typeof createServer>>,
  opts: { allowMultiple?: boolean } = {},
): Promise<string> {
  const main = await fixtureMain()
  const launched = (await server.dispatcher.dispatch('electron_launch', {
    main,
    ...(opts.allowMultiple === true ? { allowMultiple: true } : {}),
  })) as { ok: boolean; session_id?: string; _meta?: { session_id?: string } }
  const id = launched.session_id ?? launched._meta?.session_id
  if (typeof id !== 'string') throw new Error('launch did not return a session id')
  return id
}

describe('network plugin (in-process, simulated capture)', () => {
  it('advertises the package version through plugin introspection', async () => {
    const server = await open(new FakeSession())
    expect(await server.dispatcher.dispatch('electron_plugins', {})).toMatchObject({
      ok: true,
      plugins: [{ name: 'network', version: packageJson.version }],
    })
  })

  it('captures an allowlisted request, reads it back, then stops', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)

    expect(
      await server.dispatcher.dispatch('network_capture_start', {
        sessionId,
        urls: ['/api/'],
      }),
    ).toMatchObject({ ok: true, capturing: true, urls: ['/api/'] })

    session.emitNetwork(
      event({ method: 'GET', url: 'https://app.test/api/items', status: 200, ok: true }),
    )

    expect(await server.dispatcher.dispatch('network_captured', { sessionId })).toMatchObject({
      ok: true,
      count: 1,
      events: [{ method: 'GET', url: 'https://app.test/api/items', status: 200, ok: true }],
      overflowed: 0,
    })
    expect(await server.dispatcher.dispatch('network_capture_stop', { sessionId })).toMatchObject({
      ok: true,
      stopped: true,
      events: 1,
    })
  })

  it('records only allowlisted URLs', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    await server.dispatcher.dispatch('network_capture_start', { sessionId, urls: ['/api/'] })

    session.emitNetwork(event({ method: 'GET', url: 'https://app.test/api/items' }))
    session.emitNetwork(event({ method: 'GET', url: 'https://cdn.test/logo.png' })) // not in allowlist

    expect(await server.dispatcher.dispatch('network_captured', { sessionId })).toMatchObject({
      ok: true,
      count: 1,
      events: [{ url: 'https://app.test/api/items' }],
    })
  })

  it('restricts capture to the named methods when methods is set', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    await server.dispatcher.dispatch('network_capture_start', {
      sessionId,
      urls: ['/api/'],
      methods: ['POST'],
    })

    session.emitNetwork(event({ method: 'GET', url: 'https://app.test/api/items' }))
    session.emitNetwork(event({ method: 'post', url: 'https://app.test/api/items' })) // case-insensitive

    expect(await server.dispatcher.dispatch('network_captured', { sessionId })).toMatchObject({
      ok: true,
      count: 1,
      events: [{ method: 'post' }],
    })
  })

  it('rejects a transport that cannot capture with network.UNSUPPORTED', async () => {
    const session = new FakeSession()
    const server = await open(session, { capabilities: { ...FULL_CAPS, canIntercept: false } })
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('network_capture_start', { sessionId, urls: ['/api/'] }),
    ).toMatchObject({ ok: false, code: 'network.UNSUPPORTED' })
  })

  it('rejects an empty allowlist, reading before a capture, and a double start', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    // Empty allowlist -> core BAD_ARGUMENT (zod min(1)), not a plugin code.
    expect(
      await server.dispatcher.dispatch('network_capture_start', { sessionId, urls: [] }),
    ).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    // captured before a capture started.
    expect(await server.dispatcher.dispatch('network_captured', { sessionId })).toMatchObject({
      ok: false,
      code: 'network.NOT_CAPTURING',
    })
    // double start.
    await server.dispatcher.dispatch('network_capture_start', { sessionId, urls: ['/api/'] })
    expect(
      await server.dispatcher.dispatch('network_capture_start', { sessionId, urls: ['/other/'] }),
    ).toMatchObject({ ok: false, code: 'network.ALREADY_CAPTURING' })
  })

  it('reports NOT_CAPTURING when stopping a session that never started', async () => {
    const server = await open(new FakeSession())
    const sessionId = await launch(server)
    expect(await server.dispatcher.dispatch('network_capture_stop', { sessionId })).toMatchObject({
      ok: false,
      code: 'network.NOT_CAPTURING',
    })
  })

  it('clears the buffer when clear:true is passed', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    await server.dispatcher.dispatch('network_capture_start', { sessionId, urls: ['/api/'] })
    session.emitNetwork(event({ method: 'GET', url: 'https://app.test/api/a' }))

    expect(
      await server.dispatcher.dispatch('network_captured', { sessionId, clear: true }),
    ).toMatchObject({ ok: true, count: 1 })
    // After a clearing read, the buffer is empty.
    expect(await server.dispatcher.dispatch('network_captured', { sessionId })).toMatchObject({
      ok: true,
      count: 0,
    })
  })

  it('returns captured events that survive a JSON round-trip', async () => {
    // invariant A1: nothing leaks a Map/Set into the wire payload.
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    await server.dispatcher.dispatch('network_capture_start', { sessionId, urls: ['/api/'] })
    session.emitNetwork(
      event({
        method: 'POST',
        url: 'https://app.test/api/save',
        status: 201,
        ok: true,
        requestHeaders: { 'content-type': 'application/json' },
        durationMs: 12,
      }),
    )
    const read = (await server.dispatcher.dispatch('network_captured', { sessionId })) as {
      ok: boolean
      events?: unknown
    }
    expect(read.ok).toBe(true)
    expect(JSON.parse(JSON.stringify(read.events))).toEqual(read.events)
  })
})

describe('network plugin (redaction, simulated capture)', () => {
  const secretEvent = event({
    method: 'GET',
    url: 'https://app.test/api/me',
    requestHeaders: {
      authorization: 'Bearer secret',
      'x-api-key': 'k',
      accept: 'application/json',
    },
    responseHeaders: { 'set-cookie': 'sid=abc', 'content-type': 'application/json' },
  })

  it('redacts authorization, cookie, and set-cookie by default', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    await server.dispatcher.dispatch('network_capture_start', { sessionId, urls: ['/api/'] })
    session.emitNetwork(secretEvent)

    expect(await server.dispatcher.dispatch('network_captured', { sessionId })).toMatchObject({
      ok: true,
      events: [
        {
          requestHeaders: {
            authorization: '[redacted]',
            'x-api-key': 'k',
            accept: 'application/json',
          },
          responseHeaders: { 'set-cookie': '[redacted]', 'content-type': 'application/json' },
        },
      ],
    })
  })

  it('redacts extra named headers from redactHeaders', async () => {
    const session = new FakeSession()
    const server = await open(session, { networkConfig: { redactHeaders: ['x-api-key'] } })
    const sessionId = await launch(server)
    await server.dispatcher.dispatch('network_capture_start', { sessionId, urls: ['/api/'] })
    session.emitNetwork(secretEvent)

    expect(await server.dispatcher.dispatch('network_captured', { sessionId })).toMatchObject({
      ok: true,
      events: [
        {
          requestHeaders: { authorization: '[redacted]', 'x-api-key': '[redacted]' },
        },
      ],
    })
  })

  it('captures secret headers verbatim when redactSecureDefaults is false', async () => {
    const session = new FakeSession()
    const server = await open(session, { networkConfig: { redactSecureDefaults: false } })
    const sessionId = await launch(server)
    await server.dispatcher.dispatch('network_capture_start', { sessionId, urls: ['/api/'] })
    session.emitNetwork(secretEvent)

    expect(await server.dispatcher.dispatch('network_captured', { sessionId })).toMatchObject({
      ok: true,
      events: [{ requestHeaders: { authorization: 'Bearer secret' } }],
    })
  })
})

describe('network plugin (overflow + multi-session, simulated capture)', () => {
  it('counts dropped entries in overflowed when the ring cap is exceeded', async () => {
    const session = new FakeSession({ networkCap: 2 })
    const server = await open(session)
    const sessionId = await launch(server)
    await server.dispatcher.dispatch('network_capture_start', { sessionId, urls: ['/api/'] })
    for (const n of [1, 2, 3]) {
      session.emitNetwork(event({ method: 'GET', url: `https://app.test/api/${n}` }))
    }
    expect(await server.dispatcher.dispatch('network_captured', { sessionId })).toMatchObject({
      ok: true,
      count: 2,
      overflowed: 1,
      events: [{ url: 'https://app.test/api/2' }, { url: 'https://app.test/api/3' }],
    })
  })

  it('captures two sessions independently and concurrently', async () => {
    const sessA = new FakeSession({ id: 'sess-a' })
    const sessB = new FakeSession({ id: 'sess-b' })
    const transport = new MultiSessionFakeTransport([sessA, sessB])
    const server = await createServer({
      plugins: [networkPlugin],
      logger: NOOP_LOGGER,
      transports: new TransportRegistry({ transports: [transport] }),
    })
    servers.push(server)

    const idA = await launch(server, { allowMultiple: true })
    const idB = await launch(server, { allowMultiple: true })
    expect(idA).not.toBe(idB)

    await server.dispatcher.dispatch('network_capture_start', { sessionId: idA, urls: ['/api/'] })
    await server.dispatcher.dispatch('network_capture_start', { sessionId: idB, urls: ['/api/'] })
    sessA.emitNetwork(event({ method: 'GET', url: 'https://app.test/api/a' }))
    sessB.emitNetwork(event({ method: 'GET', url: 'https://app.test/api/b' }))

    expect(await server.dispatcher.dispatch('network_captured', { sessionId: idA })).toMatchObject({
      ok: true,
      count: 1,
      events: [{ url: 'https://app.test/api/a' }],
    })
    expect(await server.dispatcher.dispatch('network_captured', { sessionId: idB })).toMatchObject({
      ok: true,
      count: 1,
      events: [{ url: 'https://app.test/api/b' }],
    })

    // Stopping A leaves B capturing and readable.
    await server.dispatcher.dispatch('network_capture_stop', { sessionId: idA })
    expect(await server.dispatcher.dispatch('network_captured', { sessionId: idA })).toMatchObject({
      ok: false,
      code: 'network.NOT_CAPTURING',
      details: { sessionId: idA, capturing: [idB] },
    })
    expect(await server.dispatcher.dispatch('network_captured', { sessionId: idB })).toMatchObject({
      ok: true,
      count: 1,
    })
  })
})

describe('network plugin (stubbing, simulated)', () => {
  it('registers a fulfill stub on the session transport', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('network_stub', {
        sessionId,
        urls: ['/api/save'],
        status: 503,
        contentType: 'application/json',
        body: '{"down":true}',
      }),
    ).toMatchObject({ ok: true, stubbed: ['/api/save'] })
    expect(session.networkStubCalls).toHaveLength(1)
    expect(session.networkStubCalls[0]).toMatchObject({
      urls: ['/api/save'],
      fulfill: { status: 503, contentType: 'application/json', body: '{"down":true}' },
    })
  })

  it('registers an abort stub', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('network_stub', {
        sessionId,
        urls: ['/api/'],
        abort: 'failed',
      }),
    ).toMatchObject({ ok: true, abort: 'failed' })
    expect(session.networkStubCalls[0]).toMatchObject({ abort: 'failed' })
    expect(session.networkStubCalls[0]?.fulfill).toBeUndefined()
  })

  it('passes through times and delayMs', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    await server.dispatcher.dispatch('network_stub', {
      sessionId,
      urls: ['/api/'],
      status: 200,
      times: 2,
      delayMs: 50,
    })
    expect(session.networkStubCalls[0]).toMatchObject({ times: 2, delayMs: 50 })
  })

  it('rejects invalid stub shapes before they reach the transport', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    // abort + body -> refine -> BAD_ARGUMENT.
    expect(
      await server.dispatcher.dispatch('network_stub', {
        sessionId,
        urls: ['/api/'],
        abort: 'failed',
        body: 'x',
      }),
    ).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    // empty urls -> zod min(1) -> BAD_ARGUMENT.
    expect(
      await server.dispatcher.dispatch('network_stub', { sessionId, urls: [], status: 200 }),
    ).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    // invalid status range would make Playwright route.fulfill throw at request time.
    expect(
      await server.dispatcher.dispatch('network_stub', { sessionId, urls: ['/api/'], status: 99 }),
    ).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(
      await server.dispatcher.dispatch('network_stub', { sessionId, urls: ['/api/'], status: 600 }),
    ).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    // unknown abort reasons would make Playwright route.abort throw at request time.
    expect(
      await server.dispatcher.dispatch('network_stub', {
        sessionId,
        urls: ['/api/'],
        abort: 'offline',
      }),
    ).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(session.networkStubCalls).toHaveLength(0)
  })

  it('rejects stubbing on a transport that cannot intercept', async () => {
    const session = new FakeSession()
    const server = await open(session, { capabilities: { ...FULL_CAPS, canIntercept: false } })
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('network_stub', { sessionId, urls: ['/api/'], status: 200 }),
    ).toMatchObject({ ok: false, code: 'network.UNSUPPORTED' })
  })

  it('unstubs all stubs, or only the named url', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    expect(await server.dispatcher.dispatch('network_unstub', { sessionId })).toMatchObject({
      ok: true,
      unstubbed: 'all',
    })
    expect(
      await server.dispatcher.dispatch('network_unstub', { sessionId, url: '/api/a' }),
    ).toMatchObject({ ok: true, unstubbed: '/api/a' })
    expect(session.clearNetworkStubsCalls).toEqual([undefined, '/api/a'])
  })

  it('advertises the bumped package version', async () => {
    const server = await open(new FakeSession())
    expect(await server.dispatcher.dispatch('electron_plugins', {})).toMatchObject({
      ok: true,
      plugins: [{ name: 'network', version: packageJson.version }],
    })
  })
})

describe('network plugin (body capture, simulated)', () => {
  const bodyEvent = event({
    method: 'POST',
    url: 'https://app.test/api/login',
    status: 200,
    requestBody: '{"password":"hunter2"}',
    requestBodyBytes: 22,
    responseBody: '{"token":"abc"}',
    responseBodyBytes: 15,
  })

  it('relays the body-capture knobs into the transport filter', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    await server.dispatcher.dispatch('network_capture_start', {
      sessionId,
      urls: ['/api/'],
      captureBodies: 'size',
      maxBodyBytes: 2048,
      bodyContentTypes: ['application/json'],
    })
    expect(session.networkCaptureFilters[0]).toMatchObject({
      urls: ['/api/'],
      captureBodies: 'size',
      maxBodyBytes: 2048,
      bodyContentTypes: ['application/json'],
    })
  })

  it('rejects a maxBodyBytes above the hard ceiling with BAD_ARGUMENT', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('network_capture_start', {
        sessionId,
        urls: ['/api/'],
        captureBodies: true,
        maxBodyBytes: 1024 * 1024 + 1,
      }),
    ).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(session.networkCaptureFilters).toHaveLength(0)
  })

  it('rejects an empty bodyContentTypes list (would silently capture nothing)', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('network_capture_start', {
        sessionId,
        urls: ['/api/'],
        captureBodies: true,
        bodyContentTypes: [],
      }),
    ).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(session.networkCaptureFilters).toHaveLength(0)
  })

  it('rejects body knobs passed without captureBodies (a silent no-op otherwise)', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('network_capture_start', {
        sessionId,
        urls: ['/api/'],
        maxBodyBytes: 1024,
      }),
    ).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(
      await server.dispatcher.dispatch('network_capture_start', {
        sessionId,
        urls: ['/api/'],
        bodyContentTypes: ['application/json'],
      }),
    ).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(session.networkCaptureFilters).toHaveLength(0)
  })

  it('passes a captured body through to the agent', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    await server.dispatcher.dispatch('network_capture_start', {
      sessionId,
      urls: ['/api/'],
      captureBodies: true,
    })
    session.emitNetwork(
      event({
        method: 'GET',
        url: 'https://app.test/api/me',
        status: 200,
        responseBody: '{"id":7}',
        responseBodyBytes: 8,
      }),
    )
    expect(await server.dispatcher.dispatch('network_captured', { sessionId })).toMatchObject({
      ok: true,
      events: [{ responseBody: '{"id":7}', responseBodyBytes: 8 }],
    })
  })

  it('passes body content through verbatim by default (bodies are not value-redacted)', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    await server.dispatcher.dispatch('network_capture_start', {
      sessionId,
      urls: ['/api/'],
      captureBodies: true,
    })
    session.emitNetwork(bodyEvent)
    expect(await server.dispatcher.dispatch('network_captured', { sessionId })).toMatchObject({
      ok: true,
      events: [{ requestBody: '{"password":"hunter2"}', responseBody: '{"token":"abc"}' }],
    })
  })

  it('replaces body content with a size placeholder when redactBodies is on', async () => {
    const session = new FakeSession()
    const server = await open(session, { networkConfig: { redactBodies: true } })
    const sessionId = await launch(server)
    await server.dispatcher.dispatch('network_capture_start', {
      sessionId,
      urls: ['/api/'],
      captureBodies: true,
    })
    session.emitNetwork(bodyEvent)
    expect(await server.dispatcher.dispatch('network_captured', { sessionId })).toMatchObject({
      ok: true,
      events: [{ requestBody: '[redacted: 22 bytes]', responseBody: '[redacted: 15 bytes]' }],
    })
  })
})

/**
 * A transport that hands out a fresh session on each launch (the shared FakeTransport returns the same
 * session every time), so ONE server can drive several concurrent sessions, each with its own
 * simulated capture buffer — exactly as two real Electron apps would.
 */
class MultiSessionFakeTransport extends FakeTransport {
  readonly #queue: FakeSession[]
  constructor(sessions: readonly FakeSession[]) {
    super(sessions[0] !== undefined ? { session: sessions[0] } : {})
    this.#queue = [...sessions]
  }
  override async launch(): Promise<TransportSession> {
    const next = this.#queue.shift()
    if (next === undefined) throw new Error('MultiSessionFakeTransport: no more sessions queued')
    return next
  }
}
