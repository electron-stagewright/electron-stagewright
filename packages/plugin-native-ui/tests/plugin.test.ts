/**
 * Integration tests for the native-UI plugin (ADR-019) loaded into a real server. The session transport
 * is a FakeTransport whose FakeSession returns a canned application menu, so the plugin's orchestration —
 * the canAccessNativeUI gate, the relay to the seam, the path lookup (by label OR role), and the
 * null-menu case — is exercised without launching Electron. The real Menu.getApplicationMenu() serializer
 * is covered by the Playwright-session unit test and the gated real-Electron smoke.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  createServer,
  NOOP_LOGGER,
  TransportRegistry,
  type NativeMenu,
  type NativeNotification,
  type NativeTray,
  type TransportCapabilities,
} from '@electron-stagewright/core'
import { afterEach, describe, expect, it } from 'vitest'

import { FakeSession, FakeTransport } from '../../core/tests/helpers/fake-transport.js'
import packageJson from '../package.json' with { type: 'json' }
import nativeUiPlugin from '../src/index.js'

const created: string[] = []

/** electron_launch validates the main path exists on disk, so back it with a real temp file. */
async function fixtureMain(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sw-native-'))
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

/** A representative menu: a top-level View submenu with a checked checkbox + a disabled item + a role. */
const SAMPLE_MENU: NativeMenu = {
  items: [
    {
      label: 'View',
      type: 'submenu',
      enabled: true,
      visible: true,
      submenu: [
        {
          label: 'Dark Mode',
          type: 'checkbox',
          enabled: true,
          visible: true,
          checked: true,
          accelerator: 'CmdOrCtrl+D',
        },
        { label: '', type: 'separator', enabled: true, visible: true },
        { label: 'Reload', role: 'reload', type: 'normal', enabled: false, visible: true },
      ],
    },
    {
      label: 'Help',
      type: 'submenu',
      enabled: true,
      visible: true,
      submenu: [{ label: 'Quit', role: 'quit', type: 'normal', enabled: true, visible: true }],
    },
  ],
}

const servers: Array<Awaited<ReturnType<typeof createServer>>> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => undefined)))
  await Promise.all(created.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

async function open(
  session: FakeSession,
  opts: { capabilities?: TransportCapabilities } = {},
): Promise<Awaited<ReturnType<typeof createServer>>> {
  const transport = new FakeTransport({ session, capabilities: opts.capabilities ?? FULL_CAPS })
  const server = await createServer({
    plugins: [nativeUiPlugin],
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

describe('native-ui plugin', () => {
  it('advertises the package version through plugin introspection', async () => {
    const server = await open(new FakeSession())
    expect(await server.dispatcher.dispatch('electron_plugins', {})).toMatchObject({
      ok: true,
      plugins: [{ name: 'native', version: packageJson.version }],
    })
  })

  it('relays the application menu from the seam', async () => {
    const session = new FakeSession()
    session.applicationMenu = SAMPLE_MENU
    const server = await open(session)
    const sessionId = await launch(server)
    expect(await server.dispatcher.dispatch('native_menu', { sessionId })).toMatchObject({
      ok: true,
      menu: SAMPLE_MENU,
    })
  })

  it('returns menu null when the app has no application menu', async () => {
    const session = new FakeSession()
    session.applicationMenu = null
    const server = await open(session)
    const sessionId = await launch(server)
    expect(await server.dispatcher.dispatch('native_menu', { sessionId })).toMatchObject({
      ok: true,
      menu: null,
    })
  })

  it('finds an item by label path and reports its state', async () => {
    const session = new FakeSession()
    session.applicationMenu = SAMPLE_MENU
    const server = await open(session)
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('native_menu_item', {
        sessionId,
        path: ['View', 'Dark Mode'],
      }),
    ).toMatchObject({
      ok: true,
      found: true,
      item: { label: 'Dark Mode', type: 'checkbox', checked: true, accelerator: 'CmdOrCtrl+D' },
    })
  })

  it('resolves a path segment by role when the label differs (role-based items)', async () => {
    const session = new FakeSession()
    session.applicationMenu = SAMPLE_MENU
    const server = await open(session)
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('native_menu_item', { sessionId, path: ['Help', 'quit'] }),
    ).toMatchObject({ ok: true, found: true, item: { role: 'quit', enabled: true } })
  })

  it('reports found false for a path that does not resolve', async () => {
    const session = new FakeSession()
    session.applicationMenu = SAMPLE_MENU
    const server = await open(session)
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('native_menu_item', {
        sessionId,
        path: ['View', 'Nonexistent'],
      }),
    ).toMatchObject({ ok: true, found: false })
  })

  it('reports found false for any path when the app has no menu', async () => {
    const session = new FakeSession()
    session.applicationMenu = null
    const server = await open(session)
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('native_menu_item', { sessionId, path: ['View'] }),
    ).toMatchObject({ ok: true, found: false })
  })

  it('rejects an empty path with BAD_ARGUMENT', async () => {
    const session = new FakeSession()
    session.applicationMenu = SAMPLE_MENU
    const server = await open(session)
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('native_menu_item', { sessionId, path: [] }),
    ).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
  })

  it('rejects a transport that cannot read the native UI with native.UNSUPPORTED', async () => {
    const server = await open(new FakeSession(), {
      capabilities: { ...FULL_CAPS, canAccessNativeUI: false },
    })
    const sessionId = await launch(server)
    for (const [tool, args] of [
      ['native_menu', {}],
      ['native_menu_item', { path: ['View'] }],
      ['native_menu_invoke', { path: ['View'] }],
      ['native_notifications_start', {}],
      ['native_notifications', {}],
      ['native_notifications_stop', {}],
      ['native_trays', {}],
    ] as const) {
      expect(await server.dispatcher.dispatch(tool, { sessionId, ...args })).toMatchObject({
        ok: false,
        code: 'native.UNSUPPORTED',
      })
    }
  })

  it('relays an invoke to the seam and echoes the success result', async () => {
    const session = new FakeSession()
    session.invokeResult = { invoked: true, label: 'Save', role: 'save' }
    const server = await open(session)
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('native_menu_invoke', { sessionId, path: ['File', 'Save'] }),
    ).toMatchObject({ ok: true, invoked: true, label: 'Save', role: 'save' })
    expect(session.invokeCalls).toEqual([['File', 'Save']])
  })

  it('surfaces an invoke refusal reason verbatim', async () => {
    const session = new FakeSession()
    session.invokeResult = { invoked: false, reason: 'role' }
    const server = await open(session)
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('native_menu_invoke', { sessionId, path: ['Help', 'quit'] }),
    ).toMatchObject({ ok: true, invoked: false, reason: 'role' })
  })

  it('rejects an empty invoke path with BAD_ARGUMENT', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('native_menu_invoke', { sessionId, path: [] }),
    ).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(session.invokeCalls).toEqual([])
  })

  it('returns a wire-serialisable invoke result (no Map/Set/Date round-trip loss)', async () => {
    const session = new FakeSession()
    session.invokeResult = { invoked: true, label: 'Save', role: 'save' }
    const server = await open(session)
    const sessionId = await launch(server)
    const res = (await server.dispatcher.dispatch('native_menu_invoke', {
      sessionId,
      path: ['File', 'Save'],
    })) as unknown as Record<string, unknown>
    expect(JSON.parse(JSON.stringify(res))).toEqual(res)
  })

  it('returns a wire-serialisable menu payload (no Map/Set/Date round-trip loss)', async () => {
    // The menu tree is JSON.stringify'd before reaching the agent; assert it survives a round-trip
    // intact (the repo's documented Map-ships-empty defect class), mirroring the storage/network guards.
    const session = new FakeSession()
    session.applicationMenu = SAMPLE_MENU
    const server = await open(session)
    const sessionId = await launch(server)
    const res = (await server.dispatcher.dispatch('native_menu', { sessionId })) as unknown as {
      menu: unknown
    }
    expect(JSON.parse(JSON.stringify(res.menu))).toEqual(res.menu)
  })

  const SAMPLE_NOTIFICATIONS: NativeNotification[] = [
    { title: 'Saved', body: 'All changes saved', silent: false, at: 1000 },
    { title: 'Error', body: 'Could not connect', urgency: 'critical', at: 2000 },
  ]

  it('arms capture, relays the filter, reads, and stops', async () => {
    const session = new FakeSession()
    session.notifications = SAMPLE_NOTIFICATIONS
    const server = await open(session)
    const sessionId = await launch(server)

    expect(
      await server.dispatcher.dispatch('native_notifications_start', {
        sessionId,
        titleContains: 'Sav',
      }),
    ).toMatchObject({ ok: true, capturing: true })
    expect(session.notificationStartCalls).toEqual([{ titleContains: 'Sav' }])

    expect(await server.dispatcher.dispatch('native_notifications', { sessionId })).toMatchObject({
      ok: true,
      count: 2,
      notifications: SAMPLE_NOTIFICATIONS,
    })

    expect(
      await server.dispatcher.dispatch('native_notifications_stop', { sessionId }),
    ).toMatchObject({ ok: true, count: 2, notifications: SAMPLE_NOTIFICATIONS })
    expect(session.notificationStopCalls).toBe(1)
  })

  it('arms with no filter (capture all) when titleContains is omitted', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    await server.dispatcher.dispatch('native_notifications_start', { sessionId })
    expect(session.notificationStartCalls).toEqual([{}])
  })

  it('refuses a double-arm with native.ALREADY_CAPTURING', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    await server.dispatcher.dispatch('native_notifications_start', { sessionId })
    expect(
      await server.dispatcher.dispatch('native_notifications_start', { sessionId }),
    ).toMatchObject({ ok: false, code: 'native.ALREADY_CAPTURING' })
    // Only the first arm reached the seam.
    expect(session.notificationStartCalls).toHaveLength(1)
  })

  it('refuses read/stop before arming with native.NOT_CAPTURING', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    for (const tool of ['native_notifications', 'native_notifications_stop'] as const) {
      expect(await server.dispatcher.dispatch(tool, { sessionId })).toMatchObject({
        ok: false,
        code: 'native.NOT_CAPTURING',
      })
    }
    expect(session.notificationStopCalls).toBe(0)
  })

  it('can re-arm after a stop', async () => {
    const session = new FakeSession()
    const server = await open(session)
    const sessionId = await launch(server)
    await server.dispatcher.dispatch('native_notifications_start', { sessionId })
    await server.dispatcher.dispatch('native_notifications_stop', { sessionId })
    expect(
      await server.dispatcher.dispatch('native_notifications_start', { sessionId }),
    ).toMatchObject({ ok: true, capturing: true })
  })

  it('returns a wire-serialisable notifications payload (no Map/Set/Date round-trip loss)', async () => {
    const session = new FakeSession()
    session.notifications = SAMPLE_NOTIFICATIONS
    const server = await open(session)
    const sessionId = await launch(server)
    await server.dispatcher.dispatch('native_notifications_start', { sessionId })
    const res = (await server.dispatcher.dispatch('native_notifications', {
      sessionId,
    })) as unknown as { notifications: unknown }
    expect(JSON.parse(JSON.stringify(res.notifications))).toEqual(res.notifications)
  })

  const SAMPLE_TRAYS: NativeTray[] = [
    { id: 0, hasImage: true, toolTip: 'Status: OK', menu: { items: [] } },
    { id: 1, hasImage: false, title: 'Second' },
  ]

  it('relays the trays from the seam', async () => {
    const session = new FakeSession()
    session.trays = SAMPLE_TRAYS
    const server = await open(session)
    const sessionId = await launch(server)
    expect(await server.dispatcher.dispatch('native_trays', { sessionId })).toMatchObject({
      ok: true,
      count: 2,
      trays: SAMPLE_TRAYS,
    })
  })

  it('returns native.NOT_INSTRUMENTED when the session was not instrumented', async () => {
    const session = new FakeSession()
    session.trays = null // a session not launched with instrumentNative
    const server = await open(session)
    const sessionId = await launch(server)
    expect(await server.dispatcher.dispatch('native_trays', { sessionId })).toMatchObject({
      ok: false,
      code: 'native.NOT_INSTRUMENTED',
    })
  })

  it('returns a wire-serialisable trays payload (no Map/Set/Date round-trip loss)', async () => {
    const session = new FakeSession()
    session.trays = SAMPLE_TRAYS
    const server = await open(session)
    const sessionId = await launch(server)
    const res = (await server.dispatcher.dispatch('native_trays', {
      sessionId,
    })) as unknown as { trays: unknown }
    expect(JSON.parse(JSON.stringify(res.trays))).toEqual(res.trays)
  })
})
