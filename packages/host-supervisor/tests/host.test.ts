import { describe, expect, it, vi } from 'vitest'

import {
  HostError,
  createHost,
  inProcessTransport,
  memoryWatch,
  restartPolicy,
  type CallContext,
  type HostExit,
} from '../src/index.js'
import { calls, fakeTransport, rejection, settle } from './fake-transport.js'

interface Ops {
  echo(value: string): Promise<string>
  fail(code: string): Promise<never>
  slow(ms: number): Promise<string>
  hang(): Promise<string>
  count(limit: number): AsyncIterable<number>
}

const OPERATIONS = ['echo', 'fail', 'slow', 'hang'] as const
const STREAMS = ['count'] as const

function served(log: string[] = []) {
  return inProcessTransport<Ops, { greeting: string }>({
    operations: OPERATIONS,
    streams: STREAMS,
    start: (payload) => ({
      echo: (value: string) => `${payload.greeting} ${value}`,
      fail: (code: string) => {
        throw Object.assign(new Error(`failed with ${code}`), { code })
      },
      slow: (ms: number) => new Promise<string>((resolve) => setTimeout(() => resolve('done'), ms)),
      hang: (context: CallContext) =>
        new Promise<string>((resolve) => {
          context.signal.addEventListener('abort', () => {
            log.push('aborted')
            resolve('aborted')
          })
        }),
      async *count(limit: number) {
        try {
          for (let index = 1; index <= limit; index++) {
            log.push(`produce ${index}`)
            yield index
          }
        } finally {
          log.push('closed')
        }
      },
    }),
    stop: () => void log.push('stopped'),
  })
}

function inProcessHost(log: string[] = [], extra: { maxPending?: number } = {}) {
  return createHost<Ops, { greeting: string }>({
    operations: OPERATIONS,
    streams: STREAMS,
    transport: served(log),
    start: { payload: () => ({ greeting: 'hello' }) },
    limits: { ...(extra.maxPending === undefined ? {} : { maxPending: extra.maxPending }) },
  })
}

