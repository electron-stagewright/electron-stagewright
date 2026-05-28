/**
 * Unit tests for `electron_attach` / `electron_inject`. These run against the
 * real (default) transport registry, so they exercise the honest failure mode of
 * today's CDP / Injector stubs: a registered error code, no fake success.
 */

import { describe, expect, it } from 'vitest'

import { type ErrorResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { attachTool, injectTool } from '../src/tools/lifecycle/index.js'

function setup() {
  // Default registry → real CDP (attach) and Injector (inject) stubs.
  const dispatcher = new Dispatcher({ sessions: new SessionManager() })
  dispatcher.registerAll([attachTool, injectTool])
  return { dispatcher }
}

describe('electron_attach (stub transport)', () => {
  it('rejects a missing attach target with BAD_ARGUMENT before choosing a transport', async () => {
    const { dispatcher } = setup()
    const res = await dispatcher.dispatch('electron_attach', {})
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

  it('surfaces a registered error rather than faking success', async () => {
    const { dispatcher } = setup()
    const res = await dispatcher.dispatch('electron_attach', { port: 9222 })
    expect(res.ok).toBe(false)
    expect(['NOT_IMPLEMENTED', 'TRANSPORT_UNSUPPORTED']).toContain((res as ErrorResponse).code)
  })
})

describe('electron_inject (stub transport)', () => {
  it('surfaces a registered error rather than faking success', async () => {
    const { dispatcher } = setup()
    const res = await dispatcher.dispatch('electron_inject', { pid: 1234 })
    expect(res.ok).toBe(false)
    expect(['NOT_IMPLEMENTED', 'TRANSPORT_UNSUPPORTED']).toContain((res as ErrorResponse).code)
  })

  it('rejects a missing pid with BAD_ARGUMENT (Zod)', async () => {
    const { dispatcher } = setup()
    const res = await dispatcher.dispatch('electron_inject', {})
    expect((res as ErrorResponse).code).toBe('BAD_ARGUMENT')
  })
})
