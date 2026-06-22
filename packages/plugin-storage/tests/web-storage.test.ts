/**
 * Unit tests for WEB_STORAGE_BODY (ADR-018 Status Update) — the renderer-eval body that backs the
 * per-key localStorage/sessionStorage tools. The body is executed the way the Playwright transport runs
 * it: wrapped in `"use strict"; return (async () => { … })()` with the request bound to `arg`. The only
 * difference from production is that `window` (the renderer global) is supplied as an extra function
 * parameter, since Node has no DOM — the documented test seam (mirrors the IPC plugin's instrument-body
 * tests). A fake in-memory Storage stands in for the real Web Storage areas.
 */

import { describe, expect, it } from 'vitest'

import {
  WEB_STORAGE_BODY,
  type WebStorageRequest,
  type WebStorageResult,
} from '../src/web-storage.js'

/** In-memory Web Storage faithful to the parts WEB_STORAGE_BODY uses (getItem/setItem/.../key/length). */
function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(seed))
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage
}

interface FakeWindow {
  readonly location: { readonly origin: string }
  readonly localStorage: Storage
  readonly sessionStorage: Storage
}

/** Run WEB_STORAGE_BODY exactly as the transport does, with `window` injected for the Node test. */
async function run(req: WebStorageRequest, win: FakeWindow): Promise<WebStorageResult> {
  // Mirrors the transport's evaluate wrapper, run against the FIXED, trusted WEB_STORAGE_BODY constant
  // (no untrusted interpolation) — the documented way to unit-test a renderer body string off-Electron.
  const fn = new Function(
    'arg',
    'window',
    `"use strict"; return (async () => { ${WEB_STORAGE_BODY} })()`,
  ) as (arg: WebStorageRequest, window: FakeWindow) => Promise<WebStorageResult>
  return fn(req, win)
}

const ORIGIN = 'https://app.example.com'

function win(seed?: {
  local?: Record<string, string>
  session?: Record<string, string>
}): FakeWindow {
  return {
    location: { origin: ORIGIN },
    localStorage: fakeStorage(seed?.local),
    sessionStorage: fakeStorage(seed?.session),
  }
}

describe('WEB_STORAGE_BODY', () => {
  it('reads a present key and reports the origin', async () => {
    const res = await run({ op: 'get', scope: 'local', key: 'cart' }, win({ local: { cart: '3' } }))
    expect(res).toEqual({ ok: true, origin: ORIGIN, value: '3' })
  })

  it('returns null (not empty string) for an absent key', async () => {
    const res = await run({ op: 'get', scope: 'local', key: 'missing' }, win())
    expect(res).toMatchObject({ ok: true, value: null })
  })

  it('distinguishes an empty-string value from an absent key', async () => {
    const res = await run(
      { op: 'get', scope: 'local', key: 'blank' },
      win({ local: { blank: '' } }),
    )
    expect(res).toMatchObject({ ok: true, value: '' })
  })

  it('reads many keys in order, null for the absent ones', async () => {
    const res = await run(
      { op: 'getMany', scope: 'local', keys: ['a', 'gone', 'b'] },
      win({ local: { a: '1', b: '2' } }),
    )
    expect(res).toEqual({
      ok: true,
      origin: ORIGIN,
      items: [
        { key: 'a', value: '1' },
        { key: 'gone', value: null },
        { key: 'b', value: '2' },
      ],
    })
  })

  it('sets a key (verbatim) and a later get sees it', async () => {
    const w = win()
    expect(await run({ op: 'set', scope: 'local', key: 'k', value: 'v' }, w)).toEqual({
      ok: true,
      origin: ORIGIN,
    })
    expect(w.localStorage.getItem('k')).toBe('v')
  })

  it('removes a key idempotently (removing an absent key still succeeds)', async () => {
    const w = win({ local: { k: 'v' } })
    expect(await run({ op: 'remove', scope: 'local', key: 'k' }, w)).toMatchObject({ ok: true })
    expect(w.localStorage.getItem('k')).toBeNull()
    expect(await run({ op: 'remove', scope: 'local', key: 'k' }, w)).toMatchObject({ ok: true })
  })

  it('lists keys (the keys tool derives count from this list)', async () => {
    const res = await run({ op: 'keys', scope: 'local' }, win({ local: { a: '1', b: '2' } }))
    expect(res).toMatchObject({ ok: true })
    expect((res as unknown as { keys: string[] }).keys.sort()).toEqual(['a', 'b'])
  })

  it('clears the scope', async () => {
    const w = win({ local: { a: '1', b: '2' } })
    expect(await run({ op: 'clear', scope: 'local' }, w)).toMatchObject({ ok: true })
    expect(w.localStorage.length).toBe(0)
  })

  it('targets sessionStorage independently of localStorage', async () => {
    const w = win({ local: { k: 'L' }, session: { k: 'S' } })
    expect(await run({ op: 'get', scope: 'session', key: 'k' }, w)).toMatchObject({ value: 'S' })
    await run({ op: 'set', scope: 'session', key: 'only', value: 'x' }, w)
    expect(w.localStorage.getItem('only')).toBeNull()
    expect(w.sessionStorage.getItem('only')).toBe('x')
  })

  it('round-trips unicode (astral-plane) keys and values', async () => {
    const w = win()
    const key = 'astral-😀-key'
    const value = '𝓊𝓃𝒾𝒸𝑜𝒹𝑒-✓'
    await run({ op: 'set', scope: 'local', key, value }, w)
    expect(await run({ op: 'get', scope: 'local', key }, w)).toMatchObject({ value })
  })

  it('returns a structured failure (never throws) when storage access throws', async () => {
    const w: FakeWindow = {
      location: { origin: ORIGIN },
      get localStorage(): Storage {
        throw new DOMException('access denied', 'SecurityError')
      },
      sessionStorage: fakeStorage(),
    }
    const res = await run({ op: 'get', scope: 'local', key: 'k' }, w)
    expect(res).toMatchObject({ ok: false, origin: ORIGIN, reason: 'access denied' })
  })

  it('returns a structured failure when setItem throws (quota exceeded)', async () => {
    const throwingSet = fakeStorage()
    throwingSet.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError')
    }
    const w: FakeWindow = {
      location: { origin: ORIGIN },
      localStorage: throwingSet,
      sessionStorage: fakeStorage(),
    }
    const res = await run({ op: 'set', scope: 'local', key: 'k', value: 'v' }, w)
    expect(res).toMatchObject({ ok: false, reason: 'quota' })
  })

  it('every result is JSON-serialisable (the wire contract)', async () => {
    const w = win({ local: { a: '1' } })
    for (const req of [
      { op: 'get', scope: 'local', key: 'a' },
      { op: 'getMany', scope: 'local', keys: ['a', 'z'] },
      { op: 'keys', scope: 'local' },
    ] as const) {
      const res = await run(req, w)
      expect(JSON.parse(JSON.stringify(res))).toEqual(res)
    }
  })
})
