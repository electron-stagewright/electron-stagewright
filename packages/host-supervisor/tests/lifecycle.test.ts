import { describe, expect, it, vi } from 'vitest'

import {
  createHost,
  inProcessTransport,
  type CallContext,
  type HostStartedEvent,
} from '../src/index.js'
import { calls, fakeTransport, rejection, settle } from './fake-transport.js'

interface Ops {
  echo(value: string): Promise<string>
  work(ms: number): Promise<string>
}

/** `work` stops early when aborted and says so, as a cancellable engine query would. */
function served(log: string[] = []) {
  return inProcessTransport<Ops>({
    operations: ['echo', 'work'],
    start: () => {
      log.push('start')
      return {
        echo: (value: string) => value,
        work: (ms: number, { signal }: CallContext) =>
          new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => resolve('finished'), ms)
            signal.addEventListener('abort', () => {
              clearTimeout(timer)
              reject(Object.assign(new Error('cancelled by the engine'), { code: 'CANCELLED' }))
            })
          }),
      }
    },
    stop: () => void log.push('stop'),
  })
}

describe('abortGraceMs', () => {
  it('refuses a grace no timer can hold', () => {
    expect(() =>
      createHost<Ops>({
        operations: ['echo', 'work'],
        transport: served(),
        limits: { abortGraceMs: Number.POSITIVE_INFINITY },
      }),
    ).toThrow(RangeError)
  })

  it('settles an aborted call with the host answer', async () => {
    const host = createHost<Ops>({
      operations: ['echo', 'work'],
      transport: served(),
      limits: { abortGraceMs: 1_000 },
    })
    await host.start()
    const controller = new AbortController()
    const answer = host.call('work', [10_000], { signal: controller.signal })
    await settle()
    controller.abort()
    expect(await rejection(answer)).toMatchObject({
      message: 'cancelled by the engine',
      code: 'CANCELLED',
    })
    await host.close()
  })

  it('fails with HOST_ABORT_UNSETTLED when the host does not answer in time', async () => {
    const transport = fakeTransport()
    const host = createHost<Ops>({ operations: ['echo', 'work'], transport })
    await host.start()
    const controller = new AbortController()
    const answer = host.call('work', [1], { signal: controller.signal, abortGraceMs: 20 })
    await settle()
    controller.abort('user')
    await settle()
    expect(transport.last.sent.at(-1)).toEqual({ type: 'cancel', id: calls(transport.last)[0]?.id })
    const error = await rejection(answer)
    expect(error).toMatchObject({ code: 'HOST_ABORT_UNSETTLED', cause: 'user' })
    await host.close()
  })

  it('keeps the call counted against maxPending until it settles', async () => {
    const transport = fakeTransport()
    const host = createHost<Ops>({
      operations: ['echo', 'work'],
      transport,
      limits: { maxPending: 1, abortGraceMs: 1_000 },
    })
    await host.start()
    const controller = new AbortController()
    const first = host.call('work', [1], { signal: controller.signal })
    await settle()
    controller.abort()
    expect(await rejection(host.ops.echo('x'))).toMatchObject({ code: 'HOST_QUEUE_FULL' })
    const id = calls(transport.last)[0]?.id ?? 0
    transport.last.reply({ type: 'result', id, ok: true, value: 'finished anyway' })
    expect(await first).toBe('finished anyway')
    await host.close()
  })

  it('still fails at once for a call the host never received', async () => {
    const transport = fakeTransport({ autoStart: false })
    const host = createHost<Ops>({
      operations: ['echo', 'work'],
      transport,
      limits: { abortGraceMs: 1_000 },
    })
    const controller = new AbortController()
    const answer = host.call('work', [1], { signal: controller.signal })
    await settle()
    controller.abort()
    expect(await rejection(answer)).toMatchObject({ code: 'HOST_CALL_ABORTED' })
    void host.kill()
  })
})

