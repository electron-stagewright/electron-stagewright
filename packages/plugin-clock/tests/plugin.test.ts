/**
 * Integration tests for the clock plugin (ADR-017) loaded into a real server. The session transport is
 * a FakeTransport whose FakeSession records each clock-seam call, so the plugin's orchestration — the
 * canControlClock gate, the per-session install lifecycle (clock.NOT_INSTALLED before install), the
 * relay to the seam, and status — is exercised without launching Electron. The real `page.clock` path
 * is covered by the gated real-Electron smoke and the Playwright-session unit tests.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  createServer,
  NOOP_LOGGER,
  TransportRegistry,
  type TransportCapabilities,
} from '@electron-stagewright/core'
import { afterEach, describe, expect, it } from 'vitest'

import { FakeSession, FakeTransport } from '../../core/tests/helpers/fake-transport.js'
import packageJson from '../package.json' with { type: 'json' }
import clockPlugin from '../src/index.js'

const created: string[] = []

/** electron_launch validates the main path exists on disk, so back it with a real temp file. */
async function fixtureMain(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sw-clock-'))
  created.push(dir)
  const main = path.join(dir, 'main.js')
  await writeFile(main, '// fake main entry\n', 'utf8')
  return main
}

const FULL_CAPS: TransportCapabilities = {
  canLaunch: true,
  canAttach: true,
  canInject: true,
  canIntercept: true,
  canControlClock: true,
  canAccessStorage: true,
  canAccessNativeUI: true,
  supportsMainEval: true,
  supportsRendererEval: true,
  supportsInteraction: true,
}

const servers: Array<Awaited<ReturnType<typeof createServer>>> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => undefined)))
  await Promise.all(created.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

async function open(
  session: FakeSession,
  opts: { capabilities?: TransportCapabilities } = {},
): Promise<Awaited<ReturnType<typeof createServer>>> {
  const transport = new FakeTransport({ session, capabilities: opts.capabilities ?? FULL_CAPS })
  const server = await createServer({
    plugins: [clockPlugin],
    logger: NOOP_LOGGER,
    transports: new TransportRegistry({ transports: [transport] }),
  })
  servers.push(server)
  return server
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

describe('clock plugin', () => {
  it('advertises the package version through plugin introspection', async () => {
    const server = await open(new FakeSession())
    expect(await server.dispatcher.dispatch('electron_plugins', {})).toMatchObject({
      ok: true,
      plugins: [{ name: 'clock', version: packageJson.version }],
    })
  })

  it('installs a clock and relays each seam op to the session', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)

    expect(
      await server.dispatcher.dispatch('clock_install', { sessionId, time: 1000 }),
    ).toMatchObject({ ok: true, installed: true, time: 1000 })
    expect(
      await server.dispatcher.dispatch('clock_set_time', { sessionId, time: 2000 }),
    ).toMatchObject({
      ok: true,
      fixed: 2000,
    })
    expect(
      await server.dispatcher.dispatch('clock_advance', { sessionId, ms: 5000 }),
    ).toMatchObject({
      ok: true,
      advancedMs: 5000,
    })
    expect(await server.dispatcher.dispatch('clock_run_for', { sessionId, ms: 250 })).toMatchObject(
      {
        ok: true,
        ranForMs: 250,
      },
    )
    expect(
      await server.dispatcher.dispatch('clock_pause', { sessionId, time: 9000 }),
    ).toMatchObject({
      ok: true,
      pausedAt: 9000,
    })
    expect(
      await server.dispatcher.dispatch('clock_set_system_time', { sessionId, time: 3000 }),
    ).toMatchObject({ ok: true, systemTime: 3000 })
    expect(await server.dispatcher.dispatch('clock_resume', { sessionId })).toMatchObject({
      ok: true,
      resumed: true,
    })

    expect(session.clockCalls).toEqual([
      { method: 'installClock', arg: 1000 },
      { method: 'setFixedTime', arg: 2000 },
      { method: 'advanceClock', arg: 5000 },
      { method: 'runClockFor', arg: 250 },
      { method: 'pauseClockAt', arg: 9000 },
      { method: 'setSystemTime', arg: 3000 },
      { method: 'resumeClock' },
    ])
  })

  it('installs at the current time when none is given', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    expect(await server.dispatcher.dispatch('clock_install', { sessionId })).toMatchObject({
      ok: true,
      installed: true,
    })
    expect(session.clockCalls).toEqual([{ method: 'installClock' }])
  })

  it('rejects every post-install tool before an install with clock.NOT_INSTALLED', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    // Every tool that calls requireInstalled — not just a sample — must refuse before clock_install.
    for (const [tool, args] of [
      ['clock_set_time', { time: 1 }],
      ['clock_set_system_time', { time: 1 }],
      ['clock_advance', { ms: 1 }],
      ['clock_run_for', { ms: 1 }],
      ['clock_pause', { time: 1 }],
      ['clock_resume', {}],
    ] as const) {
      expect(await server.dispatcher.dispatch(tool, { sessionId, ...args })).toMatchObject({
        ok: false,
        code: 'clock.NOT_INSTALLED',
      })
    }
    // Nothing reached the seam.
    expect(session.clockCalls).toEqual([])
  })

  it('rejects a transport that cannot control the clock with clock.UNSUPPORTED', async () => {
    const server = await open(new FakeSession(), {
      capabilities: { ...FULL_CAPS, canControlClock: false },
    })
    const sessionId = await launch(server)
    expect(await server.dispatcher.dispatch('clock_install', { sessionId })).toMatchObject({
      ok: false,
      code: 'clock.UNSUPPORTED',
    })
  })

  it('rejects bad arguments before they reach the transport', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    // negative ms -> zod nonnegative -> BAD_ARGUMENT.
    await server.dispatcher.dispatch('clock_install', { sessionId })
    expect(await server.dispatcher.dispatch('clock_advance', { sessionId, ms: -1 })).toMatchObject({
      ok: false,
      code: 'BAD_ARGUMENT',
    })
    // missing required time on set_time.
    expect(await server.dispatcher.dispatch('clock_set_time', { sessionId })).toMatchObject({
      ok: false,
      code: 'BAD_ARGUMENT',
    })
    // invalid date-time strings are rejected by the schema, not deferred to the transport.
    expect(
      await server.dispatcher.dispatch('clock_set_time', { sessionId, time: 'not-a-date' }),
    ).toMatchObject({
      ok: false,
      code: 'BAD_ARGUMENT',
    })
    expect(session.clockCalls).toEqual([{ method: 'installClock' }])
  })

  it('reports clock status before and after install', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    expect(await server.dispatcher.dispatch('clock_status', { sessionId })).toMatchObject({
      ok: true,
      installed: false,
    })
    await server.dispatcher.dispatch('clock_install', { sessionId, time: 1000 })
    await server.dispatcher.dispatch('clock_set_time', { sessionId, time: 2000 })
    expect(await server.dispatcher.dispatch('clock_status', { sessionId })).toMatchObject({
      ok: true,
      installed: true,
      mode: 'fixed',
      time: 2000,
    })
  })
})
