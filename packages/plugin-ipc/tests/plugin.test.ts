/**
 * Integration tests for the IPC plugin (ADR-010) loaded into a real server. The session transport
 * is a FakeTransport whose `evaluate('main', …)` SIMULATES the main-process __swIpc state (install /
 * read / invoke / stop / stub), so the plugin's orchestration — allowlist, the --allow-eval gate,
 * per-session capture state, error envelopes, redaction — is exercised without launching Electron.
 * The real INSTRUMENT_BODY shim is covered by the gated real-Electron smoke.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createServer, TransportRegistry, type TransportSession } from '@electron-stagewright/core'
import { afterEach, describe, expect, it } from 'vitest'

import {
  FakeSession,
  FakeTransport,
  type FakeEvaluate,
} from '../../core/tests/helpers/fake-transport.js'
import packageJson from '../package.json' with { type: 'json' }
import ipcPlugin from '../src/index.js'

const created: string[] = []

/** electron_launch validates the main path exists on disk, so back it with a real temp file. */
async function fixtureMain(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sw-ipc-'))
  created.push(dir)
  const main = path.join(dir, 'main.js')
  await writeFile(main, '// fake main entry\n', 'utf8')
  return main
}

/** A JS stand-in for the main-process __swIpc state, driven by the same ops the real shim handles. */
function fakeMain(): FakeEvaluate {
  const state: {
    installed: boolean
    allow: string[]
    events: unknown[]
    stubs: Record<string, unknown>
  } = { installed: false, allow: [], events: [], stubs: {} }
  // Pretend the app registered an ipcMain.handle('save', …) handler.
  const handlers: Record<string, (...a: unknown[]) => unknown> = {
    save: (payload) => ({ saved: payload }),
  }
  return async (_target, _body, arg) => {
    const a = arg as {
      op: string
      allow?: string[]
      channel?: string
      args?: unknown[]
      response?: unknown
    }
    switch (a.op) {
      case 'install':
        Object.assign(state, { installed: true, allow: a.allow ?? [], events: [], stubs: {} })
        return { installed: true, channels: state.allow }
      case 'read':
        return { installed: state.installed, events: state.events.slice() }
      case 'stop': {
        const n = state.events.length
        state.installed = false
        return { stopped: true, events: n }
      }
      case 'stub':
        state.stubs[a.channel as string] = a.response
        return { ok: true, stubbed: a.channel }
      case 'invoke': {
        const channel = a.channel as string
        const stubbed = Object.prototype.hasOwnProperty.call(state.stubs, channel)
        const handler = handlers[channel]
        if (!stubbed && handler === undefined) return { ok: false, error: 'no handler' }
        const result = stubbed ? state.stubs[channel] : handler!(...(a.args ?? []))
        if (state.installed && state.allow.includes(channel)) {
          state.events.push({ channel, type: 'invoke', args: a.args ?? [], ok: true, ms: 0, ts: 0 })
        }
        return { ok: true, result }
      }
      default:
        return { ok: false, error: 'unknown op' }
    }
  }
}

function serverWith(opts: { allowEval: boolean }) {
  const transport = new FakeTransport({ session: new FakeSession({ evaluate: fakeMain() }) })
  return createServer({
    plugins: [ipcPlugin],
    allowEval: opts.allowEval,
    transports: new TransportRegistry({ transports: [transport] }),
  })
}

/**
 * A transport that hands out a fresh session on each launch (the shared FakeTransport returns the
 * same session every time), so ONE server can drive several concurrent sessions — the multi-session
 * scenario. Each session carries its own simulated `__swIpc` via its own `fakeMain()`, exactly as
 * two real Electron apps would.
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

function serverWithSessions(
  sessions: readonly FakeSession[],
  opts: { allowEval: boolean } = { allowEval: true },
) {
  return createServer({
    plugins: [ipcPlugin],
    allowEval: opts.allowEval,
    transports: new TransportRegistry({ transports: [new MultiSessionFakeTransport(sessions)] }),
  })
}

async function launch(
  server: Awaited<ReturnType<typeof createServer>>,
  opts: { allowMultiple?: boolean } = {},
): Promise<string> {
  const main = await fixtureMain()
  // electron_launch refuses a second concurrent session unless allowMultiple is set — pass it when a
  // test drives more than one app on the same server.
  const launched = (await server.dispatcher.dispatch('electron_launch', {
    main,
    ...(opts.allowMultiple === true ? { allowMultiple: true } : {}),
  })) as {
    ok: boolean
    session_id?: string
    _meta?: { session_id?: string }
  }
  const id = launched.session_id ?? launched._meta?.session_id
  if (typeof id !== 'string') throw new Error('launch did not return a session id')
  return id
}

const servers: Array<Awaited<ReturnType<typeof createServer>>> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => undefined)))
  await Promise.all(created.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
async function open(opts = { allowEval: true }): Promise<Awaited<ReturnType<typeof createServer>>> {
  const server = await serverWith(opts)
  servers.push(server)
  return server
}
async function openMulti(
  sessions: readonly FakeSession[],
  opts: { allowEval: boolean } = { allowEval: true },
): Promise<Awaited<ReturnType<typeof createServer>>> {
  const server = await serverWithSessions(sessions, opts)
  servers.push(server)
  return server
}
/** A single-session server whose ipc plugin is loaded with `ipcConfig` (e.g. `{ invokeAllow }`). */
async function openWithConfig(
  ipcConfig: Record<string, unknown>,
  opts: { allowEval: boolean } = { allowEval: true },
): Promise<Awaited<ReturnType<typeof createServer>>> {
  const transport = new FakeTransport({ session: new FakeSession({ evaluate: fakeMain() }) })
  const server = await createServer({
    plugins: [ipcPlugin],
    allowEval: opts.allowEval,
    pluginConfigs: { ipc: ipcConfig },
    transports: new TransportRegistry({ transports: [transport] }),
  })
  servers.push(server)
  return server
}

