/**
 * Unit tests for `runDomStorage`, the CDP DOMStorage path behind the Web Storage seam: it picks the
 * selected frame, keys storage by storage key (or security origin on older builds), and maps each
 * operation onto one DOMStorage command.
 */

import { describe, expect, it } from 'vitest'

import { type CdpSend, runDomStorage } from '../src/transports/dom-storage.js'

const TREE = {
  frameTree: {
    frame: { id: 'main', url: 'file:///app/index.html', securityOrigin: 'file://' },
    childFrames: [
      {
        frame: {
          id: 'child',
          url: 'https://widget.example.com/embed',
          securityOrigin: 'https://widget.example.com',
        },
      },
    ],
  },
}

function cdp(opts: { storageKey?: boolean; entries?: [string, string][] } = {}) {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const send: CdpSend = async <T>(method: string, params?: Record<string, unknown>) => {
    calls.push({ method, ...(params !== undefined ? { params } : {}) })
    if (method === 'Page.getFrameTree') return TREE as T
    if (method === 'Storage.getStorageKeyForFrame') {
      if (opts.storageKey === false) throw new Error("'Storage.getStorageKeyForFrame' wasn't found")
      return { storageKey: `key-for-${String(params?.['frameId'])}` } as T
    }
    if (method === 'DOMStorage.getDOMStorageItems') return { entries: opts.entries ?? [] } as T
    return {} as T
  }
  return { send, calls }
}

const commands = (calls: { method: string }[]) =>
  calls.map((call) => call.method).filter((method) => method.startsWith('DOMStorage.'))

describe('runDomStorage', () => {
  it('reads the main frame by storage key and reports its origin', async () => {
    const { send, calls } = cdp({ entries: [['lang', 'es']] })
    await expect(runDomStorage(send, {}, { area: 'local', op: 'items' })).resolves.toEqual({
      origin: 'file://',
      entries: [['lang', 'es']],
    })
    expect(calls.find((c) => c.method === 'DOMStorage.getDOMStorageItems')?.params).toEqual({
      storageId: { storageKey: 'key-for-main', isLocalStorage: true },
    })
  })

  it('selects a frame by id or by URL', async () => {
    const byId = cdp()
    await expect(
      runDomStorage(byId.send, { frameId: 'child' }, { area: 'session', op: 'items' }),
    ).resolves.toMatchObject({ origin: 'https://widget.example.com' })
    const byUrl = cdp()
    await runDomStorage(
      byUrl.send,
      { url: 'https://widget.example.com/embed' },
      { area: 'session', op: 'items' },
    )
    expect(byUrl.calls.find((c) => c.method === 'DOMStorage.getDOMStorageItems')?.params).toEqual({
      storageId: { storageKey: 'key-for-child', isLocalStorage: false },
    })
  })

  it("addresses a frame missing from this connection's tree by its URL origin, not the top page", async () => {
    const { send, calls } = cdp()
    await expect(
      runDomStorage(send, { url: 'http://localhost:4000/child' }, { area: 'local', op: 'items' }),
    ).resolves.toMatchObject({ origin: 'http://localhost:4000' })
    expect(calls.find((c) => c.method === 'DOMStorage.getDOMStorageItems')?.params).toEqual({
      storageId: { securityOrigin: 'http://localhost:4000', isLocalStorage: true },
    })
  })

  it('turns the DOMStorage domain off again after each operation', async () => {
    const { send, calls } = cdp()
    await runDomStorage(send, {}, { area: 'local', op: 'items' })
    expect(commands(calls)).toEqual([
      'DOMStorage.enable',
      'DOMStorage.getDOMStorageItems',
      'DOMStorage.disable',
    ])
  })

  it('falls back to the security origin when the build has no storage keys', async () => {
    const { send, calls } = cdp({ storageKey: false })
    await runDomStorage(send, {}, { area: 'local', op: 'items' })
    expect(calls.find((c) => c.method === 'DOMStorage.getDOMStorageItems')?.params).toEqual({
      storageId: { securityOrigin: 'file://', isLocalStorage: true },
    })
  })

  it('maps set, remove and clear onto one DOMStorage command each', async () => {
    const { send, calls } = cdp()
    await runDomStorage(send, {}, { area: 'local', op: 'set', key: 'theme', value: 'dark' })
    await runDomStorage(send, {}, { area: 'local', op: 'remove', key: 'theme' })
    await runDomStorage(send, {}, { area: 'session', op: 'clear' })
    expect(commands(calls).filter((method) => !method.endsWith('able'))).toEqual([
      'DOMStorage.setDOMStorageItem',
      'DOMStorage.removeDOMStorageItem',
      'DOMStorage.clear',
    ])
    expect(calls.find((c) => c.method === 'DOMStorage.clear')?.params).toEqual({
      storageId: { storageKey: 'key-for-main', isLocalStorage: false },
    })
    expect(calls.find((c) => c.method === 'DOMStorage.setDOMStorageItem')?.params).toEqual({
      storageId: { storageKey: 'key-for-main', isLocalStorage: true },
      key: 'theme',
      value: 'dark',
    })
  })
})
