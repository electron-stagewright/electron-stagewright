/**
 * Integration with real worker threads: the host entry is TypeScript, loaded through tsx.
 */

import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createHost,
  restartPolicy,
  type ChannelExit,
  type Host,
  type HostExit,
  type HostStats,
} from '../src/index.js'
import { workerThreadTransport, type WorkerLike } from '../src/worker.js'
import { rejection } from './fake-transport.js'
import { TEST_OPERATIONS, TEST_STREAMS, type TestOps } from './fixtures/test-ops.js'

const ENTRY = fileURLToPath(new URL('./fixtures/worker-host.ts', import.meta.url))

const hosts: Array<Host<TestOps>> = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.kill()))
})

function workerHost(
  extra: {
    onExit?: (exit: HostExit) => ReturnType<ReturnType<typeof restartPolicy>>
    maxOldGenerationSizeMb?: number
    graceMs?: number
    onStats?: (stats: HostStats) => void
  } = {},
): Host<TestOps> {
  const host = createHost<TestOps, { greeting: string }>({
    operations: TEST_OPERATIONS,
    streams: TEST_STREAMS,
    transport: workerThreadTransport({
      entry: ENTRY,
      execArgv: ['--import', 'tsx'],
      ...(extra.maxOldGenerationSizeMb
        ? { resourceLimits: { maxOldGenerationSizeMb: extra.maxOldGenerationSizeMb } }
        : {}),
    }),
    start: { payload: () => ({ greeting: 'hello' }), timeoutMs: 20_000 },
    ...(extra.graceMs === undefined ? {} : { stop: { graceMs: extra.graceMs } }),
    ...(extra.onExit ? { onExit: extra.onExit } : {}),
    ...(extra.onStats ? { onStats: extra.onStats } : {}),
  })
  hosts.push(host)
  return host
}

describe('workerThreadTransport', { timeout: 30_000 }, () => {
  it('answers calls and streams from a real worker', async () => {
    const host = workerHost()
    await expect(host.ops.echo('worker')).resolves.toBe('hello worker')
    const seen: number[] = []
    for await (const value of host.ops.count(3)) seen.push(value)
    expect(seen).toEqual([1, 2, 3])
    await host.close()
    expect(host.state).toBe('closed')
  })

  it('fails the call in flight when the worker crashes, then restarts it', async () => {
    const exits: HostExit[] = []
    const policy = restartPolicy({ backoffMs: [0] })
    const host = workerHost({
      onExit: (exit) => {
        exits.push(exit)
        return policy(exit)
      },
    })
    await host.start()
    const error = await rejection(host.ops.crash())
    expect(error.code).toBe('HOST_EXITED')
    expect(error.cause).toMatchObject({ message: 'native state lost', code: 'TEST_CRASH' })
    await expect(host.ops.echo('again')).resolves.toBe('hello again')
    expect(exits).toEqual([expect.objectContaining({ kind: 'crash', pendingCalls: 1 })])
    await host.close()
  })

  it('reports a heap-limit exit as out-of-memory', async () => {
    const exits: HostExit[] = []
    const host = workerHost({
      maxOldGenerationSizeMb: 32,
      onExit: (exit) => {
        exits.push(exit)
        return 'on-demand'
      },
    })
    const error = await rejection(host.ops.exhaustHeap())
    expect(error.code).toBe('HOST_EXITED')
    expect(exits[0]?.kind).toBe('out-of-memory')
    await expect(host.ops.echo('after')).resolves.toBe('hello after')
  })

  it('drains a slow call on stop and lets the worker exit', async () => {
    const host = workerHost()
    await host.start()
    const slow = host.ops.slow(200)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await host.stop()
    await expect(slow).resolves.toBe('done')
    expect(host.state).toBe('idle')
  })

  it('terminates a worker that is still busy past the grace period', async () => {
    const host = workerHost({ graceMs: 100 })
    await host.start()
    const busy = rejection(host.ops.block(2_000))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const error = await rejection(host.stop())
    expect(error.code).toBe('HOST_STOP_TIMEOUT')
    expect((await busy).code).toBe('HOST_STOPPED')
  })

  it('reports the worker heap cap as heapLimitMb', async () => {
    const seen: HostStats[] = []
    const host = workerHost({ maxOldGenerationSizeMb: 48, onStats: (stats) => seen.push(stats) })
    await host.start()
    await vi.waitFor(() => expect(seen[0]?.heapLimitMb).toBe(48))
    await host.close()
  })

  it('aborts a call inside the worker', async () => {
    const host = workerHost()
    await host.start()
    const error = await rejection(host.call('hang', [], { timeoutMs: 100 }))
    expect(error.code).toBe('HOST_CALL_TIMEOUT')
    await vi.waitFor(async () => expect(await host.ops.aborted()).toBe(1))
    await host.close()
  })
})

describe('workerThreadTransport exits', () => {
  function worker() {
    const listeners: Record<string, (value: never) => void> = {}
    const fake: WorkerLike = {
      postMessage: () => undefined,
      on: (event: string, listener: (value: never) => void) => (listeners[event] = listener),
      terminate: () => Promise.resolve(1),
    }
    const channel = workerThreadTransport({ entry: 'host.js', createWorker: () => fake }).launch()
    let exit: ChannelExit | null = null
    channel.onExit((value) => (exit = value))
    return {
      error: (thrown: unknown) => listeners['error']?.(thrown as never),
      exit: () => {
        listeners['exit']?.(1 as never)
        return exit as ChannelExit | null
      },
    }
  }

  function crashed(thrown: unknown) {
    const fake = worker()
    fake.error(thrown)
    return fake.exit()
  }

  it('maps the heap-limit error to out-of-memory', () => {
    const oom = Object.assign(new Error('heap'), { code: 'ERR_WORKER_OUT_OF_MEMORY' })
    expect(crashed(oom)).toEqual({ code: 1, error: oom, outOfMemory: true })
  })

  it.each([['boom'], [null], [0], [{ code: 'ERR_WORKER_OUT_OF_MEMORY' }]])(
    'turns a thrown %j into an Error',
    (thrown) => {
      const exit = crashed(thrown)
      expect(exit?.error).toBeInstanceOf(Error)
      expect(exit?.outOfMemory).toBe(false)
    },
  )

  it('does not blame the host for an inner worker that ran out of memory', async () => {
    const fake = worker()
    fake.error(Object.assign(new Error('inner heap'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }))
    await Promise.resolve()
    expect(fake.exit()?.outOfMemory).toBe(false)
  })
})