describe('createHost calls', () => {
  it('starts lazily, sends the payload, and answers through the typed proxy', async () => {
    const transport = fakeTransport()
    const host = createHost<Ops, { secret: string }>({
      operations: OPERATIONS,
      transport,
      start: { payload: () => ({ secret: 's3' }) },
    })
    expect(transport.channels).toHaveLength(0)
    expect(host.state).toBe('idle')
    const answer = host.ops.echo('x')
    await settle()
    expect(transport.last.sent[0]).toEqual({ type: 'start', version: 1, payload: { secret: 's3' } })
    const [call] = calls(transport.last)
    expect(call).toMatchObject({ op: 'echo', args: ['x'] })
    transport.last.reply({ type: 'result', id: call?.id ?? 0, ok: true, value: 'y' })
    await expect(answer).resolves.toBe('y')
    expect(host.state).toBe('running')
  })

  it('runs real handlers in process', async () => {
    const host = inProcessHost()
    await expect(host.ops.echo('world')).resolves.toBe('hello world')
    await expect(host.call('echo', ['again'])).resolves.toBe('hello again')
    await host.close()
  })

  it('keeps a well-formed application code and rebuilds supervisor codes as HostError', async () => {
    const host = inProcessHost()
    const coded = await rejection(host.ops.fail('DB_LOCKED'))
    expect(coded).not.toBeInstanceOf(HostError)
    expect(coded).toMatchObject({ message: 'failed with DB_LOCKED', code: 'DB_LOCKED' })
    const free = await rejection(host.ops.fail('not a code'))
    expect(free.code).toBeUndefined()
    const forged = await rejection(host.ops.fail('HOST_FATAL'))
    expect(forged).not.toBeInstanceOf(HostError)
    await host.close()
  })

  it('refuses an operation outside the closed list on both sides', async () => {
    const host = inProcessHost()
    const local = await rejection(host.call('nope' as 'echo', ['x']))
    expect(local).toBeInstanceOf(HostError)
    expect(local.code).toBe('HOST_OPERATION_REJECTED')

    const transport = fakeTransport()
    const remote = createHost<Ops>({ operations: OPERATIONS, transport })
    const answer = remote.ops.echo('x')
    await settle()
    const id = calls(transport.last)[0]?.id ?? 0
    transport.last.reply({
      type: 'result',
      id,
      ok: false,
      error: { name: 'HostError', message: 'no', code: 'HOST_OPERATION_REJECTED' },
    })
    const error = await rejection(answer)
    expect(error).toBeInstanceOf(HostError)
    expect(error.code).toBe('HOST_OPERATION_REJECTED')
    await host.close()
  })

  it('times out a call and cancels it in the host', async () => {
    const log: string[] = []
    const host = createHost<Ops, { greeting: string }>({
      operations: OPERATIONS,
      transport: served(log),
      start: { payload: () => ({ greeting: 'hi' }) },
      limits: { callTimeoutMs: 20 },
    })
    const error = await rejection(host.ops.hang())
    expect(error.code).toBe('HOST_CALL_TIMEOUT')
    await settle()
    expect(log).toContain('aborted')
    await expect(host.call('slow', [1], { timeoutMs: 1_000 })).resolves.toBe('done')
    await host.close()
  })

  it('aborts a call through its signal and never launches for one already aborted', async () => {
    const log: string[] = []
    const host = inProcessHost(log)
    const controller = new AbortController()
    const answer = host.call('hang', [], { signal: controller.signal })
    await settle()
    controller.abort(new Error('user left'))
    const error = await rejection(answer)
    expect(error.code).toBe('HOST_CALL_ABORTED')
    expect((error.cause as Error).message).toBe('user left')
    await settle()
    expect(log).toContain('aborted')

    const transport = fakeTransport()
    const idle = createHost<Ops>({ operations: OPERATIONS, transport })
    const early = await rejection(idle.call('echo', ['x'], { signal: AbortSignal.abort() }))
    expect(early.code).toBe('HOST_CALL_ABORTED')
    expect(transport.channels).toHaveLength(0)
    await host.close()
  })

  it('rejects past maxPending and admits again once a call settles', async () => {
    const host = inProcessHost([], { maxPending: 2 })
    const first = host.ops.slow(30)
    const second = host.ops.slow(30)
    const third = await rejection(host.ops.echo('x'))
    expect(third.code).toBe('HOST_QUEUE_FULL')
    await expect(Promise.all([first, second])).resolves.toEqual(['done', 'done'])
    await expect(host.ops.echo('x')).resolves.toBe('hello x')
    await host.close()
  })
})

describe('createHost start', () => {
  it('rejects waiting calls when the start fails, and tries again on the next call', async () => {
    let attempts = 0
    const host = createHost<Ops>({
      operations: OPERATIONS,
      transport: inProcessTransport<Ops>({
        operations: OPERATIONS,
        start: () => {
          attempts++
          if (attempts === 1)
            throw Object.assign(new Error('key missing'), { code: 'DB_KEY_MISSING' })
          return {
            echo: (value: string) => value,
            fail: () => Promise.reject(new Error('x')),
            slow: () => 'done',
            hang: () => 'done',
            count: () => [],
          }
        },
      }),
    })
    const error = await rejection(host.ops.echo('a'))
    expect(error.code).toBe('HOST_START_FAILED')
    expect(error.cause).toMatchObject({ message: 'key missing', code: 'DB_KEY_MISSING' })
    expect(host.state).toBe('idle')
    await expect(host.ops.echo('b')).resolves.toBe('b')
    await host.close()
  })

  it('refuses a host that speaks another protocol version', async () => {
    const transport = fakeTransport({ autoStart: false })
    const host = createHost<Ops>({ operations: OPERATIONS, transport })
    const started = host.start()
    await settle()
    transport.last.reply({
      type: 'start-failed',
      error: { name: 'Error', message: 'The host speaks protocol 2, not 1' },
    })
    const error = await rejection(started)
    expect(error.code).toBe('HOST_START_FAILED')
    expect(transport.last.killed).toBe(true)
  })

  it('fails a start that never answers within start.timeoutMs', async () => {
    const transport = fakeTransport({ autoStart: false })
    const host = createHost<Ops>({ operations: OPERATIONS, transport, start: { timeoutMs: 20 } })
    const error = await rejection(host.start())
    expect(error.code).toBe('HOST_START_FAILED')
    expect(transport.last.killed).toBe(true)
  })
})