describe('pause and resume', () => {
  it('drains, keeps calls waiting without launching, and serves them after resume', async () => {
    const log: string[] = []
    const host = createHost<Ops>({ operations: ['echo', 'work'], transport: served(log) })
    const inFlight = host.ops.work(20)
    await settle()
    const paused = host.pause()
    const waiting = host.ops.echo('after')
    await paused
    expect(await inFlight).toBe('finished')
    expect(host.state).toBe('paused')
    await settle(10)
    expect(log).toEqual(['start', 'stop'])
    host.resume()
    expect(await waiting).toBe('after')
    expect(log).toEqual(['start', 'stop', 'start'])
    expect(host.state).toBe('running')
    await host.close()
  })

  it('rejects calls with HOST_PAUSED in reject mode', async () => {
    const host = createHost<Ops>({ operations: ['echo', 'work'], transport: served() })
    await host.start()
    await host.pause({ calls: 'reject' })
    expect(await rejection(host.ops.echo('x'))).toMatchObject({ code: 'HOST_PAUSED' })
    expect(await rejection(host.start())).toMatchObject({ code: 'HOST_PAUSED' })
    host.resume()
    expect(await host.ops.echo('y')).toBe('y')
    await host.close()
  })

  it('bounds a waiting call by its timeout', async () => {
    const host = createHost<Ops>({ operations: ['echo', 'work'], transport: served() })
    await host.pause()
    const error = await rejection(host.call('echo', ['x'], { timeoutMs: 20 }))
    expect(error).toMatchObject({ code: 'HOST_CALL_TIMEOUT' })
    await host.close()
  })

  it('stays paused when the stop fails, and reports the failure', async () => {
    const transport = fakeTransport({ autoStop: false })
    const host = createHost<Ops>({
      operations: ['echo', 'work'],
      transport,
      stop: { graceMs: 10 },
    })
    await host.start()
    const error = await rejection(host.pause())
    expect(error).toMatchObject({ code: 'HOST_STOP_TIMEOUT' })
    expect(host.state).toBe('paused')
    expect(transport.channels).toHaveLength(1)
    host.resume()
    await host.start()
    expect(transport.channels).toHaveLength(2)
    void host.kill()
  })

  it('holds a restart that was pending when it paused', async () => {
    const transport = fakeTransport()
    const host = createHost<Ops>({
      operations: ['echo', 'work'],
      transport,
      onExit: () => ({ action: 'restart', delayMs: 50 }),
    })
    await host.start()
    transport.last.exit({ code: 1 })
    await settle()
    expect(host.state).toBe('restarting')
    const waiting = host.ops.echo('x')
    await host.pause()
    await settle(80)
    expect(transport.channels).toHaveLength(1)
    host.resume()
    await settle()
    expect(transport.channels).toHaveLength(2)
    const id = calls(transport.last)[0]?.id ?? 0
    transport.last.reply({ type: 'result', id, ok: true, value: 'x' })
    expect(await waiting).toBe('x')
    await host.close()
  })

  it('does not hold a start once close() has begun', async () => {
    const host = createHost<Ops>({ operations: ['echo', 'work'], transport: served() })
    await host.start()
    const closing = host.close()
    void host.pause()
    await expect(host.start()).rejects.toBeInstanceOf(Error)
    await closing
  })

  it('rejects a waiting start() when the pause turns to reject', async () => {
    const host = createHost<Ops>({ operations: ['echo', 'work'], transport: served() })
    await host.pause()
    const waiting = host.start()
    await settle()
    await host.pause({ calls: 'reject' })
    await expect(waiting).rejects.toMatchObject({ code: 'HOST_PAUSED' })
    await host.close()
  })

  it('fails waiting calls when closed while paused', async () => {
    const host = createHost<Ops>({ operations: ['echo', 'work'], transport: served() })
    await host.pause()
    const waiting = host.ops.echo('x')
    await host.close()
    expect(await rejection(waiting)).toMatchObject({ code: 'HOST_STOPPED' })
    expect(host.state).toBe('closed')
  })

  it('waits for the pause stop before resuming a call made during it', async () => {
    const log: string[] = []
    const host = createHost<Ops>({ operations: ['echo', 'work'], transport: served(log) })
    const inFlight = host.ops.work(20)
    await settle()
    const paused = host.pause()
    const waiting = host.ops.echo('soon')
    host.resume()
    expect(await waiting).toBe('soon')
    await paused
    expect(await inFlight).toBe('finished')
    expect(log).toEqual(['start', 'stop', 'start'])
    await host.close()
  })
})

