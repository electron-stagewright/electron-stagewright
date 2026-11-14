import { describe, expect, it } from 'vitest'

import {
  createHost,
  deserializeError,
  inProcessTransport,
  serializeError,
  type HostExit,
} from '../src/index.js'
import { calls, fakeTransport, rejection, settle } from './fake-transport.js'

interface Ops {
  fail(kind: string): Promise<never>
}

class EditError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly data: { step: string; fix?: string },
  ) {
    super(message)
    this.name = 'EditError'
  }
}

function failing() {
  return inProcessTransport<Ops>({
    operations: ['fail'],
    errors: {
      codePattern: /^[a-z][a-z-]{1,40}$/,
      data: (error) => (error instanceof EditError ? error.data : undefined),
    },
    start: () => ({
      fail: (kind: string) => {
        if (kind === 'edit') throw new EditError('edit failed', 'engine-gone', { step: 'apply' })
        if (kind === 'uncloneable') {
          throw new EditError('edit failed', 'engine-gone', {
            step: 'apply',
            fix: (() => 'no') as unknown as string,
          })
        }
        throw Object.assign(new Error('plain'), {
          code: kind === 'upper' ? 'UPPER_CASE' : 'Not a code',
        })
      },
    }),
  })
}

describe('structured errors', () => {
  it('carries a configured code and the picked detail across', async () => {
    const host = createHost<Ops>({ operations: ['fail'], transport: failing() })
    const error = await rejection(host.ops.fail('edit'))
    expect(error).toMatchObject({
      name: 'EditError',
      message: 'edit failed',
      code: 'engine-gone',
      data: { step: 'apply' },
    })
    await host.close()
  })

  it('keeps matching codes with a global codePattern', async () => {
    const host = createHost<Ops>({
      operations: ['fail'],
      transport: inProcessTransport<Ops>({
        operations: ['fail'],
        errors: { codePattern: /^[a-z][a-z-]{1,40}$/g },
        start: () => ({
          fail: () => {
            throw Object.assign(new Error('gone'), { code: 'engine-gone' })
          },
        }),
      }),
    })
    for (let i = 0; i < 3; i++) {
      expect((await rejection(host.ops.fail('edit'))).code).toBe('engine-gone')
    }
    await host.close()
  })

  it('keeps the default codes next to the configured pattern', async () => {
    const host = createHost<Ops>({ operations: ['fail'], transport: failing() })
    expect((await rejection(host.ops.fail('upper'))).code).toBe('UPPER_CASE')
    await host.close()
  })

  it('drops a code outside both patterns', async () => {
    const host = createHost<Ops>({ operations: ['fail'], transport: failing() })
    const error = await rejection(host.ops.fail('other'))
    expect(error.code).toBeUndefined()
    await host.close()
  })

  it('still answers when the detail cannot be cloned, without the detail', async () => {
    const host = createHost<Ops>({ operations: ['fail'], transport: failing() })
    const error = await rejection(host.ops.fail('uncloneable'))
    expect(error).toMatchObject({ message: 'edit failed', code: 'engine-gone' })
    expect((error as { data?: unknown }).data).toBeUndefined()
    await host.close()
  })

  it('rebuilds the app error class through errors.revive', async () => {
    const host = createHost<Ops>({
      operations: ['fail'],
      transport: failing(),
      errors: {
        revive: (serialized) =>
          serialized.name === 'EditError'
            ? new EditError(
                serialized.message,
                serialized.code ?? '',
                serialized.data as EditError['data'],
              )
            : undefined,
      },
    })
    const error = await rejection(host.ops.fail('edit'))
    expect(error).toBeInstanceOf(EditError)
    expect((error as EditError).data).toEqual({ step: 'apply' })
    await host.close()
  })

  it('never lets a reviver turn a supervisor failure into an app error', async () => {
    const transport = fakeTransport()
    const host = createHost<Ops>({
      operations: ['fail'],
      transport,
      errors: { revive: () => new Error('revived') },
    })
    const answer = host.ops.fail('x')
    await settle()
    const [call] = calls(transport.last)
    if (!call) throw new Error('no call was sent')
    transport.last.reply({
      type: 'result',
      id: call.id,
      ok: false,
      error: { name: 'HostError', message: 'not serving', code: 'HOST_STOPPED' },
    })
    expect(await rejection(answer)).toMatchObject({ name: 'HostError', code: 'HOST_STOPPED' })
    await host.close()
  })

  it('keeps the default behaviour without options', () => {
    const error = Object.assign(new Error('x'), { code: 'lower', data: { secret: 1 } })
    expect(serializeError(error)).toEqual({ name: 'Error', message: 'x' })
    expect(serializeError(error, { data: () => ({ ok: true }) })).toEqual({
      name: 'Error',
      message: 'x',
      data: { ok: true },
    })
    expect(
      serializeError(error, {
        data: () => {
          throw new Error('picker bug')
        },
      }),
    ).toEqual({ name: 'Error', message: 'x' })
    expect(deserializeError({ name: 'E', message: 'm', data: [1] })).toMatchObject({ data: [1] })
  })
})

interface ServerOps {
  ping(): Promise<string>
}

