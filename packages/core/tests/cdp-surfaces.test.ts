/**
 * Unit tests for CDP renderer-surface targeting (ADR-029) over the fake CDP endpoint: discovery
 * from `/json/list` parent links and per-target frame trees, opaque ids and tombstones, eval in
 * in-process frame contexts and OOPIF sockets, and input routed through the window target with
 * frame-owner offsets. Real Electron shapes are covered by `cdp-surface-targeting-smoke.test.ts`.
 */

import { describe, expect, it } from 'vitest'

import { CDPTransport, type FetchJson } from '../src/transports/cdp.js'
import type { SurfaceDescriptor } from '../src/transports/index.js'
import { FakeCdpServer, type Json } from './helpers/fake-cdp.js'

const BROWSER_WS = 'ws://127.0.0.1:9222/devtools/browser/b1'
const ws = (id: string) => `ws://127.0.0.1:9222/devtools/page/${id}`
const HOST = 'http://127.0.0.1:4000/host.html'

const target = (id: string, type: string, url: string, parentId?: string): Json => ({
  id,
  type,
  title: id,
  url,
  webSocketDebuggerUrl: ws(id),
  ...(parentId !== undefined ? { parentId } : {}),
})

const DEFAULT_TARGETS: readonly Json[] = [
  target('H', 'page', HOST),
  target('V', 'page', 'http://127.0.0.1:4000/view.html'),
  target('W', 'webview', 'http://127.0.0.1:4000/guest.html', 'H'),
  target('O', 'iframe', 'http://localhost:4000/cross.html', 'H'),
  target('O2', 'iframe', 'http://127.0.0.1:4000/nested-cross.html', 'O'),
  { id: 'SW', type: 'service_worker', title: 'sw', url: '', webSocketDebuggerUrl: ws('SW') },
]

const HOST_TREE: Json = {
  frame: { id: 'H', url: HOST },
  childFrames: [
    {
      frame: { id: 'S', parentId: 'H', url: 'http://127.0.0.1:4000/same.html' },
      childFrames: [
        { frame: { id: 'S2', parentId: 'S', url: 'http://127.0.0.1:4000/nested-same.html' } },
      ],
    },
  ],
}

/** Owner element per frame id, and its content box origin in the owning target's viewport. */
const OWNERS: Record<string, { readonly node: number; readonly x: number; readonly y: number }> = {
  S: { node: 101, x: 90, y: 8 },
  S2: { node: 102, x: 100, y: 40 },
  O: { node: 103, x: 10, y: 170 },
  O2: { node: 201, x: 10, y: 30 },
}

function setup() {
  const server = new FakeCdpServer()
  let targets: readonly Json[] = DEFAULT_TARGETS
  let hostTree: Json = HOST_TREE
  const fetchJson: FetchJson = async (url) => {
    if (url.endsWith('/json/version')) return { webSocketDebuggerUrl: BROWSER_WS }
    if (url.endsWith('/json/list')) return targets
    throw new Error(`unexpected discovery url ${url}`)
  }
  server.respond('Page.getFrameTree', (_params, url) => {
    if (url === ws('H')) return { frameTree: hostTree }
    const id = url.slice(url.lastIndexOf('/') + 1)
    return { frameTree: { frame: { id } } }
  })
  server.respond('Runtime.evaluate', (params) => {
    const expr = String(params?.['expression'] ?? '')
    if (expr.includes('scrollIntoView({ block')) {
      return { result: { value: { status: 'ok', x: 10, y: 20, visible: true, disabled: false } } }
    }
    return { result: { value: 'ok' } }
  })
  server.respond('DOM.getFrameOwner', (params) => {
    const owner = OWNERS[String(params?.['frameId'])]
    if (owner === undefined) throw new Error('Frame with the given id was not found.')
    return { backendNodeId: owner.node }
  })
  server.respond('DOM.getBoxModel', (params) => {
    const owner = Object.values(OWNERS).find((o) => o.node === params?.['backendNodeId'])
    if (owner === undefined) throw new Error('Could not compute box model.')
    return { model: { content: [owner.x, owner.y, owner.x + 300, owner.y] } }
  })
  const transport = new CDPTransport({
    wsFactory: server.factory,
    fetchJson,
    killProcess: () => {},
    defaultMethodTimeoutMs: 500,
  })
  const context = (targetId: string, frameId: string, id: number, isDefault = true) =>
    server.emit(`page/${targetId}`, 'Runtime.executionContextCreated', {
      context: { id, auxData: { isDefault, frameId, type: isDefault ? 'default' : 'isolated' } },
    })
  return {
    server,
    transport,
    context,
    setTargets: (next: readonly Json[]) => {
      targets = next
    },
    setHostTree: (next: Json) => {
      hostTree = next
    },
  }
}

