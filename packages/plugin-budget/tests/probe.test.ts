/** The main-process body run in Node against a stand-in electron module. */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { MAIN_BODY, MAX_WINDOW_MS, type FirstWindowStartup } from '../src/probe.js'

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => (electronApp: unknown, arg: unknown) => Promise<unknown>
const main = new AsyncFunction('electronApp', 'arg', MAIN_BODY)

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as Record<string, unknown>)['__swBudget']
})

function window(id: number, historyLength: number, timeOrigin: number) {
  return {
    id,
    isDestroyed: () => false,
    webContents: {
      navigationHistory: { length: () => historyLength },
      executeJavaScript: async () => ({ timeOrigin, loadEventEnd: 400, type: 'navigate' }),
    },
  }
}

describe('MAIN_BODY', () => {
  it('stops an unread window once it outlives MAX_WINDOW_MS', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
    await main({}, { op: 'start' })
    vi.advanceTimersByTime(1_000)
    expect(await main({}, { op: 'read' })).not.toBeNull()
    vi.advanceTimersByTime(MAX_WINDOW_MS)
    expect(await main({}, { op: 'read', stop: true })).toBeNull()
  })

  it('reads startup from the first window still open, with its history length', async () => {
    const electronApp = {
      BrowserWindow: { getAllWindows: () => [window(3, 1, 9_000), window(2, 2, 5_000)] },
    }
    expect((await main(electronApp, { op: 'startup' })) as FirstWindowStartup).toEqual({
      timeOrigin: 5_000,
      loadEventEnd: 400,
      type: 'navigate',
      historyLength: 2,
    })
    const none = { BrowserWindow: { getAllWindows: () => [] } }
    expect(await main(none, { op: 'startup' })).toEqual({ error: 'no window is open' })
  })
})
