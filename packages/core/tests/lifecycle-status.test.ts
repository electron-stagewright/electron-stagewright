/** Compact orientation state exposed by `electron_status`. */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { type SuccessResponse } from '../src/errors/envelope.js'
import { StagewrightError } from '../src/errors/registry.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { statusTool } from '../src/tools/lifecycle/status.js'
import { defineTool } from '../src/tools/types.js'
import type { SurfaceDescriptor } from '../src/transports/index.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'

const ACTIVE_SURFACE: SurfaceDescriptor = {
  id: 'surface-main',
  kind: 'window',
  title: 'Task board',
  active: true,
  capabilities: { snapshot: true, interaction: true, rendererEval: true },
}

function setup() {
  let clock = 1_000
  const now = (): number => clock
  const sessions = new SessionManager()
  const session = new FakeSession({ id: 'session-one', surfaces: [ACTIVE_SURFACE] })
  const transport = new FakeTransport({ session })
  sessions.register(transport, session)
  const dispatcher = new Dispatcher({ sessions, now })
  dispatcher.register(statusTool)
  dispatcher.register(
    defineTool({
      name: 'test_status_failure',
      description: 'Test-only stable failure.',
      inputSchema: z.object({ sessionId: z.string() }),
      operationType: 'query',
      handler: async () => {
        throw new StagewrightError('ELEMENT_DISABLED', 'The action is disabled.')
      },
    }),
  )
  return {
    dispatcher,
    sessions,
    session,
    transport,
    advance(ms: number) {
      clock += ms
    },
  }
}

describe('electron_status', () => {
  it('orients an agent without returning session telemetry arrays or prompt text', async () => {
    const { dispatcher, session, advance } = setup()
    await session.setDialogPolicy({
      action: 'accept',
      promptText: 'private value',
      perType: { confirm: 'dismiss' },
      oneShot: true,
    })
    advance(42)
    await dispatcher.dispatch('test_status_failure', { sessionId: 'session-one' })

    const result = (await dispatcher.dispatch('electron_status', {})) as SuccessResponse & {
      readonly server: { readonly version: string; readonly uptime_ms: number }
      readonly active_sessions: number
      readonly sessions: readonly Record<string, unknown>[]
    }
    expect(result).toMatchObject({
      ok: true,
      server: { uptime_ms: 42 },
      active_sessions: 1,
      sessions: [
        {
          session_id: 'session-one',
          transport: 'playwright-electron',
          renderer_ready: true,
          active_surface: { id: 'surface-main', kind: 'window', title: 'Task board' },
          dialog: {
            armed: true,
            action: 'accept',
            per_type: { confirm: 'dismiss' },
            one_shot: true,
          },
          last_error: { code: 'ELEMENT_DISABLED', at: 1_042 },
        },
      ],
    })
    expect(result.server.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(JSON.stringify(result)).not.toContain('private value')
    expect(result._meta.estimated_tokens).toBeLessThanOrEqual(350)
  })

  it('covers zero and multiple live sessions, then clears released session state', async () => {
    const { dispatcher, sessions, transport } = setup()
    const initial = (await dispatcher.dispatch('electron_status', {})) as SuccessResponse & {
      readonly active_sessions: number
      readonly sessions: readonly { readonly session_id: string }[]
    }
    expect(initial.active_sessions).toBe(1)

    const second = new FakeSession({ id: 'session-two' })
    sessions.register(transport, second)
    const multiple = (await dispatcher.dispatch('electron_status', {})) as SuccessResponse & {
      readonly active_sessions: number
      readonly sessions: readonly { readonly session_id: string }[]
    }
    expect(multiple.active_sessions).toBe(2)
    expect(multiple.sessions.map((entry) => entry.session_id)).toEqual([
      'session-one',
      'session-two',
    ])

    await sessions.remove('session-one')
    await sessions.remove('session-two')
    const empty = (await dispatcher.dispatch('electron_status', {})) as SuccessResponse & {
      readonly active_sessions: number
      readonly sessions: readonly unknown[]
    }
    expect(empty).toMatchObject({ ok: true, active_sessions: 0, sessions: [] })
    expect(JSON.parse(JSON.stringify(empty))).toEqual(empty)
  })

  it('does not retain an error from a session that had already been released', async () => {
    const { dispatcher, sessions, transport } = setup()
    await sessions.remove('session-one')
    await dispatcher.dispatch('test_status_failure', { sessionId: 'session-one' })
    sessions.register(transport, new FakeSession({ id: 'session-one' }))

    const result = (await dispatcher.dispatch('electron_status', {})) as SuccessResponse & {
      readonly sessions: readonly Record<string, unknown>[]
    }
    expect(result.sessions[0]).toMatchObject({ session_id: 'session-one' })
    expect(result.sessions[0]).not.toHaveProperty('last_error')
  })

  it('does not lose orientation when one session no longer has a readable renderer', async () => {
    const sessions = new SessionManager()
    const broken = new FakeSession({ id: 'broken' })
    const originalActiveSurface = broken.activeSurface.bind(broken)
    broken.activeSurface = async () => {
      await originalActiveSurface()
      throw new Error('renderer detached')
    }
    const healthy = new FakeSession({ id: 'healthy' })
    const transport = new FakeTransport({ session: broken })
    sessions.register(transport, broken)
    sessions.register(transport, healthy)
    const dispatcher = new Dispatcher({ sessions })
    dispatcher.register(statusTool)

    const result = (await dispatcher.dispatch('electron_status', {})) as SuccessResponse & {
      readonly sessions: readonly Record<string, unknown>[]
    }
    expect(result.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ session_id: 'broken', renderer_ready: false }),
        expect.objectContaining({ session_id: 'healthy', renderer_ready: true }),
      ]),
    )
  })
})
