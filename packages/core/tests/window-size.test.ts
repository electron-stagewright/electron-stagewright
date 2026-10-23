/**
 * Unit tests for `electron_set_window_size`: it resizes the active (or given) window, reports the
 * size the window really got, and explains a clamp by the window's limits.
 */

import { describe, expect, it } from 'vitest'

import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { setWindowSizeTool } from '../src/tools/lifecycle/window-size.js'
import type { WindowDescriptor } from '../src/transports/index.js'
import { FakeSession, FakeTransport } from '../../testkit/src/fake-transport.js'

const MAIN: WindowDescriptor = { id: 'w1', index: 0, title: 'Main', visible: true, focused: true }
const PREFS: WindowDescriptor = {
  id: 'w2',
  index: 1,
  title: 'Prefs',
  visible: true,
  focused: false,
}

function setup(windows: readonly WindowDescriptor[] = [MAIN, PREFS]) {
  const sessions = new SessionManager()
  const session = new FakeSession({ id: 'sess', windows })
  sessions.register(new FakeTransport(), session)
  const dispatcher = new Dispatcher({ sessions, snapshots: new SnapshotStore() })
  dispatcher.register(setWindowSizeTool)
  return { dispatcher, session }
}

describe('electron_set_window_size', () => {
  it('resizes the active window and reports the size it got', async () => {
    const { dispatcher, session } = setup()
    await expect(
      dispatcher.dispatch('electron_set_window_size', { width: 1024, height: 700 }),
    ).resolves.toMatchObject({
      ok: true,
      window_id: 'w1',
      requested: { width: 1024, height: 700, area: 'window' },
      actual: { width: 1024, height: 700 },
      clamped: false,
      window: { width: 1024, height: 700 },
      content: { width: 1024, height: 672 },
      min_size: null,
      method: 'browser_window',
    })
    expect(session.setWindowSizeCalls).toEqual([
      { target: { kind: 'id', id: 'w1' }, request: { width: 1024, height: 700, content: false } },
    ])
  })

  it('reports a clamp by the minimum size', async () => {
    const { dispatcher, session } = setup()
    session.windowFrame = { ...session.windowFrame, minimum: { width: 400, height: 768 } }
    const res = await dispatcher.dispatch('electron_set_window_size', { width: 1024, height: 720 })
    expect(res).toMatchObject({
      ok: true,
      actual: { width: 1024, height: 768 },
      clamped: true,
      clamped_by: 'minimum_size',
      min_size: { width: 400, height: 768 },
    })
    expect(res).not.toHaveProperty('restored_from')
  })

  it('compares a content request with the limits once the frame is added', async () => {
    const { dispatcher, session } = setup()
    session.windowFrame = { ...session.windowFrame, maximum: { width: 0, height: 628 } }
    await expect(
      dispatcher.dispatch('electron_set_window_size', {
        width: 800,
        height: 620,
        area: 'content',
      }),
    ).resolves.toMatchObject({
      actual: { width: 800, height: 600 },
      clamped: true,
      clamped_by: 'maximum_size',
      window: { width: 800, height: 628 },
    })
    expect(session.setWindowSizeCalls[0]?.request).toEqual({
      width: 800,
      height: 620,
      content: true,
    })
  })

  it('blames the window system when no limit explains the clamp', async () => {
    const { dispatcher, session } = setup()
    session.setWindowSize = async () => ({
      outer: { width: 1440, height: 900 },
      content: { width: 1440, height: 872 },
      minimum: null,
      maximum: null,
      method: 'renderer',
    })
    await expect(
      dispatcher.dispatch('electron_set_window_size', { width: 5000, height: 4000 }),
    ).resolves.toMatchObject({ clamped: true, clamped_by: 'window_system', method: 'renderer' })
  })

  it('targets windowId and refuses an unknown one', async () => {
    const { dispatcher, session } = setup()
    await dispatcher.dispatch('electron_set_window_size', {
      width: 640,
      height: 480,
      windowId: 'w2',
    })
    expect(session.setWindowSizeCalls[0]?.target).toEqual({ kind: 'id', id: 'w2' })
    await expect(
      dispatcher.dispatch('electron_set_window_size', {
        width: 640,
        height: 480,
        windowId: 'nope',
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'REF_NOT_FOUND',
      next_actions: ['electron_windows_list()'],
    })
    expect(session.setWindowSizeCalls).toHaveLength(1)
  })

  it('refuses when no window is open, and rejects bad sizes', async () => {
    await expect(
      setup([]).dispatcher.dispatch('electron_set_window_size', { width: 640, height: 480 }),
    ).resolves.toMatchObject({ ok: false, code: 'REF_NOT_FOUND' })
    const { dispatcher } = setup()
    for (const size of [
      { width: 0, height: 480 },
      { width: 640.5, height: 480 },
    ]) {
      await expect(dispatcher.dispatch('electron_set_window_size', size)).resolves.toMatchObject({
        ok: false,
        code: 'BAD_ARGUMENT',
      })
    }
  })
})
