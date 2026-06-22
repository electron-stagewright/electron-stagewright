/**
 * Integration tests for the storage plugin (ADR-018) loaded into a real server. The session transport is
 * a FakeTransport whose FakeSession records each storage-seam call and holds a cookie/localStorage store,
 * so the plugin's orchestration — the canAccessStorage gate, the relay to the seam, the cookie filter,
 * the url-or-domain refine, and (above all) the default cookie-value redaction — is exercised without
 * launching Electron. The real BrowserContext / CDP Network path is covered by the gated real-Electron
 * smoke and the transport-session unit tests.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  createServer,
  NOOP_LOGGER,
  TransportRegistry,
  type EvalPolicy,
  type TransportCapabilities,
} from '@electron-stagewright/core'
import { afterEach, describe, expect, it } from 'vitest'

import { FakeSession, FakeTransport } from '../../core/tests/helpers/fake-transport.js'
import packageJson from '../package.json' with { type: 'json' }
import storagePlugin from '../src/index.js'
import {
  WEB_STORAGE_BODY,
  type WebStorageRequest,
  type WebStorageResult,
} from '../src/web-storage.js'

const created: string[] = []

/** electron_launch validates the main path exists on disk, so back it with a real temp file. */
async function fixtureMain(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sw-storage-'))
  created.push(dir)
  const main = path.join(dir, 'main.js')
  await writeFile(main, '// fake main entry\n', 'utf8')
  return main
}

const FULL_CAPS: TransportCapabilities = {
  canLaunch: true,
  canAttach: true,
  canInject: true,
  canIntercept: true,
  canControlClock: true,
  canAccessStorage: true,
  canAccessNativeUI: true,
  supportsMainEval: true,
  supportsRendererEval: true,
  supportsInteraction: true,
}

