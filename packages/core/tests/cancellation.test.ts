import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { makeSuccess } from '../src/errors/envelope.js'
import { StagewrightError } from '../src/errors/registry.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { NOOP_PROGRESS_REPORTER, withElapsedProgress } from '../src/server/progress.js'
import { SessionManager } from '../src/server/session-manager.js'
import { TransportRegistry } from '../src/server/transport-registry.js'
import { attachTool, injectTool } from '../src/tools/lifecycle/attach.js'
import { makeLaunchTool } from '../src/tools/lifecycle/launch.js'
import { defineTool, type ToolContext } from '../src/tools/types.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function setup(transport = new FakeTransport(), operationTimeoutMs = 0) {
  const sessions = new SessionManager()
  const dispatcher = new Dispatcher({
    sessions,
    operationTimeoutMs,
    transports: new TransportRegistry({ transports: [transport] }),
  })
  dispatcher.registerAll([makeLaunchTool({ fileExists: () => true }), attachTool, injectTool])
  return { dispatcher, sessions, transport }
}

afterEach(() => vi.useRealTimers())

describe('request cancellation', () => {
  it('never enters a handler for a pre-cancelled request, even with the timeout disabled', async () => {
    const { dispatcher, transport } = setup()
    const controller = new AbortController()
    controller.abort('private client reason')
    const result = await dispatcher.dispatch(
      'electron_launch',
      { main: '/app/main.js' },
      { signal: controller.signal },
    )
    expect(result).toMatchObject({ ok: false, code: 'OPERATION_CANCELLED', retryable: false })
    expect(JSON.stringify(result)).not.toContain('private client reason')
    expect(transport.launchCount).toBe(0)
  })

  it.each(['launch', 'attach', 'inject'] as const)(
    'cleans a late %s without registering a session',
    async (kind) => {
      const { dispatcher, sessions, transport } = setup()
      const gate = deferred<FakeSession>()
      const entered = deferred<void>()
      vi.spyOn(transport, kind).mockImplementation(() => {
        entered.resolve()
        return gate.promise
      })
      const windows = vi.spyOn(transport.session, 'windowsList')
      const controller = new AbortController()
      const pending = dispatcher.dispatch(
        `electron_${kind}`,
        kind === 'launch' ? { main: '/app/main.js' } : { port: 9222, pid: 42 },
        { signal: controller.signal },
      )
      await entered.promise
      controller.abort()
      expect(await pending).toMatchObject({ code: 'OPERATION_CANCELLED' })
      gate.resolve(transport.session)
      await vi.waitFor(() =>
        expect(kind === 'launch' ? transport.stopCount : transport.session.detachCount).toBe(1),
      )
      expect(sessions.size).toBe(0)
      expect(windows).not.toHaveBeenCalled()
      expect(transport.stopCount).toBe(kind === 'launch' ? 1 : 0)
      expect(transport.forceKillCount).toBe(0)
    },
  )

  it('cleans up immediately while the initial window probe is hung, only once after it settles', async () => {
    const { dispatcher, sessions, transport } = setup()
    const entered = deferred<void>()
    const gate = deferred<never>()
    vi.spyOn(transport.session, 'windowsList').mockImplementation(() => {
      entered.resolve()
      return gate.promise
    })
    const controller = new AbortController()
    const pending = dispatcher.dispatch(
      'electron_attach',
      { port: 9222 },
      { signal: controller.signal },
    )
    await entered.promise
    controller.abort()
    expect(await pending).toMatchObject({ code: 'OPERATION_CANCELLED' })
    expect(transport.session.detachCount).toBe(1)
    gate.reject(new Error('socket closed'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(transport.session.detachCount).toBe(1)
    expect(sessions.size).toBe(0)
    expect(transport.stopCount).toBe(0)
  })

  it('times out renderer preparation before publishing the session and stops only its owned app', async () => {
    vi.useFakeTimers()
    const entered = deferred<void>()
    const session = new FakeSession({
      evaluate: () => {
        entered.resolve()
        return new Promise(() => undefined)
      },
    })
    const { dispatcher, sessions, transport } = setup(new FakeTransport({ session }), 20)
    const pending = dispatcher.dispatch('electron_launch', { main: '/app/main.js' })
    await entered.promise
    expect(sessions.size).toBe(0)
    await vi.advanceTimersByTimeAsync(20)
    expect(await pending).toMatchObject({ code: 'OPERATION_TIMEOUT' })
    expect(transport.stopCount).toBe(1)
    expect(sessions.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('passes cancellation to nested dispatch and keeps concurrent requests independent', async () => {
    const { dispatcher } = setup()
    const gate = deferred<void>()
    const entered = deferred<void>()
    const sideEffect = vi.fn()
    dispatcher.register(
      defineTool({
        name: 'test_action',
        description: 'action',
        inputSchema: z.object({}),
        operationType: 'command',
        handler: async () => {
          sideEffect()
          return makeSuccess({})
        },
      }),
    )
    dispatcher.register(
      defineTool({
        name: 'test_parent',
        description: 'parent',
        inputSchema: z.object({}),
        operationType: 'query',
        handler: async (_args, ctx) => {
          entered.resolve()
          await gate.promise
          return ctx.dispatch('test_action', {})
        },
      }),
    )
    const controller = new AbortController()
    const pending = dispatcher.dispatch('test_parent', {}, { signal: controller.signal })
    await entered.promise
    controller.abort()
    expect(await pending).toMatchObject({ code: 'OPERATION_CANCELLED' })
    expect(await dispatcher.dispatch('test_action', {})).toMatchObject({ ok: true })
    gate.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(sideEffect).toHaveBeenCalledTimes(1)
  })

  it('detaches the parent signal after success so later cancellation preserves the completed session', async () => {
    const { dispatcher, sessions, transport } = setup()
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    expect(
      await dispatcher.dispatch('electron_attach', { port: 9222 }, { signal: controller.signal }),
    ).toMatchObject({ ok: true })
    controller.abort()
    expect(sessions.size).toBe(1)
    expect(transport.session.detachCount).toBe(0)
    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1])
  })

  it('rolls back a just-registered attach even if disconnect rejects, without stopping the app', async () => {
    const session = new FakeSession({ detachError: new Error('disconnect failed') })
    const detach = vi.spyOn(session, 'detach')
    const { dispatcher, sessions, transport } = setup(new FakeTransport({ session }))
    const controller = new AbortController()
    const register = sessions.register.bind(sessions)
    vi.spyOn(sessions, 'register').mockImplementation((t, s) => {
      const managed = register(t, s)
      queueMicrotask(() => controller.abort())
      return managed
    })
    expect(
      await dispatcher.dispatch('electron_attach', { port: 9222 }, { signal: controller.signal }),
    ).toMatchObject({ code: 'OPERATION_CANCELLED' })
    expect(sessions.size).toBe(0)
    expect(detach).toHaveBeenCalledTimes(1)
    expect(transport.stopCount).toBe(0)
    expect(transport.forceKillCount).toBe(0)
  })

  it('commits a completed session before notifying observers', async () => {
    const { dispatcher, sessions, transport } = setup()
    const controller = new AbortController()
    dispatcher.addObserver(() => controller.abort())
    expect(
      await dispatcher.dispatch('electron_attach', { port: 9222 }, { signal: controller.signal }),
    ).toMatchObject({ ok: true })
    expect(sessions.size).toBe(1)
    expect(transport.session.detachCount).toBe(0)
  })

  it('clears progress timers on timeout even when the handler never settles', async () => {
    vi.useFakeTimers()
    const { dispatcher } = setup(undefined, 300)
    const report = vi.fn(() => true)
    dispatcher.register(
      defineTool({
        name: 'test_wait',
        description: 'wait',
        inputSchema: z.object({}),
        operationType: 'query',
        handler: async (_args, ctx) =>
          withElapsedProgress(
            { reporter: ctx.progress, totalMs: 1000, message: 'Waiting' },
            () => new Promise(() => undefined),
          ),
      }),
    )
    const pending = dispatcher.dispatch('test_wait', {}, { progress: { enabled: true, report } })
    await vi.advanceTimersByTimeAsync(300)
    expect(await pending).toMatchObject({ code: 'OPERATION_TIMEOUT' })
    expect(report).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not retry renderer initialization after cancellation during a transient failure', async () => {
    const entered = deferred<void>()
    const gate = deferred<never>()
    const evaluate = vi.fn(() => {
      entered.resolve()
      return gate.promise
    })
    const { dispatcher, transport } = setup(
      new FakeTransport({ session: new FakeSession({ evaluate }) }),
    )
    const controller = new AbortController()
    const pending = dispatcher.dispatch(
      'electron_launch',
      { main: '/app/main.js' },
      { signal: controller.signal },
    )
    await entered.promise
    controller.abort()
    expect(await pending).toMatchObject({ code: 'OPERATION_CANCELLED' })
    gate.reject(new StagewrightError('CDP_DISCONNECTED', 'closed'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(transport.stopCount).toBe(1)
  })

  it('rejects with the request reason when cancelled during a renderer retry delay', async () => {
    const evaluate = vi.fn(() =>
      Promise.reject(new StagewrightError('REF_NOT_FOUND', 'renderer not ready')),
    )
    const transport = new FakeTransport({ session: new FakeSession({ evaluate }) })
    const controller = new AbortController()
    const reason = new StagewrightError('OPERATION_CANCELLED', 'The request was cancelled.')
    const ctx = {
      sessions: new SessionManager(),
      transports: new TransportRegistry({ transports: [transport] }),
      progress: NOOP_PROGRESS_REPORTER,
      now: Date.now,
      startedAt: Date.now(),
      signal: controller.signal,
    } as unknown as ToolContext
    const pending = makeLaunchTool({ fileExists: () => true }).handler(
      { main: '/app/main.js', readyTimeoutMs: 5_000 },
      ctx,
    )
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalled())
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(transport.stopCount).toBe(1)
  })

  it('does not launch after asynchronous preflight completes on a cancelled request', async () => {
    const { dispatcher, transport } = setup()
    const entered = deferred<void>()
    const gate = deferred<undefined>()
    const tool = makeLaunchTool({
      fileExists: () => true,
      inspectElectronFuses: () => {
        entered.resolve()
        return gate.promise
      },
    })
    dispatcher.register({ ...tool, name: 'test_launch_preflight' })
    const controller = new AbortController()
    const pending = dispatcher.dispatch(
      'test_launch_preflight',
      { main: '/app/main.js', executablePath: '/app/electron' },
      { signal: controller.signal },
    )
    await entered.promise
    controller.abort()
    expect(await pending).toMatchObject({ code: 'OPERATION_CANCELLED' })
    gate.resolve(undefined)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(transport.launchCount).toBe(0)
  })

  it('cancels an active nested handler and reports each dispatch only once', async () => {
    const { dispatcher } = setup()
    const entered = deferred<void>()
    const cleanup = vi.fn()
    const completed = vi.fn()
    dispatcher.addObserver(completed)
    dispatcher.register(
      defineTool({
        name: 'test_child',
        description: 'child',
        inputSchema: z.object({}),
        operationType: 'query',
        handler: async (_args, ctx) => {
          ctx.onCancel?.(cleanup)
          entered.resolve()
          return new Promise(() => undefined)
        },
      }),
    )
    dispatcher.register(
      defineTool({
        name: 'test_parent_active',
        description: 'parent',
        inputSchema: z.object({}),
        operationType: 'query',
        handler: async (_args, ctx) => ctx.dispatch('test_child', {}),
      }),
    )
    const controller = new AbortController()
    const pending = dispatcher.dispatch('test_parent_active', {}, { signal: controller.signal })
    await entered.promise
    controller.abort()
    expect(await pending).toMatchObject({ code: 'OPERATION_CANCELLED' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(completed).toHaveBeenCalledTimes(2)
  })
})
