/** Compact orientation state exposed by `electron_status`. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { makeSuccess, type SuccessResponse } from '../src/errors/envelope.js'
import { StagewrightError } from '../src/errors/registry.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { createServer } from '../src/server/server.js'
import { SessionManager } from '../src/server/session-manager.js'
import type { ServerStatusReader } from '../src/server/status.js'
import { statusTool } from '../src/tools/lifecycle/status.js'
import { defineTool, type ToolContext } from '../src/tools/types.js'
import type { SurfaceDescriptor } from '../src/transports/index.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'

const ACTIVE_SURFACE: SurfaceDescriptor = {
  id: 'surface-main',
  kind: 'window',
  title: 'Task board',
  active: true,
  capabilities: { snapshot: true, interaction: true, rendererEval: true },
}

interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve() {
      resolvePromise?.()
    },
  }
}

function setup() {
  let clock = 1_000
  const now = (): number => clock
  const firstFailure = deferred()
  const secondFailure = deferred()
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
  dispatcher.register(
    defineTool({
      name: 'test_server_failure',
      description: 'Test-only stable server failure.',
      inputSchema: z.object({ secretPath: z.string().optional() }),
      operationType: 'query',
      handler: async (args) => {
        throw new StagewrightError(
          'FILE_NOT_FOUND',
          `Sensitive path was not found: ${args.secretPath ?? 'none'}.`,
          args.secretPath === undefined ? undefined : { path: args.secretPath },
        )
      },
    }),
  )
  dispatcher.register(
    defineTool({
      name: 'test_resolve_failure',
      description: 'Test-only missing-session failure.',
      inputSchema: z.object({ sessionId: z.string() }),
      operationType: 'query',
      handler: async (args, ctx) => {
        ctx.sessions.resolve(args.sessionId)
        return makeSuccess({}, { startedAt: ctx.startedAt, now: ctx.now })
      },
    }),
  )
  dispatcher.register(
    defineTool({
      name: 'test_first_controlled_failure',
      description: 'Test-only controlled failure.',
      inputSchema: z.object({}),
      operationType: 'query',
      handler: async () => {
        await firstFailure.promise
        throw new StagewrightError('ELEMENT_DISABLED', 'First controlled failure.')
      },
    }),
  )
  dispatcher.register(
    defineTool({
      name: 'test_second_controlled_failure',
      description: 'Test-only controlled failure.',
      inputSchema: z.object({}),
      operationType: 'query',
      handler: async () => {
        await secondFailure.promise
        throw new StagewrightError('FILE_NOT_FOUND', 'Second controlled failure.')
      },
    }),
  )
  return {
    dispatcher,
    firstFailure,
    sessions,
    secondFailure,
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
      server: { started_at: 1_000, uptime_ms: 42 },
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
    expect(result.server).not.toHaveProperty('last_error')
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

  it('retains bounded server failures without echoing sensitive or unknown input', async () => {
    const { dispatcher, advance } = setup()
    const secretPath = '/private/consumer/project/private-entry.js'
    advance(10)
    await dispatcher.dispatch('test_server_failure', { secretPath })

    const first = (await dispatcher.dispatch('electron_status', {})) as SuccessResponse & {
      readonly server: {
        readonly last_error?: { readonly tool?: string; readonly code: string; readonly at: number }
      }
    }
    expect(first.server.last_error).toEqual({
      tool: 'test_server_failure',
      code: 'FILE_NOT_FOUND',
      at: 1_010,
    })
    expect(JSON.stringify(first)).not.toContain(secretPath)
    expect(JSON.stringify(first)).not.toContain('Sensitive path was not found')
    expect(first._meta.estimated_tokens).toBeLessThanOrEqual(350)

    // A successful status read retains the prior failure.
    const retained = (await dispatcher.dispatch('electron_status', {})) as SuccessResponse & {
      readonly server: { readonly last_error?: unknown }
    }
    expect(retained.server.last_error).toEqual(first.server.last_error)

    const unknownName = `unknown_${secretPath}`
    advance(10)
    await dispatcher.dispatch(unknownName, {})
    const unknown = (await dispatcher.dispatch('electron_status', {})) as SuccessResponse & {
      readonly server: {
        readonly last_error?: { readonly tool?: string; readonly code: string; readonly at: number }
      }
    }
    expect(unknown.server.last_error).toEqual({ code: 'BAD_ARGUMENT', at: 1_020 })
    expect(JSON.stringify(unknown)).not.toContain(unknownName)
    expect(JSON.stringify(unknown)).not.toContain(secretPath)
  })

  it('uses the server breadcrumb when a requested session is missing or released', async () => {
    const { dispatcher, sessions, advance } = setup()
    await sessions.remove('session-one')
    advance(15)
    await dispatcher.dispatch('test_resolve_failure', { sessionId: 'released-session' })

    const result = (await dispatcher.dispatch('electron_status', {})) as SuccessResponse & {
      readonly server: {
        readonly last_error?: { readonly tool?: string; readonly code: string; readonly at: number }
      }
    }
    expect(result).toMatchObject({
      active_sessions: 0,
      sessions: [],
      server: {
        last_error: {
          tool: 'test_resolve_failure',
          code: 'NOT_RUNNING',
          at: 1_015,
        },
      },
    })
    expect(JSON.stringify(result)).not.toContain('released-session')
  })

  it('promotes a live-session failure to the server breadcrumb once its session ends', async () => {
    const { dispatcher, sessions, advance } = setup()
    advance(10)
    await dispatcher.dispatch('test_status_failure', { sessionId: 'session-one' })

    const live = (await dispatcher.dispatch('electron_status', {})) as SuccessResponse & {
      readonly server: { readonly last_error?: unknown }
      readonly sessions: readonly Record<string, unknown>[]
    }
    expect(live.sessions[0]).toMatchObject({
      last_error: { code: 'ELEMENT_DISABLED', at: 1_010 },
    })
    expect(live.server).not.toHaveProperty('last_error')

    await sessions.remove('session-one')
    const ended = (await dispatcher.dispatch('electron_status', {})) as SuccessResponse & {
      readonly server: { readonly last_error?: unknown }
      readonly sessions: readonly unknown[]
    }
    expect(ended.sessions).toEqual([])
    expect(ended.server.last_error).toEqual({ code: 'ELEMENT_DISABLED', at: 1_010 })
    expect(JSON.stringify(ended)).not.toContain('session-one')
  })

  it('does not let an ending session displace a newer server failure', async () => {
    const { dispatcher, sessions, advance } = setup()
    advance(10)
    await dispatcher.dispatch('test_status_failure', { sessionId: 'session-one' })
    advance(10)
    await dispatcher.dispatch('test_server_failure', {})
    await sessions.remove('session-one')

    const result = (await dispatcher.dispatch('electron_status', {})) as SuccessResponse & {
      readonly server: { readonly last_error?: unknown }
    }
    expect(result.server.last_error).toEqual({
      tool: 'test_server_failure',
      code: 'FILE_NOT_FOUND',
      at: 1_020,
    })
  })

  it('does not let an ending session displace a server failure from the same clock tick', async () => {
    const { dispatcher, sessions, advance } = setup()
    advance(10)
    await dispatcher.dispatch('test_status_failure', { sessionId: 'session-one' })
    await dispatcher.dispatch('test_server_failure', {})
    await sessions.remove('session-one')

    const result = (await dispatcher.dispatch('electron_status', {})) as SuccessResponse & {
      readonly server: { readonly last_error?: unknown }
    }
    expect(result.server.last_error).toEqual({
      tool: 'test_server_failure',
      code: 'FILE_NOT_FOUND',
      at: 1_010,
    })
  })

  it('keeps the last completed concurrent server failure', async () => {
    const { advance, dispatcher, firstFailure, secondFailure } = setup()
    const first = dispatcher.dispatch('test_first_controlled_failure', {})
    const second = dispatcher.dispatch('test_second_controlled_failure', {})

    advance(10)
    secondFailure.resolve()
    await second
    advance(10)
    firstFailure.resolve()
    await first

    const result = (await dispatcher.dispatch('electron_status', {})) as SuccessResponse & {
      readonly server: {
        readonly last_error?: { readonly tool?: string; readonly code: string; readonly at: number }
      }
    }
    expect(result.server.last_error).toEqual({
      tool: 'test_first_controlled_failure',
      code: 'ELEMENT_DISABLED',
      at: 1_020,
    })
  })

  it('reports a real launch preflight failure through the server status projection', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sw-status-launch-'))
    const missingExecutable = path.join(root, 'missing-electron')
    let clock = 5_000
    const server = await createServer({ now: () => clock })
    try {
      clock += 25
      await expect(
        server.dispatcher.dispatch('electron_launch', {
          executablePath: missingExecutable,
        }),
      ).resolves.toMatchObject({ ok: false, code: 'FILE_NOT_FOUND' })

      const result = (await server.dispatcher.dispatch(
        'electron_status',
        {},
      )) as SuccessResponse & {
        readonly server: {
          readonly started_at: number
          readonly last_error?: {
            readonly tool?: string
            readonly code: string
            readonly at: number
          }
        }
      }
      expect(result.server).toMatchObject({
        started_at: 5_000,
        last_error: {
          tool: 'electron_launch',
          code: 'FILE_NOT_FOUND',
          at: 5_025,
        },
      })
      expect(JSON.stringify(result)).not.toContain(missingExecutable)
    } finally {
      await server.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps plugin API 1.3 status readers source- and runtime-compatible', async () => {
    const legacyStatus: ServerStatusReader = {
      uptimeMs: () => 40,
      lastError: () => undefined,
    }
    const now = (): number => 1_040
    const result = (await statusTool.handler({}, {
      sessions: new SessionManager(),
      status: legacyStatus,
      startedAt: 1_040,
      now,
    } as ToolContext)) as SuccessResponse & {
      readonly server: {
        readonly started_at: number
        readonly uptime_ms: number
        readonly last_error?: unknown
      }
    }

    expect(result.server).toEqual({
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      started_at: 1_000,
      uptime_ms: 40,
    })
  })

  it('does not retain an error on the session entry after that session was released', async () => {
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