describe('ipc plugin (in-process, simulated main)', () => {
  it('advertises the package version through plugin introspection', async () => {
    const server = await open()
    expect(await server.dispatcher.dispatch('electron_plugins', {})).toMatchObject({
      ok: true,
      plugins: [{ name: 'ipc', version: packageJson.version }],
    })
  })

  it('captures an invoked channel, reads it back, then stops', async () => {
    const server = await open()
    const sessionId = await launch(server)

    expect(
      await server.dispatcher.dispatch('ipc_capture_start', { sessionId, channels: ['save'] }),
    ).toMatchObject({
      ok: true,
      capturing: true,
      channels: ['save'],
    })
    expect(
      await server.dispatcher.dispatch('ipc_invoke', {
        sessionId,
        channel: 'save',
        args: [{ name: 'a' }],
      }),
    ).toMatchObject({ ok: true, result: { saved: { name: 'a' } } })
    expect(await server.dispatcher.dispatch('ipc_captured', { sessionId })).toMatchObject({
      ok: true,
      count: 1,
      events: [{ channel: 'save', type: 'invoke', args: [{ name: 'a' }] }],
    })
    expect(await server.dispatcher.dispatch('ipc_capture_stop', { sessionId })).toMatchObject({
      ok: true,
      stopped: true,
      events: 1,
    })
  })

  it('stubs an allowlisted channel so invoke returns the canned value', async () => {
    const server = await open()
    const sessionId = await launch(server)
    await server.dispatcher.dispatch('ipc_capture_start', { sessionId, channels: ['save'] })
    expect(
      await server.dispatcher.dispatch('ipc_stub', {
        sessionId,
        channel: 'save',
        response: { stubbed: true },
      }),
    ).toMatchObject({ ok: true, stubbed: 'save' })
    expect(
      await server.dispatcher.dispatch('ipc_invoke', { sessionId, channel: 'save' }),
    ).toMatchObject({
      ok: true,
      result: { stubbed: true },
    })
  })

  it('requires --allow-eval for instrumentation', async () => {
    const server = await open({ allowEval: false })
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('ipc_capture_start', { sessionId, channels: ['save'] }),
    ).toMatchObject({
      ok: false,
      code: 'ipc.EVAL_REQUIRED',
    })
  })

  it('rejects an empty allowlist, reading before a capture, and stubbing a non-allowlisted channel', async () => {
    const server = await open()
    const sessionId = await launch(server)
    // Empty allowlist -> BAD_ARGUMENT (zod min(1)).
    expect(
      await server.dispatcher.dispatch('ipc_capture_start', { sessionId, channels: [] }),
    ).toMatchObject({
      ok: false,
      code: 'BAD_ARGUMENT',
    })
    // captured before a capture started.
    expect(await server.dispatcher.dispatch('ipc_captured', { sessionId })).toMatchObject({
      ok: false,
      code: 'ipc.NOT_CAPTURING',
    })
    // stub a channel outside the allowlist.
    await server.dispatcher.dispatch('ipc_capture_start', { sessionId, channels: ['save'] })
    expect(
      await server.dispatcher.dispatch('ipc_stub', { sessionId, channel: 'other', response: 1 }),
    ).toMatchObject({ ok: false, code: 'ipc.CHANNEL_NOT_ALLOWED' })
  })

  it('reports ipc.INVOKE_FAILED when no handler is registered for the channel', async () => {
    const server = await open()
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('ipc_invoke', { sessionId, channel: 'missing' }),
    ).toMatchObject({
      ok: false,
      code: 'ipc.INVOKE_FAILED',
    })
  })

  it('refuses a second capture until the first stops', async () => {
    const server = await open()
    const sessionId = await launch(server)
    await server.dispatcher.dispatch('ipc_capture_start', { sessionId, channels: ['save'] })
    expect(
      await server.dispatcher.dispatch('ipc_capture_start', { sessionId, channels: ['open'] }),
    ).toMatchObject({
      ok: false,
      code: 'ipc.ALREADY_CAPTURING',
    })
  })

  it('a session that never started a capture reports NOT_CAPTURING, even across servers', async () => {
    // Two servers in one process share the module-level capture registry, but it is keyed by the
    // unique session id: capturing server A's session must not make server B's untouched session
    // look like it is capturing. Per-session keying prevents this live cross-server report leak;
    // lifecycle/config are still process-global, so independent servers belong in separate processes.
    const serverA = await open()
    const idA = await launch(serverA)
    await serverA.dispatcher.dispatch('ipc_capture_start', { sessionId: idA, channels: ['save'] })

    const serverB = await open()
    const idB = await launch(serverB)
    expect(idB).not.toBe(idA)
    // Scoped reporting: server A's capture does NOT leak into server B's error details, even though
    // the registry is process-global — capturing is filtered to the caller server's own sessions.
    expect(await serverB.dispatcher.dispatch('ipc_captured', { sessionId: idB })).toMatchObject({
      ok: false,
      code: 'ipc.NOT_CAPTURING',
      details: { sessionId: idB, capturing: [] },
    })
  })

  it('a session that never started a capture cannot stub, even across servers', async () => {
    const serverA = await open()
    const idA = await launch(serverA)
    await serverA.dispatcher.dispatch('ipc_capture_start', { sessionId: idA, channels: ['save'] })

    const serverB = await open()
    const idB = await launch(serverB)
    expect(
      await serverB.dispatcher.dispatch('ipc_stub', {
        sessionId: idB,
        channel: 'save',
        response: 1,
      }),
    ).toMatchObject({
      ok: false,
      code: 'ipc.NOT_CAPTURING',
    })
  })
})

