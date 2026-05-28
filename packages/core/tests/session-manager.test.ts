/**
 * Unit tests for {@link SessionManager}: identity, resolution rules, idempotent
 * teardown, and the empty-id guard.
 */

import { describe, expect, it } from 'vitest'

import { StagewrightError } from '../src/errors/registry.js'
import { SessionManager } from '../src/server/session-manager.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'

function setup() {
  const manager = new SessionManager()
  const transport = new FakeTransport()
  return { manager, transport }
}

describe('SessionManager registration and lookup', () => {
  it('keys a registered session by the transport-assigned id', () => {
    const { manager, transport } = setup()
    const session = new FakeSession({ id: 'sess-1' })
    const managed = manager.register(transport, session)
    expect(managed.id).toBe('sess-1')
    expect(manager.has('sess-1')).toBe(true)
    expect(manager.get('sess-1')?.session).toBe(session)
    expect(manager.size).toBe(1)
    expect(manager.list()).toHaveLength(1)
  })

  it('throws INTERNAL_ERROR when a transport returns an empty session id', () => {
    const { manager, transport } = setup()
    const session = new FakeSession({ id: '' })
    expect(() => manager.register(transport, session)).toThrowError(StagewrightError)
    try {
      manager.register(transport, new FakeSession({ id: '' }))
    } catch (err) {
      expect(err).toBeInstanceOf(StagewrightError)
      expect((err as StagewrightError).code).toBe('INTERNAL_ERROR')
    }
  })

  it('throws INTERNAL_ERROR instead of overwriting a duplicate session id', () => {
    const { manager, transport } = setup()
    manager.register(transport, new FakeSession({ id: 'dupe' }))

    expect(() => manager.register(transport, new FakeSession({ id: 'dupe' }))).toThrowError(
      StagewrightError,
    )
    try {
      manager.register(transport, new FakeSession({ id: 'dupe' }))
    } catch (err) {
      expect(err).toBeInstanceOf(StagewrightError)
      expect((err as StagewrightError).code).toBe('INTERNAL_ERROR')
      expect((err as StagewrightError).details).toMatchObject({ sessionId: 'dupe' })
    }

    expect(manager.size).toBe(1)
  })
})

describe('SessionManager.resolve', () => {
  it('throws NOT_RUNNING when no sessions are live', () => {
    const { manager } = setup()
    expect(() => manager.resolve()).toThrowError(StagewrightError)
    try {
      manager.resolve()
    } catch (err) {
      expect((err as StagewrightError).code).toBe('NOT_RUNNING')
    }
  })

  it('returns the only session when id is omitted', () => {
    const { manager, transport } = setup()
    const session = new FakeSession({ id: 'only' })
    manager.register(transport, session)
    expect(manager.resolve().id).toBe('only')
  })

  it('returns the named session when its id is given', () => {
    const { manager, transport } = setup()
    manager.register(transport, new FakeSession({ id: 'a' }))
    manager.register(transport, new FakeSession({ id: 'b' }))
    expect(manager.resolve('b').id).toBe('b')
  })

  it('throws NOT_RUNNING when the given id is not registered', () => {
    const { manager, transport } = setup()
    manager.register(transport, new FakeSession({ id: 'a' }))
    try {
      manager.resolve('missing')
    } catch (err) {
      expect((err as StagewrightError).code).toBe('NOT_RUNNING')
      expect((err as StagewrightError).details?.['available_sessions']).toEqual(['a'])
    }
  })

  it('throws BAD_ARGUMENT (ambiguous) when several are live and id is omitted', () => {
    const { manager, transport } = setup()
    manager.register(transport, new FakeSession({ id: 'a' }))
    manager.register(transport, new FakeSession({ id: 'b' }))
    try {
      manager.resolve()
    } catch (err) {
      expect((err as StagewrightError).code).toBe('BAD_ARGUMENT')
      expect((err as StagewrightError).details?.['available_sessions']).toEqual(['a', 'b'])
    }
  })
})

describe('SessionManager teardown', () => {
  it('remove stops the session through its transport and forgets it', async () => {
    const { manager, transport } = setup()
    const session = new FakeSession({ id: 'x' })
    manager.register(transport, session)
    await manager.remove('x')
    expect(transport.stopCount).toBe(1)
    expect(session.disposeCount).toBe(1)
    expect(manager.has('x')).toBe(false)
  })

  it('remove is idempotent — a second call is a no-op', async () => {
    const { manager, transport } = setup()
    const session = new FakeSession({ id: 'x' })
    manager.register(transport, session)
    await manager.remove('x')
    await manager.remove('x')
    expect(transport.stopCount).toBe(1)
  })

  it('remove with force routes to forceKill', async () => {
    const { manager, transport } = setup()
    const session = new FakeSession({ id: 'x' })
    manager.register(transport, session)
    await manager.remove('x', { force: true })
    expect(transport.forceKillCount).toBe(1)
    expect(transport.stopCount).toBe(0)
  })

  it('disposeAll stops every session and is idempotent', async () => {
    const { manager, transport } = setup()
    const s1 = new FakeSession({ id: 'a' })
    const s2 = new FakeSession({ id: 'b' })
    manager.register(transport, s1)
    manager.register(transport, s2)
    await manager.disposeAll()
    expect(transport.stopCount).toBe(2)
    expect(manager.size).toBe(0)
    await manager.disposeAll()
    expect(transport.stopCount).toBe(2)
  })
})