describe('host info', () => {
  it('exposes what the host passed to setInfo, from start and while running', async () => {
    let port = 4100
    const host = createHost<ServerOps, undefined, { url: string }>({
      operations: ['ping'],
      transport: inProcessTransport<ServerOps, undefined, { url: string }>({
        operations: ['ping'],
        start: (_payload, { setInfo }) => {
          setInfo({ url: `http://127.0.0.1:${port++}` })
          return { ping: () => 'pong' }
        },
      }),
    })
    expect(host.info).toBeUndefined()
    expect(await host.start()).toEqual({ url: 'http://127.0.0.1:4100' })
    expect(host.info).toEqual({ url: 'http://127.0.0.1:4100' })
    await host.stop()
    expect(host.info).toBeUndefined()
    await host.ops.ping()
    expect(host.info).toEqual({ url: 'http://127.0.0.1:4101' })
    await host.close()
  })

  it('rejects setInfo after start resolves', async () => {
    let late: ((info: { url: string }) => void) | undefined
    const host = createHost<ServerOps, undefined, { url: string }>({
      operations: ['ping'],
      transport: inProcessTransport<ServerOps, undefined, { url: string }>({
        operations: ['ping'],
        start: (_payload, { setInfo }) => {
          late = setInfo
          return { ping: () => 'pong' }
        },
      }),
    })
    await host.start()
    expect(() => late?.({ url: 'http://late' })).toThrow('before start resolves')
    await host.close()
  })

  it('fails the start when the info cannot be cloned', async () => {
    const host = createHost<ServerOps, undefined, { url: string }>({
      operations: ['ping'],
      transport: inProcessTransport<ServerOps, undefined, { url: string }>({
        operations: ['ping'],
        start: (_payload, { setInfo }) => {
          setInfo({ url: (() => 'no') as unknown as string })
          return { ping: () => 'pong' }
        },
      }),
    })
    const error = await rejection(host.start())
    expect(String((error as { cause?: unknown }).cause ?? error)).toContain('setInfo received')
    await host.close()
  })

  it('is undefined when the host sets none', async () => {
    const host = createHost<ServerOps>({
      operations: ['ping'],
      transport: inProcessTransport<ServerOps>({
        operations: ['ping'],
        start: () => ({ ping: () => 'pong' }),
      }),
    })
    expect(await host.start()).toBeUndefined()
    await host.close()
  })
})

describe('exit reason', () => {
  async function exitWith(
    setup: (channel: ReturnType<typeof fakeTransport>['last']) => void,
  ): Promise<HostExit> {
    const transport = fakeTransport()
    const exits: HostExit[] = []
    const host = createHost<ServerOps>({
      operations: ['ping'],
      transport,
      onExit: (exit) => {
        exits.push(exit)
        return 'fatal'
      },
    })
    await host.start()
    setup(transport.last)
    await settle()
    const [exit] = exits
    if (!exit || exits.length !== 1) throw new Error(`expected one exit, saw ${exits.length}`)
    return exit
  }

  it('reports an uncaught exception the host announced', async () => {
    const exit = await exitWith((channel) => {
      channel.reply({ type: 'crashed', error: { name: 'Error', message: 'boom' } })
      channel.exit({ code: 1 })
    })
    expect(exit).toMatchObject({ kind: 'crash', reason: 'uncaught', error: { message: 'boom' } })
  })

  it('forgets an exception the host survived', async () => {
    const exit = await exitWith((channel) => {
      channel.reply({ type: 'crashed', error: { name: 'Error', message: 'handled' } })
      channel.reply({
        type: 'stats',
        stats: { rssMb: 1, heapUsedMb: 1, heapLimitMb: 1, externalMb: 0, eventLoopUtilization: 0 },
      })
      channel.exit({ code: 0 })
    })
    expect(exit.reason).toBe('exit')
    expect(exit.error.message).not.toBe('handled')
  })

  it('reports a worker error event as uncaught', async () => {
    const exit = await exitWith((channel) => channel.exit({ code: 1, error: new Error('thrown') }))
    expect(exit.reason).toBe('uncaught')
  })

  it('reports out-of-memory, runtime-fatal and a plain exit', async () => {
    expect(
      (await exitWith((c) => c.exit({ code: 1, error: new Error('heap'), outOfMemory: true })))
        .reason,
    ).toBe('out-of-memory')
    expect(
      (await exitWith((c) => c.exit({ code: 1, error: new Error('v8'), runtimeFatal: true })))
        .reason,
    ).toBe('runtime-fatal')
    const plain = await exitWith((c) => c.exit({ code: 3 }))
    expect(plain).toMatchObject({ kind: 'crash', reason: 'exit', code: 3 })
    expect(plain.error).toBeInstanceOf(Error)
  })

  it('reports a failed restart as start-failed', async () => {
    const transport = fakeTransport()
    const exits: HostExit[] = []
    const host = createHost<ServerOps>({
      operations: ['ping'],
      transport,
      onExit: (exit) => {
        exits.push(exit)
        return exits.length === 1 ? 'restart' : 'fatal'
      },
    })
    await host.start()
    const original = transport.launch
    transport.launch = () => {
      throw new Error('cannot spawn')
    }
    transport.last.exit({ code: 1 })
    await settle(5)
    transport.launch = original
    expect(exits.map((exit) => exit.reason)).toEqual(['exit', 'start-failed'])
    expect(host.state).toBe('fatal')
  })
})
