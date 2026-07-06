/**
 * Loopback attach-target validation (security review follow-up). The transports must not rely on
 * the `electron_attach` tool schema alone to keep attach endpoints loopback-only — a direct API
 * caller must be rejected at the transport boundary too.
 */

import { describe, expect, it } from 'vitest'

import {
  assertLoopbackAttachTarget,
  isLoopbackCdpUrl,
  isLoopbackHost,
} from '../src/transports/index.js'

describe('isLoopbackHost', () => {
  it('accepts loopback names and rejects others', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true)
    }
    for (const host of ['169.254.169.254', 'example.com', '10.0.0.1', '0.0.0.0']) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })
})

describe('isLoopbackCdpUrl', () => {
  it('accepts ws/wss loopback URLs', () => {
    expect(isLoopbackCdpUrl('ws://127.0.0.1:9222/devtools/browser/x')).toBe(true)
    expect(isLoopbackCdpUrl('wss://localhost:9222/x')).toBe(true)
  })

  it('rejects non-loopback hosts and non-ws protocols', () => {
    expect(isLoopbackCdpUrl('ws://169.254.169.254/x')).toBe(false)
    expect(isLoopbackCdpUrl('http://127.0.0.1:9222/x')).toBe(false)
    expect(isLoopbackCdpUrl('not a url')).toBe(false)
  })
})

describe('assertLoopbackAttachTarget', () => {
  it('is a no-op for loopback targets', () => {
    expect(() =>
      assertLoopbackAttachTarget('cdp', { cdpUrl: 'ws://127.0.0.1:9222/x', host: 'localhost' }),
    ).not.toThrow()
    expect(() => assertLoopbackAttachTarget('cdp', {})).not.toThrow()
  })

  it('throws BAD_ARGUMENT for a non-loopback cdpUrl (SSRF guard)', () => {
    expect(() =>
      assertLoopbackAttachTarget('cdp', { cdpUrl: 'ws://169.254.169.254/x' }),
    ).toThrowError(/loopback/)
  })

  it('throws BAD_ARGUMENT for a non-loopback host', () => {
    expect(() => assertLoopbackAttachTarget('cdp', { host: 'example.com' })).toThrowError(
      /loopback/,
    )
  })
})