describe('createHost exits', () => {
  it('rejects pending calls when the host dies, reports the exit, and stays fatal by default', async () => {
    const transport = fakeTransport()
    const exits: HostExit[] = []
    const host = createHost<Ops>({
      operations: OPERATIONS,
      transport,
      onExit: (exit) => {
        exits.push(exit)
        return 'fatal'
      },
    })
    const first = host.ops.echo('a')
    const second = host.ops.echo('b')
    await settle()
    transport.last.reply({
      type: 'crashed',
      error: { name: 'Error', message: 'boom', code: 'SQLITE_CORRUPT' },
    })
    transport.last.exit({ code: 1 })
    for (const answer of [first, second]) {
      const error = await rejection(answer)
      expect(error.code).toBe('HOST_EXITED')
      expect(error.cause).toMatchObject({ message: 'boom', code: 'SQLITE_CORRUPT' })
    }
    await settle()
    expect(exits).toEqual([
      expect.objectContaining({
        kind: 'crash',
        code: 1,
        pendingCalls: 2,
        uptimeMs: expect.any(Number),
      }),
    ])
    expect(host.state).toBe('fatal')
    const later = await rejection(host.ops.echo('c'))
    expect(later.code).toBe('HOST_FATAL')
    expect(transport.channels).toHaveLength(1)
  })

  it('classifies an out-of-memory exit', async () => {
    const transport = fakeTransport()
    const onExit = vi.fn(() => 'on-demand' as const)
    const host = createHost<Ops>({ operations: OPERATIONS, transport, onExit })
    await host.start()
    transport.last.exit({ code: 1, outOfMemory: true, error: new Error('heap') })
    await settle()
    expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'out-of-memory' }))
  })

  it('starts a new host on the next call after an on-demand exit', async () => {
    const transport = fakeTransport()
    const host = createHost<Ops>({
      operations: OPERATIONS,
      transport,
      onExit: () => 'on-demand',
    })
    await host.start()
    transport.last.exit({ code: 1 })
    await settle()
    expect(host.state).toBe('idle')
    expect(transport.channels).toHaveLength(1)
    const answer = host.ops.echo('x')
    await settle()
    expect(transport.channels).toHaveLength(2)
    transport.last.reply({
      type: 'result',
      id: calls(transport.last)[0]?.id ?? 0,
      ok: true,
      value: 'x',
    })
    await expect(answer).resolves.toBe('x')
  })

  it('restarts with backoff, queues calls meanwhile, and goes fatal past the budget', async () => {
    const transport = fakeTransport()
    const decisions: string[] = []
    const policy = restartPolicy({ maxRestarts: 2, backoffMs: [10, 20] })
    const host = createHost<Ops>({
      operations: OPERATIONS,
      transport,
      onExit: (exit) => {
        const decision = policy(exit)
        decisions.push(typeof decision === 'string' ? decision : `restart ${decision.delayMs}`)
        return decision
      },
    })
    await host.start()

    transport.last.exit({ code: 1 })
    await settle()
    expect(host.state).toBe('restarting')
    const queued = host.ops.echo('q')
    await settle(30)
    expect(transport.channels).toHaveLength(2)
    expect(host.state).toBe('running')
    transport.last.reply({
      type: 'result',
      id: calls(transport.last)[0]?.id ?? 0,
      ok: true,
      value: 'q',
    })
    await expect(queued).resolves.toBe('q')

    transport.last.exit({ code: 1 })
    await settle(40)
    expect(transport.channels).toHaveLength(3)

    transport.last.exit({ code: 1 })
    await settle()
    expect(decisions).toEqual(['restart 10', 'restart 20', 'fatal'])
    expect(host.state).toBe('fatal')
  })

  it('treats a failed restart as another exit for the policy', async () => {
    let launches = 0
    const transport = fakeTransport()
    const failing = {
      launch() {
        launches++
        const channel = transport.launch()
        if (launches === 2) {
          const send = channel.send.bind(channel)
          channel.send = (message) => {
            if (message.type === 'start') {
              channel.reply({ type: 'start-failed', error: { name: 'Error', message: 'locked' } })
              return
            }
            send(message)
          }
        }
        return channel
      },
    }
    const kinds: string[] = []
    const host = createHost<Ops>({
      operations: OPERATIONS,
      transport: failing,
      onExit: (exit) => {
        kinds.push(exit.kind)
        return 'restart'
      },
    })
    await host.start()
    transport.last.exit({ code: 1 })
    await settle(10)
    expect(kinds).toEqual(['crash', 'start-failed'])
    expect(launches).toBe(3)
    expect(host.state).toBe('running')
    await host.close()
  })

  it('treats a throwing onExit as fatal', async () => {
    const transport = fakeTransport()
    const host = createHost<Ops>({
      operations: OPERATIONS,
      transport,
      onExit: () => {
        throw new Error('policy bug')
      },
    })
    await host.start()
    transport.last.exit()
    await settle()
    expect(host.state).toBe('fatal')
  })
})

