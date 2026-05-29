/**
 * Unit tests for {@link TransportRegistry}: capability-based selection, id
 * lookup, and the no-transport-qualifies error.
 */

import { describe, expect, it } from 'vitest'

import { StagewrightError } from '../src/errors/registry.js'
import { TransportRegistry } from '../src/server/transport-registry.js'
import type { TransportCapabilities } from '../src/transports/index.js'
import { FakeTransport } from './helpers/fake-transport.js'

function caps(partial: Partial<TransportCapabilities>): TransportCapabilities {
  return {
    canLaunch: false,
    canAttach: false,
    canInject: false,
    canIntercept: false,
    canControlClock: false,
    supportsMainEval: false,
    supportsRendererEval: false,
    supportsInteraction: false,
    ...partial,
  }
}

describe('TransportRegistry', () => {
  it('selects the first transport declaring the requested capability', () => {
    const launcher = new FakeTransport({
      id: 'playwright-electron',
      capabilities: caps({ canLaunch: true }),
    })
    const attacher = new FakeTransport({ id: 'cdp', capabilities: caps({ canAttach: true }) })
    const registry = new TransportRegistry({ transports: [launcher, attacher] })

    expect(registry.requireCapability('canLaunch')).toBe(launcher)
    expect(registry.requireCapability('canAttach')).toBe(attacher)
  })

  it('throws TRANSPORT_UNSUPPORTED when no transport declares the capability', () => {
    const registry = new TransportRegistry({
      transports: [new FakeTransport({ capabilities: caps({}) })],
    })
    try {
      registry.requireCapability('canInject')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(StagewrightError)
      expect((err as StagewrightError).code).toBe('TRANSPORT_UNSUPPORTED')
    }
  })

  it('looks transports up by id', () => {
    const cdp = new FakeTransport({ id: 'cdp', capabilities: caps({ canAttach: true }) })
    const registry = new TransportRegistry({ transports: [cdp] })
    expect(registry.byId('cdp')).toBe(cdp)
    expect(registry.byId('injector')).toBeUndefined()
  })

  it('defaults to the three built-in transports', () => {
    const registry = new TransportRegistry()
    expect(registry.all().map((t) => t.id)).toEqual(['playwright-electron', 'cdp', 'injector'])
    // Playwright launches, CDP attaches, Injector injects.
    expect(registry.requireCapability('canLaunch').id).toBe('playwright-electron')
    expect(registry.requireCapability('canAttach').id).toBe('cdp')
    expect(registry.requireCapability('canInject').id).toBe('injector')
  })
})
