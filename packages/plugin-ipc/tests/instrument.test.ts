/**
 * Unit tests for the IPC plugin's pure plugin-side helpers (ADR-010): channel filtering and arg
 * redaction over captured events. The main-process shim itself (INSTRUMENT_BODY) is exercised by
 * the e2e tests (simulated main) and the gated real-Electron smoke.
 */

import { describe, expect, it } from 'vitest'

import { filterEvents, redactEvents, type IpcEvent } from '../src/instrument.js'

function ev(channel: string, args: unknown[], type: 'invoke' | 'send' = 'invoke'): IpcEvent {
  return { channel, type, args, ok: true, ms: 0, ts: 0 }
}

describe('filterEvents', () => {
  const events = [ev('save', [1]), ev('open', [2]), ev('save', [3])]

  it('returns all events when no channel is given', () => {
    expect(filterEvents(events)).toHaveLength(3)
  })

  it('keeps only the named channel', () => {
    const result = filterEvents(events, 'save')
    expect(result).toHaveLength(2)
    expect(result.every((e) => e.channel === 'save')).toBe(true)
  })
})

describe('redactEvents', () => {
  it('returns events unchanged when no keys are configured', () => {
    const events = [ev('save', [{ token: 'x' }])]
    expect(redactEvents(events, [])).toEqual(events)
  })

  it('redacts named arg fields recursively', () => {
    const events = [ev('save', [{ token: 'secret', keep: 1, nested: { token: 'deep' } }])]
    const redacted = redactEvents(events, ['token'])
    expect(redacted[0]?.args[0]).toEqual({
      token: '[redacted]',
      keep: 1,
      nested: { token: '[redacted]' },
    })
    // The original is not mutated.
    expect((events[0]?.args[0] as { token: string }).token).toBe('secret')
  })
})
