/** Tests for the stable plugin-authoring helpers exposed from the core plugin-sdk subpath. */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  createPluginConfigState,
  createSessionCleanup,
  parsePluginConfig,
  PluginConfigValidationError,
  requireTransportCapability,
  sessionIdField,
} from '../src/plugin-sdk/index.js'
import type { PluginSessionEndEvent, PluginServerContext } from '../src/plugins/types.js'
import type { TransportCapabilities } from '../src/transports/types.js'

const CAPABILITIES: TransportCapabilities = {
  canLaunch: true,
  canAttach: true,
  canInject: false,
  canIntercept: true,
  canControlClock: true,
  canAccessStorage: true,
  canAccessNativeUI: true,
  supportsMainEval: true,
  supportsRendererEval: true,
  supportsInteraction: true,
}

describe('plugin SDK config helpers', () => {
  it('parses a detached deeply frozen config snapshot', () => {
    const raw = { nested: { label: 'before' }, values: ['one'] }
    const parsed = parsePluginConfig(
      z.object({ nested: z.object({ label: z.string() }), values: z.array(z.string()) }),
      raw,
    )

    raw.nested.label = 'after'
    raw.values.push('two')

    expect(parsed).toEqual({ nested: { label: 'before' }, values: ['one'] })
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.nested)).toBe(true)
    expect(Object.isFrozen(parsed.values)).toBe(true)
    expect(() => (parsed.values as string[]).push('blocked')).toThrow(TypeError)
  })

  it('reports schema failures with a public validation error', () => {
    let caught: unknown
    try {
      parsePluginConfig(z.object({ enabled: z.boolean() }), { enabled: 'yes' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PluginConfigValidationError)
    expect(caught).toMatchObject({
      issues: [{ path: '$.enabled' }],
    })
  })

  it('keeps config state isolated from both inputs and its initial defaults', () => {
    const defaults = { tags: ['default'] }
    const state = createPluginConfigState(defaults)
    defaults.tags.push('caller-change')

    const next = { tags: ['configured'] }
    state.set(next)
    next.tags.push('caller-change')
    expect(state.current).toEqual({ tags: ['configured'] })

    state.reset()
    expect(state.current).toEqual({ tags: ['default'] })
    expect(Object.isFrozen(state.current.tags)).toBe(true)
  })
})

describe('plugin SDK lifecycle helpers', () => {
  it('cleans released session state and unsubscribes before the final backstop', () => {
    const listeners = new Set<(event: PluginSessionEndEvent) => void | Promise<void>>()
    const context: PluginServerContext = {
      onSessionEnd(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    const released = vi.fn()
    const final = vi.fn()
    const cleanup = createSessionCleanup(released, final)

    cleanup.setup(context)
    expect(listeners).toHaveLength(1)
    for (const listener of listeners) {
      listener({ sessionId: 'session-a', reason: 'stop', remainingSessionIds: [] })
    }
    expect(released).toHaveBeenCalledWith('session-a')

    cleanup.teardown()
    cleanup.teardown()
    cleanup.setup(context)
    expect(listeners).toHaveLength(0)
    expect(final).toHaveBeenCalledTimes(1)
  })
})

describe('plugin SDK capability and schema helpers', () => {
  it('defers the plugin-specific fallback until a capability is unavailable', () => {
    const fallback = vi.fn(() => ({ code: 'plugin.UNSUPPORTED' }))
    const supported = requireTransportCapability(CAPABILITIES, 'canIntercept', fallback)
    expect(supported).toEqual({ supported: true })
    expect(fallback).not.toHaveBeenCalled()

    const unsupported = requireTransportCapability(
      { ...CAPABILITIES, canIntercept: false },
      'canIntercept',
      fallback,
    )
    expect(unsupported).toEqual({ supported: false, fallback: { code: 'plugin.UNSUPPORTED' } })
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('keeps the shared optional session field contract stable', () => {
    expect(sessionIdField.sessionId.safeParse(undefined).success).toBe(true)
    expect(sessionIdField.sessionId.safeParse('session-1').success).toBe(true)
  })
})