describe('ipc plugin (multi-session, simulated main)', () => {
  /** Two independent simulated-main sessions to drive concurrently on ONE server. */
  function twoSessions(): [FakeSession, FakeSession] {
    return [
      new FakeSession({ id: 'sess-a', evaluate: fakeMain() }),
      new FakeSession({ id: 'sess-b', evaluate: fakeMain() }),
    ]
  }

  it('captures two sessions independently and concurrently', async () => {
    const server = await openMulti(twoSessions())
    const idA = await launch(server, { allowMultiple: true })
    const idB = await launch(server, { allowMultiple: true })
    expect(idA).not.toBe(idB)

    // Both capture at once — starting the second does NOT trip ALREADY_CAPTURING.
    expect(
      await server.dispatcher.dispatch('ipc_capture_start', { sessionId: idA, channels: ['save'] }),
    ).toMatchObject({ ok: true, capturing: true })
    expect(
      await server.dispatcher.dispatch('ipc_capture_start', { sessionId: idB, channels: ['save'] }),
    ).toMatchObject({ ok: true, capturing: true })

    // Invoke on each; the captured events stay isolated per session.
    await server.dispatcher.dispatch('ipc_invoke', {
      sessionId: idA,
      channel: 'save',
      args: [{ n: 'a' }],
    })
    await server.dispatcher.dispatch('ipc_invoke', {
      sessionId: idB,
      channel: 'save',
      args: [{ n: 'b' }],
    })
    expect(await server.dispatcher.dispatch('ipc_captured', { sessionId: idA })).toMatchObject({
      ok: true,
      count: 1,
      events: [{ channel: 'save', args: [{ n: 'a' }] }],
    })
    expect(await server.dispatcher.dispatch('ipc_captured', { sessionId: idB })).toMatchObject({
      ok: true,
      count: 1,
      events: [{ channel: 'save', args: [{ n: 'b' }] }],
    })

    // Stopping A leaves B capturing and readable.
    expect(await server.dispatcher.dispatch('ipc_capture_stop', { sessionId: idA })).toMatchObject({
      ok: true,
      stopped: true,
    })
    expect(await server.dispatcher.dispatch('ipc_captured', { sessionId: idA })).toMatchObject({
      ok: false,
      code: 'ipc.NOT_CAPTURING',
    })
    expect(await server.dispatcher.dispatch('ipc_captured', { sessionId: idB })).toMatchObject({
      ok: true,
      count: 1,
    })
  })

  it('judges ALREADY_CAPTURING per session, not globally', async () => {
    const server = await openMulti(twoSessions())
    const idA = await launch(server, { allowMultiple: true })
    const idB = await launch(server, { allowMultiple: true })
    await server.dispatcher.dispatch('ipc_capture_start', { sessionId: idA, channels: ['save'] })
    // Starting a DIFFERENT session while A captures is allowed.
    expect(
      await server.dispatcher.dispatch('ipc_capture_start', { sessionId: idB, channels: ['save'] }),
    ).toMatchObject({ ok: true, capturing: true })
    // Re-starting the SAME session still trips ALREADY_CAPTURING, naming it.
    expect(
      await server.dispatcher.dispatch('ipc_capture_start', { sessionId: idA, channels: ['open'] }),
    ).toMatchObject({
      ok: false,
      code: 'ipc.ALREADY_CAPTURING',
      details: { sessionId: idA },
    })
  })

  it('lists the capturing sessions in NOT_CAPTURING details so the agent can retarget', async () => {
    const server = await openMulti(twoSessions())
    const idA = await launch(server, { allowMultiple: true })
    const idB = await launch(server, { allowMultiple: true })
    await server.dispatcher.dispatch('ipc_capture_start', { sessionId: idA, channels: ['save'] })
    // B never started a capture; the error names B and lists A as the one capturing.
    expect(await server.dispatcher.dispatch('ipc_captured', { sessionId: idB })).toMatchObject({
      ok: false,
      code: 'ipc.NOT_CAPTURING',
      details: { sessionId: idB, capturing: [idA] },
    })
  })

  it('returns captured events that survive a JSON round-trip', async () => {
    // invariant A1: the per-session split must not leak a Map/Set into the wire payload.
    const server = await openMulti(twoSessions())
    const idA = await launch(server)
    await server.dispatcher.dispatch('ipc_capture_start', { sessionId: idA, channels: ['save'] })
    await server.dispatcher.dispatch('ipc_invoke', {
      sessionId: idA,
      channel: 'save',
      args: [{ n: 'a' }],
    })
    const read = (await server.dispatcher.dispatch('ipc_captured', { sessionId: idA })) as {
      ok: boolean
      events?: unknown
    }
    expect(read.ok).toBe(true)
    expect(JSON.parse(JSON.stringify(read.events))).toEqual(read.events)
  })
})

