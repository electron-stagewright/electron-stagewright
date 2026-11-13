/** The main-process body run in Node against a stand-in electron module. */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { readProcStartTime } from '../src/memory.js'
import { MAIN_BODY, MAX_WINDOW_MS, type FirstWindowStartup } from '../src/probe.js'

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => (electronApp: unknown, arg: unknown) => Promise<unknown>
const main = new AsyncFunction('electronApp', 'arg', MAIN_BODY)

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as Record<string, unknown>)['__swBudget']
})

function window(id: number, firstUrl: string, url: string, loading = false) {
  return {
    id,
    isDestroyed: () => false,
    webContents: {
      getURL: () => url,
      isLoadingMainFrame: () => loading,
      navigationHistory: { getEntryAtIndex: () => ({ url: firstUrl }) },
      executeJavaScript: async () => ({
        timeOrigin: id * 1_000,
        loadEventEnd: 400,
        type: 'navigate',
        url,
      }),
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

  it('reads startup from the first window still open, with its first history entry', async () => {
    const electronApp = {
      BrowserWindow: {
        getAllWindows: () => [window(3, 'app://b', 'app://b'), window(2, 'app://a', 'app://c')],
      },
    }
    expect((await main(electronApp, { op: 'startup' })) as FirstWindowStartup).toEqual({
      timeOrigin: 2_000,
      loadEventEnd: 400,
      type: 'navigate',
      url: 'app://c',
      firstUrl: 'app://a',
      historyLength: null,
    })
    const legacy = window(1, 'app://a', 'app://a') as { webContents: Record<string, unknown> }
    delete legacy.webContents['navigationHistory']
    legacy.webContents['length'] = () => 3
    const old = { BrowserWindow: { getAllWindows: () => [legacy] } }
    expect(await main(old, { op: 'startup' })).toMatchObject({ firstUrl: null, historyLength: 3 })
    const loading = { BrowserWindow: { getAllWindows: () => [window(1, '', '', true)] } }
    expect(await main(loading, { op: 'startup' })).toEqual({
      error: 'the first window has not finished loading',
    })
    const none = { BrowserWindow: { getAllWindows: () => [] } }
    expect(await main(none, { op: 'startup' })).toEqual({ error: 'no window is open' })
  })
})

describe('readProcStartTime', () => {
  it('adds the start ticks after the command name to the boot time', async () => {
    const files: Record<string, string> = {
      '/proc/42/stat': `42 (Electron Helper (Renderer)) S ${'0 '.repeat(18)}12345 0 0`,
      '/proc/stat': 'cpu 1 2 3\nbtime 1700000000\nprocesses 9\n',
    }
    const read = async (file: string) => {
      const text = files[file]
      if (text === undefined) throw new Error('ENOENT')
      return text
    }
    expect(await readProcStartTime(42, read)).toBe(1_700_000_000_000 + 123_450)
    expect(await readProcStartTime(7, read)).toBe('missing')
  })
})