describe('createHost stop', () => {
  it('drains accepted calls, refuses new ones, then runs the host stop', async () => {
    const log: string[] = []
    const host = inProcessHost(log)
    const inFlight = host.ops.slow(30)
    await settle()
    const stopping = host.stop()
    const refused = await rejection(host.ops.echo('late'))
    expect(refused.code).toBe('HOST_STOPPED')
    await expect(inFlight).resolves.toBe('done')
    await stopping
    expect(log).toEqual(['stopped'])
    expect(host.state).toBe('idle')
    await expect(host.ops.echo('again')).resolves.toBe('hello again')
    await host.close()
  })

  it('shares one stop between concurrent callers', async () => {
    const transport = fakeTransport()
    const host = createHost<Ops>({ operations: OPERATIONS, transport })
    await host.start()
    await Promise.all([host.stop(), host.stop(), host.close()])
    expect(transport.last.sent.filter((message) => message.type === 'stop')).toHaveLength(1)
    expect(host.state).toBe('closed')
    await host.close()
    const error = await rejection(host.ops.echo('x'))
    expect(error.code).toBe('HOST_STOPPED')
  })

  it('terminates a host that does not stop within the grace period', async () => {
    const transport = fakeTransport({ autoStop: false })
    const host = createHost<Ops>({ operations: OPERATIONS, transport, stop: { graceMs: 20 } })
    const answer = host.ops.echo('x')
    await settle()
    const error = await rejection(host.stop())
    expect(error.code).toBe('HOST_STOP_TIMEOUT')
    expect(transport.last.killed).toBe(true)
    expect((await rejection(answer)).code).toBe('HOST_STOPPED')
  })

  it('reports a stop that ended without the host confirming it', async () => {
    const transport = fakeTransport({ autoStop: false })
    const host = createHost<Ops>({ operations: OPERATIONS, transport })
    await host.start()
    const stopping = host.stop()
    await settle()
    transport.last.exit({ code: 0 })
    expect((await rejection(stopping)).code).toBe('HOST_STOP_INCOMPLETE')

    await host.start()
    const failing = host.stop()
    await settle()
    transport.last.reply({
      type: 'stopped',
      error: { name: 'Error', message: 'checkpoint failed' },
    })
    transport.last.exit({ code: 0 })
    const error = await rejection(failing)
    expect(error.code).toBe('HOST_STOP_INCOMPLETE')
    expect((error.cause as Error).message).toBe('checkpoint failed')
  })

  it('waits for a killed host to exit before launching the next one', async () => {
    const transport = fakeTransport({ exitOnKill: false })
    const host = createHost<Ops>({
      operations: OPERATIONS,
      transport,
      stop: { retireWaitMs: 1_000 },
    })
    await host.start()
    const pending = host.ops.echo('lost')
    await settle()
    const killing = host.kill()
    expect((await rejection(pending)).code).toBe('HOST_STOPPED')
    const next = host.ops.echo('next')
    await settle(20)
    expect(transport.channels).toHaveLength(1)
    transport.channels[0]?.exit({ code: null })
    await killing
    await settle()
    expect(transport.channels).toHaveLength(2)
    transport.last.reply({
      type: 'result',
      id: calls(transport.last)[0]?.id ?? 0,
      ok: true,
      value: 'n',
    })
    await expect(next).resolves.toBe('n')
  })

  it('launches anyway once retireWaitMs passes without an exit', async () => {
    const transport = fakeTransport({ exitOnKill: false })
    const host = createHost<Ops>({ operations: OPERATIONS, transport, stop: { retireWaitMs: 20 } })
    await host.start()
    await host.kill()
    await host.start()
    expect(transport.channels).toHaveLength(2)
  })
})

