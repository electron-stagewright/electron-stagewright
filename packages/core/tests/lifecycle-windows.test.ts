/**
 * Unit tests for the session-operating lifecycle tools: windows_list,
 * switch_window (default no-op vs unsupported non-default vs REF_NOT_FOUND),
 * detach (honest TRANSPORT_UNSUPPORTED), stop, and force_kill.
 */

import { describe, expect, it } from 'vitest'

import { type ErrorResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import {
  detachTool,
  forceKillTool,
  stopTool,
  switchWindowTool,
  windowsListTool,
} from '../src/tools/lifecycle/index.js'
import type { WindowDescriptor } from '../src/transports/index.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'

const WIN0: WindowDescriptor = { id: 'w0', index: 0, title: 'Main', visible: true, focused: true }
const WIN1: WindowDescriptor = { id: 'w1', index: 1, title: 'Prefs', visible: true, focused: false }

function setup(windows: readonly WindowDescriptor[] = [WIN0, WIN1]) {
  const sessions = new SessionManager()
  const transport = new FakeTransport()
  const session = new FakeSession({ id: 'sess', windows })
  sessions.register(transport, session)
  const dispatcher = new Dispatcher({ sessions })
  dispatcher.registerAll([windowsListTool, switchWindowTool, detachTool, stopTool, forceKillTool])
  return { sessions, transport, session, dispatcher }
}

describe('electron_windows_list', () => {
  it('returns the window list with a count', async () => {
    const { dispatcher } = setup()
    const res = await dispatcher.dispatch('electron_windows_list', {})
    expect(res).toMatchObject({ ok: true, session_id: 'sess', windows: [WIN0, WIN1], count: 2 })
    expect(JSON.parse(JSON.stringify(res))).toEqual(res)
  })
})

describe('electron_switch_window', () => {
  it('succeeds as a no-op when selecting the default (active) window', async () => {
    const { dispatcher } = setup()
    const res = await dispatcher.dispatch('electron_switch_window', { index: 0 })
    expect(res).toMatchObject({ ok: true, active: WIN0 })
  })

  it('returns TRANSPORT_UNSUPPORTED when switching to a non-default window', async () => {
    const { dispatcher } = setup()
    const res = await dispatcher.dispatch('electron_switch_window', { targetId: 'w1' })
    expect((res as ErrorResponse).code).toBe('TRANSPORT_UNSUPPORTED')
  })

  it('applies targetId before windowTitle and index', async () => {
    const { dispatcher } = setup()
    const res = await dispatcher.dispatch('electron_switch_window', {
      targetId: 'w0',
      windowTitle: 'Prefs',
      index: 1,
    })
    expect(res).toMatchObject({ ok: true, active: WIN0 })
  })

  it('returns REF_NOT_FOUND when no window matches', async () => {
    const { dispatcher } = setup()
    const res = await dispatcher.dispatch('electron_switch_window', { targetId: 'nope' })
    expect((res as ErrorResponse).code).toBe('REF_NOT_FOUND')
  })
})

describe('electron_detach', () => {
  it('returns TRANSPORT_UNSUPPORTED (not yet supported by any transport)', async () => {
    const { dispatcher } = setup()
    const res = await dispatcher.dispatch('electron_detach', {})
    expect((res as ErrorResponse).code).toBe('TRANSPORT_UNSUPPORTED')
  })
})

describe('electron_stop / electron_force_kill', () => {
  it('stop gracefully removes the session', async () => {
    const { sessions, transport, session, dispatcher } = setup()
    const res = await dispatcher.dispatch('electron_stop', {})
    expect(res).toMatchObject({ ok: true, stopped: true })
    expect(transport.stopCount).toBe(1)
    expect(session.disposeCount).toBe(1)
    expect(sessions.size).toBe(0)
  })

  it('force_kill removes the session via forceKill', async () => {
    const { sessions, transport, dispatcher } = setup()
    const res = await dispatcher.dispatch('electron_force_kill', {})
    expect(res).toMatchObject({ ok: true, killed: true })
    expect(transport.forceKillCount).toBe(1)
    expect(sessions.size).toBe(0)
  })

  it('stop on a fresh manager returns NOT_RUNNING', async () => {
    const sessions = new SessionManager()
    const dispatcher = new Dispatcher({ sessions })
    dispatcher.register(stopTool)
    const res = await dispatcher.dispatch('electron_stop', {})
    expect((res as ErrorResponse).code).toBe('NOT_RUNNING')
  })
})
