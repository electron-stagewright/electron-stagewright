/**
 * Library-level lifecycle: an embedder using createServer() + connectStdio() gets the same
 * host-exit cleanup as the CLI, and a transparent session reconnect drops stored snapshots.
 */

import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { NOOP_LOGGER } from '../src/server/logger.js'
import { createServer } from '../src/server/server.js'
import type { Snapshot } from '../src/snapshot/index.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'

async function serverWithSession(session = new FakeSession({ id: 'sess-1' })) {
  const transport = new FakeTransport()
  const server = await createServer({ logger: NOOP_LOGGER })
  server.sessions.register(transport, session)
  return { server, transport, session }
}

describe('StagewrightServer.connectStdio', () => {
  it.each(['end', 'close'] as const)(
    'closes the server and disposes sessions when stdin emits %s',
    async (event) => {
      const { server, transport } = await serverWithSession()
      const stdin = new PassThrough()
      await server.connectStdio({ stdin, stdout: new PassThrough() })

      if (event === 'end') stdin.end()
      else stdin.destroy()
      stdin.resume()

      await expect(server.closed).resolves.toBeUndefined()
      expect(server.sessions.size).toBe(0)
      expect(transport.stopCount).toBe(1)
    },
  )

  it('shares one teardown between an explicit close and a later stdin close', async () => {
    const { server, transport } = await serverWithSession()
    const stdin = new PassThrough()
    await server.connectStdio({ stdin, stdout: new PassThrough() })

    const first = server.close()
    expect(server.close()).toBe(first)
    await first
    stdin.end()
    stdin.resume()
    await server.closed
    expect(transport.stopCount).toBe(1)
  })
})

describe('session reconnect', () => {
  it('clears the stored snapshots of a session that reconnected', async () => {
    let reconnected: (() => void) | undefined
    const session = Object.assign(new FakeSession({ id: 'sess-r' }), {
      onReconnect: (listener: () => void) => {
        reconnected = listener
        return () => {}
      },
    })
    const { server } = await serverWithSession(session)
    server.snapshots.set('sess-r', {} as Snapshot)

    reconnected?.()

    expect(server.snapshots.get('sess-r')).toBeUndefined()
    await server.close()
  })

  it('ignores a reconnect from a session that is no longer registered', async () => {
    let reconnected: (() => void) | undefined
    const session = Object.assign(new FakeSession({ id: 'sess-gone' }), {
      onReconnect: (listener: () => void) => {
        reconnected = listener
        return () => {}
      },
    })
    const { server } = await serverWithSession(session)
    await server.sessions.remove('sess-gone')
    const seen: string[] = []
    server.sessions.onSessionReconnect((id) => seen.push(id))

    reconnected?.()

    expect(seen).toEqual([])
    await server.close()
  })
})
