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

import { createServer, TransportRegistry } from '@electron-stagewright/core'
import { afterEach, describe, expect, it } from 'vitest'

import {
  FakeSession,
  FakeTransport,
  type FakeEvaluate,
} from '../../core/tests/helpers/fake-transport.js'
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

async function launch(server: Awaited<ReturnType<typeof createServer>>): Promise<string> {
  const main = await fixtureMain()
  const launched = (await server.dispatcher.dispatch('electron_launch', { main })) as {
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

describe('ipc plugin (in-process, simulated main)', () => {
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

  it('refuses reading from a session other than the one captured', async () => {
    // Capture on server A's session, then ask a different (valid) session to read: the active
    // capture is elsewhere, so the read must not silently hit the wrong main process.
    const serverA = await open()
    const idA = await launch(serverA)
    await serverA.dispatcher.dispatch('ipc_capture_start', { sessionId: idA, channels: ['save'] })

    const serverB = await open()
    const idB = await launch(serverB)
    expect(idB).not.toBe(idA)
    expect(await serverB.dispatcher.dispatch('ipc_captured', { sessionId: idB })).toMatchObject({
      ok: false,
      code: 'ipc.NOT_CAPTURING',
    })
  })

  it('refuses stubbing from a session other than the one captured', async () => {
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
