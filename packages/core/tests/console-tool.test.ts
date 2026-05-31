/**
 * Unit tests for `electron_console_logs` — the query-time filters (type, regex,
 * since, limit), the `overflowed` passthrough, and invalid-regex handling. The
 * buffer is supplied via the FakeSession's canned `consoleEntries`.
 */

import { describe, expect, it } from 'vitest'

import { type ErrorResponse, type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { OBSERVE_TOOLS } from '../src/tools/observe/index.js'
import type { ConsoleEntry } from '../src/transports/index.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'

const ENTRIES: readonly ConsoleEntry[] = [
  { type: 'log', text: 'app started', timestamp: 1000 },
  { type: 'warning', text: 'deprecation: foo', timestamp: 2000 },
  { type: 'error', text: 'boom: network failed', timestamp: 3000 },
  { type: 'log', text: 'retry network', timestamp: 4000 },
]

function setup(opts: { entries?: readonly ConsoleEntry[]; overflowed?: number } = {}) {
  const sessions = new SessionManager()
  const session = new FakeSession({
    id: 'sess',
    consoleEntries: opts.entries ?? ENTRIES,
    ...(opts.overflowed !== undefined ? { consoleOverflowed: opts.overflowed } : {}),
  })
  sessions.register(new FakeTransport(), session)
  const dispatcher = new Dispatcher({ sessions })
  dispatcher.registerAll(OBSERVE_TOOLS)
  return { dispatcher }
}

type LogsResponse = SuccessResponse & {
  entries: readonly ConsoleEntry[]
  count: number
  overflowed: number
}

describe('electron_console_logs', () => {
  it('returns all entries and the overflow count by default', async () => {
    const { dispatcher } = setup({ overflowed: 7 })
    const res = (await dispatcher.dispatch('electron_console_logs', {})) as LogsResponse
    expect(res.count).toBe(4)
    expect(res.overflowed).toBe(7)
  })

  it('filters by a single type', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_console_logs', {
      type: 'error',
    })) as LogsResponse
    expect(res.entries.map((e) => e.text)).toEqual(['boom: network failed'])
  })

  it('filters by multiple types', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_console_logs', {
      type: ['warning', 'error'],
    })) as LogsResponse
    expect(res.entries.map((e) => e.type)).toEqual(['warning', 'error'])
  })

  it('filters by a text regex', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_console_logs', {
      match: 'network',
    })) as LogsResponse
    expect(res.entries.map((e) => e.text)).toEqual(['boom: network failed', 'retry network'])
  })

  it('filters by since (timestamp lower bound)', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_console_logs', {
      since: 3000,
    })) as LogsResponse
    expect(res.entries.map((e) => e.timestamp)).toEqual([3000, 4000])
  })

  it('keeps the most recent entries up to limit', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_console_logs', { limit: 2 })) as LogsResponse
    expect(res.entries.map((e) => e.timestamp)).toEqual([3000, 4000])
  })

  it('rejects an invalid match regex with BAD_ARGUMENT', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_console_logs', {
      match: '(unclosed',
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })

  it('requires a running session', async () => {
    const sessions = new SessionManager()
    const dispatcher = new Dispatcher({ sessions })
    dispatcher.registerAll(OBSERVE_TOOLS)
    const res = (await dispatcher.dispatch('electron_console_logs', {})) as ErrorResponse
    expect(res.code).toBe('NOT_RUNNING')
  })
})
