/**
 * Integration tests for the clock plugin (ADR-017) loaded into a real server. The session transport is
 * a FakeTransport whose FakeSession records each clock-seam call, so the plugin's orchestration — the
 * canControlClock gate, the per-session install lifecycle (clock.NOT_INSTALLED before install), the
 * relay to the seam, and status — is exercised without launching Electron. The real `page.clock` path
 * is covered by the gated real-Electron smoke and the Playwright-session unit tests.
 */

import type { StagewrightServer, TransportCapabilities } from '@electron-stagewright/core'
import {
  FakeSession,
  FakeTransport,
  fullCapabilities,
  TestLifecycle,
} from '@electron-stagewright/testkit'
import { afterEach, describe, expect, it } from 'vitest'

import packageJson from '../package.json' with { type: 'json' }
import clockPlugin from '../src/index.js'

const lifecycle = new TestLifecycle()
afterEach(() => lifecycle.cleanup())

async function open(
  session: FakeSession,
  opts: { capabilities?: TransportCapabilities } = {},
): Promise<StagewrightServer> {
  const { server } = await lifecycle.createPluginTestServer(clockPlugin, {
    session,
    capabilities: opts.capabilities ?? fullCapabilities(),
  })
  return server
}

async function launch(server: StagewrightServer): Promise<string> {
  return lifecycle.launch(server)
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
      capabilities: fullCapabilities({ canControlClock: false }),
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

  it('isolates same-id clocks across servers and clears state when a session stops', async () => {
    const id = 'shared-clock-session'
    const first = await open(new FakeSession({ id }))
    const second = await open(new FakeSession({ id }))
    await launch(first)
    await launch(second)

    await first.dispatcher.dispatch('clock_install', { sessionId: id, time: 1000 })
    expect(await first.dispatcher.dispatch('clock_status', { sessionId: id })).toMatchObject({
      ok: true,
      installed: true,
    })
    expect(await second.dispatcher.dispatch('clock_status', { sessionId: id })).toMatchObject({
      ok: true,
      installed: false,
    })

    expect(await first.dispatcher.dispatch('electron_stop', { sessionId: id })).toMatchObject({
      ok: true,
      stopped: true,
    })
    const restarted = new FakeSession({ id })
    first.sessions.register(new FakeTransport({ session: restarted }), restarted)
    expect(await first.dispatcher.dispatch('clock_status', { sessionId: id })).toMatchObject({
      ok: true,
      installed: false,
    })
  })

  it('leaves no clock state behind after one hundred force-kill cycles', async () => {
    const id = 'clock-cycle-session'
    const server = await open(new FakeSession({ id }))
    await launch(server)

    for (let cycle = 0; cycle < 100; cycle += 1) {
      expect(await server.dispatcher.dispatch('clock_status', { sessionId: id })).toMatchObject({
        ok: true,
        installed: false,
      })
      await server.dispatcher.dispatch('clock_install', { sessionId: id })
      expect(
        await server.dispatcher.dispatch('electron_force_kill', { sessionId: id }),
      ).toMatchObject({
        ok: true,
        killed: true,
      })
      if (cycle < 99) {
        const replacement = new FakeSession({ id })
        server.sessions.register(new FakeTransport({ session: replacement }), replacement)
      }
    }
  })
})
