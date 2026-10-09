import { describe, expect, it, vi } from 'vitest'

import { StagewrightError } from '../src/errors/registry.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { pressSequenceTool, typeIntoEditorTool } from '../src/tools/interaction/keyboard.js'
import { clickTool } from '../src/tools/interaction/pointer.js'
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

  it('does not run miss diagnosis after cancellation when the action later fails', async () => {
    const sessions = new SessionManager()
    const session = new FakeSession()
    sessions.register(new FakeTransport(), session)
    const dispatcher = new Dispatcher({ sessions, operationTimeoutMs: 0 })
    dispatcher.register(clickTool)
    const gate = deferred()
    const entered = deferred()
    vi.spyOn(session, 'click').mockImplementationOnce(async () => {
      entered.resolve()
      await gate.promise
      throw new StagewrightError('SELECTOR_NO_MATCH', 'No element matches #missing.')
    })
    const controller = new AbortController()
    const pending = dispatcher.dispatch(
      'electron_click',
      { selector: '#missing' },
      { signal: controller.signal },
    )
    await entered.promise
    // A miss normally re-walks and retags the live DOM for similar_refs; after cancellation
    // that would mutate tags and the snapshot store for a request nobody is waiting on.
    const activeSurface = vi.spyOn(session, 'activeSurface')
    const evaluate = vi.spyOn(session, 'evaluate')
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, code: 'OPERATION_CANCELLED' })
    gate.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(activeSurface).not.toHaveBeenCalled()
    expect(evaluate).not.toHaveBeenCalled()
  })
})
