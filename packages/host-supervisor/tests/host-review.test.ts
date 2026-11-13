import { describe, expect, it } from 'vitest'

import { createHost, inProcessTransport, type Contract } from '../src/index.js'
import { calls, fakeTransport, settle } from './fake-transport.js'

interface Ops {
  echo(value: string): Promise<string>
  items(): AsyncIterable<unknown>
}

const OPERATIONS = ['echo'] as const
const STREAMS = ['items'] as const

async function rejection(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected a rejection')
}

function answer(transport: ReturnType<typeof fakeTransport>, value: unknown): void {
  const call = calls(transport.last).at(-1)
  transport.last.reply({ type: 'result', id: call?.id ?? 0, ok: true, value })
}

describe('createHost lifecycle edges', () => {
  it('stops during a restart backoff without waiting it out, and serves again afterwards', async () => {
    const transport = fakeTransport()
    const host = createHost<Ops>({
      operations: OPERATIONS,
      transport,
      onExit: () => ({ action: 'restart', delayMs: 10_000 }),
    })
    await host.start()
    transport.last.exit()
    await settle()
    expect(host.state).toBe('restarting')
    const started = Date.now()
    await host.stop()
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(host.state).toBe('idle')
    const next = host.ops.echo('x')
    await settle()
    expect(transport.channels).toHaveLength(2)
    answer(transport, 'x')
    await expect(next).resolves.toBe('x')
  })

  it('never lets a call slip in between a stop and the close that joined it', async () => {
    const transport = fakeTransport()
    const host = createHost<Ops>({ operations: OPERATIONS, transport })
    await host.start()
    const late = host.stop().then(() => host.ops.echo('late'))
    await host.close()
    expect((await rejection(late)).code).toBe('HOST_STOPPED')
    expect(transport.channels).toHaveLength(1)
    expect(host.state).toBe('closed')
  })

  it('retires a host that confirmed its stop but does not exit, without an error', async () => {
    const transport = fakeTransport({ autoStop: false })
    const host = createHost<Ops>({ operations: OPERATIONS, transport, stop: { retireWaitMs: 20 } })
    await host.start()
    const stopping = host.stop()
    await settle()
    transport.last.reply({ type: 'stopped' })
    await expect(stopping).resolves.toBeUndefined()
    expect(transport.last.killed).toBe(true)
  })

  it('cuts a stop short with kill', async () => {
    const transport = fakeTransport({ autoStop: false })
    const host = createHost<Ops>({ operations: OPERATIONS, transport, stop: { graceMs: 60_000 } })
    await host.start()
    const stopping = host.stop()
    await settle()
    await host.kill()
    expect((await rejection(stopping)).code).toBe('HOST_STOP_INCOMPLETE')
    expect(host.state).toBe('idle')
  })

  it('treats an exit right after started as a failed start', async () => {
    const transport = fakeTransport({ autoStart: false })
    const host = createHost<Ops>({ operations: OPERATIONS, transport })
    const starting = host.start()
    await settle()
    transport.last.reply({ type: 'started' })
    transport.last.exit({ code: 1 })
    expect((await rejection(starting)).code).toBe('HOST_START_FAILED')
    expect(host.state).toBe('idle')
  })

  it('reads a malformed onExit decision as fatal', async () => {
    const transport = fakeTransport()
    const host = createHost<Ops>({
      operations: OPERATIONS,
      transport,
      onExit: () => 'later' as unknown as 'fatal',
    })
    await host.start()
    transport.last.exit()
    await settle()
    expect(host.state).toBe('fatal')
  })
})

describe('createHost stream edges', () => {
  it('settles a pending pull as done when the stream is closed early', async () => {
    const transport = fakeTransport()
    const host = createHost<Ops>({ operations: [], streams: STREAMS, transport })
    const iterator = host.ops.items()[Symbol.asyncIterator]()
    const pull = iterator.next()
    await settle()
    await iterator.return?.()
    await expect(pull).resolves.toEqual({ done: true, value: undefined })
  })

  it('fails a stream whose item cannot be cloned and frees the producer', async () => {
    const log: string[] = []
    const host = createHost<Ops>({
      operations: OPERATIONS,
      streams: STREAMS,
      transport: inProcessTransport<Ops>({
        operations: OPERATIONS,
        streams: STREAMS,
        start: () => ({
          echo: (value: string) => value,
          async *items() {
            try {
              yield () => 'not cloneable'
              yield 'never'
            } finally {
              log.push('closed')
            }
          },
        }),
      }),
    })
    const iterator = host.ops.items()[Symbol.asyncIterator]()
    expect((await rejection(iterator.next())).name).toBe('DataCloneError')
    await settle()
    expect(log).toEqual(['closed'])
    await host.close()
  })
})

describe('Contract', () => {
  it('rejects optional parameters and non-operation members at compile time', () => {
    interface Optional {
      list(limit?: number): Promise<number>
    }
    interface Sync {
      now(): number
    }
    // @ts-expect-error The context would land in the optional slot.
    const optional: Contract<Optional> = {} as Optional
    // @ts-expect-error Operations return a promise or an async iterable.
    const sync: Contract<Sync> = {} as Sync
    expect([optional, sync]).toHaveLength(2)
  })
})