const servers: Array<Awaited<ReturnType<typeof createServer>>> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => undefined)))
  await Promise.all(created.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

async function open(
  session: FakeSession,
  opts: {
    capabilities?: TransportCapabilities
    revealValues?: boolean
    allowEval?: boolean | EvalPolicy
  } = {},
): Promise<Awaited<ReturnType<typeof createServer>>> {
  const transport = new FakeTransport({ session, capabilities: opts.capabilities ?? FULL_CAPS })
  const server = await createServer({
    plugins: [storagePlugin],
    ...(opts.revealValues !== undefined
      ? { pluginConfigs: { storage: { revealValues: opts.revealValues } } }
      : {}),
    ...(opts.allowEval !== undefined ? { allowEval: opts.allowEval } : {}),
    logger: NOOP_LOGGER,
    transports: new TransportRegistry({ transports: [transport] }),
  })
  servers.push(server)
  return server
}

/**
 * A FakeSession whose `evaluate('renderer', WEB_STORAGE_BODY, req)` asserts that the plugin relays the
 * REAL fixed body, then simulates the storage result against an in-memory store seeded per scope. The
 * renderer body itself is covered in web-storage.test.ts; these tests focus on the plugin's relay +
 * result shaping without launching Electron. `evalCalls` records every request the plugin sent so a
 * test can assert the relayed op/scope/key.
 */
function webStorageSession(seed?: {
  local?: Record<string, string>
  session?: Record<string, string>
  origin?: string
}): { session: FakeSession; evalCalls: WebStorageRequest[] } {
  const local = new Map<string, string>(Object.entries(seed?.local ?? {}))
  const sess = new Map<string, string>(Object.entries(seed?.session ?? {}))
  const origin = seed?.origin ?? 'https://app.example.com'
  const evalCalls: WebStorageRequest[] = []
  const session = new FakeSession({
    evaluate: async (target, body, arg) => {
      expect(target).toBe('renderer')
      expect(body).toBe(WEB_STORAGE_BODY)
      const req = arg as WebStorageRequest
      evalCalls.push(req)
      const store = req.scope === 'session' ? sess : local
      const result = ((): WebStorageResult => {
        switch (req.op) {
          case 'get':
            return {
              ok: true,
              origin,
              value: store.has(req.key as string) ? (store.get(req.key as string) as string) : null,
            }
          case 'getMany':
            return {
              ok: true,
              origin,
              items: (req.keys ?? []).map((k) => ({
                key: k,
                value: store.has(k) ? (store.get(k) as string) : null,
              })),
            }
          case 'set':
            store.set(req.key as string, req.value as string)
            return { ok: true, origin }
          case 'remove':
            store.delete(req.key as string)
            return { ok: true, origin }
          case 'keys': {
            const keys = [...store.keys()]
            return { ok: true, origin, keys }
          }
          case 'clear':
            store.clear()
            return { ok: true, origin }
          default:
            return { ok: false, origin, reason: 'unsupported_op' }
        }
      })()
      return result
    },
  })
  return { session, evalCalls }
}

async function launch(server: Awaited<ReturnType<typeof createServer>>): Promise<string> {
  const main = await fixtureMain()
  const launched = (await server.dispatcher.dispatch('electron_launch', { main })) as {
    ok: boolean
    session_id?: string
    _meta?: { session_id?: string }
  }
  const id = launched.session_id ?? launched._meta?.session_id
  if (typeof id !== 'string') throw new Error('launch did not return a session id')
  return id
}

describe('storage plugin', () => {
  it('advertises the package version through plugin introspection', async () => {
    const server = await open(new FakeSession())
    expect(await server.dispatcher.dispatch('electron_plugins', {})).toMatchObject({
      ok: true,
      plugins: [{ name: 'storage', version: packageJson.version }],
    })
  })

  it('sets a cookie and relays it verbatim to the seam', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)

    expect(
      await server.dispatcher.dispatch('storage_set_cookie', {
        sessionId,
        name: 'auth',
        value: 'super-secret-token',
        url: 'https://app.example.com',
      }),
    ).toMatchObject({ ok: true, set: 'auth' })

    // The write path passes the agent's own value through unredacted.
    expect(session.setCookieCalls).toEqual([
      { name: 'auth', value: 'super-secret-token', url: 'https://app.example.com' },
    ])
  })

  it('defaults path to / for a domain-seeded cookie (Playwright needs a domain+path pair)', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)

    await server.dispatcher.dispatch('storage_set_cookie', {
      sessionId,
      name: 'auth',
      value: 'tok',
      domain: 'app.example.com',
    })
    expect(session.setCookieCalls).toEqual([
      { name: 'auth', value: 'tok', domain: 'app.example.com', path: '/' },
    ])
  })

  it('does not force a path when the cookie is seeded by url', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)

    await server.dispatcher.dispatch('storage_set_cookie', {
      sessionId,
      name: 'auth',
      value: 'tok',
      url: 'https://app.example.com/admin',
    })
    // url-seeded: let Playwright/CDP derive the path from the url; we must not override it.
    expect(session.setCookieCalls[0]).not.toHaveProperty('path')
  })

  it('redacts cookie VALUES by default on the read paths', async () => {
    const session = new FakeSession()
    session.storageCookies = [
      { name: 'auth', value: 'super-secret-token', domain: 'app.example.com' },
      { name: 'theme', value: 'dark', domain: 'app.example.com' },
    ]
    const server = await open(session)
    const sessionId = await launch(server)

    const cookies = (await server.dispatcher.dispatch('storage_cookies', {
      sessionId,
    })) as unknown as {
      ok: boolean
      count: number
      cookies: Array<{ name: string; value: string }>
    }
    expect(cookies.ok).toBe(true)
    expect(cookies.count).toBe(2)
    // Names survive; every value is masked.
    expect(cookies.cookies.map((c) => c.name)).toEqual(['auth', 'theme'])
    expect(cookies.cookies.every((c) => c.value === '[redacted]')).toBe(true)

    const snap = (await server.dispatcher.dispatch('storage_snapshot', {
      sessionId,
    })) as unknown as {
      ok: boolean
      cookies: Array<{ value: string }>
    }
    expect(snap.cookies.every((c) => c.value === '[redacted]')).toBe(true)
  })

  it('reveals cookie values verbatim when revealValues is configured', async () => {
    const session = new FakeSession()
    session.storageCookies = [
      { name: 'auth', value: 'super-secret-token', domain: 'app.example.com' },
    ]
    const server = await open(session, { revealValues: true })
    const sessionId = await launch(server)

    const cookies = (await server.dispatcher.dispatch('storage_cookies', {
      sessionId,
    })) as unknown as {
      cookies: Array<{ value: string }>
    }
    expect(cookies.cookies[0]?.value).toBe('super-secret-token')
  })

  it('passes url and name through as a cookie filter on read and clear', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)

    await server.dispatcher.dispatch('storage_cookies', {
      sessionId,
      url: 'https://app.example.com',
      name: 'auth',
    })
    expect(session.getCookieCalls).toEqual([{ urls: ['https://app.example.com'], name: 'auth' }])

    await server.dispatcher.dispatch('storage_clear_cookies', { sessionId, name: 'auth' })
    expect(session.clearCookieCalls).toEqual([{ name: 'auth' }])
  })

  it('clears all cookies when no filter is given', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    expect(await server.dispatcher.dispatch('storage_clear_cookies', { sessionId })).toMatchObject({
      ok: true,
      cleared: 'all',
    })
    expect(session.clearCookieCalls).toEqual([undefined])
  })

  it('returns the localStorage origins in the snapshot', async () => {
    const session = new FakeSession()
    session.storageOrigins = [
      { origin: 'https://app.example.com', localStorage: [{ name: 'cart', value: '3-items' }] },
    ]
    const server = await open(session)
    const sessionId = await launch(server)
    expect(await server.dispatcher.dispatch('storage_snapshot', { sessionId })).toMatchObject({
      ok: true,
      origins: [
        { origin: 'https://app.example.com', localStorage: [{ name: 'cart', value: '3-items' }] },
      ],
    })
  })

  it('returns a wire-serialisable snapshot payload (no Map/Set/Date round-trip loss)', async () => {
    // The cookies + origins payloads are JSON.stringify'd before reaching the agent; assert they survive
    // a round-trip intact (the repo's documented Map-ships-empty defect class), mirroring the network
    // plugin's NetworkEvent round-trip guard.
    const session = new FakeSession()
    session.storageCookies = [{ name: 'auth', value: 'tok', domain: 'app.example.com', path: '/' }]
    session.storageOrigins = [
      { origin: 'https://app.example.com', localStorage: [{ name: 'cart', value: '3-items' }] },
    ]
    const server = await open(session, { revealValues: true })
    const sessionId = await launch(server)
    const snap = (await server.dispatcher.dispatch('storage_snapshot', {
      sessionId,
    })) as unknown as { cookies: unknown; origins: unknown }
    expect(JSON.parse(JSON.stringify(snap.cookies))).toEqual(snap.cookies)
    expect(JSON.parse(JSON.stringify(snap.origins))).toEqual(snap.origins)
  })

  it('rejects a transport that cannot access storage with storage.UNSUPPORTED', async () => {
    const server = await open(new FakeSession(), {
      capabilities: { ...FULL_CAPS, canAccessStorage: false },
    })
    const sessionId = await launch(server)
    for (const [tool, args] of [
      ['storage_cookies', {}],
      ['storage_set_cookie', { name: 'a', value: 'b', url: 'https://x.example' }],
      ['storage_clear_cookies', {}],
      ['storage_snapshot', {}],
    ] as const) {
      expect(await server.dispatcher.dispatch(tool, { sessionId, ...args })).toMatchObject({
        ok: false,
        code: 'storage.UNSUPPORTED',
      })
    }
  })

  it('rejects a set_cookie with neither url nor domain as BAD_ARGUMENT', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('storage_set_cookie', {
        sessionId,
        name: 'auth',
        value: 'x',
      }),
    ).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    // Nothing reached the seam.
    expect(session.setCookieCalls).toEqual([])
  })
})

