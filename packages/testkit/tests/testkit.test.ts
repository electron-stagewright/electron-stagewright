import { describe, expect, it } from 'vitest'

import type { StagewrightPlugin } from '../../core/src/index.js'

import {
  connectMcpTestClient,
  createPluginTestServer,
  FULL_CAPABILITIES,
  fullCapabilities,
  TestLifecycle,
  waitForTestSurfaces,
} from '../src/index.js'

describe('testkit', () => {
  it('creates independent full capability matrices', () => {
    const restricted = fullCapabilities({ canIntercept: false })

    expect(restricted).toMatchObject({ canIntercept: false, canLaunch: true })
    expect(FULL_CAPABILITIES).toMatchObject({ canIntercept: true, canLaunch: true })
  })

  it('tracks a fake server, launch fixture, and cleanup lifecycle', async () => {
    const lifecycle = new TestLifecycle()
    const { server, session, transport } = await lifecycle.createTestServer()
    try {
      const sessionId = await lifecycle.launch(server)
      expect(sessionId).toBe(session.id)
      expect(transport.launchCount).toBe(1)
    } finally {
      await lifecycle.cleanup()
    }

    expect(session.disposeCount).toBe(1)
  })

  it('loads one plugin through the shared server helper', async () => {
    const plugin = {
      name: 'testkit',
      version: '1.0.0',
      coreVersionRange: '*',
    } satisfies StagewrightPlugin
    const { server } = await createPluginTestServer(plugin)
    try {
      expect(await server.dispatcher.dispatch('electron_plugins', {})).toMatchObject({
        ok: true,
        plugins: [{ name: 'testkit', version: '1.0.0' }],
      })
    } finally {
      await server.close()
    }
  })

  it('connects an MCP client through the shared in-memory transport helper', async () => {
    const lifecycle = new TestLifecycle()
    const { server } = await lifecycle.createTestServer()
    const connection = await connectMcpTestClient(server)
    try {
      const listed = await connection.client.listTools()
      expect(listed.tools).toContainEqual(expect.objectContaining({ name: 'electron_launch' }))
    } finally {
      await connection.close()
      await lifecycle.cleanup()
    }
  })

  it('waits for asynchronously attached renderer surfaces', async () => {
    let calls = 0
    const dispatcher = {
      dispatch: async () => {
        calls += 1
        return {
          ok: true,
          surfaces: [
            { id: 'window-1', kind: 'window', url: 'file:///fixture/host.html' },
            ...(calls > 1
              ? [{ id: 'frame-1', kind: 'frame', url: 'file:///fixture/child.html' }]
              : []),
          ],
        }
      },
    }

    const listed = await waitForTestSurfaces(
      dispatcher,
      'session-1',
      (result) => result.surfaces.some((surface) => surface.kind === 'frame'),
      { timeoutMs: 50, intervalMs: 1 },
    )

    expect(calls).toBe(2)
    expect(listed.surfaces).toContainEqual(
      expect.objectContaining({ kind: 'frame', url: 'file:///fixture/child.html' }),
    )
  })

  it('reports observed surfaces when attachment does not complete', async () => {
    const dispatcher = {
      dispatch: async () => ({
        ok: true,
        surfaces: [{ id: 'window-1', kind: 'window', url: 'file:///fixture/host.html' }],
      }),
    }

    await expect(
      waitForTestSurfaces(
        dispatcher,
        'session-1',
        (result) => result.surfaces.some((surface) => surface.kind === 'frame'),
        { timeoutMs: 5, intervalMs: 1 },
      ),
    ).rejects.toThrow(
      'Timed out after 5ms waiting for Electron surfaces; observed window:file:///fixture/host.html',
    )
  })
})