const byUrl = (surfaces: readonly SurfaceDescriptor[], part: string): SurfaceDescriptor => {
  const found = surfaces.find((surface) => surface.url?.includes(part))
  if (found === undefined) throw new Error(`no surface for ${part}`)
  return found
}

describe('CDP surface discovery', () => {
  it('lists targets and in-process frames parent-first with honest kinds and origins', async () => {
    const { transport } = setup()
    expect(transport.capabilities.supportsSurfaceTargeting).toBe(true)
    const session = await transport.attach({ port: 9222 })

    const surfaces = await session.surfacesList()

    expect(surfaces.map((s) => [s.url?.replace(/^.*\//, ''), s.kind, s.originRelation])).toEqual([
      ['host.html', 'other', undefined],
      ['guest.html', 'webview', undefined],
      ['cross.html', 'frame', 'cross-origin'],
      ['nested-cross.html', 'frame', 'cross-origin'],
      ['same.html', 'frame', 'same-origin'],
      ['nested-same.html', 'frame', 'same-origin'],
      ['view.html', 'other', undefined],
    ])
    const host = byUrl(surfaces, 'host.html')
    expect(host).toMatchObject({ active: true, capabilities: { interaction: true } })
    expect(byUrl(surfaces, 'guest.html').parentId).toBe(host.id)
    expect(byUrl(surfaces, 'nested-cross').parentId).toBe(byUrl(surfaces, 'cross.html').id)
    expect(byUrl(surfaces, 'nested-same').parentId).toBe(byUrl(surfaces, 'same.html').id)
    expect(surfaces.every((s) => s.id.startsWith(`${session.id}-surface-`))).toBe(true)
    expect((await session.surfacesList()).map((s) => s.id)).toEqual(surfaces.map((s) => s.id))
  })

  it('lists webview guests as windows but never iframe targets', async () => {
    const { transport } = setup()
    const session = await transport.attach({ port: 9222 })

    expect((await session.windowsList()).map((w) => w.id)).toEqual(['H', 'V', 'W'])
  })

  it('keeps a surface id when its frame moves from in-process to out-of-process', async () => {
    const { server, transport, setTargets, setHostTree } = setup()
    const session = await transport.attach({ port: 9222 })
    const before = byUrl(await session.surfacesList(), '/same.html')

    setHostTree({ frame: { id: 'H', url: HOST } })
    setTargets([
      ...DEFAULT_TARGETS,
      target('S', 'iframe', 'http://localhost:4000/same-moved.html', 'H'),
    ])
    const after = await session.surfacesList()
    const moved = byUrl(after, 'same-moved.html')
    expect(moved.id).toBe(before.id)

    await session.activateSurface(moved.id)
    await session.evaluate('renderer', 'return 1')
    const evals = server.sentTo('page/S', 'Runtime.evaluate')
    expect(evals).toHaveLength(1)
    expect(evals[0]?.params?.['contextId']).toBeUndefined()
  })

  it('lists an iframe whose parent is unknown as an undriveable root', async () => {
    const { transport, setTargets } = setup()
    const session = await transport.attach({ port: 9222 })
    setTargets([target('H', 'page', HOST), target('X', 'iframe', 'http://x.test/', 'GONE')])

    const orphan = byUrl(await session.surfacesList(), 'x.test')
    expect(orphan).toMatchObject({ kind: 'frame', capabilities: { interaction: false } })
    expect(orphan.parentId).toBeUndefined()
    await expect(session.activateSurface(orphan.id)).rejects.toMatchObject({
      code: 'SURFACE_UNSUPPORTED',
    })
  })
})

describe('CDP surface selection', () => {
  it('evaluates in an in-process frame through its main-world context', async () => {
    const { server, transport, context } = setup()
    const session = await transport.attach({ port: 9222 })
    const nested = byUrl(await session.surfacesList(), 'nested-same')
    context('H', 'S2', 99, false)
    context('H', 'S2', 7)

    await expect(session.activateSurface(nested.id)).resolves.toMatchObject({
      id: nested.id,
      active: true,
    })
    await expect(session.evaluate('renderer', 'return 1')).resolves.toBe('ok')

    const evals = server.sentTo('page/H', 'Runtime.evaluate')
    expect(evals.at(-1)?.params?.['contextId']).toBe(7)
    await expect(session.activeSurface()).resolves.toMatchObject({ id: nested.id, kind: 'frame' })
  })

  it('waits for a frame context that appears mid-navigation', async () => {
    const { server, transport, context } = setup()
    const session = await transport.attach({ port: 9222 })
    await session.activateSurface(byUrl(await session.surfacesList(), '/same.html').id)

    setTimeout(() => context('H', 'S', 11), 120)
    await expect(session.evaluate('renderer', 'return 1')).resolves.toBe('ok')
    expect(server.sentTo('page/H', 'Runtime.evaluate').at(-1)?.params?.['contextId']).toBe(11)
  })

  it('evaluates in an out-of-process frame on its own socket', async () => {
    const { server, transport } = setup()
    const session = await transport.attach({ port: 9222 })
    await session.activateSurface(byUrl(await session.surfacesList(), 'nested-cross').id)

    await session.evaluate('renderer', 'return 1')

    const evals = server.sentTo('page/O2', 'Runtime.evaluate')
    expect(evals).toHaveLength(1)
    expect(evals[0]?.params?.['contextId']).toBeUndefined()
  })

  it('selects a webview guest as the active window and drives it directly', async () => {
    const { server, transport } = setup()
    const session = await transport.attach({ port: 9222 })
    const guest = byUrl(await session.surfacesList(), 'guest.html')

    await session.activateSurface(guest.id)
    await session.click('#go')

    expect((await session.windowsList()).find((w) => w.focused)?.id).toBe('W')
    expect(server.sentTo('page/W', 'Input.dispatchMouseEvent')[0]?.params).toMatchObject({
      type: 'mouseMoved',
      x: 10,
      y: 20,
    })
    expect(server.sentTo('', 'DOM.getFrameOwner')).toHaveLength(0)
  })

  it('switching windows resets the selection to the window root', async () => {
    const { transport } = setup()
    const session = await transport.attach({ port: 9222 })
    const surfaces = await session.surfacesList()
    await session.activateSurface(byUrl(surfaces, 'cross.html').id)

    await session.activateWindow({ kind: 'id', id: 'V' })

    await expect(session.activeSurface()).resolves.toMatchObject({
      id: byUrl(surfaces, 'view.html').id,
      kind: 'other',
    })
  })
})

describe('CDP frame input', () => {
  it('clicks an in-process frame through the window target at the owner offset', async () => {
    const { server, transport, context } = setup()
    const session = await transport.attach({ port: 9222 })
    await session.activateSurface(byUrl(await session.surfacesList(), 'nested-same').id)
    context('H', 'S2', 7)

    await session.click('#go')

    expect(server.sentTo('page/H', 'Input.dispatchMouseEvent').map((f) => f.params)).toEqual([
      { type: 'mouseMoved', x: 110, y: 60, button: 'none' },
      { type: 'mousePressed', x: 110, y: 60, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 110, y: 60, button: 'left', clickCount: 1 },
    ])
  })

  it('sums owner offsets across nested out-of-process frames', async () => {
    const { server, transport } = setup()
    const session = await transport.attach({ port: 9222 })
    await session.activateSurface(byUrl(await session.surfacesList(), 'nested-cross').id)

    await session.click('#go')

    expect(server.sentTo('page/O', 'DOM.getFrameOwner')[0]?.params).toEqual({ frameId: 'O2' })
    expect(server.sentTo('page/H', 'DOM.getFrameOwner')[0]?.params).toEqual({ frameId: 'O' })
    expect(server.sentTo('page/O2', 'Input.dispatchMouseEvent')).toHaveLength(0)
    expect(server.sentTo('page/H', 'Input.dispatchMouseEvent')[0]?.params).toMatchObject({
      x: 30,
      y: 220,
    })
  })

  it('focuses a frame before dispatching keys on its window', async () => {
    const { server, transport, context } = setup()
    const session = await transport.attach({ port: 9222 })
    await session.activateSurface(byUrl(await session.surfacesList(), 'nested-same').id)
    context('H', 'S2', 7)

    await session.press('a')

    const focus = server
      .sentTo('page/H', 'Runtime.evaluate')
      .find((f) => String(f.params?.['expression']).includes('window.focus()'))
    expect(focus?.params?.['contextId']).toBe(7)
    expect(server.sentTo('page/H', 'Input.dispatchKeyEvent')).toHaveLength(2)
  })

  it('resolves file inputs in an in-process frame through its context', async () => {
    const { server, transport, context } = setup()
    server.respond('Runtime.evaluate', () => ({ result: { objectId: 'file-input' } }))
    const session = await transport.attach({ port: 9222 })
    await session.activateSurface(byUrl(await session.surfacesList(), 'nested-same').id)
    context('H', 'S2', 7)

    await session.setInputFiles('#upload', ['/tmp/a.txt'])

    expect(server.sentTo('page/H', 'Runtime.evaluate').at(-1)?.params?.['contextId']).toBe(7)
    expect(server.sentTo('page/H', 'DOM.setFileInputFiles')[0]?.params).toEqual({
      files: ['/tmp/a.txt'],
      objectId: 'file-input',
    })
    expect(server.sentTo('page/H', 'DOM.getDocument')).toHaveLength(0)
  })
})

describe('CDP surface lifecycle', () => {
  it('tombstones a detached frame and distinguishes unknown ids', async () => {
    const { transport, setHostTree } = setup()
    const session = await transport.attach({ port: 9222 })
    const same = byUrl(await session.surfacesList(), '/same.html')
    await session.activateSurface(same.id)

    setHostTree({ frame: { id: 'H', url: HOST } })

    await expect(session.activeSurface()).rejects.toMatchObject({ code: 'SURFACE_CLOSED' })
    await expect(session.activateSurface(same.id)).rejects.toMatchObject({
      code: 'SURFACE_CLOSED',
    })
    await expect(session.activateSurface('never-seen')).rejects.toMatchObject({
      code: 'SURFACE_NOT_FOUND',
    })
    expect((await session.surfacesList()).some((s) => s.id === same.id)).toBe(false)
  })

  it('falls back to a live window root when the selected frame window closes', async () => {
    const { transport, setTargets } = setup()
    const session = await transport.attach({ port: 9222 })
    const surfaces = await session.surfacesList()
    await session.activateSurface(byUrl(surfaces, 'cross.html').id)

    setTargets([target('V', 'page', 'http://127.0.0.1:4000/view.html')])

    await expect(session.activeSurface()).resolves.toMatchObject({
      id: byUrl(surfaces, 'view.html').id,
      active: true,
    })
  })
})
