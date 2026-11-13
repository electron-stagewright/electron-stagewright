/**
 * Integration with real worker threads: the host entry is TypeScript, loaded through tsx.
 */

import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { createHost, restartPolicy, type Host, type HostExit } from '../src/index.js'
import { workerThreadTransport } from '../src/worker.js'
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
  })
  hosts.push(host)
  return host
}

async function rejection(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected a rejection')
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
    const busy = host.ops.block(2_000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const error = await rejection(host.stop())
    expect(error.code).toBe('HOST_STOP_TIMEOUT')
    expect((await rejection(busy)).code).toBe('HOST_STOPPED')
  })

  it('aborts a call inside the worker', async () => {
    const host = workerHost()
    const error = await rejection(host.call('hang', [], { timeoutMs: 100 }))
    expect(error.code).toBe('HOST_CALL_TIMEOUT')
    await host.close()
  })
})