describe('onStarted', () => {
  it('reports first starts and restarts with the exit and attempt', async () => {
    const transport = fakeTransport()
    const events: HostStartedEvent[] = []
    let failNext = false
    const launch = transport.launch.bind(transport)
    transport.launch = () => {
      if (failNext) {
        failNext = false
        throw new Error('spawn failed')
      }
      return launch()
    }
    const host = createHost<Ops>({
      operations: ['echo', 'work'],
      transport,
      onExit: () => 'restart',
      onStarted: (event) => void events.push(event),
    })
    await host.start()
    failNext = true
    transport.last.exit({ code: 7 })
    await settle(5)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ launches: 1, restart: null })
    expect(events[1]).toMatchObject({
      launches: 2,
      restart: { attempt: 2, exit: { reason: 'exit', code: 7 } },
    })
    await host.close()
  })

  it('reports an on-demand replacement on the next call', async () => {
    const transport = fakeTransport()
    const events: HostStartedEvent[] = []
    const host = createHost<Ops>({
      operations: ['echo', 'work'],
      transport,
      onExit: () => 'on-demand',
      onStarted: (event) => void events.push(event),
    })
    await host.start()
    transport.last.exit({ code: 1 })
    await settle()
    void host.ops.echo('x').catch(() => undefined)
    await settle()
    expect(events[1]).toMatchObject({ launches: 2, restart: { attempt: 1, exit: { code: 1 } } })
    void host.kill()
  })

  it('relaunches a restart a pause interrupted, with its exit', async () => {
    const transport = fakeTransport()
    const events: HostStartedEvent[] = []
    const host = createHost<Ops>({
      operations: ['echo', 'work'],
      transport,
      onExit: () => ({ action: 'restart', delayMs: 50 }),
      onStarted: (event) => void events.push(event),
    })
    await host.start()
    transport.last.exit({ code: 1 })
    await settle()
    await host.pause()
    host.resume()
    await settle()
    expect(transport.channels).toHaveLength(2)
    expect(events[1]).toMatchObject({ launches: 2, restart: { attempt: 1, exit: { code: 1 } } })
    await host.close()
  })

  it('counts a failed on-demand replacement as an attempt', async () => {
    const transport = fakeTransport()
    const events: HostStartedEvent[] = []
    let failNext = false
    const launch = transport.launch.bind(transport)
    transport.launch = () => {
      if (failNext) {
        failNext = false
        throw new Error('spawn failed')
      }
      return launch()
    }
    const host = createHost<Ops>({
      operations: ['echo', 'work'],
      transport,
      onExit: () => 'on-demand',
      onStarted: (event) => void events.push(event),
    })
    await host.start()
    transport.last.exit({ code: 1 })
    await settle()
    failNext = true
    await rejection(host.start())
    await host.start()
    expect(events[1]).toMatchObject({ restart: { attempt: 2, exit: { code: 1 } } })
    await host.close()
  })

  it('reports a start after stop() as a fresh start', async () => {
    const transport = fakeTransport()
    const events: HostStartedEvent[] = []
    const host = createHost<Ops>({
      operations: ['echo', 'work'],
      transport,
      onExit: () => 'on-demand',
      onStarted: (event) => void events.push(event),
    })
    await host.start()
    transport.last.exit({ code: 1 })
    await settle()
    await host.stop()
    await host.start()
    expect(events[1]).toMatchObject({ restart: null })
    await host.close()
  })

  it('turns a throwing listener into a warning', async () => {
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const host = createHost<Ops>({
      operations: ['echo', 'work'],
      transport: fakeTransport(),
      onStarted: () => {
        throw new Error('listener bug')
      },
    })
    await host.start()
    await settle()
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ message: 'listener bug' }))
    warning.mockRestore()
    await host.close()
  })
})
