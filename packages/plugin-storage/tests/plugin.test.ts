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
  type TransportCapabilities,
} from '@electron-stagewright/core'
import { afterEach, describe, expect, it } from 'vitest'

import { FakeSession, FakeTransport } from '../../core/tests/helpers/fake-transport.js'
import packageJson from '../package.json' with { type: 'json' }
import storagePlugin from '../src/index.js'

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
  opts: { capabilities?: TransportCapabilities; revealValues?: boolean } = {},
): Promise<Awaited<ReturnType<typeof createServer>>> {
  const transport = new FakeTransport({ session, capabilities: opts.capabilities ?? FULL_CAPS })
  const server = await createServer({
    plugins: [storagePlugin],
    ...(opts.revealValues !== undefined
      ? { pluginConfigs: { storage: { revealValues: opts.revealValues } } }
      : {}),
    logger: NOOP_LOGGER,
    transports: new TransportRegistry({ transports: [transport] }),
  })
  servers.push(server)
  return server
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