describe('ipc plugin (invoke allowlist, simulated main)', () => {
  it('allows an invoke whose channel is in invokeAllow', async () => {
    const server = await openWithConfig({ invokeAllow: ['save'] })
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('ipc_invoke', {
        sessionId,
        channel: 'save',
        args: [{ n: 1 }],
      }),
    ).toMatchObject({ ok: true, result: { saved: { n: 1 } } })
  })

  it('blocks an invoke whose channel is not in invokeAllow, before the main round-trip', async () => {
    const server = await openWithConfig({ invokeAllow: ['save'] })
    const sessionId = await launch(server)
    // 'other' has no handler in fakeMain; were the allowlist not enforced first this would surface
    // INVOKE_FAILED. CHANNEL_NOT_ALLOWED proves the guard short-circuits before the eval round-trip.
    expect(
      await server.dispatcher.dispatch('ipc_invoke', { sessionId, channel: 'other' }),
    ).toMatchObject({
      ok: false,
      code: 'ipc.CHANNEL_NOT_ALLOWED',
      details: { channel: 'other', allowed: ['save'] },
    })
  })

  it('blocks every invoke when invokeAllow is empty', async () => {
    const server = await openWithConfig({ invokeAllow: [] })
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('ipc_invoke', { sessionId, channel: 'save' }),
    ).toMatchObject({ ok: false, code: 'ipc.CHANNEL_NOT_ALLOWED', details: { allowed: [] } })
  })

  it('leaves invoke unrestricted when invokeAllow is unset', async () => {
    const server = await open()
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('ipc_invoke', { sessionId, channel: 'save' }),
    ).toMatchObject({ ok: true })
  })

  it('keeps the invoke allowlist independent of the capture allowlist', async () => {
    // invokeAllow names only 'other'; capture names only 'save'. Capturing/stubbing 'save' works
    // (capture allowlist), but invoking 'save' is blocked (not in invokeAllow) — the two allowlists
    // do not bleed into each other.
    const server = await openWithConfig({ invokeAllow: ['other'] })
    const sessionId = await launch(server)
    await server.dispatcher.dispatch('ipc_capture_start', { sessionId, channels: ['save'] })
    expect(
      await server.dispatcher.dispatch('ipc_stub', { sessionId, channel: 'save', response: 1 }),
    ).toMatchObject({ ok: true, stubbed: 'save' })
    expect(
      await server.dispatcher.dispatch('ipc_invoke', { sessionId, channel: 'save' }),
    ).toMatchObject({
      ok: false,
      code: 'ipc.CHANNEL_NOT_ALLOWED',
      details: { channel: 'save', allowed: ['other'] },
    })
  })
})
