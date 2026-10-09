import { describe, expect, it, vi } from 'vitest'

import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { pressSequenceTool, typeIntoEditorTool } from '../src/tools/interaction/keyboard.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

describe('interaction cancellation boundaries', () => {
  it('does not send the remaining keys after cancellation during a key sequence', async () => {
    const sessions = new SessionManager()
    const session = new FakeSession()
    sessions.register(new FakeTransport(), session)
    const dispatcher = new Dispatcher({ sessions, operationTimeoutMs: 0 })
    dispatcher.register(pressSequenceTool)
    const gate = deferred()
    const entered = deferred()
    const press = vi.spyOn(session, 'press').mockImplementationOnce(async () => {
      entered.resolve()
      await gate.promise
    })
    const controller = new AbortController()
    const pending = dispatcher.dispatch(
      'electron_press_sequence',
      {
        keys: ['Control+A', 'Delete', 'Enter'],
      },
      { signal: controller.signal },
    )
    await entered.promise
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, code: 'OPERATION_CANCELLED' })
    gate.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(press).toHaveBeenCalledTimes(1)
  })

  it('does not replace editor content after cancellation during the focusing click', async () => {
    const sessions = new SessionManager()
    const session = new FakeSession({ evaluate: async () => 'original' })
    sessions.register(new FakeTransport(), session)
    const dispatcher = new Dispatcher({ sessions, operationTimeoutMs: 0 })
    dispatcher.register(typeIntoEditorTool)
    const gate = deferred()
    const entered = deferred()
    vi.spyOn(session, 'click').mockImplementationOnce(async () => {
      entered.resolve()
      await gate.promise
    })
    const press = vi.spyOn(session, 'press')
    const type = vi.spyOn(session, 'typeText')
    const controller = new AbortController()
    const pending = dispatcher.dispatch(
      'electron_type_into_editor',
      {
        selector: '#editor',
        text: 'replacement',
        replace: true,
      },
      { signal: controller.signal },
    )
    await entered.promise
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, code: 'OPERATION_CANCELLED' })
    gate.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(press).not.toHaveBeenCalled()
    expect(type).not.toHaveBeenCalled()
  })
})
