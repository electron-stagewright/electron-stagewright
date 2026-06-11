/**
 * Unit tests for `electron_attach` / `electron_inject`. These run against the
 * real transport implementations: attach exercises the default CDP transport's
 * honest failure mode against a dead endpoint, and inject exercises an
 * Injector transport with process/network dependencies stubbed so the test never
 * signals an arbitrary local pid.
 */

import { describe, expect, it } from 'vitest'

import { type ErrorResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { TransportRegistry } from '../src/server/transport-registry.js'
import { attachTool, injectTool } from '../src/tools/lifecycle/index.js'
import { InjectorTransport } from '../src/transports/injector.js'

function setup(transports?: TransportRegistry) {
  const dispatcher = new Dispatcher({
    sessions: new SessionManager(),
    ...(transports !== undefined ? { transports } : {}),
  })
  dispatcher.registerAll([attachTool, injectTool])
  return { dispatcher }
}

describe('electron_attach (default transport)', () => {
  it('rejects a missing attach target with BAD_ARGUMENT before choosing a transport', async () => {
    const { dispatcher } = setup()
    const res = await dispatcher.dispatch('electron_attach', {})
    expect((res as ErrorResponse).code).toBe('BAD_ARGUMENT')
  })

  it('rejects pid-only attach before choosing CDP (use electron_inject instead)', async () => {
    const { dispatcher } = setup()
    const res = await dispatcher.dispatch('electron_attach', { pid: 1234 })
    expect((res as ErrorResponse).code).toBe('BAD_ARGUMENT')
  })

  it('rejects remote CDP hosts with BAD_ARGUMENT', async () => {
    const { dispatcher } = setup()
    const byHost = await dispatcher.dispatch('electron_attach', { port: 9222, host: 'example.com' })
    const byUrl = await dispatcher.dispatch('electron_attach', {
      cdpUrl: 'ws://example.com:9222/devtools/browser/abc',
    })
    expect((byHost as ErrorResponse).code).toBe('BAD_ARGUMENT')
    expect((byUrl as ErrorResponse).code).toBe('BAD_ARGUMENT')
  })

  it('surfaces CDP_DISCONNECTED against a dead endpoint rather than faking success', async () => {
    const { dispatcher } = setup()
    // Port 1 (tcpmux) is reserved and never serves a CDP endpoint, so the
    // discovery probe fails fast and deterministically — unlike 9222, which a
    // developer machine may genuinely have a DevTools endpoint listening on.
    const res = await dispatcher.dispatch('electron_attach', { port: 1 })
    expect(res.ok).toBe(false)
    expect((res as ErrorResponse).code).toBe('CDP_DISCONNECTED')
    expect((res as ErrorResponse).retryable).toBe(true)
  })
})

describe('electron_inject (default transport)', () => {
  it('surfaces a registered error rather than faking success', async () => {
    const debugged: number[] = []
    const safeInjector = new InjectorTransport({
      debugProcess: (pid) => debugged.push(pid),
      fetchJson: async () => {
        throw new Error('no inspector here')
      },
      pollIntervalMs: 1,
    })
    const { dispatcher } = setup(new TransportRegistry({ transports: [safeInjector] }))

    const res = await dispatcher.dispatch('electron_inject', { pid: 1234, timeoutMs: 1 })
    expect(res.ok).toBe(false)
    expect((res as ErrorResponse).code).toBe('INJECT_FAILED')
    expect((res as ErrorResponse).retryable).toBe(true)
    expect(debugged).toEqual([1234])
  })

  it('rejects a missing pid with BAD_ARGUMENT (Zod)', async () => {
    const { dispatcher } = setup()
    const res = await dispatcher.dispatch('electron_inject', {})
    expect((res as ErrorResponse).code).toBe('BAD_ARGUMENT')
  })
})