describe('createHost streams', () => {
  it('pulls one item per request and closes the producer on an early return', async () => {
    const log: string[] = []
    const host = inProcessHost(log)
    const iterator = host.ops.count(5)[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ done: false, value: 1 })
    await settle()
    expect(log).toEqual(['produce 1'])
    expect(await iterator.next()).toEqual({ done: false, value: 2 })
    await iterator.return?.()
    await settle()
    expect(log).toEqual(['produce 1', 'produce 2', 'closed'])
    await host.close()
  })

  it('reads a whole stream with for await', async () => {
    const host = inProcessHost()
    const seen: number[] = []
    for await (const value of host.stream('count', [3])) seen.push(value)
    expect(seen).toEqual([1, 2, 3])
    await host.close()
  })

  it('reports a host exit between items on the next pull instead of ending quietly', async () => {
    const transport = fakeTransport()
    const host = createHost<Ops>({
      operations: [],
      streams: STREAMS,
      transport,
      onExit: () => 'on-demand',
    })
    const iterator = host.ops.count(3)[Symbol.asyncIterator]()
    const first = iterator.next()
    await settle()
    const id = calls(transport.last)[0]?.id ?? 0
    transport.last.reply({ type: 'item', id, done: false, value: 1 })
    expect(await first).toEqual({ done: false, value: 1 })
    transport.last.exit({ code: 1 })
    await settle()
    expect((await rejection(iterator.next())).code).toBe('HOST_EXITED')
  })

  it('aborts a stream through its signal', async () => {
    const log: string[] = []
    const host = inProcessHost(log)
    const controller = new AbortController()
    const iterator = host
      .stream('count', [5], { signal: controller.signal })
      [Symbol.asyncIterator]()
    await iterator.next()
    controller.abort()
    expect((await rejection(iterator.next())).code).toBe('HOST_CALL_ABORTED')
    await settle()
    expect(log).toContain('closed')
    await host.close()
  })
})

describe('policies', () => {
  it('slides the restart window and honours isFatal', () => {
    let clock = 0
    const policy = restartPolicy({
      maxRestarts: 2,
      windowMs: 100,
      backoffMs: [1, 2],
      now: () => clock,
      isFatal: (exit) => (exit.error as { code?: string }).code === 'SQLITE_CORRUPT',
    })
    const exit = (code?: string): HostExit => ({
      kind: 'crash',
      error: Object.assign(new Error('x'), code ? { code } : {}),
      code: 1,
      uptimeMs: 1,
      pendingCalls: 0,
      lastStats: null,
    })
    expect(policy(exit())).toEqual({ action: 'restart', delayMs: 1 })
    expect(policy(exit())).toEqual({ action: 'restart', delayMs: 2 })
    expect(policy(exit())).toBe('fatal')
    clock = 150
    expect(policy(exit())).toEqual({ action: 'restart', delayMs: 1 })
    expect(policy(exit('SQLITE_CORRUPT'))).toBe('fatal')
  })

  it('alerts once per excursion over the RSS limit', () => {
    const alerts: number[] = []
    const watch = memoryWatch({ rssMb: 100, onAlert: (stats) => alerts.push(stats.rssMb) })
    const sample = (rssMb: number) =>
      watch({ rssMb, heapUsedMb: 1, heapLimitMb: 1, externalMb: 0, eventLoopUtilization: 0 })
    for (const value of [150, 90, 150, 160, 170, 50, 120, 130]) sample(value)
    expect(alerts).toEqual([160, 130])
  })

  it('forwards host stats to onStats', async () => {
    const seen: number[] = []
    const host = createHost<Ops, { greeting: string }>({
      operations: OPERATIONS,
      transport: inProcessTransport<Ops, { greeting: string }>({
        operations: OPERATIONS,
        statsIntervalMs: 60_000,
        start: () => ({
          echo: (value: string) => value,
          fail: () => Promise.reject(new Error('x')),
          slow: () => 'done',
          hang: () => 'done',
          count: () => [],
        }),
      }),
      start: { payload: () => ({ greeting: 'x' }) },
      onStats: (stats) => seen.push(stats.rssMb),
    })
    await host.start()
    await settle()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeGreaterThan(0)
    await host.close()
  })
})