const RENDERER_ON: EvalPolicy = { main: false, renderer: true }

describe('storage plugin — per-key web storage (renderer-eval gated)', () => {
  it('hides the per-key tools unless the server permits renderer eval (registration gate)', async () => {
    const off = await open(new FakeSession()) // no allowEval → renderer eval denied
    const offNames = off.dispatcher.listManifest().map((e) => e.name)
    expect(offNames).not.toContain('storage_local_get')
    expect(offNames).not.toContain('storage_session_set')
    // The no-eval seam tools stay visible regardless.
    expect(offNames).toContain('storage_snapshot')

    const on = await open(new FakeSession(), { allowEval: RENDERER_ON })
    const onNames = on.dispatcher.listManifest().map((e) => e.name)
    for (const t of [
      'storage_local_get',
      'storage_local_set',
      'storage_local_remove',
      'storage_local_keys',
      'storage_local_clear',
      'storage_session_get',
      'storage_session_set',
      'storage_session_remove',
      'storage_session_keys',
      'storage_session_clear',
    ]) {
      expect(onNames).toContain(t)
    }
  })

  it('dispatching a hidden per-key tool names --allow-eval=renderer (not a bare unknown tool)', async () => {
    const server = await open(new FakeSession())
    const sessionId = await launch(server)
    const res = (await server.dispatcher.dispatch('storage_local_get', {
      sessionId,
      key: 'k',
    })) as { ok: boolean; code?: string; error?: string }
    expect(res).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(res.error).toContain('--allow-eval=renderer')
  })

  it('marks the per-key tools as renderer-eval gated in the manifest', async () => {
    const server = await open(new FakeSession(), { allowEval: RENDERER_ON })
    const entry = server.dispatcher.listManifest().find((e) => e.name === 'storage_local_get')
    expect(entry).toMatchObject({ requiresEvalFlag: true, evalTarget: 'renderer' })
  })

  it('reads a localStorage key and surfaces the origin (relaying the right request)', async () => {
    const { session, evalCalls } = webStorageSession({ local: { cart: '3-items' } })
    const server = await open(session, { allowEval: RENDERER_ON })
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('storage_local_get', { sessionId, key: 'cart' }),
    ).toMatchObject({
      ok: true,
      scope: 'local',
      origin: 'https://app.example.com',
      key: 'cart',
      value: '3-items',
    })
    expect(evalCalls).toEqual([{ op: 'get', scope: 'local', key: 'cart' }])
  })

  it('returns value:null for an absent key', async () => {
    const { session } = webStorageSession()
    const server = await open(session, { allowEval: RENDERER_ON })
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('storage_local_get', { sessionId, key: 'nope' }),
    ).toMatchObject({ ok: true, value: null })
  })

  it('reads several keys at once with keys[] (the multi-key variant)', async () => {
    const { session, evalCalls } = webStorageSession({ local: { a: '1', b: '2' } })
    const server = await open(session, { allowEval: RENDERER_ON })
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('storage_local_get', { sessionId, keys: ['a', 'z', 'b'] }),
    ).toMatchObject({
      ok: true,
      scope: 'local',
      items: [
        { key: 'a', value: '1' },
        { key: 'z', value: null },
        { key: 'b', value: '2' },
      ],
    })
    expect(evalCalls[0]).toEqual({ op: 'getMany', scope: 'local', keys: ['a', 'z', 'b'] })
  })

  it('rejects a get with neither key nor keys, and with both, as BAD_ARGUMENT', async () => {
    const { session, evalCalls } = webStorageSession()
    const server = await open(session, { allowEval: RENDERER_ON })
    const sessionId = await launch(server)
    expect(await server.dispatcher.dispatch('storage_local_get', { sessionId })).toMatchObject({
      ok: false,
      code: 'BAD_ARGUMENT',
    })
    expect(
      await server.dispatcher.dispatch('storage_local_get', { sessionId, key: 'a', keys: ['b'] }),
    ).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(evalCalls).toEqual([]) // schema rejected before the seam
  })

  it('sets, lists, removes, and clears localStorage through the seam', async () => {
    const { session } = webStorageSession()
    const server = await open(session, { allowEval: RENDERER_ON })
    const sessionId = await launch(server)

    expect(
      await server.dispatcher.dispatch('storage_local_set', { sessionId, key: 'k', value: 'v' }),
    ).toMatchObject({ ok: true, scope: 'local', set: 'k' })
    expect(
      await server.dispatcher.dispatch('storage_local_get', { sessionId, key: 'k' }),
    ).toMatchObject({ value: 'v' })
    expect(await server.dispatcher.dispatch('storage_local_keys', { sessionId })).toMatchObject({
      ok: true,
      count: 1,
      keys: ['k'],
    })
    expect(
      await server.dispatcher.dispatch('storage_local_remove', { sessionId, key: 'k' }),
    ).toMatchObject({ ok: true, removed: 'k' })
    expect(
      await server.dispatcher.dispatch('storage_local_get', { sessionId, key: 'k' }),
    ).toMatchObject({ value: null })
    // Seed two, then clear.
    await server.dispatcher.dispatch('storage_local_set', { sessionId, key: 'a', value: '1' })
    await server.dispatcher.dispatch('storage_local_set', { sessionId, key: 'b', value: '2' })
    expect(await server.dispatcher.dispatch('storage_local_clear', { sessionId })).toMatchObject({
      ok: true,
      cleared: true,
    })
    expect(await server.dispatcher.dispatch('storage_local_keys', { sessionId })).toMatchObject({
      count: 0,
    })
  })

  it('supports empty-string Web Storage keys consistently', async () => {
    const { session } = webStorageSession()
    const server = await open(session, { allowEval: RENDERER_ON })
    const sessionId = await launch(server)

    expect(
      await server.dispatcher.dispatch('storage_local_set', {
        sessionId,
        key: '',
        value: 'blank',
      }),
    ).toMatchObject({ ok: true, set: '' })
    expect(
      await server.dispatcher.dispatch('storage_local_get', { sessionId, key: '' }),
    ).toMatchObject({ ok: true, value: 'blank' })
    expect(
      await server.dispatcher.dispatch('storage_local_remove', { sessionId, key: '' }),
    ).toMatchObject({ ok: true, removed: '' })
    expect(
      await server.dispatcher.dispatch('storage_local_get', { sessionId, key: '' }),
    ).toMatchObject({ ok: true, value: null })
  })

  it('targets sessionStorage independently of localStorage', async () => {
    const { session, evalCalls } = webStorageSession({ local: { k: 'L' }, session: { k: 'S' } })
    const server = await open(session, { allowEval: RENDERER_ON })
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('storage_session_get', { sessionId, key: 'k' }),
    ).toMatchObject({ ok: true, scope: 'session', value: 'S' })
    expect(evalCalls[0]).toMatchObject({ op: 'get', scope: 'session' })
  })

  it('rejects a transport without renderer eval with storage.UNSUPPORTED', async () => {
    // Policy permits renderer eval (so the tool registers), but the transport cannot do it.
    const { session } = webStorageSession()
    const server = await open(session, {
      allowEval: RENDERER_ON,
      capabilities: { ...FULL_CAPS, supportsRendererEval: false },
    })
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('storage_local_get', { sessionId, key: 'k' }),
    ).toMatchObject({ ok: false, code: 'storage.UNSUPPORTED' })
  })

  it('maps a renderer storage-access failure to storage.ACCESS_FAILED', async () => {
    const session = new FakeSession({
      evaluate: async () =>
        ({ ok: false, origin: null, reason: 'quota exceeded' }) satisfies WebStorageResult,
    })
    const server = await open(session, { allowEval: RENDERER_ON })
    const sessionId = await launch(server)
    const res = (await server.dispatcher.dispatch('storage_local_set', {
      sessionId,
      key: 'k',
      value: 'v',
    })) as { ok: boolean; code?: string; error?: string }
    expect(res).toMatchObject({ ok: false, code: 'storage.ACCESS_FAILED' })
    expect(res.error).toContain('quota exceeded')
  })

  it('maps an absent/malformed renderer result to storage.ACCESS_FAILED', async () => {
    const session = new FakeSession({ evaluate: async () => undefined })
    const server = await open(session, { allowEval: RENDERER_ON })
    const sessionId = await launch(server)
    expect(await server.dispatcher.dispatch('storage_local_keys', { sessionId })).toMatchObject({
      ok: false,
      code: 'storage.ACCESS_FAILED',
    })
  })

  it('maps malformed successful renderer payloads to storage.ACCESS_FAILED', async () => {
    const session = new FakeSession({ evaluate: async () => ({ ok: true }) })
    const server = await open(session, { allowEval: RENDERER_ON })
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('storage_local_get', { sessionId, key: 'k' }),
    ).toMatchObject({
      ok: false,
      code: 'storage.ACCESS_FAILED',
    })
  })

  it('returns wire-serialisable per-key payloads (no round-trip loss)', async () => {
    const { session } = webStorageSession({ local: { a: '1', b: '2' } })
    const server = await open(session, { allowEval: RENDERER_ON })
    const sessionId = await launch(server)
    for (const [tool, args] of [
      ['storage_local_get', { key: 'a' }],
      ['storage_local_get', { keys: ['a', 'z'] }],
      ['storage_local_keys', {}],
    ] as const) {
      const res = await server.dispatcher.dispatch(tool, { sessionId, ...args })
      expect(JSON.parse(JSON.stringify(res))).toEqual(res)
    }
  })
})
